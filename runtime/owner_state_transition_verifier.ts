// acc2 owner-control hard gate (amendment KN78GX0J).
//
// owner_state_belief is CALIBRATION EVIDENCE ONLY — a learned prior about
// how the owner tends to react. It can never AUTHORIZE a sensitive action.
// Authorization is structural: explicit owner consent
// (owner_decision_recorded, verified by verifyOwnerConsent),
// owner_profile.things_to_never_do hard boundaries, and irreversible-effect
// constraints are enforced by evaluateOwnerControlGate BEFORE the action
// runs — not advisorily in prompt text, and not after an
// irreversible_effect_recorded row already landed.
//
// The gate emits owner_input_required / hidl_action_required and refuses
// invocation when consent / boundary / irreversibility constraints are
// unmet. A high-uncertainty (or high-confidence) owner_state_belief can
// only INCREASE the need for clarification; it can never set allowed=true
// for a protected action.

import type { Database } from "bun:sqlite";
import type { OwnerProfile } from "../substrate/types";
import { verifyOwnerConsent, profileThingsNeverDoMatches } from "./owner_gate";

export type OwnerControlGateInput = {
  directive_id?: string;
  task_id?: string;
  /** Plain-language summary of the action about to run. Matched against
   *  things_to_never_do. */
  action_summary: string;
  /** Resource handles / paths the action will touch. Matched against
   *  things_to_never_do. */
  target_resources: string[];
  /** Declared / planned irreversible effects (kind + description). When
   *  non-empty the gate requires explicit owner consent BEFORE invocation. */
  irreversible_effects?: Array<Record<string, unknown>>;
  /** Capabilities the action requested (e.g. net_allow, fs_write entries).
   *  Reserved for future capability-class gating; matched against
   *  things_to_never_do today. */
  requested_capabilities?: string[];
  /** Cited owner_decision_recorded consent event ids. The gate verifies
   *  each via verifyOwnerConsent scoped to directive_id. */
  cited_owner_consent_event_ids?: string[];
  /** Learned owner-state prior. CALIBRATION ONLY — never authorizes. */
  owner_state_belief?: Record<string, unknown> | null;
  /** The owner profile (things_to_never_do, autonomy, etc.). */
  owner_profile?: OwnerProfile | null;
};

export type OwnerControlGateDecision = {
  allowed: boolean;
  gate_kind?: "owner_input_required" | "hidl_action_required";
  reason?: string;
  summary: string;
  suggested_action?: string;
  evidence_event_ids: string[];
  /** owner_state_belief uncertainty ∈ [0,1]. Calibration signal only. */
  uncertainty: number;
  /** things_to_never_do entries (or other boundaries) that matched. */
  matched_boundaries: string[];
};

/** Resolve a [0,1] uncertainty from an owner_state_belief, if present.
 *  Reads payload.uncertainty / confidence — high uncertainty raises the
 *  clarification need; it NEVER authorizes. Returns 0 when no belief. */
const beliefUncertainty = (belief: Record<string, unknown> | null | undefined): number => {
  if (!belief || typeof belief !== "object") return 0;
  const u = belief.uncertainty;
  if (typeof u === "number" && Number.isFinite(u)) return Math.max(0, Math.min(1, u));
  const c = belief.confidence;
  if (typeof c === "number" && Number.isFinite(c)) return Math.max(0, Math.min(1, 1 - c));
  return 0;
};

/** Is at least one cited consent event a valid owner_decision_recorded for
 *  this directive scope? */
const hasValidConsent = (
  db: Database,
  consentEventIds: string[] | undefined,
  directiveId: string | undefined,
): { ok: boolean; consent_event_id?: string } => {
  if (!consentEventIds || consentEventIds.length === 0) return { ok: false };
  for (const id of consentEventIds) {
    const res = verifyOwnerConsent(db, id, directiveId);
    if (res.ok) return { ok: true, consent_event_id: id };
  }
  return { ok: false };
};

/** PRE-ACTION owner-control gate (amendment KN78GX0J). Evaluate BEFORE
 *  invoking a sensitive / irreversible artifact. Returns allowed=false with
 *  a gate_kind when a hard boundary is unmet:
 *    - things_to_never_do match → owner_input_required (owner_hard_boundary)
 *    - irreversible effects without valid consent → hidl_action_required
 *      (irreversible_effect_requires_consent)
 *  owner_state_belief is calibration only — high uncertainty raises the
 *  clarification need but never authorizes a protected action. */
export const evaluateOwnerControlGate = (
  db: Database,
  input: OwnerControlGateInput,
): OwnerControlGateDecision => {
  const uncertainty = beliefUncertainty(input.owner_state_belief);
  const profile = input.owner_profile ?? null;

  // 1. HARD BOUNDARY — things_to_never_do. A match refuses invocation
  //    regardless of owner_state_belief (a high-autonomy prior cannot
  //    override an explicit owner boundary).
  const matchTexts = [input.action_summary, ...input.target_resources, ...(input.requested_capabilities ?? [])];
  const matched = profileThingsNeverDoMatches(profile, matchTexts);
  if (matched.length > 0) {
    return {
      allowed: false,
      gate_kind: "owner_input_required",
      reason: "owner_hard_boundary",
      summary: `Action matches an owner hard boundary (${matched.join(", ")}). Owner confirmation required before proceeding.`,
      suggested_action: "Surface the boundary to the owner and ask for explicit go-ahead before any execution.",
      evidence_event_ids: [],
      uncertainty,
      matched_boundaries: matched,
    };
  }

  // 2. IRREVERSIBLE EFFECTS — require explicit, directive-scoped consent
  //    BEFORE invocation. owner_state_belief never substitutes for consent.
  const irreversible = input.irreversible_effects ?? [];
  if (irreversible.length > 0) {
    const consent = hasValidConsent(db, input.cited_owner_consent_event_ids, input.directive_id);
    if (!consent.ok) {
      return {
        allowed: false,
        gate_kind: "hidl_action_required",
        reason: "irreversible_effect_requires_consent",
        summary: `Action declares ${irreversible.length} irreversible effect(s) without a verified owner consent. A human-in-the-loop decision is required before it can run.`,
        suggested_action: "Obtain explicit owner consent (owner_decision_recorded) for this directive, then re-dispatch.",
        evidence_event_ids: [],
        uncertainty,
        matched_boundaries: [],
      };
    }
    return {
      allowed: true,
      summary: "Irreversible action authorized by verified owner consent.",
      evidence_event_ids: consent.consent_event_id ? [consent.consent_event_id] : [],
      uncertainty,
      matched_boundaries: [],
    };
  }

  // 3. No hard boundary, no irreversible effects → allowed. Note: a
  //    high-uncertainty belief is recorded on the decision (calibration)
  //    but does NOT block a non-sensitive action.
  return {
    allowed: true,
    summary: "No owner hard boundary or irreversible-effect constraint applies.",
    evidence_event_ids: [],
    uncertainty,
    matched_boundaries: [],
  };
};
