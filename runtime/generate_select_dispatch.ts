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
//   2. classifyTask(directiveText).route === "ambiguous".
// When both hold it runs `solveTask` with the LIVE LLM generator
// (generateCandidates) + substrate adapters (buildSubstrateDeps), which record
// the organism's outcome to the experience stream as ONE act_tuple_recorded
// envelope. It returns `{ handled: true, result }`. The dispatcher decides what
// to do with `handled` (complete the task lifecycle and skip the brain lane).
//
// The generator and dep-builder are injectable so tests can stub them without
// any network/LLM contact; production passes neither and gets the live wiring.

import type { Database } from "bun:sqlite";
import { classifyTask } from "./task_route";
import { solveTask, type SolveResult } from "./solve_loop";
import { generateCandidates } from "./llm_generate";
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

// Test/override seams. Production leaves both undefined and gets the live
// LLM generator + substrate adapters.
export type GenerateSelectDispatchDeps = {
  // Diversity engine. Defaults to the live OpenAI verbalized-sampling generator.
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
 * Env-gated, additive entry to the generate-and-select organism.
 *
 * Returns `{ handled: false }` (zero side effects) when the flag is unset OR
 * the directive does not classify as `ambiguous`. Otherwise runs solveTask
 * with the live (or injected) generator + substrate deps, records the outcome,
 * and returns `{ handled: true, result }`.
 */
export async function maybeRunGenerateSelect(
  db: Database,
  directiveText: string,
  ctx: GenerateSelectDispatchCtx = {},
  deps: GenerateSelectDispatchDeps = {},
): Promise<MaybeRunGenerateSelectResult> {
  // Gate 1 — the env flag. Default-OFF: behavior is byte-identical to today.
  if (process.env.ACC2_GENERATE_SELECT !== "1") return { handled: false };

  // Gate 2 — only ambiguous (subjective-quality) directives route here.
  // Verifiable directives stay on the default lane untouched.
  if (classifyTask(directiveText).route !== "ambiguous") return { handled: false };

  const generate =
    deps.generate ?? ((task: string, n: number) => generateCandidates(task, n));
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
