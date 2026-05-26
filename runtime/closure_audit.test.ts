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

  describe("owner-facing deliverable body reread", () => {
    const seedArtifact = (db: ReturnType<typeof openDb>, id: string, body: string, kind = "report_body", supersedes: string | null = null) => {
      db.run(
        `INSERT INTO act_artifact (id, runtime, kind, body, supersedes, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, ?, ?)`,
        [id, kind, body, supersedes, "2026-05-25T00:00:00.000Z", "2026-05-25T00:00:00.000Z"],
      );
    };

    test("summary-only owner-facing report closure cannot pass below threshold", () => {
      const db = openDb(":memory:");
      const r = verifyClosureAudit(db, {
        directive_id: "d_owner_report_summary_only",
        task_id: "t_owner_report_summary_only",
        closure_predicate: {
          verifier_kind: "owner_facing_report",
          owner_facing_deliverable: true,
          deliverable_kind: "report_body",
          acceptance_criteria: ["CEO Q&A", "90-day plan"],
        },
        asserted_residual: 0.05,
        raw_claim_count: 0,
      });
      expect(r.blocked).toBe(true);
      expect(r.payload.closure_residual).toBe(1.0);
      expect(r.payload.inspected_artifact_ids).toEqual([]);
      expect(r.payload.independent_deliverable_body_reread).toBe(false);
      expect(r.payload.body_source_kind).toBe("missing");
      expect(r.payload.failure_axes).toEqual(expect.objectContaining({ missing_artifact_ids: expect.any(String) }));
      const verifications = r.payload.substrate_verifications as Record<string, { verified: boolean }>;
      expect(verifications.owner_facing_deliverable_body_inspected.verified).toBe(false);
    });

    test("body-read owner-facing report closure can pass and stamps artifact evidence", () => {
      const db = openDb(":memory:");
      seedArtifact(db, "report_body_ok", "Final report\nCEO Q&A connected to the recommendations.\n90-day plan included.");
      const r = verifyClosureAudit(db, {
        directive_id: "d_owner_report_body_read",
        task_id: "t_owner_report_body_read",
        closure_predicate: {
          verifier_kind: "owner_facing_report",
          owner_facing_deliverable: true,
          deliverable_kind: "report_body",
          deliverable_artifact_ids: ["report_body_ok"],
          acceptance_criteria: ["CEO Q&A", "90-day plan"],
        },
        asserted_residual: 0.05,
        raw_claim_count: 0,
      });
      expect(r.blocked).toBe(false);
      expect(r.payload.closure_residual).toBe(0);
      expect(r.payload.inspected_artifact_ids).toEqual(["report_body_ok"]);
      expect(r.payload.independent_deliverable_body_reread).toBe(true);
      expect(r.payload.body_source_kind).toBe("act_artifact.body");
      expect(r.payload.failure_axes).toEqual({});
      const verifications = r.payload.substrate_verifications as Record<string, { verified: boolean; evidence_event_ids: string[] }>;
      expect(verifications.owner_facing_deliverable_body_inspected.verified).toBe(true);
      expect(verifications.owner_facing_deliverable_body_inspected.evidence_event_ids).toEqual(["report_body_ok"]);
    });
  });


  describe("grounded convergence reality surfaces", () => {
    const seedRenderedArtifact = (db: ReturnType<typeof openDb>, id: string, body: string, kind = "rendered_docx") => {
      db.run(
        "INSERT INTO act_artifact (id, runtime, kind, body, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, ?)",
        [id, kind, body, "2026-05-25T00:00:00.000Z", "2026-05-25T00:00:00.000Z"],
      );
    };

    test("required reality surfaces reject summary-only closure", () => {
      const db = openDb(":memory:");
      const r = verifyClosureAudit(db, {
        directive_id: "d_reality_missing",
        task_id: "t_reality_missing",
        closure_predicate: { required_reality_surfaces: ["git_clean", "tests_passed", "queue_drain_trend"] },
        asserted_residual: 0.05,
        raw_claim_count: 0,
      });
      expect(r.blocked).toBe(true);
      expect(r.payload.closure_residual).toBe(1.0);
      const verifications = r.payload.substrate_verifications as Record<string, { verified: boolean; evidence_event_ids: string[] }>;
      expect(verifications.reality_surface_git_clean.verified).toBe(false);
      expect(verifications.reality_surface_tests_passed.verified).toBe(false);
      expect(verifications.reality_surface_queue_drain_trend.verified).toBe(false);
      expect(r.payload.failure_axes).toEqual(expect.objectContaining({
        reality_surface_git_clean: "missing reality evidence",
        reality_surface_tests_passed: "missing reality evidence",
      }));
    });

    test("contradictory repo/test reality blocks a passing ledger claim", () => {
      const db = openDb(":memory:");
      emitEvent(db, {
        kind: "state_snapshot_recorded",
        substrate_origin: "runtime",
        directive_id: "d_reality_dirty",
        task_id: "t_reality_dirty",
        payload: { snapshot_kind: "git_status", git: { clean: false } },
      });
      emitEvent(db, {
        kind: "action_scored",
        substrate_origin: "substrate_auto",
        directive_id: "d_reality_dirty",
        task_id: "t_reality_dirty",
        residual: 0.8,
        outcome: "failed",
        payload: { verifier_kind: "bun_test" },
      });
      const r = verifyClosureAudit(db, {
        directive_id: "d_reality_dirty",
        task_id: "t_reality_dirty",
        closure_predicate: { required_reality_surfaces: ["git_clean", "tests_passed"] },
        brain_claims: { reality_surface_git_clean: true, reality_surface_tests_passed: true },
        asserted_residual: 0.05,
      });
      expect(r.blocked).toBe(true);
      expect(r.payload.closure_residual).toBe(1.0);
      expect(r.payload.discrepancies).toEqual(expect.arrayContaining(["reality_surface_git_clean", "reality_surface_tests_passed"]));
    });

    test("all requested reality surfaces can pass with independent evidence", () => {
      const db = openDb(":memory:");
      seedRenderedArtifact(db, "rendered_ok", "native rendered body");
      emitEvent(db, { kind: "state_snapshot_recorded", substrate_origin: "runtime", directive_id: "d_reality_ok", task_id: "t_reality_ok", payload: { snapshot_kind: "git_status", clean: true } });
      emitEvent(db, { kind: "action_scored", substrate_origin: "substrate_auto", directive_id: "d_reality_ok", task_id: "t_reality_ok", residual: 0.0, outcome: "succeeded", payload: { verifier_kind: "bun_test" } });
      emitEvent(db, { kind: "state_snapshot_recorded", substrate_origin: "runtime", directive_id: "d_reality_ok", task_id: "t_reality_ok", payload: { snapshot_kind: "ready_queue_trend", ready_before: 5, ready_after: 2 } });
      emitEvent(db, { kind: "owner_deliverable_published", substrate_origin: "runtime", directive_id: "d_reality_ok", task_id: "t_reality_ok", payload: { artifact_id: "rendered_ok" } });
      const r = verifyClosureAudit(db, {
        directive_id: "d_reality_ok",
        task_id: "t_reality_ok",
        closure_predicate: {
          required_reality_surfaces: ["git_clean", "tests_passed", "rendered_artifact", "owner_publication", "queue_drain_trend"],
          rendered_artifact_ids: ["rendered_ok"],
        },
        asserted_residual: 0.05,
        raw_claim_count: 0,
      });
      expect(r.blocked).toBe(false);
      expect(r.payload.closure_residual).toBe(0);
      expect(r.payload.failure_axes).toEqual({});
      const verifications = r.payload.substrate_verifications as Record<string, { verified: boolean }>;
      expect(Object.values(verifications).every((v) => v.verified)).toBe(true);
    });
  });
});

// ── Amendment D7GJDRYT — closure provenance ────────────────────────
import { normalizeClosureAuditPayload, isClosureCommitEligible } from "./closure_audit";

describe("closure provenance (amendment D7GJDRYT)", () => {
  const emitAudit = (db: ReturnType<typeof openDb>, payload: Record<string, unknown>, contextRefs: string[] = []) =>
    emitEvent(db, {
      kind: "task_closure_audited",
      substrate_origin: "brain",
      directive_id: "dir_prov",
      task_id: "root_prov",
      context_refs: contextRefs,
      payload,
    });

  const selectLatest = (db: ReturnType<typeof openDb>) => {
    const row = db.query("SELECT id, ts, task_id, payload, context_refs FROM events WHERE kind = 'task_closure_audited' ORDER BY ts DESC, rowid DESC LIMIT 1").get() as { id: string; ts: string; task_id: string; payload: string; context_refs: string };
    return normalizeClosureAuditPayload(db, row);
  };

  test("a HISTORICAL row with no residual_provenance parses as legacy_unknown and is NOT commit-eligible even at residual 0.05", () => {
    const db = openDb(":memory:");
    // Simulate a PRE-amendment historical row: the emit boundary now stamps
    // provenance, so legacy_unknown only applies to rows already in the
    // ledger without the field. Normalize a synthetic raw row directly.
    const sel = normalizeClosureAuditPayload(db, {
      id: "legacy_audit_1",
      ts: "2026-01-01T00:00:00.000Z",
      task_id: "root_legacy",
      payload: JSON.stringify({ closure_residual: 0.05 }),
      context_refs: null,
    })!;
    expect(sel.residual_provenance).toBe("legacy_unknown");
    expect(sel.commit_eligible).toBe(false);
    expect(isClosureCommitEligible(db, sel)).toBe(false);
    expect(sel.ineligible_reason).toBe("legacy_unknown_provenance");
  });

  test("a freshly EMITTED bare-residual audit is stamped self_reported by the emit boundary (not legacy)", () => {
    const db = openDb(":memory:");
    emitAudit(db, { closure_residual: 0.05 });
    const sel = selectLatest(db)!;
    expect(sel.residual_provenance).toBe("self_reported");
    expect(isClosureCommitEligible(db, sel)).toBe(false);
  });

  test("self_reported low residual is NOT commit-eligible", () => {
    const db = openDb(":memory:");
    emitAudit(db, { closure_residual: 0.05, residual_provenance: "self_reported" });
    const sel = selectLatest(db)!;
    expect(sel.residual_provenance).toBe("self_reported");
    expect(isClosureCommitEligible(db, sel)).toBe(false);
    expect(sel.ineligible_reason).toBe("self_reported_provenance");
  });

  test("substrate_verified + reliability_profile + residual 0.1 IS commit-eligible", () => {
    const db = openDb(":memory:");
    emitAudit(db, { closure_residual: 0.1, residual_provenance: "substrate_verified", reliability_profile: { verifier_kind: "deterministic_code", pass_rate: 0.95 } });
    const sel = selectLatest(db)!;
    expect(sel.residual_provenance).toBe("substrate_verified");
    expect(isClosureCommitEligible(db, sel)).toBe(true);
    expect(sel.commit_eligible).toBe(true);
  });

  test("substrate_verified + cited action_scored tie IS commit-eligible without a reliability_profile", () => {
    const db = openDb(":memory:");
    const scored = emitEvent(db, { kind: "action_scored", substrate_origin: "substrate_auto", action_artifact_id: "art_x", verifier_artifact_id: "ver_x", residual: 0.1, payload: {} });
    expect((db.query("SELECT kind FROM events WHERE id = ?").get(scored.id) as { kind: string }).kind).toBe("action_scored");
    emitAudit(db, { closure_residual: 0.1, residual_provenance: "substrate_verified" }, [scored.id]);
    const sel = selectLatest(db)!;
    expect(sel.residual_provenance).toBe("substrate_verified");
    expect(sel.grounding_event_ids).toContain(scored.id);
    expect(isClosureCommitEligible(db, sel)).toBe(true);
  });

  test("substrate_verified low residual WITHOUT any grounding tie is NOT commit-eligible", () => {
    const db = openDb(":memory:");
    emitAudit(db, { closure_residual: 0.1, residual_provenance: "substrate_verified" });
    const sel = selectLatest(db)!;
    expect(isClosureCommitEligible(db, sel)).toBe(false);
    expect(sel.ineligible_reason).toBe("substrate_verified_without_grounding_tie");
  });

  test("commit gate REFUSES a low self_reported residual (records provenance discrepancy)", () => {
    const db = openDb(":memory:");
    emitEvent(db, { kind: "task_closure_audited", substrate_origin: "brain", directive_id: "dir_gate", task_id: "root_gate", residual: 0.05, payload: { closure_residual: 0.05, residual_provenance: "self_reported" } });
    const decision = evaluateClosureCommitGate(db, { task_id: "root_gate", directive_id: "dir_gate" });
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.discrepancies.some((d) => d.startsWith("closure_provenance_ineligible"))).toBe(true);
    }
  });

  test("commit gate ALLOWS a grounded substrate_verified low residual", () => {
    const db = openDb(":memory:");
    emitEvent(db, { kind: "task_closure_audited", substrate_origin: "substrate_auto", directive_id: "dir_ok", task_id: "root_ok", residual: 0.05, payload: { closure_residual: 0.05, residual_provenance: "substrate_verified", reliability_profile: { verified: true } } });
    const decision = evaluateClosureCommitGate(db, { task_id: "root_ok", directive_id: "dir_ok" });
    expect(decision.allow).toBe(true);
  });
});
