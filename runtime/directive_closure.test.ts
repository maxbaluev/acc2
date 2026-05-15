import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { runViews } from "../substrate/views";
import { emitEvent } from "./events";
import { newId } from "./ids";
import {
  closedDirectiveIds,
  directiveCloseReason,
  maybeCloseFinishedDirective,
} from "./directive_closure";
import { readyTasks } from "./task_topology";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const openFiniteDirective = (db: ReturnType<typeof openDb>) => {
  const directiveId = newId();
  const taskId = newId();
  emitEvent(db, {
    kind: "directive_opened",
    substrate_origin: "owner",
    directive_id: directiveId,
    task_id: directiveId,
    payload: { directive_text: "fixture", lifecycle: "finite" },
  });
  emitEvent(db, {
    kind: "task_node_opened",
    substrate_origin: "owner",
    directive_id: directiveId,
    task_id: taskId,
    parent_task_id: null,
    payload: { goal: "fixture goal" },
  });
  return { directiveId, taskId };
};

describe("directive_closure", () => {
  test("directiveCloseReason returns null while a task is still live", () => {
    const db = openDb(":memory:");
    const { directiveId } = openFiniteDirective(db);
    expect(directiveCloseReason(db, directiveId)).toBeNull();
  });

  test("directiveCloseReason returns reason once every task is terminal", () => {
    const db = openDb(":memory:");
    const { directiveId, taskId } = openFiniteDirective(db);
    emitEvent(db, {
      kind: "task_committed",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      task_id: taskId,
      payload: {},
    });
    expect(directiveCloseReason(db, directiveId)).toBe("all_tasks_terminal");
  });

  test("rolling_active directives never auto-close", () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const taskId = newId();
    emitEvent(db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: directiveId,
      payload: { directive_text: "rolling", lifecycle: "rolling_active" },
    });
    emitEvent(db, {
      kind: "task_node_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: taskId,
      parent_task_id: null,
      payload: { goal: "rolling root" },
    });
    emitEvent(db, {
      kind: "task_committed",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      task_id: taskId,
      payload: {},
    });
    expect(directiveCloseReason(db, directiveId)).toBeNull();
    expect(maybeCloseFinishedDirective(db, directiveId)).toBeNull();
  });

  test("maybeCloseFinishedDirective is idempotent — emits at most one directive_closed", () => {
    const db = openDb(":memory:");
    const { directiveId, taskId } = openFiniteDirective(db);
    emitEvent(db, {
      kind: "task_committed",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      task_id: taskId,
      payload: {},
    });

    expect(maybeCloseFinishedDirective(db, directiveId)).toBe("all_tasks_terminal");
    expect(maybeCloseFinishedDirective(db, directiveId)).toBeNull();

    const closedRows = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'directive_closed' AND directive_id = ?")
      .get(directiveId) as { c: number };
    expect(closedRows.c).toBe(1);
  });

  test("closedDirectiveIds includes directives closed by either auto-close or operator archive", () => {
    const db = openDb(":memory:");
    const auto = openFiniteDirective(db);
    emitEvent(db, {
      kind: "task_committed",
      substrate_origin: "substrate_auto",
      directive_id: auto.directiveId,
      task_id: auto.taskId,
      payload: {},
    });
    maybeCloseFinishedDirective(db, auto.directiveId);

    const archived = openFiniteDirective(db);
    emitEvent(db, {
      kind: "directive_archived_by_operator",
      substrate_origin: "owner",
      directive_id: archived.directiveId,
      payload: { reason: "owner_cleanup" },
    });

    const live = openFiniteDirective(db);

    const closed = closedDirectiveIds(db);
    expect(closed.has(auto.directiveId)).toBe(true);
    expect(closed.has(archived.directiveId)).toBe(true);
    expect(closed.has(live.directiveId)).toBe(false);
  });

  test("readyTasks() skips tasks under closed directives — structural zombie-loop fix", () => {
    const db = openDb(":memory:");
    runViews(db);

    // Live directive — its task should appear in readyTasks.
    const live = openFiniteDirective(db);

    // Closed directive — committed task, then maybeClose fires.
    const done = openFiniteDirective(db);
    emitEvent(db, {
      kind: "task_committed",
      substrate_origin: "substrate_auto",
      directive_id: done.directiveId,
      task_id: done.taskId,
      payload: {},
    });
    maybeCloseFinishedDirective(db, done.directiveId);

    // Directive whose root is committed but no directive_closed event was
    // emitted (worker hasn't run yet). The pre-Batch-2 contract was that
    // committed tasks alone keep readyTasks() honest — we don't break that.
    const finishedButNotClosed = openFiniteDirective(db);
    emitEvent(db, {
      kind: "task_committed",
      substrate_origin: "substrate_auto",
      directive_id: finishedButNotClosed.directiveId,
      task_id: finishedButNotClosed.taskId,
      payload: {},
    });
    // (intentionally NOT calling maybeCloseFinishedDirective here)

    const ready = readyTasks(db);
    const readyIds = new Set(ready.map((n) => n.id));
    expect(readyIds.has(live.taskId)).toBe(true);
    expect(readyIds.has(done.taskId)).toBe(false);
    expect(readyIds.has(finishedButNotClosed.taskId)).toBe(false);
  });

  test("ready_tasks_view (SQL) also filters closed directives", () => {
    const db = openDb(":memory:");
    runViews(db);

    const live = openFiniteDirective(db);
    const done = openFiniteDirective(db);
    emitEvent(db, {
      kind: "task_committed",
      substrate_origin: "substrate_auto",
      directive_id: done.directiveId,
      task_id: done.taskId,
      payload: {},
    });
    maybeCloseFinishedDirective(db, done.directiveId);

    const rows = db
      .query("SELECT task_id FROM ready_tasks_view")
      .all() as Array<{ task_id: string }>;
    const ids = new Set(rows.map((r) => r.task_id));
    expect(ids.has(live.taskId)).toBe(true);
    expect(ids.has(done.taskId)).toBe(false);
  });
});
