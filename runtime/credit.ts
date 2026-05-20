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
  insertArtifact,
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
  // T0.2 universal projector idempotency guard: the emit-boundary
  // projector in runtime/events.ts may have already credited the action
  // and verifier artifacts for this scored_event_id. Skip the
  // applyResidualOutcome calls when that's the case so the posterior
  // doesn't move twice. The score_updated row emission below is also
  // gated by the same check (priorScoreUpdateExists) to keep audit-row
  // counts honest.
  // When this credit run is itself an owner-observed pass, ignore any
  // prior NON-owner credit rows for the same scored_event_id — the
  // owner's verdict is a fresh signal that must always apply.
  const isOwnerObservedRun = creditMetadata.ownerEvidenceEventId !== null;
  const actionAlreadyCredited = !isOwnerObservedRun && primaryArtifactsRegistered && priorScoreUpdateExists(db, params.scored_event_id, actionArt!.id);
  const verifierAlreadyCredited = !isOwnerObservedRun && primaryArtifactsRegistered && priorScoreUpdateExists(db, params.scored_event_id, verifierArt!.id);
  if (primaryArtifactsRegistered) {
    computedActionWeight = applyNoveltyBonus(actionArt!.id, 1.0);
    computedVerifierWeight = applyNoveltyBonus(verifierArt!.id, 1.0);
    // Delegating to the canonical primitive (cleanup audit batch 1):
    // weight=1.0 reproduces the prior unweighted path; weight>1.0 is
    // the LATM novelty-bonus path. Auto-quarantine fires inside the
    // primitive so the explicit maybeQuarantine below is now structural
    // backup, not a separate driver.
    if (!actionAlreadyCredited) {
      applyResidualOutcome(
        db,
        actionArt!.id,
        params.observed_residual,
        ts,
        (e) => emit(e),
        { weight: computedActionWeight },
      );
    }
    if (!verifierAlreadyCredited) {
      applyResidualOutcome(
        db,
        verifierArt!.id,
        params.observed_residual,
        ts,
        (e) => emit(e),
        { weight: computedVerifierWeight },
      );
    }
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
    if (!actionAlreadyCredited) {
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
    }
    if (!verifierAlreadyCredited) {
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
    }

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
      // T0.2 universal projector idempotency guard: skip if a prior
      // act_artifact_score_updated row already exists for this
      // (scored_event_id, artifact_id) pair (the emit-boundary
      // projector may have credited this artifact already). Owner-
      // observed runs ignore non-owner prior rows so the verdict
      // always applies.
      const alreadyCredited = !isOwnerObservedRun && priorScoreUpdateExists(db, params.scored_event_id, targetId);
      if (row && !alreadyCredited) {
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

  // 4. T4.4 coalition / joint-citation posterior (roadmap.md §T4.4):
  //    when the brain's action_predicted cited N>1 cooperating artifacts
  //    (payload.cited_artifact_ids carries the brain-stated coalition),
  //    emit a coalition_credit_distributed audit row carrying the
  //    sorted-member coalition id + per-member shapley shares + observed
  //    residual. The per-artifact posterior is already mutated above by
  //    the Shapley loop on `cited`; this row makes the COMBINATION
  //    first-class so future routing can score "these N together" as a
  //    unit, not only the individual nodes. shapleyWeightsByCorroboration
  //    is the canonical share fn — same algebra distributeCredit already
  //    uses for the per-artifact split, so the emitted shares match the
  //    posterior moves exactly.
  const actionPredictedPayload = jsonObject(actionEv.payload);
  const coalitionMembers = stringArrayField(actionPredictedPayload, "cited_artifact_ids")
    .filter((id) => id !== actionArtifactId && id !== verifierArtifactId);
  if (coalitionMembers.length > 1) {
    const sortedMembers = [...coalitionMembers].sort();
    const coalitionId = "coalition:" + sortedMembers.join("+");
    const shares = shapleyWeightsByCorroboration(coalitionMembers.length);
    // Ordered shares track context_refs / cited_artifact_ids order
    // (first-discoverer gets largest share) — matches the per-artifact
    // posterior moves emitted by the Shapley loop above.
    const memberShares = coalitionMembers.map((id, i) => ({
      artifact_id: id,
      shapley_share: shares[i] ?? 0,
    }));
    emit({
      kind: "coalition_credit_distributed",
      substrate_origin: "substrate_auto",
      context_refs: [params.scored_event_id, ...sortedMembers],
      payload: {
        coalition_id: coalitionId,
        sorted_member_ids: sortedMembers,
        ordered_member_ids: coalitionMembers,
        member_count: coalitionMembers.length,
        residual: params.observed_residual,
        scored_event_id: params.scored_event_id,
        action_predicted_event_id: params.action_event_id,
        member_shares: memberShares,
        goal_shape: directiveGoalShape,
      } as JsonValue,
    });
  }

  // 5. T4.2 meta-credit (roadmap.md §T4.2): credit the COMPOSER policy
  //    bundle that selected the winning artifact/knowledge. The composer
  //    emits prompt_policy_section_selected per pushPolicy at compose
  //    time carrying payload.artifact_id (the chosen bundle row). For
  //    every distinct artifact_id selected on this task before the
  //    scored event landed, project credit to that bundle's posterior
  //    so the SELECTOR accrues evidence about its own quality — not
  //    only the artifact it picked. Idempotent via projection_key
  //    "meta_credit:{scored_event_id}:{bundle_artifact_id}".
  if (inheritTaskId && scoredEv) {
    const selections = db
      .query<{ payload: string }, [string, string]>(
        `SELECT payload FROM events
         WHERE kind = 'prompt_policy_section_selected'
           AND task_id = ?
           AND ts <= ?
         ORDER BY ts ASC`,
      )
      .all(inheritTaskId, scoredEv.ts);
    const seenBundles = new Set<string>();
    for (const sel of selections) {
      let bundleId: string | null = null;
      let sectionName: string | null = null;
      try {
        const p = JSON.parse(sel.payload) as Record<string, unknown>;
        if (typeof p.artifact_id === "string" && p.artifact_id.length > 0) bundleId = p.artifact_id;
        if (typeof p.section_name === "string") sectionName = p.section_name;
      } catch { /* skip malformed */ }
      if (!bundleId || seenBundles.has(bundleId)) continue;
      seenBundles.add(bundleId);
      // Idempotency: skip if a prior meta_credit_projected row already
      // exists for (scored_event_id, bundle).
      const projectionKey = "meta_credit:" + params.scored_event_id + ":" + bundleId;
      const prior = db
        .query<{ x: number }, [string]>(
          "SELECT 1 AS x FROM events WHERE kind = 'meta_credit_projected' AND json_extract(payload, '$.projection_key') = ? LIMIT 1",
        )
        .get(projectionKey);
      if (prior) continue;
      const bundleRow = getArtifact(db, bundleId);
      let postScore: number | null = null;
      let postConfidence: number | null = null;
      if (bundleRow) {
        const updated = applyResidualOutcome(
          db,
          bundleId,
          params.observed_residual,
          ts,
          (e) => emit(e),
          { weight: 1.0 },
        );
        postScore = updated.score;
        postConfidence = updated.confidence;
        // Emit the canonical score_updated audit row so the bundle's
        // posterior move is visible on the same surface as other
        // artifact credit rows. role="composer_policy" disambiguates
        // it from action/verifier/cited roles.
        emit({
          kind: "act_artifact_score_updated",
          substrate_origin: "substrate_auto",
          action_artifact_id: bundleId,
          payload: {
            artifact_id: bundleId,
            role: "composer_policy",
            residual: params.observed_residual,
            weight: 1.0,
            score: postScore,
            confidence: postConfidence,
            scored_event_id: params.scored_event_id,
            goal_shape: directiveGoalShape,
            projected_from: "meta_credit",
            section_name: sectionName,
          } as JsonValue,
        });
        maybePromote(db, bundleId, (e) => emit(e));
      }
      emit({
        kind: "meta_credit_projected",
        substrate_origin: "substrate_auto",
        context_refs: [params.scored_event_id, bundleId],
        payload: {
          bundle_artifact_id: bundleId,
          section_name: sectionName,
          residual: params.observed_residual,
          scored_event_id: params.scored_event_id,
          action_predicted_event_id: params.action_event_id,
          goal_shape: directiveGoalShape,
          bundle_registered: bundleRow !== null,
          post_score: postScore,
          post_confidence: postConfidence,
          projection_key: projectionKey,
        } as JsonValue,
      });
    }
  }

  // 6. T4.3 brain prediction-accuracy posterior (roadmap.md §T4.3):
  //    every action_predicted whose substrate_origin is the brain (opencode)
  //    is a calibration sample — emit brain_accuracy_observation with
  //    |predicted − observed| as prediction_error, and update a per-goal_shape
  //    brain_accuracy_predicate act_artifact posterior (auto-admitted on
  //    first sighting). Low residual = "brain predicted well" → confirmed;
  //    high residual = "brain predicted poorly" → contradicted. This makes
  //    the brain's predictive calibration a first-class Beta posterior the
  //    dispatcher can read from to route between brain / replay / inline.
  if (actionEv.substrate_origin === "opencode") {
    recordBrainAccuracy(db, {
      action_predicted_event_id: params.action_event_id,
      action_scored_event_id: params.scored_event_id,
      predicted_residual: params.predicted_residual,
      observed_residual: params.observed_residual,
      goal_shape: directiveGoalShape,
      directive_id: inheritDirectiveId,
      task_id: inheritTaskId,
      emit,
    });
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

// ── T4.3 brain prediction-accuracy posterior (roadmap.md §T4.3) ──────
//
// Per-goal_shape Beta posterior on the brain's predicted_residual vs the
// substrate's observed residual. brain_accuracy_predicate act_artifact
// rows accumulate evidence per dispatch — the dispatcher can read score /
// confidence to decide whether to trust the brain's next predicted
// residual for a routing call (substrate_replay vs opencode_brain vs
// claude_inline). The "outcome" we score is the prediction's ACCURACY,
// not the action's success: low |predicted − observed| → confirmed (the
// brain calibrated well); high |predicted − observed| → contradicted.

const BRAIN_ACCURACY_ARTIFACT_PREFIX = "brain_accuracy_predicate:";

const brainAccuracyArtifactId = (goalShapeToken: string): string =>
  BRAIN_ACCURACY_ARTIFACT_PREFIX + (goalShapeToken || "default");

/** Ensure the per-goal_shape brain_accuracy_predicate act_artifact row
 *  exists; cold-start with a Beta(1,1) prior so the first observation
 *  moves the posterior off neutral. */
const ensureBrainAccuracyArtifact = (db: Database, artifactId: string, goalShapeToken: string): void => {
  const existing = getArtifact(db, artifactId);
  if (existing) return;
  // Insert lazily; the kind="brain_accuracy_predicate" string is the
  // canonical registry handle (T4.3 open-vocab — adding a new kind row,
  // not extending a closed enum).
  insertArtifact(db, {
    id: artifactId,
    runtime: "bun",
    kind: "brain_accuracy_predicate",
    body: "// brain_accuracy_predicate goal_shape=" + (goalShapeToken || "default"),
    declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
    stateRoot: null,
    posteriorAlpha: 1,
    posteriorBeta: 1,
    score: 0.5,
    confidence: 0.0,
    recentResidualMean: 0,
    recentKillCount: 0,
    status: "admitted",
    name: "brain_accuracy_predicate_" + (goalShapeToken || "default"),
    fixtureInput: null,
    fixtureExpectedResidual: 0,
  });
};

type RecordBrainAccuracyParams = {
  action_predicted_event_id: string;
  action_scored_event_id: string;
  predicted_residual: number;
  observed_residual: number;
  goal_shape: string;
  directive_id: string;
  task_id: string;
  emit: (event: EmitEventInput) => string;
};

/** Compute prediction_error = |predicted − observed|, update the per-
 *  goal_shape brain_accuracy_predicate posterior, and emit a
 *  brain_accuracy_observation audit row. Idempotent via projection_key
 *  "brain_accuracy:{action_predicted_event_id}:{action_scored_event_id}". */
const recordBrainAccuracy = (db: Database, params: RecordBrainAccuracyParams): void => {
  const projectionKey =
    "brain_accuracy:" + params.action_predicted_event_id + ":" + params.action_scored_event_id;
  const prior = db
    .query<{ x: number }, [string]>(
      "SELECT 1 AS x FROM events WHERE kind = 'brain_accuracy_observation' AND json_extract(payload, '$.projection_key') = ? LIMIT 1",
    )
    .get(projectionKey);
  if (prior) return;
  const predicted = clampResidual(params.predicted_residual);
  const observed = clampResidual(params.observed_residual);
  const predictionError = Math.abs(predicted - observed);
  // Map prediction_error to a residual-shaped signal for the Beta posterior:
  //   error in [0, 0.2]  → score ~ 0  (well-calibrated)
  //   error in [0.8, 1]  → score ~ 1  (badly calibrated)
  // applyResidualOutcome's success/failure bands handle the rest.
  const accuracyResidual = predictionError;
  const artifactId = brainAccuracyArtifactId(params.goal_shape);
  ensureBrainAccuracyArtifact(db, artifactId, params.goal_shape);
  const ts = nowIso();
  const updated = applyResidualOutcome(
    db,
    artifactId,
    accuracyResidual,
    ts,
    (e) => params.emit(e),
    { weight: 1.0 },
  );
  params.emit({
    kind: "brain_accuracy_observation",
    substrate_origin: "substrate_auto",
    context_refs: [params.action_predicted_event_id, params.action_scored_event_id, artifactId],
    payload: {
      action_predicted_event_id: params.action_predicted_event_id,
      action_scored_event_id: params.action_scored_event_id,
      predicted_residual: predicted,
      observed_residual: observed,
      prediction_error: predictionError,
      goal_shape: params.goal_shape,
      brain_accuracy_artifact_id: artifactId,
      post_score: updated.score,
      post_confidence: updated.confidence,
      post_alpha: updated.posteriorAlpha,
      post_beta: updated.posteriorBeta,
      projection_key: projectionKey,
    } as JsonValue,
  });
};

export const __recordBrainAccuracyForTest = recordBrainAccuracy;
export const __brainAccuracyArtifactIdForTest = brainAccuracyArtifactId;

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

// ── T0.2 Universal action_scored → act_artifact_score_updated projection ─
//
// Live evidence (24h pre-fix): action_scored=2380,
// act_artifact_score_updated=123, parity=5.17%. distributeCredit's full
// Shapley pipeline is the rich path, but many emit sites (internal
// substrate decisions whose action handles aren't registered act_artifact
// rows — closure_verifier_v1, dispatch_decider_v1, intent_classifier_v1,
// lesson_extractor_v1, knowledge_merger_v1, citation_chooser_v1) hit the
// synthetic-actuator branch and produce no per-cited-artifact credit row.
// The universal projector closes that gap structurally: walk
// source_act_event_id → action_predicted, pull cited_artifact_ids from
// payload + context_refs, and emit act_artifact_score_updated per cited
// artifact with the residual + Beta posterior delta. Idempotent via
// projection_key. The recursive distributeCredit machinery still owns
// the rich Shapley + LATM novelty + knowledge candidate path; this
// projector is the catch-all that guarantees parity == 100% for every
// action_scored that carries a resolvable source_act_event_id.
//
// Recursion guard: rows whose payload.projected_from === "distribute_credit"
// are skipped — distributeCredit owns the Shapley share for the act,
// projector would double-count if it ran on those rows.

const projectionKeyFor = (sourceActEventId: string, artifactId: string): string =>
  "act_artifact_score_updated:" + sourceActEventId + ":" + artifactId;

const projectionKeyExists = (db: Database, kind: string, key: string): boolean => {
  const row = db
    .query<{ x: number }, [string, string]>(
      "SELECT 1 AS x FROM events WHERE kind = ? AND json_extract(payload, '$.projection_key') = ? LIMIT 1",
    )
    .get(kind, key);
  return row !== null;
};

/** Broader idempotency check — has any prior act_artifact_score_updated
 *  row already been emitted that mentions both the scored_event_id and
 *  artifact_id (covers distributeCredit's projection-key shape AND the
 *  universal projector's). The owner-observed-outcome credit pass is a
 *  separate logical event (carries its own owner_observed_outcome_event_id
 *  on the payload); it is allowed to run again on the same scored_event_id
 *  to apply the owner's negative/positive verdict to cited posteriors.
 *  Returns true only when a prior row exists that is NOT an owner-observed
 *  credit row, so the post-write projector and the followup distributeCredit
 *  don't double-credit, but distributeOwnerObservedOutcomeCredit can still
 *  apply its residual. */
const priorScoreUpdateExists = (
  db: Database,
  scoredEventId: string,
  artifactId: string,
  opts?: { ignoreOwnerObserved?: boolean },
): boolean => {
  const ignoreOwner = opts?.ignoreOwnerObserved !== false; // default true
  const sql = ignoreOwner
    ? `SELECT 1 AS x FROM events WHERE kind = 'act_artifact_score_updated'
         AND json_extract(payload, '$.scored_event_id') = ?
         AND json_extract(payload, '$.artifact_id') = ?
         AND (json_extract(payload, '$.owner_observed_outcome_event_id') IS NULL)
       LIMIT 1`
    : `SELECT 1 AS x FROM events WHERE kind = 'act_artifact_score_updated'
         AND json_extract(payload, '$.scored_event_id') = ?
         AND json_extract(payload, '$.artifact_id') = ?
       LIMIT 1`;
  const row = db
    .query<{ x: number }, [string, string]>(sql)
    .get(scoredEventId, artifactId);
  return row !== null;
};

type ScoredEventLite = {
  id: string;
  payload: string;
  context_refs: string;
  directive_id: string;
  task_id: string;
  residual: number | null;
  action_artifact_id?: string | null;
  verifier_artifact_id?: string | null;
};

/** Universal post-write projector for action_scored.
 *  Reads source_act_event_id → action_predicted; collects
 *  cited_artifact_ids from payload + context_refs; emits
 *  act_artifact_score_updated per cited artifact with the scored
 *  residual + Beta posterior delta. Idempotent via projection_key
 *  (act_artifact_score_updated:{source_act_event_id}:{artifact_id}).
 *  Skips when the row was emitted by distributeCredit (recursion
 *  guard) or when source_act_event_id is missing/unresolvable.
 *  Fail-soft: any error emits a projection_error row but never throws. */
export const projectActionScoredToCredit = (
  db: Database,
  scoredEvent: ScoredEventLite,
): void => {
  try {
    const payload = JSON.parse(scoredEvent.payload || "{}") as Record<string, unknown>;
    // Recursion guard: distributeCredit-stamped rows already own their
    // credit share; projecting again would double-count.
    if (payload.projected_from === "distribute_credit") return;
    // Prefer action_predicted_event_id when stamped (act_tuple projection
    // path); fall back to source_act_event_id when only that is present
    // (direct emit paths). source_act_event_id may point at a non-
    // action_predicted row (e.g. an act_tuple_recorded), so we always
    // require the resolved row's kind to be action_predicted.
    const actionPredictedEventId = typeof payload.action_predicted_event_id === "string" && payload.action_predicted_event_id.length > 0
      ? payload.action_predicted_event_id
      : null;
    const sourceActEventId = typeof payload.source_act_event_id === "string" && payload.source_act_event_id.length > 0
      ? payload.source_act_event_id
      : null;
    const lookupId = actionPredictedEventId ?? sourceActEventId;
    if (!lookupId) return; // safe no-op
    const predictedRow = db
      .query<{ id: string; payload: string; context_refs: string }, [string]>(
        "SELECT id, payload, context_refs FROM events WHERE id = ? AND kind = 'action_predicted'",
      )
      .get(lookupId);
    if (!predictedRow) {
      // The act_tuple projection path stamps source_act_event_id with
      // the act_tuple_recorded id (not the projected action_predicted),
      // so a lookup miss is EXPECTED when only source_act_event_id is
      // present and the id is itself a non-action_predicted row. Check
      // whether the lookupId resolves to ANY known row — if it does,
      // skip silently (expected case); if it resolves to no row at all,
      // emit projection_error (the dangling reference is a real audit
      // signal).
      const anyRow = db.query("SELECT kind FROM events WHERE id = ?").get(lookupId) as { kind: string } | null;
      if (!anyRow) {
        emitEvent(db, {
          kind: "projection_error",
          substrate_origin: "substrate_auto",
          directive_id: scoredEvent.directive_id,
          task_id: scoredEvent.task_id,
          context_refs: [scoredEvent.id, lookupId],
          payload: {
            where: "projectActionScoredToCredit",
            reason: "source_act_event_id_unresolvable",
            action_predicted_event_id: actionPredictedEventId,
            source_act_event_id: sourceActEventId,
            looked_up_id: lookupId,
            action_scored_event_id: scoredEvent.id,
          } as JsonValue,
        });
      }
      return;
    }
    const predictedPayload = JSON.parse(predictedRow.payload || "{}") as Record<string, unknown>;
    const predictedContextRefs = JSON.parse(predictedRow.context_refs || "[]") as string[];
    const citedArtifactIds = new Set<string>();
    // PRIMARY: action_artifact_id and verifier_artifact_id from the scored
    // event itself. These are the primary act participants — every
    // action_scored row should produce a credit row for both, even when
    // they aren't registered act_artifact rows (in which case the row
    // emits but the posterior update is a no-op).
    if (typeof scoredEvent.action_artifact_id === "string" && scoredEvent.action_artifact_id.length > 0) {
      citedArtifactIds.add(scoredEvent.action_artifact_id);
    }
    if (typeof scoredEvent.verifier_artifact_id === "string" && scoredEvent.verifier_artifact_id.length > 0) {
      citedArtifactIds.add(scoredEvent.verifier_artifact_id);
    }
    // CITED: from action_predicted payload.cited_artifact_ids
    const payloadCited = predictedPayload.cited_artifact_ids;
    if (Array.isArray(payloadCited)) {
      for (const id of payloadCited) {
        if (typeof id === "string" && id.length > 0) citedArtifactIds.add(id);
      }
    }
    // CITED: from action_predicted.context_refs — context_refs may include
    // ids that are act_artifact rows. Classify each to confirm before
    // crediting. Knowledge candidates go through distributeCredit's
    // knowledge path; the projector is artifact-only.
    for (const ref of predictedContextRefs) {
      if (typeof ref !== "string" || ref.length === 0) continue;
      const isArtifact = db.query("SELECT 1 AS x FROM act_artifact WHERE id = ?").get(ref) as { x: number } | null;
      if (isArtifact) citedArtifactIds.add(ref);
    }
    if (citedArtifactIds.size === 0) return; // nothing to credit
    const residual = typeof payload.residual === "number" && Number.isFinite(payload.residual)
      ? clampResidual(payload.residual)
      : (typeof scoredEvent.residual === "number" && Number.isFinite(scoredEvent.residual)
          ? clampResidual(scoredEvent.residual)
          : 0.5);
    const { alphaDelta, betaDelta } = residualToBetaDeltas(residual);
    const ts = nowIso();
    // Key on the resolved action_predicted id so the projection key is
    // stable regardless of which header field (action_predicted_event_id
    // or source_act_event_id) the emitter happened to stamp.
    const projectionAnchorId = predictedRow.id;
    for (const artifactId of citedArtifactIds) {
      const key = projectionKeyFor(projectionAnchorId, artifactId);
      if (projectionKeyExists(db, "act_artifact_score_updated", key)) continue;
      // Broader guard: distributeCredit may have already emitted an
      // act_artifact_score_updated for this (scored_event_id, artifact_id)
      // pair via its own projection-key shape. Skip to avoid the
      // double-update on the posterior.
      if (priorScoreUpdateExists(db, scoredEvent.id, artifactId)) continue;
      // Apply weighted Beta posterior delta to the artifact's row when
      // it's registered. When the row is missing (synthetic/unregistered
      // handle) we still emit the credit row — the audit trail needs to
      // show parity even when the posterior cannot be applied.
      const row = getArtifact(db, artifactId);
      let postScore: number | null = null;
      let postConfidence: number | null = null;
      if (row) {
        const updated = applyResidualOutcome(
          db,
          artifactId,
          residual,
          ts,
          () => { /* downstream emits handled by primitive */ },
          { weight: 1.0 },
        );
        postScore = updated.score;
        postConfidence = updated.confidence;
      }
      emitEvent(db, {
        kind: "act_artifact_score_updated",
        substrate_origin: "substrate_auto",
        directive_id: scoredEvent.directive_id,
        task_id: scoredEvent.task_id,
        action_artifact_id: artifactId,
        context_refs: [scoredEvent.id, projectionAnchorId, artifactId, ...(sourceActEventId && sourceActEventId !== projectionAnchorId ? [sourceActEventId] : [])],
        payload: {
          artifact_id: artifactId,
          role: "cited",
          residual,
          weight: 1.0,
          posterior_delta_alpha: alphaDelta,
          posterior_delta_beta: betaDelta,
          score: postScore,
          confidence: postConfidence,
          scored_event_id: scoredEvent.id,
          // source_act_id mirrors distributeCredit's payload convention —
          // points at the logical act (act_tuple_recorded id when the
          // scored row came through the projection path, or the
          // action_predicted id for direct emits).
          source_act_id: sourceActEventId ?? projectionAnchorId,
          source_act_event_id: sourceActEventId ?? projectionAnchorId,
          action_predicted_event_id: projectionAnchorId,
          projected_from: "action_scored_universal_projector",
          projection_key: key,
        } as JsonValue,
      });
    }
  } catch (err) {
    // Fail-soft: parent action_scored already landed. Surface the
    // failure as a projection_error so it's observable, but DO NOT
    // throw — that would poison the emit boundary.
    try {
      emitEvent(db, {
        kind: "projection_error",
        substrate_origin: "substrate_auto",
        directive_id: scoredEvent.directive_id,
        task_id: scoredEvent.task_id,
        context_refs: [scoredEvent.id],
        payload: {
          where: "projectActionScoredToCredit",
          reason: "exception",
          error: (err as Error).message ?? String(err),
          action_scored_event_id: scoredEvent.id,
        } as JsonValue,
      });
    } catch {
      /* swallow secondary failure */
    }
  }
};

// ── T0.3 Citation binding enforcement — knowledge credit symmetry ──
//
// Symmetric to T0.2 (commit d8baa7e — universal artifact credit
// projection). T0.3 closes the knowledge-credit half: every
// retrieval_binding event now mutates the cited knowledge candidate's
// Beta posterior immediately, not advisorily.
//
// Live evidence (brain_self_audit 168h): citations kc_emitted=1745
// promoted=0 — zero downstream promotions despite 1745 cited
// candidates. Citation = mutation was advisory (k_252: advisory = fake;
// k_201: retrieval binding; k_554: citation = mutation; k_555: four
// links create → retrieve → mutate retrieval state → credit outcome).
//
// The fix: at the emitEvent post-write hook in runtime/events.ts,
// every retrieval_binding event whose payload was NOT stamped
// projected_from="bind_citation" walks payload.cited_knowledge_id
// (forward-compat) OR payload.source_event_id (current shape) and
// emits a candidate_confirmed row with weight=BINDING_WEIGHT carrying
// payload.projected_from="bind_citation". The extractor accumulates
// fractional wins (it already honors payload.weight for
// knowledge_contradiction_observed; we extend that read to
// bind_citation candidate_confirmed rows so a retention nudge of
// 0.1 counts as 0.1 wins, not 1.0).
//
// Idempotency: projection_key = retrieval_binding_credit:{event_id}.
// A prior row skips the emit.
//
// Decorative citation: when the cited id doesn't resolve to a known
// knowledge_candidate / knowledge_promoted / lesson_extracted row,
// we emit retrieval_rejected (reason=cited_knowledge_id_unresolvable)
// instead of a candidate_confirmed; the binding stays in the ledger
// but contributes no retention bias.
//
// Recursion guard: bindCitation's own emits stamp
// payload.projected_from="bind_citation" so the hook does not recurse.
// The bulk retrieval_audit_worker (if any) remains the safety net;
// this hook makes the mutation STRUCTURAL at every emit.

/** Per-binding retention bias on the cited knowledge candidate's
 *  Beta posterior. Each binding accumulates BINDING_WEIGHT fractional
 *  wins via candidate_confirmed{projected_from=bind_citation, weight}.
 *  10 bindings on the same candidate accumulate ≈1.0 wins, 50 bindings
 *  ≈5.0 wins → crosses POSTERIOR.countThreshold (5) only on sustained
 *  retrieval, which is exactly the "compounding" semantic. */
export const BINDING_WEIGHT = 0.1;

const bindingProjectionKey = (retrievalBindingEventId: string): string =>
  "retrieval_binding_credit:" + retrievalBindingEventId;

const bindingProjectionExists = (db: Database, key: string): boolean => {
  const row = db
    .query<{ x: number }, [string]>(
      "SELECT 1 AS x FROM events WHERE kind = 'candidate_confirmed' AND json_extract(payload, '$.projection_key') = ? LIMIT 1",
    )
    .get(key);
  if (row) return true;
  // Decorative citations land as retrieval_rejected rows that also
  // stamp the same projection_key so the hook is idempotent across
  // both terminal branches.
  const rejected = db
    .query<{ x: number }, [string]>(
      "SELECT 1 AS x FROM events WHERE kind = 'retrieval_rejected' AND json_extract(payload, '$.projection_key') = ? LIMIT 1",
    )
    .get(key);
  return rejected !== null;
};

const KNOWLEDGE_BEARING_KINDS = new Set<string>([
  "knowledge_candidate",
  "knowledge_promoted",
  "lesson_extracted",
]);

type RetrievalBindingLite = {
  id: string;
  payload: string;
  directive_id: string;
  task_id: string;
};

/** Post-write hook for retrieval_binding events. Reads the cited
 *  knowledge id from payload (cited_knowledge_id preferred, source_event_id
 *  fallback), confirms the id resolves to a knowledge-bearing event row,
 *  and emits one candidate_confirmed{weight=BINDING_WEIGHT,
 *  projected_from=bind_citation} per binding so the extractor's
 *  Beta-posterior recompute accumulates fractional wins. Decorative
 *  citations (unresolvable id) emit retrieval_rejected instead.
 *  Idempotent via projection_key retrieval_binding_credit:{event_id}.
 *  Fail-soft: any error emits a projection_error and never throws. */
export const bindCitation = (
  db: Database,
  bindingEvent: RetrievalBindingLite,
): void => {
  try {
    const payload = JSON.parse(bindingEvent.payload || "{}") as Record<string, unknown>;
    // Recursion guard: a binding stamped by bindCitation itself should
    // never re-enter the hook. Defense-in-depth in case the hook is
    // called directly on a substrate-replay row.
    if (payload.projected_from === "bind_citation") return;
    // Forward-compat: prefer payload.cited_knowledge_id when present
    // (matches the T0.3 design vocabulary); fall back to source_event_id
    // (current canonical field — 7158/7186 bindings carry it).
    const citedFromPayload = typeof payload.cited_knowledge_id === "string" && payload.cited_knowledge_id.length > 0
      ? payload.cited_knowledge_id
      : null;
    const sourceEventId = typeof payload.source_event_id === "string" && payload.source_event_id.length > 0
      ? payload.source_event_id
      : null;
    const citedKnowledgeId = citedFromPayload ?? sourceEventId;
    if (!citedKnowledgeId) return; // safe no-op: nothing to credit
    const projectionKey = bindingProjectionKey(bindingEvent.id);
    if (bindingProjectionExists(db, projectionKey)) return; // idempotent

    // Resolve the cited id. Must point at a known knowledge-bearing row
    // (knowledge_candidate / knowledge_promoted / lesson_extracted). When
    // it resolves to any other kind OR no row at all, the citation is
    // decorative — emit retrieval_rejected so the rejection is observable
    // but no Beta posterior moves.
    const citedRow = db
      .query<{ kind: string }, [string]>("SELECT kind FROM events WHERE id = ?")
      .get(citedKnowledgeId);
    if (!citedRow || !KNOWLEDGE_BEARING_KINDS.has(citedRow.kind)) {
      emitEvent(db, {
        kind: "retrieval_rejected",
        substrate_origin: "substrate_auto",
        directive_id: bindingEvent.directive_id,
        task_id: bindingEvent.task_id,
        context_refs: [bindingEvent.id, citedKnowledgeId],
        payload: {
          retrieval_binding_event_id: bindingEvent.id,
          cited_knowledge_id: citedKnowledgeId,
          reason: citedRow ? "cited_id_not_knowledge_bearing" : "cited_knowledge_id_unresolvable",
          resolved_kind: citedRow?.kind ?? null,
          rejected_by: "bind_citation_hook",
          projected_from: "bind_citation",
          projection_key: projectionKey,
        } as JsonValue,
      });
      return;
    }

    // Emit the retention-bias credit row. The extractor reads payload.weight
    // for candidate_confirmed rows stamped by bind_citation and accumulates
    // fractional wins (the existing weight read for
    // knowledge_contradiction_observed is generalized to honor
    // candidate_confirmed payload.weight when projected_from="bind_citation").
    emitEvent(db, {
      kind: "candidate_confirmed",
      substrate_origin: "substrate_auto",
      directive_id: bindingEvent.directive_id,
      task_id: bindingEvent.task_id,
      context_refs: [citedKnowledgeId, bindingEvent.id],
      payload: {
        knowledge_id: citedKnowledgeId,
        retrieval_binding_event_id: bindingEvent.id,
        weight: BINDING_WEIGHT,
        polarity: "retention_bias",
        projected_from: "bind_citation",
        projection_key: projectionKey,
      } as JsonValue,
    });
  } catch (err) {
    // Fail-soft: the retrieval_binding row already landed. Surface as
    // projection_error so the bulk audit worker can re-drive if needed.
    try {
      emitEvent(db, {
        kind: "projection_error",
        substrate_origin: "substrate_auto",
        directive_id: bindingEvent.directive_id,
        task_id: bindingEvent.task_id,
        context_refs: [bindingEvent.id],
        payload: {
          where: "bindCitation",
          reason: "exception",
          error: (err as Error).message ?? String(err),
          retrieval_binding_event_id: bindingEvent.id,
        } as JsonValue,
      });
    } catch { /* swallow secondary failure */ }
  }
};

// ── Internal exports for tests ────────────────────────────────────

export const __extractBodyCitationsForTest = extractBodyCitations;
export const __collectCitationsForTest = collectCitations;
export const __residualToBetaDeltasForTest = residualToBetaDeltas;
