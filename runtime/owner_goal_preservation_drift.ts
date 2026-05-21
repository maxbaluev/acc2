// Tier S0 floor: owner goal-preservation drift evaluator.
// Compares fresh owner evidence against accumulated compressed state and
// returns a residual in [0, 1]. High residual blocks autonomous commit.

export type OwnerGoalDriftInput = {
  fresh_owner_evidence: string[];
  accumulated_state: {
    owner_profile?: unknown;
    retrieved_knowledge?: string[];
    session_summaries?: string[];
  };
};

export type OwnerGoalDriftResult = {
  residual: number;
  verdict: "clean" | "stale" | "drift";
  breakdown: Record<string, number>;
  reasons: string[];
};

const CORRECTION_MARKERS = [
  "avoid",
  "never",
  "do not",
  "don't",
  "instead",
  "rather than",
  "correction",
  "prefer",
  "stop",
  "not ",
];

const clamp01 = (n: number): number => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));

const textOf = (value: unknown): string => {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
};

const tokens = (text: string): Set<string> => new Set(
  text
    .toLowerCase()
    .replace(/[^a-z0-9_ -]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3),
);

const markerPresent = (text: string): boolean => {
  const lower = text.toLowerCase();
  return CORRECTION_MARKERS.some((m) => lower.includes(m));
};

const jaccardDistance = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return a.size === b.size ? 0 : 1;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : 1 - intersection / union;
};

const contradictionResidual = (freshText: string, accumulatedText: string): number => {
  const lowerFresh = freshText.toLowerCase();
  const accumulated = tokens(accumulatedText);
  let hits = 0;
  for (const marker of ["avoid", "never", "do not", "don't", "stop"]) {
    const idx = lowerFresh.indexOf(marker);
    if (idx < 0) continue;
    const window = tokens(lowerFresh.slice(idx, idx + 96));
    for (const token of window) {
      if (accumulated.has(token)) hits++;
    }
  }
  return clamp01(hits / 4);
};

export const evaluateOwnerGoalPreservationDrift = (input: OwnerGoalDriftInput): OwnerGoalDriftResult => {
  const freshText = input.fresh_owner_evidence.map(textOf).join("\n").trim();
  const accumulatedText = [
    textOf(input.accumulated_state.owner_profile),
    ...(input.accumulated_state.retrieved_knowledge ?? []),
    ...(input.accumulated_state.session_summaries ?? []),
  ].join("\n").trim();

  if (!freshText) {
    return { residual: 0, verdict: "clean", breakdown: { fresh_evidence_absent: 0 }, reasons: ["no_fresh_owner_evidence"] };
  }
  if (!accumulatedText) {
    return { residual: 0.45, verdict: "stale", breakdown: { accumulated_state_absent: 0.45 }, reasons: ["fresh_owner_evidence_has_no_accumulated_state"] };
  }

  const correction = markerPresent(freshText) ? 1 : 0;
  const semanticDistance = jaccardDistance(tokens(freshText), tokens(accumulatedText));
  const contradiction = contradictionResidual(freshText, accumulatedText);
  const staleCompression = correction ? semanticDistance : Math.min(0.2, semanticDistance * 0.2);
  const residual = clamp01((0.55 * staleCompression) + (0.35 * contradiction) + (0.10 * correction));
  const verdict = residual >= 0.6 ? "drift" : residual >= 0.3 ? "stale" : "clean";
  const reasons = [
    correction ? "fresh_owner_evidence_contains_correction_marker" : "fresh_owner_evidence_is_not_correction_shaped",
    `semantic_distance=${semanticDistance.toFixed(3)}`,
    `contradiction=${contradiction.toFixed(3)}`,
  ];
  return {
    residual,
    verdict,
    breakdown: { correction_marker: correction, semantic_distance: semanticDistance, contradiction, stale_compression: staleCompression },
    reasons,
  };
};
