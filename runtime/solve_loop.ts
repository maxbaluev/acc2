// Phase 6 of the "generate-and-select" architecture: the UNIFIED ORGANISM
// LOOP. The five existing modules are deliberately small and orthogonal —
// a router, a world-model predictor, the generate-and-select loop, the
// substrate adapters, and the deterministic provenance verifier. This
// module is the single elegant spine that ties them into ONE universal
// entry point.
//
// The loop, in one breath:
//   classify -> if verifiable, just verify ONE candidate (cheap, objective);
//   if ambiguous, ask the world model whether the cheap prediction can be
//   trusted. If it can, take the FAST PATH (one candidate, provenance-filter,
//   record). If it cannot, spend the FULL generate-and-select loop (N diverse
//   candidates, provenance filter -> pairwise compare -> sparse owner
//   preference -> record).
//
// Pure / dependency-injected: no DB, network, LLM, or daemon inside the core.
// `generate` is the injected diversity engine; `retrieveSimilar` is the
// injected experience-stream reader; the comparator / owner-preference /
// record deps default to the structural/substrate adapters but can be
// overridden for tests or for an LLM-backed comparator. This is the falsifiable
// test of the design: the whole spine runs without any substrate present.

import { classifyTask, type TaskRoute } from "./task_route";
import {
  predictOutcome,
  shouldSpendFullLoop,
  type PastOutcome,
  type Prediction,
} from "./experience_predictor";
import {
  generateAndSelect,
  type Candidate,
  type ComparisonResult,
  type GenerateSelectDeps,
  type Preference,
  type SelectOutcome,
} from "./generate_select";
import { structuralComparator } from "./generate_select_adapters";
import { verifyClaimProvenance } from "./claim_provenance_verifier";

// Provenance residual at/above which a candidate is dropped. Mirrors the
// generate_select default and the 0.3 closure bar.
const PROVENANCE_THRESHOLD = 0.3;
// How many diverse candidates the full path requests.
const FULL_PATH_N = 3;

export type SolveDeps<T> = {
  // Diversity engine: verbalized sampling / cross-model generation. Asked for
  // `n` candidates for `task`. Injected — this is the only LLM seam.
  generate: (task: string, n: number) => Promise<Candidate<T>[]>;
  // Experience-stream reader for the world-model prediction.
  retrieveSimilar: (task: string, k: number) => Promise<PastOutcome[]>;
  // Optional overrides for the full generate-and-select path. Default to the
  // structural comparator; owner-preference / record default to no-ops here
  // (the substrate adapters supply real ones when a DB is present).
  comparator?: (
    task: string,
    a: Candidate<T>,
    b: Candidate<T>,
  ) => Promise<ComparisonResult>;
  requestOwnerPreference?: (
    task: string,
    a: Candidate<T>,
    b: Candidate<T>,
  ) => Promise<Preference>;
  recordOutcome?: (outcome: SelectOutcome<T>) => void;
  highStakes?: boolean;
};

export type SolvePath = "deterministic" | "fast" | "full";

export type SolveResult<T> = {
  route: TaskRoute;
  path: SolvePath;
  selected: Candidate<T> | null;
  prediction?: Prediction;
  selectOutcome?: SelectOutcome<T>;
  reason: string;
};

// Provenance-filter a single candidate: it survives iff its claims score
// below the 0.3 bar. Shared by the deterministic and fast paths.
const passesProvenance = <T>(candidate: Candidate<T>): boolean =>
  verifyClaimProvenance(candidate.claims).residual < PROVENANCE_THRESHOLD;

// Build a one-candidate SelectOutcome so the fast path records through the
// same recordOutcome shape the full path uses (one experience-stream row).
const singleOutcome = <T>(
  candidate: Candidate<T> | null,
  filtered: { id: string; residual: number }[],
  reason: string,
): SelectOutcome<T> => ({
  selected: candidate,
  filtered_out: filtered,
  comparisons: [],
  preference_used: null,
  reason,
});

export async function solveTask<T>(
  task: string,
  deps: SolveDeps<T>,
): Promise<SolveResult<T>> {
  const routing = classifyTask(task);

  // ── (2) VERIFIABLE: deterministic verifier only. ────────────────────
  // There is a ground truth, so spend no candidate budget and no contact:
  // generate ONE candidate and accept it iff its provenance residual clears
  // the bar.
  if (routing.route === "verifiable") {
    const [candidate] = await deps.generate(task, 1);
    if (!candidate) {
      return {
        route: "verifiable",
        path: "deterministic",
        selected: null,
        reason: "verifiable: generator produced no candidate",
      };
    }
    const { residual } = verifyClaimProvenance(candidate.claims);
    const ok = residual < PROVENANCE_THRESHOLD;
    return {
      route: "verifiable",
      path: "deterministic",
      selected: ok ? candidate : null,
      reason: ok
        ? `verifiable: provenance ok (residual ${residual.toFixed(3)} < ${PROVENANCE_THRESHOLD})`
        : `verifiable: provenance failed (residual ${residual.toFixed(3)} >= ${PROVENANCE_THRESHOLD})`,
    };
  }

  // ── (3) AMBIGUOUS: ask the world model whether to spend the full loop. ──
  const prediction = await predictOutcome(task, {
    retrieveSimilar: deps.retrieveSimilar,
  });
  const spend = shouldSpendFullLoop(prediction);

  // ── (3a) FAST PATH: the cheap prediction is confident-good — trust it. ──
  // Generate ONE candidate, provenance-filter it, record the outcome.
  if (!spend.spend) {
    const [candidate] = await deps.generate(task, 1);
    const ok = candidate ? passesProvenance(candidate) : false;
    const selected = ok ? candidate : null;
    const filtered =
      candidate && !ok
        ? [{ id: candidate.id, residual: verifyClaimProvenance(candidate.claims).residual }]
        : [];
    const reason = `fast_path: ${spend.reason}`;
    const outcome = singleOutcome(selected, filtered, reason);
    deps.recordOutcome?.(outcome);
    return {
      route: "ambiguous",
      path: "fast",
      selected,
      prediction,
      selectOutcome: outcome,
      reason,
    };
  }

  // ── (3b) FULL PATH: the prediction cannot be trusted — spend the loop. ──
  // N diverse candidates -> provenance filter -> pairwise compare -> sparse
  // owner preference -> record. We hand generate_select a single generator
  // closure that asks the diversity engine for N candidates.
  const gsDeps: GenerateSelectDeps<T> = {
    generators: [(t: string) => deps.generate(t, FULL_PATH_N)],
    comparator:
      deps.comparator ?? (async (t, a, b) => structuralComparator(t, a, b)),
    requestOwnerPreference: deps.requestOwnerPreference,
    recordOutcome: deps.recordOutcome ?? (() => {}),
    filterThreshold: PROVENANCE_THRESHOLD,
    highStakes: deps.highStakes,
  };
  const selectOutcome = await generateAndSelect(task, gsDeps);
  return {
    route: "ambiguous",
    path: "full",
    selected: selectOutcome.selected,
    prediction,
    selectOutcome,
    reason: `full_path: ${spend.reason}; select=${selectOutcome.reason}`,
  };
}
