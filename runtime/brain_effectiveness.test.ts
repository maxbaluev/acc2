import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import { newId } from "./ids";
import {
  classifyDirective,
  STALLED_THRESHOLD_MS,
  summarizeEffectiveness,
} from "./brain_effectiveness";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const seedDirective = (db: ReturnType<typeof openDb>, withRefines = false): { directiveId: string; rootTaskId: string } => {
  const directiveId = newId();
  const rootTaskId = newId();
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
    task_id: rootTaskId,
    parent_task_id: null,
    payload: { goal: "root" },
  });
  emitEvent(db, {
    kind: "brain_dispatched",
    substrate_origin: "substrate_auto",
    directive_id: directiveId,
    task_id: rootTaskId,
    payload: { dispatch_id: newId() },
  });
  if (withRefines) {
    const childId = newId();
    emitEvent(db, {
      kind: "task_node_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: childId,
      parent_task_id: rootTaskId,
      payload: { goal: "child" },
    });
    emitEvent(db, {
      kind: "task_edge_recorded",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: rootTaskId,
      payload: { kind: "refines", from_task: rootTaskId, to_task: childId },
    });
  }
  return { directiveId, rootTaskId };
};

describe("brain_effectiveness", () => {
  test("classifies first_dispatch_committed when root commits without refines", () => {
    const db = openDb(":memory:");
    const { directiveId, rootTaskId } = seedDirective(db, false);
    emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      task_id: rootTaskId,
      action_artifact_id: "test_action_handle",
      verifier_artifact_id: "test_verifier_handle",
      payload: { residual: 0.12, verifier_kind: "deterministic_code" },
      residual: 0.12,
    });
    emitEvent(db, {
      kind: "task_committed",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: rootTaskId,
      payload: { summary: "done" },
    });
    const row = classifyDirective(db, directiveId)!;
    expect(row.classification).toBe("first_dispatch_committed");
    expect(row.refinement_edge_count).toBe(0);
    expect(row.dispatch_count).toBe(1);
    expect(row.latest_residual).toBeCloseTo(0.12);
    expect(typeof row.time_to_terminal_ms).toBe("number");
  });

  test("classifies refined_then_committed when refinement edges exist", () => {
    const db = openDb(":memory:");
    const { directiveId, rootTaskId } = seedDirective(db, true);
    emitEvent(db, {
      kind: "task_committed",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: rootTaskId,
      payload: { summary: "done after refinement" },
    });
    const row = classifyDirective(db, directiveId)!;
    expect(row.classification).toBe("refined_then_committed");
    expect(row.refinement_edge_count).toBe(1);
  });

  test("classifies failed when root task_failed lands", () => {
    const db = openDb(":memory:");
    const { directiveId, rootTaskId } = seedDirective(db, false);
    emitEvent(db, {
      kind: "task_failed",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      task_id: rootTaskId,
      failure_kind: "consecutive_bridge_failures",
      payload: { reason: "consecutive_bridge_failures_exceeded_cap" },
    });
    const row = classifyDirective(db, directiveId)!;
    expect(row.classification).toBe("failed");
  });

  test("classifies failed when directive_archived_by_operator (supervisor archive)", () => {
    const db = openDb(":memory:");
    const { directiveId } = seedDirective(db, false);
    emitEvent(db, {
      kind: "directive_archived_by_operator",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      payload: { reason: "supervisor_dispatch_budget_exceeded" },
    });
    const row = classifyDirective(db, directiveId)!;
    expect(row.classification).toBe("failed");
  });

  test("classifies stalled when older than STALLED_THRESHOLD_MS with no terminal", () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const rootTaskId = newId();
    // Backdate the directive_opened so the classifier treats it as old.
    const oldTs = new Date(Date.now() - (STALLED_THRESHOLD_MS + 60_000)).toISOString();
    db.query(
      `INSERT INTO events (id, ts, kind, substrate_origin, directive_id, task_id, loop_id, payload)
       VALUES (?, ?, 'directive_opened', 'owner', ?, ?, '', ?)`,
    ).run(newId(), oldTs, directiveId, directiveId, JSON.stringify({ directive_text: "old", lifecycle: "finite" }));
    db.query(
      `INSERT INTO events (id, ts, kind, substrate_origin, directive_id, task_id, parent_task_id, loop_id, payload)
       VALUES (?, ?, 'task_node_opened', 'owner', ?, ?, NULL, '', ?)`,
    ).run(newId(), oldTs, directiveId, rootTaskId, JSON.stringify({ goal: "old" }));
    const row = classifyDirective(db, directiveId)!;
    expect(row.classification).toBe("stalled");
  });

  test("classifies in_flight when recent with no terminal/refinement signals", () => {
    const db = openDb(":memory:");
    const { directiveId } = seedDirective(db, false);
    const row = classifyDirective(db, directiveId)!;
    expect(row.classification).toBe("in_flight");
  });

  test("summarizeEffectiveness computes first_dispatch_committed_rate over a window", () => {
    const db = openDb(":memory:");
    // 2 first-dispatch, 1 refined, 1 failed.
    for (let i = 0; i < 2; i++) {
      const { directiveId, rootTaskId } = seedDirective(db, false);
      emitEvent(db, {
        kind: "task_committed",
        substrate_origin: "owner",
        directive_id: directiveId,
        task_id: rootTaskId,
        payload: {},
      });
    }
    {
      const { directiveId, rootTaskId } = seedDirective(db, true);
      emitEvent(db, {
        kind: "task_committed",
        substrate_origin: "owner",
        directive_id: directiveId,
        task_id: rootTaskId,
        payload: {},
      });
    }
    {
      const { directiveId, rootTaskId } = seedDirective(db, false);
      emitEvent(db, {
        kind: "task_failed",
        substrate_origin: "substrate_auto",
        directive_id: directiveId,
        task_id: rootTaskId,
        failure_kind: "consecutive_bridge_failures",
        payload: {},
      });
    }
    const s = summarizeEffectiveness(db);
    expect(s.total).toBe(4);
    expect(s.by_classification.first_dispatch_committed).toBe(2);
    expect(s.by_classification.refined_then_committed).toBe(1);
    expect(s.by_classification.failed).toBe(1);
    expect(s.first_dispatch_committed_rate).toBeCloseTo(2 / 3);
  });
});
