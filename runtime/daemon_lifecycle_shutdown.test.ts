// Daemon lifecycle — instant-boot / starved-read / shutdown / second-instance (part 2).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../substrate/db";
import { startDaemon, stopDaemon, isDaemonAlreadyRunningError, getBootIntegrityState, runBudgetedSweep, type DaemonHandle, type BudgetedStep } from "./daemon";
import { handleGetEvent, handleRead } from "./mcp_server/substrate_tools";
import { recordReadAttemptStart, recordReadSuccess, READ_PATH_LATENCY_MS } from "./readiness";
import { handleRecentEvents } from "./mcp_server/runtime_tools";
import { isSchedulerDraining } from "./task_scheduler";
import { getSqlPool, clearSqlPool } from "./sql_pool_singleton";
import { getFreePortPair, startDaemonOnFreePorts } from "../tests/free_port";
import { mkTmp, bootHandle, cleanup, pickPortPair, parsePayload, type Tmp } from "./daemon_test_helpers";

describe("startDaemon — shutdown + second-instance (part 2)", () => {
  let handle: DaemonHandle | null = null;
  let tmp = mkTmp();

  beforeEach(() => { tmp = mkTmp(); });
  afterEach(async () => { await cleanup(handle, tmp); handle = null; });
  test("a starved read path makes /health report read_path starved while stuck_workers stays empty", async () => {
    handle = await bootHandle(tmp);

    // Healthy baseline: a freshly-booted daemon with no read traffic is NOT
    // starved (no-traffic is not a fault) and has no stuck workers.
    {
      const res = await fetch(`http://127.0.0.1:${handle.auxPort}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      const readPath = body.read_path as { starved?: boolean } | undefined;
      expect(readPath?.starved).toBe(false);
      expect(body.stuck_workers).toEqual([]);
    }

    // Drive the read-path probe directly into a starved state: a completed
    // read whose latency exceeds the ceiling (reason: last_latency_exceeds).
    // This is the read-path dimension being ORTHOGONAL to worker liveness —
    // the workers are all ticking, yet the aux /read path is degraded.
    recordReadAttemptStart();
    recordReadSuccess(READ_PATH_LATENCY_MS + 5_000);

    const res = await fetch(`http://127.0.0.1:${handle.auxPort}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const readPath = body.read_path as { starved?: boolean; reason?: string } | undefined;
    expect(readPath?.starved).toBe(true);
    expect(readPath?.reason).toBe("last_latency_exceeds");
    // The starvation is read-path-only: no worker is stuck.
    expect(body.stuck_workers).toEqual([]);

    // Clear the process-global probe state so this synthetic starvation does
    // not leak into sibling tests (e.g. the /ready gate, which fails closed on
    // readPathStatus().starved): a fast completed read resets the verdict.
    recordReadAttemptStart();
    recordReadSuccess(1);
  });

  test("stopDaemon emits daemon_shutdown, removes the lockfile, closes both ports", async () => {
    handle = await bootHandle(tmp);
    const auxPort = handle.auxPort;
    await stopDaemon(handle);
    handle = null;

    expect(existsSync(tmp.socketFile)).toBe(false);

    // Subsequent fetch must fail — aux server has stopped.
    let failed = false;
    try { await fetch(`http://127.0.0.1:${auxPort}/health`); } catch { failed = true; }
    expect(failed).toBe(true);

    // Reopen the db (fresh cache slot) and confirm drain + shutdown landed.
    const db = openDb(tmp.dbPath);
    const shutdown = db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'daemon_shutdown'").get() as { n: number };
    const drainStarted = db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'restart_drain_started'").get() as { n: number };
    const drainCompleted = db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'restart_drain_completed'").get() as { n: number };
    expect(shutdown.n).toBeGreaterThanOrEqual(1);
    expect(drainStarted.n).toBeGreaterThanOrEqual(1);
    expect(drainCompleted.n).toBeGreaterThanOrEqual(1);
  });

  test("second-instance attempt under the same socket lock fails fast", async () => {
    handle = await bootHandle(tmp);

    // Try again — same socket file, this process is alive, so we expect a throw.
    const other = pickPortPair();
    let caught: Error | null = null;
    try {
      await startDaemon({
        port: other.mcp, auxPort: other.aux, stateDbPath: join(tmp.dir, "other.db"),
        socketFile: tmp.socketFile, tokenFile: tmp.tokenFile,
      });
    } catch (err) { caught = err as Error; }
    expect(caught).toBeTruthy();
    expect(caught!.message).toContain("daemon already running");
  });

  test("POST /shutdown (on auxPort) with the admin token gracefully stops the daemon", async () => {
    handle = await bootHandle(tmp);
    const adminToken = handle.adminToken;
    const auxPort = handle.auxPort;

    const res = await fetch(`http://127.0.0.1:${auxPort}/shutdown`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; status?: string };
    expect(body.ok).toBe(true);
    expect(body.status).toBe("shutting_down");
    expect(isSchedulerDraining()).toBe(true);

    // The /shutdown route schedules the actual teardown on a setTimeout so the
    // 200-status response flushes first; stop() then drains the SQL pool,
    // closes the DB, and removes the lock/token files. The true invariant is
    // "graceful shutdown EVENTUALLY releases the socket lock", not "within a
    // fixed 200ms". A single sleep-then-check raced the teardown whenever the
    // process was busy (e.g. right after a preceding daemon boot/teardown in
    // the same file), leaving the socket file still present at the check —
    // a flaky failure that did not reflect a real daemon defect. Poll the
    // invariant with a bounded deadline instead: deterministic, and still
    // fails loudly if the daemon genuinely never releases the lock.
    // Deadline is generous (30s) because under the full --parallel suite (6
    // workers + a possibly-live host daemon) graceful teardown — drain SQL
    // pool, release socket — can exceed a few seconds under contention; the
    // 25ms poll exits the instant the socket is gone, so a fast teardown pays
    // nothing. A short 5s deadline was the sole source of a whole-suite retry.
    const deadline = Date.now() + 30000;
    while (existsSync(tmp.socketFile) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    handle = null;

    // Lockfile removed by the graceful teardown.
    expect(existsSync(tmp.socketFile)).toBe(false);
  });

  test("POST /shutdown without the admin token returns 401", async () => {
    handle = await bootHandle(tmp);
    const res = await fetch(`http://127.0.0.1:${handle.auxPort}/shutdown`, {
      method: "POST",
      headers: { authorization: "Bearer not-the-real-token" },
    });
    expect(res.status).toBe(401);
  });

});
