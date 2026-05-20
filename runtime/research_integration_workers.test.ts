// 2026 research integration tests:
// - SSGM memory_reconciliation_worker (arXiv:2603.11768)
// - SAHOO recursive_self_improvement_governor (arXiv:2603.06333)
// - Constitutional ratification predicate seeds (arXiv:2604.07007)

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import { runMemoryReconciliationTick } from "./memory_reconciliation_worker";
import { runSahooDiagnosticsTick, evaluateGoNoGo, computeDriftScore } from "./recursive_self_improvement_governor";

afterAll(() => closeDb());
beforeEach(() => closeDb());

describe("memory_reconciliation_worker (SSGM)", () => {
  test("clean tick emits memory_reconciliation_completed with surfaces_checked > 0", () => {
    const db = openDb(":memory:");
    const summary = runMemoryReconciliationTick(db);
    expect(summary.skipped_recent).toBe(false);
    expect(summary.surfaces_checked).toBeGreaterThan(0);
    expect(summary.emitted_event_ids.length).toBeGreaterThan(0);
    const completed = db
      .query<{ c: number }, []>(
        `SELECT COUNT(*) AS c FROM events WHERE kind = 'memory_reconciliation_completed'`,
      )
      .get();
    expect(completed?.c).toBeGreaterThanOrEqual(1);
  });

  test("repeated tick within minGapMs is skipped (idempotent)", () => {
    const db = openDb(":memory:");
    runMemoryReconciliationTick(db);
    const second = runMemoryReconciliationTick(db);
    expect(second.skipped_recent).toBe(true);
  });

  test("custom surface with drifting cache emits memory_reconciliation_drift_detected", () => {
    const db = openDb(":memory:");
    const summary = runMemoryReconciliationTick(
      db,
      {},
      [
        {
          name: "test_drift_surface",
          ledgerProjectionHash: () => "ledger_hash_v1",
          liveCacheHash: () => "stale_cache_hash_v0",
        },
      ],
    );
    expect(summary.drifts_detected).toBe(1);
    const drift = db
      .query<{ c: number }, []>(
        `SELECT COUNT(*) AS c FROM events WHERE kind = 'memory_reconciliation_drift_detected'`,
      )
      .get();
    expect(drift?.c).toBe(1);
  });
});

describe("recursive_self_improvement_governor (SAHOO)", () => {
  test("computeDriftScore returns 0 on clean substrate", () => {
    const db = openDb(":memory:");
    expect(computeDriftScore(db)).toBe(0);
  });

  test("computeDriftScore rises as integrity_check_failed accumulate", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 5; i++) {
      emitEvent(db, {
        kind: "integrity_check_failed",
        substrate_origin: "substrate_auto",
        payload: { predicate: "test_failure", reason: "synthetic" },
      });
    }
    const score = computeDriftScore(db);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  test("evaluateGoNoGo returns go on clean substrate without high-impact target", () => {
    const db = openDb(":memory:");
    const decision = evaluateGoNoGo(db, { target_resource: "ledger:test/foo" });
    expect(decision.verdict).toBe("go");
    expect(decision.drift_score).toBe(0);
  });

  test("evaluateGoNoGo refuses high-impact target without evidence_event_ids", () => {
    const db = openDb(":memory:");
    const decision = evaluateGoNoGo(db, { target_resource: "repo:runtime/credit.ts" });
    expect(decision.verdict).toBe("no_go");
    expect(decision.reasons.some((r) => r.includes("evidence_chain"))).toBe(true);
  });

  test("evaluateGoNoGo accepts high-impact target with evidence chain", () => {
    const db = openDb(":memory:");
    const decision = evaluateGoNoGo(db, {
      target_resource: "repo:runtime/credit.ts",
      evidence_event_ids: ["EV1", "EV2"],
    });
    expect(decision.verdict).toBe("go");
  });

  test("evaluateGoNoGo refuses when drift exceeds bound", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 12; i++) {
      emitEvent(db, {
        kind: "integrity_check_failed",
        substrate_origin: "substrate_auto",
        payload: { predicate: "test_drift", reason: "synthetic_high_drift" },
      });
    }
    const decision = evaluateGoNoGo(db, {
      target_resource: "ledger:test/foo",
    });
    expect(decision.verdict).toBe("no_go");
    expect(decision.drift_score).toBeGreaterThanOrEqual(decision.bound);
  });

  test("runSahooDiagnosticsTick emits sahoo_diagnostics_recorded with 5-tuple", () => {
    const db = openDb(":memory:");
    const result = runSahooDiagnosticsTick(db);
    expect(result.emitted).toBe(true);
    expect(typeof result.diagnostics.delegation_safety_residual).toBe("number");
    expect(typeof result.diagnostics.drift_bound_headroom).toBe("number");
    expect(typeof result.diagnostics.closure_residual_avg).toBe("number");
    expect(typeof result.diagnostics.owner_outcome_coverage).toBe("number");
    expect(typeof result.diagnostics.posterior_promotion_rate).toBe("number");
    const ev = db
      .query<{ c: number }, []>(
        `SELECT COUNT(*) AS c FROM events WHERE kind = 'sahoo_diagnostics_recorded'`,
      )
      .get();
    expect(ev?.c).toBe(1);
  });

  test("runSahooDiagnosticsTick idempotency: second tick within minGapMs is skipped", () => {
    const db = openDb(":memory:");
    runSahooDiagnosticsTick(db);
    const second = runSahooDiagnosticsTick(db);
    expect(second.emitted).toBe(false);
  });
});
