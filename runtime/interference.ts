// acc2 cross-directive interference — Phase I (Architecture.md, §19 risk 20).
//
// Directives interact: "save for retirement" depletes "buy a house"; "ship MVP"
// blocks "refactor build pipeline"; "exec_directive_A watches market_signal_B".
// The substrate captures these interactions as directive_interference_edge
// events with one of three kinds:
//
//   - blocks    — the source directive holds priority until it closes; the
//                 target waits. Father / dispatch_decider down-rank targets.
//   - watches   — the source observes the target's progress for context.
//   - depletes  — the two share an exhaustible resource (attention, budget,
//                 calendar slot); concurrent execution thins each one's
//                 success probability.
//
// Risk 20 (`A blocks B, B blocks C, C blocks A`) is a cycle in the
// interference graph. The cycle detector below walks the blocks-only subgraph
// and emits `directive_interference_cycle_detected` per cycle found.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { emitEvent, type EmitEventInput } from "./events";

// Phase I (legacy) kinds: blocks/watches/depletes — what `recordInterferenceEdge`
// emits today. Phase DAG extends the taxonomy with the Architecture.md
// canonical kinds: `mutual_exclusion`, `resource_conflict`,
// `sequencing_dependency`, `enabling`. The scheduler-aware concurrency
// conflicts (`mutual_exclusion`, `resource_conflict`) drive dispatch-time
// deferral via `CONCURRENCY_CONFLICT_KINDS` below; the other v2-design kinds
// surface on read so downstream consumers (Father selector, dispatch decider)
// see every kind.
export type InterferenceEdgeKind =
  | "blocks"
  | "watches"
  | "depletes"
  | "mutual_exclusion"
  | "resource_conflict"
  | "sequencing_dependency"
  | "enabling";

export type InterferenceEdge = {
  from_directive: string;
  to_directive: string;
  kind: InterferenceEdgeKind;
  reason: string;
  ts: string;
  event_id: string;
};

const INTERFERENCE_EDGE_KINDS: ReadonlySet<string> = new Set([
  "blocks",
  "watches",
  "depletes",
  "mutual_exclusion",
  "resource_conflict",
  "sequencing_dependency",
  "enabling",
]);

const isEdgeKind = (k: unknown): k is InterferenceEdgeKind =>
  typeof k === "string" && INTERFERENCE_EDGE_KINDS.has(k);

/** Scheduler-aware concurrency conflicts. When two directives are joined by
 *  an edge of one of these kinds AND any task on the source side is
 *  in-flight, the scheduler defers ready tasks on the target side. */
export const CONCURRENCY_CONFLICT_KINDS: ReadonlySet<InterferenceEdgeKind> = new Set([
  "mutual_exclusion",
  "resource_conflict",
]);

/** Read every directive_interference_edge event as a typed edge row. Older
 *  edges remain — the substrate is append-only — so retraction is modelled
 *  by emitting a new edge with the opposite intent (e.g. a `watches`
 *  superseding a previous `blocks`). The caller can dedup by (from, to, kind)
 *  if needed; this function returns them all in ts order. */
export const readInterferenceEdges = (db: Database): InterferenceEdge[] => {
  const rows = db
    .query(
      "SELECT id, ts, payload FROM events WHERE kind = 'directive_interference_edge' ORDER BY ts ASC",
    )
    .all() as Array<{ id: string; ts: string; payload: string }>;
  const edges: InterferenceEdge[] = [];
  for (const r of rows) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(r.payload ?? "{}") as Record<string, unknown>;
    } catch {
      continue;
    }
    const from = payload.from_directive as string | undefined;
    const to = payload.to_directive as string | undefined;
    const kind = payload.kind ?? payload.interaction;
    if (!from || !to || !isEdgeKind(kind)) continue;
    edges.push({
      from_directive: from,
      to_directive: to,
      kind,
      reason: (payload.reason as string) ?? "",
      ts: r.ts,
      event_id: r.id,
    });
  }
  return edges;
};

/** Tarjan-style cycle detection over the `blocks` subgraph. Returns each
 *  cycle as an array of directive_ids in traversal order. Emits a
 *  `directive_interference_cycle_detected` event per cycle found. */
export const detectInterferenceCycles = (
  db: Database,
  emit: (input: EmitEventInput) => void = (input) => { emitEvent(db, input); },
): string[][] => {
  const edges = readInterferenceEdges(db).filter((e) => e.kind === "blocks");
  if (edges.length === 0) return [];

  // Build adjacency list (use a set to dedup edges).
  const adj = new Map<string, Set<string>>();
  for (const e of edges) {
    const set = adj.get(e.from_directive) ?? new Set<string>();
    set.add(e.to_directive);
    adj.set(e.from_directive, set);
  }

  const cycles: string[][] = [];
  const stack: string[] = [];
  const onStack = new Set<string>();
  const visited = new Set<string>();

  const dfs = (node: string): void => {
    stack.push(node);
    onStack.add(node);
    visited.add(node);
    const succs = adj.get(node);
    if (succs) {
      for (const next of succs) {
        if (onStack.has(next)) {
          // Cycle. Extract the slice from the first occurrence of `next` to
          // the current node, plus `next` to close the loop.
          const idx = stack.indexOf(next);
          if (idx >= 0) {
            cycles.push([...stack.slice(idx), next]);
          }
        } else if (!visited.has(next)) {
          dfs(next);
        }
      }
    }
    stack.pop();
    onStack.delete(node);
  };

  for (const node of adj.keys()) {
    if (!visited.has(node)) dfs(node);
  }

  // Dedup cycles by canonical rotation (smallest id first).
  const seen = new Set<string>();
  const unique: string[][] = [];
  for (const cyc of cycles) {
    if (cyc.length < 2) continue;
    const trimmed = cyc[0] === cyc[cyc.length - 1] ? cyc.slice(0, -1) : cyc;
    if (trimmed.length === 0) continue;
    const minIdx = trimmed.reduce((min, _, i, arr) => (arr[i]! < arr[min]! ? i : min), 0);
    const rotated = [...trimmed.slice(minIdx), ...trimmed.slice(0, minIdx)];
    const key = rotated.join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(rotated);
  }

  for (const cyc of unique) {
    emit({
      kind: "directive_interference_cycle_detected",
      substrate_origin: "substrate_auto",
      failure_kind: "directive_interference_cycle",
      payload: {
        cycle: cyc,
        length: cyc.length,
      } as JsonValue,
    });
  }
  return unique;
};

/** Record a new directive_interference_edge event. Validates the kind, refuses
 *  self-loops, and (for `blocks` edges) checks that the new edge does not
 *  introduce a fresh cycle. Returns `{ok: true, event_id}` on success or
 *  `{ok: false, error}` on refusal. Cycles ALREADY in the graph are detected
 *  on the next `detectInterferenceCycles` pass and are not blocking here. */
export const recordInterferenceEdge = (
  db: Database,
  edge: {
    from_directive: string;
    to_directive: string;
    kind: InterferenceEdgeKind;
    reason: string;
  },
  emit: (input: EmitEventInput) => void = (input) => { emitEvent(db, input); },
): { ok: true; event_id: string } | { ok: false; error: string } => {
  if (!isEdgeKind(edge.kind)) {
    return { ok: false, error: `invalid_edge_kind:${edge.kind}` };
  }
  if (edge.from_directive === edge.to_directive) {
    return { ok: false, error: "self_loop_refused" };
  }

  // Cycle pre-check (blocks only): would adding this edge close a cycle?
  if (edge.kind === "blocks") {
    const existing = readInterferenceEdges(db).filter((e) => e.kind === "blocks");
    const adj = new Map<string, Set<string>>();
    for (const e of existing) {
      const set = adj.get(e.from_directive) ?? new Set<string>();
      set.add(e.to_directive);
      adj.set(e.from_directive, set);
    }
    // Add the prospective edge and reachable-from check: can we reach
    // `from_directive` from `to_directive`?
    const targetSet = adj.get(edge.to_directive) ?? new Set<string>();
    // DFS from `to_directive` looking for `from_directive`.
    const queue: string[] = [...targetSet];
    const seen = new Set<string>();
    let cycle = false;
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur === edge.from_directive) { cycle = true; break; }
      if (seen.has(cur)) continue;
      seen.add(cur);
      const next = adj.get(cur);
      if (next) for (const n of next) queue.push(n);
    }
    if (cycle) {
      // Emit the edge anyway (event log is append-only and cycle is a fact),
      // then surface the cycle.
      const emitted = emitEvent(db, {
        kind: "directive_interference_edge",
        substrate_origin: "owner",
        directive_id: edge.from_directive,
        payload: {
          from_directive: edge.from_directive,
          to_directive: edge.to_directive,
          kind: edge.kind,
          reason: edge.reason,
        } as JsonValue,
      });
      detectInterferenceCycles(db, emit);
      return { ok: true, event_id: emitted.id };
    }
  }

  const emitted = emitEvent(db, {
    kind: "directive_interference_edge",
    substrate_origin: "owner",
    directive_id: edge.from_directive,
    payload: {
      from_directive: edge.from_directive,
      to_directive: edge.to_directive,
      kind: edge.kind,
      reason: edge.reason,
    } as JsonValue,
  });
  return { ok: true, event_id: emitted.id };
};

/** Render the CROSS-DIRECTIVE INTERFERENCE block for prompt_composer.ts.
 *  Surfaces (a) edges where `directiveId` is the source or target, plus
 *  (b) any cycles the directive participates in. Returns empty when no
 *  related edges exist. */
export const renderInterferenceBlock = (
  db: Database,
  directiveId: string,
): string => {
  const all = readInterferenceEdges(db);
  const related = all.filter(
    (e) => e.from_directive === directiveId || e.to_directive === directiveId,
  );
  if (related.length === 0) return "";

  const lines: string[] = ["CROSS-DIRECTIVE INTERFERENCE (edges + cycles involving this directive):"];
  for (const e of related) {
    const arrow = e.from_directive === directiveId ? "→" : "←";
    const other = e.from_directive === directiveId ? e.to_directive : e.from_directive;
    lines.push(`  ${e.from_directive} ${arrow}[${e.kind}] ${other} — ${e.reason || "(no reason)"}`);
  }
  return lines.join("\n");
};

/** Scheduler-side concurrency check (Architecture.md, Phase DAG).
 *
 *  For a candidate ready task that belongs to `directiveId`, return the FIRST
 *  in-flight directive that conflicts with it via a `mutual_exclusion` or
 *  `resource_conflict` edge in either direction. Returns `null` when no such
 *  conflict exists; the scheduler then dispatches normally. When non-null,
 *  the caller defers the candidate and emits `task_deferred_for_interference`.
 *
 *  Edges are direction-agnostic for these two kinds — a mutual-exclusion edge
 *  A↔B serialises the pair regardless of which side authored the edge. */
export type DeferringConflict = {
  conflicting_directive: string;
  kind: InterferenceEdgeKind;
  resource_uri?: string;
  constraint_artifact_id?: string;
  reason: string;
};

const readDeclaredExecutionResources = (
  db: Database,
  directiveIds: ReadonlySet<string>,
): Map<string, Set<string>> => {
  const out = new Map<string, Set<string>>();
  if (directiveIds.size === 0) return out;
  const placeholders = Array.from(directiveIds).map(() => "?").join(",");
  const rows = db
    .query(
      `SELECT directive_id, payload FROM events
       WHERE directive_id IN (${placeholders})
         AND kind IN ('action_predicted','act_tuple_recorded')
       ORDER BY ts DESC`,
    )
    .all(...Array.from(directiveIds)) as Array<{ directive_id: string; payload: string }>;
  for (const row of rows) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payload ?? "{}");
    } catch {
      continue;
    }
    const declared = [
      ...(Array.isArray(payload.target_resources) ? payload.target_resources : []),
      ...(Array.isArray(payload.affected_resources) ? payload.affected_resources : []),
      ...(Array.isArray(payload.engaged_resources) ? payload.engaged_resources : []),
    ]
      .map(String)
      .filter((v) => v.length > 0);
    if (declared.length === 0) continue;
    const set = out.get(row.directive_id) ?? new Set<string>();
    for (const r of declared) set.add(r);
    out.set(row.directive_id, set);
  }
  return out;
};

/** Scheduler-side execution-shape check.
 *
 * Existing directive_interference_edge rows remain authoritative. In addition,
 * act declarations can carry open ResourceUri arrays in action_predicted or
 * act_tuple_recorded payloads. A shared resource URI between a candidate and
 * any in-flight directive is treated as the same `resource_conflict` edge the
 * scheduler already understands. This keeps code edits, browser profiles,
 * accounts, physical devices, and temporal handles on one path without adding
 * platform-specific limiter enums. */
export const findDeferringConflict = (
  db: Database,
  directiveId: string,
  inFlightDirectiveIds: ReadonlySet<string>,
): DeferringConflict | null => {
  if (inFlightDirectiveIds.size === 0) return null;
  const edges = readInterferenceEdges(db).filter((e) =>
    CONCURRENCY_CONFLICT_KINDS.has(e.kind),
  );
  for (const e of edges) {
    if (e.from_directive === directiveId && inFlightDirectiveIds.has(e.to_directive)) {
      return { conflicting_directive: e.to_directive, kind: e.kind, reason: "directive_interference_edge" };
    }
    if (e.to_directive === directiveId && inFlightDirectiveIds.has(e.from_directive)) {
      return { conflicting_directive: e.from_directive, kind: e.kind, reason: "directive_interference_edge" };
    }
  }

  const all = new Set<string>([directiveId, ...inFlightDirectiveIds]);
  const resources = readDeclaredExecutionResources(db, all);
  const candidate = resources.get(directiveId);
  if (!candidate || candidate.size === 0) return null;
  for (const inFlight of inFlightDirectiveIds) {
    const peer = resources.get(inFlight);
    if (!peer) continue;
    for (const resource of candidate) {
      if (peer.has(resource)) {
        return {
          conflicting_directive: inFlight,
          kind: "resource_conflict",
          resource_uri: resource,
          reason: "shared_declared_resource",
        };
      }
    }
  }
  return null;
};

/** Return the set of directive_ids that currently block `directiveId` via
 *  unresolved `blocks` edges. dispatch_decider.ts uses this to down-rank
 *  tasks belonging to a blocked directive. A directive is "blocked" while
 *  another directive holds a `blocks` edge pointing at it AND the source
 *  hasn't itself committed/abandoned. (Phase I treats "unresolved" as "no
 *  goal_committed / goal_abandoned event on the source"; Phase K Father may
 *  refine.) */
export const blockersOf = (db: Database, directiveId: string): string[] => {
  const edges = readInterferenceEdges(db).filter(
    (e) => e.to_directive === directiveId && e.kind === "blocks",
  );
  if (edges.length === 0) return [];

  const terminalRows = db
    .query(
      "SELECT DISTINCT directive_id FROM events WHERE kind IN ('goal_committed', 'goal_abandoned')",
    )
    .all() as Array<{ directive_id: string }>;
  const terminal = new Set(terminalRows.map((r) => r.directive_id));

  const blockers = new Set<string>();
  for (const e of edges) {
    if (!terminal.has(e.from_directive)) blockers.add(e.from_directive);
  }
  return Array.from(blockers);
};
