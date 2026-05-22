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
import { betaMean, betaStreamConfidence } from "./posterior";

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
  closures_scanned: number;
  edges_credited: number;
  credit_pairs_skipped_dup: number;
};

const DEFAULT_MAX_CLOSURES = 200;

type ClosureRow = {
  id: string;
  ts: string;
  directive_id: string | null;
  task_id: string | null;
  payload: string | null;
};

/**
 * Apply Beta credit to existing causal-edge rows from recent closures.
 *
 * For each recent task_closure_audited carrying a numeric closure_residual,
 * find the act_tuple_recorded events in the same directive (or task when no
 * directive), extract their co-cited pairs (the same stringPairs over
 * cited_knowledge_ids → citation_cocitation and cited_artifact_ids →
 * citation_artifact), and for each EXISTING edge row apply credit:
 *   residual < 0.3 → posterior_alpha += 1 (co-occurred in a good outcome)
 *   residual >= 0.3 → posterior_beta  += 1
 * then recompute score = α/(α+β) and confidence.
 *
 * Idempotent per (edge_id, source_closure_event_id): a causal_edge_credited
 * event keyed on both ids is emitted, and a pair already credited for the
 * same closure is skipped on later ticks (no double-credit). Bounded to the
 * last `maxClosures` closures per tick.
 */
const creditEdgesFromClosures = async (
  db: Database,
  cutoff: string,
  maxClosures: number,
  summary: CausalEdgeSummary,
): Promise<void> => {
  const closures = db
    .query(
      `SELECT id, ts, directive_id, task_id, payload FROM events
        WHERE kind = 'task_closure_audited' AND ts > ?
        ORDER BY ts DESC LIMIT ?`,
    )
    .all(cutoff, maxClosures) as ClosureRow[];

  const LOW_RESIDUAL = 0.3;
  let processedSinceYield = 0;
  for (const closure of closures) {
    if (processedSinceYield >= YIELD_EVERY_N) {
      await yieldToEventLoop();
      processedSinceYield = 0;
    }
    processedSinceYield++;

    const cp = parsePayload(closure.payload);
    if (typeof cp.closure_residual !== "number") continue;
    const residual = cp.closure_residual;
    summary.closures_scanned++;

    // Find the acts that belong to this closure's directive (preferred) or
    // task. directive_id is the canonical grouping key the extractor uses
    // elsewhere; fall back to task_id when the closure has no directive.
    let acts: ActTupleRow[];
    if (closure.directive_id) {
      acts = db
        .query(
          `SELECT id, ts, task_id, payload FROM events
            WHERE kind = 'act_tuple_recorded' AND directive_id = ?`,
        )
        .all(closure.directive_id) as ActTupleRow[];
    } else if (closure.task_id) {
      acts = db
        .query(
          `SELECT id, ts, task_id, payload FROM events
            WHERE kind = 'act_tuple_recorded' AND task_id = ?`,
        )
        .all(closure.task_id) as ActTupleRow[];
    } else {
      continue;
    }

    // Collect the distinct edges this closure should credit. A pair that
    // appears across multiple acts in the same directive is credited once
    // per closure (the closure is the outcome unit, not the act).
    const edgeIds = new Set<string>();
    for (const act of acts) {
      const payload = parsePayload(act.payload);
      for (const [a, b] of stringPairs(payload.cited_knowledge_ids)) {
        edgeIds.add(edgeId("citation_cocitation", a, b));
      }
      for (const [a, b] of stringPairs(payload.cited_artifact_ids)) {
        edgeIds.add(edgeId("citation_artifact", a, b));
      }
    }

    for (const id of edgeIds) {
      // Idempotency: skip if this (edge_id, closure_event_id) pair was
      // already credited on a prior tick. The causal_edge_credited event
      // is the high-water-mark — keyed on both ids in context_refs.
      const already = db
        .query(
          `SELECT 1 FROM events
            WHERE kind = 'causal_edge_credited'
              AND json_extract(payload, '$.edge_act_artifact_id') = ?
              AND json_extract(payload, '$.source_closure_event_id') = ?
            LIMIT 1`,
        )
        .get(id, closure.id);
      if (already) {
        summary.credit_pairs_skipped_dup++;
        continue;
      }

      const row = db
        .query(
          `SELECT posterior_alpha, posterior_beta FROM act_artifact WHERE id = ? LIMIT 1`,
        )
        .get(id) as { posterior_alpha: number; posterior_beta: number } | null;
      // Only credit existing edge rows — the creation half admits them.
      if (!row) continue;

      const isGood = residual < LOW_RESIDUAL;
      const newAlpha = row.posterior_alpha + (isGood ? 1 : 0);
      const newBeta = row.posterior_beta + (isGood ? 0 : 1);
      const newScore = betaMean(newAlpha, newBeta);
      const newConfidence = betaStreamConfidence(newAlpha, newBeta);
      db.run(
        `UPDATE act_artifact
           SET posterior_alpha = ?, posterior_beta = ?,
               score = ?, confidence = ?,
               recent_residual_mean = ?, updated_at = ?
         WHERE id = ?`,
        [newAlpha, newBeta, newScore, newConfidence, residual, new Date().toISOString(), id],
      );
      summary.edges_credited++;
      emitEvent(db, {
        kind: "causal_edge_credited",
        substrate_origin: "substrate_auto",
        directive_id: closure.directive_id ?? undefined,
        task_id: closure.task_id ?? undefined,
        context_refs: [id, closure.id],
        payload: {
          edge_act_artifact_id: id,
          source_closure_event_id: closure.id,
          closure_residual: residual,
          outcome: isGood ? "low_residual" : "high_residual",
          posterior_alpha: newAlpha,
          posterior_beta: newBeta,
          score: newScore,
        },
      });
    }
  }
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
  opts?: { maxActs?: number; windowDays?: number; maxClosures?: number },
): Promise<CausalEdgeSummary> => {
  const maxActs = Math.max(1, opts?.maxActs ?? 500);
  const windowDays = Math.max(1, opts?.windowDays ?? 14);
  const maxClosures = Math.max(1, opts?.maxClosures ?? DEFAULT_MAX_CLOSURES);
  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const summary: CausalEdgeSummary = {
    scanned: 0,
    cocitations_recorded: 0,
    artifact_edges_recorded: 0,
    refinement_edges_recorded: 0,
    edges_admitted: 0,
    closures_scanned: 0,
    edges_credited: 0,
    credit_pairs_skipped_dup: 0,
  };

  // Citation co-occurrence + artifact co-occurrence from act_tuple_recorded.
  // T3.8/T5: heavy time-window sweep — route through the SQL worker-thread
  // pool when present so Bun.SQL's sync read can't starve the main loop.
  const actsSql = `SELECT id, ts, task_id, payload FROM events
        WHERE kind = 'act_tuple_recorded' AND ts > ?
        ORDER BY ts ASC LIMIT ?`;
  const acts = await (async (): Promise<ActTupleRow[]> => {
    try {
      const mod = await import("./sql_pool_singleton");
      const pool = mod.getSqlPool();
      if (pool) return pool.query<ActTupleRow>(actsSql, [cutoff, maxActs]);
    } catch { /* tolerate */ }
    return db.query(actsSql).all(cutoff, maxActs) as ActTupleRow[];
  })();

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
      const { id, created } = ensureEdgeRow(db, "citation_cocitation", a, b);
      summary.cocitations_recorded++;
      // Audit emit ONLY on first observation (2026-05-21 noise audit:
      // 5374 causal_edge_observed events in 24h had 43 distinct payloads
      // = 99% dupes. The edge row's posterior already accumulates each
      // observation via downstream credit; the audit event is signal
      // only when the edge is brand new. Subsequent observations are
      // counted on the act_artifact row, not in events).
      if (!created) continue;
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
          first_observation: true,
        },
      });
    }
    for (const [a, b] of artifactPairs) {
      const { id, created } = ensureEdgeRow(db, "citation_artifact", a, b);
      summary.artifact_edges_recorded++;
      if (!created) continue;
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
          first_observation: true,
        },
      });
    }
  }

  // Refinement edges from task_edge_recorded. T3.8/T5: pool-routed sweep.
  const edgesSql = `SELECT id, ts, payload FROM events
        WHERE kind = 'task_edge_recorded' AND ts > ?
        ORDER BY ts ASC LIMIT ?`;
  const edges = await (async (): Promise<EdgeEventRow[]> => {
    try {
      const mod = await import("./sql_pool_singleton");
      const pool = mod.getSqlPool();
      if (pool) return pool.query<EdgeEventRow>(edgesSql, [cutoff, maxActs]);
    } catch { /* tolerate */ }
    return db.query(edgesSql).all(cutoff, maxActs) as EdgeEventRow[];
  })();

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
    const { id, created } = ensureEdgeRow(db, "refinement_parent_child", a, b);
    summary.refinement_edges_recorded++;
    // First-observation gate per the noise-audit fix above.
    if (!created) continue;
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
        first_observation: true,
      },
    });
  }

  summary.edges_admitted =
    summary.cocitations_recorded +
    summary.artifact_edges_recorded +
    summary.refinement_edges_recorded;

  // Credit half: apply Beta credit to existing edge rows from recent
  // closures. The creation half above admits edges at Beta(1,1)/0.5; this
  // pass moves their posterior toward the outcome of the closures they
  // co-occurred in. Idempotent per (edge_id, closure_event_id).
  await creditEdgesFromClosures(db, cutoff, maxClosures, summary);

  return summary;
};
