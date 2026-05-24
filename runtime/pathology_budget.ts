// acc2 unified pathology budget (brain elegance bc8je5f3x, 2026-05-15).
//
// Pre-fix the substrate carried six backpressure mechanisms — each with
// its own thresholds, retry counter, and emit shape:
//   - bridge_failure_streak (global, bridge_health_degraded gate)
//   - consecutive_bridge_failures (per-task, task_scheduler cap)
//   - supervisor_redispatch_storm (per-task, 10 redispatches in 5min)
//   - dispatch_budget_exceeded (per-directive, 50 brain_dispatched rows)
//   - ready_starvation (per-task, 2h ready without progress)
//   - bridge_health_degraded (per-substrate, 3 failures in 60s)
//
// These are SYMPTOMS of the same condition: "this directive is consuming
// scheduler attention without converging". The unified pathology budget
// makes the condition first-class:
//
//   1. Every existing detector still emits its canonical event.
//   2. Each detector ALSO calls debit(directive_id, pathology_kind, weight,
//      evidence_event_id) — recorded as pathology_budget_debited.
//   3. The supervisor's tick (or any caller) invokes
//      maybeExhaustPathologyBudget(directive_id) to sum recent debits.
//   4. When the sum crosses PATHOLOGY_BUDGET_THRESHOLD inside the
//      PATHOLOGY_BUDGET_WINDOW_MS window, one canonical
//      pathology_budget_exhausted event fires with every contributing
//      pathology enumerated — operators see ONE archive signal instead
//      of six scattered alarms.
//
// Weights reflect severity: a bridge_health_degraded carries higher weight
// than a single ready_starvation because the former is a substrate-wide
// blocker while the latter is one stalled task. Operators can override
// via ACC2_PATHOLOGY_WEIGHT_<KIND>.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { emitEvent } from "./events";

/** Window over which pathology debits accumulate toward exhaustion. 30
 *  min lets transient blips age out while keeping repeated pathologies
 *  visible to the gate. Universal value pending f13 adaptive scoring. */
export const PATHOLOGY_BUDGET_WINDOW_MS = 30 * 60 * 1000;

/** Accumulated weight in PATHOLOGY_BUDGET_WINDOW_MS that fires
 *  pathology_budget_exhausted. 10 with default weights = roughly 5 single
 *  symptoms or 2-3 substrate-wide blockers. Universal value pending f13
 *  adaptive scoring on observed pathology-debit/recovery correlation. */
export const PATHOLOGY_BUDGET_THRESHOLD = 10;

/** Canonical pathology kind taxonomy. Each kind maps to a default weight
 *  reflecting "how much scheduler attention is this directive consuming
 *  without converging". Heavier = closer to "we should stop dispatching". */
export type PathologyKind =
  | "bridge_failure_streak"
  | "consecutive_bridge_failures"
  | "redispatch_storm"
  | "dispatch_budget_exceeded"
  | "ready_starvation"
  | "bridge_health_degraded"
  | "verifier_residual_high"
  | "dag_explosion"
  // Supervisor stuck-task detector (2026-05-17): brain emits the SAME
  // (task_id, action_artifact_id) action_predicted N+ times within a
  // window without the task committing. Live evidence: ACTTUPLE03C_CREDIT
  // emitted 13 action_predicted with action_artifact_id="opencode_brain
  // _exit_action" over ~12 minutes — brain stuck restating the same
  // unimplementable action because it has no checkout-mutation lane.
  // Weight 3 — same severity as a dag_explosion (both are "brain is
  // looping without converging" signals).
  | "brain_stuck_repeating_action"
  // Supervisor no-closure-progress detector: a directive's tasks keep
  // re-dispatching closure audits without the closure_residual ever
  // dropping below threshold — the loop spins without converging.
  // Weight 3 — same severity class as the other non-convergence signals.
  | "no_closure_progress_loop";

const DEFAULT_WEIGHTS: Record<PathologyKind, number> = {
  bridge_failure_streak: 3,
  consecutive_bridge_failures: 2,
  redispatch_storm: 4,
  dispatch_budget_exceeded: 5,
  ready_starvation: 1,
  bridge_health_degraded: 4,
  verifier_residual_high: 1,
  dag_explosion: 3,
  brain_stuck_repeating_action: 3,
  no_closure_progress_loop: 3,
};

const envWeight = (kind: PathologyKind): number => {
  const raw = process.env[`ACC2_PATHOLOGY_WEIGHT_${kind.toUpperCase()}`];
  if (!raw) return DEFAULT_WEIGHTS[kind];
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WEIGHTS[kind];
};

export type DebitInput = {
  directive_id: string;
  pathology_kind: PathologyKind;
  /** Optional explicit weight; falls back to DEFAULT_WEIGHTS / env. */
  weight?: number;
  /** Source event id (e.g. the bridge_failed / supervisor_intervention_recorded
   *  row that triggered the debit). Used for the credit chain. */
  evidence_event_id?: string;
  /** Worker that produced the debit — supervisor / scheduler / bridge_health. */
  source_worker?: string;
  /** Optional task id when the pathology is task-scoped. */
  task_id?: string;
};

/** Record a pathology debit against a directive. Emits one
 *  pathology_budget_debited event. Idempotent at the event level — the
 *  caller is responsible for not calling debit() in a tight loop for the
 *  same evidence; supervisor/scheduler already deduplicate via their
 *  own gating logic. */
export const debit = (db: Database, input: DebitInput): { id: string; ts: string } => {
  const weight = input.weight ?? envWeight(input.pathology_kind);
  const payload: JsonValue = {
    pathology_kind: input.pathology_kind,
    weight,
    source_worker: input.source_worker ?? null,
    evidence_event_id: input.evidence_event_id ?? null,
  };
  return emitEvent(db, {
    kind: "pathology_budget_debited",
    substrate_origin: "substrate_auto",
    directive_id: input.directive_id,
    task_id: input.task_id,
    payload,
    context_refs: input.evidence_event_id ? [input.evidence_event_id] : undefined,
  });
};

export type PathologyBudgetSummary = {
  directive_id: string;
  total_weight: number;
  pathologies: Record<string, { weight: number; count: number }>;
  window_cutoff_iso: string;
  /** Whether the budget has ALREADY been exhausted (a previous
   *  pathology_budget_exhausted exists in the window). */
  already_exhausted: boolean;
};

/** Return the current debit summary for a directive within the window. */
export const summarizeBudget = (
  db: Database,
  directiveId: string,
  opts?: { nowMs?: number },
): PathologyBudgetSummary => {
  const nowMs = opts?.nowMs ?? Date.now();
  const cutoffIso = new Date(nowMs - PATHOLOGY_BUDGET_WINDOW_MS).toISOString();
  const rows = db
    .query(
      `SELECT json_extract(payload, '$.pathology_kind') AS kind,
              json_extract(payload, '$.weight') AS weight
       FROM events
       WHERE kind = 'pathology_budget_debited'
         AND directive_id = ?
         AND ts >= ?`,
    )
    .all(directiveId, cutoffIso) as Array<{ kind: string; weight: number }>;
  const pathologies: Record<string, { weight: number; count: number }> = {};
  let total = 0;
  for (const r of rows) {
    const k = r.kind ?? "unknown";
    const w = typeof r.weight === "number" ? r.weight : 0;
    if (!pathologies[k]) pathologies[k] = { weight: 0, count: 0 };
    pathologies[k].weight += w;
    pathologies[k].count++;
    total += w;
  }
  const exhausted = db
    .query(
      `SELECT 1 FROM events
       WHERE kind = 'pathology_budget_exhausted'
         AND directive_id = ?
         AND ts >= ?
       LIMIT 1`,
    )
    .get(directiveId, cutoffIso);
  return {
    directive_id: directiveId,
    total_weight: total,
    pathologies,
    window_cutoff_iso: cutoffIso,
    already_exhausted: !!exhausted,
  };
};

/** Fire pathology_budget_exhausted when the directive's total debit
 *  weight in the window crosses the threshold AND the directive hasn't
 *  already been marked exhausted in the same window. Returns the
 *  emitted-event id when it fires, null otherwise. */
export const maybeExhaustPathologyBudget = (
  db: Database,
  directiveId: string,
  opts?: { nowMs?: number; threshold?: number },
): string | null => {
  const threshold = opts?.threshold ?? PATHOLOGY_BUDGET_THRESHOLD;
  const summary = summarizeBudget(db, directiveId, opts);
  if (summary.already_exhausted) return null;
  if (summary.total_weight < threshold) return null;
  const emitted = emitEvent(db, {
    kind: "pathology_budget_exhausted",
    substrate_origin: "substrate_auto",
    directive_id: directiveId,
    payload: {
      total_weight: summary.total_weight,
      threshold,
      window_ms: PATHOLOGY_BUDGET_WINDOW_MS,
      window_cutoff_iso: summary.window_cutoff_iso,
      pathologies: summary.pathologies,
      hint: "directive is consuming scheduler attention without converging; review pathologies and amend / archive the directive",
    } as JsonValue,
  });
  emitEvent(db, {
    kind: "brain_invocation_request",
    substrate_origin: "substrate_auto",
    directive_id: directiveId,
    context_refs: [emitted.id],
    payload: {
      request_reason: "pathology_budget_exhausted",
      topic_keywords: ["pathology_budget", ...Object.keys(summary.pathologies)],
      triggering_event_ids: [emitted.id],
      cited_artifact_ids: [],
      cited_knowledge_ids: [],
      emitter_identity: "pathology_budget",
      urgency: "elevated",
    } as JsonValue,
  });
  return emitted.id;
};
