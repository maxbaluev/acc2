// runtime/posterior.ts — Canonical Beta(α, β) posterior math.
//
// AccInt v2 scores every learnable thing — code artifacts, knowledge
// candidates, action attempts, low-risk inline patterns — with a Beta
// posterior. Before this module existed the same algebra (mean,
// confidence proxy, residual→delta) was duplicated across five call
// sites (`runtime/credit.ts`, `runtime/artifact_store.ts`,
// `substrate/extractors.ts`, `runtime/dispatch_decider.ts`, and the
// posterior-consistency alignment test). The brain's elegant-axis
// audit (QQEHAW97GS0AX7TEQ717Y3P174) flagged the duplication; this
// module is the canonical home.
//
// Two confidence variants coexist deliberately (see
// `runtime/alignment/posterior_consistency.test.ts` which pins them):
//
//   * stream-form  `1 - 1/√(α + β + 1)` — used by code-artifact and
//     per-residual streams in `credit.ts` and `artifact_store.ts`.
//     Counts the Beta(1, 1) prior pseudo-observations as evidence;
//     monotonically increases from confidence ≈ 0.293 at the start.
//
//   * evidence-form `1 - 1/√(max(0, α + β − 2) + 1)` — used by the
//     knowledge-candidate corroboration pipeline in `extractors.ts` and
//     the dispatcher in `dispatch_decider.ts`. Subtracts the Beta(1, 1)
//     prior so confidence starts at 0 with zero observations and grows
//     only as real corroborations arrive.
//
// Both shapes are exported so the existing call sites can keep their
// chosen interpretation without re-running consistency math against a
// hidden default. The bare `betaConfidence` matches the elegant-axis
// amendment's documented surface (no shift, n = α + β).

/** Beta(α, β) posterior mean: α / (α + β).
 *  Returns 0 when α + β === 0 — caller's intent on an empty posterior
 *  is "no signal", not NaN. */
export const betaMean = (alpha: number, beta: number): number => {
  const total = alpha + beta;
  if (total <= 0) return 0;
  return alpha / total;
};

/** Beta(α, β) posterior confidence: 1 − 1/√(α + β).
 *  Returns 0 when α + β === 0; clamps to [0, 1]. This is the canonical
 *  shape the elegant-axis amendment names; the two in-use variants
 *  (stream-form and evidence-form below) are derived shifts. */
export const betaConfidence = (alpha: number, beta: number): number => {
  const total = alpha + beta;
  if (total <= 0) return 0;
  const c = 1 - 1 / Math.sqrt(total);
  if (c < 0) return 0;
  if (c > 1) return 1;
  return c;
};

/** Stream-form Beta confidence: 1 − 1/√(α + β + 1).
 *  The shape `credit.ts` and `artifact_store.ts` use for residual
 *  streams. Identical to `betaConfidence(α + 1, β)` — i.e. one extra
 *  pseudo-evidence — but expressing it directly avoids the off-by-one
 *  confusion a curious reader would otherwise have. */
export const betaStreamConfidence = (alpha: number, beta: number): number => {
  const n = alpha + beta;
  const c = 1 - 1 / Math.sqrt(n + 1);
  if (c < 0) return 0;
  if (c > 1) return 1;
  return c;
};

/** Evidence-count Beta confidence: 1 − 1/√(max(0, α + β − 2) + 1).
 *  The shape `extractors.ts` and `dispatch_decider.ts` use for
 *  knowledge corroboration; subtracts the Beta(1, 1) prior so two
 *  units of evidence (α = β = 1) read as zero confirmations. */
export const betaEvidenceConfidence = (alpha: number, beta: number): number => {
  const n = alpha + beta - 2;
  const c = 1 - 1 / Math.sqrt(Math.max(0, n) + 1);
  if (c < 0) return 0;
  if (c > 1) return 1;
  return c;
};

/** Update Beta posterior with one observation. `residual ∈ [0, 1]` is
 *  the action's miss (0 = perfect, 1 = total failure). The complement
 *  `1 − residual` credits α (success), the residual itself credits β
 *  (failure). Residual is clamped to [0, 1] before the update so a
 *  stray over/underflow can't drive the posterior negative. */
export const updateBetaPosterior = (
  alpha: number,
  beta: number,
  residual: number,
): { alpha: number; beta: number } => {
  const r = Math.max(0, Math.min(1, residual));
  return { alpha: alpha + (1 - r), beta: beta + r };
};

/** Compute score + confidence for a given (α, β) pair using the
 *  canonical (unshifted) Beta forms. Returns the standard shape every
 *  substrate-side scoring surface produces. Both values are clamped to
 *  [0, 1] by their underlying helpers. */
export const scoreFor = (
  alpha: number,
  beta: number,
): { score: number; confidence: number } => ({
  score: betaMean(alpha, beta),
  confidence: betaConfidence(alpha, beta),
});
