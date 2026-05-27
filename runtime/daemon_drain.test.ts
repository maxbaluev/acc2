// Daemon graceful-drain, shutdown accounting, and force-terminate suites (split out of daemon.test.ts).
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
describe("bounded graceful drain (amendment 8EAKQCJW5D)", () => {
  let handle: DaemonHandle | null = null;
  let tmp = mkTmp();

  beforeEach(() => { tmp = mkTmp(); });
  afterEach(async () => { await cleanup(handle, tmp); handle = null; });

  test("default drain budget surfaces in restart_drain_started + daemon_shutdown payloads", async () => {
    handle = await bootHandle(tmp);
    // No in-flight dispatches → drain completes immediately. The payload
    // shape is what we're proving here; budget honoured = budget echoed.
    await stopDaemon(handle);
    handle = null;

    const db = openDb(tmp.dbPath);
    const started = db
      .query("SELECT payload FROM events WHERE kind = 'restart_drain_started' ORDER BY ts DESC LIMIT 1")
      .get() as { payload: string } | null;
    expect(started).toBeTruthy();
    const startedPayload = parsePayload(started!.payload);
    expect(startedPayload.timeout_ms).toBe(180_000); // default RESTART_DRAIN_TIMEOUT_MS
    expect(startedPayload.in_flight_count).toBe(0);
    expect(Array.isArray(startedPayload.in_flight_task_ids)).toBe(true);

    const shutdown = db
      .query("SELECT payload FROM events WHERE kind = 'daemon_shutdown' ORDER BY ts DESC LIMIT 1")
      .get() as { payload: string } | null;
    expect(shutdown).toBeTruthy();
    const shutdownPayload = parsePayload(shutdown!.payload);
    expect(shutdownPayload.drain_budget_ms).toBe(180_000);
    expect(shutdownPayload.drained_count).toBe(0);
    expect(shutdownPayload.interrupted_count).toBe(0);
    expect(shutdownPayload.in_flight_count_at_start).toBe(0);
    expect(typeof shutdownPayload.drain_elapsed_ms).toBe("number");
  });

  test("stopDaemon accepts a per-call drain budget and echoes it", async () => {
    handle = await bootHandle(tmp);
    // Pick a non-default budget so we can prove it threaded through.
    await stopDaemon(handle, 7_777);
    handle = null;

    const db = openDb(tmp.dbPath);
    const started = db
      .query("SELECT payload FROM events WHERE kind = 'restart_drain_started' ORDER BY ts DESC LIMIT 1")
      .get() as { payload: string } | null;
    expect(parsePayload(started!.payload).timeout_ms).toBe(7_777);

    const shutdown = db
      .query("SELECT payload FROM events WHERE kind = 'daemon_shutdown' ORDER BY ts DESC LIMIT 1")
      .get() as { payload: string } | null;
    expect(parsePayload(shutdown!.payload).drain_budget_ms).toBe(7_777);
  });

  test("budget == 0 takes the immediate-kill path and still emits the drain pair", async () => {
    handle = await bootHandle(tmp);
    const t0 = Date.now();
    await stopDaemon(handle, 0);
    const elapsed = Date.now() - t0;
    handle = null;
    // With nothing in flight, immediate-kill returns near-instantly.
    expect(elapsed).toBeLessThan(2_000);

    const db = openDb(tmp.dbPath);
    const started = db
      .query("SELECT payload FROM events WHERE kind = 'restart_drain_started' ORDER BY ts DESC LIMIT 1")
      .get() as { payload: string } | null;
    expect(parsePayload(started!.payload).timeout_ms).toBe(0);
    const shutdown = db
      .query("SELECT payload FROM events WHERE kind = 'daemon_shutdown' ORDER BY ts DESC LIMIT 1")
      .get() as { payload: string } | null;
    expect(parsePayload(shutdown!.payload).drain_budget_ms).toBe(0);
  });

  test("drain finishes early when nothing is in flight (no timed_out event)", async () => {
    handle = await bootHandle(tmp);
    // Generous budget — drain should still return in well under 1s because
    // IN_FLIGHT is empty (the helper short-circuits on snapshot.length === 0).
    const t0 = Date.now();
    await stopDaemon(handle, 60_000);
    const elapsed = Date.now() - t0;
    handle = null;
    expect(elapsed).toBeLessThan(5_000);

    const db = openDb(tmp.dbPath);
    const completed = db
      .query("SELECT COUNT(*) AS n FROM events WHERE kind = 'restart_drain_completed'")
      .get() as { n: number };
    const timedOut = db
      .query("SELECT COUNT(*) AS n FROM events WHERE kind = 'restart_drain_timed_out'")
      .get() as { n: number };
    expect(completed.n).toBeGreaterThanOrEqual(1);
    expect(timedOut.n).toBe(0);
  });

  test("POST /shutdown accepts drain_budget_ms from the request body and echoes it", async () => {
    handle = await bootHandle(tmp);
    const adminToken = handle.adminToken;
    const auxPort = handle.auxPort;
    const dbPath = tmp.dbPath;

    const res = await fetch(`http://127.0.0.1:${auxPort}/shutdown`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ drain_budget_ms: 4_242 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; status?: string; drain_budget_ms?: number };
    expect(body.ok).toBe(true);
    expect(body.status).toBe("shutting_down");
    expect(body.drain_budget_ms).toBe(4_242);

    // Wait for the scheduled stop to fire and emit the events.
    await new Promise((r) => setTimeout(r, 400));
    handle = null;

    const db = openDb(dbPath);
    const started = db
      .query("SELECT payload FROM events WHERE kind = 'restart_drain_started' ORDER BY ts DESC LIMIT 1")
      .get() as { payload: string } | null;
    expect(parsePayload(started!.payload).timeout_ms).toBe(4_242);
    const shutdown = db
      .query("SELECT payload FROM events WHERE kind = 'daemon_shutdown' ORDER BY ts DESC LIMIT 1")
      .get() as { payload: string } | null;
    expect(parsePayload(shutdown!.payload).drain_budget_ms).toBe(4_242);
  });

  test("POST /shutdown without drain_budget_ms falls back to the default budget", async () => {
    handle = await bootHandle(tmp);
    const adminToken = handle.adminToken;
    const auxPort = handle.auxPort;
    const dbPath = tmp.dbPath;

    const res = await fetch(`http://127.0.0.1:${auxPort}/shutdown`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { drain_budget_ms?: number };
    expect(body.drain_budget_ms).toBe(180_000);

    await new Promise((r) => setTimeout(r, 400));
    handle = null;

    const db = openDb(dbPath);
    const started = db
      .query("SELECT payload FROM events WHERE kind = 'restart_drain_started' ORDER BY ts DESC LIMIT 1")
      .get() as { payload: string } | null;
    expect(parsePayload(started!.payload).timeout_ms).toBe(180_000);
  });
});

// ── Drain-budget exceeded: structural assertions ─────────────────────
//
// We deliberately do NOT install a `mock.module(...)` stub for
// task_scheduler / bridge here — Bun's mock.module is process-global and
// leaks into every test suite that imports either module, silently
// breaking scheduler + fixture suites. Instead we cover the
// budget-exceeded path through (a) the integer-math invariant that the
// daemon emits in every shutdown payload (drained_count +
// interrupted_count === in_flight_count_at_start), and (b) the symbolic
// presence of the killed_opencode_procs counter on every daemon_shutdown
// row regardless of which branch the drain took.

describe("daemon_shutdown carries the full drain accounting (amendment 8EAKQCJW5D)", () => {
  let handle: DaemonHandle | null = null;
  let tmp = mkTmp();

  beforeEach(() => { tmp = mkTmp(); });
  afterEach(async () => { await cleanup(handle, tmp); handle = null; });

  test("payload exposes drained_count + interrupted_count + killed_opencode_procs (force-kill accounting fields)", async () => {
    handle = await bootHandle(tmp);
    await stopDaemon(handle, 12_345);
    handle = null;

    const db = openDb(tmp.dbPath);
    const shutdown = db
      .query("SELECT payload FROM events WHERE kind = 'daemon_shutdown' ORDER BY ts DESC LIMIT 1")
      .get() as { payload: string } | null;
    expect(shutdown).toBeTruthy();
    const payload = parsePayload(shutdown!.payload);
    // All accounting fields present so operators can read the shutdown
    // event and tell "how many drained vs how many got force-killed".
    expect(payload).toHaveProperty("drained_count");
    expect(payload).toHaveProperty("interrupted_count");
    expect(payload).toHaveProperty("killed_opencode_procs");
    expect(payload).toHaveProperty("in_flight_count_at_start");
    expect(payload).toHaveProperty("drain_budget_ms");
    expect(payload).toHaveProperty("drain_elapsed_ms");
    // Integer math invariant: every in-flight dispatch is accounted for
    // either as drained-cleanly or interrupted-by-budget.
    expect(
      (payload.drained_count as number) + (payload.interrupted_count as number),
    ).toBe(payload.in_flight_count_at_start as number);
    // Budget threading: the per-call argument is reflected in the
    // shutdown event so operators see exactly which budget was honoured.
    expect(payload.drain_budget_ms).toBe(12_345);
    // killAllLiveOpencodeProcs always runs after the drain (regardless of
    // completed vs timed_out); on a clean shutdown the counter is 0.
    expect(payload.killed_opencode_procs).toBe(0);
  });
});

// ── DAEMON STABILITY HARDENING (fix #5): force-clear a wedged brain ──────
//
// A restart used to WEDGE when an in-flight brain subprocess refused to
// drain within the budget. The stop() path now UNCONDITIONALLY kills every
// still-live opencode proc after the drain budget, emits a
// `brain_subprocess_force_terminated` evidence row per kill, and ALWAYS
// releases the socket lock — so restart can never hang indefinitely.
//
// We register a FAKE live proc (no real subprocess spawned) via the
// `_registerFakeLiveProcForTests` hook so the force-clear path runs without
// touching the live daemon or spawning opencode. The fake records every
// signal it receives so we can assert SIGTERM was delivered.
describe("daemon stop() force-terminates a stuck in-flight brain proc and releases the lock (fix #5)", () => {
  let handle: DaemonHandle | null = null;
  let tmp = mkTmp();

  beforeEach(() => { tmp = mkTmp(); });
  afterEach(async () => { await cleanup(handle, tmp); handle = null; });

  test("a registered live proc is SIGTERM'd, evidenced, and the socket lock is removed even on a zero-budget kill", async () => {
    const { _registerFakeLiveProcForTests, _liveOpencodeProcCountForTests } = await import("./bridge/opencode");
    handle = await bootHandle(tmp);
    expect(existsSync(tmp.socketFile)).toBe(true);

    // Simulate a wedged brain subprocess that the drain cannot finish.
    const fake = _registerFakeLiveProcForTests(987_654_321);
    expect(_liveOpencodeProcCountForTests()).toBeGreaterThanOrEqual(1);

    // Zero-budget stop = "immediate kill, no drain wait". stop() MUST return
    // (never hang on the stuck child) and MUST release the lock.
    await stopDaemon(handle, 0);
    handle = null;

    // The wedged proc was force-terminated: SIGTERM was delivered, the
    // registry was cleared, and the lock file is gone (lock released).
    expect(fake.signals).toContain("SIGTERM");
    expect(_liveOpencodeProcCountForTests()).toBe(0);
    expect(existsSync(tmp.socketFile)).toBe(false);
    expect(existsSync(tmp.tokenFile)).toBe(false);

    // Evidence trail: a force-termination row names the killed PID so the
    // ledger proves the wedged dispatch was killed, not silently abandoned.
    const db = openDb(tmp.dbPath);
    const ft = db
      .query("SELECT payload FROM events WHERE kind = 'brain_subprocess_force_terminated' ORDER BY ts DESC LIMIT 1")
      .get() as { payload: string } | null;
    expect(ft).toBeTruthy();
    const ftPayload = parsePayload(ft!.payload);
    expect(ftPayload.killed_count).toBe(1);
    const forced = ftPayload.forced_kills as Array<{ pid: number }>;
    expect(forced.some((k) => k.pid === 987_654_321)).toBe(true);

    // And the shutdown accounting reflects the forced kill.
    const shutdown = db
      .query("SELECT payload FROM events WHERE kind = 'daemon_shutdown' ORDER BY ts DESC LIMIT 1")
      .get() as { payload: string } | null;
    expect(parsePayload(shutdown!.payload).killed_opencode_procs).toBe(1);
  });
});
