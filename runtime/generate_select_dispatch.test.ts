// Phase 9 unit tests — the env-gated daemon dispatch hook.
//
// We never touch the network or a real DB schema: the generator is stubbed and
// the deps-builder is replaced so `solveTask` runs entirely in-memory. The
// three cases exercise the gate matrix:
//   1. flag UNSET            -> {handled:false}, generator NEVER called.
//   2. flag SET + ambiguous  -> {handled:true}, generator called, outcome recorded.
//   3. flag SET + verifiable -> {handled:false}, generator NEVER called.

import { describe, test, expect, afterEach } from "bun:test";
import {
  maybeRunGenerateSelect,
  type GenerateSelectDispatchDeps,
} from "./generate_select_dispatch";
import type { Candidate, GenerateSelectDeps, SelectOutcome } from "./generate_select";

// A clean candidate: one source_uri'd input -> provenance residual 0.
const cleanCandidate = (id: string): Candidate<string> => ({
  id,
  artifact: `artifact-${id}`,
  generator: "stub",
  claims: [
    {
      id: `${id}-c1`,
      expression: "x",
      result: 42,
      inputs: [{ label: "x", value: 42, source_uri: "https://src/10k" }],
    },
  ],
});

// A fake DB handle — never read because buildDeps is stubbed.
const fakeDb = {} as never;

// Build deps without touching the act-tuple projection gate: structural-ish
// comparator + a recordOutcome the test can spy on (overridable separately).
const stubBuildDeps =
  (recorded: SelectOutcome<string>[]): GenerateSelectDispatchDeps["buildDeps"] =>
  (_db, cfg): GenerateSelectDeps<string> => ({
    generators: cfg.generators,
    comparator: async (_t, a, _b) => ({
      winner_id: a.id,
      confidence: 1,
      rationale: "stub",
    }),
    recordOutcome: (o) => recorded.push(o),
  });

afterEach(() => {
  delete process.env.ACC2_GENERATE_SELECT;
});

describe("maybeRunGenerateSelect — env-gated organism hook", () => {
  test("flag UNSET -> {handled:false}, does nothing", async () => {
    delete process.env.ACC2_GENERATE_SELECT;
    let genCalls = 0;
    const recorded: SelectOutcome<string>[] = [];
    const deps: GenerateSelectDispatchDeps = {
      generate: async () => {
        genCalls += 1;
        return [cleanCandidate("c1")];
      },
      buildDeps: stubBuildDeps(recorded),
    };
    const res = await maybeRunGenerateSelect(
      fakeDb,
      "write an engaging persuasive headline with great tone",
      {},
      deps,
    );
    expect(res.handled).toBe(false);
    expect(res.result).toBeUndefined();
    expect(genCalls).toBe(0);
    expect(recorded.length).toBe(0);
  });

  test("flag SET + ambiguous -> {handled:true}, records an outcome", async () => {
    process.env.ACC2_GENERATE_SELECT = "1";
    let genCalls = 0;
    const recorded: SelectOutcome<string>[] = [];
    const deps: GenerateSelectDispatchDeps = {
      generate: async (_t, _n) => {
        genCalls += 1;
        return [cleanCandidate("a1"), cleanCandidate("a2"), cleanCandidate("a3")];
      },
      buildDeps: stubBuildDeps(recorded),
    };
    const res = await maybeRunGenerateSelect(
      fakeDb,
      "write an engaging persuasive headline with great tone and voice",
      { directiveId: "d1", taskId: "t1" },
      deps,
    );
    expect(res.handled).toBe(true);
    expect(res.result?.route).toBe("ambiguous");
    expect(genCalls).toBeGreaterThan(0);
    expect(recorded.length).toBeGreaterThan(0);
    expect(res.result?.selected).not.toBeNull();
  });

  test("flag SET + verifiable -> {handled:false}, generator never called", async () => {
    process.env.ACC2_GENERATE_SELECT = "1";
    let genCalls = 0;
    const recorded: SelectOutcome<string>[] = [];
    const deps: GenerateSelectDispatchDeps = {
      generate: async () => {
        genCalls += 1;
        return [cleanCandidate("v1")];
      },
      buildDeps: stubBuildDeps(recorded),
    };
    const res = await maybeRunGenerateSelect(
      fakeDb,
      "compile the function, run the unit tests, fix the type error and lint",
      {},
      deps,
    );
    expect(res.handled).toBe(false);
    expect(genCalls).toBe(0);
    expect(recorded.length).toBe(0);
  });
});
