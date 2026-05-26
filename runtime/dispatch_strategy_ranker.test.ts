// Tests for the dispatch_strategy_v1 shadow ranker.
//
// Brain design 48SN4XF3WN4KBBCHHCANDRDQRW (DAG strategy as scored
// act_artifact registry). The ranker is observational — it scores
// every admitted strategy artifact against the current dispatch
// context but does NOT change which route gets chosen. Tests pin
// the scoring axes + edge cases (empty registry, missing context
// fields, infeasible lanes).

import { afterAll, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { runViews } from "../substrate/views";
import { seedActArtifacts } from "../substrate/seed";
import {
  buildRankingContext,
  loadStrategyArtifacts,
  rankStrategies,
  applyStrategyRouteDeltas,
  selectDecisionPolicyArtifacts,
  DECISION_POLICY_KIND,
  type StrategyRankingContext,
  type RankedStrategy,
} from "./dispatch_strategy_ranker";

afterAll(() => closeDb());

const baseContext = (overrides?: Partial<StrategyRankingContext>): StrategyRankingContext => ({
  routing_axes: {},
  residual_band: "unknown",
  goal_shape_tags: [],
  owner_profile_signals: {},
  feasible_routes: ["opencode_brain"],
  ...overrides,
});

describe("dispatch_strategy_ranker — loadStrategyArtifacts", () => {
  test("loads the 6 seed strategy priors from the registry", () => {
    closeDb(":memory:");
    const db = openDb(":memory:");
    runViews(db);
    seedActArtifacts(db);
    const strategies = loadStrategyArtifacts(db);
    // Each seed artifact has a name like dispatch_strategy_v1:<X>; the
    // loader filters to state_root='dispatch/strategy'.
    expect(strategies.length).toBeGreaterThanOrEqual(6);
    const names = new Set(strategies.map((s) => s.name));
    expect(names.has("one_shot_low_risk_v1")).toBe(true);
    expect(names.has("shallow_decomposition_v1")).toBe(true);
    expect(names.has("deep_decomposition_v1")).toBe(true);
    expect(names.has("replay_first_v1")).toBe(true);
    expect(names.has("claude_inline_leaf_v1")).toBe(true);
    expect(names.has("defer_blocked_v1")).toBe(true);
  });

  test("empty registry returns empty array (no throw)", () => {
    closeDb(":memory:");
    const db = openDb(":memory:");
    runViews(db);
    // No seedActArtifacts call.
    expect(loadStrategyArtifacts(db)).toEqual([]);
  });
});

describe("scored_decision_policy_v1 — universal retrieval (selectDecisionPolicyArtifacts)", () => {
  test("retrieves a seeded policy by decision_kind + goal_shape:any", () => {
    closeDb(":memory:");
    const db = openDb(":memory:");
    runViews(db);
    seedActArtifacts(db);
    // The capability_resolution and owner_rendering policies are seeded with
    // goal_shape_key:any → they match any current goal_shape.
    const cap = selectDecisionPolicyArtifacts(db, { decision_kind: "capability_resolution", goal_shape: "abc123" });
    expect(cap.length).toBeGreaterThanOrEqual(1);
    expect(cap[0]!.decision_kind).toBe("capability_resolution");
    expect(cap[0]!.artifact_id.length).toBeGreaterThan(0);
    expect(cap[0]!.policy_params.resolution_strategy).toBe("author_new_artifact");

    const render = selectDecisionPolicyArtifacts(db, { decision_kind: "owner_rendering" });
    expect(render.length).toBeGreaterThanOrEqual(1);
    expect(render[0]!.decision_kind).toBe("owner_rendering");
  });

  test("decision_kind discriminates — capability_resolution does not return model_route rows", () => {
    closeDb(":memory:");
    const db = openDb(":memory:");
    runViews(db);
    seedActArtifacts(db);
    const cap = selectDecisionPolicyArtifacts(db, { decision_kind: "capability_resolution", topN: 10 });
    for (const p of cap) {
      const row = db.query<{ body: string }, [string]>("SELECT body FROM act_artifact WHERE id = ? LIMIT 1").get(p.artifact_id);
      expect(row!.body.includes("decision_kind: 'capability_resolution'")).toBe(true);
      expect(row!.body.includes("decision_kind: 'model_route'")).toBe(false);
    }
  });

  test("highest score×confidence ranks first; ties stable", () => {
    closeDb(":memory:");
    const db = openDb(":memory:");
    runViews(db);
    seedActArtifacts(db);
    // Boost one capability policy's posterior so it must rank first.
    const all = selectDecisionPolicyArtifacts(db, { decision_kind: "capability_resolution", topN: 10 });
    expect(all.length).toBeGreaterThanOrEqual(1);
    db.run("UPDATE act_artifact SET score = 0.95, confidence = 0.9 WHERE id = ?", [all[0]!.artifact_id]);
    const top = selectDecisionPolicyArtifacts(db, { decision_kind: "capability_resolution", topN: 1 })[0]!;
    expect(top.artifact_id).toBe(all[0]!.artifact_id);
    expect(top.rank_weight).toBeCloseTo(0.95 * 0.9, 6);
  });

  test("no matching policy returns [] (fail-soft)", () => {
    closeDb(":memory:");
    const db = openDb(":memory:");
    runViews(db);
    seedActArtifacts(db);
    expect(selectDecisionPolicyArtifacts(db, { decision_kind: "no_such_decision_kind" })).toEqual([]);
  });

  test("DECISION_POLICY_KIND is the universal scored_decision_policy_v1 kind", () => {
    expect(DECISION_POLICY_KIND).toBe("scored_decision_policy_v1");
  });
});

describe("dispatch_strategy_ranker — rankStrategies", () => {
  test("strategy with matching goal_shape_tags ranks higher than one without", () => {
    closeDb(":memory:");
    const db = openDb(":memory:");
    runViews(db);
    seedActArtifacts(db);
    // deep_decomposition_v1 matches 'strategic_verb' + 'long_goal_text'.
    // one_shot_low_risk_v1 matches 'narrow' + 'single_obligation'.
    const ctx = baseContext({ goal_shape_tags: ["strategic_verb", "long_goal_text"], feasible_routes: ["opencode_brain", "claude_inline"] });
    const ranked = rankStrategies(db, ctx, 6);
    const deep = ranked.find((r) => r.name === "deep_decomposition_v1");
    const oneShot = ranked.find((r) => r.name === "one_shot_low_risk_v1");
    expect(deep).toBeDefined();
    expect(oneShot).toBeDefined();
    expect(deep!.shadow_score).toBeGreaterThan(oneShot!.shadow_score);
    expect(deep!.breakdown.goal_shape_match).toBeGreaterThan(0);
  });

  test("strategy whose preferred lane is NOT in feasible_routes gets lane_feasibility=0", () => {
    closeDb(":memory:");
    const db = openDb(":memory:");
    runViews(db);
    seedActArtifacts(db);
    // claude_inline_leaf_v1 prefers claude_inline; if that's not feasible,
    // its lane_feasibility should be 0 (only opencode_brain at 0.2 remains).
    const noClaudeInline = baseContext({ feasible_routes: ["opencode_brain"], goal_shape_tags: ["inline_eligible"] });
    const withClaudeInline = baseContext({ feasible_routes: ["opencode_brain", "claude_inline"], goal_shape_tags: ["inline_eligible"] });
    const rankedA = rankStrategies(db, noClaudeInline, 6);
    const rankedB = rankStrategies(db, withClaudeInline, 6);
    const inlineA = rankedA.find((r) => r.name === "claude_inline_leaf_v1");
    const inlineB = rankedB.find((r) => r.name === "claude_inline_leaf_v1");
    expect(inlineA).toBeDefined();
    expect(inlineB).toBeDefined();
    // claude_inline lane_preferences: { claude_inline: 0.9, opencode_brain: 0.2 }.
    // Without claude_inline feasible, max feasibility = 0.2; with it, 0.9.
    expect(inlineA!.breakdown.lane_feasibility).toBe(0.2);
    expect(inlineB!.breakdown.lane_feasibility).toBe(0.9);
    expect(inlineB!.shadow_score).toBeGreaterThan(inlineA!.shadow_score);
  });

  test("residual_band match adds to the score", () => {
    closeDb(":memory:");
    const db = openDb(":memory:");
    runViews(db);
    seedActArtifacts(db);
    // one_shot_low_risk_v1 matches residual_band='low'.
    const lowCtx = baseContext({ residual_band: "low" });
    const highCtx = baseContext({ residual_band: "high" });
    const rankedLow = rankStrategies(db, lowCtx, 6);
    const rankedHigh = rankStrategies(db, highCtx, 6);
    const oneShotLow = rankedLow.find((r) => r.name === "one_shot_low_risk_v1");
    const oneShotHigh = rankedHigh.find((r) => r.name === "one_shot_low_risk_v1");
    expect(oneShotLow!.breakdown.residual_band_match).toBe(1);
    expect(oneShotHigh!.breakdown.residual_band_match).toBe(0);
    expect(oneShotLow!.shadow_score).toBeGreaterThan(oneShotHigh!.shadow_score);
  });

  test("topN cap is honoured", () => {
    closeDb(":memory:");
    const db = openDb(":memory:");
    runViews(db);
    seedActArtifacts(db);
    const ranked = rankStrategies(db, baseContext(), 2);
    expect(ranked.length).toBe(2);
  });

  test("empty registry returns empty array (no throw)", () => {
    closeDb(":memory:");
    const db = openDb(":memory:");
    runViews(db);
    expect(rankStrategies(db, baseContext())).toEqual([]);
  });
});

describe("dispatch_strategy_ranker — buildRankingContext", () => {
  test("derives 'low' residual_band from recent task_committed.residual < 0.3", () => {
    closeDb(":memory:");
    const db = openDb(":memory:");
    runViews(db);
    db.run(
      `INSERT INTO events (id, ts, directive_id, task_id, loop_id, substrate_origin, kind, payload, context_refs, residual)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["EV001", new Date().toISOString(), "d_ctx", "t_ctx", "l", "substrate_auto", "task_committed", JSON.stringify({ summary: "ok" }), "[]", 0.12],
    );
    const ctx = buildRankingContext(db, { id: "t_ctx", directive_id: "d_ctx", parent_id: null, goal: "test", status: "pending" }, {}, ["opencode_brain"]);
    expect(ctx.residual_band).toBe("low");
  });

  test("derives 'high' residual_band from residual >= 0.6", () => {
    closeDb(":memory:");
    const db = openDb(":memory:");
    runViews(db);
    db.run(
      `INSERT INTO events (id, ts, directive_id, task_id, loop_id, substrate_origin, kind, payload, context_refs, residual)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["EV002", new Date().toISOString(), "d_hi", "t_hi", "l", "substrate_auto", "task_committed", JSON.stringify({}), "[]", 0.8],
    );
    const ctx = buildRankingContext(db, { id: "t_hi", directive_id: "d_hi", parent_id: null, goal: "test", status: "pending" }, {}, ["opencode_brain"]);
    expect(ctx.residual_band).toBe("high");
  });

  test("defaults to 'unknown' when no scored residual exists yet", () => {
    closeDb(":memory:");
    const db = openDb(":memory:");
    runViews(db);
    const ctx = buildRankingContext(db, { id: "t_new", directive_id: "d_new", parent_id: null, goal: "test", status: "pending" }, {}, ["opencode_brain"]);
    expect(ctx.residual_band).toBe("unknown");
  });
});

// ── Amendment A12ET3SF — active route-delta merge ──────────────────
describe("applyStrategyRouteDeltas (amendment A12ET3SF)", () => {
  const mkRank = (name: string, deltas: Record<string, number>, posteriorMean: number, confidence: number, activeScore = 1): RankedStrategy => ({
    artifact_id: "art_" + name,
    name,
    active_score: activeScore,
    shadow_score: activeScore,
    route_deltas: deltas,
    breakdown: { posterior_mean: posteriorMean, confidence, goal_shape_match: 0, residual_band_match: 0, owner_signal_dot: 0, routing_axis_dot: 0, lane_feasibility: 0 },
  });

  test("adds bounded deltas only for feasible routes", () => {
    const base = { opencode_brain: 0.4, claude_inline: 0.35 };
    const ranks = [mkRank("inline_first", { claude_inline: 1, substrate_replay: 1 }, 0.9, 0.9)];
    const out = applyStrategyRouteDeltas(base, ranks, ["opencode_brain", "claude_inline"]);
    // claude_inline (feasible) gets a delta; substrate_replay (infeasible) does not appear.
    expect(out.route_scores.claude_inline).toBeGreaterThan(0.35);
    expect(out.route_scores.substrate_replay).toBeUndefined();
    // Delta is bounded by maxDelta (default 0.25).
    expect(out.route_scores.claude_inline! - 0.35).toBeLessThanOrEqual(0.25 + 1e-9);
    expect(out.verifier_evidence.strategy_ranker_fail_soft).toBe(0);
    expect(out.verifier_evidence.strategy_delta_applied).toBe(1);
  });

  test("empty ranks are fail-soft: route_scores unchanged, strategy_ranker_fail_soft=1", () => {
    const base = { opencode_brain: 0.5, claude_inline: 0.3 };
    const out = applyStrategyRouteDeltas(base, [], ["opencode_brain", "claude_inline"]);
    expect(out.route_scores).toEqual(base);
    expect(out.verifier_evidence.strategy_ranker_fail_soft).toBe(1);
  });

  test("a posterior-weighted delta can flip which route is highest", () => {
    // Base: opencode_brain slightly ahead of claude_inline.
    const base = { opencode_brain: 0.50, claude_inline: 0.45 };
    const ranks = [mkRank("inline_first", { claude_inline: 1 }, 0.95, 0.95, 1)];
    const out = applyStrategyRouteDeltas(base, ranks, ["opencode_brain", "claude_inline"]);
    expect(out.route_scores.claude_inline).toBeGreaterThan(out.route_scores.opencode_brain!);
  });
});
