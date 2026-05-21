import { describe, expect, test } from "bun:test";
import { evaluateMetacognitiveOwnerPolicy } from "./metacognitive_owner_policy";

describe("metacognitive_owner_policy_predicate evaluator", () => {
  test("stable low-pressure interaction recommends compact compression", () => {
    const result = evaluateMetacognitiveOwnerPolicy({
      candidate_policy_action: "compress",
      session_signals: { repeated_evidence: 0.6, task_ambiguity: 0.1 },
      cross_session_signals: { stable_preference: 0.8, low_policy_drift: 0.8 },
      owner_interaction: { recent_satisfaction: ["approved", "works"] },
    });
    expect(result.residual).toBeLessThan(0.3);
    expect(result.recommended_policy_action).toBe("compress");
    expect(result.verdict).toBe("aligned");
  });

  test("fresh corrections and control pressure recommend asking", () => {
    const result = evaluateMetacognitiveOwnerPolicy({
      candidate_policy_action: "compress",
      session_signals: { owner_control_need: 0.8, recent_control_language: 1 },
      cross_session_signals: { profile_control_signal: 0.7 },
      owner_interaction: { recent_corrections: ["Correction: do not compress this; ask before applying."], unresolved_decisions: ["repo:runtime/apply.ts"] },
    });
    expect(result.residual).toBeGreaterThanOrEqual(0.6);
    expect(result.recommended_policy_action).toBe("ask");
    expect(result.verdict).toBe("misaligned");
  });

  test("blocked cross-session signals recommend deferring", () => {
    const result = evaluateMetacognitiveOwnerPolicy({
      candidate_policy_action: "compress",
      session_signals: { active_failures: 0.9 },
      cross_session_signals: { policy_regression: 0.8 },
      owner_interaction: { recent_declines: ["not now", "defer until evidence refresh"] },
    });
    expect(result.residual).toBeGreaterThanOrEqual(0.6);
    expect(result.recommended_policy_action).toBe("defer");
  });

  test("new feedback without ask pressure recommends learning", () => {
    const result = evaluateMetacognitiveOwnerPolicy({
      candidate_policy_action: "learn",
      session_signals: { new_preference: 0.7, owner_feedback: 0.5 },
      cross_session_signals: { policy_uncertainty: 0.6 },
    });
    expect(result.residual).toBeLessThan(0.3);
    expect(result.recommended_policy_action).toBe("learn");
  });

  test("missing signals degrade gracefully to aligned compression", () => {
    const result = evaluateMetacognitiveOwnerPolicy({});
    expect(result.residual).toBeLessThan(0.3);
    expect(result.recommended_policy_action).toBe("compress");
    expect(result.breakdown.correction_pressure).toBe(0);
  });
});
