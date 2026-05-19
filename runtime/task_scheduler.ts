// acc2 task scheduler — picks ready tasks and dispatches them
// (v2-design.md §9.1).
//
// Phase E lights up real parallelism:
//   - Up to maxConcurrent dispatches per tick (default 5, configurable up to
//     10 in crisis mode).
//   - Tracks in-flight dispatches via an in-memory map keyed by task_id so
//     successive ticks know how many slots are free.
//   - Routes through decideDispatch:
//       substrate_replay → dispatchReadyTask (which calls replayRecipe from
//                          runtime/recipe_replay.ts — real Tier-0 replay).
//       claude_inline    → emit `claude_inline_lane_routed` event; main
//                          Claude reads the event stream and runs inline.
//                          Scheduler does NOT dispatch from this lane.
//       opencode_brain   → dispatchReadyTask (Phase D dispatcher).
//   - Concurrent dispatches run via Promise.all with per-dispatch error
//     isolation (a failed dispatch must not crash the tick).
//   - schedulerLoop is a setInterval-style loop suitable for the daemon to
//     run continuously; honors a stop signal via AbortController.
//
// The scheduler's in-flight registry is process-local. Multi-process daemons
// would need a SQLite-backed lease table — Phase G+ adds that when uv /
// camofox runtimes show up.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { readDagForDirective, readyTasks, type TaskNode } from "./task_topology";
import { dispatchReadyTask } from "./task_dispatcher";
import { decideDispatch, dispatchEvidencePayload } from "./dispatch_decider";
import { emitEvent } from "./events";
import { readCurrentMode, applyModeAdjustments } from "./crisis_mode";
import { findDeferringConflict } from "./interference";
import { isBridgeHealthDegraded } from "./bridge_health";

// Interaction kinds that block another directive's dispatch when one of the
// two is mid-flight. `mutual_exclusion` is symmetric (either side blocks the
// other while in flight); `resource_conflict` denotes a shared exhaustible
// resource (attention, calendar slot, budget) — concurrent dispatch is
// permitted to be down-ranked rather than refused, but Father-style ranking
// uses the same set. The set is exported so Phase DAG callers and Father's
// selector reference the same canonical taxonomy.
export const CROSS_DIRECTIVE_BLOCKING_INTERACTIONS: ReadonlySet<string> = new Set([
  "mutual_exclusion",
  "resource_conflict",
]);

export type SchedulerOpts = {
  maxConcurrent?: number;
  pollIntervalMs?: number;
  directiveId?: string;
  fixtureTargetPath?: string;
  /** EmbeddingIndex threaded through to dispatchReadyTask so depth-1
   *  retrieval can fire before composePrompt. Without this the brain
   *  prompt's KNOWLEDGE section is always built from recency, not the
   *  cosine × posterior reranker. Knowledge audit bc5vdkrik #1. */
  index?: import("./embedding_index").EmbeddingIndex;
  /** Multi-goal alignment (2026-05-15): per-directive in-flight cap so
   *  one runaway goal cannot consume every scheduler slot and starve
   *  parallel goals. Defaults to ceil(maxConcurrent / 2) — at most half
   *  of the global slots can belong to a single directive at any time.
   *  Explicit 0 disables (legacy behaviour). */
  maxConcurrentPerDirective?: number;
};

export type SchedulerTick = {
  dispatched: string[];
  in_flight: string[];
  skipped_concurrency_cap: string[];
  skipped_recipe: string[];
  skipped_inline: string[];
  skipped_blocked: string[];
  /** Tasks not admitted because the daemon is in graceful restart drain. */
  skipped_draining: string[];
  /** Tasks deferred because a `mutual_exclusion` or `resource_conflict`
   *  interference edge points at an in-flight peer directive. The scheduler
   *  emits `task_deferred_for_interference` for each entry here. */
  skipped_interference: string[];
  /** Tasks the scheduler quarantined because they hit
   *  `MAX_CONSECUTIVE_BRIDGE_FAILURES` in a row with no successful
   *  interleaving event. Each entry corresponds to a `task_failed` row with
   *  `failure_kind: "consecutive_bridge_failures"`. */
  skipped_failure_capped: string[];
};

const DEFAULT_MAX_CONCURRENT = 5;
const DEFAULT_POLL_INTERVAL_MS = 500;

/** OOM defence: opencode subprocesses run gpt-5.5 and consume ~1-2GB RAM
 *  each. Four parallel brain dispatches on an 8GB host trigger the OS
 *  OOM-killer (exit 137 SIGKILL) — observed 2026-05-15 during a 4-way
 *  parallel orchestrator dispatch. The cap is computed DYNAMICALLY from
 *  available host RAM at dispatch time so the same daemon runs sensibly
 *  on a 4GB laptop (cap=1), an 8GB workstation (cap=2-3), and a 32GB
 *  workhorse (cap=10+) WITHOUT operator tuning. No env knob — matches
 *  the "no new env vars" operating rule and the user's directive that
 *  the system should self-determine brain parallelism. */
// Per-opencode-subprocess RAM budget. Empirical observation 2026-05-16:
// 3 live opencode subprocesses doing real brain cycles each held ~340MB RSS
// (`ps -eo pid,rss,comm | grep opencode` during a parallel-dispatch ant
// audit). The previous 1.8GB constant was ~6× over-provisioned, which
// caused brain_in_flight_at_cap saturation cascades (≥130 rejections in
// 2min) whenever the operator dispatched ≥4 parallel `acc task`
// directives. 700MB sits comfortably above observed peak with headroom
// for prompt-context growth + bridge buffers, and lets a 16GB host run
// ~8 concurrent brains instead of 3. Single universal value — no env
// override; the universal workflow stays one path.
const BRAIN_PROCESS_RAM_BYTES = 700_000_000;
const HOST_RAM_RESERVE_BYTES = 2_000_000_000;  // ~2GB kept for OS + daemon + bun + tests

/** Compute the brain-dispatch cap from live host memory. We use the
 *  *less* of available-free and the conservative free-from-total
 *  estimate to avoid optimism when the OS reports stale "free" while
 *  the page cache is hot. Floor of 1 — we never block dispatch entirely
 *  even on a tiny host; the user can always run one brain at a time. */
export const computeBrainDispatchCap = (): number => {
  let totalBytes = 0;
  let freeBytes = 0;
  try {
    // Use require-like indirection so the field is read at call time, not
    // module load time — important for tests that mock process.memoryUsage.
    const os = require("node:os") as typeof import("node:os");
    totalBytes = os.totalmem();
    freeBytes = os.freemem();
  } catch {
    return 2; // os module shouldn't fail; conservative default if it does.
  }
  const usableBytes = Math.max(0, Math.min(freeBytes, totalBytes - HOST_RAM_RESERVE_BYTES));
  const cap = Math.floor(usableBytes / BRAIN_PROCESS_RAM_BYTES);
  return Math.max(1, cap);
};

/** Track in-flight opencode_brain dispatches separately so the brain cap
 *  is enforced independently of the global cap. Same lifecycle as
 *  IN_FLIGHT — entries inserted at dispatch, deleted on promise
 *  resolution / rejection / catch. */
const IN_FLIGHT_BRAIN: Set<string> = new Set();

/** (task_id, gate_name) pairs that have already emitted a
 *  constitutional_gate_decision in the current queueing cycle. Without this
 *  dedupe the scheduler tick (every 500ms) would re-emit gate events for
 *  every ready task on every tick while a gate stays closed, flooding the
 *  SQLite write queue (~340 events / 10min observed 2026-05-16 across
 *  brain_concurrency_cap + bridge_health_degraded gates, which throttled
 *  FastMCP request handling and made substrate.open_directive time out).
 *  Entries cleared when the corresponding task settles OR when ALL brain
 *  slots open (signal a fresh cycle). Tests call _resetSchedulerForTests. */
const GATE_NOTIFIED: Set<string> = new Set();
const gateKey = (taskId: string, gate: string): string => `${taskId}:${gate}`;

const clearInFlightTask = (taskId: string): void => {
  IN_FLIGHT.delete(taskId);
  IN_FLIGHT_DIRECTIVE.delete(taskId);
  IN_FLIGHT_PARENT.delete(taskId);
  IN_FLIGHT_BRAIN.delete(taskId);
  GATE_NOTIFIED.delete(gateKey(taskId, "brain_concurrency_cap"));
  GATE_NOTIFIED.delete(gateKey(taskId, "bridge_health_degraded"));
  if (IN_FLIGHT_BRAIN.size === 0) GATE_NOTIFIED.clear();
};

/** Max consecutive `bridge_failed` events for a single task before the
 *  scheduler quarantines it with `task_failed { failure_kind:
 *  "consecutive_bridge_failures" }`. Without this cap, a structural issue
 *  (mcp_server_url_missing, brain_silent_exit, mcp_handshake_timed_out, auth_missing) causes the
 *  scheduler to hot-loop the same task forever — every 500ms tick re-picks
 *  the same task because `readyTasks` only filters by committed/failed and
 *  no `task_failed` is ever emitted for bridge-level failures. The cap is
 *  generous enough to absorb transient network blips (default 3) but tight
 *  enough that an operator notices fast. */
export const MAX_CONSECUTIVE_BRIDGE_FAILURES = 3;

/** Count consecutive `bridge_failed` events for a task with no intervening
 *  successful frame (`action_predicted`, `bridge_mcp_connected`, or
 *  `task_committed`). Returns the run-length of the most recent failure
 *  streak. */
const consecutiveBridgeFailureEvidence = (db: Database, taskId: string): Array<{ id: string; reason: string | null; ts: string }> => {
  const rows = db
    .query(
      `SELECT id, kind, ts, payload FROM events
       WHERE task_id = ?
         AND kind IN ('bridge_failed','action_predicted','bridge_mcp_connected','task_committed')
       ORDER BY ts DESC, rowid DESC LIMIT 50`,
    )
    .all(taskId) as Array<{ id: string; kind: string; ts: string; payload: string }>;
  const out: Array<{ id: string; reason: string | null; ts: string }> = [];
  for (const r of rows) {
    if (r.kind !== "bridge_failed") break;
    let reason: string | null = null;
    try {
      const payload = JSON.parse(r.payload ?? "{}") as Record<string, unknown>;
      reason = typeof payload.reason === "string" ? payload.reason : null;
    } catch { /* malformed payload: evidence id is still useful */ }
    out.push({ id: r.id, reason, ts: r.ts });
  }
  return out;
};

const consecutiveBridgeFailures = (db: Database, taskId: string): number =>
  consecutiveBridgeFailureEvidence(db, taskId).length;

/** Bridge-failure reasons that indicate the BRAIN itself failed to make
 *  progress (vs a transient transport issue). These failures are
 *  DETERMINISTIC: the brain will fail the same way on the same task again.
 *  Re-dispatching wastes 5+ minutes of brain-slot time per attempt.
 *  Foundational audit 2026-05-17: ledger evidence showed CHRZM6VX4H7YVF7D
 *  silent-failing 5 times in a row (each a 5-min watchdog kill) while
 *  never accumulating 3 CONSECUTIVE generic failures (other tasks landed
 *  in between). The generic cap (3) is right for transport hiccups; this
 *  tighter cap (1) is right for silent failures which are deterministic.
 *  After ONE silent-class failure, the task is quarantined with
 *  `failure_kind: "silent_dispatch_quarantine"` — operator may re-open via
 *  a fresh task_id once the underlying compatibility issue is resolved. */
const SILENT_DISPATCH_REASONS: ReadonlySet<string> = new Set([
  "brain_silent_exit",
  "mcp_handshake_timed_out",
  "subprocess_stuck",
]);

const MAX_SILENT_DISPATCH_FAILURES = 1;

/** Count silent-class bridge_failed events for a task (irrespective of
 *  whether they're consecutive). A task that silent-failed even ONCE has
 *  proven brain-incompatible for this dispatch shape; further attempts on
 *  the same task waste compute. Use the entire task history (not just the
 *  recent streak) because silent-class is deterministic and persists. */
const silentDispatchFailureEvidence = (
  db: Database,
  taskId: string,
): Array<{ id: string; reason: string; ts: string }> => {
  const rows = db
    .query(
      `SELECT id, ts, payload FROM events
       WHERE task_id = ?
         AND kind = 'bridge_failed'
       ORDER BY ts ASC`,
    )
    .all(taskId) as Array<{ id: string; ts: string; payload: string }>;
  const out: Array<{ id: string; reason: string; ts: string }> = [];
  for (const r of rows) {
    let reason: string | null = null;
    try {
      const payload = JSON.parse(r.payload ?? "{}") as Record<string, unknown>;
      reason = typeof payload.reason === "string" ? payload.reason : null;
    } catch { /* skip malformed */ }
    if (reason && SILENT_DISPATCH_REASONS.has(reason)) {
      out.push({ id: r.id, reason, ts: r.ts });
    }
  }
  return out;
};

// Process-local in-flight registry. The scheduler is the only writer; the
// dispatcher promises resolve here. Keys are task_ids; values are the
// underlying promise so the loop can await any completion when needed.
const IN_FLIGHT: Map<string, Promise<unknown>> = new Map();

// Companion map: task_id → directive_id so the scheduler can compute the set
// of in-flight directives without re-reading SQLite. Kept in sync with
// IN_FLIGHT (same insertion / deletion sites). Used for the interference
// concurrency check (`findDeferringConflict`).
const IN_FLIGHT_DIRECTIVE: Map<string, string> = new Map();
const IN_FLIGHT_PARENT: Map<string, string | null> = new Map();
let SCHEDULER_DRAINING = false;

/** Fence scheduler admission during daemon restart drain. Existing dispatches
 *  keep running; new ready tasks stay ready and are picked up by the next
 *  daemon generation after boot recovery reconciles any unclosed leases. */
export const setSchedulerDraining = (draining: boolean): void => {
  SCHEDULER_DRAINING = draining;
};

export const isSchedulerDraining = (): boolean => SCHEDULER_DRAINING;

export const inFlightDispatchTaskIds = (): string[] => Array.from(IN_FLIGHT.keys());

const refinementParent = (db: Database, task: TaskNode): string | null => {
  if (task.parent_id) return task.parent_id;
  const { edges } = readDagForDirective(db, task.directive_id);
  const refine = edges.find((e) => e.kind === "refines" && e.to_task === task.id);
  return refine?.from_task ?? null;
};

const hasRequiresEdgeBetween = (db: Database, directiveId: string, a: string, b: string): boolean => {
  const { edges } = readDagForDirective(db, directiveId);
  return edges.some((e) => e.kind === "requires" && ((e.from_task === a && e.to_task === b) || (e.from_task === b && e.to_task === a)));
};

const hasParallelSiblingSlot = (db: Database, task: TaskNode): boolean => {
  const parent = refinementParent(db, task);
  if (!parent) return false;
  for (const [inFlightTaskId, inFlightParent] of IN_FLIGHT_PARENT.entries()) {
    if (inFlightParent !== parent) continue;
    if (hasRequiresEdgeBetween(db, task.directive_id, task.id, inFlightTaskId)) continue;
    return true;
  }
  return false;
};

const emitInlineLaneRouted = (
  db: Database,
  task: TaskNode,
  reason: string,
): void => {
  emitEvent(db, {
    kind: "constitutional_gate_decision",
    substrate_origin: "substrate_auto",
    directive_id: task.directive_id,
    task_id: task.id,
    payload: {
      gate: "claude_inline_lane_routed",
      reason,
      task_id: task.id,
    } as JsonValue,
  });
};

const emitSchedulerAdmissionGate = (
  db: Database,
  task: TaskNode,
  gate: string,
  payload: Record<string, JsonValue>,
): void => {
  const key = gateKey(task.id, gate);
  if (GATE_NOTIFIED.has(key)) return;
  GATE_NOTIFIED.add(key);
  emitEvent(db, {
    kind: "constitutional_gate_decision",
    substrate_origin: "substrate_auto",
    directive_id: task.directive_id,
    task_id: task.id,
    payload: {
      gate,
      task_id: task.id,
      ...payload,
    } as JsonValue,
  });
};

/** One tick: read ready tasks, fill open dispatch slots, route by lane.
 *  Returns immediately after launching dispatches — the per-task promises
 *  remain tracked in IN_FLIGHT until they resolve. Tests await the
 *  per-dispatch promise by calling schedulerTickAwait. */
export const schedulerTick = async (
  db: Database,
  opts: SchedulerOpts = {},
): Promise<SchedulerTick> => {
  // Crisis-mode adjustments: if a directive scope is supplied AND that
  // directive is in crisis, raise maxConcurrent before applying the cap.
  // Without a directive scope we keep the caller's baseline (Phase K Father
  // will pick the active directive for us).
  let effectiveOpts: SchedulerOpts = { ...opts };
  if (opts.directiveId) {
    const mode = readCurrentMode(db, opts.directiveId);
    effectiveOpts = applyModeAdjustments(effectiveOpts, mode);
  }
  const maxConcurrent = Math.max(1, effectiveOpts.maxConcurrent ?? opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
  // Multi-goal alignment (2026-05-15): per-directive cap so one
  // runaway goal can't starve concurrent goals. Default to half the
  // global cap; explicit 0 disables.
  const rawPerDir = effectiveOpts.maxConcurrentPerDirective ?? opts.maxConcurrentPerDirective;
  const maxConcurrentPerDirective = rawPerDir === 0
    ? Number.MAX_SAFE_INTEGER
    : Math.max(1, rawPerDir ?? Math.ceil(maxConcurrent / 2));
  const ready = readyTasks(db, opts.directiveId);
  if (SCHEDULER_DRAINING) {
    for (const task of ready) {
      emitSchedulerAdmissionGate(db, task, "scheduler_draining", {
        reason: "scheduler_admission_paused_for_restart_drain",
        in_flight: IN_FLIGHT.size,
      });
    }
    return {
      dispatched: [],
      in_flight: Array.from(IN_FLIGHT.keys()),
      skipped_concurrency_cap: [],
      skipped_recipe: [],
      skipped_inline: [],
      skipped_blocked: [],
      skipped_draining: ready.map((task) => task.id),
      skipped_interference: [],
      skipped_failure_capped: [],
    };
  }

  // Branch-competition lane: when sibling refinement branches expose
  // trigger_residual / expected_residual_delta, prefer the branch with the
  // best expected residual reduction before falling back to oldest-ready
  // fairness. This keeps strategic alternatives competing on verifier axes
  // instead of whichever task_node_opened happened to be oldest.
  const taskOpenedTs = (taskId: string): string => {
    const row = db
      .query("SELECT ts FROM events WHERE kind = 'task_node_opened' AND task_id = ? ORDER BY ts ASC LIMIT 1")
      .get(taskId) as { ts: string } | null;
    return row?.ts ?? "";
  };
  const branchCompetitionScore = (taskId: string): number => {
    const row = db
      .query("SELECT payload FROM events WHERE kind = 'task_edge_recorded' AND json_extract(payload, '$.to_task') = ? ORDER BY ts DESC LIMIT 1")
      .get(taskId) as { payload: string } | null;
    if (!row) return 0;
    try {
      const p = JSON.parse(row.payload) as { trigger_residual?: number; expected_residual_delta?: number };
      return Math.max(0, Number(p.trigger_residual ?? 0)) * Math.max(0, Number(p.expected_residual_delta ?? 0));
    } catch { return 0; }
  };
  // Operator-dispatch fairness floor (foundational fix 2026-05-18):
  // pre-fix the scheduler ordered by branchCompetitionScore first (refinement
  // edges with trigger_residual × expected_residual_delta), then by
  // task_opened_ts oldest-first. Operator-initiated root tasks have NO
  // refinement edge pointing to them → branchCompetitionScore = 0 → they
  // perpetually lose to any brain-emitted child carrying even a tiny
  // residual hint. Observed: a 4-hour-old operator `acc task` landed in
  // orphan_node while 43 brain_dispatched fired in 10 min — pure
  // starvation by branch competition.
  //
  // Fix: add an age bonus to the effective score. Below 5 min waiting,
  // bonus is 0 (branch competition wins, the intended fast path). Over
  // 5 min, bonus grows linearly (+1.0 per 5 min). After 30 min waiting,
  // bonus = 5.0 which beats almost any branchCompetitionScore (residual
  // × delta is bounded ∈ [0,1]). This guarantees an operator dispatch
  // can never be starved indefinitely, while letting fresh refinement
  // edges still take precedence in normal operation.
  const ageBonusFor = (taskId: string): number => {
    const ts = taskOpenedTs(taskId);
    if (!ts) return 0;
    const ageMs = Math.max(0, Date.now() - Date.parse(ts));
    const FAIRNESS_AGE_THRESHOLD_MS = 5 * 60 * 1000;
    const FAIRNESS_AGE_BONUS_PER_MS = 1 / FAIRNESS_AGE_THRESHOLD_MS;
    return Math.max(0, (ageMs - FAIRNESS_AGE_THRESHOLD_MS) * FAIRNESS_AGE_BONUS_PER_MS);
  };
  const effectiveScore = (taskId: string): number => branchCompetitionScore(taskId) + ageBonusFor(taskId);
  ready.sort((a, b) => {
    const scoreDelta = effectiveScore(b.id) - effectiveScore(a.id);
    if (scoreDelta !== 0) return scoreDelta;
    return taskOpenedTs(a.id).localeCompare(taskOpenedTs(b.id));
  });

  const dispatched: string[] = [];
  const skippedConcurrencyCap: string[] = [];
  const skippedRecipe: string[] = [];
  const skippedInline: string[] = [];
  const skippedBlocked: string[] = [];
  const skippedInterference: string[] = [];
  const skippedFailureCapped: string[] = [];
  const pending: Array<Promise<unknown>> = [];

  for (const task of ready) {
    if (IN_FLIGHT.has(task.id)) continue; // already dispatched in a prior tick.

    // SILENT-DISPATCH QUARANTINE (FOUNDATIONAL FIX 2026-05-17):
    // Brain failures classified as `brain_silent_exit`, `mcp_handshake_timed_out`,
    // or `subprocess_stuck` are DETERMINISTIC — the brain will fail the same
    // way on the same task again. Live ledger evidence: CHRZM6VX4H7YVF7D
    // silent-failed 5 times in a row across multiple dispatches, each
    // consuming 5 min of brain-slot time, never accumulating 3 CONSECUTIVE
    // generic failures (the consecutive cap below) because other tasks
    // landed in between. The generic cap protects against transport flaps;
    // this tighter silent-class cap (1) prevents wasted compute on
    // structurally-incompatible tasks. Operator may re-open via a fresh
    // task_id once the prompt/grammar issue is fixed.
    const silentFailures = silentDispatchFailureEvidence(db, task.id);
    if (silentFailures.length >= MAX_SILENT_DISPATCH_FAILURES) {
      skippedFailureCapped.push(task.id);
      emitEvent(db, {
        kind: "task_failed",
        substrate_origin: "substrate_auto",
        directive_id: task.directive_id,
        task_id: task.id,
        failure_kind: "silent_dispatch_quarantine",
        payload: {
          silent_failures: silentFailures.length,
          cap: MAX_SILENT_DISPATCH_FAILURES,
          reason: "silent_dispatch_quarantine",
          reasons_observed: Array.from(new Set(silentFailures.map((f) => f.reason))),
          backoff_mode: "terminal_after_silent_class_failure",
          retry_evidence_event_ids: silentFailures.map((f) => f.id),
          retry_evidence: silentFailures,
          hint: "brain produced zero substrate emits for this task (deterministic). Re-dispatch on the same task_id will repeat the failure. Operator should investigate prompt shape OR re-open via a fresh task_id once the brain-incompatible pattern is resolved.",
        } as JsonValue,
      });
      continue;
    }

    // Consecutive-failure backoff (no retry storm). If the task's most-recent
    // bridge_failed streak hit the cap, emit `task_failed` so it drops out of
    // `readyTasks` on the next call — the cap prevents the scheduler from
    // hot-looping a structurally broken dispatch (mcp_server_url_missing,
    // auth_missing, etc.). Silent-class failures are caught above by the
    // tighter MAX_SILENT_DISPATCH_FAILURES gate; this generic cap is for
    // transient transport failures. Operators see the failure verbatim
    // in the substrate and can re-open the task once the underlying gap is
    // fixed (the next `acc task` call gets a fresh task_id).
    const failureStreak = consecutiveBridgeFailures(db, task.id);
    if (failureStreak >= MAX_CONSECUTIVE_BRIDGE_FAILURES) {
      skippedFailureCapped.push(task.id);
      const failureEvidence = consecutiveBridgeFailureEvidence(db, task.id);
      emitEvent(db, {
        kind: "task_failed",
        substrate_origin: "substrate_auto",
        directive_id: task.directive_id,
        task_id: task.id,
        failure_kind: "consecutive_bridge_failures",
        payload: {
          consecutive_failures: failureStreak,
          cap: MAX_CONSECUTIVE_BRIDGE_FAILURES,
          reason: "consecutive_bridge_failures_exceeded_cap",
          backoff_mode: "terminal_after_consecutive_bridge_failures",
          retry_evidence_event_ids: failureEvidence.map((e) => e.id),
          retry_evidence: failureEvidence,
        } as JsonValue,
      });
      continue;
    }

    // Cross-directive interference (Phase DAG): defer when a peer directive
    // joined by `mutual_exclusion` / `resource_conflict` is in-flight. We
    // assemble the in-flight directive set from the live registry (the same
    // tick's dispatches are appended below so two intra-tick conflicts also
    // serialise).
    const inFlightDirectives = new Set<string>(IN_FLIGHT_DIRECTIVE.values());
    const conflict = findDeferringConflict(db, task.directive_id, inFlightDirectives);
    if (conflict !== null) {
      skippedInterference.push(task.id);
      emitEvent(db, {
        kind: "task_deferred_for_interference",
        substrate_origin: "substrate_auto",
        directive_id: task.directive_id,
        task_id: task.id,
        payload: {
          from_directive: task.directive_id,
          conflicting_directive: conflict.conflicting_directive,
          interaction: conflict.kind,
          reason: "concurrency_conflict_with_in_flight_directive",
        } as JsonValue,
      });
      emitSchedulerAdmissionGate(db, task, "scheduler_interference_deferred", {
        reason: "concurrency_conflict_with_in_flight_directive",
        conflicting_directive: conflict.conflicting_directive,
        interaction: conflict.kind,
      });
      continue;
    }

    const slotsLeft = maxConcurrent - IN_FLIGHT.size;
    if (slotsLeft <= 0) {
      skippedConcurrencyCap.push(task.id);
      emitSchedulerAdmissionGate(db, task, "scheduler_global_concurrency_cap", {
        reason: "scheduler_global_in_flight_at_cap",
        in_flight: IN_FLIGHT.size,
        cap: maxConcurrent,
      });
      continue;
    }
    // Per-directive cap: how many slots is THIS directive already using?
    // When ≥ maxConcurrentPerDirective, defer this task so peer goals
    // get a turn. Logged via skippedConcurrencyCap so the scheduler-
    // tick payload shows the queue pressure.
    let perDirCount = 0;
    for (const d of IN_FLIGHT_DIRECTIVE.values()) {
      if (d === task.directive_id) perDirCount++;
    }
    if (perDirCount >= maxConcurrentPerDirective && !hasParallelSiblingSlot(db, task)) {
      skippedConcurrencyCap.push(task.id);
      emitSchedulerAdmissionGate(db, task, "scheduler_per_directive_concurrency_cap", {
        reason: "scheduler_directive_in_flight_at_cap",
        directive_in_flight: perDirCount,
        cap: maxConcurrentPerDirective,
      });
      continue;
    }

    const decision = decideDispatch(db, task);
    const dispatchDecisionEvidence = dispatchEvidencePayload(decision);
    if (decision.route === "deferred_blocked") {
      skippedBlocked.push(task.id);
      emitEvent(db, {
        kind: "dispatch_decided",
        substrate_origin: "substrate_auto",
        directive_id: task.directive_id,
        task_id: task.id,
        payload: {
          ...dispatchDecisionEvidence,
        } as JsonValue,
      });
      emitEvent(db, {
        kind: "constitutional_gate_decision",
        substrate_origin: "substrate_auto",
        directive_id: task.directive_id,
        task_id: task.id,
        payload: {
          gate: "directive_blocked_deferred",
          blockers: decision.blockers,
          ...dispatchDecisionEvidence,
        } as JsonValue,
      });
      continue;
    }

    // substrate_replay falls through to dispatchReadyTask below, which calls
    // replayRecipe (runtime/recipe_replay.ts) internally. The scheduler used
    // to short-circuit this route with a Phase-J stub (returning
    // {ok:false, error:"phase_j"} on every tick — tight loop emitting
    // `substrate_replay_skipped` because readyTasks kept returning the same
    // task forever). Real Tier-0 replay now runs.

    if (decision.route === "claude_inline") {
      emitEvent(db, {
        kind: "dispatch_decided",
        substrate_origin: "substrate_auto",
        directive_id: task.directive_id,
        task_id: task.id,
        payload: {
          ...dispatchDecisionEvidence,
        } as JsonValue,
      });
      skippedInline.push(task.id);
      emitInlineLaneRouted(db, task, decision.reason);
      continue;
    }

    // Batch 8.A bridge-health gate (cite brain lesson 5SWP11NZFS3YX68Y95T164HT9W):
    // when ≥ BRIDGE_DEGRADATION_THRESHOLD bridge_failed events fired within
    // BRIDGE_FAILURE_WINDOW_MS, the substrate flips to degraded. The brain
    // surfaced this pattern in a workflow-policy lesson_extracted:
    //   "Add a pre-dispatch bridge-health gate or scheduler backoff that
    //    pauses repeated opencode dispatch after bridge_stuck/no-frame
    //    streaks and opens a diagnostic task instead of spawning duplicate
    //    stale dispatches."
    // Tier-0 substrate_replay and claude_inline lanes still dispatch; only
    // the opencode_brain lane is paused. Auto-clears via bridge_health_recovered
    // when BRIDGE_HEALTH_COOLDOWN_MS passes with no further failures.
    if (decision.route === "opencode_brain" && isBridgeHealthDegraded(db)) {
      const key = gateKey(task.id, "bridge_health_degraded");
      if (!GATE_NOTIFIED.has(key)) {
        GATE_NOTIFIED.add(key);
        emitEvent(db, {
          kind: "constitutional_gate_decision",
          substrate_origin: "substrate_auto",
          directive_id: task.directive_id,
          task_id: task.id,
          payload: {
            gate: "bridge_health_degraded",
            reason: "opencode_brain_dispatch_paused_pending_bridge_recovery",
            note: "single notification per task while gate closed; cleared on recovery or task settle",
          } as JsonValue,
        });
      }
      continue;
    }

    // OOM defence: each opencode subprocess consumes ~1-2GB. The global
    // maxConcurrent cap counts ALL routes (substrate_replay + claude_inline
    // + opencode_brain) — cheap routes shouldn't squeeze brain runs out, but
    // ALSO brain runs shouldn't pile up unbounded on top of cheap ones. The
    // brain cap is computed dynamically from live host RAM at dispatch time
    // (computeBrainDispatchCap) so the same daemon runs correctly on hosts
    // with 4GB / 8GB / 32GB / 64GB RAM without operator tuning. When full,
    // the task stays in ready state and re-attempts next tick.
    if (decision.route === "opencode_brain") {
      const brainCap = computeBrainDispatchCap();
      if (IN_FLIGHT_BRAIN.size >= brainCap) {
        // Dedupe at_cap notifications per (task_id, gate) — see GATE_NOTIFIED.
        const key = gateKey(task.id, "brain_concurrency_cap");
        if (!GATE_NOTIFIED.has(key)) {
          GATE_NOTIFIED.add(key);
          emitEvent(db, {
            kind: "constitutional_gate_decision",
            substrate_origin: "substrate_auto",
            directive_id: task.directive_id,
            task_id: task.id,
            payload: {
              gate: "brain_concurrency_cap",
              reason: "opencode_brain_in_flight_at_cap",
              in_flight_brain: IN_FLIGHT_BRAIN.size,
              cap: brainCap,
              cap_source: "dynamic_host_ram",
              note: "single notification per saturation cycle; tick keeps trying silently until cap clears",
            } as JsonValue,
          });
        }
        continue;
      }
    }

    // opencode_brain lane → actual dispatch.
    if (decision.route === "opencode_brain") IN_FLIGHT_BRAIN.add(task.id);
    const promise = dispatchReadyTask(db, task, {
      fixtureTargetPath: opts.fixtureTargetPath,
      index: opts.index,
    })
      .catch((err: Error) => {
        // Per-dispatch error isolation. Record a failure event so the audit
        // trail stays complete; the tick continues.
        try {
          emitEvent(db, {
            kind: "dispatcher_violation",
            substrate_origin: "substrate_auto",
            directive_id: task.directive_id,
            task_id: task.id,
            failure_kind: "bridge_killed",
            payload: {
              gate: "scheduler_dispatch_isolated_error",
              error: err.message ?? String(err),
            } as JsonValue,
          });
        } catch { /* swallow */ }
      })
      .finally(() => {
        clearInFlightTask(task.id);
      });
    // Mark settled-flag accessor lazily — best-effort cleanup helper.
    (promise as Promise<unknown> & { _settled?: boolean })._settled = false;
    void promise.then(
      () => ((promise as Promise<unknown> & { _settled?: boolean })._settled = true),
      () => ((promise as Promise<unknown> & { _settled?: boolean })._settled = true),
    );
    IN_FLIGHT.set(task.id, promise);
    IN_FLIGHT_DIRECTIVE.set(task.id, task.directive_id);
    IN_FLIGHT_PARENT.set(task.id, refinementParent(db, task));
    pending.push(promise);
    dispatched.push(task.id);
  }

  // Production scheduler ticks return after launching dispatches so sibling
  // brain leaves can run concurrently across poll cycles. Tests that need a
  // drain point should await the tracked promises (IN_FLIGHT registry) via
  // `drainInFlightDispatches(db)` instead.
  if (pending.length > 0) {
    // Track but DON'T await — sibling leaves dispatch concurrently.
    // Each promise self-cleans from IN_FLIGHT via its .finally() handler.
  }

  return {
    dispatched,
    in_flight: Array.from(IN_FLIGHT.keys()),
    skipped_concurrency_cap: skippedConcurrencyCap,
    skipped_recipe: skippedRecipe,
    skipped_inline: skippedInline,
    skipped_blocked: skippedBlocked,
    skipped_draining: [],
    skipped_interference: skippedInterference,
    skipped_failure_capped: skippedFailureCapped,
  };
};

export type SchedulerLoopOpts = SchedulerOpts & {
  stopAfterTicks?: number;
  abort?: AbortSignal;
};

/** setInterval-style loop suitable for the daemon to run continuously.
 *  Stops when (a) the AbortSignal fires, (b) stopAfterTicks is reached, or
 *  (c) readyTasks returns empty AND IN_FLIGHT is empty for two consecutive
 *  ticks (a "drained" quiescence — the loop yields rather than spinning). */
export const schedulerLoop = async (
  db: Database,
  opts: SchedulerLoopOpts = {},
): Promise<void> => {
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const stopAfterTicks = opts.stopAfterTicks ?? Infinity;
  let ticks = 0;
  let drainedStreak = 0;

  // Brain elegance bc8je5f3x (2026-05-15): wake immediately when a new
  // ready-task signal lands on the activation bus instead of waiting
  // for the next poll tick. Polling stays as the safety-net max-timeout
  // so a missed publish (cross-process / subscriber crash) still drains.
  const { waitForActivation, onEvent } = await import("./activation_bus");
  const WAKE_KINDS = [
    "directive_opened",
    "task_node_opened",
    "task_committed",
    "task_failed",
    "directive_resumed",
  ] as const;
  const clearOnEventKinds = [
    "brain_dispatch_closed",
    "dispatch_recovered_orphan",
    "dispatcher_violation",
    "task_committed",
    "task_failed",
    "task_abandoned",
    "task_blocked",
    "task_committed_superseded",
  ] as const;
  const clearDisposers = clearOnEventKinds.map((kind) => onEvent(kind, (payload) => {
    if (payload.task_id) clearInFlightTask(payload.task_id);
  }));

  try {
  while (ticks < stopAfterTicks) {
    if (opts.abort?.aborted) return;
    const tick = await schedulerTick(db, opts);
    ticks++;
    if (tick.dispatched.length === 0 && tick.in_flight.length === 0) {
      drainedStreak++;
      if (drainedStreak >= 2 && stopAfterTicks === Infinity) {
        // Quiescent — yield. The daemon can call schedulerLoop again when a
        // new directive arrives.
        return;
      }
    } else {
      drainedStreak = 0;
    }
    if (ticks >= stopAfterTicks) return;
    // Wait for either the next poll tick OR an activation event. The race
    // means a fresh directive_opened wakes the scheduler within ~1ms
    // instead of pollIntervalMs (default 500ms). When activation fires,
    // the returned promise resolves with the payload; we ignore it and
    // just loop — the next tick will see the row in ready_tasks_view.
    await Promise.race([
      new Promise((r) => setTimeout(r, pollIntervalMs)),
      waitForActivation(WAKE_KINDS, opts.abort),
    ]);
  }
  } finally {
    for (const dispose of clearDisposers) dispose();
  }
};

/** Test-only: clear the process-local in-flight registry. */
export const _resetSchedulerForTests = (): void => {
  IN_FLIGHT.clear();
  IN_FLIGHT_DIRECTIVE.clear();
  IN_FLIGHT_PARENT.clear();
  // Parallel-DAG contract (1826363): schedulerTick returns after launch,
  // so a test that didn't drain leaves IN_FLIGHT_BRAIN populated. Cleared
  // here so the next test's brain dispatch isn't artificially capped.
  IN_FLIGHT_BRAIN.clear();
  GATE_NOTIFIED.clear();
  SCHEDULER_DRAINING = false;
};

/** Await every in-flight dispatch tracked in the process-local IN_FLIGHT
 *  registry. Production schedulerTick returns after launching (so siblings
 *  run concurrently); callers that need post-dispatch state — tests, the
 *  schedulerLoop's quiescence detector, and any consumer that wants to
 *  assert ledger rows synchronously — call this helper to drain. The
 *  promises self-clean from IN_FLIGHT via their .finally() handlers, so
 *  the registry shrinks naturally as each dispatch resolves. The function
 *  is safe to call when nothing is in flight (Promise.all on []) and may
 *  be called repeatedly. */
export const drainInFlightDispatches = async (
  opts: { timeoutMs?: number } = {},
): Promise<{ completed: boolean; timed_out_task_ids: string[] }> => {
  // Snapshot first — IN_FLIGHT mutates as promises resolve.
  const snapshot = Array.from(IN_FLIGHT.entries());
  if (snapshot.length === 0) return { completed: true, timed_out_task_ids: [] };
  const allSettled = Promise.allSettled(snapshot.map(([, promise]) => promise));
  if (opts.timeoutMs === undefined) {
    await allSettled;
    return { completed: true, timed_out_task_ids: [] };
  }
  const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), opts.timeoutMs));
  const result = await Promise.race([allSettled, timeout]);
  if (result !== "timeout") return { completed: true, timed_out_task_ids: [] };
  return { completed: false, timed_out_task_ids: Array.from(IN_FLIGHT.keys()) };
};

// ── Multi-process in-flight detection (SQL-backed) ────────────────────
//
// The IN_FLIGHT Map above is process-local. Two daemons sharing one substrate
// (Phase G+ when uv / camofox runtimes show up alongside the bun daemon, or
// any operator running `acc daemon` plus `acc task` from another shell) need
// a substrate-visible signal. The pair `brain_dispatched` (open) /
// `brain_dispatch_closed` (close) is one such signal — every dispatch the
// runtime begins is bracketed by these two events with a stable
// `payload.dispatch_id`. A directive is in-flight regardless of process iff
// at least one of its `brain_dispatched` rows lacks a matching
// `brain_dispatch_closed` (same dispatch_id).

/** Return the set of directive_ids that have an open brain dispatch (a
 *  `brain_dispatched` event whose `payload.dispatch_id` has no matching
 *  `brain_dispatch_closed`). Process-independent — multiple daemons can call
 *  this concurrently and observe the same in-flight set. The OR-fold against
 *  any in-memory IN_FLIGHT Map happens at the caller. */
export const inFlightDirectivesFromSql = (db: Database): Set<string> => {
  // Pull every open + close pair. Substrate is append-only — closes always
  // follow opens — so a "set-difference by dispatch_id" projects the live set
  // exactly. Reading both columns in one pass keeps this O(rows) and avoids
  // a correlated subquery.
  const openRows = db
    .query(
      `SELECT directive_id, payload FROM events
       WHERE kind = 'brain_dispatched'`,
    )
    .all() as Array<{ directive_id: string; payload: string }>;

  const closeIds = new Set<string>();
  const closeRows = db
    .query(
      `SELECT payload FROM events
       WHERE kind = 'brain_dispatch_closed'`,
    )
    .all() as Array<{ payload: string }>;
  for (const r of closeRows) {
    try {
      const p = JSON.parse(r.payload ?? "{}") as { dispatch_id?: string };
      if (p.dispatch_id) closeIds.add(p.dispatch_id);
    } catch { /* skip malformed payload */ }
  }

  const inFlight = new Set<string>();
  for (const r of openRows) {
    try {
      const p = JSON.parse(r.payload ?? "{}") as { dispatch_id?: string };
      if (!p.dispatch_id) continue;
      if (closeIds.has(p.dispatch_id)) continue;
      if (r.directive_id) inFlight.add(r.directive_id);
    } catch { /* skip malformed payload */ }
  }
  return inFlight;
};

/** Find the first cross-directive interference edge (kind = `mutual_exclusion`
 *  or `resource_conflict`) between `candidateDirectiveId` and any in-flight
 *  directive (per `inFlightDirectivesFromSql`). Returns `null` when no
 *  conflict exists. This is the multi-process-safe equivalent of the helper
 *  C's Phase DAG branch will add as `findDeferringConflict`. The scheduler
 *  dispatch site (which C's branch will introduce) reads this; the
 *  `task_deferred_for_interference` event is emitted there, NOT here.
 *
 *  The query walks `directive_interference_edge` events both directions —
 *  `mutual_exclusion` is symmetric, so an edge `candidate → in_flight` or
 *  `in_flight → candidate` both deferring this candidate. `resource_conflict`
 *  is treated the same way: a shared resource is shared regardless of which
 *  side declared the edge first. */
export const findCrossDirectiveConflict = (
  db: Database,
  candidateDirectiveId: string,
): { conflicting_directive: string; interaction: string } | null => {
  const inFlight = inFlightDirectivesFromSql(db);
  // The candidate's own directive being in-flight doesn't count — only OTHER
  // in-flight directives produce a conflict.
  inFlight.delete(candidateDirectiveId);
  if (inFlight.size === 0) return null;

  const rows = db
    .query(
      `SELECT payload FROM events
       WHERE kind = 'directive_interference_edge'
       ORDER BY ts ASC`,
    )
    .all() as Array<{ payload: string }>;

  for (const r of rows) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(r.payload ?? "{}") as Record<string, unknown>;
    } catch {
      continue;
    }
    const from = payload.from_directive as string | undefined;
    const to = payload.to_directive as string | undefined;
    // Some emitters use `interaction`, others use `kind` (the InterferenceEdge
    // shape canonicalises both into `kind` on read, but here we read raw).
    const interaction =
      (payload.interaction as string | undefined) ??
      (payload.kind as string | undefined);
    if (!from || !to || !interaction) continue;
    if (!CROSS_DIRECTIVE_BLOCKING_INTERACTIONS.has(interaction)) continue;

    if (from === candidateDirectiveId && inFlight.has(to)) {
      return { conflicting_directive: to, interaction };
    }
    if (to === candidateDirectiveId && inFlight.has(from)) {
      return { conflicting_directive: from, interaction };
    }
  }
  return null;
};
