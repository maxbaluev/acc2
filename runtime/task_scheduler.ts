// acc2 task scheduler — picks ready tasks and dispatches them
// (v2-design.md §9.1).
//
// Phase E lights up real parallelism:
//   - Up to maxConcurrent dispatches per tick (default 5, configurable up to
//     10 in crisis mode).
//   - Tracks in-flight dispatches via an in-memory map keyed by task_id so
//     successive ticks know how many slots are free.
//   - Routes through decideDispatch:
//       substrate_replay → Phase J recipe replay (stub returns {ok:false,
//                          error:"phase_j"}, scheduler accepts).
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
import { readyTasks, type TaskNode } from "./task_topology";
import { dispatchReadyTask } from "./task_dispatcher";
import { decideDispatch } from "./dispatch_decider";
import { emitEvent } from "./events";
import { readCurrentMode, applyModeAdjustments } from "./crisis_mode";
import { findDeferringConflict } from "./interference";

export type SchedulerOpts = {
  maxConcurrent?: number;
  pollIntervalMs?: number;
  directiveId?: string;
  fixtureTargetPath?: string;
};

export type SchedulerTick = {
  dispatched: string[];
  in_flight: string[];
  skipped_concurrency_cap: string[];
  skipped_recipe: string[];
  skipped_inline: string[];
  skipped_blocked: string[];
  /** Tasks deferred because a `mutual_exclusion` or `resource_conflict`
   *  interference edge points at an in-flight peer directive. The scheduler
   *  emits `task_deferred_for_interference` for each entry here. */
  skipped_interference: string[];
};

const DEFAULT_MAX_CONCURRENT = 5;
const DEFAULT_POLL_INTERVAL_MS = 500;

// Process-local in-flight registry. The scheduler is the only writer; the
// dispatcher promises resolve here. Keys are task_ids; values are the
// underlying promise so the loop can await any completion when needed.
const IN_FLIGHT: Map<string, Promise<unknown>> = new Map();

// Companion map: task_id → directive_id so the scheduler can compute the set
// of in-flight directives without re-reading SQLite. Kept in sync with
// IN_FLIGHT (same insertion / deletion sites). Used for the interference
// concurrency check (`findDeferringConflict`).
const IN_FLIGHT_DIRECTIVE: Map<string, string> = new Map();

const phaseJRecipeReplay = (): { ok: false; error: "phase_j" } => ({
  ok: false,
  error: "phase_j",
});

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
  const ready = readyTasks(db, opts.directiveId);

  // Cull resolved entries (cheap — Map iteration).
  for (const [taskId, p] of IN_FLIGHT) {
    if ((p as Promise<unknown> & { _settled?: boolean })._settled) {
      IN_FLIGHT.delete(taskId);
      IN_FLIGHT_DIRECTIVE.delete(taskId);
    }
  }

  const dispatched: string[] = [];
  const skippedConcurrencyCap: string[] = [];
  const skippedRecipe: string[] = [];
  const skippedInline: string[] = [];
  const skippedBlocked: string[] = [];
  const skippedInterference: string[] = [];
  const pending: Array<Promise<unknown>> = [];

  for (const task of ready) {
    if (IN_FLIGHT.has(task.id)) continue; // already dispatched in a prior tick.

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
      continue;
    }

    const slotsLeft = maxConcurrent - IN_FLIGHT.size;
    if (slotsLeft <= 0) {
      skippedConcurrencyCap.push(task.id);
      continue;
    }

    const decision = decideDispatch(db, task);
    if (decision.route === "deferred_blocked") {
      skippedBlocked.push(task.id);
      emitEvent(db, {
        kind: "constitutional_gate_decision",
        substrate_origin: "substrate_auto",
        directive_id: task.directive_id,
        task_id: task.id,
        payload: {
          gate: "directive_blocked_deferred",
          blockers: decision.blockers,
          reason: decision.reason,
        } as JsonValue,
      });
      continue;
    }

    if (decision.route === "substrate_replay") {
      // Phase J recipe replay: stub returns {ok:false, error:"phase_j"}.
      const replay = phaseJRecipeReplay();
      if (!replay.ok) {
        skippedRecipe.push(task.id);
        emitEvent(db, {
          kind: "constitutional_gate_decision",
          substrate_origin: "substrate_auto",
          directive_id: task.directive_id,
          task_id: task.id,
          payload: {
            gate: "substrate_replay_skipped",
            reason: replay.error,
          } as JsonValue,
        });
      }
      continue;
    }

    if (decision.route === "claude_inline") {
      skippedInline.push(task.id);
      emitInlineLaneRouted(db, task, decision.reason);
      continue;
    }

    // opencode_brain lane → actual dispatch.
    const promise = dispatchReadyTask(db, task, {
      fixtureTargetPath: opts.fixtureTargetPath,
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
        IN_FLIGHT.delete(task.id);
        IN_FLIGHT_DIRECTIVE.delete(task.id);
      });
    // Mark settled-flag accessor lazily — best-effort cleanup helper.
    (promise as Promise<unknown> & { _settled?: boolean })._settled = false;
    void promise.then(
      () => ((promise as Promise<unknown> & { _settled?: boolean })._settled = true),
      () => ((promise as Promise<unknown> & { _settled?: boolean })._settled = true),
    );
    IN_FLIGHT.set(task.id, promise);
    IN_FLIGHT_DIRECTIVE.set(task.id, task.directive_id);
    pending.push(promise);
    dispatched.push(task.id);
  }

  // Await all newly-dispatched promises this tick so tests can assert
  // post-dispatch substrate state. The IN_FLIGHT registry is still useful
  // across ticks when the scheduler runs as a loop and a slow dispatch
  // straddles two ticks; we just don't block on those here.
  if (pending.length > 0) {
    await Promise.all(pending);
  }

  return {
    dispatched,
    in_flight: Array.from(IN_FLIGHT.keys()),
    skipped_concurrency_cap: skippedConcurrencyCap,
    skipped_recipe: skippedRecipe,
    skipped_inline: skippedInline,
    skipped_blocked: skippedBlocked,
    skipped_interference: skippedInterference,
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

  while (ticks < stopAfterTicks) {
    if (opts.abort?.aborted) return;
    const tick = await schedulerTick(db, opts);
    ticks++;
    if (tick.dispatched.length === 0 && tick.in_flight.length === 0) {
      drainedStreak++;
      if (drainedStreak >= 2 && stopAfterTicks === Infinity) {
        // Quiescent — yield. The daemon can call schedulerLoop again when a
        // new directive arrives. Long-running daemons would replace this
        // with a substrate-event-driven wake instead of polling.
        return;
      }
    } else {
      drainedStreak = 0;
    }
    if (ticks >= stopAfterTicks) return;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
};

/** Test-only: clear the process-local in-flight registry. */
export const _resetSchedulerForTests = (): void => {
  IN_FLIGHT.clear();
  IN_FLIGHT_DIRECTIVE.clear();
};
