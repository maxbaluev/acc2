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
  credit_acts_scanned: number;
  credit_acts_with_residual: number;
  edges_credited: number;
  credit_pairs_skipped_dup: number;
};

const DEFAULT_MAX_CREDIT_ACTS = 300;

type CreditActRow = {
  id: string;
  ts: string;
  directive_id: string | null;
  task_id: string | null;
  payload: string | null;
};

/**
 * Resolve the truth-bearing residual for a co-citing act.
 *
 * SCOPE-MISMATCH DIAGNOSIS (2026-05-22, runtime-verified): commit 8842eea's
 * closure-correlation path credited edges by matching task_closure_audited
 * residuals to co-citation acts IN THE SAME DIRECTIVE. That found 0 edges in
 * 193 closures scanned — closures and co-citation acts live in DIFFERENT
 * directives (0 of 50 sampled closure-directives contained a ≥2-knowledge
 * cocite act). The connecting signal is that the co-citing
 * act_tuple_recorded ITSELF carries the outcome: ~347/349 cocitation acts
 * have `predicted_residual` on the tuple payload, and the projected
 * action_scored row (keyed by source_act_id / id / task_id) carries the
 * realized `residual`. So credit keys on the ACT's OWN residual.
 *
 * Resolution order:
 *   1. `predicted_residual` on the tuple payload (present on ~99% of acts).
 *   2. the latest action_scored.residual whose source_act_id matches the
 *      tuple's payload.source_act_id, the tuple event id, or task_id.
 * Returns null when neither carries a numeric residual (act is skipped).
 */
const resolveActResidual = (
  db: Database,
  act: CreditActRow,
  payload: Record<string, unknown>,
): number | null => {
  if (typeof payload.predicted_residual === "number") {
    return payload.predicted_residual;
  }
  const sourceActId =
    typeof payload.source_act_id === "string" ? payload.source_act_id : null;
  // Prefer source_act_id, then the tuple's own event id, then task_id.
  const scoredByActId = (matchId: string): number | null => {
    const row = db
      .query(
        `SELECT payload FROM events
          WHERE kind = 'action_scored'
            AND json_extract(payload, '$.source_act_id') = ?
          ORDER BY ts DESC LIMIT 1`,
      )
      .get(matchId) as { payload: string | null } | null;
    if (!row) return null;
    const p = parsePayload(row.payload);
    return typeof p.residual === "number" ? p.residual : null;
  };
  if (sourceActId) {
    const r = scoredByActId(sourceActId);
    if (r !== null) return r;
  }
  const rOwn = scoredByActId(act.id);
  if (rOwn !== null) return rOwn;
  if (act.task_id) {
    const row = db
      .query(
        `SELECT payload FROM events
          WHERE kind = 'action_scored' AND task_id = ?
          ORDER BY ts DESC LIMIT 1`,
      )
      .get(act.task_id) as { payload: string | null } | null;
    if (row) {
      const p = parsePayload(row.payload);
      if (typeof p.residual === "number") return p.residual;
    }
  }
  return null;
};

/**
 * Apply Beta credit to existing causal-edge rows from each co-citing act's
 * OWN residual.
 *
 * For each recent act_tuple_recorded with ≥2 cited_knowledge_ids (cocitation)
 * or ≥2 cited_artifact_ids (artifact), resolve the act's residual (see
 * resolveActResidual), and for each co-cited pair → its EXISTING edge row
 * apply credit:
 *   residual < 0.3 → posterior_alpha += 1 (cited together in a good outcome)
 *   residual >= 0.3 → posterior_beta  += 1
 * then recompute score = α/(α+β) and confidence (mirroring artifact_store).
 *
 * Idempotent per (edge_id, source_act_id): a causal_edge_credited event keyed
 * on both ids is the high-water-mark; a pair already credited for the same
 * act is skipped on later ticks (no double-credit). Within a single act a
 * pair is credited at most once even if it appears under both citation
 * vectors. Bounded to the last `maxActs` co-citation acts per tick.
 */
const creditEdgesFromActResiduals = async (
  db: Database,
  cutoff: string,
  maxActs: number,
  summary: CausalEdgeSummary,
): Promise<void> => {
  const acts = db
    .query(
      `SELECT id, ts, directive_id, task_id, payload FROM events
        WHERE kind = 'act_tuple_recorded' AND ts > ?
        ORDER BY ts DESC LIMIT ?`,
    )
    .all(cutoff, maxActs) as CreditActRow[];

  const LOW_RESIDUAL = 0.3;
  let processedSinceYield = 0;
  for (const act of acts) {
    if (processedSinceYield >= YIELD_EVERY_N) {
      await yieldToEventLoop();
      processedSinceYield = 0;
    }
    processedSinceYield++;

    const payload = parsePayload(act.payload);
    // Collect the distinct edges this act co-cites. A pair that appears
    // across both citation vectors on one act is credited once per act.
    // Track the full (edge_class, node_a, node_b) tuple so we can admit
    // the edge row here if the creation half hasn't seen this act yet —
    // creation scans oldest-first while credit scans newest-first, so the
    // two windows are disjoint on a large ledger (4045 acts in window vs
    // 500/300 caps). Ensuring the row here is what makes credit fire.
    const edgeTuples = new Map<string, { edgeClass: EdgeClass; a: string; b: string }>();
    for (const [a, b] of stringPairs(payload.cited_knowledge_ids)) {
      edgeTuples.set(edgeId("citation_cocitation", a, b), { edgeClass: "citation_cocitation", a, b });
    }
    for (const [a, b] of stringPairs(payload.cited_artifact_ids)) {
      edgeTuples.set(edgeId("citation_artifact", a, b), { edgeClass: "citation_artifact", a, b });
    }
    if (edgeTuples.size === 0) continue;
    summary.credit_acts_scanned++;

    const residual = resolveActResidual(db, act, payload);
    // No residual signal → no outcome to credit. Skip (the act still
    // admitted the edge row in the creation half).
    if (residual === null) continue;
    summary.credit_acts_with_residual++;

    for (const [id, tuple] of edgeTuples) {
      // Idempotency: skip if this (edge_id, source_act_id) pair was already
      // credited on a prior tick. The causal_edge_credited event is the
      // high-water-mark — keyed on both ids.
      const already = db
        .query(
          `SELECT 1 FROM events
            WHERE kind = 'causal_edge_credited'
              AND json_extract(payload, '$.edge_act_artifact_id') = ?
              AND json_extract(payload, '$.source_act_id') = ?
            LIMIT 1`,
        )
        .get(id, act.id);
      if (already) {
        summary.credit_pairs_skipped_dup++;
        continue;
      }

      // Admit the edge row if absent (disjoint creation/credit windows),
      // then read its current posterior. ensureEdgeRow is idempotent.
      ensureEdgeRow(db, tuple.edgeClass, tuple.a, tuple.b);
      const row = db
        .query(
          `SELECT posterior_alpha, posterior_beta FROM act_artifact WHERE id = ? LIMIT 1`,
        )
        .get(id) as { posterior_alpha: number; posterior_beta: number } | null;
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
        directive_id: act.directive_id ?? undefined,
        task_id: act.task_id ?? undefined,
        context_refs: [id, act.id],
        payload: {
          edge_act_artifact_id: id,
          source_act_id: act.id,
          act_residual: residual,
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
  opts?: { maxActs?: number; windowDays?: number; maxCreditActs?: number },
): Promise<CausalEdgeSummary> => {
  const maxActs = Math.max(1, opts?.maxActs ?? 500);
  const windowDays = Math.max(1, opts?.windowDays ?? 14);
  const maxCreditActs = Math.max(1, opts?.maxCreditActs ?? DEFAULT_MAX_CREDIT_ACTS);
  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const summary: CausalEdgeSummary = {
    scanned: 0,
    cocitations_recorded: 0,
    artifact_edges_recorded: 0,
    refinement_edges_recorded: 0,
    edges_admitted: 0,
    credit_acts_scanned: 0,
    credit_acts_with_residual: 0,
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

  // Credit half: apply Beta credit to existing edge rows from each
  // co-citing act's OWN residual. The creation half above admits edges at
  // Beta(1,1)/0.5; this pass moves their posterior toward the outcome the
  // act itself carries (predicted_residual on the tuple, or its projected
  // action_scored residual). Idempotent per (edge_id, source_act_id).
  //
  // This REPLACES the prior closure-correlation path (commit 8842eea),
  // which was runtime-inert: closures and co-citation acts live in
  // different directives, so directive-correlation credited 0 of 193
  // closures. The act's own residual is the connecting signal.
  await creditEdgesFromActResiduals(db, cutoff, maxCreditActs, summary);

  return summary;
};
