import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import { readDagForDirective, readyTasks, refinementDepth } from "./task_topology";
import { newId } from "./ids";

afterAll(() => closeDb());
beforeEach(() => closeDb());

describe("task_topology", () => {
  test("readDagForDirective round-trips nodes + edges", () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const a = newId();
    const b = newId();
    emitEvent(db, {
      kind: "task_node_opened",
      directive_id: directiveId,
      task_id: a,
      payload: { goal: "A" },
    });
    emitEvent(db, {
      kind: "task_node_opened",
      directive_id: directiveId,
      task_id: b,
      payload: { goal: "B" },
    });
    emitEvent(db, {
      kind: "task_edge_recorded",
      directive_id: directiveId,
      task_id: a,
      payload: { from_task: a, to_task: b, kind: "requires" },
    });
    const dag = readDagForDirective(db, directiveId);
    expect(dag.nodes).toHaveLength(2);
    expect(dag.edges).toHaveLength(1);
    expect(dag.edges[0]!.kind).toBe("requires");
    expect(dag.edges[0]!.from_task).toBe(a);
    expect(dag.edges[0]!.to_task).toBe(b);
  });

  test("readyTasks excludes nodes whose required upstreams aren't committed", () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const a = newId();
    const b = newId();
    emitEvent(db, { kind: "task_node_opened", directive_id: directiveId, task_id: a, payload: { goal: "A" } });
    emitEvent(db, { kind: "task_node_opened", directive_id: directiveId, task_id: b, payload: { goal: "B" } });
    emitEvent(db, {
      kind: "task_edge_recorded",
      directive_id: directiveId,
      task_id: b,
      payload: { from_task: a, to_task: b, kind: "requires" },
    });
    // Both are ready-shape, but B requires A which hasn't committed.
    const ready1 = readyTasks(db, directiveId);
    expect(ready1.map((n) => n.id)).toContain(a);
    expect(ready1.map((n) => n.id)).not.toContain(b);

    // Commit A.
    emitEvent(db, {
      kind: "task_committed",
      directive_id: directiveId,
      task_id: a,
      outcome: "succeeded",
      payload: {},
    });
    const ready2 = readyTasks(db, directiveId);
    expect(ready2.map((n) => n.id)).toContain(b);
  });

  test("refinementDepth walks the refines chain upward", () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const root = newId();
    const r1 = newId();
    const r2 = newId();
    emitEvent(db, { kind: "task_node_opened", directive_id: directiveId, task_id: root, payload: { goal: "root" } });
    emitEvent(db, { kind: "task_node_opened", directive_id: directiveId, task_id: r1, payload: { goal: "r1" } });
    emitEvent(db, { kind: "task_node_opened", directive_id: directiveId, task_id: r2, payload: { goal: "r2" } });
    emitEvent(db, {
      kind: "task_edge_recorded",
      directive_id: directiveId,
      task_id: r1,
      payload: { from_task: root, to_task: r1, kind: "refines" },
    });
    emitEvent(db, {
      kind: "task_edge_recorded",
      directive_id: directiveId,
      task_id: r2,
      payload: { from_task: r1, to_task: r2, kind: "refines" },
    });
    expect(refinementDepth(db, root)).toBe(0);
    expect(refinementDepth(db, r1)).toBe(1);
    expect(refinementDepth(db, r2)).toBe(2);
  });
});
