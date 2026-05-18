// acc2 predicate_gate verifier tests — C1 (2026-05-18, contract
// DXQK3VYMCH7930TP20H4QSTP0R). Covers the gated-audience pass/fail
// paths and the skip paths for non-gated audiences.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../../substrate/db";
import { runPredicateGate } from "./predicate_gate";

afterAll(() => closeDb());
beforeEach(() => closeDb());

describe("runPredicateGate — gated audience", () => {
  test("clean body returns residual=0 and rejected=false", () => {
    const db = openDb(":memory:");
    const result = runPredicateGate(db, {
      audience: "ceo_buyer",
      body: "Clean proposal text with nothing banned in it whatsoever.",
    });
    expect(result.residual).toBe(0);
    expect(result.rejected).toBe(false);
    expect(result.matches.length).toBe(0);
    expect(result.citedKnowledgeIds.length).toBe(0);
  });

  test("body containing 'friction' returns residual=1.0 and rejected=true", () => {
    const db = openDb(":memory:");
    const result = runPredicateGate(db, {
      audience: "ceo_buyer",
      body: "This change reduces friction across the partner pipeline.",
    });
    expect(result.residual).toBe(1.0);
    expect(result.rejected).toBe(true);
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0]!.matched_text.toLowerCase()).toBe("friction");
    expect(result.citedKnowledgeIds).toContain("alex_predicate_xkc5n4a66s13_no_friction");
  });

  test("body containing 'modest' is rejected by the vague-magnitude predicate", () => {
    const db = openDb(":memory:");
    const result = runPredicateGate(db, {
      audience: "ceo_buyer",
      body: "We observed modest improvement in batch throughput.",
    });
    expect(result.rejected).toBe(true);
    expect(result.residual).toBe(1.0);
    const matched = result.matches.map((m) => m.matched_text.toLowerCase());
    expect(matched).toContain("modest");
  });

  test("body containing multiple banned phrases returns all matches", () => {
    const db = openDb(":memory:");
    const result = runPredicateGate(db, {
      audience: "ceo_buyer",
      body: "Significant friction reduction with several substantial wins this quarter.",
    });
    expect(result.rejected).toBe(true);
    expect(result.matches.length).toBeGreaterThanOrEqual(3);
    const matched = result.matches.map((m) => m.matched_text.toLowerCase());
    expect(matched).toContain("friction");
    // The vague-magnitude predicate covers significant / several /
    // substantial so each lands its own match row.
    expect(matched.some((t) => ["significant", "several", "substantial"].includes(t))).toBe(true);
  });

  test("external_executive audience is also gated", () => {
    const db = openDb(":memory:");
    const result = runPredicateGate(db, {
      audience: "external_executive",
      body: "Significant friction reduction.",
    });
    expect(result.rejected).toBe(true);
    expect(result.residual).toBe(1.0);
  });
});

describe("runPredicateGate — skip paths", () => {
  test("audience=undefined skips the gate regardless of body content", () => {
    const db = openDb(":memory:");
    const result = runPredicateGate(db, {
      audience: undefined,
      body: "This text mentions friction modest substantial repeatedly.",
    });
    expect(result.residual).toBe(0);
    expect(result.rejected).toBe(false);
    expect(result.matches.length).toBe(0);
  });

  test("audience=internal_diagnostic skips the gate", () => {
    const db = openDb(":memory:");
    const result = runPredicateGate(db, {
      audience: "internal_diagnostic",
      body: "Significant friction in the pipeline; the substrate ate it.",
    });
    expect(result.residual).toBe(0);
    expect(result.rejected).toBe(false);
  });
});
