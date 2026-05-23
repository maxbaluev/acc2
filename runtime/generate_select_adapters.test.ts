import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import type { Database } from "bun:sqlite";
import type { NumericClaim } from "./claim_provenance_verifier";
import {
  type Candidate,
  type SelectOutcome,
  generateAndSelect,
} from "./generate_select";
import {
  GENERATE_SELECT_VERIFIER_KIND,
  buildSubstrateDeps,
  recordOutcomeToStream,
  requestOwnerPreference,
  structuralComparator,
} from "./generate_select_adapters";

type Report = { headline: string };

// Grounded claim: every input has a source_uri.
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

// One unsourced input -> residual >= 0.3.
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
  generator: "gen",
});

const countEvents = (db: Database, kind: string): number =>
  db
    .query<{ c: number }, [string]>(
      "SELECT COUNT(*) AS c FROM events WHERE kind = ?",
    )
    .get(kind)!.c;

const countActTuplesByVerifierKind = (db: Database, vk: string): number =>
  db
    .query<{ c: number }, [string]>(
      "SELECT COUNT(*) AS c FROM events WHERE kind = 'act_tuple_recorded' AND json_extract(payload, '$.verifier_kind') = ?",
    )
    .get(vk)!.c;

afterAll(() => closeDb());
beforeEach(() => closeDb());

describe("recordOutcomeToStream", () => {
  it("emits exactly one act-tuple with verifier_kind 'generate_select_outcome'", () => {
    const db = openDb(":memory:");
    const outcome: SelectOutcome<Report> = {
      selected: cand("good1", cleanClaims("good1")),
      filtered_out: [{ id: "slop", residual: 0.5 }],
      comparisons: [
        { a_id: "good1", b_id: "slop", winner_id: "good1", confidence: 0.9, rationale: "x" },
      ],
      preference_used: null,
      reason: "comparator_winner",
    };

    const before = countActTuplesByVerifierKind(db, GENERATE_SELECT_VERIFIER_KIND);
    const ev = recordOutcomeToStream(db, "summarize the 10-K", outcome);
    const after = countActTuplesByVerifierKind(db, GENERATE_SELECT_VERIFIER_KIND);

    expect(ev.id).toBeTruthy();
    expect(after - before).toBe(1);

    const row = db
      .query<{ verifier_kind: string }, [string]>(
        "SELECT json_extract(payload, '$.verifier_kind') AS verifier_kind FROM events WHERE id = ?",
      )
      .get(ev.id)!;
    expect(row.verifier_kind).toBe(GENERATE_SELECT_VERIFIER_KIND);
  });

  it("records a null selection as a failed outcome", () => {
    const db = openDb(":memory:");
    const outcome: SelectOutcome<Report> = {
      selected: null,
      filtered_out: [{ id: "slop", residual: 0.5 }],
      comparisons: [],
      preference_used: null,
      reason: "all_candidates_failed_provenance",
    };
    const ev = recordOutcomeToStream(db, "task", outcome);
    const row = db
      .query<{ outcome: string }, [string]>(
        "SELECT json_extract(payload, '$.outcome') AS outcome FROM events WHERE id = ?",
      )
      .get(ev.id)!;
    expect(row.outcome).toBe("failed");
  });
});

describe("requestOwnerPreference", () => {
  it("emits one owner_input_required carrying both candidates", () => {
    const db = openDb(":memory:");
    const a = cand("good1", cleanClaims("good1"));
    const b = cand("good2", cleanClaims("good2"));

    const before = countEvents(db, "owner_input_required");
    const { request, preference } = requestOwnerPreference(db, "which?", a, b);
    const after = countEvents(db, "owner_input_required");

    expect(after - before).toBe(1);
    expect(preference.reason).toContain(request.id);

    const row = db
      .query<{ a_id: string; b_id: string; kind: string }, [string]>(
        "SELECT json_extract(payload, '$.candidate_a.id') AS a_id, json_extract(payload, '$.candidate_b.id') AS b_id, json_extract(payload, '$.input_kind') AS kind FROM events WHERE id = ?",
      )
      .get(request.id)!;
    expect(row.a_id).toBe("good1");
    expect(row.b_id).toBe("good2");
    expect(row.kind).toBe("pairwise_preference");
  });
});

describe("structuralComparator", () => {
  it("picks the lower-residual candidate", () => {
    const clean = cand("clean", cleanClaims("clean")); // residual 0
    const slop = cand("slop", slopClaims("slop")); // residual ~0.5
    const out = structuralComparator("task", slop, clean);
    expect(out.winner_id).toBe("clean");
    expect(out.confidence).toBeGreaterThan(0);
    expect(out.rationale).toContain("lower provenance residual");
  });

  it("tie on residual -> tie-break by more grounded inputs, low confidence", () => {
    // both residual 0; give `a` more grounded inputs.
    const aClaims: NumericClaim[] = [
      {
        id: "a-c1",
        expression: "x + y",
        result: 3,
        inputs: [
          { label: "x", value: 1, source_uri: "s" },
          { label: "y", value: 2, source_uri: "s" },
        ],
      },
    ];
    const bClaims: NumericClaim[] = [
      {
        id: "b-c1",
        expression: "z + 1",
        result: 2,
        inputs: [{ label: "z", value: 1, source_uri: "s" }, { label: "1", value: 1, source_uri: "s" }],
      },
    ];
    // a has 2 grounded, b has 2 grounded -> total tie -> incumbent wins.
    const tie = structuralComparator("t", cand("a", aClaims), cand("b", bClaims));
    expect(tie.winner_id).toBe("a");
    expect(tie.confidence).toBe(0);
  });
});

describe("buildSubstrateDeps + generateAndSelect (end to end on real db)", () => {
  it("filters slop, selects survivor, records one outcome to the stream", async () => {
    const db = openDb(":memory:");
    const good1 = cand("good1", cleanClaims("good1"));
    const good2 = cand("good2", cleanClaims("good2"));
    const slop = cand("slop", slopClaims("slop"));

    const deps = buildSubstrateDeps<Report>(db, {
      task: "summarize the 10-K",
      generators: [async () => [good1, good2, slop]],
    });

    const before = countActTuplesByVerifierKind(db, GENERATE_SELECT_VERIFIER_KIND);
    const out = await generateAndSelect("summarize the 10-K", deps);
    const after = countActTuplesByVerifierKind(db, GENERATE_SELECT_VERIFIER_KIND);

    expect(out.filtered_out.map((f) => f.id)).toContain("slop");
    expect(out.selected?.id).not.toBe("slop");
    expect(after - before).toBe(1);
  });
});
