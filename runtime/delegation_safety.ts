// Tier S0: delegation safety evaluator.
// Scores whether an autonomous commit is safe, or whether the task should
// ask the owner, route to Claude inline, route to brain, or defer.

export type DelegationLane = "autonomous_commit" | "ask_owner" | "claude_inline" | "opencode_brain" | "defer";

export type DelegationSafetyInput = {
  candidate_lane?: DelegationLane;
  task?: {
    risk?: unknown;
    novelty?: unknown;
    reversible?: unknown;
    target_resources?: string[];
    recent_failures?: string[];
  };
  owner_control_signals?: Record<string, unknown>;
};

export type DelegationSafetyResult = {
  residual: number;
  recommended_lane: DelegationLane;
  verdict: "safe" | "caution" | "unsafe";
  breakdown: Record<string, number>;
  reasons: string[];
};

const clamp01 = (n: number): number => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));

const numberSignal = (value: unknown): number => {
  if (typeof value === "number") return clamp01(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (["high", "unsafe", "irreversible", "novel"].includes(lower)) return 1;
    if (["medium", "moderate", "caution"].includes(lower)) return 0.5;
    if (["low", "safe", "routine", "reversible"].includes(lower)) return 0;
    return clamp01(Number(value));
  }
  return 0;
};

const maxRecordSignal = (record: Record<string, unknown> | undefined): number => {
  if (!record) return 0;
  let max = 0;
  for (const value of Object.values(record)) max = Math.max(max, numberSignal(value));
  return max;
};

const laneMismatchResidual = (candidate: DelegationLane, recommended: DelegationLane, pressure: number): number => {
  if (candidate === recommended) return pressure < 0.3 ? pressure * 0.3 : 0.2;
  if (candidate === "autonomous_commit") return Math.max(0.35, pressure);
  return Math.max(0.15, pressure * 0.5);
};

export const evaluateDelegationSafety = (input: DelegationSafetyInput): DelegationSafetyResult => {
  const candidate = input.candidate_lane ?? "autonomous_commit";
  const task = input.task ?? {};
  const ownerControl = maxRecordSignal(input.owner_control_signals);
  const risk = numberSignal(task.risk);
  const novelty = numberSignal(task.novelty);
  const irreversible = task.reversible === false ? 1 : 0;
  const failurePressure = clamp01((task.recent_failures?.length ?? 0) / 3);
  const runtimeSurface = (task.target_resources ?? []).some((r) => /^repo:(runtime|substrate|cli)\//.test(r)) ? 0.25 : 0;
  const pressure = clamp01(Math.max(ownerControl, risk, novelty * 0.9, irreversible, failurePressure, runtimeSurface));

  let recommended: DelegationLane = "autonomous_commit";
  if (failurePressure >= 0.75) recommended = "defer";
  else if (ownerControl >= 0.6 || irreversible >= 1 || risk >= 0.75) recommended = "ask_owner";
  else if (novelty >= 0.65) recommended = "opencode_brain";
  else if (risk >= 0.35 || runtimeSurface > 0) recommended = "claude_inline";

  const residual = clamp01(laneMismatchResidual(candidate, recommended, pressure));
  const verdict = residual >= 0.6 ? "unsafe" : residual >= 0.3 ? "caution" : "safe";
  const reasons = [
    "candidate_lane=" + candidate,
    "recommended_lane=" + recommended,
    "owner_control=" + ownerControl.toFixed(3),
    "risk=" + risk.toFixed(3),
    "novelty=" + novelty.toFixed(3),
    "irreversible=" + irreversible.toFixed(3),
    "failure_pressure=" + failurePressure.toFixed(3),
  ];

  return {
    residual,
    recommended_lane: recommended,
    verdict,
    breakdown: { owner_control: ownerControl, risk, novelty, irreversible, failure_pressure: failurePressure, runtime_surface: runtimeSurface },
    reasons,
  };
};
