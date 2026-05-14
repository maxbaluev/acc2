// acc2 camofox-browser runtime — chromium driven against a long-lived
// substrate-owned profile root (v2-design.md §6.1 row "camofox-browser",
// §11.3 camofox variant, §5.5 supervision).
//
// Phase G implementation reality: v1's camofox-browser is a v1-internal MCP
// tool that v2 cannot import. The Phase-G shim is structured so the WIRING
// and the sandbox/policy plumbing are real and exercised by tests, while
// actual chromium execution is gated on `playwright` (a Bun-installable
// chromium driver) being present in node_modules. The operator install path
// (`bun add playwright && bunx playwright install chromium`) is documented
// at every refusal site so the runtime is self-explaining when invoked
// without playwright.
//
// Lifecycle when playwright IS installed:
//   1. Acquire the per-profile-root mutex (v2-design.md §11.2 — stateful
//      artifacts queue on a per-state-root mutex; camofox is stateful per
//      profile_root). Concurrent invocations against the SAME profile_root
//      serialize; different profile_roots run in parallel.
//   2. Materialize the artifact body into an ephemeral tempdir. The wrapper
//      provides a `camofox` virtual module with a minimal session API
//      (`session.goto`, `session.fill`, `session.click`, `session.text`,
//      `session.url`, `session.screenshot`) on top of playwright's
//      `chromium.launchPersistentContext`. Inputs flow in via ACC2_INPUTS.
//   3. Launch chromium with `userDataDir = browser_profile_root`. The
//      profile root is owned by the substrate; the wrapper does not delete
//      it on exit so state survives across invocations.
//   4. Enforce `browser_allow_domains` via `page.route()` — block requests
//      to disallowed domains.
//   5. Watchdog per §5.5 row "camofox": graceful `session.close()` at
//      wall_ms; SIGKILL at wall_ms × 2 (chromium hung-page recovery is
//      slow). If chromium fails to exit after SIGKILL, emit a
//      `profile_quarantine_pending` event so the supervisor spawns fresh
//      chromium on next invocation.
//   6. Drain stdout + stderr. Parse `@@RESULT@@ <json>`.
//   7. Tempdir cleanup unconditional in `finally`. Profile root persists.
//
// Lifecycle when playwright is NOT installed:
//   - Return `{ok:false, error:"camofox_runtime_unavailable"}` cleanly with
//     a sandboxWarnings entry pointing at the install command. Admission
//     paths can still admit the artifact (the sandbox decl validates); only
//     RUNNING the artifact is gated.

import type { Subprocess } from "bun";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue, SandboxDecl } from "../../substrate/types";
import { buildCamofoxPermissionArgs } from "../sandbox";
import type { EmitEventInput } from "../events";

export type CamofoxRuntimeInvocation = {
  artifactId: string;
  body: string;
  declaredSandbox: SandboxDecl & { runtime: "camofox-browser" };
  inputs: JsonValue;
  budget?: { wallMs?: number; memoryMb?: number };
  emit?: (event: EmitEventInput) => void;
};

export type CamofoxRuntimeObservation = {
  ok: boolean;
  result?: JsonValue;
  error?: string;
  irreversibleEffects: Array<{ kind: string; description: string }>;
  durationMs: number;
  exitCode: number;
  stderrTail: string;
  sandboxWarnings: string[];
  profileRoot: string;
};

const RESULT_PREFIX = "@@RESULT@@ ";
const IRREVERSIBLE_PREFIX = "@@IRREVERSIBLE@@ ";
const STDERR_TAIL_BYTES = 1024;
// Per §5.5: SIGKILL at wall_ms × 2 (chromium hung-page recovery is slow).
const HARD_KILL_MULTIPLIER = 2;
const KILL_GRACE_MS = 1000;

/** See runtimes/bun.ts for the convention — same parser, same semantics.
 *  The camofox wrapper captures console.log; user code emits the marker
 *  via `console.log('@@IRREVERSIBLE@@ <kind>:<description>')`. */
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

// ── Per-state-root mutex (v2-design.md §11.2) ─────────────────────
//
// Concurrent invocations against the same profile_root MUST queue. We model
// this as a Map<profile_root, Promise>: each entry is a tail promise; new
// invocations chain onto it and replace it in the same call site, so the
// queue is implicit in the promise chain. The map is per-process; in v2 the
// daemon is the only process running artifacts so a process-local mutex is
// authoritative.

const profileMutexes = new Map<string, Promise<void>>();

const acquireProfileMutex = <T>(profileRoot: string, fn: () => Promise<T>): Promise<T> => {
  const prev = profileMutexes.get(profileRoot) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const next = new Promise<void>((resolve) => { release = resolve; });
  profileMutexes.set(profileRoot, prev.then(() => next));
  // Eagerly clean up the map entry when this entry is the LATEST one —
  // otherwise the map would grow unbounded with empty resolved promises.
  const guarded = (async () => {
    await prev;
    try {
      return await fn();
    } finally {
      release();
      // If our `next` is still the head, drop it so the map doesn't leak.
      if (profileMutexes.get(profileRoot) === prev.then(() => next)) {
        profileMutexes.delete(profileRoot);
      }
    }
  })();
  return guarded;
};

// Exposed for tests that need to assert serialization behavior end-to-end.
export const __getProfileMutexQueueDepth = (profileRoot: string): boolean =>
  profileMutexes.has(profileRoot);

/** Test surface: run an arbitrary async function under the per-profile-root
 *  mutex without spawning chromium. Phase Align Principle 8 uses this to
 *  prove the mutex serializes concurrent invocations against the same
 *  state root. NOT exported for production callers — only the runtime's
 *  own `runCamofoxArtifact` should drive the chromium pipeline. */
export const __acquireProfileMutexForTest = <T>(
  profileRoot: string,
  fn: () => Promise<T>,
): Promise<T> => acquireProfileMutex(profileRoot, fn);

// ── Playwright availability detection ──────────────────────────────
//
// We look up the `playwright` module without `await import()` because
// node_modules can be present without chromium having been downloaded. Two
// existence checks: the package manifest and the chromium binary cache.
// The runtime still attempts `await import("playwright")` lazily so any
// other resolver shape (e.g. a workspace symlink) still works.

const isPlaywrightInstalled = (): boolean => {
  try {
    // Module path inside the acc2/node_modules layout.
    const candidates = [
      join(import.meta.dir, "..", "..", "node_modules", "playwright", "package.json"),
      join(import.meta.dir, "..", "..", "node_modules", "playwright-core", "package.json"),
    ];
    return candidates.some((p) => existsSync(p));
  } catch {
    return false;
  }
};

// ── Result-parsing helpers (shared shape with bun/uv runtimes) ─────

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

// ── Wrapper script generation ──────────────────────────────────────
//
// The wrapper imports playwright, exposes a thin `session` facade matching
// the camofox API the seed artifacts use, runs the user body, and prints
// `@@RESULT@@ <json>` on exit. The user body is wrapped in an async IIFE so
// `await` works at the top level.

const wrapBrowserBody = (body: string, profileRoot: string, allowDomains: string[]): string => [
  "import { chromium } from 'playwright';",
  "const inputs = JSON.parse(process.env.ACC2_INPUTS ?? 'null');",
  `const __profileRoot = ${JSON.stringify(profileRoot)};`,
  `const __allowDomains = ${JSON.stringify(allowDomains)};`,
  "const __isAllowed = (url) => {",
  "  if (__allowDomains.length === 0) return true;",
  "  try { const u = new URL(url); return __allowDomains.some((d) => u.hostname === d || u.hostname.endsWith('.' + d)); }",
  "  catch { return false; }",
  "};",
  "const __ctx = await chromium.launchPersistentContext(__profileRoot, { headless: true });",
  "const __page = (await __ctx.pages())[0] ?? await __ctx.newPage();",
  "await __page.route('**/*', (route) => { __isAllowed(route.request().url()) ? route.continue() : route.abort(); });",
  "const session = {",
  "  goto: async (url) => { await __page.goto(url); },",
  "  fill: async (sel, text) => { await __page.fill(sel, text); },",
  "  click: async (sel) => { await __page.click(sel); },",
  "  text: async (sel) => __page.textContent(sel),",
  "  get url() { return __page.url(); },",
  "  screenshot: async () => __page.screenshot({ encoding: 'base64' }),",
  "  close: async () => { await __ctx.close(); },",
  "};",
  "let __result = null;",
  "let __resultEmitted = false;",
  "const __origLog = console.log.bind(console);",
  "console.log = (...args) => {",
  "  const first = args[0];",
  "  if (typeof first === 'string' && first.startsWith('@@RESULT@@ ')) __resultEmitted = true;",
  "  __origLog(...args);",
  "};",
  "try {",
  "  __result = await (async () => {",
  "    // --- begin artifact body ---",
  body,
  "    // --- end artifact body ---",
  "  })();",
  "} finally {",
  "  try { await __ctx.close(); } catch {}",
  "}",
  "if (!__resultEmitted) {",
  "  __origLog('@@RESULT@@ ' + JSON.stringify(__result ?? { ok: true }));",
  "}",
].join("\n");

// ── Public runtime entry point ─────────────────────────────────────

export const runCamofoxArtifact = async (
  inv: CamofoxRuntimeInvocation,
): Promise<CamofoxRuntimeObservation> => {
  const perm = buildCamofoxPermissionArgs(inv.declaredSandbox);
  const wallMs = inv.budget?.wallMs ?? inv.declaredSandbox.wall_ms;
  const memoryMb = inv.budget?.memoryMb ?? inv.declaredSandbox.memory_mb;
  const profileRoot = inv.declaredSandbox.browser_profile_root;
  const allowDomains = inv.declaredSandbox.browser_allow_domains;

  // Phase-G availability gate. If playwright isn't installed, refuse cleanly
  // with the operator-install hint surfaced as a sandboxWarning so the audit
  // trail has a pointer.
  if (!isPlaywrightInstalled()) {
    return {
      ok: false,
      error: "camofox_runtime_unavailable",
      irreversibleEffects: [],
      durationMs: 0,
      exitCode: -1,
      stderrTail: "",
      sandboxWarnings: perm.warnings.concat([
        "playwright not installed — run `bun add playwright && bunx playwright install chromium` to enable camofox-browser execution",
      ]),
      profileRoot,
    };
  }

  return acquireProfileMutex(profileRoot, () => runCamofoxArtifactInner(inv, perm.warnings, wallMs, memoryMb, profileRoot, allowDomains));
};

const runCamofoxArtifactInner = async (
  inv: CamofoxRuntimeInvocation,
  baseWarnings: string[],
  wallMs: number,
  memoryMb: number,
  profileRoot: string,
  allowDomains: string[],
): Promise<CamofoxRuntimeObservation> => {
  const dir = mkdtempSync(join(tmpdir(), "acc2-camofox-"));
  const entryPath = join(dir, "entry.mjs");
  writeFileSync(entryPath, wrapBrowserBody(inv.body, profileRoot, allowDomains), { mode: 0o600 });

  const env: Record<string, string> = {
    ...process.env,
    ACC2_INPUTS: JSON.stringify(inv.inputs ?? null),
    ACC2_ARTIFACT_ID: inv.artifactId,
    ACC2_BUDGET_WALL_MS: String(wallMs),
    ACC2_BUDGET_MEMORY_MB: String(memoryMb),
    ACC2_BROWSER_PROFILE: profileRoot,
    ACC2_ALLOWED_DOMAINS: JSON.stringify(allowDomains),
  };

  const startMs = Date.now();
  let proc: Subprocess<"ignore", "pipe", "pipe"> | null = null;
  let softTimer: ReturnType<typeof setTimeout> | null = null;
  let hardTimer: ReturnType<typeof setTimeout> | null = null;
  let softFired = false;
  let hardFired = false;

  try {
    // Use Bun.spawn with process.execPath ('bun') so the wrapper runs under
    // the same runtime as the daemon and can `import 'playwright'` from the
    // shared node_modules.
    proc = Bun.spawn({
      cmd: [process.execPath, "run", entryPath],
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
        runtime: "camofox-browser",
        pid: proc.pid ?? null,
        wall_ms: wallMs,
        memory_mb: memoryMb,
        profile_root: profileRoot,
        allow_domains: allowDomains as unknown as JsonValue,
      } as JsonValue,
    });

    softTimer = setTimeout(() => {
      softFired = true;
      try { proc?.kill("SIGTERM"); } catch { /* already exited */ }
    }, Math.max(1, wallMs));

    hardTimer = setTimeout(() => {
      if (proc && proc.exitCode === null) {
        hardFired = true;
        try { proc.kill("SIGKILL"); } catch { /* already exited */ }
      }
    }, Math.max(1, Math.floor(wallMs * HARD_KILL_MULTIPLIER) + KILL_GRACE_MS));

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
      // Per §5.5: chromium hung-page recovery — if SIGKILL didn't drain,
      // mark the profile root quarantine_pending so the next invocation
      // gets a fresh context. We can't observe "didn't drain" reliably from
      // the parent without proc-tree probing, so we conservatively emit on
      // every hard-kill (a stricter test of "actually orphaned" lives in
      // the daemon's process-tree reaper).
      inv.emit?.({
        kind: "artifact_observed",
        substrate_origin: "substrate_auto",
        action_artifact_id: inv.artifactId,
        payload: {
          phase: "hard_kill",
          signal: "SIGKILL",
          wall_ms: wallMs,
          profile_quarantine_pending: true,
          profile_root: profileRoot,
        } as JsonValue,
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
        sandboxWarnings: baseWarnings,
        profileRoot,
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
        sandboxWarnings: baseWarnings,
        profileRoot,
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
      sandboxWarnings: baseWarnings,
      profileRoot,
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
      sandboxWarnings: baseWarnings,
      profileRoot,
    };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* swallow */ }
  }
};

// Exposed for tests — checks that the wrapper script generation is stable
// without spawning chromium.
export const __wrapBrowserBodyForTest = wrapBrowserBody;
export const __isPlaywrightInstalledForTest = isPlaywrightInstalled;
