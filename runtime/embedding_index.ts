// acc2 embedding index — thin wrapper around the sqlite-vec `vec_events`
// virtual table (substrate/schema.sql). Per Architecture.md the canonical
// embedding store in v2 is sqlite-vec; this class survives as a compatibility
// surface for existing callers (`retrieve`, `retrieveWithEmbedding`, the
// daemon boot path, `mcp_server.handleSearch`, `prompt_composer`).
//
// Storage model (2026-05-22 on-demand-metadata refactor — owner directive):
//   - vec_events (vec0, ON-DISK) is the SOLE persistent vector store. It is
//     always-ready: the daemon does NOT rebuild any in-memory vector/metadata
//     map at boot. `rebuildFromDb` is now effectively instant — it only
//     backfills the FEW legacy events.embedding BLOB rows that never reached
//     vec_events (cutover-window / mid-write-crash parity), and never
//     pre-loads the giant per-row metadata Map that previously cost ~95s of
//     boot and ~240MB+ RSS (14GB OOM pre-cap) on the production DB.
//   - `search`/`knn` runs the vec_events MATCH knn over ALL embedded rows,
//     then fetches enrichment/rerank metadata (kind / ts / origin / aspects /
//     domains / snippet) ON-DEMAND for ONLY the K returned event_ids via one
//     batched embedding_index_view query. Memory is bounded to the K results.
//   - Tests use non-1536 dims (typically 8) for cosine sanity. vec0 refuses
//     inserts that don't match the declared dim (float[1536]); the wrapper
//     transparently stores those entries inline (`jsEntries`: Meta + vector)
//     so an in-process linear-scan can serve them. This path is test-only;
//     production always emits 1536-dim vectors through the OpenAI embedder
//     and therefore keeps an EMPTY in-memory map.

import type { Database } from "bun:sqlite";
import { decodeEmbeddingBlob, EMBEDDING_VERSION, upsertVecEventRow } from "./embedder";

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

/** Test-only inline entry: a vector vec_events refused (dim != 1536) plus its
 *  enrichment metadata. Production never populates this — every 1536-dim
 *  vector lives in vec_events and its metadata is fetched on-demand. */
type JsEntry = { meta: Meta; vec: Float32Array };

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

const rowToMeta = (row: EventRow): Meta => {
  const payload = parsePayload(row.payload);
  return {
    event_id: row.id,
    kind: row.kind,
    ts: row.ts,
    directive_id: row.directive_id,
    task_id: row.task_id,
    substrate_origin: row.substrate_origin,
    embedding_version: row.embedding_version ?? EMBEDDING_VERSION,
    retrieval_aspects: asStringRecord(row.retrieval_aspects, payload),
    retrieval_domains: asNumberRecord(row.retrieval_domains, payload),
    snippet: buildSnippet(payload),
  };
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

const METADATA_SELECT =
  "SELECT id, kind, ts, directive_id, task_id, substrate_origin, payload, embedding, " +
  "embedding_version, retrieval_aspects, retrieval_domains FROM embedding_index_view";

/** The vec0 KNN MATCH SQL — shared by the synchronous (`knnSql`) and the
 *  off-loop pooled (`knnSqlAsync`) paths so the query, k binding, and
 *  ordering are byte-identical regardless of execution thread. */
const VEC_KNN_SQL =
  "SELECT event_id, distance FROM vec_events WHERE embedding MATCH ? AND k = ? ORDER BY distance";

/** Async DB-read injected into `knnAsync` so the vec0 MATCH + on-demand
 *  metadata SELECTs run OFF the daemon's single event loop (the SQL worker
 *  pool loads sqlite-vec on its worker connections, so vec0 queries route
 *  cleanly). Same shape as `sql_pool_singleton.poolQuery`: it MUST execute
 *  `sql` with `params` against the same db and return identical rows in
 *  identical order (the pool falls back to the synchronous read on
 *  overflow/timeout, so results are byte-identical to `knnSql`). */
export type AsyncDbRead = <T = unknown>(sql: string, params: unknown[]) => Promise<T[]>;

export class EmbeddingIndex {
  private constructor(
    private readonly db: Database,
    /** Test-only inline storage for entries vec_events refused (dim mismatch).
     *  Holds both the enrichment metadata and the raw vector so the
     *  JS-fallback knn can rank and enrich them. Empty in production. */
    private jsEntries: Map<string, JsEntry>,
  ) {}

  /** Count of embedded rows in the canonical store (vec_events) plus the
   *  test-only inline entries. A fast COUNT(*) — no row materialisation. */
  private vecCount(): number {
    try {
      const r = this.db.query("SELECT COUNT(*) AS n FROM vec_events").get() as { n: number } | null;
      return r?.n ?? 0;
    } catch {
      return 0;
    }
  }

  /** Construct the index. NO heavy boot scan: vec_events is already the
   *  persistent, always-ready vector store. This only backfills the FEW
   *  legacy events.embedding BLOB rows that never reached vec_events (and,
   *  for tests, stashes dim-mismatch vectors inline). Production DBs have
   *  ~0 backfill rows, so this returns near-instantly. */
  static rebuildFromDb(db: Database): EmbeddingIndex {
    const jsEntries = new Map<string, JsEntry>();
    // Only consider rows whose embedding BLOB exists but is NOT already in
    // vec_events. The previous implementation scanned up to 40k rows (and
    // pre-fix ALL ~328k rows, ~298KB payloads, growing to 14GB RSS / OOM)
    // purely to build an in-memory metadata map. That map is gone — metadata
    // is fetched on-demand for the K knn results. The remaining backfill set
    // is the legacy/mid-write-crash rows that have a BLOB but no vec_events
    // row; on a healthy production DB that set is empty.
    let backfillRows: EventRow[] = [];
    try {
      backfillRows = db
        .query(
          `${METADATA_SELECT} v WHERE v.embedding IS NOT NULL ` +
            "AND NOT EXISTS (SELECT 1 FROM vec_events ve WHERE ve.event_id = v.id)",
        )
        .all() as EventRow[];
    } catch {
      // vec_events may be absent in some minimal test DBs; fall back to a
      // bounded scan so test seeds (dim-mismatch, never in vec_events) still
      // land in jsEntries.
      backfillRows = db.query(`${METADATA_SELECT} WHERE embedding IS NOT NULL`).all() as EventRow[];
    }
    for (const row of backfillRows) {
      const blob = row.embedding;
      if (!blob) continue;
      const decoded = decodeEmbeddingBlob(blob);
      if (!decoded) continue;
      const version = row.embedding_version ?? EMBEDDING_VERSION;
      try {
        // 1536-dim production rows backfill into vec_events (no in-memory
        // retention — served on-demand thereafter). Test rows (dim != 1536)
        // raise a schema error and fall through to the inline store.
        upsertVecEventRow(db, row.id, Array.from(decoded), version);
      } catch {
        jsEntries.set(row.id, { meta: rowToMeta(row), vec: decoded });
      }
    }
    return new EmbeddingIndex(db, jsEntries);
  }

  /** Append one entry — called by tests synthesizing entries directly
   *  and by future live-add callers. The embedder worker writes via
   *  persistEmbedding (which already lands in vec_events); calling
   *  `add` after that would be a duplicate, but the upsert is
   *  idempotent so it's safe.
   *
   *  Production (1536-dim) entries land in vec_events and are NOT retained
   *  in memory — their metadata is fetched on-demand at knn time. Entries
   *  vec_events refuses (synthetic / dim-mismatch test rows) are stashed
   *  inline so knnJs can serve them. */
  add(entry: IndexEntry): void {
    let projectedToVec = false;
    try {
      upsertVecEventRow(this.db, entry.event_id, Array.from(entry.embedding), entry.embedding_version);
      const probe = this.db
        .query("SELECT 1 AS ok FROM vec_events WHERE event_id = ? LIMIT 1")
        .get(entry.event_id) as { ok: number } | null;
      projectedToVec = !!probe;
    } catch {
      /* vec0 refused (typically a dim mismatch for tests); fall through */
    }
    if (projectedToVec) {
      // In vec_events → metadata served on-demand. Drop any stale inline copy.
      this.jsEntries.delete(entry.event_id);
      return;
    }
    this.jsEntries.set(entry.event_id, {
      meta: {
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
      },
      vec: entry.embedding,
    });
  }

  /** KNN. Combines the SQL path (vec_events) and the JS fallback (test-only
   *  entries with non-1536 dims). The optional `filter` predicate runs after
   *  the SQL pass; vec0 supports WHERE on kind / ts / embedding_version
   *  directly, but the legacy callback API takes arbitrary predicates so we
   *  over-fetch and post-filter. */
  knn(
    queryEmbedding: Float32Array,
    k: number,
    filter?: (e: IndexEntry) => boolean,
  ): KnnHit[] {
    if (queryEmbedding.length === 0 || k <= 0) return [];
    const kCap = Math.max(1, k);

    // Path selection: 1536-dim query AND vec_events has rows → SQL path.
    // Otherwise the JS fallback (test dim-mismatch entries, or no vec rows).
    if (queryEmbedding.length === 1536 && this.vecCount() > 0) {
      return this.knnSql(queryEmbedding, kCap, filter);
    }
    return this.knnJs(queryEmbedding, kCap, filter);
  }

  /** Build the vec0 MATCH params for a given over-fetch. The vector is
   *  JSON-serialised exactly as the synchronous and async paths both expect,
   *  and `fetchN` is the ×3 over-fetch so the JS-side filter has room to drop
   *  without starving the caller. vec_events.k must be a positive integer. */
  private vecKnnParams(queryEmbedding: Float32Array, kCap: number): unknown[] {
    const fetchN = Math.max(kCap, kCap * 3);
    const vec = JSON.stringify(Array.from(queryEmbedding));
    return [vec, fetchN];
  }

  /** Assemble KnnHits from the raw vec0 result rows + the on-demand metadata
   *  rows. Pure (no DB access) so the synchronous and pooled paths produce
   *  byte-identical hits — same ordering, same distance math, same filter
   *  semantics, same kCap truncation. */
  private assembleHits(
    queryEmbedding: Float32Array,
    kCap: number,
    vecRows: Array<{ event_id: string; distance: number }>,
    metaRows: EventRow[],
    filter?: (e: IndexEntry) => boolean,
  ): KnnHit[] {
    const metaById = new Map<string, Meta>();
    for (const mr of metaRows) metaById.set(mr.id, rowToMeta(mr));

    const hits: KnnHit[] = [];
    for (const r of vecRows) {
      const meta = metaById.get(r.event_id);
      if (!meta) continue;
      const entry: IndexEntry = {
        ...meta,
        embedding: queryEmbedding, // placeholder; SQL-path callers don't use this
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

  private knnSql(
    queryEmbedding: Float32Array,
    kCap: number,
    filter?: (e: IndexEntry) => boolean,
  ): KnnHit[] {
    const vecParams = this.vecKnnParams(queryEmbedding, kCap);
    const rows = this.db
      .query(VEC_KNN_SQL)
      .all(...vecParams) as Array<{ event_id: string; distance: number }>;
    if (rows.length === 0) return [];

    // ON-DEMAND metadata: one batched query for ONLY the K knn result ids.
    // This is the entire memory footprint — no pre-loaded 40k map.
    const ids = rows.map((r) => r.event_id);
    const placeholders = ids.map(() => "?").join(", ");
    const metaRows = this.db
      .query(`${METADATA_SELECT} WHERE id IN (${placeholders})`)
      .all(...ids) as EventRow[];
    return this.assembleHits(queryEmbedding, kCap, rows, metaRows, filter);
  }

  /** Off-loop variant of `knnSql`: routes BOTH vec0 SELECTs (the MATCH and
   *  the on-demand metadata IN-query) through `read`, which the daemon wires
   *  to the SQL worker pool (sqlite-vec is loaded on the pool's worker
   *  connections, so vec0 routes cleanly). The SQL strings, params, k binding,
   *  distance math, filter semantics, and kCap truncation are identical to
   *  `knnSql`, so the returned hits are byte-identical — only the execution
   *  thread of the two SELECTs moved off the daemon's single event loop.
   *  The vec0 MATCH over the embedding index was the ~11s loop blocker on
   *  substrate.search; the JS-side filter callback (cheap point reads) stays
   *  on the main thread, matching the synchronous path exactly. */
  private async knnSqlAsync(
    queryEmbedding: Float32Array,
    kCap: number,
    read: AsyncDbRead,
    filter?: (e: IndexEntry) => boolean,
  ): Promise<KnnHit[]> {
    const vecParams = this.vecKnnParams(queryEmbedding, kCap);
    const rows = await read<{ event_id: string; distance: number }>(VEC_KNN_SQL, vecParams);
    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.event_id);
    const placeholders = ids.map(() => "?").join(", ");
    const metaRows = await read<EventRow>(`${METADATA_SELECT} WHERE id IN (${placeholders})`, ids);
    return this.assembleHits(queryEmbedding, kCap, rows, metaRows, filter);
  }

  /** Async KNN. Identical path selection to `knn`, but the SQL (vec_events)
   *  branch runs OFF the event loop through `read`. The JS-fallback branch
   *  (test dim-mismatch entries / no vec rows) has no DB work, so it is run
   *  inline and wrapped in a resolved promise. Results are byte-identical to
   *  `knn(queryEmbedding, k, filter)` — same query, same k, same ordering. */
  async knnAsync(
    queryEmbedding: Float32Array,
    k: number,
    read: AsyncDbRead,
    filter?: (e: IndexEntry) => boolean,
  ): Promise<KnnHit[]> {
    if (queryEmbedding.length === 0 || k <= 0) return [];
    const kCap = Math.max(1, k);
    if (queryEmbedding.length === 1536 && this.vecCount() > 0) {
      return this.knnSqlAsync(queryEmbedding, kCap, read, filter);
    }
    return this.knnJs(queryEmbedding, kCap, filter);
  }

  private knnJs(
    queryEmbedding: Float32Array,
    kCap: number,
    filter?: (e: IndexEntry) => boolean,
  ): KnnHit[] {
    const hits: KnnHit[] = [];
    for (const { meta, vec } of this.jsEntries.values()) {
      if (vec.length !== queryEmbedding.length) continue;
      const entry: IndexEntry = { ...meta, embedding: vec };
      if (filter && !filter(entry)) continue;
      hits.push({ entry, distance: cosineDistance(queryEmbedding, vec) });
    }
    hits.sort((a, b) => a.distance - b.distance);
    return hits.slice(0, kCap);
  }

  /** Snapshot the test-only inline entries — used by tests to introspect
   *  what was loaded via the dim-mismatch fallback. Production vec_events
   *  rows are NOT enumerated here (no in-memory copy exists; query
   *  embedding_index_view directly if a full enumeration is ever needed). */
  list(): IndexEntry[] {
    const out: IndexEntry[] = [];
    for (const { meta, vec } of this.jsEntries.values()) {
      out.push({ ...meta, embedding: vec });
    }
    return out;
  }

  reloadFromDb(): void {
    const fresh = EmbeddingIndex.rebuildFromDb(this.db);
    this.jsEntries = fresh.jsEntries;
  }

  /** Embedded-row count. Reflects the canonical vec_events store (a fast
   *  COUNT) plus any test-only inline entries. Callers gate retrieval on
   *  `size() > 0` — with vec_events always-ready this is true whenever the
   *  on-disk index has any rows, regardless of in-memory state. */
  size(): number {
    return this.vecCount() + this.jsEntries.size;
  }
}
