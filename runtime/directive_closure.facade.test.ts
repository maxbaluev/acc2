// Unified closure facade test (amendment DZK9A0R9150RKAMT8RXKKDD3TR).
//
// Proves the three closure surfaces collapse to ONE coherent entry surface:
// every closure decision symbol is importable from runtime/directive_closure.ts
// (the facade) and the facade-routed call produces byte-identical behavior to
// the internal module it delegates to. The preservation invariants that landed
// recently MUST survive the consolidation:
//   - the deliverable-compounding REGRESSION GATE still fails closure when a new
//     deliverable version drops a previously-satisfied requirement;
//   - the open-provenance fix still applies (provenance/verifier_kind/… claim
//     keys are NOT auto-marked verified:false and do NOT force residual → 1.0);
//   - the commit gate, residual-lineage selector, and deliverable helpers all
//     resolve through the single facade import path.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import type { Database } from "bun:sqlite";
import { insertArtifact } from "./artifact_store";
// EVERYTHING below is imported from the facade (directive_closure.ts), NOT from
// the three internal files. This is the load-bearing assertion of the
// consolidation: callers route through one closure import path.
import {
  // re-exported from closure_audit.ts
  verifyClosureAudit,
  evaluateClosureCommitGate,
  closureResidualsForLineage,
  selectCurrentRootClosureAudit,
  // re-exported from closure_deliverable_check.ts
  checkClosureDeliverables,
  closureDeliverablePressure,
  hasRealDocumentBody,
  // native to directive_closure.ts
  rootCommitReadiness,
  computeCoverage,
} from "./directive_closure";
// Pull the same symbols straight from the internal modules so we can assert the
// facade re-exports the IDENTICAL function references (zero behavioral drift).
import { verifyClosureAudit as verifyClosureAuditInternal } from "./closure_audit";
import { checkClosureDeliverables as checkClosureDeliverablesInternal } from "./closure_deliverable_check";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const insertDeliverableArtifact = (
  db: Database,
  id: string,
  body: string,
  supersedes?: string,
  supersededBy?: string,
) =>
  insertArtifact(db, {
    id,
    runtime: null,
    kind: "deliverable_body",
    body,
    declaredSandbox: null,
    stateRoot: null,
    posteriorAlpha: 1,
    posteriorBeta: 1,
    score: 0.5,
    confidence: 0.3,
    recentResidualMean: 0,
    recentKillCount: 0,
    status: "admitted",
    name: id,
    fixtureInput: null,
    fixtureExpectedResidual: null,
    supersedes: supersedes ?? null,
    supersededBy: supersededBy ?? null,
  });

describe("closure facade — single entry surface (DZK9A0R9150RKAMT8RXKKDD3TR)", () => {
  test("facade re-exports the IDENTICAL function references (no shim/copy drift)", () => {
    expect(verifyClosureAudit).toBe(verifyClosureAuditInternal);
    expect(checkClosureDeliverables).toBe(checkClosureDeliverablesInternal);
    // The full closure surface is reachable from the one module.
    expect(typeof evaluateClosureCommitGate).toBe("function");
    expect(typeof closureResidualsForLineage).toBe("function");
    expect(typeof selectCurrentRootClosureAudit).toBe("function");
    expect(typeof closureDeliverablePressure).toBe("function");
    expect(typeof hasRealDocumentBody).toBe("function");
    expect(typeof rootCommitReadiness).toBe("function");
    expect(typeof computeCoverage).toBe("function");
  });

  test("PRESERVED: regression gate fails closure when a new version drops a previously-satisfied requirement (via facade)", () => {
    const db = openDb(":memory:");
    insertDeliverableArtifact(db, "facade_v1", "Intro. Summary. Budget breakdown of 50000 USD. Timeline.", undefined, "facade_v2");
    insertDeliverableArtifact(db, "facade_v2", "Intro. Summary. Timeline. Risk analysis.", "facade_v1");

    const result = verifyClosureAudit(db, {
      directive_id: "dir_facade_reg",
      task_id: "task_facade_reg",
      asserted_residual: 0.05,
      closure_predicate: {
        owner_facing_deliverable: true,
        deliverable_artifact_ids: ["facade_v2"],
        acceptance_criteria: ["Risk analysis"],
        requirements_ledger: ["Risk analysis", "Budget breakdown of 50000 USD"],
        previously_satisfied_requirements: ["Budget breakdown of 50000 USD"],
      },
    });

    expect(result.blocked).toBe(true);
    expect(result.payload.closure_residual).toBe(1.0);
    const failureAxes = result.payload.failure_axes as Record<string, string>;
    expect(failureAxes.regressed_previously_satisfied_requirements).toContain("Budget breakdown of 50000 USD");
  });

  test("PRESERVED: regression gate passes when the new version preserves all previously-satisfied requirements (via facade)", () => {
    const db = openDb(":memory:");
    insertDeliverableArtifact(db, "facade2_v1", "Intro. Summary. Budget breakdown of 50000 USD. Timeline.", undefined, "facade2_v2");
    insertDeliverableArtifact(db, "facade2_v2", "Intro. Summary. Budget breakdown of 50000 USD. Timeline. Risk analysis.", "facade2_v1");

    const result = verifyClosureAudit(db, {
      directive_id: "dir_facade_ok",
      task_id: "task_facade_ok",
      asserted_residual: 0.05,
      closure_predicate: {
        owner_facing_deliverable: true,
        deliverable_artifact_ids: ["facade2_v2"],
        acceptance_criteria: ["Risk analysis"],
        requirements_ledger: ["Risk analysis", "Budget breakdown of 50000 USD"],
        previously_satisfied_requirements: ["Budget breakdown of 50000 USD"],
      },
    });

    expect(result.blocked).toBe(false);
    expect(result.payload.closure_residual).toBe(0);
  });

  test("PRESERVED: provenance/verifier_kind claim-keys do NOT gate closure (via facade)", () => {
    const db = openDb(":memory:");
    const result = verifyClosureAudit(db, {
      directive_id: "dir_facade_prov",
      task_id: "task_facade_prov",
      brain_claims: {
        verifier_kind: true,
        non_self_audit: true,
        independent_audit: true,
        peer_audit: true,
        audit_source: true,
        provenance: true,
      },
      asserted_residual: 0.08,
      legacy_fields: { summary: "passing audit with provenance labels" },
    });

    expect(result.blocked).toBe(false);
    // Provenance labels skipped — not auto-marked verified:false.
    expect(result.payload.substrate_verifications).toEqual({});
    // Residual not forced to 1.0 by a false provenance gate.
    expect(result.payload.closure_residual).toBe(0.08);
    expect(result.payload.closure_residual).toBeLessThan(0.3);
  });

  test("facade-routed deliverable + commit-gate decisions match the internal path", () => {
    const db = openDb(":memory:");
    // No closure audit exists for this task → commit gate fails OPEN (preserved).
    const decision = evaluateClosureCommitGate(db, { task_id: "task_no_audit", directive_id: "dir_no_audit" });
    expect(decision.allow).toBe(true);
    expect(decision.closure_residual).toBeNull();

    // Deliverable coverage check resolves through the facade identically.
    const coverage = checkClosureDeliverables(db, "root_empty");
    expect(coverage.ok).toBe(true);
    expect(coverage.uncovered_leaves).toEqual([]);

    // Pressure wrapper never blocks commit (goal-sufficiency stop rule, preserved).
    const pressure = closureDeliverablePressure(db, "root_empty");
    expect(pressure.blocks_commit).toBe(false);

    // Document-body hard gate still rejects a thin stub via the facade.
    expect(hasRealDocumentBody("summary: tbd", [])).toBe(false);
  });
});
