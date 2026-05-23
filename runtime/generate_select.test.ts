import { describe, expect, it, mock } from "bun:test";
import {
  generateAndSelect,
  type Candidate,
  type ComparisonResult,
  type GenerateSelectDeps,
  type Preference,
  type SelectOutcome,
} from "./generate_select";
import type { NumericClaim } from "./claim_provenance_verifier";

type Report = { headline: string };

// A clean claim: every input is grounded in a real source.
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

// A slop claim: an invented, unsourced multiplier feeds the headline.
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

const cand = (
  id: string,
  claims: NumericClaim[],
): Candidate<Report> => ({
  id,
  artifact: { headline: id },
  claims,
  generator: "gen",
});

const gen =
  (...cs: Candidate<Report>[]) =>
  async (): Promise<Candidate<Report>[]> =>
    cs;

describe("generateAndSelect", () => {
  it("1: provenance filter prunes slop", async () => {
    const good1 = cand("good1", cleanClaims("good1"));
    const good2 = cand("good2", cleanClaims("good2"));
    const slop = cand("slop", slopClaims("slop"));
    const recordOutcome = mock((_: SelectOutcome<Report>) => {});
    const deps: GenerateSelectDeps<Report> = {
      generators: [gen(good1, good2, slop)],
      comparator: async (_t, a): Promise<ComparisonResult> => ({
        winner_id: a.id,
        confidence: 0.9,
        rationale: "a wins clearly",
      }),
      recordOutcome,
    };

    const out = await generateAndSelect("task", deps);

    expect(out.filtered_out.map((f) => f.id)).toContain("slop");
    expect(out.filtered_out.find((f) => f.id === "slop")!.residual).toBeGreaterThanOrEqual(0.3);
    expect(out.selected?.id).not.toBe("slop");
    expect(recordOutcome).toHaveBeenCalledTimes(1);
  });

  it("2: close candidates spend a preference", async () => {
    const good1 = cand("good1", cleanClaims("good1"));
    const good2 = cand("good2", cleanClaims("good2"));
    const requestOwnerPreference = mock(
      async (): Promise<Preference> => ({
        winner_id: "good2",
        reason: "owner prefers good2",
      }),
    );
    const recordOutcome = mock((_: SelectOutcome<Report>) => {});
    const deps: GenerateSelectDeps<Report> = {
      generators: [gen(good1, good2)],
      comparator: async (_t, a): Promise<ComparisonResult> => ({
        winner_id: a.id,
        confidence: 0.05, // gap < closeMargin (0.15) -> close
        rationale: "barely",
      }),
      requestOwnerPreference,
      recordOutcome,
    };

    const out = await generateAndSelect("task", deps);

    expect(requestOwnerPreference).toHaveBeenCalledTimes(1);
    expect(out.preference_used).toEqual({
      winner_id: "good2",
      reason: "owner prefers good2",
    });
    expect(out.selected?.id).toBe("good2");
    expect(out.reason).toBe("owner_preference");
    expect(recordOutcome).toHaveBeenCalledTimes(1);
  });

  it("3: clear winner needs no preference", async () => {
    const good1 = cand("good1", cleanClaims("good1"));
    const good2 = cand("good2", cleanClaims("good2"));
    const requestOwnerPreference = mock(
      async (): Promise<Preference> => ({ winner_id: "good2", reason: "x" }),
    );
    const recordOutcome = mock((_: SelectOutcome<Report>) => {});
    const deps: GenerateSelectDeps<Report> = {
      generators: [gen(good1, good2)],
      comparator: async (_t, a): Promise<ComparisonResult> => ({
        winner_id: a.id,
        confidence: 0.9, // large gap -> not close
        rationale: "decisive",
      }),
      requestOwnerPreference,
      recordOutcome,
    };

    const out = await generateAndSelect("task", deps);

    expect(requestOwnerPreference).not.toHaveBeenCalled();
    expect(out.preference_used).toBeNull();
    expect(out.selected?.id).toBe("good1");
    expect(out.reason).toBe("comparator_winner");
    expect(recordOutcome).toHaveBeenCalledTimes(1);
  });

  it("4: all fail provenance -> null selection", async () => {
    const slop1 = cand("slop1", slopClaims("slop1"));
    const slop2 = cand("slop2", slopClaims("slop2"));
    const recordOutcome = mock((_: SelectOutcome<Report>) => {});
    const deps: GenerateSelectDeps<Report> = {
      generators: [gen(slop1, slop2)],
      comparator: async (_t, a): Promise<ComparisonResult> => ({
        winner_id: a.id,
        confidence: 0.9,
        rationale: "n/a",
      }),
      recordOutcome,
    };

    const out = await generateAndSelect("task", deps);

    expect(out.selected).toBeNull();
    expect(out.reason).toBe("all_candidates_failed_provenance");
    expect(out.filtered_out).toHaveLength(2);
    expect(recordOutcome).toHaveBeenCalledTimes(1);
  });

  it("5: recordOutcome called exactly once for sole survivor too", async () => {
    const good1 = cand("good1", cleanClaims("good1"));
    const slop = cand("slop", slopClaims("slop"));
    const recordOutcome = mock((_: SelectOutcome<Report>) => {});
    const deps: GenerateSelectDeps<Report> = {
      generators: [gen(good1, slop)],
      comparator: async (_t, a): Promise<ComparisonResult> => ({
        winner_id: a.id,
        confidence: 0.9,
        rationale: "n/a",
      }),
      recordOutcome,
    };

    const out = await generateAndSelect("task", deps);

    expect(out.selected?.id).toBe("good1");
    expect(out.reason).toBe("sole_survivor");
    expect(recordOutcome).toHaveBeenCalledTimes(1);
  });
});
