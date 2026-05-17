// acc2 task topology — DAG analysis over task_node_opened + task_edge_recorded
// events (v2-design.md §3.8, §8, §9.3).
//
// Phase D scope:
//   - readDagForDirective: walk events for one directive, return nodes + edges.
//   - readyTasks: find nodes whose `requires` upstreams have all committed
//     (or have no requires edges at all).
//   - refinementDepth: walk the 'refines' edge chain upward from a task.
//
// The substrate is the source of truth — we replay events to compute current
// shape. Phase E will materialize a `task_graph_view` and add concurrency.

import type { Database } from "bun:sqlite";
import type { TaskEdgeKind } from "../substrate/types";
import { closedDirectiveIds } from "./directive_closure";

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
  // a stale `task_node_opened` (from Father loops re-emitting the same
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

/** Read all nodes + edges for one directive by replaying its events. */
export const readDagForDirective = (
  db: Database,
  directiveId: string,
): { nodes: TaskNode[]; edges: TaskEdge[] } => {
  const rows = db
    .query(
      "SELECT id, task_id, directive_id, parent_task_id, kind, payload FROM events WHERE directive_id = ? ORDER BY ts ASC",
    )
    .all(directiveId) as EventRow[];

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
    const rows = db
      .query("SELECT DISTINCT directive_id FROM events WHERE kind = 'task_node_opened'")
      .all() as Array<{ directive_id: string }>;
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
  const rows = db
    .query(
      "SELECT payload FROM events WHERE kind = 'task_edge_recorded'",
    )
    .all() as Array<{ payload: string }>;
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
