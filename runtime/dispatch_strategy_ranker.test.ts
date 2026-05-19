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
  type StrategyRankingContext,
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
