// `acc admin embed-all` tests — drive the programmatic entry against an
// injected env. Hermetic: no daemon, no real OpenAI call, no fs.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "../runtime/events";
import { runEmbedAll, type EmbedAllEnv } from "./admin_embed_all";

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

const makeEnv = (
  db: ReturnType<typeof openDb>,
  overrides: Partial<EmbedAllEnv> = {},
): { env: EmbedAllEnv; out: string[]; err: string[] } => {
  const out: string[] = [];
  const err: string[] = [];
  const env: EmbedAllEnv = {
    openSubstrate: () => db,
    daemonRunning: () => false,
    out: (line) => { out.push(line); },
    err: (line) => { err.push(line); },
    ...overrides,
  };
  return { env, out, err };
};

describe("acc admin embed-all", () => {
  test("refuses when the daemon is running", async () => {
    const db = openDb(":memory:");
    const { env, err } = makeEnv(db, { daemonRunning: () => true });
    const code = await runEmbedAll([], env);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("daemon is running");
    expect(err.join("\n")).toContain("acc daemon stop");
  });

  test("prints zero summary on a fresh substrate", async () => {
    const db = openDb(":memory:");
    const { env, out } = makeEnv(db);
    const code = await runEmbedAll([], env);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("embedded: 0");
    expect(out.join("\n")).toContain("skipped: 0");
    expect(out.join("\n")).toContain("failed: 0");
  });

  test("embeds pending knowledge events and prints the count", async () => {
    process.env.OPENAI_API_KEY = "sk-test-mock";
    installMockFetch(async (_url, init) => {
      const reqBody = JSON.parse((init.body as string) ?? "{}") as { input: string[] };
      const data = reqBody.input.map((_t, i) => ({ embedding: synthEmbedding(i + 1), index: i }));
      return new Response(JSON.stringify({ data }), { status: 200 });
    });
    const db = openDb(":memory:");
    emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "claude_root",
      payload: { text: "alpha" },
    });
    emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "claude_root",
      payload: { text: "bravo" },
    });
    const { env, out } = makeEnv(db);
    const code = await runEmbedAll([], env);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("embedded: 2");
    // Both events now have a vec_events row.
    const vecCount = (db
      .query("SELECT COUNT(*) AS c FROM vec_events").get() as { c: number }).c;
    expect(vecCount).toBe(2);
  });

  test("idempotent — second call with no pending rows is a no-op", async () => {
    process.env.OPENAI_API_KEY = "sk-test-mock";
    let calls = 0;
    installMockFetch(async (_url, init) => {
      calls++;
      const reqBody = JSON.parse((init.body as string) ?? "{}") as { input: string[] };
      const data = reqBody.input.map((_t, i) => ({ embedding: synthEmbedding(i + 5), index: i }));
      return new Response(JSON.stringify({ data }), { status: 200 });
    });
    const db = openDb(":memory:");
    emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "claude_root",
      payload: { text: "only one" },
    });
    const { env: env1 } = makeEnv(db);
    await runEmbedAll([], env1);
    const { env: env2, out: out2 } = makeEnv(db);
    const code = await runEmbedAll([], env2);
    expect(code).toBe(0);
    expect(out2.join("\n")).toContain("embedded: 0");
    expect(calls).toBe(1);
  });
});
