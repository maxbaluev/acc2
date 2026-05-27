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

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

// ── Residual → Beta-delta band mapping (canonical home, P6 stage B) ──
//
// The success/failure band algebra used to live in `artifact_store.ts`
// and was lazily-required back into this module (the stage-A hack noted
// below). P6 stage B makes posterior.ts the CANONICAL home of the band
// constants + the residual→delta map; artifact_store imports
// `residualToBetaDeltas` statically from here, so there is no longer a
// module-load cycle (posterior.ts has no static import OF artifact_store).
//
//   - residual ≤ SUCCESS_BAND (0.3) counts as a "success": αΔ grows from
//     1 (residual 0) → 0 (band boundary).
//   - residual ≥ FAILURE_BAND (0.7) counts as a "failure": βΔ grows from
//     0 (band boundary) → 1 (residual 1).
//   - Mid-band 0.3 < r < 0.7 tapers both αΔ and βΔ across 0.5 so the
//     posterior tracks informativeness without forcing a discrete
//     win/loss.

/** Success band: residual at/below this counts (proportionally) as a win. */
export const SUCCESS_BAND = 0.3;
/** Failure band: residual at/above this counts (proportionally) as a loss. */
export const FAILURE_BAND = 0.7;

/** Compute the (unweighted) Beta posterior deltas for a single residual
 *  observation, using the standard success/failure bands. Exported so
 *  `runtime/artifact_store.ts` (per-artifact health), `runtime/credit.ts`
 *  (Shapley-weighted per-citation credit) and the consolidated
 *  `applyScoredOutcome` primitive all share ONE copy of the band algebra.
 *  residual is clamped to [0,1] defensively; a non-finite residual yields
 *  zero deltas (no posterior movement). */
export const residualToBetaDeltas = (
  residual: number | null | undefined,
): { alphaDelta: number; betaDelta: number } => {
  if (typeof residual !== "number" || !Number.isFinite(residual)) {
    return { alphaDelta: 0, betaDelta: 0 };
  }
  const r = clamp01(residual);
  let alphaDelta = 0;
  let betaDelta = 0;
  if (r <= SUCCESS_BAND) {
    alphaDelta = 1 - r / SUCCESS_BAND;
  } else if (r >= FAILURE_BAND) {
    betaDelta = (r - FAILURE_BAND) / (1 - FAILURE_BAND);
  } else {
    // Linear interpolation across the mid-band.
    const t = (r - SUCCESS_BAND) / (FAILURE_BAND - SUCCESS_BAND);
    alphaDelta = (1 - t) * 0.5; // taper from 0.5 → 0 across mid-band
    betaDelta = t * 0.5;        // taper from 0 → 0.5 across mid-band
  }
  return { alphaDelta, betaDelta };
};

// ── Canonical scored-entity primitive (P6 consolidation, stage A) ────
//
// Brain amendment 5XRDMG6G, stage A — ADDITIVE ONLY. The substrate has
// ≥4 parallel Beta-posterior update mechanisms (act_artifact via
// artifact_store.applyResidualOutcome, knowledge candidates via the
// extractor corroboration pipeline, code-artifact scoring, bespoke
// recipe confidence) audited by as many event families
// (act_artifact_score_updated / code_artifact_score_updated /
// candidate_confirmed / candidate_contradicted / …). The end state of
// the P6 consolidation is ONE `scored_entity` row, updated by ONE
// `applyScoredOutcome` primitive, audited by ONE `entity_score_updated`
// event.
//
// THIS STAGE introduces ONLY that primitive + its row + its event kind.
// No existing consumer is migrated and no existing event kind / table /
// path is removed in this stage — consumers migrate in later stages.
// The primitive is unused-by-default; admitting it changes no live
// behaviour.
//
// It REUSES the existing posterior math verbatim rather than inventing
// new algebra:
//   * residual → (αΔ, βΔ): `residualToBetaDeltas` — the SUCCESS_BAND=0.3 /
//     FAILURE_BAND=0.7 band logic, now CANONICAL in this module (P6 stage
//     B moved it here; artifact_store imports it statically, so the
//     stage-A lazy-require cycle hack is gone).
//   * score = `betaMean(α, β)` — identical to artifact_store's
//     `recomputeScore`.
//   * confidence = `betaStreamConfidence(α, β)` — identical to
//     artifact_store's `recomputeConfidence` (1 − 1/√(α+β+1)).
//   * half-life decay of accumulated evidence (α−1, β−1) before the new
//     delta lands — the SAME 30-day exponential decay applyResidualOutcome
//     uses, so an old scored_entity ages out stale evidence the same way.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";

/** Default Beta-posterior evidence half-life: 30 days. Identical to
 *  artifact_store.DEFAULT_POSTERIOR_HALF_LIFE_MS — old corroborations
 *  halve their weight every half-life so fresh contradictions can move a
 *  long-lived entity's posterior. The prior (α=1, β=1) is never decayed;
 *  only the accumulated evidence (α−1, β−1) ages. */
export const SCORED_ENTITY_POSTERIOR_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

/** Exponentially decay accumulated evidence over elapsed wall time —
 *  the same shape `artifact_store.decayedEvidence` uses. */
const decayedEvidence = (currentEvidence: number, dtMs: number): number => {
  const halfLife = SCORED_ENTITY_POSTERIOR_HALF_LIFE_MS;
  if (halfLife <= 0 || dtMs <= 0) return currentEvidence;
  return currentEvidence * Math.pow(0.5, dtMs / halfLife);
};

/** A single scored learnable entity. The consolidation target: every
 *  posterior-scored thing (artifact, knowledge candidate, recipe, edge,
 *  motif, …) becomes one row in `scored_entity`, keyed by its id, tagged
 *  with its free-string `entity_kind`. The shape mirrors the score columns
 *  already on `act_artifact` (posterior_alpha / posterior_beta / score /
 *  confidence) so a later migration can fold the existing rows in. */
export type ScoredEntity = {
  entity_id: string;
  entity_kind: string;
  posterior_alpha: number;
  posterior_beta: number;
  score: number;
  confidence: number;
  updated_ts: string;
};

const mapScoredEntityRow = (raw: Record<string, unknown>): ScoredEntity => ({
  entity_id: raw.entity_id as string,
  entity_kind: raw.entity_kind as string,
  posterior_alpha: raw.posterior_alpha as number,
  posterior_beta: raw.posterior_beta as number,
  score: raw.score as number,
  confidence: raw.confidence as number,
  updated_ts: raw.updated_ts as string,
});

/** Read a scored_entity row by id, or null when none exists yet. */
export const getScoredEntity = (db: Database, entityId: string): ScoredEntity | null => {
  const row = db
    .query("SELECT * FROM scored_entity WHERE entity_id = ?")
    .get(entityId) as Record<string, unknown> | null;
  return row ? mapScoredEntityRow(row) : null;
};

export type ApplyScoredOutcomeInput = {
  /** Stable id of the scored thing (artifact id, knowledge source_event_id, …). */
  entity_id: string;
  /** Free-string discriminator (e.g. "act_artifact", "knowledge_candidate",
   *  "recipe", "causal_edge"). Open vocabulary — admitted, not enumerated. */
  entity_kind: string;
  /** Observed residual ∈ [0,1] (0 = perfect, 1 = total miss). One of
   *  `residual` / `outcome` is required; `residual` wins when both given. */
  residual?: number;
  /** Coarse outcome shorthand: "succeeded" → residual 0, "failed" →
   *  residual 1. Ignored when `residual` is supplied. */
  outcome?: "succeeded" | "failed";
  /** ISO timestamp of the observation (drives the half-life decay window). */
  ts: string;
  /** Optional weight scales the residual-derived Beta deltas. */
  weight?: number;
  /** Optional seed for first migration of an existing scored row. */
  initial_posterior?: { posterior_alpha: number; posterior_beta: number; updated_ts?: string };
  /** Optional event-routing context carried onto the entity_score_updated row. */
  directive_id?: string;
  task_id?: string;
  context_refs?: string[];
  /** Optional caller-supplied idempotency key for the canonical score event. */
  projection_key?: string;
  /** Optional extra payload fields merged onto the audit event. */
  payload?: Record<string, JsonValue>;
};

/** The single update primitive for the consolidated scoring substrate.
 *
 *  Upserts the `scored_entity` row for `entity_id`, applies the SAME Beta
 *  update + half-life decay + score/confidence recompute that
 *  `artifact_store.applyResidualOutcome` uses, and emits ONE
 *  `entity_score_updated` audit event. The emit is idempotent on a
 *  projection key (`entity_score:{entity_id}:{ts}`) — re-running the
 *  identical outcome (same entity, same ts) is a no-op on the second
 *  pass: no duplicate event, no double posterior movement. Returns the
 *  updated posterior.
 *
 *  ADDITIVE: nothing reads or writes this table or event kind yet. The
 *  primitive is the consolidation target; consumers migrate onto it in
 *  later stages of amendment 5XRDMG6G. */
export const applyScoredOutcome = (
  db: Database,
  input: ApplyScoredOutcomeInput,
): ScoredEntity => {
  const { emitEvent } = require("./events") as typeof import("./events");

  const residual = clamp01(
    typeof input.residual === "number" && Number.isFinite(input.residual)
      ? input.residual
      : input.outcome === "failed"
        ? 1
        : 0,
  );
  const weight = typeof input.weight === "number" && Number.isFinite(input.weight)
    ? Math.max(0, input.weight)
    : 1.0;
  const ts = input.ts;
  const projectionKey = typeof input.projection_key === "string" && input.projection_key.length > 0
    ? input.projection_key
    : `entity_score:${input.entity_id}:${ts}`;

  // Idempotency gate — first-wins. A prior entity_score_updated row with
  // the same projection_key means this exact outcome already landed; the
  // posterior was already moved on that pass. Return the current row
  // unchanged (no second movement, no duplicate event). Mirrors the
  // existingProjection() first-wins shape in runtime/events.ts.
  const alreadyApplied = db
    .query<{ id: string }, [string]>(
      "SELECT id FROM events WHERE kind = 'entity_score_updated' AND json_extract(payload, '$.projection_key') = ? LIMIT 1",
    )
    .get(projectionKey);
  if (alreadyApplied) {
    const current = getScoredEntity(db, input.entity_id);
    if (current) return current;
    // Defensive: event exists but row missing (e.g. table reset between
    // runs) — fall through and recompute so the row is restored.
  }

  const prior = getScoredEntity(db, input.entity_id);
  const initial = input.initial_posterior;
  const initialAlpha = typeof initial?.posterior_alpha === "number" && Number.isFinite(initial.posterior_alpha)
    ? initial.posterior_alpha
    : 1;
  const initialBeta = typeof initial?.posterior_beta === "number" && Number.isFinite(initial.posterior_beta)
    ? initial.posterior_beta
    : 1;
  const priorEvidence = prior ? Math.max(0, prior.posterior_alpha - 1) + Math.max(0, prior.posterior_beta - 1) : -1;
  const initialEvidence = Math.max(0, initialAlpha - 1) + Math.max(0, initialBeta - 1);
  const seedFromInitial = initialEvidence > priorEvidence;
  const prevAlpha = seedFromInitial ? initialAlpha : (prior?.posterior_alpha ?? initialAlpha);
  const prevBeta = seedFromInitial ? initialBeta : (prior?.posterior_beta ?? initialBeta);
  const prevUpdatedTs = seedFromInitial ? initial?.updated_ts : (prior?.updated_ts ?? initial?.updated_ts);
  const prevTs = prevUpdatedTs ? Date.parse(prevUpdatedTs) : NaN;
  const curTs = Date.parse(ts);
  const dtMs = Number.isFinite(prevTs) && Number.isFinite(curTs) ? Math.max(0, curTs - prevTs) : 0;

  const rawDeltas = residualToBetaDeltas(residual);
  const alphaDelta = rawDeltas.alphaDelta * weight;
  const betaDelta = rawDeltas.betaDelta * weight;
  // Decay accumulated evidence (α−1, β−1); the prior (1,1) stays fixed.
  const newAlpha = 1 + decayedEvidence(Math.max(0, prevAlpha - 1), dtMs) + alphaDelta;
  const newBeta = 1 + decayedEvidence(Math.max(0, prevBeta - 1), dtMs) + betaDelta;
  const newScore = betaMean(newAlpha, newBeta);
  const newConfidence = betaStreamConfidence(newAlpha, newBeta);

  db.run(
    `INSERT INTO scored_entity (entity_id, entity_kind, posterior_alpha, posterior_beta, score, confidence, updated_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(entity_id) DO UPDATE SET
       entity_kind = excluded.entity_kind,
       posterior_alpha = excluded.posterior_alpha,
       posterior_beta = excluded.posterior_beta,
       score = excluded.score,
       confidence = excluded.confidence,
       updated_ts = excluded.updated_ts`,
    [input.entity_id, input.entity_kind, newAlpha, newBeta, newScore, newConfidence, ts],
  );

  emitEvent(db, {
    kind: "entity_score_updated",
    substrate_origin: "substrate_auto",
    directive_id: input.directive_id,
    task_id: input.task_id,
    context_refs: input.context_refs,
    // The audit event must not spawn an act_tuple projection cascade — it
    // is a leaf posterior-movement record, like act_artifact_score_updated.
    projectActTuple: false,
    payload: {
      ...(input.payload ?? {}),
      projection_key: projectionKey,
      entity_id: input.entity_id,
      entity_kind: input.entity_kind,
      residual,
      weight,
      posterior_alpha: newAlpha,
      posterior_beta: newBeta,
      score: newScore,
      confidence: newConfidence,
    } as JsonValue,
  });

  return getScoredEntity(db, input.entity_id) as ScoredEntity;
};
