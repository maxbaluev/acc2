// acc2 central memory budget (resource-spec GTWD1AV2VH4M5AE957J4H7RFPR, 2026-05-26).
//
// ROOT-CAUSE FIX for the daemon RSS meltdown: a fresh daemon starts at ~2.4 GB
// and grows monotonically to 8-9 GB before a native Bun SIGILL/segfault. The
// growth is a mix of GB-scale transient spikes during dispatch / retrieval /
// prompt-composition and unbounded in-memory caches (prompt_cache,
// embedding_cache, embedding_index jsEntries, activation/event subscriber
// buffers). Each cache previously owned a LOCAL, INCOMPLETE cap with no shared
// notion of a total memory budget — so the SUM of caches plus transient
// allocation could blow past host memory with no coordinated eviction.
//
// This module is the process-wide governor:
//   (1) global soft/hard RSS ceilings derived from host totalmem (and a sane
//       default fraction) — the budget the daemon promises to stay under;
//   (2) registerCache(name, {estimatedBytes, evictUntilBytes, clear}) — every
//       bounded cache registers so the budget can account total tracked bytes
//       AND drive coordinated eviction when pressure rises;
//   (3) sampleMemoryPressure() — rss_bytes, heap_used_bytes, external_bytes,
//       array_buffers, host_total_bytes, tracked_cache_bytes, and an
//       rss_slope_bytes_per_min computed from a small ring of samples;
//   (4) evictOnPressure(reason) — invoked from scheduler admission, /health
//       gauge refresh, and before spawning a brain; sheds cache bytes toward
//       each cache's evictUntilBytes target when over the soft ceiling and
//       emits a telemetry_evicted event so the eviction is on the ledger.
//
// Reuses Bun/Node `process.memoryUsage()` + `os.totalmem()` — no native deps.

import type { Database } from "bun:sqlite";
import os from "node:os";
import { emitEvent } from "./events";
import { logger } from "./logger";

/** A registered cache's eviction contract. The budget never reaches inside a
 *  cache's data structure — it asks the cache how many bytes it currently
 *  holds and tells it to shed down toward a target. */
export type RegisteredCache = {
  /** Stable name (e.g. "prompt_cache", "embedding_cache", "embedding_index_js").
   *  Used for telemetry + idempotent re-registration. */
  name: string;
  /** Current best-effort byte estimate this cache holds resident. */
  estimatedBytes: () => number;
  /** Shed entries until the cache holds <= targetBytes (oldest-first). Returns
   *  the number of bytes actually evicted. */
  evictUntilBytes: (targetBytes: number) => number;
  /** Drop everything (hard-reset path). */
  clear: () => void;
};

export type MemoryPressureSample = {
  ts_ms: number;
  rss_bytes: number;
  heap_used_bytes: number;
  external_bytes: number;
  array_buffers_bytes: number;
  host_total_bytes: number;
  tracked_cache_bytes: number;
  /** Linear slope over the retained sample ring; 0 until >=2 samples. */
  rss_slope_bytes_per_min: number;
  /** Soft / hard ceilings in effect for this process. */
  soft_ceiling_bytes: number;
  hard_ceiling_bytes: number;
  /** rss_bytes / soft_ceiling_bytes — >1 means over the soft ceiling. */
  pressure_ratio: number;
};

/** Default fraction of host totalmem the daemon promises to stay under (soft).
 *  Hard ceiling is a higher fraction — the circuit-breaker line. These are the
 *  universal defaults; ACC2_MEM_SOFT_FRACTION / ACC2_MEM_HARD_FRACTION override
 *  for constrained hosts / tests. */
const DEFAULT_SOFT_FRACTION = 0.55;
const DEFAULT_HARD_FRACTION = 0.75;

/** Ring of recent samples used to compute the RSS slope. Small + bounded so the
 *  governor itself never becomes a memory sink. */
const SLOPE_RING_CAPACITY = 12;

const parseFraction = (envName: string, fallback: number): number => {
  const raw = process.env[envName];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return fallback;
  return n;
};

const parseBytes = (envName: string): number | null => {
  const raw = process.env[envName];
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
};

/**
 * Process-wide memory budget. One instance per daemon process (held by the
 * module-level singleton below); tests construct their own to stay isolated.
 */
export class MemoryBudget {
  private readonly caches = new Map<string, RegisteredCache>();
  private readonly samples: MemoryPressureSample[] = [];
  private readonly hostTotalBytes: number;
  private readonly softCeilingBytes: number;
  private readonly hardCeilingBytes: number;
  /** Throttle telemetry so a hot evict loop can't flood the ledger. */
  private lastEvictTelemetryMs = 0;

  constructor(opts?: {
    hostTotalBytes?: number;
    softCeilingBytes?: number;
    hardCeilingBytes?: number;
  }) {
    this.hostTotalBytes = opts?.hostTotalBytes ?? os.totalmem();
    const softFraction = parseFraction("ACC2_MEM_SOFT_FRACTION", DEFAULT_SOFT_FRACTION);
    const hardFraction = parseFraction("ACC2_MEM_HARD_FRACTION", DEFAULT_HARD_FRACTION);
    this.softCeilingBytes =
      opts?.softCeilingBytes ??
      parseBytes("ACC2_MEM_SOFT_BYTES") ??
      Math.floor(this.hostTotalBytes * softFraction);
    this.hardCeilingBytes =
      opts?.hardCeilingBytes ??
      parseBytes("ACC2_MEM_HARD_BYTES") ??
      Math.floor(this.hostTotalBytes * hardFraction);
  }

  /** Register (idempotently, by name) a bounded cache under this budget. A
   *  re-register replaces the prior contract — safe across hot-reload. */
  registerCache(cache: RegisteredCache): void {
    this.caches.set(cache.name, cache);
  }

  /** Remove a cache from accounting (e.g. on hot-reload teardown). */
  unregisterCache(name: string): void {
    this.caches.delete(name);
  }

  /** Sum of every registered cache's current byte estimate. */
  trackedCacheBytes(): number {
    let total = 0;
    for (const c of this.caches.values()) {
      try {
        total += Math.max(0, c.estimatedBytes());
      } catch {
        /* a cache estimator must never break accounting */
      }
    }
    return total;
  }

  get softCeiling(): number {
    return this.softCeilingBytes;
  }

  get hardCeiling(): number {
    return this.hardCeilingBytes;
  }

  /** Snapshot current process memory pressure. Pushes the sample onto the
   *  bounded ring and computes the RSS slope across retained samples. */
  sampleMemoryPressure(nowMs?: number): MemoryPressureSample {
    const ts = nowMs ?? Date.now();
    const mu = process.memoryUsage();
    const sample: MemoryPressureSample = {
      ts_ms: ts,
      rss_bytes: mu.rss,
      heap_used_bytes: mu.heapUsed,
      external_bytes: mu.external,
      array_buffers_bytes: (mu as { arrayBuffers?: number }).arrayBuffers ?? 0,
      host_total_bytes: this.hostTotalBytes,
      tracked_cache_bytes: this.trackedCacheBytes(),
      rss_slope_bytes_per_min: 0,
      soft_ceiling_bytes: this.softCeilingBytes,
      hard_ceiling_bytes: this.hardCeilingBytes,
      pressure_ratio: this.softCeilingBytes > 0 ? mu.rss / this.softCeilingBytes : 0,
    };
    this.samples.push(sample);
    while (this.samples.length > SLOPE_RING_CAPACITY) this.samples.shift();
    sample.rss_slope_bytes_per_min = this.computeRssSlope();
    return sample;
  }

  /** Least-squares slope of rss_bytes vs ts (converted to bytes/min). Returns 0
   *  until at least 2 samples exist or when the time span is degenerate. */
  private computeRssSlope(): number {
    const n = this.samples.length;
    if (n < 2) return 0;
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumXX = 0;
    const t0 = this.samples[0]!.ts_ms;
    for (const s of this.samples) {
      const x = (s.ts_ms - t0) / 60_000; // minutes since first sample
      const y = s.rss_bytes;
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumXX += x * x;
    }
    const denom = n * sumXX - sumX * sumX;
    if (denom === 0) return 0;
    return (n * sumXY - sumX * sumY) / denom;
  }

  /**
   * Coordinated eviction when over the soft ceiling. Sheds cache bytes toward
   * a fair per-cache target so total tracked bytes drops below the headroom we
   * want back. No-op (returns 0) when RSS is under the soft ceiling. Emits a
   * single throttled telemetry_evicted event when any bytes are shed.
   *
   * `db` is optional so non-daemon contexts (tests) can drive eviction without
   * an event sink.
   */
  evictOnPressure(reason: string, db?: Database, nowMs?: number): number {
    const sample = this.sampleMemoryPressure(nowMs);
    if (sample.rss_bytes <= this.softCeilingBytes) return 0;
    if (this.caches.size === 0) return 0;

    // How aggressively to shed: linear ramp between soft and hard ceiling.
    // At the soft ceiling we want to reclaim a small fraction of tracked cache
    // bytes; at/above the hard ceiling we shed almost everything.
    const over = sample.rss_bytes - this.softCeilingBytes;
    const span = Math.max(1, this.hardCeilingBytes - this.softCeilingBytes);
    const shedFraction = Math.min(0.95, 0.25 + 0.7 * (over / span));

    let totalEvicted = 0;
    const perCacheEvictions: Record<string, number> = {};
    for (const cache of this.caches.values()) {
      let current = 0;
      try {
        current = Math.max(0, cache.estimatedBytes());
      } catch {
        continue;
      }
      const target = Math.floor(current * (1 - shedFraction));
      let evicted = 0;
      try {
        evicted = Math.max(0, cache.evictUntilBytes(target));
      } catch (err) {
        logger.debug(
          { where: "memory_budget.evict", cache: cache.name, err: String(err) },
          "cache eviction failed (swallowed)",
        );
        continue;
      }
      if (evicted > 0) {
        totalEvicted += evicted;
        perCacheEvictions[cache.name] = evicted;
      }
    }

    if (totalEvicted > 0 && db) {
      const ts = nowMs ?? Date.now();
      // Throttle to at most once per 5s so a tight admission loop can't flood.
      if (ts - this.lastEvictTelemetryMs >= 5_000) {
        this.lastEvictTelemetryMs = ts;
        try {
          emitEvent(db, {
            kind: "telemetry_evicted",
            substrate_origin: "substrate_auto",
            payload: {
              reason,
              evicted_bytes: totalEvicted,
              per_cache: perCacheEvictions,
              rss_bytes: sample.rss_bytes,
              soft_ceiling_bytes: this.softCeilingBytes,
              hard_ceiling_bytes: this.hardCeilingBytes,
              shed_fraction: Number(shedFraction.toFixed(3)),
              rss_slope_bytes_per_min: Math.round(sample.rss_slope_bytes_per_min),
            },
          });
        } catch {
          /* fail-soft telemetry */
        }
      }
    }
    return totalEvicted;
  }

  /** Test/diagnostic: drop sample ring + registered caches. */
  resetForTests(): void {
    this.caches.clear();
    this.samples.length = 0;
    this.lastEvictTelemetryMs = 0;
  }

  /** Names of currently-registered caches (diagnostic / /health). */
  registeredCacheNames(): string[] {
    return Array.from(this.caches.keys());
  }
}

// ── Process-global singleton ──────────────────────────────────────────────
// One budget per daemon process. Cache modules register against it at module
// load (lazily on first use) so registration survives import order. The daemon
// drives evictOnPressure from admission / /health / pre-brain-spawn.

let singleton: MemoryBudget | null = null;

export const getMemoryBudget = (): MemoryBudget => {
  if (!singleton) singleton = new MemoryBudget();
  return singleton;
};

/** Replace the singleton (tests). */
export const _setMemoryBudgetForTests = (budget: MemoryBudget | null): void => {
  singleton = budget;
};
