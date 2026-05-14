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

export const RECIPE_REPLAY_THRESHOLD = 0.7;
export const INLINE_PATTERN_SCORE_THRESHOLD = 0.7;
export const INLINE_PATTERN_CONFIDENCE_THRESHOLD = 0.6;

export type DispatchDecision =
  | { route: "substrate_replay"; recipe_id: string; reason: string }
  | { route: "claude_inline"; cited_artifact_ids: string[]; reason: string }
  | { route: "opencode_brain"; predicted_complexity: "low" | "mid" | "high"; reason: string };

type RecipeMatch = { id: string; confidence: number };

const findRecipeMatch = (db: Database, task: TaskNode): RecipeMatch | null => {
  // Phase D: recipes_view doesn't exist yet. We look for `recipe_extracted`
  // events whose payload.goal_embedding_match flag is set true for this task.
  // None are emitted in Phase D, so this returns null — the test asserts that.
  const rows = db
    .query(
      "SELECT id, payload FROM events WHERE kind = 'recipe_extracted' ORDER BY ts DESC LIMIT 20",
    )
    .all() as Array<{ id: string; payload: string }>;
  for (const r of rows) {
    try {
      const payload = JSON.parse(r.payload ?? "{}") as Record<string, unknown>;
      const confidence = (payload.confidence as number) ?? 0;
      const goalShape = (payload.goal_shape as string | undefined) ?? "";
      // Cheap shape match — does the recipe's goal_shape token appear in the
      // task goal? Phase J replaces with embedding cosine.
      if (goalShape && task.goal.toLowerCase().includes(goalShape.toLowerCase())) {
        if (confidence >= RECIPE_REPLAY_THRESHOLD) {
          return { id: r.id, confidence };
        }
      }
    } catch { /* skip */ }
  }
  return null;
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

/** Route a ready task to its execution lane. Returns one of three decisions.
 *  Phase D effectively always returns `opencode_brain` because no recipes or
 *  inline patterns exist — that's the expected behavior. */
export const decideDispatch = (db: Database, task: TaskNode): DispatchDecision => {
  // 1. Tier-0 recipe replay.
  const recipe = findRecipeMatch(db, task);
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
