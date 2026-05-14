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
): string => {
  const seeded = emitEvent(db, {
    kind: kind as any,
    substrate_origin: "claude_root",
    payload: { text },
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
    const artId = seedEmbedded(db, "code_artifact_admitted", "art near", 0, dims);
    const idx = EmbeddingIndex.rebuildFromDb(db);
    const result = await retrieve(db, idx, {
      text: "anything",
      k: 5,
      kindFilter: ["code_artifact_admitted", "code_artifact_promoted"],
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
