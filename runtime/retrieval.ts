// acc2 retrieval reranker — embedding cosine × posterior × per-origin bias
// (Architecture.md priority + K caps, §3.6.1 Rule 4 per-origin bias).
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
import { EMBEDDING_VERSION } from "./embedder";
import { getCachedQueryEmbedding } from "./embedding_cache";
import { ARTIFACT_LIFECYCLE_KINDS } from "../substrate/event_kinds";
import type { EmbeddingIndex, IndexEntry, KnnHit } from "./embedding_index";
import { originPromotion, originPromotionByGoalShape } from "../substrate/views";
import { goalShape as computeGoalShape } from "./goal_shape";
import { poolQuery } from "./sql_pool_singleton";

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

// Off-loop origin-bias readers. The sync `readOriginBias` /
// `readOriginBiasForGoalShape` above call substrate views that issue
// SYNCHRONOUS SELECTs on the daemon's single event loop. During a live
// dispatch `retrieve` is on the loop's critical path and runs these twice
// (knowledge + artifacts), so the by-goal-shape variant's three reads
// (directive_opened payloads + two kind-grouped COUNTs) block the loop. The
// async variants below issue the EXACT same SQL the views run — index-served
// (SEARCH events USING INDEX idx_events_kind_ts, NOT a full SCAN) and bounded
// to the row count of those specific kinds — through `poolQuery`, so they run
// on the SQL worker thread. The JS aggregation (goal-shape hashing, per-key
// roll-up, clamp) is replicated byte-for-byte from substrate/views.ts so the
// resulting bias map is identical to the sync path; only the SELECT execution
// thread moves off the dispatch-critical loop. Fail-soft: poolQuery degrades
// to the identical sync read when no pool is installed (unit tests).
const ORIGIN_PROMOTION_VIEW_SQL = "SELECT * FROM origin_promotion_view";
const DIRECTIVE_OPENED_SQL = "SELECT directive_id, payload FROM events WHERE kind = 'directive_opened'";
const KNOWLEDGE_CANDIDATE_GROUP_SQL =
  "SELECT substrate_origin, directive_id, COUNT(*) AS c FROM events WHERE kind = 'knowledge_candidate' GROUP BY substrate_origin, directive_id";
const KNOWLEDGE_PROMOTED_GROUP_SQL =
  "SELECT substrate_origin, directive_id, COUNT(*) AS c FROM events WHERE kind = 'knowledge_promoted' GROUP BY substrate_origin, directive_id";

/** Off-loop equivalent of `originPromotion(db)` (substrate/views.ts). Same
 *  view, same NULL-promotion_ratio skip + clamp, executed on the SQL worker. */
const readOriginBiasPooled = async (db: Database): Promise<Map<string, number>> => {
  const out = new Map<string, number>();
  const rows = await poolQuery<{ substrate_origin: string; promotion_ratio: number | null }>(db, ORIGIN_PROMOTION_VIEW_SQL);
  for (const row of rows) {
    if (row.promotion_ratio === null || row.promotion_ratio === undefined || Number.isNaN(row.promotion_ratio)) continue;
    out.set(row.substrate_origin, clampBias(row.promotion_ratio));
  }
  return out;
};

/** Off-loop equivalent of `originPromotionByGoalShape(db, goalShape)`
 *  (substrate/views.ts:6060). Replicates the three-read + JS-aggregation logic
 *  exactly, routing each SELECT through `poolQuery` so the daemon loop is not
 *  blocked. Filters to the requested goal_shape, falling back to the global
 *  per-origin ratio for origins that have global data but no shape-specific
 *  row — identical fallback to the sync path. */
const readOriginBiasForGoalShapePooled = async (db: Database, goalShape: string): Promise<Map<string, number>> => {
  const out = new Map<string, number>();
  // Step 1 — directive_id → goal_shape map (same hashing as the view).
  const directives = await poolQuery<{ directive_id: string; payload: string }>(db, DIRECTIVE_OPENED_SQL);
  const directiveToShape = new Map<string, string>();
  for (const d of directives) {
    let goal = "";
    try {
      const p = JSON.parse(d.payload) as { goal?: unknown; intent?: unknown; directive_text?: unknown };
      goal = String((p.goal ?? p.intent ?? p.directive_text ?? "") as string);
    } catch { /* malformed payload — empty shape */ }
    directiveToShape.set(d.directive_id, computeGoalShape(goal));
  }
  // Step 2 — per-(origin, directive) candidate + promotion counts.
  const candidates = await poolQuery<{ substrate_origin: string; directive_id: string; c: number }>(db, KNOWLEDGE_CANDIDATE_GROUP_SQL);
  const promotions = await poolQuery<{ substrate_origin: string; directive_id: string; c: number }>(db, KNOWLEDGE_PROMOTED_GROUP_SQL);
  // Step 3 — aggregate per (origin, goal_shape), then emit ratio rows.
  const candMap = new Map<string, number>();
  const promMap = new Map<string, number>();
  const emptyShape = computeGoalShape("");
  for (const c of candidates) {
    const shape = directiveToShape.get(c.directive_id) ?? emptyShape;
    const key = `${c.substrate_origin}::${shape}`;
    candMap.set(key, (candMap.get(key) ?? 0) + c.c);
  }
  for (const p of promotions) {
    const shape = directiveToShape.get(p.directive_id) ?? emptyShape;
    const key = `${p.substrate_origin}::${shape}`;
    promMap.set(key, (promMap.get(key) ?? 0) + p.c);
  }
  const seenKeys = new Set<string>([...candMap.keys(), ...promMap.keys()]);
  for (const key of seenKeys) {
    const sep = key.indexOf("::");
    const origin = key.slice(0, sep);
    const shape = key.slice(sep + 2);
    if (shape !== goalShape) continue;
    const cand = candMap.get(key) ?? 0;
    const prom = promMap.get(key) ?? 0;
    const ratio = cand === 0 ? 1.0 : prom / cand;
    if (Number.isNaN(ratio)) continue;
    out.set(origin, clampBias(ratio));
  }
  // Fill origins with global data but no shape-specific row (sync-path parity).
  const globalRows = await poolQuery<{ substrate_origin: string; promotion_ratio: number | null }>(db, ORIGIN_PROMOTION_VIEW_SQL);
  for (const row of globalRows) {
    if (out.has(row.substrate_origin)) continue;
    if (row.promotion_ratio === null || row.promotion_ratio === undefined || Number.isNaN(row.promotion_ratio)) continue;
    out.set(row.substrate_origin, clampBias(row.promotion_ratio));
  }
  return out;
};

// Posterior-lookup SQL — shared verbatim between the sync and pooled
// variants so both paths execute byte-identical statements against the same
// db handle. Only the EXECUTION THREAD differs (main loop vs. SQL worker);
// rows, ordering, and scoring are unchanged.
const POSTERIOR_ARTIFACT_SCORE_SQL =
  "SELECT score FROM act_artifact WHERE id = ? AND runtime IS NULL AND superseded_by IS NULL";
const POSTERIOR_EVENT_PAYLOAD_SQL = "SELECT payload FROM events WHERE id = ?";
const POSTERIOR_ARTIFACT_BY_ID_SQL = "SELECT score FROM act_artifact WHERE id = ?";
const POSTERIOR_EVENT_RESIDUAL_SQL = "SELECT residual FROM events WHERE id = ?";

/** Convert a posterior payload-scan row into a score in [0, 1]; shared by
 *  both the sync and pooled posterior readers so the branch logic is single-
 *  sourced and the two paths cannot drift. */
const artifactIdFromPayload = (payload: string | undefined): string | null => {
  if (!payload) return null;
  try {
    const p = JSON.parse(payload) as Record<string, unknown>;
    return (p.artifact_id as string | undefined) ?? (p.id as string | undefined) ?? null;
  } catch {
    return null;
  }
};

const residualToPosterior = (residual: number | null | undefined): number => {
  if (typeof residual === "number") {
    const r = Math.max(0, Math.min(1, residual));
    return 1 - r;
  }
  return 0.5;
};

/** Cheap posterior lookup for an event — SYNCHRONOUS core. For Phase F we
 *  read the source event's `residual` (when present — lower residual =
 *  better) and convert to a posterior-shaped score in [0, 1]. Act-artifact-*
 *  event kinds get the artifact's stored `score` from the act_artifact table.
 *  Matches both canonical and pre-rename kind strings so historical events
 *  still resolve.
 *
 *  Returns 0.5 (neutral) when no signal is available — Beta(1,1) prior.
 *
 *  Used by the pure-sync `retrieveWithEmbedding` variant (tests/benchmarks).
 *  The async `retrieve` path uses `readPosteriorPooled` instead so the point
 *  reads execute off the main event loop during a live dispatch. */
const readPosterior = (db: Database, eventId: string, kind: string): number => {
  if (kind === "act_artifact") {
    const row = db.query(POSTERIOR_ARTIFACT_SCORE_SQL).get(eventId) as { score: number } | null;
    if (row && typeof row.score === "number") return row.score;
    return 0.5;
  }
  if ((ARTIFACT_LIFECYCLE_KINDS as readonly string[]).includes(kind)) {
    // Pull the score from the registry by looking up via context_refs or
    // payload.artifact_id. We use a shape-tolerant fallback: scan the event,
    // look for an artifact_id reference, otherwise return neutral.
    const row = db.query(POSTERIOR_EVENT_PAYLOAD_SQL).get(eventId) as { payload: string } | null;
    const aid = artifactIdFromPayload(row?.payload);
    if (aid) {
      const ca = db.query(POSTERIOR_ARTIFACT_BY_ID_SQL).get(aid) as { score: number } | null;
      if (ca && typeof ca.score === "number") return ca.score;
    }
    return 0.5;
  }
  // For non-artifact events, prefer the `residual` column when present
  // (lower = better → posterior = 1 − residual).
  const row = db.query(POSTERIOR_EVENT_RESIDUAL_SQL).get(eventId) as { residual: number | null } | null;
  return residualToPosterior(row?.residual);
};

/** Off-loop posterior lookup — same SQL, same db handle, same branch logic
 *  as `readPosterior`, but each point read is routed through `poolQuery` so
 *  it runs on the SQL worker thread when the daemon installed a pool (and
 *  falls back to the identical sync read otherwise). Because `poolQuery`
 *  issues the exact same statement against the exact same db, the returned
 *  row is byte-identical to the sync path — only the execution thread moves
 *  off the dispatch-critical main loop. */
const readPosteriorPooled = async (db: Database, eventId: string, kind: string): Promise<number> => {
  if (kind === "act_artifact") {
    const rows = await poolQuery<{ score: number }>(db, POSTERIOR_ARTIFACT_SCORE_SQL, [eventId]);
    const row = rows[0] ?? null;
    if (row && typeof row.score === "number") return row.score;
    return 0.5;
  }
  if ((ARTIFACT_LIFECYCLE_KINDS as readonly string[]).includes(kind)) {
    const rows = await poolQuery<{ payload: string }>(db, POSTERIOR_EVENT_PAYLOAD_SQL, [eventId]);
    const aid = artifactIdFromPayload(rows[0]?.payload);
    if (aid) {
      const caRows = await poolQuery<{ score: number }>(db, POSTERIOR_ARTIFACT_BY_ID_SQL, [aid]);
      const ca = caRows[0] ?? null;
      if (ca && typeof ca.score === "number") return ca.score;
    }
    return 0.5;
  }
  const rows = await poolQuery<{ residual: number | null }>(db, POSTERIOR_EVENT_RESIDUAL_SQL, [eventId]);
  return residualToPosterior(rows[0]?.residual);
};

/** Active-artifact membership check. Deliberately SYNCHRONOUS: it runs inside
 *  the `index.knn` filter callback, and `knnSql` stops over-fetching once the
 *  filter has admitted `kCap` hits (`if (hits.length >= kCap) break;`). The
 *  predicate is therefore CAP-COUPLED — which entries it rejects determines
 *  which entries reach the result set. Moving it off-loop would require an
 *  async knn filter, which would change WHICH hits survive the cap and break
 *  byte-identical results. It is a `LIMIT 1` primary-key point read (not a
 *  table scan), so it does not contribute the heavy-scan loop stall this fix
 *  targets — leaving it sync is both correct and cheap. */
const isActiveArtifactHit = (db: Database, artifactId: string): boolean => {
  const row = db.query("SELECT 1 AS ok FROM act_artifact WHERE id = ? AND runtime IS NULL AND superseded_by IS NULL AND status IN ('admitted', 'promoted') LIMIT 1").get(artifactId) as { ok: number } | null;
  return !!row;
};

/** Assemble a RetrievalHit from a KnnHit and a pre-computed posterior. Pure
 *  arithmetic — no db access — so the sync and pooled pack variants share the
 *  EXACT scoring/ordering logic and differ only in HOW the posterior was
 *  fetched (sync `db.query` vs. off-loop `poolQuery`). This guarantees the two
 *  paths produce byte-identical hits. */
const assembleHit = (
  hit: KnnHit,
  posterior: number,
  originBias: Map<string, number>,
  q: RoutingQuery,
): RetrievalHit => {
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

/** Synchronous pack — used by `retrieveWithEmbedding`. */
const packHit = (
  db: Database,
  hit: KnnHit,
  originBias: Map<string, number>,
  q: RoutingQuery,
): RetrievalHit => assembleHit(hit, readPosterior(db, hit.entry.event_id, hit.entry.kind), originBias, q);

/** Off-loop pack — used by the async `retrieve` path. The posterior point
 *  reads run on the SQL worker thread (sync fallback when no pool) so they no
 *  longer block the dispatch-critical main event loop. */
const packHitPooled = async (
  db: Database,
  hit: KnnHit,
  originBias: Map<string, number>,
  q: RoutingQuery,
): Promise<RetrievalHit> =>
  assembleHit(hit, await readPosteriorPooled(db, hit.entry.event_id, hit.entry.kind), originBias, q);

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

  // Query embedding is a pure deterministic function of (text, model, dims,
  // version) — no ledger state — so it is safely keyed-cached (compounding
  // lever #4) to avoid re-paying the OpenAI round-trip for a repeated query.
  const queryResult = await getCachedQueryEmbedding(db, q.text);
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
  // Off-loop the vec0 KNN. The sqlite-vec MATCH over the embedding index ran
  // SYNCHRONOUSLY on the daemon's single event loop here, blocking it ~11s
  // during substrate.search (profiling: event_loop_blocked lag_ms=11140).
  // knnAsync routes BOTH vec0 SELECTs (the MATCH + the on-demand metadata
  // IN-query) through poolQuery; the SQL worker pool loads sqlite-vec on its
  // worker connections, so vec0 routes cleanly and the loop stays free. The
  // pool falls back to the synchronous read on overflow/timeout, and the SQL,
  // params, k binding, distance math, and filter semantics are identical, so
  // `knnHits` is byte-identical to the synchronous `index.knn(...)`.
  const knnHits = await index.knnAsync(
    queryVec,
    overFetch,
    (sql, params) => poolQuery(db, sql, params),
    indexFilter,
  );

  // Off-loop the origin-bias reads (the only remaining SYNCHRONOUS event-table
  // reads on the dispatch-critical loop in this path). The by-goal-shape
  // variant ran three index-served SELECTs + JS aggregation synchronously on
  // every retrieve (twice per dispatch); the pooled variant issues the exact
  // same SQL on the SQL worker thread and replicates the aggregation byte-for-
  // byte, so the bias map is identical. Sync fallback when no pool is present.
  const originBias = q.goalText
    ? await readOriginBiasForGoalShapePooled(db, computeGoalShape(q.goalText))
    : await readOriginBiasPooled(db);
  // Off-loop the per-hit posterior point reads. `Promise.all` preserves array
  // order, and each pooled read issues the same SQL against the same db as the
  // sync path, so `packed` is byte-identical to the synchronous map below —
  // only the execution thread of the SELECTs moved off the dispatch loop.
  let packed = await Promise.all(knnHits.map((h) => packHitPooled(db, h, originBias, q)));
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
