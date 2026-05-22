#!/usr/bin/env bun
// `acc apply <event_id>` — render a Claude Agent subagent prompt for
// applying a lesson_extracted or contract_amendment_proposed event, AND
// record the act-shaped applied_change_committed spine plus the
// lesson_applied / contract_amendment_applied credit event when the
// subagent finishes. Option D + Claude subagent executor (CLAUDE.md
// §"Applying lessons via Claude Agent subagents").
//
// Two modes:
//   acc apply <event_id>
//       Requires any owner consent as owner_decision_recorded in the ledger,
//       then reads the source event via mcpCall, renders the structured prompt
//       template, prints it to stdout. The orchestrator (main Claude) feeds
//       this prompt into the Agent tool with run_in_background:true so the
//       subagent does the actual Edit/test/git work in an isolated context.
//
//   acc apply --record <event_id> --status (applied|failed) [--commit-sha X]
//             [--subagent-task-id Y] [--summary "..."] [--reason "..."]
//       Emits action_predicted -> action_scored, then applied_change_committed
//       only when the verifier residual passes, followed by the corresponding
//       *_applied event so the originating lesson/amendment is credited
//       (closes the four-link chain:
//       create -> retrieve -> mutate -> credit, k_555).

import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { mcpCall } from "./rpc";
import { lessonApplyTargetsPolicy } from "../substrate/lesson_apply_policy";
import { classifyApply } from "./verify";
import { emitActTupleViaMcp } from "../runtime/act_tuple";

// Clean-break consolidation (RLM-first): the 7 rule-based owner-alignment
// apply-gate evaluators (goal-drift, delegation-safety, metacognitive-policy,
// continual-state, outcome-forecast, rendering, theory-of-mind) collapsed
// into ONE owner_alignment gate. A change auto-applies UNLESS (a) it violates
// owner hard constraints (things_to_never_do) OR (b) its residual/risk exceeds
// the owner autonomy threshold. No legacy/backward-compat shims.

// OwnerAlignmentInput / OwnerAlignmentResult — the single owner-alignment
// signal. Injectable for tests via setApplyEvaluatorsForTest.
type OwnerAlignmentInput = {
  // upstream change/precondition residual (1 - decision.score) — already
  // reflects diff well-formedness, anchor uniqueness, posterior score.
  change_residual: number;
  // owner autonomy threshold from owner_profile_view.autonomy_signals.
  autonomy_threshold: number;
  // owner hard-constraint match against the directive/target context, or null.
  hard_constraint_hit: string | null;
  // risk for the target surfaces (runtime/substrate/cli surfaces score higher).
  target_surface_risk: number;
};

type OwnerAlignmentResult = {
  residual: number;
  verdict: "aligned" | "misaligned";
  hard_constraint_hit: string | null;
  breakdown: Record<string, unknown>;
  reasons: string[];
};

// Default owner-alignment evaluator: the unified RLM-first rule. residual is
// the max of the upstream change residual and the target-surface autonomy
// risk; verdict is misaligned when a hard constraint is hit OR the residual
// exceeds the owner autonomy threshold.
const evaluateOwnerAlignment = (input: OwnerAlignmentInput): OwnerAlignmentResult => {
  const residual = Math.min(1, Math.max(0, Math.max(input.change_residual, input.target_surface_risk)));
  const constraintHit = input.hard_constraint_hit;
  const exceedsThreshold = residual > input.autonomy_threshold;
  const misaligned = constraintHit !== null || exceedsThreshold;
  const reasons: string[] = [];
  if (constraintHit !== null) reasons.push(`owner_hard_constraint:${constraintHit}`);
  if (exceedsThreshold) reasons.push("residual_exceeds_autonomy_threshold");
  if (!misaligned) reasons.push("within_autonomy_envelope");
  return {
    residual,
    verdict: misaligned ? "misaligned" : "aligned",
    hard_constraint_hit: constraintHit,
    breakdown: {
      change_residual: input.change_residual,
      target_surface_risk: input.target_surface_risk,
      autonomy_threshold: input.autonomy_threshold,
      hard_constraint_hit: constraintHit !== null ? 1 : 0,
    },
    reasons,
  };
};

type ApplyEvaluators = {
  evaluateOwnerAlignment: (input: OwnerAlignmentInput) => OwnerAlignmentResult;
};

const defaultApplyEvaluators: ApplyEvaluators = {
  evaluateOwnerAlignment,
};

let applyEvaluators: ApplyEvaluators = defaultApplyEvaluators;

export const setApplyEvaluatorsForTest = (overrides: Partial<ApplyEvaluators>): void => {
  applyEvaluators = { ...defaultApplyEvaluators, ...overrides };
};

export const resetApplyEvaluatorsForTest = (): void => {
  applyEvaluators = defaultApplyEvaluators;
};

type Args = Record<string, string | boolean>;

const parseArgs = (argv: string[]): { positional: string[]; flags: Args } => {
  const positional: string[] = [];
  const flags: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq >= 0) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[a.slice(2)] = next;
        i++;
      } else {
        flags[a.slice(2)] = true;
      }
    }
  }
  return { positional, flags };
};

type EventRow = {
  event_id?: string;
  id?: string;
  ts?: string;
  kind?: string;
  task_id?: string;
  directive_id?: string;
  payload?: unknown;
  context_refs?: string[];
};

type LessonQueueRow = {
  source_event_id?: string;
  source_kind?: string;
  target?: string | null;
  owner_gate_required?: boolean | number;
  owner_approved?: boolean | number;
  trajectory_hazard_count?: number;
  auto_apply_eligible?: boolean | number;
  apply_route?: string | null;
  apply_gate_status?: string | null;
  auto_apply_gate_verdict?: string | null;
  auto_apply_gate_residual?: number | null;
};

type ApplyRoute =
  | "AUTO_APPLY"
  | "AUTO_APPLY_TEST_LANE"
  | "OWNER_GATE"
  | "AUTO_DEFER_DEPENDENCY"
  | "AUTO_DECLINE_ALREADY_APPLIED"
  | "AUTO_DECLINE_TARGET_MISSING"
  | "AUTO_DECLINE_PROSE_ONLY"
  | "NEEDS_BRAIN_RECYCLE";

type ApplyRouteDecision = {
  route: ApplyRoute;
  score: number;
  confidence: number;
  deterministic: boolean;
  reason: string;
  preconditions: Record<string, unknown>;
};

type ApplyAuthorization = {
  ok: true;
  target: string;
  ownerGateRequired: boolean;
  ownerApproved: boolean;
  queueRow: LessonQueueRow | null;
  routeDecision: ApplyRouteDecision;
};

const DEFAULT_APPLY_ACTION_ARTIFACT_ID = "claude_agent_apply_change_action";
const DEFAULT_APPLY_VERIFIER_ARTIFACT_ID = "claude_agent_apply_change_verifier";
const DEFAULT_APPLY_GATE_ACTION_ARTIFACT_ID = "apply_route_predicate_action";
const DEFAULT_APPLY_GATE_VERIFIER_ARTIFACT_ID = "apply_route_predicate_verifier";

const fetchEvent = async (eventId: string): Promise<EventRow | null> => {
  const env = await mcpCall("substrate.get_event", { id: eventId });
  if (!env.ok) return null;
  return (env.result as EventRow) ?? null;
};

const parsePayload = (p: unknown): Record<string, unknown> => {
  if (!p) return {};
  if (typeof p === "string") {
    try { return JSON.parse(p) as Record<string, unknown>; } catch { return {}; }
  }
  if (typeof p === "object") return p as Record<string, unknown>;
  return {};
};

const proposalResource = (proposal: Record<string, unknown>): string => {
  // target_resource is canonical; "target" is kept as a transitional
  // alias for historical rows. resource_uri / file_path were dropped
  // (universality cleanup proposal #8, T104FY8YRX389165P4BKYAF2M4).
  for (const key of ["target_resource", "target"] as const) {
    const value = proposal[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
};

const targetFromPayload = (payload: Record<string, unknown>): string => {
  for (const key of ["target_resource", "target"] as const) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  const proposed = payload.proposed_behavior ?? payload.proposed_action;
  if (proposed && typeof proposed === "object") return proposalResource(proposed as Record<string, unknown>);
  return "";
};

const targetCandidatesFromPayload = (payload: Record<string, unknown>): string[] => {
  const targets = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim().length > 0) targets.add(value.trim());
  };
  for (const key of ["target_resource", "target"] as const) add(payload[key]);
  for (const key of ["proposed_behavior", "proposed_action"] as const) {
    const proposed = payload[key];
    if (proposed && typeof proposed === "object") {
      const p = proposed as Record<string, unknown>;
      for (const field of ["target_resource", "target"] as const) add(p[field]);
    }
  }
  return [...targets];
};

const repoResourceFromTarget = (target: string): string => {
  const trimmed = target.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.startsWith("repo:")) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  return "repo:" + trimmed.replace(/^\.\//, "");
};

const repoFileFromResource = (resource: string): string | null => {
  const normalized = repoResourceFromTarget(resource);
  if (!normalized.startsWith("repo:")) return null;
  const file = normalized.slice("repo:".length).replace(/^\.\//, "");
  return file.length > 0 ? file : null;
};

// isRepoTestFile — Candidate E (brain dispatch be0p341w8). Test-file
// targets bypass owner-decision queueing entirely so brain-emitted
// test amendments do not accumulate as "pending decisions" the
// operator never reviews. Closes the upstream leak above the
// pending_decision_retire_worker auto-prune (commit 19c2402).
//
// Matches `(^|/)<name>.(test|spec).ts(x)?` only. The `__tests__/`
// convention is NOT used anywhere in the current codebase (no
// directory matches `find -type d -name __tests__`), so we omit it;
// adding it later if a producer adopts the convention is a one-line
// extension.
const TEST_FILE_PATTERN = /(^|\/)[^/]+\.(test|spec)\.tsx?$/;
const isRepoTestFile = (file: string): boolean => TEST_FILE_PATTERN.test(file);

const affectedTargetsFromPayload = (payload: Record<string, unknown>, target: string | undefined): { affectedResources: string[]; affectedFiles: string[] } => {
  const resources = new Set<string>();
  for (const candidate of [...targetCandidatesFromPayload(payload), target].filter((t): t is string => typeof t === "string" && t.trim().length > 0)) {
    const resource = repoResourceFromTarget(candidate);
    if (resource.length > 0) resources.add(resource);
  }
  const affectedResources = [...resources];
  const affectedFiles = affectedResources
    .map(repoFileFromResource)
    .filter((file): file is string => typeof file === "string" && file.length > 0);
  return { affectedResources, affectedFiles };
};

const normalizeTargetForCompare = (target: string): string => target.startsWith("repo:") ? target.slice("repo:".length) : target;

const proposalTargetsPayloadTarget = (proposal: Record<string, unknown>, target: string): boolean => {
  const normalizedTarget = normalizeTargetForCompare(target);
  for (const field of ["target_resource", "target"] as const) {
    const value = proposal[field];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed === target || normalizeTargetForCompare(trimmed) === normalizedTarget) return true;
  }
  return false;
};

const structuredDiff = (diff: unknown): boolean => {
  if (typeof diff === "string") return diff.trim().length > 0;
  if (!diff || typeof diff !== "object" || Array.isArray(diff)) return false;
  const d = diff as Record<string, unknown>;
  return d.kind === "anchored_replace_v1"
    && typeof d.before === "string"
    && d.before.length > 0
    && typeof d.after === "string";
};

const applyRouteFromUnknown = (value: unknown): ApplyRoute | null => {
  if (typeof value !== "string") return null;
  switch (value) {
    case "AUTO_APPLY":
    case "AUTO_APPLY_TEST_LANE":
    case "OWNER_GATE":
    case "AUTO_DEFER_DEPENDENCY":
    case "AUTO_DECLINE_ALREADY_APPLIED":
    case "AUTO_DECLINE_TARGET_MISSING":
    case "AUTO_DECLINE_PROSE_ONLY":
    case "NEEDS_BRAIN_RECYCLE":
      return value;
    case "BLOCKED_ON_DEPENDENCY":
      return "AUTO_DEFER_DEPENDENCY";
    default:
      return null;
  }
};

const routeFromQueue = (row: LessonQueueRow | null): ApplyRoute | null => {
  const direct = applyRouteFromUnknown(row?.apply_route);
  if (direct) return direct;
  switch (row?.apply_gate_status) {
    case "authorized_auto": return "AUTO_APPLY";
    case "manual_review": return "OWNER_GATE";
    case "blocked_trajectory_hazard": return "AUTO_DEFER_DEPENDENCY";
    case "blocked_unstructured_proposal": return "AUTO_DECLINE_PROSE_ONLY";
    case "blocked_auto_apply_gate_missing": return null;
    case "blocked_auto_apply_gate_residual": return "NEEDS_BRAIN_RECYCLE";
    default:
      return null;
  }
};

const anchoredReplaceDiff = (payload: Record<string, unknown>): { before: string; after: string; occurrence: number } | null => {
  const structured = proposedChangeFields(payload);
  const diff = structured?.proposal.diff;
  if (!diff || typeof diff !== "object" || Array.isArray(diff)) return null;
  const d = diff as Record<string, unknown>;
  if (d.kind !== "anchored_replace_v1" || typeof d.before !== "string" || d.before.length === 0 || typeof d.after !== "string") return null;
  const occurrence = typeof d.occurrence === "number" && Number.isInteger(d.occurrence) && d.occurrence > 0 ? d.occurrence : 1;
  return { before: d.before, after: d.after, occurrence };
};

const countOccurrences = (haystack: string, needle: string): number => {
  if (needle.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while (true) {
    const next = haystack.indexOf(needle, pos);
    if (next === -1) return count;
    count++;
    pos = next + needle.length;
  }
};

const globLikeMatch = (pattern: string, value: string): boolean => {
  const normalizedPattern = normalizePolicyTarget(pattern).replace(/^repo:/, "");
  const normalizedValue = normalizePolicyTarget(value);
  if (normalizedPattern.length === 0) return false;
  if (!normalizedPattern.includes("*")) return normalizedValue.includes(normalizedPattern);
  const escaped = normalizedPattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`).test(normalizedValue);
};

const ownerProfileManualReviewMatch = async (targets: readonly string[]): Promise<string | null> => {
  const env = await mcpCall("substrate.read", { view_name: "owner_profile_view" });
  const row = env.ok && Array.isArray(env.result) ? (env.result[0] as { payload?: unknown } | undefined) : undefined;
  const payload = parsePayload(row?.payload);
  const patterns = Array.isArray(payload.manual_review_patterns) ? payload.manual_review_patterns : [];
  for (const raw of patterns) {
    if (typeof raw !== "string") continue;
    for (const target of targets) {
      if (globLikeMatch(raw, target)) return raw;
    }
  }
  return null;
};

const ownerAutonomyThreshold = async (): Promise<number> => {
  const env = await mcpCall("substrate.read", { view_name: "owner_profile_view" });
  const row = env.ok && Array.isArray(env.result) ? (env.result[0] as { payload?: unknown } | undefined) : undefined;
  const payload = parsePayload(row?.payload);
  const signals = payload.autonomy_signals && typeof payload.autonomy_signals === "object" ? payload.autonomy_signals as Record<string, unknown> : {};
  const threshold = signals.autonomy_threshold;
  return typeof threshold === "number" && Number.isFinite(threshold) ? Math.min(1, Math.max(0, threshold)) : 0.5;
};

// targetSurfaceRisk — RLM-first autonomy-risk for the change's target
// surfaces. repo:runtime/, repo:substrate/, and repo:cli/ are the
// high-leverage surfaces the autonomy envelope must guard most tightly.
const targetSurfaceRisk = (targets: readonly string[]): number => {
  let risk = 0;
  for (const resource of targets) {
    if (/^repo:(runtime|substrate|cli)\//.test(resource)) risk = Math.max(risk, 0.5);
    else if (resource.startsWith("repo:")) risk = Math.max(risk, 0.2);
  }
  return risk;
};

// ownerAlignmentProfileContext — single owner_profile_view read returning the
// autonomy threshold and any things_to_never_do hard-constraint hit. The
// hard-constraint match runs against the change's target surfaces AND the
// directive/proposal context text so an owner rule like "never touch billing"
// blocks even when the file path does not literally contain the rule string.
// Fail-open: substrate read failure yields the default 0.5 threshold and no
// constraint hit (matches the prior evaluators' fail-open contract).
const ownerAlignmentProfileContext = async (
  targets: readonly string[],
  contextText: string,
): Promise<{ ok: boolean; threshold: number; hardConstraintHit: string | null }> => {
  const env = await mcpCall("substrate.read", { view_name: "owner_profile_view" });
  if (!env.ok) return { ok: false, threshold: 0.5, hardConstraintHit: null };
  const row = Array.isArray(env.result) ? (env.result[0] as { payload?: unknown } | undefined) : undefined;
  const payload = parsePayload(row?.payload);
  const signals = payload.autonomy_signals && typeof payload.autonomy_signals === "object" ? payload.autonomy_signals as Record<string, unknown> : {};
  const rawThreshold = signals.autonomy_threshold;
  const threshold = typeof rawThreshold === "number" && Number.isFinite(rawThreshold) ? Math.min(1, Math.max(0, rawThreshold)) : 0.5;

  const normalizedTargets = targets.map(normalizePolicyTarget).filter(Boolean);
  const normalizedContext = contextText.toLowerCase();
  const rules = Array.isArray(payload.things_to_never_do) ? payload.things_to_never_do : [];
  let hardConstraintHit: string | null = null;
  for (const raw of rules) {
    if (typeof raw !== "string") continue;
    const rule = raw.toLowerCase();
    let hit = false;
    for (const target of normalizedTargets) {
      const basename = target.split("/").pop() ?? target;
      if (rule.includes(target) || (basename.length > 0 && rule.includes(basename)) || normalizedContext.includes(rule)) { hit = true; break; }
    }
    if (!hit && normalizedTargets.length === 0 && normalizedContext.includes(rule)) hit = true;
    if (hit) { hardConstraintHit = raw; break; }
  }
  return { ok: true, threshold, hardConstraintHit };
};

// gateAutonomousCommitByOwnerAlignment — the ONE owner-alignment gate. It
// reads owner_profile_view, computes a single owner_alignment residual
// (max of the upstream change/precondition residual and the target-surface
// autonomy risk), and blocks (route -> OWNER_GATE) when the change plausibly
// violates things_to_never_do OR the residual exceeds the owner autonomy
// threshold; otherwise it returns the decision unchanged. Fail-open on
// substrate read failure (residual 0). This single check replaced the 7 soft
// rule-based heuristics (goal-drift, delegation-safety, metacognitive-policy,
// continual-state, outcome-forecast, rendering, theory-of-mind).
const gateAutonomousCommitByOwnerAlignment = async (
  decision: ApplyRouteDecision,
  payload: Record<string, unknown>,
  targets: readonly string[],
): Promise<ApplyRouteDecision> => {
  const contextText = JSON.stringify({
    intent: payload.intent,
    proposal: payload.proposed_behavior ?? payload.proposed_action ?? payload,
    owner_visible_text: payload.owner_visible_text,
  });
  const profile = await ownerAlignmentProfileContext(targets, contextText);
  if (!profile.ok) {
    // Fail-open: substrate read failed; residual 0, no constraint hit.
    const alignment = applyEvaluators.evaluateOwnerAlignment({
      change_residual: 0,
      autonomy_threshold: profile.threshold,
      hard_constraint_hit: null,
      target_surface_risk: 0,
    });
    if (alignment.verdict === "aligned") return decision;
    // verdict can only be misaligned here if an injected evaluator forces it.
  }

  const changeResidual = Math.min(1, Math.max(0, 1 - decision.score));
  const alignment = applyEvaluators.evaluateOwnerAlignment({
    change_residual: changeResidual,
    autonomy_threshold: profile.threshold,
    hard_constraint_hit: profile.hardConstraintHit,
    target_surface_risk: targetSurfaceRisk(targets),
  });
  if (alignment.verdict === "aligned") return decision;
  return {
    route: "OWNER_GATE",
    score: 1,
    confidence: 0.85,
    deterministic: false,
    reason: "owner_alignment_predicate",
    preconditions: {
      ...decision.preconditions,
      owner_alignment_residual: alignment.residual,
      owner_alignment_verdict: alignment.verdict,
      owner_alignment_hard_constraint_hit: alignment.hard_constraint_hit,
      owner_alignment_autonomy_threshold: profile.threshold,
      owner_alignment_breakdown: alignment.breakdown,
      owner_alignment_reasons: alignment.reasons,
      reconciliation_required: true,
    },
  };
};

const orchestratorPredicateRoute = (recommended: string): ApplyRoute => {
  switch (recommended) {
    case "NEEDS_BRAIN_RECYCLE": return "NEEDS_BRAIN_RECYCLE";
    case "OWNER_GATE": return "OWNER_GATE";
    case "AUTO_APPLY":
    default:
      return "AUTO_APPLY";
  }
};

// subPredicateResultsFromDecision — projects the single owner_alignment
// signal for the orchestrator predicate. The 7 rule-based sub-predicates were
// collapsed into one owner_alignment boundary (clean break).
const subPredicateResultsFromDecision = (decision: ApplyRouteDecision): Record<string, { name: string; residual: unknown; verdict?: string; reasons?: string[]; breakdown?: Record<string, unknown> }> => ({
  owner_alignment: {
    name: "owner_alignment",
    residual: decision.preconditions.owner_alignment_residual ?? 0,
    verdict: typeof decision.preconditions.owner_alignment_verdict === "string" ? decision.preconditions.owner_alignment_verdict : "aligned",
    reasons: Array.isArray(decision.preconditions.owner_alignment_reasons) ? decision.preconditions.owner_alignment_reasons as string[] : [],
    breakdown: decision.preconditions.owner_alignment_breakdown && typeof decision.preconditions.owner_alignment_breakdown === "object" ? decision.preconditions.owner_alignment_breakdown as Record<string, unknown> : {},
  },
});

const evaluateAutonomousCommitOrchestratorPredicate = async (
  decision: ApplyRouteDecision,
  payload: Record<string, unknown>,
  targets: readonly string[],
) => {
  try {
    const { evaluateOrchestratorPredicate } = await import("../runtime/orchestrator_predicate");
    return evaluateOrchestratorPredicate({
      candidate_route: decision.route,
      proposed_action: {
        intent: typeof payload.intent === "string" ? payload.intent : undefined,
        summary: JSON.stringify(payload.proposed_behavior ?? payload.proposed_action ?? payload),
        target_resources: [...targets],
        reversible: true,
        risk: decision.score < 0.7 ? 0.5 : payload.risk,
        novelty: payload.classification === "novel" ? 0.8 : payload.novelty,
      },
      sub_predicate_results: subPredicateResultsFromDecision(decision),
      candidate_orchestration: {
        boundary_order: ["owner_alignment"],
        selected_boundaries: ["owner_alignment"],
      },
    });
  } catch {
    return { residual: 0, verdict: "aligned" as const, recommended_route: "AUTO_APPLY" as const, breakdown: { substrate_read_failed_open: 0 }, reasons: ["substrate_read_failed_open"] };
  }
};

const gateAutonomousCommitByOrchestratorPredicate = async (
  decision: ApplyRouteDecision,
  payload: Record<string, unknown>,
  targets: readonly string[],
): Promise<ApplyRouteDecision> => {
  const orchestrator = await evaluateAutonomousCommitOrchestratorPredicate(decision, payload, targets);
  if (orchestrator.residual < 0.6 && orchestrator.recommended_route === "AUTO_APPLY") return decision;
  return {
    route: orchestratorPredicateRoute(orchestrator.recommended_route),
    score: 1,
    confidence: 0.85,
    deterministic: false,
    reason: "orchestrator_predicate",
    preconditions: {
      ...decision.preconditions,
      orchestrator_predicate_residual: orchestrator.residual,
      orchestrator_predicate_verdict: orchestrator.verdict,
      orchestrator_predicate_recommended_route: orchestrator.recommended_route,
      orchestrator_predicate_breakdown: orchestrator.breakdown,
      orchestrator_predicate_reasons: orchestrator.reasons,
    },
  };
};

const gateAutonomousCommit = async (
  decision: ApplyRouteDecision,
  payload: Record<string, unknown>,
  target: string,
  targets: readonly string[],
): Promise<ApplyRouteDecision> => {
  // ONE owner-alignment gate (clean break, RLM-first) replaces the prior 7
  // rule-based heuristics; orchestrator_predicate (orchestration, not
  // owner-alignment) stays as the final gate.
  const alignmentDecision = await gateAutonomousCommitByOwnerAlignment(decision, payload, targets);
  if (alignmentDecision.route !== "AUTO_APPLY") return alignmentDecision;
  return gateAutonomousCommitByOrchestratorPredicate(alignmentDecision, payload, targets);
};

const deterministicApplyRoute = async (
  payload: Record<string, unknown>,
  target: string,
  targets: readonly string[],
  queueRow: LessonQueueRow | null,
  ownerGateRequired: boolean,
): Promise<ApplyRouteDecision> => {
  const explicitClassification = applyRouteFromUnknown(payload.classification) ?? applyRouteFromUnknown(payload.route) ?? applyRouteFromUnknown(payload.apply_route);
  if (explicitClassification === "AUTO_DEFER_DEPENDENCY") {
    return { route: "AUTO_DEFER_DEPENDENCY", score: 1, confidence: 1, deterministic: true, reason: "blocked_on_dependency", preconditions: { explicit_classification: payload.classification ?? payload.route ?? payload.apply_route } };
  }

  if (ownerGateRequired) {
    return { route: "OWNER_GATE", score: 1, confidence: 1, deterministic: true, reason: "owner_policy_requires_gate", preconditions: { owner_gate_required: true } };
  }

  // Candidate E (brain dispatch be0p341w8): if EVERY repo target on this
  // proposal resolves to a test file, emit a deterministic test_lane
  // route that bypasses owner-decision queueing. Mixed targets (one
  // test + one non-test) fall through to the existing routing.
  const repoTargetFiles = targets
    .map(repoFileFromResource)
    .filter((f): f is string => typeof f === "string" && f.length > 0);
  if (repoTargetFiles.length > 0 && repoTargetFiles.length === targets.length && repoTargetFiles.every(isRepoTestFile)) {
    return {
      route: "AUTO_APPLY_TEST_LANE",
      score: 1,
      confidence: 1,
      deterministic: true,
      reason: "test_lane_target",
      preconditions: { test_lane: true, repo_target: true, target_files: repoTargetFiles },
    };
  }

  const manualPattern = await ownerProfileManualReviewMatch(targets);
  if (manualPattern) {
    return { route: "OWNER_GATE", score: 1, confidence: 1, deterministic: true, reason: "owner_manual_review_pattern", preconditions: { manual_review_pattern: manualPattern } };
  }

  const file = repoFileFromResource(target);
  if (!file) {
    return { route: "NEEDS_BRAIN_RECYCLE", score: 0, confidence: 0.7, deterministic: true, reason: "non_repo_target", preconditions: { repo_target: false } };
  }
  const abs = resolve(process.cwd(), file);
  if (!existsSync(abs)) {
    return { route: "AUTO_DECLINE_TARGET_MISSING", score: 1, confidence: 1, deterministic: true, reason: "target_file_missing", preconditions: { target_file_exists: false, file } };
  }

  const diff = anchoredReplaceDiff(payload);
  if (!diff) {
    return { route: "AUTO_DECLINE_PROSE_ONLY", score: 1, confidence: 1, deterministic: true, reason: "anchored_replace_v1_required", preconditions: { diff_well_formed: false, target_file_exists: true } };
  }

  const body = readFileSync(abs, "utf8");
  const beforeCount = countOccurrences(body, diff.before);
  const afterCount = diff.after.length > 0 ? countOccurrences(body, diff.after) : 0;
  if (beforeCount === 0 && afterCount > 0) {
    return { route: "AUTO_DECLINE_ALREADY_APPLIED", score: 1, confidence: 0.95, deterministic: true, reason: "before_absent_after_present", preconditions: { anchor_found_exactly_once: false, before_count: beforeCount, after_count: afterCount } };
  }
  if (beforeCount === 0) {
    return { route: "AUTO_DECLINE_TARGET_MISSING", score: 1, confidence: 0.9, deterministic: true, reason: "before_anchor_missing", preconditions: { anchor_found_exactly_once: false, before_count: beforeCount } };
  }
  if (beforeCount !== 1) {
    return { route: "NEEDS_BRAIN_RECYCLE", score: 0.2, confidence: 0.8, deterministic: true, reason: "before_anchor_not_unique", preconditions: { anchor_found_exactly_once: false, before_count: beforeCount } };
  }

  const queuedRoute = routeFromQueue(queueRow);
  const gateResidual = typeof queueRow?.auto_apply_gate_residual === "number" ? queueRow.auto_apply_gate_residual : null;
  const posteriorScore = gateResidual == null ? 0.95 : Math.max(0, 1 - gateResidual);
  const threshold = await ownerAutonomyThreshold();
  if (queuedRoute === "AUTO_APPLY" && posteriorScore >= threshold) {
    return gateAutonomousCommit({ route: "AUTO_APPLY", score: posteriorScore, confidence: 0.8, deterministic: false, reason: "preconditions_passed_posterior_above_threshold", preconditions: { diff_well_formed: true, anchor_found_exactly_once: true, target_file_exists: true, autonomy_threshold: threshold } }, payload, target, targets);
  }
  if (queuedRoute === "OWNER_GATE") {
    return { route: "OWNER_GATE", score: posteriorScore, confidence: 0.7, deterministic: false, reason: "queue_route_owner_gate", preconditions: { diff_well_formed: true, anchor_found_exactly_once: true, target_file_exists: true } };
  }
  if (queuedRoute === null && posteriorScore >= threshold) {
    return gateAutonomousCommit({ route: "AUTO_APPLY", score: posteriorScore, confidence: 0.65, deterministic: false, reason: "preconditions_passed_local_predicate_above_threshold", preconditions: { diff_well_formed: true, anchor_found_exactly_once: true, target_file_exists: true, autonomy_threshold: threshold } }, payload, target, targets);
  }
  return { route: "NEEDS_BRAIN_RECYCLE", score: posteriorScore, confidence: 0.6, deterministic: false, reason: "posterior_missing_or_below_threshold", preconditions: { diff_well_formed: true, anchor_found_exactly_once: true, target_file_exists: true, autonomy_threshold: threshold } };
};

const boolish = (v: unknown): boolean => v === true || v === 1 || v === "1" || v === "true";

const fetchQueueRow = async (eventId: string): Promise<LessonQueueRow | null> => {
  const env = await mcpCall("substrate.read", { view_name: "lesson_implementer_queue_view" });
  if (!env.ok || !Array.isArray(env.result)) return null;
  return (env.result as LessonQueueRow[]).find((r) => r.source_event_id === eventId) ?? null;
};

const ownerConsentDecisionApproved = (payload: Record<string, unknown>): boolean =>
  payload.decision === "approve" || payload.decision === "approved" || payload.outcome === "approved";

const resolveOwnerConsentFromSubstrate = async (
  sourceEventId: string,
  directiveId: string | undefined,
  queueRow: LessonQueueRow | null,
): Promise<boolean> => {
  if (boolish(queueRow?.owner_approved)) return true;
  const env = await mcpCall("runtime.recent_events", { k: 200, kinds: ["owner_decision_recorded"] });
  const events = (env.ok ? (env.result as { events?: EventRow[] }).events : undefined) ?? [];
  return events.some((row) => {
    const payload = parsePayload(row.payload);
    if (!ownerConsentDecisionApproved(payload)) return false;
    if (payload.source_event_id === sourceEventId) return true;
    if (Array.isArray(row.context_refs) && row.context_refs.includes(sourceEventId)) return true;
    if (!directiveId) return false;
    return payload.directive_id === directiveId || (payload.source_event_id === undefined && row.directive_id === directiveId);
  });
};

const normalizePolicyTarget = (target: string): string => {
  const trimmed = target.trim();
  return (trimmed.startsWith("repo:") ? trimmed.slice(5) : trimmed).replace(/^\.\//, "").toLowerCase();
};

const ownerProfileThingsToNeverDoBlock = async (targets: readonly string[]): Promise<string | null> => {
  const normalizedTargets = targets.map(normalizePolicyTarget).filter(Boolean);
  if (normalizedTargets.length === 0) return null;
  const env = await mcpCall("substrate.read", { view_name: "owner_profile_view" });
  const row = env.ok && Array.isArray(env.result) ? (env.result[0] as { payload?: unknown } | undefined) : undefined;
  const payload = parsePayload(row?.payload);
  const rules = Array.isArray(payload.things_to_never_do) ? payload.things_to_never_do : [];
  for (const raw of rules) {
    if (typeof raw !== "string") continue;
    const rule = raw.toLowerCase();
    for (const target of normalizedTargets) {
      const basename = target.split("/").pop() ?? target;
      if (rule.includes(target) || (basename.length > 0 && rule.includes(basename))) return raw;
    }
  }
  return null;
};

const structuredChangeProposal = (payload: Record<string, unknown>, target: string): boolean => {
  const proposed = payload.proposed_behavior ?? payload.proposed_action;
  if (!proposed || typeof proposed !== "object") return false;
  const p = proposed as Record<string, unknown>;
  return proposalTargetsPayloadTarget(p, target)
    && typeof p.anchor === "string"
    && p.anchor.trim().length > 0
    && structuredDiff(p.diff);
};

const proposalText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return JSON.stringify(value);
  return "";
};

const proposedChangeFields = (
  payload: Record<string, unknown>,
): { sourceField: "proposed_behavior" | "proposed_action"; proposal: Record<string, unknown> } | null => {
  for (const sourceField of ["proposed_behavior", "proposed_action"] as const) {
    const proposal = payload[sourceField];
    if (proposal && typeof proposal === "object" && !Array.isArray(proposal)) {
      return { sourceField, proposal: proposal as Record<string, unknown> };
    }
  }
  return null;
};

const formatPromptValue = (value: unknown): string => {
  if (value === undefined || value === null || value === "") return "(missing)";
  return typeof value === "string" ? value : JSON.stringify(value);
};

const renderStructuredProposalBlock = (payload: Record<string, unknown>): string => {
  const structured = proposedChangeFields(payload);
  if (!structured) {
    const fallback = proposalText(payload.proposed_behavior) || proposalText(payload.proposed_action);
    return [
      `STRUCTURED PROPOSED CHANGE`,
      `  status: unstructured`,
      fallback ? `  proposal_text: ${JSON.stringify(fallback)}` : `  proposal_text: (missing)`,
    ].join("\n");
  }

  const { sourceField, proposal } = structured;
  return [
    `STRUCTURED PROPOSED CHANGE`,
    `  source_field: ${sourceField}`,
    `  target_resource: ${formatPromptValue(proposal.target_resource ?? proposal.resource_uri ?? proposal.target ?? (typeof proposal.file_path === "string" ? "repo:" + proposal.file_path : undefined))}`,
    `  anchor:          ${formatPromptValue(proposal.anchor)}`,
    `  diff:`,
    `\`\`\`diff`,
    typeof proposal.diff === "string" ? proposal.diff : JSON.stringify(proposal.diff ?? ""),
    `\`\`\``,
  ].join("\n");
};

const renderGateBlock = (
  payload: Record<string, unknown>,
  auth: ApplyAuthorization,
  policy: ReturnType<typeof lessonApplyTargetsPolicy>,
): string => {
  const hazardCount = Number(auth.queueRow?.trajectory_hazard_count ?? 0);
  const structured = structuredChangeProposal(payload, auth.target);
  return [
    `APPLY GATES`,
    `  owner_gate.required: ${auth.ownerGateRequired}`,
    `  owner_gate.approved: ${auth.ownerApproved}`,
    `  owner_gate.rule: dynamic owner_profile.things_to_never_do entries can require explicit owner approval; static path enumeration is not policy.`,
    `  cli_runtime_gate.target_in_scope: ${policy.autoApplyTarget}`,
    `  cli_runtime_gate.rule: repo:cli/* and repo:runtime/* may auto-apply only with structured {target_resource, anchor, diff:{kind:\"anchored_replace_v1\", before, after}}, verifier residual < 0.3, and no dispatcher_violation or irreversible_effect_recorded in the trajectory.`,
    `  cli_runtime_gate.structured_change: ${structured || !policy.autoApplyTarget}`,
    `  cli_runtime_gate.trajectory_hazard_count: ${hazardCount}`,
  ].join("\n");
};

const emitApplyGateEvaluation = async (
  ev: EventRow,
  eventId: string,
  args: {
    target: string;
    status: "approved" | "denied";
    reason?: string;
    ownerGateRequired: boolean;
    ownerApproved: boolean;
    autoApplyTarget: boolean;
    routeDecision?: ApplyRouteDecision;
  },
): Promise<{ actionEventId?: string; scoredEventId?: string; residual: number }> => {
  const residual = args.status === "approved" ? 0 : 1;
  const actionEnv = await mcpCall("substrate.emit", {
    kind: "action_predicted",
    substrate_origin: "claude_root",
    directive_id: ev.directive_id,
    task_id: ev.task_id,
    context_refs: [eventId],
    action_artifact_id: DEFAULT_APPLY_GATE_ACTION_ARTIFACT_ID,
    verifier_artifact_id: DEFAULT_APPLY_GATE_VERIFIER_ARTIFACT_ID,
    predicted_residual: args.status === "approved" ? 0.05 : 0.95,
    payload: {
      intent: "Evaluate owner/auto gate for applying a substrate-emitted lesson or contract amendment.",
      source_event_id: eventId,
      source_kind: ev.kind,
      target: args.target,
      authorization_status: args.status,
      reason: args.reason,
      owner_gate_required: args.ownerGateRequired,
      owner_approved: args.ownerApproved,
      auto_apply_target: args.autoApplyTarget,
      apply_route: args.routeDecision?.route,
      apply_route_score: args.routeDecision?.score,
      apply_route_confidence: args.routeDecision?.confidence,
      apply_route_deterministic: args.routeDecision?.deterministic,
      apply_route_reason: args.routeDecision?.reason,
      apply_route_preconditions: args.routeDecision?.preconditions,
      design_citations: ["v2-design.md §3", "v2-design.md §6", "v2-design.md §7", "v2-design.md §11.5", "v2-design.md §15"],
    },
  });
  if (!actionEnv.ok) throw new Error(`gate action_predicted emit failed - ${actionEnv.error}`);
  const actionEventId = (actionEnv.result as { id?: string })?.id;

  const scoredEnv = await mcpCall("substrate.emit", {
    kind: "action_scored",
    substrate_origin: "claude_root",
    directive_id: ev.directive_id,
    task_id: ev.task_id,
    context_refs: [eventId, actionEventId].filter(Boolean),
    action_artifact_id: DEFAULT_APPLY_GATE_ACTION_ARTIFACT_ID,
    verifier_artifact_id: DEFAULT_APPLY_GATE_VERIFIER_ARTIFACT_ID,
    outcome: args.status,
    residual,
    payload: {
      source_event_id: eventId,
      source_kind: ev.kind,
      action_event_id: actionEventId,
      target: args.target,
      authorization_status: args.status,
      reason: args.reason,
      owner_gate_required: args.ownerGateRequired,
      owner_approved: args.ownerApproved,
      auto_apply_target: args.autoApplyTarget,
      apply_route: args.routeDecision?.route,
      apply_route_score: args.routeDecision?.score,
      apply_route_confidence: args.routeDecision?.confidence,
      apply_route_deterministic: args.routeDecision?.deterministic,
      apply_route_reason: args.routeDecision?.reason,
      apply_route_preconditions: args.routeDecision?.preconditions,
    },
  });
  if (!scoredEnv.ok) throw new Error(`gate action_scored emit failed - ${scoredEnv.error}`);
  return { actionEventId, scoredEventId: (scoredEnv.result as { id?: string })?.id, residual };
};

const emitApplyDenied = async (
  ev: EventRow,
  eventId: string,
  reason: string,
  target: string,
  gate: { ownerGateRequired: boolean; ownerApproved: boolean; autoApplyTarget: boolean },
  routeDecision?: ApplyRouteDecision,
): Promise<number> => {
  let gateActionEventId: string | undefined;
  let gateScoredEventId: string | undefined;
  try {
    const gateEval = await emitApplyGateEvaluation(ev, eventId, {
      target,
      status: "denied",
      reason,
      ...gate,
      routeDecision,
    });
    gateActionEventId = gateEval.actionEventId;
    gateScoredEventId = gateEval.scoredEventId;
  } catch (err) {
    console.error(`acc apply: ${(err as Error).message}`);
    return 1;
  }
  const env = await mcpCall("substrate.emit", {
    kind: "lesson_apply_requested",
    substrate_origin: "claude_root",
    directive_id: ev.directive_id,
    task_id: ev.task_id,
    context_refs: [eventId, gateActionEventId, gateScoredEventId].filter(Boolean),
    payload: {
      source_event_id: eventId,
      source_kind: ev.kind,
      target,
      authorization_status: "denied",
      reason,
      gate_action_event_id: gateActionEventId,
      gate_scored_event_id: gateScoredEventId,
      gate_residual: 1,
      owner_gate_required: gate.ownerGateRequired,
      owner_approved: gate.ownerApproved,
      auto_apply_target: gate.autoApplyTarget,
      apply_route: routeDecision?.route,
      apply_route_score: routeDecision?.score,
      apply_route_confidence: routeDecision?.confidence,
      apply_route_reason: routeDecision?.reason,
      design_citations: ["v2-design.md §3", "v2-design.md §6", "v2-design.md §7", "v2-design.md §11.5", "v2-design.md §15"],
    },
  });
  if (!env.ok) {
    console.error(`acc apply: authorization denial emit failed - ${env.error}`);
    return 1;
  }
  console.error(`acc apply: authorization denied - ${reason}`);
  return 1;
};

const authorizeApply = async (
  ev: EventRow,
  eventId: string,
  opts: { target?: string; status?: string },
): Promise<ApplyAuthorization | { ok: false; code: number }> => {
  const payload = parsePayload(ev.payload);
  const target = opts.target || targetFromPayload(payload);
  const targets = [...new Set(
    [...targetCandidatesFromPayload(payload), opts.target]
      .filter((t): t is string => typeof t === "string" && t.trim().length > 0),
  )];
  const queueRow = await fetchQueueRow(eventId);
  const kind = ev.kind ?? "";
  if (kind !== "lesson_extracted" && kind !== "contract_amendment_proposed") {
    console.error(`acc apply: event ${eventId} is ${kind}, not lesson_extracted or contract_amendment_proposed`);
    return { ok: false, code: 1 };
  }
  const policy = lessonApplyTargetsPolicy(targets);
  const ownerApproved = await resolveOwnerConsentFromSubstrate(eventId, ev.directive_id, queueRow);
  let ownerGateRequired = false;
  if (opts.status !== "refused") {
    const ownerRule = await ownerProfileThingsToNeverDoBlock(targets);
    ownerGateRequired = ownerRule !== null;
    if (ownerRule && !ownerApproved) {
      return { ok: false, code: await emitApplyDenied(ev, eventId, "owner_policy_things_to_never_do", target, {
        ownerGateRequired,
        ownerApproved,
        autoApplyTarget: policy.autoApplyTarget,
      }) };
    }
  }
  if (kind === "contract_amendment_proposed") {
    const adjudicationEnv = await mcpCall("substrate.search", {
      query: `pre_apply_adjudication_recorded target_event_id:${eventId}`,
      opts: { kind_filter: ["pre_apply_adjudication_recorded"], k: 50 },
    });
    const rawRows = adjudicationEnv.ok && Array.isArray(adjudicationEnv.result)
      ? adjudicationEnv.result
      : adjudicationEnv.ok && Array.isArray((adjudicationEnv.result as { events?: unknown[] } | null)?.events)
        ? ((adjudicationEnv.result as { events: unknown[] }).events)
        : [];
    const adjudications = rawRows
      .map((row) => parsePayload((row as EventRow).payload))
      .filter((row) => row.target_event_id === eventId);
    const hasVerdict = (verdict: string): boolean => adjudications.some((row) => row.verdict === verdict);

    if (hasVerdict("contradicts")) {
      return { ok: false, code: await emitApplyDenied(ev, eventId, "drift_detected", target, {
        ownerGateRequired,
        ownerApproved,
        autoApplyTarget: policy.autoApplyTarget,
      }) };
    }
    if (hasVerdict("corrects")) {
      return { ok: false, code: await emitApplyDenied(ev, eventId, "corrected_payload_required", target, {
        ownerGateRequired,
        ownerApproved,
        autoApplyTarget: policy.autoApplyTarget,
      }) };
    }
    if (hasVerdict("proposes_alternative")) {
      return { ok: false, code: await emitApplyDenied(ev, eventId, "adversarial_cycle_required", target, {
        ownerGateRequired,
        ownerApproved,
        autoApplyTarget: policy.autoApplyTarget,
      }) };
    }
    if (hasVerdict("escalate_to_owner")) {
      return { ok: false, code: await emitApplyDenied(ev, eventId, "owner_decision_required", target, {
        ownerGateRequired,
        ownerApproved,
        autoApplyTarget: policy.autoApplyTarget,
      }) };
    }
    if (hasVerdict("gray_zone_review")) {
      console.error("acc apply: pre-apply adjudication marked this apply tentative; record a follow-up scoring round after the subagent verifier returns");
    }
    // verdict=peer_approve and unknown open-kind verdicts do not block here;
    // unknown verdicts remain ledger evidence for future calibrated consumers.
  }

  const routeDecision = await deterministicApplyRoute(payload, target, targets, queueRow, ownerGateRequired);
  if (routeDecision.route === "OWNER_GATE" && !ownerApproved) {
    return { ok: false, code: await emitApplyDenied(ev, eventId, routeDecision.reason, target, {
      ownerGateRequired: true,
      ownerApproved,
      autoApplyTarget: policy.autoApplyTarget,
    }, routeDecision) };
  }
  if (routeDecision.route !== "AUTO_APPLY" && routeDecision.route !== "AUTO_APPLY_TEST_LANE" && routeDecision.route !== "OWNER_GATE") {
    return { ok: false, code: await emitApplyDenied(ev, eventId, routeDecision.reason, target, {
      ownerGateRequired,
      ownerApproved,
      autoApplyTarget: policy.autoApplyTarget,
    }, routeDecision) };
  }

  // Universal verifier remains the correctness scorer. Pre-apply adjudication is
  // a narrow fast-path correction surface for authoritative contradictions,
  // corrected payloads, adversarial alternatives, owner escalation, peer approval,
  // and gray-zone review before the standard apply handoff.
  return { ok: true, target, ownerGateRequired, ownerApproved, queueRow, routeDecision };
};

/** Construct the Agent subagent prompt for a lesson_extracted /
 *  contract_amendment_proposed event. The subagent reads evidence via MCP,
 *  makes the edit, runs the verifier (`bun test --bail`), commits to git,
 *  and returns a strict JSON summary the orchestrator pipes into
 *  `acc apply --record`. */
const renderSubagentPrompt = (ev: EventRow, opts: { ownerApproved?: boolean; auth: ApplyAuthorization }): string => {
  const payload = parsePayload(ev.payload);
  const kind = ev.kind ?? "?";
  const evId = ev.event_id ?? ev.id ?? "?";
  const evidenceIds = (payload.evidence_event_ids as string[] | undefined) ?? [];
  const isAmendment = kind === "contract_amendment_proposed";

  const resolvedTarget = targetFromPayload(payload);
  const target = resolvedTarget || "(unspecified — subagent must infer from summary)";
  const anchor = (payload.anchor as string | undefined) ?? "";
  const proposed = proposalText(payload.proposed_behavior) || proposalText(payload.proposed_action);
  const current = (payload.current_behavior as string | undefined) ?? "";
  const summary = (payload.summary as string | undefined) ?? "";
  const lessonKind = (payload.lesson_kind as string | undefined) ?? "";

  const policy = lessonApplyTargetsPolicy(targetCandidatesFromPayload(payload));
  const ownerGateLine = policy.autoApplyTarget
    ? `APPLY ROUTE PREDICATE — CLI/RUNTIME: proceed according to apply_route, not a brain-authored boolean. Hard preconditions run first: anchored_replace_v1 well-formed, target exists, before text appears exactly once, no owner manual-review match; posterior scoring is consulted only after those pass.`
      : `(target outside auto-apply surface — apply directly unless owner_profile.things_to_never_do blocks it)`;

  return [
    `You are a Claude Code Agent subagent running in run_in_background mode.`,
    `Your job: APPLY one substrate-emitted improvement to the AccInt v2 codebase,`,
    `then commit the change to git, and return a JSON summary.`,
    ``,
    `SOURCE EVENT`,
    `  event_id:  ${evId}`,
    `  kind:      ${kind}`,
    `  ts:        ${ev.ts ?? "?"}`,
    `  task_id:   ${ev.task_id ?? "?"}`,
    `  directive: ${ev.directive_id ?? "?"}`,
    ``,
    `EVENT PAYLOAD (verbatim, the brain's proposal):`,
    isAmendment
      ? [
          `  target:             ${target}`,
          anchor ? `  anchor:             ${anchor}` : ``,
          current ? `  current_behavior:   ${JSON.stringify(current)}` : ``,
          proposed ? `  proposed_behavior:  ${JSON.stringify(proposed)}` : ``,
        ].filter(Boolean).join("\n")
      : [
          lessonKind ? `  lesson_kind:     ${lessonKind}` : ``,
          summary ? `  summary:         ${JSON.stringify(summary)}` : ``,
          proposed ? `  proposed_action: ${JSON.stringify(proposed)}` : ``,
        ].filter(Boolean).join("\n"),
    ``,
    renderStructuredProposalBlock(payload),
    ``,
    renderGateBlock(payload, opts.auth, policy),
    ``,
    `EVIDENCE EVENT IDS (resolve via substrate.get_event before editing — they`,
    `cite the trajectory rows that led to this proposal):`,
    evidenceIds.length > 0
      ? evidenceIds.map((id) => `  - ${id}`).join("\n")
      : `  (none — proposal stands on its summary alone)`,
    ``,
    ownerGateLine,
    ``,
    `ANCHORED REPLACE PREFLIGHT`,
    `  - If STRUCTURED PROPOSED CHANGE carries diff.kind=anchored_replace_v1, read the`,
    `    target file from the current worktree before editing and search for diff.before.`,
    `  - If diff.before is not an exact substring, try a diagnostic-only normalized match`,
    `    that ignores line-ending differences and common prompt-rendering artifacts`,
    `    (escaped newlines, quote/comma delimiters from TypeScript string arrays).`,
    `  - Do not silently invent a patch from a stale anchor. If only the normalized`,
    `    diagnostic matches, make the smallest semantic edit against live source and`,
    `    report residual/breakdown.anchor_freshness; if neither exact nor normalized`,
    `    match is credible, return failed with reason=before_text_not_found_in_target`,
    `    plus the closest anchor context.`,
    ``,
    `OPERATING CONTRACT`,
    `  1. Use EXACT substrate handles, not file/log scanning, as your primary information surface.`,
    `     Resolve the SOURCE EVENT and each EVIDENCE EVENT id directly via MCP — do NOT grep`,
    `     over event history or dump 200-row windows to reconstruct context. The handles are`,
    `     already on the proposal; use them.`,
    `     If you need more context on a specific node:`,
    `       bun cli/dispatch.ts graph <directive_id>    (task DAG for one directive only)`,
    `       bun cli/dispatch.ts inspect <task_id>       (chronology for one task only)`,
    `  2. Make the SMALLEST possible edit that satisfies the proposal — no scope creep.`,
    `     Use Edit (not Write) for in-place changes. Preserve indentation + surrounding context.`,
    `  3. Run \`bun test --bail\` and confirm all tests pass before committing.`,
    `  4. Work inside the per-source-event apply worktree created from the current default-branch HEAD.`,
    `     Refuse if \`git merge-base HEAD <default-branch>\` is not that HEAD, if the inherited index`,
    `     is non-empty, or if staged/changed paths include anything outside the proposal targets.`,
    `     Only after that isolation gate passes, stage the specific edited file(s) — never`,
    `     \`git add -A\` or \`git add .\`.`,
    `  5. Commit with message:`,
    `        <lesson_kind-or-amendment>: <one-line summary>`,
    ``,
    `        Applies: ${evId}`,
    `        Evidence: ${evidenceIds.length > 0 ? evidenceIds.join(", ") : "(see source event)"}`,
    `        Co-Authored-By: Claude Agent (acc2 applier) <noreply@accint>`,
    `  6. Return ONE JSON object on stdout — nothing else. Schema:`,
    `        {`,
    `          "status":         "applied" | "failed" | "refused",`,
    `          "target":         "<repo-relative file path>",`,
    `          "commit_sha":     "<10-char sha>"  // when status=applied`,
    `          "summary":        "<one-sentence summary of the change>",`,
    `          "residual":       0,  // verifier residual in [0,1], if known`,
    `          "action_artifact_id":   "<optional substrate code artifact id>",`,
    `          "verifier_artifact_id": "<optional substrate verifier artifact id>",`,
    `          "reason":         "<failure reason>"  // when status=failed or refused`,
    `        }`,
    ``,
    `FORBIDDEN`,
    `  - DO NOT skip the test gate. \`--no-verify\` is forbidden. Hook failures get`,
    `    investigated, not bypassed.`,
    `  - DO NOT touch files outside the proposed target's scope.`,
    `  - DO NOT amend a previous commit. New commit only.`,
    `  - DO NOT push to remote. Local commit only.`,
    ``,
    `When done, return the JSON summary on stdout. The orchestrator will pipe it`,
    `into \`acc apply --record ${evId} --status <status> --commit-sha <sha> --summary <text> --residual <n>\``,
    `to emit action_predicted -> action_scored -> applied_change_committed`,
    `and an act_tuple_recorded envelope that closes the shared credit chain.`,
  ].join("\n");
};

const renderPromptCommand = async (eventId: string): Promise<number> => {
  const ev = await fetchEvent(eventId);
  if (!ev) {
    console.error(`acc apply: event ${eventId} not found in substrate`);
    return 1;
  }
  if (ev.kind !== "lesson_extracted" && ev.kind !== "contract_amendment_proposed") {
    console.error(`acc apply: event ${eventId} is ${ev.kind}, not lesson_extracted or contract_amendment_proposed`);
    return 1;
  }
  const payload = parsePayload(ev.payload);
  const auth = await authorizeApply(ev, eventId, { target: targetFromPayload(payload) });
  if (!auth.ok) return auth.code;
  let gateActionEventId: string | undefined;
  let gateScoredEventId: string | undefined;
  try {
    const gatePolicy = lessonApplyTargetsPolicy(targetCandidatesFromPayload(payload));
    const gateEval = await emitApplyGateEvaluation(ev, eventId, {
      target: auth.target || targetFromPayload(payload),
      status: "approved",
      ownerGateRequired: auth.ownerGateRequired,
      ownerApproved: auth.ownerApproved,
      autoApplyTarget: gatePolicy.autoApplyTarget,
      routeDecision: auth.routeDecision,
    });
    gateActionEventId = gateEval.actionEventId;
    gateScoredEventId = gateEval.scoredEventId;
  } catch (err) {
    console.error(`acc apply: ${(err as Error).message}`);
    return 1;
  }
  const requestEnv = await mcpCall("substrate.emit", {
    kind: "lesson_apply_requested",
    substrate_origin: "claude_root",
    directive_id: ev.directive_id,
    task_id: ev.task_id,
    context_refs: [eventId, gateActionEventId, gateScoredEventId].filter(Boolean),
    payload: {
      source_event_id: eventId,
      source_kind: ev.kind,
      owner_approved: auth.ownerApproved,
      owner_gate_required: auth.ownerGateRequired,
      gate_action_event_id: gateActionEventId,
      gate_scored_event_id: gateScoredEventId,
      gate_residual: 0,
      authorization_status: "approved",
      apply_route: auth.routeDecision.route,
      apply_route_score: auth.routeDecision.score,
      apply_route_confidence: auth.routeDecision.confidence,
      apply_route_reason: auth.routeDecision.reason,
      target: auth.target || payload.target,
      design_citations: ["v2-design.md §3", "v2-design.md §6", "v2-design.md §7", "v2-design.md §11.5", "v2-design.md §15"],
    },
  });
  if (!requestEnv.ok) {
    console.error(`acc apply: lesson_apply_requested emit failed - ${requestEnv.error}`);
    return 1;
  }
  const prompt = renderSubagentPrompt(ev, { ownerApproved: auth.ownerApproved, auth });
  console.log(prompt);
  return 0;
};

/** Outcome of recording an apply through the substrate credit chain. */
export type ApplyOutcomeResult =
  | { ok: false; reason: string; exitCode: number }
  | {
      ok: true;
      appliedKind: "applied_change_committed";
      appliedEventId: string;
      committedEventId?: string;
      residual: number;
      status: string;
      verifierPassed: boolean;
    };

/** Emit the full apply credit chain for one substrate-emitted lesson or
 *  contract amendment. Used by both the CLI (`acc apply --record`) and the
 *  daemon-side auto-apply worker (`runtime/auto_apply_worker.ts`) — one
 *  implementation guarantees both callers update posteriors and lineage
 *  identically. The four-link chain (k_555) is:
 *
 *      lesson_apply_requested → action_predicted → action_scored
 *      → applied_change_committed → contract_amendment_applied / lesson_applied
 *
 *  Returns a structured result; callers handle stdout / exit codes. */
export const recordApplyOutcome = async (opts: {
  eventId: string;
  status: string;
  commitSha?: string;
  subagentTaskId?: string;
  summary?: string;
  reason?: string;
  target?: string;
  residual?: number;
  actionArtifactId?: string;
  verifierArtifactId?: string;
}): Promise<ApplyOutcomeResult> => {
  const ev = await fetchEvent(opts.eventId);
  if (!ev) {
    return { ok: false, reason: `source event ${opts.eventId} not found`, exitCode: 1 };
  }
  const isAmendment = ev.kind === "contract_amendment_proposed";
  const status = opts.status || "applied";
  const residual = typeof opts.residual === "number" && Number.isFinite(opts.residual)
    ? Math.min(1, Math.max(0, opts.residual))
    : status === "applied" ? 0 : 1;
  const actionArtifactId = opts.actionArtifactId || DEFAULT_APPLY_ACTION_ARTIFACT_ID;
  const verifierArtifactId = opts.verifierArtifactId || DEFAULT_APPLY_VERIFIER_ARTIFACT_ID;
  const payload = parsePayload(ev.payload);
  const auth = await authorizeApply(ev, opts.eventId, { target: opts.target, status });
  if (!auth.ok) return { ok: false, reason: "authorization denied", exitCode: auth.code };
  const eventId = opts.eventId;

  // Layer 1 write-time prerequisite (owner-approved 2026-05-16 gate-deletion):
  // when status=applied + commit_sha + structured payload, verify the commit
  // exists AND touches the proposed target file. Only "missing" refuses —
  // that's a real prerequisite (no commit, or commit doesn't touch target),
  // not byte-level pedantry. Previous "drift" refusal fought the verifier
  // residual: brain payload encodes \n escapes that don't byte-match commit
  // hunk-context even when the edit is semantically identical (witnessed
  // PSWPPZMKVS5G this session). Drift is now an informational signal
  // consumed by the residual + breakdown packet, not a hard refusal.
  if (status === "applied" && opts.commitSha && isAmendment) {
    const verdict = classifyApply(payload, opts.commitSha, process.cwd());
    if (verdict === "missing") {
      console.error(`acc apply --record: refusing status=applied — commit ${opts.commitSha} either does not exist or does not touch the proposed target.`);
      console.error(`  correct the commit + retry, or use --status failed.`);
      return { ok: false, reason: `apply_diff_mismatch:${verdict}`, exitCode: 3 };
    }
  }

  const target = auth.target || opts.target;
  const { affectedResources, affectedFiles } = affectedTargetsFromPayload(payload, target);
  const sourceBrainEventId = eventId;
  const applyActorOrigin = opts.subagentTaskId ? "claude_subagent" : "claude_root";
  let gateActionEventId: string | undefined;
  let gateScoredEventId: string | undefined;
  try {
    const gatePolicy = lessonApplyTargetsPolicy(opts.target ? [opts.target] : targetCandidatesFromPayload(payload));
    const gateEval = await emitApplyGateEvaluation(ev, eventId, {
      target: target || targetFromPayload(payload),
      status: "approved",
      ownerGateRequired: auth.ownerGateRequired,
      ownerApproved: auth.ownerApproved,
      autoApplyTarget: gatePolicy.autoApplyTarget,
      routeDecision: auth.routeDecision,
    });
    gateActionEventId = gateEval.actionEventId;
    gateScoredEventId = gateEval.scoredEventId;
  } catch (err) {
    return { ok: false, reason: (err as Error).message, exitCode: 1 };
  }

  const requestEnv = await mcpCall("substrate.emit", {
    kind: "lesson_apply_requested",
    substrate_origin: "claude_root",
    directive_id: ev.directive_id,
    task_id: ev.task_id,
    context_refs: [eventId, gateActionEventId, gateScoredEventId].filter(Boolean),
    payload: {
      source_event_id: eventId,
      source_kind: ev.kind,
      status,
      target,
      owner_gate_checked: true,
      owner_gate_required: auth.ownerGateRequired,
      owner_approved: auth.ownerApproved,
      gate_action_event_id: gateActionEventId,
      gate_scored_event_id: gateScoredEventId,
      gate_residual: 0,
      authorization_status: "approved",
      design_citations: ["v2-design.md §3", "v2-design.md §6", "v2-design.md §7", "v2-design.md §11.5", "v2-design.md §15"],
    },
  });
  if (!requestEnv.ok) {
    return { ok: false, reason: `lesson_apply_requested emit failed - ${requestEnv.error}`, exitCode: 1 };
  }
  const requestEventId = (requestEnv.result as { id?: string })?.id;

  // FINDING 4 (brain amendment 7D4VK9EYJX63V0K2WD40VXT5WG): a single
  // act_tuple_recorded envelope replaces the 5 explicit emits the
  // pre-fix flow used (action_predicted, action_scored,
  // candidate_contradicted, substrate.credit, applied_change_committed).
  // The substrate-side projection in runtime/events.ts:projectActTupleRecorded
  // expands the envelope into all of those rows automatically. With
  // payload.source_event_id set on the act_tuple, the projection
  // payloads also carry source_event_id so lesson_implementation_status_view
  // can join projected action_predicted / action_scored / commit rows
  // by the original proposal id.
  const verifierPassed = status === "applied" && residual < 0.3;
  let actTupleEventId: string;
  try {
    const actTuple = await emitActTupleViaMcp(mcpCall, {
      substrateOrigin: applyActorOrigin,
      directiveId: ev.directive_id,
      taskId: ev.task_id,
      intent: "Apply a substrate-emitted lesson or contract amendment as a committed code change.",
      reasoningSummary: opts.reason || opts.summary || "Claude apply recorded the verified outcome for one proposal as a coherent act.",
      actionSummary: `Apply outcome recorded for ${ev.kind} ${eventId}`,
      effectSummary: opts.summary || status,
      verifierKind: "claude_apply_record",
      predictedResidual: 0.2,
      residual,
      outcome: residual < 0.3 ? "succeeded" : "failed",
      actionArtifactId,
      verifierArtifactId,
      affectedResources,
      citedKnowledgeIds: [eventId],
      citedArtifactIds: [actionArtifactId, verifierArtifactId],
      sourceEventId: eventId,
      contextRefs: [eventId, requestEventId].filter(Boolean) as string[],
      derivedEventIds: [requestEventId].filter(Boolean) as string[],
      extra: {
        co_actors: [
          "claude_root",
          opts.subagentTaskId ? `claude_subagent:${opts.subagentTaskId}` : "claude_inline",
          sourceBrainEventId ? "opencode_brain" : null,
        ].filter((actor): actor is string => typeof actor === "string" && actor.length > 0),
        source_kind: ev.kind ?? null,
        source_brain_event_id: sourceBrainEventId,
        request_event_id: requestEventId ?? null,
        authorization_event_id: requestEventId ?? null,
        target,
        affected_files: affectedFiles,
        status,
        verifier_passed: verifierPassed,
        commit_sha: opts.commitSha ?? null,
        subagent_task_id: opts.subagentTaskId ?? null,
        reason: opts.reason ?? null,
        owner_gate_checked: true,
        owner_gate_required: auth.ownerGateRequired,
        owner_approved: auth.ownerApproved,
        authorization_status: "approved",
        is_amendment: isAmendment,
        applied_at: new Date().toISOString(),
        design_citations: ["v2-design.md §3", "v2-design.md §6", "v2-design.md §7", "v2-design.md §11.5", "v2-design.md §15"],
      },
    });
    actTupleEventId = actTuple.id;
  } catch (err) {
    return { ok: false, reason: `act_tuple_recorded emit failed - ${(err as Error).message}`, exitCode: 1 };
  }
  return {
    ok: true,
    appliedKind: "applied_change_committed",
    appliedEventId: actTupleEventId,
    committedEventId: actTupleEventId,
    residual,
    status,
    verifierPassed,
  };
};

/** CLI wrapper for `acc apply --record`. Calls recordApplyOutcome and
 *  prints the stdout summary lines the operator expects, returning the
 *  appropriate exit code. */
const recordApply = async (
  eventId: string,
  opts: {
    status: string;
    commitSha?: string;
    subagentTaskId?: string;
    summary?: string;
    reason?: string;
    target?: string;
    residual?: number;
    actionArtifactId?: string;
    verifierArtifactId?: string;
  },
): Promise<number> => {
  const result = await recordApplyOutcome({ eventId, ...opts });
  if (!result.ok) {
    console.error(`acc apply --record: ${result.reason}`);
    return result.exitCode;
  }
  // Audit #3 collapse: applied_change_committed now ALWAYS emits, carrying
  // status + verifier_passed in payload. Single CLI line replaces the prior
  // dual emit (applied_change_committed + lesson_applied/contract_amendment_applied).
  const verifierTag = result.verifierPassed ? "verifier_passed" : "verifier_failed";
  console.log(`applied_change_committed ${result.committedEventId} residual=${result.residual} status=${result.status} ${verifierTag} (source=${eventId.slice(0, 12)})`);
  return result.status === "applied" && !result.verifierPassed ? 1 : 0;
};

export const runApply = async (argv: string[]): Promise<number> => {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || flags.h || (positional.length === 0 && !flags.record)) {
    console.log("acc apply <event_id>");
    console.log("        Render the subagent prompt for applying the event. Owner consent is read only from owner_decision_recorded events scoped to the source event or directive.");
    console.log("acc apply --record <event_id> --status applied|failed|refused");
    console.log("                  [--commit-sha X] [--subagent-task-id Y]");
    console.log("                  [--summary Z] [--reason W] [--target FILE] [--residual N]");
    console.log("                  [--action-artifact-id A] [--verifier-artifact-id V]");
    console.log("        Emit lesson_apply_requested plus one act_tuple_recorded; substrate projections write action/action_scored/applied_change_committed.");
    return positional.length === 0 ? 1 : 0;
  }
  const eventId = (typeof flags.record === "string" ? flags.record : positional[0]) ?? "";
  if (!eventId) {
    console.error("acc apply: requires <event_id>");
    return 1;
  }
  if (flags.record) {
    const status = typeof flags.status === "string" ? flags.status : "applied";
    return recordApply(eventId, {
      status,
      commitSha: typeof flags["commit-sha"] === "string" ? flags["commit-sha"] : undefined,
      subagentTaskId: typeof flags["subagent-task-id"] === "string" ? flags["subagent-task-id"] : undefined,
      summary: typeof flags.summary === "string" ? flags.summary : undefined,
      reason: typeof flags.reason === "string" ? flags.reason : undefined,
      target: typeof flags.target === "string" ? flags.target : undefined,
      residual: typeof flags.residual === "string" ? Number(flags.residual) : undefined,
      actionArtifactId: typeof flags["action-artifact-id"] === "string" ? flags["action-artifact-id"] : undefined,
      verifierArtifactId: typeof flags["verifier-artifact-id"] === "string" ? flags["verifier-artifact-id"] : undefined,
    });
  }
  return renderPromptCommand(eventId);
};

if (import.meta.main) {
  void runApply(process.argv.slice(2)).then((code) => process.exit(code));
}
