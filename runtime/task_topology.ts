// acc2 task topology — DAG analysis over task_node_opened + task_edge_recorded
// events (Architecture.md, §8, §9.3).
//
// Phase D scope:
//   - readDagForDirective: walk events for one directive, return nodes + edges.
//   - readyTasks: find nodes whose `requires` upstreams have all committed
//     (or have no requires edges at all).
//   - refinementDepth: walk the 'refines' edge chain upward from a task.
//
// The substrate is the source of truth — we replay events to compute current
// shape. Phase E will materialize a `task_graph_view` and add concurrency.
//
// COMPOUNDING SPEEDUP (2026-05-22, brain compounding-strategy lever #2):
// readDagForDirective sits on the scheduler hot path — schedulerTick calls
// readyTasks every ~500ms (and on every activation-bus wake), which previously
// replayed EVERY event for EVERY open directive to rebuild each DAG from
// scratch on every call: O(all events per directive) recomputation of an
// identical result whenever the ledger had not advanced for that directive.
// We now memoize the per-directive DAG keyed by the directive's max event
// rowid. The events table is append-only (substrate invariant), so a
// directive's MAX(rowid) strictly increases when (and only when) a new event
// lands for that directive, and never changes otherwise — an exact
// invalidation signal. A cache hit therefore returns a DAG byte-identical to a
// fresh full replay, and any new event forces a recompute (O(new state) on the
// next read, O(1) for the unchanged reads in between). This mirrors the
// established prompt_cache.ts idiom (in-memory cache keyed by an events
// high-water rowid) rather than introducing a foreign mechanism. The cache is
// process-local and advisory — a daemon restart simply repopulates it on first
// read; it is never the source of truth.

import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { TaskEdgeKind } from "../substrate/types";
import { closedDirectiveIds } from "./directive_closure";
import { attachedArchiveSchemas } from "../substrate/db";

// ── Tier-spanning event read (hot + attached cold archives) ────────────────
//
// The task DAG (task_node_opened / task_edge_recorded) is part of the credit
// spine. The narrowed ALWAYS_KEEP (archival_worker.ts) now lets those rows age
// into a sibling `state-archive-YYYY-MM.db` that `attachArchives` ATTACHes
// read-only as an `archive_*` schema. A hot-only `FROM events` read would then
// return an EMPTY DAG for an aged directive → dense closure credit finds no
// contributors. We mirror the established pattern in dense_closure_credit.ts /
// credit.ts / events.ts: UNION hot `events` with every attached
// `<schema>.events`. For the common all-hot directive the archive union returns
// nothing extra, so the read stays bounded and cheap.
const eventTables = (db: Database): string[] => [
  "events",
  ...attachedArchiveSchemas(db).map((schema) => `${schema}.events`),
];

const selectEventRowsAcrossTiers = <T extends Record<string, unknown>>(
  db: Database,
  selectCols: string,
  whereSql: string,
  params: SQLQueryBindings[] = [],
): T[] => {
  const rows: T[] = [];
  for (const table of eventTables(db)) {
    try {
      rows.push(
        ...(db.query(`SELECT ${selectCols} FROM ${table} WHERE ${whereSql}`).all(...params) as T[]),
      );
    } catch (err) {
      // A malformed / partially-attached archive must not break the hot read.
      if (table === "events") throw err;
    }
  }
  return rows;
};

export type TaskNodeStatus = "pending" | "ready" | "in_progress" | "committed" | "failed";

export type TaskNode = {
  id: string;
  directive_id: string;
  parent_id: string | null;
  goal: string;
  status: TaskNodeStatus;
};

export type TaskEdge = {
  from_task: string;
  to_task: string;
  kind: TaskEdgeKind;
};

type EventRow = {
  id: string;
  task_id: string;
  directive_id: string;
  parent_task_id: string | null;
  kind: string;
  payload: string;
};

const parsePayload = (row: EventRow): Record<string, unknown> => {
  try {
    return JSON.parse(row.payload ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
};

const computeStatus = (taskId: string, eventsByTask: Map<string, EventRow[]>): TaskNodeStatus => {
  const evs = eventsByTask.get(taskId) ?? [];
  // Terminal states are MONOTONIC. Once a task reaches committed / failed /
  // abandoned, NO subsequent event reopens it on the same task_id. Pre-fix
  // a stale `task_node_opened` (from OwnerAutonomy loops re-emitting the same
  // template, or from brain refinement re-emits using the same id) would
  // reset status to "pending" and the scheduler would re-dispatch — exactly
  // the zombie-loop pattern this session exposed. Re-attempting work uses
  // a NEW task_id linked via task_edge_recorded { kind: "refines" }, not
  // the same id.
  let status: TaskNodeStatus = "pending";
  for (const e of evs) {
    if (status === "committed" || status === "failed") continue;
    if (e.kind === "task_node_opened") status = "pending";
    else if (e.kind === "task_ready") status = "ready";
    else if (e.kind === "task_claimed") status = "in_progress";
    else if (e.kind === "task_committed") status = "committed";
    else if (e.kind === "task_failed") status = "failed";
    else if (e.kind === "task_abandoned") status = "failed";
    // L4.1 mirror (2026-05-17): ready_tasks_view SQL terminal CTE now
    // suppresses both kinds; the runtime helper has to agree so
    // schedulers / verifiers reading either surface see the same
    // monotonic terminal vocabulary. task_committed_superseded is a
    // committed-equivalent (the prior task's result no longer applies
    // but it is not a failure); task_blocked is a failure-equivalent
    // for status purposes — the task did not complete on this path.
    else if (e.kind === "task_committed_superseded") status = "committed";
    else if (e.kind === "task_blocked") status = "failed";
  }
  return status;
};

export type TaskDag = { nodes: TaskNode[]; edges: TaskEdge[] };

// ── Incremental per-directive DAG cache (event-cursor) ────────────────────
//
// Process-local memo: directive_id → { cursor, dag }. `cursor` is the
// directive's MAX(rowid) at the time the DAG was computed. A read recomputes
// only when the directive's current MAX(rowid) differs from the cached cursor;
// otherwise it returns the cached DAG instance. All current callers treat the
// DAG read-only (filter/find/some — no mutation), so the shared reference is
// safe and avoids a defensive clone that would defeat the speedup.
// directive_ids are globally-unique ULIDs (newId()), so
// the key never collides across independent :memory: DBs in tests; the cursor
// comparison is the correctness guard regardless.
type DagCacheEntry = { cursor: number; dag: TaskDag };
const dagCache = new Map<string, DagCacheEntry>();

/** The directive's append-only event high-water mark. Strictly increasing as
 *  events are inserted for the directive; unchanged otherwise. 0 when the
 *  directive has no events yet. Uses the (directive_id, …) index for a bounded
 *  seek rather than a full-table scan. */
const directiveCursor = (db: Database, directiveId: string): number => {
  const row = db
    .query("SELECT IFNULL(MAX(rowid), 0) AS m FROM events WHERE directive_id = ?")
    .get(directiveId) as { m: number };
  return row.m;
};

/** Read all nodes + edges for one directive.
 *
 *  Incremental (event-cursor): returns the memoized DAG when the directive's
 *  max event rowid is unchanged since the last computation; otherwise replays
 *  the directive's events once and re-caches. Output is identical to the pure
 *  full-replay path (`readDagForDirectiveReplay`) — the cache is invalidated
 *  precisely by any new event for the directive. */
export const readDagForDirective = (
  db: Database,
  directiveId: string,
): TaskDag => {
  const cursor = directiveCursor(db, directiveId);
  const cached = dagCache.get(directiveId);
  if (cached && cached.cursor === cursor) {
    return cached.dag;
  }
  const dag = readDagForDirectiveReplay(db, directiveId);
  dagCache.set(directiveId, { cursor, dag });
  return dag;
};

/** Pure full-replay computation of a directive's DAG. The cache wrapper
 *  (`readDagForDirective`) calls this only when the directive's event cursor
 *  has advanced. Kept exported so tests can assert incremental == replay. */
export const readDagForDirectiveReplay = (
  db: Database,
  directiveId: string,
): TaskDag => {
  // Tier-spanning: union hot + every attached cold archive, then order by ts
  // (the union helper does not order across tiers, so we sort here to preserve
  // the original ORDER BY ts ASC replay semantics).
  const rows = selectEventRowsAcrossTiers<EventRow & { ts: string }>(
    db,
    "id, task_id, directive_id, parent_task_id, kind, payload, ts",
    "directive_id = ?",
    [directiveId],
  ).sort((a, b) => String(a.ts ?? "").localeCompare(String(b.ts ?? ""))) as EventRow[];

  const eventsByTask = new Map<string, EventRow[]>();
  const nodeRows: EventRow[] = [];
  const edgeRows: EventRow[] = [];

  for (const r of rows) {
    if (r.kind === "task_node_opened") nodeRows.push(r);
    if (r.kind === "task_edge_recorded") edgeRows.push(r);
    const list = eventsByTask.get(r.task_id) ?? [];
    list.push(r);
    eventsByTask.set(r.task_id, list);
  }

  const seenNodeIds = new Set<string>();
  const nodes: TaskNode[] = [];
  for (const r of nodeRows) {
    if (seenNodeIds.has(r.task_id)) continue;
    seenNodeIds.add(r.task_id);
    const payload = parsePayload(r);
    nodes.push({
      id: r.task_id,
      directive_id: r.directive_id,
      parent_id: r.parent_task_id,
      goal: (payload.goal as string) ?? "(no goal)",
      status: computeStatus(r.task_id, eventsByTask),
    });
  }

  const edges: TaskEdge[] = [];
  for (const r of edgeRows) {
    const payload = parsePayload(r);
    const from = (payload.from_task as string) ?? null;
    const to = (payload.to_task as string) ?? null;
    const kind = ((payload.kind as string) ?? "requires") as TaskEdgeKind;
    if (!from || !to) continue;
    edges.push({ from_task: from, to_task: to, kind });
  }

  return { nodes, edges };
};

/** Find tasks ready for dispatch: every `requires` upstream is committed, the
 *  task itself isn't already committed/failed, and it has at least one
 *  `task_node_opened` event. Phase D returns a flat list — Phase E adds
 *  concurrency caps. */
export const readyTasks = (db: Database, directiveId?: string): TaskNode[] => {
  // If a directive is supplied, scope to it; else scan all events.
  const dagDirectiveIds = new Set<string>();
  if (directiveId) {
    dagDirectiveIds.add(directiveId);
  } else {
    const rows = selectEventRowsAcrossTiers<{ directive_id: string }>(
      db,
      "DISTINCT directive_id",
      "kind = 'task_node_opened'",
    );
    for (const r of rows) dagDirectiveIds.add(r.directive_id);
  }

  // Exclude directives whose work is over (directive_closed emitted by
  // maybeCloseFinishedDirective once all tasks are terminal; or operator/
  // rolling-housekeeping archive events). This is the structural fix for
  // the "scheduler keeps re-dispatching tasks whose directive is done"
  // class of zombie-loop bugs.
  const closed = closedDirectiveIds(db);

  const ready: TaskNode[] = [];
  for (const d of dagDirectiveIds) {
    if (closed.has(d)) continue;
    const { nodes, edges } = readDagForDirective(db, d);
    const committedTasks = new Set(nodes.filter((n) => n.status === "committed").map((n) => n.id));

    for (const n of nodes) {
      if (n.status === "committed" || n.status === "failed") continue;
      const requires = edges.filter((e) => e.to_task === n.id && e.kind === "requires");
      const blocked = requires.some((e) => !committedTasks.has(e.from_task));
      if (blocked) continue;
      ready.push(n);
    }
  }
  return ready;
};

/** Walk the 'refines' chain upward from a task to count how many refinement
 *  steps lie between it and its non-refined root. Used by Phase D's refinement
 *  depth cap (defaults to 5 in §3.7). */
export const refinementDepth = (db: Database, taskId: string): number => {
  // Read every refines edge anywhere — Phase D directives are tiny.
  const rows = selectEventRowsAcrossTiers<{ payload: string }>(
    db,
    "payload",
    "kind = 'task_edge_recorded'",
  );
  const incoming = new Map<string, string>(); // to_task -> from_task (refines)
  for (const r of rows) {
    try {
      const payload = JSON.parse(r.payload ?? "{}") as Record<string, unknown>;
      if (payload.kind === "refines") {
        const from = payload.from_task as string;
        const to = payload.to_task as string;
        if (from && to) incoming.set(to, from);
      }
    } catch { /* skip */ }
  }
  let depth = 0;
  let cur = taskId;
  const seen = new Set<string>([cur]);
  while (incoming.has(cur)) {
    cur = incoming.get(cur)!;
    if (seen.has(cur)) break; // cycle defense
    seen.add(cur);
    depth++;
    if (depth > 1000) break; // pathological cap
  }
  return depth;
};

/** Drop the process-local per-directive DAG memo. The cache is self-
 *  invalidating via the directive event cursor, so this is needed only for
 *  test isolation (each test opens a fresh :memory: DB whose rowids restart
 *  from 1, which could otherwise alias a prior test's directive cursor if a
 *  directive_id were ever reused) and for hot-reload of this module. */
export const _resetTaskTopologyCacheForTests = (): void => {
  dagCache.clear();
};
