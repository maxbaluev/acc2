import { afterEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import { newId } from "./ids";
import { readyTasks } from "./task_topology";
import {
  REFINEMENT_DEPTH_CAP,
  checkpointInterruptedDispatches,
  emitRefinementContinuation,
} from "./dispatch_continuation";

afterEach(() => {
  closeDb();
});

/** Open a directive + one in-flight-style task (directive_opened +
 *  task_node_opened + a dangling brain_dispatched with no terminal). */
const openInFlightTask = (
  db: ReturnType<typeof openDb>,
  goal: string,
): { directiveId: string; taskId: string } => {
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
    payload: { goal },
  });
  emitEvent(db, {
    kind: "brain_dispatched",
    substrate_origin: "substrate_auto",
    directive_id: directiveId,
    task_id: taskId,
    payload: { dispatch_id: newId(), task_id: taskId, route_pending: true },
  });
  return { directiveId, taskId };
};

describe("dispatch continuation — no job loss on restart (GOAL 2)", () => {
  test("an in-flight dispatch interrupted by graceful shutdown is CHECKPOINTED (refinement continuation), not abandoned", () => {
    const db = openDb(":memory:");
    const { directiveId, taskId } = openInFlightTask(db, "in-flight brain work that the drain budget interrupted");

    // Simulate the daemon stop() drain timing out with this task still in flight.
    const result = checkpointInterruptedDispatches(db, [taskId]);

    expect(result.checkpointed_task_ids).toEqual([taskId]);
    expect(result.continuation_task_ids.length).toBe(1);
    expect(result.depth_capped_task_ids).toEqual([]);
    expect(result.skipped_task_ids).toEqual([]);
    const continuationTaskId = result.continuation_task_ids[0]!;

    // The interrupted task is NOT abandoned / failed.
    const abandoned = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind IN ('task_abandoned','task_failed') AND task_id = ?")
      .get(taskId) as { c: number };
    expect(abandoned.c).toBe(0);

    // A refinement-edge continuation child carries the work.
    const childNode = db
      .query("SELECT task_id, payload FROM events WHERE kind = 'task_node_opened' AND parent_task_id = ?")
      .get(taskId) as { task_id: string; payload: string } | null;
    expect(childNode).not.toBeNull();
    expect(childNode!.task_id).toBe(continuationTaskId);
    const childPayload = JSON.parse(childNode!.payload);
    expect(childPayload.continuation_reason).toBe("restart_drain_checkpoint");
    expect(childPayload.refines_task_id).toBe(taskId);
    expect(childPayload.checkpoint_origin).toBe("graceful_shutdown_drain");

    const edge = db
      .query("SELECT payload FROM events WHERE kind = 'task_edge_recorded' AND task_id = ?")
      .get(continuationTaskId) as { payload: string } | null;
    expect(edge).not.toBeNull();
    const edgePayload = JSON.parse(edge!.payload);
    expect(edgePayload.kind).toBe("refines");
    expect(edgePayload.from_task).toBe(taskId);
    expect(edgePayload.to_task).toBe(continuationTaskId);

    // Parent is superseded so it drops out of readyTasks; the continuation
    // child becomes the ready task the scheduler resumes on next boot.
    const superseded = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'task_committed_superseded' AND task_id = ?")
      .get(taskId) as { c: number };
    expect(superseded.c).toBe(1);
    const ready = readyTasks(db, directiveId).map((t) => t.id);
    expect(ready).not.toContain(taskId);
    expect(ready).toContain(continuationTaskId);
  });

  test("checkpoint is bounded by the refinement-depth cap — an interrupted-every-restart task terminalizes instead of resuming forever", () => {
    const db = openDb(":memory:");
    const { directiveId, taskId } = openInFlightTask(db, "perpetually-interrupted goal");

    // Build a 'refines' lineage that already reached the cap so the next
    // checkpoint must terminalize rather than open another continuation.
    let cur = taskId;
    for (let i = 0; i < REFINEMENT_DEPTH_CAP; i++) {
      const child = newId();
      emitEvent(db, {
        kind: "task_edge_recorded",
        substrate_origin: "substrate_auto",
        directive_id: directiveId,
        task_id: child,
        parent_task_id: cur,
        payload: { from_task: cur, to_task: child, kind: "refines" },
      });
      cur = child;
    }

    const result = checkpointInterruptedDispatches(db, [cur]);
    expect(result.depth_capped_task_ids).toEqual([cur]);
    expect(result.checkpointed_task_ids).toEqual([]);

    const failed = db
      .query("SELECT payload FROM events WHERE kind = 'task_failed' AND task_id = ? AND failure_kind = 'refinement_depth_exceeded'")
      .get(cur) as { payload: string } | null;
    expect(failed).not.toBeNull();
    expect(JSON.parse(failed!.payload).reason).toContain("restart_drain_checkpoint");
  });

  test("emitRefinementContinuation is the shared primitive used by the productive-timeout path", () => {
    const db = openDb(":memory:");
    const { directiveId, taskId } = openInFlightTask(db, "shared primitive goal");
    const outcome = emitRefinementContinuation(db, {
      taskId,
      directiveId,
      goal: "shared primitive goal",
      continuationReason: "productive_timeout_continuation",
      priorDispatchId: "disp-1",
    });
    expect(outcome.outcome).toBe("opened");
    if (outcome.outcome === "opened") {
      expect(outcome.depth).toBe(1);
      const edge = db
        .query("SELECT payload FROM events WHERE kind = 'task_edge_recorded' AND task_id = ?")
        .get(outcome.continuation_task_id) as { payload: string } | null;
      expect(JSON.parse(edge!.payload).continuation_reason).toBe("productive_timeout_continuation");
    }
  });
});
