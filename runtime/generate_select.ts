// Phase 2 of the "generate-and-select" architecture: the orchestration loop.
//
// Generate diverse candidates -> provenance-filter the slop -> pairwise
// compare the survivors -> spend a sparse owner preference only when the top
// two are close (or stakes are high) -> always record the outcome to the
// experience stream.
//
// This module is pure and dependency-injected: it performs NO DB, network, or
// LLM work itself. Every external behavior (generation, comparison, owner
// contact, outcome recording) is supplied by the caller via `deps`, so the
// loop is unit-testable without any of those substrates. The only concrete
// dependency is the deterministic, taste-free provenance verifier from Phase 1.

import {
  verifyClaimProvenance,
  type NumericClaim,
} from "./claim_provenance_verifier";

export type Candidate<T> = {
  id: string;
  artifact: T;
  claims: NumericClaim[];
  generator: string;
};

export type Preference = { winner_id: string; reason: string };

export type ComparisonResult = {
  winner_id: string;
  confidence: number;
  rationale: string;
};

// One recorded pairwise comparison in the king-of-the-hill ladder.
export type Comparison = {
  a_id: string;
  b_id: string;
  winner_id: string;
  confidence: number;
  rationale: string;
};

export type GenerateSelectDeps<T> = {
  // Diversity engine: cross-model / verbalized-sampling generators, injected.
  generators: ((task: string) => Promise<Candidate<T>[]>)[];
  // Pairwise comparator (NOT absolute scoring).
  comparator: (
    task: string,
    a: Candidate<T>,
    b: Candidate<T>,
  ) => Promise<ComparisonResult>;
  // Sparse human contact; the caller emits owner_input_required upstream.
  requestOwnerPreference?: (
    task: string,
    a: Candidate<T>,
    b: Candidate<T>,
  ) => Promise<Preference>;
  // Append to the experience stream (act_tuple upstream). Always invoked.
  recordOutcome: (outcome: SelectOutcome<T>) => void;
  // Provenance residual at/above which a candidate is dropped. Default 0.3.
  filterThreshold?: number;
  // Confidence gap below which the top-2 are "close" -> spend a preference.
  // Default 0.15.
  closeMargin?: number;
  highStakes?: boolean;
};

export type SelectOutcome<T> = {
  selected: Candidate<T> | null;
  filtered_out: { id: string; residual: number }[];
  comparisons: Comparison[];
  preference_used: Preference | null;
  reason: string;
};

const DEFAULT_FILTER_THRESHOLD = 0.3;
const DEFAULT_CLOSE_MARGIN = 0.15;

export async function generateAndSelect<T>(
  task: string,
  deps: GenerateSelectDeps<T>,
): Promise<SelectOutcome<T>> {
  const filterThreshold = deps.filterThreshold ?? DEFAULT_FILTER_THRESHOLD;
  const closeMargin = deps.closeMargin ?? DEFAULT_CLOSE_MARGIN;

  // (1) Gather candidates from all generators.
  const generated = await Promise.all(deps.generators.map((g) => g(task)));
  const candidates: Candidate<T>[] = generated.flat();

  // (2) FILTER: deterministic provenance check; drop residual >= threshold.
  const filtered_out: { id: string; residual: number }[] = [];
  const survivors: Candidate<T>[] = [];
  for (const candidate of candidates) {
    const { residual } = verifyClaimProvenance(candidate.claims);
    if (residual >= filterThreshold) {
      filtered_out.push({ id: candidate.id, residual });
    } else {
      survivors.push(candidate);
    }
  }

  const finish = (
    selected: Candidate<T> | null,
    comparisons: Comparison[],
    preference_used: Preference | null,
    reason: string,
  ): SelectOutcome<T> => {
    const outcome: SelectOutcome<T> = {
      selected,
      filtered_out,
      comparisons,
      preference_used,
      reason,
    };
    // (6) Always record the outcome (grounded reward to the experience stream).
    deps.recordOutcome(outcome);
    return outcome;
  };

  // (3) Degenerate cases.
  if (survivors.length === 0) {
    return finish(null, [], null, "all_candidates_failed_provenance");
  }
  if (survivors.length === 1) {
    return finish(survivors[0], [], null, "sole_survivor");
  }

  // (4) Pairwise king-of-the-hill: the reigning champion faces each challenger.
  // The last comparison's confidence is the gap that tells us how decisively
  // the final champion was chosen over its closest contender.
  const comparisons: Comparison[] = [];
  let champion = survivors[0];
  let lastConfidence = 1;
  for (let i = 1; i < survivors.length; i++) {
    const challenger = survivors[i];
    const result = await deps.comparator(task, champion, challenger);
    comparisons.push({
      a_id: champion.id,
      b_id: challenger.id,
      winner_id: result.winner_id,
      confidence: result.confidence,
      rationale: result.rationale,
    });
    lastConfidence = result.confidence;
    if (result.winner_id === challenger.id) {
      champion = challenger;
    }
  }

  // The confidence of the deciding bout is the proxy for the top-2 gap: a low
  // confidence means the runner-up was nearly as good (a "close" call).
  const isClose = lastConfidence < closeMargin;

  // (5) Spend a sparse owner preference only when close or high-stakes.
  if ((isClose || deps.highStakes === true) && deps.requestOwnerPreference) {
    // The closest contender is the loser of the deciding bout.
    const decider = comparisons[comparisons.length - 1];
    const runnerUpId =
      decider.winner_id === champion.id ? decider.a_id : decider.b_id;
    const runnerUp =
      survivors.find((c) => c.id === runnerUpId) ?? survivors[0];
    const preference = await deps.requestOwnerPreference(
      task,
      champion,
      runnerUp,
    );
    const ownerWinner =
      survivors.find((c) => c.id === preference.winner_id) ?? champion;
    return finish(
      ownerWinner,
      comparisons,
      preference,
      "owner_preference",
    );
  }

  return finish(champion, comparisons, null, "comparator_winner");
}
