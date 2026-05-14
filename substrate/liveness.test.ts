// substrate/liveness — verdict-contract tests. Both `acc doctor` and
// `acc admin substrate-status` consume this module; the assertions
// here pin the canonical ALIVE / DEGRADED / DEAD semantics so neither
// surface can drift away from the contract.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "./db";
import {
  seedCodeArtifacts,
  seedFoundationalKnowledge,
  seedRecipes,
} from "./seed";
import { embedPendingEvents } from "../runtime/embedder";
import {
  computeLivenessReport,
  LIVENESS_THRESHOLDS,
} from "./liveness";

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

const synthEmbedding = (seed: number): number[] => {
  const out = new Array<number>(1536);
  for (let i = 0; i < 1536; i++) out[i] = Math.sin(seed * 0.1 + i * 0.001);
  return out;
};

describe("LIVENESS_THRESHOLDS", () => {
  test("exposes the canonical seed-count floors", () => {
    // Re-pin the canonical numbers. Doctor + substrate-status must
    // derive from these; changing them in one place and not the other
    // is what this contract exists to prevent.
    expect(LIVENESS_THRESHOLDS.knowledgePromoted).toBe(5);
    expect(LIVENESS_THRESHOLDS.codeArtifactsSeed).toBe(5);
    expect(LIVENESS_THRESHOLDS.recipesSeed).toBe(1);
    expect(LIVENESS_THRESHOLDS.vecExtensionLoadable).toBe(1);
  });
});

describe("computeLivenessReport", () => {
  test("DEAD on an empty events table", () => {
    const db = openDb(":memory:");
    const r = computeLivenessReport(db);
    expect(r.verdict).toBe("DEAD");
    // Every signal still surfaces so the renderer can show the gap.
    const names = r.signals.map((s) => s.name).sort();
    expect(names).toEqual([
      "codeArtifactsSeed",
      "knowledgePromoted",
      "recipesSeed",
      "vecExtensionLoadable",
    ]);
    expect(r.signals.every((s) => !s.pass)).toBe(true);
  });

  test("DEGRADED when seed_knowledge below threshold (events > 0, ≥1 signal missing)", () => {
    const db = openDb(":memory:");
    // Seed artifacts + recipes but skip foundational knowledge so
    // knowledgePromoted stays at 0 (below LIVENESS_THRESHOLDS.knowledgePromoted=5).
    seedCodeArtifacts(db);
    seedRecipes(db);
    const r = computeLivenessReport(db);
    expect(r.verdict).toBe("DEGRADED");
    const kp = r.signals.find((s) => s.name === "knowledgePromoted")!;
    expect(kp.pass).toBe(false);
    expect(kp.observed).toBeLessThan(kp.required);
  });

  test("DEGRADED when seeds landed but no embeddings exist (vec_events == 0)", () => {
    const db = openDb(":memory:");
    seedFoundationalKnowledge(db, { ownerApproved: true });
    seedCodeArtifacts(db);
    seedRecipes(db);
    const r = computeLivenessReport(db);
    expect(r.verdict).toBe("DEGRADED");
    const vec = r.signals.find((s) => s.name === "vecExtensionLoadable")!;
    expect(vec.pass).toBe(false);
    expect(vec.observed).toBe(0);
    // Other seed signals should pass (the seeds populate them).
    expect(r.signals.find((s) => s.name === "knowledgePromoted")!.pass).toBe(true);
    expect(r.signals.find((s) => s.name === "codeArtifactsSeed")!.pass).toBe(true);
    expect(r.signals.find((s) => s.name === "recipesSeed")!.pass).toBe(true);
  });

  test("ALIVE on a fully-seeded + embedded substrate", async () => {
    process.env.OPENAI_API_KEY = "sk-test-mock";
    installMockFetch(async (_url, init) => {
      const reqBody = JSON.parse((init.body as string) ?? "{}") as { input: string[] };
      const data = reqBody.input.map((_t, i) => ({ embedding: synthEmbedding(i + 1), index: i }));
      return new Response(JSON.stringify({ data }), { status: 200 });
    });
    const db = openDb(":memory:");
    seedFoundationalKnowledge(db, { ownerApproved: true });
    seedCodeArtifacts(db);
    seedRecipes(db);
    await embedPendingEvents(db);
    const r = computeLivenessReport(db);
    expect(r.verdict).toBe("ALIVE");
    expect(r.signals.every((s) => s.pass)).toBe(true);
  });
});
