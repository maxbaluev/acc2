// acc2 crisis-mode adjustments — Phase I (Architecture.md).
//
// Crisis directives carry `urgency: 'crisis'` (alongside the default 'normal'
// and 'elevated'). When a directive in crisis is the active one for a task,
// the scheduler, verifier, dispatch decider, and LATM authoring loop must all
// respect raised concurrency, halved timeouts, hard recipe-preference, and a
// suspended LATM authoring path. Father shortens its iteration interval from
// 5 min to 30 s.
//
// This module exposes:
//   - readCurrentMode(db, directiveId): NORMAL_MODE | CRISIS_MODE.
//   - applyModeAdjustments(opts, mode): merges mode-derived caps into the
//     SchedulerOpts the scheduler / dispatcher are about to use.
//   - openCrisisPostmortem(db, crisisDirectiveId): opens a follow-up
//     directive once the crisis directive closes, gathering any
//     irreversible_effect_recorded rows for review.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { emitEvent } from "./events";
import { newId } from "./ids";
import type { SchedulerOpts } from "./task_scheduler";

export type CrisisModeAdjustments = {
  max_concurrent: number;
  verification_timeout_multiplier: number;
  recipe_preferred: boolean;
  recipe_confidence_threshold: number;
  latm_authoring_suspended: boolean;
  father_interval_ms: number;
};

export const NORMAL_MODE: CrisisModeAdjustments = Object.freeze({
  max_concurrent: 5,
  verification_timeout_multiplier: 1.0,
  recipe_preferred: false,
  // Recipe-replay threshold. Recipes start at confidence 0.5 and gain +0.05
  // per successful replay (cap 0.95). The Tier-0 lane only accepts recipes
  // at 0.85+ — that is SEVEN proven replays, not just one. Pre-fix this was
  // 0.6 (= one success); combined with the loose goal_shape match in
  // recipe_replay.ts, fresh recipes from unrelated DAGs falsely matched new
  // directives and committed them without brain involvement. Crisis mode
  // (§3.5) lowers to 0.7 (= four proven replays) — still conservative.
  recipe_confidence_threshold: 0.85,
  latm_authoring_suspended: false,
  father_interval_ms: 5 * 60 * 1000,
});

export const CRISIS_MODE: CrisisModeAdjustments = Object.freeze({
  max_concurrent: 20,
  verification_timeout_multiplier: 0.5,
  recipe_preferred: true,
  recipe_confidence_threshold: 0.7,
  latm_authoring_suspended: true,
  father_interval_ms: 30 * 1000,
});

/** Read the urgency declared on the LATEST directive_opened or
 *  directive_amended event for `directiveId`. Returns CRISIS_MODE when
 *  urgency === 'crisis', else NORMAL_MODE. The latest amendment wins so
 *  the owner can downgrade a crisis once it resolves. */
export const readCurrentMode = (
  db: Database,
  directiveId: string,
): CrisisModeAdjustments => {
  const row = db
    .query(
      `SELECT payload FROM events
       WHERE directive_id = ? AND kind IN ('directive_opened', 'directive_amended')
       ORDER BY ts DESC, rowid DESC LIMIT 1`,
    )
    .get(directiveId) as { payload: string } | null;
  if (!row) return NORMAL_MODE;
  try {
    const payload = JSON.parse(row.payload ?? "{}") as Record<string, unknown>;
    const urgency = (payload.urgency as string | undefined) ?? "normal";
    return urgency === "crisis" ? CRISIS_MODE : NORMAL_MODE;
  } catch {
    return NORMAL_MODE;
  }
};

/** Merge a CrisisModeAdjustments onto a SchedulerOpts struct. Mutates a copy
 *  rather than the input so callers can keep their baseline opts. */
export const applyModeAdjustments = (
  opts: SchedulerOpts,
  mode: CrisisModeAdjustments,
): SchedulerOpts => ({
  ...opts,
  maxConcurrent: mode.max_concurrent,
});

/** Check if LATM authoring (act_artifact_candidate emission) is currently
 *  suspended for the supplied directive. dispatch_decider and
 *  task_dispatcher consult this to suppress candidate emission in crisis
 *  mode (emitting a `latm_suspended_in_crisis` event instead). */
export const isLatmAuthoringSuspended = (
  db: Database,
  directiveId: string,
): boolean => {
  return readCurrentMode(db, directiveId).latm_authoring_suspended;
};

/** Emit a `latm_suspended_in_crisis` event. Called by task_dispatcher and the
 *  dispatch decider when a candidate would otherwise have fired. */
export const emitLatmSuspended = (
  db: Database,
  directiveId: string,
  taskId: string,
  reason: string,
): void => {
  emitEvent(db, {
    kind: "latm_suspended_in_crisis",
    substrate_origin: "substrate_auto",
    directive_id: directiveId,
    task_id: taskId,
    payload: {
      reason,
    } as JsonValue,
  });
};

/** Open a crisis_postmortem directive after the crisis closes. The new
 *  directive gathers every `irreversible_effect_recorded` row from the
 *  crisis directive so the brain (next dispatch) can reconcile them with the
 *  pre-crisis plan. Returns the new directive's id. */
export const openCrisisPostmortem = async (
  db: Database,
  crisisDirectiveId: string,
): Promise<{ postmortem_directive_id: string }> => {
  // Read every irreversible_effect_recorded under the crisis directive.
  const effects = db
    .query(
      `SELECT id, ts, payload FROM events
       WHERE directive_id = ? AND kind = 'irreversible_effect_recorded'
       ORDER BY ts ASC`,
    )
    .all(crisisDirectiveId) as Array<{ id: string; ts: string; payload: string }>;

  const postmortemId = newId();
  emitEvent(db, {
    kind: "directive_opened",
    substrate_origin: "substrate_auto",
    directive_id: postmortemId,
    task_id: postmortemId,
    payload: {
      directive_text: `crisis_postmortem for ${crisisDirectiveId}: reconcile irreversible effects with plan`,
      lifecycle: "finite",
      urgency: "normal",
      postmortem_for: crisisDirectiveId,
      effects: effects.map((e) => ({ event_id: e.id, ts: e.ts })),
    } as JsonValue,
  });

  emitEvent(db, {
    kind: "crisis_postmortem_opened",
    substrate_origin: "substrate_auto",
    directive_id: postmortemId,
    payload: {
      crisis_directive_id: crisisDirectiveId,
      postmortem_directive_id: postmortemId,
      effect_count: effects.length,
    } as JsonValue,
  });

  // Root task for the postmortem so the scheduler picks it up.
  const rootTaskId = newId();
  emitEvent(db, {
    kind: "task_node_opened",
    substrate_origin: "substrate_auto",
    directive_id: postmortemId,
    task_id: rootTaskId,
    parent_task_id: null,
    payload: {
      goal: `Reconcile ${effects.length} irreversible effect(s) from crisis ${crisisDirectiveId} with the pre-crisis plan.`,
      lifecycle: "finite",
      urgency: "normal",
      postmortem_for: crisisDirectiveId,
    } as JsonValue,
  });

  return { postmortem_directive_id: postmortemId };
};

/** Convenience: open a fresh directive in crisis mode. Emits both
 *  directive_opened (urgency='crisis') AND a `crisis_mode_engaged` marker so
 *  observers can subscribe to the transition. */
export const openCrisisDirective = (
  db: Database,
  input: {
    directive_text: string;
    lifecycle?: "finite" | "rolling_active";
    initial_task_goal?: string;
  },
): { directive_id: string; task_id: string } => {
  const directiveId = newId();
  const taskId = newId();
  emitEvent(db, {
    kind: "directive_opened",
    substrate_origin: "owner",
    directive_id: directiveId,
    task_id: directiveId,
    payload: {
      directive_text: input.directive_text,
      lifecycle: input.lifecycle ?? "finite",
      urgency: "crisis",
    } as JsonValue,
  });
  emitEvent(db, {
    kind: "crisis_mode_engaged",
    substrate_origin: "substrate_auto",
    directive_id: directiveId,
    payload: {
      reason: "directive_urgency_crisis",
    } as JsonValue,
  });
  emitEvent(db, {
    kind: "task_node_opened",
    substrate_origin: "owner",
    directive_id: directiveId,
    task_id: taskId,
    parent_task_id: null,
    payload: {
      goal: input.initial_task_goal ?? input.directive_text,
      lifecycle: "finite",
      urgency: "crisis",
    } as JsonValue,
  });
  return { directive_id: directiveId, task_id: taskId };
};
