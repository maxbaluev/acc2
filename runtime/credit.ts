// acc2 credit pipeline — Shapley distribution across cited knowledge +
// code artifacts (v2-design.md §3.6.1 Rule 3 + §17 Phase H + §18 cutover
// criterion 8 "knowledge promotion balance").
//
// One outcome (action_scored.residual) → many credit destinations:
//   - The action artifact itself.
//   - The verifier artifact (verifier accrues its own posterior — §11.5,
//     §3.6.1 Rule 3 treats verifiers identically to action artifacts).
//   - Every knowledge_id and code_artifact_id cited by either artifact —
//     pulled from (a) the action_predicted / artifact_observed / action_scored
//     events' context_refs and (b) `@cite k_NNN` or `@cite art_NNN` comments
//     scanned out of the action / verifier bodies.
//
// Shapley by corroboration order:
//   For N cited entities (deduplicated, ordered by first-seen ts):
//     raw_weight_i = 1 / 2^(i+1)
//     normalized_i = raw_weight_i / Σ raw_weight
//   So three corroborators get raw [0.5, 0.25, 0.125] → normalized
//   [0.571, 0.286, 0.143]. The first-discoverer gets the largest share; the
//   tail asymptotes to 1/(2^N) before normalization. After normalization,
//   the weights sum to 1.0 exactly (within float epsilon).
//
// How we apply the weighted outcome:
//   We use the WEIGHTED-POSTERIOR-DELTA approach: applyResidualOutcome
//   produces ΔΑ + ΔΒ. We scale each delta by the entity's weight and
//   apply directly to its posterior. This keeps the residual itself
//   uncolored (the audit row preserves the actual observed residual) and
//   makes the posterior math linear in weight.
//
// Knowledge entries (events with kind='knowledge_candidate' /
// 'knowledge_promoted'): the substrate does not maintain a separate alpha/
// beta column on the events table. Instead we emit explicit
// candidate_confirmed / candidate_contradicted events that the existing
// extractor (extractors.ts:extractKnowledgePromotions) consumes to
// recompute Beta posteriors. Phase H credits flow as one
// candidate_confirmed/contradicted per cited knowledge id, weighted by
// the Shapley share (the weight is recorded on the payload for audit and
// for a future weighted-extractor pass; the existing extractor treats
// each event as unit-weight, which is the canonical Phase H behavior —
// Phase J refines).
//
// Citation source-of-truth (priority order, dedup preserves first-seen):
//   1. context_refs[] on the action_predicted event.
//   2. context_refs[] on the artifact_observed event.
//   3. context_refs[] on the action_scored event.
//   4. `@cite <id>` markers in the action body.
//   5. `@cite <id>` markers in the verifier body.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { getEventById, type EmitEventInput, emitEvent } from "./events";
import { getArtifact, maybePromote, maybeQuarantine } from "./artifact_store";
import { goalShape } from "./goal_shape";
import { nowIso } from "./ids";
import { betaMean, betaStreamConfidence } from "./posterior";
// Audit b7kjyk2k1 / Z9MXJ8YHXN1ZH knowledge cold-start (8.2% candidates ever
// get a verdict). Brain proposal TNY4XZY0GD1W: after each candidate_confirmed
// / candidate_contradicted credit emit, refresh the candidate's posterior
// synchronously so promotion happens at credit time, not at the 5-min
// extractor cadence. Bulk cadence remains the fallback if this refresh fails.
import { maybePromoteKnowledge } from "../substrate/extractors";

// ── LATM novelty bonus (v2-design.md §11.5) ───────────────────────
//
// When an artifact earns credit for a previously-unseen goal_shape (i.e. the
// directive's hashed goal token), its first-time weight is multiplied by
// NOVELTY_BONUS_MULTIPLIER to surface newly-useful artifacts faster. Prior
// credits for the SAME (artifact, goal_shape) pair are detected by scanning
// past `code_artifact_score_updated` events whose payload carries the same
// goal_shape token. The bonus is ADDITIVE to the existing Shapley weight —
// it multiplies the weight only on the first credit, not the residual or the
// posterior delta computation; on later credits for the same shape the
// weight is left untouched.

const DEFAULT_NOVELTY_BONUS_MULTIPLIER = 1.5;

const noveltyBonusMultiplier = (): number => {
  const raw = process.env.ACC2_LATM_NOVELTY_BONUS;
  if (raw === undefined || raw === "") return DEFAULT_NOVELTY_BONUS_MULTIPLIER;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_NOVELTY_BONUS_MULTIPLIER;
  return parsed;
};

/** Resolve the goal_shape hash for a directive by reading its latest
 *  directive_opened payload and feeding `goal`/`intent`/`directive_text`
 *  through `goalShape()`. Returns empty string when no directive_opened row
 *  exists; in that case the novelty check is a no-op. */
const resolveGoalShape = (db: Database, directiveId: string): string => {
  const row = db
    .query(
      `SELECT payload FROM events
       WHERE kind = 'directive_opened' AND directive_id = ?
       ORDER BY ts DESC LIMIT 1`,
    )
    .get(directiveId) as { payload: string } | null;
  if (!row) return "";
  try {
    const p = JSON.parse(row.payload ?? "{}") as Record<string, unknown>;
    const text = (p.directive_text ?? p.goal ?? p.intent ?? "") as string;
    if (!text || typeof text !== "string") return "";
    return goalShape(text);
  } catch {
    return "";
  }
};

/** Check whether `artifactId` has already received credit on `goalShapeStr`.
 *  Scans past `code_artifact_score_updated` events that carry the goal_shape
 *  token in their payload (LIKE match avoids JSON1 dependency). Empty shape
 *  → returns true (no novelty path). */
const artifactSeenGoalShape = (db: Database, artifactId: string, goalShapeStr: string): boolean => {
  if (!goalShapeStr) return true;
  const row = db
    .query(
      `SELECT 1 AS x FROM events
       WHERE kind = 'code_artifact_score_updated'
         AND action_artifact_id = ?
         AND payload LIKE ?
       LIMIT 1`,
    )
    .get(artifactId, `%"goal_shape":"${goalShapeStr}"%`) as { x: number } | null;
  return row !== null;
};

// ── Public types ──────────────────────────────────────────────────

export type CreditContribution = {
  target_id: string;
  target_kind: "knowledge" | "code_artifact";
  weight: number;
  posterior_delta_alpha: number;
  posterior_delta_beta: number;
};

export type CreditDistribution = {
  action_artifact_id: string;
  verifier_artifact_id: string;
  predicted_residual: number;
  observed_residual: number;
  /** |predicted − observed| — closer to 0 means better calibration. */
  delta: number;
  contributions: CreditContribution[];
  /** IDs of every event we emitted (code_artifact_score_updated,
   *  candidate_confirmed/contradicted, code_artifact_promoted, …). */
  emitted_events: string[];
};

export type DistributeCreditParams = {
  action_event_id: string;
  observation_event_id: string;
  scored_event_id: string;
  predicted_residual: number;
  observed_residual: number;
};

// ── Citation extraction ───────────────────────────────────────────

const CITE_RE_SOURCE = "@cite\\s+(k_[a-zA-Z0-9_]+|art_[a-zA-Z0-9_]+|[A-Z0-9]{20,32})";

/** Scan a body for `@cite <id>` markers. Returns first-seen order. */
const extractBodyCitations = (body: string): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = new RegExp(CITE_RE_SOURCE, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const id = m[1]!;
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
};

/** Classify an id as `knowledge` (event id of a candidate / promoted row)
 *  or `code_artifact` (row in code_artifact). Returns `unknown` when the
 *  id resolves to neither — callers default unknown to knowledge so a
 *  citation that names a row we haven't ingested yet still receives
 *  credit when its event lands later. */
const classifyTarget = (db: Database, id: string): "knowledge" | "code_artifact" | "unknown" => {
  const art = db.query("SELECT 1 AS x FROM code_artifact WHERE id = ?").get(id) as { x: number } | null;
  if (art) return "code_artifact";
  const ev = db.query("SELECT kind FROM events WHERE id = ?").get(id) as { kind: string } | null;
  if (ev && (ev.kind === "knowledge_candidate" || ev.kind === "knowledge_promoted")) {
    return "knowledge";
  }
  return "unknown";
};

/** Look up the confidence_estimate field from a cited knowledge entry's
 *  source candidate. When the target id is itself a knowledge_candidate,
 *  read its own payload; when it's a knowledge_promoted, traverse to the
 *  originating candidate via payload.candidate_id. Returns 1.0 (full
 *  weight) when the field is absent or out of [0,1] — backward compatible
 *  with flat-text candidates that don't carry the rich schema. */
const readCandidateConfidenceEstimate = (db: Database, knowledgeId: string): number => {
  const ev = db.query("SELECT kind, payload FROM events WHERE id = ?").get(knowledgeId) as
    | { kind: string; payload: string }
    | null;
  if (!ev) return 1;
  let payloadStr = ev.payload;
  if (ev.kind === "knowledge_promoted") {
    try {
      const p = JSON.parse(payloadStr) as Record<string, unknown>;
      const candId = (p.candidate_id as string | undefined) ?? undefined;
      if (candId) {
        const candEv = db.query("SELECT payload FROM events WHERE id = ?").get(candId) as
          | { payload: string }
          | null;
        if (candEv) payloadStr = candEv.payload;
      }
    } catch { /* fall through with original payload */ }
  }
  try {
    const p = JSON.parse(payloadStr) as Record<string, unknown>;
    const raw = p.confidence_estimate;
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 1) return raw;
  } catch { /* malformed → default */ }
  return 1;
};

// ── Shapley weight computation ────────────────────────────────────

/** Compute Shapley shares by corroboration order. raw_weight_i = 1/2^(i+1);
 *  normalized so Σ weights = 1.0. */
export const shapleyWeightsByCorroboration = (n: number): number[] => {
  if (n <= 0) return [];
  const raw: number[] = [];
  for (let i = 0; i < n; i++) {
    raw.push(1 / Math.pow(2, i + 1));
  }
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((w) => w / sum);
};

// ── Posterior-delta computation (mirrors artifact_store internals) ─

const SUCCESS_BAND = 0.3;
const FAILURE_BAND = 0.7;

/** Compute the alpha/beta deltas for a single residual observation —
 *  matches the algebra in artifact_store.applyResidualOutcome. We need
 *  this here too because credit weighting multiplies the deltas, not the
 *  residual itself (weighting the residual would corrupt the audit row). */
const residualToBetaDeltas = (residual: number): { alphaDelta: number; betaDelta: number } => {
  const r = Math.max(0, Math.min(1, residual));
  let alphaDelta = 0;
  let betaDelta = 0;
  if (r <= SUCCESS_BAND) {
    alphaDelta = 1 - r / SUCCESS_BAND;
  } else if (r >= FAILURE_BAND) {
    betaDelta = (r - FAILURE_BAND) / (1 - FAILURE_BAND);
  } else {
    const t = (r - SUCCESS_BAND) / (FAILURE_BAND - SUCCESS_BAND);
    alphaDelta = (1 - t) * 0.5;
    betaDelta = t * 0.5;
  }
  return { alphaDelta, betaDelta };
};

/** Apply a residual outcome to an artifact's posterior + EMA, scaling the
 *  Beta posterior delta by `weight`. weight=1.0 is identical to the
 *  unweighted applyResidualOutcome from artifact_store.ts; weight>1.0 is
 *  the LATM novelty-bonus path. The EMA itself blends the weighted residual
 *  contribution with a neutral 0.5 background — the same algebra used for
 *  cited-artifact updates downstream — so the EMA stays monotonic in
 *  evidence regardless of N. */
const applyWeightedResidualOutcome = (
  db: Database,
  artifactId: string,
  residual: number,
  weight: number,
  ts: string,
): void => {
  const row = getArtifact(db, artifactId);
  if (!row) throw new Error(`code_artifact_not_found:${artifactId}`);
  const r = Math.max(0, Math.min(1, residual));
  const { alphaDelta, betaDelta } = residualToBetaDeltas(r);
  const newAlpha = row.posteriorAlpha + alphaDelta * weight;
  const newBeta = row.posteriorBeta + betaDelta * weight;
  const newScore = betaMean(newAlpha, newBeta);
  const newConfidence = betaStreamConfidence(newAlpha, newBeta);
  const decay = Math.pow(0.5, 1 / 20);
  // When weight=1.0 this collapses to the unweighted EMA from artifact_store.
  // When weight>1.0 the residual contribution is capped to [0,1] before
  // blending so a bonused observation cannot drive the EMA outside the unit
  // interval.
  const weightedR = weight === 1.0 ? r : Math.min(1, r * weight + 0.5 * (1 - Math.min(1, weight)));
  const newEma = decay * row.recentResidualMean + (1 - decay) * weightedR;
  db.run(
    `UPDATE code_artifact SET
       posterior_alpha = ?, posterior_beta = ?,
       score = ?, confidence = ?,
       recent_residual_mean = ?,
       updated_at = ?
     WHERE id = ?`,
    [newAlpha, newBeta, newScore, newConfidence, newEma, ts, artifactId],
  );
};

// ── Citation collection from the three driving events + bodies ─────

// Differential weighting (2026-05-15 — loop-elegance gap #1):
//   The brain saw K entries in the RETRIEVED KNOWLEDGE prompt section
//   but typically only cites 2-3 of them in action_predicted.context_refs.
//   Pre-fix every prompt-exposed entry got the same Shapley share as
//   an explicitly-cited one — noise drowned signal. Now:
//     - explicit citations (action/obs/scored.context_refs + body @cite)
//       get FULL Shapley weight (factor 1.0).
//     - exposure-only entries (retrieval_binding emitted, NOT cited)
//       get the EXPOSURE_ONLY_FACTOR. Smaller share — they were in the
//       prompt but didn't drive the action, so they earn / lose less.
//   This implements precise attribution without requiring the brain to
//   actively exclude prompt entries; absence-of-citation is the signal.
const EXPOSURE_ONLY_FACTOR = 0.2;
const PROPAGATION_ONLY_FACTOR = 0.35;

type CitationEntry = { id: string; weightFactor: number };

const collectCitations = (
  db: Database,
  params: DistributeCreditParams,
  actionBodyCitations: string[],
  verifierBodyCitations: string[],
  actionArtifactId: string,
  verifierArtifactId: string,
): CitationEntry[] => {
  const seen = new Set<string>();
  const out: CitationEntry[] = [];
  const explicitlyCited = new Set<string>();
  const actionEv = getEventById(db, params.action_event_id);
  const obsEv = getEventById(db, params.observation_event_id);
  const scoredEv = getEventById(db, params.scored_event_id);

  // First pass: every EXPLICIT citation (context_refs across the three
  // events + body @cite markers). These get the full Shapley share.
  const ordered: CitationEntry[] = [];
  for (const ev of [actionEv, obsEv, scoredEv]) {
    if (!ev) continue;
    for (const ref of ev.context_refs ?? []) {
      ordered.push({ id: ref, weightFactor: 1.0 });
      explicitlyCited.add(ref);
    }
  }
  for (const id of actionBodyCitations) {
    ordered.push({ id, weightFactor: 1.0 });
    explicitlyCited.add(id);
  }
  for (const id of verifierBodyCitations) {
    ordered.push({ id, weightFactor: 1.0 });
    explicitlyCited.add(id);
  }

  // Second pass: retrieval_binding source ids — but only as EXPOSURE-ONLY
  // when not already in the explicit set. The dispatch's k_554 four-link
  // chain still closes (every binding feeds credit) but the magnitude
  // tracks whether the brain ACTUALLY cited the entry vs merely saw it.
  if (actionEv && actionEv.task_id && scoredEv) {
    const bindings = db
      .query(
        `SELECT payload FROM events
         WHERE kind = 'retrieval_binding'
           AND task_id = ?
           AND ts <= ?
         ORDER BY ts ASC`,
      )
      .all(actionEv.task_id, scoredEv.ts) as Array<{ payload: string }>;
    for (const b of bindings) {
      try {
        const p = JSON.parse(b.payload) as Record<string, unknown>;
        const sourceId = p.source_event_id as string | undefined;
        if (!sourceId) continue;
        const factor = explicitlyCited.has(sourceId) ? 1.0 : EXPOSURE_ONLY_FACTOR;
        ordered.push({ id: sourceId, weightFactor: factor });
      } catch { /* skip malformed */ }
    }
  }

  if (actionEv && actionEv.task_id && scoredEv) {
    const propagated = db
      .query(
        `SELECT payload FROM events
         WHERE kind = 'knowledge_propagated'
           AND task_id = ?
           AND ts <= ?
         ORDER BY ts ASC`,
      )
      .all(actionEv.task_id, scoredEv.ts) as Array<{ payload: string }>;
    for (const row of propagated) {
      try {
        const p = JSON.parse(row.payload) as Record<string, unknown>;
        const sourceId = p.source_event_id as string | undefined;
        if (!sourceId) continue;
        const factor = explicitlyCited.has(sourceId) ? 1.0 : PROPAGATION_ONLY_FACTOR;
        ordered.push({ id: sourceId, weightFactor: factor });
      } catch { /* skip malformed */ }
    }
  }

  for (const entry of ordered) {
    // Skip the action + verifier artifact ids themselves — they receive
    // primary credit, not third-party citation credit.
    if (entry.id === actionArtifactId || entry.id === verifierArtifactId) continue;
    const existing = out.find((c) => c.id === entry.id);
    if (existing) {
      existing.weightFactor = Math.max(existing.weightFactor, entry.weightFactor);
      continue;
    }
    if (!seen.has(entry.id)) {
      seen.add(entry.id);
      out.push(entry);
    }
  }
  return out;
};

// ── Public entry point ───────────────────────────────────────────

/** Distribute one action_scored outcome across cited knowledge + artifacts
 *  via Shapley decomposition by corroboration order (§3.6.1 Rule 3).
 *
 *  Workflow:
 *    1. Resolve the action_predicted event → action + verifier artifact ids.
 *    2. Apply full-weight residual outcome to action + verifier (primary
 *       observers — not third-party citations).
 *    3. Extract third-party citations from context_refs + body @cite markers.
 *    4. Compute Shapley weights by corroboration position.
 *    5. Apply the WEIGHTED Beta posterior delta to each cited code_artifact;
 *       emit candidate_confirmed/contradicted for each cited knowledge id.
 *    6. After every posterior update, fire maybePromote / maybeQuarantine.
 *    7. Emit `code_artifact_score_updated` for every artifact touched.
 *
 *  Returns a summary suitable for the substrate.credit MCP response.
 */
export const distributeCredit = async (
  db: Database,
  params: DistributeCreditParams,
): Promise<CreditDistribution> => {
  const actionEv = getEventById(db, params.action_event_id);
  if (!actionEv) throw new Error(`action_event_not_found:${params.action_event_id}`);
  if (actionEv.kind !== "action_predicted") {
    throw new Error(`action_event_kind_mismatch:${actionEv.kind}`);
  }
  const actionArtifactId = actionEv.action_artifact_id;
  const verifierArtifactId = actionEv.verifier_artifact_id;
  if (!actionArtifactId || !verifierArtifactId) {
    throw new Error("action_event_missing_artifact_ids");
  }
  const actionArt = getArtifact(db, actionArtifactId);
  const verifierArt = getArtifact(db, verifierArtifactId);
  // Synthetic substrate actuators — owner_profile_promoter,
  // knowledge_promotion, code_artifact_promotion, recipe_*,
  // auto_apply_worker_stage2, etc — emit action_predicted +
  // action_scored events but are NOT registered code_artifact rows
  // (they're substrate-side primitives, not brain-authored scripts).
  // For these paths, skip the primary artifact posterior updates
  // (there's no row to update) but CONTINUE through collectCitations
  // so cited candidates/knowledge still receive
  // candidate_confirmed/candidate_contradicted evidence. Throwing
  // here would leave every substrate-side spine without credit flow.
  const primaryArtifactsRegistered = Boolean(actionArt && verifierArt);

  const ts = nowIso();
  const emittedEvents: string[] = [];

  // Inherit directive_id / task_id from the action_predicted event so every
  // credit-side event stays attached to the same task surface. Auditors
  // filter by task_id to assemble a per-task credit trail.
  const inheritDirectiveId = actionEv.directive_id;
  const inheritTaskId = actionEv.task_id;

  // Resolve the goal_shape hash for the directive ONCE and reuse across
  // every credit destination. Empty shape disables the novelty path (e.g.
  // synthetic test events that never opened a directive).
  const directiveGoalShape = resolveGoalShape(db, inheritDirectiveId);
  const noveltyMultiplier = noveltyBonusMultiplier();

  const emit = (event: EmitEventInput): string => {
    const result = emitEvent(db, {
      ...event,
      directive_id: event.directive_id ?? inheritDirectiveId,
      task_id: event.task_id ?? inheritTaskId,
      invoker: event.invoker ?? "substrate_auto",
    });
    emittedEvents.push(result.id);
    return result.id;
  };

  /** Apply the LATM novelty bonus when an artifact earns credit on a
   *  previously-unseen goal_shape. Returns the (possibly-boosted) weight.
   *  Emits a `latm_novelty_bonus_applied` event so the bonus is auditable.
   *  The check runs BEFORE the matching `code_artifact_score_updated` event
   *  for this credit is emitted — that's important because the post-credit
   *  score update is the row that "claims" this goal_shape for future calls. */
  const applyNoveltyBonus = (artifactId: string, baseWeight: number): number => {
    if (!directiveGoalShape) return baseWeight;
    if (artifactSeenGoalShape(db, artifactId, directiveGoalShape)) return baseWeight;
    const bonusWeight = baseWeight * noveltyMultiplier;
    emit({
      kind: "latm_novelty_bonus_applied",
      substrate_origin: "substrate_auto",
      action_artifact_id: artifactId,
      payload: {
        artifact_id: artifactId,
        goal_shape: directiveGoalShape,
        base_weight: baseWeight,
        bonus_weight: bonusWeight,
        multiplier: noveltyMultiplier,
        scored_event_id: params.scored_event_id,
      } as JsonValue,
    });
    return bonusWeight;
  };

  // 1. Primary credit — full-weight applyResidualOutcome on action + verifier.
  //
  //    LATM novelty bonus (§11.5): if this artifact has never received credit
  //    for this directive's goal_shape before, multiply its credit weight by
  //    NOVELTY_BONUS_MULTIPLIER. The bonus is captured by applying the
  //    weighted Beta delta INSTEAD of the unweighted applyResidualOutcome
  //    when weight ≠ 1.0; the EMA still uses the raw residual so the audit
  //    surface stays honest.
  //
  //    Important ordering: we must check novelty BEFORE emitting the
  //    `code_artifact_score_updated` row that stamps this goal_shape onto
  //    the artifact's history; otherwise the verifier's check would observe
  //    the action's stamp and miss its own novelty.
  let computedActionWeight = 1.0;
  let computedVerifierWeight = 1.0;
  if (primaryArtifactsRegistered) {
    computedActionWeight = applyNoveltyBonus(actionArt!.id, 1.0);
    computedVerifierWeight = applyNoveltyBonus(verifierArt!.id, 1.0);
    applyWeightedResidualOutcome(db, actionArt!.id, params.observed_residual, computedActionWeight, ts);
    applyWeightedResidualOutcome(db, verifierArt!.id, params.observed_residual, computedVerifierWeight, ts);
  } else {
    // Synthetic actuator path: record the skip so observers can see the
    // credit chain ran but skipped primary artifact updates. Cited
    // candidates STILL get credit downstream via collectCitations.
    emit({
      kind: "constitutional_gate_decision",
      substrate_origin: "substrate_auto",
      payload: {
        gate: "credit_synthetic_actuator",
        reason: "primary artifacts not registered; skipping artifact posterior update, continuing citation credit",
        action_artifact_id: actionArtifactId,
        verifier_artifact_id: verifierArtifactId,
        scored_event_id: params.scored_event_id,
      } as JsonValue,
    });
  }

  // Artifact-row-dependent surface (score_updated, promotion checks,
  // body citation extraction) only runs when primary artifacts are
  // registered. Synthetic actuators skip cleanly here and still
  // distribute citation credit below.
  if (primaryArtifactsRegistered) {
    const actionRowPost = getArtifact(db, actionArt!.id)!;
    emit({
      kind: "code_artifact_score_updated",
      substrate_origin: "substrate_auto",
      action_artifact_id: actionArt!.id,
      payload: {
        artifact_id: actionArt!.id,
        role: "action",
        residual: params.observed_residual,
        weight: computedActionWeight,
        score: actionRowPost.score,
        confidence: actionRowPost.confidence,
        scored_event_id: params.scored_event_id,
        goal_shape: directiveGoalShape,
      } as JsonValue,
    });
    const verifierRowPost = getArtifact(db, verifierArt!.id)!;
    emit({
      kind: "code_artifact_score_updated",
      substrate_origin: "substrate_auto",
      action_artifact_id: verifierArt!.id,
      payload: {
        artifact_id: verifierArt!.id,
        role: "verifier",
        residual: params.observed_residual,
        weight: computedVerifierWeight,
        score: verifierRowPost.score,
        confidence: verifierRowPost.confidence,
        scored_event_id: params.scored_event_id,
        goal_shape: directiveGoalShape,
      } as JsonValue,
    });

    // 2. Promotion / quarantine checks on action + verifier.
    maybePromote(db, actionArt!.id, (e) => emit(e));
    maybeQuarantine(db, actionArt!.id, (e) => emit(e));
    maybePromote(db, verifierArt!.id, (e) => emit(e));
    maybeQuarantine(db, verifierArt!.id, (e) => emit(e));
  }

  // 3. Third-party citations — Shapley distribute. Body citations only
  // exist when artifacts are registered (no body to scan otherwise).
  const actionBodyCites = primaryArtifactsRegistered ? extractBodyCitations(actionArt!.body) : [];
  const verifierBodyCites = primaryArtifactsRegistered ? extractBodyCitations(verifierArt!.body) : [];
  const cited = collectCitations(
    db,
    params,
    actionBodyCites,
    verifierBodyCites,
    actionArtifactId,
    verifierArtifactId,
  );
  const weights = shapleyWeightsByCorroboration(cited.length);
  const { alphaDelta, betaDelta } = residualToBetaDeltas(params.observed_residual);

  const contributions: CreditContribution[] = [];

  for (let i = 0; i < cited.length; i++) {
    const targetId = cited[i]!.id;
    // Differential weighting: explicit citations get full Shapley share;
    // exposure-only (in prompt via retrieval_binding but uncited) gets
    // EXPOSURE_ONLY_FACTOR. See collectCitations for rationale.
    const baseWeight = weights[i]! * cited[i]!.weightFactor;
    const kind = classifyTarget(db, targetId);

    if (kind === "code_artifact") {
      // Apply the LATM novelty bonus on the Shapley share — first-time
      // goal_shape credit on this cited artifact gets a multiplier on its
      // weight so a newly-useful artifact rises faster. Idempotent on
      // subsequent credits for the same shape (returns baseWeight).
      const weight = applyNoveltyBonus(targetId, baseWeight);
      const wAlpha = alphaDelta * weight;
      const wBeta = betaDelta * weight;
      // Apply the weighted Beta posterior delta directly. We hand-roll the
      // update instead of calling applyResidualOutcome because we need a
      // per-entity weighted DELTA, not a single residual the function
      // would interpret unweighted.
      const row = getArtifact(db, targetId);
      if (row) {
        const newAlpha = row.posteriorAlpha + wAlpha;
        const newBeta = row.posteriorBeta + wBeta;
        const newScore = betaMean(newAlpha, newBeta);
        const newConfidence = betaStreamConfidence(newAlpha, newBeta);
        // EMA blends the WEIGHTED residual contribution with a neutral 0.5
        // background: the entity owns `weight` of the responsibility and
        // shares the rest with the substrate average. This keeps the EMA
        // monotonic in evidence regardless of N. Cap the weight inside the
        // mix-formula at 1.0 to keep the EMA bounded when the novelty bonus
        // would otherwise overshoot.
        const r = Math.max(0, Math.min(1, params.observed_residual));
        const decay = Math.pow(0.5, 1 / 20);
        const wForEma = Math.min(1, weight);
        const newEma = decay * row.recentResidualMean + (1 - decay) * (r * wForEma + 0.5 * (1 - wForEma));
        db.run(
          `UPDATE code_artifact SET
             posterior_alpha = ?, posterior_beta = ?,
             score = ?, confidence = ?,
             recent_residual_mean = ?,
             updated_at = ?
           WHERE id = ?`,
          [newAlpha, newBeta, newScore, newConfidence, newEma, ts, targetId],
        );
        maybePromote(db, targetId, (e) => emit(e));
        maybeQuarantine(db, targetId, (e) => emit(e));
        emit({
          kind: "code_artifact_score_updated",
          substrate_origin: "substrate_auto",
          action_artifact_id: targetId,
          payload: {
            artifact_id: targetId,
            role: "cited",
            weight,
            residual: params.observed_residual,
            score: newScore,
            confidence: newConfidence,
            scored_event_id: params.scored_event_id,
            goal_shape: directiveGoalShape,
          } as JsonValue,
        });
      }
      contributions.push({
        target_id: targetId,
        target_kind: "code_artifact",
        weight,
        posterior_delta_alpha: wAlpha,
        posterior_delta_beta: wBeta,
      });
    } else if (kind === "knowledge" || kind === "unknown") {
      // Knowledge credit — emit candidate_confirmed/contradicted citing the
      // knowledge id. The existing extractor (extractors.ts) consumes these
      // and recomputes Beta posteriors → knowledge_promoted/_demoted on
      // threshold crossings. Knowledge entries do NOT receive the LATM
      // novelty bonus — the bonus is artifact-specific (§11.5 frames it as a
      // Voyager-style authoring-loop signal).
      //
      // Confidence-weighted credit (Batch 1 — 2026-05-15): the brain emits
      // a confidence_estimate on rich-schema knowledge_candidates. Scale
      // the Shapley share by that confidence so the brain's self-assessed
      // strong claims get more weight than tentative ones. Flat candidates
      // (without confidence_estimate) default to weight=1.0 — backward
      // compatible. The weight lands on candidate_confirmed.payload so the
      // extractor reads the fractional contribution.
      const confidenceEstimate = readCandidateConfidenceEstimate(db, targetId);
      const knowledgeWeight = baseWeight * confidenceEstimate;
      const kAlpha = alphaDelta * knowledgeWeight;
      const kBeta = betaDelta * knowledgeWeight;
      const r = Math.max(0, Math.min(1, params.observed_residual));
      const knowledgeKind: "candidate_confirmed" | "candidate_contradicted" =
        r >= FAILURE_BAND ? "candidate_contradicted" : "candidate_confirmed";
      const id = emit({
        kind: knowledgeKind,
        substrate_origin: "substrate_auto",
        context_refs: [targetId, params.scored_event_id],
        payload: {
          knowledge_id: targetId,
          residual: r,
          weight: knowledgeWeight,
          base_shapley_weight: baseWeight,
          confidence_estimate: confidenceEstimate,
          scored_event_id: params.scored_event_id,
          polarity: r >= FAILURE_BAND ? "deny" : r <= SUCCESS_BAND ? "assert" : "midband",
        } as JsonValue,
      });
      // The id is already appended inside emit(); avoid double-pushing.
      void id;
      // Synchronous promotion refresh (audit b7kjyk2k1 / TNY4XZY0GD1W).
      // Newly-credited candidates become searchable immediately rather
      // than waiting the full extractors cadence. Bulk cadence remains
      // the fallback — credit emission must not fail if refresh did.
      try {
        maybePromoteKnowledge(db, targetId);
      } catch {
        /* bulk extractor cadence remains the fallback */
      }
      contributions.push({
        target_id: targetId,
        target_kind: "knowledge",
        weight: knowledgeWeight,
        posterior_delta_alpha: kAlpha,
        posterior_delta_beta: kBeta,
      });
    }
  }

  return {
    action_artifact_id: actionArt.id,
    verifier_artifact_id: verifierArt.id,
    predicted_residual: params.predicted_residual,
    observed_residual: params.observed_residual,
    delta: Math.abs(params.predicted_residual - params.observed_residual),
    contributions,
    emitted_events: emittedEvents,
  };
};

// ── Internal exports for tests ────────────────────────────────────

export const __extractBodyCitationsForTest = extractBodyCitations;
export const __collectCitationsForTest = collectCitations;
export const __residualToBetaDeltasForTest = residualToBetaDeltas;
