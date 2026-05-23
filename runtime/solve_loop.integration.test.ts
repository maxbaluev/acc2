// End-to-end ORGANISM integration test for the generate-and-select spine.
//
// Unlike the unit suites (which inject no-op deps), this test wires solveTask
// to the REAL substrate adapters from generate_select_adapters.ts against a
// REAL schema-backed SQLite DB (openDb(":memory:") loads substrate/schema.sql).
// It proves the whole organism flows as ONE thing:
//   classify -> predict -> generate -> provenance-filter -> select -> record
// and that the recorded outcome lands in the experience stream as a single
// act_tuple_recorded row with verifier_kind 'generate_select_outcome'.
//
// The only stub is the diversity engine (`generate`) and the experience-stream
// reader (`retrieveSimilar`) — these are the LLM / retrieval seams the design
// deliberately injects. Everything downstream (comparator, owner-preference
// request, outcome recording, the act-tuple projection at the emit boundary)
// is the real substrate code path.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import type { Database } from "bun:sqlite";
import { solveTask, type SolveDeps } from "./solve_loop";
import type { Candidate } from "./generate_select";
import type { NumericClaim } from "./claim_provenance_verifier";
import type { PastOutcome } from "./experience_predictor";
import {
  GENERATE_SELECT_VERIFIER_KIND,
  structuralComparator,
  recordOutcomeToStream,
  requestOwnerPreference,
} from "./generate_select_adapters";

type Report = { headline: string };

// A clean, fully-sourced numeric claim (every leaf has a source_uri).
const cleanClaims = (label: string): NumericClaim[] => [
  {
    id: `${label}-c1`,
    expression: "revenue * 2",
    result: 200,
    inputs: [
      { label: "revenue", value: 100, source_uri: "https://sec.gov/10-K" },
      { label: "2", value: 2, source_uri: "https://sec.gov/10-K" },
    ],
  },
];

// The Lakeland slop: a "recovery_rate" multiplier invented out of nowhere
// (unsourced:true) silently feeding a headline figure. residual >= 0.3 -> drop.
const slopClaims = (label: string): NumericClaim[] => [
  {
    id: `${label}-c1`,
    expression: "revenue * recovery_rate",
    result: 6,
    inputs: [
      { label: "revenue", value: 100, source_uri: "https://sec.gov/10-K" },
      { label: "recovery_rate", value: 0.06, unsourced: true },
    ],
  },
];

const cand = (id: string, claims: NumericClaim[]): Candidate<Report> => ({
  id,
  artifact: { headline: id },
  claims,
  generator: "verbalized_sampling",
});

// Count act_tuple rows in the experience stream by verifier_kind.
const countActTuples = (db: Database, vk: string): number =>
  db
    .query<{ c: number }, [string]>(
      "SELECT COUNT(*) AS c FROM events WHERE kind = 'act_tuple_recorded' AND json_extract(payload, '$.verifier_kind') = ?",
    )
    .get(vk)!.c;

// Build the REAL substrate-backed deps. comparator / owner-preference / record
// are the genuine adapter implementations bound to `db` — not stubs.
const realDeps = (
  db: Database,
  generate: SolveDeps<Report>["generate"],
  retrieveSimilar: SolveDeps<Report>["retrieveSimilar"],
  task: string,
): SolveDeps<Report> => ({
  generate,
  retrieveSimilar,
  comparator: async (t, a, b) => structuralComparator(t, a, b),
  requestOwnerPreference: async (t, a, b) =>
    requestOwnerPreference(db, t, a, b, { substrateOrigin: "claude_inline" })
      .preference,
  recordOutcome: (outcome) =>
    recordOutcomeToStream(db, task, outcome, {
      substrateOrigin: "claude_inline",
    }),
});

afterAll(() => closeDb());
beforeEach(() => closeDb());

describe("solveTask end-to-end organism (real adapters + real schema DB)", () => {
  it("(1) AMBIGUOUS + novel: full path filters the slop, selects a clean candidate, records one outcome", async () => {
    const db = openDb(":memory:");
    const task = "write a persuasive investor report summary of the 10-K";

    // Novel: the experience stream has nothing similar -> world model has no
    // grounding -> full path.
    const retrieveSimilar = async (): Promise<PastOutcome[]> => [];

    // Three diverse candidates: ONE carries the Lakeland slop, two are clean.
    const generate = async (_t: string, _n: number): Promise<Candidate<Report>[]> => [
      cand("slop", slopClaims("slop")),
      cand("clean_a", cleanClaims("clean_a")),
      cand("clean_b", cleanClaims("clean_b")),
    ];

    const before = countActTuples(db, GENERATE_SELECT_VERIFIER_KIND);
    const result = await solveTask(task, realDeps(db, generate, retrieveSimilar, task));
    const after = countActTuples(db, GENERATE_SELECT_VERIFIER_KIND);

    expect(result.route).toBe("ambiguous");
    expect(result.path).toBe("full");

    // The slop candidate was provenance-filtered out.
    const filteredIds = result.selectOutcome!.filtered_out.map((f) => f.id);
    expect(filteredIds).toContain("slop");

    // A clean candidate won.
    expect(result.selected).not.toBeNull();
    expect(["clean_a", "clean_b"]).toContain(result.selected!.id);

    // Exactly one outcome row was written to the experience stream.
    expect(after - before).toBe(1);
  });

  it("(2) AMBIGUOUS + confident-good history: fast path, outcome recorded", async () => {
    const db = openDb(":memory:");
    const task = "draft a customer-facing email recommending the new pricing";

    // Many recent, highly-similar, REAL-contact good outcomes -> world model
    // is confidently good -> fast path (skip the expensive loop).
    const now = Date.now();
    const retrieveSimilar = async (): Promise<PastOutcome[]> =>
      Array.from({ length: 8 }, (_, i) => ({
        task,
        residual: 0.05,
        ts_ms: now - i * 60_000, // all within the last few minutes
        similarity: 0.95,
        was_real_contact: true,
      }));

    // The fast path generates ONE clean candidate.
    const generate = async (): Promise<Candidate<Report>[]> => [
      cand("fast_clean", cleanClaims("fast_clean")),
    ];

    const before = countActTuples(db, GENERATE_SELECT_VERIFIER_KIND);
    const result = await solveTask(task, realDeps(db, generate, retrieveSimilar, task));
    const after = countActTuples(db, GENERATE_SELECT_VERIFIER_KIND);

    expect(result.route).toBe("ambiguous");
    expect(result.path).toBe("fast");
    expect(result.selected).not.toBeNull();
    expect(result.selected!.id).toBe("fast_clean");
    // The fast path also records exactly one experience-stream outcome.
    expect(after - before).toBe(1);
  });

  it("(3) VERIFIABLE task: deterministic path, no generate-and-select spend", async () => {
    const db = openDb(":memory:");
    const task = "fix the failing unit test so it compiles and passes";

    let generateCalls = 0;
    const generate = async (_t: string, n: number): Promise<Candidate<Report>[]> => {
      generateCalls += 1;
      // Deterministic path asks for exactly ONE candidate.
      expect(n).toBe(1);
      return [cand("det", cleanClaims("det"))];
    };
    const retrieveSimilar = async (): Promise<PastOutcome[]> => {
      throw new Error("verifiable path must not consult the experience stream");
    };

    const result = await solveTask(task, realDeps(db, generate, retrieveSimilar, task));

    expect(result.route).toBe("verifiable");
    expect(result.path).toBe("deterministic");
    expect(generateCalls).toBe(1);
    expect(result.selected).not.toBeNull();
  });
});
