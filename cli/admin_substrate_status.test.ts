// `acc admin substrate-status` tests — drive the programmatic entry
// against an injected env; assert the verdict + rendered shape.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "../runtime/events";
import {
  seedActArtifacts,
  seedFoundationalKnowledge,
  seedRecipes,
} from "../substrate/seed";
import { embedPendingEvents } from "../runtime/embedder";
import {
  computeSubstrateStatus,
  renderSubstrateStatus,
  runSubstrateStatus,
  type SubstrateStatusEnv,
} from "./admin_substrate_status";

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
  overrides: Partial<SubstrateStatusEnv> = {},
): { env: SubstrateStatusEnv; out: string[]; err: string[] } => {
  const out: string[] = [];
  const err: string[] = [];
  const env: SubstrateStatusEnv = {
    openSubstrate: () => db,
    stateDbPath: "/tmp/test-substrate.db",
    out: (line) => { out.push(line); },
    err: (line) => { err.push(line); },
    ...overrides,
  };
  return { env, out, err };
};

describe("computeSubstrateStatus", () => {
  test("DEAD verdict on an empty DB", () => {
    const db = openDb(":memory:");
    const r = computeSubstrateStatus(db, "/tmp/x.db");
    expect(r.verdict).toBe("DEAD");
    expect(r.events).toBe(0);
    expect(r.actArtifacts).toBe(0);
    expect(r.vecEvents).toBe(0);
  });

  test("DEGRADED verdict when seeds landed but no embeddings exist", () => {
    const db = openDb(":memory:");
    seedFoundationalKnowledge(db, { ownerApproved: true });
    seedActArtifacts(db);
    seedRecipes(db);
    const r = computeSubstrateStatus(db, "/tmp/x.db");
    expect(r.verdict).toBe("DEGRADED");
    expect(r.events).toBeGreaterThan(0);
    expect(r.actArtifacts).toBeGreaterThan(0);
    expect(r.vecEvents).toBe(0);
    expect(r.recipeRows).toBeGreaterThan(0);
  });

  test("ALIVE verdict after seed + embedPendingEvents", async () => {
    process.env.OPENAI_API_KEY = "sk-test-mock";
    installMockFetch(async (_url, init) => {
      const reqBody = JSON.parse((init.body as string) ?? "{}") as { input: string[] };
      const data = reqBody.input.map((_t, i) => ({ embedding: synthEmbedding(i + 1), index: i }));
      return new Response(JSON.stringify({ data }), { status: 200 });
    });
    const db = openDb(":memory:");
    seedFoundationalKnowledge(db, { ownerApproved: true });
    seedActArtifacts(db);
    seedRecipes(db);
    await embedPendingEvents(db);
    const r = computeSubstrateStatus(db, "/tmp/x.db");
    expect(r.verdict).toBe("ALIVE");
    expect(r.vecEvents).toBeGreaterThan(0);
    expect(r.embeddableTotal).toBeGreaterThan(0);
    expect(r.actArtifactsSeed).toBeGreaterThan(0);
    expect(r.actArtifactsBrain).toBe(0);
  });

  test("counts seed vs brain-authored artifacts separately", () => {
    const db = openDb(":memory:");
    seedActArtifacts(db);
    db.run(
      `INSERT INTO act_artifact (id, runtime, body, declared_sandbox, state_root,
         posterior_alpha, posterior_beta, score, confidence,
         recent_residual_mean, recent_kill_count, status, name,
         fixture_input, fixture_expected_residual, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "art_brain_authored_xyz",
        "bun",
        "// brain-authored body",
        JSON.stringify({ runtime: "bun" }),
        "brain/state",
        2, 2, 0.5, 0.5, 0, 0, "admitted", "brain_thing",
        "{}", 0.0,
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );
    const r = computeSubstrateStatus(db, "/tmp/x.db");
    expect(r.actArtifactsBrain).toBe(1);
    expect(r.actArtifactsSeed).toBeGreaterThan(0);
  });

  test("counts data-class (runtime IS NULL) act_artifact rows in the brain bucket", () => {
    // Path A (2026-05-20, contract A0DQT211JH): non-executing data-class
    // rows admit with runtime/declared_sandbox/fixture_input NULL. The
    // status report's seed/brain split must still tolerate the row
    // (state_root is null so it falls into the brain bucket — substrate-
    // primitive / threshold rows carry their own state_root prefix).
    const db = openDb(":memory:");
    seedActArtifacts(db);
    db.run(
      `INSERT INTO act_artifact (id, runtime, body, declared_sandbox, state_root,
         posterior_alpha, posterior_beta, score, confidence,
         recent_residual_mean, recent_kill_count, status, name,
         fixture_input, fixture_expected_residual, summary, created_at, updated_at
       ) VALUES (?, NULL, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
      [
        "art_data_class_xyz",
        "raw corpus body",
        2, 2, 0.5, 0.5, 0, 0, "admitted", "data_thing",
        "data-class summary",
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );
    const r = computeSubstrateStatus(db, "/tmp/x.db");
    expect(r.actArtifactsBrain).toBe(1);
    expect(r.actArtifactsSeed).toBeGreaterThan(0);
  });
});

describe("renderSubstrateStatus", () => {
  test("includes the verdict in the rendered output", () => {
    const lines: string[] = [];
    renderSubstrateStatus(
      {
        dbPath: "/tmp/x.db",
        events: 10,
        actArtifacts: 8,
        actArtifactsSeed: 8,
        actArtifactsBrain: 0,
        vecEvents: 5,
        embeddableTotal: 5,
        recipeRows: 2,
        knowledgePromoted: 10,
        stakeholderState: 0,
        directiveInterference: 0,
        healthMetricCounts: {
          dispatcher_violation: 0,
          irreversible_effect_recorded: 0,
          worker_tick_overrun: 0,
        },
        dispatcherViolations: 0,
        irreversibleEffects: 0,
        workerTickOverruns: 0,
        latestEventTs: "2026-01-01T00:00:00Z",
        latestArtifactTs: "2026-01-01T00:00:00Z",
        oldestUnembeddedTs: null,
        verdict: "ALIVE",
      },
      (line) => lines.push(line),
    );
    const joined = lines.join("\n");
    expect(joined).toContain("verdict: ALIVE");
    expect(joined).toContain("events:");
    expect(joined).toContain("act_artifact:");
    expect(joined).toContain("vec_events:");
    expect(joined).toContain("(8 seed, 0 brain-authored)");
    expect(joined).toContain("all embedded");
    expect(joined).toContain("health metrics:");
    expect(joined).toContain("dispatcher_violation:");
    // Registry now emits the canonical kind verbatim (was the
    // shortened `irreversible_effect:` before unification).
    expect(joined).toContain("irreversible_effect_recorded:");
    expect(joined).toContain("worker_tick_overrun:");
  });

  test("counts health-metric event kinds (dispatcher_violation, irreversible_effect_recorded, worker_tick_overrun)", () => {
    const db = openDb(":memory:");
    seedActArtifacts(db);
    emitEvent(db, {
      kind: "dispatcher_violation" as never,
      substrate_origin: "substrate_auto",
      payload: { failure_kind: "cycle_1_only_breach" },
    });
    emitEvent(db, {
      kind: "irreversible_effect_recorded" as never,
      substrate_origin: "substrate_auto",
      payload: { kind: "net_outbound", target: "https://example.com" },
    });
    emitEvent(db, {
      kind: "irreversible_effect_recorded" as never,
      substrate_origin: "substrate_auto",
      payload: { kind: "fs_write", path: "/tmp/x" },
    });
    emitEvent(db, {
      kind: "worker_tick_overrun" as never,
      substrate_origin: "substrate_auto",
      payload: { worker: "scheduler", expected_ms: 1000, actual_ms: 2500 },
    });
    const r = computeSubstrateStatus(db, "/tmp/x.db");
    expect(r.dispatcherViolations).toBe(1);
    expect(r.irreversibleEffects).toBe(2);
    expect(r.workerTickOverruns).toBe(1);
  });
});

describe("runSubstrateStatus end-to-end", () => {
  test("renders DEAD output for empty DB and returns 0", async () => {
    const db = openDb(":memory:");
    const { env, out } = makeEnv(db);
    const code = await runSubstrateStatus([], env);
    expect(code).toBe(0);
    const joined = out.join("\n");
    expect(joined).toContain("verdict: DEAD");
    expect(joined).toContain("acc2 substrate status —");
  });

  test("renders ALIVE for fully-populated substrate", async () => {
    process.env.OPENAI_API_KEY = "sk-test-mock";
    installMockFetch(async (_url, init) => {
      const reqBody = JSON.parse((init.body as string) ?? "{}") as { input: string[] };
      const data = reqBody.input.map((_t, i) => ({ embedding: synthEmbedding(i + 1), index: i }));
      return new Response(JSON.stringify({ data }), { status: 200 });
    });
    const db = openDb(":memory:");
    seedFoundationalKnowledge(db, { ownerApproved: true });
    seedActArtifacts(db);
    seedRecipes(db);
    await embedPendingEvents(db);
    const { env, out } = makeEnv(db);
    const code = await runSubstrateStatus([], env);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("verdict: ALIVE");
  });
});
