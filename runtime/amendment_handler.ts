// acc2 amendment handler — processes `directive_amended` events
// (Architecture.md, §4.1).
//
// When the owner says "narrow the goal to X" mid-flight, the substrate
// receives a `directive_amended` event with:
//   - original_directive_id
//   - amendment_text
//   - superseded_predictions: string[]
//   - superseded_tasks: string[]
//   - new_tasks: string[]   (task_ids the brain wants opened)
//   - new_task_goals: string[]   (parallel to new_tasks; goal text)
//   - rationale
//   - amended_by
//
// This handler:
//   1. Marks every superseded prediction's `outcome` to "amended" in the
//      events table (single UPDATE — events stay immutable rows; outcome
//      reflects current scoring posture).
//   2. Emits `task_committed_superseded` for each superseded task so the
//      DAG view excludes them from active topology.
//   3. Emits `task_node_opened` for each new task goal — with parent_task_id
//      pointing at the original directive's root.
//   4. Emits an `amendment_applied` event recording the diff.
//
// Idempotency: applied amendments are tracked via the `meta` table under
// key `amendment_applied_<event_id>` so re-application is a no-op.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { emitEvent, getEventById } from "./events";
import { newId } from "./ids";

export type AmendmentSummary = {
  amendment_event_id: string;
  superseded_tasks_closed: string[];
  superseded_predictions_marked: string[];
  new_tasks_opened: string[];
  already_applied: boolean;
};

const META_KEY_PREFIX = "amendment_applied_";

const wasApplied = (db: Database, amendmentId: string): boolean => {
  const row = db
    .query("SELECT value FROM meta WHERE key = ?")
    .get(`${META_KEY_PREFIX}${amendmentId}`) as { value: string } | null;
  return !!row;
};

const markApplied = (db: Database, amendmentId: string, summary: AmendmentSummary): void => {
  db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [
    `${META_KEY_PREFIX}${amendmentId}`,
    JSON.stringify(summary),
  ]);
};

const markSupersededPredictions = (db: Database, predictionIds: string[]): string[] => {
  const marked: string[] = [];
  for (const id of predictionIds) {
    const row = db
      .query("SELECT id, kind FROM events WHERE id = ?")
      .get(id) as { id: string; kind: string } | null;
    if (!row) continue;
    db.run("UPDATE events SET outcome = ? WHERE id = ?", ["amended", id]);
    marked.push(id);
  }
  return marked;
};

const closeSupersededTasks = (
  db: Database,
  directiveId: string,
  taskIds: string[],
  amendmentEventId: string,
): string[] => {
  const closed: string[] = [];
  for (const taskId of taskIds) {
    // Confirm the task row actually opened — defensive against the brain
    // naming a task that was never registered.
    const opened = db
      .query("SELECT id FROM events WHERE task_id = ? AND kind = 'task_node_opened' LIMIT 1")
      .get(taskId) as { id: string } | null;
    if (!opened) continue;
    emitEvent(db, {
      kind: "task_committed_superseded",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      task_id: taskId,
      outcome: "amended",
      payload: {
        amendment_event_id: amendmentEventId,
        reason: "directive_amendment_superseded",
      } as JsonValue,
    });
    closed.push(taskId);
  }
  return closed;
};

const openNewTasks = (
  db: Database,
  directiveId: string,
  rootTaskId: string,
  goals: string[],
  amendmentEventId: string,
): string[] => {
  const opened: string[] = [];
  for (const goal of goals) {
    if (!goal || typeof goal !== "string") continue;
    const taskId = newId();
    emitEvent(db, {
      kind: "task_node_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: taskId,
      parent_task_id: rootTaskId,
      payload: {
        goal,
        lifecycle: "finite",
        urgency: "normal",
        amendment_event_id: amendmentEventId,
        source: "directive_amended",
      } as JsonValue,
    });
    opened.push(taskId);
  }
  return opened;
};

/** Apply a single `directive_amended` event. Idempotent: a second call with
 *  the same event_id returns `already_applied: true` and emits nothing. */
export const applyAmendment = async (
  db: Database,
  amendmentEventId: string,
): Promise<AmendmentSummary> => {
  if (wasApplied(db, amendmentEventId)) {
    return {
      amendment_event_id: amendmentEventId,
      superseded_tasks_closed: [],
      superseded_predictions_marked: [],
      new_tasks_opened: [],
      already_applied: true,
    };
  }

  const event = getEventById(db, amendmentEventId);
  if (!event) {
    throw new Error(`amendment event not found: ${amendmentEventId}`);
  }
  if (event.kind !== "directive_amended") {
    throw new Error(`event ${amendmentEventId} is not directive_amended (kind=${event.kind})`);
  }

  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const originalDirectiveId =
    (payload.original_directive_id as string | undefined) ?? event.directive_id;
  const supersededTaskIds = (payload.superseded_tasks as string[] | undefined) ?? [];
  const supersededPredictionIds =
    (payload.superseded_predictions as string[] | undefined) ?? [];
  const newTaskGoals = (payload.new_task_goals as string[] | undefined) ?? [];

  const supersededPredictionsMarked = markSupersededPredictions(db, supersededPredictionIds);
  const supersededTasksClosed = closeSupersededTasks(
    db,
    originalDirectiveId,
    supersededTaskIds,
    amendmentEventId,
  );

  // Find the directive's root task. We look for the earliest task_node_opened
  // on this directive whose parent_task_id is null.
  const rootRow = db
    .query(
      "SELECT task_id FROM events WHERE directive_id = ? AND kind = 'task_node_opened' AND (parent_task_id IS NULL OR parent_task_id = '') ORDER BY ts ASC LIMIT 1",
    )
    .get(originalDirectiveId) as { task_id: string } | null;
  const rootTaskId = rootRow?.task_id ?? originalDirectiveId;

  const newTasksOpened = openNewTasks(
    db,
    originalDirectiveId,
    rootTaskId,
    newTaskGoals,
    amendmentEventId,
  );

  emitEvent(db, {
    kind: "directive_milestone_recorded",
    substrate_origin: "substrate_auto",
    directive_id: originalDirectiveId,
    payload: {
      milestone: "amendment_applied",
      amendment_event_id: amendmentEventId,
      superseded_tasks_closed: supersededTasksClosed,
      superseded_predictions_marked: supersededPredictionsMarked,
      new_tasks_opened: newTasksOpened,
    } as JsonValue,
  });

  const summary: AmendmentSummary = {
    amendment_event_id: amendmentEventId,
    superseded_tasks_closed: supersededTasksClosed,
    superseded_predictions_marked: supersededPredictionsMarked,
    new_tasks_opened: newTasksOpened,
    already_applied: false,
  };
  markApplied(db, amendmentEventId, summary);
  return summary;
};

/** Find every directive_amended event not yet marked applied in `meta`.
 *  The amendment worker calls this on its tick to drain the queue. */
export const findUnappliedAmendments = (db: Database): string[] => {
  const rows = db
    .query(
      "SELECT id FROM events WHERE kind = 'directive_amended' ORDER BY ts ASC",
    )
    .all() as Array<{ id: string }>;
  const unapplied: string[] = [];
  for (const r of rows) {
    if (!wasApplied(db, r.id)) unapplied.push(r.id);
  }
  return unapplied;
};

/** Emit a directive_amended event AND immediately apply it. Used by the
 *  `substrate.amend_directive` MCP tool to give chat-time amendments a
 *  round-trip in one call. */
export const emitAndApplyAmendment = async (
  db: Database,
  input: {
    original_directive_id: string;
    amendment_text: string;
    superseded_tasks?: string[];
    superseded_predictions?: string[];
    new_task_goals?: string[];
    rationale?: string;
    amended_by?: "owner" | "claude_root" | "opencode";
  },
): Promise<AmendmentSummary> => {
  const emitted = emitEvent(db, {
    kind: "directive_amended",
    substrate_origin: "owner",
    directive_id: input.original_directive_id,
    payload: {
      original_directive_id: input.original_directive_id,
      amendment_text: input.amendment_text,
      superseded_tasks: input.superseded_tasks ?? [],
      superseded_predictions: input.superseded_predictions ?? [],
      new_task_goals: input.new_task_goals ?? [],
      rationale: input.rationale ?? null,
      amended_by: input.amended_by ?? "owner",
    } as JsonValue,
  });
  return applyAmendment(db, emitted.id);
};
