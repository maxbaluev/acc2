import { describe, expect, test } from "bun:test";
import { evaluateOrchestratorPredicate } from "./orchestrator_predicate";

const cleanResults = {
  owner_goal_preservation_drift: { name: "owner_goal_preservation_drift", residual: 0.05, verdict: "clean", reasons: [] },
  delegation_safety: { name: "delegation_safety", residual: 0.05, verdict: "safe", reasons: [] },
  metacognitive_owner_policy: { name: "metacognitive_owner_policy", residual: 0.05, verdict: "aligned", reasons: [] },
  continual_owner_state: { name: "continual_owner_state", residual: 0.05, verdict: "stable", reasons: [] },
  owner_outcome_forecast: { name: "owner_outcome_forecast", residual: 0.05, verdict: "aligned", reasons: [] },
  owner_rendering: { name: "owner_rendering", residual: 0.05, verdict: "clean", reasons: [] },
  ordered_theory_of_mind: { name: "ordered_theory_of_mind", residual: 0.05, verdict: "aligned", reasons: [] },
};

describe("evaluateOrchestratorPredicate", () => {
  test("allows autonomous apply when all seven S0 predicates are clean", () => {
    const result = evaluateOrchestratorPredicate({
      candidate_route: "AUTO_APPLY",
      sub_predicate_results: cleanResults,
      candidate_orchestration: {
        boundary_order: [
          "owner_goal_preservation_drift",
          "delegation_safety",
          "metacognitive_owner_policy",
          "continual_owner_state",
          "owner_outcome_forecast",
          "owner_rendering",
          "ordered_theory_of_mind",
        ],
        selected_boundaries: Object.keys(cleanResults),
      },
    });

    expect(result.residual).toBeLessThan(0.3);
    expect(result.verdict).toBe("aligned");
    expect(result.recommended_route).toBe("AUTO_APPLY");
  });

  test("recycles when any composed sub-predicate has a blocking residual", () => {
    const result = evaluateOrchestratorPredicate({
      candidate_route: "AUTO_APPLY",
      sub_predicate_results: {
        ...cleanResults,
        ordered_theory_of_mind: { name: "ordered_theory_of_mind", residual: 0.72, verdict: "order_mismatch", reasons: ["mock_order_mismatch"] },
      },
      candidate_orchestration: { selected_boundaries: Object.keys(cleanResults) },
    });

    expect(result.residual).toBeGreaterThanOrEqual(0.6);
    expect(result.verdict).toBe("misaligned");
    expect(result.recommended_route).toBe("NEEDS_BRAIN_RECYCLE");
    expect(result.reasons.join("\n")).toContain("ordered_theory_of_mind");
  });

  test("routes to owner gate for watch-level composed signals", () => {
    const result = evaluateOrchestratorPredicate({
      candidate_route: "AUTO_APPLY",
      sub_predicate_results: {
        ...cleanResults,
        owner_outcome_forecast: { name: "owner_outcome_forecast", residual: 0.35, verdict: "watch", reasons: ["mock_watch"] },
      },
    });

    expect(result.residual).toBeGreaterThanOrEqual(0.3);
    expect(result.residual).toBeLessThan(0.6);
    expect(result.verdict).toBe("watch");
    expect(result.recommended_route).toBe("OWNER_GATE");
  });

  test("degrades gracefully when prior gates provide no detailed predicate rows", () => {
    const result = evaluateOrchestratorPredicate({ candidate_route: "AUTO_APPLY" });

    expect(result.residual).toBeLessThan(0.6);
    expect(result.verdict).toBe("aligned");
    expect(result.recommended_route).toBe("AUTO_APPLY");
    expect(result.breakdown.coverage_gap).toBeGreaterThan(0);
  });
});
