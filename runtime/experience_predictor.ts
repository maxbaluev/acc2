// acc2 experience-stream predictor — generate-and-select Phase 5.
//
// The world-model "imagined rollout" that makes the organism FAST.
//
// Grounding (encoded as design, not prose):
//   Dreamer — predict cheaply by imagined rollout over the learned
//     world model; take a real (expensive) step only to CORRECT the
//     model when the cheap prediction is untrusted. shouldSpendFullLoop
//     is exactly that gate: skip the expensive generate-and-select +
//     human-contact loop only when the world model is confidently good.
//   JEPA — predict the abstract JUDGMENT latent (the residual), not a
//     reconstruction of the artifact. We predict residual ∈ [0,1].
//   Non-stationary judge — confidence DECAYS with time and context
//     distance from the most-similar past REAL contact. Old or distant
//     evidence is worth less; predicted-only evidence is worth less than
//     real contact.
//
// Pure / dependency-injected: no DB, network, or LLM inside the core
// function. Retrieval is injected so the core is unit-testable.

/** A single past outcome retrieved from the experience stream. */
export type PastOutcome = {
  task: string;
  /** Judgment latent in [0,1]; lower is better (0 = perfect). */
  residual: number;
  ts_ms: number;
  /** Similarity to the query task in [0,1]; higher is closer. */
  similarity: number;
  /** True if this outcome came from a REAL (expensive) contact/step,
   *  false if it was itself only a cheap prediction. */
  was_real_contact: boolean;
};

/** The imagined-rollout prediction for a query task. */
export type Prediction = {
  /** Similarity-, recency-, and real-contact-weighted mean residual. */
  predicted_residual: number;
  /** Calibrated-ish trust scalar in [0,1]. */
  confidence: number;
  n_evidence: number;
  /** Highest similarity among retrieved evidence (transparency). */
  nearest_similarity: number;
  /** Age of the nearest (most-similar) outcome, ms (transparency). */
  staleness_ms: number;
  basis: "sufficient" | "sparse" | "none";
};

export type PredictDeps = {
  retrieveSimilar: (task: string, k: number) => Promise<PastOutcome[]>;
  nowMs?: () => number;
  k?: number;
};

const DEFAULT_K = 8;

// Recency half-life: weight halves every ~14 days of staleness. The
// non-stationary judge means contact loses predictive value over time.
const RECENCY_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;

// Real contact is worth this multiple of a predicted-only outcome in the
// weighted mean. Dreamer: real steps correct the model, so they anchor.
const REAL_CONTACT_WEIGHT = 3;
const PREDICTED_ONLY_WEIGHT = 1;

// Confidence shaping. Evidence saturates: the marginal trust from the
// Nth corroborating outcome shrinks. ~4 strong outcomes ≈ full count term.
const EVIDENCE_SATURATION = 4;

function recencyWeight(staleMs: number): number {
  if (!Number.isFinite(staleMs) || staleMs <= 0) return 1;
  return Math.pow(0.5, staleMs / RECENCY_HALF_LIFE_MS);
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

/**
 * Imagined rollout: predict the residual we expect at `task` and how
 * much we trust that prediction, based on similar past experience.
 */
export async function predictOutcome(task: string, deps: PredictDeps): Promise<Prediction> {
  const k = deps.k ?? DEFAULT_K;
  const now = (deps.nowMs ?? (() => Date.now()))();
  const outcomes = await deps.retrieveSimilar(task, k);

  if (!outcomes || outcomes.length === 0) {
    return {
      predicted_residual: 0,
      confidence: 0,
      n_evidence: 0,
      nearest_similarity: 0,
      staleness_ms: 0,
      basis: "none",
    };
  }

  let weightSum = 0;
  let residualWeighted = 0;
  let realContactWeightShare = 0;
  let nearestSimilarity = 0;
  let nearestStaleness = 0;

  for (const o of outcomes) {
    const sim = clamp01(o.similarity);
    const stale = Math.max(0, now - o.ts_ms);
    const recency = recencyWeight(stale);
    const contactFactor = o.was_real_contact ? REAL_CONTACT_WEIGHT : PREDICTED_ONLY_WEIGHT;
    // weight = similarity × recency × contact-provenance
    const w = sim * recency * contactFactor;

    weightSum += w;
    residualWeighted += w * clamp01(o.residual);
    if (o.was_real_contact) realContactWeightShare += w;

    if (sim > nearestSimilarity) {
      nearestSimilarity = sim;
      nearestStaleness = stale;
    }
  }

  const predicted_residual = weightSum > 0 ? clamp01(residualWeighted / weightSum) : 0;
  const realShare = weightSum > 0 ? realContactWeightShare / weightSum : 0;

  // --- Confidence shaping (calibrated-ish, clamp [0,1]) ---
  // RISES with: n_evidence (saturating), nearest_similarity, real-contact share.
  // FALLS with: staleness of the nearest outcome, dissimilarity.
  const nEvidence = outcomes.length;
  const evidenceTerm = clamp01(nEvidence / EVIDENCE_SATURATION);
  const similarityTerm = clamp01(nearestSimilarity);
  const recencyTerm = recencyWeight(nearestStaleness); // 1 fresh → 0 stale
  const contactTerm = clamp01(realShare);

  // Multiplicative core so any single weak axis drags confidence down
  // (an old, dissimilar, or wholly-predicted basis cannot be confident),
  // then blend the real-contact share so a fully-predicted basis is
  // strictly penalised relative to a real-contact one.
  const core = evidenceTerm * similarityTerm * recencyTerm;
  const confidence = clamp01(core * (0.4 + 0.6 * contactTerm));

  let basis: Prediction["basis"];
  // 'sufficient' requires real corroborating evidence that is close and
  // fresh enough to trust; otherwise 'sparse'. (n===0 handled above.)
  if (confidence >= 0.6 && nearestSimilarity >= 0.6 && nEvidence >= 2 && realShare > 0) {
    basis = "sufficient";
  } else {
    basis = "sparse";
  }

  return {
    predicted_residual,
    confidence,
    n_evidence: nEvidence,
    nearest_similarity: nearestSimilarity,
    staleness_ms: nearestStaleness,
    basis,
  };
}

/**
 * The speed lever. Spend the full (expensive) generate-and-select +
 * contact loop ONLY when the cheap prediction cannot be trusted:
 *   - confidence below floor (we don't know enough), OR
 *   - predicted_residual above ceiling (we confidently expect a BAD
 *     outcome — never fast-path a predicted failure), OR
 *   - basis is not 'sufficient'.
 * Otherwise take the FAST PATH and trust the imagined rollout.
 */
export function shouldSpendFullLoop(
  p: Prediction,
  opts?: { confidenceFloor?: number; residualCeil?: number },
): { spend: boolean; reason: string } {
  const confidenceFloor = opts?.confidenceFloor ?? 0.6;
  const residualCeil = opts?.residualCeil ?? 0.3;

  if (p.basis !== "sufficient") {
    return { spend: true, reason: `basis_${p.basis}: world model lacks sufficient grounding` };
  }
  if (p.confidence < confidenceFloor) {
    return {
      spend: true,
      reason: `confidence_below_floor: ${p.confidence.toFixed(3)} < ${confidenceFloor}`,
    };
  }
  if (p.predicted_residual > residualCeil) {
    return {
      spend: true,
      reason: `predicted_bad: residual ${p.predicted_residual.toFixed(3)} > ${residualCeil}`,
    };
  }
  return {
    spend: false,
    reason: `fast_path: confident (${p.confidence.toFixed(3)}) good (residual ${p.predicted_residual.toFixed(3)})`,
  };
}
