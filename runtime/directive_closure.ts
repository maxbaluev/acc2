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
