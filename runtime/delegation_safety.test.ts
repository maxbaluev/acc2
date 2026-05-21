import { describe, expect, test } from "bun:test";
import { evaluateDelegationSafety } from "./delegation_safety";

describe("delegation_safety_predicate evaluator", () => {
  test("safe routine task allows autonomous commit", () => {
    const result = evaluateDelegationSafety({
      candidate_lane: "autonomous_commit",
      task: { risk: 0.1, novelty: 0.1, reversible: true, target_resources: ["repo:docs/notes.md"] },
      owner_control_signals: { owner_control_need: 0.1 },
    });
    expect(result.residual).toBeLessThan(0.3);
    expect(result.recommended_lane).toBe("autonomous_commit");
    expect(result.verdict).toBe("safe");
  });

  test("unsafe autonomous commit downgrades to owner ask", () => {
    const result = evaluateDelegationSafety({
      candidate_lane: "autonomous_commit",
      task: { risk: 0.8, novelty: 0.3, reversible: false, target_resources: ["repo:runtime/apply.ts"] },
      owner_control_signals: { owner_control_need: 0.9 },
    });
    expect(result.residual).toBeGreaterThanOrEqual(0.6);
    expect(result.recommended_lane).toBe("ask_owner");
    expect(result.verdict).toBe("unsafe");
  });
});
