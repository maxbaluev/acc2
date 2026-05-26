// Shadow ranker for dispatch_strategy_v1 artifacts (2026-05-17).
//
// Brain knowledge 48SN4XF3WN4KBBCHHCANDRDQRW (residual 0.18, DAG-strategy
// design): "dispatch_decider migration: compute goal_shape via
// currentGoalShapeForTask, residual_band from latest task/directive
// residual or unknown, owner_profile_signal projection from
// owner_profile_view/routing_axes, then retrieve candidates from
// act_artifact_registry_view OR substrate.search query=
// 'dispatch_strategy_v1 <goal_shape> <residual_band> <owner signals>'.
// Filter only for structural validity and status admitted/promoted;
// score as posterior_mean/confidence × semantic match(goal_shape_tags),
// residual_band match, owner_signal dot product, routing_axis dot
// product, and feasibility mask for lanes already computed by
// blockers/recipe/inline gates."
//
// This module ships the SHADOW path: it computes strategy scores
// alongside the legacy scoreRoutesFromAxes() decision but does NOT
// change the final route. The brain's design explicitly said
// `rollout.shadow = true` for every seed row — the ranker collects
// posterior evidence first; replacing the enum logic comes later.
//
// The output (top-N strategy IDs + scores) is attached to the
// dispatch_decided event's verifier_evidence so closure_audited can
// later credit the chosen strategy via its posterior_alpha/beta.
//
// This file is intentionally pure: no side effects, no event emission.
// Just (db, task, axes) → ranked strategies. The caller decides what
// to do with the ranking.

import type { Database } from "bun:sqlite";
import type { TaskNode } from "./task_topology";

const STRATEGY_KIND_TAG = "dispatch_strategy_v1";

// ── Universal scored-decision-policy primitive ─────────────────────────
//
// Every learnable substrate decision can be represented as an act_artifact
// row with kind = DECISION_POLICY_KIND. The row's body/payload declare
// {decision_kind, goal_shape_key|goal_shape_tags, policy_params, ...}. The
// four-link chain (retrieve → cite → credit) closes UNIVERSALLY through the
// EXISTING artifact retrieval + posterior + credit envelope — this primitive
// adds NO new posterior table and NO bespoke score family. A selected policy
// artifact's id is cited into the governing act; the standard action_scored +
// dense_closure_credit envelope then moves its NORMAL act_artifact posterior.
//
// LEGACY_DISPATCH_STRATEGY_KIND is the pre-existing dispatch_strategy_v1 kind
// (still ranked by rankStrategies for the dispatch_lane site). DECISION_POLICY_KIND
// is the universal kind keyed by decision_kind. DISPATCH_DECISION_KIND is the
// decision_kind discriminator for the dispatch-lane decision site.
const LEGACY_DISPATCH_STRATEGY_KIND = "dispatch_strategy_v1";
export const DECISION_POLICY_KIND = "scored_decision_policy_v1";
export const DISPATCH_DECISION_KIND = "dispatch_lane";

void LEGACY_DISPATCH_STRATEGY_KIND;

/** A retrieved scored_decision_policy_v1 artifact, ranked for a decision site. */
export type SelectedDecisionPolicy = {
  /** act_artifact row id — cite THIS into the governing act so credit lands here. */
  artifact_id: string;
  decision_kind: string;
  /** posterior_mean × confidence, the ranking weight (standard act_artifact posterior). */
  rank_weight: number;
  score: number;
  confidence: number;
  /** Free-form policy params parsed from the artifact body/payload. */
  policy_params: Record<string, unknown>;
};

export type SelectDecisionPolicyInput = {
  /** decision_kind discriminator (e.g. "dispatch_lane", "model_route",
   *  "capability_resolution", "owner_rendering"). Free string. */
  decision_kind: string;
  /** Current goal_shape key/hash to condition on. Reuses existing goal-shape
   *  machinery; never regex over language. May be null/empty (matches "any"). */
  goal_shape?: string | null;
  /** Optional extra match hints folded into the SQL LIKE filter. */
  trigger?: string | null;
  artifact_kind?: string | null;
  evidence?: unknown;
  /** Max policies to return, highest rank_weight first. */
  topN?: number;
};

const extractPolicyParams = (body: string): Record<string, unknown> => {
  // The policy artifact body declares `const POLICY = {...}` (mirrors the
  // strategy declaration shape) returning structured params. Reuse the same
  // brace-balanced literal extractor used for STRATEGY declarations.
  const start = body.indexOf("const POLICY = ");
  if (start < 0) return {};
  const open = body.indexOf("{", start);
  if (open < 0) return {};
  let depth = 0;
  let end = -1;
  let inString: '"' | "'" | null = null;
  for (let i = open; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (ch === "\\") { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end < 0) return {};
  try {
    const factory = new Function(`return ${body.slice(open, end)};`);
    const parsed = factory() as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return {};
    // The declaration nests the tunable knobs under `policy_params`; surface
    // those directly while keeping the full declaration's other fields
    // (decision_kind, goal_shape_key, rollout, verifier_handle) merged in so a
    // caller can read either shape.
    const nested = parsed.policy_params;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      return { ...(nested as Record<string, unknown>), ...parsed };
    }
    return parsed;
  } catch {
    return {};
  }
};

/** UNIVERSAL retrieval leg of the four-link chain. Retrieve the best
 *  scored_decision_policy_v1 artifact(s) for a decision site, keyed by
 *  decision_kind + current goal_shape, ranked by the STANDARD act_artifact
 *  posterior (score × confidence). Pure read; no side effects. Returns [] on
 *  any error (fail-soft: a decision site must never break because a policy
 *  lookup failed). The caller CITES the returned artifact_id(s) into the
 *  governing act so the existing credit envelope moves their posteriors. */
export const selectDecisionPolicyArtifacts = (
  db: Database,
  input: SelectDecisionPolicyInput,
): SelectedDecisionPolicy[] => {
  const topN = input.topN ?? 1;
  const goalShape = (input.goal_shape ?? "").trim();
  type Row = { id: string; body: string; score: number; confidence: number };
  let rows: Row[];
  try {
    // Condition on decision_kind (required) and goal_shape (soft: a policy
    // tagged goal_shape:any, or matching the current shape, qualifies). The
    // body/name carry these as free-string tags so retrieval reuses the same
    // registry + posterior the dispatch strategy ranker already uses.
    rows = db
      .query(
        `SELECT id, body, score, confidence
         FROM act_artifact_registry_view
         WHERE kind = '${DECISION_POLICY_KIND}'
           AND status IN ('admitted', 'promoted')
           AND (body LIKE ? OR name LIKE ?)
           AND (? = ''
                OR body LIKE ? OR name LIKE ?
                OR body LIKE '%goal_shape_key%''any''%'
                OR body LIKE '%goal_shape_tags%''any''%'
                OR body LIKE '%goal_shape:any%')
         ORDER BY score DESC, confidence DESC
         LIMIT ${Math.max(1, topN)}`,
      )
      .all(
        `%decision_kind%${input.decision_kind}%`,
        `%${input.decision_kind}%`,
        goalShape,
        `%${goalShape}%`,
        `%${goalShape}%`,
      ) as Row[];
  } catch {
    return [];
  }
  return rows.map((r) => {
    const params = extractPolicyParams(r.body);
    const score = r.score ?? 0;
    const confidence = r.confidence ?? 0;
    return {
      artifact_id: r.id,
      decision_kind: input.decision_kind,
      rank_weight: score * confidence,
      score,
      confidence,
      policy_params: params,
    };
  });
};

type StrategyDecl = {
  /** Substrate id of the source act_artifact row. */
  artifact_id: string;
  /** payload.name from the strategy declaration (one of one_shot_low_risk_v1,
   *  shallow_decomposition_v1, deep_decomposition_v1, replay_first_v1,
   *  claude_inline_leaf_v1, defer_blocked_v1, or future admitted rows). */
  name: string;
  goal_shape_tags: string[];
  match: {
    residual_bands: string[];
    owner_profile_signal_weights: Record<string, number>;
    routing_axis_weights: Record<string, number>;
  };
  plan: {
    lane_preferences: Record<string, number>;
  };
  posterior_alpha: number;
  posterior_beta: number;
  score: number;
  confidence: number;
};

const parseJson = <T>(s: unknown, fallback: T): T => {
  if (typeof s !== "string") return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

/** Extract a strategy declaration from a seed artifact body. The body
 *  is a small bun script that defines `const STRATEGY = {...}` then
 *  prints @@RESULT@@ with the strategy. We extract the literal via the
 *  Function constructor on JUST the `const STRATEGY = {...}` slice —
 *  the seed body's strategy declaration is pure data with no I/O.
 *  Errors fall through to null and are excluded from the candidate set.
 *
 *  Safety: the Function eval runs ONLY the declaration substring (no
 *  console.log, no imports). The slice is bounded by literal anchors
 *  ('const STRATEGY = ' and the matching brace). A malformed body
 *  surfaces as a parse error and degrades silently. */
const extractStrategyFromBody = (body: string): Pick<StrategyDecl, "name" | "goal_shape_tags" | "match" | "plan"> | null => {
  const start = body.indexOf("const STRATEGY = ");
  if (start < 0) return null;
  const open = body.indexOf("{", start);
  if (open < 0) return null;
  // Track brace depth, honouring string literals so a `{` inside a
  // quoted value doesn't bump depth.
  let depth = 0;
  let end = -1;
  let inString: '"' | "'" | null = null;
  for (let i = open; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (ch === "\\") { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end < 0) return null;
  const objText = body.slice(open, end);
  try {
    // Function-eval extracts the literal as a real JS object. No
    // side-effects because objText is just the declaration body.
    const factory = new Function(`return ${objText};`);
    const parsed = factory() as Record<string, unknown>;
    return {
      name: (parsed.name as string) ?? "(unnamed)",
      goal_shape_tags: Array.isArray(parsed.goal_shape_tags) ? (parsed.goal_shape_tags as string[]) : [],
      match: (parsed.match as StrategyDecl["match"]) ?? { residual_bands: [], owner_profile_signal_weights: {}, routing_axis_weights: {} },
      plan: (parsed.plan as StrategyDecl["plan"]) ?? { lane_preferences: {} },
    };
  } catch {
    return null;
  }
};

/** Load every admitted/promoted strategy artifact from the registry. */
export const loadStrategyArtifacts = (db: Database): StrategyDecl[] => {
  type Row = { id: string; body: string; posterior_alpha: number; posterior_beta: number; score: number; confidence: number };
  let rows: Row[];
  try {
    // L8 (2026-05-17): query by the kind discriminator column
    // (preferred). Fall back to state_root for installs running before
    // the kind column landed. Both predicates are wide-OR'd so any one
    // matching identifier suffices — same row will only appear once.
    rows = db
      .query(
        `SELECT id, body, posterior_alpha, posterior_beta, score, confidence
         FROM act_artifact_registry_view
         WHERE (kind = 'dispatch_strategy_v1' OR state_root = 'dispatch/strategy')
           AND status IN ('admitted', 'promoted')`,
      )
      .all() as Row[];
  } catch {
    return [];
  }
  const out: StrategyDecl[] = [];
  for (const r of rows) {
    const decl = extractStrategyFromBody(r.body);
    if (!decl) continue;
    out.push({
      artifact_id: r.id,
      ...decl,
      posterior_alpha: r.posterior_alpha ?? 1,
      posterior_beta: r.posterior_beta ?? 1,
      score: r.score ?? 0,
      confidence: r.confidence ?? 0,
    });
  }
  return out;
};

/** Context the ranker scores against. Caller provides this from the
 *  dispatch_decider's existing telemetry — no new collection needed. */
export type StrategyRankingContext = {
  /** Open-ended axis vector from buildDispatchDecisionEvidence; the
   *  ranker dot-products against each strategy's routing_axis_weights. */
  routing_axes: Record<string, number>;
  /** Open-ended residual band tag: 'low' | 'medium' | 'high' | 'unknown'
   *  inferred from the task's recent score history. */
  residual_band: "low" | "medium" | "high" | "unknown";
  /** Open-ended goal_shape tags from currentGoalShapeForTask. */
  goal_shape_tags: string[];
  /** Owner-profile signals (autonomy_high, autonomy_medium, control_strict,
   *  collaboration_inline_preferred, etc.) from owner_profile_view. */
  owner_profile_signals: Record<string, number>;
  /** Which lanes are structurally available right now (after blocker /
   *  recipe / inline gates). Strategies whose lane_preferences point at
   *  unavailable lanes get penalised. */
  feasible_routes: ReadonlyArray<string>;
};

export type RankedStrategy = {
  artifact_id: string;
  name: string;
  /** Active ranking score (amendment A12ET3SF). Ranked strategies are no
   *  longer observational shadow evidence — applyStrategyRouteDeltas folds
   *  posterior-weighted deltas into route_scores before route selection. */
  active_score: number;
  /** Back-compat read for legacy dispatch_decided payloads / views that
   *  still reference shadow_score. Mirrors active_score; no consumer may
   *  use the shadow name for behavior. */
  shadow_score: number;
  /** Posterior-weighted per-lane route deltas this strategy contributes
   *  (amendment A12ET3SF). Computed from plan.lane_preferences intersected
   *  with feasible_routes and scaled by active_score × posterior weight. */
  route_deltas: Record<string, number>;
  /** Per-axis contribution to the score — useful for debugging WHY a
   *  strategy ranked where it did. The closure_audited credit projector
   *  consumes these to update individual axis posteriors. */
  breakdown: {
    posterior_mean: number;
    confidence: number;
    goal_shape_match: number;
    residual_band_match: number;
    owner_signal_dot: number;
    routing_axis_dot: number;
    lane_feasibility: number;
  };
};

const dot = (a: Record<string, number>, b: Record<string, number>): number => {
  let s = 0;
  for (const [k, v] of Object.entries(b)) s += (a[k] ?? 0) * v;
  return s;
};

/** Score every loaded strategy against the current dispatch context.
 *  Returns top-N ranked. Pure function — no side effects. */
export const rankStrategies = (
  db: Database,
  ctx: StrategyRankingContext,
  topN = 3,
): RankedStrategy[] => {
  const strategies = loadStrategyArtifacts(db);
  const ranked: RankedStrategy[] = strategies.map((s) => {
    const posteriorMean = s.posterior_alpha / Math.max(1, s.posterior_alpha + s.posterior_beta);
    // Goal-shape: count overlap between strategy's tags and the
    // current task's tags, normalised by the strategy's tag count.
    const goalShapeMatch = s.goal_shape_tags.length > 0
      ? s.goal_shape_tags.filter((t) => ctx.goal_shape_tags.includes(t)).length / s.goal_shape_tags.length
      : 0;
    const residualBandMatch = s.match.residual_bands.includes(ctx.residual_band) ? 1 : 0;
    const ownerSignalDot = dot(ctx.owner_profile_signals, s.match.owner_profile_signal_weights);
    const routingAxisDot = dot(ctx.routing_axes, s.match.routing_axis_weights);
    // Lane feasibility: the highest lane_preferences weight whose
    // route is in ctx.feasible_routes. If no preferred lane is
    // available, the strategy gets a feasibility of 0.
    let laneFeasibility = 0;
    for (const [lane, weight] of Object.entries(s.plan.lane_preferences)) {
      if (ctx.feasible_routes.includes(lane)) laneFeasibility = Math.max(laneFeasibility, weight);
    }
    const activeScore =
      posteriorMean * 0.25
      + s.confidence * 0.1
      + goalShapeMatch * 0.2
      + residualBandMatch * 0.15
      + ownerSignalDot * 0.1
      + routingAxisDot * 0.1
      + laneFeasibility * 0.1;
    // Per-lane route deltas (amendment A12ET3SF): only for FEASIBLE lanes
    // the strategy prefers. Raw deltas here; applyStrategyRouteDeltas scales
    // them by active_score × posterior weight and clamps.
    const routeDeltas: Record<string, number> = {};
    for (const [lane, weight] of Object.entries(s.plan.lane_preferences)) {
      if (ctx.feasible_routes.includes(lane)) routeDeltas[lane] = weight;
    }
    return {
      artifact_id: s.artifact_id,
      name: s.name,
      active_score: activeScore,
      shadow_score: activeScore,
      route_deltas: routeDeltas,
      breakdown: {
        posterior_mean: posteriorMean,
        confidence: s.confidence,
        goal_shape_match: goalShapeMatch,
        residual_band_match: residualBandMatch,
        owner_signal_dot: ownerSignalDot,
        routing_axis_dot: routingAxisDot,
        lane_feasibility: laneFeasibility,
      },
    };
  });
  ranked.sort((a, b) => b.active_score - a.active_score);
  return ranked.slice(0, topN);
};

// ── Amendment A12ET3SF — active strategy route-score adjustment ────────
//
// Ranked strategies are no longer observational shadow evidence. A
// non-empty ranking merges posterior-weighted route_deltas into the
// route_scores BEFORE chooseHighestScoredRoute, so a learned strategy that
// prefers a feasible lane can change the selected route. Empty rankings or
// a thrown ranker are fail-soft: route_scores are returned unchanged and
// verifier_evidence.strategy_ranker_fail_soft=1.
//
// Formula (per rank, per feasible lane preference p):
//   posteriorWeight = breakdown.posterior_mean × breakdown.confidence
//   delta           = clamp(p × active_score × posteriorWeight, 0, maxDelta)
// Deltas accumulate across ranks, then every score is clamped to [0,1].

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

export const applyStrategyRouteDeltas = (
  routeScores: Record<string, number>,
  ranks: RankedStrategy[],
  feasibleRoutes: ReadonlyArray<string>,
  opts?: { maxDelta?: number },
): { route_scores: Record<string, number>; verifier_evidence: Record<string, number> } => {
  const maxDelta = opts?.maxDelta ?? 0.25;
  // Fail-soft: no ranks → unchanged scores, record the soft fallback.
  if (!Array.isArray(ranks) || ranks.length === 0) {
    return { route_scores: { ...routeScores }, verifier_evidence: { strategy_ranker_fail_soft: 1, strategy_rank_count: 0, strategy_delta_applied: 0 } };
  }
  const adjusted: Record<string, number> = { ...routeScores };
  let totalDelta = 0;
  try {
    for (const rank of ranks) {
      const posteriorWeight = (rank.breakdown?.posterior_mean ?? 0) * (rank.breakdown?.confidence ?? 0);
      const deltas = rank.route_deltas ?? {};
      for (const [lane, pref] of Object.entries(deltas)) {
        if (!feasibleRoutes.includes(lane)) continue;
        const delta = Math.max(0, Math.min(maxDelta, pref * rank.active_score * posteriorWeight));
        if (delta <= 0) continue;
        adjusted[lane] = (adjusted[lane] ?? 0) + delta;
        totalDelta += delta;
      }
    }
  } catch {
    // Thrown mid-merge → fail-soft to the original scores.
    return { route_scores: { ...routeScores }, verifier_evidence: { strategy_ranker_fail_soft: 1, strategy_rank_count: ranks.length, strategy_delta_applied: 0 } };
  }
  for (const lane of Object.keys(adjusted)) adjusted[lane] = clamp01(adjusted[lane]!);
  return {
    route_scores: adjusted,
    verifier_evidence: {
      strategy_ranker_fail_soft: 0,
      strategy_rank_count: ranks.length,
      strategy_delta_applied: totalDelta > 0 ? 1 : 0,
      strategy_total_delta: totalDelta,
    },
  };
};

/** Convenience: build the StrategyRankingContext from telemetry the
 *  dispatch_decider already has. Caller passes its evidence + the
 *  TaskNode; this helper does the goal-shape lookup + residual-band
 *  inference. */
export const buildRankingContext = (
  db: Database,
  task: TaskNode,
  routingAxes: Record<string, number>,
  feasibleRoutes: ReadonlyArray<string>,
): StrategyRankingContext => {
  // Residual band: latest action_scored / task_committed residual under
  // this directive. Bucketed: low (<0.3), medium (<0.6), high (>=0.6),
  // unknown (no scoring yet).
  let residualBand: StrategyRankingContext["residual_band"] = "unknown";
  try {
    const row = db
      .query(
        `SELECT residual FROM events
         WHERE directive_id = ?
           AND kind IN ('action_scored','task_committed','task_closure_audited','owner_observed_outcome_recorded')
           AND residual IS NOT NULL
         ORDER BY ts DESC LIMIT 1`,
      )
      .get(task.directive_id) as { residual: number } | null;
    if (row && typeof row.residual === "number") {
      residualBand = row.residual < 0.3 ? "low" : row.residual < 0.6 ? "medium" : "high";
    }
  } catch { /* leave 'unknown' */ }

  // Goal-shape tags: read from task's own goal_shape_tags payload if
  // the task_node_opened carried any; otherwise empty (the strategy
  // ranker degrades gracefully — goal_shape_match scores 0).
  let goalShapeTags: string[] = [];
  try {
    const row = db
      .query(
        `SELECT payload FROM events
         WHERE kind = 'task_node_opened' AND task_id = ? AND directive_id = ?
         LIMIT 1`,
      )
      .get(task.id, task.directive_id) as { payload: string } | null;
    if (row?.payload) {
      const p = parseJson<{ goal_shape_tags?: string[] }>(row.payload, {});
      if (Array.isArray(p.goal_shape_tags)) goalShapeTags = p.goal_shape_tags;
    }
  } catch { /* leave empty */ }

  // Owner-profile signals: pulled from the most recent
  // owner_profile_recorded payload (a Record<string,number>).
  let ownerSignals: Record<string, number> = {};
  try {
    const row = db
      .query(
        `SELECT payload FROM events WHERE kind = 'owner_profile_recorded'
         ORDER BY ts DESC LIMIT 1`,
      )
      .get() as { payload: string } | null;
    if (row?.payload) {
      const p = parseJson<Record<string, unknown>>(row.payload, {});
      // Flatten autonomy_signals + control_signals + collaboration_signals
      // + risk_signals + rendering_signals onto a single map. Each is
      // already Record<string, number> per acc2 CLAUDE.md.
      const buckets = ["autonomy_signals", "control_signals", "collaboration_signals", "risk_signals", "rendering_signals", "goal_continuity_signals"];
      for (const b of buckets) {
        const v = p[b];
        if (v && typeof v === "object" && !Array.isArray(v)) {
          for (const [k, n] of Object.entries(v)) {
            if (typeof n === "number") ownerSignals[k] = n;
          }
        }
      }
    }
  } catch { /* leave empty */ }

  return {
    routing_axes: routingAxes,
    residual_band: residualBand,
    goal_shape_tags: goalShapeTags,
    owner_profile_signals: ownerSignals,
    feasible_routes: feasibleRoutes,
  };
};
