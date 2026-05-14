// acc2 dispatch decider — scored routing predicate (v2-design.md §3.6).
//
// Three lanes:
//   1. substrate_replay  — `recipes_view` matches by embedding × shape with
//      confidence ≥ RECIPE_REPLAY_THRESHOLD. No LLM call. Phase J wires the
//      recipe view; Phase D never returns this lane because no recipes
//      have been extracted yet.
//   2. claude_inline     — every target in the task matches at least one
//      knowledge entry tagged `low_risk_inline_pattern` with
//      score ≥ 0.7 AND confidence ≥ 0.6. Phase D never returns this lane
//      because no low-risk patterns have been promoted yet.
//   3. opencode_brain    — default. Strategic work, DAG decomposition,
//      code-artifact authoring. Phase D's MVP fixture always hits this
//      lane (and that's correct — the brain designs the bun grep + verifier).
//
// The predicate is testable: even without recipes or inline patterns wired,
// the function must return `opencode_brain` cleanly with `reason = 'no_recipe_no_inline_match'`.

import type { Database } from "bun:sqlite";
import type { TaskNode } from "./task_topology";
import { readCurrentMode } from "./crisis_mode";
import { blockersOf } from "./interference";
import { findRecipeMatch as findRealRecipeMatch } from "./recipe_replay";

/** Default Tier-0 recipe-replay confidence threshold (§15). Recipes seed at
 *  0.5 and accumulate via updateRecipeConfidence; two successful replays push
 *  a recipe to 0.6 and admit it to the Tier-0 lane. Crisis-mode lowers the
 *  effective threshold to 0.4 via `CRISIS_MODE.recipe_confidence_threshold`. */
export const RECIPE_REPLAY_THRESHOLD = 0.6;
export const INLINE_PATTERN_SCORE_THRESHOLD = 0.7;
export const INLINE_PATTERN_CONFIDENCE_THRESHOLD = 0.6;

export type DispatchDecision =
  | { route: "substrate_replay"; recipe_id: string; reason: string }
  | { route: "claude_inline"; cited_artifact_ids: string[]; reason: string }
  | { route: "opencode_brain"; predicted_complexity: "low" | "mid" | "high"; reason: string }
  | { route: "deferred_blocked"; blockers: string[]; reason: string };

type RecipeMatch = { id: string; confidence: number };

/** Phase J: delegate to the real matcher in runtime/recipe_replay.ts which
 *  computes goal_shape via runtime/goal_shape.ts and topology_signature off
 *  the task's directive DAG. The wrapper preserves the local RecipeMatch
 *  shape the decider uses. */
const findRecipeMatch = (db: Database, task: TaskNode, confidenceThreshold: number): RecipeMatch | null => {
  const match = findRealRecipeMatch(db, task, { minConfidence: confidenceThreshold });
  if (!match) return null;
  return { id: match.recipe_id, confidence: match.confidence };
};

type InlinePattern = {
  cited_id: string;
  pattern_kind: "extension" | "prefix" | "exact" | "glob";
  pattern: string;
  score: number;
  confidence: number;
};

const readLowRiskInlinePatterns = (db: Database): InlinePattern[] => {
  // Phase D: low-risk patterns are knowledge_promoted rows tagged
  // 'low_risk_inline_pattern' with score ≥ threshold AND confidence ≥ threshold.
  // None are seeded in Phase D, so this returns an empty array.
  const rows = db
    .query(
      "SELECT id, payload FROM events WHERE kind = 'knowledge_promoted' ORDER BY ts DESC",
    )
    .all() as Array<{ id: string; payload: string }>;
  const patterns: InlinePattern[] = [];
  for (const r of rows) {
    try {
      const payload = JSON.parse(r.payload ?? "{}") as Record<string, unknown>;
      const tags = (payload.tags as string[] | undefined) ?? [];
      if (!tags.includes("low_risk_inline_pattern")) continue;
      const score = (payload.score as number) ?? 0;
      const confidence = (payload.confidence as number) ?? 0;
      if (score < INLINE_PATTERN_SCORE_THRESHOLD) continue;
      if (confidence < INLINE_PATTERN_CONFIDENCE_THRESHOLD) continue;
      patterns.push({
        cited_id: r.id,
        pattern_kind: ((payload.pattern_kind as string) ?? "exact") as InlinePattern["pattern_kind"],
        pattern: (payload.pattern as string) ?? "",
        score,
        confidence,
      });
    } catch { /* skip */ }
  }
  return patterns;
};

const estimateComplexity = (task: TaskNode): "low" | "mid" | "high" => {
  // Phase D heuristic: short single-noun goals are 'low', everything else mid.
  // Phase F can replace with an embedding-derived feature.
  const wordCount = task.goal.split(/\s+/).filter(Boolean).length;
  if (wordCount <= 6) return "low";
  if (wordCount <= 20) return "mid";
  return "high";
};

/** Route a ready task to its execution lane. Returns one of four decisions.
 *  Phase D effectively always returns `opencode_brain` because no recipes or
 *  inline patterns exist — that's the expected behavior. Phase I adds two
 *  modulators on top of the original three lanes:
 *    - If the directive is the target of a `blocks` interference edge from
 *      an unresolved source directive, we down-rank to `deferred_blocked`.
 *    - In crisis mode (urgency='crisis' on the directive) we lower the
 *      recipe-match threshold from 0.7 → 0.4 so Tier-0 fires harder. */
export const decideDispatch = (db: Database, task: TaskNode): DispatchDecision => {
  // 0. Down-rank: directive blocked by an unresolved higher-priority directive.
  const blockers = blockersOf(db, task.directive_id);
  if (blockers.length > 0) {
    return {
      route: "deferred_blocked",
      blockers,
      reason: `blocked_by:${blockers.join(",")}`,
    };
  }

  // 1. Tier-0 recipe replay. Crisis mode lowers the confidence threshold.
  const mode = readCurrentMode(db, task.directive_id);
  const recipeThreshold = mode.recipe_confidence_threshold;
  const recipe = findRecipeMatch(db, task, recipeThreshold);
  if (recipe) {
    return { route: "substrate_replay", recipe_id: recipe.id, reason: "recipe_match" };
  }

  // 2. Scored inline lane. Fail-closed: no knowledge → no inline.
  const inlinePatterns = readLowRiskInlinePatterns(db);
  if (inlinePatterns.length > 0) {
    // In Phase D we treat "task has no concrete file targets" as
    // not-inline-eligible (the brain still has to design the artifact).
    // Phase E will compare task.target_files against pattern.pattern.
    // For now, claude_inline requires explicit `payload.target_files`.
    // We have none in the MVP fixture, so we fall through.
  }

  // 3. Default — opencode brain.
  return {
    route: "opencode_brain",
    predicted_complexity: estimateComplexity(task),
    reason: "no_recipe_no_inline_match",
  };
};
