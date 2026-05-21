import { describe, expect, test } from "bun:test";
import { evaluateOwnerOutcomeForecast } from "./owner_outcome_forecast";

describe("owner_outcome_forecast_predicate evaluator", () => {
  test("low-risk proposed action predicts owner acceptance", () => {
    const result = evaluateOwnerOutcomeForecast({
      proposed_action: {
        summary: "Apply a small anchored replacement to a test file",
        target_resources: ["repo:runtime/example.test.ts"],
        reversible: true,
        risk: 0.1,
      },
      owner_profile: {
        control_signals: { owner_control_need: 0.1 },
        risk_signals: { directive_risk: 0.1 },
      },
      owner_history: [
        { text: "Approved, this worked.", signal: "worked", residual: 0.05 },
      ],
    });

    expect(result.residual).toBeLessThan(0.3);
    expect(result.predicted_owner_verdict).toBe("accept");
    expect(result.verdict).toBe("aligned");
  });

  test("recent negative owner outcome predicts rejection of auto-accept", () => {
    const result = evaluateOwnerOutcomeForecast({
      proposed_action: {
        summary: "Autonomously ship another runtime change",
        target_resources: ["repo:runtime/apply.ts"],
        risk: 0.4,
      },
      owner_history: [
        { text: "still broken, not what I meant", signal: "broke", residual: 0.95 },
      ],
    });

    expect(result.residual).toBeGreaterThanOrEqual(0.6);
    expect(result.predicted_owner_verdict).toBe("reject");
    expect(result.verdict).toBe("misforecast");
  });

  test("owner control and upstream residuals predict revision", () => {
    const result = evaluateOwnerOutcomeForecast({
      proposed_action: {
        summary: "Apply a CLI gate change",
        target_resources: ["repo:cli/apply.ts"],
        risk: 0.35,
      },
      owner_profile: {
        control_signals: { owner_control_need: 0.8 },
      },
      upstream_residuals: {
        continual_owner_state_residual: 0.2,
        delegation_safety_residual: 0.65,
      },
    });

    expect(result.residual).toBeGreaterThanOrEqual(0.6);
    expect(result.predicted_owner_verdict).toBe("revise");
    expect(result.breakdown.upstream_pressure).toBe(0.65);
  });

  test("candidate revision forecast can align under moderate revision pressure", () => {
    const result = evaluateOwnerOutcomeForecast({
      candidate_predicted_verdict: "revise",
      proposed_action: { summary: "Needs changes before apply", risk: 0.4 },
      owner_history: [{ text: "closer but needs changes", signal: "partial", residual: 0.45 }],
    });

    expect(result.residual).toBeLessThan(0.3);
    expect(result.predicted_owner_verdict).toBe("revise");
  });

  test("missing signals degrade gracefully to acceptance forecast", () => {
    const result = evaluateOwnerOutcomeForecast({});
    expect(result.residual).toBeLessThan(0.3);
    expect(result.predicted_owner_verdict).toBe("accept");
    expect(result.breakdown.action_risk).toBe(0);
  });
});
