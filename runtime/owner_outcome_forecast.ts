// Tier S0: owner outcome forecast evaluator.
// Predicts likely owner-observed outcome before an action ships so later
// owner_observed_outcome_recorded evidence can calibrate the predicate.

export type OwnerOutcomeForecastVerdict = "accept" | "reject" | "revise";

export type OwnerOutcomeForecastAction = {
  intent?: string;
  summary?: string;
  owner_visible_text?: string;
  route?: string;
  target_resources?: string[];
  reversible?: boolean;
  risk?: unknown;
  novelty?: unknown;
  [key: string]: unknown;
};

export type OwnerOutcomeForecastHistoryItem = {
  kind?: string;
  text?: string;
  signal?: string;
  verdict?: string;
  residual?: unknown;
  ts?: string;
};

export type OwnerOutcomeForecastInput = {
  proposed_action?: OwnerOutcomeForecastAction;
  owner_profile?: Record<string, unknown>;
  owner_history?: OwnerOutcomeForecastHistoryItem[];
  upstream_residuals?: Record<string, unknown>;
  candidate_predicted_verdict?: OwnerOutcomeForecastVerdict;
};

export type OwnerOutcomeForecastResult = {
  residual: number;
  predicted_owner_verdict: OwnerOutcomeForecastVerdict;
  verdict: "aligned" | "watch" | "misforecast";
  breakdown: Record<string, number>;
  reasons: string[];
};

const clamp01 = (n: number): number => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));

const numberSignal = (value: unknown): number => {
  if (typeof value === "number") return clamp01(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (["high", "strong", "many", "blocked", "reject", "failed", "broke"].includes(lower)) return 1;
    if (["medium", "moderate", "some", "watch", "revise", "partial"].includes(lower)) return 0.5;
    if (["low", "none", "clear", "safe", "accept", "worked"].includes(lower)) return 0;
    return clamp01(Number(value));
  }
  return 0;
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : [];

const textOf = (value: unknown): string => {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
};

const maxRecordSignal = (source: Record<string, unknown>, keys: readonly string[]): number => {
  let max = 0;
  for (const key of keys) max = Math.max(max, numberSignal(source[key]));
  return max;
};

const actionText = (action: OwnerOutcomeForecastAction): string => [
  action.intent,
  action.summary,
  action.owner_visible_text,
  ...(action.target_resources ?? []),
].map(textOf).join(" ").toLowerCase();

const maxUpstreamResidual = (upstream: Record<string, unknown>): number => {
  let max = 0;
  for (const [key, value] of Object.entries(upstream)) {
    if (key.endsWith("_residual") || key.includes("residual")) max = Math.max(max, numberSignal(value));
  }
  return max;
};

const historyPressures = (history: OwnerOutcomeForecastHistoryItem[]): { negative: number; revise: number; positive: number } => {
  let negative = 0;
  let revise = 0;
  let positive = 0;
  for (const item of history) {
    const text = [item.text, item.signal, item.verdict, item.kind].map(textOf).join(" ").toLowerCase();
    const residual = numberSignal(item.residual);
    if (/\b(broke|broken|failed|not what i meant|wrong|reject|rejected|regression|did not work|didn't work)\b/.test(text)) negative = Math.max(negative, 1, residual);
    else if (/\b(partial|closer|revise|revision|needs changes|want changes|adjust|watch)\b/.test(text)) revise = Math.max(revise, 0.7, residual);
    else if (/\b(worked|works|accepted|approved|looks good|success|fixed)\b/.test(text)) positive = Math.max(positive, 0.8, 1 - residual);
    else if (residual >= 0.75) negative = Math.max(negative, residual);
    else if (residual >= 0.35) revise = Math.max(revise, residual);
  }
  return { negative, revise, positive };
};

const hardConstraintPressure = (profile: Record<string, unknown>, proposedText: string): number => {
  const constraints = stringArray(profile.things_to_never_do).map((s) => s.toLowerCase());
  if (constraints.length === 0 || proposedText.length === 0) return 0;
  for (const constraint of constraints) {
    const tokens = constraint.match(/[a-z0-9]+/g) ?? [];
    const meaningful = tokens.filter((t) => t.length > 4);
    if (meaningful.length > 0 && meaningful.some((token) => proposedText.includes(token))) return 1;
  }
  return 0;
};

const targetRisk = (targets: readonly string[]): number =>
  targets.some((resource) => /^repo:(runtime|substrate|cli)\//.test(resource)) ? 0.35 : 0;

const mismatchResidual = (
  candidate: OwnerOutcomeForecastVerdict,
  predicted: OwnerOutcomeForecastVerdict,
  pressure: number,
): number => {
  if (candidate === predicted) return predicted === "accept" ? Math.min(0.25, pressure * 0.4) : Math.max(0.2, pressure * 0.35);
  if (candidate === "accept" && predicted === "reject") return Math.max(0.75, pressure);
  if (candidate === "accept" && predicted === "revise") return Math.max(0.6, pressure * 0.9);
  return Math.max(0.35, pressure * 0.7);
};

export const evaluateOwnerOutcomeForecast = (input: OwnerOutcomeForecastInput): OwnerOutcomeForecastResult => {
  const action = input.proposed_action ?? {};
  const profile = input.owner_profile ?? {};
  const targets = Array.isArray(action.target_resources) ? action.target_resources : [];
  const riskSignals = record(profile.risk_signals);
  const controlSignals = record(profile.control_signals);
  const autonomySignals = record(profile.autonomy_signals);
  const renderingSignals = record(profile.rendering_signals);
  const history = historyPressures(input.owner_history ?? []);
  const proposedText = actionText(action);

  const actionRisk = Math.max(numberSignal(action.risk), targetRisk(targets), maxRecordSignal(riskSignals, ["directive_risk", "runtime_change_risk", "irreversible_risk"]));
  const noveltyPressure = Math.max(numberSignal(action.novelty), proposedText.includes("new") ? 0.25 : 0);
  const controlPressure = Math.max(
    maxRecordSignal(controlSignals, ["owner_control_need", "manual_review", "recent_correction"]),
    maxRecordSignal(autonomySignals, ["owner_control_need", "manual_review_rate"]),
    numberSignal(profile.owner_control_need),
  );
  const renderingPressure = maxRecordSignal(renderingSignals, ["low_attention_budget", "preference_update"]);
  const upstreamPressure = maxUpstreamResidual(input.upstream_residuals ?? {});
  const hardConstraint = hardConstraintPressure(profile, proposedText);

  const pressure = clamp01(Math.max(
    hardConstraint,
    history.negative,
    history.revise,
    actionRisk,
    noveltyPressure,
    controlPressure,
    renderingPressure,
    upstreamPressure,
  ));

  let predicted: OwnerOutcomeForecastVerdict = "accept";
  if (hardConstraint >= 1 || history.negative >= 0.75) predicted = "reject";
  else if (history.revise >= 0.5 || controlPressure >= 0.65 || upstreamPressure >= 0.6 || actionRisk >= 0.6 || renderingPressure >= 0.7) predicted = "revise";

  const candidate = input.candidate_predicted_verdict ?? "accept";
  const residual = clamp01(mismatchResidual(candidate, predicted, pressure));
  const verdict = residual >= 0.6 ? "misforecast" : residual >= 0.3 ? "watch" : "aligned";
  const reasons = [
    "candidate_predicted_verdict=" + candidate,
    "predicted_owner_verdict=" + predicted,
    "action_risk=" + actionRisk.toFixed(3),
    "novelty_pressure=" + noveltyPressure.toFixed(3),
    "control_pressure=" + controlPressure.toFixed(3),
    "rendering_pressure=" + renderingPressure.toFixed(3),
    "upstream_pressure=" + upstreamPressure.toFixed(3),
    "recent_negative_outcome=" + history.negative.toFixed(3),
    "recent_revision_outcome=" + history.revise.toFixed(3),
    "recent_positive_outcome=" + history.positive.toFixed(3),
    hardConstraint > 0 ? "hard_owner_constraint_overlap" : "no_hard_owner_constraint_overlap",
  ];

  return {
    residual,
    predicted_owner_verdict: predicted,
    verdict,
    breakdown: {
      action_risk: actionRisk,
      novelty_pressure: noveltyPressure,
      control_pressure: controlPressure,
      rendering_pressure: renderingPressure,
      upstream_pressure: upstreamPressure,
      recent_negative_outcome: history.negative,
      recent_revision_outcome: history.revise,
      recent_positive_outcome: history.positive,
      hard_constraint_pressure: hardConstraint,
    },
    reasons,
  };
};
