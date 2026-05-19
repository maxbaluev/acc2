// acc2 posterior-driven recipe promotion (F5, 2026-05-18).
//
// Replaces the fixed-count threshold (≥3 successful replays) that previously
// gated recipe promotion. A Beta posterior over (goal_shape × topology ×
// outcome_class) supplies a lower-bound confidence; the promotion gate
// compares that confidence against a per-owner threshold derived from the
// owner profile's autonomy signal for the goal class.
//
// Roadmap: WW7W1NZ8A10R52PB4E7EJE9YBW (F5 posterior_driven_promotion).
// Falsifying test: posterior_N1_and_mixed_signal_gate.
//
// Why a Beta lower bound rather than the mean: a single positive owner
// outcome should be capable of promoting a recipe when the owner trust
// signal is high, but ten observations split evenly should not. The mean
// alone treats both cases at 0.5; the std-aware lower bound separates them
// because the second case carries near-zero residual uncertainty around an
// uninformative mean.
//
// The threshold lookup honors the owner_profile.autonomy_signals open map
// (per-goal-class scores when present), then the scalar autonomy_score,
// then the default 0.65 floor when neither is set. autonomy_scope today
// holds include/exclude paths rather than per-goal-class scalars, so the
// per-goal-class read prefers autonomy_signals[goalClass] before falling
// back to the global score.

import type { OwnerProfile } from "../substrate/types";

/** Default threshold used when the owner profile carries no usable signal. */
export const DEFAULT_PROMOTION_THRESHOLD = 0.65;

/** Threshold returned for owners with high autonomy_score (>= 0.8). */
export const HIGH_AUTONOMY_THRESHOLD = 0.4;

/** Threshold returned for owners with mid autonomy_score (>= 0.5). */
export const MID_AUTONOMY_THRESHOLD = 0.6;

/** Threshold returned for owners with low autonomy_score (< 0.5). */
export const LOW_AUTONOMY_THRESHOLD = 0.75;

/** Lower-bound width in standard deviations. k=1 gives the 84th-percentile
 *  lower bound for a near-Gaussian posterior; a higher k tightens the gate. */
export const DEFAULT_K = 1.0;

export type BetaConfidence = {
  mean: number;
  std: number;
  lower_bound: number;
  sample_size: number;
};

/** Compute the Beta posterior mean, std, and lower-bound confidence for
 *  the supplied alpha/beta counts. k controls how many standard deviations
 *  below the mean the lower bound sits.
 *
 *  Beta(alpha, beta) has mean = alpha / (alpha + beta) and variance =
 *  alpha * beta / ((alpha + beta)^2 * (alpha + beta + 1)). The lower
 *  bound is clamped to [0, 1] so callers can compare it against the
 *  promotion threshold directly. */
export const computeBetaConfidence = (
  alpha: number,
  beta: number,
  k: number = DEFAULT_K,
): BetaConfidence => {
  const safeAlpha = Math.max(0, alpha);
  const safeBeta = Math.max(0, beta);
  const n = safeAlpha + safeBeta;
  if (n <= 0) {
    return { mean: 0, std: 0, lower_bound: 0, sample_size: 0 };
  }
  const mean = safeAlpha / n;
  const variance = (safeAlpha * safeBeta) / (n * n * (n + 1));
  const std = Math.sqrt(variance);
  const raw = mean - k * std;
  const lower_bound = Math.max(0, Math.min(1, raw));
  return { mean, std, lower_bound, sample_size: n };
};

/** Resolve the promotion threshold for the supplied owner profile and goal
 *  class. The lookup order is:
 *
 *    1. owner_profile.autonomy_signals[goalClass] — the open-ended map that
 *       carries per-goal-class learned strengths. Treated as the local
 *       autonomy_score for this goal class.
 *    2. owner_profile.autonomy_score — the global scalar.
 *    3. DEFAULT_PROMOTION_THRESHOLD (0.65) when the profile carries
 *       neither signal.
 *
 *  An autonomy reading in [0.8, 1] returns HIGH_AUTONOMY_THRESHOLD.
 *  A reading in [0.5, 0.8) returns MID_AUTONOMY_THRESHOLD.
 *  A reading in [0, 0.5) returns LOW_AUTONOMY_THRESHOLD.
 *
 *  Missing profile or missing goalClass → DEFAULT_PROMOTION_THRESHOLD. */
export const derivePromotionThreshold = (
  ownerProfile: OwnerProfile | null | undefined,
  goalClass: string | null | undefined,
): number => {
  if (!ownerProfile) return DEFAULT_PROMOTION_THRESHOLD;
  let reading: number | null = null;
  if (goalClass && ownerProfile.autonomy_signals) {
    const v = ownerProfile.autonomy_signals[goalClass];
    if (typeof v === "number" && Number.isFinite(v)) reading = Math.max(0, Math.min(1, v));
  }
  if (reading === null && typeof ownerProfile.autonomy_score === "number" && Number.isFinite(ownerProfile.autonomy_score)) {
    reading = Math.max(0, Math.min(1, ownerProfile.autonomy_score));
  }
  if (reading === null) return DEFAULT_PROMOTION_THRESHOLD;
  if (reading >= 0.8) return HIGH_AUTONOMY_THRESHOLD;
  if (reading >= 0.5) return MID_AUTONOMY_THRESHOLD;
  return LOW_AUTONOMY_THRESHOLD;
};

export type RecipePosterior = {
  posterior_alpha: number;
  posterior_beta: number;
};

export type PromotionEvaluation = {
  promote: boolean;
  confidence: number;
  threshold: number;
  reason: string;
  mean: number;
  std: number;
  sample_size: number;
};

/** Evaluate whether a recipe's Beta posterior crosses the per-owner per-goal
 *  promotion threshold. Returns the decision plus diagnostic fields so
 *  emitters can stamp `recipe_promoted` / `recipe_promotion_deferred`
 *  payloads with the exact numbers that produced the verdict. */
export const evaluatePromotion = (
  recipe: RecipePosterior,
  ownerProfile: OwnerProfile | null | undefined,
  goalClass: string | null | undefined,
  opts: { k?: number } = {},
): PromotionEvaluation => {
  const k = opts.k ?? DEFAULT_K;
  const conf = computeBetaConfidence(recipe.posterior_alpha, recipe.posterior_beta, k);
  const threshold = derivePromotionThreshold(ownerProfile, goalClass);
  const promote = conf.sample_size > 0 && conf.lower_bound >= threshold;
  let reason: string;
  if (conf.sample_size <= 0) {
    reason = "no_evidence";
  } else if (promote) {
    reason = "confidence_above_threshold";
  } else {
    reason = "confidence_below_threshold";
  }
  return {
    promote,
    confidence: conf.lower_bound,
    threshold,
    reason,
    mean: conf.mean,
    std: conf.std,
    sample_size: conf.sample_size,
  };
};

/** Weight assigned to a single owner-observed outcome with strong positive
 *  or negative signal. Owner signals carry full weight (1.0); internal
 *  closure verdicts carry half weight (0.5). */
export const OWNER_SIGNAL_WEIGHT = 1.0;
export const CLOSURE_SIGNAL_WEIGHT = 0.5;

/** Default weight when an owner outcome lacks an explicit signal_class. */
export const DEFAULT_SIGNAL_WEIGHT = 0.5;

/** Map an open-string signal_class to a numeric weight. The vocabulary is
 *  not closed — unknown strings fall through to DEFAULT_SIGNAL_WEIGHT. */
export const signalClassWeight = (signalClass: string | null | undefined): number => {
  if (!signalClass) return DEFAULT_SIGNAL_WEIGHT;
  switch (signalClass) {
    case "positive_strong":
    case "negative_strong":
      return OWNER_SIGNAL_WEIGHT;
    case "positive_weak":
    case "negative_weak":
      return 0.7;
    case "neutral":
      return 0;
    default:
      return DEFAULT_SIGNAL_WEIGHT;
  }
};

/** Return true when the supplied signal_class denotes a positive outcome. */
export const isPositiveSignalClass = (signalClass: string | null | undefined): boolean => {
  if (!signalClass) return false;
  return signalClass === "positive_strong" || signalClass === "positive_weak";
};

/** Return true when the supplied signal_class denotes a negative outcome. */
export const isNegativeSignalClass = (signalClass: string | null | undefined): boolean => {
  if (!signalClass) return false;
  return signalClass === "negative_strong" || signalClass === "negative_weak";
};
