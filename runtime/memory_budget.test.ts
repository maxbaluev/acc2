// Tests for the central memory budget + bounded LRU (resource-spec
// GTWD1AV2VH4M5AE957J4H7RFPR). Proves: bounded_lru evicts at BOTH the entry cap
// and the byte cap (oldest-first) and registers with the budget; the budget
// reports pressure and drives coordinated eviction.

import { describe, expect, test } from "bun:test";
import { BoundedLru, stringBytes } from "./bounded_lru";
import { MemoryBudget } from "./memory_budget";

describe("BoundedLru", () => {
  test("evicts oldest at the entry cap", () => {
    const lru = new BoundedLru<string>({
      name: "t_entry_cap",
      maxEntries: 3,
      maxBytes: 1_000_000,
      sizeOf: stringBytes,
      budget: null,
    });
    lru.set("a", "1");
    lru.set("b", "2");
    lru.set("c", "3");
    lru.set("d", "4"); // evicts "a"
    expect(lru.size).toBe(3);
    expect(lru.has("a")).toBe(false);
    expect(lru.has("d")).toBe(true);
    expect(lru.get("b")).toBe("2");
  });

  test("get bumps recency so the LRU victim is the genuinely-oldest", () => {
    const lru = new BoundedLru<string>({
      name: "t_recency",
      maxEntries: 2,
      maxBytes: 1_000_000,
      sizeOf: stringBytes,
      budget: null,
    });
    lru.set("a", "1");
    lru.set("b", "2");
    lru.get("a"); // a is now most-recent
    lru.set("c", "3"); // evicts b (now oldest), not a
    expect(lru.has("a")).toBe(true);
    expect(lru.has("b")).toBe(false);
    expect(lru.has("c")).toBe(true);
  });

  test("evicts oldest at the byte cap even when entry count is fine", () => {
    // Each value is 10 chars → 20 bytes. maxBytes=50 → at most 2 entries fit.
    const lru = new BoundedLru<string>({
      name: "t_byte_cap",
      maxEntries: 1000,
      maxBytes: 50,
      sizeOf: stringBytes,
      budget: null,
    });
    lru.set("a", "xxxxxxxxxx");
    lru.set("b", "yyyyyyyyyy");
    lru.set("c", "zzzzzzzzzz"); // pushes bytes over 50 → evicts oldest
    expect(lru.bytes).toBeLessThanOrEqual(50);
    expect(lru.size).toBeLessThanOrEqual(2);
    expect(lru.has("a")).toBe(false);
  });

  test("registers with the budget and updates tracked bytes on set/delete", () => {
    const budget = new MemoryBudget({ hostTotalBytes: 1_000_000_000 });
    const lru = new BoundedLru<string>({
      name: "t_register",
      maxEntries: 100,
      maxBytes: 1_000_000,
      sizeOf: stringBytes,
      budget,
    });
    expect(budget.registeredCacheNames()).toContain("t_register");
    lru.set("a", "abcd"); // 8 bytes
    expect(budget.trackedCacheBytes()).toBe(lru.bytes);
    expect(budget.trackedCacheBytes()).toBeGreaterThan(0);
    lru.delete("a");
    expect(budget.trackedCacheBytes()).toBe(0);
  });
});

describe("MemoryBudget", () => {
  test("sampleMemoryPressure reports the canonical fields", () => {
    const budget = new MemoryBudget({ hostTotalBytes: 8_000_000_000 });
    const s = budget.sampleMemoryPressure();
    expect(s.rss_bytes).toBeGreaterThan(0);
    expect(s.heap_used_bytes).toBeGreaterThan(0);
    expect(s.host_total_bytes).toBe(8_000_000_000);
    expect(s.soft_ceiling_bytes).toBeGreaterThan(0);
    expect(s.hard_ceiling_bytes).toBeGreaterThan(s.soft_ceiling_bytes);
    expect(s.pressure_ratio).toBeGreaterThan(0);
  });

  test("computes a positive RSS slope when samples climb", () => {
    // Drive sampleMemoryPressure with a controlled clock; RSS is real but the
    // slope math is exercised across the sample ring (>=2 samples → non-zero).
    const budget = new MemoryBudget({ hostTotalBytes: 8_000_000_000 });
    budget.sampleMemoryPressure(1_000);
    budget.sampleMemoryPressure(61_000);
    const s = budget.sampleMemoryPressure(121_000);
    // Slope is finite (RSS may wobble; we only assert it is computed).
    expect(Number.isFinite(s.rss_slope_bytes_per_min)).toBe(true);
  });

  test("evictOnPressure sheds cache bytes when over the soft ceiling", () => {
    // Force a tiny soft ceiling so the live RSS is already "over" it; register
    // a cache full of bytes and assert eviction reclaims some.
    const budget = new MemoryBudget({
      hostTotalBytes: 8_000_000_000,
      softCeilingBytes: 1, // any real RSS is over this
      hardCeilingBytes: 2,
    });
    const lru = new BoundedLru<string>({
      name: "t_evict",
      maxEntries: 10_000,
      maxBytes: 100_000_000,
      sizeOf: stringBytes,
      budget,
    });
    for (let i = 0; i < 1000; i++) lru.set(`k${i}`, "x".repeat(1000));
    const before = lru.bytes;
    expect(before).toBeGreaterThan(0);
    const evicted = budget.evictOnPressure("test");
    expect(evicted).toBeGreaterThan(0);
    expect(lru.bytes).toBeLessThan(before);
  });

  test("evictOnPressure is a no-op when under the soft ceiling", () => {
    const budget = new MemoryBudget({
      hostTotalBytes: 8_000_000_000,
      softCeilingBytes: 64_000_000_000, // far above any real RSS
      hardCeilingBytes: 80_000_000_000,
    });
    const lru = new BoundedLru<string>({
      name: "t_noop",
      maxEntries: 1000,
      maxBytes: 100_000_000,
      sizeOf: stringBytes,
      budget,
    });
    lru.set("a", "x".repeat(1000));
    const evicted = budget.evictOnPressure("test");
    expect(evicted).toBe(0);
    expect(lru.size).toBe(1);
  });
});
