// CRASH-RESILIENCE daemon control surface (resource-spec
// AHV73KJDK54P3FF7D2NDV9TQ2C).
//
// This module is the canonical, supervisor-aware daemon launch + bounded-stop
// path. The cli/dispatch.ts `daemon` subcommand delegates here so the crash
// watchdog is wired in ONE place.
//
// Two stuck-states this surface eliminates:
//
//   1. EADDRINUSE after a native crash. A daemon that died on a Bun
//      SIGILL/SIGSEGV skips stop(); its ports + lock are left behind and the
//      next plain `start` either short-circuits on the stale lock or fails to
//      bind. `startDaemonSupervised` runs the crash watchdog FIRST: it reaps
//      the stale lock, polls for OS port release, and respawns exactly one
//      daemon (lock-aware — never duplicates). When the watchdog finds a
//      HEALTHY incumbent it is a no-op; when it finds a non-child holding the
//      port it surfaces an operator diagnostic instead of thrashing.
//
//   2. A restart that hangs because stop() awaited mcpServer.stop() unbounded.
//      The bound now lives inside the daemon's stop() (runtime/daemon.ts
//      withTimeout); `stopDaemonBounded` additionally caps the CLIENT-side
//      wait so the operator's `stop`/`restart` command always returns in
//      bounded time even if the daemon never acknowledges.
//
// `--foreground-child` opts OUT of the watchdog and spawns the raw daemon
// (the prior behaviour) for debugging / tests that want a bare child.

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import {
  resolveSocketFile,
  resolveStateDir,
  detectStaleLock,
} from "../runtime/state_paths";
import { recoverCrashedDaemon } from "../runtime/daemon_supervisor";

/** Resolve the canonical daemon entry (`runtime/daemon.ts`). */
const resolveDaemonEntry = (): string =>
  resolve(import.meta.dirname ?? ".", "..", "runtime", "daemon.ts");

export type SupervisedStartResult = {
  /** What the start path did. */
  outcome: "already_healthy" | "recovered_and_respawned" | "spawned_fresh" | "operator_diagnostic_required";
  pid: number | null;
  detail: string;
  ports_still_bound?: number[];
};

/**
 * Canonical `acc daemon start` body. Lock-aware + idempotent + crash-resilient.
 *
 * Flow:
 *   1. If a lock exists, run the crash watchdog (recoverCrashedDaemon). It
 *      returns:
 *        - no_recovery_needed/lock_healthy → already running, no-op.
 *        - recovered → it ALREADY respawned a single daemon; return its pid.
 *        - operator_diagnostic_required → a non-child holds the port; surface
 *          the diagnostic, do NOT spawn (avoids the EADDRINUSE thrash loop).
 *   2. If no lock exists, spawn a fresh daemon via the canonical entry. The
 *      child's own O_CREAT|O_EXCL boot lock guarantees a single daemon even
 *      under a concurrent-start race.
 *
 * `foregroundChild:true` skips the watchdog and spawns the raw daemon.
 */
export const startDaemonSupervised = async (
  opts: { foregroundChild?: boolean; logFd?: number } = {},
): Promise<SupervisedStartResult> => {
  const entry = resolveDaemonEntry();
  const stateDir = resolveStateDir();

  // When the caller provides a log fd (the `acc daemon start` CLI does, to
  // preserve the operator-tailable ${stateDir}/logs/daemon.log) the fresh
  // child's stdout/stderr are wired there instead of /dev/null, so a silent
  // startup death still leaves a trace.
  const childStdio: ["ignore", number | "ignore", number | "ignore"] =
    typeof opts.logFd === "number"
      ? ["ignore", opts.logFd, opts.logFd]
      : ["ignore", "ignore", "ignore"];

  const spawnFresh = (): SupervisedStartResult => {
    const child = spawn("bun", [entry], {
      detached: true,
      stdio: childStdio,
      env: { ...process.env },
    });
    child.unref();
    return {
      outcome: "spawned_fresh",
      pid: child.pid ?? null,
      detail: `spawned daemon pid=${child.pid ?? "?"}`,
    };
  };

  if (opts.foregroundChild) {
    return spawnFresh();
  }

  const lockPath = resolveSocketFile();
  const verdict = detectStaleLock(lockPath);

  // No lock at all → nothing to recover; spawn fresh.
  if (!verdict.present) {
    return spawnFresh();
  }

  // A lock exists. Let the crash-only watchdog decide based purely on the OS
  // process lifecycle: pid ALIVE → already running, leave it completely
  // untouched (no kill, no /health probe — a slow-but-alive daemon running a
  // long brain cycle is legitimate work). pid GONE / stale lock → reap +
  // respawn EXACTLY ONE. Non-child holding the port → operator diagnostic. The
  // watchdog itself performs the respawn, so we never double-spawn.
  const recovery = await recoverCrashedDaemon({ lockPath, stateDir });

  if (recovery.action === "no_recovery_needed") {
    return {
      outcome: "already_healthy",
      pid: verdict.pid,
      detail: `daemon already running pid=${verdict.pid ?? "?"} (${recovery.reason})`,
    };
  }
  if (recovery.action === "operator_diagnostic_required") {
    return {
      outcome: "operator_diagnostic_required",
      pid: null,
      detail: `ports ${recovery.ports_still_bound.join(",")} held by a non-child process — manual intervention required`,
      ports_still_bound: recovery.ports_still_bound,
    };
  }
  return {
    outcome: "recovered_and_respawned",
    pid: recovery.respawn_pid,
    detail: `reaped stale daemon (${recovery.verdict.reason}), released ports, respawned pid=${recovery.respawn_pid ?? "?"}`,
  };
};

/**
 * Client-side bounded stop. Posts /shutdown with the requested drain budget
 * and waits at most `drainBudgetMs + slackMs` for the acknowledgement. The
 * daemon's own stop() is already bounded (mcpServer.stop withTimeout), so the
 * ack is fast; this cap protects the operator from a wedged listener that
 * never even returns the ack. Returns once the ack lands OR the client
 * deadline expires — `stop`/`restart` therefore ALWAYS complete in bounded
 * time.
 */
export const stopDaemonBounded = async (
  opts: { drainBudgetMs?: number; ackSlackMs?: number } = {},
): Promise<{ ok: boolean; detail: string }> => {
  const { auxBaseUrl, readAdminToken, rpcPostAuth } = await import("./rpc");
  const base = auxBaseUrl();
  if (!base) return { ok: true, detail: "daemon not running" };
  const token = readAdminToken();
  if (!token) return { ok: false, detail: "admin token file missing — cannot stop daemon safely" };

  const drainBudgetMs = opts.drainBudgetMs;
  const ackSlackMs = opts.ackSlackMs ?? 5_000;
  // The ack returns the INSTANT scheduler admission is fenced + stop() is
  // scheduled — it does NOT wait for the whole drain. So the client wait is
  // small + bounded regardless of drain budget.
  const ackTimeoutMs = ackSlackMs;
  const body = typeof drainBudgetMs === "number" ? { drain_budget_ms: drainBudgetMs } : {};
  try {
    const reply = await rpcPostAuth<{ ok?: boolean; error?: string; drain_budget_ms?: number }>(
      `${base}/shutdown`,
      token,
      body,
      { timeoutMs: ackTimeoutMs },
    );
    if (!reply.ok) return { ok: false, detail: `shutdown refused: ${reply.error}` };
    const drain = typeof reply.drain_budget_ms === "number" ? ` drain_budget_ms=${reply.drain_budget_ms}` : "";
    return { ok: true, detail: `daemon shutdown requested${drain}` };
  } catch (err) {
    // Even if the ack never returns (wedged listener), we do not hang — the
    // rpc timeout fires and we surface a bounded failure the operator can act
    // on (the watchdog will reap + respawn on the next start).
    return { ok: false, detail: `shutdown ack timed out within ${ackTimeoutMs}ms: ${String(err)}` };
  }
};
