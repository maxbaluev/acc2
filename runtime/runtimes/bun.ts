// acc2 bun runtime — executes TypeScript code artifacts under a declared
// sandbox (v2-design.md §6.1, §11.2, §11.3, §5.5).
//
// Lifecycle:
//   1. Materialize the artifact body into an ephemeral tempdir.
//      - `entry.ts`     — written verbatim from the artifact body. The body
//        is expected to print exactly one JSON line prefixed by `@@RESULT@@ `
//        so the parent can parse cleanly without picking up stray logs.
//      - Inputs are exposed via `process.env.ACC2_INPUTS` (a JSON string).
//        We picked the env-var path over a virtual `acc2/in` module because
//        it requires zero rewriting of the artifact source and is uniform
//        across all bun runtime call sites.
//   2. Spawn `Bun.spawn([process.execPath, ...permArgs, "entry.ts"])` with
//      cwd = tempdir and env merged from buildBunPermissionArgs(decl).
//   3. Watchdog the process per §5.5:
//        - soft timeout: SIGTERM at wall_ms.
//        - hard timeout: SIGKILL at wall_ms * 1.25.
//      Each transition fires an `emit` callback the caller passes in (the
//      callback writes a runtime_subprocess_* event onto the substrate).
//   4. Drain stdout + stderr. Find the LAST line starting with `@@RESULT@@ `
//      and JSON.parse the suffix. If parsing fails, the observation is
//      `ok:false, error:"result_parse_failed"`.
//   5. Tempdir removed unconditionally in a `finally` block.
//
// Irreversible-effect detection (v2-design.md §6.2) is honor-system in Phase C:
// the bun process cannot reliably observe its own filesystem writes from
// outside, so `observation.irreversibleEffects` starts empty. Phase G adds an
// nsjail-based shim that intercepts open(O_WRONLY) and forwards effect records.

import type { Subprocess } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue, SandboxDecl } from "../../substrate/types";
import { buildBunPermissionArgs } from "../sandbox";
import type { EmitEventInput } from "../events";

export type BunRuntimeInvocation = {
  artifactId: string;
  body: string;
  declaredSandbox: SandboxDecl & { runtime: "bun" };
  inputs: JsonValue;
  budget?: { wallMs?: number; memoryMb?: number };
  /** Optional callback so the runtime can fire runtime_subprocess_* events.
   *  The caller is expected to persist these to the substrate; the runtime
   *  itself does NOT touch the database directly (one-write-path principle). */
  emit?: (event: EmitEventInput) => void;
};

export type BunRuntimeObservation = {
  ok: boolean;
  result?: JsonValue;
  error?: string;
  irreversibleEffects: Array<{ kind: string; description: string }>;
  durationMs: number;
  exitCode: number;
  stderrTail: string;
  /** Sandbox warnings forwarded from buildBunPermissionArgs — the caller may
   *  emit a `sandbox_unenforced_warning` event per entry. */
  sandboxWarnings: string[];
};

const RESULT_PREFIX = "@@RESULT@@ ";
const IRREVERSIBLE_PREFIX = "@@IRREVERSIBLE@@ ";
const STDERR_TAIL_BYTES = 1024;
/** Robustness: SIGKILL fires this many ms AFTER SIGTERM if the subprocess
 *  has not exited. Matches the camofox `SIGTERM_SIGKILL_ESCALATION_MS`
 *  constant — escalation is decoupled from wall_ms so a long-wall artifact
 *  that hangs at wall_ms still hard-kills 2s later, not wall_ms × 1.25.
 *  Override via ACC2_BUN_SIGKILL_ESCALATION_MS (rarely needed). */
const SIGTERM_SIGKILL_ESCALATION_MS = 2_000;

/** Scan stdout for `@@IRREVERSIBLE@@ <kind>:<description>` lines. The
 *  artifact opts in to declaring its irreversible effects via this marker
 *  (v2-design.md §6.2 + Phase H light-weight detection). Multiple lines
 *  allowed; the dispatcher fires irreversible_effect_recorded events for
 *  every entry. */
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

/** Read a ReadableStream<Uint8Array> end-to-end and return it as a string.
 *  Bun's spawn stdout/stderr are ReadableStream<Uint8Array>. */
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
    try {
      reader.releaseLock();
    } catch (err) {
      // releaseLock throws if the reader was already released — this is a
      // benign post-drain race, not a real failure. No emit needed.
      void err;
    }
  }
  return out;
};

/** Find the last @@RESULT@@ line in stdout and parse its JSON suffix.
 *  Returns the parsed value or `undefined` if no such line exists or it
 *  doesn't parse. */
const parseResultLine = (stdout: string): { ok: true; value: JsonValue } | { ok: false; reason: string } => {
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

const lastBytes = (s: string, n: number): string => {
  if (s.length <= n) return s;
  return s.slice(s.length - n);
};

/** Execute an artifact body under a bun subprocess and return the observation.
 *  Tempdir is created + cleaned up here; the caller does not need to manage it.
 *  Watchdog wakes at wall_ms (SIGTERM) and wall_ms × 1.25 (SIGKILL); both
 *  transitions, plus the started/completed pair, fire `emit` callbacks. */
export const runBunArtifact = async (
  inv: BunRuntimeInvocation,
): Promise<BunRuntimeObservation> => {
  const perm = buildBunPermissionArgs(inv.declaredSandbox);
  const wallMs = inv.budget?.wallMs ?? inv.declaredSandbox.wall_ms;
  const memoryMb = inv.budget?.memoryMb ?? inv.declaredSandbox.memory_mb;
  const dir = mkdtempSync(join(tmpdir(), `acc2-bun-${process.pid}-`));
  const entryPath = join(dir, "entry.ts");
  // The artifact body is written verbatim. Phase D's prompt composer will
  // ensure brain-emitted bodies follow the @@RESULT@@ convention; for now any
  // script that doesn't print the marker yields ok:false, result_marker_missing.
  writeFileSync(entryPath, inv.body, { mode: 0o600 });

  const env: Record<string, string> = {
    ...process.env,
    ...perm.env,
    ACC2_INPUTS: JSON.stringify(inv.inputs ?? null),
    ACC2_ARTIFACT_ID: inv.artifactId,
    ACC2_BUDGET_WALL_MS: String(wallMs),
    ACC2_BUDGET_MEMORY_MB: String(memoryMb),
  };

  const startMs = Date.now();
  let proc: Subprocess<"ignore", "pipe", "pipe"> | null = null;
  let softTimer: ReturnType<typeof setTimeout> | null = null;
  let hardTimer: ReturnType<typeof setTimeout> | null = null;
  let softFired = false;
  let hardFired = false;

  try {
    proc = Bun.spawn({
      cmd: [process.execPath, ...perm.argv, entryPath],
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
        runtime: "bun",
        pid: proc.pid ?? null,
        wall_ms: wallMs,
        memory_mb: memoryMb,
      } as JsonValue,
    });
    // §5.5 supervision event — pid + sandbox decl recorded at start.
    inv.emit?.({
      kind: "runtime_subprocess_started",
      substrate_origin: "substrate_auto",
      action_artifact_id: inv.artifactId,
      payload: {
        runtime: "bun",
        pid: proc.pid ?? null,
        wall_ms: wallMs,
        memory_mb: memoryMb,
      } as JsonValue,
    });

    // Soft watchdog — SIGTERM at wall_ms.
    // When SIGTERM fires we arm a follow-up SIGKILL `SIGTERM_SIGKILL_ESCALATION_MS`
    // later (independent of wall_ms) so a wedged subprocess always escalates
    // within a bounded window. This was previously scaled with wall_ms — long-
    // wall artifacts that hung at wall_ms had to wait wall_ms × 0.25 for the
    // hard kill, which hides the wedge behind the long timeout.
    const envEsc = Number(process.env.ACC2_BUN_SIGKILL_ESCALATION_MS ?? "");
    const escMs = Number.isFinite(envEsc) && envEsc > 0 ? envEsc : SIGTERM_SIGKILL_ESCALATION_MS;
    softTimer = setTimeout(() => {
      softFired = true;
      try { proc?.kill("SIGTERM"); } catch (killErr) {
        // already exited — debug only so the audit trail records the cause
        void killErr;
      }
      // Hard watchdog — SIGKILL escalation 2s after SIGTERM. Only fires if the
      // subprocess didn't drain in response to SIGTERM.
      hardTimer = setTimeout(() => {
        if (proc && proc.exitCode === null) {
          hardFired = true;
          try { proc.kill("SIGKILL"); } catch (killErr) { void killErr; }
          inv.emit?.({
            kind: "runtime_subprocess_killed",
            substrate_origin: "substrate_auto",
            action_artifact_id: inv.artifactId,
            payload: {
              runtime: "bun",
              reason: "sigterm_did_not_drain",
              escalation_ms: escMs,
              wall_ms: wallMs,
            } as JsonValue,
          });
        }
      }, escMs);
    }, Math.max(1, wallMs));

    // Read both streams concurrently with the exit code.
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
      // §5.5 — pair the artifact_observed phase row with the canonical
      // runtime_subprocess_soft_terminated supervision event.
      inv.emit?.({
        kind: "runtime_subprocess_soft_terminated",
        substrate_origin: "substrate_auto",
        action_artifact_id: inv.artifactId,
        payload: { runtime: "bun", wall_ms: wallMs, signal: "SIGTERM" } as JsonValue,
      });
    }
    if (hardFired) {
      inv.emit?.({
        kind: "artifact_observed",
        substrate_origin: "substrate_auto",
        action_artifact_id: inv.artifactId,
        payload: { phase: "hard_kill", signal: "SIGKILL", wall_ms: wallMs } as JsonValue,
      });
      inv.emit?.({
        kind: "runtime_subprocess_hard_killed",
        substrate_origin: "substrate_auto",
        action_artifact_id: inv.artifactId,
        payload: { runtime: "bun", wall_ms: wallMs, signal: "SIGKILL" } as JsonValue,
      });
    }

    // Surface sandbox warnings (e.g. unenforceable net_allow on bun) as
    // discoverable substrate events. §5.5 + §6.1 — warnings declared but
    // unenforced previously were swallowed inside the observation; the
    // event makes them queryable.
    for (const w of perm.warnings) {
      inv.emit?.({
        kind: "sandbox_unenforced_warning",
        substrate_origin: "substrate_auto",
        action_artifact_id: inv.artifactId,
        payload: { runtime: "bun", warning: w } as JsonValue,
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
        sandboxWarnings: perm.warnings,
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
        sandboxWarnings: perm.warnings,
      };
    }

    inv.emit?.({
      kind: "artifact_observed",
      substrate_origin: "substrate_auto",
      action_artifact_id: inv.artifactId,
      payload: { phase: "completed", duration_ms: durationMs } as JsonValue,
    });
    inv.emit?.({
      kind: "runtime_subprocess_completed",
      substrate_origin: "substrate_auto",
      action_artifact_id: inv.artifactId,
      payload: {
        runtime: "bun",
        duration_ms: durationMs,
        exit_code: exitCode,
      } as JsonValue,
    });

    return {
      ok: true,
      result: parsed.value,
      irreversibleEffects,
      durationMs,
      exitCode,
      stderrTail,
      sandboxWarnings: perm.warnings,
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
      sandboxWarnings: perm.warnings,
    };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* swallow */ }
  }
};
