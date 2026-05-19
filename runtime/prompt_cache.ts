// acc2 prompt composition cache (brain elegance bc8je5f3x bet #4, 2026-05-15).
//
// composePrompt scans many substrate slices per call (knowledge top-K,
// artifact registry, watch edges, directive goal, retrieved hits…). When
// the scheduler ticks repeatedly for the same task within a short window,
// or when tests exercise composePrompt with identical inputs, the
// substrate hasn't moved enough to warrant a fresh composition. The
// cache is a small in-memory TTL keyed by the call's input signature
// plus the global high-water mark on the events table — any new event
// growing the high-water mark invalidates every cache entry, so a stale
// entry can never serve a brain dispatch that should see fresh state.
//
// Scope:
//   - In-memory process-local Map. Daemon restart clears the cache,
//     which is fine (it's a speedup, not authoritative).
//   - TTL bounds staleness even when no events fire (paranoia bound).
//   - Max entries bounds memory.
//   - emit prompt_composition_cache_hit / _miss for telemetry.

import type { Database } from "bun:sqlite";
import { emitEvent } from "./events";

// Decoupled telemetry: emitting from inside lookup/store would advance
// the events high-water rowid, which is the cache's own invalidation
// signal — every emit would self-evict the just-stored entry. Instead
// the cache exposes pure lookup/store + lightweight in-memory counters;
// the dispatcher (or any other caller) emits prompt_composition_cache_hit
// / _miss explicitly via recordPromptCacheHit/Miss after deciding what
// to do with the result.

export type CacheKey = {
  directive_id: string;
  task_id: string;
  /** Stable hash over composePrompt's non-substrate inputs (budgetTokens,
   *  pre-computed retrieval hits, etc.). The caller computes this. */
  options_signature: string;
};

type CacheEntry<T> = {
  key: CacheKey;
  highWaterRowid: number;
  insertedAtMs: number;
  value: T;
};

/** Maximum cache age (ms) regardless of event freshness. Bounds staleness
 *  for the corner case where composePrompt's substrate inputs change in a
 *  way that doesn't insert an event (e.g. a act_artifact row status
 *  flips). Default 60s; override via ACC2_PROMPT_CACHE_TTL_MS. */
export const PROMPT_CACHE_TTL_MS = Number(
  process.env.ACC2_PROMPT_CACHE_TTL_MS ?? 60_000,
);

/** Max in-memory entries before LRU eviction. */
export const PROMPT_CACHE_MAX_ENTRIES = Number(
  process.env.ACC2_PROMPT_CACHE_MAX_ENTRIES ?? 200,
);

const cache = new Map<string, CacheEntry<unknown>>();
let hitCount = 0;
let missCount = 0;

const renderKey = (key: CacheKey): string =>
  `${key.directive_id}|${key.task_id}|${key.options_signature}`;

const currentHighWaterRowid = (db: Database): number => {
  const row = db.query("SELECT IFNULL(MAX(rowid), 0) AS m FROM events").get() as { m: number };
  return row.m;
};

export type LookupResult<T> =
  | { hit: true; value: T; age_ms: number }
  | { hit: false; reason: "no_entry" | "ttl_expired" | "high_water_advanced"; age_ms?: number; cached_rowid?: number; current_rowid?: number };

/** Pure lookup — returns hit/miss verdict + value. NO event emission.
 *  The caller (dispatcher) decides whether to record telemetry via
 *  recordPromptCacheHit/Miss; emitting from inside lookup would advance
 *  the events high-water mark and self-invalidate the next lookup. */
export const lookupCachedPrompt = <T>(
  db: Database,
  key: CacheKey,
  opts?: { nowMs?: number },
): LookupResult<T> => {
  const rendered = renderKey(key);
  const entry = cache.get(rendered) as CacheEntry<T> | undefined;
  if (!entry) {
    missCount++;
    return { hit: false, reason: "no_entry" };
  }
  const nowMs = opts?.nowMs ?? Date.now();
  const age = nowMs - entry.insertedAtMs;
  if (age >= PROMPT_CACHE_TTL_MS) {
    cache.delete(rendered);
    missCount++;
    return { hit: false, reason: "ttl_expired", age_ms: age };
  }
  const hw = currentHighWaterRowid(db);
  if (hw !== entry.highWaterRowid) {
    cache.delete(rendered);
    missCount++;
    return { hit: false, reason: "high_water_advanced", cached_rowid: entry.highWaterRowid, current_rowid: hw };
  }
  // Cache hit — bump to end of insertion order so LRU eviction is honest.
  cache.delete(rendered);
  cache.set(rendered, entry);
  hitCount++;
  return { hit: true, value: entry.value, age_ms: age };
};

/** Telemetry helper — call AFTER lookup when the caller wants to record
 *  the outcome to the substrate. Safe to omit when telemetry isn't
 *  needed (tests, low-frequency call sites). */
export const recordPromptCacheHit = (
  db: Database,
  key: CacheKey,
  ageMs: number,
): void => {
  try {
    emitEvent(db, {
      kind: "prompt_composition_cache_hit",
      substrate_origin: "substrate_auto",
      directive_id: key.directive_id,
      task_id: key.task_id,
      payload: { age_ms: ageMs, options_signature: key.options_signature },
    });
  } catch { /* fail-soft */ }
};

export const recordPromptCacheMiss = (
  db: Database,
  key: CacheKey,
  reason: string,
  extras?: Record<string, unknown>,
): void => {
  try {
    emitEvent(db, {
      kind: "prompt_composition_cache_miss",
      substrate_origin: "substrate_auto",
      directive_id: key.directive_id,
      task_id: key.task_id,
      payload: { reason, options_signature: key.options_signature, ...(extras ?? {}) },
    });
  } catch { /* fail-soft */ }
};

/** Store a freshly-composed value under the key. Stamps the current
 *  high-water rowid + nowMs so subsequent lookups can invalidate
 *  precisely. LRU-evicts the oldest entry when MAX_ENTRIES is exceeded. */
export const storeCachedPrompt = <T>(
  db: Database,
  key: CacheKey,
  value: T,
  opts?: { nowMs?: number },
): void => {
  const rendered = renderKey(key);
  const entry: CacheEntry<T> = {
    key,
    highWaterRowid: currentHighWaterRowid(db),
    insertedAtMs: opts?.nowMs ?? Date.now(),
    value,
  };
  cache.set(rendered, entry);
  while (cache.size > PROMPT_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
};

/** Drop every entry. Hot-reload of prompt_composer or schema-change
 *  surfaces should call this to avoid serving values built against the
 *  pre-reload composer. */
export const invalidatePromptCache = (): void => {
  cache.clear();
};

/** Telemetry — hit/miss totals plus current size. The TUI Effectiveness
 *  panel can render this to spot cache regressions. */
export const promptCacheStats = (): {
  entries: number;
  hits: number;
  misses: number;
  hit_rate: number;
} => {
  const totalLookups = hitCount + missCount;
  return {
    entries: cache.size,
    hits: hitCount,
    misses: missCount,
    hit_rate: totalLookups === 0 ? 0 : hitCount / totalLookups,
  };
};

/** Test-only: reset counters and entries. */
export const _resetPromptCacheForTests = (): void => {
  cache.clear();
  hitCount = 0;
  missCount = 0;
};
