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

  test("degrades to the owner gate (NOT AUTO_APPLY) when prior gates provide no detailed predicate rows", () => {
    // Missing required boundary = unevaluated owner alignment. The gate must
    // surface that to the owner rather than silently auto-applying (k_252).
    const result = evaluateOrchestratorPredicate({ candidate_route: "AUTO_APPLY" });

    expect(result.residual).toBeGreaterThanOrEqual(0.3);
    expect(result.residual).toBeLessThan(0.6);
    expect(result.verdict).toBe("watch");
    expect(result.recommended_route).toBe("OWNER_GATE");
    expect(result.breakdown.coverage_gap).toBe(1); // honest full-missing ratio
    expect(result.breakdown.absence_floor).toBe(0.5);
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

  test("fails closed when the required owner_alignment boundary is absent (no fail-open AUTO_APPLY)", () => {
    // No sub_predicate_results at all → the gate has zero owner-alignment
    // evidence. The earlier coverage formula collapsed this to residual ~0.08
    // (verdict "aligned" → AUTO_APPLY): an apply auto-committed without ANY
    // owner-alignment evaluation (k_252 advisory-not-hard). It must now route
    // to the owner gate, never AUTO_APPLY.
    const result = evaluateOrchestratorPredicate({
      candidate_route: "AUTO_APPLY",
      candidate_orchestration: { selected_boundaries: [], boundary_order: [] },
    });
    expect(result.recommended_route).not.toBe("AUTO_APPLY");
    expect(result.recommended_route).toBe("OWNER_GATE");
    expect(result.residual).toBeGreaterThanOrEqual(0.3);
    expect(result.breakdown.absence_floor).toBe(0.5);
    expect(result.breakdown.coverage_gap).toBe(1); // honest: boundary fully missing
  });

  test("present boundary carries no absence floor", () => {
    const result = evaluateOrchestratorPredicate({
      candidate_route: "AUTO_APPLY",
      sub_predicate_results: cleanResult,
      candidate_orchestration: { selected_boundaries: ["owner_alignment"] },
    });
    expect(result.breakdown.absence_floor).toBe(0);
    expect(result.recommended_route).toBe("AUTO_APPLY");
  });

  // ── Owner-safety gate (runaway-dispatch guard) ──────────────────────
  // The unified forecast+autonomy loop routes forecast-originated candidate
  // actions through this predicate. An IRREVERSIBLE or HIGH-RISK forecast must
  // ALWAYS surface to the owner — it can never silently AUTO_APPLY, regardless
  // of how clean the owner_alignment sub-predicate looks. These tests pin that
  // structural floor so the loop cannot auto-execute owner-sensitive actions.

  test("owner-safety: an IRREVERSIBLE forecast NEVER auto-executes — it surfaces to the owner even with a perfectly clean alignment boundary", () => {
    const result = evaluateOrchestratorPredicate({
      candidate_route: "AUTO_APPLY",
      // Alignment is maximally clean — the ONLY blocking signal is reversibility.
      sub_predicate_results: cleanResult,
      proposed_action: {
        intent: "send_irreversible_outreach",
        reversible: false,
      },
      candidate_orchestration: { selected_boundaries: ["owner_alignment"] },
    });
    expect(result.breakdown.irreversibility_floor).toBe(1);
    expect(result.residual).toBeGreaterThanOrEqual(0.6);
    // Does NOT auto-execute — routes off AUTO_APPLY so the loop surfaces it.
    expect(result.recommended_route).not.toBe("AUTO_APPLY");
  });

  test("owner-safety: a HIGH-RISK forecast does not auto-execute — it floors into at least the owner-gate band", () => {
    const result = evaluateOrchestratorPredicate({
      candidate_route: "AUTO_APPLY",
      sub_predicate_results: cleanResult,
      proposed_action: {
        intent: "high_risk_forecast_action",
        reversible: true,
        risk: 0.8,
      },
      candidate_orchestration: { selected_boundaries: ["owner_alignment"] },
    });
    expect(result.breakdown.high_risk_floor).toBe(0.6);
    expect(result.residual).toBeGreaterThanOrEqual(0.6);
    expect(result.recommended_route).not.toBe("AUTO_APPLY");
  });

  test("owner-safety regression: a REVERSIBLE, low-risk, well-aligned forecast still auto-applies (the floor only trips on the explicit irreversible/high-risk flag)", () => {
    const result = evaluateOrchestratorPredicate({
      candidate_route: "AUTO_APPLY",
      sub_predicate_results: cleanResult,
      proposed_action: {
        intent: "reversible_forecast_action",
        reversible: true,
        risk: 0.1,
      },
      candidate_orchestration: { selected_boundaries: ["owner_alignment"] },
    });
    expect(result.breakdown.irreversibility_floor).toBe(0);
    expect(result.breakdown.high_risk_floor).toBe(0);
    expect(result.recommended_route).toBe("AUTO_APPLY");
  });

  test("owner-safety: undefined reversibility is treated conservatively as reversible (no floor) so existing reversible-by-default applies are unaffected", () => {
    const result = evaluateOrchestratorPredicate({
      candidate_route: "AUTO_APPLY",
      sub_predicate_results: cleanResult,
      proposed_action: { intent: "unspecified_reversibility" },
      candidate_orchestration: { selected_boundaries: ["owner_alignment"] },
    });
    expect(result.breakdown.irreversibility_floor).toBe(0);
    expect(result.recommended_route).toBe("AUTO_APPLY");
  });
});
