// acc2 embedder tests — computeEmbedding (mocked fetch), batch variant,
// extractor, encode/decode round-trip, and the worker tick that persists
// embeddings back to source rows + emits embedding_computed events.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import {
  batchComputeEmbeddings,
  cleanupOrphanedVecEvents,
  computeEmbedding,
  decodeEmbeddingBlob,
  embedderWorkerTick,
  embedPendingEvents,
  EMBEDDING_DIMS,
  EMBEDDING_MODEL,
  EMBEDDING_VERSION,
  encodeEmbeddingBlob,
  extractTextFromEvent,
  readEmbeddingFromEvent,
  upsertVecEventRow,
  MAX_DAEMON_EMBEDDER_BATCH_SIZE,
  MAX_EMBED_PENDING_BATCH_SIZE,
} from "./embedder";

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

const restoreFetch = (): void => {
  globalThis.fetch = originalFetch;
};

afterEach(() => {
  restoreFetch();
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalKey;
});

const synthEmbedding = (seed: number): number[] => {
  const out = new Array<number>(EMBEDDING_DIMS);
  // Deterministic gentle ramp keyed by seed — enough variation for tests.
  for (let i = 0; i < EMBEDDING_DIMS; i++) out[i] = Math.sin(seed * 0.1 + i * 0.001);
  return out;
};

describe("encodeEmbeddingBlob / decodeEmbeddingBlob", () => {
  test("round-trips a small embedding", () => {
    const original = [1.0, -0.5, 0.25, 0.125];
    const blob = encodeEmbeddingBlob(original);
    expect(blob.byteLength).toBe(original.length * 4);
    const decoded = decodeEmbeddingBlob(blob);
    expect(decoded).not.toBeNull();
    expect(decoded!.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(decoded![i]).toBeCloseTo(original[i], 5);
    }
  });

  test("decodeEmbeddingBlob rejects mis-aligned blobs", () => {
    const bad = new Uint8Array([1, 2, 3]); // 3 bytes — not a multiple of 4
    expect(decodeEmbeddingBlob(bad)).toBeNull();
  });
});

describe("computeEmbedding (mocked fetch)", () => {
  test("returns null when OPENAI_API_KEY is not set", async () => {
    delete process.env.OPENAI_API_KEY;
    const result = await computeEmbedding("hello world");
    expect(result).toBeNull();
  });

  test("returns embedding + version on a successful response", async () => {
    process.env.OPENAI_API_KEY = "sk-test-mock";
    installMockFetch(async () => {
      const body = JSON.stringify({ data: [{ embedding: synthEmbedding(1), index: 0 }] });
      return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const result = await computeEmbedding("hello world");
    expect(result).not.toBeNull();
    expect(result!.version).toBe(EMBEDDING_VERSION);
    expect(result!.embedding.length).toBe(EMBEDDING_DIMS);
  });

  test("retries a 429 then returns embedding on a successful response", async () => {
    process.env.OPENAI_API_KEY = "sk-test-mock";
    let calls = 0;
    installMockFetch(async () => {
      calls++;
      if (calls === 1) return new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } });
      const body = JSON.stringify({ data: [{ embedding: synthEmbedding(2), index: 0 }] });
      return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const result = await computeEmbedding("hello world");
    expect(result).not.toBeNull();
    expect(result!.embedding.length).toBe(EMBEDDING_DIMS);
    expect(calls).toBe(2);
  });

  test("returns null immediately on a non-retryable 400 response", async () => {
    process.env.OPENAI_API_KEY = "sk-test-mock";
    let calls = 0;
    installMockFetch(async () => {
      calls++;
      return new Response("bad request", { status: 400 });
    });
    const result = await computeEmbedding("hello world");
    expect(result).toBeNull();
    expect(calls).toBe(1);
  });

  test("bounds retries for a transient 500 response", async () => {
    process.env.OPENAI_API_KEY = "sk-test-mock";
    let calls = 0;
    installMockFetch(async () => {
      calls++;
      return new Response("oops", { status: 500, headers: { "Retry-After": "0" } });
    });
    const result = await computeEmbedding("hello world");
    expect(result).toBeNull();
    expect(calls).toBe(4);
  });

  test("returns null on a network throw after bounded retries", async () => {
    process.env.OPENAI_API_KEY = "sk-test-mock";
    let calls = 0;
    installMockFetch(async () => {
      calls++;
      throw new Error("ECONNRESET");
    });
    const result = await computeEmbedding("hello world");
    expect(result).toBeNull();
    expect(calls).toBe(4);
  });
});

describe("batchComputeEmbeddings", () => {
  test("returns empty map when items is empty", async () => {
    const result = await batchComputeEmbeddings([]);
    expect(result.size).toBe(0);
  });

  test("returns empty map when API key is absent (no fetch fires)", async () => {
    delete process.env.OPENAI_API_KEY;
    let calls = 0;
    installMockFetch(async () => {
      calls++;
      return new Response("{}", { status: 200 });
    });
    const result = await batchComputeEmbeddings([{ id: "a", text: "x" }]);
    expect(result.size).toBe(0);
    expect(calls).toBe(0);
  });

  test("maps embeddings back to caller ids by index", async () => {
    process.env.OPENAI_API_KEY = "sk-test-mock";
    installMockFetch(async (_url, init) => {
      const reqBody = JSON.parse((init.body as string) ?? "{}") as { input: string[]; model: string };
      expect(reqBody.model).toBe(EMBEDDING_MODEL);
      const data = reqBody.input.map((_t, i) => ({ embedding: synthEmbedding(i + 5), index: i }));
      return new Response(JSON.stringify({ data }), { status: 200 });
    });
    const result = await batchComputeEmbeddings([
      { id: "alpha", text: "a" },
      { id: "bravo", text: "b" },
      { id: "charlie", text: "c" },
    ]);
    expect(result.size).toBe(3);
    expect(result.get("alpha")!.length).toBe(EMBEDDING_DIMS);
    expect(result.get("bravo")!.length).toBe(EMBEDDING_DIMS);
    expect(result.get("charlie")!.length).toBe(EMBEDDING_DIMS);
  });

  test("retries a transient chunk failure before mapping embeddings", async () => {
    process.env.OPENAI_API_KEY = "sk-test-mock";
    let calls = 0;
    installMockFetch(async (_url, init) => {
      calls++;
      if (calls === 1) return new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } });
      const reqBody = JSON.parse((init.body as string) ?? "{}") as { input: string[] };
      const data = reqBody.input.map((_t, i) => ({ embedding: synthEmbedding(i + 8), index: i }));
      return new Response(JSON.stringify({ data }), { status: 200 });
    });
    const result = await batchComputeEmbeddings([{ id: "alpha", text: "a" }]);
    expect(result.size).toBe(1);
    expect(result.get("alpha")!.length).toBe(EMBEDDING_DIMS);
    expect(calls).toBe(2);
  });
});

describe("extractTextFromEvent", () => {
  test("returns text from knowledge_candidate payload", () => {
    const text = extractTextFromEvent("knowledge_candidate", { text: "claim X", score: 0.9 });
    expect(text).toBe("claim X");
  });

  test("returns goal from task_node_opened payload", () => {
    const text = extractTextFromEvent("task_node_opened", { goal: "count files" });
    expect(text).toBe("count files");
  });

  test("returns null for non-embeddable kind", () => {
    const text = extractTextFromEvent("daemon_started", { whatever: true });
    expect(text).toBeNull();
  });

  test("returns null when no text-like fields are present", () => {
    const text = extractTextFromEvent("knowledge_candidate", { tags: [1, 2] });
    expect(text).toBeNull();
  });
});

describe("embedderWorkerTick", () => {
  test("no-op when there are zero unembedded events", async () => {
    const db = openDb(":memory:");
    const result = await embedderWorkerTick(db, { batchSize: 10 });
    expect(result.embedded).toBe(0);
    expect(result.skipped_no_text).toBe(0);
    expect(result.failed).toBe(0);
  });

  test("embeds a knowledge_candidate, updates the row, emits embedding_computed", async () => {
    process.env.OPENAI_API_KEY = "sk-test-mock";
    installMockFetch(async (_url, init) => {
      const reqBody = JSON.parse((init.body as string) ?? "{}") as { input: string[] };
      const data = reqBody.input.map((_t, i) => ({ embedding: synthEmbedding(i + 1), index: i }));
      return new Response(JSON.stringify({ data }), { status: 200 });
    });

    const db = openDb(":memory:");
    const seeded = emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "claude_root",
      payload: { text: "prefer ripgrep over recursive find", tags: ["pattern"] },
    });

    const result = await embedderWorkerTick(db, { batchSize: 5 });
    expect(result.embedded).toBe(1);
    expect(result.failed).toBe(0);

    // Source row mutated: embedding BLOB + embedding_version set.
    const row = db
      .query("SELECT embedding, embedding_version FROM events WHERE id = ?")
      .get(seeded.id) as { embedding: Uint8Array | null; embedding_version: string | null };
    expect(row.embedding).not.toBeNull();
    expect(row.embedding_version).toBe(EMBEDDING_VERSION);

    // A subsequent embedding_computed event landed and references the source.
    // New shape (2026-05-19): batch-summary emit — payload.source_event_ids is
    // an array, payload.count is its length. context_refs carries up to 20
    // source ids. Previous per-row payload.source_event_id is gone (replaced
    // by the array). This collapses the per-row activation-bus storm that
    // was the embedder wedge on a 1543-event backlog (50 events/batch ×
    // ~16 publish cascades = 800 publishes that took ~12s).
    const ev = db
      .query("SELECT id, payload, context_refs FROM events WHERE kind = 'embedding_computed' LIMIT 1")
      .get() as { id: string; payload: string; context_refs: string };
    expect(ev).toBeTruthy();
    const payload = JSON.parse(ev.payload) as { source_event_ids: string[]; count: number; version: string };
    expect(Array.isArray(payload.source_event_ids)).toBe(true);
    expect(payload.source_event_ids).toContain(seeded.id);
    expect(payload.count).toBeGreaterThanOrEqual(1);
    expect(payload.version).toBe(EMBEDDING_VERSION);
    const refs = JSON.parse(ev.context_refs) as string[];
    expect(refs).toContain(seeded.id);

    // readEmbeddingFromEvent rebuilds the vector with the right dims.
    const back = readEmbeddingFromEvent(db, seeded.id);
    expect(back).not.toBeNull();
    expect(back!.version).toBe(EMBEDDING_VERSION);
    expect(back!.vector.length).toBe(EMBEDDING_DIMS);

    // Canonical v2 path: the embedder ALSO upserts into the sqlite-vec
    // virtual table. Verify the row landed with the same event_id and
    // version stamp so the SQL retrieval path can find it.
    const vecRow = db
      .query("SELECT event_id, kind, embedding_version FROM vec_events WHERE event_id = ?")
      .get(seeded.id) as { event_id: string; kind: string; embedding_version: string } | null;
    expect(vecRow).not.toBeNull();
    expect(vecRow!.event_id).toBe(seeded.id);
    expect(vecRow!.kind).toBe("knowledge_candidate");
    expect(vecRow!.embedding_version).toBe(EMBEDDING_VERSION);
  });

  test("batched persist writes N embeddings exactly-once (events row + vec_events) in one txn", async () => {
    // Reduce embedder + heavy-worker main-loop blocking: persistEmbeddingsBatch
    // prepares the four SQL statements once and reuses them across the batch.
    // This asserts the batched path is exactly-once — every accepted row gets
    // its events.embedding UPDATE AND exactly one vec_events projection, and a
    // re-tick does NOT duplicate either (no double-write).
    process.env.OPENAI_API_KEY = "sk-test-mock";
    installMockFetch(async (_url, init) => {
      const reqBody = JSON.parse((init.body as string) ?? "{}") as { input: string[] };
      const data = reqBody.input.map((_t, i) => ({ embedding: synthEmbedding(i + 101), index: i }));
      return new Response(JSON.stringify({ data }), { status: 200 });
    });
    const db = openDb(":memory:");
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const ev = emitEvent(db, {
        kind: "knowledge_candidate",
        substrate_origin: "claude_root",
        payload: { text: `exactly-once row ${i}` },
      });
      ids.push(ev.id);
    }
    const result = await embedderWorkerTick(db, { batchSize: 8 });
    expect(result.embedded).toBe(6);
    expect(result.failed).toBe(0);
    // Every source row has its embedding BLOB written exactly once.
    for (const id of ids) {
      const row = db
        .query("SELECT embedding, embedding_version FROM events WHERE id = ?")
        .get(id) as { embedding: Uint8Array | null; embedding_version: string | null };
      expect(row.embedding).not.toBeNull();
      expect(row.embedding_version).toBe(EMBEDDING_VERSION);
      // Exactly ONE vec_events row per id — no duplicate projection.
      const vecCount = db
        .query<{ c: number }, [string]>("SELECT COUNT(*) AS c FROM vec_events WHERE event_id = ?")
        .get(id)!.c;
      expect(vecCount).toBe(1);
    }
    // A second tick re-embeds nothing and does NOT duplicate vec_events rows.
    const second = await embedderWorkerTick(db, { batchSize: 8 });
    expect(second.embedded).toBe(0);
    const totalVec = db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM vec_events")
      .get()!.c;
    expect(totalVec).toBe(6);
  });

  test("idempotent — a second tick does not re-embed an already-embedded row", async () => {
    process.env.OPENAI_API_KEY = "sk-test-mock";
    let calls = 0;
    installMockFetch(async (_url, init) => {
      calls++;
      const reqBody = JSON.parse((init.body as string) ?? "{}") as { input: string[] };
      const data = reqBody.input.map((_t, i) => ({ embedding: synthEmbedding(i + 11), index: i }));
      return new Response(JSON.stringify({ data }), { status: 200 });
    });
    const db = openDb(":memory:");
    emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "claude_root",
      payload: { text: "one" },
    });
    await embedderWorkerTick(db, { batchSize: 5 });
    const second = await embedderWorkerTick(db, { batchSize: 5 });
    expect(second.embedded).toBe(0);
    // Only one HTTP call — the second tick skipped the now-embedded row.
    expect(calls).toBe(1);
  });

  test("selects oldest unembedded backlog rows before recent rows", async () => {
    process.env.OPENAI_API_KEY = "sk-test-mock";
    const embeddedTexts: string[] = [];
    installMockFetch(async (_url, init) => {
      const reqBody = JSON.parse((init.body as string) ?? "{}") as { input: string[] };
      embeddedTexts.push(...reqBody.input);
      const data = reqBody.input.map((_t, i) => ({ embedding: synthEmbedding(i + 21), index: i }));
      return new Response(JSON.stringify({ data }), { status: 200 });
    });

    const db = openDb(":memory:");
    const recent = emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "claude_root",
      payload: { text: "recent pending row" },
    });
    const backlog = emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "claude_root",
      payload: { text: "old backlog row" },
    });
    db.run("UPDATE events SET ts = ? WHERE id = ?", ["2026-01-01T00:00:00.000Z", backlog.id]);
    db.run("UPDATE events SET ts = ? WHERE id = ?", ["2026-02-01T00:00:00.000Z", recent.id]);

    const result = await embedderWorkerTick(db, { batchSize: 1 });
    expect(result.embedded).toBe(1);
    expect(embeddedTexts).toEqual(["old backlog row"]);
    const backlogRow = db
      .query("SELECT embedding FROM events WHERE id = ?")
      .get(backlog.id) as { embedding: Uint8Array | null };
    const recentRow = db
      .query("SELECT embedding FROM events WHERE id = ?")
      .get(recent.id) as { embedding: Uint8Array | null };
    expect(backlogRow.embedding).not.toBeNull();
    expect(recentRow.embedding).toBeNull();
  });

  test("embed + vec_events projection are atomic; hot path does NOT reproject embedded-but-missing rows", async () => {
    // Instant-responsive clean-break: the per-tick NOT-EXISTS-vec0 reproject
    // scan was removed (it blocked boot + ground the loop). persistEmbedding is
    // now atomic-or-nothing — a successful embed ALWAYS lands in vec_events the
    // same tick — so drift is impossible by construction and the hot path only
    // embeds `embedding IS NULL` rows. This test pins both halves: (a) a
    // NULL-embedding row gets embedded AND projected to vec_events in one tick;
    // (b) a pre-existing embedded-but-unprojected row is NOT picked up (no
    // reproject) — that case can no longer occur in production.
    process.env.OPENAI_API_KEY = "sk-test-mock";
    installMockFetch(async (_url, init) => {
      const reqBody = JSON.parse((init.body as string) ?? "{}") as { input: string[] };
      const data = reqBody.input.map((_t, i) => ({ embedding: synthEmbedding(i + 31), index: i }));
      return new Response(JSON.stringify({ data }), { status: 200 });
    });

    const db = openDb(":memory:");
    // (b) pre-existing embedded-but-unprojected row — must be IGNORED by the hot path.
    const stale = emitEvent(db, { kind: "knowledge_candidate", substrate_origin: "claude_root", payload: { text: "embedded but unprojected" } });
    db.run("UPDATE events SET embedding = ?, embedding_version = ? WHERE id = ?", [encodeEmbeddingBlob(synthEmbedding(41)), EMBEDDING_VERSION, stale.id]);
    // (a) a fresh NULL-embedding row — must be embedded + projected atomically.
    const fresh = emitEvent(db, { kind: "knowledge_candidate", substrate_origin: "claude_root", payload: { text: "needs embedding" } });

    const result = await embedderWorkerTick(db, { batchSize: 5 });
    expect(result.embedded).toBe(1); // only the NULL-embedding row, NOT the pre-embedded one
    // (a) atomic projection: fresh row embedded AND in vec_events same tick.
    expect(db.query("SELECT 1 FROM vec_events WHERE event_id = ?").get(fresh.id)).not.toBeNull();
    // (b) no reproject: the stale embedded-but-unprojected row stays unprojected (hot path ignores it).
    expect(db.query("SELECT 1 FROM vec_events WHERE event_id = ?").get(stale.id)).toBeNull();
  });

  test("daemon worker clamps oversized caller batches to the small per-tick budget", async () => {
    process.env.OPENAI_API_KEY = "sk-test-mock";
    const requestSizes: number[] = [];
    installMockFetch(async (_url, init) => {
      const reqBody = JSON.parse((init.body as string) ?? "{}") as { input: string[] };
      requestSizes.push(reqBody.input.length);
      const data = reqBody.input.map((_t, i) => ({ embedding: synthEmbedding(i + 51), index: i }));
      return new Response(JSON.stringify({ data }), { status: 200 });
    });

    const db = openDb(":memory:");
    for (let i = 0; i < MAX_DAEMON_EMBEDDER_BATCH_SIZE + 3; i++) {
      emitEvent(db, {
        kind: "knowledge_candidate",
        substrate_origin: "claude_root",
        payload: { text: "worker backlog " + i },
      });
    }

    const result = await embedderWorkerTick(db, { batchSize: 500 });
    expect(result.embedded).toBe(MAX_DAEMON_EMBEDDER_BATCH_SIZE);
    expect(requestSizes).toEqual([MAX_DAEMON_EMBEDDER_BATCH_SIZE]);
    const pending = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'knowledge_candidate' AND embedding IS NULL")
      .get() as { c: number };
    expect(pending.c).toBe(3);
  });

  test("skips events whose payload has no text-like field", async () => {
    process.env.OPENAI_API_KEY = "sk-test-mock";
    installMockFetch(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const db = openDb(":memory:");
    emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "claude_root",
      payload: { tags: ["only-tags"] },
    });
    const result = await embedderWorkerTick(db, { batchSize: 5 });
    expect(result.embedded).toBe(0);
    expect(result.skipped_no_text).toBe(1);
  });
});

describe("embedPendingEvents", () => {
  test("returns zeros on a fresh DB with no pending events", async () => {
    const db = openDb(":memory:");
    const result = await embedPendingEvents(db);
    expect(result).toEqual({ embedded: 0, skipped: 0, failed: 0 });
  });

  test("embeds pending events synchronously and populates vec_events", async () => {
    process.env.OPENAI_API_KEY = "sk-test-mock";
    installMockFetch(async (_url, init) => {
      const reqBody = JSON.parse((init.body as string) ?? "{}") as { input: string[] };
      const data = reqBody.input.map((_t, i) => ({ embedding: synthEmbedding(i + 3), index: i }));
      return new Response(JSON.stringify({ data }), { status: 200 });
    });
    const db = openDb(":memory:");
    const seeded = emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "claude_root",
      payload: { text: "embed me please" },
    });
    const result = await embedPendingEvents(db);
    expect(result.embedded).toBe(1);
    expect(result.failed).toBe(0);
    const vecRow = db
      .query("SELECT event_id FROM vec_events WHERE event_id = ?")
      .get(seeded.id) as { event_id: string } | null;
    expect(vecRow).not.toBeNull();
    const eventRow = db
      .query("SELECT embedding FROM events WHERE id = ?")
      .get(seeded.id) as { embedding: Uint8Array | null };
    expect(eventRow.embedding).not.toBeNull();
  });

  test("emits embedding_skipped_missing_api_key + hidl_action_required when OPENAI_API_KEY is unset", async () => {
    delete process.env.OPENAI_API_KEY;
    const db = openDb(":memory:");
    emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "claude_root",
      payload: { text: "needs embedding" },
    });
    emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "claude_root",
      payload: { text: "another one" },
    });
    const result = await embedPendingEvents(db);
    expect(result.embedded).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(2);
    const auditRows = db
      .query("SELECT payload FROM events WHERE kind = 'embedding_skipped_missing_api_key'")
      .all() as Array<{ payload: string }>;
    expect(auditRows.length).toBe(1);
    const payload = JSON.parse(auditRows[0]!.payload) as { pending_count: number; reason: string };
    expect(payload.pending_count).toBe(2);
    expect(payload.reason).toBe("openai_api_key_missing");
    // HIDL emit: owner sees the gap inline (mirror_inline=true on the kind).
    const hidlRows = db
      .query("SELECT payload FROM events WHERE kind = 'hidl_action_required'")
      .all() as Array<{ payload: string }>;
    expect(hidlRows.length).toBe(1);
    const hidlPayload = JSON.parse(hidlRows[0]!.payload) as { reason: string; env_var: string; suggested_action: string };
    expect(hidlPayload.reason).toBe("env_missing");
    expect(hidlPayload.env_var).toBe("OPENAI_API_KEY");
    expect(hidlPayload.suggested_action).toContain("OPENAI_API_KEY");
  });

  test("HIDL emit is idempotent within the dedup window — second call without key emits one HIDL only", async () => {
    delete process.env.OPENAI_API_KEY;
    const db = openDb(":memory:");
    emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "claude_root",
      payload: { text: "first" },
    });
    await embedPendingEvents(db);
    emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "claude_root",
      payload: { text: "second" },
    });
    await embedPendingEvents(db);
    const hidlRows = db
      .query("SELECT payload FROM events WHERE kind = 'hidl_action_required'")
      .all() as Array<{ payload: string }>;
    // Two embedding_skipped events but only one HIDL within the hour window.
    expect(hidlRows.length).toBe(1);
  });

  test("yields to the event loop between embedPendingEvents batches", async () => {
    process.env.OPENAI_API_KEY = "sk-test-mock";
    let calls = 0;
    let timerFired = false;
    let timerFiredBeforeThirdFetch = false;
    installMockFetch(async (_url, init) => {
      calls++;
      if (calls === 3) timerFiredBeforeThirdFetch = timerFired;
      const reqBody = JSON.parse((init.body as string) ?? "{}") as { input: string[] };
      const data = reqBody.input.map((_t, i) => ({ embedding: synthEmbedding(i + 61 + calls), index: i }));
      return new Response(JSON.stringify({ data }), { status: 200 });
    });
    const db = openDb(":memory:");
    for (let i = 0; i < MAX_EMBED_PENDING_BATCH_SIZE * 2 + 1; i++) {
      emitEvent(db, {
        kind: "knowledge_candidate",
        substrate_origin: "claude_root",
        payload: { text: "pending backlog " + i },
      });
    }

    setTimeout(() => { timerFired = true; }, 0);
    const result = await embedPendingEvents(db, { batchSize: 500 });

    expect(result.embedded).toBe(MAX_EMBED_PENDING_BATCH_SIZE * 2 + 1);
    expect(calls).toBe(3);
    expect(timerFiredBeforeThirdFetch).toBe(true);
  });

  test("idempotent — a second call after success is a cheap no-op", async () => {
    process.env.OPENAI_API_KEY = "sk-test-mock";
    let calls = 0;
    installMockFetch(async (_url, init) => {
      calls++;
      const reqBody = JSON.parse((init.body as string) ?? "{}") as { input: string[] };
      const data = reqBody.input.map((_t, i) => ({ embedding: synthEmbedding(i + 7), index: i }));
      return new Response(JSON.stringify({ data }), { status: 200 });
    });
    const db = openDb(":memory:");
    emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "claude_root",
      payload: { text: "first" },
    });
    const first = await embedPendingEvents(db);
    expect(first.embedded).toBe(1);
    const second = await embedPendingEvents(db);
    expect(second.embedded).toBe(0);
    expect(second.skipped).toBe(0);
    expect(second.failed).toBe(0);
    expect(calls).toBe(1);
  });
});
