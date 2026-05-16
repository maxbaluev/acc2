// acc2 dispatch decider — scored routing predicate (v2-design.md §3.6).
//
// Three lanes:
//   1. substrate_replay  — `recipes_view` matches by embedding × shape with
//      confidence ≥ RECIPE_REPLAY_THRESHOLD. No LLM call. Phase J wires the
//      recipe view; Phase D never returns this lane because no recipes
//      have been extracted yet.
//   2. claude_inline     — every normalized target_resource on the task
//      matches at least one scheme-aware knowledge entry tagged
//      `low_risk_inline_pattern` with score ≥ 0.7 AND confidence ≥ 0.6.
//      Phase D never returns this lane because no low-risk patterns have
//      been promoted yet.
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
import { lowRiskInlinePatterns } from "../substrate/views";
import { parseResourceRefs, resourceMatchesPattern, type ResourceRef } from "./resource_uri";

/** Default Tier-0 recipe-replay confidence threshold (§15). Recipes seed at
 *  0.5 and accumulate via updateRecipeConfidence; SEVEN successful replays
 *  push a recipe to 0.85 (capped at 0.95) and admit it to the Tier-0 lane.
 *  Pre-fix this was 0.6 — combined with the loose goal_shape match in
 *  recipe_replay.ts:findRecipeMatch, fresh recipes (confidence 0.5+0.05·k)
 *  matched almost anything after a single success, replaying the wrong
 *  trajectory against unrelated directives. 0.85 forces real evidence of
 *  reusability. Crisis-mode lowers to 0.7 via
 *  `CRISIS_MODE.recipe_confidence_threshold`. */
export const RECIPE_REPLAY_THRESHOLD = 0.85;
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

/** Return the set of patterns the task's resources match. Empty array means
 *  no inline lane. The decider rejects inline unless EVERY normalized
 *  target_resource matches at least one scheme-aware pattern. */
const inlineMatchingPatterns = (
  task: TaskNode & { target_resources?: string[] },
  patterns: InlinePattern[],
): InlinePattern[] | null => {
  if (patterns.length === 0) return null;
  const targets = parseResourceRefs(task.target_resources);
  if (!targets || targets.length === 0) return null;
  const matched: InlinePattern[] = [];
  for (const t of targets) {
    const hit = patterns.find((p) => resourceMatchesPattern(t as ResourceRef, p.pattern_kind, p.pattern));
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
/** Beta-distribution mean. Mirrors the canonical scorer used by the
 *  knowledge promotion extractor (`substrate/extractors.ts:betaMean`) so
 *  inline-lane refreshes use exactly the same algebra. */
const betaMean = (alpha: number, beta: number): number => alpha / (alpha + beta);

/** Beta-distribution confidence proxy = 1 − 1/√(n+1), where n = α+β−2 is
 *  the evidence count. Matches `substrate/extractors.ts:betaConfidence`
 *  and §11.5; keeping the formula identical here lets a single test prove
 *  the inline view, the dispatcher, and the extractor converge on the
 *  same posterior values. */
const betaConfidence = (alpha: number, beta: number): number => {
  const n = alpha + beta - 2;
  return 1 - 1 / Math.sqrt(Math.max(0, n) + 1);
};

/** Recompute the Beta posterior on the existing `knowledge_promoted` row
 *  for this candidate by counting the live `candidate_confirmed` /
 *  `candidate_contradicted` events that cite it, then stamp the new
 *  alpha/beta/score/confidence onto the promotion payload. The
 *  `low_risk_inline_patterns_view` reads the payload directly, so this
 *  refresh is what makes the inline lane adapt to outcomes (Batch 4 Hole 3).
 *
 *  The `knowledgeId` is the id of the `knowledge_promoted` event surfaced
 *  by the view (`cited_id`). Internally that event cites the original
 *  `knowledge_candidate` row via `context_refs[0]`; the verdicts cite the
 *  candidate id. We resolve both directions so callers can pass either id. */
const refreshInlinePatternPosterior = (db: Database, knowledgeId: string): void => {
  // Locate the promotion row. The view's `cited_id` IS the
  // `knowledge_promoted` event id, so callers normally pass that. If the
  // caller passed a candidate id, fall back to the promotion that cites it.
  let promotion = db
    .query(
      `SELECT id, payload, context_refs FROM events
       WHERE kind = 'knowledge_promoted' AND id = ? LIMIT 1`,
    )
    .get(knowledgeId) as { id: string; payload: string; context_refs: string } | null;
  if (!promotion) {
    promotion = db
      .query(
        `SELECT id, payload, context_refs FROM events
         WHERE kind = 'knowledge_promoted'
           AND context_refs LIKE '%"' || ? || '"%'
         ORDER BY ts DESC LIMIT 1`,
      )
      .get(knowledgeId) as { id: string; payload: string; context_refs: string } | null;
  }
  if (!promotion) return;

  // Resolve the candidate id: payload.candidate_id wins, otherwise the first
  // context_ref. Knowledge verdicts cite the candidate (matches what
  // `extractKnowledgePromotions` counts).
  let candidateId: string | null = null;
  try {
    const parsedPayload = JSON.parse(promotion.payload ?? "{}") as Record<string, unknown>;
    if (typeof parsedPayload.candidate_id === "string") {
      candidateId = parsedPayload.candidate_id;
    }
  } catch { /* fall through */ }
  if (!candidateId) {
    try {
      const refs = JSON.parse(promotion.context_refs ?? "[]") as string[];
      if (refs.length > 0) candidateId = refs[0]!;
    } catch { /* skip */ }
  }
  if (!candidateId) return;

  // Count verdicts citing either the candidate id (canonical) or the
  // promotion id (inline-lane callers pass the cited_id from the view,
  // which IS the promotion id). Both citation styles count toward the
  // same posterior — they refer to the same knowledge claim at different
  // lifecycle moments.
  const verdicts = db
    .query(
      `SELECT kind, context_refs FROM events
       WHERE kind IN ('candidate_confirmed', 'candidate_contradicted')`,
    )
    .all() as Array<{ kind: string; context_refs: string }>;
  let wins = 0;
  let losses = 0;
  for (const v of verdicts) {
    let refs: string[] = [];
    try { refs = JSON.parse(v.context_refs ?? "[]") as string[]; } catch { /* skip */ }
    if (!refs.includes(candidateId) && !refs.includes(promotion.id)) continue;
    if (v.kind === "candidate_confirmed") wins++; else losses++;
  }
  const alpha = 1 + wins;
  const beta = 1 + losses;
  const score = betaMean(alpha, beta);
  const confidence = betaConfidence(alpha, beta);

  // Stamp the refreshed posterior onto the promotion payload. The view reads
  // `payload.score` / `payload.confidence` directly so this update is what
  // makes the dispatcher's INLINE_PATTERN_SCORE_THRESHOLD / _CONFIDENCE_
  // THRESHOLD reads see the new values.
  let merged: Record<string, unknown> = {};
  try {
    merged = JSON.parse(promotion.payload ?? "{}") as Record<string, unknown>;
  } catch { merged = {}; }
  merged.alpha = alpha;
  merged.beta = beta;
  merged.wins = wins;
  merged.losses = losses;
  merged.score = score;
  merged.confidence = confidence;
  merged.last_outcome_ts = new Date().toISOString();
  db.run("UPDATE events SET payload = ? WHERE id = ?", [JSON.stringify(merged), promotion.id]);
};

/** Credit the inspiring `knowledge_promoted` row for an inline-lane outcome
 *  (k_555 four-link chain — create → retrieve → mutate → credit). Emits a
 *  `candidate_confirmed` (success) or `candidate_contradicted` (failure)
 *  event citing the promotion id; the existing knowledge extractor consumes
 *  these and recomputes the Beta posterior so the inline-vs-delegate
 *  selector adapts to outcomes. v2-design.md §3.6, k_252 "advisory=fake"
 *  remediated by structural credit emission.
 *
 *  Batch 4 Hole 3: after emitting the verdict, also refresh the promotion
 *  row's payload (`score`, `confidence`, `alpha`, `beta`) so the
 *  `low_risk_inline_patterns_view` — which reads these scalars directly —
 *  reflects the new posterior on the very next dispatch tick. Without this
 *  refresh the verdict events accumulate but the view stays frozen at
 *  promotion time and the dispatcher cannot adapt. */
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
  // Recompute and stamp the new posterior onto the inline-pattern promotion
  // row. The view reads payload.score/confidence directly; without this the
  // dispatcher's score≥0.7 + confidence≥0.6 gate is frozen at promotion time.
  refreshInlinePatternPosterior(db, knowledgeId);
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
  const matched = inlineMatchingPatterns(task as TaskNode & { target_resources?: string[] }, inlinePatterns);
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
