// acc2 supervisor (Batch 8.B, 2026-05-15) — owner directive:
//   "make monitor to always stop daemon (old tasks) to prevent stucks and
//    loops at all levels"
//
// Cites brain-authored lesson_extracted 5SWP11NZFS3YX68Y95T164HT9W
// (PPVP3S5V9506DA6A1BZ9ZCWPKW @ 02:10:08.725Z) which surfaced bridge_stuck
// streaks as the dominant structural blocker class.
//
// The supervisor runs as a periodic worker tick alongside the integrity
// worker. It enumerates pathologies that produce stucks / loops at three
// scopes — task, directive, bridge — and applies the canonical corrective
// event so the scheduler / readyTasks / dispatch lane immediately stops
// firing on the broken target:
//
//   1. Task-scope:  redispatch storm
//      → ≥ SUPERVISOR_MAX_REDISPATCHES_PER_TASK brain_dispatched on ONE
//        task within SUPERVISOR_REDISPATCH_WINDOW_MS (10min) AND no
//        task_committed in that window.
//      → emit task_failed { failure_kind: "redispatch_storm" } + the
//        supervisor_intervention_recorded audit row.
//
//   2. Directive-scope:  DAG explosion
//      → directive has > SUPERVISOR_MAX_READY_TASKS_PER_DIRECTIVE ready
//        tasks AND ≥ SUPERVISOR_MAX_DIRECTIVE_AGE_HOURS hours old with no
//        terminal root commit yet.
//      → emit directive_archived_by_operator { reason: "supervisor_dag_explosion" }
//        so readyTasks drops the entire directive subtree.
//
//   3. Bridge-scope:  global instability
//      → already handled by runtime/bridge_health.ts; the supervisor calls
//        maybeMarkDegraded + maybeMarkRecovered on every tick.
//
// The supervisor is FAIL-CLOSED — its interventions emit append-only
// events that REMOVE work from readyTasks. It never resurrects a task or
// directive. Operators inspect supervisor_intervention_recorded rows to
// audit each auto-intervention.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { emitEvent } from "./events";
import {
  maybeMarkDegraded,
  maybeMarkRecovered,
} from "./bridge_health";
import { debit, maybeExhaustPathologyBudget, type PathologyKind } from "./pathology_budget";
import { logger } from "./logger";

/** Maximum brain_dispatched events allowed on ONE task within the
 *  redispatch window. Above this, the supervisor force-fails the task as
 *  `redispatch_storm`. 3 is tight — a healthy cycle needs at most 1-2
 *  dispatches per task; 3+ in a window means the scheduler is looping. */
export const SUPERVISOR_MAX_REDISPATCHES_PER_TASK = 3;

/** Window over which redispatch counts accumulate. 5 minutes is the
 *  bridge timeout — within one cycle window, more than 3 dispatches on
 *  the same task is a tight loop. */
export const SUPERVISOR_REDISPATCH_WINDOW_MS = 5 * 60 * 1000;

/** Maximum ready task_node_opened entries under ONE directive before the
 *  supervisor flags DAG explosion. Lowered from 50 → 20 because live
 *  evidence (2026-05-15 06:30+) showed QB07F9XX at 45 ready tasks for 7+
 *  hours without ever triggering — too lax. The brain's depth-1 retrieval
 *  should produce ≤ 10 ready siblings; 20 is a clear-runaway signal. */
export const SUPERVISOR_MAX_READY_TASKS_PER_DIRECTIVE = 20;

/** Directive age (hours) past which the DAG-explosion gate fires AND no
 *  root commit has landed. Lowered from 4 → 2 — a healthy directive
 *  with the new 600s bridge timeout should close in < 1h. 2h is generous. */
export const SUPERVISOR_MAX_DIRECTIVE_AGE_HOURS = 2;

const SUPERVISOR_DIRECTIVE_AGE_MS = SUPERVISOR_MAX_DIRECTIVE_AGE_HOURS * 60 * 60 * 1000;

/** Token-burn budget per directive — maximum total brain_dispatched
 *  events allowed under ONE directive before the supervisor archives it.
 *  A healthy DAG with 5-10 sub-tasks should produce 10-20 dispatches
 *  total; > 50 means the brain is looping without converging. Caps
 *  cost-burn from any pathology the per-task / per-bridge gates miss. */
export const SUPERVISOR_MAX_DISPATCHES_PER_DIRECTIVE = 50;

/** Detect tasks in a redispatch storm and fail them. Returns the list of
 *  task ids that were quarantined this tick. Idempotent — a task that
 *  already has a task_failed event will not be re-failed. */
export const detectRedispatchStorm = (
  db: Database,
  opts?: { nowMs?: number },
): Array<{ task_id: string; directive_id: string; dispatch_count: number }> => {
  const nowMs = opts?.nowMs ?? Date.now();
  const cutoffIso = new Date(nowMs - SUPERVISOR_REDISPATCH_WINDOW_MS).toISOString();
  const rows = db
    .query(
      `SELECT task_id, directive_id, COUNT(*) AS dispatch_count
       FROM events
       WHERE kind = 'brain_dispatched' AND ts >= ?
       GROUP BY task_id
       HAVING dispatch_count > ?`,
    )
    .all(cutoffIso, SUPERVISOR_MAX_REDISPATCHES_PER_TASK) as Array<{
      task_id: string;
      directive_id: string;
      dispatch_count: number;
    }>;

  const quarantined: Array<{ task_id: string; directive_id: string; dispatch_count: number }> = [];
  for (const r of rows) {
    // Skip if the task already has any terminal event in the window —
    // the scheduler's consecutive_bridge_failures cap may already have
    // fired, or the brain may have just committed it.
    const terminal = db
      .query(
        `SELECT 1 FROM events
         WHERE task_id = ?
           AND kind IN ('task_committed', 'task_failed', 'task_abandoned')
         LIMIT 1`,
      )
      .get(r.task_id);
    if (terminal) continue;
    try {
      emitEvent(db, {
        kind: "task_failed",
        substrate_origin: "substrate_auto",
        directive_id: r.directive_id,
        task_id: r.task_id,
        failure_kind: "redispatch_storm",
        payload: {
          reason: "supervisor_redispatch_storm",
          dispatch_count: r.dispatch_count,
          window_ms: SUPERVISOR_REDISPATCH_WINDOW_MS,
          threshold: SUPERVISOR_MAX_REDISPATCHES_PER_TASK,
        } as JsonValue,
      });
      emitEvent(db, {
        kind: "supervisor_intervention_recorded",
        substrate_origin: "substrate_auto",
        directive_id: r.directive_id,
        task_id: r.task_id,
        payload: {
          pathology: "redispatch_storm",
          corrective_event: "task_failed",
          dispatch_count: r.dispatch_count,
          threshold: SUPERVISOR_MAX_REDISPATCHES_PER_TASK,
          window_ms: SUPERVISOR_REDISPATCH_WINDOW_MS,
        } as JsonValue,
      });
      quarantined.push(r);
    } catch (err) {
      logger.warn(
        { where: "supervisor.redispatch_storm", task_id: r.task_id, err: (err as Error).message },
        "supervisor failed to fail redispatch-storm task",
      );
    }
  }
  return quarantined;
};

/** Collect the unfinished task ids + goals under a directive. Used by
 *  the supervisor when archiving a runaway directive so the archive event
 *  records WHAT work was paused — owner directive: "system never should
 *  loose tasks if task explosion, etc". The substrate is append-only;
 *  nothing is ever deleted, but this payload makes the dormant work
 *  immediately visible to operators via `acc status` / `acc events`. */
const collectUnfinishedTasks = (
  db: Database,
  directiveId: string,
): Array<{ task_id: string; goal: string }> => {
  const rows = db
    .query(
      `SELECT n.task_id AS task_id, n.payload AS payload FROM events n
       WHERE n.kind = 'task_node_opened' AND n.directive_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM events t
           WHERE t.task_id = n.task_id
             AND t.kind IN ('task_committed', 'task_failed', 'task_abandoned')
         )
       ORDER BY n.ts ASC LIMIT 200`,
    )
    .all(directiveId) as Array<{ task_id: string; payload: string }>;
  const out: Array<{ task_id: string; goal: string }> = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.task_id)) continue;
    seen.add(r.task_id);
    let goal = "";
    try {
      const p = JSON.parse(r.payload ?? "{}") as Record<string, unknown>;
      goal = ((p.goal as string | undefined) ?? "").slice(0, 200);
    } catch { /* leave blank */ }
    out.push({ task_id: r.task_id, goal });
  }
  return out;
};

/** Detect directives whose ready-task subtree has exploded (uncontrolled
 *  refinement fanout) AND have been running past the age threshold. Emits
 *  directive_archived_by_operator so readyTasks drops the entire DAG.
 *  Returns the directive ids that were archived this tick. */
export const detectDagExplosion = (
  db: Database,
  opts?: { nowMs?: number },
): Array<{ directive_id: string; ready_count: number; age_hours: number }> => {
  const nowMs = opts?.nowMs ?? Date.now();
  const ageCutoffIso = new Date(nowMs - SUPERVISOR_DIRECTIVE_AGE_MS).toISOString();

  // Directives whose oldest task_node_opened is older than the age threshold
  // AND have no terminal root commit yet.
  const aged = db
    .query(
      `SELECT directive_id, MIN(ts) AS first_ts
       FROM events
       WHERE kind = 'task_node_opened'
       GROUP BY directive_id
       HAVING first_ts <= ?`,
    )
    .all(ageCutoffIso) as Array<{ directive_id: string; first_ts: string }>;

  const archived: Array<{ directive_id: string; ready_count: number; age_hours: number }> = [];
  for (const r of aged) {
    // Skip directives already closed/archived.
    const closed = db
      .query(
        `SELECT 1 FROM events
         WHERE directive_id = ?
           AND kind IN ('directive_closed', 'directive_archived_by_operator', 'directive_archived_missed_reviews')
         LIMIT 1`,
      )
      .get(r.directive_id);
    if (closed) continue;
    // Count ready (opened but not terminal) tasks under this directive.
    const readyCount = (db
      .query(
        `SELECT COUNT(*) AS c FROM events n
         WHERE n.kind = 'task_node_opened' AND n.directive_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM events t
             WHERE t.task_id = n.task_id
               AND t.kind IN ('task_committed', 'task_failed', 'task_abandoned')
           )`,
      )
      .get(r.directive_id) as { c: number }).c;
    if (readyCount <= SUPERVISOR_MAX_READY_TASKS_PER_DIRECTIVE) continue;

    const ageHours = (nowMs - Date.parse(r.first_ts)) / (60 * 60 * 1000);
    try {
      // Preserve unfinished task ids + goals so the archive is recoverable.
      const unfinished = collectUnfinishedTasks(db, r.directive_id);
      emitEvent(db, {
        kind: "directive_archived_by_operator",
        substrate_origin: "substrate_auto",
        directive_id: r.directive_id,
        payload: {
          reason: "supervisor_dag_explosion",
          ready_task_count: readyCount,
          age_hours: ageHours,
          threshold_ready_tasks: SUPERVISOR_MAX_READY_TASKS_PER_DIRECTIVE,
          threshold_age_hours: SUPERVISOR_MAX_DIRECTIVE_AGE_HOURS,
          quarantined_tasks: unfinished,
          recoverable: true,
          resume_command: `acc directive resume ${r.directive_id}`,
        } as JsonValue,
      });
      emitEvent(db, {
        kind: "supervisor_intervention_recorded",
        substrate_origin: "substrate_auto",
        directive_id: r.directive_id,
        payload: {
          pathology: "dag_explosion",
          corrective_event: "directive_archived_by_operator",
          ready_task_count: readyCount,
          age_hours: ageHours,
        } as JsonValue,
      });
      archived.push({ directive_id: r.directive_id, ready_count: readyCount, age_hours: ageHours });
    } catch (err) {
      logger.warn(
        { where: "supervisor.dag_explosion", directive_id: r.directive_id, err: (err as Error).message },
        "supervisor failed to archive DAG-explosion directive",
      );
    }
  }
  return archived;
};

/** Detect directives whose total brain_dispatched count exceeds the
 *  budget. Token-burn prevention — a single directive cannot infinitely
 *  spend brain cycles. Catches the recurring-cycle-no-convergence
 *  pattern that the DAG-explosion gate misses when the directive has
 *  few simultaneously-ready tasks but many sequential rounds.
 *  Idempotent: skips directives already closed/archived. */
export const detectDispatchBudgetExceeded = (
  db: Database,
): Array<{ directive_id: string; dispatch_count: number }> => {
  const rows = db
    .query(
      `SELECT directive_id, COUNT(*) AS dispatch_count
       FROM events
       WHERE kind = 'brain_dispatched'
       GROUP BY directive_id
       HAVING dispatch_count > ?`,
    )
    .all(SUPERVISOR_MAX_DISPATCHES_PER_DIRECTIVE) as Array<{ directive_id: string; dispatch_count: number }>;

  const archived: Array<{ directive_id: string; dispatch_count: number }> = [];
  for (const r of rows) {
    const closed = db
      .query(
        `SELECT 1 FROM events
         WHERE directive_id = ?
           AND kind IN ('directive_closed', 'directive_archived_by_operator', 'directive_archived_missed_reviews')
         LIMIT 1`,
      )
      .get(r.directive_id);
    if (closed) continue;
    try {
      const unfinished = collectUnfinishedTasks(db, r.directive_id);
      emitEvent(db, {
        kind: "directive_archived_by_operator",
        substrate_origin: "substrate_auto",
        directive_id: r.directive_id,
        payload: {
          reason: "supervisor_dispatch_budget_exceeded",
          dispatch_count: r.dispatch_count,
          threshold: SUPERVISOR_MAX_DISPATCHES_PER_DIRECTIVE,
          quarantined_tasks: unfinished,
          recoverable: true,
          resume_command: `acc directive resume ${r.directive_id}`,
        } as JsonValue,
      });
      emitEvent(db, {
        kind: "supervisor_intervention_recorded",
        substrate_origin: "substrate_auto",
        directive_id: r.directive_id,
        payload: {
          pathology: "dispatch_budget_exceeded",
          corrective_event: "directive_archived_by_operator",
          dispatch_count: r.dispatch_count,
          threshold: SUPERVISOR_MAX_DISPATCHES_PER_DIRECTIVE,
        } as JsonValue,
      });
      archived.push(r);
    } catch (err) {
      logger.warn(
        { where: "supervisor.dispatch_budget", directive_id: r.directive_id, err: (err as Error).message },
        "supervisor failed to archive over-budget directive",
      );
    }
  }
  return archived;
};

/** Round-2 audit (2026-05-15): ready-starvation detector. A task that
 *  sits in ready_tasks_view for longer than this without any
 *  dispatch_decided / brain_dispatched / action_predicted /
 *  terminal event is slow-drift starvation — neither a tight redispatch
 *  storm nor a DAG explosion. 2 hours default; override via
 *  ACC2_SUPERVISOR_READY_STARVATION_MS. */
export const SUPERVISOR_READY_STARVATION_MS = Number(
  process.env.ACC2_SUPERVISOR_READY_STARVATION_MS ?? 2 * 60 * 60 * 1000,
);

/** Scan ready_tasks_view for rows opened more than
 *  SUPERVISOR_READY_STARVATION_MS ago whose task has no
 *  dispatch_decided / brain_dispatched / action_predicted /
 *  task_committed / task_failed / task_abandoned event. Emits one
 *  supervisor_intervention_recorded with pathology=ready_starvation
 *  per starved task so operators see slow-drift without manual
 *  query. Returns the list of starved task ids. Idempotent — skips
 *  tasks whose latest event already includes a recent intervention. */
export const probeReadyStarvation = (
  db: Database,
  opts?: { nowMs?: number },
): Array<{ task_id: string; directive_id: string; ready_age_ms: number }> => {
  const nowMs = opts?.nowMs ?? Date.now();
  const cutoffIso = new Date(nowMs - SUPERVISOR_READY_STARVATION_MS).toISOString();
  const candidates = db
    .query(
      `SELECT task_id, directive_id, ts FROM ready_tasks_view
       WHERE ts <= ?`,
    )
    .all(cutoffIso) as Array<{ task_id: string; directive_id: string; ts: string }>;

  const starved: Array<{ task_id: string; directive_id: string; ready_age_ms: number }> = [];
  for (const c of candidates) {
    // Skip if the task has any progress signal — even a single
    // brain_dispatched proves the scheduler engaged.
    const progress = db
      .query(
        `SELECT 1 FROM events
         WHERE task_id = ?
           AND kind IN (
             'dispatch_decided', 'brain_dispatched', 'action_predicted',
             'task_committed', 'task_failed', 'task_abandoned'
           )
         LIMIT 1`,
      )
      .get(c.task_id);
    if (progress) continue;
    // Idempotent: skip tasks that already have a recent ready_starvation
    // intervention so a long-stuck task doesn't generate an event every
    // 30s supervisor tick.
    const lastInterventionIso = new Date(nowMs - SUPERVISOR_READY_STARVATION_MS).toISOString();
    const already = db
      .query(
        `SELECT 1 FROM events
         WHERE task_id = ?
           AND kind = 'supervisor_intervention_recorded'
           AND ts >= ?
           AND json_extract(payload, '$.pathology') = 'ready_starvation'
         LIMIT 1`,
      )
      .get(c.task_id, lastInterventionIso);
    if (already) continue;

    const readyAgeMs = nowMs - new Date(c.ts).getTime();
    try {
      emitEvent(db, {
        kind: "supervisor_intervention_recorded",
        substrate_origin: "substrate_auto",
        directive_id: c.directive_id,
        task_id: c.task_id,
        payload: {
          pathology: "ready_starvation",
          ready_age_ms: readyAgeMs,
          threshold_ms: SUPERVISOR_READY_STARVATION_MS,
          // Observational only — supervisor surfaces the drift but does
          // not auto-archive; operators decide whether to amend/resume.
          corrective_event: null,
        } as JsonValue,
      });
      starved.push({ task_id: c.task_id, directive_id: c.directive_id, ready_age_ms: readyAgeMs });
    } catch (err) {
      logger.warn(
        { where: "supervisor.ready_starvation", task_id: c.task_id, err: (err as Error).message },
        "supervisor failed to emit ready_starvation intervention",
      );
    }
  }
  return starved;
};

export type SupervisorTickResult = {
  redispatch_storm_count: number;
  dag_explosion_count: number;
  dispatch_budget_exceeded_count: number;
  ready_starvation_count: number;
  pathology_budget_exhausted_count: number;
  bridge_health_degraded: boolean;
  bridge_health_recovered: boolean;
};

/** One supervisor tick. Composes the four detectors + bridge_health
 *  gate. Safe to call repeatedly; every detector is idempotent. */
export const supervisorTick = (
  db: Database,
  opts?: { nowMs?: number },
): SupervisorTickResult => {
  const result: SupervisorTickResult = {
    redispatch_storm_count: 0,
    dag_explosion_count: 0,
    dispatch_budget_exceeded_count: 0,
    ready_starvation_count: 0,
    pathology_budget_exhausted_count: 0,
    bridge_health_degraded: false,
    bridge_health_recovered: false,
  };
  // Unified pathology budget (brain elegance bc8je5f3x, 2026-05-15): each
  // detector still emits its canonical event, but supervisorTick now ALSO
  // debits the budget for every quarantined item. After all detectors run,
  // we check maybeExhaustPathologyBudget for the affected directives — one
  // exhaustion event collapses scattered backpressure alarms into a single
  // canonical "directive not converging" signal.
  const affectedDirectives = new Set<string>();
  const debitOnDirective = (directiveId: string, kind: PathologyKind, sourceWorker: string): void => {
    if (!directiveId) return;
    try {
      debit(db, {
        directive_id: directiveId,
        pathology_kind: kind,
        source_worker: sourceWorker,
      });
      affectedDirectives.add(directiveId);
    } catch (err) {
      logger.warn({ where: "supervisor.budget.debit", kind, err: (err as Error).message }, "pathology budget debit failed");
    }
  };

  try {
    const storms = detectRedispatchStorm(db, opts);
    result.redispatch_storm_count = storms.length;
    for (const s of storms) debitOnDirective(s.directive_id, "redispatch_storm", "supervisor.redispatch_storm");
  } catch (err) {
    logger.warn({ where: "supervisor.tick.redispatch", err: (err as Error).message }, "redispatch detector failed");
  }
  try {
    const explosions = detectDagExplosion(db, opts);
    result.dag_explosion_count = explosions.length;
    for (const e of explosions) debitOnDirective(e.directive_id, "dag_explosion", "supervisor.dag_explosion");
  } catch (err) {
    logger.warn({ where: "supervisor.tick.dag_explosion", err: (err as Error).message }, "dag-explosion detector failed");
  }
  try {
    const overBudget = detectDispatchBudgetExceeded(db);
    result.dispatch_budget_exceeded_count = overBudget.length;
    for (const b of overBudget) debitOnDirective(b.directive_id, "dispatch_budget_exceeded", "supervisor.dispatch_budget");
  } catch (err) {
    logger.warn({ where: "supervisor.tick.dispatch_budget", err: (err as Error).message }, "dispatch-budget detector failed");
  }
  try {
    const starved = probeReadyStarvation(db, opts);
    result.ready_starvation_count = starved.length;
    for (const s of starved) debitOnDirective(s.directive_id, "ready_starvation", "supervisor.ready_starvation");
  } catch (err) {
    logger.warn({ where: "supervisor.tick.ready_starvation", err: (err as Error).message }, "ready-starvation detector failed");
  }
  try { result.bridge_health_degraded = maybeMarkDegraded(db, opts); } catch (err) {
    logger.warn({ where: "supervisor.tick.bridge_degraded", err: (err as Error).message }, "bridge_health degraded check failed");
  }
  try { result.bridge_health_recovered = maybeMarkRecovered(db, opts); } catch (err) {
    logger.warn({ where: "supervisor.tick.bridge_recovered", err: (err as Error).message }, "bridge_health recovered check failed");
  }
  // Final pass: check the budget for every directive that received a
  // debit this tick. One pathology_budget_exhausted may fire per
  // directive; the event payload enumerates every contributing
  // pathology so operators see ONE archive signal instead of six
  // scattered alarms.
  for (const directiveId of affectedDirectives) {
    try {
      const emittedId = maybeExhaustPathologyBudget(db, directiveId, opts);
      if (emittedId) result.pathology_budget_exhausted_count++;
    } catch (err) {
      logger.warn(
        { where: "supervisor.tick.budget_exhaust", directive_id: directiveId, err: (err as Error).message },
        "pathology budget exhaustion check failed",
      );
    }
  }
  return result;
};
