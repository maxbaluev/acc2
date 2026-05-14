// acc2 cross-directive interference tests — Phase I (v2-design.md §3.4).

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { runViews } from "../substrate/views";
import { emitEvent } from "./events";
import { newId } from "./ids";
import {
  recordInterferenceEdge,
  readInterferenceEdges,
  detectInterferenceCycles,
  renderInterferenceBlock,
  blockersOf,
} from "./interference";
import { decideDispatch } from "./dispatch_decider";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const openDirective = (db: ReturnType<typeof openDb>, text: string): string => {
  const id = newId();
  emitEvent(db, {
    kind: "directive_opened",
    substrate_origin: "owner",
    directive_id: id,
    task_id: id,
    payload: { directive_text: text, lifecycle: "finite" },
  });
  return id;
};

describe("interference", () => {
  test("recordInterferenceEdge emits directive_interference_edge and stores reason", () => {
    const db = openDb(":memory:");
    const a = openDirective(db, "save for retirement");
    const b = openDirective(db, "buy house");
    const result = recordInterferenceEdge(db, {
      from_directive: a,
      to_directive: b,
      kind: "depletes",
      reason: "down payment drains 401k",
    });
    expect(result.ok).toBe(true);

    const rows = db
      .query("SELECT payload FROM events WHERE kind = 'directive_interference_edge'")
      .all() as Array<{ payload: string }>;
    expect(rows.length).toBe(1);
    const payload = JSON.parse(rows[0]!.payload);
    expect(payload.kind).toBe("depletes");
    expect(payload.reason).toContain("401k");
  });

  test("recordInterferenceEdge refuses self-loops", () => {
    const db = openDb(":memory:");
    const a = openDirective(db, "self-loop");
    const result = recordInterferenceEdge(db, {
      from_directive: a,
      to_directive: a,
      kind: "blocks",
      reason: "absurd",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("self_loop_refused");
  });

  test("readInterferenceEdges returns typed rows in ts order", () => {
    const db = openDb(":memory:");
    const a = openDirective(db, "A");
    const b = openDirective(db, "B");
    const c = openDirective(db, "C");
    recordInterferenceEdge(db, { from_directive: a, to_directive: b, kind: "watches", reason: "" });
    recordInterferenceEdge(db, { from_directive: b, to_directive: c, kind: "blocks", reason: "blocker" });
    const edges = readInterferenceEdges(db);
    expect(edges.length).toBe(2);
    expect(edges[0]!.kind).toBe("watches");
    expect(edges[1]!.kind).toBe("blocks");
  });

  test("detectInterferenceCycles finds A→B→C→A in blocks subgraph", () => {
    const db = openDb(":memory:");
    const a = openDirective(db, "A");
    const b = openDirective(db, "B");
    const c = openDirective(db, "C");
    recordInterferenceEdge(db, { from_directive: a, to_directive: b, kind: "blocks", reason: "" });
    recordInterferenceEdge(db, { from_directive: b, to_directive: c, kind: "blocks", reason: "" });
    // The third edge would close the cycle — recordInterferenceEdge surfaces it.
    recordInterferenceEdge(db, { from_directive: c, to_directive: a, kind: "blocks", reason: "" });
    const cycles = detectInterferenceCycles(db);
    expect(cycles.length).toBe(1);
    expect(new Set(cycles[0])).toEqual(new Set([a, b, c]));

    const detected = db
      .query("SELECT COUNT(*) as c FROM events WHERE kind = 'directive_interference_cycle_detected'")
      .get() as { c: number };
    expect(detected.c).toBeGreaterThanOrEqual(1);
  });

  test("cycle detection ignores watches / depletes edges", () => {
    const db = openDb(":memory:");
    const a = openDirective(db, "A");
    const b = openDirective(db, "B");
    recordInterferenceEdge(db, { from_directive: a, to_directive: b, kind: "watches", reason: "" });
    recordInterferenceEdge(db, { from_directive: b, to_directive: a, kind: "watches", reason: "" });
    const cycles = detectInterferenceCycles(db);
    expect(cycles.length).toBe(0);
  });

  test("renderInterferenceBlock surfaces edges that touch this directive", () => {
    const db = openDb(":memory:");
    const a = openDirective(db, "A");
    const b = openDirective(db, "B");
    recordInterferenceEdge(db, { from_directive: a, to_directive: b, kind: "blocks", reason: "release blocker" });
    const block = renderInterferenceBlock(db, a);
    expect(block).toContain("CROSS-DIRECTIVE INTERFERENCE");
    expect(block).toContain("blocks");
    expect(block).toContain("release blocker");
  });

  test("renderInterferenceBlock returns empty when no edges touch this directive", () => {
    const db = openDb(":memory:");
    const a = openDirective(db, "A");
    expect(renderInterferenceBlock(db, a)).toBe("");
  });

  test("blockersOf returns unresolved blockers (not closed source directives)", () => {
    const db = openDb(":memory:");
    const a = openDirective(db, "A");
    const b = openDirective(db, "B");
    const c = openDirective(db, "C");
    recordInterferenceEdge(db, { from_directive: a, to_directive: c, kind: "blocks", reason: "" });
    recordInterferenceEdge(db, { from_directive: b, to_directive: c, kind: "blocks", reason: "" });
    // Close A so it no longer blocks.
    emitEvent(db, {
      kind: "goal_committed",
      substrate_origin: "substrate_auto",
      directive_id: a,
      payload: {},
    });
    const blockers = blockersOf(db, c);
    expect(blockers).toEqual([b]);
  });

  test("decideDispatch returns deferred_blocked when the task's directive is blocked", () => {
    const db = openDb(":memory:");
    const a = openDirective(db, "A blocker");
    const b = openDirective(db, "B target");
    const taskId = newId();
    emitEvent(db, {
      kind: "task_node_opened",
      directive_id: b,
      task_id: taskId,
      payload: { goal: "do thing" },
    });
    recordInterferenceEdge(db, { from_directive: a, to_directive: b, kind: "blocks", reason: "wait for A" });

    const decision = decideDispatch(db, {
      id: taskId,
      directive_id: b,
      parent_id: null,
      goal: "do thing",
      status: "pending",
    });
    expect(decision.route).toBe("deferred_blocked");
    if (decision.route === "deferred_blocked") {
      expect(decision.blockers).toContain(a);
    }
  });

  test("directive_conflicts_view exposes interference edges", () => {
    const db = openDb(":memory:");
    runViews(db);
    const a = openDirective(db, "A");
    const b = openDirective(db, "B");
    recordInterferenceEdge(db, { from_directive: a, to_directive: b, kind: "depletes", reason: "shared budget" });
    const rows = db.query("SELECT * FROM directive_conflicts_view").all() as Array<{ payload: string }>;
    expect(rows.length).toBe(1);
    const payload = JSON.parse(rows[0]!.payload);
    expect(payload.kind).toBe("depletes");
  });
});
