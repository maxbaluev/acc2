import { describe, expect, test } from "bun:test";
import { evaluateContinualOwnerState } from "./continual_owner_state";

describe("continual_owner_state_predicate evaluator", () => {
  test("stable prior and fresh interaction update returns low residual", () => {
    const result = evaluateContinualOwnerState({
      prior_owner_profile: {
        control_signals: { owner_control_need: 0.2 },
        rendering_signals: { compact_status: 0.8 },
        preferred_terms: ["AI strategy"],
      },
      recent_interactions: [
        { text: "Approved, this works. Prefer compact status when evidence is strong." },
      ],
    });

    expect(result.residual).toBeLessThan(0.3);
    expect(result.verdict).toBe("stable");
    expect(result.updated_owner_profile.preferred_terms).toContain("AI strategy");
    expect(result.breakdown.key_forgetting).toBe(0);
  });

  test("candidate update that drops stable state reports catastrophic forgetting", () => {
    const result = evaluateContinualOwnerState({
      prior_owner_profile: {
        control_signals: { owner_control_need: 0.9, manual_review: 0.8 },
        risk_signals: { runtime_change_risk: 0.7 },
        preferred_terms: ["enterprise transformation"],
        things_to_never_do: ["Do not approach David with low-context tool-first messaging"],
      },
      candidate_updated_state: {
        control_signals: {},
        preferred_terms: [],
        things_to_never_do: [],
      },
      recent_interactions: [
        { text: "Correction: do not forget the manual review and David constraint." },
      ],
    });

    expect(result.residual).toBeGreaterThanOrEqual(0.6);
    expect(result.verdict).toBe("forgetting");
    expect(result.breakdown.key_forgetting).toBeGreaterThan(0);
    expect(result.breakdown.array_forgetting).toBeGreaterThan(0);
  });

  test("fresh correction without prior profile is watch, not autonomous forgetting", () => {
    const result = evaluateContinualOwnerState({
      recent_interactions: [
        { text: "Correction: ask before applying runtime changes." },
      ],
    });

    expect(result.residual).toBeGreaterThanOrEqual(0.3);
    expect(result.residual).toBeLessThan(0.6);
    expect(result.verdict).toBe("watch");
    expect(result.updated_owner_profile.control_signals?.owner_control_need).toBe(1);
  });

  test("missing signals degrade gracefully to stable residual", () => {
    const result = evaluateContinualOwnerState({});
    expect(result.residual).toBeLessThan(0.3);
    expect(result.verdict).toBe("stable");
    expect(result.breakdown.no_interaction).toBe(0.1);
  });
});
