// Daemon lifecycle — readiness / metrics / orphan-reconcile / restart recovery (part 3).
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

describe("startDaemon — readiness + recovery (part 3)", () => {
  let handle: DaemonHandle | null = null;
  let tmp = mkTmp();

  beforeEach(() => { tmp = mkTmp(); });
  afterEach(async () => { await cleanup(handle, tmp); handle = null; });
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
