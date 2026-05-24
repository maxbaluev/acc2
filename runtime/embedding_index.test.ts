// acc2 embedding-index tests — bulk rebuild from substrate, live add(),
// KNN ordering correctness, optional kind filter.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { runViews } from "../substrate/views";
import { emitEvent } from "./events";
import { encodeEmbeddingBlob, EMBEDDING_VERSION } from "./embedder";
import { EmbeddingIndex, type IndexEntry } from "./embedding_index";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const makeUnitVec = (dims: number, axis: number): Float32Array => {
  // Unit vector along one axis — sparse, easy to reason about cosine.
  const v = new Float32Array(dims);
  v[axis] = 1;
  return v;
};

const seedEmbeddedEvent = (
  db: ReturnType<typeof openDb>,
  kind: string,
  text: string,
  axis: number,
  dims = 8,
): string => {
  const seeded = emitEvent(db, {
    kind: kind as any,
    substrate_origin: "claude_root",
    payload: { text },
  });
  const vec = makeUnitVec(dims, axis);
  const blob = encodeEmbeddingBlob(Array.from(vec));
  db.run(
    "UPDATE events SET embedding = ?, embedding_version = ? WHERE id = ?",
    [blob, EMBEDDING_VERSION, seeded.id],
  );
  return seeded.id;
};

describe("EmbeddingIndex.rebuildFromDb", () => {
  test("returns empty index on a fresh substrate", () => {
    const db = openDb(":memory:");
    runViews(db);
    const idx = EmbeddingIndex.rebuildFromDb(db);
    expect(idx.size()).toBe(0);
  });

  test("loads every embedded event with its version + snippet", () => {
    const db = openDb(":memory:");
    runViews(db);
    const aId = seedEmbeddedEvent(db, "knowledge_candidate", "alpha topic", 0);
    const bId = seedEmbeddedEvent(db, "knowledge_promoted", "bravo topic", 1);

    const idx = EmbeddingIndex.rebuildFromDb(db);
    expect(idx.size()).toBe(2);
    const entries = idx.list();
    const byId: Record<string, IndexEntry> = {};
    for (const e of entries) byId[e.event_id] = e;
    expect(byId[aId].snippet).toBe("alpha topic");
    expect(byId[bId].snippet).toBe("bravo topic");
    expect(byId[aId].embedding_version).toBe(EMBEDDING_VERSION);
  });
});

describe("EmbeddingIndex.add + knn", () => {
  test("knn returns nearest first by cosine distance", () => {
    const db = openDb(":memory:");
    runViews(db);
    const dims = 8;
    seedEmbeddedEvent(db, "knowledge_candidate", "axis-0 entry", 0, dims);
    seedEmbeddedEvent(db, "knowledge_candidate", "axis-1 entry", 1, dims);
    seedEmbeddedEvent(db, "knowledge_candidate", "axis-2 entry", 2, dims);

    const idx = EmbeddingIndex.rebuildFromDb(db);
    expect(idx.size()).toBe(3);

    const query = makeUnitVec(dims, 0);
    const hits = idx.knn(query, 3);
    expect(hits.length).toBe(3);
    expect(hits[0].entry.snippet).toBe("axis-0 entry");
    // axis-0 query against axis-0 entry: cosine distance ≈ 0
    expect(hits[0].distance).toBeLessThan(0.0001);
    // The other two are orthogonal — distance ≈ 1
    expect(hits[1].distance).toBeGreaterThan(0.9);
  });

  test("knn honours an optional filter (kind whitelist)", () => {
    const db = openDb(":memory:");
    runViews(db);
    const dims = 8;
    seedEmbeddedEvent(db, "knowledge_candidate", "candidate axis-0", 0, dims);
    seedEmbeddedEvent(db, "act_artifact_admitted", "artifact axis-1", 1, dims);

    const idx = EmbeddingIndex.rebuildFromDb(db);
    const query = makeUnitVec(dims, 0);
    const hits = idx.knn(query, 5, (e) => e.kind === "act_artifact_admitted");
    expect(hits.length).toBe(1);
    expect(hits[0].entry.snippet).toBe("artifact axis-1");
  });

  test("add() appends new entries that subsequent knn calls see", () => {
    const db = openDb(":memory:");
    runViews(db);
    const idx = EmbeddingIndex.rebuildFromDb(db);
    expect(idx.size()).toBe(0);

    const dims = 8;
    idx.add({
      event_id: "evt_synth",
      embedding: makeUnitVec(dims, 0),
      kind: "knowledge_candidate",
      ts: new Date().toISOString(),
      directive_id: "d1",
      task_id: "t1",
      substrate_origin: "claude_root",
      embedding_version: EMBEDDING_VERSION,
      snippet: "synthetic",
    });
    expect(idx.size()).toBe(1);
    const hits = idx.knn(makeUnitVec(dims, 0), 1);
    expect(hits[0].entry.event_id).toBe("evt_synth");
  });

  test("knn returns [] for empty index", () => {
    const db = openDb(":memory:");
    runViews(db);
    const idx = EmbeddingIndex.rebuildFromDb(db);
    expect(idx.knn(makeUnitVec(8, 0), 3)).toEqual([]);
  });
});

describe("EmbeddingIndex on-demand metadata (vec_events SQL path)", () => {
  // 1536-dim seeds land in vec_events (the canonical on-disk store). The
  // refactor removed the pre-loaded in-memory metadata map: knn now reads
  // vec_events MATCH and fetches enrichment metadata ON-DEMAND for only the
  // K result ids. These tests prove (a) hits come back correctly ordered
  // WITH enrichment (snippet/kind/version sourced on-demand), and (b) an
  // empty in-memory map no longer means empty results when vec_events has
  // rows — size() reflects the on-disk count.
  const DIMS = 1536;
  const seed1536 = (
    db: ReturnType<typeof openDb>,
    kind: string,
    text: string,
    axis: number,
  ): string => {
    const seeded = emitEvent(db, {
      kind: kind as any,
      substrate_origin: "claude_root",
      payload: { text },
    });
    const vec = makeUnitVec(DIMS, axis);
    db.run(
      "UPDATE events SET embedding = ?, embedding_version = ? WHERE id = ?",
      [encodeEmbeddingBlob(Array.from(vec)), EMBEDDING_VERSION, seeded.id],
    );
    return seeded.id;
  };

  test("size() reflects vec_events count even with an empty in-memory map", () => {
    const db = openDb(":memory:");
    runViews(db);
    seed1536(db, "knowledge_candidate", "vec axis-0", 0);
    seed1536(db, "knowledge_candidate", "vec axis-1", 1);
    seed1536(db, "knowledge_candidate", "vec axis-2", 2);

    const idx = EmbeddingIndex.rebuildFromDb(db);
    // No dim-mismatch entries → the in-memory inline map is empty, yet
    // size() must report the 3 on-disk vec_events rows (the gate callers
    // use to activate retrieval).
    expect(idx.list().length).toBe(0); // in-memory inline store is empty
    expect(idx.size()).toBe(3);        // but the on-disk index has 3 rows
  });

  test("knn returns ordered hits from vec_events with on-demand enrichment", () => {
    const db = openDb(":memory:");
    runViews(db);
    const a0 = seed1536(db, "knowledge_candidate", "vec axis-0 entry", 0);
    seed1536(db, "knowledge_candidate", "vec axis-1 entry", 1);
    seed1536(db, "knowledge_candidate", "vec axis-2 entry", 2);

    const idx = EmbeddingIndex.rebuildFromDb(db);
    const hits = idx.knn(makeUnitVec(DIMS, 0), 3);
    expect(hits.length).toBe(3);
    // Nearest = axis-0 entry; metadata (snippet/kind/version) was fetched
    // on-demand for the K results, not pre-loaded.
    expect(hits[0].entry.event_id).toBe(a0);
    expect(hits[0].entry.snippet).toBe("vec axis-0 entry");
    expect(hits[0].entry.kind).toBe("knowledge_candidate");
    expect(hits[0].entry.embedding_version).toBe(EMBEDDING_VERSION);
    expect(hits[0].distance).toBeLessThan(0.0001);
    // Orthogonal axes are clearly farther than the exact match.
    expect(hits[1].distance).toBeGreaterThan(0.5);
  });

  test("knn filter still works against on-demand-enriched metadata", () => {
    const db = openDb(":memory:");
    runViews(db);
    seed1536(db, "knowledge_candidate", "candidate axis-0", 0);
    seed1536(db, "act_artifact_admitted", "artifact axis-1", 1);

    const idx = EmbeddingIndex.rebuildFromDb(db);
    const hits = idx.knn(makeUnitVec(DIMS, 1), 5, (e) => e.kind === "act_artifact_admitted");
    expect(hits.length).toBe(1);
    expect(hits[0].entry.snippet).toBe("artifact axis-1");
  });
});

describe("EmbeddingIndex.knnAsync (off-loop vec0 KNN — byte-identical to knn)", () => {
  // knnAsync routes the vec0 MATCH + on-demand metadata SELECTs through an
  // injected async `read`. In the daemon that `read` is the SQL worker pool
  // (sqlite-vec loaded on the pool's worker connections). These tests use a
  // `read` adapter backed by the SAME synchronous bun:sqlite handle the
  // sync path uses, plus a microtask-deferred variant that mimics the pool's
  // off-loop dispatch — and assert the returned hits are byte-identical to
  // `idx.knn(...)` for the same (query, k, filter).
  const DIMS = 1536;
  const seed1536 = (
    db: ReturnType<typeof openDb>,
    kind: string,
    text: string,
    axis: number,
  ): string => {
    const seeded = emitEvent(db, {
      kind: kind as any,
      substrate_origin: "claude_root",
      payload: { text },
    });
    const vec = makeUnitVec(DIMS, axis);
    db.run(
      "UPDATE events SET embedding = ?, embedding_version = ? WHERE id = ?",
      [encodeEmbeddingBlob(Array.from(vec)), EMBEDDING_VERSION, seeded.id],
    );
    return seeded.id;
  };

  // Mimic the pool: run the SAME SQL against the SAME db handle, but resolve
  // on a microtask so the call genuinely returns a Promise off the call stack
  // (proving knnAsync awaits rather than reading inline).
  const makeRead = (db: ReturnType<typeof openDb>) =>
    async <T = unknown>(sql: string, params: unknown[]): Promise<T[]> => {
      await Promise.resolve();
      return (params.length > 0 ? db.query(sql).all(...params) : db.query(sql).all()) as T[];
    };

  test("knnAsync returns hits byte-identical to knn (SQL/vec_events path)", async () => {
    const db = openDb(":memory:");
    runViews(db);
    const a0 = seed1536(db, "knowledge_candidate", "vec axis-0 entry", 0);
    seed1536(db, "knowledge_candidate", "vec axis-1 entry", 1);
    seed1536(db, "knowledge_candidate", "vec axis-2 entry", 2);

    const idx = EmbeddingIndex.rebuildFromDb(db);
    const query = makeUnitVec(DIMS, 0);

    const sync = idx.knn(query, 3);
    const async_ = await idx.knnAsync(query, 3, makeRead(db));

    expect(async_).toEqual(sync);
    expect(async_[0].entry.event_id).toBe(a0);
    expect(async_[0].entry.snippet).toBe("vec axis-0 entry");
    expect(async_[0].distance).toBeLessThan(0.0001);
  });

  test("knnAsync honours the filter callback identically to knn", async () => {
    const db = openDb(":memory:");
    runViews(db);
    seed1536(db, "knowledge_candidate", "candidate axis-0", 0);
    seed1536(db, "act_artifact_admitted", "artifact axis-1", 1);

    const idx = EmbeddingIndex.rebuildFromDb(db);
    const query = makeUnitVec(DIMS, 1);
    const filter = (e: { kind: string }) => e.kind === "act_artifact_admitted";

    const sync = idx.knn(query, 5, filter);
    const async_ = await idx.knnAsync(query, 5, makeRead(db), filter);

    expect(async_).toEqual(sync);
    expect(async_.length).toBe(1);
    expect(async_[0].entry.snippet).toBe("artifact axis-1");
  });

  test("knnAsync falls back to the JS path for non-1536 dims (no read used)", async () => {
    const db = openDb(":memory:");
    runViews(db);
    seedEmbeddedEvent(db, "knowledge_candidate", "axis-0 entry", 0, 8);
    seedEmbeddedEvent(db, "knowledge_candidate", "axis-1 entry", 1, 8);

    const idx = EmbeddingIndex.rebuildFromDb(db);
    const query = makeUnitVec(8, 0);

    let reads = 0;
    const countingRead = async <T = unknown>(): Promise<T[]> => {
      reads++;
      return [] as T[];
    };

    const sync = idx.knn(query, 2);
    const async_ = await idx.knnAsync(query, 2, countingRead);

    expect(async_).toEqual(sync);
    expect(reads).toBe(0); // JS-fallback path issues no DB reads
    expect(async_[0].entry.snippet).toBe("axis-0 entry");
  });

  test("knnAsync returns [] for empty index / k<=0 / empty query", async () => {
    const db = openDb(":memory:");
    runViews(db);
    const idx = EmbeddingIndex.rebuildFromDb(db);
    expect(await idx.knnAsync(makeUnitVec(DIMS, 0), 3, makeRead(db))).toEqual([]);
    seed1536(db, "knowledge_candidate", "x", 0);
    const idx2 = EmbeddingIndex.rebuildFromDb(db);
    expect(await idx2.knnAsync(makeUnitVec(DIMS, 0), 0, makeRead(db))).toEqual([]);
    expect(await idx2.knnAsync(new Float32Array(0), 3, makeRead(db))).toEqual([]);
  });
});
