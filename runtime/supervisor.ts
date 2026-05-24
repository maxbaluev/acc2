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
 *  `redispatch_storm`. Raised from 3 → 6 on 2026-05-16: legitimate brain
 *  refinement (verdict re-evaluation across 4-5 cycles, k_201
 *  retrieval-binding scored across multiple acts, closure audit + lesson
 *  extraction passes) was being killed at cycle 4 even when each cycle
 *  emitted real knowledge_candidate / lesson_extracted. 6 leaves enough
 *  ceiling to catch true tight loops while letting iterative brain
 *  refinement converge. Observed: both health-verification and acc-trust
 *  audits today emitted 3 successful cycles each, then supervisor killed
 *  the 4th. */
export const SUPERVISOR_MAX_REDISPATCHES_PER_TASK = 6;

/** Window over which redispatch counts accumulate. 5 minutes is the
 *  bridge timeout — within one cycle window, more than the cap dispatches
 *  on the same task is a tight loop. */
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

/** Recent-ts window bounding the DAG-explosion driving scan (2026-05-24).
 *  The detector flags directives with > N open ready tasks whose OLDEST open
 *  task is older than SUPERVISOR_MAX_DIRECTIVE_AGE_HOURS (2h). Bounding the
 *  driving scan's `task_node_opened.ts` to the last 7 days cannot miss a real
 *  explosion: any directive that is genuinely runaway has open tasks with
 *  recent task_node_opened events (the explosion IS recent fanout), and the
 *  age gate (first_ts <= now-2h) already requires the oldest open task be
 *  ≤ 2h old — far inside 7d. 7 days is a wide safety margin over the 2h age
 *  threshold so a directive that has been quietly accumulating ready tasks
 *  for days is still scanned. A directive older than 7d with no terminal root
 *  commit is already dead by every other gate (dispatch budget, no-closure).
 *  Without the bound the LEFT-JOIN anti-join walks every task_node_opened
 *  event ever recorded. */
const SUPERVISOR_DAG_SCAN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Token-burn budget per directive — maximum total brain_dispatched
 *  events allowed under ONE directive before the supervisor archives it.
 *  A healthy DAG with 5-10 sub-tasks should produce 10-20 dispatches
 *  total; > 50 means the brain is looping without converging. Caps
 *  cost-burn from any pathology the per-task / per-bridge gates miss. */
export const SUPERVISOR_MAX_DISPATCHES_PER_DIRECTIVE = 50;

/** Recent-ts window bounding the dispatch-budget AND no-closure-progress
 *  driving scans (2026-05-24). Both count brain_dispatched per directive and
 *  HAVING-filter directives above a cap. Bounding the count to the last 6
 *  hours cannot miss a real pathology: a directive that is still burning brain
 *  cycles is emitting brain_dispatched events right now (the cap is about the
 *  ONGOING burn rate, and a directive idle for 6h with no terminal event is
 *  already caught by the DAG-explosion age gate at 2h). A directive that
 *  accumulated >50 dispatches but went quiet >6h ago is dead — re-counting its
 *  ancient dispatches changes nothing because the idempotency guard skips it
 *  once any directive_closed/archived/task_committed exists, and a live
 *  un-converged directive keeps its over-cap count inside any 6h slice once
 *  it is dispatching ~once/minute or faster (50 dispatches < 1h at that rate).
 *  Without the bound each detector walks every brain_dispatched event ever
 *  (~8-9ms on a 400k-row ledger); the 6h window collapses it to ~0.1ms. */
const SUPERVISOR_DISPATCH_COUNT_WINDOW_MS = 6 * 60 * 60 * 1000;

/** No-closure-progress loop detector (2026-05-21). Fallback only.
 *  The primary fix is scheduler-admission self-reaping: the first attempted
 *  unchanged redispatch terminates the task before spawning another brain.
 *  This supervisor cap remains as an idempotent belt-and-suspenders audit
 *  for legacy daemons or missed scheduler paths. The precise scheduler-side
 *  terminateNoProgressRedispatch (commit 5b7080d) is the primary fast-path
 *  for genuine identical-redispatch loops, so this crude count-based cap is
 *  pure fallback. It was briefly 1, but cap=1 over-reaped: bridge_failed is
 *  frequent (transient brain-subprocess timeouts, 768+ all-time), and a
 *  research-heavy or new-feature directive that hit even one bridge_failure
 *  in its first 2 dispatches was archived before it could retry + emit. Set
 *  to 4 so a directive survives a transient bridge failure plus 1-2 research
 *  cycles before this fallback fires; the scheduler-side check still kills
 *  genuine no-progress loops immediately. (A follow-up brain fix excludes
 *  bridge_failed dispatches from the productive count entirely.) */
export const SUPERVISOR_NO_CLOSURE_PROGRESS_DISPATCH_CAP = 4;

/** Stuck-task detector (2026-05-17): when the brain emits the SAME
 *  action_predicted (keyed by `(task_id, action_artifact_id)`) N+ times
 *  within the window without the task committing, the brain is wedged on
 *  an unimplementable action. Default threshold catches the typical
 *  "brain restates the same fake-artifact action every cycle" loop
 *  (witnessed on ACTTUPLE03C_CREDIT: 13 repeats of
 *  action_artifact_id="opencode_brain_exit_action" over ~12 minutes).
 *  Substrate-state only — does NOT depend on whether the artifact id is
 *  a real handle (we're refactoring the artifact system in parallel). */
// Universal value pending f13 adaptive-scoring contract (GEZ955QDYN3R):
// these thresholds should learn from outcomes (false-positive rate on
// flagged storms vs. real wedge detection) rather than be env-tuned.
export const SUPERVISOR_MAX_REPEATING_ACTIONS = 5;
export const SUPERVISOR_REPEATING_ACTION_WINDOW_MS = 10 * 60 * 1000;

/** Cadence throttle (2026-05-24): supervisorTick is reactive-fired on every
 *  brain_dispatched / action_predicted / task_node_opened / terminal / bridge
 *  event. During a dispatch burst that means many ticks per second. But the
 *  supervisor detects SLOW phenomena (redispatch storms over 5min, DAG age over
 *  2h, dispatch budgets over dozens of events) — there is no value in scanning
 *  more often than ~15s. Gating to one real scan per SUPERVISOR_MIN_GAP_MS
 *  collapses burst fan-out into a single off-loop scan, cutting pool pressure.
 *  A throttled call returns a no-op result immediately (throttled=true) without
 *  launching any pooled scan. Semantics of the scan itself are unchanged. */
export const SUPERVISOR_MIN_GAP_MS = 15_000;

/** Module-level last-real-run timestamp for the cadence throttle. Tracked here
 *  (not in the daemon) so every caller — daemon reactive fire, safety net, and
 *  tests — shares one gate. Exposed reset for deterministic tests. */
let lastSupervisorRunMs = 0;
export const __resetSupervisorThrottle = (): void => {
  lastSupervisorRunMs = 0;
};

/** Detect tasks in a redispatch storm and fail them. Returns the list of
 *  task ids that were quarantined this tick. Idempotent — a task that
 *  already has a task_failed event will not be re-failed. */
export const detectRedispatchStorm = (
  db: Database,
  opts?: { nowMs?: number },
): Array<{ task_id: string; directive_id: string; dispatch_count: number }> => {
  const nowMs = opts?.nowMs ?? Date.now();
  const cutoffIso = new Date(nowMs - SUPERVISOR_REDISPATCH_WINDOW_MS).toISOString();
  // Bounded GROUP BY scan over events, run synchronously on the main thread.
  // Off-loading full-table scans to the SQL worker pool (b62fd6d) made the
  // regression WORSE: concurrent pooled readers contended with the main-thread
  // SQLite writer (WAL I/O), stalling emit/open_directive ~41-45s. The fix is
  // to make the scan CHEAP, not to move it threads: the `ts >= cutoff` window
  // (SUPERVISOR_REDISPATCH_WINDOW_MS = 5min) bounds this to the few hundred
  // brain_dispatched rows in the last 5 minutes. A redispatch storm is by
  // definition a burst of dispatches on ONE task in that window, so the recent
  // window cannot miss a real storm — a storm that is genuinely ongoing emits
  // its dispatches inside the window. EXPLAIN: SEARCH events USING INDEX
  // idx_events_kind_ts (kind=? AND ts>?) — a ts-range seek, not a full SCAN.
  const rows = db.query<{
    task_id: string;
    directive_id: string;
    dispatch_count: number;
  }, [string, number]>(
    `SELECT task_id, directive_id, COUNT(*) AS dispatch_count
       FROM events
       WHERE kind = 'brain_dispatched' AND ts >= ?
       GROUP BY task_id
       HAVING dispatch_count > ?`,
  ).all(cutoffIso, SUPERVISOR_MAX_REDISPATCHES_PER_TASK);

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

/** Detect brain stuck-task loops (2026-05-17): the brain keeps emitting
 *  the SAME action_predicted (keyed by `(task_id, action_artifact_id)`)
 *  without the task committing. Pre-fix the brain would cycle
 *  indefinitely on tasks it couldn't actually land — e.g. ACTTUPLE03C
 *  _CREDIT emitted 13 action_predicted with action_artifact_id=
 *  "opencode_brain_exit_action" over ~12 minutes because the brain has
 *  READ-ONLY filesystem permission and no auto-apply path for raw code
 *  changes. The detector fails the task with failure_kind=
 *  "brain_stuck_repeating_action" so the scheduler stops re-dispatching
 *  it and the brain can move on to other work.
 *
 *  Purely substrate-state — counts action_predicted rows by
 *  (task_id, action_artifact_id) over a window. Does NOT validate that
 *  action_artifact_id resolves to a real act_artifact row (we're
 *  refactoring the artifact system in parallel; this detector works
 *  regardless of which artifact table exists). Idempotent — skips
 *  tasks that already have a terminal event. */
export const detectRepeatingAction = (
  db: Database,
  opts?: { nowMs?: number },
): Array<{ task_id: string; directive_id: string; action_artifact_id: string; repeat_count: number }> => {
  const nowMs = opts?.nowMs ?? Date.now();
  const cutoffIso = new Date(nowMs - SUPERVISOR_REPEATING_ACTION_WINDOW_MS).toISOString();
  // Bounded GROUP BY scan, run synchronously on the main thread (reverted from
  // the b62fd6d pool off-load — see detectRedispatchStorm). The
  // `ts >= cutoff` window (SUPERVISOR_REPEATING_ACTION_WINDOW_MS = 10min)
  // bounds this to recent action_predicted rows. A brain stuck repeating the
  // same action is by definition emitting that action repeatedly right now, so
  // a 10-minute window cannot miss a live wedge — the witnessed loop
  // (ACTTUPLE03C_CREDIT: 13 repeats over ~12min) is fully inside the window.
  // EXPLAIN: SEARCH events USING INDEX idx_events_origin_ts
  // (substrate_origin=? AND ts>?) — a ts-range seek, not a full SCAN.
  const rows = db.query<{
    task_id: string;
    directive_id: string;
    action_artifact_id: string;
    repeat_count: number;
  }, [string, number]>(
    `SELECT task_id, directive_id, action_artifact_id, COUNT(*) AS repeat_count
       FROM events
       WHERE kind = 'action_predicted'
         AND ts >= ?
         AND substrate_origin = 'opencode'
         AND action_artifact_id IS NOT NULL
         AND action_artifact_id != ''
       GROUP BY task_id, action_artifact_id
       HAVING repeat_count >= ?`,
  ).all(cutoffIso, SUPERVISOR_MAX_REPEATING_ACTIONS);

  const quarantined: Array<{ task_id: string; directive_id: string; action_artifact_id: string; repeat_count: number }> = [];
  for (const r of rows) {
    // Idempotency: skip tasks that already have any terminal event.
    // The single-terminal-per-task gate at runtime/events.ts would
    // refuse a second terminal anyway, but the explicit check avoids
    // a noisy refusal in the audit trail.
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
        failure_kind: "brain_stuck_repeating_action",
        payload: {
          reason: "supervisor_brain_stuck_repeating_action",
          action_artifact_id: r.action_artifact_id,
          repeat_count: r.repeat_count,
          window_ms: SUPERVISOR_REPEATING_ACTION_WINDOW_MS,
          threshold: SUPERVISOR_MAX_REPEATING_ACTIONS,
          hint: "brain emitted action_predicted with the same action_artifact_id more than threshold times without the task committing — typically a sign the action_artifact_id is a placeholder string (artifact never admitted) or the brain has no implementation lane for this action. Task failed so the scheduler stops re-dispatching it. Brain should emit contract_amendment_proposed (which has an auto-apply path) or knowledge_candidate instead.",
        } as JsonValue,
      });
      emitEvent(db, {
        kind: "supervisor_intervention_recorded",
        substrate_origin: "substrate_auto",
        directive_id: r.directive_id,
        task_id: r.task_id,
        payload: {
          pathology: "brain_stuck_repeating_action",
          corrective_event: "task_failed",
          action_artifact_id: r.action_artifact_id,
          repeat_count: r.repeat_count,
          threshold: SUPERVISOR_MAX_REPEATING_ACTIONS,
          window_ms: SUPERVISOR_REPEATING_ACTION_WINDOW_MS,
        } as JsonValue,
      });
      quarantined.push(r);
    } catch (err) {
      logger.warn(
        { where: "supervisor.repeating_action", task_id: r.task_id, err: (err as Error).message },
        "supervisor failed to fail repeating-action task",
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
  const scanCutoffIso = new Date(nowMs - SUPERVISOR_DAG_SCAN_WINDOW_MS).toISOString();

  // 2026-05-21 O(n²) → O(n) rewrite (owner directive: avoid O(n²), stay
  // fast/reactive). Pre-fix this did GROUP BY over all task_node_opened to
  // find aged directives, then for EACH ran a per-directive correlated
  // `NOT EXISTS` COUNT + a per-directive closed-check — N round-trips, each
  // a correlated subquery over the events table = O(N×M). On the 326K-event
  // DB this was a multi-second supervisor tick that pinned the daemon CPU.
  //
  // Single-pass anti-join replacement: LEFT JOIN task_node_opened against
  // its terminal events (uses idx_events_task_kind_ts on (task_id,kind,ts));
  // t.id IS NULL = the task is still open. Count open tasks + take MIN(ts)
  // per directive in ONE grouped pass, exclude closed/archived directives
  // via a single small subquery, and HAVING-filter to directives that are
  // both exploded (ready_count > cap) AND aged (oldest open task past the
  // age cutoff). One query, index-backed, no per-directive loop.
  // Bounded CTE + LEFT JOIN anti-join, run synchronously on the main thread
  // (reverted from the b62fd6d pool off-load — see detectRedispatchStorm). The
  // `n.ts >= scanCutoffIso` clause (SUPERVISOR_DAG_SCAN_WINDOW_MS = 7d) bounds
  // the driving task_node_opened scan to the last week. It cannot miss a real
  // explosion: the HAVING `first_ts <= ageCutoffIso` (now-2h) already requires
  // the oldest OPEN task be ≥ 2h old (well inside 7d), and a genuinely runaway
  // directive has its open tasks' task_node_opened events within the window.
  // EXPLAIN: SEARCH n USING INDEX idx_events_kind_ts (kind=? AND ts>?) — a
  // ts-range seek on the driving scan, not a full SCAN of all task_node_opened.
  const aged = db.query<{
    directive_id: string;
    ready_count: number;
    first_ts: string;
  }, [string, number, string]>(
    `WITH closed_directives AS (
         SELECT DISTINCT directive_id FROM events
         WHERE kind IN ('directive_closed', 'directive_archived_by_operator', 'directive_archived_missed_reviews')
       )
       SELECT n.directive_id AS directive_id,
              COUNT(*)        AS ready_count,
              MIN(n.ts)       AS first_ts
       FROM events n
       LEFT JOIN events t
         ON t.task_id = n.task_id
        AND t.kind IN ('task_committed', 'task_failed', 'task_abandoned')
       WHERE n.kind = 'task_node_opened'
         AND n.ts >= ?
         AND t.id IS NULL
         AND n.directive_id NOT IN (SELECT directive_id FROM closed_directives)
       GROUP BY n.directive_id
       HAVING ready_count > ? AND first_ts <= ?`,
  ).all(scanCutoffIso, SUPERVISOR_MAX_READY_TASKS_PER_DIRECTIVE, ageCutoffIso);

  const archived: Array<{ directive_id: string; ready_count: number; age_hours: number }> = [];
  for (const r of aged) {
    const readyCount = r.ready_count;
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
  opts?: { nowMs?: number },
): Array<{ directive_id: string; dispatch_count: number }> => {
  const nowMs = opts?.nowMs ?? Date.now();
  const cutoffIso = new Date(nowMs - SUPERVISOR_DISPATCH_COUNT_WINDOW_MS).toISOString();
  // Bounded GROUP BY scan, run synchronously on the main thread (reverted from
  // the b62fd6d pool off-load — see detectRedispatchStorm). The
  // `ts >= cutoff` window (SUPERVISOR_DISPATCH_COUNT_WINDOW_MS = 6h) bounds the
  // count to recent dispatches. Cannot miss a real over-budget directive: a
  // directive still burning >50 brain cycles is actively dispatching, so its
  // over-cap count lands inside any recent 6h slice; one that went quiet >6h
  // ago is already dead (DAG age gate fires at 2h). EXPLAIN: SEARCH events
  // USING INDEX idx_events_kind_ts (kind=? AND ts>?) — ts-range seek, not SCAN.
  const rows = db.query<{ directive_id: string; dispatch_count: number }, [string, number]>(
    `SELECT directive_id, COUNT(*) AS dispatch_count
       FROM events
       WHERE kind = 'brain_dispatched' AND ts >= ?
       GROUP BY directive_id
       HAVING dispatch_count > ?`,
  ).all(cutoffIso, SUPERVISOR_MAX_DISPATCHES_PER_DIRECTIVE);

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

/** Detect no-closure-progress loops: directives re-dispatched past
 *  SUPERVISOR_NO_CLOSURE_PROGRESS_DISPATCH_CAP whose latest completed dispatch
 *  emitted no structural progress. The scheduler-side no-progress redispatch
 *  gate is the primary precise guard; this supervisor detector is only a
 *  fallback for completed dispatches, so it must not race in-flight multi-node
 *  build work before the dispatch has had a chance to emit edges, closures, or
 *  deliverables. */
export const detectNoClosureProgressLoop = (
  db: Database,
  opts?: { nowMs?: number },
): Array<{ directive_id: string; dispatch_count: number }> => {
  const nowMs = opts?.nowMs ?? Date.now();
  const cutoffIso = new Date(nowMs - SUPERVISOR_DISPATCH_COUNT_WINDOW_MS).toISOString();
  // Bounded GROUP BY scan, run synchronously on the main thread (reverted from
  // the b62fd6d pool off-load — see detectRedispatchStorm). The
  // `ts >= cutoff` window (SUPERVISOR_DISPATCH_COUNT_WINDOW_MS = 6h) bounds the
  // count to recent dispatches. This detector is a FALLBACK only — the precise
  // scheduler-side terminateNoProgressRedispatch (commit 5b7080d) kills genuine
  // identical-redispatch loops immediately on the first attempted unchanged
  // redispatch. A real no-progress LOOP dispatches frequently (it is a tight
  // cycle), so its >4 dispatches always fall inside a 6h slice; a directive
  // whose only dispatches are >6h old is not actively looping and the precise
  // scheduler guard plus the per-row last-dispatch/progress checks below would
  // not fire on it anyway. EXPLAIN: SEARCH events USING INDEX idx_events_kind_ts
  // (kind=? AND ts>?) — ts-range seek, not a full SCAN. The per-row idempotency
  // / last-dispatch / progress LIMIT-1 lookups below are cheap index point-reads.
  const rows = db.query<{ directive_id: string; dispatch_count: number }, [string, number]>(
    `SELECT directive_id, COUNT(*) AS dispatch_count
       FROM events
       WHERE kind = 'brain_dispatched' AND ts >= ?
       GROUP BY directive_id
       HAVING dispatch_count > ?`,
  ).all(cutoffIso, SUPERVISOR_NO_CLOSURE_PROGRESS_DISPATCH_CAP);

  const progressKinds = [
    "task_committed",
    "task_closure_audited",
    "task_edge_recorded",
    "contract_amendment_proposed",
    "act_artifact_candidate",
    "knowledge_candidate",
  ];
  const progressKindList = progressKinds.map((k) => `'${k}'`).join(", ");

  const archived: Array<{ directive_id: string; dispatch_count: number }> = [];
  for (const r of rows) {
    const terminalOrClosed = db
      .query(
        `SELECT 1 FROM events
         WHERE directive_id = ?
           AND kind IN ('directive_closed', 'directive_archived_by_operator',
                        'directive_archived_missed_reviews', 'task_committed')
         LIMIT 1`,
      )
      .get(r.directive_id);
    if (terminalOrClosed) continue;

    const lastDispatch = db
      .query(
        `SELECT id, ts, task_id, json_extract(payload, '$.dispatch_id') AS dispatch_id
         FROM events
         WHERE directive_id = ? AND kind = 'brain_dispatched'
         ORDER BY ts DESC, rowid DESC
         LIMIT 1`,
      )
      .get(r.directive_id) as { id: string; ts: string; task_id: string | null; dispatch_id: string | null } | null;
    if (!lastDispatch) continue;

    const dispatchClosed = lastDispatch.dispatch_id
      ? db
          .query(
            `SELECT 1 FROM events
             WHERE directive_id = ?
               AND kind = 'brain_dispatch_closed'
               AND json_extract(payload, '$.dispatch_id') = ?
             LIMIT 1`,
          )
          .get(r.directive_id, lastDispatch.dispatch_id)
      : db
          .query(
            `SELECT 1 FROM events
             WHERE directive_id = ?
               AND task_id = ?
               AND kind = 'brain_dispatch_closed'
               AND ts >= ?
             LIMIT 1`,
          )
          .get(r.directive_id, lastDispatch.task_id, lastDispatch.ts);
    if (!dispatchClosed) continue;

    const madeProgressSinceLastDispatch = db
      .query(
        `SELECT 1 FROM events
         WHERE directive_id = ?
           AND ts > ?
           AND kind IN (${progressKindList})
         LIMIT 1`,
      )
      .get(r.directive_id, lastDispatch.ts);
    if (madeProgressSinceLastDispatch) continue;

    try {
      const unfinished = collectUnfinishedTasks(db, r.directive_id);
      emitEvent(db, {
        kind: "directive_archived_by_operator",
        substrate_origin: "substrate_auto",
        directive_id: r.directive_id,
        payload: {
          reason: "supervisor_no_closure_progress_loop",
          dispatch_count: r.dispatch_count,
          threshold: SUPERVISOR_NO_CLOSURE_PROGRESS_DISPATCH_CAP,
          last_dispatch_event_id: lastDispatch.id,
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
          pathology: "no_closure_progress_loop",
          corrective_event: "directive_archived_by_operator",
          dispatch_count: r.dispatch_count,
          threshold: SUPERVISOR_NO_CLOSURE_PROGRESS_DISPATCH_CAP,
          last_dispatch_event_id: lastDispatch.id,
        } as JsonValue,
      });
      archived.push(r);
    } catch (err) {
      logger.warn(
        { where: "supervisor.no_closure_progress", directive_id: r.directive_id, err: (err as Error).message },
        "supervisor failed to archive no-closure-progress directive",
      );
    }
  }
  return archived;
};

/** Round-2 audit (2026-05-15): ready-starvation detector. A task that
 *  sits in ready_tasks_view for longer than this without any
 *  dispatch_decided / brain_dispatched / action_predicted /
 *  terminal event is slow-drift starvation — neither a tight redispatch
 *  storm nor a DAG explosion. 2 hours hardcoded; pending f13 adaptive
 *  scoring (false-positive rate on flagged starvations vs. real stuck
 *  tasks should drive the threshold). */
export const SUPERVISOR_READY_STARVATION_MS = 2 * 60 * 60 * 1000;

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
  // ready_tasks_view scan, run synchronously on the main thread (reverted from
  // the b62fd6d pool off-load — see detectRedispatchStorm). Unlike the other
  // detectors this one CANNOT be bounded to a recent ts window: starvation is
  // about tasks that are OLD (ts <= now - 2h) yet still ready, so a recent-ts
  // floor would suppress exactly the rows it must find. It is instead bounded
  // STRUCTURALLY by the view itself — ready_tasks_view returns only currently
  // non-terminal, non-blocked, non-closed-directive task_node_opened rows (a
  // tiny set: 0 on the current live ledger). The `ts <= cutoff` ceiling is a
  // ts-range seek on the view's driving scan
  // (SEARCH events USING INDEX idx_events_kind_ts (kind=? AND ts<?)); measured
  // ~19ms on the 400k-row ledger — under the 50ms target. The view's internal
  // committed/terminal/blocked CTEs are inherent to readiness and are the only
  // remaining full-kind scans; they do not grow with starvation horizon.
  const candidates = db.query<{ task_id: string; directive_id: string; ts: string }, [string]>(
    `SELECT task_id, directive_id, ts FROM ready_tasks_view
       WHERE ts <= ?`,
  ).all(cutoffIso);

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
  no_closure_progress_loop_count: number;
  ready_starvation_count: number;
  pathology_budget_exhausted_count: number;
  brain_stuck_repeating_action_count: number;
  bridge_health_degraded: boolean;
  bridge_health_recovered: boolean;
  /** True when the cadence throttle skipped the scan this call — a no-op tick.
   *  All counts are zero and no events were emitted. */
  throttled: boolean;
};

/** One supervisor tick. Composes the six pathology detectors + bridge_health
 *  gate. Safe to call repeatedly; every detector is idempotent.
 *
 *  Synchronous (2026-05-24): reverted the b62fd6d SQL-worker-pool off-load.
 *  Pooling full-table scans made the loop block WORSE (event_loop_blocked
 *  ~11s → ~41s) because the concurrent pooled readers contended with the
 *  main-thread SQLite writer (WAL I/O), stalling emit/open_directive ~41-45s.
 *  The real fix is making each detector scan CHEAP: every GROUP BY scan is now
 *  bounded to a recent ts window (idx_events_kind_ts ts-range seek), so the
 *  whole tick touches a few hundred rows and finishes well under 200ms on the
 *  main thread without any cross-thread reader. Single-writer invariant holds.
 *
 *  Cadence-throttled: gated to one real scan per SUPERVISOR_MIN_GAP_MS. A call
 *  inside the gap returns immediately with throttled=true and emits nothing.
 *  Pass opts.force to bypass the throttle (used by detector-level tests that
 *  call the individual detectors; supervisorTick callers normally honor it). */
export const supervisorTick = (
  db: Database,
  opts?: { nowMs?: number; force?: boolean },
): SupervisorTickResult => {
  const result: SupervisorTickResult = {
    redispatch_storm_count: 0,
    dag_explosion_count: 0,
    dispatch_budget_exceeded_count: 0,
    no_closure_progress_loop_count: 0,
    ready_starvation_count: 0,
    pathology_budget_exhausted_count: 0,
    brain_stuck_repeating_action_count: 0,
    bridge_health_degraded: false,
    bridge_health_recovered: false,
    throttled: false,
  };
  const nowMs = opts?.nowMs ?? Date.now();
  if (!opts?.force && nowMs - lastSupervisorRunMs < SUPERVISOR_MIN_GAP_MS) {
    result.throttled = true;
    return result;
  }
  lastSupervisorRunMs = nowMs;
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
    const overBudget = detectDispatchBudgetExceeded(db, opts);
    result.dispatch_budget_exceeded_count = overBudget.length;
    for (const b of overBudget) debitOnDirective(b.directive_id, "dispatch_budget_exceeded", "supervisor.dispatch_budget");
  } catch (err) {
    logger.warn({ where: "supervisor.tick.dispatch_budget", err: (err as Error).message }, "dispatch-budget detector failed");
  }
  try {
    const noProgress = detectNoClosureProgressLoop(db, opts);
    result.no_closure_progress_loop_count = noProgress.length;
    for (const n of noProgress) debitOnDirective(n.directive_id, "no_closure_progress_loop", "supervisor.no_closure_progress");
  } catch (err) {
    logger.warn({ where: "supervisor.tick.no_closure_progress", err: (err as Error).message }, "no-closure-progress detector failed");
  }
  try {
    const starved = probeReadyStarvation(db, opts);
    result.ready_starvation_count = starved.length;
    for (const s of starved) debitOnDirective(s.directive_id, "ready_starvation", "supervisor.ready_starvation");
  } catch (err) {
    logger.warn({ where: "supervisor.tick.ready_starvation", err: (err as Error).message }, "ready-starvation detector failed");
  }
  try {
    const stuck = detectRepeatingAction(db, opts);
    result.brain_stuck_repeating_action_count = stuck.length;
    for (const s of stuck) debitOnDirective(s.directive_id, "brain_stuck_repeating_action", "supervisor.repeating_action");
  } catch (err) {
    logger.warn({ where: "supervisor.tick.repeating_action", err: (err as Error).message }, "repeating-action detector failed");
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
  // scattered alarms. Brain convergence audit axis H (2026-05-15):
  // when exhaustion fires, ALSO archive the directive with the same
  // recoverable operator-archive shape used by dispatch-budget
  // exhaustion so quarantined_tasks are preserved and the operator
  // can resume via `acc directive resume <id>`.
  for (const directiveId of affectedDirectives) {
    try {
      const emittedId = maybeExhaustPathologyBudget(db, directiveId, opts);
      if (emittedId) {
        result.pathology_budget_exhausted_count++;
        // Idempotency: skip if already closed/archived.
        const alreadyClosed = db
          .query(
            `SELECT 1 FROM events
             WHERE directive_id = ?
               AND kind IN ('directive_closed', 'directive_archived_by_operator', 'directive_archived_missed_reviews')
             LIMIT 1`,
          )
          .get(directiveId);
        if (!alreadyClosed) {
          const unfinished = collectUnfinishedTasks(db, directiveId);
          emitEvent(db, {
            kind: "directive_archived_by_operator",
            substrate_origin: "substrate_auto",
            directive_id: directiveId,
            payload: {
              reason: "pathology_budget_exhausted",
              evidence_event_id: emittedId,
              quarantined_tasks: unfinished,
              recoverable: true,
              resume_command: `acc directive resume ${directiveId}`,
            } as JsonValue,
          });
          emitEvent(db, {
            kind: "supervisor_intervention_recorded",
            substrate_origin: "substrate_auto",
            directive_id: directiveId,
            payload: {
              pathology: "pathology_budget_exhausted",
              corrective_event: "directive_archived_by_operator",
              evidence_event_id: emittedId,
            } as JsonValue,
          });
        }
      }
    } catch (err) {
      logger.warn(
        { where: "supervisor.tick.budget_exhaust", directive_id: directiveId, err: (err as Error).message },
        "pathology budget exhaustion check failed",
      );
    }
  }
  return result;
};
