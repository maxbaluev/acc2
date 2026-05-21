// runtime/closure_audit substrate-truth gate tests — T0.1.
//
// Brain dispatch TFZ6AJXNPS6655QMFWT6KPB3QM, amendment
// ZC7HF4Y3HN1BK91FXVQE77S4GC. Pin the substrate-truth gate at the
// closure-audit boundary so the k_252 advisory-gate fake — brain
// emitting checks={all_true} for amendments it never wrote — cannot
// silently lower closure_residual past the commit gate.
//
// Test surface:
//   (a) target_files declared + asserted_residual < 0.3 + zero
//       matching contract_amendment_proposed → closure_blocked_no_amendments
//       emitted, residual bumped to 1.0, substrate_verifications.
//       target_files_have_amendments.verified = false.
//   (b) target_files declared + at least one matching amendment →
//       verification passes, residual ≤ asserted (substrate confirms).
//   (c) No target_files declared → backwards-compat path; the new
//       gate stays silent and residual falls back to the brain's
//       assertion.
//   (d) brain_claims and substrate_verifications disagree →
//       discrepancies array populated.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import { evaluateClosureCommitGate, verifyClosureAudit } from "./closure_audit";
import { invalidateThresholdCache, seedThresholdPredicate } from "./threshold_registry";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const DIRECTIVE = "d_t01_closure_truth";
const TASK = "t_t01_closure_truth";

describe("verifyClosureAudit — T0.1 substrate-truth gate", () => {
  test("(a) target_files declared, residual<0.3, no amendments → blocked + residual=1.0", () => {
    const db = openDb(":memory:");
    const result = verifyClosureAudit(db, {
      directive_id: DIRECTIVE,
      task_id: TASK,
      closure_predicate: { target_files: ["runtime/closure_audit.ts", "cli/observe.ts"] },
      brain_claims: { all_tests_pass: true, ledger_emits_expected_kinds: true },
      asserted_residual: 0.08,
    });
    expect(result.blocked).toBe(true);
    expect(result.emitted_event_ids).toHaveLength(1);
    expect(result.payload.closure_residual).toBe(1.0);
    expect(result.payload.asserted_residual).toBe(0.08);
    const verifications = result.payload.substrate_verifications as Record<string, { verified: boolean; evidence_event_ids: string[]; query: string }>;
    expect(verifications.target_files_have_amendments.verified).toBe(false);
    expect(verifications.target_files_have_amendments.evidence_event_ids).toEqual([]);
    expect(verifications.target_files_have_amendments.query).toContain("contract_amendment_proposed");
    // The closure_blocked_no_amendments event landed on the ledger.
    const row = db
      .query<{ payload: string }, [string]>("SELECT payload FROM events WHERE id = ?")
      .get(result.emitted_event_ids[0]);
    expect(row).toBeTruthy();
    const refusalPayload = JSON.parse(row!.payload) as Record<string, unknown>;
    expect(refusalPayload.reason).toBe("no_contract_amendment_for_declared_target_files");
    expect(refusalPayload.residual).toBe(1.0);
    expect(refusalPayload.asserted_residual).toBe(0.08);
    expect(refusalPayload.target_files).toEqual(["repo:runtime/closure_audit.ts", "repo:cli/observe.ts"]);
  });

  test("(b) target_files declared with matching amendment → verified, residual passes", () => {
    const db = openDb(":memory:");
    // Seed a contract_amendment_proposed targeting one of the files.
    emitEvent(db, {
      kind: "contract_amendment_proposed",
      substrate_origin: "brain",
      directive_id: DIRECTIVE,
      task_id: TASK,
      payload: {
        target_resource: "repo:runtime/closure_audit.ts",
        proposed_behavior: "register substrate-truth gate",
      },
    });
    const result = verifyClosureAudit(db, {
      directive_id: DIRECTIVE,
      task_id: TASK,
      closure_predicate: { target_files: ["runtime/closure_audit.ts"] },
      brain_claims: { all_tests_pass: true },
      asserted_residual: 0.05,
    });
    expect(result.blocked).toBe(false);
    expect(result.emitted_event_ids).toEqual([]);
    const verifications = result.payload.substrate_verifications as Record<string, { verified: boolean; evidence_event_ids: string[] }>;
    expect(verifications.target_files_have_amendments.verified).toBe(true);
    expect(verifications.target_files_have_amendments.evidence_event_ids).toHaveLength(1);
    // residual derivation rule: any failed verification → 1.0. The
    // amendments check passed but `all_tests_pass` has no substrate-side
    // query, so it lands as verified=false → residual = 1.0. This is
    // the canonical fail-closed shape — only substrate-verified checks
    // can drop residual to 0.
    expect(result.payload.closure_residual).toBe(1.0);
    // Discrepancy: brain says all_tests_pass=true, substrate says
    // verified=false (no query to verify with).
    expect(result.payload.discrepancies).toContain("all_tests_pass");
  });

  test("(b2) bare path target_files also match (no `repo:` prefix required on input)", () => {
    const db = openDb(":memory:");
    // Amendment payload also uses a bare path. Normalization should
    // make both sides agree.
    emitEvent(db, {
      kind: "contract_amendment_proposed",
      substrate_origin: "brain",
      directive_id: DIRECTIVE,
      task_id: TASK,
      payload: { target_resource: "repo:runtime/closure_audit.ts" },
    });
    const result = verifyClosureAudit(db, {
      directive_id: DIRECTIVE,
      task_id: TASK,
      closure_predicate: { target_files: ["./runtime/closure_audit.ts"] },
      asserted_residual: 0.1,
    });
    const verifications = result.payload.substrate_verifications as Record<string, { verified: boolean }>;
    expect(verifications.target_files_have_amendments.verified).toBe(true);
    expect(result.blocked).toBe(false);
  });

  test("(c) no target_files declared → backwards-compat: residual = asserted", () => {
    const db = openDb(":memory:");
    const result = verifyClosureAudit(db, {
      directive_id: DIRECTIVE,
      task_id: TASK,
      asserted_residual: 0.12,
      legacy_fields: { summary: "no predicate declared", verdict: "audited" },
    });
    expect(result.blocked).toBe(false);
    expect(result.emitted_event_ids).toEqual([]);
    // No checks declared, no substrate verifications — the gate has
    // nothing to refute. Residual falls back to the brain's assertion.
    expect(result.payload.closure_residual).toBe(0.12);
    expect(result.payload.asserted_residual).toBe(0.12);
    // Legacy fields preserved on the augmented payload.
    expect(result.payload.summary).toBe("no predicate declared");
    expect(result.payload.verdict).toBe("audited");
    // Substrate_verifications still stamped (empty object) so readers
    // can branch on presence.
    expect(result.payload.substrate_verifications).toEqual({});
    expect(result.payload.brain_claims).toEqual({});
    expect(result.payload.discrepancies).toEqual([]);
  });

  test("(d) brain_claims and substrate_verifications disagree → discrepancies populated", () => {
    const db = openDb(":memory:");
    // No amendments seeded; brain claims target_files_have_amendments=true
    // (lying); residual < 0.3 triggers the hard precondition which sets
    // substrate_verifications.target_files_have_amendments = false.
    const result = verifyClosureAudit(db, {
      directive_id: DIRECTIVE,
      task_id: TASK,
      closure_predicate: { target_files: ["runtime/foo.ts"] },
      brain_claims: { target_files_have_amendments: true, secondary_check: false },
      asserted_residual: 0.05,
    });
    expect(result.blocked).toBe(true);
    expect(result.payload.discrepancies).toContain("target_files_have_amendments");
    // secondary_check: brain says false, substrate says verified=false (no
    // query) — values AGREE so it should NOT appear in discrepancies.
    expect(result.payload.discrepancies).not.toContain("secondary_check");
  });

  test("(e) asserted_residual ≥ 0.3 → hard precondition does NOT fire even with target_files", () => {
    const db = openDb(":memory:");
    // Brain says the closure already failed (residual ≥ 0.3). The
    // substrate-truth gate is anchored on the brain CLAIMING a pass — if
    // the brain self-reports failure, the gate stays out of the way.
    const result = verifyClosureAudit(db, {
      directive_id: DIRECTIVE,
      task_id: TASK,
      closure_predicate: { target_files: ["runtime/foo.ts"] },
      asserted_residual: 0.7,
    });
    expect(result.blocked).toBe(false);
    expect(result.emitted_event_ids).toEqual([]);
    // No substrate checks ran (no brain_claims, no hard-precondition
    // trip) → residual falls back to assertion.
    expect(result.payload.closure_residual).toBe(0.7);
  });

  describe("leniency narrowing — only modern closure_predicate summaries are bumped", () => {
    test("modern closure_predicate + no verifiable structure + asserts <0.3 → bumped to 0.3", () => {
      const db = openDb(":memory:");
      const r = verifyClosureAudit(db, {
        directive_id: "d_modern_summary", task_id: "t1",
        closure_predicate: { verifier_kind: "deterministic_code" },
        brain_claims: {}, asserted_residual: 0.08, raw_claim_count: 0,
      });
      expect(r.payload.closure_residual).toBe(0.3);
    });

    test("legacy no closure_predicate + no verifiable structure → preserves asserted residual", () => {
      const db = openDb(":memory:");
      const r = verifyClosureAudit(db, {
        directive_id: "d_legacy_summary", task_id: "t2",
        brain_claims: {}, asserted_residual: 0.1, raw_claim_count: 0,
      });
      expect(r.payload.closure_residual).toBe(0.1);
    });

    test("structured closure_predicate with matching amendment → derives from substrate verification", () => {
      const db = openDb(":memory:");
      emitEvent(db, {
        kind: "contract_amendment_proposed",
        substrate_origin: "brain",
        directive_id: "d_structured",
        task_id: "t3",
        payload: { target_resource: "repo:runtime/foo.ts", proposed_behavior: "wire something" },
      });
      const r = verifyClosureAudit(db, {
        directive_id: "d_structured", task_id: "t3",
        closure_predicate: { target_files: ["runtime/foo.ts"] },
        asserted_residual: 0.05, raw_claim_count: 0,
      });
      expect(r.payload.closure_residual).toBe(0);
    });
  });
});
