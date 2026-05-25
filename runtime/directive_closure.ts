// acc2 directive-closure helper — emits `directive_closed` once every
// task under a finite directive has reached a terminal state, and exposes
// the set of closed/archived directive ids for read-side filtering.
//
// This is the "system should never stuck and never repeat work" Batch 2
// foundational fix: pre-fix the scheduler kept re-dispatching tasks for
// directives whose work was already done (the zombie pattern). Closing
// the directive removes the entire DAG from `readyTasks()` and
// `ready_tasks_view` so nothing further fires against it.
//
// Two surfaces:
//   - closedDirectiveIds(db): Set of every directive id that has any
//     directive_closed / directive_archived_by_operator /
//     directive_archived_missed_reviews row. readyTasks() consults this.
//   - maybeCloseFinishedDirective(db, directiveId): idempotent — emits
//     `directive_closed` once if every task_node_opened under the
//     directive has a terminal task event AND the directive is finite
//     AND no closure/archive event already exists. Called inline from the
//     dispatcher after task_committed/task_failed lands.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { emitEvent } from "./events";
import { decompositionDescendantTaskIds, openFrontier } from "./task_descendants";

type DirectivePayload = { lifecycle?: { kind?: string } | string; urgency?: string };

const readDirectiveLifecycle = (db: Database, directiveId: string): "finite" | "rolling_active" | "unknown" => {
  const row = db
    .query(
      `SELECT payload FROM events
       WHERE kind IN ('directive_opened', 'directive_amended') AND directive_id = ?
       ORDER BY ts DESC, rowid DESC LIMIT 1`,
    )
    .get(directiveId) as { payload: string } | null;
  if (!row) return "unknown";
  try {
    const p = JSON.parse(row.payload ?? "{}") as DirectivePayload;
    const raw = p.lifecycle;
    const value = typeof raw === "string" ? raw : raw?.kind;
    if (value === "rolling_active") return "rolling_active";
    if (value === "finite") return "finite";
  } catch { /* malformed payload — treat as unknown */ }
  return "unknown";
};

/** Read every directive id whose work is over — directive_closed (emitted by
 *  the substrate when all tasks are terminal), directive_archived_by_operator
 *  (owner-initiated), or directive_archived_missed_reviews (rolling
 *  housekeeping). Used by the scheduler / readyTasks() to skip the whole
 *  DAG. Directives whose LATEST archive/close event was followed by a
 *  `directive_resumed` are considered live again — operators can recover
 *  supervisor-quarantined directives (owner directive 2026-05-15: "system
 *  never should loose tasks if task explosion"). */
export const closedDirectiveIds = (db: Database): Set<string> => {
  const rows = db
    .query(
      `SELECT directive_id, kind, ts FROM events
       WHERE kind IN ('directive_closed', 'directive_archived_by_operator', 'directive_archived_missed_reviews', 'directive_resumed')
       ORDER BY ts ASC, rowid ASC`,
    )
    .all() as Array<{ directive_id: string; kind: string; ts: string }>;
  const latest = new Map<string, string>();
  for (const r of rows) {
    if (!r.directive_id) continue;
    latest.set(r.directive_id, r.kind);
  }
  const out = new Set<string>();
  for (const [id, kind] of latest) {
    if (kind === "directive_resumed") continue;
    out.add(id);
  }
  return out;
};

/** Check whether a directive is fully done. Returns the reason string when
 *  it can be closed, or null when at least one task is still live. Internal
 *  to maybeCloseFinishedDirective — exported for tests. */
export const directiveCloseReason = (db: Database, directiveId: string): string | null => {
  const lifecycle = readDirectiveLifecycle(db, directiveId);
  if (lifecycle !== "finite") return null;

  // Every task_node_opened must have at least one terminal event. We count
  // distinct task ids that have a terminal event vs the total opened set —
  // mismatch ⇒ at least one task is still live.
  const opened = db
    .query(
      `SELECT DISTINCT task_id FROM events
       WHERE kind = 'task_node_opened' AND directive_id = ?`,
    )
    .all(directiveId) as Array<{ task_id: string }>;
  if (opened.length === 0) return null;

  const terminal = db
    .query(
      `SELECT DISTINCT task_id FROM events
       WHERE kind IN ('task_committed', 'task_failed', 'task_abandoned') AND directive_id = ?`,
    )
    .all(directiveId) as Array<{ task_id: string }>;
  const terminalIds = new Set(terminal.map((r) => r.task_id));
  for (const r of opened) {
    if (!terminalIds.has(r.task_id)) return null;
  }
  return "all_tasks_terminal";
};

export type RootCommitReadiness =
  | { ok: true; closure_audit_event_id: string | null; closure_residual: number | null; nonterminal_descendant_task_ids: string[]; open_frontier_count: number }
  | { ok: false; reason: "not_root" | "missing_clean_closure_audit" | "nonterminal_descendants"; status_reason?: "wait_on_frontier"; closure_audit_event_id: string | null; closure_residual: number | null; nonterminal_descendant_task_ids: string[]; open_frontier_count: number };

// Decomposition descendants for closure-gating. The single definition lives in
// runtime/task_descendants.ts (shared cycle-free with the events.ts root-commit
// block, so the two can never drift again). Re-exported here under the
// historical name for existing callers.
export const descendantTaskIds = decompositionDescendantTaskIds;

export const rootCommitReadiness = (db: Database, rootTaskId: string): RootCommitReadiness => {
  const rootRow = db.query(`SELECT 1 FROM events WHERE kind = 'task_node_opened' AND task_id = ? AND parent_task_id IS NULL LIMIT 1`).get(rootTaskId) as { 1: number } | null;
  if (!rootRow) return { ok: false, reason: "not_root", closure_audit_event_id: null, closure_residual: null, nonterminal_descendant_task_ids: [], open_frontier_count: 0 };
  const audit = db.query(`SELECT id, residual, payload FROM events WHERE kind = 'task_closure_audited' AND task_id = ? ORDER BY ts DESC, rowid DESC LIMIT 1`).get(rootTaskId) as { id: string; residual: number | null; payload: string } | null;
  let closureResidual: number | null = null;
  if (audit) {
    try { const p = JSON.parse(audit.payload ?? '{}') as { closure_residual?: unknown }; closureResidual = typeof p.closure_residual === 'number' && Number.isFinite(p.closure_residual) ? p.closure_residual : typeof audit.residual === 'number' && Number.isFinite(audit.residual) ? audit.residual : null; }
    catch { closureResidual = typeof audit.residual === 'number' && Number.isFinite(audit.residual) ? audit.residual : null; }
  }
  // Coverage frontier: the single source of truth for "are all descendants
  // terminal?". A root is terminal-eligible only when open_count === 0 — the
  // scheduler DRAINS the frontier (schedules ready descendants) rather than
  // re-attempting the doomed commit (amendment frontier_drainer_hard_gate).
  const frontier = openFrontier(db, rootTaskId);
  if (closureResidual === null || closureResidual >= 0.3) return { ok: false, reason: "missing_clean_closure_audit", closure_audit_event_id: audit?.id ?? null, closure_residual: closureResidual, nonterminal_descendant_task_ids: [], open_frontier_count: frontier.open_count };
  if (frontier.open_count > 0) return { ok: false, reason: "nonterminal_descendants", status_reason: "wait_on_frontier", closure_audit_event_id: audit?.id ?? null, closure_residual: closureResidual, nonterminal_descendant_task_ids: frontier.open_descendant_task_ids, open_frontier_count: frontier.open_count };
  return { ok: true, closure_audit_event_id: audit?.id ?? null, closure_residual: closureResidual, nonterminal_descendant_task_ids: [], open_frontier_count: 0 };
};

/** Upward cascade: when EVERY refines-child of a task has a terminal
 *  event, auto-commit the task. This never fabricates child success; it only
 *  seals an ancestor after all of its existing children are terminal.
 *
 *  The "older test-speedup" case observed 2026-05-15: the brain emitted
 *  `task_committed` on the MEASURE child after running the timing verifier,
 *  but never sealed the ROOT. Without an upward cascade, the root sat in
 *  `ready_tasks_view` forever, kept getting re-dispatched, and burned
 *  bridge_failed:timeout retries on work that was already done downstream.
 *
 *  Algorithm: from the given task, walk UP the refines edges (to_task →
 *  from_task) to find its parent. If every refines-child of that parent
 *  has a terminal event, emit `task_committed` for the parent with
 *  `reason="cascaded_upward_from_all_children_terminal"`. Recurse upward
 *  until a node with non-terminal siblings, a node already terminal,
 *  or the root (no parent) is reached.
 *
 *  Returns the count of cascaded parent commits. */
export const cascadeUpwardWhenChildrenTerminal = (
  db: Database,
  startingTaskId: string,
): number => {
  let cascaded = 0;
  let cursor = startingTaskId;
  // Bounded loop so a corrupted edge graph can't spin forever.
  for (let depth = 0; depth < 64; depth++) {
    // The cursor itself must be terminal — only then does the parent see
    // "all children terminal" reach the threshold.
    const ownTerminal = db
      .query(
        `SELECT 1 FROM events
         WHERE task_id = ?
           AND kind IN ('task_committed', 'task_failed', 'task_abandoned')
         LIMIT 1`,
      )
      .get(cursor) as { 1: number } | null;
    if (!ownTerminal) break;

    // Find PARENT via reverse refines edge.
    const parentRow = db
      .query(
        `SELECT json_extract(payload, '$.from_task') AS from_task
         FROM events
         WHERE kind = 'task_edge_recorded'
           AND json_extract(payload, '$.kind') = 'refines'
           AND json_extract(payload, '$.to_task') = ?
         LIMIT 1`,
      )
      .get(cursor) as { from_task: string | null } | null;
    if (!parentRow || !parentRow.from_task) break;
    const parentId = parentRow.from_task;

    // Parent already terminal — nothing to cascade.
    const parentTerminal = db
      .query(
        `SELECT 1 FROM events
         WHERE task_id = ?
           AND kind IN ('task_committed', 'task_failed', 'task_abandoned')
         LIMIT 1`,
      )
      .get(parentId) as { 1: number } | null;
    if (parentTerminal) break;

    // Check every refines-child of parent is terminal.
    const siblings = db
      .query(
        `SELECT DISTINCT json_extract(payload, '$.to_task') AS to_task
         FROM events
         WHERE kind = 'task_edge_recorded'
           AND json_extract(payload, '$.kind') = 'refines'
           AND json_extract(payload, '$.from_task') = ?`,
      )
      .all(parentId) as Array<{ to_task: string | null }>;
    let allTerminal = true;
    for (const sib of siblings) {
      if (!sib.to_task) continue;
      const t = db
        .query(
          `SELECT 1 FROM events
           WHERE task_id = ?
             AND kind IN ('task_committed', 'task_failed', 'task_abandoned')
           LIMIT 1`,
        )
        .get(sib.to_task) as { 1: number } | null;
      if (!t) { allTerminal = false; break; }
    }
    if (!allTerminal) break;

    // Resolve parent's directive_id, falling back to walking the cursor's
    // task_node_opened in case the parent only appears in edges.
    const parentOpened = db
      .query(
        `SELECT directive_id FROM events
         WHERE kind = 'task_node_opened' AND task_id = ?
         ORDER BY ts ASC, rowid ASC LIMIT 1`,
      )
      .get(parentId) as { directive_id: string } | null;
    let directiveId = parentOpened?.directive_id;
    if (!directiveId) {
      const cursorOpened = db
        .query(
          `SELECT directive_id FROM events
           WHERE kind = 'task_node_opened' AND task_id = ?
           ORDER BY ts ASC, rowid ASC LIMIT 1`,
        )
        .get(cursor) as { directive_id: string } | null;
      directiveId = cursorOpened?.directive_id;
    }
    if (!directiveId) break;

    const readiness = rootCommitReadiness(db, parentId);
    if (!readiness.ok && readiness.reason !== "not_root") break;

    emitEvent(db, {
      kind: "task_committed",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      task_id: parentId,
      payload: {
        reason: "cascaded_upward_from_all_children_terminal",
        child_task_id: cursor,
        sibling_count: siblings.length,
      } as JsonValue,
    });
    cascaded++;
    cursor = parentId;
  }
  return cascaded;
};

/** Idempotent: emits `directive_closed` once per directive when every task
 *  under it has reached a terminal state. Re-emits are suppressed by the
 *  closed-set check. Returns the close reason when an event was emitted,
 *  null otherwise. */
export const maybeCloseFinishedDirective = (
  db: Database,
  directiveId: string,
): string | null => {
  // Already closed/archived — bail.
  const existing = db
    .query(
      `SELECT 1 FROM events
       WHERE directive_id = ?
         AND kind IN ('directive_closed', 'directive_archived_by_operator', 'directive_archived_missed_reviews')
       LIMIT 1`,
    )
    .get(directiveId) as { 1: number } | null;
  if (existing) return null;

  const reason = directiveCloseReason(db, directiveId);
  if (!reason) return null;

  emitEvent(db, {
    kind: "directive_closed",
    substrate_origin: "substrate_auto",
    directive_id: directiveId,
    payload: {
      reason,
    } as JsonValue,
  });
  return reason;
};
