import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import { newId } from "./ids";
import {
  detectRedispatchStorm,
  detectDagExplosion,
  supervisorTick,
  SUPERVISOR_MAX_REDISPATCHES_PER_TASK,
  SUPERVISOR_MAX_READY_TASKS_PER_DIRECTIVE,
  SUPERVISOR_MAX_DIRECTIVE_AGE_HOURS,
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
  test("does NOT quarantine a task with dispatches below the threshold", () => {
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

  test("quarantines a task with > SUPERVISOR_MAX_REDISPATCHES_PER_TASK dispatches", () => {
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

  test("does NOT re-fail an already-terminal task (idempotent)", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    const directiveId = newId();
    const taskId = newId();
    for (let i = 0; i <= SUPERVISOR_MAX_REDISPATCHES_PER_TASK; i++) {
      insertDispatch(db, new Date(now - 1000 * i).toISOString(), taskId, directiveId);
    }
    // First call: fails the task.
    expect(detectRedispatchStorm(db, { nowMs: now }).length).toBe(1);
    // Second call: task is now terminal; supervisor skips it.
    expect(detectRedispatchStorm(db, { nowMs: now }).length).toBe(0);
    const failedCount = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'task_failed' AND task_id = ?")
      .get(taskId) as { c: number };
    expect(failedCount.c).toBe(1);
  });
});

describe("supervisor — detectDagExplosion", () => {
  test("does NOT archive a young directive even with many ready tasks", () => {
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

  test("archives a directive with ready_count > threshold AND age > threshold", () => {
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

  test("does NOT re-archive an already-closed directive (idempotent)", () => {
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
    expect(detectDagExplosion(db, { nowMs: now }).length).toBe(1);
    expect(detectDagExplosion(db, { nowMs: now }).length).toBe(0);
  });
});

describe("supervisor — supervisorTick composition", () => {
  test("supervisorTick runs every detector and returns a summary", () => {
    const db = openDb(":memory:");
    const result = supervisorTick(db);
    expect(result).toEqual({
      redispatch_storm_count: 0,
      dag_explosion_count: 0,
      dispatch_budget_exceeded_count: 0,
      ready_starvation_count: 0,
      pathology_budget_exhausted_count: 0,
      bridge_health_degraded: false,
      bridge_health_recovered: false,
    });
  });
});
