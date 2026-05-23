// Phase 6 unit tests — the unified organism loop. All deps stubbed: no DB,
// no LLM, no daemon. We assert WHICH path ran by spying on the injected
// generate / recordOutcome and on whether generate_select's pairwise machinery
// was reached (proxied by the comparator spy + the candidate count requested).

import { describe, test, expect } from "bun:test";
import { solveTask, type SolveDeps } from "./solve_loop";
import type { Candidate } from "./generate_select";
import type { PastOutcome } from "./experience_predictor";

// ── fixtures ──────────────────────────────────────────────────────────
// A clean candidate: one source_uri'd input -> provenance residual 0.
const cleanCandidate = (id: string, generator = "g"): Candidate<string> => ({
  id,
  artifact: `artifact-${id}`,
  generator,
  claims: [
    {
      id: `${id}-c1`,
      expression: "x",
      result: 42,
      inputs: [{ label: "x", value: 42, source_uri: "https://src/10k" }],
    },
  ],
});

// A slop candidate: one unsourced input -> provenance residual 1.0 (>= 0.3).
const slopCandidate = (id: string, generator = "g"): Candidate<string> => ({
  id,
  artifact: `artifact-${id}`,
  generator,
  claims: [
    {
      id: `${id}-c1`,
      expression: "x",
      result: 99,
      inputs: [{ label: "x", value: 99, unsourced: true }],
    },
  ],
});

// Many recent good REAL-contact outcomes -> world model confident-good.
const confidentGood = (task: string, _k: number): Promise<PastOutcome[]> =>
  Promise.resolve(
    Array.from({ length: 6 }, (_, i) => ({
      task,
      residual: 0.05,
      ts_ms: Date.now() - i * 1000, // all fresh
      similarity: 0.95,
      was_real_contact: true,
    })),
  );

// Sparse / novel retrieval -> world model cannot be trusted.
const sparseNovel = (_task: string, _k: number): Promise<PastOutcome[]> =>
  Promise.resolve([]);

describe("solveTask — unified organism loop", () => {
  test("VERIFIABLE: clean candidate selected, deterministic path", async () => {
    let genCalls = 0;
    let genN = 0;
    const deps: SolveDeps<string> = {
      generate: async (_t, n) => {
        genCalls += 1;
        genN = n;
        return [cleanCandidate("v1")];
      },
      retrieveSimilar: async () => {
        throw new Error("retrieveSimilar must NOT be called on verifiable route");
      },
    };
    const res = await solveTask("compute the sum and run unit tests", deps);
    expect(res.route).toBe("verifiable");
    expect(res.path).toBe("deterministic");
    expect(res.selected?.id).toBe("v1");
    expect(genCalls).toBe(1);
    expect(genN).toBe(1); // no candidate budget on the verifiable route
    expect(res.prediction).toBeUndefined();
  });

  test("VERIFIABLE: bad-provenance candidate -> selected null", async () => {
    const deps: SolveDeps<string> = {
      generate: async () => [slopCandidate("v2")],
      retrieveSimilar: async () => [],
    };
    const res = await solveTask("calculate the checksum and parse the json", deps);
    expect(res.route).toBe("verifiable");
    expect(res.path).toBe("deterministic");
    expect(res.selected).toBeNull();
    expect(res.reason).toContain("provenance failed");
  });

  test("AMBIGUOUS + confident-good prediction -> FAST path (one candidate, no generateAndSelect)", async () => {
    let genCalls = 0;
    let genN = 0;
    let comparatorCalls = 0;
    let recordCalls = 0;
    const deps: SolveDeps<string> = {
      generate: async (_t, n) => {
        genCalls += 1;
        genN = n;
        return [cleanCandidate("f1")];
      },
      retrieveSimilar: confidentGood,
      comparator: async () => {
        comparatorCalls += 1;
        return { winner_id: "f1", confidence: 1, rationale: "should-not-run" };
      },
      recordOutcome: () => {
        recordCalls += 1;
      },
    };
    const res = await solveTask(
      "write a persuasive investor pitch with a compelling narrative",
      deps,
    );
    expect(res.route).toBe("ambiguous");
    expect(res.path).toBe("fast");
    expect(res.selected?.id).toBe("f1");
    expect(genCalls).toBe(1);
    expect(genN).toBe(1); // fast path asks for exactly ONE candidate
    expect(comparatorCalls).toBe(0); // generateAndSelect NOT invoked
    expect(recordCalls).toBe(1); // outcome recorded
    expect(res.prediction?.basis).toBe("sufficient");
  });

  test("AMBIGUOUS + sparse/novel prediction -> FULL path (generateAndSelect over N, slop filtered)", async () => {
    let genCalls = 0;
    let genN = 0;
    let comparatorCalls = 0;
    let recordCalls = 0;
    const deps: SolveDeps<string> = {
      generate: async (_t, n) => {
        genCalls += 1;
        genN = n;
        // Two clean + one slop; the slop must be provenance-filtered.
        return [
          cleanCandidate("u1", "gen-a"),
          slopCandidate("u-slop", "gen-b"),
          cleanCandidate("u2", "gen-c"),
        ];
      },
      retrieveSimilar: sparseNovel,
      comparator: async (_t, a, _b) => {
        comparatorCalls += 1;
        return { winner_id: a.id, confidence: 0.9, rationale: "champion holds" };
      },
      recordOutcome: () => {
        recordCalls += 1;
      },
    };
    const res = await solveTask(
      "draft a strategic vision memo and recommend the best positioning",
      deps,
    );
    expect(res.route).toBe("ambiguous");
    expect(res.path).toBe("full");
    expect(genN).toBe(3); // full path asks for N=3 diverse candidates
    expect(comparatorCalls).toBeGreaterThan(0); // generateAndSelect ran the ladder
    expect(recordCalls).toBe(1);
    // The slop candidate was provenance-filtered out.
    const filteredIds = res.selectOutcome?.filtered_out.map((f) => f.id) ?? [];
    expect(filteredIds).toContain("u-slop");
    // A clean survivor was selected.
    expect(["u1", "u2"]).toContain(res.selected?.id);
    expect(res.prediction?.basis).not.toBe("sufficient");
  });

  test("recordOutcome is reached in both fast and full paths", async () => {
    // Fast
    let fastRecorded = 0;
    await solveTask("write an engaging headline with great tone", {
      generate: async () => [cleanCandidate("fast")],
      retrieveSimilar: confidentGood,
      recordOutcome: () => {
        fastRecorded += 1;
      },
    });
    expect(fastRecorded).toBe(1);

    // Full
    let fullRecorded = 0;
    await solveTask("brainstorm creative marketing ideas and recommend tradeoffs", {
      generate: async () => [cleanCandidate("a"), cleanCandidate("b")],
      retrieveSimilar: sparseNovel,
      recordOutcome: () => {
        fullRecorded += 1;
      },
    });
    expect(fullRecorded).toBe(1);
  });
});
