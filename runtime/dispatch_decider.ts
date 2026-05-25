// acc2 dispatch decider — scored routing predicate (Architecture.md).
//
// Three lanes:
//   1. substrate_replay  — `recipes_view` matches by embedding × shape with
//      confidence ≥ RECIPE_REPLAY_THRESHOLD. No LLM call. Phase J wires the
//      recipe view; Phase D never returns this lane because no recipes
//      have been extracted yet.
//   2. claude_inline     — every normalized target_resource on the task
//      matches at least one scheme-aware knowledge entry tagged
//      `low_risk_inline_pattern` with score ≥ 0.7 AND confidence ≥ 0.6.
//      Phase D never returns this lane because no low-risk patterns have
//      been promoted yet.
//   3. opencode_brain    — default. Strategic work, DAG decomposition,
//      code-artifact authoring. Phase D's MVP fixture always hits this
//      lane (and that's correct — the brain designs the bun grep + verifier).
//
// The predicate is testable: even without recipes or inline patterns wired,
// the function must return `opencode_brain` cleanly with `reason = 'no_recipe_no_inline_match'`.

import type { Database } from "bun:sqlite";
import type { TaskNode } from "./task_topology";
import { readCurrentMode } from "./crisis_mode";
import { blockersOf } from "./interference";
import { findRecipeMatch as findRealRecipeMatch } from "./recipe_replay";
import { lowRiskInlinePatterns } from "../substrate/views";
import { parseResourceRefs, resourceMatchesPattern, type ResourceRef } from "./resource_uri";
import { betaMean as canonicalBetaMean, betaEvidenceConfidence } from "./posterior";
import { goalShape as computeGoalShape } from "./goal_shape";
import { buildRankingContext, rankStrategies, type RankedStrategy } from "./dispatch_strategy_ranker";

/** Default Tier-0 recipe-replay confidence threshold (§15). Recipes seed at
 *  0.5 and accumulate via updateRecipeConfidence; SEVEN successful replays
 *  push a recipe to 0.85 (capped at 0.95) and admit it to the Tier-0 lane.
 *  Pre-fix this was 0.6 — combined with the loose goal_shape match in
 *  recipe_replay.ts:findRecipeMatch, fresh recipes (confidence 0.5+0.05·k)
 *  matched almost anything after a single success, replaying the wrong
 *  trajectory against unrelated directives. 0.85 forces real evidence of
 *  reusability. Crisis-mode lowers to 0.7 via
 *  `CRISIS_MODE.recipe_confidence_threshold`. */
export const RECIPE_REPLAY_THRESHOLD = 0.85;
export const INLINE_PATTERN_SCORE_THRESHOLD = 0.7;
export const INLINE_PATTERN_CONFIDENCE_THRESHOLD = 0.6;

export type DispatchRouteScores = Record<string, number>;

export type DispatchDecisionEvidence = {
  /** Open-ended axis vector used to score the route choice. These keys are
   *  learned/reweighted from verifier and knowledge outcomes; consumers must
   *  treat the record as extensible, not a closed enum. */
  routing_axes: Record<string, number>;
  route_scores: DispatchRouteScores;
  verifier_evidence: Record<string, number>;
  /** Shadow ranking of dispatch_strategy_v1 artifacts (2026-05-17 brain
   *  design 48SN4XF3WN4KBBCHHCANDRDQRW). Populated by
   *  dispatch_strategy_ranker — observational only, does NOT change the
   *  selected route. The closure_audited consumer credits the top
   *  strategy via its posterior_alpha/beta. When the strategy registry
   *  is empty or the ranker errors out, this is an empty array (no
   *  behavioral change). */
  strategy_shadow_ranks?: RankedStrategy[];
};

type DispatchDecisionBase = { reason: string } & DispatchDecisionEvidence;

export type DispatchDecision =
  | ({ route: "substrate_replay"; recipe_id: string } & DispatchDecisionBase)
  | ({ route: "claude_inline"; cited_artifact_ids: string[] } & DispatchDecisionBase)
  | ({ route: "claude_agent"; job_intent: string; target_files: string[]; acceptance_predicate: Record<string, unknown> } & DispatchDecisionBase)
  | ({ route: "opencode_brain"; predicted_complexity: "low" | "mid" | "high" } & DispatchDecisionBase)
  | ({ route: "deferred_blocked"; blockers: string[] } & DispatchDecisionBase);

type DispatchRoute = DispatchDecision["route"];

type RecipeMatch = { id: string; confidence: number };

const safeJson = (raw: string | null | undefined): Record<string, unknown> => {
  try {
    return JSON.parse(raw ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
};

const readDirectivePayload = (db: Database, directiveId: string): Record<string, unknown> => {
  const row = db
    .query("SELECT payload FROM events WHERE kind = 'directive_opened' AND directive_id = ? ORDER BY ts DESC, rowid DESC LIMIT 1")
    .get(directiveId) as { payload: string } | null;
  return safeJson(row?.payload);
};

/** Collect the task's declared target resources (universal lane). Both
 *  modern `target_resources` and legacy `target_files` (normalized to the
 *  `repo:` scheme) contribute structural blast-radius evidence for the
 *  routing-axis vector. This is a structural inventory, NOT a semantic
 *  intent classifier — there is no regex verb/keyword judgment here. */
const taskTargetResources = (task: TaskNode): string[] => {
  const t = task as TaskNode & { target_resources?: string[]; target_files?: string[] };
  const out: string[] = [];
  if (Array.isArray(t.target_resources)) out.push(...t.target_resources.filter((x): x is string => typeof x === "string"));
  if (Array.isArray(t.target_files)) out.push(...t.target_files.filter((x): x is string => typeof x === "string").map((x) => `repo:${x}`));
  return Array.from(new Set(out));
};

/** Semantic-DAG signals extracted from owner free-text. Per brain lessons
 *  VZE6Q5PS / EEEF091H / FX6AT1TQ (directive SZG5PQ01A51HX5RNFTS6BG0RX0,
 *  2026-05-16): owner free-text needs DAG decomposition when text signals
 *  multiple independently verifiable deliverables, explicit breadth,
 *  cross-surface changes, evidence/citation demands, or residual-gated
 *  closure. These signals feed `decomposition_value` directly — they do
 *  NOT add new axis keys (REUSE-first applied to ourselves: extending the
 *  existing routing_axes.decomposition_value calculation, not the axis
 *  vocabulary). */
export type SemanticDagSignals = {
  independent_deliverable_count: number;
  gate_count: number;
  evidence_modality_count: number;
  one_shot_answer_fit: number; // 0..1; higher = better fits one-shot answer
  raw_signals: Record<string, number>;
};

export const extractSemanticDagSignals = (text: string): SemanticDagSignals => {
  if (!text || typeof text !== "string") {
    return { independent_deliverable_count: 0, gate_count: 0, evidence_modality_count: 0, one_shot_answer_fit: 1, raw_signals: {} };
  }
  // Structural marker counts — NOT semantic-meaning interpretation. The
  // markers ARE the structural language. The brain interprets meaning;
  // this scorer counts markers.
  const numberedListItems = (text.match(/(?:^|\n)\s*(\d+[.)]\s|[-*]\s+(?=[A-Z]))/gm) ?? []).length;
  const partMarkers = (text.match(/\bPART\s+[A-Z](?:\s|:|\b)/gi) ?? []).length;
  const stepMarkers = (text.match(/\b(?:step|phase)\s+\d+\b/gi) ?? []).length;
  const dagLanguage = (text.match(/\b(?:DAG|refinement edge|task_node_opened|decompose|task_edge_recorded|sub-?task|in parallel|for each)\b/gi) ?? []).length;
  const explicitMandates = (text.match(/\b(?:must|MUST|mandatory|required)\b/g) ?? []).length;
  const closureGateLang = (text.match(/\b(?:closure verifier|verifier must|audit that|residual must|closure_residual|gate)\b/gi) ?? []).length;
  const citationDemand = (text.match(/\b(?:cite|citation|paper|arxiv|venue|references?|evidence|grounded)\b/gi) ?? []).length;
  const conflictLang = (text.match(/\b(?:reuse-?first|REUSE|DISTINCT|supersede|vs\.?|trade-?off|conflicting)\b/gi) ?? []).length;
  const oneShotLang = (text.match(/\b(?:one-?shot|quick|simple|status|check|what is|tell me|when did|how many)\b/gi) ?? []).length;

  const independent_deliverable_count = Math.max(numberedListItems, partMarkers, stepMarkers);
  const gate_count = closureGateLang + Math.floor(explicitMandates / 3);
  const evidence_modality_count = citationDemand;
  // one_shot_answer_fit: high when text is short + has one-shot markers; low when complex.
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const complexityScore = independent_deliverable_count + dagLanguage + closureGateLang + Math.floor(wordCount / 100);
  const oneShotBonus = wordCount < 40 && oneShotLang > 0 ? 0.3 : 0;
  const one_shot_answer_fit = Math.max(0, Math.min(1, 1 - complexityScore * 0.12 + oneShotBonus));

  return {
    independent_deliverable_count,
    gate_count,
    evidence_modality_count,
    one_shot_answer_fit,
    raw_signals: {
      numberedListItems, partMarkers, stepMarkers, dagLanguage,
      explicitMandates, closureGateLang, citationDemand, conflictLang,
      oneShotLang, wordCount,
    },
  };
};

/** Map semantic signals to a decomposition_value boost in [0, 1]. Returns
 *  the max of: (a) the heuristic baseline, (b) a signal-driven value when
 *  any signal is strong. The heuristic remains the floor — signals never
 *  REDUCE decomposition_value, only push it higher when the text plainly
 *  needs DAG. */
export const decompositionValueFromSignals = (signals: SemanticDagSignals, heuristicBaseline: number): number => {
  const sigContribution =
    Math.min(0.5, signals.independent_deliverable_count * 0.10) +
    Math.min(0.25, signals.gate_count * 0.05) +
    Math.min(0.20, signals.evidence_modality_count * 0.03) +
    Math.max(0, 0.20 - signals.one_shot_answer_fit * 0.20);
  return clamp01(Math.max(heuristicBaseline, sigContribution));
};

const DISPATCH_ROUTE_AXIS_KEYS = [
  "one_shot_confidence",
  "information_gap",
  "reversibility",
  "owner_control_need",
  "decomposition_value",
  "cost_pressure",
  "time_sensitivity",
] as const;

const clamp01 = (n: number): number => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));

const addAxisSample = (sums: Record<string, number>, counts: Record<string, number>, value: unknown): void => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  for (const axis of DISPATCH_ROUTE_AXIS_KEYS) {
    const v = record[axis];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    sums[axis] = (sums[axis] ?? 0) + clamp01(v);
    counts[axis] = (counts[axis] ?? 0) + 1;
  }
};

const readLearnedDispatchAxisEvidence = (db: Database): { axes: Record<string, number>; verifier_evidence: Record<string, number> } => {
  const sums: Record<string, number> = {};
  const counts: Record<string, number> = {};
  let scoredRows = 0;
  let promotedRows = 0;
  try {
    const rows = db.query("SELECT residual, payload FROM events WHERE kind = 'action_scored' ORDER BY ts DESC, rowid DESC LIMIT 50").all() as Array<{ residual: number | null; payload: string }>;
    scoredRows = rows.length;
    for (const row of rows) {
      const payload = safeJson(row.payload);
      addAxisSample(sums, counts, payload.outcome_dimensions);
      addAxisSample(sums, counts, payload.breakdown);
      addAxisSample(sums, counts, payload.reliability_profile);
      addAxisSample(sums, counts, payload.budget_observed);
      addAxisSample(sums, counts, payload.dispatch_axes);
      const verifier = payload.verifier_result;
      if (verifier && typeof verifier === "object" && !Array.isArray(verifier)) {
        const vr = verifier as Record<string, unknown>;
        addAxisSample(sums, counts, vr.outcome_dimensions);
        addAxisSample(sums, counts, vr.breakdown);
        addAxisSample(sums, counts, vr.reliability_profile);
        addAxisSample(sums, counts, vr.budget_observed);
        addAxisSample(sums, counts, vr.dispatch_axes);
      }
      if (typeof row.residual === "number" && Number.isFinite(row.residual)) {
        sums.one_shot_confidence = (sums.one_shot_confidence ?? 0) + clamp01(1 - row.residual);
        counts.one_shot_confidence = (counts.one_shot_confidence ?? 0) + 1;
      }
    }
  } catch { /* fresh schemas or tests may not have matching rows */ }
  try {
    const rows = db.query("SELECT payload FROM events WHERE kind = 'knowledge_promoted' ORDER BY ts DESC, rowid DESC LIMIT 50").all() as Array<{ payload: string }>;
    promotedRows = rows.length;
    for (const row of rows) {
      const payload = safeJson(row.payload);
      addAxisSample(sums, counts, payload.dispatch_axes);
      addAxisSample(sums, counts, payload.routing_axes);
      addAxisSample(sums, counts, payload.verifier_evidence);
    }
  } catch { /* skip */ }
  const axes: Record<string, number> = {};
  for (const axis of DISPATCH_ROUTE_AXIS_KEYS) {
    if ((counts[axis] ?? 0) > 0) axes[axis] = clamp01((sums[axis] ?? 0) / counts[axis]!);
  }
  return {
    axes,
    verifier_evidence: {
      action_scored_rows_considered: scoredRows,
      knowledge_promoted_rows_considered: promotedRows,
      learned_axis_count: Object.keys(axes).length,
    },
  };
};

const blendLearnedAxis = (learned: Record<string, number>, axis: string, fallback: number): number => {
  const v = learned[axis];
  if (typeof v === "number" && Number.isFinite(v)) return clamp01(v * 0.65 + fallback * 0.35);
  return clamp01(fallback);
};

const scoreRoutesFromAxes = (axes: Record<string, number>): DispatchRouteScores => {
  const oneShot = axes.one_shot_confidence ?? 0;
  const gap = axes.information_gap ?? 0;
  const reversible = axes.reversibility ?? 0;
  const control = axes.owner_control_need ?? 0;
  const decomposition = axes.decomposition_value ?? 0;
  const cost = axes.cost_pressure ?? 0;
  const time = axes.time_sensitivity ?? 0;
  return {
    substrate_replay: clamp01(oneShot * 0.45 + cost * 0.25 + time * 0.15 + (1 - gap) * 0.10 + (1 - decomposition) * 0.05),
    claude_inline: clamp01(oneShot * 0.35 + reversible * 0.25 + (1 - control) * 0.20 + (1 - gap) * 0.10 + cost * 0.10),
    // Claude-agent work is still substrate-orchestrated, but it is drained
    // by a live external Claude orchestrator. Score it for decomposable,
    // reversible work where background parallelism can reduce elapsed time
    // without forcing the main Claude thread to inline the act.
    claude_agent: clamp01(decomposition * 0.40 + gap * 0.20 + reversible * 0.15 + time * 0.15 + (1 - control) * 0.10),
    opencode_brain: clamp01(gap * 0.25 + decomposition * 0.35 + control * 0.15 + (1 - oneShot) * 0.15 + (1 - reversible) * 0.10),
    deferred_blocked: clamp01(control * 0.25 + gap * 0.20 + (1 - reversible) * 0.25),
  };
};

const chooseHighestScoredRoute = (routeScores: DispatchRouteScores, feasibleRoutes: DispatchRoute[]): DispatchRoute => {
  let best = feasibleRoutes[0] ?? "opencode_brain";
  let bestScore = routeScores[best] ?? 0;
  for (const route of feasibleRoutes.slice(1)) {
    const score = routeScores[route] ?? 0;
    if (score > bestScore) {
      best = route;
      bestScore = score;
    }
  }
  return best;
};

const BRAIN_ACCURACY_ARTIFACT_PREFIX = "brain_accuracy_predicate:";

type PosteriorRoutedPeerRoute = "opencode_brain" | "claude_inline" | "claude_agent";

const POSTERIOR_ROUTED_PEER_HINTS: Record<PosteriorRoutedPeerRoute, { kinds: string[]; origins: string[] }> = {
  opencode_brain: { kinds: ["opencode"], origins: ["opencode", "opencode_brain"] },
  claude_inline: { kinds: ["claude_root", "claude_terminal", "claude"], origins: ["claude_inline", "claude_root", "claude"] },
  claude_agent: { kinds: ["claude_agent", "claude_terminal"], origins: ["claude_agent", "claude_root", "claude"] },
};

type PeerAccuracyRouteAdjustment = {
  route_scores: DispatchRouteScores;
  verifier_evidence: Record<string, number>;
};

type PeerActivityRow = {
  peer_id: string | null;
  kind: string | null;
  spawnability: string | null;
  liveness_verdict: string | null;
  latest_activity_event_id: string | null;
};

type PeerAccuracyPosterior = {
  artifact_id: string;
  score: number;
  confidence: number;
  predicted_residual: number;
};

const currentGoalShapeForTask = (db: Database, task: TaskNode): string => {
  const directivePayload = readDirectivePayload(db, task.directive_id);
  const directiveText = typeof directivePayload.directive_text === "string" ? directivePayload.directive_text : "";
  const goal = typeof directivePayload.goal === "string" ? directivePayload.goal : "";
  const intent = typeof directivePayload.intent === "string" ? directivePayload.intent : "";
  return computeGoalShape(directiveText || goal || intent || task.goal);
};

const readPeerActivityRows = (db: Database): PeerActivityRow[] => {
  try {
    return db
      .query(
        `SELECT peer_id, kind, spawnability, liveness_verdict, latest_activity_event_id
         FROM peer_activity_view
         WHERE liveness_verdict = 'live'`,
      )
      .all() as PeerActivityRow[];
  } catch {
    return [];
  }
};

const hasLiveClaudeAgentPeer = (db: Database): boolean =>
  readPeerActivityRows(db).some((row) => row.kind === "claude_agent" || row.kind === "claude_terminal");

const routePeerTokens = (route: PosteriorRoutedPeerRoute, peerRows: PeerActivityRow[]): string[] => {
  const hints = POSTERIOR_ROUTED_PEER_HINTS[route];
  const tokens = new Set<string>([...hints.origins, ...hints.kinds]);
  for (const row of peerRows) {
    const kind = typeof row.kind === "string" ? row.kind : "";
    if (!hints.kinds.includes(kind) && !hints.origins.includes(kind)) continue;
    if (typeof row.peer_id === "string" && row.peer_id.trim()) tokens.add(row.peer_id.trim());
    if (typeof row.spawnability === "string" && row.spawnability.trim()) tokens.add(row.spawnability.trim());
  }
  return Array.from(tokens).map((t) => t.toLowerCase());
};

const readPeerAccuracyPosteriors = (
  db: Database,
  goalShapeToken: string,
  peerTokens: string[],
): PeerAccuracyPosterior[] => {
  if (peerTokens.length === 0) return [];
  const needle = `%${goalShapeToken}%`;
  let rows: Array<{ id: string; name: string | null; body: string; score: number; confidence: number }> = [];
  try {
    rows = db
      .query(
        `SELECT id, name, body, score, confidence
         FROM act_artifact
         WHERE kind = 'brain_accuracy_predicate'
           AND status NOT IN ('quarantined', 'retired')
           AND (id LIKE ? OR name LIKE ? OR body LIKE ?)`,
      )
      .all(needle, needle, needle) as Array<{ id: string; name: string | null; body: string; score: number; confidence: number }>;
  } catch {
    return [];
  }

  const tokenSet = new Set(peerTokens);
  return rows
    .filter((row) => {
      const haystack = `${row.id} ${row.name ?? ""} ${row.body ?? ""}`.toLowerCase();
      return haystack.includes(BRAIN_ACCURACY_ARTIFACT_PREFIX) && Array.from(tokenSet).some((token) => haystack.includes(token));
    })
    .map((row) => {
      const score = clamp01(row.score);
      return {
        artifact_id: row.id,
        score,
        confidence: clamp01(row.confidence),
        predicted_residual: clamp01(1 - score),
      };
    });
};

const applyPeerAccuracyRouteAdjustment = (
  db: Database,
  task: TaskNode,
  routeScores: DispatchRouteScores,
  feasibleRoutes: DispatchRoute[],
): PeerAccuracyRouteAdjustment => {
  const adjusted: DispatchRouteScores = { ...routeScores };
  const evidence: Record<string, number> = {};
  const peerRoutes = feasibleRoutes.filter((r): r is PosteriorRoutedPeerRoute =>
    r === "opencode_brain" || r === "claude_inline" || r === "claude_agent");
  if (peerRoutes.length === 0) return { route_scores: adjusted, verifier_evidence: evidence };

  const shape = currentGoalShapeForTask(db, task);
  const peerRows = readPeerActivityRows(db);
  evidence.peer_accuracy_goal_shape_present = shape ? 1 : 0;
  evidence.peer_activity_live_count = peerRows.length;

  let applied = 0;
  for (const route of peerRoutes) {
    const peerTokens = routePeerTokens(route, peerRows);
    const posteriors = readPeerAccuracyPosteriors(db, shape, peerTokens);
    evidence[`peer_accuracy_${route}_posterior_count`] = posteriors.length;
    if (posteriors.length === 0) continue;

    const totalConfidence = posteriors.reduce((sum, p) => sum + p.confidence, 0);
    const weightedScore = totalConfidence > 0
      ? posteriors.reduce((sum, p) => sum + p.score * p.confidence, 0) / totalConfidence
      : posteriors.reduce((sum, p) => sum + p.score, 0) / posteriors.length;
    const confidence = clamp01(totalConfidence / posteriors.length);
    const posteriorScore = clamp01(weightedScore);
    evidence[`peer_accuracy_${route}_score`] = posteriorScore;
    evidence[`peer_accuracy_${route}_confidence`] = confidence;
    evidence[`peer_accuracy_${route}_predicted_residual`] = clamp01(1 - posteriorScore);
    adjusted[route] = clamp01((adjusted[route] ?? 0) * (1 - confidence) + posteriorScore * confidence);
    applied = 1;
  }

  evidence.peer_accuracy_adjustment_applied = applied;
  return { route_scores: adjusted, verifier_evidence: evidence };
};

const evidenceForSelectedRoute = (
  evidence: DispatchDecisionEvidence,
  selectedRoute: DispatchRoute,
  feasibleRoutes: DispatchRoute[],
): DispatchDecisionEvidence => ({
  ...evidence,
  verifier_evidence: {
    ...evidence.verifier_evidence,
    selected_route_score: evidence.route_scores[selectedRoute] ?? 0,
    feasible_route_count: feasibleRoutes.length,
  },
});

/** Canonical dispatch-decision audit payload — the SHAPE that
 *  dispatch_decided and its constitutional_gate_decision mirror both
 *  carry on the wire. Centralising the projection here means a new
 *  field on DispatchDecisionEvidence (e.g. strategy_shadow_ranks
 *  2026-05-17) propagates to every audit emitter without each call
 *  site having to remember to rebuild its hand-curated object.
 *  Without this, "decider attaches field; emit site rebuilds and
 *  silently drops field" is a class of bug that recurs (859 historical
 *  dispatch_decided rows landed in production with `strategy_shadow_ranks`
 *  stripped because two emit sites diverged from the decider). */
export const dispatchEvidencePayload = (decision: DispatchDecision): {
  route: DispatchRoute;
  reason: string;
  routing_axes: Record<string, number>;
  route_scores: DispatchRouteScores;
  verifier_evidence: Record<string, number>;
  strategy_shadow_ranks: RankedStrategy[];
} => ({
  route: decision.route,
  reason: decision.reason,
  routing_axes: decision.routing_axes,
  route_scores: decision.route_scores,
  verifier_evidence: decision.verifier_evidence,
  strategy_shadow_ranks: decision.strategy_shadow_ranks ?? [],
});

/** Build the open-ended routing-axis vector + verifier evidence for a task.
 *
 *  CLEAN-BREAK (universal-workflow design DKDWVBTX2S0J9FQY0863GS1SJ0): there
 *  is NO regex/keyword hard-task pre-classification here. Risk and
 *  decomposition are not decided by matching strategic verbs or counting
 *  stakeholders/budget fields — the LM decides decomposition (it emits
 *  refinement edges for any task that needs it) and verifier residual +
 *  the unified owner_alignment gate handle risk. The fallback axis vector is
 *  derived only from (a) structural-marker semantic-DAG signals (numbered
 *  parts, gates, citation demands — counts, not meaning interpretation),
 *  (b) the count of declared target resources (structural blast radius), and
 *  (c) directive urgency. Learned action_scored/knowledge_promoted evidence
 *  blends on top of these via blendLearnedAxis. */
const buildDispatchDecisionEvidence = (db: Database, task: TaskNode): DispatchDecisionEvidence => {
  const directivePayload = readDirectivePayload(db, task.directive_id);
  const text = String(typeof directivePayload.directive_text === "string" ? directivePayload.directive_text : "") + "\n" + task.goal;
  const targets = taskTargetResources(task);
  const urgency = typeof directivePayload.urgency === "string" ? directivePayload.urgency : "normal";
  const learned = readLearnedDispatchAxisEvidence(db);
  // Semantic-DAG signals: extracted from owner free-text + task goal so the
  // decomposition_value axis reflects what the owner is actually asking for
  // (numbered parts, mandatory gates, citation demands). These are
  // structural-marker counts, not semantic intent classification — the brain
  // interprets meaning; this scorer only counts the structural language.
  const semantic = extractSemanticDagSignals(text);
  // Decomposition baseline rises with the number of declared independent
  // deliverables/targets — structural evidence, not a regex verdict. The
  // semantic signal scorer only ever pushes this higher (never lower).
  const decompositionBaseline = clamp01(0.20 + Math.max(0, targets.length - 1) * 0.10);
  const fallbackAxes: Record<string, number> = {
    one_shot_confidence: clamp01((0.85 - Math.max(0, targets.length - 1) * 0.10) * semantic.one_shot_answer_fit),
    information_gap: clamp01(0.15 + (targets.length === 0 ? 0.10 : 0) + (1 - semantic.one_shot_answer_fit) * 0.40),
    reversibility: 0.80,
    owner_control_need: clamp01(0.25 + Math.max(0, targets.length - 1) * 0.15),
    decomposition_value: decompositionValueFromSignals(semantic, decompositionBaseline),
    cost_pressure: urgency === "crisis" ? 0.85 : 0.35,
    time_sensitivity: urgency === "crisis" ? 0.95 : (urgency === "elevated" ? 0.65 : 0.25),
  };
  const routing_axes: Record<string, number> = {};
  for (const axis of DISPATCH_ROUTE_AXIS_KEYS) routing_axes[axis] = blendLearnedAxis(learned.axes, axis, fallbackAxes[axis] ?? 0);
  return {
    routing_axes,
    route_scores: scoreRoutesFromAxes(routing_axes),
    verifier_evidence: {
      ...learned.verifier_evidence,
      target_count: targets.length,
      semantic_independent_deliverable_count: semantic.independent_deliverable_count,
      semantic_gate_count: semantic.gate_count,
      semantic_evidence_modality_count: semantic.evidence_modality_count,
      semantic_one_shot_answer_fit: semantic.one_shot_answer_fit,
      semantic_decomposition_baseline: decompositionBaseline,
    },
  };
};


/** Phase J: delegate to the real matcher in runtime/recipe_replay.ts which
 *  computes goal_shape via runtime/goal_shape.ts and topology_signature off
 *  the task's directive DAG. The wrapper preserves the local RecipeMatch
 *  shape the decider uses. */
const findRecipeMatch = (db: Database, task: TaskNode, confidenceThreshold: number): RecipeMatch | null => {
  const match = findRealRecipeMatch(db, task, { minConfidence: confidenceThreshold });
  if (!match) return null;
  return { id: match.recipe_id, confidence: match.confidence };
};

type InlinePattern = {
  cited_id: string;
  pattern_kind: "extension" | "prefix" | "exact" | "glob";
  pattern: string;
  score: number;
  confidence: number;
};

const readLowRiskInlinePatterns = (db: Database): InlinePattern[] => {
  // Phase Audit: route through `low_risk_inline_patterns_view` (the SQL
  // view scoped by tag + score + confidence) so dispatch_decider and the
  // MCP `substrate.read` surface share one source of truth (§3.6). The
  // accessor handles missing views gracefully — if `runViews(db)` has not
  // been called the catch returns [], which keeps the decider fail-closed.
  try {
    const rows = lowRiskInlinePatterns(db);
    return rows.map((r): InlinePattern => ({
      cited_id: r.cited_id,
      pattern_kind: r.pattern_kind,
      pattern: r.pattern,
      score: r.score,
      confidence: r.confidence,
    }));
  } catch {
    return [];
  }
};

/** Return the set of patterns the task's resources match. Empty array means
 *  no inline lane. The decider rejects inline unless EVERY normalized
 *  target_resource matches at least one scheme-aware pattern. */
const inlineMatchingPatterns = (
  task: TaskNode & { target_resources?: string[] },
  patterns: InlinePattern[],
): InlinePattern[] | null => {
  if (patterns.length === 0) return null;
  const targets = parseResourceRefs(task.target_resources);
  if (!targets || targets.length === 0) return null;
  const matched: InlinePattern[] = [];
  for (const t of targets) {
    const hit = patterns.find((p) => resourceMatchesPattern(t as ResourceRef, p.pattern_kind, p.pattern));
    if (!hit) return null; // ANY mismatch disqualifies the entire task
    matched.push(hit);
  }
  return matched;
};

const estimateComplexity = (task: TaskNode): "low" | "mid" | "high" => {
  // Phase D heuristic: short single-noun goals are 'low', everything else mid.
  // Phase F can replace with an embedding-derived feature.
  const wordCount = task.goal.split(/\s+/).filter(Boolean).length;
  if (wordCount <= 6) return "low";
  if (wordCount <= 20) return "mid";
  return "high";
};

/** Route a ready task to its execution lane. Returns one of four decisions.
 *  Without recipes or inline patterns, this typically returns
 *  `opencode_brain`. Two modulators apply on top of the base lanes:
 *    - If the directive is the target of a `blocks` interference edge from
 *      an unresolved source directive, we down-rank to `deferred_blocked`.
 *    - In crisis mode (urgency='crisis' on the directive) we lower the
 *      recipe-match threshold from 0.7 → 0.4 so Tier-0 fires harder. */
/** Beta-distribution mean and evidence-count confidence proxy. Both
 *  delegate to the canonical implementation in `runtime/posterior.ts`
 *  so the inline-lane refresh, the knowledge-promotion extractor in
 *  `substrate/extractors.ts`, and the dispatcher all share exactly the
 *  same algebra (Architecture.md; posterior-consistency alignment
 *  test pins both formulas). Local aliases keep the call-site names
 *  unchanged. */
const betaMean = canonicalBetaMean;
const betaConfidence = betaEvidenceConfidence;

/** Recompute the Beta posterior on the existing `knowledge_promoted` row
 *  for this candidate by counting the live `candidate_confirmed` /
 *  `candidate_contradicted` events that cite it, then stamp the new
 *  alpha/beta/score/confidence onto the promotion payload. The
 *  `low_risk_inline_patterns_view` reads the payload directly, so this
 *  refresh is what makes the inline lane adapt to outcomes (Batch 4 Hole 3).
 *
 *  The `knowledgeId` is the id of the `knowledge_promoted` event surfaced
 *  by the view (`cited_id`). Internally that event cites the original
 *  `knowledge_candidate` row via `context_refs[0]`; the verdicts cite the
 *  candidate id. We resolve both directions so callers can pass either id. */
const refreshInlinePatternPosterior = (db: Database, knowledgeId: string): void => {
  // Locate the promotion row. The view's `cited_id` IS the
  // `knowledge_promoted` event id, so callers normally pass that. If the
  // caller passed a candidate id, fall back to the promotion that cites it.
  let promotion = db
    .query(
      `SELECT id, payload, context_refs FROM events
       WHERE kind = 'knowledge_promoted' AND id = ? LIMIT 1`,
    )
    .get(knowledgeId) as { id: string; payload: string; context_refs: string } | null;
  if (!promotion) {
    promotion = db
      .query(
        `SELECT id, payload, context_refs FROM events
         WHERE kind = 'knowledge_promoted'
           AND context_refs LIKE '%"' || ? || '"%'
         ORDER BY ts DESC LIMIT 1`,
      )
      .get(knowledgeId) as { id: string; payload: string; context_refs: string } | null;
  }
  if (!promotion) return;

  // Resolve the candidate id: payload.candidate_id wins, otherwise the first
  // context_ref. Knowledge verdicts cite the candidate (matches what
  // `extractKnowledgePromotions` counts).
  let candidateId: string | null = null;
  try {
    const parsedPayload = JSON.parse(promotion.payload ?? "{}") as Record<string, unknown>;
    if (typeof parsedPayload.candidate_id === "string") {
      candidateId = parsedPayload.candidate_id;
    }
  } catch { /* fall through */ }
  if (!candidateId) {
    try {
      const refs = JSON.parse(promotion.context_refs ?? "[]") as string[];
      if (refs.length > 0) candidateId = refs[0]!;
    } catch { /* skip */ }
  }
  if (!candidateId) return;

  // Count verdicts citing either the candidate id (canonical) or the
  // promotion id (inline-lane callers pass the cited_id from the view,
  // which IS the promotion id). Both citation styles count toward the
  // same posterior — they refer to the same knowledge claim at different
  // lifecycle moments.
  const verdicts = db
    .query(
      `SELECT kind, context_refs FROM events
       WHERE kind IN ('candidate_confirmed', 'candidate_contradicted')`,
    )
    .all() as Array<{ kind: string; context_refs: string }>;
  let wins = 0;
  let losses = 0;
  for (const v of verdicts) {
    let refs: string[] = [];
    try { refs = JSON.parse(v.context_refs ?? "[]") as string[]; } catch { /* skip */ }
    if (!refs.includes(candidateId) && !refs.includes(promotion.id)) continue;
    if (v.kind === "candidate_confirmed") wins++; else losses++;
  }
  const alpha = 1 + wins;
  const beta = 1 + losses;
  const score = betaMean(alpha, beta);
  const confidence = betaConfidence(alpha, beta);

  // Stamp the refreshed posterior onto the promotion payload. The view reads
  // `payload.score` / `payload.confidence` directly so this update is what
  // makes the dispatcher's INLINE_PATTERN_SCORE_THRESHOLD / _CONFIDENCE_
  // THRESHOLD reads see the new values.
  let merged: Record<string, unknown> = {};
  try {
    merged = JSON.parse(promotion.payload ?? "{}") as Record<string, unknown>;
  } catch { merged = {}; }
  merged.alpha = alpha;
  merged.beta = beta;
  merged.wins = wins;
  merged.losses = losses;
  merged.score = score;
  merged.confidence = confidence;
  merged.last_outcome_ts = new Date().toISOString();
  db.run("UPDATE events SET payload = ? WHERE id = ?", [JSON.stringify(merged), promotion.id]);
};

/** Credit the inspiring `knowledge_promoted` row for an inline-lane outcome
 *  (k_555 four-link chain — create → retrieve → mutate → credit). Emits a
 *  `candidate_confirmed` (success) or `candidate_contradicted` (failure)
 *  event citing the promotion id; the existing knowledge extractor consumes
 *  these and recomputes the Beta posterior so the inline-vs-delegate
 *  selector adapts to outcomes. Architecture.md, k_252 "advisory=fake"
 *  remediated by structural credit emission.
 *
 *  Batch 4 Hole 3: after emitting the verdict, also refresh the promotion
 *  row's payload (`score`, `confidence`, `alpha`, `beta`) so the
 *  `low_risk_inline_patterns_view` — which reads these scalars directly —
 *  reflects the new posterior on the very next dispatch tick. Without this
 *  refresh the verdict events accumulate but the view stays frozen at
 *  promotion time and the dispatcher cannot adapt. */
export const recordLowRiskInlineOutcome = (
  db: Database,
  knowledgeId: string,
  outcome: "success" | "failure",
  ts?: string,
): void => {
  // Lazy import to avoid a circular: emit lives in runtime/events.ts and
  // the dispatch_decider is imported by the MCP server which also imports
  // events.ts. Static import is fine; we keep the call here so any caller
  // (OwnerAutonomy, dispatcher, tests) can credit uniformly.
  const { emitEvent } = require("./events") as typeof import("./events");
  emitEvent(db, {
    kind: outcome === "success" ? "candidate_confirmed" : "candidate_contradicted",
    substrate_origin: "substrate_auto",
    context_refs: [knowledgeId],
    payload: {
      knowledge_id: knowledgeId,
      outcome,
      ts: ts ?? new Date().toISOString(),
      source: "low_risk_inline_lane",
    },
  });
  // Recompute and stamp the new posterior onto the inline-pattern promotion
  // row. The view reads payload.score/confidence directly; without this the
  // dispatcher's score≥0.7 + confidence≥0.6 gate is frozen at promotion time.
  refreshInlinePatternPosterior(db, knowledgeId);
};

export const decideDispatch = (db: Database, task: TaskNode): DispatchDecision => {
  const baseEvidence = buildDispatchDecisionEvidence(db, task);

  // 0. Down-rank: directive blocked by an unresolved higher-priority directive.
  const blockers = blockersOf(db, task.directive_id);
  if (blockers.length > 0) {
    const feasibleRoutes: DispatchRoute[] = ["deferred_blocked"];
    const evidence = evidenceForSelectedRoute(baseEvidence, "deferred_blocked", feasibleRoutes);
    return {
      route: "deferred_blocked",
      blockers,
      reason: "blocked_by:" + blockers.join(","),
      ...evidence,
    };
  }

  const mode = readCurrentMode(db, task.directive_id);
  const recipeThreshold = mode.recipe_confidence_threshold;
  const recipe = findRecipeMatch(db, task, recipeThreshold);
  // CLEAN-BREAK (universal-workflow design DKDWVBTX): recipe-replay feasibility
  // is NOT gated by hard-task semantic classification. A high-confidence
  // recipe match is feasible for every task; residual-scored route selection
  // (below) decides whether substrate_replay actually wins. There is no
  // "recipe_match_hard_override_verified" branch — the recipe's confidence
  // (and crisis-mode threshold) IS the override evidence.
  const recipeRouteReason: string | null = recipe ? "recipe_match" : null;

  const inlinePatterns = readLowRiskInlinePatterns(db);
  const matchedInlinePatterns = inlineMatchingPatterns(task as TaskNode & { target_resources?: string[] }, inlinePatterns);

  const feasibleRoutes: DispatchRoute[] = ["opencode_brain"];
  if (recipe && recipeRouteReason) feasibleRoutes.push("substrate_replay");
  // CLEAN-BREAK (universal-workflow design DKDWVBTX): inline eligibility is
  // structural/retrieval-backed only. There is no hard-task semantic
  // classifier removing a lane from feasibleRoutes before residual-scored
  // route selection. If every declared target_resource matches a promoted
  // low-risk inline pattern, the inline lane is feasible; the scored route
  // selection (and learned/peer-accuracy posteriors) decide whether it wins.
  if (matchedInlinePatterns && matchedInlinePatterns.length > 0) feasibleRoutes.push("claude_inline");
  // Tier U/U5: the substrate cannot spawn Claude. It may route to the
  // claude_agent lane only when a live Claude orchestrator/agent peer is
  // already registered and heartbeating, so queued jobs always have a
  // plausible external drainer. Without that peer, fail closed to the
  // existing opencode_brain / claude_inline lanes.
  if (hasLiveClaudeAgentPeer(db)) feasibleRoutes.push("claude_agent");

  // Route availability still fails closed (no recipe/no inline knowledge means
  // no such lane). When a peer lane is feasible, fold in the per-peer,
  // per-goal-shape brain_accuracy_predicate posterior before selecting.
  // Missing peer posteriors are a cold-start condition, not a blocker: the
  // static route scores remain the fallback.
  const posteriorAdjusted = applyPeerAccuracyRouteAdjustment(db, task, baseEvidence.route_scores, feasibleRoutes);

  // Shadow ranker (2026-05-17 brain design 48SN4XF3WN4KBBCHHCANDRDQRW):
  // compute dispatch_strategy_v1 artifact rankings ALONGSIDE the
  // existing scoreRoutesFromAxes decision. Observational only — the
  // chosen route is still determined by chooseHighestScoredRoute below.
  // The rankings ride along on dispatch_decided.payload for the
  // closure_audited consumer to credit strategy posteriors against
  // realised outcomes.
  let strategyShadowRanks: RankedStrategy[] = [];
  try {
    const ctx = buildRankingContext(db, task, baseEvidence.routing_axes, feasibleRoutes);
    strategyShadowRanks = rankStrategies(db, ctx, 3);
  } catch { /* shadow ranking is observational — never block dispatch */ }

  const routeEvidence = {
    ...baseEvidence,
    route_scores: posteriorAdjusted.route_scores,
    verifier_evidence: {
      ...baseEvidence.verifier_evidence,
      ...posteriorAdjusted.verifier_evidence,
    },
    strategy_shadow_ranks: strategyShadowRanks,
  };
  const selectedRoute = chooseHighestScoredRoute(routeEvidence.route_scores, feasibleRoutes);
  const evidence = evidenceForSelectedRoute(routeEvidence, selectedRoute, feasibleRoutes);

  if (selectedRoute === "substrate_replay" && recipe && recipeRouteReason) {
    return { route: "substrate_replay", recipe_id: recipe.id, reason: recipeRouteReason, ...evidence };
  }

  if (selectedRoute === "claude_inline" && matchedInlinePatterns && matchedInlinePatterns.length > 0) {
    return {
      route: "claude_inline",
      cited_artifact_ids: matchedInlinePatterns.map((m) => m.cited_id),
      reason: "scored_inline_lane",
      ...evidence,
    };
  }

  if (selectedRoute === "claude_agent") {
    return {
      route: "claude_agent",
      job_intent: task.goal,
      target_files: taskTargetResources(task).map((target) => target.startsWith("repo:") ? target.slice("repo:".length) : target),
      acceptance_predicate: {
        kind: "task_residual_below_threshold",
        residual_below: 0.3,
        closure_requires_act_tuple_recorded: true,
      },
      reason: "live_claude_agent_peer_scored_lane",
      ...evidence,
    };
  }

  // CLEAN-BREAK (universal-workflow design DKDWVBTX): the universal lane is
  // opencode_brain. There is no regex hard-task force to "high" complexity —
  // the LM decides decomposition (it emits refinement edges for any task that
  // needs them) and risk is handled by verifier residual plus the unified
  // owner-autonomy gate. The same gate applies to forecast-originated
  // directives: high-confidence, reversible forecasts inside
  // owner_profile.autonomy_scope may dispatch; low-confidence, out-of-scope,
  // irreversible, or owner-sensitive forecasts must route to
  // owner_input_required/hidl_action_required as proposed actions. This is
  // route evidence, not a OwnerAutonomy mode or regex pre-classifier. Complexity is a
  // coarse structural estimate only; routing is always valid (defaults here).
  return {
    route: "opencode_brain",
    predicted_complexity: estimateComplexity(task),
    reason: matchedInlinePatterns && matchedInlinePatterns.length > 0 ? "scored_brain_lane" : "no_recipe_no_inline_match",
    ...evidence,
  };
};
