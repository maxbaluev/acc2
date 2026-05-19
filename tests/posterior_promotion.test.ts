// acc2 F5 posterior-driven recipe promotion tests (2026-05-18).
//
// Falsifying test for the F5 roadmap line (event id
// WW7W1NZ8A10R52PB4E7EJE9YBW): `posterior_N1_and_mixed_signal_gate`.
//
// Validates that:
//   - N=1 with strong positive owner signal can cross the gate for a
//     high-autonomy owner (the elegant solution the fixed ≥3 threshold
//     could never express).
//   - N=10 with mixed signal does NOT cross the default gate (the
//     symmetric falsifier — more observations with weaker mean do not
//     get promoted just because they're numerous).
//   - N=20 with consistent positive signal crosses even for a
//     low-autonomy owner (high confidence overrides cautious threshold).
//   - Missing owner profile falls back to the 0.65 threshold.
//   - Diagnostic payload exposes confidence + threshold so emitters can
//     record both on `promoted recipe-shape knowledge` / `deferred recipe-shape knowledge`.

import { describe, expect, test } from "bun:test";
import {
  computeBetaConfidence,
  derivePromotionThreshold,
  evaluatePromotion,
  DEFAULT_PROMOTION_THRESHOLD,
  HIGH_AUTONOMY_THRESHOLD,
  MID_AUTONOMY_THRESHOLD,
  LOW_AUTONOMY_THRESHOLD,
} from "../runtime/posterior_promotion";
import type { OwnerProfile } from "../substrate/types";

const highAutonomyOwner: OwnerProfile = { autonomy_score: 0.9 };
const midAutonomyOwner: OwnerProfile = { autonomy_score: 0.6 };
const lowAutonomyOwner: OwnerProfile = { autonomy_score: 0.3 };

describe("computeBetaConfidence", () => {
  test("returns zeros when posterior carries no evidence", () => {
    const r = computeBetaConfidence(0, 0);
    expect(r.mean).toBe(0);
    expect(r.std).toBe(0);
    expect(r.lower_bound).toBe(0);
    expect(r.sample_size).toBe(0);
  });

  test("N=1 alpha=2 beta=1 → mean=0.667, lower_bound > 0.4", () => {
    const r = computeBetaConfidence(2, 1);
    expect(r.mean).toBeCloseTo(0.667, 2);
    expect(r.lower_bound).toBeGreaterThan(0.4);
    expect(r.sample_size).toBe(3);
  });

  test("alpha=5 beta=5 (mixed) → mean=0.5, lower_bound < 0.4", () => {
    const r = computeBetaConfidence(5, 5);
    expect(r.mean).toBeCloseTo(0.5, 5);
    expect(r.lower_bound).toBeLessThan(0.4);
  });

  test("alpha=18 beta=2 (consistent positive) → lower_bound > 0.75", () => {
    const r = computeBetaConfidence(18, 2);
    expect(r.mean).toBeCloseTo(0.9, 5);
    expect(r.lower_bound).toBeGreaterThan(0.75);
  });
});

describe("derivePromotionThreshold", () => {
  test("high autonomy_score (>= 0.8) returns HIGH_AUTONOMY_THRESHOLD", () => {
    expect(derivePromotionThreshold(highAutonomyOwner, "research")).toBe(HIGH_AUTONOMY_THRESHOLD);
  });

  test("mid autonomy_score (0.5 - 0.8) returns MID_AUTONOMY_THRESHOLD", () => {
    expect(derivePromotionThreshold(midAutonomyOwner, "research")).toBe(MID_AUTONOMY_THRESHOLD);
  });

  test("low autonomy_score (< 0.5) returns LOW_AUTONOMY_THRESHOLD", () => {
    expect(derivePromotionThreshold(lowAutonomyOwner, "research")).toBe(LOW_AUTONOMY_THRESHOLD);
  });

  test("missing profile → DEFAULT_PROMOTION_THRESHOLD", () => {
    expect(derivePromotionThreshold(null, "research")).toBe(DEFAULT_PROMOTION_THRESHOLD);
  });

  test("profile without autonomy_score → DEFAULT_PROMOTION_THRESHOLD", () => {
    expect(derivePromotionThreshold({}, "research")).toBe(DEFAULT_PROMOTION_THRESHOLD);
  });

  test("autonomy_signals[goalClass] preferred over scalar autonomy_score", () => {
    const profile: OwnerProfile = {
      autonomy_score: 0.3, // would yield LOW_AUTONOMY_THRESHOLD
      autonomy_signals: { research: 0.9 }, // but per-class signal is high
    };
    expect(derivePromotionThreshold(profile, "research")).toBe(HIGH_AUTONOMY_THRESHOLD);
    // A different goal class still falls back to the scalar.
    expect(derivePromotionThreshold(profile, "design")).toBe(LOW_AUTONOMY_THRESHOLD);
  });
});

describe("posterior_N1_and_mixed_signal_gate (falsifying test from roadmap)", () => {
  test("Case A: N=1 alpha=2 beta=1 + high-autonomy owner → promote", () => {
    const e = evaluatePromotion(
      { posterior_alpha: 2, posterior_beta: 1 },
      highAutonomyOwner,
      "research",
    );
    expect(e.promote).toBe(true);
    expect(e.confidence).toBeGreaterThan(e.threshold);
    expect(e.threshold).toBe(HIGH_AUTONOMY_THRESHOLD);
    expect(e.reason).toBe("confidence_above_threshold");
    expect(e.sample_size).toBe(3);
  });

  test("Case B: N=10 alpha=5 beta=5 (mixed signal) + default owner → NOT promote", () => {
    const e = evaluatePromotion(
      { posterior_alpha: 5, posterior_beta: 5 },
      midAutonomyOwner,
      "research",
    );
    expect(e.promote).toBe(false);
    expect(e.confidence).toBeLessThan(e.threshold);
    expect(e.reason).toBe("confidence_below_threshold");
    expect(e.sample_size).toBe(10);
  });

  test("Case C: N=20 alpha=18 beta=2 (consistent positive) + low-autonomy owner → promote", () => {
    const e = evaluatePromotion(
      { posterior_alpha: 18, posterior_beta: 2 },
      lowAutonomyOwner,
      "research",
    );
    expect(e.promote).toBe(true);
    expect(e.threshold).toBe(LOW_AUTONOMY_THRESHOLD);
    expect(e.confidence).toBeGreaterThan(LOW_AUTONOMY_THRESHOLD);
  });

  test("Case D: missing owner_profile falls back to 0.65 threshold; weaker signal fails", () => {
    // N=1 alpha=2 beta=1 lower_bound ≈ 0.45 — fails 0.65 default.
    const e1 = evaluatePromotion(
      { posterior_alpha: 2, posterior_beta: 1 },
      null,
      "research",
    );
    expect(e1.threshold).toBe(DEFAULT_PROMOTION_THRESHOLD);
    expect(e1.promote).toBe(false);
    // But a strong N=20 alpha=18 beta=2 still crosses.
    const e2 = evaluatePromotion(
      { posterior_alpha: 18, posterior_beta: 2 },
      null,
      "research",
    );
    expect(e2.threshold).toBe(DEFAULT_PROMOTION_THRESHOLD);
    expect(e2.promote).toBe(true);
  });

  test("Case E: diagnostic payload surfaces both confidence and threshold", () => {
    const e = evaluatePromotion(
      { posterior_alpha: 3, posterior_beta: 7 },
      midAutonomyOwner,
      "design",
    );
    // Both fields must be present and in [0, 1] so emitters can stamp them
    // onto deferred recipe-shape knowledge for diagnostic visibility.
    expect(typeof e.confidence).toBe("number");
    expect(typeof e.threshold).toBe("number");
    expect(e.confidence).toBeGreaterThanOrEqual(0);
    expect(e.confidence).toBeLessThanOrEqual(1);
    expect(e.threshold).toBeGreaterThanOrEqual(0);
    expect(e.threshold).toBeLessThanOrEqual(1);
    expect(typeof e.mean).toBe("number");
    expect(typeof e.std).toBe("number");
    expect(e.sample_size).toBe(10);
  });
});

describe("evaluatePromotion edge cases", () => {
  test("zero evidence never promotes", () => {
    const e = evaluatePromotion(
      { posterior_alpha: 0, posterior_beta: 0 },
      highAutonomyOwner,
      "research",
    );
    expect(e.promote).toBe(false);
    expect(e.reason).toBe("no_evidence");
    expect(e.sample_size).toBe(0);
  });

  test("k=2 tightens the gate (lower bound moves down)", () => {
    const e1 = evaluatePromotion(
      { posterior_alpha: 2, posterior_beta: 1 },
      highAutonomyOwner,
      "research",
      { k: 1 },
    );
    const e2 = evaluatePromotion(
      { posterior_alpha: 2, posterior_beta: 1 },
      highAutonomyOwner,
      "research",
      { k: 2 },
    );
    expect(e2.confidence).toBeLessThan(e1.confidence);
  });
});
