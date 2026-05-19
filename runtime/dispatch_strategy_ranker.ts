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
import type { TaskNode } from "../substrate/types";

const STRATEGY_KIND_TAG = "dispatch_strategy_v1";

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
  shadow_score: number;
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
    const shadowScore =
      posteriorMean * 0.25
      + s.confidence * 0.1
      + goalShapeMatch * 0.2
      + residualBandMatch * 0.15
      + ownerSignalDot * 0.1
      + routingAxisDot * 0.1
      + laneFeasibility * 0.1;
    return {
      artifact_id: s.artifact_id,
      name: s.name,
      shadow_score: shadowScore,
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
  ranked.sort((a, b) => b.shadow_score - a.shadow_score);
  return ranked.slice(0, topN);
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
