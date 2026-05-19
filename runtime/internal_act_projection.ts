// acc2 F6 — universal internal Act scoring helper.
//
// Every internal substrate decision (intent classification, dispatch
// lane selection, predicate gate triggers, knowledge merger,
// refinement edge open, closure audit, lesson extraction, citation
// choice, recipe replay selection, etc.) emits ONE
// `act_tuple_recorded` row through this single ingress so the
// existing emit-boundary projector in `runtime/events.ts` expands it
// into action_predicted / action_scored / candidate_confirmed /
// retrieval_binding / applied_change_committed rows with deterministic
// projection keys. No bespoke scoring tables per decision class.
//
// Why this exists as a separate helper rather than a direct
// `emitActTupleDirect` call at each site: callers need a UNIFORM
// shape, derived projection keys that survive replay and retry, and a
// fail-soft contract so a decision-site bug never blocks the
// underlying decision event from landing. The substrate already
// handles projection idempotency by `source_act_id + projection_kind
// + role/target`; this helper just composes the canonical envelope.
//
// Action and verifier "handles" are free strings — open-ended
// vocabulary that grows by being emitted, not by enum extension
// (CLAUDE.md "verifier_kind is a free-form string"). The
// `predicted_residual` carries the decision-time confidence inverse
// (1 - confidence) so high-confidence decisions predict near-zero
// residual and low-confidence decisions predict near-1.
//
// Wiring constraint: the helper MUST NOT throw on missing optional
// inputs and MUST NOT mutate the caller's flow. If the underlying
// `emitActTupleDirect` rejects an envelope (validation), the caller
// should observe `null` and continue with its primary decision emit.

import type { Database } from "bun:sqlite";
import type { JsonValue, OutcomeStatus, SubstrateOrigin } from "../substrate/types";
import { emitActTupleDirect } from "./act_tuple";
import type { EmittedEvent } from "./events";

type JsonObject = { [k: string]: JsonValue };

export type InternalActParams = {
  /** Free-string identifier for the decision intent — short prose
   *  describing what the substrate just decided. Examples:
   *  "classify directive intent", "select dispatch lane",
   *  "trigger predicate gate", "score closure verdict". */
  intent: string;
  /** Free-string handle for the action artifact — names the
   *  decision class (one per call site). Examples:
   *  "intent_classifier_v1", "dispatch_decider_v1",
   *  "predicate_gate_v1", "closure_verifier_v1",
   *  "citation_selector_v1". */
  actionHandle: string;
  /** Free-string handle for the verifier that will score this
   *  decision downstream. Examples: "lane_match_verifier",
   *  "owner_refusal_confirmation", "owner_observed_completeness",
   *  "retrieval_binding_credit". */
  verifierHandle: string;
  /** Verifier provenance string (CLAUDE.md). Examples:
   *  "deterministic_code", "peer_llm_claude", "owner_confirmation",
   *  "external_signal". Used by the action_scored projection. */
  verifierKind: string;
  /** Best-guess residual at decision time, in [0, 1]. Low means
   *  high confidence. Typical mapping: residual = 1 - confidence. */
  predictedResidual: number;
  /** Concise reasoning summary — one sentence. Required by the
   *  ActTuple validator. */
  reasoningSummary: string;
  /** Action summary — what was decided. */
  actionSummary: string;
  /** Effect summary — what changed in the ledger as a result. */
  effectSummary: string;
  /** Where the decision happened in the directive/task graph. */
  directiveId?: string;
  taskId?: string;
  /** The substrate-side actor that made the decision. Usually
   *  "substrate_auto" for internal decisions. */
  substrateOrigin?: SubstrateOrigin;
  /** Event id of the primary event the decision produced (e.g. the
   *  intent_classified row, the dispatch_decided row). Stamped onto
   *  the act envelope so the projection chain links back to the
   *  decision the act describes. */
  sourceEventId?: string;
  /** Logical group id so retries/replays produce the SAME
   *  projection_key. When omitted, the act_tuple_recorded row's own
   *  event id becomes the source_act_id (and projection keys remain
   *  unique per emit). For deterministic idempotency across retries,
   *  pass a stable string derived from the decision context (e.g.
   *  `intent_classifier_v1:` + directive_text_hash). */
  sourceActId?: string;
  /** Knowledge IDs that shaped the decision. May be empty for
   *  deterministic classifiers that do not consult substrate
   *  knowledge. */
  citedKnowledgeIds?: string[];
  /** Artifact IDs that shaped the decision. */
  citedArtifactIds?: string[];
  /** Resources the decision touched (file paths, URIs, table rows). */
  affectedResources?: string[];
  /** Extra payload fields the projection should carry through
   *  verbatim (decision-specific evidence the scoring loop may want
   *  later). Avoid embedding large blobs here — that defeats the
   *  thin-prompt principle. */
  extra?: JsonObject;
};

/** Emit ONE act_tuple_recorded row for an internal substrate
 *  decision. Returns the emitted event when projection succeeds,
 *  null when validation refuses the envelope (callers continue
 *  with their primary emit either way). The downstream
 *  action_predicted / action_scored / applied_change_committed
 *  projections are produced by `runtime/events.ts` at the emit
 *  boundary — this helper does NOT re-implement projection. */
export const recordInternalAct = (
  db: Database,
  params: InternalActParams,
): EmittedEvent | null => {
  try {
    const residual = clampResidual(params.predictedResidual);
    // For internal decisions the "observed" residual at emit time
    // equals the predicted one — the downstream verifier later
    // updates the posterior through action_scored credit when
    // ground-truth evidence (owner confirmation, lane outcome,
    // retrieval binding) arrives. Pending outcome until that
    // downstream signal lands.
    // Internal decisions are substrate-level, not task-level, and not
    // directive-level. Inheriting the work task's directive_id /
    // task_id would cause the action_predicted / action_scored
    // projections to share scope with the work artifact's projections,
    // breaking per-directive and per-task counters every external
    // observer relies on. The act envelope records the originating
    // directive_id and task_id in payload extras (as
    // associated_directive_id / associated_task_id) so observers can
    // still join internal decisions back to the work they accompanied,
    // while the projected rows stay self-rooted (directive_id and
    // task_id both default to the act_tuple_recorded event's own id
    // when omitted in events.ts).
    const associatedDirectiveId = params.directiveId;
    const associatedTaskId = params.taskId;
    const event = emitActTupleDirect(db, {
      substrateOrigin: params.substrateOrigin ?? "substrate_auto",
      intent: params.intent,
      reasoningSummary: params.reasoningSummary,
      actionSummary: params.actionSummary,
      effectSummary: params.effectSummary,
      verifierKind: params.verifierKind,
      predictedResidual: residual,
      residual,
      outcome: "pending" as OutcomeStatus,
      actionArtifactId: params.actionHandle,
      verifierArtifactId: params.verifierHandle,
      citedKnowledgeIds: params.citedKnowledgeIds ?? [],
      citedArtifactIds: params.citedArtifactIds ?? [],
      affectedResources: params.affectedResources ?? [],
      sourceEventId: params.sourceEventId,
      sourceActId: params.sourceActId,
      extra: {
        ...(params.extra ?? {}),
        internal_decision: true,
        action_handle: params.actionHandle,
        verifier_handle: params.verifierHandle,
        ...(associatedDirectiveId ? { associated_directive_id: associatedDirectiveId } : {}),
        ...(associatedTaskId ? { associated_task_id: associatedTaskId } : {}),
      },
    });
    return event;
  } catch {
    // Fail-soft: the decision the act describes already landed on the
    // ledger through the caller's primary emit. A validation-time
    // refusal here must not block the substrate's main decision flow.
    return null;
  }
};

const clampResidual = (value: number): number => {
  if (!Number.isFinite(value)) return 0.5;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
};
