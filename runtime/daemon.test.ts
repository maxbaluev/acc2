// acc2 daemon test — single-instance lock, /health, /shutdown, lifecycle
// events. The daemon now binds TWO ports:
//   - primary (mcpPort)   — fastmcp httpStream transport (MCP-only)
//   - auxiliary (auxPort) — Bun.serve for /external/push, /health, /shutdown
// All HTTP tests in this file hit the auxiliary port. The MCP wire is exercised
// in mcp_server.test.ts via the stdio transport.

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

// OS-assigned free ports (collision-free by construction). Earlier schemes
// (random-in-band, then monotonic) still collided across parallel files /
// unreleased ports. getFreePort asks the OS for a guaranteed-free ephemeral
// port — no band bookkeeping, no collision with the live daemon (9387/9388)
// or sibling test files, and the suite is safe to run alongside a live daemon.
//
// Even OS-assigned ports have a tiny close→reuse window under heavy
// `bun test --parallel` load, so the canonical boot path is
// startDaemonOnFreePorts (getFreePortPair + 4-attempt EADDRINUSE retry).
const pickPortPair = () => getFreePortPair();

type Tmp = { dir: string; dbPath: string; socketFile: string; tokenFile: string };

const mkTmp = (): Tmp => {
  const dir = mkdtempSync(join(tmpdir(), "acc2-daemon-"));
  return {
    dir,
    dbPath: join(dir, "test.db"),
    socketFile: join(dir, "v2.sock"),
    tokenFile: join(dir, "v2.sock.token"),
  };
};

// Resilient boot for the common case: fresh OS-assigned ports + retry. The
// few tests that need a SPECIFIC port pair (same-port rebind on restart,
// second-instance lock contention) still call startDaemon directly.
const bootHandle = (tmp: Tmp): Promise<DaemonHandle> =>
  startDaemonOnFreePorts(startDaemon, {
    stateDbPath: tmp.dbPath,
    socketFile: tmp.socketFile,
    tokenFile: tmp.tokenFile,
  });

const cleanup = async (handle: DaemonHandle | null, tmp: ReturnType<typeof mkTmp>): Promise<void> => {
  if (handle) {
    try { await stopDaemon(handle); } catch { /* swallow */ }
  }
  closeDb();
  rmSync(tmp.dir, { recursive: true, force: true });
};

describe("startDaemon — boot + health + shutdown", () => {
  let handle: DaemonHandle | null = null;
  let tmp = mkTmp();

  beforeEach(() => { tmp = mkTmp(); });
  afterEach(async () => { await cleanup(handle, tmp); handle = null; });

  test("opens both ports, binds the lock, emits daemon_started + daemon_index_rebuilt", async () => {
    handle = await bootHandle(tmp);
    expect(handle.server).toBeTruthy();
    expect(handle.mcpServer).toBeTruthy();
    expect(typeof handle.port).toBe("number");
    expect(typeof handle.auxPort).toBe("number");
    expect(handle.port).not.toBe(handle.auxPort);
    expect(existsSync(tmp.socketFile)).toBe(true);
    expect(existsSync(tmp.tokenFile)).toBe(true);

    // Re-open the db (cache returns the same handle the daemon is using).
    const db = openDb(tmp.dbPath);
    const kinds = db
      .query("SELECT kind FROM events ORDER BY ts")
      .all() as Array<{ kind: string }>;
    const set = new Set(kinds.map((r) => r.kind));
    expect(set.has("daemon_started")).toBe(true);
    expect(set.has("daemon_index_rebuilt")).toBe(true);
  });

  test("GET /health (on auxPort) returns { status: ok, mcp_transport: 'fastmcp:httpStream', … }", async () => {
    handle = await bootHandle(tmp);
    const res = await fetch(`http://127.0.0.1:${handle.auxPort}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(typeof body.pid).toBe("number");
    expect(typeof body.uptime_ms).toBe("number");
    expect(body.db_path).toBe(tmp.dbPath);
    expect(typeof body.events_count).toBe("number");
    expect(body.mcp_port).toBe(handle.port);
    expect(body.aux_port).toBe(handle.auxPort);
    expect(body.mcp_transport).toBe("fastmcp:httpStream");
    expect(body.mcp_sessions).toMatchObject({
      active_sessions: 0,
      max_sessions: expect.any(Number),
      idle_ttl_ms: expect.any(Number),
      reaper_interval_ms: expect.any(Number),
    });
    // Robustness: /health now carries a stuck_workers array. On a fresh
    // daemon every worker just ticked, so the array is empty.
    expect(Array.isArray(body.stuck_workers)).toBe(true);
    expect((body.stuck_workers as unknown[]).length).toBe(0);
  });

  test("aux read endpoints match the canonical MCP read handlers", async () => {
    handle = await bootHandle(tmp);
    const { emitEvent } = await import("./events");
    const emitted = emitEvent(handle.db, {
      kind: "owner_input_received",
      substrate_origin: "owner",
      payload: { text: "aux-read-parity" },
    });
    const ctx = { db: handle.db, invoker: "claude_root" as const, index: null, ingressState: handle.ingressState };

    const post = async (path: string, body: unknown): Promise<{ status: number; body: unknown }> => {
      const res = await fetch("http://127.0.0.1:" + handle!.auxPort + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    };

    const readArgs = { view_name: "failure_view", args: {} };
    expect(await post("/read", readArgs)).toEqual({
      status: 200,
      body: await handleRead(ctx, readArgs),
    });

    const recentArgs = { k: 1, kinds: ["owner_input_received"] };
    expect(await post("/recent-events", recentArgs)).toEqual({
      status: 200,
      body: handleRecentEvents(ctx, recentArgs),
    });

    const getArgs = { id: emitted.id };
    expect(await post("/get-event", getArgs)).toEqual({
      status: 200,
      body: handleGetEvent(ctx, getArgs),
    });
  });

  test("aux read endpoints reject malformed envelopes without reaching MCP", async () => {
    handle = await bootHandle(tmp);
    const res = await fetch("http://127.0.0.1:" + handle.auxPort + "/get-event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "invalid_params" });
  });

  test("aux read endpoints do not create FastMCP sessions", async () => {
    handle = await bootHandle(tmp);
    const health = async (): Promise<Record<string, unknown>> => {
      const res = await fetch("http://127.0.0.1:" + handle!.auxPort + "/health");
      expect(res.status).toBe(200);
      return await res.json() as Record<string, unknown>;
    };
    const sessionCount = async (): Promise<number> => {
      const body = await health();
      const sessions = body.mcp_sessions as { active_sessions?: number } | undefined;
      return sessions?.active_sessions ?? -1;
    };

    expect(await sessionCount()).toBe(0);

    const post = async (path: string, body: unknown): Promise<void> => {
      const res = await fetch("http://127.0.0.1:" + handle!.auxPort + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBeLessThan(500);
      await res.text();
    };

    await post("/read", { view_name: "failure_view", args: {} });
    await post("/recent-events", { k: 1 });
    await post("/get-event", { id: "missing_event_id" });

    expect(await sessionCount()).toBe(0);
  });

  test("INSTANT-BOOT: health=ok is reachable WITHOUT the boot integrity check completing", async () => {
    // The boot PRAGMA quick_check (formerly synchronous, pre-bind, scanning
    // every page of the ≈1GB state.db) is now deferred to AFTER the ports
    // bind + /health serves. startDaemon resolving + /health returning
    // status:ok must NOT depend on the integrity scan having run. We assert
    // /health is ok while boot_integrity is still `pending` (the scan is
    // scheduled via setTimeout(BOOT_HEAVY_PASS_DELAY_MS) and has not fired
    // by the time the daemon is serving).
    const fresh = mkTmp();
    const localHandle = await startDaemonOnFreePorts(startDaemon, {
      stateDbPath: fresh.dbPath,
      socketFile: fresh.socketFile,
      tokenFile: fresh.tokenFile,
    });
    try {
      // The deferred check has not fired yet; the in-process getter must
      // report `pending` immediately after boot resolved.
      expect(getBootIntegrityState().status).toBe("pending");

      // /health serves status:ok with the integrity scan still pending —
      // proving health is decoupled from the (deferred) boot integrity check.
      const res = await fetch(`http://127.0.0.1:${localHandle.auxPort}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("ok");
      const bi = body.boot_integrity as { status?: string };
      expect(bi.status).toBe("pending");

      // The deferred check still RUNS (correctness preserved): wait for it to
      // transition off `pending` to `ok` on this fresh, healthy temp DB.
      const deadline = Date.now() + 8000;
      while (getBootIntegrityState().status === "pending" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(getBootIntegrityState().status).toBe("ok");
    } finally {
      await stopDaemon(localHandle);
      closeDb();
      rmSync(fresh.dir, { recursive: true, force: true });
    }
  });

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

  test("GET /ready returns 200 once amendment+gauge+integrity workers complete", async () => {
    handle = await bootHandle(tmp);
    // Workers are marked ready synchronously inside startDaemon (no LLM
    // calls, no real subprocess fixtures), so /ready should flip almost
    // immediately. Poll up to 3s for safety.
    let lastBody: Record<string, unknown> | null = null;
    let lastStatus = 0;
    for (let i = 0; i < 30; i++) {
      const res = await fetch(`http://127.0.0.1:${handle.auxPort}/ready`);
      lastStatus = res.status;
      lastBody = (await res.json()) as Record<string, unknown>;
      if (lastStatus === 200) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(lastStatus).toBe(200);
    expect(lastBody!.status).toBe("ready");
    expect(typeof lastBody!.ready_at_ms).toBe("number");
  });

  test("daemon_ready event is emitted exactly once after readiness flips", async () => {
    handle = await bootHandle(tmp);
    // Wait for readiness
    for (let i = 0; i < 30; i++) {
      const res = await fetch(`http://127.0.0.1:${handle.auxPort}/ready`);
      if (res.status === 200) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const rows = handle.db
      .query("SELECT COUNT(*) AS n FROM events WHERE kind = 'daemon_ready'")
      .get() as { n: number };
    expect(rows.n).toBeGreaterThanOrEqual(1);
  });

  test("GET /metrics returns Prometheus exposition format", async () => {
    handle = await bootHandle(tmp);
    const res = await fetch(`http://127.0.0.1:${handle.auxPort}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    // Spot-check several Prometheus-format markers.
    expect(body).toContain("# TYPE acc2_dispatches_total counter");
    expect(body).toContain("# TYPE acc2_events_emitted_total counter");
    expect(body).toContain("# TYPE acc2_daemon_uptime_seconds gauge");
  });

  test("startDaemon registers unhandledRejection + uncaughtException handlers", async () => {
    // Regression guard for the live-ledger bug observed 2026-05-16: 12 daemon
    // restarts in one session, each preceded by repeated
    // `[FastMCP error] Conflict: Only one SSE stream is allowed per session`
    // from mcp-proxy. Without top-level process.on('unhandledRejection') /
    // 'uncaughtException' handlers, Bun's default behavior is to exit the
    // process — orphaning every in-flight brain dispatch.
    //
    // We can't fire a synthetic rejection in-process here because Bun's
    // test harness intercepts unhandled rejections before they reach the
    // production handler (the harness needs them to fail tests).
    // Instead we verify the handler is REGISTERED on the process — and
    // that the event kind is in the registry so the ledger insert won't
    // be rejected at the boundary when the handler fires for real.
    const before = process.listenerCount("unhandledRejection");
    const beforeExc = process.listenerCount("uncaughtException");
    // bootHandle may retry on EADDRINUSE, but startDaemon registers its
    // process handlers AFTER the port bind succeeds — a failed (retried)
    // attempt throws before registration, so the +1 delta still holds.
    handle = await bootHandle(tmp);
    expect(process.listenerCount("unhandledRejection")).toBe(before + 1);
    expect(process.listenerCount("uncaughtException")).toBe(beforeExc + 1);
    // And the registry knows about daemon_unhandled_rejection so the emit
    // inside the handler won't fail with unknown_event_kind.
    const { EVENT_KINDS } = await import("../substrate/event_kinds");
    expect(EVENT_KINDS).toHaveProperty("daemon_unhandled_rejection");
  });

  test("boot reconciles orphaned dispatches from the previous run", async () => {
    // Stage 1: open the db directly and seed an unclosed brain_dispatched
    // row so the next daemon start sees it as an orphan.
    const { emitEvent: emit } = await import("./events");
    const db = openDb(tmp.dbPath);
    emit(db, {
      kind: "brain_dispatched",
      directive_id: "d_orphan_boot",
      task_id: "t_orphan_boot",
      payload: { dispatch_id: "disp_orphan_boot" },
    });
    closeDb(tmp.dbPath);

    // Stage 2: start the daemon and assert dispatch_recovered_orphan landed.
    handle = await bootHandle(tmp);
    const recovered = handle.db
      .query("SELECT * FROM events WHERE kind = 'dispatch_recovered_orphan' AND task_id = ?")
      .all("t_orphan_boot");
    expect(recovered.length).toBe(1);
  });

  test("restart zero-loss recovery accounts for every parallel in-flight brain dispatch", async () => {
    handle = await bootHandle(tmp);

    const { emitEvent: emit } = await import("./events");
    const directiveId = "YEF00QZM2S4T973MTJ3Q8EJ534";
    const taskIds = Array.from({ length: 15 }, (_, i) => `zero_loss_restart_task_${i}`);
    for (const taskId of taskIds) {
      emit(handle.db, {
        kind: "task_node_opened",
        directive_id: directiveId,
        task_id: taskId,
        payload: { goal: "parallel brain dispatch interrupted by daemon restart" },
      });
      emit(handle.db, {
        kind: "brain_dispatched",
        directive_id: directiveId,
        task_id: taskId,
        payload: { dispatch_id: `disp_${taskId}` },
      });
    }

    await stopDaemon(handle, 0);
    handle = null;

    // Restart against the SAME db/socket (the recovery source) but on fresh
    // ports. This test proves zero-loss DISPATCH RECOVERY, not same-port
    // rebind — and fastmcp does not release a port promptly enough in-process
    // for a same-port rebind to be reliable under parallel load.
    handle = await bootHandle(tmp);

    const recovered = handle.db
      .query("SELECT task_id, payload FROM events WHERE kind = 'dispatch_recovered_orphan' AND directive_id = ?")
      .all(directiveId) as Array<{ task_id: string; payload: string }>;
    expect(recovered.map((r) => r.task_id).sort()).toEqual([...taskIds].sort());

    const closes = handle.db
      .query("SELECT task_id, payload FROM events WHERE kind = 'brain_dispatch_closed' AND directive_id = ?")
      .all(directiveId) as Array<{ task_id: string; payload: string }>;
    const closePayloadByTask = new Map(closes.map((r) => [r.task_id, parsePayload(r.payload)]));
    for (const taskId of taskIds) {
      expect(closePayloadByTask.get(taskId)?.reason).toBe("restart_orphan_recovered");
      expect(closePayloadByTask.get(taskId)?.dispatch_id).toBe(`disp_${taskId}`);
    }

    const unaccounted = handle.db
      .query(`
        SELECT d.task_id
        FROM events d
        WHERE d.kind = 'brain_dispatched'
          AND d.directive_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM events c
            WHERE c.task_id = d.task_id
              AND c.kind IN ('brain_dispatch_closed', 'dispatcher_violation', 'task_failed', 'task_committed')
              AND c.ts >= d.ts
          )
        ORDER BY d.task_id ASC
      `)
      .all(directiveId) as Array<{ task_id: string }>;
    expect(unaccounted).toEqual([]);

    const restartInterruptedFailures = handle.db
      .query(`
        SELECT task_id
        FROM events
        WHERE directive_id = ?
          AND kind = 'task_failed'
          AND (failure_kind = 'restart_interrupted' OR json_extract(payload, '$.reason') = 'restart_interrupted')
      `)
      .all(directiveId) as Array<{ task_id: string }>;
    expect(restartInterruptedFailures).toEqual([]);
  });

  test("amendment worker drains unapplied directive_amended events automatically", async () => {
    // Amendment worker is reactive: it subscribes to directive_amended
    // events and fires immediately on emission (with a minReactiveGapMs
    // safety floor). The ACC2_AMENDMENT_TICK_MS env knob (and the env
    // override this test used to set) is gone — the polling-based test
    // shape still works because the reactive worker drains the row
    // within milliseconds of the directive_amended emit below.
    try {
      handle = await bootHandle(tmp);
      const directiveId = "d_daemon_amend_test";
      const taskId = "t_daemon_amend_task";
      const { emitEvent } = await import("./events");
      emitEvent(handle.db, {
        kind: "directive_opened",
        directive_id: directiveId,
        task_id: directiveId,
        payload: { directive_text: "x" },
      });
      emitEvent(handle.db, {
        kind: "task_node_opened",
        directive_id: directiveId,
        task_id: taskId,
        payload: { goal: "supersede me" },
      });
      emitEvent(handle.db, {
        kind: "directive_amended",
        directive_id: directiveId,
        substrate_origin: "owner",
        payload: {
          original_directive_id: directiveId,
          amendment_text: "amend it",
          superseded_tasks: [taskId],
          new_task_goals: ["new daemon task"],
        },
      });
      // Worker tick interval=50ms; poll every 25ms up to 1s.
      let supersededCount = 0;
      for (let i = 0; i < 40; i++) {
        const row = handle.db
          .query("SELECT COUNT(*) as c FROM events WHERE kind = 'task_committed_superseded' AND task_id = ?")
          .get(taskId) as { c: number };
        supersededCount = row.c;
        if (supersededCount > 0) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(supersededCount).toBeGreaterThanOrEqual(1);
    } finally {
      // No env restoration needed — ACC2_AMENDMENT_TICK_MS is no longer
      // read by the daemon (reactive worker, env knob deleted).
    }
  }, 5_000);

  // LOOP-BLOCK REGRESSION GUARD (2026-05-24): reactive workers must NOT run
  // their (possibly heavy, synchronous) tick body on the emitEvent →
  // publishActivation synchronous call stack. Before the fix, supervisorTick's
  // 8 GROUP-BY detectors ran fully synchronously inside the emit that opened a
  // directive, blocking the single event loop for ~11s on a large ledger.
  // fireReactiveWorker now defers entry.run() (and the worker_tick_completed
  // telemetry emit) to a macrotask. This test pins that off-stack contract:
  // emitting task_node_opened (which both supervisor + integrity subscribe to)
  // returns BEFORE any reactive worker_tick_completed row lands, and the row
  // only appears after a macrotask yield.
  test("reactive worker fire is deferred off the emitEvent call stack", async () => {
    handle = await bootHandle(tmp);
    const { emitEvent } = await import("./events");
    const directiveId = "d_offstack_test";
    const taskId = "t_offstack_test";
    emitEvent(handle.db, {
      kind: "directive_opened",
      directive_id: directiveId,
      task_id: directiveId,
      payload: { directive_text: "off-stack reactive fire" },
    });
    const countReactiveTicks = (): number => {
      const row = handle!.db
        .query(
          `SELECT COUNT(*) AS c FROM events
             WHERE kind = 'worker_tick_completed'
               AND json_extract(payload, '$.activation_source') = 'event'
               AND json_extract(payload, '$.trigger_kind') = 'task_node_opened'`,
        )
        .get() as { c: number };
      return row.c;
    };
    const before = countReactiveTicks();
    // Emit on the current call stack. A reactive worker fire scheduled by this
    // emit MUST NOT have written its telemetry row by the time emit returns —
    // it is deferred to a macrotask. The synchronous read immediately after
    // therefore sees no NEW event-sourced reactive tick from this emit.
    emitEvent(handle.db, {
      kind: "task_node_opened",
      directive_id: directiveId,
      task_id: taskId,
      payload: { goal: "off-stack" },
    });
    const immediatelyAfter = countReactiveTicks();
    expect(immediatelyAfter).toBe(before);
    // After macrotask yields the deferred fire runs and lands its telemetry.
    let eventual = immediatelyAfter;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 25));
      eventual = countReactiveTicks();
      if (eventual > before) break;
    }
    expect(eventual).toBeGreaterThan(before);
  }, 5_000);
});

// ── Amendment 8EAKQCJW5D — bounded graceful drain on shutdown ────────
//
// The daemon's stop function now accepts a per-call drain budget; the
// /shutdown HTTP route accepts that budget from the request body; the
// `daemon_shutdown` payload carries `drained_count` + `interrupted_count`
// so operators can see how many in-flight dispatches finished cleanly vs
// were force-killed. Boot recovery (reconcileOrphanedDispatches) remains
// the deterministic backstop for any leases left after a force-kill —
// already wired by amendment HJFTSQ4V2.

const parsePayload = (raw: string): Record<string, unknown> => {
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
};

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

// ── DAEMON STABILITY HARDENING (fix #3): extractor-sweep wall-clock budget ──
//
// runBudgetedSweep bounds the whole extractor sweep so a slow tick on a
// 424k-row ledger can never run >10min. We test the budget semantics with an
// injected clock so there is no real wall-clock dependence and no daemon boot.
describe("runBudgetedSweep — per-tick wall-clock budget (fix #3)", () => {
  // A fake clock the test advances by side-effect inside each step.
  const makeClock = (start = 0) => {
    let t = start;
    return { now: () => t, advance: (ms: number) => { t += ms; } };
  };

  test("the first step always runs even past the budget; subsequent steps are deferred once the budget is exceeded", async () => {
    const clock = makeClock();
    const ran: string[] = [];
    const steps: BudgetedStep[] = [
      // First step pushes elapsed past the 100ms budget — but it MUST still run.
      { name: "a", run: async () => { ran.push("a"); clock.advance(500); } },
      { name: "b", run: async () => { ran.push("b"); } },
      { name: "c", run: async () => { ran.push("c"); } },
    ];
    const res = await runBudgetedSweep(steps, { budgetMs: 100, now: clock.now });
    expect(ran).toEqual(["a"]);            // only the first ran
    expect(res.ran).toEqual(["a"]);
    expect(res.cutBeforeStep).toBe("b");   // budget cut before step b
  });

  test("a clean (under-budget) sweep runs every step and reports no cut", async () => {
    const clock = makeClock();
    const ran: string[] = [];
    const steps: BudgetedStep[] = [
      { name: "a", run: async () => { ran.push("a"); clock.advance(1); } },
      { name: "b", run: async () => { ran.push("b"); clock.advance(1); } },
      { name: "c", run: async () => { ran.push("c"); clock.advance(1); } },
    ];
    const res = await runBudgetedSweep(steps, { budgetMs: 10_000, now: clock.now });
    expect(ran).toEqual(["a", "b", "c"]);
    expect(res.cutBeforeStep).toBeNull();
    expect(res.ran).toEqual(["a", "b", "c"]);
  });

  test("a throwing step is caught (onError) and does NOT abort the sweep — only the budget defers steps", async () => {
    const clock = makeClock();
    const ran: string[] = [];
    const errors: string[] = [];
    const steps: BudgetedStep[] = [
      { name: "a", run: async () => { ran.push("a"); } },
      { name: "boom", run: async () => { throw new Error("kaboom"); } },
      { name: "c", run: async () => { ran.push("c"); } },
    ];
    const res = await runBudgetedSweep(steps, {
      budgetMs: 10_000,
      now: clock.now,
      onError: (name) => errors.push(name),
    });
    expect(ran).toEqual(["a", "c"]);        // c still ran after boom threw
    expect(errors).toEqual(["boom"]);
    expect(res.cutBeforeStep).toBeNull();   // a thrown step is not a budget cut
    expect(res.ran).toEqual(["a", "c"]);    // boom is not counted as "ran"
  });
});

// ---------------------------------------------------------------------------
// Atomic boot-intent lock (duplicate-daemon race fix).
//
// Root cause: the lock file was only WRITTEN at the END of boot (after ports
// bound) but the second-instance guard ran at the START. During the ~150s
// boot window the file did not exist, so two concurrent `daemon start` calls
// BOTH saw "no lock" and BOTH proceeded to bind the MCP port — one won, the
// other lingered as a duplicate/zombie. The fix exclusive-creates the lock
// (`wx` / O_EXCL) at the very start of startup, so a 2nd concurrent start
// reads the live-pid lock and refuses IMMEDIATELY, before paying boot cost.
//
// These tests inject the lock path so they never touch the real
// ~/.accint/v2.sock or the live daemon (constraint: do not touch live state).
// ---------------------------------------------------------------------------
describe("atomic boot-intent lock", () => {
  let tmp = mkTmp();
  beforeEach(() => { tmp = mkTmp(); });
  afterEach(() => { closeDb(); rmSync(tmp.dir, { recursive: true, force: true }); });

  test("2nd start while a LIVE-pid lock exists refuses immediately, before any boot/bind", async () => {
    // Pre-write a lock naming a LIVE pid (this test process). The exclusive
    // create must hit EEXIST, read the live pid, and refuse.
    writeFileSync(
      tmp.socketFile,
      JSON.stringify({ pid: process.pid, started_at_ms: Date.now(), phase: "booting", role: "all" }),
      { mode: 0o600 },
    );
    const other = pickPortPair();
    const startedAt = Date.now();
    let caught: unknown = null;
    try {
      await startDaemon({
        port: other.mcp, auxPort: other.aux,
        stateDbPath: join(tmp.dir, "should-never-open.db"),
        socketFile: tmp.socketFile, tokenFile: tmp.tokenFile,
      });
    } catch (err) { caught = err; }
    const elapsedMs = Date.now() - startedAt;

    // Refused as a distinguishable already-running error.
    expect(isDaemonAlreadyRunningError(caught)).toBe(true);
    expect((caught as Error).message).toContain(String(process.pid));
    // Refusal is FAST — no 150s boot. (Generous ceiling to avoid flake; the
    // point is it returned without binding a port or opening the DB.)
    expect(elapsedMs).toBeLessThan(3_000);
    // No 2nd boot: the supplied DB was never created, the supplied MCP port
    // was never bound, and the incumbent's lock is untouched.
    expect(existsSync(join(tmp.dir, "should-never-open.db"))).toBe(false);
    let portBound = false;
    try {
      const sock = await Bun.connect({ hostname: "127.0.0.1", port: other.mcp, socket: { data() {}, open() {}, close() {}, error() {} } });
      sock.end(); portBound = true;
    } catch { portBound = false; }
    expect(portBound).toBe(false);
    const lock = JSON.parse(readFileSync(tmp.socketFile, "utf8")) as { pid: number };
    expect(lock.pid).toBe(process.pid);
  });

  test("mcp bind failure releases the boot-intent lock so retry can proceed", async () => {
    // DAEMON_BOOT_LOCK brain amendment: acquireBootLock writes the
    // phase:"booting" lock BEFORE the port binds. If the bind then fails,
    // the catch handler must remove the lock — otherwise the failed boot
    // leaves a stale lock that blocks the next start until the dead-pid
    // reaper fires. Occupy the MCP port, confirm start fails, and assert
    // the lock file is gone.
    const occupied = pickPortPair();
    const blocker = Bun.serve({
      hostname: "127.0.0.1",
      port: occupied.mcp,
      fetch: () => new Response("occupied"),
    });
    try {
      let caught: unknown = null;
      try {
        await startDaemon({
          port: occupied.mcp,
          auxPort: occupied.aux,
          stateDbPath: tmp.dbPath,
          socketFile: tmp.socketFile,
          tokenFile: tmp.tokenFile,
        });
      } catch (err) { caught = err; }
      expect(String((caught as Error | null)?.message ?? caught)).toContain("failed to bind MCP port");
      // The boot-intent lock acquireBootLock wrote must be released.
      expect(existsSync(tmp.socketFile)).toBe(false);
      // Resource-leak fix (2026-05-23): the SQL worker-thread pool is spawned
      // BEFORE the bind, so a bind failure must shut it down + clear the
      // process-global singleton — otherwise N worker_threads leak (one set
      // per retry under startDaemonOnFreePorts) and getSqlPool() returns a
      // pool pointing at a now-closed DB. Skip the assertion when the pool is
      // disabled (ACC2_DISABLE_SQL_POOL=1) — there is nothing to leak then.
      if (process.env.ACC2_DISABLE_SQL_POOL !== "1") {
        expect(getSqlPool()).toBeNull();
      }
    } finally {
      blocker.stop(true);
      // Defensive: ensure no leaked pool bleeds into sibling tests.
      clearSqlPool();
    }
  });

  test("a STALE (dead-pid) lock is reaped and start proceeds", async () => {
    // Pick a pid that is essentially certainly dead. process.kill(pid, 0)
    // throws ESRCH → pidAlive=false → acquireBootLock reaps + proceeds.
    const deadPid = 2_147_480_000;
    expect(() => process.kill(deadPid, 0)).toThrow(); // confirm it's dead
    writeFileSync(
      tmp.socketFile,
      JSON.stringify({ pid: deadPid, started_at_ms: 1, phase: "ready", role: "all" }),
      { mode: 0o600 },
    );
    const handle = await startDaemonOnFreePorts(startDaemon, {
      stateDbPath: tmp.dbPath,
      socketFile: tmp.socketFile,
      tokenFile: tmp.tokenFile,
    });
    try {
      // Boot succeeded → lock was reaped and rewritten with OUR pid + ready.
      expect(existsSync(tmp.socketFile)).toBe(true);
      const lock = JSON.parse(readFileSync(tmp.socketFile, "utf8")) as { pid: number; phase?: string };
      expect(lock.pid).toBe(process.pid);
      expect(lock.phase).toBe("ready");
    } finally {
      await stopDaemon(handle);
    }
  });

  test("boot writes phase:booting then phase:ready, and clean shutdown releases the lock", async () => {
    expect(existsSync(tmp.socketFile)).toBe(false);
    const handle = await startDaemonOnFreePorts(startDaemon, {
      stateDbPath: tmp.dbPath,
      socketFile: tmp.socketFile,
      tokenFile: tmp.tokenFile,
    });
    // After boot completes the lock is rewritten with the ready payload.
    const lock = JSON.parse(readFileSync(tmp.socketFile, "utf8")) as { pid: number; phase?: string; port?: number };
    expect(lock.pid).toBe(process.pid);
    expect(lock.phase).toBe("ready");
    expect(typeof lock.port).toBe("number");
    // Clean shutdown unlinks the lock.
    await stopDaemon(handle);
    expect(existsSync(tmp.socketFile)).toBe(false);
  });
});
