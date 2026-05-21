// acc2 embedder — wraps the OpenAI text-embedding-3-small endpoint and the
// daemon's background "embed every text-bearing event" worker tick.
//
// Per v2-design.md §5 and §20 question 1 (resolved: `text-embedding-3-small`
// via `OPENAI_API_KEY`). Tests mock `globalThis.fetch` so we never hit the
// real OpenAI API in CI. Production deployments set OPENAI_API_KEY in env.
//
// Version stamping (v2-design.md §19 risk 16):
//   Every stored embedding row carries `embedding_version` alongside the
//   BLOB column. The reranker excludes mixed-version sets — when we change
//   model or dimensions, bump EMBEDDING_VERSION and stale rows fall out of
//   retrieval until re-embedded. We picked the COLUMN approach (not a
//   header byte in the BLOB) because: (a) it indexes cleanly so future
//   migrations can scan by version without parsing the BLOB, (b) the
//   reranker filters by SQL predicate rather than reading every BLOB header,
//   and (c) the schema change is one column + one index — small enough not
//   to warrant the more compact but harder-to-query header byte approach.
//
// Worker tick is idempotent — it picks events whose `embedding IS NULL` and
// kind is in the embeddable set, never re-embeds an existing row. Each
// successful embed emits one `embedding_computed` event referencing the
// source event id.

import type { Database } from "bun:sqlite";
import type { Event, JsonValue } from "../substrate/types";
import { EMBEDDABLE_KINDS as REGISTRY_EMBEDDABLE_KINDS } from "../substrate/event_kinds";
import { emitEvent } from "./events";
import { logger } from "./logger";
import { recordEmbedding } from "./metrics";

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMS = 1536;
export const EMBEDDING_VERSION = "v1"; // bump when model or dim changes

/** Event kinds whose payload text we embed. Derived from the canonical
 *  registry (`substrate/event_kinds.ts`) so adding `embeddable: true` to
 *  a kind there propagates here without a second list to keep in sync.
 *  Other kinds are structural control-flow events with no useful
 *  embedding surface. */
export const EMBEDDABLE_KINDS: ReadonlySet<string> = new Set<string>(
  REGISTRY_EMBEDDABLE_KINDS,
);

export type EmbeddingResult = { embedding: number[]; version: string };

const getApiConfig = (): { apiKey: string; baseUrl: string } | null => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  return { apiKey, baseUrl };
};

/** Encode a number[] embedding as a raw float32 little-endian BLOB. The
 *  events table stores embeddings this way so sqlite-vec virtual tables (if
 *  we add them later) can mmap them directly. */
export const encodeEmbeddingBlob = (embedding: number[]): Uint8Array => {
  const buf = new Float32Array(embedding.length);
  for (let i = 0; i < embedding.length; i++) buf[i] = embedding[i];
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
};

/** Decode a stored BLOB back into a Float32Array. Length-checked; returns
 *  null if the byte length is not a multiple of 4 OR the input is null/empty.
 *  Tolerates non-aligned views — copies bytes into an aligned buffer before
 *  constructing the Float32Array. Used by both the embedder worker and
 *  substrate/extractors.ts (Model D similarity scoring). */
export const decodeEmbeddingBlob = (blob: Uint8Array | null): Float32Array | null => {
  if (!blob || blob.byteLength === 0) return null;
  if (blob.byteLength % 4 !== 0) return null;
  // Make a properly-aligned copy in case the BLOB straddles a non-aligned
  // offset (sqlite-vec / Bun sometimes returns subarray views).
  const aligned = new Uint8Array(blob.byteLength);
  aligned.set(blob);
  return new Float32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 4);
};

/** Compute one embedding via the OpenAI API. Returns null on missing
 *  credentials OR network/HTTP error — the caller decides whether to
 *  degrade. We deliberately do not throw: the embedder worker should
 *  continue past one bad event rather than crash the daemon. */
/** Per-request OpenAI fetch deadline. Native Bun/Node fetch has NO default
 *  timeout — a hung OpenAI endpoint would hang the embedder worker
 *  indefinitely, blocking every subsequent embedding job. 30s is comfortably
 *  above OpenAI's published p99 (typically 1-3s for text-embedding-3-small
 *  on 100-item batches) while still failing fast on a genuine wedge. */
const EMBED_FETCH_TIMEOUT_MS = 30_000;

export const computeEmbedding = async (
  text: string,
): Promise<EmbeddingResult | null> => {
  const config = getApiConfig();
  if (!config) return null;
  try {
    const response = await fetch(`${config.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: text, dimensions: EMBEDDING_DIMS }),
      signal: AbortSignal.timeout(EMBED_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { data?: Array<{ embedding: number[] }> };
    const embedding = data.data?.[0]?.embedding;
    if (!embedding) return null;
    return { embedding, version: EMBEDDING_VERSION };
  } catch {
    return null;
  }
};

const BATCH_SIZE = 100;
const MAX_EMBEDDING_TEXT_CHARS = 12_000;

const boundEmbeddingText = (text: string): string => {
  const trimmed = text.trim();
  return trimmed.length > MAX_EMBEDDING_TEXT_CHARS ? trimmed.slice(0, MAX_EMBEDDING_TEXT_CHARS) : trimmed;
};

/** Batch variant — chunks at 100 items per OpenAI request (the documented
 *  per-request input cap). On any chunk failure the surviving keys remain in
 *  the returned Map; missing keys signal failure to the caller. */
export const batchComputeEmbeddings = async (
  items: { id: string; text: string }[],
): Promise<Map<string, number[]>> => {
  const result = new Map<string, number[]>();
  if (items.length === 0) return result;
  const config = getApiConfig();
  if (!config) return result;

  for (let offset = 0; offset < items.length; offset += BATCH_SIZE) {
    const slice = items.slice(offset, offset + BATCH_SIZE);
    try {
      const response = await fetch(`${config.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: EMBEDDING_MODEL,
          input: slice.map((i) => boundEmbeddingText(i.text)),
          dimensions: EMBEDDING_DIMS,
        }),
        signal: AbortSignal.timeout(EMBED_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) continue;
      const data = (await response.json()) as { data?: Array<{ embedding: number[]; index: number }> };
      if (!data.data) continue;
      for (const entry of data.data) {
        if (entry.index >= 0 && entry.index < slice.length) {
          result.set(slice[entry.index].id, entry.embedding);
        }
      }
    } catch {
      /* swallow — surviving chunks already in result; missing keys = failed */
    }
  }
  return result;
};

/** Extract the embedding-target text from one event row payload. Returns
 *  null when the kind isn't embeddable or no text-like field is present.
 *  v2-design.md §5.2: external-pushed events wrap their payload in a
 *  `data: { ... }` envelope under `payload.data`; we look there too so an
 *  ingested external event becomes first-class for retrieval just like
 *  brain-emitted rows. */
export const extractTextFromEvent = (kind: string, payload: unknown): string | null => {
  if (!EMBEDDABLE_KINDS.has(kind)) return null;
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const candidates: Array<string | undefined> = [
    p.text as string | undefined,
    p.goal as string | undefined,
    p.directive_text as string | undefined,
    p.amendment_text as string | undefined,
    p.body as string | undefined,
    p.intent as string | undefined,
    p.summary as string | undefined,
    p.message as string | undefined,
    p.claim as string | undefined,
    // contract_amendment_proposed / lesson_extracted carry payload.current_behavior
    // (the audit trail snapshot) — useful for retrieval when the diff itself is
    // structured.
    p.current_behavior as string | undefined,
  ];
  // contract_amendment_proposed.proposed_behavior shape (the canonical
  // anchored_replace_v1 structure): pick the most semantic-rich pieces.
  // Most brain proposals carry either a string (prose direction) or an
  // object { file_path, anchor, diff: { kind, before, after } }. We
  // surface the `after` text since that's "what the amendment WILL look
  // like" — most descriptive for retrieval. Falls back to the wrapping
  // anchor/path when no diff text exists.
  const proposed = p.proposed_behavior ?? p.proposed_action;
  if (typeof proposed === "string") {
    candidates.push(proposed);
  } else if (proposed && typeof proposed === "object") {
    const pb = proposed as Record<string, unknown>;
    const diff = pb.diff;
    if (typeof diff === "string") candidates.push(diff);
    else if (diff && typeof diff === "object") {
      const d = diff as Record<string, unknown>;
      candidates.push(d.after as string | undefined, d.before as string | undefined);
    }
    candidates.push(pb.anchor as string | undefined, pb.file_path as string | undefined);
  }
  // External-push envelope: payload.data.{summary|text|body|message|...}.
  const data = p.data as Record<string, unknown> | undefined;
  if (data && typeof data === "object") {
    candidates.push(
      data.text as string | undefined,
      data.summary as string | undefined,
      data.body as string | undefined,
      data.message as string | undefined,
      data.title as string | undefined,
      data.description as string | undefined,
    );
  }
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return boundEmbeddingText(c);
  }
  return null;
};

type UnembeddedRow = { id: string; kind: string; payload: string; source: "event" | "artifact" };

/** Resolve the embedding text for one event row, including cross-table joins
 *  for kinds where the truth-bearing text lives on a different row. Called by
 *  the worker tick after extractTextFromEvent comes up empty — gives us one
 *  retry path before marking the row text-less. Currently handles:
 *    - knowledge_promoted: payload carries candidate_id pointing at the
 *      original knowledge_candidate; that row's payload.claim is the truth.
 *      Without this join, every promoted row would be sentinel'd (the
 *      promotion event itself records metadata, not the claim text). */
const resolveJoinedText = (db: Database, kind: string, payload: Record<string, unknown>): string | null => {
  if (kind === "knowledge_promoted") {
    const candidateId = (payload.candidate_id as string | undefined) ?? (() => {
      const refs = payload.context_refs as unknown;
      if (Array.isArray(refs) && refs.length > 0 && typeof refs[0] === "string") return refs[0] as string;
      return undefined;
    })();
    if (!candidateId) return null;
    const row = db
      .query("SELECT payload FROM events WHERE id = ? AND kind = 'knowledge_candidate' LIMIT 1")
      .get(candidateId) as { payload: string } | null;
    if (!row) return null;
    try {
      const p = JSON.parse(row.payload ?? "{}") as Record<string, unknown>;
      return extractTextFromEvent("knowledge_candidate", p);
    } catch {
      return null;
    }
  }
  return null;
};

// T3.8/T5: readUnembedded now returns a Promise so the heavy SELECT can
// route through the SQL worker-thread pool when present. Bun.SQL is
// fake-async; this SELECT scans the events table by (embedding IS NULL,
// kind IN (...)) which on a 270K-row substrate takes 30-90ms of fully
// synchronous work. Routing through worker_threads frees the main loop
// for emitEvent + MCP IO. The sync fallback path stays correct for unit
// tests and ACC2_DISABLE_SQL_POOL=1 diagnostics.
const readUnembeddedEvents = async (db: Database, batchSize: number): Promise<UnembeddedRow[]> => {
  const placeholders = Array.from(EMBEDDABLE_KINDS).map(() => "?").join(", ");
  const sql =
    `SELECT id, kind, payload, 'event' AS source FROM events ` +
    `WHERE embedding IS NULL AND kind IN (${placeholders}) ` +
    `ORDER BY ts ASC LIMIT ?`;
  const params: unknown[] = [...Array.from(EMBEDDABLE_KINDS), batchSize];
  try {
    const poolMod = await import("./sql_pool_singleton");
    const pool = poolMod.getSqlPool();
    if (pool) return pool.query<UnembeddedRow>(sql, params);
  } catch { /* tolerate — fall through */ }
  return db.query(sql).all(...params) as UnembeddedRow[];
};

const readUnembeddedArtifacts = (db: Database, batchSize: number): UnembeddedRow[] => {
  return db
    .query(
      `SELECT
         id,
         'act_artifact' AS kind,
         json_object('body', body, 'intent', intent, 'summary', summary, 'name', name) AS payload,
         'artifact' AS source
       FROM act_artifact
       WHERE embedding IS NULL
         AND runtime IS NULL
         AND superseded_by IS NULL
         AND status IN ('admitted', 'promoted')
       ORDER BY updated_at ASC
       LIMIT ?`,
    )
    .all(batchSize) as UnembeddedRow[];
};

const readUnembedded = async (db: Database, batchSize: number): Promise<UnembeddedRow[]> => {
  const eventRows = await readUnembeddedEvents(db, batchSize);
  if (eventRows.length >= batchSize) return eventRows;
  const artifactRows = readUnembeddedArtifacts(db, batchSize - eventRows.length);
  return [...eventRows, ...artifactRows];
};

/** Count unembedded rows USING THE EMBEDDABLE-KIND FILTER. Daemon-side
 *  batch sizing must use this, not a raw COUNT(*) WHERE embedding IS NULL,
 *  because the substrate accumulates massive non-narrative chatter
 *  (worker_tick_completed, candidate_confirmed, origin_calibration_recorded,
 *  bridge_frame_received, embedding_computed, retrieval_binding, ...) that
 *  is intentionally NEVER embedded. Per `FAWT1B3BT56S` + `T6EQS07X6X0V` +
 *  `VEC3MX7RD15F`, the raw-COUNT approach made the daemon think a 280K-event
 *  DB had a 252K-event backlog when the actual embeddable backlog was 1543.
 *
 *  T3.8/T5: now async — routes through the SQL worker-thread pool when
 *  available so the COUNT scan never blocks the main loop. */
export const pendingEmbeddableCount = async (db: Database): Promise<number> => {
  const placeholders = Array.from(EMBEDDABLE_KINDS).map(() => "?").join(", ");
  const sql =
    `SELECT COUNT(*) AS c FROM events ` +
    `WHERE embedding IS NULL AND kind IN (${placeholders})`;
  const params: unknown[] = [...Array.from(EMBEDDABLE_KINDS)];
  const artifactPending = (): number => {
    const row = db
      .query(
        `SELECT COUNT(*) AS c FROM act_artifact
         WHERE embedding IS NULL
           AND runtime IS NULL
           AND superseded_by IS NULL
           AND status IN ('admitted', 'promoted')`,
      )
      .get() as { c: number } | null;
    return row?.c ?? 0;
  };
  try {
    const poolMod = await import("./sql_pool_singleton");
    const pool = poolMod.getSqlPool();
    if (pool) {
      const rows = await pool.query<{ c: number }>(sql, params);
      return (rows[0]?.c ?? 0) + artifactPending();
    }
  } catch { /* tolerate — fall through */ }
  const row = db.query(sql).get(...params) as { c: number } | null;
  return (row?.c ?? 0) + artifactPending();
};

/** Insert (or replace) the matching row in the vec0 virtual table.
 *  Idempotent — we DELETE-by-PK first then INSERT, since vec0 does not
 *  reliably support UPSERT semantics across versions. We READ kind + ts
 *  from the source event row (one cheap PK lookup) rather than threading
 *  them through every caller. Per v2-design.md §5.1, vec_events is the
 *  canonical embedding index.
 *
 *  Failure handling: if the vec_events insert fails (extension didn't
 *  load, or schema mismatch on an upgraded substrate), we surface the
 *  exception so the caller can swallow it. The events.embedding BLOB
 *  column is still written by persistEmbedding before this runs, so
 *  retrieval can degrade to the in-memory path. */
export const upsertVecIndexRow = (
  db: Database,
  id: string,
  kind: string,
  ts: string,
  embedding: number[],
  version: string,
): void => {
  // vec0 stores the vector as JSON or BLOB; we send JSON for portability
  // (smaller code path, no Buffer juggling) — the extension parses it
  // into the internal float[N] representation either way.
  const vec = JSON.stringify(embedding);
  // Replace-if-present: DELETE then INSERT keeps the rebuild + live-add
  // paths convergent without relying on UPSERT.
  db.run("DELETE FROM vec_events WHERE event_id = ?", [id]);
  db.run(
    "INSERT INTO vec_events(event_id, embedding, kind, ts, embedding_version) VALUES (?, ?, ?, ?, ?)",
    [id, vec, kind, ts, version],
  );
};

export const upsertVecEventRow = (
  db: Database,
  eventId: string,
  embedding: number[],
  version: string,
): void => {
  const row = db
    .query("SELECT kind, ts FROM events WHERE id = ?")
    .get(eventId) as { kind: string; ts: string } | null;
  if (!row) return;
  upsertVecIndexRow(db, eventId, row.kind, row.ts, embedding, version);
};

const upsertVecArtifactRow = (
  db: Database,
  artifactId: string,
  embedding: number[],
  version: string,
): void => {
  const row = db
    .query(
      `SELECT updated_at AS ts FROM act_artifact
       WHERE id = ? AND runtime IS NULL AND superseded_by IS NULL AND status IN ('admitted', 'promoted')`,
    )
    .get(artifactId) as { ts: string } | null;
  if (!row) return;
  upsertVecIndexRow(db, artifactId, "act_artifact", row.ts, embedding, version);
};

/** Persist one embedding back onto the source row. We UPDATE the source
 *  event row's `embedding` + `embedding_version` columns (transitional —
 *  kept for parity testing per the schema deprecation note) AND insert
 *  into the canonical vec_events virtual table. The post-update emission
 *  of `embedding_computed` keeps the four-link chain auditable: the
 *  source event id appears in context_refs. */
/** Persist a single embedding row WITHOUT emitting embedding_computed.
 *  Callers MUST emit the per-batch summary event after the persist loop
 *  completes (and after the surrounding transaction commits) — see
 *  embedderWorkerTick + embedPendingEvents below. Per-row emission of
 *  embedding_computed was the structural wedge: 50-row batches emitted
 *  50 events, each publishing through the activation bus to every
 *  subscriber on `["*"]` (the embedder itself, hotreload, extractors,
 *  …). Wall time per tick was 13-14s for actual OpenAI + 50 publish
 *  cascades. After this change, one summary event per batch — the audit
 *  trail still captures every successful embedding via source_event_ids
 *  array — and the embedder reactive worker only re-fires once instead
 *  of 50 times (which is then skipped by the running-tick gate anyway,
 *  but the publish itself was the cost). */
const persistEmbedding = (
  db: Database,
  sourceEventId: string,
  embedding: number[],
  version: string,
): void => {
  const blob = encodeEmbeddingBlob(embedding);
  db.run(
    "UPDATE events SET embedding = ?, embedding_version = ? WHERE id = ?",
    [blob, version, sourceEventId],
  );
  // Canonical v2 path — see schema.sql for vec_events shape + reasoning.
  // We swallow failures here so a vec0 mishap doesn't stall the embedder
  // loop; retrieval degrades to the in-memory wrapper which reads the
  // legacy BLOB column.
  try {
    upsertVecEventRow(db, sourceEventId, embedding, version);
  } catch (err) {
    logger.warn(
      { source_event_id: sourceEventId, err: (err as Error).message ?? String(err) },
      "vec_events upsert failed",
    );
  }
};

const persistArtifactEmbedding = (
  db: Database,
  artifactId: string,
  embedding: number[],
  version: string,
): void => {
  const blob = encodeEmbeddingBlob(embedding);
  db.run(
    "UPDATE act_artifact SET embedding = ?, embedding_version = ? WHERE id = ?",
    [blob, version, artifactId],
  );
  try {
    upsertVecArtifactRow(db, artifactId, embedding, version);
  } catch (err) {
    logger.warn(
      { artifact_id: artifactId, err: (err as Error).message ?? String(err) },
      "vec_events artifact upsert failed",
    );
  }
};

const extractTextFromArtifactPayload = (payload: Record<string, unknown>): string | null => {
  const candidates = [payload.body, payload.summary, payload.intent, payload.name];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c;
  }
  return null;
};

/** Emit ONE summary embedding_computed event for an entire batch.
 *  Replaces the per-row emit storm — see persistEmbedding for rationale. */
const emitBatchEmbeddingAudit = (
  db: Database,
  sourceEventIds: string[],
  sourceArtifactIds: string[],
  version: string,
): void => {
  if (sourceEventIds.length === 0 && sourceArtifactIds.length === 0) return;
  emitEvent(db, {
    kind: "embedding_computed",
    substrate_origin: "substrate_auto",
    payload: {
      source_event_ids: sourceEventIds,
      source_artifact_ids: sourceArtifactIds,
      count: sourceEventIds.length + sourceArtifactIds.length,
      version,
      dims: EMBEDDING_DIMS,
      model: EMBEDDING_MODEL,
    },
    context_refs: [...sourceEventIds, ...sourceArtifactIds].slice(0, 20),
  });
};

export type EmbedderTickResult = {
  embedded: number;
  skipped_no_text: number;
  failed: number;
};

/** Background worker tick — picks `batchSize` unembedded embeddable events,
 *  embeds them in a batch, writes each successful embedding back to its
 *  source row, and emits one `embedding_computed` event per success.
 *  Idempotent — only rows with `embedding IS NULL` are considered. */
export const embedderWorkerTick = async (
  db: Database,
  opts?: { batchSize?: number },
): Promise<EmbedderTickResult> => {
  const batchSize = Math.max(1, Math.min(500, opts?.batchSize ?? 20));
  const rows = await readUnembedded(db, batchSize);
  if (rows.length === 0) {
    return { embedded: 0, skipped_no_text: 0, failed: 0 };
  }
  const items: Array<{ id: string; text: string; source: "event" | "artifact" }> = [];
  const noTextRows: UnembeddedRow[] = [];
  for (const r of rows) {
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(r.payload ?? "{}") as Record<string, unknown>; } catch { /* skip */ }
    let text = r.source === "artifact" ? extractTextFromArtifactPayload(payload) : extractTextFromEvent(r.kind, payload);
    if (!text && r.source === "event") {
      // Fall back to cross-table JOIN resolution (e.g. knowledge_promoted →
      // candidate.claim). Saves the row from being sentinel-marked when its
      // text genuinely exists but lives on a different row.
      text = resolveJoinedText(db, r.kind, payload);
    }
    if (!text) { noTextRows.push(r); continue; }
    items.push({ id: r.id, text, source: r.source });
  }
  // Mark text-less rows with a 0-byte sentinel BLOB so subsequent ticks don't
  // keep re-reading them. `readUnembedded` filters on `embedding IS NULL`, so
  // the sentinel takes them out of the queue without polluting `vec_events`
  // (vec0 only receives rows with real vectors). Without this the embedder
  // gets stuck on the oldest events of kinds whose payloads carry no
  // embeddable text (e.g. act_artifact_admitted, action_scored — they're
  // registered embeddable historically but the runtime emitter writes only
  // structured fields, so extractTextFromEvent returns null forever).
  const noTextEventIds = noTextRows.filter((r) => r.source === "event").map((r) => r.id);
  const noTextArtifactIds = noTextRows.filter((r) => r.source === "artifact").map((r) => r.id);
  if (noTextEventIds.length > 0) {
    const placeholders = noTextEventIds.map(() => "?").join(", ");
    try {
      db.run(
        `UPDATE events SET embedding = X'' WHERE id IN (${placeholders}) AND embedding IS NULL`,
        noTextEventIds,
      );
    } catch { /* swallow — next tick re-checks; retry is harmless */ }
  }
  if (noTextArtifactIds.length > 0) {
    const placeholders = noTextArtifactIds.map(() => "?").join(", ");
    try {
      db.run(
        `UPDATE act_artifact SET embedding = X'', embedding_version = 'no_text' WHERE id IN (${placeholders}) AND embedding IS NULL`,
        noTextArtifactIds,
      );
    } catch { /* swallow — next tick re-checks; retry is harmless */ }
  }
  const skipped_no_text = noTextRows.length;
  if (items.length === 0) {
    return { embedded: 0, skipped_no_text, failed: 0 };
  }
  const batchStartMs = Date.now();
  const embeddings = await batchComputeEmbeddings(items);
  const batchDurMs = Date.now() - batchStartMs;
  let embedded = 0;
  let failed = 0;
  // Wrap all per-row persist work in ONE transaction. Pre-fix, each
  // persistEmbedding ran UPDATE events + vec_events upsert + an
  // embedding_computed event emit (which itself writes to events AND
  // publishes through the activation bus, hitting every subscriber).
  // For batchSize=50 that was 150 SQL writes + 50 activation publishes
  // per tick, each fsyncing — wall time was 54s for 50 events. Wrapping
  // in BEGIN/COMMIT collapses fsync to once and lets WAL fast-path.
  // Failures inside the txn fall through to the catch and rollback the
  // whole batch — surviving rows are picked up by the next tick.
  const persistedEventIds: string[] = [];
  const persistedArtifactIds: string[] = [];
  db.run("BEGIN");
  try {
    for (const item of items) {
      const vec = embeddings.get(item.id);
      if (!vec) { failed++; continue; }
      try {
        if (item.source === "artifact") {
          persistArtifactEmbedding(db, item.id, vec, EMBEDDING_VERSION);
          persistedArtifactIds.push(item.id);
        } else {
          persistEmbedding(db, item.id, vec, EMBEDDING_VERSION);
          persistedEventIds.push(item.id);
        }
        embedded++;
        try { recordEmbedding(batchDurMs / Math.max(1, embeddings.size) / 1000); } catch { /* swallow */ }
      } catch {
        failed++;
      }
    }
    db.run("COMMIT");
  } catch (err) {
    try { db.run("ROLLBACK"); } catch { /* best-effort */ }
    logger.warn(
      { err: (err as Error).message },
      "embedder batch persist rolled back — surviving rows will retry next tick",
    );
    return { embedded: 0, skipped_no_text, failed: items.length };
  }
  // ONE audit emit per batch, AFTER the transaction commits. Replaces the
  // per-row emit storm that was the structural wedge.
  emitBatchEmbeddingAudit(db, persistedEventIds, persistedArtifactIds, EMBEDDING_VERSION);
  return { embedded, skipped_no_text, failed };
};

/** Public, synchronous-style batch embedder. Unlike `embedderWorkerTick`
 *  (which the daemon fires every few seconds), this entry blocks the
 *  caller until the FULL batch of pending events is embedded — `acc init`
 *  and `acc admin embed-all` use this so the substrate is LIVE before
 *  the daemon starts ticking.
 *
 *  Selects every event where `kind IN EMBEDDABLE_KINDS AND embedding IS
 *  NULL`, walks them in stable `ts ASC` order through the existing
 *  batch-of-100 path, and persists each successful embedding via the
 *  same `persistEmbedding` route the worker uses (events row UPDATE +
 *  vec_events upsert + `embedding_computed` audit row).
 *
 *  Behavior contract:
 *    - returns `{ embedded, skipped, failed }` where `skipped` = events
 *      whose payload carried no embeddable text (still counted so the
 *      caller can audit content gaps);
 *    - when OPENAI_API_KEY is unset: emits ONE `embedding_skipped_missing_api_key`
 *      event carrying the pending count and returns `{ embedded: 0,
 *      skipped: <pending>, failed: 0 }` — no throw, no partial work;
 *    - idempotent: pending count is recomputed every call, an empty
 *      pending set returns `{0, 0, 0}` cheaply.
 *
 *  `opts.batchSize` overrides the per-iteration slice (default 100,
 *  capped at 500); `opts.timeoutMs` is reserved for future wall-clock
 *  bounding — today the helper runs to completion since `batchComputeEmbeddings`
 *  already bounds per-request via `fetch`. */
export const embedPendingEvents = async (
  db: Database,
  opts: { batchSize?: number; timeoutMs?: number } = {},
): Promise<{ embedded: number; skipped: number; failed: number }> => {
  const batchSize = Math.max(1, Math.min(500, opts.batchSize ?? 100));
  // Honour the no-API-key path up front: emit ONE audit row carrying the
  // pending count so the substrate explains why nothing was indexed.
  const pendingEventCount = (db
    .query(
      `SELECT COUNT(*) AS c FROM events
       WHERE embedding IS NULL AND kind IN (${Array.from(EMBEDDABLE_KINDS).map(() => "?").join(", ")})`,
    )
    .get(...Array.from(EMBEDDABLE_KINDS)) as { c: number }).c;
  const pendingArtifactCount = (db
    .query(
      `SELECT COUNT(*) AS c FROM act_artifact
       WHERE embedding IS NULL
         AND runtime IS NULL
         AND superseded_by IS NULL
         AND status IN ('admitted', 'promoted')`,
    )
    .get() as { c: number }).c;
  const pendingCount = pendingEventCount + pendingArtifactCount;
  if (pendingCount === 0) {
    return { embedded: 0, skipped: 0, failed: 0 };
  }
  const apiConfig = getApiConfig();
  if (!apiConfig) {
    const skipRow = emitEvent(db, {
      kind: "embedding_skipped_missing_api_key",
      substrate_origin: "substrate_auto",
      payload: {
        pending_count: pendingCount,
        reason: "openai_api_key_missing",
        model: EMBEDDING_MODEL,
      },
    });
    // Surface the gap as a HIDL action card so the owner sees it inline
    // in chat (mirror_inline=true), not buried in worker logs. Idempotent:
    // emit at most one HIDL row per missing-key window. Cite the embed
    // skip row so observers can audit which events are stalled.
    const recentHidl = db
      .query(
        `SELECT 1 FROM events
         WHERE kind = 'hidl_action_required'
           AND json_extract(payload, '$.reason') = 'env_missing'
           AND json_extract(payload, '$.env_var') = 'OPENAI_API_KEY'
           AND ts > datetime('now', '-1 hour')
         LIMIT 1`,
      )
      .get();
    if (!recentHidl) {
      emitEvent(db, {
        kind: "hidl_action_required",
        substrate_origin: "substrate_auto",
        context_refs: [skipRow.id],
        payload: {
          summary: `Embeddings paused — OPENAI_API_KEY missing (${pendingCount} events pending vectorization)`,
          reason: "env_missing",
          env_var: "OPENAI_API_KEY",
          blocked_task_id: "embedder_worker",
          suggested_action: "Add OPENAI_API_KEY=<your-key> to .env and restart the daemon. Semantic retrieval (substrate.search) returns empty results until embeddings catch up.",
          evidence_event_ids: [skipRow.id],
        } as JsonValue,
      });
    }
    return { embedded: 0, skipped: pendingCount, failed: 0 };
  }

  let embedded = 0;
  let skipped = 0;
  let failed = 0;
  // Drain in successive slices of `batchSize` until no unembedded rows
  // remain. Each iteration calls into `batchComputeEmbeddings` (chunked
  // at 100 per OpenAI request) and persists each successful row.
  while (true) {
    const rows = await readUnembedded(db, batchSize);
    if (rows.length === 0) break;
    const items: Array<{ id: string; text: string; source: "event" | "artifact" }> = [];
    for (const r of rows) {
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(r.payload ?? "{}") as Record<string, unknown>; } catch { /* skip */ }
      let text = r.source === "artifact" ? extractTextFromArtifactPayload(payload) : extractTextFromEvent(r.kind, payload);
      if (!text && r.source === "event") {
        // Cross-table JOIN fallback (knowledge_promoted → candidate.claim).
        text = resolveJoinedText(db, r.kind, payload);
      }
      if (!text) {
        skipped++;
        // Stamp a sentinel embedding_version so subsequent calls don't
        // re-attempt the same row. We mark the row as "no-text" by
        // setting embedding_version to a stable marker and leaving the
        // BLOB null — readUnembedded filters on `embedding IS NULL` so
        // we need a different escape: instead, write a 0-byte blob
        // so the row is removed from the pending pool. Empty BLOB is
        // a legitimate marker because decodeEmbeddingBlob returns null
        // for zero-length input.
        if (r.source === "artifact") {
          db.run(
            "UPDATE act_artifact SET embedding = ?, embedding_version = ? WHERE id = ?",
            [new Uint8Array(0), "no_text", r.id],
          );
        } else {
          db.run(
            "UPDATE events SET embedding = ?, embedding_version = ? WHERE id = ?",
            [new Uint8Array(0), "no_text", r.id],
          );
        }
        continue;
      }
      items.push({ id: r.id, text, source: r.source });
    }
    if (items.length === 0) {
      // Nothing embeddable in this slice; loop again only if readUnembedded
      // returned <= skipped (the skipped rows are now marked, so the next
      // iteration won't re-see them). Break to avoid an infinite loop.
      continue;
    }
    const embeddings = await batchComputeEmbeddings(items);
    const persistedEventIds: string[] = [];
    const persistedArtifactIds: string[] = [];
    db.run("BEGIN");
    try {
      for (const item of items) {
        const vec = embeddings.get(item.id);
        if (!vec) { failed++; continue; }
        try {
          if (item.source === "artifact") {
            persistArtifactEmbedding(db, item.id, vec, EMBEDDING_VERSION);
            persistedArtifactIds.push(item.id);
          } else {
            persistEmbedding(db, item.id, vec, EMBEDDING_VERSION);
            persistedEventIds.push(item.id);
          }
          embedded++;
        } catch {
          failed++;
        }
      }
      db.run("COMMIT");
    } catch (err) {
      try { db.run("ROLLBACK"); } catch { /* best-effort */ }
      logger.warn({ err: (err as Error).message }, "embedPendingEvents batch persist rolled back");
      failed += items.length - persistedEventIds.length - persistedArtifactIds.length;
    }
    // ONE audit emit per batch — replaces the per-row storm.
    emitBatchEmbeddingAudit(db, persistedEventIds, persistedArtifactIds, EMBEDDING_VERSION);
    // Defensive cap: if a slice came back with EVERY item failing (no
    // network, bad key, etc) we'd loop forever — bail out so the caller
    // sees the failed count without hanging.
    if (embeddings.size === 0 && items.length > 0) break;
  }
  return { embedded, skipped, failed };
};

/** Convenience: read one event's stored embedding as a Float32Array, or
 *  null if no embedding or version mismatch. The reranker uses this to
 *  fetch the query embedding back when seeded by tests. */
export const readEmbeddingFromEvent = (
  db: Database,
  eventId: string,
): { vector: Float32Array; version: string } | null => {
  const row = db
    .query("SELECT embedding, embedding_version FROM events WHERE id = ?")
    .get(eventId) as { embedding: Uint8Array | null; embedding_version: string | null } | null;
  if (!row || !row.embedding) return null;
  const vec = decodeEmbeddingBlob(row.embedding);
  if (!vec) return null;
  return { vector: vec, version: row.embedding_version ?? EMBEDDING_VERSION };
};

// Re-export the Event type so call sites that import from embedder don't
// have to re-import substrate/types just for the surface.
export type { Event };
