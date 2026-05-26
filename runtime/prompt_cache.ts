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
import { BoundedLru } from "./bounded_lru";

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
 *  for the corner case where composePrompt's substrate inputs change in
 *  a way that doesn't insert an event (e.g. a act_artifact row status
 *  flips). Universal value — pending f13 adaptive-scoring contract
 *  (GEZ955QDYN3R: prompt cache freshness should be scored, not tuned). */
export const PROMPT_CACHE_TTL_MS = 60_000;

/** Max in-memory entries before LRU eviction. Universal value. */
export const PROMPT_CACHE_MAX_ENTRIES = 200;

/** Byte cap — the real memory governor. Composed prompts can be large; 200
 *  entries × multi-MB each is what fed the daemon RSS meltdown. The byte cap
 *  bounds the cache's contribution to RSS regardless of entry size. Universal
 *  value (ACC2_PROMPT_CACHE_MAX_BYTES overrides for constrained hosts/tests). */
export const PROMPT_CACHE_MAX_BYTES = (() => {
  const raw = Number(process.env.ACC2_PROMPT_CACHE_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 64 * 1024 * 1024;
})();

/** Best-effort byte estimate of one cached entry. The dominant cost is the
 *  composed value (a prompt string or a structured object serialised lazily);
 *  we JSON-stringify defensively for size only when it is not already a string. */
const entryBytes = (entry: CacheEntry<unknown>): number => {
  const v = entry.value;
  let valueBytes: number;
  if (typeof v === "string") {
    valueBytes = v.length * 2;
  } else {
    try {
      valueBytes = JSON.stringify(v).length * 2;
    } catch {
      valueBytes = 1024; // unserialisable — charge a flat estimate
    }
  }
  // Key + bookkeeping overhead.
  const keyBytes =
    (entry.key.directive_id.length + entry.key.task_id.length + entry.key.options_signature.length) * 2;
  return valueBytes + keyBytes + 64;
};

const cache = new BoundedLru<CacheEntry<unknown>>({
  name: "prompt_cache",
  maxEntries: PROMPT_CACHE_MAX_ENTRIES,
  maxBytes: PROMPT_CACHE_MAX_BYTES,
  sizeOf: entryBytes,
});
let hitCount = 0;
let missCount = 0;

// Per-Database identity. The cache is a module-level Map shared across the
// whole process, but the high-water rowid (its only freshness signal besides
// TTL) is db-relative — two distinct Database instances (e.g. two `:memory:`
// test DBs, or a real db + an in-process probe db) can sit at the SAME rowid
// while holding entirely different state. Without a db tag in the rendered
// key, a store from db A could be served to db B whose matching key + matching
// rowid falsely passes the high-water guard, leaking a stale/foreign prompt.
// `:memory:` DBs even share `.filename` (":memory:") so the filename can't
// disambiguate. A WeakMap mints a stable, GC-friendly tag per Database
// instance and folds it into the key so entries never cross databases.
const dbTags = new WeakMap<Database, string>();
let dbTagSeq = 0;
const tagFor = (db: Database): string => {
  let tag = dbTags.get(db);
  if (tag === undefined) {
    tag = `db${dbTagSeq++}`;
    dbTags.set(db, tag);
  }
  return tag;
};

const renderKey = (db: Database, key: CacheKey): string =>
  `${tagFor(db)}|${key.directive_id}|${key.task_id}|${key.options_signature}`;

// Composer-telemetry kinds that composePrompt itself emits as a side
// effect of composing. They must be excluded from the high-water mark:
// otherwise the act of composing (which stores the cache entry) advances
// the high-water past the stored entry, so the very next lookup for the
// same task always misses with reason=high_water_advanced and the cache
// can never serve a single hit. The brain's RLMQ_PROMPT_COMP design calls
// this out explicitly ("a high-water mark that excludes prompt-composer
// telemetry"). Any NON-telemetry event (real substrate movement) still
// advances the mark and correctly invalidates the cache.
const COMPOSER_TELEMETRY_KINDS = [
  "prompt_composition_cache_hit",
  "prompt_composition_cache_miss",
  "prompt_truncated",
  "counterfactual_alternative_recorded",
  "prompt_policy_section_selected",
] as const;

const HIGH_WATER_SQL =
  `SELECT IFNULL(MAX(rowid), 0) AS m FROM events WHERE kind NOT IN (${COMPOSER_TELEMETRY_KINDS.map(() => "?").join(",")})`;

export const currentHighWaterRowid = (db: Database): number => {
  const row = db.query(HIGH_WATER_SQL).get(...COMPOSER_TELEMETRY_KINDS) as { m: number };
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
  const rendered = renderKey(db, key);
  // peek (no recency bump) — a stale/expired entry should be deleted, not
  // promoted. We bump recency below only on a genuine hit.
  const entry = cache.peek(rendered) as CacheEntry<T> | undefined;
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
  // Cache hit — bump to most-recently-used so LRU eviction is honest.
  cache.get(rendered);
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
  opts?: { nowMs?: number; highWaterRowid?: number },
): void => {
  const rendered = renderKey(db, key);
  // The caller (composePrompt) may pass the high-water mark it snapshotted
  // BEFORE composition began. Composition emits its own act_tuple_recorded
  // (citation-choice credit) which is NOT in COMPOSER_TELEMETRY_KINDS;
  // stamping the pre-composition mark prevents that self-emitted row from
  // invalidating the entry on the very next lookup. Falls back to the
  // current (telemetry-excluding) mark when the caller omits it.
  const entry: CacheEntry<T> = {
    key,
    highWaterRowid: opts?.highWaterRowid ?? currentHighWaterRowid(db),
    insertedAtMs: opts?.nowMs ?? Date.now(),
    value,
  };
  // BoundedLru enforces both the entry cap and the byte cap (oldest-first)
  // on set — no manual eviction loop needed.
  cache.set(rendered, entry);
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
  bytes: number;
  hits: number;
  misses: number;
  hit_rate: number;
} => {
  const totalLookups = hitCount + missCount;
  return {
    entries: cache.size,
    bytes: cache.bytes,
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
