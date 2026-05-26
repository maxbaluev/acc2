import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import { newId } from "./ids";
import {
  detectRedispatchStorm,
  detectDagExplosion,
  detectRepeatingAction,
  detectNoClosureProgressLoop,
  detectDispatchBudgetExceeded,
  supervisorTick,
  SUPERVISOR_MAX_REDISPATCHES_PER_TASK,
  SUPERVISOR_MAX_READY_TASKS_PER_DIRECTIVE,
  SUPERVISOR_MAX_DIRECTIVE_AGE_HOURS,
  SUPERVISOR_MAX_REPEATING_ACTIONS,
  SUPERVISOR_MAX_DISPATCHES_PER_DIRECTIVE,
  SUPERVISOR_MIN_GAP_MS,
  __resetSupervisorThrottle,
} from "./supervisor";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const insertDispatch = (db: ReturnType<typeof openDb>, ts: string, taskId: string, directiveId: string) => {
  db.query(
    `INSERT INTO events (id, ts, kind, substrate_origin, directive_id, task_id, loop_id, payload)
     VALUES (?, ?, 'brain_dispatched', 'substrate_auto', ?, ?, '', ?)`,
  ).run(newId(), ts, directiveId, taskId, JSON.stringify({ dispatch_id: newId() }));
};

describe("supervisor — detectRedispatchStorm", () => {
  test("does NOT quarantine a task with dispatches below the threshold", async () => {
    const db = openDb(":memory:");
    const now = Date.now();
    const directiveId = newId();
    const taskId = newId();
    for (let i = 0; i < SUPERVISOR_MAX_REDISPATCHES_PER_TASK; i++) {
      insertDispatch(db, new Date(now - 1000 * i).toISOString(), taskId, directiveId);
    }
    const quarantined = detectRedispatchStorm(db, { nowMs: now });
    expect(quarantined.length).toBe(0);
  });

  test("quarantines a task with > SUPERVISOR_MAX_REDISPATCHES_PER_TASK dispatches", async () => {
    const db = openDb(":memory:");
    const now = Date.now();
    const directiveId = newId();
    const taskId = newId();
    for (let i = 0; i <= SUPERVISOR_MAX_REDISPATCHES_PER_TASK; i++) {
      insertDispatch(db, new Date(now - 1000 * i).toISOString(), taskId, directiveId);
    }
    const quarantined = detectRedispatchStorm(db, { nowMs: now });
    expect(quarantined.length).toBe(1);
    expect(quarantined[0].task_id).toBe(taskId);

    const failed = db
      .query("SELECT failure_kind FROM events WHERE kind = 'task_failed' AND task_id = ?")
      .get(taskId) as { failure_kind: string } | null;
    expect(failed?.failure_kind).toBe("redispatch_storm");

    const intervention = db
      .query("SELECT payload FROM events WHERE kind = 'supervisor_intervention_recorded' AND task_id = ?")
      .get(taskId) as { payload: string } | null;
    expect(intervention).not.toBeNull();
    const ip = JSON.parse(intervention!.payload);
    expect(ip.pathology).toBe("redispatch_storm");
  });

  test("does NOT re-fail an already-terminal task (idempotent)", async () => {
    const db = openDb(":memory:");
    const now = Date.now();
    const directiveId = newId();
    const taskId = newId();
    for (let i = 0; i <= SUPERVISOR_MAX_REDISPATCHES_PER_TASK; i++) {
      insertDispatch(db, new Date(now - 1000 * i).toISOString(), taskId, directiveId);
    }
    // First call: fails the task.
    expect((detectRedispatchStorm(db, { nowMs: now })).length).toBe(1);
    // Second call: task is now terminal; supervisor skips it.
    expect((detectRedispatchStorm(db, { nowMs: now })).length).toBe(0);
    const failedCount = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'task_failed' AND task_id = ?")
      .get(taskId) as { c: number };
    expect(failedCount.c).toBe(1);
  });
});

describe("supervisor — detectDagExplosion", () => {
  test("does NOT archive a young directive even with many ready tasks", async () => {
    const db = openDb(":memory:");
    const now = Date.now();
    const directiveId = newId();
    // Insert directive_opened + N task_node_opened just a few minutes ago.
    const recentTs = new Date(now - 60_000).toISOString();
    db.query(
      `INSERT INTO events (id, ts, kind, substrate_origin, directive_id, task_id, loop_id, payload)
       VALUES (?, ?, 'directive_opened', 'owner', ?, ?, '', ?)`,
    ).run(newId(), recentTs, directiveId, directiveId, JSON.stringify({ directive_text: "x" }));
    for (let i = 0; i < SUPERVISOR_MAX_READY_TASKS_PER_DIRECTIVE + 5; i++) {
      db.query(
        `INSERT INTO events (id, ts, kind, substrate_origin, directive_id, task_id, loop_id, payload)
         VALUES (?, ?, 'task_node_opened', 'owner', ?, ?, '', ?)`,
      ).run(newId(), recentTs, directiveId, newId(), JSON.stringify({ goal: `task_${i}` }));
    }
    const archived = detectDagExplosion(db, { nowMs: now });
    expect(archived.length).toBe(0);
  });

  test("archives a directive with ready_count > threshold AND age > threshold", async () => {
    const db = openDb(":memory:");
    const now = Date.now();
    const directiveId = newId();
    const oldTs = new Date(now - (SUPERVISOR_MAX_DIRECTIVE_AGE_HOURS + 1) * 60 * 60 * 1000).toISOString();
    db.query(
      `INSERT INTO events (id, ts, kind, substrate_origin, directive_id, task_id, loop_id, payload)
       VALUES (?, ?, 'directive_opened', 'owner', ?, ?, '', ?)`,
    ).run(newId(), oldTs, directiveId, directiveId, JSON.stringify({ directive_text: "old runaway" }));
    for (let i = 0; i < SUPERVISOR_MAX_READY_TASKS_PER_DIRECTIVE + 5; i++) {
      db.query(
        `INSERT INTO events (id, ts, kind, substrate_origin, directive_id, task_id, loop_id, payload)
         VALUES (?, ?, 'task_node_opened', 'owner', ?, ?, '', ?)`,
      ).run(newId(), oldTs, directiveId, newId(), JSON.stringify({ goal: `task_${i}` }));
    }
    const archived = detectDagExplosion(db, { nowMs: now });
    expect(archived.length).toBe(1);
    expect(archived[0].directive_id).toBe(directiveId);
    expect(archived[0].ready_count).toBeGreaterThan(SUPERVISOR_MAX_READY_TASKS_PER_DIRECTIVE);

    const archiveEvent = db
      .query("SELECT payload FROM events WHERE kind = 'directive_archived_by_operator' AND directive_id = ?")
      .get(directiveId) as { payload: string } | null;
    expect(archiveEvent).not.toBeNull();
    expect(JSON.parse(archiveEvent!.payload).reason).toBe("supervisor_dag_explosion");
  });

  test("does NOT re-archive an already-closed directive (idempotent)", async () => {
    const db = openDb(":memory:");
    const now = Date.now();
    const directiveId = newId();
    const oldTs = new Date(now - (SUPERVISOR_MAX_DIRECTIVE_AGE_HOURS + 1) * 60 * 60 * 1000).toISOString();
    db.query(
      `INSERT INTO events (id, ts, kind, substrate_origin, directive_id, task_id, loop_id, payload)
       VALUES (?, ?, 'directive_opened', 'owner', ?, ?, '', ?)`,
    ).run(newId(), oldTs, directiveId, directiveId, JSON.stringify({ directive_text: "x" }));
    for (let i = 0; i < SUPERVISOR_MAX_READY_TASKS_PER_DIRECTIVE + 5; i++) {
      db.query(
        `INSERT INTO events (id, ts, kind, substrate_origin, directive_id, task_id, loop_id, payload)
         VALUES (?, ?, 'task_node_opened', 'owner', ?, ?, '', ?)`,
      ).run(newId(), oldTs, directiveId, newId(), JSON.stringify({ goal: `task_${i}` }));
    }
    expect((detectDagExplosion(db, { nowMs: now })).length).toBe(1);
    expect((detectDagExplosion(db, { nowMs: now })).length).toBe(0);
  });
});

describe("supervisor — detectRepeatingAction (2026-05-17 brain-stuck-loop detector)", () => {
  const insertActionPredicted = (
    db: ReturnType<typeof openDb>,
    ts: string,
    taskId: string,
    directiveId: string,
    actionArtifactId: string,
    substrateOrigin: string = "opencode",
  ): void => {
    db.query(
      `INSERT INTO events (id, ts, kind, substrate_origin, directive_id, task_id, loop_id, action_artifact_id, verifier_artifact_id, predicted_residual, payload)
       VALUES (?, ?, 'action_predicted', ?, ?, ?, '', ?, ?, ?, ?)`,
    ).run(newId(), ts, substrateOrigin, directiveId, taskId, actionArtifactId, "verifier", 0.2, JSON.stringify({ intent: "Record one coherent opencode brain dispatch exit boundary." }));
  };

  test("does NOT quarantine when repeats are below threshold", async () => {
    const db = openDb(":memory:");
    const now = Date.now();
    const directiveId = newId();
    const taskId = newId();
    for (let i = 0; i < SUPERVISOR_MAX_REPEATING_ACTIONS - 1; i++) {
      insertActionPredicted(db, new Date(now - 1000 * i).toISOString(), taskId, directiveId, "opencode_brain_exit_action");
    }
    const quarantined = detectRepeatingAction(db, { nowMs: now });
    expect(quarantined.length).toBe(0);
  });

  test("quarantines a task with ≥ SUPERVISOR_MAX_REPEATING_ACTIONS same-artifact action_predicted (the live ACTTUPLE03C_CREDIT loop shape)", async () => {
    const db = openDb(":memory:");
    const now = Date.now();
    const directiveId = newId();
    const taskId = newId();
    for (let i = 0; i < SUPERVISOR_MAX_REPEATING_ACTIONS; i++) {
      insertActionPredicted(db, new Date(now - 60_000 * i).toISOString(), taskId, directiveId, "opencode_brain_exit_action");
    }
    const quarantined = detectRepeatingAction(db, { nowMs: now });
    expect(quarantined.length).toBe(1);
    expect(quarantined[0]!.task_id).toBe(taskId);
    expect(quarantined[0]!.action_artifact_id).toBe("opencode_brain_exit_action");

    const failed = db
      .query("SELECT failure_kind, payload FROM events WHERE kind = 'task_failed' AND task_id = ?")
      .get(taskId) as { failure_kind: string; payload: string } | null;
    expect(failed?.failure_kind).toBe("brain_stuck_repeating_action");
    const fp = JSON.parse(failed!.payload);
    expect(fp.action_artifact_id).toBe("opencode_brain_exit_action");
    expect(fp.repeat_count).toBeGreaterThanOrEqual(SUPERVISOR_MAX_REPEATING_ACTIONS);

    const intervention = db
      .query("SELECT payload FROM events WHERE kind = 'supervisor_intervention_recorded' AND task_id = ?")
      .get(taskId) as { payload: string } | null;
    expect(intervention).not.toBeNull();
    const ip = JSON.parse(intervention!.payload);
    expect(ip.pathology).toBe("brain_stuck_repeating_action");
  });

  test("does NOT cross-link tasks: only same (task_id, action_artifact_id) tuples count", async () => {
    const db = openDb(":memory:");
    const now = Date.now();
    const directiveId = newId();
    // Two distinct tasks each emit N/2 of the same artifact. Neither should fire alone.
    const t1 = newId();
    const t2 = newId();
    const half = Math.floor(SUPERVISOR_MAX_REPEATING_ACTIONS / 2) + 1;
    for (let i = 0; i < half; i++) {
      insertActionPredicted(db, new Date(now - 1000 * i).toISOString(), t1, directiveId, "shared_artifact");
      insertActionPredicted(db, new Date(now - 1000 * (i + 100)).toISOString(), t2, directiveId, "shared_artifact");
    }
    const quarantined = detectRepeatingAction(db, { nowMs: now });
    expect(quarantined.length).toBe(0);
  });

  test("ignores non-brain action_predicted (substrate_origin filter)", async () => {
    const db = openDb(":memory:");
    const now = Date.now();
    const directiveId = newId();
    const taskId = newId();
    for (let i = 0; i < SUPERVISOR_MAX_REPEATING_ACTIONS + 2; i++) {
      insertActionPredicted(db, new Date(now - 1000 * i).toISOString(), taskId, directiveId, "claude_inline_action", "claude_root");
    }
    const quarantined = detectRepeatingAction(db, { nowMs: now });
    expect(quarantined.length).toBe(0);
  });

  test("is idempotent — second call does NOT re-fail an already-failed task", async () => {
    const db = openDb(":memory:");
    const now = Date.now();
    const directiveId = newId();
    const taskId = newId();
    for (let i = 0; i < SUPERVISOR_MAX_REPEATING_ACTIONS; i++) {
      insertActionPredicted(db, new Date(now - 60_000 * i).toISOString(), taskId, directiveId, "opencode_brain_exit_action");
    }
    expect((detectRepeatingAction(db, { nowMs: now })).length).toBe(1);
    expect((detectRepeatingAction(db, { nowMs: now })).length).toBe(0);
    const failedCount = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'task_failed' AND task_id = ?")
      .get(taskId) as { c: number };
    expect(failedCount.c).toBe(1);
  });
});

describe("supervisor — no-closure-progress loop detector", () => {
  const insertClosedDispatch = (
    db: ReturnType<typeof openDb>,
    directiveId: string,
    taskId: string,
    ts: string,
    dispatchId: string,
  ) => {
    db.query(
      `INSERT INTO events (id, ts, kind, substrate_origin, directive_id, task_id, loop_id, payload)
       VALUES (?, ?, 'brain_dispatched', 'substrate_auto', ?, ?, '', ?)`,
    ).run(newId(), ts, directiveId, taskId, JSON.stringify({ dispatch_id: dispatchId }));
    db.query(
      `INSERT INTO events (id, ts, kind, substrate_origin, directive_id, task_id, loop_id, payload)
       VALUES (?, ?, 'brain_dispatch_closed', 'substrate_auto', ?, ?, '', ?)`,
    ).run(newId(), new Date(Date.parse(ts) + 1000).toISOString(), directiveId, taskId, JSON.stringify({ dispatch_id: dispatchId }));
  };

  test("archives a completed re-dispatch with zero structural events since the last dispatch", async () => {
    const db = openDb(":memory:");
    const dir = "DIRSTUCK0000000000000000000";
    // Cap is 4 (bridge-failure-resilient): a genuinely stuck directive is
    // only reaped after >4 productive dispatches with zero structural progress.
    insertClosedDispatch(db, dir, "TSTUCK", "2026-05-22T00:00:00.000Z", "stuck-dispatch-1");
    insertClosedDispatch(db, dir, "TSTUCK", "2026-05-22T00:01:00.000Z", "stuck-dispatch-2");
    insertClosedDispatch(db, dir, "TSTUCK", "2026-05-22T00:02:00.000Z", "stuck-dispatch-3");
    insertClosedDispatch(db, dir, "TSTUCK", "2026-05-22T00:03:00.000Z", "stuck-dispatch-4");
    insertClosedDispatch(db, dir, "TSTUCK", "2026-05-22T00:04:00.000Z", "stuck-dispatch-5");

    // Anchor nowMs just after the seeded dispatches so they fall inside the
    // detector's recent-ts count window (SUPERVISOR_DISPATCH_COUNT_WINDOW_MS).
    const nowMs = Date.parse("2026-05-22T00:05:00.000Z");
    const flagged = detectNoClosureProgressLoop(db, { nowMs });
    expect(flagged.map((f) => f.directive_id)).toContain(dir);
    const archived = db.query("SELECT payload FROM events WHERE kind='directive_archived_by_operator' AND directive_id=? AND json_extract(payload,'$.reason')='supervisor_no_closure_progress_loop' LIMIT 1").get(dir) as { payload: string } | null;
    expect(archived).not.toBeNull();
    expect(typeof JSON.parse(archived!.payload).last_dispatch_event_id).toBe("string");
  });

  test("does NOT archive a completed re-dispatch that made structural progress since the last dispatch", async () => {
    const db = openDb(":memory:");
    const dir = "DIRLEGIT0000000000000000000";
    insertClosedDispatch(db, dir, "TLEGIT", "2026-05-22T00:00:00.000Z", "legit-dispatch-1");
    insertClosedDispatch(db, dir, "TLEGIT", "2026-05-22T00:01:00.000Z", "legit-dispatch-2");
    db.query(
      `INSERT INTO events (id, ts, kind, substrate_origin, directive_id, task_id, loop_id, payload)
       VALUES (?, ?, 'task_edge_recorded', 'substrate_auto', ?, ?, '', ?)`,
    ).run(newId(), "2026-05-22T00:01:02.000Z", dir, "TLEGIT", JSON.stringify({ edge_kind: "refines" }));

    const nowMs = Date.parse("2026-05-22T00:05:00.000Z");
    const flagged = detectNoClosureProgressLoop(db, { nowMs });
    expect(flagged.map((f) => f.directive_id)).not.toContain(dir);
    const archived = db.query("SELECT 1 FROM events WHERE kind='directive_archived_by_operator' AND directive_id=? LIMIT 1").get(dir);
    expect(archived).toBeNull();
  });

  test("does NOT force-fail a task whose most-recent ledger row is owner_input_required (owner-blocked is progress, not a storm)", async () => {
    const db = openDb(":memory:");
    const dir = "DIRWAITOWNER000000000000000";
    // >4 productive dispatches with no structural-commit progress would
    // normally trip the no-closure-progress fallback. But the most-recent
    // ledger row is owner_input_required — the task is legitimately BLOCKED
    // on owner input, which now counts as progress and must NOT be force-failed.
    insertClosedDispatch(db, dir, "TWAIT", "2026-05-22T00:00:00.000Z", "wait-dispatch-1");
    insertClosedDispatch(db, dir, "TWAIT", "2026-05-22T00:01:00.000Z", "wait-dispatch-2");
    insertClosedDispatch(db, dir, "TWAIT", "2026-05-22T00:02:00.000Z", "wait-dispatch-3");
    insertClosedDispatch(db, dir, "TWAIT", "2026-05-22T00:03:00.000Z", "wait-dispatch-4");
    insertClosedDispatch(db, dir, "TWAIT", "2026-05-22T00:04:00.000Z", "wait-dispatch-5");
    db.query(
      `INSERT INTO events (id, ts, kind, substrate_origin, directive_id, task_id, loop_id, payload)
       VALUES (?, ?, 'owner_input_required', 'substrate_auto', ?, ?, '', ?)`,
    ).run(newId(), "2026-05-22T00:04:30.000Z", dir, "TWAIT", JSON.stringify({ reason: "awaiting_owner_decision" }));

    const nowMs = Date.parse("2026-05-22T00:05:00.000Z");
    const flagged = detectNoClosureProgressLoop(db, { nowMs });
    expect(flagged.map((f) => f.directive_id)).not.toContain(dir);
    const archived = db.query("SELECT 1 FROM events WHERE kind='directive_archived_by_operator' AND directive_id=? LIMIT 1").get(dir);
    expect(archived).toBeNull();
  });
});

describe("supervisor — supervisorTick composition", () => {
  test("supervisorTick runs every detector and returns a summary", async () => {
    __resetSupervisorThrottle();
    const db = openDb(":memory:");
    const result = supervisorTick(db);
    expect(result).toEqual({
      redispatch_storm_count: 0,
      dag_explosion_count: 0,
      dispatch_budget_exceeded_count: 0,
      no_closure_progress_loop_count: 0,
      ready_starvation_count: 0,
      pathology_budget_exhausted_count: 0,
      brain_stuck_repeating_action_count: 0,
      bridge_health_degraded: false,
      bridge_health_recovered: false,
      throttled: false,
    });
  });
});

describe("supervisor — cadence throttle (2026-05-24 loop-block fix)", () => {
  test("a second call within SUPERVISOR_MIN_GAP_MS returns a throttled no-op without scanning or emitting", async () => {
    __resetSupervisorThrottle();
    const db = openDb(":memory:");
    const now = Date.now();
    // Seed a real redispatch storm so a NON-throttled scan would emit events.
    const directiveId = newId();
    const taskId = newId();
    for (let i = 0; i <= SUPERVISOR_MAX_REDISPATCHES_PER_TASK; i++) {
      insertDispatch(db, new Date(now - 1000 * i).toISOString(), taskId, directiveId);
    }

    // First call (throttle gate open): real scan, fires the storm.
    const first = supervisorTick(db, { nowMs: now });
    expect(first.throttled).toBe(false);
    expect(first.redispatch_storm_count).toBe(1);
    const emittedAfterFirst = (db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'task_failed'")
      .get() as { c: number }).c;
    expect(emittedAfterFirst).toBe(1);

    // Second call only 1s later (inside the gap): MUST be a no-op. Seed a
    // brand-new storm to prove the throttle skips the scan entirely.
    const t2 = newId();
    for (let i = 0; i <= SUPERVISOR_MAX_REDISPATCHES_PER_TASK; i++) {
      insertDispatch(db, new Date(now + 1000 - 1000 * i).toISOString(), t2, newId());
    }
    const second = supervisorTick(db, { nowMs: now + 1000 });
    expect(second.throttled).toBe(true);
    expect(second.redispatch_storm_count).toBe(0);
    // No new task_failed emitted — the second storm was never scanned.
    const emittedAfterSecond = (db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'task_failed'")
      .get() as { c: number }).c;
    expect(emittedAfterSecond).toBe(1);

    // A call past the gap window scans again and catches the second storm.
    const third = supervisorTick(db, { nowMs: now + SUPERVISOR_MIN_GAP_MS + 1 });
    expect(third.throttled).toBe(false);
    expect(third.redispatch_storm_count).toBe(1);
  });

  test("detector results are byte-identical across the async refactor (same inputs → same emitted events)", async () => {
    // Run the redispatch-storm detector directly (no throttle) and via the
    // throttled supervisorTick on identical seeded state; both must produce
    // exactly one task_failed + one supervisor_intervention_recorded.
    const seed = (db: ReturnType<typeof openDb>, now: number) => {
      const directiveId = newId();
      const taskId = newId();
      for (let i = 0; i <= SUPERVISOR_MAX_REDISPATCHES_PER_TASK; i++) {
        insertDispatch(db, new Date(now - 1000 * i).toISOString(), taskId, directiveId);
      }
      return { directiveId, taskId };
    };

    const dbA = openDb(":memory:");
    const now = Date.now();
    const { taskId: taskA } = seed(dbA, now);
    const direct = detectRedispatchStorm(dbA, { nowMs: now });
    expect(direct.length).toBe(1);
    expect(direct[0].task_id).toBe(taskA);

    closeDb();
    __resetSupervisorThrottle();
    const dbB = openDb(":memory:");
    const { taskId: taskB } = seed(dbB, now);
    const viaTick = supervisorTick(dbB, { nowMs: now });
    expect(viaTick.throttled).toBe(false);
    expect(viaTick.redispatch_storm_count).toBe(1);
    const failedB = dbB
      .query("SELECT failure_kind FROM events WHERE kind = 'task_failed' AND task_id = ?")
      .get(taskB) as { failure_kind: string } | null;
    expect(failedB?.failure_kind).toBe("redispatch_storm");
  });
});

describe("supervisor — bounded-scan ts-window perf fix (2026-05-24)", () => {
  // The b62fd6d SQL-pool off-load made the loop block WORSE; the real fix is
  // bounding each detector's GROUP BY scan to a recent ts window so the planner
  // does a ts-range SEARCH (idx_events_kind_ts) instead of scanning all 400k
  // rows. These tests pin (a) that the heaviest unbounded detector now uses a
  // ts-range index and (b) that a pathology INSIDE the window is still caught.

  test("detectDispatchBudgetExceeded EXPLAIN uses a ts-range index SEARCH, not a bare SCAN", () => {
    const db = openDb(":memory:");
    const nowMs = Date.now();
    const cutoffIso = new Date(nowMs - 6 * 60 * 60 * 1000).toISOString();
    // Mirror the detector's exact bounded query so EXPLAIN reflects production.
    const plan = db
      .query(
        `EXPLAIN QUERY PLAN
         SELECT directive_id, COUNT(*) AS dispatch_count
           FROM events
           WHERE kind = 'brain_dispatched' AND ts >= ?
           GROUP BY directive_id
           HAVING dispatch_count > ?`,
      )
      .all(cutoffIso, SUPERVISOR_MAX_DISPATCHES_PER_DIRECTIVE) as Array<{ detail: string }>;
    const detail = plan.map((r) => r.detail).join(" | ");
    // Must be a ts-range SEARCH on the kind+ts index — NOT a full table SCAN.
    expect(detail).toContain("SEARCH events USING INDEX idx_events_kind_ts");
    expect(detail).toContain("ts>");
    expect(detail).not.toContain("SCAN events");
  });

  test("dispatch-budget pathology INSIDE the window is still detected (no false negative)", () => {
    const db = openDb(":memory:");
    const dir = newId();
    const task = newId();
    // Anchor a fixed now; seed > cap dispatches all within the last few minutes
    // (well inside the 6h count window). The pathology is live → still caught.
    const nowMs = Date.parse("2026-05-24T12:00:00.000Z");
    for (let i = 0; i <= SUPERVISOR_MAX_DISPATCHES_PER_DIRECTIVE; i++) {
      insertDispatch(db, new Date(nowMs - 1000 * i).toISOString(), task, dir);
    }
    const over = detectDispatchBudgetExceeded(db, { nowMs });
    expect(over.map((o) => o.directive_id)).toContain(dir);
  });

  test("dispatch-budget count is bounded to the window — ancient dispatches outside it do NOT count", () => {
    const db = openDb(":memory:");
    const dir = newId();
    const task = newId();
    const nowMs = Date.parse("2026-05-24T12:00:00.000Z");
    // Seed > cap dispatches, but ALL more than 6h before nowMs (i.e. quiet/dead
    // directive). The bounded scan must not count them, so no archive fires.
    // A directive idle this long is caught by the DAG age gate instead.
    for (let i = 0; i <= SUPERVISOR_MAX_DISPATCHES_PER_DIRECTIVE; i++) {
      insertDispatch(db, new Date(nowMs - 7 * 60 * 60 * 1000 - 1000 * i).toISOString(), task, dir);
    }
    const over = detectDispatchBudgetExceeded(db, { nowMs });
    expect(over.map((o) => o.directive_id)).not.toContain(dir);
  });

  test("a real pathology within the window is detected while the throttle no-ops a second call inside the gap", () => {
    __resetSupervisorThrottle();
    const db = openDb(":memory:");
    const nowMs = Date.parse("2026-05-24T12:00:00.000Z");
    // Live redispatch storm fully inside the 5-min redispatch window.
    const dir = newId();
    const task = newId();
    for (let i = 0; i <= SUPERVISOR_MAX_REDISPATCHES_PER_TASK; i++) {
      insertDispatch(db, new Date(nowMs - 1000 * i).toISOString(), task, dir);
    }
    // First tick (gate open): catches the in-window storm.
    const first = supervisorTick(db, { nowMs });
    expect(first.throttled).toBe(false);
    expect(first.redispatch_storm_count).toBe(1);
    // Second tick inside the gap: throttled no-op, scans nothing.
    const second = supervisorTick(db, { nowMs: nowMs + 1000 });
    expect(second.throttled).toBe(true);
    expect(second.redispatch_storm_count).toBe(0);
  });
});
