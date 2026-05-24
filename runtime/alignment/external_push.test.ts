// Phase Align — Principle 7: external-push first-class.
//
// Architecture.md: events ingested via `POST /external/push` are first-
// class substrate rows. The embedder includes them in `EMBEDDABLE_KINDS`,
// and once embedded they show up in retrieval just like brain-emitted rows.
//
// This test exercises the surface end-to-end with a mocked embedding fetch
// — we POST through `handleExternalPush`, run a single embedder tick under
// a fake fetch that returns a known vector, rebuild the embedding index,
// and KNN against that same vector. The external row must surface with
// distance ≈ 0.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../../substrate/db";
import { runViews } from "../../substrate/views";
import {
  createExternalIngressState,
  handleExternalPush,
  registerExternalSource,
} from "../external_ingress";
import { embedderWorkerTick, EMBEDDABLE_KINDS, EMBEDDING_DIMS } from "../embedder";
import { EmbeddingIndex } from "../embedding_index";

afterAll(() => closeDb());

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_API_KEY = process.env.OPENAI_API_KEY;
beforeEach(() => {
  // Default state: restore original fetch so other tests are unaffected.
  globalThis.fetch = ORIGINAL_FETCH;
  process.env.OPENAI_API_KEY = ORIGINAL_API_KEY;
});
// beforeEach only resets BEFORE each test in THIS file — it does NOT clean up
// after the file's last test. A test here replaces globalThis.fetch with an
// unconditional-200 OpenAI mock; without an afterEach restore that mock leaks
// onto the process-wide globalThis.fetch and poisons whatever test file runs
// next in the serial suite (observed: runtime/bridge/mcp_pool.test.ts's real
// defaultProbe got a fake 200 from this mock and never failed over → 8s
// timeout). Restore the global after every test so the leak cannot escape.
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ORIGINAL_API_KEY;
});

describe("alignment / external_push (Principle 7)", () => {
  test("external_event_received is in EMBEDDABLE_KINDS", () => {
    expect(EMBEDDABLE_KINDS.has("external_event_received")).toBe(true);
  });

  test("an external-pushed event becomes retrievable through the embedding index", async () => {
    closeDb();
    const db = openDb(":memory:");
    runViews(db);

    // Wire ingress state with a token for our test source.
    const state = createExternalIngressState({ ownerDefaultToken: "phase-align-secret" });
    registerExternalSource(db, state, {
      name: "phase_align_source",
      bearer_token: "phase-align-secret",
      schema_hint: "alignment-fixture",
    });

    // Mock OpenAI: return a single canonical embedding for every call.
    const canonical = new Array<number>(EMBEDDING_DIMS).fill(0);
    for (let i = 0; i < canonical.length; i++) canonical[i] = ((i % 13) - 6) / 10;
    process.env.OPENAI_API_KEY = "test-key";
    let fetchCalls = 0;
    globalThis.fetch = (async (_url: string, _init?: RequestInit) => {
      fetchCalls++;
      // Build a `data` array matching the input count (we always send one in
      // this test, but support batches for correctness).
      const input = JSON.parse((_init?.body as string) ?? "{}") as { input: string | string[] };
      const inputs = Array.isArray(input.input) ? input.input : [input.input];
      const data = inputs.map((_, idx) => ({ embedding: canonical, index: idx }));
      return new Response(JSON.stringify({ data }), { status: 200 });
    }) as typeof fetch;

    // POST one external event through the canonical webhook handler.
    const req = new Request("http://localhost/external/push", {
      method: "POST",
      headers: {
        "Authorization": "Bearer phase-align-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source: "phase_align_source",
        kind: "external_event_received",
        payload: { summary: "alignment phase-7 external push fixture body" },
      }),
    });
    const res = await handleExternalPush(db, state, req);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; event_id: string };
    expect(body.ok).toBe(true);
    const eventId: string = body.event_id;

    // Drive the embedder worker once. It picks the unembedded
    // external_event_received row, embeds it, writes the BLOB + version,
    // and emits embedding_computed.
    const tick = await embedderWorkerTick(db, { batchSize: 10 });
    expect(fetchCalls).toBeGreaterThanOrEqual(1);
    expect(tick.embedded).toBe(1);

    const embeddingComputed = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'embedding_computed' AND payload LIKE '%' || ? || '%'")
      .get(eventId) as { c: number };
    expect(embeddingComputed.c).toBe(1);

    // Rebuild the index and KNN. Querying with the same canonical vector
    // must surface the external row at distance ≈ 0.
    const index = EmbeddingIndex.rebuildFromDb(db);
    expect(index.size()).toBeGreaterThanOrEqual(1);
    const queryVec = new Float32Array(canonical);
    const hits = index.knn(queryVec, 5);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const externalHit = hits.find((h) => h.entry.event_id === eventId);
    expect(externalHit).toBeDefined();
    if (externalHit) {
      // Identical vectors → cosine distance == 0 (allow tiny float epsilon).
      expect(externalHit.distance).toBeLessThan(1e-6);
    }
  });
});
