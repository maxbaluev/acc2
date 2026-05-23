// acc2 artifact-candidate screen — emit-side gates that scan
// `act_artifact_candidate` event payloads BEFORE the candidate row
// flows into downstream admission/closure paths. Closes the
// dark-gate gap (substrate audit 2026-05-18): the predicate gate and
// strategy-first gate were only wired into `admitArtifact`, but the
// brain emits `act_artifact_candidate` events directly via
// `substrate.emit` carrying the body in payload.body. Those events
// never reached the gates, so banned phrases, empty bodies, and
// missing strategic-direction citations slipped through.
//
// Hook point: `runtime/events.ts emitEvent` calls
// `screenActArtifactCandidate` whenever input.kind ===
// "act_artifact_candidate". The screen returns the list of refusal
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
import { requiresStrategicGrounding } from "../substrate/artifact_kind_metadata";

export type CandidateRefusal = {
  kind: EventKind;
  payload: JsonValue;
};

/** Minimum prefix length to consider for unique-prefix citation resolution.
 *  12 chars of ULID base32 = 60 bits — collision probability at 1M events is
 *  ~1 in 1e6, well below the truncation surface area the brain emits. */
const MIN_CITATION_PREFIX_LEN = 12;

/** Resolves an id to events.id when present. Tries exact match first (the
 *  canonical brain emission shape), then unique-prefix match: when the
 *  caller passed a ULID prefix of at least MIN_CITATION_PREFIX_LEN chars
 *  AND exactly one events.id starts with it, that row resolves. This
 *  closes the citation-truncation gap where the brain emits 12-26 char
 *  prefixes of valid ULIDs and the gate refused them as decorative
 *  because the exact-match query missed. Ambiguous prefixes (>=2 matches)
 *  return null — the brain must disambiguate. */
const resolveEventId = (db: Database, id: string): string | null => {
  if (typeof id !== "string" || id.length === 0) return null;
  try {
    const exact = db
      .query<{ id: string }, [string]>(
        "SELECT id FROM events WHERE id = ? LIMIT 1",
      )
      .get(id);
    if (exact) return exact.id;
    if (id.length < MIN_CITATION_PREFIX_LEN) return null;
    // LIMIT 2 lets us detect ambiguity in one query (≥2 matches = reject).
    const matches = db
      .query<{ id: string }, [string]>(
        "SELECT id FROM events WHERE id LIKE ? LIMIT 2",
      )
      .all(`${id}%`);
    if (matches.length === 1) return matches[0]!.id;
    return null;
  } catch {
    return null;
  }
};

/** F1: partition cited_knowledge_ids into resolved (real events.id) and
 *  unresolved (free-text labels). The screen treats unresolved entries
 *  as decorative citations (k_555 four-link chain broken) and emits a
 *  lane_routing_refused with the unresolved list. The admitted artifact
 *  retains ONLY the resolved entries as its effective citation set. */
export const partitionCitedKnowledge = (
  db: Database,
  citedIds: readonly string[],
): { resolved: string[]; unresolved: string[] } => {
  const resolved: string[] = [];
  const unresolved: string[] = [];
  for (const id of citedIds) {
    if (typeof id !== "string" || id.length === 0) continue;
    const eventId = resolveEventId(db, id);
    if (eventId) {
      resolved.push(eventId);
    } else {
      unresolved.push(id);
    }
  }
  return { resolved, unresolved };
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

/** Screen one act_artifact_candidate payload. The returned refusals
 *  are emitted by the caller AFTER the candidate row is inserted so
 *  each refusal references the candidate's id in context_refs. */
export const screenActArtifactCandidate = (
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
          refused_kind: "act_artifact_candidate",
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

  // 3. Strategy-first gate — F4c posterior-keyed (contract
  //    897XTN2GF11XB9D4N45N2R9W58). Any candidate whose declared kind
  //    or name resolves to an `artifact_kind_metadata` row with
  //    `needs_strategic_grounding > threshold` MUST cite at least one
  //    knowledge_candidate / knowledge_synthesized event whose
  //    payload.claim ends with `_strategic_direction_chosen`. The lookup
  //    uses the same helper as the admission-path gate so admit + emit-
  //    side stay consistent. Pre-F4c the substrate hard-coded the
  //    `atms_report_v` prefix here; now those kinds are seeded into the
  //    metadata table and the gate self-extends through use.
  const citedIds = asStringArray(payload.cited_knowledge_ids);
  const groundingHit = requiresStrategicGrounding(db, {
    kind: declaredKind ?? null,
    name: declaredName ?? null,
  });
  if (groundingHit.required) {
    const check = findStrategicDirectionCitation(db, citedIds);
    if (!check.ok) {
      refusals.push({
        kind: "atms_strategy_first_violation",
        payload: {
          reason: "strategy_first_violation_missing_strategic_direction_chosen",
          artifact_name: declaredName ?? null,
          artifact_kind: declaredKind ?? null,
          matched_kind: groundingHit.matched_kind,
          needs_strategic_grounding: groundingHit.needs_strategic_grounding,
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

  // 4. F1 decorative-citation refusal — every cited_knowledge_ids entry
  //    on a substantive candidate (audience set OR body length > 200)
  //    must resolve to a real events.id. Pre-fix 310 / 323 recent
  //    act_artifact_candidates cited NOTHING; 60% of those that DID
  //    cite supplied string labels (e.g. "decorative_proof_of_alex") not
  //    real event ids — so k_555 four-link credit was broken at the
  //    binding step.
  //
  //    Two refusal shapes:
  //      (a) substantive candidate cites zero knowledge ids →
  //          lane_routing_refused reason=artifact_citation_underrooted
  //      (b) substantive candidate cites ≥1 id but some are unresolvable
  //          labels → lane_routing_refused reason=decorative_citation
  //          with payload.unresolved_labels (the admitted artifact still
  //          retains the RESOLVED subset as its effective citations).
  //
  //    "Substantive" = audience is set OR body length exceeds 200 chars.
  //    Pure placeholder-kind rows (rendered_docx / published_drive_doc /
  //    markdown_body) are exempt from (a) because their body is
  //    structural-placeholder text; if they happen to cite labels (b)
  //    still applies.
  const bodyText = typeof payload.body === "string" ? payload.body : "";
  // 2026-05-21 executable-tool exemption (mirror of artifact_admission.ts).
  // Executable artifacts (non-null runtime ∈ {bun,uv,camofox-browser}) are
  // TOOLS the brain creates to do work (diagnostic/test/patch runners),
  // rooted by sandbox + verifier residual — NOT knowledge claims. They are
  // exempt from the citation-underrooted refusal, exactly as placeholder
  // kinds are. Without this, every uncited runner the brain admits during a
  // normal implementation dispatch storms lane_routing_refused and stalls.
  const declaredRuntime = typeof payload.runtime === "string" ? payload.runtime : null;
  const isExecutableTool = declaredRuntime !== null && declaredRuntime.length > 0;
  const isPlaceholderKind =
    (typeof declaredKind === "string" && PLACEHOLDER_BODY_KINDS.has(declaredKind)) ||
    isExecutableTool;
  const isSubstantive =
    (typeof payload.audience === "string" && payload.audience.length > 0) ||
    bodyText.length > 200;
  if (isSubstantive) {
    const { resolved, unresolved } = partitionCitedKnowledge(db, citedIds);
    if (citedIds.length === 0 && !isPlaceholderKind) {
      refusals.push({
        kind: "lane_routing_refused",
        payload: {
          reason: "artifact_citation_underrooted",
          refused_kind: "act_artifact_candidate",
          artifact_kind: declaredKind ?? null,
          artifact_name: declaredName ?? null,
          audience: typeof payload.audience === "string" ? payload.audience : null,
          body_length: bodyText.length,
          directive_id: input.directive_id ?? null,
          task_id: input.task_id ?? null,
        } as JsonValue,
      });
    } else if (unresolved.length > 0) {
      refusals.push({
        kind: "lane_routing_refused",
        payload: {
          reason: "decorative_citation",
          refused_kind: "act_artifact_candidate",
          artifact_kind: declaredKind ?? null,
          artifact_name: declaredName ?? null,
          unresolved_labels: unresolved as unknown as JsonValue,
          resolved_ids: resolved as unknown as JsonValue,
          directive_id: input.directive_id ?? null,
          task_id: input.task_id ?? null,
        } as JsonValue,
      });
    }
  }

  return { refusals };
};
