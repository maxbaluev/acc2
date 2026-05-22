import { describe, expect, test } from "bun:test";
import { evaluateOrchestratorPredicate } from "./orchestrator_predicate";

// Post-db0788e reality: the seven rule-based owner-alignment evaluators were
// collapsed into ONE unified owner_alignment gate (their evaluator code
// deleted). cli/apply.ts projects a single owner_alignment sub-predicate row
// into this predicate; the orchestrator predicate evaluates that live boundary
// and leans the blocking decision on the scored residual + breakdown, NOT on a
// fixed verdict-name Set populated by removed subsystems (RLM-first).
const cleanResult = {
  owner_alignment: { name: "owner_alignment", residual: 0.05, verdict: "aligned", reasons: ["within_autonomy_envelope"] },
};

describe("evaluateOrchestratorPredicate", () => {
  test("allows autonomous apply when the unified owner_alignment boundary is clean", () => {
    const result = evaluateOrchestratorPredicate({
      candidate_route: "AUTO_APPLY",
      sub_predicate_results: cleanResult,
      candidate_orchestration: {
        boundary_order: ["owner_alignment"],
        selected_boundaries: ["owner_alignment"],
      },
    });

    expect(result.residual).toBeLessThan(0.3);
    expect(result.verdict).toBe("aligned");
    expect(result.recommended_route).toBe("AUTO_APPLY");
  });

  test("recycles when the owner_alignment boundary has a blocking residual", () => {
    const result = evaluateOrchestratorPredicate({
      candidate_route: "AUTO_APPLY",
      sub_predicate_results: {
        owner_alignment: { name: "owner_alignment", residual: 0.72, verdict: "misaligned", reasons: ["residual_exceeds_autonomy_threshold"] },
      },
      candidate_orchestration: { selected_boundaries: ["owner_alignment"] },
    });

    expect(result.residual).toBeGreaterThanOrEqual(0.6);
    expect(result.verdict).toBe("misaligned");
    expect(result.recommended_route).toBe("NEEDS_BRAIN_RECYCLE");
    expect(result.reasons.join("\n")).toContain("owner_alignment");
  });

  test("a misaligned verdict alone forces a blocking residual regardless of the numeric residual", () => {
    // RLM-first: misaligned is the one verdict the live predicate emits, and it
    // signals a hard owner-constraint / threshold breach — it must block even
    // if the numeric residual field is understated.
    const result = evaluateOrchestratorPredicate({
      candidate_route: "AUTO_APPLY",
      sub_predicate_results: {
        owner_alignment: { name: "owner_alignment", residual: 0.1, verdict: "misaligned", reasons: ["owner_hard_constraint:never_force_push"] },
      },
      candidate_orchestration: { selected_boundaries: ["owner_alignment"] },
    });

    expect(result.breakdown.blocking_verdict).toBe(1);
    expect(result.residual).toBeGreaterThanOrEqual(0.6);
    expect(result.recommended_route).toBe("NEEDS_BRAIN_RECYCLE");
  });

  test("routes to owner gate on a watch-band residual derived from the score, not a verdict name", () => {
    const result = evaluateOrchestratorPredicate({
      candidate_route: "AUTO_APPLY",
      sub_predicate_results: {
        owner_alignment: { name: "owner_alignment", residual: 0.45, verdict: "aligned", reasons: ["partial_envelope"] },
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

  test("dead verdicts from removed subsystems no longer block", () => {
    // violates_avoided_term / wrong_language / exposes_declined_concept / drift /
    // order_mismatch are gone — nothing live emits them, so a row carrying one
    // of these legacy names with a low residual must NOT be treated as blocking.
    for (const deadVerdict of ["violates_avoided_term", "wrong_language", "exposes_declined_concept", "drift", "order_mismatch"]) {
      const result = evaluateOrchestratorPredicate({
        candidate_route: "AUTO_APPLY",
        sub_predicate_results: {
          owner_alignment: { name: "owner_alignment", residual: 0.05, verdict: deadVerdict, reasons: [deadVerdict] },
        },
        candidate_orchestration: { selected_boundaries: ["owner_alignment"] },
      });
      expect(result.breakdown.blocking_verdict).toBe(0);
      expect(result.recommended_route).toBe("AUTO_APPLY");
    }
  });
});
