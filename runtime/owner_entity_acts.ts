// acc2 F6 completion — entity-model and owner-profile attribute write wraps.
//
// Decisions 9 (entity attribute write) and 10 (owner profile attribute
// write) from the F4-F7 roadmap (event WW7W1NZ8A10R52PB4E7EJE9YBW).
// Both go through the same recordInternalAct ingress as every other
// internal substrate decision (CLAUDE.md "same substrate, same scoring
// loop"), keeping the open-string action/verifier vocabulary aligned
// with the F6 brief.
//
// Why a thin wrap rather than inline emit at every entity/owner write
// site: the wrap derives the deterministic projection key from
// (action_handle, deterministic_context_hash) so retries/replays do
// not double-credit, and centralises the predicted_residual + verifier
// handle choices so future calibration changes touch one row, not N.
// Substrate-level emission — directive_id/task_id are payload extras
// (associated_directive_id / associated_task_id) so internal-decision
// projections stay self-rooted, matching the F6 invariant in
// runtime/internal_act_projection.ts.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { recordInternalAct } from "./internal_act_projection";
import type { EmittedEvent } from "./events";

type JsonObject = { [k: string]: JsonValue };

// FNV-1a 32-bit string hash — stable across retries and platforms,
// short enough to embed in projection keys without bloating the row.
const stableHash = (input: string): string => {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
};

const safeJson = (value: JsonValue | undefined): string => {
  try { return JSON.stringify(value ?? null); }
  catch { return "unserializable"; }
};

export type EntityAttributeActParams = {
  /** Entity identifier — e.g. stakeholder_id, company id, contact id. */
  entityId: string;
  /** Attribute being written — open-string (declared_utility,
   *  inferred_constraints, information_visibility, relationship,
   *  …whatever the entity surface declares). */
  attributeName: string;
  /** Attribute value the write committed (verbatim, for credit-time
   *  retrieval). Pass nulls/objects/arrays as-is. */
  attributeValue: JsonValue | undefined;
  /** Originating event id (stakeholder_state_recorded row, etc.). */
  sourceEventId?: string;
  directiveId?: string;
  taskId?: string;
  citedKnowledgeIds?: string[];
  extra?: JsonObject;
};

/** Score an entity-model attribute write as one act. The downstream
 *  verifier (subsequent_evidence_agreement) closes the credit chain
 *  when later observations either confirm or contradict the recorded
 *  attribute value. Predicted residual 0.3 mirrors the F6 brief —
 *  entity-attribute writes are moderately confident assertions: the
 *  declared utility might be observation-based or owner-stated, both
 *  of which can later be revised by direct contradicting evidence. */
export const recordEntityAttributeAct = (
  db: Database,
  params: EntityAttributeActParams,
): EmittedEvent | null => {
  const contextHash = stableHash(
    params.entityId + "::" + params.attributeName + "::" + safeJson(params.attributeValue),
  );
  return recordInternalAct(db, {
    intent: "write entity attribute",
    actionHandle: "entity_attribute_writer_v1",
    verifierHandle: "subsequent_evidence_agreement",
    verifierKind: "deterministic_code",
    predictedResidual: 0.3,
    reasoningSummary: `entity ${params.entityId} attribute=${params.attributeName}`,
    actionSummary: `entity_attribute write entity=${params.entityId} attribute=${params.attributeName}`,
    effectSummary: `attribute committed to ledger for entity ${params.entityId}`,
    directiveId: params.directiveId,
    taskId: params.taskId,
    sourceEventId: params.sourceEventId,
    sourceActId: "entity_attribute_writer_v1:" + contextHash,
    citedKnowledgeIds: params.citedKnowledgeIds,
    extra: {
      ...(params.extra ?? {}),
      entity_id: params.entityId,
      attribute_name: params.attributeName,
      attribute_value: params.attributeValue ?? null,
    },
  });
};

export type OwnerProfileAttributeActParams = {
  /** Owner-profile field being written — e.g. preferred_terms,
   *  autonomy_score, rendering_signals, things_to_never_do. */
  field: string;
  /** Value committed (string, number, array, object — whatever the
   *  field's schema accepts). */
  value: JsonValue | undefined;
  /** How the value reached this write — promotion route, classifier
   *  source, adjuster delta, etc. Free-string vocabulary. */
  source: string;
  sourceEventId?: string;
  directiveId?: string;
  taskId?: string;
  citedKnowledgeIds?: string[];
  extra?: JsonObject;
};

/** Score an owner-profile attribute write as one act. The downstream
 *  verifier (drift_detection_signal) credits the action when later
 *  owner observations stay consistent with the recorded value and
 *  contradicts it when drift fires. Predicted residual 0.3 — same
 *  rationale as entity attribute: owner profile writes are moderately
 *  confident assertions about a non-stationary signal. */
export const recordOwnerProfileAttributeAct = (
  db: Database,
  params: OwnerProfileAttributeActParams,
): EmittedEvent | null => {
  const contextHash = stableHash(
    params.field + "::" + safeJson(params.value) + "::" + params.source,
  );
  return recordInternalAct(db, {
    intent: "write owner profile attribute",
    actionHandle: "owner_profile_writer_v1",
    verifierHandle: "drift_detection_signal",
    verifierKind: "deterministic_code",
    predictedResidual: 0.3,
    reasoningSummary: `owner profile field=${params.field} source=${params.source}`,
    actionSummary: `owner_profile attribute write field=${params.field}`,
    effectSummary: `field committed to owner profile via ${params.source}`,
    directiveId: params.directiveId,
    taskId: params.taskId,
    sourceEventId: params.sourceEventId,
    sourceActId: "owner_profile_writer_v1:" + contextHash,
    citedKnowledgeIds: params.citedKnowledgeIds,
    extra: {
      ...(params.extra ?? {}),
      field: params.field,
      value: params.value ?? null,
      source: params.source,
    },
  });
};
