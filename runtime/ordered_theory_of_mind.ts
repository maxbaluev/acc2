// Tier S0: ordered theory-of-mind evaluator.
// Estimates nested owner beliefs at explicit ToM order before routing or
// owner-visible rendering decisions are allowed to auto-apply.

export type OrderedTheoryOfMindVerdict = "aligned" | "sparse" | "order_mismatch" | "constraint_miss";

export type OrderedTheoryOfMindHistoryItem = {
  kind?: string;
  text?: string;
  signal?: string;
  ts?: string;
  payload?: unknown;
};

export type OrderedTheoryOfMindAction = {
  intent?: string;
  summary?: string;
  owner_visible_text?: string;
  route?: string;
  target_resources?: string[];
  [key: string]: unknown;
};

export type NestedBeliefEstimate = {
  depth: number;
  owner_believes: string[];
  owner_believes_system_believes: string[];
  owner_wants_system_to_infer: string[];
  constraints: string[];
  uncertainty: number;
};

export type OrderedTheoryOfMindInput = {
  owner_profile?: Record<string, unknown>;
  interaction_history?: OrderedTheoryOfMindHistoryItem[];
  owner_state_belief?: Record<string, unknown>;
  proposed_action?: OrderedTheoryOfMindAction;
  candidate_nested_belief?: Partial<NestedBeliefEstimate>;
  upstream_residuals?: Record<string, unknown>;
};

export type OrderedTheoryOfMindResult = {
  residual: number;
  verdict: OrderedTheoryOfMindVerdict;
  nested_belief_estimate: NestedBeliefEstimate;
  breakdown: Record<string, number>;
  reasons: string[];
};

const clamp01 = (n: number): number => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const textOf = (value: unknown): string => {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
};

const numberSignal = (value: unknown): number => {
  if (typeof value === "number") return clamp01(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (["high", "strong", "many", "blocked", "wrong", "mismatch", "uncertain"].includes(lower)) return 1;
    if (["medium", "moderate", "some", "watch", "partial"].includes(lower)) return 0.5;
    if (["low", "none", "clear", "safe", "aligned"].includes(lower)) return 0;
    return clamp01(Number(value));
  }
  return 0;
};

const stringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  if (typeof value === "string" && value.trim().length > 0) return [value];
  if (value && typeof value === "object") return Object.keys(value as Record<string, unknown>).filter((key) => key.trim().length > 0);
  return [];
};

const unique = (items: readonly string[]): string[] => [...new Set(items.map((s) => s.trim()).filter(Boolean))];

const historyText = (history: readonly OrderedTheoryOfMindHistoryItem[]): string =>
  history.map((item) => [item.text, item.signal, item.kind, textOf(item.payload)].map(textOf).join(" ")).join("\n");

const profileText = (profile: Record<string, unknown>): string => [
  ...stringArray(profile.preferred_terms),
  ...stringArray(profile.avoided_terms),
  ...stringArray(profile.things_to_never_do),
  ...stringArray(profile.understood_concepts),
  ...stringArray(profile.declined_concepts),
  textOf(profile.rendering_signals),
  textOf(profile.control_signals),
  textOf(profile.goal_continuity_signals),
].join("\n");

const actionText = (action: OrderedTheoryOfMindAction): string => [
  action.intent,
  action.summary,
  action.owner_visible_text,
  action.route,
  ...(action.target_resources ?? []),
].map(textOf).join(" ").toLowerCase();

const extractSentences = (text: string, patterns: readonly RegExp[], fallback: readonly string[] = []): string[] => {
  const sentences = text.split(/[\n.!?]+/).map((s) => s.trim()).filter(Boolean);
  const hits = sentences.filter((sentence) => patterns.some((pattern) => pattern.test(sentence.toLowerCase())));
  return unique(hits.length > 0 ? hits : fallback);
};

const estimateDepth = (estimate: NestedBeliefEstimate): number => {
  if (estimate.owner_wants_system_to_infer.length > 0) return 3;
  if (estimate.owner_believes_system_believes.length > 0) return 2;
  if (estimate.owner_believes.length > 0 || estimate.constraints.length > 0) return 1;
  return 0;
};

const maxUpstreamResidual = (upstream: Record<string, unknown>): number => {
  let max = 0;
  for (const [key, value] of Object.entries(upstream)) {
    if (key.includes("residual")) max = Math.max(max, numberSignal(value));
  }
  return max;
};

const candidateCoverageGap = (candidate: Partial<NestedBeliefEstimate> | undefined, requiredDepth: number): number => {
  if (!candidate || Object.keys(candidate).length === 0) return requiredDepth >= 2 ? 0.35 : 0;
  const candidateDepth = typeof candidate.depth === "number" ? candidate.depth : estimateDepth({
    depth: 0,
    owner_believes: stringArray(candidate.owner_believes),
    owner_believes_system_believes: stringArray(candidate.owner_believes_system_believes),
    owner_wants_system_to_infer: stringArray(candidate.owner_wants_system_to_infer),
    constraints: stringArray(candidate.constraints),
    uncertainty: numberSignal(candidate.uncertainty),
  });
  return candidateDepth >= requiredDepth ? 0 : clamp01((requiredDepth - candidateDepth) / 3);
};

const hardConstraintPressure = (profile: Record<string, unknown>, proposedText: string): number => {
  const constraints = stringArray(profile.things_to_never_do).map((s) => s.toLowerCase());
  if (constraints.length === 0 || proposedText.length === 0) return 0;
  for (const constraint of constraints) {
    const tokens = constraint.match(/[a-z0-9]+/g)?.filter((token) => token.length > 4) ?? [];
    if (tokens.length > 0 && tokens.some((token) => proposedText.includes(token))) return 1;
  }
  return 0;
};

export const evaluateOrderedTheoryOfMind = (input: OrderedTheoryOfMindInput): OrderedTheoryOfMindResult => {
  const profile = input.owner_profile ?? {};
  const history = input.interaction_history ?? [];
  const belief = input.owner_state_belief ?? {};
  const proposedAction = input.proposed_action ?? {};
  const combined = [profileText(profile), historyText(history), textOf(belief)].join("\n");
  const lower = combined.toLowerCase();

  const ownerBelieves = extractSentences(combined, [
    /\b(prefer|want|need|goal|believe|expect|avoid|never|do not|don't)\b/,
  ], [...stringArray(profile.preferred_terms), ...stringArray(profile.avoided_terms)]);
  const ownerBelievesSystemBelieves = extractSentences(combined, [
    /\b(you think|you believe|system thinks|substrate thinks|assuming|assume|misunderstood|what you think)\b/,
  ]);
  const ownerWantsSystemToInfer = extractSentences(combined, [
    /\b(infer|understand|recognize|lead with|what i mean|take from this|remember that)\b/,
  ]);
  const constraints = unique([
    ...stringArray(profile.things_to_never_do),
    ...extractSentences(combined, [/\b(never|do not|don't|must not|avoid|refuse)\b/]),
  ]);

  const baseUncertainty = Math.max(
    numberSignal(belief.uncertainty),
    history.length === 0 && lower.trim().length === 0 ? 0.35 : 0,
    history.length > 0 && ownerBelieves.length === 0 ? 0.25 : 0,
  );
  const nestedBeliefEstimate: NestedBeliefEstimate = {
    depth: 0,
    owner_believes: ownerBelieves,
    owner_believes_system_believes: ownerBelievesSystemBelieves,
    owner_wants_system_to_infer: ownerWantsSystemToInfer,
    constraints,
    uncertainty: clamp01(baseUncertainty),
  };
  nestedBeliefEstimate.depth = estimateDepth(nestedBeliefEstimate);

  const proposedText = actionText(proposedAction);
  const hardConstraint = hardConstraintPressure(profile, proposedText);
  const requiredDepth = lower.includes("you think") || lower.includes("infer") || lower.includes("understand") || lower.includes("what i mean") ? 2 : Math.min(1, nestedBeliefEstimate.depth);
  const orderCoverageGap = requiredDepth === 0 ? 0 : nestedBeliefEstimate.depth >= requiredDepth ? 0 : clamp01((requiredDepth - nestedBeliefEstimate.depth) / 3);
  const candidateGap = candidateCoverageGap(input.candidate_nested_belief, requiredDepth);
  const upstreamPressure = maxUpstreamResidual(input.upstream_residuals ?? {});
  const sparseEvidence = history.length === 0 && Object.keys(profile).length === 0 && Object.keys(belief).length === 0 ? 0.1 : 0;
  const residual = clamp01(Math.max(
    hardConstraint,
    orderCoverageGap,
    candidateGap,
    upstreamPressure >= 0.6 ? 0.4 : upstreamPressure * 0.25,
    sparseEvidence,
    nestedBeliefEstimate.uncertainty * 0.4,
  ));
  const verdict: OrderedTheoryOfMindVerdict = hardConstraint >= 1
    ? "constraint_miss"
    : residual >= 0.6 || orderCoverageGap >= 0.6 || candidateGap >= 0.6
      ? "order_mismatch"
      : sparseEvidence > 0 || nestedBeliefEstimate.uncertainty >= 0.6
        ? "sparse"
        : "aligned";

  const reasons = [
    `belief_depth=${nestedBeliefEstimate.depth}`,
    `required_depth=${requiredDepth}`,
    `owner_beliefs=${ownerBelieves.length}`,
    `owner_believes_system_believes=${ownerBelievesSystemBelieves.length}`,
    `owner_wants_system_to_infer=${ownerWantsSystemToInfer.length}`,
    `constraints=${constraints.length}`,
    `candidate_gap=${candidateGap.toFixed(3)}`,
    `order_coverage_gap=${orderCoverageGap.toFixed(3)}`,
    `hard_constraint=${hardConstraint.toFixed(3)}`,
    `upstream_pressure=${upstreamPressure.toFixed(3)}`,
  ];

  return {
    residual,
    verdict,
    nested_belief_estimate: nestedBeliefEstimate,
    breakdown: {
      required_depth: requiredDepth,
      belief_depth: nestedBeliefEstimate.depth,
      order_coverage_gap: orderCoverageGap,
      candidate_gap: candidateGap,
      hard_constraint_pressure: hardConstraint,
      upstream_pressure: upstreamPressure,
      sparse_evidence: sparseEvidence,
      uncertainty: nestedBeliefEstimate.uncertainty,
    },
    reasons,
  };
};
