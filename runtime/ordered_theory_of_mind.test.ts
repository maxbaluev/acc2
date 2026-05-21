import { describe, expect, test } from "bun:test";
import { evaluateOrderedTheoryOfMind } from "./ordered_theory_of_mind";

describe("ordered_theory_of_mind_predicate evaluator", () => {
  test("aligned nested belief estimate covers first, second, and inference orders", () => {
    const result = evaluateOrderedTheoryOfMind({
      owner_profile: {
        preferred_terms: ["AI strategy", "enterprise transformation"],
        avoided_terms: ["unsupported AI novelty"],
      },
      interaction_history: [
        { text: "I want you to understand that I believe the system thinks this is a tool demo; infer enterprise transformation credibility instead." },
      ],
      proposed_action: {
        summary: "Frame the update around AI strategy and enterprise transformation credibility.",
        target_resources: ["repo:cli/apply.ts"],
      },
      candidate_nested_belief: {
        depth: 3,
        owner_believes: ["owner wants enterprise transformation framing"],
        owner_believes_system_believes: ["owner worries the system thinks this is a tool demo"],
        owner_wants_system_to_infer: ["lead with enterprise transformation credibility"],
      },
    });

    expect(result.residual).toBeLessThan(0.3);
    expect(result.verdict).toBe("aligned");
    expect(result.nested_belief_estimate.depth).toBe(3);
    expect(result.breakdown.order_coverage_gap).toBe(0);
  });

  test("hard owner constraint overlap is a blocking constraint miss", () => {
    const result = evaluateOrderedTheoryOfMind({
      owner_profile: {
        things_to_never_do: ["Do not approach David with low-context tool-first messaging; lead with enterprise transformation process credibility."],
      },
      proposed_action: {
        summary: "Approach David with low-context tool-first messaging about the product.",
      },
    });

    expect(result.residual).toBe(1);
    expect(result.verdict).toBe("constraint_miss");
    expect(result.breakdown.hard_constraint_pressure).toBe(1);
  });

  test("missing profile and history degrade gracefully as sparse evidence", () => {
    const result = evaluateOrderedTheoryOfMind({});

    expect(result.residual).toBeLessThan(0.3);
    expect(result.verdict).toBe("sparse");
    expect(result.nested_belief_estimate.depth).toBe(0);
  });

  test("candidate model that omits required ordered depth is scored", () => {
    const result = evaluateOrderedTheoryOfMind({
      interaction_history: [
        { text: "You think I only want a quick fix, but I want you to infer the operating model implications." },
      ],
      candidate_nested_belief: {
        depth: 1,
        owner_believes: ["owner wants a quick fix"],
      },
    });

    expect(result.residual).toBeGreaterThanOrEqual(0.3);
    expect(result.breakdown.candidate_gap).toBeGreaterThan(0);
    expect(result.nested_belief_estimate.depth).toBe(3);
  });
});
