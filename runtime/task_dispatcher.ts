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
import { getArtifact, applyResidualOutcome } from "./artifact_store";
import { runBunArtifact } from "./runtimes/bun";
import { nowIso } from "./ids";

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

  if (decision.route === "substrate_replay") {
    // Phase J wires recipe replay; Phase D never returns this lane.
    emitEvent(db, {
      kind: "brain_dispatch_closed",
      substrate_origin: "substrate_auto",
      directive_id: task.directive_id,
      task_id: task.id,
      payload: { dispatch_id: dispatchId, reason: "substrate_replay_phase_j_stub" } as JsonValue,
    });
    return { dispatch_id: dispatchId, task_id: task.id, events: [], violations: [] };
  }

  if (decision.route === "claude_inline") {
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

  // Cycle-1 enforcement: scan for forbidden self-iteration kinds.
  let cycleViolationDetected = false;
  for (const ev of dispatchEvents) {
    if (ev.kind === "brain_cycle_2_started" || ev.kind === "continue_cycle_requested") {
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

      if (!actionObs.ok) {
        emitEvent(db, {
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
        applyResidualOutcome(db, actionArtifact.id, 1, nowIso());
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

        emitEvent(db, {
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

        // Credit both artifacts' posteriors. Verifier and action both share
        // the residual; v2-design §11.5 treats verifier promotion identically.
        applyResidualOutcome(db, actionArtifact.id, residual, nowIso());
        applyResidualOutcome(db, verifierArtifact.id, residual, nowIso());

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
        }
        // Phase E adds refinement-edge emission when residual ≥ threshold.
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
      route: decision.route,
    } as JsonValue,
  });

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
