// Phase 9 of the "generate-and-select" architecture: the ENV-GATED daemon
// dispatch hook.
//
// This is the single, additive, default-OFF seam that lets the live daemon
// route an AMBIGUOUS directive through the generate-and-select organism
// (solveTask) instead of the default opencode_brain lane. It is deliberately
// isolated in its own module so the dispatcher edit is a few lines and the
// behavior is byte-identical to today whenever the flag is unset.
//
// CONTRACT — `maybeRunGenerateSelect` returns `{ handled: false }` (and does
// NOTHING — no LLM call, no ledger write) UNLESS BOTH:
//   1. process.env.ACC2_GENERATE_SELECT === "1", AND
//   2. an injected `shouldHandle` predicate returns true. This is the
//      RLM-first authorization: there is NO keyword/regex intent classifier
//      in the path. The substrate wires `shouldHandle` from its scored
//      dispatch decision or a posterior-scored predicate; when it is missing
//      or returns false the directive falls through to the brain (cold-start
//      uncertainty is brain-routed, never keyword-guessed). The env flag
//      ALONE never authorizes interception.
// When both hold it runs `solveTask` with the intellect-backed candidate
// generator (wired through `deps.generate`) + substrate adapters
// (buildSubstrateDeps), which record the organism's outcome to the experience
// stream as ONE act_tuple_recorded envelope. It returns `{ handled: true,
// result }`. The dispatcher decides what to do with `handled` (complete the
// task lifecycle and skip the brain lane).
//
// Candidate generation is an ACT performed by the intellect (the opencode
// brain, or Claude Code), NOT a hardcoded OpenAI chat call — OPENAI_API_KEY is
// for EMBEDDINGS ONLY. The generator MUST be wired explicitly through
// `deps.generate`. When it is absent the organism returns `{ handled: false }`
// and the directive falls through to the brain (which generates candidates in
// its normal reasoning). The dep-builder is injectable so tests can stub it.

import type { Database } from "bun:sqlite";
import { solveTask, type SolveResult } from "./solve_loop";
import { buildSubstrateDeps } from "./generate_select_adapters";
import type { Candidate, GenerateSelectDeps, SelectOutcome } from "./generate_select";
import { logger } from "./logger";

// How many diverse candidates the live LLM generator is asked for. The full
// path inside solveTask requests its own FULL_PATH_N; this caps the per-call
// upper bound the adapters' generator closure hands the generate engine.
const LIVE_GENERATE_N_CAP = 5;

export type GenerateSelectDispatchCtx = {
  directiveId?: string;
  taskId?: string;
  substrateOrigin?: string;
};

export type MaybeRunGenerateSelectResult = {
  handled: boolean;
  result?: SolveResult<string>;
};

// Test/override seams. Production leaves these undefined and gets the live
// LLM generator + substrate adapters; the substrate wires `shouldHandle` from
// its scored dispatch decision.
export type GenerateSelectDispatchDeps = {
  // RLM-first interception predicate. The ONLY thing (alongside the env flag)
  // that authorizes the organism to handle a directive instead of the brain.
  // Sourced from the substrate's scored dispatch decision or a posterior-
  // scored predicate. When absent or returning false, the directive falls
  // through to the brain — there is NO keyword/regex classifier in this path.
  shouldHandle?: (directiveText: string, ctx: GenerateSelectDispatchCtx) => boolean;
  // Diversity engine — an ACT performed by the intellect (brain / Claude Code).
  // MUST be wired explicitly; there is NO direct-LLM-API default. When absent
  // the organism falls through to the brain (see maybeRunGenerateSelect).
  generate?: (task: string, n: number) => Promise<Candidate<string>[]>;
  // Builds the GenerateSelectDeps bound to the live DB handle. Defaults to
  // buildSubstrateDeps (structural comparator + owner-preference + recorder).
  buildDeps?: (
    db: Database,
    cfg: {
      task: string;
      generators: ((task: string) => Promise<Candidate<string>[]>)[];
      directiveId?: string;
      taskId?: string;
      substrateOrigin?: string;
    },
  ) => GenerateSelectDeps<string>;
  // Direct recordOutcome override (test-only). When set it replaces the
  // recordOutcome the built deps would use, so a test can assert recording
  // without standing up the act-tuple projection gate.
  recordOutcome?: (outcome: SelectOutcome<string>) => void;
};

/**
 * Env-gated, additive entry to the generate-and-select organism (RLM-first).
 *
 * Returns `{ handled: false }` (zero side effects) when the env flag is unset,
 * the injected `shouldHandle` predicate is missing / returns false, OR no
 * intellect-backed `deps.generate` is wired. There is NO keyword/regex intent
 * classifier here: interception is authorized only by the substrate's scored
 * dispatch decision (wired through `shouldHandle`). When all gates pass it runs
 * solveTask with the wired generator + substrate deps, records the outcome, and
 * returns `{ handled: true, result }`.
 */
export async function maybeRunGenerateSelect(
  db: Database,
  directiveText: string,
  ctx: GenerateSelectDispatchCtx = {},
  deps: GenerateSelectDispatchDeps = {},
): Promise<MaybeRunGenerateSelectResult> {
  // Gate 1 — the env flag. Default-OFF: behavior is byte-identical to today.
  // The env flag ALONE never authorizes interception.
  if (process.env.ACC2_GENERATE_SELECT !== "1") return { handled: false };

  // Gate 2 — RLM-first scored allowance. The organism intercepts only when the
  // substrate's scored dispatch decision (or a posterior-scored predicate),
  // wired through `shouldHandle`, says so. No predicate -> fall through to the
  // brain (fail-closed: cold-start uncertainty is brain-routed, not guessed).
  if (!deps.shouldHandle || !deps.shouldHandle(directiveText, ctx)) {
    return { handled: false };
  }

  // Gate 3 — an intellect-backed generator MUST be wired. Candidate generation
  // is an act performed by the intellect, not a direct-LLM-API call. With no
  // generator the organism falls through to the brain (which generates
  // candidates in its normal reasoning). There is NO fallback generator.
  if (!deps.generate) return { handled: false };
  const generate = deps.generate;
  const buildDeps = deps.buildDeps ?? buildSubstrateDeps;

  try {
    // Assemble the substrate-bound GenerateSelectDeps via the adapters so the
    // organism's outcome is recorded to the experience stream (one act_tuple).
    const built = buildDeps(db, {
      task: directiveText,
      generators: [(t: string) => generate(t, LIVE_GENERATE_N_CAP)],
      directiveId: ctx.directiveId,
      taskId: ctx.taskId,
      substrateOrigin: ctx.substrateOrigin ?? "substrate_auto",
    });
    // Allow a test to observe recording without the full projection gate.
    const recordOutcome = deps.recordOutcome ?? built.recordOutcome;

    const result = await solveTask<string>(directiveText, {
      generate,
      // solveTask reads similar past outcomes for the world-model prediction;
      // an empty stream is the honest default (novel -> spend the full loop).
      retrieveSimilar: async () => [],
      comparator: built.comparator,
      requestOwnerPreference: built.requestOwnerPreference,
      recordOutcome,
    });
    return { handled: true, result };
  } catch (err) {
    // Fail-soft: a generator/adapter exception must NOT crash the dispatch.
    // Report unhandled so the caller falls through to the default brain lane.
    logger.warn(
      {
        where: "generate_select_dispatch.maybeRunGenerateSelect",
        err: (err as Error).message,
        task_id: ctx.taskId,
      },
      "generate-and-select organism threw — falling through to default lane",
    );
    return { handled: false };
  }
}
