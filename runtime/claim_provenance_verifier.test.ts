// Tests for runtime/claim_provenance_verifier.ts — the deterministic,
// taste-free claim-provenance verifier.
//
// The keystone test models the real "Lakeland slop" derivation the owner
// flagged: a headline figure built on an invented 6% recovery-rate
// multiplier that appears in NO source. A taste-free verifier MUST catch it
// (residual above the 0.3 closure bar) without any LLM judgment.

import { describe, expect, test } from "bun:test";
import {
  verifyClaimProvenance,
  type NumericClaim,
} from "./claim_provenance_verifier";

describe("verifyClaimProvenance", () => {
  // 1. KEYSTONE / FALSIFIABLE — the Lakeland slop derivation.
  // "$15.779M x 6% = $0.947M" where the 6% recovery rate is invented.
  test("KEYSTONE: invented 6% recovery-rate multiplier FAILS (residual > 0.3)", () => {
    const claim: NumericClaim = {
      id: "lakeland_recovery",
      expression: "gross_profit_gap * recovery_rate_6pct",
      result: 0.947,
      inputs: [
        // grounded leaves of the derived gross_profit_gap
        {
          label: "fy26_rev",
          value: 192.648,
          source_uri: "https://www.sec.gov/cgi-bin/browse-edgar?fy26-10K",
        },
        {
          label: "fy25_margin",
          value: 0.4107,
          source_uri: "https://www.sec.gov/cgi-bin/browse-edgar?fy25-10K",
        },
        // derived input that bottoms out in the grounded leaves above
        {
          label: "gross_profit_gap",
          value: 15.779,
          derived_from: ["fy26_rev", "fy25_margin"],
        },
        // the INVENTED multiplier — appears in no source
        { label: "recovery_rate_6pct", value: 0.06, unsourced: true },
      ],
    };

    const res = verifyClaimProvenance([claim]);

    expect(res.residual).toBeGreaterThan(0.3); // FAILS the closure bar
    const flaggedLabels = res.breakdown.unsourced_inputs.map((u) => u.label);
    expect(flaggedLabels).toContain("recovery_rate_6pct");
    // the grounded inputs must NOT be flagged
    expect(flaggedLabels).not.toContain("gross_profit_gap");
    expect(flaggedLabels).not.toContain("fy26_rev");
  });

  // 2. CLEAN — every input has a real source and the arithmetic checks out.
  test("CLEAN: all inputs sourced + arithmetic correct PASSES (residual < 0.3)", () => {
    const claim: NumericClaim = {
      id: "fy26_gross_profit",
      expression: "fy26_revenue * fy25_margin",
      result: 192.648 * 0.4107,
      inputs: [
        {
          label: "fy26_revenue",
          value: 192.648,
          source_uri: "https://www.sec.gov/Archives/edgar/fy26-10K.htm",
        },
        {
          label: "fy25_margin",
          value: 0.4107,
          source_uri: "https://www.sec.gov/Archives/edgar/fy25-10K.htm",
        },
      ],
    };

    const res = verifyClaimProvenance([claim]);

    expect(res.residual).toBeLessThan(0.3); // PASSES
    expect(res.breakdown.unsourced_inputs).toHaveLength(0);
    expect(res.breakdown.arithmetic_errors).toHaveLength(0);
    expect(res.residual).toBe(0);
  });

  // 3. ARITHMETIC ERROR — inputs all sourced, but stated result is wrong.
  test("ARITHMETIC ERROR: sourced inputs but wrong result → arithmetic_errors non-empty, residual > 0", () => {
    const claim: NumericClaim = {
      id: "bad_math",
      expression: "rev * margin",
      result: 100, // wrong: 192.648 * 0.4107 ≈ 79.12
      inputs: [
        {
          label: "rev",
          value: 192.648,
          source_uri: "https://www.sec.gov/fy26-10K.htm",
        },
        {
          label: "margin",
          value: 0.4107,
          source_uri: "https://www.sec.gov/fy25-10K.htm",
        },
      ],
    };

    const res = verifyClaimProvenance([claim]);

    expect(res.breakdown.arithmetic_errors).not.toHaveLength(0);
    expect(res.breakdown.arithmetic_errors[0].claim_id).toBe("bad_math");
    expect(res.breakdown.arithmetic_errors[0].got).toBe(100);
    expect(res.residual).toBeGreaterThan(0);
    // inputs were sourced, so the only contribution is the arithmetic error
    expect(res.breakdown.unsourced_inputs).toHaveLength(0);
  });

  // 4. DERIVED CHAIN — derived_from grounded inputs is valid; derived_from an
  //    unsourced input is invalid.
  test("DERIVED CHAIN: grounded chain is valid (low residual)", () => {
    const claim: NumericClaim = {
      id: "valid_chain",
      expression: "leaf_a + leaf_b",
      result: 30,
      inputs: [
        {
          label: "leaf_a",
          value: 10,
          source_uri: "https://src/a",
        },
        {
          label: "leaf_b",
          value: 20,
          source_uri: "https://src/b",
        },
        // derived from two grounded leaves → grounded
        { label: "sum_ab", value: 30, derived_from: ["leaf_a", "leaf_b"] },
      ],
    };

    const res = verifyClaimProvenance([claim]);

    expect(res.residual).toBeLessThan(0.3);
    expect(res.breakdown.unsourced_inputs).toHaveLength(0);
  });

  test("DERIVED CHAIN: chain bottoming out in an unsourced input is invalid (high residual)", () => {
    const claim: NumericClaim = {
      id: "tainted_chain",
      expression: "grounded_leaf * derived_from_invented",
      result: 5,
      inputs: [
        {
          label: "grounded_leaf",
          value: 10,
          source_uri: "https://src/real",
        },
        // invented at the bottom of the chain
        { label: "invented_base", value: 0.5, unsourced: true },
        // derived_from the invented input → taint propagates → invalid
        {
          label: "derived_from_invented",
          value: 0.5,
          derived_from: ["invented_base"],
        },
      ],
    };

    const res = verifyClaimProvenance([claim]);

    expect(res.residual).toBeGreaterThan(0.3);
    const flagged = res.breakdown.unsourced_inputs.map((u) => u.label);
    // both the invented base AND the input derived from it are flagged
    expect(flagged).toContain("invented_base");
    expect(flagged).toContain("derived_from_invented");
    expect(flagged).not.toContain("grounded_leaf");
  });
});
