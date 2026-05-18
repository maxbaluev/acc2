// acc2 artifact-candidate screen — emit-side gates that scan
// `code_artifact_candidate` event payloads BEFORE the candidate row
// flows into downstream admission/closure paths. Closes the
// dark-gate gap (substrate audit 2026-05-18): the predicate gate and
// strategy-first gate were only wired into `admitArtifact`, but the
// brain emits `code_artifact_candidate` events directly via
// `substrate.emit` carrying the body in payload.body. Those events
// never reached the gates, so banned phrases, empty bodies, and
// missing strategic-direction citations slipped through.
//
// Hook point: `runtime/events.ts emitEvent` calls
// `screenCodeArtifactCandidate` whenever input.kind ===
// "code_artifact_candidate". The screen returns the list of refusal
// events to emit alongside the candidate. emitEvent inserts the
// candidate row first, then drives the refusal emissions back
// through itself so each one lands as a normal ledger row referencing
// the candidate's id in context_refs.
//
// Open-string semantics: thresholds and kind discrimination read
// payload.kind / payload.name verbatim (no closed enum). New artifact
// kinds inherit the default (200-char threshold) until a maintainer
// adds a rule.

import type { Database } from "bun:sqlite";
import type { EventKind, JsonValue } from "../substrate/types";
import { runPredicateGate } from "./verifiers/predicate_gate";
import { findStrategicDirectionCitation } from "./artifact_admission";

export type CandidateRefusal = {
  kind: EventKind;
  payload: JsonValue;
};

/** Per-artifact-kind minimum body length. Bodies below the threshold
 *  emit `lane_routing_refused` with reason `empty_body_below_threshold`.
 *  Open-string lookup — unknown kinds fall through to DEFAULT_MIN. The
 *  rendered_docx / published_drive_doc / markdown_body kinds carry a
 *  synthetic short body intentionally (render pipeline + drive seed),
 *  so they are exempt at 0. */
const PLACEHOLDER_BODY_KINDS = new Set<string>([
  "published_drive_doc",
  "rendered_docx",
  "markdown_body",
]);

const ATMS_REPORT_MIN = 500;
const DEFAULT_MIN = 200;

const thresholdFor = (
  kind: string | undefined,
  name: string | undefined,
): { threshold: number; classification: string } => {
  if (kind && PLACEHOLDER_BODY_KINDS.has(kind)) {
    return { threshold: 0, classification: "structural_placeholder" };
  }
  if (typeof name === "string" && name.startsWith("atms_report_v")) {
    return { threshold: ATMS_REPORT_MIN, classification: "atms_report" };
  }
  if (typeof kind === "string" && kind.startsWith("atms_report_")) {
    return { threshold: ATMS_REPORT_MIN, classification: "atms_report" };
  }
  return { threshold: DEFAULT_MIN, classification: "default" };
};

type CandidatePayload = {
  body?: unknown;
  kind?: unknown;
  name?: unknown;
  audience?: unknown;
  source_candidate_id?: unknown;
  cited_knowledge_ids?: unknown;
};

const asObject = (value: unknown): CandidatePayload | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as CandidatePayload;
};

const asStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.length > 0);
};

/** Screen one code_artifact_candidate payload. The returned refusals
 *  are emitted by the caller AFTER the candidate row is inserted so
 *  each refusal references the candidate's id in context_refs. */
export const screenCodeArtifactCandidate = (
  db: Database,
  input: { payload?: JsonValue; directive_id?: string; task_id?: string },
): { refusals: CandidateRefusal[] } => {
  const payload = asObject(input.payload);
  if (!payload) return { refusals: [] };
  const refusals: CandidateRefusal[] = [];

  const declaredKind = typeof payload.kind === "string" ? payload.kind : undefined;
  const declaredName = typeof payload.name === "string" ? payload.name : undefined;

  // 1. Empty-body refusal. Only inspect when payload.body is a string —
  //    candidates without a body field (e.g. workers logging a purpose
  //    stub) pre-date the body convention and are exempt. The threshold
  //    is keyed on declared kind/name so atms_report_v* gets the larger
  //    floor while small fixture bodies stay admissible.
  if (typeof payload.body === "string") {
    const bodyLen = payload.body.length;
    const t = thresholdFor(declaredKind, declaredName);
    if (bodyLen < t.threshold) {
      refusals.push({
        kind: "lane_routing_refused",
        payload: {
          reason: "empty_body_below_threshold",
          refused_kind: "code_artifact_candidate",
          body_length: bodyLen,
          threshold: t.threshold,
          classification: t.classification,
          artifact_kind: declaredKind ?? null,
          artifact_name: declaredName ?? null,
          directive_id: input.directive_id ?? null,
          task_id: input.task_id ?? null,
        } as JsonValue,
      });
    }
  }

  // 2. Predicate gate scan — runs when audience is set to one of the
  //    high-stakes audiences gated in runPredicateGate. The gate itself
  //    returns rejected=false when audience is unset or out of scope,
  //    so the call is fail-soft.
  const audience = typeof payload.audience === "string" ? payload.audience : undefined;
  const sourceCandidateId =
    typeof payload.source_candidate_id === "string" ? payload.source_candidate_id : undefined;
  if (audience && typeof payload.body === "string" && payload.body.length > 0) {
    const gate = runPredicateGate(db, {
      audience,
      body: payload.body,
      sourceCandidateId,
    });
    if (gate.rejected) {
      refusals.push({
        kind: "predicate_gate_rejected",
        payload: {
          reason: "predicate_gate_failed",
          audience,
          artifact_kind: declaredKind ?? null,
          artifact_name: declaredName ?? null,
          source_candidate_id: sourceCandidateId ?? null,
          match_count: gate.matches.length,
          matches: gate.matches as unknown as JsonValue,
          cited_knowledge_ids: gate.citedKnowledgeIds as unknown as JsonValue,
          residual: gate.residual,
          directive_id: input.directive_id ?? null,
          task_id: input.task_id ?? null,
        } as JsonValue,
      });
    }
  }

  // 3. Strategy-first gate — any candidate whose declared NAME OR
  //    KIND starts with atms_report_v MUST cite at least one
  //    knowledge_candidate / knowledge_synthesized event whose
  //    payload.claim ends with `_strategic_direction_chosen`. The
  //    lookup uses the same helper as the admission-path gate so
  //    admit + emit-side stay consistent. Pre-dark-gate-sweep the
  //    admission gate only checked input.name; the v9 Lakeland
  //    candidates set name="lakeland_industries_ai_transformation_report_v9"
  //    while kind="atms_report_v9" — so the name-only check missed
  //    them entirely. Checking both surfaces closes the gap.
  const looksLikeAtmsReport =
    (typeof declaredName === "string" && declaredName.startsWith("atms_report_v")) ||
    (typeof declaredKind === "string" && declaredKind.startsWith("atms_report_v"));
  if (looksLikeAtmsReport) {
    const citedIds = asStringArray(payload.cited_knowledge_ids);
    const check = findStrategicDirectionCitation(db, citedIds);
    if (!check.ok) {
      refusals.push({
        kind: "atms_strategy_first_violation",
        payload: {
          reason: "strategy_first_violation_missing_strategic_direction_chosen",
          artifact_name: declaredName ?? null,
          artifact_kind: declaredKind ?? null,
          cited_knowledge_ids: citedIds as unknown as JsonValue,
          source_candidate_id: sourceCandidateId ?? null,
          missing_claim_suffix: "_strategic_direction_chosen",
          inspected_ids: check.inspectedIds as unknown as JsonValue,
          directive_id: input.directive_id ?? null,
          task_id: input.task_id ?? null,
        } as JsonValue,
      });
    }
  }

  return { refusals };
};
