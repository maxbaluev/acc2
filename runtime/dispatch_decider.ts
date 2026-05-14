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
import { lowRiskInlinePatterns, type LowRiskInlinePatternRow } from "../substrate/views";

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
  // Phase Audit: route through `low_risk_inline_patterns_view` (the SQL
  // view scoped by tag + score + confidence) so dispatch_decider and the
  // MCP `substrate.read` surface share one source of truth (§3.6). The
  // accessor handles missing views gracefully — if `runViews(db)` has not
  // been called the catch returns [], which keeps the decider fail-closed.
  try {
    const rows = lowRiskInlinePatterns(db);
    return rows.map((r): InlinePattern => ({
      cited_id: r.cited_id,
      pattern_kind: r.pattern_kind,
      pattern: r.pattern,
      score: r.score,
      confidence: r.confidence,
    }));
  } catch {
    return [];
  }
};

/** Match a target string against one of the four pattern kinds. */
const matchPattern = (target: string, p: InlinePattern): boolean => {
  switch (p.pattern_kind) {
    case "extension":
      return target.endsWith(p.pattern);
    case "prefix":
      return target.startsWith(p.pattern);
    case "exact":
      return target === p.pattern;
    case "glob": {
      // Minimal glob: `*` → `.*`, escape other regex metacharacters.
      const re = new RegExp(
        "^" + p.pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$",
      );
      return re.test(target);
    }
    default:
      return false;
  }
};

/** Return the set of patterns the task's targets match. Empty array means
 *  no inline lane. A target = each entry in `task.target_files` (added by
 *  callers when known) OR `task.goal` token-fallback. The decider rejects
 *  inline unless EVERY target matches at least one pattern. */
const inlineMatchingPatterns = (
  task: TaskNode & { target_files?: string[] },
  patterns: InlinePattern[],
): InlinePattern[] | null => {
  if (patterns.length === 0) return null;
  const targets = (task.target_files && task.target_files.length > 0)
    ? task.target_files
    : []; // no concrete targets → not eligible (fail-closed)
  if (targets.length === 0) return null;
  const matched: InlinePattern[] = [];
  for (const t of targets) {
    const hit = patterns.find((p) => matchPattern(t, p));
    if (!hit) return null; // ANY mismatch disqualifies the entire task
    matched.push(hit);
  }
  return matched;
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
/** Credit the inspiring `knowledge_promoted` row for an inline-lane outcome
 *  (k_555 four-link chain — create → retrieve → mutate → credit). Emits a
 *  `candidate_confirmed` (success) or `candidate_contradicted` (failure)
 *  event citing the promotion id; the existing knowledge extractor consumes
 *  these and recomputes the Beta posterior so the inline-vs-delegate
 *  selector adapts to outcomes. v2-design.md §3.6, k_252 "advisory=fake"
 *  remediated by structural credit emission. */
export const recordLowRiskInlineOutcome = (
  db: Database,
  knowledgeId: string,
  outcome: "success" | "failure",
  ts?: string,
): void => {
  // Lazy import to avoid a circular: emit lives in runtime/events.ts and
  // the dispatch_decider is imported by the MCP server which also imports
  // events.ts. Static import is fine; we keep the call here so any caller
  // (Father, dispatcher, tests) can credit uniformly.
  const { emitEvent } = require("./events") as typeof import("./events");
  emitEvent(db, {
    kind: outcome === "success" ? "candidate_confirmed" : "candidate_contradicted",
    substrate_origin: "substrate_auto",
    context_refs: [knowledgeId],
    payload: {
      knowledge_id: knowledgeId,
      outcome,
      ts: ts ?? new Date().toISOString(),
      source: "low_risk_inline_lane",
    },
  });
};

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
  const matched = inlineMatchingPatterns(task as TaskNode & { target_files?: string[] }, inlinePatterns);
  if (matched && matched.length > 0) {
    return {
      route: "claude_inline",
      cited_artifact_ids: matched.map((m) => m.cited_id),
      reason: "scored_inline_lane",
    };
  }

  // 3. Default — opencode brain.
  return {
    route: "opencode_brain",
    predicted_complexity: estimateComplexity(task),
    reason: "no_recipe_no_inline_match",
  };
};
