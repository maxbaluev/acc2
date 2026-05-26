// CRASH-RESILIENCE watchdog (resource-spec AHV73KJDK54P3FF7D2NDV9TQ2C).
//
// The measured stuck-states this watchdog eliminates:
//   - A native Bun SIGILL/SIGSEGV killed the daemon; the next start hit
//     EADDRINUSE on 9387 because the crashed process left the port + a stale
//     lock behind → manual recovery needed.
//   - The system could not self-recover because nothing detected the dead
//     daemon and respawned a single replacement.
//
// These tests drive the recovery functions with injected effects (no real
// subprocess, no real daemon) so the design is verifiable deterministically:
//   1. stale-lock / dead-pid detection (detectStaleLock).
//   2. port-release polling (waitForPortRelease) — both the released and the
//      still-held outcomes.
//   3. full recovery: detect dead → release ports → reap lock → respawn
//      EXACTLY ONE daemon (no duplicate).
//   4. live incumbent → no-op (never duplicate OR kill a live daemon).
//   5. HARD CONSTRAINT: a pid-ALIVE-but-slow/unresponsive daemon (a long
//      20+ min brain cycle) is left COMPLETELY untouched — no respawn, no kill,
//      no process.kill of any kind. Recovery is CRASH-ONLY (pid gone).
//   6. port held by a non-child → operator diagnostic, NOT a respawn thrash.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectStaleLock } from "./state_paths";
import {
  recoverCrashedDaemon,
  waitForPortRelease,
  type SupervisorChildHandle,
  type CrashWatchdogDeps,
} from "./daemon_supervisor";

let dir: string;
let lockPath: string;
let tokenPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "acc2-resil-"));
  lockPath = join(dir, "v2.sock");
  tokenPath = join(dir, "v2.sock.token");
});

afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

const writeLock = (payload: Record<string, unknown>): void => {
  writeFileSync(lockPath, JSON.stringify(payload), { mode: 0o600 });
};

const fakeChild = (pid: number): SupervisorChildHandle => ({
  pid,
  exited: false,
  exitCode: null,
});

describe("detectStaleLock — crashed-daemon signature", () => {
  test("no lock file → not stale, not present", () => {
    const v = detectStaleLock(lockPath, () => false);
    expect(v.present).toBe(false);
    expect(v.stale).toBe(false);
    expect(v.reason).toBe("no_lock");
  });

  test("lock + LIVE pid → not stale (healthy incumbent)", () => {
    writeLock({ pid: 4242, port: 9387, aux_port: 9388 });
    const v = detectStaleLock(lockPath, (pid) => pid === 4242);
    expect(v.present).toBe(true);
    expect(v.stale).toBe(false);
    expect(v.reason).toBe("pid_alive");
    expect(v.pid).toBe(4242);
  });

  test("lock + DEAD pid → stale (SIGILL/SIGSEGV signature)", () => {
    writeLock({ pid: 99999, port: 9387, aux_port: 9388 });
    const v = detectStaleLock(lockPath, () => false);
    expect(v.stale).toBe(true);
    expect(v.reason).toBe("pid_dead");
    expect(v.pid).toBe(99999);
  });

  test("malformed lock → stale", () => {
    writeFileSync(lockPath, "{not json", { mode: 0o600 });
    const v = detectStaleLock(lockPath, () => true);
    expect(v.stale).toBe(true);
    expect(v.reason).toBe("malformed");
  });

  test("lock with no pid → stale", () => {
    writeLock({ port: 9387 });
    const v = detectStaleLock(lockPath, () => true);
    expect(v.stale).toBe(true);
    expect(v.reason).toBe("no_pid");
  });
});

describe("waitForPortRelease — bounded OS port-release poll", () => {
  test("returns empty when ports release before the deadline", async () => {
    let calls = 0;
    const released = await waitForPortRelease(
      [9387, 9388],
      { deadlineMs: 1000, pollIntervalMs: 10 },
      {
        // Bound on the first poll, free on the second.
        isPortBound: async () => { calls += 1; return calls <= 2; },
        sleep: async () => {},
      },
    );
    expect(released).toEqual([]);
  });

  test("returns the still-bound ports when the deadline expires", async () => {
    let now = 0;
    const stillBound = await waitForPortRelease(
      [9387, 9388],
      { deadlineMs: 100, pollIntervalMs: 20 },
      {
        isPortBound: async (p) => p === 9387, // 9387 never releases
        nowMs: () => now,
        sleep: async (ms) => { now += ms; },
      },
    );
    expect(stillBound).toEqual([9387]);
  });
});

describe("recoverCrashedDaemon — detect → release → reap → single respawn", () => {
  test("dead-pid stale lock → reaps lock+token, respawns EXACTLY ONE daemon", async () => {
    writeLock({ pid: 99999, port: 9387, aux_port: 9388 });
    writeFileSync(tokenPath, "tok", { mode: 0o600 });

    let spawnCount = 0;
    const deps: CrashWatchdogDeps = {
      pidAlive: () => false,           // pid is dead (crashed)
      isPortBound: async () => false,  // ports already released
      spawnDaemon: () => { spawnCount += 1; return fakeChild(5555); },
    };

    const result = await recoverCrashedDaemon(
      { lockPath, tokenPath, stateDir: dir, ports: [9387, 9388] },
      deps,
    );

    expect(result.action).toBe("recovered");
    if (result.action === "recovered") {
      expect(result.respawn_pid).toBe(5555);
      expect(result.reaped).toContain(lockPath);
      expect(result.reaped).toContain(tokenPath);
    }
    // Single respawn — NO duplicate daemon.
    expect(spawnCount).toBe(1);
    // Stale files reaped.
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(tokenPath)).toBe(false);
  });

  test("LIVE incumbent (pid alive) → no-op, never respawns, never kills", async () => {
    writeLock({ pid: 4242, port: 9387, aux_port: 9388 });
    let spawnCount = 0;
    const result = await recoverCrashedDaemon(
      { lockPath, tokenPath, stateDir: dir, ports: [9387, 9388] },
      {
        pidAlive: (pid) => pid === 4242,
        spawnDaemon: () => { spawnCount += 1; return fakeChild(1); },
      },
    );
    expect(result.action).toBe("no_recovery_needed");
    if (result.action === "no_recovery_needed") expect(result.reason).toBe("lock_healthy");
    expect(spawnCount).toBe(0);
    // Lock untouched — we never disturb a live daemon.
    expect(existsSync(lockPath)).toBe(true);
  });

  // ── HARD CONSTRAINT (owner flagged twice): NEVER kill live long-running
  // brain work. A slow / unresponsive but ALIVE daemon (a 20+ min opencode/
  // GPT-5.5 brain cycle) must be left COMPLETELY untouched. The watchdog
  // watches the OS process lifecycle (pid liveness), NOT responsiveness. This
  // test simulates exactly that signature: pid alive, ports bound, the daemon
  // would answer /health slowly or not at all — and asserts the watchdog does
  // NOT respawn, does NOT reap the lock, and issues NO process.kill of any
  // signal whatsoever.
  test("slow/unresponsive but ALIVE daemon (long brain cycle) → NO respawn, NO kill, lock untouched", async () => {
    writeLock({ pid: 4242, port: 9387, aux_port: 9388 });
    let spawnCount = 0;
    let portProbed = false;
    const killSignals: Array<{ pid: number; sig: string | number | undefined }> = [];
    const realKill = process.kill;
    const spyKill = ((pid: number, sig?: string | number): true => {
      killSignals.push({ pid, sig });
      // Never forward to the real kill — we are asserting it is never called
      // for the incumbent on this path; if a regression calls it we record it.
      if (pid !== 4242) realKill.call(process, pid, sig as never);
      return true;
    }) as unknown as typeof process.kill;
    (process as unknown as { kill: typeof process.kill }).kill = spyKill;
    try {
      const result = await recoverCrashedDaemon(
        { lockPath, tokenPath, stateDir: dir, ports: [9387, 9388] },
        {
          // pid is ALIVE — the daemon process exists, it is merely slow.
          pidAlive: (pid) => pid === 4242,
          // If the watchdog ever reached the recovery path it would poll ports;
          // assert it does NOT by failing the test if this runs.
          isPortBound: async () => { portProbed = true; return false; },
          spawnDaemon: () => { spawnCount += 1; return fakeChild(9999); },
        },
      );
      // No recovery: the live process is left untouched.
      expect(result.action).toBe("no_recovery_needed");
      if (result.action === "no_recovery_needed") expect(result.reason).toBe("lock_healthy");
      // NO respawn.
      expect(spawnCount).toBe(0);
      // NO kill of the live incumbent (no SIGTERM, no SIGKILL, no signal at all).
      expect(killSignals.filter((k) => k.pid === 4242)).toEqual([]);
      // The recovery path (port poll) was never entered.
      expect(portProbed).toBe(false);
      // Lock untouched — the slow daemon keeps owning it.
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      (process as unknown as { kill: typeof process.kill }).kill = realKill;
    }
  });

  // ── CRASH-ONLY recovery: a daemon that ACTUALLY exited (native Bun SIGILL/
  // SIGSEGV) leaves a stale lock whose pid is GONE. THIS is the only condition
  // that triggers recovery. We simulate the dead pid, a brief port-release
  // delay (the OS reclaims the port a tick after the process dies), and assert
  // a SINGLE idempotent respawn — no duplicate daemon.
  test("ACTUAL child exit / SIGILL (pid gone) → port-release poll → single idempotent respawn (no duplicate)", async () => {
    writeLock({ pid: 4242, port: 9387, aux_port: 9388 });
    writeFileSync(tokenPath, "tok", { mode: 0o600 });
    let spawnCount = 0;
    let portPolls = 0;
    let now = 0;
    const result = await recoverCrashedDaemon(
      { lockPath, tokenPath, stateDir: dir, ports: [9387, 9388], portReleaseDeadlineMs: 5_000, portPollIntervalMs: 50 },
      {
        // The child PROCESS is gone — crashed via SIGILL/SIGSEGV.
        pidAlive: () => false,
        // Port still held for the first poll, released by the second (the OS
        // reclaims it a tick after the dead process is reaped).
        isPortBound: async () => { portPolls += 1; return portPolls <= 2; },
        nowMs: () => now,
        sleep: async (ms) => { now += ms; },
        spawnDaemon: () => { spawnCount += 1; return fakeChild(5555); },
      },
    );
    expect(result.action).toBe("recovered");
    if (result.action === "recovered") {
      expect(result.respawn_pid).toBe(5555);
      expect(result.verdict.reason).toBe("pid_dead");
    }
    // The port-release poll WAS entered (this is the crash path).
    expect(portPolls).toBeGreaterThan(0);
    // EXACTLY ONE respawn — no duplicate daemon.
    expect(spawnCount).toBe(1);
    // Stale lock + token reaped so the respawn's O_CREAT|O_EXCL boot lock wins.
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(tokenPath)).toBe(false);
  });

  test("port held by a non-child past the deadline → operator diagnostic, NO respawn thrash", async () => {
    writeLock({ pid: 99999, port: 9387, aux_port: 9388 });
    let spawnCount = 0;
    let now = 0;
    const result = await recoverCrashedDaemon(
      { lockPath, tokenPath, stateDir: dir, ports: [9387, 9388], portReleaseDeadlineMs: 100, portPollIntervalMs: 20 },
      {
        pidAlive: () => false,                 // lock owner is dead
        isPortBound: async (p) => p === 9387,  // but 9387 is held by someone else
        nowMs: () => now,
        sleep: async (ms) => { now += ms; },
        spawnDaemon: () => { spawnCount += 1; return fakeChild(7777); },
      },
    );
    expect(result.action).toBe("operator_diagnostic_required");
    if (result.action === "operator_diagnostic_required") {
      expect(result.ports_still_bound).toEqual([9387]);
    }
    // Must NOT respawn into an occupied port.
    expect(spawnCount).toBe(0);
  });

  test("no lock at all → no_recovery_needed (watchdog only respawns after a crash)", async () => {
    let spawnCount = 0;
    const result = await recoverCrashedDaemon(
      { lockPath, tokenPath, stateDir: dir, ports: [9387, 9388] },
      { spawnDaemon: () => { spawnCount += 1; return fakeChild(1); } },
    );
    expect(result.action).toBe("no_recovery_needed");
    if (result.action === "no_recovery_needed") expect(result.reason).toBe("no_lock");
    expect(spawnCount).toBe(0);
  });

  test("CONCURRENT watchdogs do not create duplicate daemons (each delegates to the lock-aware entry)", async () => {
    // Two watchdogs race on the same stale lock. Each respawn delegates the
    // single-writer guarantee to the daemon's O_CREAT|O_EXCL boot lock, so
    // even if both reach spawnDaemon, the children themselves can never BOTH
    // win the lock. Here we assert that after the first recovery reaps the
    // lock, the second sees no lock and does NOT respawn — the FS state is the
    // serialization point.
    writeLock({ pid: 99999, port: 9387, aux_port: 9388 });
    let spawnCount = 0;
    const deps: CrashWatchdogDeps = {
      pidAlive: () => false,
      isPortBound: async () => false,
      spawnDaemon: () => { spawnCount += 1; return fakeChild(8888); },
    };
    const first = await recoverCrashedDaemon({ lockPath, tokenPath, stateDir: dir, ports: [9387, 9388] }, deps);
    const second = await recoverCrashedDaemon({ lockPath, tokenPath, stateDir: dir, ports: [9387, 9388] }, deps);
    expect(first.action).toBe("recovered");
    // Second watchdog sees the reaped lock → no_recovery_needed, no respawn.
    expect(second.action).toBe("no_recovery_needed");
    expect(spawnCount).toBe(1);
  });
});
