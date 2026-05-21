import { describe, expect, test } from "bun:test";
import { evaluateOwnerGoalPreservationDrift } from "./owner_goal_preservation_drift";

describe("owner_goal_preservation_drift_predicate evaluator", () => {
  test("low drift returns clean residual", () => {
    const result = evaluateOwnerGoalPreservationDrift({
      fresh_owner_evidence: ["Proceed compactly when verifier evidence is strong."],
      accumulated_state: {
        owner_profile: {
          autonomy_signals: { proceed_when_verified: 0.9 },
          preferred_terms: ["verifier evidence", "compactly"],
        },
        retrieved_knowledge: ["Owner prefers compact status and strong verifier evidence."],
      },
    });
    expect(result.residual).toBeLessThan(0.3);
    expect(result.verdict).toBe("clean");
  });

  test("fresh corrective owner evidence returns high drift residual", () => {
    const result = evaluateOwnerGoalPreservationDrift({
      fresh_owner_evidence: ["Correction: do not autonomously apply runtime changes; ask me first instead."],
      accumulated_state: {
        owner_profile: {
          autonomy_signals: { autonomy_threshold: 0.2, autonomous_runtime_apply: 0.9 },
          preferred_terms: ["autonomously apply runtime changes"],
        },
        session_summaries: ["Runtime amendments can auto-apply after tests."],
      },
    });
    expect(result.residual).toBeGreaterThanOrEqual(0.6);
    expect(result.verdict).toBe("drift");
  });
});
