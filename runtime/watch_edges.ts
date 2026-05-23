// acc2 watch edges — typed consistency for downstream readers (Architecture.md).
//
// `watches` is a soft dependency that lets a downstream task observe an
// upstream's intermediate output mid-flight. The consistency contract is
// declared per-edge:
//
//   - monotonic       — values only grow; all upstream events are visible
//                       in ts-order; revocation forbidden.
//   - snapshot_now    — only the most-recent value per event_kind at read
//                       time is visible. Stale-but-consistent.
//   - read_your_writes — within the same task scope, the task always sees
//                       its own writes. Implicit / always-on inside a
//                       dispatch (the same SQLite connection trivially
//                       satisfies this); included here as a typed mode so
//                       prompt_composer can surface the contract.
//
// Edges are stored as `task_edge_recorded` events with payload:
//   { from_task, to_task, kind: "watches", consistency_mode: "..." }
//
// snapshotWatchedOutputs walks the watch edges incoming to a task and
// returns the observation set the downstream should see. The dispatcher
// (Phase D) currently feeds an empty array into prompt_composer's WATCHED
// OUTPUTS section; Phase E lights up the real walk.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";

export type ConsistencyMode = "monotonic" | "snapshot_now" | "read_your_writes";

export type WatchObservation = {
  upstream_task_id: string;
  observed_at: string;
  payload: JsonValue;
  consistency_mode: ConsistencyMode;
  event_kind: string;
};

const VISIBLE_EVENT_KINDS = new Set([
  "task_committed",
  "action_scored",
  "artifact_observed",
  "task_ready",
  "task_node_opened",
]);

type EdgeRow = {
  payload: string;
};

type EventRow = {
  id: string;
  ts: string;
  task_id: string;
  kind: string;
  payload: string;
};

const safeParse = (raw: string | null | undefined): Record<string, unknown> => {
  try {
    return JSON.parse(raw ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
};

type WatchEdge = {
  from_task: string;
  to_task: string;
  consistency_mode: ConsistencyMode;
};

const readWatchEdges = (db: Database): WatchEdge[] => {
  const rows = db
    .query("SELECT payload FROM events WHERE kind = 'task_edge_recorded'")
    .all() as EdgeRow[];
  const edges: WatchEdge[] = [];
  for (const r of rows) {
    const p = safeParse(r.payload);
    if (p.kind !== "watches") continue;
    const from = p.from_task as string | undefined;
    const to = p.to_task as string | undefined;
    if (!from || !to) continue;
    const mode = ((p.consistency_mode as string) ?? "monotonic") as ConsistencyMode;
    edges.push({ from_task: from, to_task: to, consistency_mode: mode });
  }
  return edges;
};

const readUpstreamEvents = (db: Database, upstreamTaskId: string): EventRow[] => {
  const rows = db
    .query(
      "SELECT id, ts, task_id, kind, payload FROM events WHERE task_id = ? ORDER BY ts ASC",
    )
    .all(upstreamTaskId) as EventRow[];
  return rows.filter((r) => VISIBLE_EVENT_KINDS.has(r.kind));
};

/** Walk the watch edges incoming to a task and project upstream observations
 *  under each edge's declared consistency mode. Returns observations ordered
 *  by (upstream_task_id, ts) so prompt composition is deterministic. */
export const snapshotWatchedOutputs = (
  db: Database,
  taskId: string,
): WatchObservation[] => {
  const edges = readWatchEdges(db).filter((e) => e.to_task === taskId);
  const observations: WatchObservation[] = [];

  for (const edge of edges) {
    const events = readUpstreamEvents(db, edge.from_task);
    if (edge.consistency_mode === "monotonic") {
      for (const e of events) {
        observations.push({
          upstream_task_id: edge.from_task,
          observed_at: e.ts,
          payload: safeParse(e.payload) as JsonValue,
          consistency_mode: "monotonic",
          event_kind: e.kind,
        });
      }
    } else if (edge.consistency_mode === "snapshot_now") {
      // Keep only the most-recent value per (upstream_task, event_kind).
      const latestByKind = new Map<string, EventRow>();
      for (const e of events) {
        latestByKind.set(e.kind, e); // events arrive ts-asc; last write wins.
      }
      for (const [, e] of latestByKind) {
        observations.push({
          upstream_task_id: edge.from_task,
          observed_at: e.ts,
          payload: safeParse(e.payload) as JsonValue,
          consistency_mode: "snapshot_now",
          event_kind: e.kind,
        });
      }
    } else {
      // read_your_writes is always-on (same SQLite connection inside a
      // dispatch). We still surface upstream events under this mode for
      // structural symmetry — the brain reads the same shape.
      for (const e of events) {
        observations.push({
          upstream_task_id: edge.from_task,
          observed_at: e.ts,
          payload: safeParse(e.payload) as JsonValue,
          consistency_mode: "read_your_writes",
          event_kind: e.kind,
        });
      }
    }
  }

  observations.sort((a, b) =>
    a.upstream_task_id === b.upstream_task_id
      ? a.observed_at.localeCompare(b.observed_at)
      : a.upstream_task_id.localeCompare(b.upstream_task_id),
  );
  return observations;
};

/** Detect revocation violations: a monotonic watcher observed a value that
 *  the upstream then revoked (emitted an explicit `revocation_recorded` event
 *  on that kind, or rewrote a committed observation to a lower-information
 *  value). Per Architecture: "Mid-flight observation revocation: monotonic-
 *  only mode; revocation forbidden." Returns the offending event ids. */
export const detectRevocationViolations = (
  db: Database,
  directiveId: string,
): string[] => {
  const edges = readWatchEdges(db);
  if (edges.length === 0) return [];

  const violations: string[] = [];
  const monotonicEdges = edges.filter((e) => e.consistency_mode === "monotonic");

  for (const edge of monotonicEdges) {
    // For each monotonic upstream, look for an `observation_revoked` event
    // (synthetic kind a downstream signals via payload.revocation = true on
    // a follow-up event) OR an artifact_observed event that supersedes a
    // committed observation.
    const events = db
      .query(
        "SELECT id, ts, task_id, kind, payload FROM events WHERE task_id = ? AND directive_id = ? ORDER BY ts ASC",
      )
      .all(edge.from_task, directiveId) as EventRow[];

    for (const e of events) {
      const p = safeParse(e.payload);
      if (p.revocation === true) {
        violations.push(e.id);
        continue;
      }
      // task_committed_superseded on a watched upstream IS a revocation
      // from the downstream's perspective.
      if (e.kind === "task_committed_superseded") {
        violations.push(e.id);
      }
    }
  }

  return violations;
};
