// Tier S0: metacognitive owner-policy evaluator.
// Scores whether the owner-interaction policy should learn, ask, defer, or
// compress from per-session and cross-session owner-interaction signals.

export type MetacognitiveOwnerPolicyAction = "learn" | "ask" | "defer" | "compress";

export type MetacognitiveOwnerPolicyInput = {
  candidate_policy_action?: MetacognitiveOwnerPolicyAction;
  session_signals?: Record<string, unknown>;
  cross_session_signals?: Record<string, unknown>;
  owner_interaction?: {
    recent_corrections?: string[];
    recent_questions?: string[];
    recent_declines?: string[];
    recent_satisfaction?: string[];
    unresolved_decisions?: string[];
  };
};

export type MetacognitiveOwnerPolicyResult = {
  residual: number;
  recommended_policy_action: MetacognitiveOwnerPolicyAction;
  verdict: "aligned" | "watch" | "misaligned";
  breakdown: Record<string, number>;
  reasons: string[];
};

const clamp01 = (n: number): number => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));

const numberSignal = (value: unknown): number => {
  if (typeof value === "number") return clamp01(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (["high", "strong", "many", "blocked", "stale", "defer", "ask"].includes(lower)) return 1;
    if (["medium", "moderate", "some", "watch", "learn"].includes(lower)) return 0.5;
    if (["low", "none", "clear", "safe", "compress"].includes(lower)) return 0;
    return clamp01(Number(value));
  }
  return 0;
};

const maxRecordSignal = (record: Record<string, unknown> | undefined, keys: readonly string[]): number => {
  if (!record) return 0;
  let max = 0;
  for (const key of keys) max = Math.max(max, numberSignal(record[key]));
  return max;
};

const textPressure = (items: string[] | undefined, denominator: number): number => clamp01((items?.filter((s) => s.trim().length > 0).length ?? 0) / denominator);

const actionMismatchResidual = (
  candidate: MetacognitiveOwnerPolicyAction,
  recommended: MetacognitiveOwnerPolicyAction,
  pressure: number,
): number => {
  if (candidate === recommended) return pressure < 0.3 ? pressure * 0.3 : 0.2;
  if (candidate === "compress" && (recommended === "ask" || recommended === "defer")) return Math.max(0.6, pressure);
  if (candidate === "learn" && recommended === "ask") return Math.max(0.35, pressure * 0.8);
  return Math.max(0.2, pressure * 0.6);
};

export const evaluateMetacognitiveOwnerPolicy = (input: MetacognitiveOwnerPolicyInput): MetacognitiveOwnerPolicyResult => {
  const candidate = input.candidate_policy_action ?? "compress";
  const session = input.session_signals ?? {};
  const cross = input.cross_session_signals ?? {};
  const interaction = input.owner_interaction ?? {};

  const correctionPressure = Math.max(
    textPressure(interaction.recent_corrections, 2),
    maxRecordSignal(session, ["recent_correction_count", "manual_override_count", "owner_rephrased", "policy_miss"]),
  );
  const ambiguityPressure = Math.max(
    textPressure(interaction.recent_questions, 3),
    maxRecordSignal(session, ["task_ambiguity", "comprehension_gap", "uncertainty", "clarification_loop_count"]),
  );
  const controlPressure = Math.max(
    textPressure(interaction.unresolved_decisions, 2),
    maxRecordSignal(session, ["owner_control_need", "recent_control_language", "owner_gate_required"]),
    maxRecordSignal(cross, ["profile_control_signal", "manual_review_rate"]),
  );
  const deferPressure = Math.max(
    textPressure(interaction.recent_declines, 2),
    maxRecordSignal(session, ["blocked", "active_failures", "recent_failures", "irreversible_risk"]),
    maxRecordSignal(cross, ["ignored_rate", "override_rate", "policy_regression"]),
  );
  const compressionPressure = Math.max(
    maxRecordSignal(session, ["context_bloat", "verbosity_pressure", "repeated_evidence", "low_attention_budget"]),
    maxRecordSignal(cross, ["stable_preference", "satisfaction_rate", "low_policy_drift"]),
    textPressure(interaction.recent_satisfaction, 3),
  );
  const learningPressure = Math.max(
    correctionPressure * 0.8,
    maxRecordSignal(session, ["new_preference", "owner_feedback", "rendering_feedback", "prediction_error"]),
    maxRecordSignal(cross, ["uncalibrated_policy", "sparse_profile", "policy_uncertainty"]),
  );

  let recommended: MetacognitiveOwnerPolicyAction = "compress";
  if (deferPressure >= 0.75) recommended = "defer";
  else if (correctionPressure >= 0.6 || controlPressure >= 0.6 || ambiguityPressure >= 0.7) recommended = "ask";
  else if (learningPressure >= 0.35) recommended = "learn";
  else if (compressionPressure >= 0.35) recommended = "compress";

  const pressure = clamp01(Math.max(correctionPressure, ambiguityPressure, controlPressure, deferPressure, compressionPressure * 0.6, learningPressure));
  const residual = clamp01(actionMismatchResidual(candidate, recommended, pressure));
  const verdict = residual >= 0.6 ? "misaligned" : residual >= 0.3 ? "watch" : "aligned";
  const reasons = [
    "candidate_policy_action=" + candidate,
    "recommended_policy_action=" + recommended,
    "correction_pressure=" + correctionPressure.toFixed(3),
    "ambiguity_pressure=" + ambiguityPressure.toFixed(3),
    "control_pressure=" + controlPressure.toFixed(3),
    "defer_pressure=" + deferPressure.toFixed(3),
    "compression_pressure=" + compressionPressure.toFixed(3),
    "learning_pressure=" + learningPressure.toFixed(3),
  ];

  return {
    residual,
    recommended_policy_action: recommended,
    verdict,
    breakdown: {
      correction_pressure: correctionPressure,
      ambiguity_pressure: ambiguityPressure,
      control_pressure: controlPressure,
      defer_pressure: deferPressure,
      compression_pressure: compressionPressure,
      learning_pressure: learningPressure,
    },
    reasons,
  };
};
