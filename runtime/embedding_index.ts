// acc2 embedding index — thin wrapper around the sqlite-vec `vec_events`
// virtual table (substrate/schema.sql). Per v2-design.md §5.1 the canonical
// embedding store in v2 is sqlite-vec; this class survives as a compatibility
// surface for existing callers (`retrieve`, `retrieveWithEmbedding`, the
// daemon boot path, `mcp_server.handleSearch`, `prompt_composer`).
//
// What changed (vs the previous in-memory linear-scan implementation):
//   - The production knn path is a single SQL query against vec_events.
//     The daemon no longer materialises every 1536-dim Float32Array in
//     JS memory at boot.
//   - `rebuildFromDb` backfills vec_events from the legacy
//     `events.embedding` BLOB column for cutover-window parity, while
//     building a small metadata Map (kind / ts / origin / snippet /
//     version per entry) so callers can iterate without re-reading
//     events for filter-only purposes.
//   - Tests use non-1536 dims (typically 8) for cosine sanity. vec0
//     refuses inserts that don't match the declared dim, so the
//     wrapper transparently falls back to an in-process linear-scan
//     for those entries — kept just for test parity; production always
//     emits 1536-dim vectors through the OpenAI embedder.
//
// Why keep the class at all? Three callers depend on the API shape today
// (retrieve / retrieveWithEmbedding / prompt_composer); deleting it would
// thrash them for no semantic gain. The wrapper is ~140 LOC and keeps the
// canonical store migration self-contained. Phase G can collapse the
// wrapper after callers move to the SQL surface directly.

import type { Database } from "bun:sqlite";
import { decodeEmbeddingBlob, EMBEDDING_VERSION, upsertVecIndexRow } from "./embedder";

export type IndexEntry = {
  event_id: string;
  embedding: Float32Array;
  kind: string;
  ts: string;
  directive_id: string;
  task_id: string;
  substrate_origin: string;
  embedding_version: string;
  /** Open-ended payload-derived aspect text, e.g. claim/evidence/applies_to.
   *  Keys are not a schema; emitters may add any domain-specific axis. */
  retrieval_aspects: Record<string, string>;
  /** Open-ended domain routing weights. Values are clamped by retrieval.ts. */
  retrieval_domains: Record<string, number>;
  /** Compact preview pulled from the source event payload — used by the
   *  retrieval surface to render snippets without re-reading the row. */
  snippet: string;
};

export type KnnHit = {
  entry: IndexEntry;
  /** Cosine distance in [0, 2]. For the SQL path we read sqlite-vec's
   *  L2-on-normalised-vectors distance and convert via /2 (L2² between
   *  two unit vectors equals 2·(1 − cos)). For the JS-fallback path we
   *  compute cosine distance directly. */
  distance: number;
};

const SNIPPET_LEN = 200;

const buildSnippet = (payload: Record<string, unknown> | null | undefined): string => {
  if (!payload || typeof payload !== "object") return "";
  const candidates: Array<unknown> = [
    payload.text,
    payload.goal,
    payload.directive_text,
    payload.amendment_text,
    payload.body,
    payload.intent,
    payload.summary,
    payload.message,
    payload.claim,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) {
      return c.length > SNIPPET_LEN ? `${c.slice(0, SNIPPET_LEN)}…` : c;
    }
  }
  return "";
};

const parsePayload = (raw: unknown): Record<string, unknown> | null => {
  if (raw == null) return null;
  if (typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
  }
  return null;
};

const parseOpenRecord = (raw: unknown): Record<string, unknown> => {
  const parsed = parsePayload(raw);
  return parsed ?? {};
};

const asStringRecord = (raw: unknown, payload: Record<string, unknown> | null): Record<string, string> => {
  const source = parseOpenRecord(raw);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string" && value.trim()) out[key] = value;
    else if (Array.isArray(value) && value.length > 0) out[key] = value.map(String).join(" ");
  }
  if (Object.keys(out).length > 0 || !payload) return out;
  for (const nested of [payload.retrieval_aspects, payload.aspect_vectors]) {
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) continue;
    for (const [key, value] of Object.entries(nested as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim()) out[key] = value;
      else if (Array.isArray(value) && value.length > 0) out[key] = value.map(String).join(" ");
    }
  }
  if (Object.keys(out).length > 0) return out;
  for (const key of ["claim", "text", "summary", "insight", "evidence", "implications", "applies_to"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) out[key] = value;
    else if (Array.isArray(value) && value.length > 0) out[key] = value.map(String).join(" ");
  }
  return out;
};

const asNumberRecord = (raw: unknown, payload: Record<string, unknown> | null): Record<string, number> => {
  const source = parseOpenRecord(raw);
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(source)) {
    const n = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(n)) out[key] = n;
  }
  if (Object.keys(out).length > 0 || !payload) return out;
  for (const nested of [payload.retrieval_domains, payload.domain_vector, payload.domain_weights]) {
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) continue;
    for (const [key, value] of Object.entries(nested as Record<string, unknown>)) {
      const n = typeof value === "number" ? value : Number(value);
      if (Number.isFinite(n)) out[key] = n;
    }
  }
  if (Object.keys(out).length > 0) return out;
  const appliesTo = payload.applies_to;
  if (Array.isArray(appliesTo)) {
    for (const key of appliesTo) if (typeof key === "string" && key.trim()) out[key] = 1;
  }
  return out;
};

type Meta = Omit<IndexEntry, "embedding">;

type EventRow = {
  id: string;
  kind: string;
  ts: string;
  directive_id: string;
  task_id: string;
  substrate_origin: string;
  payload: string;
  embedding: Uint8Array | null;
  embedding_version: string | null;
  retrieval_aspects?: string | null;
  retrieval_domains?: string | null;
};

const cosineDistance = (a: Float32Array, b: Float32Array): number => {
  let dot = 0;
  let aMag = 0;
  let bMag = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ai = a[i];
    const bi = b[i];
    dot += ai * bi;
    aMag += ai * ai;
    bMag += bi * bi;
  }
  if (aMag === 0 || bMag === 0) return 2;
  const cosSim = dot / (Math.sqrt(aMag) * Math.sqrt(bMag));
  const clamped = cosSim > 1 ? 1 : cosSim < -1 ? -1 : cosSim;
  return 1 - clamped;
};

export class EmbeddingIndex {
  /** All metadata for entries currently visible to the index. Vectors
   *  that vec_events accepted (dim == 1536) are flagged `inVec = true`
   *  and queried via SQL. Entries with mismatched dims (test-only) hold
   *  their Float32Array inline so the JS-fallback knn can serve them. */
  private constructor(
    private readonly db: Database,
    private metadata: Map<string, Meta>,
    /** Entries whose vector lives in vec_events (production path). */
    private inVec: Set<string>,
    /** Test-only inline storage for entries vec_events refused (dim mismatch). */
    private jsVectors: Map<string, Float32Array>,
  ) {}

  /** Bulk-rebuild from the legacy embedding_index_view: every event
   *  with a non-null embedding BLOB gets backfilled into vec_events
   *  (if dim matches) and recorded in the metadata Map. */
  static rebuildFromDb(db: Database): EmbeddingIndex {
    const rows = db
      .query(
        "SELECT id, kind, ts, directive_id, task_id, substrate_origin, payload, embedding, embedding_version, retrieval_aspects, retrieval_domains " +
          "FROM embedding_index_view",
      )
      .all() as EventRow[];
    const metadata = new Map<string, Meta>();
    const inVec = new Set<string>();
    const jsVectors = new Map<string, Float32Array>();
    // 2026-05-21 instant-startup fix: pre-load the set of event_ids ALREADY
    // present in vec_events so the rebuild loop can SKIP re-upserting them.
    // Pre-fix, every boot re-upserted EVERY embedded vector into vec_events
    // (thousands of vec0 1536-dim inserts) even though they were already
    // persisted from their first embedding — the dominant boot CPU sink and
    // a major contributor to slow startup. vec_events is the durable vector
    // store; rebuildFromDb only needs to (a) load metadata into memory and
    // (b) backfill the FEW rows whose embedding blob exists but never made
    // it into vec_events (legacy / mid-write-crash rows).
    const alreadyInVec = new Set<string>();
    try {
      const vecRows = db.query("SELECT event_id FROM vec_events").all() as Array<{ event_id: string }>;
      for (const v of vecRows) alreadyInVec.add(v.event_id);
    } catch { /* vec_events may not exist in some test DBs; tolerate */ }
    for (const row of rows) {
      const blob = row.embedding;
      if (!blob) continue;
      const decoded = decodeEmbeddingBlob(blob);
      if (!decoded) continue;
      const version = row.embedding_version ?? EMBEDDING_VERSION;
      // Skip the vec_events upsert when the row is already present — the
      // expensive path. Only genuinely-missing rows pay the upsert cost.
      let projectedToVec = false;
      if (alreadyInVec.has(row.id)) {
        projectedToVec = true;
      } else {
        // Try to backfill vec_events. Test embeddings (dim != 1536) raise
        // a schema error; we catch and stash the vector in jsVectors so
        // the JS-fallback knn can serve them.
        try {
          upsertVecIndexRow(db, row.id, row.kind, row.ts, Array.from(decoded), version);
          projectedToVec = true;
        } catch {
          jsVectors.set(row.id, decoded);
        }
      }
      if (projectedToVec) inVec.add(row.id);
      const payload = parsePayload(row.payload);
      metadata.set(row.id, {
        event_id: row.id,
        kind: row.kind,
        ts: row.ts,
        directive_id: row.directive_id,
        task_id: row.task_id,
        substrate_origin: row.substrate_origin,
        embedding_version: version,
        retrieval_aspects: asStringRecord(row.retrieval_aspects, payload),
        retrieval_domains: asNumberRecord(row.retrieval_domains, payload),
        snippet: buildSnippet(payload),
      });
    }
    return new EmbeddingIndex(db, metadata, inVec, jsVectors);
  }

  /** Append one entry — called by tests synthesizing entries directly
   *  and by future live-add callers. The embedder worker writes via
   *  persistEmbedding (which already lands in vec_events); calling
   *  `add` after that would be a duplicate, but the upsert is
   *  idempotent so it's safe.
   *
   *  Verification: after attempting the vec_events upsert we check
   *  whether the row actually landed. upsertVecEventRow returns early
   *  if there's no matching `events` row (synthetic `add` skips the
   *  events table); in that case we stash the vector inline so knnJs
   *  can still serve it. */
  add(entry: IndexEntry): void {
    let projectedToVec = false;
    try {
      upsertVecIndexRow(this.db, entry.event_id, entry.kind, entry.ts, Array.from(entry.embedding), entry.embedding_version);
      const probe = this.db
        .query("SELECT 1 AS ok FROM vec_events WHERE event_id = ? LIMIT 1")
        .get(entry.event_id) as { ok: number } | null;
      projectedToVec = !!probe;
    } catch {
      /* vec0 refused (typically a dim mismatch for tests); fall through */
    }
    if (projectedToVec) {
      this.inVec.add(entry.event_id);
    } else {
      this.jsVectors.set(entry.event_id, entry.embedding);
    }
    this.metadata.set(entry.event_id, {
      event_id: entry.event_id,
      kind: entry.kind,
      ts: entry.ts,
      directive_id: entry.directive_id,
      task_id: entry.task_id,
      substrate_origin: entry.substrate_origin,
      embedding_version: entry.embedding_version,
      retrieval_aspects: entry.retrieval_aspects ?? {},
      retrieval_domains: entry.retrieval_domains ?? {},
      snippet: entry.snippet,
    });
  }

  /** KNN. Combines the SQL path (entries in vec_events) and the JS
   *  fallback (test-only entries with non-1536 dims). The optional
   *  `filter` predicate runs after the SQL pass; vec0 supports WHERE
   *  on kind / ts / embedding_version directly, but the legacy callback
   *  API takes arbitrary predicates so we over-fetch and post-filter. */
  knn(
    queryEmbedding: Float32Array,
    k: number,
    filter?: (e: IndexEntry) => boolean,
  ): KnnHit[] {
    if (this.metadata.size === 0 || queryEmbedding.length === 0) return [];
    const kCap = Math.max(1, Math.min(this.metadata.size, k));

    // Path selection: if the query is 1536-dim AND there is at least one
    // entry in vec_events, use the SQL path. Otherwise fall back to JS.
    const useSql = queryEmbedding.length === 1536 && this.inVec.size > 0;

    if (useSql) return this.knnSql(queryEmbedding, kCap, filter);
    return this.knnJs(queryEmbedding, kCap, filter);
  }

  private knnSql(
    queryEmbedding: Float32Array,
    kCap: number,
    filter?: (e: IndexEntry) => boolean,
  ): KnnHit[] {
    // Over-fetch ×3 so the JS-side filter has room to drop without
    // starving the caller. vec_events.k must be a positive integer.
    const fetchN = Math.max(kCap, kCap * 3);
    const vec = JSON.stringify(Array.from(queryEmbedding));
    const rows = this.db
      .query(
        "SELECT event_id, distance FROM vec_events WHERE embedding MATCH ? AND k = ? ORDER BY distance",
      )
      .all(vec, fetchN) as Array<{ event_id: string; distance: number }>;
    const hits: KnnHit[] = [];
    for (const r of rows) {
      const meta = this.metadata.get(r.event_id);
      if (!meta) continue;
      const entry: IndexEntry = {
        ...meta,
        embedding: queryEmbedding, // placeholder; callers don't use this in the SQL path
      };
      if (filter && !filter(entry)) continue;
      // sqlite-vec's default distance for float[] embeddings is L2 on the
      // raw vector. OpenAI's text-embedding-3-small returns vectors that
      // are L2-normalised, so L2² between two unit vectors = 2·(1 − cos).
      // We divide by 2 here to keep the rerank math (which expects
      // cosine_distance ∈ [0, 2]) numerically aligned.
      const distance = Math.max(0, Math.min(2, r.distance / 2));
      hits.push({ entry, distance });
      if (hits.length >= kCap) break;
    }
    return hits;
  }

  private knnJs(
    queryEmbedding: Float32Array,
    kCap: number,
    filter?: (e: IndexEntry) => boolean,
  ): KnnHit[] {
    const hits: KnnHit[] = [];
    for (const [eventId, meta] of this.metadata) {
      const vec = this.jsVectors.get(eventId);
      if (!vec) continue;
      if (vec.length !== queryEmbedding.length) continue;
      const entry: IndexEntry = { ...meta, embedding: vec };
      if (filter && !filter(entry)) continue;
      hits.push({ entry, distance: cosineDistance(queryEmbedding, vec) });
    }
    hits.sort((a, b) => a.distance - b.distance);
    return hits.slice(0, kCap);
  }

  /** Snapshot the entry list — used by tests + the retrieval surface
   *  to introspect what is currently indexed. The embedding field is
   *  populated from jsVectors when available; SQL-path entries get an
   *  empty placeholder (callers that need the vector must read the
   *  events.embedding BLOB column directly). */
  list(): IndexEntry[] {
    const out: IndexEntry[] = [];
    for (const meta of this.metadata.values()) {
      const inline = this.jsVectors.get(meta.event_id);
      out.push({ ...meta, embedding: inline ?? new Float32Array(0) });
    }
    return out;
  }

  size(): number {
    return this.metadata.size;
  }
}
