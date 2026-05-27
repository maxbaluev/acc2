// runtime/posterior.test.ts — unit coverage for the canonical Beta
// posterior helpers. Pins both confidence variants (stream-form and
// evidence-form) so a future refactor cannot silently swap one for the
// other and quietly bias every score surface in the substrate.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { closeDb, openDb } from "../substrate/db";
// P6 stage B: residualToBetaDeltas is now CANONICAL in posterior.ts (moved
// here to break the posterior↔artifact_store cycle). artifact_store re-exports
// it; the cycle-resolution test below pins that the two bindings are the SAME
// function reference.
import { residualToBetaDeltas as residualToBetaDeltasFromArtifactStore } from "./artifact_store";
import {
  applyScoredOutcome,
  betaConfidence,
  betaEvidenceConfidence,
  betaMean,
  betaStreamConfidence,
  getScoredEntity,
  residualToBetaDeltas,
  scoreFor,
  SUCCESS_BAND,
  FAILURE_BAND,
  updateBetaPosterior,
} from "./posterior";

describe("runtime/posterior — canonical Beta math", () => {
  test("betaMean(1, 1) === 0.5 — symmetric prior", () => {
    expect(betaMean(1, 1)).toBe(0.5);
  });

  // P6 stage B: cycle resolution. residualToBetaDeltas + the band
  // constants are canonical in posterior.ts; artifact_store re-exports
  // residualToBetaDeltas. The re-export MUST be the same function (no
  // second copy of the band algebra), and the band map must honour the
  // SUCCESS_BAND / FAILURE_BAND boundaries.
  test("residualToBetaDeltas is canonical here and the artifact_store export is the SAME reference", () => {
    expect(residualToBetaDeltasFromArtifactStore).toBe(residualToBetaDeltas);
  });

  test("residualToBetaDeltas honours SUCCESS_BAND / FAILURE_BAND boundaries", () => {
    expect(SUCCESS_BAND).toBe(0.3);
    expect(FAILURE_BAND).toBe(0.7);
    // Perfect success → full alpha unit, zero beta.
    expect(residualToBetaDeltas(0)).toEqual({ alphaDelta: 1, betaDelta: 0 });
    // Total failure → full beta unit, zero alpha.
    expect(residualToBetaDeltas(1)).toEqual({ alphaDelta: 0, betaDelta: 1 });
    // At the success band boundary, alpha delta is 0.
    expect(residualToBetaDeltas(SUCCESS_BAND).alphaDelta).toBeCloseTo(0, 6);
    // Non-finite residual → no movement.
    expect(residualToBetaDeltas(null)).toEqual({ alphaDelta: 0, betaDelta: 0 });
    expect(residualToBetaDeltas(undefined)).toEqual({ alphaDelta: 0, betaDelta: 0 });
  });

  test("betaMean(0, 0) === 0 — empty posterior is no signal, not NaN", () => {
    expect(betaMean(0, 0)).toBe(0);
    expect(Number.isNaN(betaMean(0, 0))).toBe(false);
  });

  test("betaMean(3, 1) === 0.75 — three wins, one loss", () => {
    expect(betaMean(3, 1)).toBeCloseTo(0.75, 10);
  });

  test("betaConfidence(1, 1) ≈ 1 - 1/√2 (spec form, no shift)", () => {
    expect(betaConfidence(1, 1)).toBeCloseTo(1 - 1 / Math.sqrt(2), 10);
  });

  test("betaConfidence(0, 0) === 0 — empty posterior", () => {
    expect(betaConfidence(0, 0)).toBe(0);
  });

  test("betaStreamConfidence matches the credit.ts / artifact_store.ts shape", () => {
    // 1 - 1/sqrt(alpha + beta + 1) for stream form.
    expect(betaStreamConfidence(1, 1)).toBeCloseTo(1 - 1 / Math.sqrt(3), 10);
    expect(betaStreamConfidence(0, 0)).toBeCloseTo(1 - 1 / Math.sqrt(1), 10); // 0
  });

  test("betaEvidenceConfidence matches the extractors.ts / dispatch_decider.ts shape", () => {
    // 1 - 1/sqrt(max(0, alpha+beta-2) + 1); Beta(1,1) prior reads as 0 evidence.
    expect(betaEvidenceConfidence(1, 1)).toBeCloseTo(1 - 1 / Math.sqrt(1), 10); // 0
    expect(betaEvidenceConfidence(3, 1)).toBeCloseTo(1 - 1 / Math.sqrt(3), 10);
  });

  test("updateBetaPosterior on success (residual=0) bumps α only", () => {
    const next = updateBetaPosterior(1, 1, 0);
    expect(next.alpha).toBe(2);
    expect(next.beta).toBe(1);
  });

  test("updateBetaPosterior on failure (residual=1) bumps β only", () => {
    const next = updateBetaPosterior(1, 1, 1);
    expect(next.alpha).toBe(1);
    expect(next.beta).toBe(2);
  });

  test("updateBetaPosterior on partial residual splits the count", () => {
    const next = updateBetaPosterior(1, 1, 0.25);
    expect(next.alpha).toBeCloseTo(1.75, 10);
    expect(next.beta).toBeCloseTo(1.25, 10);
  });

  test("updateBetaPosterior clamps a stray residual outside [0, 1]", () => {
    expect(updateBetaPosterior(1, 1, -0.5)).toEqual({ alpha: 2, beta: 1 });
    expect(updateBetaPosterior(1, 1, 1.5)).toEqual({ alpha: 1, beta: 2 });
  });

  test("scoreFor returns clamped [0, 1] values with consistent shape", () => {
    const a = scoreFor(1, 1);
    expect(a.score).toBe(0.5);
    expect(a.confidence).toBeGreaterThanOrEqual(0);
    expect(a.confidence).toBeLessThanOrEqual(1);
    const b = scoreFor(0, 0);
    expect(b.score).toBe(0);
    expect(b.confidence).toBe(0);
    const c = scoreFor(10, 0);
    expect(c.score).toBe(1);
    expect(c.confidence).toBeGreaterThan(0);
    expect(c.confidence).toBeLessThanOrEqual(1);
  });
});

// ── Canonical scored-entity primitive (amendment 5XRDMG6G, stage A) ──
// Verifies the consolidation primitive upserts + audits, is idempotent on
// (entity, ts), and reuses the EXISTING posterior formulas verbatim.
describe("runtime/posterior — applyScoredOutcome canonical primitive", () => {
  afterAll(() => closeDb());
  beforeEach(() => closeDb());

  const countEntityScoreEvents = (db: ReturnType<typeof openDb>, entityId: string): number =>
    (db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM events WHERE kind = 'entity_score_updated' AND json_extract(payload, '$.entity_id') = ?",
      )
      .get(entityId)?.n) ?? 0;

  test("applyScoredOutcome upserts a scored_entity row and emits entity_score_updated", () => {
    const db = openDb(":memory:");
    expect(getScoredEntity(db, "ent_a")).toBeNull();

    const result = applyScoredOutcome(db, {
      entity_id: "ent_a",
      entity_kind: "act_artifact",
      residual: 0,
      ts: "2026-05-27T00:00:00.000Z",
    });

    const row = getScoredEntity(db, "ent_a");
    expect(row).not.toBeNull();
    expect(row!.entity_kind).toBe("act_artifact");
    expect(row!.posterior_alpha).toBeGreaterThan(1); // success bumped α
    expect(row!.posterior_beta).toBe(1);
    expect(result.score).toBe(row!.score);

    expect(countEntityScoreEvents(db, "ent_a")).toBe(1);
  });

  test("score/confidence match the existing posterior formulas for the same α/β", () => {
    const db = openDb(":memory:");
    const ts = "2026-05-27T01:00:00.000Z";
    // success outcome (residual 0) from the Beta(1,1) prior → the same
    // residualToBetaDeltas band logic artifact_store / applyResidualOutcome use.
    const { alphaDelta, betaDelta } = residualToBetaDeltas(0);
    const expectedAlpha = 1 + alphaDelta; // no prior evidence to decay
    const expectedBeta = 1 + betaDelta;

    const row = applyScoredOutcome(db, {
      entity_id: "ent_formula",
      entity_kind: "knowledge_candidate",
      residual: 0,
      ts,
    });

    expect(row.posterior_alpha).toBeCloseTo(expectedAlpha, 10);
    expect(row.posterior_beta).toBeCloseTo(expectedBeta, 10);
    // score == betaMean, confidence == betaStreamConfidence (artifact_store's
    // recomputeScore / recomputeConfidence) — reused, not reinvented.
    expect(row.score).toBeCloseTo(betaMean(expectedAlpha, expectedBeta), 10);
    expect(row.confidence).toBeCloseTo(betaStreamConfidence(expectedAlpha, expectedBeta), 10);
  });

  test("repeated identical outcome (same entity + ts) is idempotent", () => {
    const db = openDb(":memory:");
    const ts = "2026-05-27T02:00:00.000Z";

    const first = applyScoredOutcome(db, {
      entity_id: "ent_idem",
      entity_kind: "recipe",
      residual: 1,
      ts,
    });
    const second = applyScoredOutcome(db, {
      entity_id: "ent_idem",
      entity_kind: "recipe",
      residual: 1,
      ts,
    });

    // No second posterior movement, no duplicate audit event.
    expect(second.posterior_alpha).toBe(first.posterior_alpha);
    expect(second.posterior_beta).toBe(first.posterior_beta);
    expect(second.score).toBe(first.score);
    expect(countEntityScoreEvents(db, "ent_idem")).toBe(1);
  });

  test("outcome shorthand maps succeeded→residual 0, failed→residual 1", () => {
    const db = openDb(":memory:");
    const win = applyScoredOutcome(db, {
      entity_id: "ent_win",
      entity_kind: "causal_edge",
      outcome: "succeeded",
      ts: "2026-05-27T03:00:00.000Z",
    });
    const loss = applyScoredOutcome(db, {
      entity_id: "ent_loss",
      entity_kind: "causal_edge",
      outcome: "failed",
      ts: "2026-05-27T03:00:00.000Z",
    });
    expect(win.posterior_alpha).toBeGreaterThan(win.posterior_beta);
    expect(loss.posterior_beta).toBeGreaterThan(loss.posterior_alpha);
  });

  test("a later distinct outcome compounds onto the same entity row", () => {
    const db = openDb(":memory:");
    const t1 = "2026-05-27T04:00:00.000Z";
    const t2 = "2026-05-27T05:00:00.000Z";
    applyScoredOutcome(db, { entity_id: "ent_seq", entity_kind: "act_artifact", residual: 0, ts: t1 });
    const after = applyScoredOutcome(db, { entity_id: "ent_seq", entity_kind: "act_artifact", residual: 0, ts: t2 });

    // Two distinct observations → two audit rows, posterior moved twice.
    expect(countEntityScoreEvents(db, "ent_seq")).toBe(2);
    expect(after.posterior_alpha).toBeGreaterThan(1 + residualToBetaDeltas(0).alphaDelta);
  });
});
