// acc2 Tier-S2 — causal-edge posterior extractor.
// Per roadmap Tier-S2 (brain KC G3PR7X6TCD4T57D7T6GXCDY9AW): edges between
// substrate entities (citation co-occurrence, refinement, supersession,
// contradiction) become first-class scored act_artifact rows. Each edge's
// Beta posterior calibrates from outcome correlation: when act A cites
// both knowledge_id K1 and knowledge_id K2 and the act closes with low
// residual, the edge (K1, K2) gets +alpha credit.
//
// Three edge classes implemented in this commit:
//   citation_cocitation:    pairs of cited_knowledge_ids on the same act
//   citation_artifact:      pairs of cited_artifact_ids on the same act
//   refinement_parent_child: task_edge_recorded refinement edges
//
// Bounded: yields every 25 acts; LIMIT 500 acts per tick.

import type { Database } from "bun:sqlite";
import { emitEvent } from "./events";

const YIELD_EVERY_N = 25;
const yieldToEventLoop = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0));

const EDGE_KIND = "causal_edge_predicate";

type ActTupleRow = {
  id: string;
  ts: string;
  task_id: string | null;
  payload: string | null;
};

type EdgeEventRow = {
  id: string;
  ts: string;
  payload: string | null;
};

type EdgeClass =
  | "citation_cocitation"
  | "citation_artifact"
  | "refinement_parent_child";

const parsePayload = (raw: string | null): Record<string, unknown> => {
  if (!raw) return {};
  try {
    const p = JSON.parse(raw) as unknown;
    return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const stringPairs = (ids: unknown): Array<[string, string]> => {
  if (!Array.isArray(ids)) return [];
  const out: Array<[string, string]> = [];
  const strs = ids.filter((v): v is string => typeof v === "string");
  for (let i = 0; i < strs.length; i++) {
    for (let j = i + 1; j < strs.length; j++) {
      // canonical ordering for idempotent edge ids
      const [a, b] = strs[i] < strs[j] ? [strs[i], strs[j]] : [strs[j], strs[i]];
      out.push([a, b]);
    }
  }
  return out;
};

const edgeId = (kind: EdgeClass, a: string, b: string): string =>
  `edge_${kind}__${a}__${b}`;

const ensureEdgeRow = (
  db: Database,
  edgeClass: EdgeClass,
  a: string,
  b: string,
): { id: string; created: boolean } => {
  const id = edgeId(edgeClass, a, b);
  const existing = db.query("SELECT id FROM act_artifact WHERE id = ? LIMIT 1").get(id);
  if (existing) return { id, created: false };
  const ts = new Date().toISOString();
  const body = JSON.stringify({ edge_class: edgeClass, node_a: a, node_b: b });
  const declaredSandbox = JSON.stringify({
    runtime: "bun",
    substrate_access: "ro",
    cpu_ms: 100,
    wall_ms: 1000,
    memory_mb: 8,
    fs_read: [],
    fs_write: [],
    net_allow: [],
    proc_allow: [],
  });
  db.run(
    `INSERT INTO act_artifact (
       id, runtime, body, declared_sandbox, state_root, kind,
       posterior_alpha, posterior_beta, score, confidence,
       recent_residual_mean, recent_kill_count, status, name,
       fixture_input, fixture_expected_residual,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      "bun",
      body,
      declaredSandbox,
      `substrate/causal_edge/${edgeClass}/${a}/${b}`,
      EDGE_KIND,
      1.0,
      1.0,
      0.5,
      0.5,
      0.0,
      0,
      "admitted",
      `${edgeClass}:${a}:${b}`,
      JSON.stringify({ edge_class: edgeClass, node_a: a, node_b: b }),
      0.5,
      ts,
      ts,
    ],
  );
  return { id, created: true };
};

export type CausalEdgeSummary = {
  scanned: number;
  cocitations_recorded: number;
  artifact_edges_recorded: number;
  refinement_edges_recorded: number;
  edges_admitted: number;
};

/**
 * Scan recent act_tuple_recorded + task_edge_recorded events and admit
 * one act_artifact{kind:causal_edge_predicate} row per distinct
 * (edge_class, node_a, node_b) tuple. Canonical alphabetical ordering of
 * (node_a, node_b) keeps the row idempotent across reruns. Emits one
 * causal_edge_observed event per observation (even when the edge row
 * already existed) so downstream credit can attribute the outcome later.
 */
export const extractCausalEdges = async (
  db: Database,
  opts?: { maxActs?: number; windowDays?: number },
): Promise<CausalEdgeSummary> => {
  const maxActs = Math.max(1, opts?.maxActs ?? 500);
  const windowDays = Math.max(1, opts?.windowDays ?? 14);
  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const summary: CausalEdgeSummary = {
    scanned: 0,
    cocitations_recorded: 0,
    artifact_edges_recorded: 0,
    refinement_edges_recorded: 0,
    edges_admitted: 0,
  };

  // Citation co-occurrence + artifact co-occurrence from act_tuple_recorded.
  const acts = db
    .query(
      `SELECT id, ts, task_id, payload FROM events
        WHERE kind = 'act_tuple_recorded' AND ts > ?
        ORDER BY ts ASC LIMIT ?`,
    )
    .all(cutoff, maxActs) as ActTupleRow[];

  let processedSinceYield = 0;
  for (const act of acts) {
    if (processedSinceYield >= YIELD_EVERY_N) {
      await yieldToEventLoop();
      processedSinceYield = 0;
    }
    processedSinceYield++;
    summary.scanned++;

    const payload = parsePayload(act.payload);
    const knowledgePairs = stringPairs(payload.cited_knowledge_ids);
    const artifactPairs = stringPairs(payload.cited_artifact_ids);

    for (const [a, b] of knowledgePairs) {
      const { id } = ensureEdgeRow(db, "citation_cocitation", a, b);
      summary.cocitations_recorded++;
      // Audit the edge observation; downstream credit can attribute later.
      emitEvent(db, {
        kind: "causal_edge_observed",
        substrate_origin: "substrate_auto",
        task_id: act.task_id ?? undefined,
        context_refs: [act.id, a, b, id],
        payload: {
          edge_class: "citation_cocitation",
          node_a: a,
          node_b: b,
          edge_act_artifact_id: id,
          source_act_id: act.id,
        },
      });
    }
    for (const [a, b] of artifactPairs) {
      const { id } = ensureEdgeRow(db, "citation_artifact", a, b);
      summary.artifact_edges_recorded++;
      emitEvent(db, {
        kind: "causal_edge_observed",
        substrate_origin: "substrate_auto",
        task_id: act.task_id ?? undefined,
        context_refs: [act.id, a, b, id],
        payload: {
          edge_class: "citation_artifact",
          node_a: a,
          node_b: b,
          edge_act_artifact_id: id,
          source_act_id: act.id,
        },
      });
    }
  }

  // Refinement edges from task_edge_recorded.
  const edges = db
    .query(
      `SELECT id, ts, payload FROM events
        WHERE kind = 'task_edge_recorded' AND ts > ?
        ORDER BY ts ASC LIMIT ?`,
    )
    .all(cutoff, maxActs) as EdgeEventRow[];

  processedSinceYield = 0;
  for (const ev of edges) {
    if (processedSinceYield >= YIELD_EVERY_N) {
      await yieldToEventLoop();
      processedSinceYield = 0;
    }
    processedSinceYield++;
    const p = parsePayload(ev.payload);
    const parent = typeof p.parent_task_id === "string" ? p.parent_task_id : null;
    const child = typeof p.child_task_id === "string" ? p.child_task_id : null;
    if (!parent || !child) continue;
    const [a, b] = parent < child ? [parent, child] : [child, parent];
    const { id } = ensureEdgeRow(db, "refinement_parent_child", a, b);
    summary.refinement_edges_recorded++;
    emitEvent(db, {
      kind: "causal_edge_observed",
      substrate_origin: "substrate_auto",
      context_refs: [ev.id, a, b, id],
      payload: {
        edge_class: "refinement_parent_child",
        node_a: a,
        node_b: b,
        edge_act_artifact_id: id,
        source_event_id: ev.id,
      },
    });
  }

  summary.edges_admitted =
    summary.cocitations_recorded +
    summary.artifact_edges_recorded +
    summary.refinement_edges_recorded;
  return summary;
};
