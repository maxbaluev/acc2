// acc2 retrieval reranker tests — end-to-end with a seeded substrate,
// embedded events, and a mocked OpenAI fetch for the query embedding.
// Asserts: top-K ordering matches expected distance ranking, kindFilter
// scopes the result set, and mixed-version rows are excluded with the
// counter incremented.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { runViews } from "../substrate/views";
import { emitEvent } from "./events";
import { encodeEmbeddingBlob, EMBEDDING_VERSION, EMBEDDING_DIMS } from "./embedder";
import { EmbeddingIndex } from "./embedding_index";
import { retrieve, retrieveWithEmbedding } from "./retrieval";
import { clearSqlPool, setSqlPool } from "./sql_pool_singleton";
import type { SqlWorkerPool } from "./sql_worker_pool";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const originalFetch = globalThis.fetch;
const originalKey = process.env.OPENAI_API_KEY;

const installMockFetch = (
  responder: (url: string, init: RequestInit) => Response | Promise<Response>,
): void => {
  globalThis.fetch = (async (input: any, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : (input?.url ?? String(input));
    return responder(url, init ?? {});
  }) as typeof fetch;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalKey;
});

const makeUnitVec = (dims: number, axis: number): number[] => {
  const v = new Array<number>(dims).fill(0);
  v[axis] = 1;
  return v;
};

const seedEmbedded = (
  db: ReturnType<typeof openDb>,
  kind: string,
  text: string,
  axis: number,
  dims: number,
  version: string = EMBEDDING_VERSION,
  payloadExtras: Record<string, unknown> = {},
): string => {
  const seeded = emitEvent(db, {
    kind: kind as any,
    substrate_origin: "claude_root",
    payload: { text, ...payloadExtras },
  });
  db.run(
    "UPDATE events SET embedding = ?, embedding_version = ? WHERE id = ?",
    [encodeEmbeddingBlob(makeUnitVec(dims, axis)), version, seeded.id],
  );
  return seeded.id;
};

describe("retrieve (full async path with mocked query embed)", () => {
  test("returns [] hits when index is empty", async () => {
    const db = openDb(":memory:");
    runViews(db);
    const idx = EmbeddingIndex.rebuildFromDb(db);
    const result = await retrieve(db, idx, { text: "anything", k: 5 });
    expect(result.hits).toEqual([]);
  });

  test("returns query_embedding_unavailable when no API key", async () => {
    delete process.env.OPENAI_API_KEY;
    const db = openDb(":memory:");
    runViews(db);
    seedEmbedded(db, "knowledge_candidate", "topic", 0, 8);
    const idx = EmbeddingIndex.rebuildFromDb(db);
    const result = await retrieve(db, idx, { text: "anything", k: 5 });
    expect(result.query_embedding_unavailable).toBe(true);
    expect(result.hits).toEqual([]);
  });

  test("top-K ordering matches distance ranking after rerank", async () => {
    process.env.OPENAI_API_KEY = "sk-test-mock";
    const dims = EMBEDDING_DIMS;
    // Mock the OpenAI fetch to return a known query vector pointing at axis 0.
    installMockFetch(async () => {
      const data = { data: [{ embedding: makeUnitVec(dims, 0), index: 0 }] };
      return new Response(JSON.stringify(data), { status: 200 });
    });

    const db = openDb(":memory:");
    runViews(db);
    const nearId = seedEmbedded(db, "knowledge_candidate", "near axis-0", 0, dims);
    const farId = seedEmbedded(db, "knowledge_candidate", "far axis-7", 7, dims);
    seedEmbedded(db, "knowledge_candidate", "mid axis-3", 3, dims);

    const idx = EmbeddingIndex.rebuildFromDb(db);
    const result = await retrieve(db, idx, { text: "looking for axis-0", k: 3 });
    expect(result.hits.length).toBe(3);
    // Nearest must lead — the one whose embedding equals the query.
    expect(result.hits[0].event_id).toBe(nearId);
    // The orthogonal entries (mid + far) are both ≈ orthogonal to the query
    // so they share a distance band; we don't pin their relative order, but
    // farId must NOT be the lead.
    expect(result.hits[0].event_id).not.toBe(farId);
    // And the lead's rerank score must dominate the trailing entry's.
    expect(result.hits[0].rerank_score).toBeGreaterThan(result.hits[2].rerank_score);
  });

  test("kindFilter scopes the hit set", async () => {
    process.env.OPENAI_API_KEY = "sk-test-mock";
    const dims = EMBEDDING_DIMS;
    installMockFetch(async () => {
      const data = { data: [{ embedding: makeUnitVec(dims, 0), index: 0 }] };
      return new Response(JSON.stringify(data), { status: 200 });
    });
    const db = openDb(":memory:");
    runViews(db);
    seedEmbedded(db, "knowledge_candidate", "k-c near", 0, dims);
    const artId = seedEmbedded(db, "act_artifact_admitted", "art near", 0, dims);
    const idx = EmbeddingIndex.rebuildFromDb(db);
    const result = await retrieve(db, idx, {
      text: "anything",
      k: 5,
      kindFilter: ["act_artifact_admitted", "act_artifact_promoted"],
    });
    expect(result.hits.length).toBe(1);
    expect(result.hits[0].event_id).toBe(artId);
  });

  test("mixed-version rows are excluded; counter increments", async () => {
    process.env.OPENAI_API_KEY = "sk-test-mock";
    const dims = EMBEDDING_DIMS;
    installMockFetch(async () => {
      const data = { data: [{ embedding: makeUnitVec(dims, 0), index: 0 }] };
      return new Response(JSON.stringify(data), { status: 200 });
    });
    const db = openDb(":memory:");
    runViews(db);
    const sameVerId = seedEmbedded(db, "knowledge_candidate", "current-v entry", 0, dims);
    seedEmbedded(db, "knowledge_candidate", "stale-v entry", 0, dims, "v_LEGACY");
    const idx = EmbeddingIndex.rebuildFromDb(db);
    const result = await retrieve(db, idx, { text: "anything", k: 5 });
    expect(result.hits.length).toBe(1);
    expect(result.hits[0].event_id).toBe(sameVerId);
    expect(result.mixed_version_excluded).toBe(1);
  });
});

describe("sqlite-vec backed retrieval — clustered synthetic events", () => {
  // End-to-end exercise of the canonical SQL path. We embed 20 events
  // across three clusters at 1536-dim (so vec_events accepts them) and
  // confirm that querying for one cluster's centroid returns hits from
  // that cluster, NOT the other clusters.
  const makeClusterVec = (cluster: number, jitterSeed: number): number[] => {
    const v = new Array<number>(EMBEDDING_DIMS).fill(0);
    // Cluster centroid axes: 0..3, 100..103, 200..203. The seed adds
    // tiny per-event jitter so each event has a unique embedding.
    const base = cluster * 100;
    v[base] = 1;
    v[base + 1] = 0.5;
    v[base + 2] = 0.5;
    v[base + 3] = 0.5;
    // Add small uniform jitter outside the cluster centre.
    const j = ((jitterSeed * 9301 + 49297) % 233280) / 233280;
    v[base + 4] = j * 0.01;
    return v;
  };
  const seedClusterEvent = (
    db: ReturnType<typeof openDb>,
    cluster: number,
    seed: number,
  ): string => {
    const seeded = emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "claude_root",
      payload: { text: `cluster-${cluster}-seed-${seed}` },
    });
    const vec = makeClusterVec(cluster, seed);
    db.run(
      "UPDATE events SET embedding = ?, embedding_version = ? WHERE id = ?",
      [encodeEmbeddingBlob(vec), EMBEDDING_VERSION, seeded.id],
    );
    return seeded.id;
  };

  test("top-K results all come from the queried cluster", async () => {
    process.env.OPENAI_API_KEY = "sk-test-mock";
    // Query embedding = cluster 1's centroid (no jitter).
    const queryVec = (() => {
      const v = new Array<number>(EMBEDDING_DIMS).fill(0);
      v[100] = 1; v[101] = 0.5; v[102] = 0.5; v[103] = 0.5;
      return v;
    })();
    installMockFetch(async () => {
      const data = { data: [{ embedding: queryVec, index: 0 }] };
      return new Response(JSON.stringify(data), { status: 200 });
    });

    const db = openDb(":memory:");
    runViews(db);
    const cluster1Ids = new Set<string>();
    // 20 events: 7 in cluster 1, 7 in cluster 0, 6 in cluster 2.
    for (let i = 0; i < 7; i++) cluster1Ids.add(seedClusterEvent(db, 1, i));
    for (let i = 0; i < 7; i++) seedClusterEvent(db, 0, i + 100);
    for (let i = 0; i < 6; i++) seedClusterEvent(db, 2, i + 200);

    const idx = EmbeddingIndex.rebuildFromDb(db);
    expect(idx.size()).toBe(20);
    const result = await retrieve(db, idx, { text: "cluster 1 query", k: 5 });
    expect(result.hits.length).toBe(5);
    // All top-5 must come from cluster 1.
    for (const hit of result.hits) {
      expect(cluster1Ids.has(hit.event_id)).toBe(true);
    }
  });
});

describe("retrieveWithEmbedding (sync variant, no API call)", () => {
  test("ranks identical entries against a unit-axis query in the expected order", () => {
    const db = openDb(":memory:");
    runViews(db);
    const dims = 8;
    const nearId = seedEmbedded(db, "knowledge_candidate", "near axis-0", 0, dims);
    seedEmbedded(db, "knowledge_candidate", "axis-1", 1, dims);
    seedEmbedded(db, "knowledge_candidate", "axis-2", 2, dims);
    const idx = EmbeddingIndex.rebuildFromDb(db);
    const query = new Float32Array(makeUnitVec(dims, 0));
    const result = retrieveWithEmbedding(db, idx, query, { k: 3 });
    expect(result.hits.length).toBe(3);
    expect(result.hits[0].event_id).toBe(nearId);
  });
});

describe("per-(origin, goal_shape) bias (Phase H)", () => {
  test("two distinct goal_texts produce distinct origin-bias maps when shape-specific data differs", () => {
    const db = openDb(":memory:");
    runViews(db);
    const dims = 8;

    // Seed two directives with distinct goals.
    const d1 = emitEvent(db, {
      kind: "directive_opened",
      directive_id: "dir_alpha",
      task_id: "t_alpha",
      payload: { goal: "Count TODO markers in scripts" },
    });
    const d2 = emitEvent(db, {
      kind: "directive_opened",
      directive_id: "dir_beta",
      task_id: "t_beta",
      payload: { goal: "Audit substrate events for failures" },
    });
    expect(d1.id).toBeTruthy();
    expect(d2.id).toBeTruthy();

    // Under dir_alpha: opencode has high candidate→promotion rate (looks good on this shape).
    for (let i = 0; i < 4; i++) {
      emitEvent(db, {
        kind: "knowledge_candidate",
        substrate_origin: "opencode",
        directive_id: "dir_alpha",
        task_id: "t_alpha",
        payload: { text: `candidate-${i}` },
      });
      emitEvent(db, {
        kind: "knowledge_promoted",
        substrate_origin: "opencode",
        directive_id: "dir_alpha",
        task_id: "t_alpha",
        payload: { text: `promoted-${i}` },
      });
    }
    // Under dir_beta: opencode has poor ratio (only candidates, no promotions).
    for (let i = 0; i < 4; i++) {
      emitEvent(db, {
        kind: "knowledge_candidate",
        substrate_origin: "opencode",
        directive_id: "dir_beta",
        task_id: "t_beta",
        payload: { text: `candidate-${i}` },
      });
    }

    // Seed an embedded knowledge_candidate so the index has content. Its
    // origin = opencode so the per-(origin, goal_shape) lookup is what we
    // exercise.
    const evId = emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "opencode",
      payload: { text: "target hit" },
    });
    db.run(
      "UPDATE events SET embedding = ?, embedding_version = ? WHERE id = ?",
      [encodeEmbeddingBlob(makeUnitVec(dims, 0)), EMBEDDING_VERSION, evId.id],
    );

    const idx = EmbeddingIndex.rebuildFromDb(db);
    const query = new Float32Array(makeUnitVec(dims, 0));

    // With the dir_alpha goal text, opencode bias is high (~1.0 ratio).
    const alphaResult = retrieveWithEmbedding(db, idx, query, {
      k: 1,
      goalText: "Count TODO markers in scripts",
    });
    // With the dir_beta goal text, opencode bias is low (0 promotions).
    const betaResult = retrieveWithEmbedding(db, idx, query, {
      k: 1,
      goalText: "Audit substrate events for failures",
    });

    expect(alphaResult.hits.length).toBe(1);
    expect(betaResult.hits.length).toBe(1);
    // The same hit content, different rerank_score because the per-shape
    // origin-bias multiplier differs across goal_shapes.
    expect(alphaResult.hits[0].rerank_score).not.toBe(betaResult.hits[0].rerank_score);
    // The good-shape result must dominate the bad-shape result.
    expect(alphaResult.hits[0].rerank_score).toBeGreaterThan(betaResult.hits[0].rerank_score);
  });

  test("missing goalText falls back to the global per-origin ratio", () => {
    const db = openDb(":memory:");
    runViews(db);
    const dims = 8;
    const evId = emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "opencode",
      payload: { text: "hit" },
    });
    db.run(
      "UPDATE events SET embedding = ?, embedding_version = ? WHERE id = ?",
      [encodeEmbeddingBlob(makeUnitVec(dims, 0)), EMBEDDING_VERSION, evId.id],
    );
    const idx = EmbeddingIndex.rebuildFromDb(db);
    const query = new Float32Array(makeUnitVec(dims, 0));
    const result = retrieveWithEmbedding(db, idx, query, { k: 1 });
    expect(result.hits.length).toBe(1);
  });
});

describe("multi-vector/domain routed retrieval", () => {
  test("domain hints and aspect weights boost payload-matched knowledge without fixed enums", () => {
    const db = openDb(":memory:");
    runViews(db);
    const dims = 8;
    const genericId = seedEmbedded(db, "knowledge_candidate", "generic retrieval", 0, dims);
    const domainId = seedEmbedded(db, "knowledge_candidate", "generic retrieval", 0, dims, EMBEDDING_VERSION, {
      retrieval_aspects: { any_axis: "knowledge retrieval calibration" },
      retrieval_domains: { accint_knowledge_efficiency: 1 },
    });
    const idx = EmbeddingIndex.rebuildFromDb(db);
    const query = new Float32Array(makeUnitVec(dims, 0));
    const result = retrieveWithEmbedding(db, idx, query, {
      k: 2,
      goalText: "improve knowledge retrieval calibration",
      aspectWeights: { any_axis: 1 },
      domainHints: { accint_knowledge_efficiency: 1 },
    });
    expect(result.hits.map((h) => h.event_id)).toContain(genericId);
    expect(result.hits[0].event_id).toBe(domainId);
    expect(result.hits[0].routing_score_breakdown.domain_boost).toBeGreaterThan(0);
    expect(result.hits[0].aspect_scores.any_axis).toBeGreaterThan(0);
  });
});

describe("off-loop posterior reads (SQL worker pool) are byte-identical to sync", () => {
  // The async `retrieve` path routes its per-hit posterior point reads
  // through `poolQuery`. When the daemon installed a SQL worker pool, those
  // SELECTs execute off the main event loop. Correctness invariant: the
  // pooled path must return the EXACT same hits (same rows, same order, same
  // scoring) as the synchronous fallback — `poolQuery` issues identical SQL
  // against the same db handle, so only the execution thread differs.
  afterEach(() => clearSqlPool());

  /** A mock pool whose `query` delegates to the SAME db via the synchronous
   *  bun:sqlite path — modeling "off-loop, same handle, same SQL". It records
   *  every statement so the test can PROVE the pooled branch was taken. */
  const makeDelegatingPool = (db: ReturnType<typeof openDb>, seen: string[]): SqlWorkerPool =>
    ({
      query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
        seen.push(sql);
        return Promise.resolve(db.query(sql).all(...(params as any[])) as T[]);
      },
    } as unknown as SqlWorkerPool);

  // Seed a heterogeneous substrate exercising every posterior branch:
  // a plain knowledge_candidate (residual branch), an act_artifact-lifecycle
  // event (payload→artifact_id branch), each with distinct residual/score so
  // the posterior — and thus rerank_score and ordering — is non-trivial.
  const seedMixed = (db: ReturnType<typeof openDb>, dims: number): void => {
    const a = seedEmbedded(db, "knowledge_candidate", "alpha", 0, dims);
    const b = seedEmbedded(db, "knowledge_candidate", "beta", 0, dims);
    const c = seedEmbedded(db, "knowledge_candidate", "gamma", 0, dims);
    // Distinct residuals → distinct posteriors → ordering depends on the read.
    db.run("UPDATE events SET residual = ? WHERE id = ?", [0.1, a]);
    db.run("UPDATE events SET residual = ? WHERE id = ?", [0.9, b]);
    db.run("UPDATE events SET residual = ? WHERE id = ?", [0.5, c]);
  };

  test("pooled posterior path equals sync path — same rows, order, scores", async () => {
    const db = openDb(":memory:");
    runViews(db);
    const dims = EMBEDDING_DIMS;
    seedMixed(db, dims);
    const idx = EmbeddingIndex.rebuildFromDb(db);
    const queryVec = makeUnitVec(dims, 0);
    process.env.OPENAI_API_KEY = "sk-test-mock";
    installMockFetch(async () => {
      const data = { data: [{ embedding: queryVec, index: 0 }] };
      return new Response(JSON.stringify(data), { status: 200 });
    });

    // SYNC reference: identical `retrieve` call (identical RoutingQuery) with
    // NO pool installed → poolQuery takes the synchronous fallback. Comparing
    // two `retrieve` invocations that differ ONLY in pool-presence isolates
    // the execution-thread change (the variable under test) from query shape.
    clearSqlPool();
    const sync = await retrieve(db, idx, { text: "alpha beta gamma", k: 5 });

    // OFF-LOOP: install the delegating pool; `retrieve` must use poolQuery.
    const seen: string[] = [];
    setSqlPool(makeDelegatingPool(db, seen));
    const offloop = await retrieve(db, idx, { text: "alpha beta gamma", k: 5 });

    // Prove the pooled branch actually executed posterior SELECTs off-loop.
    expect(seen.some((s) => s.includes("residual") || s.includes("act_artifact"))).toBe(true);

    // Byte-identical hits: same ids, same order, same scores. Compare the
    // hit arrays directly (retrieved_at differs by wall-clock, so exclude it).
    expect(offloop.hits).toEqual(sync.hits);
    expect(offloop.mixed_version_excluded).toEqual(sync.mixed_version_excluded);
  });

  test("sync fallback (no pool installed) is identical to the pooled result", async () => {
    process.env.OPENAI_API_KEY = "sk-test-mock";
    const db = openDb(":memory:");
    runViews(db);
    const dims = EMBEDDING_DIMS;
    seedMixed(db, dims);
    const idx = EmbeddingIndex.rebuildFromDb(db);
    const queryVec = makeUnitVec(dims, 0);
    installMockFetch(async () => {
      const data = { data: [{ embedding: queryVec, index: 0 }] };
      return new Response(JSON.stringify(data), { status: 200 });
    });

    // No pool → poolQuery takes the sync fallback inside `retrieve`.
    clearSqlPool();
    const noPool = await retrieve(db, idx, { text: "alpha beta gamma", k: 5 });

    // With a delegating pool → off-loop. Must match.
    const seen: string[] = [];
    setSqlPool(makeDelegatingPool(db, seen));
    const withPool = await retrieve(db, idx, { text: "alpha beta gamma", k: 5 });

    expect(seen.length).toBeGreaterThan(0); // pool was actually used
    expect(withPool.hits).toEqual(noPool.hits);
  });

  test("pooled origin-bias (by goal_shape) path equals sync — same rows, order, scores", async () => {
    // Regression guard for the dispatch-cascade off-load: the origin-bias
    // reads (origin_promotion_view + the three directive/candidate/promotion
    // event reads) ran SYNCHRONOUSLY on the daemon loop inside `retrieve`,
    // twice per dispatch. They now route through `poolQuery`. This test pins
    // that the pooled goal_shape-biased path is byte-identical to the sync
    // path AND that the origin-bias SELECTs actually executed through the pool
    // (so the off-load cannot silently revert to the synchronous main-loop
    // read). The directive/candidate/promotion event reads are index-served
    // (idx_events_kind_ts), not full table scans, so pooling them is a bounded
    // read — not the writer-contention pattern that full-table pooling causes.
    process.env.OPENAI_API_KEY = "sk-test-mock";
    const db = openDb(":memory:");
    runViews(db);
    const dims = EMBEDDING_DIMS;

    // Seed a directive + per-(origin, directive) candidate/promotion signal so
    // the by-goal-shape bias map is non-trivial (opencode promotes well here).
    emitEvent(db, {
      kind: "directive_opened",
      directive_id: "dir_bias",
      task_id: "t_bias",
      payload: { goal: "improve retrieval calibration on this shape" },
    });
    for (let i = 0; i < 3; i++) {
      emitEvent(db, {
        kind: "knowledge_candidate",
        substrate_origin: "opencode",
        directive_id: "dir_bias",
        task_id: "t_bias",
        payload: { text: `cand-${i}` },
      });
      emitEvent(db, {
        kind: "knowledge_promoted",
        substrate_origin: "opencode",
        directive_id: "dir_bias",
        task_id: "t_bias",
        payload: { text: `prom-${i}` },
      });
    }
    const evId = seedEmbedded(db, "knowledge_candidate", "biased hit", 0, dims);
    db.run("UPDATE events SET substrate_origin = ? WHERE id = ?", ["opencode", evId]);

    const idx = EmbeddingIndex.rebuildFromDb(db);
    const queryVec = makeUnitVec(dims, 0);
    installMockFetch(async () => {
      const data = { data: [{ embedding: queryVec, index: 0 }] };
      return new Response(JSON.stringify(data), { status: 200 });
    });
    const goalText = "improve retrieval calibration on this shape";

    // SYNC reference: no pool → poolQuery takes the synchronous fallback.
    clearSqlPool();
    const sync = await retrieve(db, idx, { text: "biased hit", k: 3, goalText });

    // OFF-LOOP: delegating pool → the origin-bias SELECTs run through poolQuery.
    const seen: string[] = [];
    setSqlPool(makeDelegatingPool(db, seen));
    const offloop = await retrieve(db, idx, { text: "biased hit", k: 3, goalText });

    // Prove the origin-bias reads executed through the pool (not the loop).
    expect(seen.some((s) => s.includes("origin_promotion_view"))).toBe(true);
    expect(seen.some((s) => s.includes("kind = 'directive_opened'"))).toBe(true);
    expect(seen.some((s) => s.includes("kind = 'knowledge_candidate'"))).toBe(true);
    expect(seen.some((s) => s.includes("kind = 'knowledge_promoted'"))).toBe(true);

    // Byte-identical hits: same ids, order, and rerank scores (origin bias
    // multiplier included). retrieved_at differs by wall-clock so exclude it.
    expect(offloop.hits).toEqual(sync.hits);
    expect(offloop.hits.length).toBeGreaterThan(0);
  });
});
