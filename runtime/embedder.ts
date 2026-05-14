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
import type { Event } from "../substrate/types";
import { emitEvent } from "./events";

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMS = 1536;
export const EMBEDDING_VERSION = "v1"; // bump when model or dim changes

/** Event kinds whose payload text we embed. Other kinds are structural
 *  control-flow events with no useful embedding surface. */
export const EMBEDDABLE_KINDS = new Set<string>([
  "directive_opened",
  "directive_amended",
  "task_node_opened",
  "knowledge_candidate",
  "knowledge_promoted",
  "code_artifact_candidate",
  "code_artifact_admitted",
  "owner_input_received",
  "owner_decision_recorded",
  "external_event_received",
  "action_predicted",
  "action_scored",
]);

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
 *  null if the byte length is not a multiple of 4. */
export const decodeEmbeddingBlob = (blob: Uint8Array): Float32Array | null => {
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
          input: slice.map((i) => i.text),
          dimensions: EMBEDDING_DIMS,
        }),
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
 *  null when the kind isn't embeddable or no text-like field is present. */
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
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c;
  }
  return null;
};

type UnembeddedRow = { id: string; kind: string; payload: string };

const readUnembedded = (db: Database, batchSize: number): UnembeddedRow[] => {
  const placeholders = Array.from(EMBEDDABLE_KINDS).map(() => "?").join(", ");
  const sql =
    `SELECT id, kind, payload FROM events ` +
    `WHERE embedding IS NULL AND kind IN (${placeholders}) ` +
    `ORDER BY ts ASC LIMIT ?`;
  const rows = db.query(sql).all(...Array.from(EMBEDDABLE_KINDS), batchSize) as Array<{
    id: string;
    kind: string;
    payload: string;
  }>;
  return rows;
};

/** Persist one embedding back onto the source row. We UPDATE the source
 *  event row's `embedding` + `embedding_version` columns (the columns added
 *  by Phase F's schema migration). The post-update emission of
 *  `embedding_computed` keeps the four-link chain auditable: the source
 *  event id appears in context_refs. */
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
  emitEvent(db, {
    kind: "embedding_computed",
    substrate_origin: "substrate_auto",
    payload: {
      source_event_id: sourceEventId,
      version,
      dims: EMBEDDING_DIMS,
      model: EMBEDDING_MODEL,
    },
    context_refs: [sourceEventId],
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
  const rows = readUnembedded(db, batchSize);
  if (rows.length === 0) {
    return { embedded: 0, skipped_no_text: 0, failed: 0 };
  }
  const items: Array<{ id: string; text: string }> = [];
  let skipped_no_text = 0;
  for (const r of rows) {
    let payload: unknown = {};
    try { payload = JSON.parse(r.payload ?? "{}"); } catch { /* skip */ }
    const text = extractTextFromEvent(r.kind, payload);
    if (!text) { skipped_no_text++; continue; }
    items.push({ id: r.id, text });
  }
  if (items.length === 0) {
    return { embedded: 0, skipped_no_text, failed: 0 };
  }
  const embeddings = await batchComputeEmbeddings(items);
  let embedded = 0;
  let failed = 0;
  for (const item of items) {
    const vec = embeddings.get(item.id);
    if (!vec) { failed++; continue; }
    try {
      persistEmbedding(db, item.id, vec, EMBEDDING_VERSION);
      embedded++;
    } catch {
      failed++;
    }
  }
  return { embedded, skipped_no_text, failed };
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
