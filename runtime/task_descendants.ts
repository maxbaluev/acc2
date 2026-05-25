// acc2 task descendants — the single, shared definition of a task's
// DECOMPOSITION descendants for closure / root-commit gating.
//
// Why this module exists: the descendant walk was previously inlined in BOTH
// runtime/events.ts (the root-commit block) and runtime/directive_closure.ts
// (the closure audit) "to avoid an import cycle" — and the two copies DRIFTED
// (a fix had to be applied to both). This pure module (it imports only the
// Database type, nothing from events/directive_closure) is the cycle-free home
// they both import, so the definition can never diverge again.
//
// Decomposition only (parent_task_id chain). `requires` is a downstream
// dependency — blocking a task's commit on a `requires` dependent DEADLOCKS
// (the dependent cannot start until the task commits, but the task cannot
// commit until the dependent is terminal). `refines` is a checkpoint
// continuation — blocking on it forbids the commit-cycle-then-continue
// pattern. Neither is a decomposition descendant, so neither gates commit.

import type { Database } from "bun:sqlite";

/** Transitive decomposition descendants of `rootTaskId` (task_node_opened rows
 *  whose parent_task_id chains up to it). Excludes the root itself. Pure. */
export const decompositionDescendantTaskIds = (db: Database, rootTaskId: string): string[] => {
  const out = new Set<string>();
  const queue: string[] = [rootTaskId];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const children = db
      .query("SELECT task_id AS child_id FROM events WHERE kind = 'task_node_opened' AND parent_task_id = ?")
      .all(cur) as Array<{ child_id: string | null }>;
    for (const child of children) {
      if (!child.child_id || child.child_id === rootTaskId || out.has(child.child_id)) continue;
      out.add(child.child_id);
      queue.push(child.child_id);
    }
  }
  return [...out];
};

// ── Coverage frontier (amendment frontier_drainer_hard_gate) ─────────────────
//
// PROBLEM observed (directive EEZR4XQS): a root with open decomposition
// descendants had its commit refused (dispatcher_violation root_commit_blocked),
// but nothing DROVE those descendants to terminal. The root just re-emitted
// task_committed and looped on the refusal until the directive died — passive
// parking, no owned drain.
//
// FIX: a persistent, event-sourced "coverage frontier" keyed by root_task_id —
// the set of DECOMPOSITION descendants that are NOT yet terminal (status
// open|ready|in_progress). It is NOT mutable stored state: it is recomputed from
// the events table every call, so the same ledger always yields the same
// frontier (idempotent). A root is terminal-eligible only when this frontier is
// empty. The scheduler uses it to PREFER ready frontier descendants over
// re-admitting the parked root (drain instead of loop), and surfaces
// `wait_on_frontier` while count > 0.

/** A task is "terminal" for frontier purposes when it has any one of these
 *  terminal/superseded events. Mirrors the descendant-terminal scan in
 *  events.ts (rootTaskCommitBlocker) and directive_closure.ts so all three
 *  agree on what "the frontier is drained" means. */
const FRONTIER_TERMINAL_KINDS = ["task_committed", "task_failed", "task_abandoned", "task_committed_superseded"] as const;

export type OpenFrontier = {
  /** Root the frontier is computed for. */
  root_task_id: string;
  /** Decomposition descendant ids with NO terminal event yet (open|ready|in_progress). */
  open_descendant_task_ids: string[];
  /** Count of open descendants. A root is terminal-eligible iff this is 0. */
  open_count: number;
  /** Total decomposition descendants (terminal + open). */
  total_descendant_count: number;
};

/** Event-sourced coverage frontier of a root: the DECOMPOSITION descendants
 *  (parent_task_id chain, via decompositionDescendantTaskIds — the same narrow
 *  set that gates root commit) that have not reached a terminal event. Pure and
 *  idempotent: recomputed from the ledger, never stored. `open_count === 0`
 *  means every descendant is terminal and the root may commit.
 *
 *  Decomposition-only on purpose: `requires`/`refines` are excluded for the
 *  identical deadlock/checkpoint reasons documented at the top of this module
 *  and enforced by the commit gate — the drain frontier and the commit gate
 *  MUST cover exactly the same descendant set, or the scheduler would drain a
 *  set the gate doesn't check (or vice versa). */
export const openFrontier = (db: Database, rootTaskId: string): OpenFrontier => {
  const descendants = decompositionDescendantTaskIds(db, rootTaskId);
  const open: string[] = [];
  for (const taskId of descendants) {
    const placeholders = FRONTIER_TERMINAL_KINDS.map(() => "?").join(", ");
    const terminal = db
      .query(`SELECT 1 FROM events WHERE task_id = ? AND kind IN (${placeholders}) LIMIT 1`)
      .get(taskId, ...FRONTIER_TERMINAL_KINDS) as { 1: number } | null;
    if (!terminal) open.push(taskId);
  }
  return {
    root_task_id: rootTaskId,
    open_descendant_task_ids: open,
    open_count: open.length,
    total_descendant_count: descendants.length,
  };
};

// ── Ancestor-progress crediting (amendment ancestor_progress_crediting) ──────
//
// The no-progress / stuck-lifecycle sweeps previously scored ONLY a task's OWN
// events. A deep, healthy graph could be killed for "no progress" while its
// children were actively committing deliverables: descendant/grandchild
// progress did NOT refresh ancestor progress (observed: directive VCGTS7AE root
// abandoned while Phase C children were still open and other children had just
// committed).
//
// The fix is a HARD GATE: a descendant emitting ANY structural-progress event
// counts as progress for EVERY ancestor in its decomposition chain. The
// progress subtree is deliberately BROADER than `decompositionDescendantTaskIds`
// — it follows BOTH the `parent_task_id` chain AND `refines` / `requires` edges
// recorded in `task_edge_recorded`. (Commit-gating stays narrow / decomposition-
// only to avoid the deadlock + commit-cycle hazards documented above; that is a
// different question — "may this root commit?" — from "is this subtree alive?".)

/** The structural-progress event kinds that, when emitted by ANY descendant,
 *  refresh ancestor progress. Mirrors task_scheduler's STRUCTURAL_PROGRESS_KINDS
 *  plus the open/refine kinds that prove the subtree is decomposing — kept here
 *  (the cycle-free module) so the scheduler and the lifecycle sweep share one
 *  definition that cannot drift. */
export const ANCESTOR_PROGRESS_KINDS: ReadonlySet<string> = new Set([
  "task_node_opened",
  "task_edge_recorded",
  "action_predicted",
  "action_scored",
  "knowledge_candidate",
  "act_artifact_candidate",
  "contract_amendment_proposed",
  "lesson_extracted",
  "task_closure_audited",
  "task_committed",
  "task_failed",
  "task_abandoned",
]);

/** Transitive PROGRESS-subtree of `rootTaskId`: every task reachable from the
 *  root via the `parent_task_id` chain OR via `refines` / `requires` edges in
 *  task_edge_recorded. Excludes the root itself. Used only for ancestor-progress
 *  crediting (NOT for commit gating). Pure. */
export const progressSubtreeTaskIds = (db: Database, rootTaskId: string): string[] => {
  const out = new Set<string>();
  const seen = new Set<string>();
  const queue: string[] = [rootTaskId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const decompChildren = db
      .query("SELECT task_id AS child_id FROM events WHERE kind = 'task_node_opened' AND parent_task_id = ?")
      .all(cur) as Array<{ child_id: string | null }>;
    const edgeChildren = db
      .query(
        `SELECT json_extract(payload, '$.to_task') AS child_id FROM events
          WHERE kind = 'task_edge_recorded'
            AND json_extract(payload, '$.from_task') = ?
            AND json_extract(payload, '$.kind') IN ('refines', 'requires')`,
      )
      .all(cur) as Array<{ child_id: string | null }>;
    for (const child of [...decompChildren, ...edgeChildren]) {
      if (!child.child_id || child.child_id === rootTaskId || seen.has(child.child_id)) continue;
      out.add(child.child_id);
      queue.push(child.child_id);
    }
  }
  return [...out];
};

/** The maximum timestamp (epoch ms) of any structural-progress event emitted by
 *  a task in `rootTaskId`'s progress subtree — DESCENDANTS ONLY (the root's own
 *  events are excluded; the caller already scores the root's own progress).
 *  Returns null when no descendant has ever emitted structural progress.
 *
 *  Event-sourced and idempotent: recomputed purely from the events table, so
 *  the same ledger always yields the same answer. */
export const latestDescendantProgressTs = (db: Database, rootTaskId: string): number | null => {
  const taskIds = progressSubtreeTaskIds(db, rootTaskId);
  if (taskIds.length === 0) return null;
  const placeholders = taskIds.map(() => "?").join(", ");
  const kinds = [...ANCESTOR_PROGRESS_KINDS];
  const kindPlaceholders = kinds.map(() => "?").join(", ");
  const row = db
    .query(
      `SELECT MAX(ts) AS max_ts FROM events
        WHERE task_id IN (${placeholders})
          AND kind IN (${kindPlaceholders})`,
    )
    .get(...taskIds, ...kinds) as { max_ts: string | null } | null;
  if (!row?.max_ts) return null;
  const ms = new Date(row.max_ts).getTime();
  return Number.isFinite(ms) ? ms : null;
};

/** Hard gate: did any DESCENDANT in `rootTaskId`'s progress subtree emit a
 *  structural-progress event STRICTLY AFTER `sinceMs`? When true, the ancestor
 *  is alive through its descendants and must NOT be marked no_structural_progress
 *  / stuck. Uses a strict `>` to match the scheduler's `ts > lastDispatch.ts`
 *  window (events sharing the dispatch's millisecond are pre-dispatch noise). */
export const subtreeHasRecentProgress = (
  db: Database,
  rootTaskId: string,
  sinceMs: number,
): boolean => {
  const latest = latestDescendantProgressTs(db, rootTaskId);
  return latest !== null && latest > sinceMs;
};
