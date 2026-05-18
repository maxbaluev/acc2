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
  test("audience=undefined now applies the system_meta predicate by default (F2 inversion)", () => {
    // Pre-F2 the gate skipped when audience was unset; that meant
    // letter v3 shipped through with "the system" hits. Post-F2 the
    // system_meta predicate runs by default; the buyer-class
    // predicates (friction, modest, hyphen-jargon, version-markers)
    // still use denylist scoping, so this test asserts via the
    // system_meta phrase that fires on audience=null.
    const db = openDb(":memory:");
    const result = runPredicateGate(db, {
      audience: undefined,
      body: "the system handled this trivially.",
    });
    expect(result.residual).toBe(1.0);
    expect(result.rejected).toBe(true);
    expect(result.matches.some((m) => m.matched_text.toLowerCase() === "the system")).toBe(true);
  });

  test("audience=internal_diagnostic remains explicitly exempt", () => {
    const db = openDb(":memory:");
    const result = runPredicateGate(db, {
      audience: "internal_diagnostic",
      body: "Significant friction in the pipeline; the substrate ate it.",
    });
    expect(result.residual).toBe(0);
    expect(result.rejected).toBe(false);
  });
});

describe("runPredicateGate — F2 audience-conditional predicates", () => {
  test("(a) ceo_buyer + 'the system' body → reject (default predicate applies)", () => {
    const db = openDb(":memory:");
    const result = runPredicateGate(db, {
      audience: "ceo_buyer",
      body: "the system handled the order end-to-end without manual touch.",
    });
    expect(result.rejected).toBe(true);
    expect(result.residual).toBe(1.0);
    const matched = result.matches.map((m) => m.matched_text.toLowerCase());
    expect(matched).toContain("the system");
  });

  test("(b) cofounder_technical_reviewer + 'the system' body → pass (allowlist exempt)", () => {
    const db = openDb(":memory:");
    const result = runPredicateGate(db, {
      audience: "cofounder_technical_reviewer",
      body: "the system handled the order end-to-end without manual touch.",
    });
    // The "the system" predicate is allowlisted for this audience; no
    // other predicate matches this body, so the gate passes.
    const systemHits = result.matches.filter(
      (m) => m.matched_text.toLowerCase() === "the system",
    );
    expect(systemHits.length).toBe(0);
    expect(result.rejected).toBe(false);
  });

  test("(c) audience=null + 'the system' body → reject (default applies)", () => {
    const db = openDb(":memory:");
    const result = runPredicateGate(db, {
      audience: null,
      body: "the system handled the order end-to-end without manual touch.",
    });
    expect(result.rejected).toBe(true);
    expect(result.residual).toBe(1.0);
    const matched = result.matches.map((m) => m.matched_text.toLowerCase());
    expect(matched).toContain("the system");
  });

  test("substrate_self_identification audience is also in the allowlist for 'the system'", () => {
    const db = openDb(":memory:");
    const result = runPredicateGate(db, {
      audience: "substrate_self_identification",
      body: "the system signed this letter.",
    });
    const systemHits = result.matches.filter(
      (m) => m.matched_text.toLowerCase() === "the system",
    );
    expect(systemHits.length).toBe(0);
  });
});
