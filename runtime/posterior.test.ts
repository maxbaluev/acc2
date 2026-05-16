// runtime/posterior.test.ts — unit coverage for the canonical Beta
// posterior helpers. Pins both confidence variants (stream-form and
// evidence-form) so a future refactor cannot silently swap one for the
// other and quietly bias every score surface in the substrate.

import { describe, expect, test } from "bun:test";

import {
  betaConfidence,
  betaEvidenceConfidence,
  betaMean,
  betaStreamConfidence,
  scoreFor,
  updateBetaPosterior,
} from "./posterior";

describe("runtime/posterior — canonical Beta math", () => {
  test("betaMean(1, 1) === 0.5 — symmetric prior", () => {
    expect(betaMean(1, 1)).toBe(0.5);
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
