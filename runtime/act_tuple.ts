import type { Database } from "bun:sqlite";
import type { JsonValue, OutcomeStatus, SubstrateOrigin } from "../substrate/types";
import { emitEvent, type EmittedEvent } from "./events";

type JsonObject = { [k: string]: JsonValue };

// F7 (2026-05-18, roadmap WW7W1NZ8A10R52PB4E7EJE9YBW). Non-technical
// goals (eulogies, job decisions, relationship reconciliation, growth,
// meaning) settle on owner-observed timescales that span days to years.
// `FeedbackWindow` encodes how long the substrate should wait before
// scoring the act. The classification is open-ended in spirit
// (operators can coin new strings) but five canonical buckets are
// recognised by the lifecycle closure sweep:
//   immediate (< 1 min)  — deterministic test, code-residual check
//   short     (< 1 hr)   — owner review of an artifact / draft
//   medium    (< 1 day)  — research outcome, draft acceptance
//   long      (< 1 mo)   — decision quality, relationship signal
//   very_long (1 mo+)    — life outcome, growth, meaning
//
// Lifecycles whose feedback_window.classification is `long` or
// `very_long` are EXPECTED to stay open for weeks-to-months; the
// closure sweep exempts them from premature auto-closure so the owner
// can return with the eventual signal and the substrate can credit
// the originating act chain.
export type FeedbackWindowClassification =
  | "immediate"
  | "short"
  | "medium"
  | "long"
  | "very_long"
  | string;

export type FeedbackWindow = {
  /** Typical wait time in milliseconds before owner outcome is
   *  expected. Emitters set this from the verifier_kind hint or from
   *  prior posterior evidence; closure sweeps may consult it. */
  duration_ms: number;
  classification: FeedbackWindowClassification;
};

/** Canonical packet shape for predicted_residual when the emitter wants
 *  to carry feedback_window alongside the scalar prediction. The Event
 *  row column stays a bare number — JsonValue does not allow nested
 *  objects in that slot; the packet form is used inside
 *  act_tuple_recorded payloads, recipe trajectories, and lifecycle-source
 *  rows that the closure sweep inspects.
 *
 *  The helpers accept `number` everywhere; the packet form is opt-in. */
export type PredictedResidual = {
  /** Scalar residual prediction in [0,1]. */
  value: number;
  /** Optional observation window. Required only when the act settles
   *  on a non-immediate timescale. */
  feedback_window?: FeedbackWindow;
};

export type ActTupleInput = {
  directiveId?: string;
  taskId?: string;
  substrateOrigin: SubstrateOrigin;
  invoker?: SubstrateOrigin;
  intent: string;
  reasoningSummary: string;
  actionSummary: string;
  effectSummary: string;
  verifierKind: string;
  predictedResidual: number;
  /** F7: optional observation window for the predicted residual. When
   *  set, the lifecycle closure sweep treats long / very_long lifecycles
   *  as expected-to-remain-open rather than stale. */
  feedbackWindow?: FeedbackWindow;
  residual: number;
  outcome: OutcomeStatus;
  actionArtifactId: string;
  verifierArtifactId: string;
  affectedResources?: string[];
  citedKnowledgeIds: string[];
  citedArtifactIds: string[];
  contextRefs?: string[];
  sourceEventId?: string;
  sourceActId?: string;
  derivedEventIds?: string[];
  extra?: JsonObject;
};

type McpEmitEnvelope =
  | { ok: true; result?: { id?: string; ts?: string }; id?: string; ts?: string }
  | { ok: false; error?: string };

const requireNonEmptyString = (value: string | undefined, key: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("act_tuple_missing_" + key);
  }
  return value;
};

const requireResidual = (value: number | undefined, key: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("act_tuple_invalid_" + key);
  }
  return value;
};

const asJsonStringArray = (xs: string[] | undefined, key: string): JsonValue[] => {
  if (!Array.isArray(xs)) throw new Error("act_tuple_missing_" + key);
  if (xs.some((x) => typeof x !== "string" || x.trim().length === 0)) {
    throw new Error("act_tuple_invalid_" + key);
  }
  return xs;
};

const optionalJsonStringArray = (xs: string[] | undefined, key: string): JsonValue[] => {
  if (xs === undefined) return [];
  return asJsonStringArray(xs, key);
};

const validateFeedbackWindow = (fw: FeedbackWindow): FeedbackWindow => {
  if (typeof fw.duration_ms !== "number" || !Number.isFinite(fw.duration_ms) || fw.duration_ms < 0) {
    throw new Error("act_tuple_invalid_feedback_window_duration_ms");
  }
  if (typeof fw.classification !== "string" || fw.classification.trim().length === 0) {
    throw new Error("act_tuple_invalid_feedback_window_classification");
  }
  return { duration_ms: fw.duration_ms, classification: fw.classification };
};

export const buildActTuplePayload = (act: ActTupleInput): JsonObject => {
  const actionArtifactId = requireNonEmptyString(act.actionArtifactId, "action_artifact_id");
  const verifierArtifactId = requireNonEmptyString(act.verifierArtifactId, "verifier_artifact_id");
  const fw = act.feedbackWindow ? validateFeedbackWindow(act.feedbackWindow) : undefined;
  return {
    intent: requireNonEmptyString(act.intent, "intent"),
    reasoning_summary: requireNonEmptyString(act.reasoningSummary, "reasoning_summary"),
    action_summary: requireNonEmptyString(act.actionSummary, "action_summary"),
    effect_summary: requireNonEmptyString(act.effectSummary, "effect_summary"),
    verifier_kind: requireNonEmptyString(act.verifierKind, "verifier_kind"),
    predicted_residual: requireResidual(act.predictedResidual, "predicted_residual"),
    residual: requireResidual(act.residual, "residual"),
    outcome: act.outcome,
    action_artifact_id: actionArtifactId,
    verifier_artifact_id: verifierArtifactId,
    source_event_id: act.sourceEventId ?? null,
    source_act_id: act.sourceActId ?? null,
    affected_resources: optionalJsonStringArray(act.affectedResources, "affected_resources"),
    cited_knowledge_ids: asJsonStringArray(act.citedKnowledgeIds, "cited_knowledge_ids"),
    cited_artifact_ids: asJsonStringArray(act.citedArtifactIds, "cited_artifact_ids"),
    derived_event_ids: optionalJsonStringArray(act.derivedEventIds, "derived_event_ids"),
    // F7: include the packet form of predicted_residual when an
    // observation window was declared. Consumers that want the bare
    // scalar still read `predicted_residual` directly; consumers that
    // care about the window read `predicted_residual_packet`.
    ...(fw
      ? {
          predicted_residual_packet: {
            value: act.predictedResidual,
            feedback_window: fw,
          },
          feedback_window: fw,
        }
      : {}),
    ...(act.extra ?? {}),
  };
};

export const emitActTupleDirect = (db: Database, act: ActTupleInput): EmittedEvent => {
  return emitEvent(db, {
    kind: "act_tuple_recorded",
    substrate_origin: act.substrateOrigin,
    directive_id: act.directiveId,
    task_id: act.taskId,
    context_refs: act.contextRefs ?? [],
    action_artifact_id: act.actionArtifactId,
    verifier_artifact_id: act.verifierArtifactId,
    predicted_residual: act.predictedResidual,
    residual: act.residual,
    outcome: act.outcome,
    payload: buildActTuplePayload(act),
    invoker: act.invoker ?? act.substrateOrigin,
  });
};

export const emitActTupleViaMcp = async (
  mcpCall: (toolName: string, args: Record<string, unknown>) => Promise<McpEmitEnvelope>,
  act: ActTupleInput,
): Promise<EmittedEvent> => {
  const env = await mcpCall("substrate.emit", {
    kind: "act_tuple_recorded",
    substrate_origin: act.substrateOrigin,
    directive_id: act.directiveId,
    task_id: act.taskId,
    context_refs: act.contextRefs ?? [],
    action_artifact_id: act.actionArtifactId,
    verifier_artifact_id: act.verifierArtifactId,
    predicted_residual: act.predictedResidual,
    residual: act.residual,
    outcome: act.outcome,
    payload: buildActTuplePayload(act),
  });
  if (!env.ok) throw new Error(env.error ?? "act_tuple_emit_failed");
  const id = env.result?.id ?? env.id;
  const ts = env.result?.ts ?? env.ts ?? "";
  if (!id) throw new Error("act_tuple_emit_missing_id");
  return { id, ts };
};
