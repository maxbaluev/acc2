// Shared fixtures for the daemon-lifecycle test files. Extracted from the
// former monolithic runtime/daemon.test.ts so the lifecycle suites can be
// split across several files and run in PARALLEL across Bun test workers.
//
// WHY: Bun's `--parallel` schedules whole *files* onto workers, so a single
// 30s daemon.test.ts (17 daemon boots + graceful-drain stops + readiness
// waits, all serial within one file) was the entire suite's critical path —
// the parallel wall-clock could never drop below that one file. Splitting the
// lifecycle tests into independent files (each booting its own throwaway
// daemon on OS-assigned free ports) lets the boots fan out across workers.
//
// This is NOT a *.test.ts file, so the runner ignores it; it only carries the
// fixtures the split files import.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../substrate/db";
import { startDaemon, stopDaemon, type DaemonHandle } from "./daemon";
import { getFreePortPair, startDaemonOnFreePorts } from "../tests/free_port";

// OS-assigned free ports (collision-free by construction). getFreePort asks the
// OS for a guaranteed-free ephemeral port — no band bookkeeping, no collision
// with the live daemon (9387/9388) or sibling test files, so the suite is safe
// to run alongside a live daemon.
export const pickPortPair = (): { mcp: number; aux: number } => getFreePortPair();

export type Tmp = { dir: string; dbPath: string; socketFile: string; tokenFile: string };

export const mkTmp = (): Tmp => {
  const dir = mkdtempSync(join(tmpdir(), "acc2-daemon-"));
  return {
    dir,
    dbPath: join(dir, "test.db"),
    socketFile: join(dir, "v2.sock"),
    tokenFile: join(dir, "v2.sock.token"),
  };
};

// Resilient boot for the common case: fresh OS-assigned ports + EADDRINUSE
// retry over the tiny close→reuse window. The few tests that need a SPECIFIC
// port pair (same-port rebind on restart, second-instance lock contention)
// still call startDaemon directly.
export const bootHandle = (tmp: Tmp): Promise<DaemonHandle> =>
  startDaemonOnFreePorts(startDaemon, {
    stateDbPath: tmp.dbPath,
    socketFile: tmp.socketFile,
    tokenFile: tmp.tokenFile,
  });

export const cleanup = async (handle: DaemonHandle | null, tmp: Tmp): Promise<void> => {
  if (handle) {
    try { await stopDaemon(handle); } catch { /* swallow */ }
  }
  closeDb();
  rmSync(tmp.dir, { recursive: true, force: true });
};

export const parsePayload = (raw: string): Record<string, unknown> => {
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
};
