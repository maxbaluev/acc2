// acc2 closure audit selection — timestamp-scoped, current-root closure
// row selection helpers. F11 (2026-05-18, contract
// 2AMJKN0GTX32790173EPYH6YT4) cites lesson 7JE565S6016T: closure stop
// functions previously selected stale closure_audited rows when a root
// task_id was reused across directive amendments or when a directive's
// CURRENT root differs from a historical root id with its own closure
// audits. The substrate must select the MOST RECENT task_closure_audited
// row that is scoped to:
//
//   1. the directive id, AND
//   2. the directive's CURRENT root task id (the root after any
//      directive_amended row that may have changed the active root), AND
//   3. ts strictly greater than the most recent root-supersession or
//      directive_amended event that changed the active root.
//
// Without this, the plateau detector (task_dispatcher.ts) and the
// experience compression worker can pick up a closure_residual from a
// previous incarnation of the same task_id, suppress active refinement,
// or score a fresh trajectory as "already settled" against ancient
// evidence.
//
// The KC (JN8ND1TFQ11FHD178RNZSHH554) names this file explicitly as the
// canonical home for the helper.

import type { Database } from "bun:sqlite";

export type ClosureAuditSelection = {
  /** Event id of the selected task_closure_audited row. */
  closure_audit_event_id: string;
  /** Numeric closure_residual extracted from the audit payload. */
  closure_residual: number;
  /** ts of the selected audit row. */
  ts: string;
  /** task_id stamped on the audit row. */
  task_id: string;
};

/** Resolve the LATEST directive_amended or directive_root_superseded ts
 *  on this directive. The current root is only considered "settled" by
 *  closure audits emitted AFTER this cutoff; older rows are stale even
 *  if they share the same task_id. Returns null when no amendment /
 *  supersession has fired (the directive's original root still owns
 *  every closure on it). */
const latestRootSupersessionTs = (
  db: Database,
  directiveId: string,
): string | null => {
  const row = db
    .query<{ ts: string }, [string]>(
      `SELECT ts FROM events
        WHERE directive_id = ?
          AND kind IN ('directive_amended', 'directive_root_superseded')
        ORDER BY ts DESC, rowid DESC
        LIMIT 1`,
    )
    .get(directiveId);
  return row?.ts ?? null;
};

/** Select the most recent task_closure_audited row whose:
 *    - directive_id matches the supplied directive,
 *    - task_id matches the directive's current root (the caller resolves
 *      "current root" — usually `task.id` when the dispatcher is iterating
 *      the root, or via task_graph projection),
 *    - ts is strictly newer than any directive_amended / root supersession
 *      event on the same directive.
 *
 *  Returns null when no qualifying row exists — callers must treat a null
 *  result as "no closure verdict yet" rather than falling back to an
 *  earlier (stale) row. Idempotent / pure: re-running with identical
 *  inputs returns identical output until a new audit lands. */
export const selectCurrentRootClosureAudit = (
  db: Database,
  directiveId: string,
  currentRootTaskId: string,
): ClosureAuditSelection | null => {
  const cutoff = latestRootSupersessionTs(db, directiveId);
  const rows = cutoff
    ? db
        .query<{ id: string; ts: string; task_id: string; payload: string }, [string, string, string]>(
          `SELECT id, ts, task_id, payload FROM events
            WHERE kind = 'task_closure_audited'
              AND directive_id = ?
              AND task_id = ?
              AND ts > ?
            ORDER BY ts DESC, rowid DESC`,
        )
        .all(directiveId, currentRootTaskId, cutoff)
    : db
        .query<{ id: string; ts: string; task_id: string; payload: string }, [string, string]>(
          `SELECT id, ts, task_id, payload FROM events
            WHERE kind = 'task_closure_audited'
              AND directive_id = ?
              AND task_id = ?
            ORDER BY ts DESC, rowid DESC`,
        )
        .all(directiveId, currentRootTaskId);
  for (const row of rows) {
    let residual: number | null = null;
    try {
      const payload = JSON.parse(row.payload ?? "{}") as Record<string, unknown>;
      if (typeof payload.closure_residual === "number") residual = payload.closure_residual;
    } catch { /* malformed payload — skip */ }
    if (residual === null) continue;
    return {
      closure_audit_event_id: row.id,
      closure_residual: residual,
      ts: row.ts,
      task_id: row.task_id,
    };
  }
  return null;
};

/** Time-ordered list of closure_residual values for a refinement lineage
 *  under a directive's CURRENT root window. The plateau detector in
 *  task_dispatcher.ts uses this to find "no improvement over N cycles" —
 *  it must operate over a window that excludes audits emitted before the
 *  current root took over (a previous amendment's audits would
 *  spuriously flatten the trend). Returns rows in ts ASC so callers can
 *  slice -N off the tail to get the most recent N values. */
export const closureResidualsForLineage = (
  db: Database,
  directiveId: string,
  lineageTaskIds: ReadonlySet<string>,
): number[] => {
  if (lineageTaskIds.size === 0) return [];
  const cutoff = latestRootSupersessionTs(db, directiveId);
  const rows = cutoff
    ? db
        .query<{ task_id: string; payload: string }, [string, string]>(
          `SELECT task_id, payload FROM events
            WHERE kind = 'task_closure_audited'
              AND directive_id = ?
              AND ts > ?
            ORDER BY ts ASC, rowid ASC`,
        )
        .all(directiveId, cutoff)
    : db
        .query<{ task_id: string; payload: string }, [string]>(
          `SELECT task_id, payload FROM events
            WHERE kind = 'task_closure_audited'
              AND directive_id = ?
            ORDER BY ts ASC, rowid ASC`,
        )
        .all(directiveId);
  const out: number[] = [];
  for (const row of rows) {
    if (!lineageTaskIds.has(row.task_id)) continue;
    try {
      const payload = JSON.parse(row.payload ?? "{}") as Record<string, unknown>;
      if (typeof payload.closure_residual === "number") out.push(payload.closure_residual);
    } catch { /* malformed payload — skip */ }
  }
  return out;
};
