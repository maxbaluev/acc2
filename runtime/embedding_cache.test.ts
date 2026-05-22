import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import {
  QUERY_EMBEDDING_CACHE_TTL_MS,
  _resetQueryEmbeddingCacheForTests,
  getCachedQueryEmbedding,
  invalidateQueryEmbeddingCache,
  queryEmbeddingCacheStats,
} from "./embedding_cache";
import { EMBEDDING_VERSION } from "./embedder";
import type { EmbeddingResult } from "./embedder";

afterAll(() => closeDb());
beforeEach(() => {
  closeDb();
  _resetQueryEmbeddingCacheForTests();
});

// Deterministic stub embedder: same text -> same vector, and a call counter so
// we can prove the cache actually suppressed a recompute.
const makeStub = () => {
  let calls = 0;
  const fn = async (text: string): Promise<EmbeddingResult> => {
    calls++;
    // Cheap deterministic vector derived from the text — stands in for the
    // (deterministic-given-text) OpenAI embedding.
    const vec = Array.from({ length: 4 }, (_, i) => (text.charCodeAt(i % text.length) || 0) / 128);
    return { embedding: vec, version: EMBEDDING_VERSION };
  };
  return { fn, calls: () => calls };
};

describe("embedding_cache", () => {
  test("cache hit returns a result identical to a fresh compute, without recomputing", async () => {
    const db = openDb(":memory:");
    const stub = makeStub();

    // First call: miss -> computes.
    const fresh = await getCachedQueryEmbedding(db, "find retrieval bugs", { compute: stub.fn });
    expect(fresh).not.toBeNull();
    expect(stub.calls()).toBe(1);

    // Second call same text: hit -> must NOT recompute and must be identical.
    const cached = await getCachedQueryEmbedding(db, "find retrieval bugs", { compute: stub.fn });
    expect(stub.calls()).toBe(1); // no extra compute
    expect(cached).toEqual(fresh); // provably identical result

    // And identical to a direct fresh compute of the same text.
    const direct = await stub.fn("find retrieval bugs");
    expect(cached!.embedding).toEqual(direct.embedding);
    expect(cached!.version).toEqual(direct.version);

    const stats = queryEmbeddingCacheStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
  });

  test("different query text is a separate key (no cross-contamination)", async () => {
    const db = openDb(":memory:");
    const stub = makeStub();
    const a = await getCachedQueryEmbedding(db, "alpha query", { compute: stub.fn });
    const b = await getCachedQueryEmbedding(db, "beta query", { compute: stub.fn });
    expect(stub.calls()).toBe(2); // both computed
    expect(a).not.toEqual(b);
  });

  test("TTL expiry invalidates: a fresh compute runs after the entry ages out", async () => {
    const db = openDb(":memory:");
    const stub = makeStub();
    const t0 = 1_000_000;
    await getCachedQueryEmbedding(db, "stale me", { compute: stub.fn, nowMs: t0 });
    expect(stub.calls()).toBe(1);

    // Within TTL -> hit, no recompute.
    await getCachedQueryEmbedding(db, "stale me", { compute: stub.fn, nowMs: t0 + 1 });
    expect(stub.calls()).toBe(1);

    // Past TTL -> miss, recompute.
    await getCachedQueryEmbedding(db, "stale me", {
      compute: stub.fn,
      nowMs: t0 + QUERY_EMBEDDING_CACHE_TTL_MS + 1,
    });
    expect(stub.calls()).toBe(2);
  });

  test("explicit invalidation forces a fresh compute (model/version-change path)", async () => {
    const db = openDb(":memory:");
    const stub = makeStub();
    await getCachedQueryEmbedding(db, "invalidate me", { compute: stub.fn });
    expect(stub.calls()).toBe(1);
    invalidateQueryEmbeddingCache();
    await getCachedQueryEmbedding(db, "invalidate me", { compute: stub.fn });
    expect(stub.calls()).toBe(2);
  });

  test("null result (missing creds / fetch failure) is NOT cached so recovery re-tries", async () => {
    const db = openDb(":memory:");
    let calls = 0;
    const flaky = async (): Promise<EmbeddingResult | null> => {
      calls++;
      // First call fails (null), second succeeds.
      return calls === 1 ? null : { embedding: [0.1, 0.2, 0.3, 0.4], version: EMBEDDING_VERSION };
    };
    const first = await getCachedQueryEmbedding(db, "flaky", { compute: flaky });
    expect(first).toBeNull();
    // Second call must recompute (null was not cached) and now succeed.
    const second = await getCachedQueryEmbedding(db, "flaky", { compute: flaky });
    expect(second).not.toBeNull();
    expect(calls).toBe(2);
  });

  test("emits query_embedding_cache_miss then _hit telemetry events", async () => {
    const db = openDb(":memory:");
    const stub = makeStub();
    await getCachedQueryEmbedding(db, "telemetry", { compute: stub.fn });
    await getCachedQueryEmbedding(db, "telemetry", { compute: stub.fn });
    const miss = db.query("SELECT COUNT(*) AS c FROM events WHERE kind = 'query_embedding_cache_miss'").get() as { c: number };
    const hit = db.query("SELECT COUNT(*) AS c FROM events WHERE kind = 'query_embedding_cache_hit'").get() as { c: number };
    expect(miss.c).toBe(1);
    expect(hit.c).toBe(1);
  });
});
