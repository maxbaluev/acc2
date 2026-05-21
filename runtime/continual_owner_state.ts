// Tier S0: continual owner-state evaluator.
// Estimates owner-profile state updates across sessions while preserving
// stable prior signals against catastrophic forgetting.

export type OwnerProfileState = {
  rendering_signals?: Record<string, unknown>;
  autonomy_signals?: Record<string, unknown>;
  control_signals?: Record<string, unknown>;
  risk_signals?: Record<string, unknown>;
  collaboration_signals?: Record<string, unknown>;
  goal_continuity_signals?: Record<string, unknown>;
  preferred_terms?: unknown;
  avoided_terms?: unknown;
  things_to_never_do?: unknown;
  [key: string]: unknown;
};

export type OwnerInteractionSignal = {
  kind?: string;
  text?: string;
  ts?: string;
  signals?: Record<string, unknown>;
};

export type ContinualOwnerStateInput = {
  prior_owner_profile?: OwnerProfileState;
  interaction_signals?: Record<string, unknown>;
  recent_interactions?: OwnerInteractionSignal[];
  candidate_updated_state?: OwnerProfileState;
};

export type ContinualOwnerStateResult = {
  residual: number;
  verdict: "stable" | "watch" | "forgetting";
  updated_owner_profile: OwnerProfileState;
  breakdown: Record<string, number>;
  reasons: string[];
};

const SIGNAL_MAP_KEYS = [
  "rendering_signals",
  "autonomy_signals",
  "control_signals",
  "risk_signals",
  "collaboration_signals",
  "goal_continuity_signals",
] as const;

const ARRAY_KEYS = ["preferred_terms", "avoided_terms", "things_to_never_do"] as const;

const clamp01 = (n: number): number => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));

const numberSignal = (value: unknown): number => {
  if (typeof value === "number") return clamp01(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (["high", "strong", "many", "blocked", "stale", "forgetting"].includes(lower)) return 1;
    if (["medium", "moderate", "some", "watch", "uncertain"].includes(lower)) return 0.5;
    if (["low", "none", "clear", "stable", "safe"].includes(lower)) return 0;
    return clamp01(Number(value));
  }
  return 0;
};

const signalMap = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : [];

const textOf = (value: unknown): string => {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
};

const addMax = (target: Record<string, number>, key: string, value: unknown): void => {
  const next = numberSignal(value);
  target[key] = Math.max(target[key] ?? 0, next);
};

const signalsFromInteraction = (input: ContinualOwnerStateInput): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(input.interaction_signals ?? {})) addMax(out, key, value);
  for (const interaction of input.recent_interactions ?? []) {
    for (const [key, value] of Object.entries(interaction.signals ?? {})) addMax(out, key, value);
    const text = textOf(interaction.text).toLowerCase();
    if (!text) continue;
    if (/\b(correction|wrong|regression|broken|do not|don't|never|stop)\b/.test(text)) addMax(out, "recent_correction", 1);
    if (/\b(ask|confirm|approval|before applying|manual review)\b/.test(text)) addMax(out, "owner_control_need", 1);
    if (/\b(frustrated|tired|overwhelmed|low attention)\b/.test(text)) addMax(out, "low_attention_budget", 1);
    if (/\b(prefer|preferred|use the term|avoid the term)\b/.test(text)) addMax(out, "preference_update", 1);
    if (/\b(works|approved|good|accepted|passing)\b/.test(text)) addMax(out, "positive_confirmation", 0.6);
  }
  return out;
};

const mergeSignalMap = (prior: Record<string, unknown>, fresh: Record<string, number>, keys: readonly string[]): Record<string, number> => {
  const merged: Record<string, number> = {};
  for (const [key, value] of Object.entries(prior)) merged[key] = numberSignal(value) * 0.98;
  for (const key of keys) merged[key] = Math.max(merged[key] ?? 0, fresh[key] ?? 0);
  return merged;
};

const stableKeyLoss = (prior: OwnerProfileState, candidate: OwnerProfileState | undefined): number => {
  if (!candidate) return 0;
  let stable = 0;
  let lost = 0;
  for (const mapKey of SIGNAL_MAP_KEYS) {
    const priorMap = signalMap(prior[mapKey]);
    const candidateMap = signalMap(candidate[mapKey]);
    for (const [key, value] of Object.entries(priorMap)) {
      if (numberSignal(value) < 0.4) continue;
      stable++;
      if (!(key in candidateMap)) lost++;
    }
  }
  return stable === 0 ? 0 : clamp01(lost / stable);
};

const stableArrayLoss = (prior: OwnerProfileState, candidate: OwnerProfileState | undefined): number => {
  if (!candidate) return 0;
  let stable = 0;
  let lost = 0;
  for (const key of ARRAY_KEYS) {
    const priorItems = stringArray(prior[key]).map((s) => s.toLowerCase());
    const candidateItems = new Set(stringArray(candidate[key]).map((s) => s.toLowerCase()));
    for (const item of priorItems) {
      stable++;
      if (!candidateItems.has(item)) lost++;
    }
  }
  return stable === 0 ? 0 : clamp01(lost / stable);
};

export const evaluateContinualOwnerState = (input: ContinualOwnerStateInput): ContinualOwnerStateResult => {
  const prior = input.prior_owner_profile ?? {};
  const fresh = signalsFromInteraction(input);
  const recentCount = input.recent_interactions?.length ?? 0;
  const interactionPressure = clamp01(Math.max(...Object.values(fresh), 0));

  const updated: OwnerProfileState = { ...prior };
  updated.control_signals = mergeSignalMap(signalMap(prior.control_signals), fresh, ["owner_control_need", "recent_correction"]);
  updated.risk_signals = mergeSignalMap(signalMap(prior.risk_signals), fresh, ["recent_correction"]);
  updated.rendering_signals = mergeSignalMap(signalMap(prior.rendering_signals), fresh, ["low_attention_budget", "preference_update", "positive_confirmation"]);
  updated.autonomy_signals = mergeSignalMap(signalMap(prior.autonomy_signals), fresh, ["owner_control_need"]);
  updated.collaboration_signals = mergeSignalMap(signalMap(prior.collaboration_signals), fresh, ["positive_confirmation"]);
  updated.goal_continuity_signals = mergeSignalMap(signalMap(prior.goal_continuity_signals), fresh, ["recent_correction", "preference_update"]);
  for (const key of ARRAY_KEYS) updated[key] = stringArray(prior[key]);

  const keyForgetting = stableKeyLoss(prior, input.candidate_updated_state);
  const arrayForgetting = stableArrayLoss(prior, input.candidate_updated_state);
  const forgetting = clamp01(Math.max(keyForgetting, arrayForgetting));
  const staleState = Object.keys(prior).length === 0 && recentCount > 0 ? 0.45 : 0;
  const noInteraction = recentCount === 0 && Object.keys(input.interaction_signals ?? {}).length === 0 ? 0.1 : 0;
  const residual = clamp01(Math.max(forgetting, staleState, noInteraction, interactionPressure > 0 ? 0.2 : 0));
  const verdict = residual >= 0.6 ? "forgetting" : residual >= 0.3 ? "watch" : "stable";
  const reasons = [
    `recent_interactions=${recentCount}`,
    `interaction_pressure=${interactionPressure.toFixed(3)}`,
    `key_forgetting=${keyForgetting.toFixed(3)}`,
    `array_forgetting=${arrayForgetting.toFixed(3)}`,
    staleState > 0 ? "fresh_interactions_have_no_prior_owner_profile" : "prior_owner_profile_present_or_not_needed",
  ];

  return {
    residual,
    verdict,
    updated_owner_profile: updated,
    breakdown: { interaction_pressure: interactionPressure, key_forgetting: keyForgetting, array_forgetting: arrayForgetting, stale_state: staleState, no_interaction: noInteraction },
    reasons,
  };
};
