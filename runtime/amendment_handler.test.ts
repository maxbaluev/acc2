import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import { newId } from "./ids";
import {
  applyAmendment,
  emitAndApplyAmendment,
  findUnappliedAmendments,
} from "./amendment_handler";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const seedDirective = (db: ReturnType<typeof openDb>) => {
  const directiveId = newId();
  const rootTaskId = newId();
  const supersededTaskId = newId();

  emitEvent(db, {
    kind: "directive_opened",
    substrate_origin: "owner",
    directive_id: directiveId,
    task_id: directiveId,
    payload: { directive_text: "original goal", lifecycle: "finite" },
  });
  emitEvent(db, {
    kind: "task_node_opened",
    substrate_origin: "owner",
    directive_id: directiveId,
    task_id: rootTaskId,
    parent_task_id: null,
    payload: { goal: "root", lifecycle: "finite" },
  });
  emitEvent(db, {
    kind: "task_node_opened",
    substrate_origin: "owner",
    directive_id: directiveId,
    task_id: supersededTaskId,
    parent_task_id: rootTaskId,
    payload: { goal: "to-be-superseded", lifecycle: "finite" },
  });
  // A prediction targeting the soon-to-be-superseded task.
  const prediction = emitEvent(db, {
    kind: "action_predicted",
    directive_id: directiveId,
    task_id: supersededTaskId,
    predicted_residual: 0.2,
    payload: { intent: "old prediction" },
  });
  return { directiveId, rootTaskId, supersededTaskId, predictionId: prediction.id };
};

describe("amendment_handler", () => {
  test("supersedes tasks, marks predictions, opens new tasks", async () => {
    const db = openDb(":memory:");
    const { directiveId, supersededTaskId, predictionId } = seedDirective(db);

    const summary = await emitAndApplyAmendment(db, {
      original_directive_id: directiveId,
      amendment_text: "narrow to remote-only",
      superseded_tasks: [supersededTaskId],
      superseded_predictions: [predictionId],
      new_task_goals: ["new goal A", "new goal B"],
      rationale: "owner reframed scope",
      amended_by: "owner",
    });

    expect(summary.already_applied).toBe(false);
    expect(summary.superseded_tasks_closed).toContain(supersededTaskId);
    expect(summary.superseded_predictions_marked).toContain(predictionId);
    expect(summary.new_tasks_opened.length).toBe(2);

    // Prediction marked amended
    const pred = db
      .query("SELECT outcome FROM events WHERE id = ?")
      .get(predictionId) as { outcome: string };
    expect(pred.outcome).toBe("amended");

    // Superseded task got task_committed_superseded
    const sup = db
      .query("SELECT COUNT(*) as c FROM events WHERE task_id = ? AND kind = 'task_committed_superseded'")
      .get(supersededTaskId) as { c: number };
    expect(sup.c).toBe(1);

    // Two new task_node_opened events for the new goals
    for (const newTaskId of summary.new_tasks_opened) {
      const opened = db
        .query("SELECT payload FROM events WHERE task_id = ? AND kind = 'task_node_opened'")
        .get(newTaskId) as { payload: string };
      expect(opened).not.toBeNull();
      const p = JSON.parse(opened.payload);
      expect(p.source).toBe("directive_amended");
    }
  });

  test("re-applying the same amendment is a no-op (idempotent)", async () => {
    const db = openDb(":memory:");
    const { directiveId, supersededTaskId } = seedDirective(db);

    const first = await emitAndApplyAmendment(db, {
      original_directive_id: directiveId,
      amendment_text: "x",
      superseded_tasks: [supersededTaskId],
      new_task_goals: ["new goal"],
    });
    expect(first.already_applied).toBe(false);

    const replay = await applyAmendment(db, first.amendment_event_id);
    expect(replay.already_applied).toBe(true);
    expect(replay.new_tasks_opened.length).toBe(0);

    // Only one task_committed_superseded should exist on the superseded task.
    const sup = db
      .query("SELECT COUNT(*) as c FROM events WHERE task_id = ? AND kind = 'task_committed_superseded'")
      .get(supersededTaskId) as { c: number };
    expect(sup.c).toBe(1);
  });

  test("amendment with no superseded targets still opens new tasks", async () => {
    const db = openDb(":memory:");
    const { directiveId } = seedDirective(db);

    const summary = await emitAndApplyAmendment(db, {
      original_directive_id: directiveId,
      amendment_text: "add follow-ups",
      new_task_goals: ["solo new"],
    });
    expect(summary.superseded_tasks_closed.length).toBe(0);
    expect(summary.superseded_predictions_marked.length).toBe(0);
    expect(summary.new_tasks_opened.length).toBe(1);
  });

  test("applyAmendment throws for non-existent event_id", async () => {
    const db = openDb(":memory:");
    let threw = false;
    try {
      await applyAmendment(db, "nonexistent_event_id");
    } catch (err) {
      threw = true;
      expect((err as Error).message).toContain("amendment event not found");
    }
    expect(threw).toBe(true);
  });

  test("applyAmendment throws when event is not directive_amended", async () => {
    const db = openDb(":memory:");
    const { directiveId } = seedDirective(db);
    const evt = emitEvent(db, {
      kind: "directive_opened",
      directive_id: directiveId,
      payload: {},
    });
    let threw = false;
    try {
      await applyAmendment(db, evt.id);
    } catch (err) {
      threw = true;
      expect((err as Error).message).toContain("is not directive_amended");
    }
    expect(threw).toBe(true);
  });

  test("amendment_applied milestone records the change diff", async () => {
    const db = openDb(":memory:");
    const { directiveId, supersededTaskId } = seedDirective(db);
    const summary = await emitAndApplyAmendment(db, {
      original_directive_id: directiveId,
      amendment_text: "amend",
      superseded_tasks: [supersededTaskId],
      new_task_goals: ["new"],
    });
    const milestone = db
      .query(
        "SELECT payload FROM events WHERE kind = 'directive_milestone_recorded' AND directive_id = ? ORDER BY ts DESC LIMIT 1",
      )
      .get(directiveId) as { payload: string } | null;
    expect(milestone).not.toBeNull();
    const p = JSON.parse(milestone!.payload);
    expect(p.milestone).toBe("amendment_applied");
    expect(p.amendment_event_id).toBe(summary.amendment_event_id);
  });

  test("findUnappliedAmendments returns only events not yet applied", async () => {
    const db = openDb(":memory:");
    const { directiveId } = seedDirective(db);

    const a = emitEvent(db, {
      kind: "directive_amended",
      substrate_origin: "owner",
      directive_id: directiveId,
      payload: {
        original_directive_id: directiveId,
        amendment_text: "amendment a",
        new_task_goals: ["a"],
      },
    });
    const b = emitEvent(db, {
      kind: "directive_amended",
      substrate_origin: "owner",
      directive_id: directiveId,
      payload: {
        original_directive_id: directiveId,
        amendment_text: "amendment b",
        new_task_goals: ["b"],
      },
    });

    const before = findUnappliedAmendments(db);
    expect(before).toContain(a.id);
    expect(before).toContain(b.id);

    await applyAmendment(db, a.id);
    const after = findUnappliedAmendments(db);
    expect(after).not.toContain(a.id);
    expect(after).toContain(b.id);
  });
});
