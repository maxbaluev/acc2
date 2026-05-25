// acc2 dispatch continuation — refinement-edge checkpointing of in-flight
// brain work so a graceful restart RESUMES it instead of abandoning it.
//
// Two callers share ONE continuation primitive (emitRefinementContinuation):
//
//   1. runtime/task_dispatcher.ts — productive-timeout continuation. A brain
//      dispatch that ran the full wall-clock budget while making real
//      progress is re-opened as a refinement child so the scheduler picks a
//      fresh cycle-1 dispatch that continues the remaining work.
//
//   2. runtime/daemon.ts stop() drain — NO-JOB-LOSS-ON-RESTART. When the
//      graceful drain budget expires with brain dispatches still in flight,
//      those tasks would otherwise be SIGTERM-killed and reconciled into
//      dispatch_recovered_orphan (re-picked from scratch — the in-progress
//      brain cycle's proposed amendments are abandoned). Instead, for each
//      interrupted dispatch we emit the SAME refinement-edge continuation, so
//      the next boot's scheduler resumes the work as a continuation child.
//
// Both paths are bounded by the SAME refinement-depth cap: a task whose
// 'refines' lineage already reached REFINEMENT_DEPTH_CAP is NOT re-opened —
// it terminalizes via refinement_depth_exceeded -> task_failed so a
// perpetually-interrupted task cannot resume forever.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { emitEvent } from "./events";
import { newId } from "./ids";
import { refinementDepth } from "./task_topology";
import { recordInternalAct } from "./internal_act_projection";
import { logger } from "./logger";

/** Shared with task_dispatcher.ts — the residual-refinement / productive-
 *  timeout / shutdown-checkpoint chains are ALL bounded by this single cap. */
export const REFINEMENT_DEPTH_CAP = 5;

export type ContinuationOutcome =
  | { outcome: "opened"; continuation_task_id: string; continuation_edge_event_id: string; depth: number }
  | { outcome: "already_open"; continuation_task_id: string; continuation_edge_event_id: string | null; depth: number }
  | { outcome: "depth_capped"; depth: number }
  | { outcome: "skipped"; reason: string };

export type EmitContinuationArgs = {
  taskId: string;
  directiveId: string;
  /** The interrupted task's goal text (resumed verbatim in the child goal). */
  goal: string;
  /** Why the continuation is being opened — stamped on every emitted row so
   *  the audit trail distinguishes a productive-timeout from a restart-drain
   *  checkpoint. */
  continuationReason: string;
  /** The dispatch that was interrupted (for the audit chain). */
  priorDispatchId?: string | null;
  /** Optional extra payload keys merged into the task_node_opened payload. */
  extra?: Record<string, JsonValue>;
  /** Internal-act handle so each continuation credits a posterior. Defaults
   *  to a generic continuation handle when omitted. */
  actionHandle?: string;
};

const findExistingContinuation = (
  db: Database,
  args: EmitContinuationArgs,
): { taskId: string; edgeEventId: string | null } | null => {
  const row = db
    .query(
      `SELECT task_id FROM events
        WHERE kind = 'task_node_opened'
          AND parent_task_id = ?
          AND json_extract(payload, '$.continuation_reason') = ?
          AND COALESCE(json_extract(payload, '$.prior_dispatch_id'), '__NULL__') = COALESCE(?, '__NULL__')
        ORDER BY ts ASC LIMIT 1`,
    )
    .get(args.taskId, args.continuationReason, args.priorDispatchId ?? null) as { task_id: string } | null;
  if (!row) return null;
  const edge = db
    .query(
      `SELECT id FROM events
        WHERE kind = 'task_edge_recorded'
          AND parent_task_id = ?
          AND task_id = ?
          AND json_extract(payload, '$.kind') = 'refines'
        ORDER BY ts ASC LIMIT 1`,
    )
    .get(args.taskId, row.task_id) as { id: string } | null;
  return { taskId: row.task_id, edgeEventId: edge?.id ?? null };
};

/** Emit a refinement-edge continuation for ONE task. Reuses the canonical
 *  productive-timeout continuation shape:
 *    task_node_opened (refines parent) + task_edge_recorded(kind=refines) +
 *    task_committed_superseded (so the parent drops out of readyTasks and the
 *    child carries the work) + a recordInternalAct credit anchor.
 *
 *  Returns "depth_capped" (emits refinement_depth_exceeded + task_failed) when
 *  the lineage already reached REFINEMENT_DEPTH_CAP, "opened" otherwise. Never
 *  throws — emission failure is logged and returned as "skipped" so a drain or
 *  dispatch close path is never blocked by a single bad checkpoint. */
export const emitRefinementContinuation = (
  db: Database,
  args: EmitContinuationArgs,
): ContinuationOutcome => {
  try {
    const existing = findExistingContinuation(db, args);
    if (existing) {
      return {
        outcome: "already_open",
        continuation_task_id: existing.taskId,
        continuation_edge_event_id: existing.edgeEventId,
        depth: refinementDepth(db, existing.taskId),
      };
    }
    const depth = refinementDepth(db, args.taskId);
    if (depth >= REFINEMENT_DEPTH_CAP) {
      emitEvent(db, {
        kind: "refinement_depth_exceeded",
        substrate_origin: "substrate_auto",
        directive_id: args.directiveId,
        task_id: args.taskId,
        payload: {
          depth,
          cap: REFINEMENT_DEPTH_CAP,
          dispatch_id: args.priorDispatchId ?? null,
          reason: `${args.continuationReason}_depth_cap`,
        } as JsonValue,
      });
      emitEvent(db, {
        kind: "task_failed",
        substrate_origin: "substrate_auto",
        directive_id: args.directiveId,
        task_id: args.taskId,
        outcome: "failed",
        failure_kind: "refinement_depth_exceeded",
        payload: {
          dispatch_id: args.priorDispatchId ?? null,
          refinement_depth: depth,
          cap: REFINEMENT_DEPTH_CAP,
          reason: `refinement_depth_exceeded:${args.continuationReason} depth=${depth} cap=${REFINEMENT_DEPTH_CAP}`,
        } as JsonValue,
      });
      return { outcome: "depth_capped", depth };
    }

    const continuationTaskId = newId();
    const continuationGoal =
      `continue (${args.continuationReason}): the prior cycle on goal "${args.goal}" was ` +
      `interrupted before it could close — resume the remaining work from where it left off ` +
      `(continuation depth=${depth + 1}).`;
    emitEvent(db, {
      kind: "task_node_opened",
      substrate_origin: "substrate_auto",
      directive_id: args.directiveId,
      task_id: continuationTaskId,
      parent_task_id: args.taskId,
      payload: {
        goal: continuationGoal,
        lifecycle: "finite",
        urgency: "normal",
        refines_task_id: args.taskId,
        continuation_reason: args.continuationReason,
        prior_dispatch_id: args.priorDispatchId ?? null,
        trajectory_id: `trajectory:${args.directiveId}:${args.taskId}`,
        resource_price: { wall_ms: null, cpu_ms: null, slots: 1 },
        expected_value: { resume_prior_work: true },
        world_model_delta: { strand_state: "checkpointed", terminal_safe: true },
        merge_policy: {
          dedupe_key: ["parent_task_id", "continuation_reason", "prior_dispatch_id"],
          duplicate_action: "reuse_existing_child",
        },
        ...(args.extra ?? {}),
      } as JsonValue,
    });
    const continuationEdge = emitEvent(db, {
      kind: "task_edge_recorded",
      substrate_origin: "substrate_auto",
      directive_id: args.directiveId,
      task_id: continuationTaskId,
      parent_task_id: args.taskId,
      payload: {
        from_task: args.taskId,
        to_task: continuationTaskId,
        kind: "refines",
        continuation_reason: args.continuationReason,
      } as JsonValue,
    });
    // Mark the interrupted parent terminal-by-supersession so it drops out of
    // readyTasks (the continuation child now carries the work) — the SAME
    // pattern the scheduler uses for closure-refinement children. Without it,
    // BOTH parent and child would be ready and the parent would re-dispatch
    // its own (lost) work in parallel.
    emitEvent(db, {
      kind: "task_committed_superseded",
      substrate_origin: "substrate_auto",
      directive_id: args.directiveId,
      task_id: args.taskId,
      context_refs: [continuationEdge.id],
      payload: {
        dispatch_id: args.priorDispatchId ?? null,
        reason: args.continuationReason,
        superseded_by_task_id: continuationTaskId,
        continuation_edge_event_id: continuationEdge.id,
      } as JsonValue,
    });
    try {
      recordInternalAct(db, {
        intent: `open ${args.continuationReason} continuation edge`,
        actionHandle: args.actionHandle ?? "dispatch_continuation_v1",
        verifierHandle: "continuation_closure_after_resume",
        verifierKind: "deterministic_code",
        predictedResidual: 0.3,
        reasoningSummary: `dispatch interrupted (${args.continuationReason}); resuming via refinement edge at depth ${depth + 1}`,
        actionSummary: `task_edge_recorded refines (continuation) -> ${continuationTaskId}`,
        effectSummary: `scheduler now has a continuation task to resume the interrupted work`,
        directiveId: args.directiveId,
        taskId: continuationTaskId,
        sourceEventId: continuationEdge.id,
        sourceActId: `${args.actionHandle ?? "dispatch_continuation_v1"}:${args.taskId}:${depth + 1}`,
        extra: {
          from_task: args.taskId,
          to_task: continuationTaskId,
          continuation_depth: depth + 1,
          prior_dispatch_id: args.priorDispatchId ?? null,
          continuation_reason: args.continuationReason,
        },
      });
    } catch (err) {
      // Credit anchoring is best-effort; the edge itself is the load-bearing
      // resumption signal.
      logger.debug(
        { where: "dispatch_continuation.record_act", err: (err as Error).message },
        "recordInternalAct failed for continuation edge (non-fatal)",
      );
    }
    return {
      outcome: "opened",
      continuation_task_id: continuationTaskId,
      continuation_edge_event_id: continuationEdge.id,
      depth: depth + 1,
    };
  } catch (err) {
    logger.warn(
      { where: "dispatch_continuation.emit", task_id: args.taskId, err: (err as Error).message },
      "could not emit refinement continuation — task will fall back to boot orphan recovery",
    );
    return { outcome: "skipped", reason: (err as Error).message };
  }
};

/** Resolve a task's goal + directive_id from the ledger. Reads the task's
 *  task_node_opened row (the canonical goal source). Returns null when the
 *  task has no opened row (should not happen for an in-flight dispatch). */
const resolveTaskContext = (
  db: Database,
  taskId: string,
): { directiveId: string; goal: string } | null => {
  const row = db
    .query(
      `SELECT directive_id, payload FROM events
        WHERE task_id = ? AND kind = 'task_node_opened'
        ORDER BY ts ASC LIMIT 1`,
    )
    .get(taskId) as { directive_id: string; payload: string } | null;
  if (!row) {
    // Fall back to ANY event carrying the directive_id so we can still open a
    // continuation under the right directive even if the opened row is missing.
    const anyRow = db
      .query(`SELECT directive_id FROM events WHERE task_id = ? ORDER BY ts ASC LIMIT 1`)
      .get(taskId) as { directive_id: string } | null;
    if (!anyRow) return null;
    return { directiveId: anyRow.directive_id, goal: taskId };
  }
  let goal = taskId;
  try {
    const payload = JSON.parse(row.payload ?? "{}") as Record<string, unknown>;
    if (typeof payload.goal === "string" && payload.goal.length > 0) goal = payload.goal;
  } catch { /* keep taskId fallback */ }
  return { directiveId: row.directive_id, goal };
};

export type CheckpointResult = {
  checkpointed_task_ids: string[];
  continuation_task_ids: string[];
  depth_capped_task_ids: string[];
  skipped_task_ids: string[];
};

/** Graceful-shutdown checkpoint (NO JOB LOSS ON RESTART). For each in-flight
 *  brain dispatch that did NOT finish within the drain budget, emit a
 *  refinement-edge continuation so the next boot's scheduler resumes the work
 *  instead of letting boot orphan recovery abandon it. Bounded by the
 *  refinement-depth cap (a task whose lineage hit the cap terminalizes rather
 *  than resuming forever). Never throws. */
export const checkpointInterruptedDispatches = (
  db: Database,
  interruptedTaskIds: readonly string[],
): CheckpointResult => {
  const result: CheckpointResult = {
    checkpointed_task_ids: [],
    continuation_task_ids: [],
    depth_capped_task_ids: [],
    skipped_task_ids: [],
  };
  for (const taskId of interruptedTaskIds) {
    const ctx = resolveTaskContext(db, taskId);
    if (!ctx) {
      result.skipped_task_ids.push(taskId);
      continue;
    }
    const outcome = emitRefinementContinuation(db, {
      taskId,
      directiveId: ctx.directiveId,
      goal: ctx.goal,
      continuationReason: "restart_drain_checkpoint",
      actionHandle: "restart_drain_checkpoint_v1",
      extra: { checkpoint_origin: "graceful_shutdown_drain" as JsonValue },
    });
    if (outcome.outcome === "opened") {
      result.checkpointed_task_ids.push(taskId);
      result.continuation_task_ids.push(outcome.continuation_task_id);
    } else if (outcome.outcome === "already_open") {
      result.checkpointed_task_ids.push(taskId);
      result.continuation_task_ids.push(outcome.continuation_task_id);
    } else if (outcome.outcome === "depth_capped") {
      result.depth_capped_task_ids.push(taskId);
    } else {
      result.skipped_task_ids.push(taskId);
    }
  }
  return result;
};
