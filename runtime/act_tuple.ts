import type { Database } from "bun:sqlite";
import type { JsonValue, OutcomeStatus, SubstrateOrigin } from "../substrate/types";
import { emitEvent, type EmittedEvent } from "./events";

type JsonObject = { [k: string]: JsonValue };

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

export const buildActTuplePayload = (act: ActTupleInput): JsonObject => {
  const actionArtifactId = requireNonEmptyString(act.actionArtifactId, "action_artifact_id");
  const verifierArtifactId = requireNonEmptyString(act.verifierArtifactId, "verifier_artifact_id");
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
