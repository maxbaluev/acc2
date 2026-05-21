import { describe, expect, test } from "bun:test";
import { evaluateOwnerRendering } from "./owner_rendering";

describe("owner_rendering_predicate evaluator", () => {
  test("profile-aligned owner-visible draft is clean", () => {
    const result = evaluateOwnerRendering({
      rendered_message: {
        text: "The AI strategy work is framed as enterprise transformation and operating model change.",
        language: "en",
      },
      owner_profile: {
        preferred_terms: ["AI strategy", "enterprise transformation", "operating model"],
        avoided_terms: ["unsupported AI novelty"],
        detected_language: { language: "en", confidence: 0.9 },
        rendering_signals: { mirror_preferred_terms: 1 },
      },
    });

    expect(result.residual).toBeLessThan(0.3);
    expect(result.verdict).toBe("clean");
    expect(result.breakdown.preferred_term_gap).toBe(0);
  });

  test("avoided owner term produces a blocking rendering verdict", () => {
    const result = evaluateOwnerRendering({
      rendered_message: "This is an unsupported AI novelty pitch.",
      owner_profile: { avoided_terms: ["unsupported AI novelty"] },
    });

    expect(result.residual).toBe(1);
    expect(result.verdict).toBe("violates_avoided_term");
  });

  test("high-confidence detected language catches wrong rendered language", () => {
    const result = evaluateOwnerRendering({
      rendered_message: { text: "Bonjour, voici le statut.", language: "fr" },
      owner_profile: { detected_language: { language: "en", confidence: 0.95 } },
    });

    expect(result.residual).toBe(1);
    expect(result.verdict).toBe("wrong_language");
  });

  test("declined concept exposure is scored before owner display", () => {
    const result = evaluateOwnerRendering({
      rendered_message: "Lead with a low-context tool-first message to David.",
      owner_profile: {
        declined_concepts: ["low-context tool-first message"],
        exposed_concepts: { enterprise_transformation: { exposure_count: 3 } },
      },
    });

    expect(result.residual).toBe(1);
    expect(result.verdict).toBe("exposes_declined_concept");
  });

  test("missing draft and profile degrade gracefully", () => {
    const result = evaluateOwnerRendering({});
    expect(result.residual).toBeLessThan(0.3);
    expect(result.verdict).toBe("clean");
    expect(result.breakdown.empty_draft).toBe(0);
  });
});
