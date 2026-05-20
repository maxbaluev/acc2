// acc2 credit pipeline — Shapley distribution across cited knowledge +
// code artifacts (v2-design.md §3.6.1 Rule 3 + §17 Phase H + §18 cutover
// criterion 8 "knowledge promotion balance").
//
// One outcome (action_scored.residual) → many credit destinations:
//   - The action artifact itself.
//   - The verifier artifact (verifier accrues its own posterior — §11.5,
//     §3.6.1 Rule 3 treats verifiers identically to action artifacts).
//   - Every knowledge_id and act_artifact_id cited by either artifact —
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
import {
  applyResidualOutcome,
  getArtifact,
  maybePromote,
  residualToBetaDeltas,
} from "./artifact_store";
import { goalShape } from "./goal_shape";
import { nowIso } from "./ids";
// Audit b7kjyk2k1 / Z9MXJ8YHXN1ZH knowledge cold-start (8.2% candidates ever
// get a verdict). Brain proposal TNY4XZY0GD1W: after each candidate_confirmed
// / candidate_contradicted credit emit, refresh the candidate's posterior
// synchronously so promotion happens at credit time, not at the 5-min
// extractor cadence. Bulk cadence remains the fallback if this refresh fails.
import { maybePromoteKnowledge } from "../substrate/extractors";
import { getThreshold } from "./threshold_registry";

// ── LATM novelty bonus (v2-design.md §11.5) ───────────────────────
//
// When an artifact earns credit for a previously-unseen goal_shape (i.e. the
// directive's hashed goal token), its first-time weight is multiplied by
// NOVELTY_BONUS_MULTIPLIER to surface newly-useful artifacts faster. Prior
// credits for the SAME (artifact, goal_shape) pair are detected by scanning
// past `act_artifact_score_updated` events whose payload carries the same
// goal_shape token. The bonus is ADDITIVE to the existing Shapley weight —
// it multiplies the weight only on the first credit, not the residual or the
// posterior delta computation; on later credits for the same shape the
// weight is left untouched.

// Universal value — 1.5× first-credit bonus per novel goal_shape token.
// T2.1 F-Universal-Threshold-Registry: the cold-start default is the
// hardcoded 1.5, but the runtime now reads from
// act_artifact{kind:"threshold_predicate", name:"novelty_bonus_multiplier"}
// when a posterior-ranked row exists, so the multiplier calibrates from
// observed novelty/promotion correlation through the standard
// maybePromote/maybeQuarantine machinery rather than staying frozen.
const NOVELTY_BONUS_MULTIPLIER = 1.5;

const noveltyBonusMultiplier = (db: Database): number =>
  getThreshold(db, "novelty_bonus_multiplier", NOVELTY_BONUS_MULTIPLIER);

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
 *  Scans past `act_artifact_score_updated` events that carry the goal_shape
 *  token in their payload (LIKE match avoids JSON1 dependency). Empty shape
 *  → returns true (no novelty path). */
const artifactSeenGoalShape = (db: Database, artifactId: string, goalShapeStr: string): boolean => {
  if (!goalShapeStr) return true;
  const row = db
    .query(
      `SELECT 1 AS x FROM events
       WHERE kind = 'act_artifact_score_updated'
         AND action_artifact_id = ?
         AND payload LIKE ?
       LIMIT 1`,
    )
    .get(artifactId, `%"goal_shape":"${goalShapeStr}"%`) as { x: number } | null;
  return row !== null;
};

// ── Internal types ─────────────────────────────────────────────────

type CreditContribution = {
  target_id: string;
  target_kind: "knowledge" | "act_artifact";
  weight: number;
  posterior_delta_alpha: number;
  posterior_delta_beta: number;
};

type CreditDistribution = {
  action_artifact_id: string;
  verifier_artifact_id: string;
  predicted_residual: number;
  observed_residual: number;
  /** |predicted − observed| — closer to 0 means better calibration. */
  delta: number;
  contributions: CreditContribution[];
  /** IDs of every event we emitted (act_artifact_score_updated,
   *  candidate_confirmed/contradicted, act_artifact_promoted, …). */
  emitted_events: string[];
};

type DistributeCreditParams = {
  action_event_id: string;
  observation_event_id: string;
  scored_event_id: string;
  predicted_residual: number;
  observed_residual: number;
};

type EventLike = NonNullable<ReturnType<typeof getEventById>>;

type CreditProjectionMetadata = {
  sourceActId: string | null;
  ownerEvidenceEventId: string | null;
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
 *  or `act_artifact` (row in act_artifact). Returns `unknown` when the
 *  id resolves to neither — callers default unknown to knowledge so a
 *  citation that names a row we haven't ingested yet still receives
 *  credit when its event lands later. */
const classifyTarget = (db: Database, id: string): "knowledge" | "act_artifact" | "unknown" => {
  const art = db.query("SELECT 1 AS x FROM act_artifact WHERE id = ?").get(id) as { x: number } | null;
  if (art) return "act_artifact";
  const ev = db.query("SELECT kind FROM events WHERE id = ?").get(id) as { kind: string } | null;
  if (ev && (ev.kind === "knowledge_candidate" || ev.kind === "knowledge_promoted")) {
    return "knowledge";
  }
  return "unknown";
};

const jsonObject = (value: JsonValue | undefined): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const stringArrayField = (payload: Record<string, unknown>, key: string): string[] =>
  Array.isArray(payload[key]) ? (payload[key] as unknown[]).filter((item): item is string => typeof item === "string" && item.length > 0) : [];

const resolveSourceActId = (events: Array<EventLike | null>): string | null => {
  for (const ev of events) {
    if (!ev) continue;
    const payload = jsonObject(ev.payload);
    const direct = payload.source_act_id;
    if (typeof direct === "string" && direct.length > 0) return direct;
    const projection = jsonObject(payload.projection as JsonValue | undefined);
    if (typeof projection.source_act_id === "string" && projection.source_act_id.length > 0) return projection.source_act_id;
    const actTuple = jsonObject(payload.act_tuple as JsonValue | undefined);
    if (typeof actTuple.source_act_id === "string" && actTuple.source_act_id.length > 0) return actTuple.source_act_id;
  }
  return null;
};

const clampResidual = (value: number): number => Math.max(0, Math.min(1, value));

const residualFromOwnerObservedOutcome = (ownerEv: EventLike, fallback: number): number => {
  if (typeof ownerEv.residual === "number" && Number.isFinite(ownerEv.residual)) return clampResidual(ownerEv.residual);
  const payload = jsonObject(ownerEv.payload);
  if (typeof payload.residual === "number" && Number.isFinite(payload.residual)) return clampResidual(payload.residual);
  // signal_class is an open string carrying the owner's
  // qualitative verdict (positive_strong, positive_weak, negative_weak,
  // negative_strong, neutral, …). Map known classes onto residual; unknown
  // strings fall through to the verdict-text path. The vocabulary is
  // discovered through use — emitters may leave the field unset.
  const signalClass = typeof payload.signal_class === "string" ? payload.signal_class : "";
  if (signalClass === "positive_strong") return 0;
  if (signalClass === "positive_weak") return 0.2;
  if (signalClass === "neutral") return 0.5;
  if (signalClass === "negative_weak") return 0.8;
  if (signalClass === "negative_strong") return 1;
  const observedOutcome = jsonObject(payload.observed_outcome as JsonValue | undefined);
  const verdict = String(payload.verdict ?? observedOutcome.verdict ?? observedOutcome.outcome ?? "").toLowerCase();
  if (verdict === "positive" || verdict === "success" || verdict === "succeeded") return 0;
  if (verdict === "partial" || verdict === "mixed") return 0.5;
  if (verdict === "negative" || verdict === "failure" || verdict === "failed") return 1;
  return clampResidual(fallback);
};

const resolveOwnerObservedSourceActId = (db: Database, ownerEv: EventLike): string | null => {
  const direct = resolveSourceActId([ownerEv]);
  if (direct) return direct;
  const payload = jsonObject(ownerEv.payload);
  const refs = [payload.source_event_id, ...(ownerEv.context_refs ?? [])]
    .filter((ref): ref is string => typeof ref === "string" && ref.length > 0);
  for (const ref of refs) {
    const refEv = getEventById(db, ref);
    if (!refEv) continue;
    if (refEv.kind === "act_tuple_recorded") return refEv.id;
    const sourceActId = resolveSourceActId([refEv]);
    if (sourceActId) return sourceActId;
  }
  return null;
};

const resolveBindingTargets = (db: Database, id: string): string[] => {
  const row = db.query("SELECT kind, payload FROM events WHERE id = ?").get(id) as { kind: string; payload: string } | null;
  if (!row || row.kind !== "retrieval_binding") return [id];
  try {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    return [payload.source_event_id, payload.source_artifact_id].filter((value): value is string => typeof value === "string" && value.length > 0);
  } catch {
    return [id];
  }
};

const actTupleCitationIds = (db: Database, sourceActId: string | null): string[] => {
  if (!sourceActId) return [];
  const act = getEventById(db, sourceActId);
  if (!act || act.kind !== "act_tuple_recorded") return [];
  const payload = jsonObject(act.payload);
  return [...stringArrayField(payload, "cited_knowledge_ids"), ...stringArrayField(payload, "cited_artifact_ids")];
};

/** Look up the confidence_estimate field from a cited knowledge entry's
 *  source candidate. When the target id is itself a knowledge_candidate,
 *  read its own payload; when it's a knowledge_promoted, traverse to the
 *  originating candidate via payload.candidate_id. Returns 1.0 (full
 *  weight) when the field is absent or out of [0,1] — flat-text
 *  candidates that don't carry the rich schema land at neutral weight. */
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

// ── Posterior-delta computation ────────────────────────────────────
//
// The Beta-delta + EMA + posterior-recompute algebra lives ONCE in
// artifact_store.applyResidualOutcome (extended with an optional
// `opts.weight` per KC 81VSHW67Q51XZC683B2XTR79FR, cleanup audit
// batch 1). credit.ts used to carry a parallel implementation
// (`applyWeightedResidualOutcome` + a local `residualToBetaDeltas`)
// plus an inline UPDATE block in the cited-artifact loop, which
// made score semantics fragile — any evolution to the algebra
// required parallel edits. Both surfaces now delegate to the
// shared primitive; `residualToBetaDeltas` is imported from
// artifact_store so the band thresholds are sourced from a single
// place. Auto-quarantine wiring (Hole 7, commit a65ea22) fires
// once via the centralized primitive — no caller-side maybeQuarantine
// is required after the call.
const MIDBAND_UNCERTAINTY_LOW = 0.4;
const MIDBAND_UNCERTAINTY_HIGH = 0.6;
const SUCCESS_BAND = 0.3;
const FAILURE_BAND = 0.7;

// ── Citation collection from the three driving events + bodies ─────

// Citation weighting:
//   - explicit citations (action/obs/scored.context_refs + body @cite)
//     get FULL Shapley weight (factor 1.0). A cited retrieval_binding id is
//     resolved to its source_event_id/source_artifact_id before credit.
//   - prompt-level retrieval_binding rows that were exposed but not cited are
//     recorded as retrieval_rejected and excluded from Shapley credit. Prompt
//     exposure alone is not evidence that the entry drove the action.
//   - knowledge_propagated remains a weaker explicit transfer signal because
//     propagation is a substrate-authored cross-directive act, not mere prompt
//     exposure.
const PROPAGATION_ONLY_FACTOR = 0.35;

type CitationEntry = { id: string; weightFactor: number };
type RetrievalRejectionEmitter = (bindingEventId: string, sourceIds: string[]) => void;

const collectCitations = (
  db: Database,
  params: DistributeCreditParams,
  actionBodyCitations: string[],
  verifierBodyCitations: string[],
  actionArtifactId: string,
  verifierArtifactId: string,
  rejectRetrievalBinding?: RetrievalRejectionEmitter,
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
      for (const resolved of resolveBindingTargets(db, ref)) {
        ordered.push({ id: resolved, weightFactor: 1.0 });
        explicitlyCited.add(resolved);
      }
    }
  }
  for (const id of actTupleCitationIds(db, resolveSourceActId([actionEv, obsEv, scoredEv]))) {
    ordered.push({ id, weightFactor: 1.0 });
    explicitlyCited.add(id);
  }
  for (const id of actionBodyCitations) {
    ordered.push({ id, weightFactor: 1.0 });
    explicitlyCited.add(id);
  }
  for (const id of verifierBodyCitations) {
    ordered.push({ id, weightFactor: 1.0 });
    explicitlyCited.add(id);
  }

  // Second pass: retrieval_binding source ids. Per the policy documented
  // at the top of this file ("exposed but not cited are recorded as
  // retrieval_rejected and excluded from Shapley credit"), bindings whose
  // source id is NOT in the explicit-citation set get NO credit weight —
  // exposure alone is not evidence the entry drove the action. The
  // pre-V08SXCG9 implementation gave them a small EXPOSURE_ONLY_FACTOR
  // (≈0.1) but the brain's behavioral-binding amendment removed that
  // const without updating this loop, leaving a dangling reference.
  // The honest implementation: skip uncited bindings entirely (so they
  // never enter Shapley) and, when a rejection emitter is provided,
  // surface them as retrieval_rejected so credit history retains the
  // provenance. Bindings whose source is ALREADY in explicitlyCited
  // are also skipped (the explicit pass above already pushed them with
  // factor 1.0 — double-pushing would double-count).
  if (actionEv && actionEv.task_id && scoredEv) {
    const bindings = db
      .query(
        `SELECT id, payload FROM events
         WHERE kind = 'retrieval_binding'
           AND task_id = ?
           AND ts <= ?
         ORDER BY ts ASC`,
      )
      .all(actionEv.task_id, scoredEv.ts) as Array<{ id: string; payload: string }>;
    for (const b of bindings) {
      try {
        const p = JSON.parse(b.payload) as Record<string, unknown>;
        const sourceIds = [p.source_event_id, p.source_artifact_id]
          .filter((value): value is string => typeof value === "string" && value.length > 0);
        const uncited = sourceIds.filter((sourceId) => !explicitlyCited.has(sourceId));
        if (uncited.length > 0 && rejectRetrievalBinding) {
          rejectRetrievalBinding(b.id, uncited);
        }
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
 *    1. Resolve the action_predicted event -> action + verifier artifact ids.
 *    2. Apply full-weight residual outcome to action + verifier as primary
 *       act participants. Do not mutate action_predicted.context_refs or
 *       act_tuple_recorded.cited_artifact_ids to represent these structural
 *       roles; cited_artifact_ids remains emitter-declared citation intent.
 *    3. Extract third-party citations from context_refs + body @cite markers.
 *    4. Compute Shapley weights by corroboration position.
 *    5. Apply the WEIGHTED Beta posterior delta to each cited act_artifact;
 *       emit candidate_confirmed/contradicted for each cited knowledge id.
 *    6. After every posterior update, fire maybePromote / maybeQuarantine.
 *    7. Emit `act_artifact_score_updated` for every artifact touched.
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
  // Named substrate primitives are expected to be registered act_artifact
  // rows under their canonical action_artifact_id (for example
  // knowledge_merger_v1, dispatch_decider_v1, and
  // owner_profile_promoter_action). Those rows receive the same primary
  // posterior updates as any other action/verifier artifact. This fallback
  // is only for truly synthetic or malformed handles with no registry row
  // (for example ad-hoc random ids, deleted test fixtures, or null/legacy
  // emissions that cannot be resolved). Continue through collectCitations
  // so cited candidates/knowledge still receive evidence even when the
  // primary artifact handle is not updateable.
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
  const noveltyMultiplier = noveltyBonusMultiplier(db);

  const observationEv = getEventById(db, params.observation_event_id);
  const scoredEv = getEventById(db, params.scored_event_id);
  const creditMetadata: CreditProjectionMetadata = {
    sourceActId: resolveSourceActId([actionEv, observationEv, scoredEv]),
    ownerEvidenceEventId: observationEv?.kind === "owner_observed_outcome_recorded" ? observationEv.id : null,
  };

  const projectionTarget = (event: EmitEventInput, payload: Record<string, unknown>): string => {
    const target = payload.artifact_id ?? payload.knowledge_id ?? event.action_artifact_id ?? "primary";
    const role = typeof payload.role === "string" ? ":" + payload.role : "";
    const evidence = creditMetadata.ownerEvidenceEventId ? ":owner:" + creditMetadata.ownerEvidenceEventId : ":scored:" + params.scored_event_id;
    return String(target) + role + evidence;
  };

  const emit = (event: EmitEventInput): string => {
    const payload = jsonObject(event.payload);
    const shouldStamp = creditMetadata.sourceActId && (event.kind === "candidate_confirmed" || event.kind === "candidate_contradicted" || event.kind === "act_artifact_score_updated");
    const stampedPayload = shouldStamp
      ? {
          ...payload,
          source_act_id: creditMetadata.sourceActId,
          ...(creditMetadata.ownerEvidenceEventId ? { owner_observed_outcome_event_id: creditMetadata.ownerEvidenceEventId } : {}),
          projection_key: creditMetadata.sourceActId + ":" + event.kind + ":" + projectionTarget(event, payload),
        }
      : payload;
    const result = emitEvent(db, {
      ...event,
      directive_id: event.directive_id ?? inheritDirectiveId,
      task_id: event.task_id ?? inheritTaskId,
      payload: stampedPayload as JsonValue,
      invoker: event.invoker ?? "substrate_auto",
    });
    emittedEvents.push(result.id);
    return result.id;
  };

  /** Apply the LATM novelty bonus when an artifact earns credit on a
   *  previously-unseen goal_shape. Returns the (possibly-boosted) weight.
   *  Emits a `latm_novelty_bonus_applied` event so the bonus is auditable.
   *  The check runs BEFORE the matching `act_artifact_score_updated` event
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
  //    `act_artifact_score_updated` row that stamps this goal_shape onto
  //    the artifact's history; otherwise the verifier's check would observe
  //    the action's stamp and miss its own novelty.
  let computedActionWeight = 1.0;
  let computedVerifierWeight = 1.0;
  if (primaryArtifactsRegistered) {
    computedActionWeight = applyNoveltyBonus(actionArt!.id, 1.0);
    computedVerifierWeight = applyNoveltyBonus(verifierArt!.id, 1.0);
    // Delegating to the canonical primitive (cleanup audit batch 1):
    // weight=1.0 reproduces the prior unweighted path; weight>1.0 is
    // the LATM novelty-bonus path. Auto-quarantine fires inside the
    // primitive so the explicit maybeQuarantine below is now structural
    // backup, not a separate driver.
    applyResidualOutcome(
      db,
      actionArt!.id,
      params.observed_residual,
      ts,
      (e) => emit(e),
      { weight: computedActionWeight },
    );
    applyResidualOutcome(
      db,
      verifierArt!.id,
      params.observed_residual,
      ts,
      (e) => emit(e),
      { weight: computedVerifierWeight },
    );
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
      kind: "act_artifact_score_updated",
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
      kind: "act_artifact_score_updated",
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

    // 2. Promotion checks on action + verifier. Quarantine already
    // fired inside applyResidualOutcome (canonical Hole-7 wiring +
    // cleanup audit batch 1); calling it again would be an idempotent
    // no-op but the explicit driver is no longer needed.
    maybePromote(db, actionArt!.id, (e) => emit(e));
    maybePromote(db, verifierArt!.id, (e) => emit(e));
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
    (bindingEventId, sourceIds) => {
      emit({
        kind: "retrieval_rejected",
        substrate_origin: "substrate_auto",
        context_refs: [bindingEventId, ...sourceIds, params.scored_event_id],
        payload: {
          retrieval_binding_id: bindingEventId,
          source_ids: sourceIds,
          action_scored_event_id: params.scored_event_id,
          reason: "exposed_but_not_cited_by_act",
          selection_point: "credit.collectCitations",
        } as JsonValue,
      });
    },
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

    if (kind === "act_artifact") {
      // Apply the LATM novelty bonus on the Shapley share — first-time
      // goal_shape credit on this cited artifact gets a multiplier on its
      // weight so a newly-useful artifact rises faster. Idempotent on
      // subsequent credits for the same shape (returns baseWeight).
      const weight = applyNoveltyBonus(targetId, baseWeight);
      const wAlpha = alphaDelta * weight;
      const wBeta = betaDelta * weight;
      // Delegate the per-entity weighted update to the canonical
      // primitive (cleanup audit batch 1). Auto-quarantine fires
      // inside; we still call maybePromote explicitly because the
      // primitive owns demotion (Hole 7) but not promotion.
      const row = getArtifact(db, targetId);
      if (row) {
        const updated = applyResidualOutcome(
          db,
          targetId,
          params.observed_residual,
          ts,
          (e) => emit(e),
          { weight },
        );
        maybePromote(db, targetId, (e) => emit(e));
        emit({
          kind: "act_artifact_score_updated",
          substrate_origin: "substrate_auto",
          action_artifact_id: targetId,
          payload: {
            artifact_id: targetId,
            role: "cited",
            weight,
            residual: params.observed_residual,
            score: updated.score,
            confidence: updated.confidence,
            scored_event_id: params.scored_event_id,
            goal_shape: directiveGoalShape,
          } as JsonValue,
        });
      }
      contributions.push({
        target_id: targetId,
        target_kind: "act_artifact",
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
      // (without confidence_estimate) default to weight=1.0.
      // The weight lands on candidate_confirmed.payload so the
      // extractor reads the fractional contribution.
      const confidenceEstimate = readCandidateConfidenceEstimate(db, targetId);
      const citedKnowledgeOrigin = (() => {
        const row = db.query(`SELECT substrate_origin FROM events WHERE id = ?`).get(targetId) as { substrate_origin?: string } | null;
        return row?.substrate_origin ?? "unknown";
      })();
      const knowledgeWeight = baseWeight * confidenceEstimate;
      const kAlpha = alphaDelta * knowledgeWeight;
      const kBeta = betaDelta * knowledgeWeight;
      const r = Math.max(0, Math.min(1, params.observed_residual));
      const knowledgeKind: "candidate_confirmed" | "candidate_contradicted" =
        r >= FAILURE_BAND ? "candidate_contradicted" : "candidate_confirmed";
      const outcomeProbability = r <= SUCCESS_BAND ? 1 : r >= FAILURE_BAND ? 0 : 0.5;
      emit({
        kind: "origin_calibration_recorded",
        substrate_origin: "substrate_auto",
        context_refs: [targetId, params.scored_event_id],
        payload: {
          origin: citedKnowledgeOrigin,
          role: "cited_knowledge",
          predicted_confidence: confidenceEstimate,
          observed_success_probability: outcomeProbability,
          calibration_error: Math.abs(confidenceEstimate - outcomeProbability),
          merger_quality_axes: {
            confidence_error: Math.abs(confidenceEstimate - outcomeProbability),
            shapley_weight: baseWeight,
          },
        } as JsonValue,
      });
      if (r >= MIDBAND_UNCERTAINTY_LOW && r <= MIDBAND_UNCERTAINTY_HIGH) {
        emit({
          kind: "knowledge_uncertainty_observed",
          substrate_origin: "substrate_auto",
          context_refs: [targetId, params.scored_event_id],
          payload: {
            knowledge_id: targetId,
            residual: r,
            residual_band: "midband",
            uncertainty_range: [MIDBAND_UNCERTAINTY_LOW, MIDBAND_UNCERTAINTY_HIGH],
            scored_event_id: params.scored_event_id,
            calibration_evidence_event_id: params.scored_event_id,
            origin_calibration: {
              origin: citedKnowledgeOrigin,
              predicted_confidence: confidenceEstimate,
              observed_success_probability: outcomeProbability,
              calibration_error: Math.abs(confidenceEstimate - outcomeProbability),
            },
            merger_quality_axes: {
              uncertainty: 1 - Math.abs(r - 0.5) * 2,
              confidence_error: Math.abs(confidenceEstimate - outcomeProbability),
              shapley_weight: baseWeight,
            },
          } as JsonValue,
        });
      }
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
    action_artifact_id: actionArtifactId,
    verifier_artifact_id: verifierArtifactId,
    predicted_residual: params.predicted_residual,
    observed_residual: params.observed_residual,
    delta: Math.abs(params.predicted_residual - params.observed_residual),
    contributions,
    emitted_events: emittedEvents,
  };
};

export const distributeOwnerObservedOutcomeCredit = async (
  db: Database,
  ownerObservedOutcomeEventId: string,
): Promise<CreditDistribution> => {
  const ownerEv = getEventById(db, ownerObservedOutcomeEventId);
  if (!ownerEv) throw new Error(`owner_observed_outcome_event_not_found:${ownerObservedOutcomeEventId}`);
  if (ownerEv.kind !== "owner_observed_outcome_recorded") {
    throw new Error(`owner_observed_outcome_kind_mismatch:${ownerEv.kind}`);
  }
  const sourceActId = resolveOwnerObservedSourceActId(db, ownerEv);
  if (!sourceActId) throw new Error("owner_observed_outcome_missing_source_act_id");
  const actionRow = db
    .query<{ id: string; predicted_residual: number | null }, [string, string]>(
      `SELECT id, predicted_residual FROM events
       WHERE kind = 'action_predicted'
         AND (json_extract(payload, '$.source_act_id') = ? OR EXISTS (SELECT 1 FROM json_each(context_refs) WHERE value = ?))
       ORDER BY ts ASC LIMIT 1`,
    )
    .get(sourceActId, sourceActId);
  const scoredRow = db
    .query<{ id: string; predicted_residual: number | null; residual: number | null }, [string, string]>(
      `SELECT id, predicted_residual, residual FROM events
       WHERE kind = 'action_scored'
         AND (json_extract(payload, '$.source_act_id') = ? OR EXISTS (SELECT 1 FROM json_each(context_refs) WHERE value = ?))
       ORDER BY ts ASC LIMIT 1`,
    )
    .get(sourceActId, sourceActId);
  if (!actionRow || !scoredRow) throw new Error(`owner_observed_outcome_missing_projected_action:${sourceActId}`);
  const observedResidual = residualFromOwnerObservedOutcome(ownerEv, scoredRow.residual ?? 1);
  return distributeCredit(db, {
    action_event_id: actionRow.id,
    observation_event_id: ownerEv.id,
    scored_event_id: scoredRow.id,
    predicted_residual: actionRow.predicted_residual ?? scoredRow.predicted_residual ?? 0.5,
    observed_residual: observedResidual,
  });
};

// ── Internal exports for tests ────────────────────────────────────

export const __extractBodyCitationsForTest = extractBodyCitations;
export const __collectCitationsForTest = collectCitations;
export const __residualToBetaDeltasForTest = residualToBetaDeltas;
