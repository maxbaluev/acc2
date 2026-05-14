// acc2 task dispatcher — single-cycle brain dispatch with structural
// cycle-1-only enforcement (v2-design.md §3.7, §9.2).
//
// Per dispatch:
//   1. Emit `brain_dispatched` once per ready task.
//   2. Decide route via decideDispatch (recipe replay | claude inline | brain).
//   3. For `opencode_brain`: compose prompt, call opencodeQuery (mock in Phase D).
//   4. Capture events the brain emits. If any of them is `brain_cycle_2_started`
//      or `continue_cycle_requested`, emit `dispatcher_violation` with
//      `failure_kind: 'cycle_1_only_breach'`, terminate, and close.
//   5. If `action_predicted` landed, run the action artifact via runBunArtifact,
//      run the verifier on the observation, emit action_scored, credit the
//      artifact posterior via applyResidualOutcome.
//   6. Commit the task with task_committed if the verifier residual < commit
//      threshold. Phase D's MVP fixture targets residual=0; Phase E adds
//      refinement-edge emission when residual ≥ threshold.
//   7. Emit `brain_dispatch_closed`.
//
// The dispatcher writes events ONLY through emitEvent — never directly to
// SQLite. The bridge mock also writes through emitEvent, so the audit trail
// is uniform regardless of where the event originated.

import type { Database } from "bun:sqlite";
import type { Event, JsonValue, SandboxDecl } from "../substrate/types";
import { emitEvent } from "./events";
import { newId } from "./ids";
import { composePrompt } from "./prompt_composer";
import { decideDispatch } from "./dispatch_decider";
import { opencodeQuery, type BridgeRequest, type BridgeResult } from "./bridge";
import type { TaskNode } from "./task_topology";
import { refinementDepth } from "./task_topology";
import { getArtifact, applyResidualOutcome } from "./artifact_store";
import { runBunArtifact } from "./runtimes/bun";
import { nowIso } from "./ids";
import { distributeCredit } from "./credit";
import { findRecipeMatch, replayRecipe } from "./recipe_replay";
import { readCurrentMode } from "./crisis_mode";
import { isCycleViolation } from "./cycle_one_gate";
import { recordDispatch, recordActionResidual } from "./metrics";

const REFINEMENT_DEPTH_CAP = 5;

export type DispatchResult = {
  dispatch_id: string;
  task_id: string;
  events: Event[];
  violations: string[];
  bridge_result?: BridgeResult;
};

const COMMIT_RESIDUAL_THRESHOLD = 0.3;

type DispatchDeps = {
  /** Override the bridge call — Phase D tests use this to inject the
   *  adversarial cycle-2 mock. Defaults to opencodeQuery. */
  bridge?: (req: BridgeRequest, db: Database) => Promise<BridgeResult>;
  /** Optional fixture path threaded into the bridge request. The MVP fixture
   *  reads it to point the bun grep at a deterministic directory. */
  fixtureTargetPath?: string;
};

const readEventsForDispatch = (db: Database, dispatchId: string): Event[] => {
  const rows = db
    .query(
      "SELECT * FROM events WHERE payload LIKE ? OR id IN (SELECT id FROM events WHERE ts >= (SELECT ts FROM events WHERE id = ?)) ORDER BY ts ASC",
    )
    .all(`%${dispatchId}%`, dispatchId) as Array<Record<string, unknown>>;
  // The LIKE filter is intentionally loose — every event the dispatcher cares
  // about either references dispatch_id in its payload or was emitted after
  // it. Strict filtering happens in the dispatcher's downstream consumers.
  return rows.map((r) => ({
    id: r.id as string,
    ts: r.ts as string,
    directive_id: r.directive_id as string,
    task_id: r.task_id as string,
    parent_task_id: (r.parent_task_id as string | null) ?? null,
    loop_id: r.loop_id as string,
    substrate_origin: r.substrate_origin as Event["substrate_origin"],
    kind: r.kind as Event["kind"],
    payload: JSON.parse((r.payload as string) ?? "{}") as JsonValue,
    context_refs: JSON.parse((r.context_refs as string) ?? "[]") as string[],
    predicted_residual: (r.predicted_residual as number | null) ?? undefined,
    action_artifact_id: (r.action_artifact_id as string | null) ?? undefined,
    verifier_artifact_id: (r.verifier_artifact_id as string | null) ?? undefined,
    outcome: (r.outcome as Event["outcome"]) ?? undefined,
    residual: (r.residual as number | null) ?? undefined,
    failure_kind: (r.failure_kind as Event["failure_kind"]) ?? undefined,
    invoker: (r.invoker as Event["invoker"]) ?? undefined,
  }));
};

const readEventsSinceTs = (db: Database, sinceTs: string, taskId: string): Event[] => {
  const rows = db
    .query("SELECT * FROM events WHERE ts >= ? AND task_id = ? ORDER BY ts ASC")
    .all(sinceTs, taskId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    ts: r.ts as string,
    directive_id: r.directive_id as string,
    task_id: r.task_id as string,
    parent_task_id: (r.parent_task_id as string | null) ?? null,
    loop_id: r.loop_id as string,
    substrate_origin: r.substrate_origin as Event["substrate_origin"],
    kind: r.kind as Event["kind"],
    payload: JSON.parse((r.payload as string) ?? "{}") as JsonValue,
    context_refs: JSON.parse((r.context_refs as string) ?? "[]") as string[],
    predicted_residual: (r.predicted_residual as number | null) ?? undefined,
    action_artifact_id: (r.action_artifact_id as string | null) ?? undefined,
    verifier_artifact_id: (r.verifier_artifact_id as string | null) ?? undefined,
    outcome: (r.outcome as Event["outcome"]) ?? undefined,
    residual: (r.residual as number | null) ?? undefined,
    failure_kind: (r.failure_kind as Event["failure_kind"]) ?? undefined,
    invoker: (r.invoker as Event["invoker"]) ?? undefined,
  }));
};

/** Dispatch ONE ready task. Single-cycle by construction — see §3.7. Returns
 *  the events that fired during the dispatch and any violations detected. */
export const dispatchReadyTask = async (
  db: Database,
  task: TaskNode,
  deps: DispatchDeps = {},
): Promise<DispatchResult> => {
  const dispatchId = newId();
  const dispatchStartMs = Date.now();
  const violations: string[] = [];
  const bridge = deps.bridge ?? opencodeQuery;

  // 1. brain_dispatched
  emitEvent(db, {
    kind: "brain_dispatched",
    substrate_origin: "substrate_auto",
    directive_id: task.directive_id,
    task_id: task.id,
    payload: { dispatch_id: dispatchId, task_id: task.id, route_pending: true } as JsonValue,
  });

  // Record the timestamp BEFORE the bridge fires so we can collect every event
  // emitted on this task during the dispatch (the bridge mock writes through
  // emitEvent, the runtime writes through emitEvent — one path, one audit).
  const dispatchStartedTs = nowIso();

  // 2. decideDispatch
  const decision = decideDispatch(db, task);
  emitEvent(db, {
    kind: "constitutional_gate_decision",
    substrate_origin: "substrate_auto",
    directive_id: task.directive_id,
    task_id: task.id,
    payload: {
      dispatch_id: dispatchId,
      route: decision.route,
      reason: decision.reason,
    } as JsonValue,
  });

  let bridgeResult: BridgeResult | undefined;
  // The effective route may change mid-dispatch (substrate_replay → fallback
  // opencode_brain on abort). We track it in a local so we can rewrite cleanly.
  let effectiveRoute: typeof decision.route = decision.route;

  if (decision.route === "substrate_replay") {
    // Phase J: route through recipe_replay.ts. The decider already validated
    // confidence ≥ threshold, but we re-fetch the full match so we have the
    // trajectory in hand.
    const mode = readCurrentMode(db, task.directive_id);
    const match = findRecipeMatch(db, task, { minConfidence: mode.recipe_confidence_threshold });
    if (!match) {
      // Decider and matcher disagreed (rare; e.g. recipe demoted between
      // decider call and now). Fall back to opencode_brain dispatch.
      emitEvent(db, {
        kind: "brain_dispatch_closed",
        substrate_origin: "substrate_auto",
        directive_id: task.directive_id,
        task_id: task.id,
        payload: { dispatch_id: dispatchId, reason: "recipe_match_disappeared" } as JsonValue,
      });
      return { dispatch_id: dispatchId, task_id: task.id, events: [], violations: [] };
    }

    emitEvent(db, {
      kind: "recipe_invoked",
      substrate_origin: "recipe",
      directive_id: task.directive_id,
      task_id: task.id,
      payload: {
        dispatch_id: dispatchId,
        recipe_id: match.recipe_id,
        goal_shape: match.goal_shape,
        topology_signature: match.topology_signature,
        confidence: match.confidence,
      } as JsonValue,
    });

    const outcome = await replayRecipe(db, task, match);
    if (outcome.task_committed) {
      emitEvent(db, {
        kind: "brain_dispatch_closed",
        substrate_origin: "substrate_auto",
        directive_id: task.directive_id,
        task_id: task.id,
        payload: {
          dispatch_id: dispatchId,
          reason: "recipe_replayed",
          recipe_id: match.recipe_id,
          residuals: outcome.residuals,
        } as JsonValue,
      });
      return {
        dispatch_id: dispatchId,
        task_id: task.id,
        events: readEventsSinceTs(db, dispatchStartedTs, task.id),
        violations: [],
      };
    }
    // Replay aborted — fall through to opencode_brain dispatch as a
    // refinement (§15 "any verifier residual exceeds threshold, replay
    // aborts and the dispatcher routes the task back to opencode_brain").
    emitEvent(db, {
      kind: "constitutional_gate_decision",
      substrate_origin: "substrate_auto",
      directive_id: task.directive_id,
      task_id: task.id,
      payload: {
        dispatch_id: dispatchId,
        route: "opencode_brain",
        reason: `recipe_replay_aborted:${outcome.abort_reason ?? "unknown"}`,
        previous_route: "substrate_replay",
      } as JsonValue,
    });
    effectiveRoute = "opencode_brain";
  }

  if (effectiveRoute === "claude_inline") {
    // Phase E wires Claude inline lane; Phase D never returns this lane.
    emitEvent(db, {
      kind: "brain_dispatch_closed",
      substrate_origin: "substrate_auto",
      directive_id: task.directive_id,
      task_id: task.id,
      payload: { dispatch_id: dispatchId, reason: "claude_inline_phase_e_stub" } as JsonValue,
    });
    return { dispatch_id: dispatchId, task_id: task.id, events: [], violations: [] };
  }

  // 3. opencode_brain — compose prompt + call bridge.
  const composed = composePrompt(db, { taskId: task.id });
  bridgeResult = await bridge(
    {
      prompt: composed.text,
      taskId: task.id,
      directiveId: task.directive_id,
      fixtureTargetPath: deps.fixtureTargetPath,
    },
    db,
  );

  // 4. Inspect every event emitted on this task during the dispatch window.
  //    The dispatcher reads from the SAME substrate the bridge writes to —
  //    that's the symmetry §3.6 calls for.
  const dispatchEvents = readEventsSinceTs(db, dispatchStartedTs, task.id);

  // Cycle-1 enforcement: scan for forbidden self-iteration kinds. The
  // forbidden set is owned by `cycle_one_gate.ts` so the real-bridge
  // stdout scan and this post-bridge event scan stay in lock-step.
  let cycleViolationDetected = false;
  for (const ev of dispatchEvents) {
    if (isCycleViolation(ev.kind)) {
      emitEvent(db, {
        kind: "dispatcher_violation",
        substrate_origin: "substrate_auto",
        directive_id: task.directive_id,
        task_id: task.id,
        failure_kind: "cycle_1_only_breach",
        payload: {
          dispatch_id: dispatchId,
          attempted_event: ev.kind,
          attempted_event_id: ev.id,
        } as JsonValue,
      });
      violations.push("cycle_1_only_breach");
      cycleViolationDetected = true;
      break;
    }
  }

  if (cycleViolationDetected) {
    // Close immediately; do NOT honor any action_predicted that may have
    // landed on the same task — the dispatch is structurally invalid.
    emitEvent(db, {
      kind: "brain_dispatch_closed",
      substrate_origin: "substrate_auto",
      directive_id: task.directive_id,
      task_id: task.id,
      payload: {
        dispatch_id: dispatchId,
        reason: "cycle_1_only_breach",
        events_count: dispatchEvents.length,
      } as JsonValue,
    });
    return { dispatch_id: dispatchId, task_id: task.id, events: dispatchEvents, violations, bridge_result: bridgeResult };
  }

  if (!bridgeResult.ok) {
    emitEvent(db, {
      kind: "brain_dispatch_closed",
      substrate_origin: "substrate_auto",
      directive_id: task.directive_id,
      task_id: task.id,
      payload: {
        dispatch_id: dispatchId,
        reason: `bridge_failed:${bridgeResult.reason.kind}`,
        events_count: dispatchEvents.length,
      } as JsonValue,
    });
    return { dispatch_id: dispatchId, task_id: task.id, events: dispatchEvents, violations, bridge_result: bridgeResult };
  }

  // 5. action_predicted detection + execution
  const actionPredicted = dispatchEvents.find((e) => e.kind === "action_predicted");
  if (actionPredicted && actionPredicted.action_artifact_id && actionPredicted.verifier_artifact_id) {
    const actionArtifact = getArtifact(db, actionPredicted.action_artifact_id);
    const verifierArtifact = getArtifact(db, actionPredicted.verifier_artifact_id);
    if (actionArtifact && verifierArtifact && actionArtifact.declaredSandbox.runtime === "bun" && verifierArtifact.declaredSandbox.runtime === "bun") {
      // Run the action. Inputs come from the predicted event's payload
      // (target_path etc).
      const predictedPayload = actionPredicted.payload as Record<string, unknown>;
      const actionInputs: JsonValue = {
        target_path: ((predictedPayload as Record<string, unknown>).target_path as string) ?? deps.fixtureTargetPath ?? ".",
      } as JsonValue;

      const actionObs = await runBunArtifact({
        artifactId: actionArtifact.id,
        body: actionArtifact.body,
        declaredSandbox: actionArtifact.declaredSandbox as Extract<SandboxDecl, { runtime: "bun" }>,
        inputs: actionInputs,
        emit: (ev) => {
          emitEvent(db, {
            ...ev,
            directive_id: ev.directive_id ?? task.directive_id,
            task_id: ev.task_id ?? task.id,
            invoker: ev.invoker ?? "substrate_auto",
          });
        },
      });

      // Phase H: surface any declared irreversible effects via
      // `irreversible_effect_recorded`. Bun/uv/camofox artifacts opt in by
      // printing `@@IRREVERSIBLE@@ <kind>:<description>` lines; the runtime
      // parses them into observation.irreversibleEffects.
      if (actionObs.irreversibleEffects.length > 0) {
        for (const eff of actionObs.irreversibleEffects) {
          emitEvent(db, {
            kind: "irreversible_effect_recorded",
            substrate_origin: "substrate_auto",
            directive_id: task.directive_id,
            task_id: task.id,
            action_artifact_id: actionArtifact.id,
            payload: { kind: eff.kind, description: eff.description } as JsonValue,
          });
        }
      }

      if (!actionObs.ok) {
        // Locate the most recent artifact_observed row on this task — that's
        // the artifact's own "I ran" row, even when ok is false (the runtime
        // emits an observed row for soft/hard timeouts too).
        const obsRow = db
          .query(
            `SELECT id FROM events WHERE task_id = ? AND kind = 'artifact_observed'
             AND action_artifact_id = ? ORDER BY ts DESC LIMIT 1`,
          )
          .get(task.id, actionArtifact.id) as { id: string } | null;
        const scored = emitEvent(db, {
          kind: "action_scored",
          substrate_origin: "substrate_auto",
          directive_id: task.directive_id,
          task_id: task.id,
          action_artifact_id: actionArtifact.id,
          verifier_artifact_id: verifierArtifact.id,
          residual: 1,
          failure_kind: "artifact_runtime_error",
          payload: {
            dispatch_id: dispatchId,
            action_error: actionObs.error ?? "unknown",
            stderr_tail: actionObs.stderrTail,
          } as JsonValue,
        });
        // Route through the Phase H credit pipeline. When the observation
        // event is missing (rare — runtime crash before any emit) we fall
        // back to applyResidualOutcome directly so the artifact's posterior
        // still moves; credit-pipeline gracefully handles the missing event
        // (collectCitations skips a null event).
        try {
          await distributeCredit(db, {
            action_event_id: actionPredicted.id,
            observation_event_id: obsRow?.id ?? actionPredicted.id,
            scored_event_id: scored.id,
            predicted_residual: actionPredicted.predicted_residual ?? 1,
            observed_residual: 1,
          });
        } catch {
          applyResidualOutcome(db, actionArtifact.id, 1, nowIso());
        }
      } else {
        // Run the verifier on the observation.
        const verifierObs = await runBunArtifact({
          artifactId: verifierArtifact.id,
          body: verifierArtifact.body,
          declaredSandbox: verifierArtifact.declaredSandbox as Extract<SandboxDecl, { runtime: "bun" }>,
          inputs: actionObs.result as JsonValue,
          emit: (ev) => {
            emitEvent(db, {
              ...ev,
              directive_id: ev.directive_id ?? task.directive_id,
              task_id: ev.task_id ?? task.id,
              invoker: ev.invoker ?? "substrate_auto",
            });
          },
        });

        let residual = 1;
        if (
          verifierObs.ok &&
          verifierObs.result &&
          typeof verifierObs.result === "object" &&
          !Array.isArray(verifierObs.result) &&
          typeof (verifierObs.result as Record<string, unknown>).residual === "number"
        ) {
          residual = (verifierObs.result as { residual: number }).residual;
        }

        const scored = emitEvent(db, {
          kind: "action_scored",
          substrate_origin: "substrate_auto",
          directive_id: task.directive_id,
          task_id: task.id,
          action_artifact_id: actionArtifact.id,
          verifier_artifact_id: verifierArtifact.id,
          predicted_residual: actionPredicted.predicted_residual ?? undefined,
          residual,
          payload: {
            dispatch_id: dispatchId,
            action_result: actionObs.result ?? null,
            verifier_result: verifierObs.result ?? null,
          } as JsonValue,
        });

        // Phase H: credit pipeline distributes the residual across the
        // action + verifier + every cited knowledge/artifact via Shapley
        // decomposition (§3.6.1 Rule 3). The pipeline calls
        // applyResidualOutcome on the primary action + verifier; cited
        // entities receive a weighted Beta posterior delta.
        const obsRow = db
          .query(
            `SELECT id FROM events WHERE task_id = ? AND kind = 'artifact_observed'
             AND action_artifact_id = ? ORDER BY ts DESC LIMIT 1`,
          )
          .get(task.id, actionArtifact.id) as { id: string } | null;
        try {
          await distributeCredit(db, {
            action_event_id: actionPredicted.id,
            observation_event_id: obsRow?.id ?? actionPredicted.id,
            scored_event_id: scored.id,
            predicted_residual: actionPredicted.predicted_residual ?? residual,
            observed_residual: residual,
          });
        } catch {
          // Fail-safe: keep posterior accounting honest even if credit fails.
          applyResidualOutcome(db, actionArtifact.id, residual, nowIso());
          applyResidualOutcome(db, verifierArtifact.id, residual, nowIso());
        }

        // 6. Commit if residual is below the success band.
        if (residual < COMMIT_RESIDUAL_THRESHOLD) {
          emitEvent(db, {
            kind: "task_committed",
            substrate_origin: "substrate_auto",
            directive_id: task.directive_id,
            task_id: task.id,
            outcome: "succeeded",
            residual,
            payload: {
              dispatch_id: dispatchId,
              action_artifact_id: actionArtifact.id,
              verifier_artifact_id: verifierArtifact.id,
            } as JsonValue,
          });
          // Self-modification heuristic (Batch 3.CLEANUP §10.1): when the
          // action artifact's observation declares a `modified_paths` array AND
          // any path falls under the acc2 codebase root, surface the trajectory
          // via `self_modification_recorded`. The event is observational — the
          // commit has already landed; this row makes the self-as-target dispatch
          // auditable downstream (e.g. by govern-side rolling reviews). The
          // heuristic deliberately reads ACTION_OBSERVATION, not the diff on
          // disk: artifacts opt in by printing the paths they touched into
          // `modified_paths` (flat) or `result.modified_paths` (wrapped — the
          // existing fixture convention used by fixture_d_count_todos). Nothing
          // fires automatically when an artifact silently mutates files
          // outside that envelope.
          const observed = actionObs.result as Record<string, unknown> | null;
          let modifiedPaths: unknown = undefined;
          if (observed && typeof observed === "object" && !Array.isArray(observed)) {
            const flat = (observed as { modified_paths?: unknown }).modified_paths;
            const wrapped = (observed as { result?: { modified_paths?: unknown } }).result;
            modifiedPaths = Array.isArray(flat)
              ? flat
              : (wrapped && typeof wrapped === "object" && !Array.isArray(wrapped)
                  ? (wrapped as { modified_paths?: unknown }).modified_paths
                  : undefined);
          }
          if (Array.isArray(modifiedPaths)) {
            const selfPaths = modifiedPaths
              .filter((p): p is string => typeof p === "string")
              .filter((p) => p.includes("/system/acc2/") || p.startsWith("acc2/") || p.startsWith("system/acc2/"));
            if (selfPaths.length > 0) {
              emitEvent(db, {
                kind: "self_modification_recorded",
                substrate_origin: "substrate_auto",
                directive_id: task.directive_id,
                task_id: task.id,
                action_artifact_id: actionArtifact.id,
                payload: {
                  dispatch_id: dispatchId,
                  modified_paths: selfPaths,
                  total_declared_paths: modifiedPaths.length,
                  detection: "action_observation_modified_paths_acc2_root",
                } as JsonValue,
              });
            }
          }
        } else {
          // High-residual path — emit a refinement edge + new task_node_opened
          // for the refinement child, OR cap-fail if we've exhausted depth.
          const depth = refinementDepth(db, task.id);
          if (depth >= REFINEMENT_DEPTH_CAP) {
            emitEvent(db, {
              kind: "task_failed",
              substrate_origin: "substrate_auto",
              directive_id: task.directive_id,
              task_id: task.id,
              outcome: "failed",
              residual,
              failure_kind: "refinement_depth_exceeded",
              payload: {
                dispatch_id: dispatchId,
                refinement_depth: depth,
                cap: REFINEMENT_DEPTH_CAP,
                action_artifact_id: actionArtifact.id,
                verifier_artifact_id: verifierArtifact.id,
              } as JsonValue,
            });
          } else {
            const refinedTaskId = newId();
            const refinementHint =
              `refine: previous attempt returned residual ${residual.toFixed(2)} on goal "${task.goal}" — ` +
              `investigate why and adjust action/verifier (refinement depth=${depth + 1}).`;
            emitEvent(db, {
              kind: "task_node_opened",
              substrate_origin: "substrate_auto",
              directive_id: task.directive_id,
              task_id: refinedTaskId,
              parent_task_id: task.id,
              payload: {
                goal: refinementHint,
                lifecycle: "finite",
                urgency: "normal",
                refines_task_id: task.id,
                prior_residual: residual,
              } as JsonValue,
            });
            emitEvent(db, {
              kind: "task_edge_recorded",
              substrate_origin: "substrate_auto",
              directive_id: task.directive_id,
              task_id: refinedTaskId,
              parent_task_id: task.id,
              payload: {
                from_task: task.id,
                to_task: refinedTaskId,
                kind: "refines",
              } as JsonValue,
            });
          }
        }
      }
    }
  }

  // 7. brain_dispatch_closed seals the audit trail.
  const finalEvents = readEventsSinceTs(db, dispatchStartedTs, task.id);
  emitEvent(db, {
    kind: "brain_dispatch_closed",
    substrate_origin: "substrate_auto",
    directive_id: task.directive_id,
    task_id: task.id,
    payload: {
      dispatch_id: dispatchId,
      events_count: finalEvents.length,
      route: effectiveRoute,
      original_route: decision.route,
    } as JsonValue,
  });

  // Batch 3.OPS: record dispatch metric. Outcome is derived from terminal
  // events on this task during the dispatch window.
  try {
    const closedEvents = readEventsSinceTs(db, dispatchStartedTs, task.id);
    const hasCommit = closedEvents.some((e) => e.kind === "task_committed");
    const hasFail = closedEvents.some((e) => e.kind === "task_failed");
    const hasRefine = closedEvents.some((e) => e.kind === "task_edge_recorded" &&
      (e.payload as Record<string, unknown> | null)?.kind === "refines");
    const outcome = hasCommit ? "committed" : hasFail ? "failed" : hasRefine ? "refined" : "closed";
    recordDispatch(effectiveRoute, outcome, (Date.now() - dispatchStartMs) / 1000);
    // Record observed residuals as well.
    for (const e of closedEvents) {
      if (e.kind === "action_scored" && typeof e.residual === "number") {
        recordActionResidual("bun", e.residual);
      }
    }
  } catch { /* swallow — metrics are best-effort */ }

  return {
    dispatch_id: dispatchId,
    task_id: task.id,
    events: readEventsSinceTs(db, dispatchStartedTs, task.id),
    violations,
    bridge_result: bridgeResult,
  };
};

// Re-export readEventsForDispatch only because tests may want it; the helper
// is internal otherwise.
export { readEventsForDispatch };
