// acc2 uv runtime — Python under nsjail (when available) via the Astral `uv`
// fast Python package manager (v2-design.md §6.1 row "uv", §11.3 uv variant,
// §5.5 supervision).
//
// Lifecycle (mirrors runtimes/bun.ts):
//   1. Materialize the artifact body into an ephemeral tempdir.
//      - `entry.py`         — wraps the artifact body. Body is expected to
//        print exactly one JSON line prefixed by `@@RESULT@@ ` so the parent
//        can parse cleanly. Inputs are exposed via `ACC2_INPUTS` env var.
//      - `requirements.txt` — written only when `pypi_allow` is non-empty;
//        consumed by `uv run --with-requirements`.
//   2. Detect `nsjail` on PATH. If present, build the argv prefix
//      `nsjail --quiet --time_limit <wall_s> --rlimit_as <memMb> --bind /tmp:/tmp
//      -- uv run python entry.py` (with the optional `--with-requirements`
//      hop when deps were declared). If absent, emit a
//      `sandbox_unenforced_warning` and run `uv run` directly in the tempdir.
//      The warning lets the audit trail record that the runtime degraded its
//      sandbox; the artifact still executes.
//   3. Spawn under Bun.spawn (we share the watchdog + result-parsing logic
//      with the bun runtime, so the orchestrator only learns one shape).
//   4. Watchdog per §5.5 row "uv": SIGTERM at wall_ms, SIGKILL at wall_ms ×
//      1.5 (Python unwinding is slower than bun). Each transition + the
//      started/completed pair fires an `emit` callback the caller passes in.
//   5. Drain stdout + stderr. Parse the LAST line beginning with `@@RESULT@@ `.
//   6. Tempdir cleanup unconditional in `finally`.
//
// Irreversible-effect detection is honor-system in Phase G (same as bun).
// nsjail's strace mode could intercept open(O_WRONLY) but Phase G keeps the
// surface uniform; effect records arrive via the verifier's observation,
// not the runtime's syscall trace.
//
// uv-on-PATH detection: when `uv` itself is not installed the runtime
// returns `ok:false, error:"uv_runtime_unavailable: install uv"`. The
// admission tests skip end-to-end uv spawning when `uv` is absent; the
// sandbox / policy plumbing is exercised unconditionally.

import type { Subprocess } from "bun";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue, SandboxDecl } from "../../substrate/types";
import { buildUvPermissionArgs } from "../sandbox";
import type { EmitEventInput } from "../events";

export type UvRuntimeInvocation = {
  artifactId: string;
  body: string;
  declaredSandbox: SandboxDecl & { runtime: "uv" };
  inputs: JsonValue;
  budget?: { wallMs?: number; memoryMb?: number };
  emit?: (event: EmitEventInput) => void;
};

export type UvRuntimeObservation = {
  ok: boolean;
  result?: JsonValue;
  error?: string;
  irreversibleEffects: Array<{ kind: string; description: string }>;
  durationMs: number;
  exitCode: number;
  stderrTail: string;
  sandboxWarnings: string[];
};

const RESULT_PREFIX = "@@RESULT@@ ";
const IRREVERSIBLE_PREFIX = "@@IRREVERSIBLE@@ ";
const STDERR_TAIL_BYTES = 1024;
/** Robustness: SIGKILL fires this many ms AFTER SIGTERM if the subprocess
 *  has not exited. Python unwinding is slower than bun, so we keep a 2s
 *  grace by default but allow operator override via
 *  ACC2_UV_SIGKILL_ESCALATION_MS (e.g. 3000 for slower interpreters). */
const SIGTERM_SIGKILL_ESCALATION_MS = 2_000;

/** See runtimes/bun.ts for the convention — same parser, same semantics. */
const parseIrreversibleLines = (stdout: string): Array<{ kind: string; description: string }> => {
  const out: Array<{ kind: string; description: string }> = [];
  for (const ln of stdout.split(/\r?\n/)) {
    if (!ln.startsWith(IRREVERSIBLE_PREFIX)) continue;
    const suffix = ln.slice(IRREVERSIBLE_PREFIX.length);
    const sep = suffix.indexOf(":");
    if (sep <= 0) {
      out.push({ kind: "unspecified", description: suffix.trim() });
    } else {
      out.push({
        kind: suffix.slice(0, sep).trim(),
        description: suffix.slice(sep + 1).trim(),
      });
    }
  }
  return out;
};

const readStream = async (stream: ReadableStream<Uint8Array> | null): Promise<string> => {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
  } finally {
    try { reader.releaseLock(); } catch { /* swallow */ }
  }
  return out;
};

const parseResultLine = (stdout: string):
  | { ok: true; value: JsonValue }
  | { ok: false; reason: string } => {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i]!;
    if (ln.startsWith(RESULT_PREFIX)) {
      const suffix = ln.slice(RESULT_PREFIX.length);
      try {
        return { ok: true, value: JSON.parse(suffix) as JsonValue };
      } catch (err) {
        return { ok: false, reason: `result_parse_failed:${(err as Error).message}` };
      }
    }
  }
  return { ok: false, reason: "result_marker_missing" };
};

const lastBytes = (s: string, n: number): string =>
  s.length <= n ? s : s.slice(s.length - n);

/** Look up an executable on PATH. Returns null if none found. We use this for
 *  both `uv` (the runtime itself) and `nsjail` (the sandbox jailer). */
const whichSync = (cmd: string): string | null => {
  const path = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of path.split(sep)) {
    if (!dir) continue;
    const candidate = join(dir, cmd);
    try {
      if (existsSync(candidate)) return candidate;
    } catch { /* keep scanning */ }
  }
  return null;
};

/** Per-process cache for the nsjail probe + one-shot degraded warning.
 *  Batch 4 Hole 1 — we only want ONE `sandbox_degraded` event per process
 *  (not per uv invocation), but every successful nsjail launch emits its
 *  own `sandbox_enforced` row carrying the actual limits for audit. */
let nsjailPathCache: string | null | undefined;
let sandboxDegradedReported = false;

/** Resolve nsjail path with a per-process cache (testable via the
 *  internal reset hook below). */
const resolveNsjailPath = (): string | null => {
  if (nsjailPathCache !== undefined) return nsjailPathCache;
  nsjailPathCache = whichSync("nsjail");
  return nsjailPathCache;
};

/** Build the nsjail argv prefix from the declared sandbox. Mounts read globs
 *  as read-only and write globs as read-write; when `net.allow_domains` is
 *  empty we disable the network namespace entirely (nsjail does not support
 *  per-domain allowlists natively, so the coarse-but-honest gate is "all-or-
 *  nothing"). When the array is non-empty we keep the host network namespace
 *  so the artifact can reach the declared domains. */
export const buildNsjailArgv = (
  nsjailPath: string,
  uvPath: string,
  uvArgs: string[],
  sandbox: SandboxDecl & { runtime: "uv" },
  cwd: string,
  wallMs: number,
  memoryMb: number,
): string[] => {
  const wallS = Math.max(1, Math.ceil(wallMs / 1000));
  const rlimitBytes = Math.max(1, memoryMb) * 1024 * 1024;
  const argv: string[] = [
    nsjailPath,
    "--quiet",
    "--time_limit",
    String(wallS),
    "--rlimit_as",
    String(rlimitBytes),
    "--cwd",
    cwd,
    // /tmp must be visible — the uv cache + entry.py live there.
    "--bindmount",
    "/tmp:/tmp",
  ];

  // Read globs → readonly bind mounts. We resolve a glob to its directory
  // prefix (everything before the first wildcard) so nsjail accepts it.
  const fsRead = sandbox.fs_read ?? [];
  for (const g of fsRead) {
    const dir = g.split(/[*?[]/)[0] ?? g;
    if (!dir) continue;
    argv.push("--bindmount_ro", `${dir}:${dir}`);
  }

  // Write globs → read-write bind mounts.
  const fsWrite = sandbox.fs_write ?? [];
  for (const g of fsWrite) {
    const dir = g.split(/[*?[]/)[0] ?? g;
    if (!dir) continue;
    argv.push("--bindmount", `${dir}:${dir}`);
  }

  // Network namespace gate: when no domains are allowed, disable cloning the
  // net ns (nsjail's --disable_clone_newnet keeps the host network — we WANT
  // the opposite: when net is forbidden, ENABLE the new-net namespace so the
  // child has its own empty stack). nsjail's default IS clone_newnet, so
  // when allowlist is non-empty we pass --disable_clone_newnet to keep host
  // networking reachable.
  const netAllow = sandbox.net_allow ?? [];
  if (netAllow.length > 0) {
    argv.push("--disable_clone_newnet");
  }

  argv.push("--", uvPath, ...uvArgs);
  return argv;
};

/** Test hook — reset the per-process nsjail caches so test cases can
 *  exercise both the "nsjail present" and "nsjail absent" paths without a
 *  module reload. Production callers MUST NOT invoke this. */
export const __resetNsjailCacheForTest = (overridePath: string | null | undefined): void => {
  nsjailPathCache = overridePath;
  sandboxDegradedReported = false;
};

/** Wrap the user-supplied Python body so it (a) reads inputs from ACC2_INPUTS,
 *  (b) binds the unpacked inputs to a `inputs` local before user code, and
 *  (c) only emits the @@RESULT@@ marker when the user code didn't already.
 *  We keep the wrapper minimal: artifact bodies are free to print the marker
 *  themselves (the seed `py_run` artifact does so) and the wrapper falls back
 *  to printing `{"ok": true}` only when no marker reaches stdout. */
const wrapPythonBody = (body: string): string => [
  "import json, os, sys",
  "_acc2_inputs = json.loads(os.environ.get('ACC2_INPUTS', 'null'))",
  "inputs = _acc2_inputs",
  "_acc2_result_emitted = False",
  "_acc2_orig_print = print",
  "def _acc2_check_marker(*args, **kw):",
  "    global _acc2_result_emitted",
  "    text = ' '.join(str(a) for a in args)",
  "    if text.startswith('@@RESULT@@ '):",
  "        _acc2_result_emitted = True",
  "    _acc2_orig_print(*args, **kw)",
  "print = _acc2_check_marker",
  "# --- begin artifact body ---",
  body,
  "# --- end artifact body ---",
  "if not _acc2_result_emitted:",
  "    _acc2_orig_print('@@RESULT@@ ' + json.dumps({'ok': True}))",
].join("\n");

/** Execute an artifact body under a uv subprocess and return the observation.
 *  Tempdir is created + cleaned up here. */
export const runUvArtifact = async (
  inv: UvRuntimeInvocation,
): Promise<UvRuntimeObservation> => {
  const perm = buildUvPermissionArgs(inv.declaredSandbox);
  const wallMs = inv.budget?.wallMs ?? inv.declaredSandbox.wall_ms;
  const memoryMb = inv.budget?.memoryMb ?? inv.declaredSandbox.memory_mb;

  const uvPath = whichSync("uv");
  if (!uvPath) {
    // The runtime itself isn't installed. Refuse cleanly so the admission
    // path can decide whether to admit-but-defer-execution or reject.
    return {
      ok: false,
      error: "uv_runtime_unavailable",
      irreversibleEffects: [],
      durationMs: 0,
      exitCode: -1,
      stderrTail: "",
      sandboxWarnings: perm.warnings.concat([
        "uv runtime not on PATH — install Astral uv (https://docs.astral.sh/uv/) to enable Python execution",
      ]),
    };
  }

  // Pid-namespaced prefix so parallel `bun test --parallel` workers can audit
  // their own tempdirs without seeing siblings' in-flight dirs.
  const dir = mkdtempSync(join(tmpdir(), `acc2-uv-${process.pid}-`));
  const entryPath = join(dir, "entry.py");
  writeFileSync(entryPath, wrapPythonBody(inv.body), { mode: 0o600 });

  // Optional requirements.txt — only when the brain declared pypi_allow.
  const pypiAllow = inv.declaredSandbox.pypi_allow ?? [];
  let reqsPath: string | null = null;
  if (pypiAllow.length > 0) {
    reqsPath = join(dir, "requirements.txt");
    writeFileSync(reqsPath, pypiAllow.join("\n") + "\n", { mode: 0o600 });
  }

  const env: Record<string, string> = {
    ...process.env,
    ...perm.env,
    ACC2_INPUTS: JSON.stringify(inv.inputs ?? null),
    ACC2_ARTIFACT_ID: inv.artifactId,
    ACC2_BUDGET_WALL_MS: String(wallMs),
    ACC2_BUDGET_MEMORY_MB: String(memoryMb),
  };

  // Build the uv invocation. `--no-project` keeps uv from looking for a
  // pyproject.toml in the tempdir (we don't author one — uv falls back to
  // the system Python interpreter for `uv run`). `--isolated` prevents
  // undeclared packages from leaking in through the operator's ambient Python
  // environment; only pypi_allow entries are installed below.
  const uvArgs: string[] = ["run", "--no-project", "--isolated"];
  if (reqsPath) {
    uvArgs.push("--with-requirements", reqsPath);
  }
  uvArgs.push("python", entryPath);

  // Detect nsjail. When present, wrap the uv call. When absent, emit a
  // one-per-process `sandbox_degraded` event and continue under the
  // honor-system limits the outer Bun watchdog already enforces.
  const nsjailPath = resolveNsjailPath();
  const sandboxWarnings = [...perm.warnings];
  let argv: string[];
  if (nsjailPath) {
    // Build the nsjail argv from the full sandbox grammar (fs/net/pypi/wall).
    // The outer Bun watchdog is kept ALSO so a misbehaving nsjail still gets
    // SIGKILL'd at wall_ms × 1.5.
    argv = buildNsjailArgv(
      nsjailPath,
      uvPath,
      uvArgs,
      inv.declaredSandbox,
      dir,
      wallMs,
      memoryMb,
    );
    inv.emit?.({
      kind: "sandbox_enforced",
      substrate_origin: "substrate_auto",
      action_artifact_id: inv.artifactId,
      payload: {
        runtime: "uv",
        nsjail_path: nsjailPath,
        limits: {
          wall_ms: wallMs,
          memory_mb: memoryMb,
          fs_read: inv.declaredSandbox.fs_read ?? [],
          fs_write: inv.declaredSandbox.fs_write ?? [],
          net_allow: inv.declaredSandbox.net_allow ?? [],
          pypi_allow: inv.declaredSandbox.pypi_allow ?? [],
        },
      } as JsonValue,
    });
  } else {
    argv = [uvPath, ...uvArgs];
    sandboxWarnings.push(
      "nsjail not on PATH — uv runtime executing without syscall sandbox (install nsjail to enforce per-process limits)",
    );
    // One-per-process degraded event so the ledger records the operating
    // environment without flooding the stream on every invocation.
    if (!sandboxDegradedReported) {
      sandboxDegradedReported = true;
      inv.emit?.({
        kind: "sandbox_degraded",
        substrate_origin: "substrate_auto",
        action_artifact_id: inv.artifactId,
        payload: {
          runtime: "uv",
          reason: "nsjail_not_on_path",
          guidance:
            "Install nsjail (https://github.com/google/nsjail) for hardened uv sandboxing; honor-system limits remain in effect.",
        } as JsonValue,
      });
    }
  }

  const startMs = Date.now();
  let proc: Subprocess<"ignore", "pipe", "pipe"> | null = null;
  let softTimer: ReturnType<typeof setTimeout> | null = null;
  let hardTimer: ReturnType<typeof setTimeout> | null = null;
  let softFired = false;
  let hardFired = false;

  try {
    proc = Bun.spawn({
      cmd: argv,
      cwd: dir,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    inv.emit?.({
      kind: "artifact_invoked",
      substrate_origin: "substrate_auto",
      action_artifact_id: inv.artifactId,
      payload: {
        runtime: "uv",
        pid: proc.pid ?? null,
        wall_ms: wallMs,
        memory_mb: memoryMb,
        nsjail: nsjailPath !== null,
        pypi_allow_count: pypiAllow.length,
      } as JsonValue,
    });

    // SIGTERM at wall_ms; SIGKILL escalation 2s later (independent of wall_ms).
    const envEsc = Number(process.env.ACC2_UV_SIGKILL_ESCALATION_MS ?? "");
    const escMs = Number.isFinite(envEsc) && envEsc > 0 ? envEsc : SIGTERM_SIGKILL_ESCALATION_MS;
    softTimer = setTimeout(() => {
      softFired = true;
      try { proc?.kill("SIGTERM"); } catch (killErr) { void killErr; }
      hardTimer = setTimeout(() => {
        if (proc && proc.exitCode === null) {
          hardFired = true;
          try { proc.kill("SIGKILL"); } catch (killErr) { void killErr; }
          inv.emit?.({
            kind: "runtime_subprocess_killed",
            substrate_origin: "substrate_auto",
            action_artifact_id: inv.artifactId,
            payload: {
              runtime: "uv",
              reason: "sigterm_did_not_drain",
              escalation_ms: escMs,
              wall_ms: wallMs,
            } as JsonValue,
          });
        }
      }, escMs);
    }, Math.max(1, wallMs));

    const [stdoutText, stderrText, exitCode] = await Promise.all([
      readStream(proc.stdout),
      readStream(proc.stderr),
      proc.exited,
    ]);

    if (softTimer) clearTimeout(softTimer);
    if (hardTimer) clearTimeout(hardTimer);

    const durationMs = Date.now() - startMs;
    const stderrTail = lastBytes(stderrText, STDERR_TAIL_BYTES);

    if (softFired) {
      inv.emit?.({
        kind: "artifact_observed",
        substrate_origin: "substrate_auto",
        action_artifact_id: inv.artifactId,
        payload: { phase: "soft_timeout", signal: "SIGTERM", wall_ms: wallMs } as JsonValue,
      });
    }
    if (hardFired) {
      inv.emit?.({
        kind: "artifact_observed",
        substrate_origin: "substrate_auto",
        action_artifact_id: inv.artifactId,
        payload: { phase: "hard_kill", signal: "SIGKILL", wall_ms: wallMs } as JsonValue,
      });
    }

    const irreversibleEffects = parseIrreversibleLines(stdoutText);

    if (exitCode !== 0) {
      return {
        ok: false,
        error: softFired || hardFired ? "wall_timeout" : `nonzero_exit:${exitCode}`,
        irreversibleEffects,
        durationMs,
        exitCode,
        stderrTail,
        sandboxWarnings,
      };
    }

    const parsed = parseResultLine(stdoutText);
    if (!parsed.ok) {
      return {
        ok: false,
        error: parsed.reason,
        irreversibleEffects,
        durationMs,
        exitCode,
        stderrTail,
        sandboxWarnings,
      };
    }

    inv.emit?.({
      kind: "artifact_observed",
      substrate_origin: "substrate_auto",
      action_artifact_id: inv.artifactId,
      payload: { phase: "completed", duration_ms: durationMs } as JsonValue,
    });

    return {
      ok: true,
      result: parsed.value,
      irreversibleEffects,
      durationMs,
      exitCode,
      stderrTail,
      sandboxWarnings,
    };
  } catch (err) {
    if (softTimer) clearTimeout(softTimer);
    if (hardTimer) clearTimeout(hardTimer);
    const durationMs = Date.now() - startMs;
    return {
      ok: false,
      error: `runtime_spawn_failed:${(err as Error).message}`,
      irreversibleEffects: [],
      durationMs,
      exitCode: -1,
      stderrTail: "",
      sandboxWarnings,
    };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* swallow */ }
  }
};
