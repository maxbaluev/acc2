// acc2 in-memory embedding index — daemon holds this for the lifetime of
// the process (v2-design.md §5.1) and rebuilds it from `embedding_index_view`
// at boot (§5.3). Live updates land via `add()` once an embedder worker tick
// finishes a row.
//
// Implementation:
//   Linear scan over a Float32Array per entry with cosine distance is fine
//   for Phase F — the pilot substrate carries ≤ 10k embedded events. We
//   ALWAYS do the brute-force pass and accept O(n·d) per query. A real HNSW
//   only makes sense once measured query latency under the operational
//   substrate volume warrants it — premature optimisation here just costs
//   us debuggability for retrieval correctness work that is more
//   load-bearing in Phase F (rerank shape, version filtering, kind-filter
//   semantics).
//
// Version filtering:
//   Each entry carries its `embedding_version`. The reranker may pass a
//   filter excluding mismatched versions; we don't pre-partition the index
//   by version because the filter callback runs over the same scan and the
//   substrate is small enough.

import type { Database } from "bun:sqlite";
import { embeddingIndex } from "../substrate/views";
import { decodeEmbeddingBlob, EMBEDDING_VERSION } from "./embedder";

export type IndexEntry = {
  event_id: string;
  embedding: Float32Array;
  kind: string;
  ts: string;
  directive_id: string;
  task_id: string;
  substrate_origin: string;
  embedding_version: string;
  /** Compact preview pulled from the source event payload — used by the
   *  retrieval surface to render snippets without re-reading the row. */
  snippet: string;
};

export type KnnHit = {
  entry: IndexEntry;
  distance: number; // cosine distance in [0, 2]
};

const SNIPPET_LEN = 200;

const cosineDistance = (a: Float32Array, b: Float32Array): number => {
  // Both vectors are unit-magnitude in OpenAI's API (already L2-normalized).
  // We don't assume that — we compute full cosine to stay correct for any
  // future model. Cost: 3·d FMAs per call, negligible at d=1536, n≤10k.
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
  if (aMag === 0 || bMag === 0) return 2; // maximum cosine distance
  const cosSim = dot / (Math.sqrt(aMag) * Math.sqrt(bMag));
  // Clamp guarding floating-point drift outside [-1, 1].
  const clamped = cosSim > 1 ? 1 : cosSim < -1 ? -1 : cosSim;
  return 1 - clamped;
};

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

export class EmbeddingIndex {
  private entries: IndexEntry[] = [];

  /** Bulk-load every embedded event from the substrate. The daemon awaits
   *  this at boot before serving queries; subsequent embedder ticks call
   *  `add()` directly. */
  static rebuildFromDb(db: Database): EmbeddingIndex {
    const index = new EmbeddingIndex();
    const rows = embeddingIndex(db);
    for (const row of rows) {
      const vec = decodeEmbeddingBlob(row.embedding);
      if (!vec) continue;
      index.entries.push({
        event_id: row.id,
        embedding: vec,
        kind: row.kind,
        ts: row.ts,
        directive_id: row.directive_id,
        task_id: row.task_id,
        substrate_origin: row.substrate_origin,
        embedding_version: row.embedding_version ?? EMBEDDING_VERSION,
        snippet: buildSnippet(row.payload),
      });
    }
    return index;
  }

  /** Append one entry — called by the embedder worker after each successful
   *  embed. No dedup: the worker guarantees one-shot via `embedding IS NULL`
   *  predicate, so a duplicate `add()` would itself be a bug. */
  add(entry: IndexEntry): void {
    this.entries.push(entry);
  }

  /** Cosine-distance KNN. Returns up to `k` entries sorted by ascending
   *  distance. The optional `filter` runs per-entry before scoring; use it
   *  to exclude mismatched versions, restrict by kind, or scope to a
   *  directive.
   *
   *  Returns [] when the index is empty or query dimensions don't match
   *  the indexed entries' dimension. */
  knn(
    queryEmbedding: Float32Array,
    k: number,
    filter?: (e: IndexEntry) => boolean,
  ): KnnHit[] {
    if (this.entries.length === 0 || queryEmbedding.length === 0) return [];
    const kCap = Math.max(1, Math.min(this.entries.length, k));
    const hits: KnnHit[] = [];
    for (const e of this.entries) {
      if (filter && !filter(e)) continue;
      if (e.embedding.length !== queryEmbedding.length) continue;
      const distance = cosineDistance(queryEmbedding, e.embedding);
      hits.push({ entry: e, distance });
    }
    hits.sort((a, b) => a.distance - b.distance);
    return hits.slice(0, kCap);
  }

  /** Snapshot the entry list — used by tests + the retrieval surface to
   *  introspect what is currently in memory. */
  list(): IndexEntry[] {
    return this.entries.slice();
  }

  size(): number {
    return this.entries.length;
  }
}
