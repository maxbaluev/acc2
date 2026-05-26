// acc2 reusable bounded LRU (resource-spec GTWD1AV2VH4M5AE957J4H7RFPR, 2026-05-26).
//
// A single Map-backed LRU with BOTH an entry cap AND a byte cap. Insertion
// order is the recency order: a hit (get) bumps the key to the most-recent
// slot; eviction always drops the oldest (least-recently-used) entry first.
// Every insert/eviction keeps tracked bytes <= byteCap and size <= maxEntries.
//
// Why both caps: an entry-count cap alone is what let the daemon RSS melt down
// — 200 prompt entries is cheap if each is 2 KB but catastrophic if each is a
// multi-MB composed prompt. The byte cap is the real memory governor; the entry
// cap is a cheap secondary bound. Each LRU also registers itself with the
// process-wide MemoryBudget so coordinated eviction (evictOnPressure) can shed
// its bytes when global RSS climbs, not just its own local caps.
//
// The caller supplies a sizeOf(value) estimator. It does not need to be exact —
// it only needs to be monotone-ish so the byte cap tracks real growth. For
// strings we use the UTF-16 length × 2; for Float32Array embeddings we use the
// byteLength; composite values sum their parts.

import { getMemoryBudget, type MemoryBudget } from "./memory_budget";

export type BoundedLruOptions<V> = {
  /** Stable name for MemoryBudget registration + telemetry. */
  name: string;
  /** Hard cap on entry count. */
  maxEntries: number;
  /** Hard cap on summed value bytes. */
  maxBytes: number;
  /** Best-effort byte size of one value. */
  sizeOf: (value: V) => number;
  /** Override the budget the LRU registers with (tests). Defaults to the
   *  process singleton. Pass `null` to skip registration entirely. */
  budget?: MemoryBudget | null;
};

type Node<V> = {
  value: V;
  bytes: number;
};

export class BoundedLru<V> {
  private readonly map = new Map<string, Node<V>>();
  private trackedBytes = 0;
  readonly name: string;
  readonly maxEntries: number;
  readonly maxBytes: number;
  private readonly sizeOf: (value: V) => number;

  constructor(opts: BoundedLruOptions<V>) {
    this.name = opts.name;
    this.maxEntries = Math.max(1, opts.maxEntries);
    this.maxBytes = Math.max(1, opts.maxBytes);
    this.sizeOf = opts.sizeOf;
    const budget = opts.budget === undefined ? getMemoryBudget() : opts.budget;
    if (budget) {
      budget.registerCache({
        name: this.name,
        estimatedBytes: () => this.trackedBytes,
        evictUntilBytes: (target) => this.evictUntilBytes(target),
        clear: () => this.clear(),
      });
    }
  }

  get size(): number {
    return this.map.size;
  }

  get bytes(): number {
    return this.trackedBytes;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  /** Get a value, bumping it to most-recently-used. */
  get(key: string): V | undefined {
    const node = this.map.get(key);
    if (node === undefined) return undefined;
    // Re-insert to move to the end (most-recent) of insertion order.
    this.map.delete(key);
    this.map.set(key, node);
    return node.value;
  }

  /** Peek without changing recency. */
  peek(key: string): V | undefined {
    return this.map.get(key)?.value;
  }

  /** Insert / replace a value, then enforce both caps (oldest-first). */
  set(key: string, value: V): void {
    const bytes = Math.max(0, this.sizeOf(value));
    const existing = this.map.get(key);
    if (existing) {
      this.trackedBytes -= existing.bytes;
      this.map.delete(key);
    }
    this.map.set(key, { value, bytes });
    this.trackedBytes += bytes;
    this.enforceCaps();
  }

  delete(key: string): boolean {
    const node = this.map.get(key);
    if (node === undefined) return false;
    this.trackedBytes -= node.bytes;
    this.map.delete(key);
    return true;
  }

  clear(): void {
    this.map.clear();
    this.trackedBytes = 0;
  }

  /** Iterate values in recency order (oldest-first). Does NOT change recency —
   *  use for read-only scans (e.g. linear-scan fallbacks). */
  *values(): IterableIterator<V> {
    for (const node of this.map.values()) yield node.value;
  }

  /** Iterate [key, value] pairs in recency order (oldest-first). Read-only. */
  *entries(): IterableIterator<[string, V]> {
    for (const [k, node] of this.map.entries()) yield [k, node.value];
  }

  /** Evict oldest entries until tracked bytes <= targetBytes. Returns the
   *  number of bytes evicted. Used by MemoryBudget.evictOnPressure. */
  evictUntilBytes(targetBytes: number): number {
    let evicted = 0;
    while (this.trackedBytes > targetBytes && this.map.size > 0) {
      const oldestKey = this.map.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const node = this.map.get(oldestKey)!;
      this.trackedBytes -= node.bytes;
      this.map.delete(oldestKey);
      evicted += node.bytes;
    }
    return evicted;
  }

  /** Enforce the entry cap then the byte cap, evicting oldest-first. */
  private enforceCaps(): void {
    while (this.map.size > this.maxEntries) {
      const oldestKey = this.map.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const node = this.map.get(oldestKey)!;
      this.trackedBytes -= node.bytes;
      this.map.delete(oldestKey);
    }
    if (this.trackedBytes > this.maxBytes) {
      this.evictUntilBytes(this.maxBytes);
    }
  }

  /** Snapshot for telemetry / tests. */
  stats(): { entries: number; bytes: number; max_entries: number; max_bytes: number } {
    return {
      entries: this.map.size,
      bytes: this.trackedBytes,
      max_entries: this.maxEntries,
      max_bytes: this.maxBytes,
    };
  }
}

/** Cheap byte estimate for a UTF-16 string (length × 2). */
export const stringBytes = (s: string): number => s.length * 2;
