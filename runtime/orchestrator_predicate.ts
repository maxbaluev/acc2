// Tier S0: orchestrator predicate.
// Composes the live owner-alignment sub-predicate signal into one top-level
// orchestration verdict for the autonomous-apply decision.
//
// History (RLM-first clean break): db0788e collapsed the seven rule-based
// owner-alignment evaluators (owner_goal_preservation_drift, delegation_safety,
// metacognitive_owner_policy, continual_owner_state, owner_outcome_forecast,
// owner_rendering, ordered_theory_of_mind) into ONE unified owner_alignment
// gate and deleted their evaluator code. This predicate now evaluates the SAME
// owner_alignment boundary the apply gate actually projects (cli/apply.ts
// subPredicateResultsFromDecision), not the seven deleted boundaries. The
// blocking decision leans on the scored residual + breakdown; the verdict Set
// holds only the verdict the live owner_alignment predicate actually emits.

export type OrchestratorSubPredicateName = "owner_alignment";

export type OrchestratorSubPredicateResult = {
  name?: string;
  residual?: unknown;
  verdict?: string;
  reasons?: string[];
  breakdown?: Record<string, unknown>;
};

export type OrchestratorPredicateInput = {
  candidate_route?: string;
  proposed_action?: {
    intent?: string;
    summary?: string;
    target_resources?: string[];
    reversible?: boolean;
    risk?: unknown;
    novelty?: unknown;
    [key: string]: unknown;
  };
  sub_predicate_results?: Partial<Record<OrchestratorSubPredicateName, OrchestratorSubPredicateResult>> | OrchestratorSubPredicateResult[];
  candidate_orchestration?: {
    boundary_order?: string[];
    selected_boundaries?: string[];
    rationale?: string;
    [key: string]: unknown;
  };
};

export type OrchestratorPredicateResult = {
  residual: number;
  verdict: "aligned" | "watch" | "misaligned";
  recommended_route: "AUTO_APPLY" | "OWNER_GATE" | "NEEDS_BRAIN_RECYCLE";
  breakdown: Record<string, number>;
  reasons: string[];
};

const REQUIRED_BOUNDARIES: OrchestratorSubPredicateName[] = ["owner_alignment"];

// The unified owner_alignment predicate emits exactly two verdicts: "aligned"
// and "misaligned" (see cli/apply.ts evaluateOwnerAlignment). Only "misaligned"
// is blocking. The dead verdicts from the removed owner-vocabulary/rendering
// subsystems (violates_avoided_term, wrong_language, exposes_declined_concept,
// drift, unsafe, forgetting, misforecast, constraint_miss, order_mismatch) and
// the watch-band verdict names (stale, caution, revise, sparse) are gone —
// nothing live emits them, and the watch band is now derived from the residual
// score, not a fixed verdict name (RLM-first: residual + breakdown, not enums).
const BLOCKING_VERDICTS = new Set(["misaligned"]);

const clamp01 = (n: number): number => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));

const numberSignal = (value: unknown): number => {
  if (typeof value === "number") return clamp01(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (["high", "strong", "blocked", "unsafe", "reject", "misaligned"].includes(lower)) return 1;
    if (["medium", "moderate", "some", "watch", "revise", "partial"].includes(lower)) return 0.5;
    if (["low", "none", "clear", "safe", "aligned", "accept"].includes(lower)) return 0;
    return clamp01(Number(value));
  }
  return 0;
};

const stringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  if (typeof value === "string" && value.trim().length > 0) return [value];
  return [];
};

const normalizeName = (name: string | undefined): OrchestratorSubPredicateName | null => {
  if (!name) return null;
  const normalized = name.replace(/_predicate$/, "") as OrchestratorSubPredicateName;
  return (REQUIRED_BOUNDARIES as string[]).includes(normalized) ? normalized : null;
};

const resultMap = (input: OrchestratorPredicateInput): Partial<Record<OrchestratorSubPredicateName, OrchestratorSubPredicateResult>> => {
  const results = input.sub_predicate_results;
  if (!results) return {};
  if (Array.isArray(results)) {
    const out: Partial<Record<OrchestratorSubPredicateName, OrchestratorSubPredicateResult>> = {};
    for (const result of results) {
      const name = normalizeName(result.name);
      if (name) out[name] = result;
    }
    return out;
  }
  return results;
};

const boundaryCoverageGap = (results: Partial<Record<OrchestratorSubPredicateName, OrchestratorSubPredicateResult>>): number => {
  const present = REQUIRED_BOUNDARIES.filter((name) => results[name]).length;
  if (present === 0) return 0.2;
  return clamp01((REQUIRED_BOUNDARIES.length - present) / REQUIRED_BOUNDARIES.length);
};

const orderGap = (order: string[] | undefined): number => {
  if (!order || order.length === 0) return 0;
  const normalized = order.map((name) => normalizeName(name) ?? name.replace(/_predicate$/, ""));
  let last = -1;
  for (const required of REQUIRED_BOUNDARIES) {
    const idx = normalized.indexOf(required);
    if (idx < 0) continue;
    if (idx < last) return 1;
    last = idx;
  }
  return 0;
};

const selectedGap = (selected: string[] | undefined, results: Partial<Record<OrchestratorSubPredicateName, OrchestratorSubPredicateResult>>): number => {
  if (!selected || selected.length === 0) return 0;
  const normalized = new Set(selected.map((name) => normalizeName(name) ?? name.replace(/_predicate$/, "")));
  const omittedBlocking = REQUIRED_BOUNDARIES.some((name) => {
    const result = results[name];
    const residual = numberSignal(result?.residual);
    const verdict = result?.verdict ?? "";
    return !normalized.has(name) && (residual >= 0.6 || BLOCKING_VERDICTS.has(verdict));
  });
  return omittedBlocking ? 1 : 0;
};

export const evaluateOrchestratorPredicate = (input: OrchestratorPredicateInput): OrchestratorPredicateResult => {
  const results = resultMap(input);
  const residuals = REQUIRED_BOUNDARIES.map((name) => numberSignal(results[name]?.residual));
  const maxResidual = Math.max(...residuals, 0);
  const meanResidual = residuals.reduce((sum, n) => sum + n, 0) / REQUIRED_BOUNDARIES.length;
  const blockingVerdict = REQUIRED_BOUNDARIES.some((name) => BLOCKING_VERDICTS.has(results[name]?.verdict ?? "")) ? 1 : 0;
  const coverageGap = boundaryCoverageGap(results);
  const sequencingGap = orderGap(input.candidate_orchestration?.boundary_order);
  const omittedBlockingBoundary = selectedGap(input.candidate_orchestration?.selected_boundaries, results);
  const actionRisk = Math.max(numberSignal(input.proposed_action?.risk), numberSignal(input.proposed_action?.novelty));
  const routePressure = input.candidate_route === "AUTO_APPLY" ? actionRisk * 0.25 : 0;
  // RLM-first: the blocking decision leans on the scored residual + breakdown.
  // A "misaligned" verdict forces residual to 1 (hard owner-constraint/threshold
  // breach), but the watch band is no longer a verdict-name signal — it is the
  // residual score itself (the [0.3, 0.6) band below). owner_alignment's own
  // residual already captures threshold-exceed and target-surface risk.
  const residual = clamp01(Math.max(
    blockingVerdict,
    maxResidual,
    sequencingGap,
    omittedBlockingBoundary,
    meanResidual * 0.7,
    coverageGap * 0.4,
    routePressure,
  ));
  const verdict = residual >= 0.6 ? "misaligned" : residual >= 0.3 ? "watch" : "aligned";
  const recommended_route = verdict === "misaligned" ? "NEEDS_BRAIN_RECYCLE" : verdict === "watch" ? "OWNER_GATE" : "AUTO_APPLY";
  const missing = REQUIRED_BOUNDARIES.filter((name) => !results[name]);
  const blocking = REQUIRED_BOUNDARIES.filter((name) => {
    const result = results[name];
    return numberSignal(result?.residual) >= 0.6 || BLOCKING_VERDICTS.has(result?.verdict ?? "");
  });
  const reasons = [
    "candidate_route=" + (input.candidate_route ?? "AUTO_APPLY"),
    "max_sub_predicate_residual=" + maxResidual.toFixed(3),
    "mean_sub_predicate_residual=" + meanResidual.toFixed(3),
    "missing_boundaries=" + missing.join(","),
    "blocking_boundaries=" + blocking.join(","),
    "sequencing_gap=" + sequencingGap.toFixed(3),
    "omitted_blocking_boundary=" + omittedBlockingBoundary.toFixed(3),
  ];
  return {
    residual,
    verdict,
    recommended_route,
    breakdown: {
      max_sub_predicate_residual: maxResidual,
      mean_sub_predicate_residual: meanResidual,
      blocking_verdict: blockingVerdict,
      coverage_gap: coverageGap,
      sequencing_gap: sequencingGap,
      omitted_blocking_boundary: omittedBlockingBoundary,
      action_risk: actionRisk,
      route_pressure: routePressure,
      selected_boundary_count: stringArray(input.candidate_orchestration?.selected_boundaries).length,
    },
    reasons,
  };
};
