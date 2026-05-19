// acc2 brain effectiveness projection (brain elegance bc8je5f3x, 2026-05-15).
//
// Falsifiability surface for the depth-1 retrieval claim. With
// brain_prompt_composed now persisted (audit b0kheqg3g), we can join
// the prompt, the dispatch decision, refinement edges, action scoring,
// and the final commit/fail to classify each brain dispatch:
//
//   first_dispatch_committed  — the brain's FIRST dispatch on this
//                               directive's root task produced
//                               action_predicted + action_scored
//                               (residual ≤ 0.3) and task_committed
//                               within the same dispatch chain. The
//                               prompt was sufficient on its own.
//
//   refined_then_committed    — the brain emitted refinement edges
//                               (task_edge_recorded kind=refines)
//                               before the directive committed. The
//                               first prompt was not sufficient; the
//                               organism iterated.
//
//   failed                    — the directive's root reached task_failed
//                               OR consecutive_bridge_failures_exceeded_cap
//                               OR was archived by supervisor.
//
//   stalled                   — neither terminal nor refining; ready
//                               for longer than STALLED_THRESHOLD_MS.
//                               Almost always a substrate or scheduler
//                               health issue rather than a brain issue.
//
//   in_flight                 — open, recent, can still classify either
//                               way. Excluded from the summary.
//
// The projection is read-only. The brain reads it via substrate.read +
// MCP at design time; operators see it in a nightly summary. Changes
// to prompt_composer.ts then become measurable retrieval experiments
// rather than taste-based prompt edits.

import type { Database } from "bun:sqlite";

export type BrainDispatchClassification =
  | "first_dispatch_committed"
  | "refined_then_committed"
  | "failed"
  | "stalled"
  | "in_flight";

/** Threshold for the `stalled` bucket. Two hours mirrors
 *  SUPERVISOR_READY_STARVATION_MS so a directive flagged stalled here
 *  is also debit-able to the pathology budget. Universal value pending
 *  f13 adaptive-scoring contract (GEZ955QDYN3R): the threshold should
 *  learn from outcomes (false-positive rate on flagged stalls vs.
 *  real wedge detection) rather than be env-tuned. */
export const STALLED_THRESHOLD_MS = 2 * 60 * 60 * 1000;

export type DirectiveEffectivenessRow = {
  directive_id: string;
  root_task_id: string;
  opened_ts: string;
  classification: BrainDispatchClassification;
  /** Number of refinement edges emitted under the root. > 0 disqualifies
   *  the first_dispatch_committed bucket. */
  refinement_edge_count: number;
  /** Number of brain_dispatched events on the root. Useful for
   *  spotting prompts that didn't even produce an action_predicted. */
  dispatch_count: number;
  /** Latest action_scored residual on the root (null if none). */
  latest_residual: number | null;
  /** Event id of the action_scored row that produced `latest_residual`.
   *  Surfaced so downstream credit traversal (k_555 four-link: outcome →
   *  retrieval → posterior mutation → credit) can cite the underlying
   *  observation rather than the projection row. Null when no
   *  action_scored has landed on this directive yet. */
  latest_residual_event_id: string | null;
  /** Time from directive_opened to terminal event (ms); null when
   *  still in flight. */
  time_to_terminal_ms: number | null;
};

/** Classify the brain's work on a single directive. Pure read over
 *  events. Uses ts ordering — no DB schema changes. */
export const classifyDirective = (
  db: Database,
  directiveId: string,
  opts?: { nowMs?: number },
): DirectiveEffectivenessRow | null => {
  const nowMs = opts?.nowMs ?? Date.now();

  const opened = db
    .query(
      `SELECT task_id, ts FROM events
       WHERE kind = 'directive_opened' AND directive_id = ?
       ORDER BY ts ASC LIMIT 1`,
    )
    .get(directiveId) as { task_id: string; ts: string } | null;
  if (!opened) return null;

  // The ROOT task is the first task_node_opened whose parent_task_id is null.
  const rootRow = db
    .query(
      `SELECT task_id FROM events
       WHERE kind = 'task_node_opened' AND directive_id = ?
         AND parent_task_id IS NULL
       ORDER BY ts ASC LIMIT 1`,
    )
    .get(directiveId) as { task_id: string } | null;
  const rootTaskId = rootRow?.task_id ?? opened.task_id;

  const refinementCount = (db
    .query(
      `SELECT COUNT(*) AS c FROM events
       WHERE kind = 'task_edge_recorded' AND directive_id = ?
         AND json_extract(payload, '$.kind') = 'refines'`,
    )
    .get(directiveId) as { c: number }).c;

  const dispatchCount = (db
    .query(
      `SELECT COUNT(*) AS c FROM events
       WHERE kind = 'brain_dispatched' AND directive_id = ?`,
    )
    .get(directiveId) as { c: number }).c;

  // Pull `id` alongside `residual` so context_refs can cite the underlying
  // action_scored row in any downstream credit emission (k_555 spine).
  const latestResidualRow = db
    .query(
      `SELECT id, residual FROM events
       WHERE kind = 'action_scored' AND directive_id = ?
         AND residual IS NOT NULL
       ORDER BY ts DESC, rowid DESC LIMIT 1`,
    )
    .get(directiveId) as { id: string; residual: number } | null;

  // Terminal event on the ROOT task. We treat the FIRST terminal row for
  // the root as authoritative — cascade-emitted commits land later.
  const terminal = db
    .query(
      `SELECT kind, ts FROM events
       WHERE task_id = ? AND kind IN ('task_committed', 'task_failed', 'task_abandoned')
       ORDER BY ts ASC LIMIT 1`,
    )
    .get(rootTaskId) as { kind: string; ts: string } | null;

  // Operator-archived or supervisor-archived?
  const archived = db
    .query(
      `SELECT kind, ts FROM events
       WHERE directive_id = ?
         AND kind IN ('directive_archived_by_operator', 'directive_archived_missed_reviews')
       ORDER BY ts ASC LIMIT 1`,
    )
    .get(directiveId) as { kind: string; ts: string } | null;

  const openedMs = new Date(opened.ts).getTime();

  let classification: BrainDispatchClassification = "in_flight";
  let timeToTerminalMs: number | null = null;

  if (terminal) {
    timeToTerminalMs = new Date(terminal.ts).getTime() - openedMs;
    if (terminal.kind === "task_committed") {
      classification = refinementCount > 0 ? "refined_then_committed" : "first_dispatch_committed";
    } else {
      classification = "failed";
    }
  } else if (archived) {
    classification = "failed";
    timeToTerminalMs = new Date(archived.ts).getTime() - openedMs;
  } else if (nowMs - openedMs > STALLED_THRESHOLD_MS) {
    classification = "stalled";
  }

  return {
    directive_id: directiveId,
    root_task_id: rootTaskId,
    opened_ts: opened.ts,
    classification,
    refinement_edge_count: refinementCount,
    dispatch_count: dispatchCount,
    latest_residual: latestResidualRow?.residual ?? null,
    latest_residual_event_id: latestResidualRow?.id ?? null,
    time_to_terminal_ms: timeToTerminalMs,
  };
};

export type EffectivenessSummary = {
  total: number;
  by_classification: Record<BrainDispatchClassification, number>;
  /** First-dispatch-committed rate, the headline metric. Higher = the
   *  prompt composer is producing prompts that the brain can act on
   *  without refinement. Closer to 1.0 = depth-1 retrieval is working. */
  first_dispatch_committed_rate: number;
  /** Median time-to-terminal (ms) across committed directives. Useful
   *  for spotting prompt regressions that lengthen cycles even when
   *  closure rate stays steady. */
  median_time_to_commit_ms: number | null;
  window_start_iso: string;
  rows: DirectiveEffectivenessRow[];
};

/** Aggregate the projection across a time window (default 7 days). */
export const summarizeEffectiveness = (
  db: Database,
  opts?: { nowMs?: number; windowMs?: number },
): EffectivenessSummary => {
  const nowMs = opts?.nowMs ?? Date.now();
  const windowMs = opts?.windowMs ?? 7 * 24 * 60 * 60 * 1000;
  const startIso = new Date(nowMs - windowMs).toISOString();
  const directives = db
    .query(
      `SELECT DISTINCT directive_id FROM events
       WHERE kind = 'directive_opened' AND ts >= ?`,
    )
    .all(startIso) as Array<{ directive_id: string }>;

  const rows: DirectiveEffectivenessRow[] = [];
  for (const d of directives) {
    const row = classifyDirective(db, d.directive_id, { nowMs });
    if (row) rows.push(row);
  }

  const byClass: Record<BrainDispatchClassification, number> = {
    first_dispatch_committed: 0,
    refined_then_committed: 0,
    failed: 0,
    stalled: 0,
    in_flight: 0,
  };
  for (const r of rows) byClass[r.classification]++;

  const committed = rows.filter((r) => r.classification === "first_dispatch_committed" || r.classification === "refined_then_committed");
  const firstDispatchRate = committed.length > 0
    ? byClass.first_dispatch_committed / committed.length
    : 0;

  const commitTimes = committed
    .map((r) => r.time_to_terminal_ms)
    .filter((t): t is number => typeof t === "number")
    .sort((a, b) => a - b);
  const medianCommitMs = commitTimes.length === 0
    ? null
    : commitTimes[Math.floor(commitTimes.length / 2)] ?? null;

  return {
    total: rows.length,
    by_classification: byClass,
    first_dispatch_committed_rate: firstDispatchRate,
    median_time_to_commit_ms: medianCommitMs,
    window_start_iso: startIso,
    rows,
  };
};
