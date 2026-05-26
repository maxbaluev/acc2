// Daemon memory load test (resource-spec GTWD1AV2VH4M5AE957J4H7RFPR).
//
// PROVES THE FIX: the bounded caches do NOT grow without bound under many
// inserts — the leak that grew the daemon RSS from 2.4 GB to 8.6 GB before a
// native SIGILL. Drives the three migrated caches (prompt_cache,
// embedding_cache, embedding_index jsEntries) with FAR more inserts than their
// caps and asserts entry count AND tracked bytes stay capped (and the global
// budget's tracked-cache-bytes total stays bounded).

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { newId } from "./ids";
import {
  PROMPT_CACHE_MAX_ENTRIES,
  PROMPT_CACHE_MAX_BYTES,
  _resetPromptCacheForTests,
  lookupCachedPrompt,
  promptCacheStats,
  storeCachedPrompt,
} from "./prompt_cache";
import {
  QUERY_EMBEDDING_CACHE_MAX_ENTRIES,
  QUERY_EMBEDDING_CACHE_MAX_BYTES,
  _resetQueryEmbeddingCacheForTests,
  getCachedQueryEmbedding,
  queryEmbeddingCacheStats,
} from "./embedding_cache";
import {
  EMBEDDING_INDEX_MAX_INLINE_ENTRIES,
  EmbeddingIndex,
  type IndexEntry,
} from "./embedding_index";
import { getMemoryBudget } from "./memory_budget";
import { EMBEDDING_VERSION } from "./embedder";

afterAll(() => closeDb());
beforeEach(() => {
  closeDb();
  _resetPromptCacheForTests();
  _resetQueryEmbeddingCacheForTests();
});

describe("daemon memory load — bounded caches stay capped", () => {
  test("prompt_cache stays under entry AND byte caps across 50× the cap inserts", () => {
    const db = openDb(":memory:");
    const inserts = PROMPT_CACHE_MAX_ENTRIES * 50;
    // Each value is a sizeable composed-prompt-shaped string (~4 KB) so the
    // byte cap is exercised, not just the entry cap.
    const bigPrompt = { text: "x".repeat(4096) };
    for (let i = 0; i < inserts; i++) {
      storeCachedPrompt(db, { directive_id: newId(), task_id: newId(), options_signature: "v1" }, bigPrompt);
    }
    const stats = promptCacheStats();
    expect(stats.entries).toBeLessThanOrEqual(PROMPT_CACHE_MAX_ENTRIES);
    expect(stats.bytes).toBeLessThanOrEqual(PROMPT_CACHE_MAX_BYTES);
    // The cache still serves hits — eviction is transparent.
    const k = { directive_id: newId(), task_id: newId(), options_signature: "v1" };
    storeCachedPrompt(db, k, { text: "served" });
    const hit = lookupCachedPrompt<{ text: string }>(db, k);
    expect(hit.hit).toBe(true);
  });

  test("embedding_cache stays under entry AND byte caps across many distinct queries", async () => {
    const db = openDb(":memory:");
    const dims = 1536;
    const compute = async (text: string) => ({
      embedding: new Array(dims).fill(0).map((_, j) => (text.length + j) % 7),
      version: EMBEDDING_VERSION,
    });
    const inserts = QUERY_EMBEDDING_CACHE_MAX_ENTRIES * 10;
    for (let i = 0; i < inserts; i++) {
      await getCachedQueryEmbedding(db, `query-${i}-${"q".repeat(i % 32)}`, { compute });
    }
    const stats = queryEmbeddingCacheStats();
    expect(stats.entries).toBeLessThanOrEqual(QUERY_EMBEDDING_CACHE_MAX_ENTRIES);
    expect(stats.bytes).toBeLessThanOrEqual(QUERY_EMBEDDING_CACHE_MAX_BYTES);
  });

  test("embedding_index jsEntries (inline fallback) stays capped under a flood of inserts", () => {
    const db = openDb(":memory:");
    const idx = EmbeddingIndex.rebuildFromDb(db);
    // Use dim != 1536 so vec0 refuses and the entry lands in the bounded inline
    // store — the previously-UNBOUNDED jsEntries leak this fix closes.
    const dims = 8;
    const inserts = EMBEDDING_INDEX_MAX_INLINE_ENTRIES * 4;
    for (let i = 0; i < inserts; i++) {
      const vec = new Float32Array(dims);
      vec[i % dims] = 1;
      const entry: IndexEntry = {
        event_id: newId(),
        embedding: vec,
        kind: "knowledge_promoted",
        ts: new Date().toISOString(),
        directive_id: newId(),
        task_id: newId(),
        substrate_origin: "claude_root",
        embedding_version: EMBEDDING_VERSION,
        retrieval_aspects: {},
        retrieval_domains: {},
        snippet: "y".repeat(64),
      };
      idx.add(entry);
    }
    // size() = vecCount() (0 here, all refused) + jsEntries.size — must be
    // capped at the inline-entry ceiling, NOT inserts.
    expect(idx.size()).toBeLessThanOrEqual(EMBEDDING_INDEX_MAX_INLINE_ENTRIES);
    expect(idx.size()).toBeLessThan(inserts);
  });

  test("global budget tracked-cache-bytes stays bounded after warmup (non-monotonic)", () => {
    const db = openDb(":memory:");
    const budget = getMemoryBudget();
    const bigPrompt = { text: "x".repeat(4096) };
    // Warm up past the caps.
    for (let i = 0; i < PROMPT_CACHE_MAX_ENTRIES * 5; i++) {
      storeCachedPrompt(db, { directive_id: newId(), task_id: newId(), options_signature: "v1" }, bigPrompt);
    }
    const afterWarmup = budget.trackedCacheBytes();
    // Continue inserting MANY more — tracked bytes must NOT keep climbing
    // (the meltdown signature was a monotonic RSS climb under sustained load).
    for (let i = 0; i < PROMPT_CACHE_MAX_ENTRIES * 20; i++) {
      storeCachedPrompt(db, { directive_id: newId(), task_id: newId(), options_signature: "v1" }, bigPrompt);
    }
    const afterSustained = budget.trackedCacheBytes();
    // Allow a small tolerance for byte-estimate jitter; the key invariant is
    // that sustained load does not grow tracked bytes unbounded.
    expect(afterSustained).toBeLessThanOrEqual(afterWarmup * 1.1 + 4096);
    expect(afterSustained).toBeLessThanOrEqual(PROMPT_CACHE_MAX_BYTES);
  });
});
