// acc2 query-embedding cache (compounding lever #4, 2026-05-22).
//
// Broadens the prompt_composition_cache idiom (runtime/prompt_cache.ts) to the
// per-search-query OpenAI embedding round-trip. `retrieve()` and the MCP
// substrate.search surface both call `computeEmbedding(query.text)` on EVERY
// query — a network fetch to text-embedding-3-small. The same query text
// re-issued within a session (scheduler re-ticks, repeated owner searches,
// test fixtures) re-pays that round-trip for an identical result.
//
// SAFETY — why this is cacheable WITHOUT a ledger state-version key:
//   computeEmbedding(text) is a PURE deterministic function of
//   (text, EMBEDDING_MODEL, EMBEDDING_DIMS, EMBEDDING_VERSION). It reads ZERO
//   mutable ledger state — the embedding of a fixed string never changes while
//   the model/dims/version are pinned. So unlike the prompt cache (which keys on
//   the events high-water rowid because composePrompt scans live substrate
//   state), the embedding cache needs NO state-version key. The model signature
//   is folded into the cache key so a model/dims/version bump invalidates every
//   entry automatically — a stale embedding can never serve a new model.
//
// Scope (matches prompt_cache.ts):
//   - In-memory process-local Map. Daemon restart clears it (speedup, not
//     authoritative).
//   - TTL bounds staleness for the corner case where the underlying model
//     silently drifts behind a fixed version string (paranoia bound).
//   - Max entries bounds memory (LRU eviction).
//   - emit query_embedding_cache_hit / _miss for observability.
//
// Telemetry coupling note: unlike prompt_cache, emitting a cache event here is
// SAFE to do inline because the cache key does NOT depend on the events
// high-water rowid — appending an event row cannot invalidate a deterministic
// text→embedding mapping. So this module exposes a single get-or-compute helper
// that does lookup + compute + store + telemetry in one call.

import type { Database } from "bun:sqlite";
import { computeEmbedding, EMBEDDING_DIMS, EMBEDDING_MODEL, EMBEDDING_VERSION } from "./embedder";
import type { EmbeddingResult } from "./embedder";
import { emitEvent } from "./events";
import { BoundedLru } from "./bounded_lru";

/** Max cache age (ms) regardless of model-version match. Bounds staleness for
 *  the corner case where the embedding endpoint drifts behind a fixed version
 *  string. Mirrors PROMPT_CACHE_TTL_MS. Universal value. */
export const QUERY_EMBEDDING_CACHE_TTL_MS = 60_000;

/** Max in-memory entries before LRU eviction. Universal value. */
export const QUERY_EMBEDDING_CACHE_MAX_ENTRIES = 500;

/** Byte cap — the real memory governor. Each entry holds a 1536-dim embedding
 *  (~12 KB as a number[]); 500 entries is ~6 MB, but a misconfigured dim or a
 *  burst of large queries could grow this. The byte cap bounds it regardless of
 *  entry count. Universal value (ACC2_EMBEDDING_CACHE_MAX_BYTES overrides). */
export const QUERY_EMBEDDING_CACHE_MAX_BYTES = (() => {
  const raw = Number(process.env.ACC2_EMBEDDING_CACHE_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 32 * 1024 * 1024;
})();

/** Model signature folded into every key — a model/dims/version bump
 *  invalidates the whole cache so a stale-model embedding can never serve a
 *  query under the new model. */
const MODEL_SIGNATURE = `${EMBEDDING_MODEL}|${EMBEDDING_DIMS}|${EMBEDDING_VERSION}`;

type CacheEntry = {
  insertedAtMs: number;
  value: EmbeddingResult;
};

/** Byte estimate of one entry — the embedding number[] dominates (8 bytes per
 *  JS number) plus small fixed overhead for the version string + bookkeeping. */
const entryBytes = (entry: CacheEntry): number =>
  entry.value.embedding.length * 8 + entry.value.version.length * 2 + 32;

const cache = new BoundedLru<CacheEntry>({
  name: "embedding_cache",
  maxEntries: QUERY_EMBEDDING_CACHE_MAX_ENTRIES,
  maxBytes: QUERY_EMBEDDING_CACHE_MAX_BYTES,
  sizeOf: entryBytes,
});
let hitCount = 0;
let missCount = 0;

/** Stable key over the deterministic inputs. The text is hashed (Bun's fast
 *  non-cryptographic hash) so arbitrarily-long queries map to a bounded key,
 *  and the model signature is prefixed verbatim so a version bump partitions
 *  the keyspace. */
const renderKey = (text: string): string => {
  const textHash = Bun.hash(text).toString(36);
  return `${MODEL_SIGNATURE}|${text.length}|${textHash}`;
};

const recordHit = (db: Database, text: string, ageMs: number): void => {
  try {
    emitEvent(db, {
      kind: "query_embedding_cache_hit",
      substrate_origin: "substrate_auto",
      payload: { age_ms: ageMs, text_length: text.length, model_signature: MODEL_SIGNATURE },
    });
  } catch { /* fail-soft telemetry */ }
};

const recordMiss = (db: Database, text: string, reason: string): void => {
  try {
    emitEvent(db, {
      kind: "query_embedding_cache_miss",
      substrate_origin: "substrate_auto",
      payload: { reason, text_length: text.length, model_signature: MODEL_SIGNATURE },
    });
  } catch { /* fail-soft telemetry */ }
};

/** Get-or-compute the embedding for `text`. On a fresh-and-valid cache entry
 *  returns the cached EmbeddingResult (provably identical to a fresh compute
 *  for the same text + model). On miss/expiry, computes via `computeEmbedding`,
 *  stores the result (only when non-null — null means missing creds / fetch
 *  failure, which must NOT be cached so a later working call re-tries), and
 *  emits the matching telemetry event.
 *
 *  `opts.nowMs` and `opts.compute` are test seams. */
export const getCachedQueryEmbedding = async (
  db: Database,
  text: string,
  opts?: { nowMs?: number; compute?: (text: string) => Promise<EmbeddingResult | null> },
): Promise<EmbeddingResult | null> => {
  const nowMs = opts?.nowMs ?? Date.now();
  const compute = opts?.compute ?? computeEmbedding;
  const key = renderKey(text);
  const entry = cache.peek(key);
  if (entry) {
    const age = nowMs - entry.insertedAtMs;
    if (age < QUERY_EMBEDDING_CACHE_TTL_MS) {
      // Bump to most-recently-used for honest LRU.
      cache.get(key);
      hitCount++;
      recordHit(db, text, age);
      return entry.value;
    }
    cache.delete(key);
  }
  missCount++;
  recordMiss(db, text, entry ? "ttl_expired" : "no_entry");
  const value = await compute(text);
  // Never cache a null result — it signals a transient/credential failure, not
  // a deterministic "no embedding" answer. Caching it would suppress recovery.
  if (value) {
    // BoundedLru enforces both the entry cap and the byte cap on set.
    cache.set(key, { insertedAtMs: nowMs, value });
  }
  return value;
};

/** Telemetry — hit/miss totals plus current size. Mirrors promptCacheStats. */
export const queryEmbeddingCacheStats = (): {
  entries: number;
  bytes: number;
  hits: number;
  misses: number;
  hit_rate: number;
} => {
  const total = hitCount + missCount;
  return {
    entries: cache.size,
    bytes: cache.bytes,
    hits: hitCount,
    misses: missCount,
    hit_rate: total === 0 ? 0 : hitCount / total,
  };
};

/** Drop every entry. Hot-reload of the embedder model/version surface should
 *  call this to avoid serving values built against the pre-reload model. */
export const invalidateQueryEmbeddingCache = (): void => {
  cache.clear();
};

/** Test-only: reset counters and entries. */
export const _resetQueryEmbeddingCacheForTests = (): void => {
  cache.clear();
  hitCount = 0;
  missCount = 0;
};
