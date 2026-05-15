import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { newId } from "./ids";
import {
  PROMPT_CACHE_TTL_MS,
  _resetPromptCacheForTests,
  invalidatePromptCache,
  lookupCachedPrompt,
  promptCacheStats,
  recordPromptCacheHit,
  recordPromptCacheMiss,
  storeCachedPrompt,
} from "./prompt_cache";
import { emitEvent } from "./events";

afterAll(() => closeDb());
beforeEach(() => {
  closeDb();
  _resetPromptCacheForTests();
});

const key = (directiveId: string, taskId: string, sig = "v1") => ({
  directive_id: directiveId,
  task_id: taskId,
  options_signature: sig,
});

describe("prompt_cache", () => {
  test("miss when no entry exists; hit after store with same key + unchanged high-water", () => {
    const db = openDb(":memory:");
    const k = key(newId(), newId());
    expect(lookupCachedPrompt(db, k).hit).toBe(false);
    storeCachedPrompt(db, k, { text: "composed_prompt_v1" });
    const result = lookupCachedPrompt<{ text: string }>(db, k);
    expect(result.hit).toBe(true);
    if (result.hit) expect(result.value.text).toBe("composed_prompt_v1");
  });

  test("new event invalidates the cache (high-water advanced)", () => {
    const db = openDb(":memory:");
    const k = key(newId(), newId());
    storeCachedPrompt(db, k, { text: "stale" });
    emitEvent(db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      payload: { directive_text: "anything", lifecycle: "finite" },
    });
    const result = lookupCachedPrompt(db, k);
    expect(result.hit).toBe(false);
    if (!result.hit) expect(result.reason).toBe("high_water_advanced");
  });

  test("TTL expiry invalidates", () => {
    const db = openDb(":memory:");
    const k = key(newId(), newId());
    const fakeNow = Date.now();
    storeCachedPrompt(db, k, { text: "fresh" }, { nowMs: fakeNow });
    const result = lookupCachedPrompt(db, k, { nowMs: fakeNow + PROMPT_CACHE_TTL_MS + 1000 });
    expect(result.hit).toBe(false);
    if (!result.hit) expect(result.reason).toBe("ttl_expired");
  });

  test("different options_signature is a different cache entry (separate state)", () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const taskId = newId();
    storeCachedPrompt(db, key(directiveId, taskId, "v1"), { text: "A" });
    storeCachedPrompt(db, key(directiveId, taskId, "v2"), { text: "B" });
    const a = lookupCachedPrompt<{ text: string }>(db, key(directiveId, taskId, "v1"));
    const b = lookupCachedPrompt<{ text: string }>(db, key(directiveId, taskId, "v2"));
    expect(a.hit && a.value.text).toBe("A");
    expect(b.hit && b.value.text).toBe("B");
  });

  test("recordPromptCacheHit + recordPromptCacheMiss emit telemetry events explicitly", () => {
    const db = openDb(":memory:");
    const k = key(newId(), newId());
    recordPromptCacheMiss(db, k, "no_entry");
    recordPromptCacheHit(db, k, 42);
    const hits = db.query("SELECT COUNT(*) AS c FROM events WHERE kind = 'prompt_composition_cache_hit'").get() as { c: number };
    const misses = db.query("SELECT COUNT(*) AS c FROM events WHERE kind = 'prompt_composition_cache_miss'").get() as { c: number };
    expect(hits.c).toBe(1);
    expect(misses.c).toBe(1);
  });

  test("invalidatePromptCache drops every entry", () => {
    const db = openDb(":memory:");
    const k = key(newId(), newId());
    storeCachedPrompt(db, k, { text: "y" });
    invalidatePromptCache();
    expect(lookupCachedPrompt(db, k).hit).toBe(false);
  });

  test("promptCacheStats tracks running hit/miss totals (pure lookups, no event side effects)", () => {
    const db = openDb(":memory:");
    const k = key(newId(), newId());
    lookupCachedPrompt(db, k); // miss
    storeCachedPrompt(db, k, { text: "z" });
    lookupCachedPrompt(db, k); // hit
    lookupCachedPrompt(db, k); // hit — no events emitted from lookup itself
    const stats = promptCacheStats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.hit_rate).toBeCloseTo(2 / 3);
  });
});
