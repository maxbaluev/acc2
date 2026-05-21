// acc2 retrieval reranker — embedding cosine × posterior × per-origin bias
// (v2-design.md §13.1 priority + K caps, §3.6.1 Rule 4 per-origin bias).
//
// Flow:
//   1. Embed the query text (live OpenAI call). If embedding fails (no API
//      key OR transient network), the caller's recency stand-in remains the
//      fallback — this function returns `hits: []` with a note so callers
//      can branch cleanly.
//   2. KNN on the in-memory index, optionally filtered by event kind.
//   3. For each hit, look up the source event's `posterior` (artifact score
//      for act_artifact_* events; promotion-derived score otherwise) and
//      the per-origin promotion bias.
//   4. Final rerank score = (1 − cosine_distance) × (1 + posterior) × bias.
//      Sort descending. Cap at `k`.
//   5. Exclude mixed-version sets: every hit must share `EMBEDDING_VERSION`
//      with the index entry; mismatches counted into `mixed_version_excluded`.
//
// The reranker is deliberately substrate-only — it never calls back to MCP.
// The brain queries retrieval via `substrate.search` (mcp_server.ts), which
// is a thin wrapper around `retrieve(...)`.

import type { Database } from "bun:sqlite";
import { computeEmbedding, EMBEDDING_VERSION } from "./embedder";
import { ARTIFACT_LIFECYCLE_KINDS } from "../substrate/event_kinds";
import type { EmbeddingIndex, IndexEntry, KnnHit } from "./embedding_index";
import { originPromotion, originPromotionByGoalShape } from "../substrate/views";
import { goalShape as computeGoalShape } from "./goal_shape";

export type RetrievalQuery = {
  text: string;
  k: number;
  /** Currently unused — runtime filtering happens at the artifact store
   *  layer, not at the event-embedding layer. Reserved for forward-compat:
   *  once code-artifact embeddings live in the same index, this will scope
   *  the KNN. */
  runtime?: string;
  /** Optional posterior floor — drop hits whose posterior is below this. */
  minScore?: number;
  /** Optional event-kind whitelist. */
  kindFilter?: string[];
  /** Optional task goal text — when present the reranker uses the
   *  per-(origin, goal_shape) bias map first, falling back to the
   *  global per-origin ratio when no shape-specific data exists. Phase H. */
  goalText?: string;
  /** Open-ended aspect routing weights. Keys are emitter-defined axes, not enums. */
  aspectWeights?: Record<string, number>;
  /** Open-ended domain routing hints. Keys are domain labels discovered from payloads. */
  domainHints?: Record<string, number>;
};

export type RetrievalHit = {
  event_id: string;
  kind: string;
  distance: number;
  posterior: number;
  rerank_score: number;
  origin: string;
  snippet: string;
  aspect_scores: Record<string, number>;
  domain_scores: Record<string, number>;
  routing_score_breakdown: Record<string, number>;
};

export type RetrievalResult = {
  hits: RetrievalHit[];
  retrieved_at: string;
  mixed_version_excluded: number;
  /** When the daemon could not produce a query embedding (no API key OR
   *  network failure), this flag tells the caller to fall back to whatever
   *  recency / lexical stand-in it has. */
  query_embedding_unavailable: boolean;
};

type RoutingQuery = Omit<RetrievalQuery, "text"> & { text?: string };

const clampBias = (r: number): number => (r < 0.5 ? 0.5 : r > 1.5 ? 1.5 : r);
const clamp01 = (r: number): number => (r < 0 ? 0 : r > 1 ? 1 : r);

const tokenize = (text: string | undefined): Set<string> => {
  const out = new Set<string>();
  for (const tok of (text ?? "").toLowerCase().split(/[^a-z0-9_:/.-]+/)) {
    if (tok.length >= 3) out.add(tok);
  }
  return out;
};

const weightedMean = (values: Record<string, number>, weights?: Record<string, number>): number => {
  const entries = Object.entries(values);
  if (entries.length === 0) return 0;
  let num = 0;
  let den = 0;
  for (const [key, value] of entries) {
    const w = Math.max(0, weights?.[key] ?? 1);
    num += clamp01(value) * w;
    den += w;
  }
  return den > 0 ? num / den : 0;
};

const scoreAspectRecord = (entry: IndexEntry, q: RoutingQuery): Record<string, number> => {
  const queryTokens = tokenize(`${q.text ?? ""} ${q.goalText ?? ""}`);
  if (queryTokens.size === 0) return {};
  const out: Record<string, number> = {};
  for (const [axis, text] of Object.entries(entry.retrieval_aspects ?? {})) {
    const tokens = tokenize(text);
    if (tokens.size === 0) continue;
    let overlap = 0;
    for (const tok of tokens) if (queryTokens.has(tok)) overlap++;
    out[axis] = clamp01(overlap / Math.min(tokens.size, Math.max(queryTokens.size, 1)));
  }
  return out;
};

const scoreDomainRecord = (entry: IndexEntry, q: RoutingQuery): Record<string, number> => {
  const hints = q.domainHints ?? {};
  const domains = entry.retrieval_domains ?? {};
  const out: Record<string, number> = {};
  for (const [domain, raw] of Object.entries(domains)) {
    const local = clamp01(Number(raw));
    const hinted = hints[domain] === undefined ? local : clamp01(local * Math.max(0, hints[domain]));
    if (hinted > 0) out[domain] = hinted;
  }
  return out;
};

/** Build a Map<origin, promotion_ratio> snapshot. Origins absent from the
 *  view default to 1.0 at the lookup site. Rows with NULL promotion_ratio
 *  (no signal: candidate_count = 0) are skipped — the view now returns
 *  NULL instead of the misleading 1.0 placeholder. Brain dataflow audit
 *  bxdhdkm9e #4 (2026-05-15). */
const readOriginBias = (db: Database): Map<string, number> => {
  const out = new Map<string, number>();
  for (const row of originPromotion(db)) {
    if (row.promotion_ratio === null || row.promotion_ratio === undefined || Number.isNaN(row.promotion_ratio)) continue;
    // Clamp into [0.5, 1.5]: a pure ratio risks washing posterior scores
    // when one origin happens to have low candidate volume. The ±0.5 band
    // keeps the bias informative without dominating the cosine signal.
    out.set(row.substrate_origin, clampBias(row.promotion_ratio));
  }
  return out;
};

/** Build a per-(origin, goal_shape) bias map for a SPECIFIC goal_shape.
 *  Falls back to the global per-origin ratio when no shape-specific row
 *  exists for an origin. Phase H — §3.6.1 Rule 4 + §18 criterion 19. */
const readOriginBiasForGoalShape = (db: Database, goalShape: string): Map<string, number> => {
  const out = new Map<string, number>();
  // Per-shape data — skip NULL promotion_ratio (no-signal rows).
  for (const row of originPromotionByGoalShape(db, computeGoalShape)) {
    if (row.goal_shape !== goalShape) continue;
    if (row.promotion_ratio === null || row.promotion_ratio === undefined || Number.isNaN(row.promotion_ratio)) continue;
    out.set(row.substrate_origin, clampBias(row.promotion_ratio));
  }
  // Fill any origin that has global data but no shape-specific row.
  for (const row of originPromotion(db)) {
    if (out.has(row.substrate_origin)) continue;
    if (row.promotion_ratio === null || row.promotion_ratio === undefined || Number.isNaN(row.promotion_ratio)) continue;
    out.set(row.substrate_origin, clampBias(row.promotion_ratio));
  }
  return out;
};

/** Cheap posterior lookup for an event. For Phase F we read the source
 *  event's `residual` (when present — lower residual = better) and convert
 *  to a posterior-shaped score in [0, 1]. Act-artifact-* event kinds get
 *  the artifact's stored `score` from the act_artifact table. Matches
 *  both canonical and pre-rename kind strings so historical events still
 *  resolve.
 *
 *  Returns 0.5 (neutral) when no signal is available — Beta(1,1) prior. */
const readPosterior = (db: Database, eventId: string, kind: string): number => {
  if (kind === "act_artifact") {
    const row = db.query("SELECT score FROM act_artifact WHERE id = ? AND runtime IS NULL AND superseded_by IS NULL").get(eventId) as { score: number } | null;
    if (row && typeof row.score === "number") return row.score;
    return 0.5;
  }
  if ((ARTIFACT_LIFECYCLE_KINDS as readonly string[]).includes(kind)) {
    // Pull the score from the registry by looking up via context_refs or
    // payload.artifact_id. We use a shape-tolerant fallback: scan the event,
    // look for an artifact_id reference, otherwise return neutral.
    const row = db
      .query("SELECT payload FROM events WHERE id = ?")
      .get(eventId) as { payload: string } | null;
    if (row?.payload) {
      try {
        const p = JSON.parse(row.payload) as Record<string, unknown>;
        const aid = (p.artifact_id as string | undefined) ?? (p.id as string | undefined);
        if (aid) {
          const ca = db
            .query("SELECT score FROM act_artifact WHERE id = ?")
            .get(aid) as { score: number } | null;
          if (ca && typeof ca.score === "number") return ca.score;
        }
      } catch { /* swallow */ }
    }
    return 0.5;
  }
  // For non-artifact events, prefer the `residual` column when present
  // (lower = better → posterior = 1 − residual).
  const row = db
    .query("SELECT residual FROM events WHERE id = ?")
    .get(eventId) as { residual: number | null } | null;
  if (row && typeof row.residual === "number") {
    const r = Math.max(0, Math.min(1, row.residual));
    return 1 - r;
  }
  return 0.5;
};

/** Pack one KnnHit into the retrieval result shape, computing the final
 *  rerank score along the way. */
const isActiveArtifactHit = (db: Database, artifactId: string): boolean => {
  const row = db.query("SELECT 1 AS ok FROM act_artifact WHERE id = ? AND runtime IS NULL AND superseded_by IS NULL AND status IN ('admitted', 'promoted') LIMIT 1").get(artifactId) as { ok: number } | null;
  return !!row;
};

const packHit = (
  db: Database,
  hit: KnnHit,
  originBias: Map<string, number>,
  q: RoutingQuery,
): RetrievalHit => {
  const posterior = readPosterior(db, hit.entry.event_id, hit.entry.kind);
  const bias = originBias.get(hit.entry.substrate_origin) ?? 1.0;
  // similarity in [0, 1] — cosine distance maps [0, 2] → [1, 0]
  const similarity = Math.max(0, 1 - hit.distance / 2);
  const aspect_scores = scoreAspectRecord(hit.entry, q);
  const domain_scores = scoreDomainRecord(hit.entry, q);
  const aspect_boost = weightedMean(aspect_scores, q.aspectWeights);
  const domain_boost = weightedMean(domain_scores, q.domainHints);
  const routing_multiplier = (1 + 0.25 * aspect_boost) * (1 + 0.25 * domain_boost);
  const rerank_score = similarity * (1 + posterior) * bias * routing_multiplier;
  return {
    event_id: hit.entry.event_id,
    kind: hit.entry.kind,
    distance: hit.distance,
    posterior,
    rerank_score,
    origin: hit.entry.substrate_origin,
    snippet: hit.entry.snippet,
    aspect_scores,
    domain_scores,
    routing_score_breakdown: {
      similarity,
      posterior,
      origin_bias: bias,
      aspect_boost,
      domain_boost,
      routing_multiplier,
    },
  };
};

/** Reranked retrieval. Embeds the query, KNN against the index, multiplies
 *  by posterior, applies per-origin bias multiplier, sorts by rerank_score
 *  descending, caps at k. */
export const retrieve = async (
  db: Database,
  index: EmbeddingIndex,
  q: RetrievalQuery,
): Promise<RetrievalResult> => {
  const retrievedAt = new Date().toISOString();
  if (q.k <= 0 || index.size() === 0) {
    return {
      hits: [],
      retrieved_at: retrievedAt,
      mixed_version_excluded: 0,
      query_embedding_unavailable: false,
    };
  }

  const queryResult = await computeEmbedding(q.text);
  if (!queryResult) {
    return {
      hits: [],
      retrieved_at: retrievedAt,
      mixed_version_excluded: 0,
      query_embedding_unavailable: true,
    };
  }
  const queryVec = new Float32Array(queryResult.embedding);
  const queryVersion = queryResult.version;
  const kindFilter = q.kindFilter && q.kindFilter.length > 0
    ? new Set(q.kindFilter)
    : null;

  let mixed_version_excluded = 0;
  const indexFilter = (entry: IndexEntry): boolean => {
    if (entry.embedding_version !== queryVersion) {
      mixed_version_excluded++;
      return false;
    }
    if (kindFilter && !kindFilter.has(entry.kind)) return false;
    if (entry.kind === "act_artifact" && !isActiveArtifactHit(db, entry.event_id)) return false;
    return true;
  };

  // Over-fetch from KNN (×3) so the rerank pass has room to reorder and
  // still meet `k`. The substrate is small; over-fetch cost is negligible.
  const overFetch = Math.max(q.k, q.k * 3);
  const knnHits = index.knn(queryVec, overFetch, indexFilter);

  const originBias = q.goalText
    ? readOriginBiasForGoalShape(db, computeGoalShape(q.goalText))
    : readOriginBias(db);
  let packed = knnHits.map((h) => packHit(db, h, originBias, q));
  if (typeof q.minScore === "number") {
    packed = packed.filter((h) => h.posterior >= q.minScore!);
  }
  packed.sort((a, b) => b.rerank_score - a.rerank_score);
  packed = packed.slice(0, q.k);

  return {
    hits: packed,
    retrieved_at: retrievedAt,
    mixed_version_excluded,
    query_embedding_unavailable: false,
  };
};

/** Pure-sync variant for tests / benchmarks: when the caller already has a
 *  query embedding (computed elsewhere or stored on a seed event), this
 *  function skips the OpenAI call entirely. Same rerank shape as
 *  `retrieve(...)`. */
export const retrieveWithEmbedding = (
  db: Database,
  index: EmbeddingIndex,
  queryEmbedding: Float32Array,
  q: Omit<RetrievalQuery, "text"> & { queryVersion?: string },
): RetrievalResult => {
  const retrievedAt = new Date().toISOString();
  if (q.k <= 0 || index.size() === 0) {
    return {
      hits: [],
      retrieved_at: retrievedAt,
      mixed_version_excluded: 0,
      query_embedding_unavailable: false,
    };
  }
  const queryVersion = q.queryVersion ?? EMBEDDING_VERSION;
  const kindFilter = q.kindFilter && q.kindFilter.length > 0
    ? new Set(q.kindFilter)
    : null;
  let mixed_version_excluded = 0;
  const indexFilter = (entry: IndexEntry): boolean => {
    if (entry.embedding_version !== queryVersion) {
      mixed_version_excluded++;
      return false;
    }
    if (kindFilter && !kindFilter.has(entry.kind)) return false;
    if (entry.kind === "act_artifact" && !isActiveArtifactHit(db, entry.event_id)) return false;
    return true;
  };
  const overFetch = Math.max(q.k, q.k * 3);
  const knnHits = index.knn(queryEmbedding, overFetch, indexFilter);
  const originBias = q.goalText
    ? readOriginBiasForGoalShape(db, computeGoalShape(q.goalText))
    : readOriginBias(db);
  let packed = knnHits.map((h) => packHit(db, h, originBias, q));
  if (typeof q.minScore === "number") {
    packed = packed.filter((h) => h.posterior >= q.minScore!);
  }
  packed.sort((a, b) => b.rerank_score - a.rerank_score);
  packed = packed.slice(0, q.k);
  return {
    hits: packed,
    retrieved_at: retrievedAt,
    mixed_version_excluded,
    query_embedding_unavailable: false,
  };
};
