// owner_state_transition_verifier.ts — score whether a chosen alignment
// action FIT the substrate's current owner-state belief.
//
// Brain contract CY7E62DSNX1DZ1BTD56845D994 Phase H3 (2026-05-18).
// The rendering_verifier scores rendered TEXT against the policy; this
// verifier scores chosen ACTIONS against the belief. Both feed the same
// substrate Bayesian event-memory but on different axes:
//   - rendering_verifier  : was the surface language right for the owner?
//   - transition_verifier : was the chosen action right for the BELIEF?
//
// Closes the four-link chain (k_555):
//   owner_state_belief → alignment_action_selected → transition_verifier
//     → owner_state_prediction_error_recorded → posterior credit
//
// Pure module — no DB reads, no side effects. Consumers (the substrate
// or a future worker) pass the belief, the chosen action, and an
// optional outcome signal; the verifier returns residual + per-axis
// breakdown + open-ended violations.

import type { OwnerStateBeliefRow } from "../substrate/views";

export type AlignmentActionInput = {
  /** Free-string action_kind. Common values: ask_clarification, defer,
   *  render_plain, render_technical, propose_alternative, refuse,
   *  inline_apply, escalate_to_owner. Open-ended per k_201. */
  action_kind: string;
  /** Optional plain-words rationale (used for ask_clarity scoring). */
  rationale?: string;
  /** Whether the action included a plain-words ask phrase. */
  has_owner_ask?: boolean;
  /** Optional self-reported axes — the action declares which belief
   *  axes it was conditioned on, e.g. ['attention_budget', 'emotional_register'].
   *  When present, the verifier checks consistency between declared axes
   *  and the belief's confidence vector. */
  cited_belief_axes?: string[];
  /** Optional artifact ids referenced by the action (cited_artifact_ids
   *  from the alignment_action_selected payload). */
  cited_artifact_ids?: string[];
};

export type OwnerStateOutcomeSignal = {
  /** Owner-observable result of the action. Free-string. Examples:
   *  "owner_approved", "owner_corrected_terms", "owner_ignored",
   *  "owner_overrode", "owner_clarified". */
  observed_outcome?: string;
  /** Optional numeric outcome residual ∈ [0,1] (0 = perfect). */
  observed_residual?: number;
};

export type OwnerStateTransitionInput = {
  belief: OwnerStateBeliefRow | null;
  action: AlignmentActionInput;
  outcome?: OwnerStateOutcomeSignal;
};

export type TransitionViolation = {
  axis: string;
  sample?: string;
  message: string;
};

export type OwnerStateTransitionResult = {
  /** Aggregate residual ∈ [0,1] across all axes. 0 = perfect fit. */
  residual: number;
  /** Per-axis prediction error ∈ [0,1]. Open-ended — new axes appear
   *  by being added here, not by enum extension. */
  prediction_error: Record<string, number>;
  /** Recorded axis-by-axis explanations. */
  violations: TransitionViolation[];
};

/** Numeric "fit" weight applied when the action TYPE conflicts with the
 *  belief axis (closer to 1 = bigger violation). */
const FIT_WEIGHTS = {
  state_action_fit: 0.18,
  attention_budget_fit: 0.15,
  emotional_register_fit: 0.18,
  decision_burden_fit: 0.15,
  skill_calibration_fit: 0.12,
  session_memory_fit: 0.10,
  latent_goal_fit: 0.12,
} as const;

const ZERO_AXES: Record<string, number> = {
  state_action_fit: 0,
  attention_budget_fit: 0,
  emotional_register_fit: 0,
  decision_burden_fit: 0,
  skill_calibration_fit: 0,
  session_memory_fit: 0,
  latent_goal_fit: 0,
};

/** Score whether a chosen alignment action fit the current belief.
 *  Returns a residual ∈ [0,1] (0 = perfect fit, 1 = total mismatch),
 *  per-axis breakdown, and open-ended violations. */
export const scoreOwnerStateTransition = (
  input: OwnerStateTransitionInput,
): OwnerStateTransitionResult => {
  const breakdown: Record<string, number> = { ...ZERO_AXES };
  const violations: TransitionViolation[] = [];
  const { belief, action, outcome } = input;
  const a = (action.action_kind ?? "").toLowerCase();

  // (1) state_action_fit — basic sanity. If belief is null, only
  //     ask_clarification + render_plain are safe defaults; other action
  //     kinds raise state_action_fit slightly.
  if (!belief) {
    if (a !== "ask_clarification" && a !== "render_plain" && a !== "defer") {
      breakdown.state_action_fit = FIT_WEIGHTS.state_action_fit;
      violations.push({
        axis: "state_action_fit",
        sample: a,
        message: "action chosen without a belief — only ask_clarification/render_plain/defer are safe defaults",
      });
    }
    const residual = Math.max(0, Math.min(1, sumValues(breakdown)));
    return { residual, prediction_error: breakdown, violations };
  }

  const latent = belief.latent_state;
  const conf = belief.confidence;

  // (2) attention_budget_fit — render_technical or surface evidence
  //     when attention_budget is 'low' violates the policy.
  const attention = String(latent.attention_budget ?? "").toLowerCase();
  if (attention === "low" && (a === "render_technical" || a === "surface_evidence" || a === "deep_dive")) {
    breakdown.attention_budget_fit = FIT_WEIGHTS.attention_budget_fit;
    violations.push({
      axis: "attention_budget_fit",
      sample: a,
      message: `chose '${a}' while attention_budget=low (conf ${(conf.attention_budget ?? 0.5).toFixed(2)})`,
    });
  }
  if (attention === "high" && a === "render_plain" && (conf.attention_budget ?? 0) > 0.7) {
    // Engineer who wants depth → render_plain leaves residual on the table.
    breakdown.attention_budget_fit = Math.max(breakdown.attention_budget_fit, 0.05);
    violations.push({
      axis: "attention_budget_fit",
      sample: a,
      message: "render_plain with high-confidence high attention — surface evidence instead",
    });
  }

  // (3) emotional_register_fit — refuse / escalate when frustrated is
  //     ok; surface_evidence when frustrated is bad.
  const register = String(latent.emotional_register ?? "").toLowerCase();
  if ((register === "frustrated" || register === "tired") && (a === "surface_evidence" || a === "deep_dive" || a === "propose_alternative")) {
    breakdown.emotional_register_fit = FIT_WEIGHTS.emotional_register_fit;
    violations.push({
      axis: "emotional_register_fit",
      sample: a,
      message: `chose '${a}' while emotional_register=${register}; lead with status + next concrete action`,
    });
  }

  // (4) decision_burden_fit — request approval inline when
  //     decision_style is direct_confirm OR delegate_when_low_risk
  //     piles burden the owner doesn't want.
  const decisionStyle = String(latent.decision_style ?? "").toLowerCase();
  if (decisionStyle === "direct_confirm" && a === "options_first") {
    breakdown.decision_burden_fit = FIT_WEIGHTS.decision_burden_fit;
    violations.push({
      axis: "decision_burden_fit",
      sample: a,
      message: "owner prefers direct_confirm; options_first piles unnecessary burden",
    });
  }
  if (decisionStyle === "delegate_when_low_risk" && a === "ask_clarification") {
    breakdown.decision_burden_fit = FIT_WEIGHTS.decision_burden_fit * 0.6;
    violations.push({
      axis: "decision_burden_fit",
      sample: a,
      message: "owner delegates low-risk decisions; asking adds friction unless the risk is real",
    });
  }

  // (5) skill_calibration_fit — render_technical when skill=novice in
  //     the domain leaves the owner stranded.
  const skill = latent.skill_calibration as Record<string, unknown> | undefined;
  if (skill && typeof skill === "object" && String(skill.estimated_skill ?? "").toLowerCase() === "novice"
      && (a === "render_technical" || a === "surface_evidence")) {
    breakdown.skill_calibration_fit = FIT_WEIGHTS.skill_calibration_fit;
    violations.push({
      axis: "skill_calibration_fit",
      sample: a,
      message: `chose '${a}' while skill_calibration=novice in '${String(skill.domain ?? "?")}'`,
    });
  }

  // (6) session_memory_fit — re-asking something the owner already
  //     answered (re-ask without referencing past answer) violates.
  //     Heuristic: working_memory_horizon=short + ask_clarification
  //     without observation_refs cited = friction signal.
  const memory = String(latent.working_memory_horizon ?? "").toLowerCase();
  if (memory === "short" && a === "ask_clarification" && (action.cited_artifact_ids ?? []).length === 0) {
    breakdown.session_memory_fit = FIT_WEIGHTS.session_memory_fit * 0.5;
    violations.push({
      axis: "session_memory_fit",
      sample: a,
      message: "owner has short working_memory_horizon; clarification without citing prior turn = re-asking same question",
    });
  }

  // (7) latent_goal_fit — if the action is unrelated to the larger
  //     goal AND the action_kind diverges (proposes_alternative without
  //     referencing the larger goal), residual goes up.
  const largerGoal = String(latent.latent_larger_goal ?? "");
  if (largerGoal.length > 0 && a === "propose_alternative"
      && !(action.rationale ?? "").toLowerCase().includes(largerGoal.toLowerCase())) {
    breakdown.latent_goal_fit = FIT_WEIGHTS.latent_goal_fit * 0.7;
    violations.push({
      axis: "latent_goal_fit",
      sample: a,
      message: `propose_alternative without referencing latent_larger_goal='${largerGoal}'`,
    });
  }

  // (8) Outcome signal — when the owner ALREADY reacted to the action,
  //     fold that into the residual directly.
  if (outcome?.observed_residual != null) {
    const r = Math.max(0, Math.min(1, outcome.observed_residual));
    if (r > 0) {
      breakdown.outcome_residual = (breakdown.outcome_residual ?? 0) + r * 0.5;
      violations.push({
        axis: "outcome_residual",
        message: `owner-observed outcome residual=${r.toFixed(2)} (${outcome.observed_outcome ?? "no signal"})`,
      });
    }
  }
  if (outcome?.observed_outcome) {
    const o = outcome.observed_outcome.toLowerCase();
    if (o.includes("corrected") || o.includes("overrode") || o.includes("declined")) {
      breakdown.outcome_residual = Math.max(breakdown.outcome_residual ?? 0, 0.30);
      violations.push({
        axis: "outcome_residual",
        sample: o,
        message: "owner correction/override/decline observed — strong negative signal on chosen action",
      });
    }
    if (o.includes("approved") || o.includes("confirmed") || o.includes("satisfaction")) {
      // Positive outcome subtracts a fixed credit; clamp at 0 below.
      breakdown.outcome_residual = Math.max(0, (breakdown.outcome_residual ?? 0) - 0.10);
    }
  }

  const residual = Math.max(0, Math.min(1, sumValues(breakdown)));
  return { residual, prediction_error: breakdown, violations };
};

const sumValues = (m: Record<string, number>): number => {
  let s = 0;
  for (const v of Object.values(m)) s += v;
  return s;
};

/** Threshold above which the substrate should treat the transition as
 *  a real prediction-error worth surfacing (mirrors closure_residual
 *  + rendering threshold of 0.3). */
export const OWNER_STATE_TRANSITION_RESIDUAL_THRESHOLD = 0.3;
