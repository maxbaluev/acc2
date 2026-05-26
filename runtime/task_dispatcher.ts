// acc2 task dispatcher — single-cycle brain dispatch with structural
// cycle-1-only enforcement (Architecture.md, §9.2).
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
import type { Event, JsonValue } from "../substrate/types";
import { ARTIFACT_LIFECYCLE_KINDS } from "../substrate/event_kinds";
import { emitEvent } from "./events";
import { newId } from "./ids";
import { poolQuery } from "./sql_pool_singleton";
import { composePrompt, readOwnerProfile } from "./prompt_composer";
import { evaluateOwnerControlGate } from "./owner_state_transition_verifier";
import { getReloadable } from "./reloadable";

// Hot-reload deep-improvement (2026-05-17): resolve composePrompt through
// the reloadable registry so a hot-reload of runtime/prompt_composer.ts
// reaches LIVE dispatches. Pre-fix the dispatcher held the boot-time
// import via the top-level binding above, so swap events were emitted
// but no consumer read the new code until restart. Now the dispatcher
// asks the registry on every call — registry returns the latest
// validated module. Fail-soft: if the registry isn't initialised (bare
// test mode) we fall through to the static import.
const resolveComposePrompt = async (): Promise<typeof composePrompt> => {
  const slot = getReloadable("prompt_composer");
  if (!slot) return composePrompt;
  try {
    const mod = (await slot.current()) as { composePrompt?: typeof composePrompt };
    return typeof mod.composePrompt === "function" ? mod.composePrompt : composePrompt;
  } catch {
    return composePrompt;
  }
};
import { decideDispatch, dispatchEvidencePayload } from "./dispatch_decider";
import { requestJob } from "./claude_agent_job";
import { recordInternalAct } from "./internal_act_projection";
import { invokeVerifierWithMeta } from "./verifier_invocation";
import { opencodeQuery, type BridgeRequest, type BridgeResult } from "./bridge/index";
import type { TaskNode } from "./task_topology";
import { refinementDepth } from "./task_topology";
import { getArtifact, applyResidualOutcome, recordArtifactKill, maybeRetire } from "./artifact_store";
import { runArtifactForRuntime, type UnifiedRuntimeInvocation, type UnifiedRuntimeObservation } from "./runtimes";
import { nowIso } from "./ids";
import { distributeCredit } from "./credit";
import { findRecipeMatch, replayRecipe } from "./recipe_replay";
import { logger } from "./logger";
import {
  cascadeUpwardWhenChildrenTerminal,
  maybeCloseFinishedDirective,
  rootCommitReadiness,
} from "./directive_closure";
import { closureResidualsForLineage } from "./closure_audit";
import { readCurrentMode } from "./crisis_mode";
import { isCycleViolation } from "./cycle_one_gate";
import { recordDispatch, recordActionResidual } from "./metrics";
import { extractRecipeFromCommit } from "../substrate/extractors";
import { maybeRunGenerateSelect } from "./generate_select_dispatch";
import { emitRefinementContinuation } from "./dispatch_continuation";

const REFINEMENT_DEPTH_CAP = 5;
const TREE_SEARCH_FANOUT_THRESHOLD = 5;

// Dispatch-cascade stage profiling (gated behind ACC2_PROFILE_LOOP, mirrors
// daemon.ts startLoopLagMonitor's gate). The event loop is single-threaded:
// any SYNCHRONOUS bun:sqlite scan inside the directive-open → brain-spawn
// cascade blocks the loop for its whole duration. The loop-lag monitor reports
// THAT the loop blocked (lag_ms) but not WHICH stage. This helper wraps each
// cascade stage with a high-resolution timer and logs
// {event:"dispatch_stage_timing", stage, ms, task_id} whenever a stage exceeds
// STAGE_LOG_THRESHOLD_MS, so the slow synchronous stage is attributable from
// daemon.log without guessing. Default OFF → zero overhead (the await still
// runs; only the timing + log is skipped). The threshold is well below the
// ~200ms loop-block budget so a stage trending toward the budget is visible
// before it regresses to a hard block.
const DISPATCH_PROFILE_ENABLED = process.env.ACC2_PROFILE_LOOP === "1";
const STAGE_LOG_THRESHOLD_MS = 50;

const timeStage = async <T>(stage: string, taskId: string, fn: () => Promise<T> | T): Promise<T> => {
  if (!DISPATCH_PROFILE_ENABLED) return await fn();
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    const ms = performance.now() - t0;
    if (ms > STAGE_LOG_THRESHOLD_MS) {
      logger.warn(
        { event: "dispatch_stage_timing", stage, ms: Math.round(ms), task_id: taskId },
        "dispatch_stage_timing",
      );
    }
  }
};

const resolveKnowledgeSourceDirective = (db: Database, eventId: string): string | null => {
  const row = db
    .query("SELECT directive_id, kind, payload FROM events WHERE id = ? LIMIT 1")
    .get(eventId) as { directive_id: string | null; kind: string; payload: string } | null;
  if (!row) return null;
  if (row.directive_id) return row.directive_id;
  if (row.kind === "knowledge_promoted" || row.kind === "knowledge_synthesized") {
    try {
      const payload = JSON.parse(row.payload ?? "{}") as Record<string, unknown>;
      const candidateId = payload.candidate_id as string | undefined;
      if (candidateId) return resolveKnowledgeSourceDirective(db, candidateId);
    } catch { /* malformed payload: no source directive */ }
  }
  return null;
};

// Gate-deletion (owner-approved 2026-05-16, audit finding #7):
// assertDispatchableArtifact (artifact_quarantined / hard_kill_fence /
// posterior_collapsed) duplicated the posterior signal the dispatcher
// already reads. Bad artifacts naturally demote via outcome — emitting
// action_predicted with a high predicted_residual derived from posterior
// is the same information the gate produced, without the extra refusal
// path. Removed; the universal verifier closes the loop on action_scored.

type DispatchResult = {
  dispatch_id: string;
  task_id: string;
  events: Event[];
  violations: string[];
  bridge_result?: BridgeResult;
};

const COMMIT_RESIDUAL_THRESHOLD = 0.3;

const irreversibleConsentEventId = (
  db: Database,
  directiveId: string,
  payload: Record<string, unknown>,
): string | null => {
  const consentId = payload.owner_consent_event_id;
  if (typeof consentId !== "string" || consentId.trim().length === 0) return null;
  const row = db
    .query("SELECT kind, directive_id FROM events WHERE id = ?")
    .get(consentId) as { kind: string; directive_id: string } | null;
  if (!row || row.kind !== "owner_decision_recorded" || row.directive_id !== directiveId) return null;
  return consentId;
};

type DispatchDeps = {
  /** Override the bridge call — Phase D tests use this to inject the
   *  adversarial cycle-2 mock. Defaults to opencodeQuery. */
  bridge?: (req: BridgeRequest, db: Database) => Promise<BridgeResult>;
  /** Test seam for dispatcher behavior assertions that should not pay runtime subprocess cost. */
  runArtifact?: (inv: UnifiedRuntimeInvocation) => Promise<UnifiedRuntimeObservation>;
  /** Optional fixture path threaded into the bridge request. The MVP fixture
   *  reads it to point the bun grep at a deterministic directory. */
  fixtureTargetPath?: string;
  /** Embedding index for depth-1 retrieval. When present, the dispatcher
   *  calls `retrieve(db, index, ...)` against the task goal text BEFORE
   *  composePrompt and passes the result as `retrievedKnowledge` so the
   *  brain prompt's KNOWLEDGE section is reranked by cosine × posterior
   *  × origin bias (not recency). Knowledge audit bc5vdkrik finding #1
   *  (2026-05-15): without this wiring depth-1 retrieval is dead — the
   *  prompt section always fell back to readKnowledgeTopK's recency scan. */
  index?: import("./embedding_index").EmbeddingIndex;
  /** Deliverable compounding seam: before composePrompt, resolve any active
   *  deliverable groundbase for this directive and pass it as server-side
   *  inline prompt bytes. This must NOT rely on brain filesystem reads: the
   *  dispatcher reads admitted data-class artifacts / lineage rows itself and
   *  supplies locked_outline_template, current_best_body, requirements_ledger,
   *  and source artifact ids to the composer. Defaults to
   *  artifact_store.readDeliverableGroundbase when omitted. */
  retrieveDeliverableGroundbase?: (db: Database, task: TaskNode) => Promise<import("./prompt_composer").DeliverableGroundbase | null>;
};

const readEventsForDispatch = async (db: Database, dispatchId: string): Promise<Event[]> => {
  // Heavy read scan (LIKE + correlated subquery over the events table) — route
  // off the daemon main loop through the SQL worker pool. poolQuery uses the
  // same db handle + SQL + params, so rows/order are identical to the sync
  // path; falls back to sync when no pool is installed (unit tests / diagnostics).
  const rows = await poolQuery<Record<string, unknown>>(
    db,
    "SELECT * FROM events WHERE payload LIKE ? OR id IN (SELECT id FROM events WHERE ts >= (SELECT ts FROM events WHERE id = ?)) ORDER BY ts ASC",
    [`%${dispatchId}%`, dispatchId],
  );
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

const readEventsSinceTs = async (db: Database, sinceTs: string, taskId: string): Promise<Event[]> => {
  // Heavy read scan over the events table (called several times per dispatch to
  // collect every event emitted during the bridge run) — route off the main
  // loop through the SQL worker pool. Same db/SQL/params → identical rows and
  // ordering; sync fallback when no pool is present.
  const rows = await poolQuery<Record<string, unknown>>(
    db,
    "SELECT * FROM events WHERE ts >= ? AND task_id = ? ORDER BY ts ASC",
    [sinceTs, taskId],
  );
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
  const runArtifact = deps.runArtifact ?? runArtifactForRuntime;

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
  const decision = await timeStage("decide_dispatch", task.id, () => decideDispatch(db, task));
  const dispatchDecisionEvidence = dispatchEvidencePayload(decision);
  const dispatchDecidedEvent = emitEvent(db, {
    kind: "dispatch_decided",
    substrate_origin: "substrate_auto",
    directive_id: task.directive_id,
    task_id: task.id,
    payload: {
      dispatch_id: dispatchId,
      ...dispatchDecisionEvidence,
    } as JsonValue,
  });
  emitEvent(db, {
    kind: "constitutional_gate_decision",
    substrate_origin: "substrate_auto",
    directive_id: task.directive_id,
    task_id: task.id,
    payload: {
      dispatch_id: dispatchId,
      ...dispatchDecisionEvidence,
    } as JsonValue,
  });

  // F6 — universal internal Act scoring. The dispatcher just selected
  // a lane (substrate_replay | claude_inline | opencode_brain |
  // deferred_blocked). Record the decision as an act_tuple so the
  // downstream lane outcome (task_committed / task_failed) can credit
  // dispatch_decider_v1's posterior. predicted_residual mirrors the
  // selected route's score: a high-scored route predicts a low
  // residual; a defensive-fallback route predicts a higher residual.
  const selectedRouteScore = dispatchDecisionEvidence.route_scores[decision.route] ?? 0.5;
  recordInternalAct(db, {
    intent: "select dispatch lane",
    actionHandle: "dispatch_decider_v1",
    verifierHandle: "lane_outcome_residual",
    verifierKind: "deterministic_code",
    predictedResidual: 1 - selectedRouteScore,
    reasoningSummary: `selected route=${decision.route} score=${selectedRouteScore.toFixed(2)} reason=${decision.reason}`,
    actionSummary: `dispatch_decided route=${decision.route}`,
    effectSummary: `dispatch_decided emitted dispatch_id=${dispatchId}`,
    directiveId: task.directive_id,
    taskId: task.id,
    sourceEventId: dispatchDecidedEvent.id,
    sourceActId: "dispatch_decider_v1:" + dispatchId,
    extra: {
      route: decision.route,
      reason: decision.reason,
      selected_route_score: selectedRouteScore,
      dispatch_id: dispatchId,
    },
  });

  // T4.1 counterfactual credit — route selection boundary. The decider
  // just picked one route from a candidate set; the non-chosen routes
  // are counterfactual alternatives. Their posteriors should learn
  // from the chosen path's residual once action_scored arrives. Each
  // rejected route is identified by its bare route string. Fail-soft:
  // emission failure must never block dispatch.
  try {
    const allRoutes: Array<"substrate_replay" | "claude_inline" | "claude_agent" | "opencode_brain" | "deferred_blocked"> =
      ["substrate_replay", "claude_inline", "claude_agent", "opencode_brain", "deferred_blocked"];
    const rejectedRoutes = allRoutes.filter((r) => r !== decision.route);
    const rejectedCandidates = rejectedRoutes
      .map((r) => ({
        id: `route:${r}`,
        score: dispatchDecisionEvidence.route_scores[r] ?? 0,
        reason: "route_not_selected",
      }))
      .filter((c) => c.score > 0); // skip routes with zero score (not in feasible set)
    if (rejectedCandidates.length > 0) {
      emitEvent(db, {
        kind: "counterfactual_alternative_recorded",
        substrate_origin: "substrate_auto",
        directive_id: task.directive_id,
        task_id: task.id,
        context_refs: [dispatchDecidedEvent.id],
        payload: {
          selection_kind: "route_selection",
          selection_event_id: dispatchDecidedEvent.id,
          chosen_id: `route:${decision.route}`,
          rejected_candidates: rejectedCandidates,
          window_seconds: 600,
          dispatch_id: dispatchId,
        } as JsonValue,
      });
    }
  } catch { /* fail-soft */ }

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

    // Reusable trajectory selection is signaled inline by stamping the
    // already-emitted dispatch_decided row's payload columns (route=substrate_replay
    // + reusable_trajectory_replay_selected=true + routing_axes/knowledge_id).
    // Tests and observers check dispatch_decided where route='substrate_replay'.
    // The reusable-trajectory selection event family was absorbed under universality proposal
    // A12CR1QCDN0SS51CM95K39T45M; replay outcomes flow through the standard
    // action_scored / task_committed substrate. Emit one action_predicted row
    // citing the selector + verifier artifact handles so the credit chain has
    // a per-selection anchor row.
    const trajectorySelectionEvent = emitEvent(db, {
      kind: "action_predicted",
      substrate_origin: "substrate_auto",
      directive_id: task.directive_id,
      task_id: task.id,
      action_artifact_id: "recipe_replay_selector_v1",
      verifier_artifact_id: "replay_vs_fresh_residual_delta",
      predicted_residual: 1 - match.confidence,
      payload: {
        dispatch_id: dispatchId,
        reusable_trajectory_replay_selected: true,
        reusable_trajectory_knowledge_id: match.recipe_id,
        knowledge_id: match.recipe_id,
        recipe_id: match.recipe_id,
        goal_shape: match.goal_shape,
        topology_signature: match.topology_signature,
        confidence: match.confidence,
      } as JsonValue,
      context_refs: [match.recipe_id],
    });

    // F6 extension — universal internal Act scoring. The substrate
    // just selected this matched reusable trajectory for replay instead of
    // routing to opencode_brain. The selection itself is the decision; the
    // replay outcome is scored on the standard action_scored / task_committed
    // substrate. Verifier is replay_vs_fresh_residual_delta — a downstream
    // process scores whether the trajectory saved a brain call.
    recordInternalAct(db, {
      intent: "select reusable trajectory knowledge for replay",
      actionHandle: "recipe_replay_selector_v1",
      verifierHandle: "replay_vs_fresh_residual_delta",
      verifierKind: "deterministic_code",
      predictedResidual: 1 - match.confidence,
      reasoningSummary: `matched reusable trajectory ${match.recipe_id} goal_shape=${match.goal_shape} confidence=${match.confidence.toFixed(2)}`,
      actionSummary: `reusable_trajectory_replay_selected dispatch_id=${dispatchId} knowledge_id=${match.recipe_id}`,
      effectSummary: `dispatcher will replay the cached trajectory; no brain call`,
      directiveId: task.directive_id,
      taskId: task.id,
      sourceEventId: trajectorySelectionEvent.id,
      sourceActId: "recipe_replay_selector_v1:" + dispatchId + ":" + match.recipe_id,
      citedArtifactIds: match.cited_act_artifact_ids.length > 0
        ? match.cited_act_artifact_ids
        : [match.recipe_id],
      extra: {
        recipe_id: match.recipe_id,
        knowledge_id: match.recipe_id,
        reusable_trajectory_knowledge_id: match.recipe_id,
        goal_shape: match.goal_shape,
        topology_signature: match.topology_signature,
        confidence: match.confidence,
        dispatch_id: dispatchId,
      },
    });

    const replayRunArtifact = deps.runArtifact
      ? async (replayDb: Database, artifactId: string, inputs: JsonValue) => {
          const artifact = getArtifact(replayDb, artifactId);
          if (!artifact) {
            return { ok: false, result: null, error: "artifact_not_found:" + artifactId };
          }
          if (!artifact.declaredSandbox) {
            return { ok: false, result: null, error: "artifact_not_executable:" + artifactId };
          }
          const observation = await deps.runArtifact!({
            artifactId: artifact.id,
            body: artifact.body,
            declaredSandbox: artifact.declaredSandbox,
            inputs,
            emit: (ev) => {
              emitEvent(replayDb, {
                ...ev,
                directive_id: ev.directive_id ?? task.directive_id,
                task_id: ev.task_id ?? task.id,
                invoker: ev.invoker ?? "substrate_auto",
              });
            },
          });
          return {
            ok: observation.ok,
            result: (observation.result ?? null) as JsonValue | null,
            error: observation.error,
          };
        }
      : undefined;
    const outcome = await replayRecipe(db, task, match, { runArtifact: replayRunArtifact });
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
        events: await readEventsSinceTs(db, dispatchStartedTs, task.id),
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
        reason: `substrate_replay_high_residual:${outcome.abort_reason ?? "unknown"}`,
        previous_route: "substrate_replay",
      } as JsonValue,
    });
    effectiveRoute = "opencode_brain";
  }

  if (effectiveRoute === "claude_agent" && decision.route === "claude_agent") {
    const job = requestJob(db, {
      directive_id: task.directive_id,
      task_id: task.id,
      intent: decision.job_intent,
      target_files: decision.target_files,
      acceptance_predicate: decision.acceptance_predicate as JsonValue,
    });
    emitEvent(db, {
      kind: "brain_dispatch_closed",
      substrate_origin: "substrate_auto",
      directive_id: task.directive_id,
      task_id: task.id,
      context_refs: [job.id],
      payload: {
        dispatch_id: dispatchId,
        reason: "claude_agent_job_requested",
        job_id: job.job_id,
        job_request_event_id: job.id,
      } as JsonValue,
    });
    return {
      dispatch_id: dispatchId,
      task_id: task.id,
      events: await readEventsSinceTs(db, dispatchStartedTs, task.id),
      violations: [],
    };
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

  // Phase 9 (generate-and-select): env-gated, default-OFF organism hook
  // (RLM-first). Interception requires ACC2_GENERATE_SELECT=1 AND an injected
  // scored `shouldHandle` predicate (no keyword/regex classifier). Until the
  // substrate wires that predicate here, the hook returns {handled:false} and
  // every directive falls through to the brain lane — fail-closed by design.
  {
    const gs = await maybeRunGenerateSelect(db, task.goal ?? "", {
      directiveId: task.directive_id,
      taskId: task.id,
      substrateOrigin: "substrate_auto",
    });
    if (gs.handled) {
      const residual = gs.result?.selected ? 0 : 1;
      emitEvent(db, {
        kind: "task_committed",
        substrate_origin: "substrate_auto",
        directive_id: task.directive_id,
        task_id: task.id,
        residual,
        payload: {
          dispatch_id: dispatchId,
          reason: "generate_select_organism",
          path: gs.result?.path,
          route: gs.result?.route,
          selected: gs.result?.selected?.id ?? null,
          organism_reason: gs.result?.reason,
        } as JsonValue,
      });
      emitEvent(db, {
        kind: "brain_dispatch_closed",
        substrate_origin: "substrate_auto",
        directive_id: task.directive_id,
        task_id: task.id,
        payload: { dispatch_id: dispatchId, reason: "generate_select_organism" } as JsonValue,
      });
      return {
        dispatch_id: dispatchId,
        task_id: task.id,
        events: await readEventsSinceTs(db, dispatchStartedTs, task.id),
        violations: [],
      };
    }
  }

  // 3. opencode_brain — compose prompt + call bridge.
  //
  // Depth-1 retrieval: when an embedding index is available, retrieve
  // knowledge against the task goal text + emit one `retrieval_binding`
  // event per hit. Without this, the brain prompt's KNOWLEDGE section
  // falls back to recency scan (operationally dead — knowledge audit
  // bc5vdkrik #1 + lesson "memory surface can appear healthy while being
  // operationally dead if prompt composition renders only handles").
  let retrievedKnowledge: import("./retrieval").RetrievalResult | null = null;
  let retrievedArtifacts: import("./retrieval").RetrievalResult | null = null;
  let retrievalUnavailable: { reason: string } | null = null;
  if (deps.index) {
    try {
      const { retrieve } = await import("./retrieval");
      retrievedKnowledge = await timeStage("retrieve_knowledge", task.id, () => retrieve(db, deps.index!, {
        text: task.goal ?? task.directive_id,
        k: 8,
        kindFilter: ["knowledge_candidate", "knowledge_promoted", "knowledge_synthesized"],
        goalText: task.goal,
      }));
      // Organism-alignment audit b3qc9ryzj #4 (2026-05-15): retrieve
      // task-similar code artifacts too — the registry has a reranked
      // prompt path but pre-fix the dispatcher only fed it posterior-
      // sorted results (artifact_routing_view), not task-similarity
      // aware. Now the brain's CODE ARTIFACT REGISTRY prompt section
      // gets cosine × posterior × origin reranked artifacts.
      try {
        retrievedArtifacts = await timeStage("retrieve_artifacts", task.id, () => retrieve(db, deps.index!, {
          text: task.goal ?? task.directive_id,
          k: 6,
          // act_artifact_* canonical + code_artifact_* legacy aliases (F4a):
          // single source of truth in event_kinds.ts (immutable historical
          // rows still need the legacy names through retrieval).
          kindFilter: ["act_artifact"],
          goalText: task.goal,
        }));
        if (retrievedArtifacts.query_embedding_unavailable) retrievedArtifacts = null;
      } catch { retrievedArtifacts = null; }
      // PROACTIVE capability-gap detection at SELECTION time (directive
      // KDZVSFNPM). The artifact retrieval above already reranked admitted
      // act_artifact candidates by fit; a gap exists when the BEST fit is
      // below the proactive floor (or there are zero candidates) for a goal
      // that genuinely wants an executable artifact. The detection is a cheap
      // comparison on already-computed fit scores — no extra heavy read on the
      // hot path. The emission + brain-author dispatch is debounced
      // (one open proactive gap per goal_shape, cooldown, attempt-cap) inside
      // maybeOpenProactiveGap. Wrapped + best-effort so a detector fault never
      // blocks dispatch. The "wants_artifact" gate is fail-closed: we fire
      // when the goal's semantic neighborhood retrieved act_artifact
      // candidates (poor-fit case) OR the substrate routed this to an
      // execution/agent lane (zero-candidate case) — NOT a regex classifier.
      try {
        const { goalShape: computeGoalShape } = await import("./goal_shape");
        const { maybeOpenProactiveGap } = await import("./capability_gap");
        const goalTextForGap = task.goal ?? "";
        const goalShapeForGap = goalTextForGap ? computeGoalShape(goalTextForGap) : "";
        const artifactHits = retrievedArtifacts?.hits ?? [];
        const candidateCount = artifactHits.length;
        const bestFit = artifactHits.reduce(
          (max, h) => Math.max(max, Number(h.routing_score_breakdown?.artifact_fit ?? 0)),
          0,
        );
        // Fail-closed artifact-wanting gate. Poor-fit case: candidates exist
        // (the goal's neighborhood IS artifact-shaped). Zero-candidate case:
        // only an explicit execution/agent route asserts artifact-demand.
        const wantsArtifact = candidateCount > 0 || decision.route === "claude_agent";
        if (goalShapeForGap) {
          maybeOpenProactiveGap(db, {
            goal_shape: goalShapeForGap,
            goal_text: goalTextForGap,
            best_fit: bestFit,
            candidate_count: candidateCount,
            wants_artifact: wantsArtifact,
          });
        }
      } catch (gapErr) {
        logger.warn(
          { where: "dispatcher.proactiveGap", err: (gapErr as Error).message, task_id: task.id },
          "proactive capability-gap detection threw — non-fatal, dispatch continues",
        );
      }
      // Organism-alignment audit b3qc9ryzj #2 (2026-05-15): surface
      // query_embedding_unavailable as a fail-loud retrievalUnavailable
      // metadata instead of letting it silently degrade to recency-fallback.
      // Emit owner_input_required so the operator sees the missing
      // prerequisite via SSE → Claude shell.
      if (retrievedKnowledge.query_embedding_unavailable) {
        retrievalUnavailable = { reason: "query_embedding_unavailable" };
        retrievedKnowledge = null;
        emitEvent(db, {
          kind: "owner_input_required",
          substrate_origin: "substrate_auto",
          directive_id: task.directive_id,
          task_id: task.id,
          payload: {
            reason: "depth_1_retrieval_unavailable",
            cause: "query_embedding_unavailable",
            instruction: "set OPENAI_API_KEY on the daemon process so text-embedding-3-small can compute query embeddings; retrieval is fail-closed until the prerequisite is met.",
          } as JsonValue,
        });
      } else {
        // Emit retrieval_binding for each hit so the credit chain
        // (action_predicted.context_refs → binding → source_event_id) can
        // mutate the cited posterior on outcome (k_554 citation = mutation).
        for (let rank = 0; rank < retrievedKnowledge.hits.length; rank++) {
          const hit = retrievedKnowledge.hits[rank]!;
          const binding = emitEvent(db, {
            kind: "retrieval_binding",
            substrate_origin: "substrate_auto",
            directive_id: task.directive_id,
            task_id: task.id,
            payload: {
              query: task.goal ?? "",
              source_event_id: hit.event_id,
              rendered_snippet: hit.snippet,
              rank,
              rerank_score: hit.rerank_score,
              posterior: hit.posterior,
              aspect_scores: hit.aspect_scores,
              domain_scores: hit.domain_scores,
              routing_score_breakdown: hit.routing_score_breakdown,
              binding_surface: "prompt",
            } as JsonValue,
          });
          const sourceDirectiveId = resolveKnowledgeSourceDirective(db, hit.event_id);
          if (sourceDirectiveId && sourceDirectiveId !== task.directive_id) {
            emitEvent(db, {
              kind: "knowledge_propagated",
              substrate_origin: "substrate_auto",
              directive_id: task.directive_id,
              task_id: task.id,
              context_refs: [hit.event_id, binding.id],
              payload: {
                source_event_id: hit.event_id,
                source_directive_id: sourceDirectiveId,
                target_directive_id: task.directive_id,
                retrieval_binding_id: binding.id,
                query: task.goal ?? "",
                rank,
                rerank_score: hit.rerank_score,
                posterior: hit.posterior,
                propagation_surface: "prompt",
              } as JsonValue,
            });
          }
        }
      }
    } catch (err) {
      // Organism-alignment audit b3qc9ryzj #3 (2026-05-15): exceptions
      // are fail-loud now. Pre-fix retrievedKnowledge was set to null
      // and composePrompt fell back to recency-scan. Now the composer
      // gets retrievalUnavailable metadata and renders an explicit
      // "(unavailable)" section.
      const reason = (err as Error).message ?? "unknown";
      retrievalUnavailable = { reason: `exception:${reason}` };
      retrievedKnowledge = null;
      logger.warn(
        { where: "dispatcher.retrieve", err: reason, task_id: task.id },
        "depth-1 retrieval threw — composing prompt with explicit unavailable marker",
      );
    }
  }
  // Q2 (brain amendment MDBZV4YVRH7D172BW40W1J5ASM, 2026-05-19): on-
  // demand policy retrieval. Query act_artifact for admitted rows
  // whose kind is prompt_policy_bundle or composer_policy_predicate
  // and whose body declares a section_name matching one of the
  // REQUIRED_POLICY_SECTION_NAMES the composer is about to push. Take
  // top K (K=3) per section by score. Pass via opts.retrievedPolicy
  // Artifacts so composePrompt stays synchronous. Wrapped in try/catch
  // because a stale/migrating substrate may not have admitted rows;
  // composePrompt falls back to policyByName + literal warnings.
  let retrievedPolicyArtifacts:
    | Partial<Record<string, Array<import("./prompt_composer").RetrievedPolicyArtifactBundle>>>
    | undefined = undefined;
  try {
    // Heavy read scan over act_artifact (kind filter + ORDER BY + LIMIT 100) on
    // the prompt-setup path — route off the main loop. Identical db/SQL/params
    // → identical rows/order; sync fallback when no pool is installed.
    const policyArtifactRows = await timeStage("retrieve_policy_artifacts", task.id, () => poolQuery<Record<string, unknown>>(
      db,
      `SELECT id, body, score, name
           FROM act_artifact
          WHERE kind IN ('prompt_policy_bundle', 'composer_policy_predicate')
            AND status = 'admitted'
          ORDER BY score DESC, confidence DESC
          LIMIT 100`,
    ));
    if (policyArtifactRows.length > 0) {
      const perSection: Record<string, Array<import("./prompt_composer").RetrievedPolicyArtifactBundle>> = {};
      for (const r of policyArtifactRows) {
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = JSON.parse(String(r.body ?? "{}")) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (!parsed) continue;
        const payload = (parsed.payload && typeof parsed.payload === "object")
          ? parsed.payload as Record<string, unknown>
          : parsed;
        const sectionName = (payload.section_name as string | undefined) ?? (parsed.name as string | undefined);
        if (!sectionName) continue;
        const surface = (payload.surface as string | undefined) ?? "brain_prompt";
        if (surface !== "brain_prompt") continue;
        const body = payload.body;
        if (typeof body !== "string" || body.length === 0) continue;
        // Universal prompt policy retrieval is section-scoped only.
        // Goal/domain labels may remain metadata for search and credit, but
        // they must not pre-filter which prompt policy can reach composePrompt.
        const kindRaw = (parsed.kind as string | undefined) ?? "prompt_policy_bundle";
        const bundleArtifactKind: "prompt_policy_bundle" | "emission_grammar" | "self_introspection" =
          (kindRaw === "emission_grammar" || kindRaw === "self_introspection")
            ? kindRaw
            : "prompt_policy_bundle";
        const bucket = perSection[sectionName] ?? (perSection[sectionName] = []);
        if (bucket.length >= 3) continue; // K=3 per section
        bucket.push({
          artifactId: String(r.id),
          artifactKind: bundleArtifactKind,
          surface,
          sectionName: sectionName as never,
          body,
          priority: typeof payload.priority === "number" ? (payload.priority as number) : undefined,
          floor: payload.floor === true,
          score: typeof r.score === "number" && Number.isFinite(r.score) ? (r.score as number) : 0,
          goalShape: typeof payload.goal_shape === "string" ? (payload.goal_shape as string) : undefined,
          evidence_event_ids: Array.isArray(payload.evidence_event_ids)
            ? (payload.evidence_event_ids as unknown[]).map(String)
            : undefined,
        });
      }
      if (Object.keys(perSection).length > 0) {
        retrievedPolicyArtifacts = perSection;
      }
    }
  } catch (err) {
    logger.warn(
      { where: "dispatcher.retrievedPolicyArtifacts", err: (err as Error).message, task_id: task.id },
      "policy-artifact retrieval threw — composing prompt with default policy_bundle fallback chain",
    );
  }
  // Deliverable compounding: resolve the directive's prior-best groundbase
  // server-side (the brain cannot read it from its sandbox) so the composer can
  // inline the current-best body + locked outline + cumulative requirements
  // BEFORE workflow instructions. Resolved once here so it feeds both the cache
  // key (a stale groundbase must never be served from cache) and composePrompt.
  const deliverableGroundbase = await timeStage("retrieve_deliverable_groundbase", task.id, async () => {
    try {
      if (deps.retrieveDeliverableGroundbase) return await deps.retrieveDeliverableGroundbase(db, task);
      const artifactStore = await import("./artifact_store");
      const g = artifactStore.readDeliverableGroundbase(db, task.directive_id);
      return g
        ? {
            groundbaseArtifactId: g.groundbaseArtifactId,
            currentBestArtifactId: g.currentBestArtifactId,
            lockedOutlineArtifactId: g.lockedOutlineArtifactId,
            requirementsLedgerArtifactId: g.requirementsLedgerArtifactId,
            currentBestBody: g.currentBestBody,
            lockedOutline: g.lockedOutline,
            requirementsLedger: g.requirementsLedger,
            satisfiedRequirementIds: g.satisfiedRequirementIds,
            lineageArtifactIds: g.lineageArtifactIds,
            evidenceEventIds: g.evidenceEventIds,
          }
        : null;
    } catch (err) {
      logger.warn(
        { where: "dispatcher.deliverableGroundbase", err: (err as Error).message, task_id: task.id },
        "deliverable groundbase retrieval threw — composing prompt without deliverable_groundbase section",
      );
      return null;
    }
  });
  const promptCache = await import("./prompt_cache");
  const promptCacheKey = {
    directive_id: task.directive_id,
    task_id: task.id,
    options_signature: JSON.stringify({
      retrievedKnowledgeIds: retrievedKnowledge?.hits.map((h) => h.event_id) ?? [],
      retrievedArtifactIds: retrievedArtifacts?.hits.map((h) => h.event_id) ?? [],
      deliverableGroundbaseArtifactId: deliverableGroundbase?.groundbaseArtifactId ?? null,
      deliverableGroundbaseCurrentBest: deliverableGroundbase?.currentBestArtifactId ?? null,
      deliverableGroundbaseSources: deliverableGroundbase?.evidenceEventIds ?? [],
      retrievalUnavailable,
      retrievedPolicySections: Object.keys(retrievedPolicyArtifacts ?? {}).sort(),
    }),
  };
  const cachedPrompt = promptCache.lookupCachedPrompt<{ text: string }>(db, promptCacheKey);
  let composed: { text: string };
  if (cachedPrompt.hit) {
    composed = cachedPrompt.value;
    promptCache.recordPromptCacheHit(db, promptCacheKey, cachedPrompt.age_ms);
  } else {
    const composer = await resolveComposePrompt();
    composed = await timeStage("compose_prompt", task.id, () => composer(db, {
      taskId: task.id,
      retrievedKnowledge,
      retrievedArtifacts,
      deliverableGroundbase,
      retrievalUnavailable,
      retrievedPolicyArtifacts: retrievedPolicyArtifacts as never,
    }));
    promptCache.storeCachedPrompt(db, promptCacheKey, composed);
    promptCache.recordPromptCacheMiss(db, promptCacheKey, cachedPrompt.reason, {
      cached_rowid: "cached_rowid" in cachedPrompt ? cachedPrompt.cached_rowid : undefined,
      current_rowid: "current_rowid" in cachedPrompt ? cachedPrompt.current_rowid : undefined,
    });
  }
  bridgeResult = await bridge(
    {
      prompt: composed.text,
      taskId: task.id,
      directiveId: task.directive_id,
      fixtureTargetPath: deps.fixtureTargetPath,
      // F8: thread the dispatch_id through so the bridge's spawn-time
      // brain_dispatched + brain_dispatch_closed pair joins to the same
      // dispatch row the task_dispatcher just emitted.
      dispatchId,
    },
    db,
  );

  // 4. Inspect every event emitted on this task during the dispatch window.
  //    The dispatcher reads from the SAME substrate the bridge writes to —
  //    that's the symmetry §3.6 calls for.
  const dispatchEvents = await readEventsSinceTs(db, dispatchStartedTs, task.id);

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
    // Bridge-timeout safety net (added 2026-05-15 after live ledger inspection).
    // If the closure verifier ran cleanly during this dispatch
    // (task_closure_audited with closure_residual below the 0.3 commit
    // threshold) AND the bridge then timed out before the brain could
    // emit task_committed, the substrate auto-commits citing the closure
    // event as evidence. WHY: the closure verifier IS the commit gate
    // (brain_prompt workflow policy step 7); the brain emitting task_committed afterward
    // is the "rubber stamp" that a 300-600s bridge window sometimes can't
    // accommodate. Pre-fix the next dispatch would re-run the entire
    // cycle from scratch, paying tokens for work the verifier had already
    // scored as complete.
    const isTimeout = bridgeResult.reason.kind === "timeout";
    const bridgeFailureEvents = dispatchEvents.filter((e) => e.kind === "bridge_failed");
    const bridgeFailureEventIds = bridgeFailureEvents.map((e) => e.id);
    const lastBridgeFailurePayload = (bridgeFailureEvents.at(-1)?.payload ?? {}) as Record<string, unknown>;
    const bridgeBudgetObserved = (lastBridgeFailurePayload.budget_observed ?? null) as JsonValue | null;
    let timeoutRecoveryOutcome: "not_timeout" | "no_closure_audit" | "closure_residual_high" | "already_committed" | "auto_committed" | "error" = isTimeout ? "no_closure_audit" : "not_timeout";
    if (isTimeout) {
      const closureAudit = dispatchEvents.find((e) => e.kind === "task_closure_audited");
      if (closureAudit) {
        try {
          const auditPayload = (closureAudit.payload ?? {}) as Record<string, unknown>;
          const closureResidual = typeof auditPayload.closure_residual === "number"
            ? auditPayload.closure_residual
            : null;
          if (closureResidual !== null && closureResidual < 0.3) {
            const alreadyCommitted = dispatchEvents.find((e) => e.kind === "task_committed");
            const readiness = rootCommitReadiness(db, task.id);
            if (alreadyCommitted) {
              timeoutRecoveryOutcome = "already_committed";
            } else if (!readiness.ok && readiness.reason !== "not_root") {
              timeoutRecoveryOutcome = "closure_residual_high";
              emitEvent(db, {
                kind: "dispatcher_violation",
                substrate_origin: "substrate_auto",
                directive_id: task.directive_id,
                task_id: task.id,
                failure_kind: "root_commit_blocked",
                payload: {
                  dispatch_id: dispatchId,
                  reason: readiness.reason,
                  closure_audit_event_id: readiness.closure_audit_event_id,
                  nonterminal_descendant_task_ids: readiness.nonterminal_descendant_task_ids,
                } as JsonValue,
              });
            } else {
              timeoutRecoveryOutcome = "auto_committed";
              emitEvent(db, {
                kind: "task_committed",
                substrate_origin: "substrate_auto",
                directive_id: task.directive_id,
                task_id: task.id,
                residual: closureResidual,
                context_refs: [closureAudit.id],
                payload: {
                  dispatch_id: dispatchId,
                  reason: "auto_commit_on_bridge_timeout_after_clean_closure_audit",
                  bridge_failure_reason: bridgeResult.reason.kind,
                  bridge_failure_event_ids: bridgeFailureEventIds,
                  budget_observed: bridgeBudgetObserved,
                  recovery_evidence: {
                    mode: "closure_audit_timeout_recovery",
                    threshold: 0.3,
                    closure_audit_event_id: closureAudit.id,
                  },
                  closure_audit_event_id: closureAudit.id,
                  closure_residual: closureResidual,
                } as JsonValue,
              });
            }
          } else if (closureResidual !== null) {
            timeoutRecoveryOutcome = "closure_residual_high";
          }
        } catch (err) {
          timeoutRecoveryOutcome = "error";
          logger.warn(
            { where: "task_dispatcher.timeout_auto_commit", task_id: task.id, err: (err as Error).message },
            "auto-commit on bridge timeout failed — falling through to normal close path",
          );
        }
      }
    }
    // ── Productive-timeout continuation (2026-05-23) ──────────────────────
    // PROBLEM (observed live): a brain dispatch that ran the full wall-clock
    // budget while making REAL progress (handshook MCP, received frames,
    // emitted brain observations, was actively editing) gets SIGTERM-killed
    // and recorded as a terminal bridge_failed{reason=timeout}. The closure-
    // audit recovery above only rescues runs that ALSO produced a clean
    // task_closure_audited; a productive-but-unclosed run still dropped all
    // in-progress work and fed supervisor_redispatch_storm -> task_failed.
    //
    // FIX: when the timeout fired BUT the dispatch was PRODUCTIVE
    // (first_frame_seen AND frames_received_count > 0 AND
    // brain_obs_emit_count > 0), treat it as NEEDS-CONTINUATION instead of a
    // hard terminal failure. We re-open the work via the EXISTING refinement
    // edge mechanism (task_node_opened + task_edge_recorded kind="refines"),
    // so the scheduler picks a fresh cycle-1 dispatch that continues the
    // remaining work. A zero-progress timeout (genuinely wedged) is NOT
    // productive and falls through to the normal terminal close path.
    //
    // No infinite loop: the continuation child sits one step deeper on the
    // 'refines' chain, so refinementDepth grows by 1 per productive timeout.
    // The same depth>=REFINEMENT_DEPTH_CAP guard that bounds residual-driven
    // refinement bounds this chain — after the cap the lineage emits
    // refinement_depth_exceeded -> task_failed. Each continuation dispatch
    // also emits a fresh brain_dispatched under the directive, so the
    // supervisor's per-directive dispatch budget (and the per-task storm cap
    // on any task that DOESN'T advance via a new edge) still backstop it.
    let productiveTimeoutContinuation: "not_attempted" | "opened" | "depth_capped" = "not_attempted";
    if (
      isTimeout &&
      (timeoutRecoveryOutcome === "no_closure_audit" || timeoutRecoveryOutcome === "closure_residual_high")
    ) {
      const budget = (bridgeBudgetObserved ?? {}) as Record<string, unknown>;
      const framesReceivedCount = typeof lastBridgeFailurePayload.frames_received_count === "number"
        ? lastBridgeFailurePayload.frames_received_count
        : 0;
      const brainObsEmitCount = typeof lastBridgeFailurePayload.brain_obs_emit_count === "number"
        ? lastBridgeFailurePayload.brain_obs_emit_count
        : 0;
      const firstFrameSeen = budget.first_frame_seen === true;
      const productive = firstFrameSeen && framesReceivedCount > 0 && brainObsEmitCount > 0;
      if (productive) {
        // Reuse the shared refinement-edge continuation primitive (also used
        // by the daemon shutdown-drain checkpoint, runtime/dispatch_continuation.ts).
        // It bounds the chain at REFINEMENT_DEPTH_CAP (terminalizing via
        // refinement_depth_exceeded -> task_failed when exhausted) and emits
        // the task_node_opened + task_edge_recorded(refines) +
        // task_committed_superseded triplet so the scheduler resumes the work.
        const continuation = emitRefinementContinuation(db, {
          taskId: task.id,
          directiveId: task.directive_id,
          goal: task.goal ?? task.id,
          continuationReason: "productive_timeout_continuation",
          priorDispatchId: dispatchId,
          actionHandle: "productive_timeout_continuation_v1",
          extra: {
            prior_bridge_failure_event_ids: bridgeFailureEventIds as unknown as JsonValue,
            prior_frames_received_count: framesReceivedCount,
            prior_brain_obs_emit_count: brainObsEmitCount,
          },
        });
        productiveTimeoutContinuation =
          continuation.outcome === "opened"
            ? "opened"
            : continuation.outcome === "depth_capped"
              ? "depth_capped"
              : "not_attempted";
      }
    }
    emitEvent(db, {
      kind: "brain_dispatch_closed",
      substrate_origin: "substrate_auto",
      directive_id: task.directive_id,
      task_id: task.id,
      payload: {
        dispatch_id: dispatchId,
        reason: `bridge_failed:${bridgeResult.reason.kind}`,
        bridge_failure_reason: bridgeResult.reason.kind,
        bridge_failure_event_ids: bridgeFailureEventIds,
        budget_observed: bridgeBudgetObserved,
        timeout_recovery_attempted: isTimeout,
        timeout_recovery_outcome: timeoutRecoveryOutcome,
        productive_timeout_continuation: productiveTimeoutContinuation,
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
    if (
      actionArtifact &&
      verifierArtifact &&
      actionArtifact.declaredSandbox &&
      verifierArtifact.declaredSandbox
    ) {
      const actionSandbox = actionArtifact.declaredSandbox;
      const verifierSandbox = verifierArtifact.declaredSandbox;
      // Run action/verifier through the declared runtime, not a bun-only lane.
      // Universal act() requires the same observation + residual wrapper for bun,
      // uv, and camofox-browser; runtime-specific sandboxing belongs inside the
      // runtime runner selected by runArtifactForRuntime.
      // Inputs come from the predicted event's payload (target_path, resource
      // handles, stakeholder utility windows, browser_session ids, sensor streams,
      // etc.) and pass through ACC2_INPUTS unchanged alongside the canonical
      // target_path fallback.
      const predictedPayload = actionPredicted.payload as Record<string, unknown>;
      const actionInputs: JsonValue = {
        ...(predictedPayload as Record<string, unknown>),
        target_path: ((predictedPayload as Record<string, unknown>).target_path as string) ?? deps.fixtureTargetPath ?? ".",
      } as JsonValue;

      // Amendment KN78GX0J — PRE-ACTION owner-control hard gate.
      // owner_state_belief is calibration only; explicit consent /
      // things_to_never_do / irreversible-effect constraints are enforced
      // HERE, BEFORE the artifact runs. A refusal emits
      // owner_input_required / hidl_action_required and skips invocation —
      // no irreversible_effect_recorded after-the-fact, no action_scored
      // success. This is the structural enforcement (k_252): a learned
      // owner-state prior can never authorize a protected action.
      const plannedIrreversible = Array.isArray(predictedPayload.irreversible_effects)
        ? (predictedPayload.irreversible_effects as Array<Record<string, unknown>>)
        : [];
      const declaresIrreversibleSandbox = Array.isArray(actionSandbox.fs_write) && actionSandbox.fs_write.length > 0
        && predictedPayload.irreversible === true;
      const irreversibleForGate = plannedIrreversible.length > 0
        ? plannedIrreversible
        : (declaresIrreversibleSandbox ? [{ effect_kind: "declared_irreversible", description: "sandbox fs_write + payload.irreversible=true" }] : []);
      const citedConsent = typeof predictedPayload.owner_consent_event_id === "string" && predictedPayload.owner_consent_event_id.length > 0
        ? [predictedPayload.owner_consent_event_id as string]
        : [];
      const ownerStateBelief = (predictedPayload.owner_state_belief && typeof predictedPayload.owner_state_belief === "object")
        ? predictedPayload.owner_state_belief as Record<string, unknown>
        : null;
      const ownerControl = evaluateOwnerControlGate(db, {
        directive_id: task.directive_id,
        task_id: task.id,
        action_summary: typeof predictedPayload.action_summary === "string" ? predictedPayload.action_summary : (task.goal ?? actionArtifact.id),
        target_resources: [
          typeof predictedPayload.target_path === "string" ? predictedPayload.target_path : "",
          ...(Array.isArray(predictedPayload.target_resources) ? (predictedPayload.target_resources as unknown[]).filter((r): r is string => typeof r === "string") : []),
        ].filter((s) => s.length > 0),
        irreversible_effects: irreversibleForGate,
        requested_capabilities: [...(actionSandbox.fs_write ?? []), ...(actionSandbox.net_allow ?? [])],
        cited_owner_consent_event_ids: citedConsent,
        owner_state_belief: ownerStateBelief,
        owner_profile: readOwnerProfile(db),
      });
      if (!ownerControl.allowed) {
        emitEvent(db, {
          kind: ownerControl.gate_kind ?? "owner_input_required",
          substrate_origin: "substrate_auto",
          directive_id: task.directive_id,
          task_id: task.id,
          context_refs: [actionPredicted.id, ...ownerControl.evidence_event_ids],
          payload: {
            dispatch_id: dispatchId,
            reason: ownerControl.reason,
            summary: ownerControl.summary,
            suggested_action: ownerControl.suggested_action,
            matched_boundaries: ownerControl.matched_boundaries,
            action_artifact_id: actionArtifact.id,
            owner_state_belief_uncertainty: ownerControl.uncertainty,
          } as JsonValue,
        });
        emitEvent(db, {
          kind: "brain_dispatch_closed",
          substrate_origin: "substrate_auto",
          directive_id: task.directive_id,
          task_id: task.id,
          payload: {
            dispatch_id: dispatchId,
            reason: "owner_control_gate_refused",
            gate_kind: ownerControl.gate_kind,
            events_count: dispatchEvents.length,
          } as JsonValue,
        });
        return { dispatch_id: dispatchId, task_id: task.id, events: dispatchEvents, violations, bridge_result: bridgeResult };
      }

      const actionObs = await runArtifact({
        artifactId: actionArtifact.id,
        body: actionArtifact.body,
        declaredSandbox: actionSandbox,
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
        const ownerConsentEventId = irreversibleConsentEventId(db, task.directive_id, predictedPayload);
        if (!ownerConsentEventId) {
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
            predicted_residual: actionPredicted.predicted_residual ?? undefined,
            residual: 1,
            failure_kind: "governance_block",
            payload: {
              dispatch_id: dispatchId,
              reason: "owner_consent_missing",
              irreversible_effects_detected: actionObs.irreversibleEffects,
              required_field: "owner_consent_event_id",
            dispatch_decision: dispatchDecisionEvidence,
            routing_axes: decision.routing_axes,
            route_scores: decision.route_scores,
            dispatch_verifier_evidence: decision.verifier_evidence,
            } as JsonValue,
          });
          try {
            await distributeCredit(db, {
              action_event_id: actionPredicted.id,
              observation_event_id: obsRow?.id ?? actionPredicted.id,
              scored_event_id: scored.id,
              predicted_residual: actionPredicted.predicted_residual ?? 1,
              observed_residual: 1,
            });
          } catch (err) {
            logger.warn(
              { where: "task_dispatcher.credit.irreversible_consent_gate", task_id: task.id, err: (err as Error).message },
              "distributeCredit failed (irreversible consent gate) — falling back to direct posterior",
            );
            applyResidualOutcome(db, actionArtifact.id, 1, nowIso());
            applyResidualOutcome(db, verifierArtifact.id, 1, nowIso());
          }
          emitEvent(db, {
            kind: "brain_dispatch_closed",
            substrate_origin: "substrate_auto",
            directive_id: task.directive_id,
            task_id: task.id,
            payload: {
              dispatch_id: dispatchId,
              reason: "irreversible_owner_consent_missing",
              events_count: dispatchEvents.length,
            } as JsonValue,
          });
          return { dispatch_id: dispatchId, task_id: task.id, events: dispatchEvents, violations, bridge_result: bridgeResult };
        }
        for (const eff of actionObs.irreversibleEffects) {
          emitEvent(db, {
            kind: "irreversible_effect_recorded",
            substrate_origin: "substrate_auto",
            directive_id: task.directive_id,
            task_id: task.id,
            action_artifact_id: actionArtifact.id,
            context_refs: [ownerConsentEventId],
            payload: { kind: eff.kind, description: eff.description, owner_consent_event_id: ownerConsentEventId } as JsonValue,
          });
        }
        // After emitting the irreversible rows, evaluate retirement —
        // chronic irreversible violators (≥ 3 in 24h) transition to
        // terminal `retired` status. Owner-consent events ARE recorded
        // on the irreversible row, so consented effects are NOT counted
        // toward retirement (countRecentIrreversibleWithoutConsent
        // skips rows whose payload carries owner_consent_event_id).
        maybeRetire(db, actionArtifact.id, (ev) => {
          emitEvent(db, {
            ...ev,
            directive_id: ev.directive_id ?? task.directive_id,
            task_id: ev.task_id ?? task.id,
          });
        });
      }

      if (!actionObs.ok) {
        // Brain sandbox audit bsfxsvgh9 (2026-05-15): feed the kill
        // counter when the action observation indicates a hard kill or
        // sandbox-violation error. recordArtifactKill increments
        // recent_kill_count and runs maybeQuarantine + maybeRetire so
        // chronic offenders transition to terminal `retired` status.
        // Sandbox unenforced warnings are NOT counted — they're
        // capability-gap signals, not artifact misconduct.
        const errStr = String(actionObs.error ?? "");
        const isHardKill = errStr.includes("hard_killed") || errStr.includes("hard_kill") || actionObs.exitCode === -1 * (process.platform === "linux" ? 9 : 9);
        const isSandboxViolation = errStr.includes("sandbox_violation");
        if (isHardKill || isSandboxViolation) {
          recordArtifactKill(db, actionArtifact.id, (ev) => {
            emitEvent(db, {
              ...ev,
              directive_id: ev.directive_id ?? task.directive_id,
              task_id: ev.task_id ?? task.id,
            });
          }, isHardKill ? "subprocess_hard_killed" : "sandbox_violation");
        }
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
            runtimeUnavailable: (actionObs as { runtimeUnavailable?: Record<string, unknown> }).runtimeUnavailable ?? null,
            breakdown: { runtime_unavailable: (actionObs as { runtimeUnavailable?: Record<string, unknown> }).runtimeUnavailable ? 1 : 0 },
            reliability_profile: (actionObs as { runtimeUnavailable?: Record<string, unknown> }).runtimeUnavailable ? { runtime_unavailable: (actionObs as { runtimeUnavailable?: Record<string, unknown> }).runtimeUnavailable } : null,
            dispatch_decision: dispatchDecisionEvidence,
            routing_axes: decision.routing_axes,
            route_scores: decision.route_scores,
            dispatch_verifier_evidence: decision.verifier_evidence,
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
        } catch (err) {
          logger.warn(
            { where: "task_dispatcher.credit.no_verifier", task_id: task.id, err: (err as Error).message },
            "distributeCredit failed (no-verifier branch) — falling back to direct posterior",
          );
          applyResidualOutcome(db, actionArtifact.id, 1, nowIso());
        }
      } else {
        // Run the verifier on the observation. F6 completion (decision 11):
        // wrap the invocation in invokeVerifierWithMeta so the verifier_handle
        // itself earns or loses posterior independently of the action it scored.
        const verifierObs = await invokeVerifierWithMeta(db, {
          verifierHandle: verifierArtifact.id,
          inputs: actionObs.result as JsonValue,
          directiveId: task.directive_id,
          taskId: task.id,
          sourceEventId: actionPredicted.id,
          citedArtifactIds: [verifierArtifact.id],
          invoke: () => runArtifact({
            artifactId: verifierArtifact.id,
            body: verifierArtifact.body,
            declaredSandbox: verifierSandbox,
            inputs: actionObs.result as JsonValue,
            emit: (ev) => {
              emitEvent(db, {
                ...ev,
                directive_id: ev.directive_id ?? task.directive_id,
                task_id: ev.task_id ?? task.id,
                invoker: ev.invoker ?? "substrate_auto",
              });
            },
          }),
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
            runtimeUnavailable: (actionObs as { runtimeUnavailable?: Record<string, unknown> }).runtimeUnavailable ?? null,
            verifier_result: verifierObs.result ?? null,
            outcome_dimensions: verifierObs.result && typeof verifierObs.result === "object" && !Array.isArray(verifierObs.result)
              ? ((verifierObs.result as Record<string, unknown>).outcome_dimensions ?? (verifierObs.result as Record<string, unknown>).breakdown ?? null)
              : null,
            reliability_profile: verifierObs.result && typeof verifierObs.result === "object" && !Array.isArray(verifierObs.result)
              ? ((verifierObs.result as Record<string, unknown>).reliability_profile ?? null)
              : null,
            dispatch_decision: dispatchDecisionEvidence,
            routing_axes: decision.routing_axes,
            route_scores: decision.route_scores,
            dispatch_verifier_evidence: decision.verifier_evidence,
          } as JsonValue,
        });

        if (residual >= COMMIT_RESIDUAL_THRESHOLD) {
          emitEvent(db, {
            kind: "verifier_residual_high",
            substrate_origin: "substrate_auto",
            directive_id: task.directive_id,
            task_id: task.id,
            action_artifact_id: actionArtifact.id,
            verifier_artifact_id: verifierArtifact.id,
            residual,
            payload: {
              residual,
              verifier_kind: verifierArtifact.kind ?? verifierArtifact.name ?? "artifact_verifier",
              threshold: COMMIT_RESIDUAL_THRESHOLD,
              action_scored_event_id: scored.id,
            } as JsonValue,
          });
        }

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
        } catch (err) {
          // Fail-safe: keep posterior accounting honest even if credit fails.
          logger.warn(
            { where: "task_dispatcher.credit.verifier_branch", task_id: task.id, residual, err: (err as Error).message },
            "distributeCredit failed (verifier branch) — falling back to direct posterior",
          );
          applyResidualOutcome(db, actionArtifact.id, residual, nowIso());
          applyResidualOutcome(db, verifierArtifact.id, residual, nowIso());
        }

        // 6a. PROPOSAL GROUNDING GATE — structural check before commit.
        // Brain audit CBKDWYRN2N08V9ESTCKCNF210M identified missing
        // substrate-side validation at the commit boundary as the root
        // cause of seven session frictions: unregistered event kinds,
        // Gate-deletion (owner-approved 2026-05-16, audit finding #1):
        // validateProposalGrounding (event_kind / anchor / CLI / deliverable
        // checks) refused to commit semantic work because of structural
        // pre-checks the residual + breakdown already score. Removed; the
        // universal verifier (residual ∈ [0,1] + open-ended breakdown) is
        // the truth-bearer. Bad proposals get demoted via posterior, not
        // refused at commit time.

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
              // Optional open-ended axis vector emitted by verifiers that can
              // decompose success beyond the scalar residual. Unknown keys are
              // retained for retrieval/credit and ignored by strict consumers.
              outcome_dimensions: verifierObs.result && typeof verifierObs.result === "object" && !Array.isArray(verifierObs.result)
                ? ((verifierObs.result as Record<string, unknown>).outcome_dimensions ?? (verifierObs.result as Record<string, unknown>).breakdown ?? null)
                : null,
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
          // Inline recipe extraction: the FIRST successful commit for a
          // (goal_shape, topology_signature) pair seeds a Tier-0 recipe at
          // confidence=1.0 so the dispatcher's recipe_replay route can
          // catch the next dispatch with the same shape without waiting
          // for OwnerAutonomy / the rolling reviewer to fire the 3-success
          // statistical extractor. Idempotent: re-firing on the same
          // composite key is a no-op. Errors surfaced as error_caught
          // (recoverable) — recipe seeding failing must not derail the
          // committed dispatch.
          try {
            extractRecipeFromCommit(db, task.id);
          } catch (err) {
            logger.warn(
              { where: "task_dispatcher.extractRecipeFromCommit", task_id: task.id, err: (err as Error).message },
              "extractRecipeFromCommit failed — surfaced as error_caught",
            );
            try {
              emitEvent(db, {
                kind: "error_caught",
                substrate_origin: "substrate_auto",
                directive_id: task.directive_id,
                task_id: task.id,
                payload: {
                  where: "task_dispatcher.extractRecipeFromCommit",
                  recoverable: true,
                  message: (err as Error).message,
                } as JsonValue,
              });
            } catch { /* db likely closed */ }
          }
        } else {
          // High-residual path — emit a refinement edge + new task_node_opened
          // for the refinement child, OR cap-fail if we've exhausted depth.
          // Complex research follow-up: when sibling fanout crosses
          // TREE_SEARCH_FANOUT_THRESHOLD, route through a substrate-owned
          // tree-search scorer instead of only extending a linear chain.
          const depth = refinementDepth(db, task.id);
          // Plateau early-stop (brain amendment ZH75YT9MV95RNC9DQV6FN1AW0C,
          // rerun b23eiv4yt → directive HZGZGDPGJ96..., 2026-05-16): when
          // 3 consecutive refinement cycles in this lineage haven't improved
          // closure_residual by more than 0.03, stop refining and commit the
          // current cycle's residual as plateau_early_stop instead of
          // continuing to the depth cap. Catches "iterating in circles"
          // earlier than REFINEMENT_DEPTH_CAP=5 would.
          const plateauCycles = 3;
          const plateauEpsilon = 0.03;
          // Unbounded read scan over the events table (all task_edge_recorded
          // rows for the directive) on the refinement path — route off the main
          // loop. Same db/SQL/params → identical rows/order; sync fallback when
          // no pool is installed.
          const edgeRows = await poolQuery<{ payload: string }>(
            db,
            "SELECT payload FROM events WHERE directive_id = ? AND kind = 'task_edge_recorded' ORDER BY ts ASC",
            [task.directive_id],
          );
          const incomingRefines = new Map<string, string>();
          for (const row of edgeRows) {
            try {
              const payload = JSON.parse(row.payload ?? "{}") as Record<string, unknown>;
              if (payload.kind === "refines" && typeof payload.from_task === "string" && typeof payload.to_task === "string") {
                incomingRefines.set(payload.to_task, payload.from_task);
              }
            } catch { /* malformed edge payload: ignore for plateau detection */ }
          }
          const lineageTaskIds = new Set<string>([task.id]);
          for (let cur = task.id; incomingRefines.has(cur);) {
            cur = incomingRefines.get(cur)!;
            if (lineageTaskIds.has(cur)) break;
            lineageTaskIds.add(cur);
          }
          // F11 (2026-05-18, contract 2AMJKN0GTX32790173EPYH6YT4): the
          // plateau detector now uses the current-root-scoped closure
          // selector. Pre-F11 it scanned EVERY task_closure_audited row
          // on the directive (ORDER BY ts ASC) and filtered by lineage —
          // which silently included audits emitted before the most
          // recent directive_amended / root supersession. Lesson
          // 7JE565S6016T showed those stale residuals could flatten the
          // delta and trigger plateau_early_stop on a fresh trajectory.
          // closureResidualsForLineage applies the
          // latest_root_supersession_ts cutoff so only audits emitted
          // under the CURRENT root window participate.
          const closureResiduals = closureResidualsForLineage(db, task.directive_id, lineageTaskIds);
          const recentClosureResiduals = closureResiduals.slice(-plateauCycles);
          const plateauEarlyStop = recentClosureResiduals.length >= plateauCycles &&
            recentClosureResiduals.slice(1).every((value, index) => recentClosureResiduals[index]! - value <= plateauEpsilon);
          if (plateauEarlyStop) {
            const closureResidual = recentClosureResiduals.at(-1)!;
            emitEvent(db, {
              kind: "task_committed",
              substrate_origin: "substrate_auto",
              directive_id: task.directive_id,
              task_id: task.id,
              outcome: "succeeded",
              residual: closureResidual,
              payload: {
                dispatch_id: dispatchId,
                reason: "plateau_early_stop",
                closure_residual: closureResidual,
                plateau_cycles: plateauCycles,
                plateau_epsilon: plateauEpsilon,
                recent_closure_residuals: recentClosureResiduals,
                refinement_depth: depth,
                action_artifact_id: actionArtifact.id,
                verifier_artifact_id: verifierArtifact.id,
              } as JsonValue,
            });
          } else if (depth >= REFINEMENT_DEPTH_CAP) {
            emitEvent(db, {
              kind: "refinement_depth_exceeded",
              substrate_origin: "substrate_auto",
              directive_id: task.directive_id,
              task_id: task.id,
              residual,
              payload: {
                depth,
                cap: REFINEMENT_DEPTH_CAP,
                residual,
                dispatch_id: dispatchId,
              } as JsonValue,
            });
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
                // FOUNDATIONAL: payload.reason so renderers + classifiers
                // surface a readable cause instead of "reason=?". Audit
                // 2026-05-17 — the acc tail renderer reads p.reason; pre-
                // fix this event landed with no reason field.
                reason: `refinement_depth_exceeded:depth=${depth} cap=${REFINEMENT_DEPTH_CAP} residual=${residual.toFixed(2)}`,
              } as JsonValue,
            });
          } else {
            const refinedTaskId = newId();
            const deliverableRefinementSuffix = deliverableGroundbase
              ? ` DELIVERABLE REFINEMENT CONTRACT: use current_best_artifact_id=${deliverableGroundbase.currentBestArtifactId ?? "(none)"} as the base; preserve the locked outline and every previously satisfied requirement; change only the verifier-identified delta; emit the successor artifact with supersedes=${deliverableGroundbase.currentBestArtifactId ?? "(none)"}.`
              : "";
            const refinementHint =
              `refine: previous attempt returned residual ${residual.toFixed(2)} on goal "${task.goal}" — ` +
              `investigate why and adjust action/verifier (refinement depth=${depth + 1}).` +
              deliverableRefinementSuffix;
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
            const refinementEdge = emitEvent(db, {
              kind: "task_edge_recorded",
              substrate_origin: "substrate_auto",
              directive_id: task.directive_id,
              task_id: refinedTaskId,
              parent_task_id: task.id,
              payload: {
                from_task: task.id,
                to_task: refinedTaskId,
                kind: "refines",
                ...(deliverableGroundbase ? {
                  refinement_semantics: "deliverable_compounding_v1",
                  base_artifact_id: deliverableGroundbase.currentBestArtifactId ?? null,
                  groundbase_artifact_id: deliverableGroundbase.groundbaseArtifactId,
                  locked_outline_present: deliverableGroundbase.lockedOutline.length > 0,
                  requirements_count: deliverableGroundbase.requirementsLedger.length,
                  preserve_previously_satisfied_requirements: true,
                  change_scope: "targeted_delta_only",
                } : {}),
              } as JsonValue,
            });
            // F6 — universal internal Act scoring. The dispatcher just
            // decided to open a refinement edge instead of failing or
            // committing. The residual delta after the refined task
            // closes will score whether opening the edge was the right
            // choice (low delta means refinement helped).
            recordInternalAct(db, {
              intent: "open refinement edge",
              actionHandle: "refinement_edge_opener_v1",
              verifierHandle: "residual_delta_after_refine",
              verifierKind: "deterministic_code",
              predictedResidual: residual,
              reasoningSummary: `prior residual ${residual.toFixed(2)} >= threshold; opened depth ${depth + 1} refinement`,
              actionSummary: `task_edge_recorded refines -> ${refinedTaskId}`,
              effectSummary: `scheduler now has a refined task to run`,
              directiveId: task.directive_id,
              taskId: refinedTaskId,
              sourceEventId: refinementEdge.id,
              sourceActId: "refinement_edge_opener_v1:" + task.id + ":" + (depth + 1),
              extra: {
                from_task: task.id,
                to_task: refinedTaskId,
                refinement_depth: depth + 1,
                prior_residual: residual,
              },
            });
          }
        }
      }
    }
  }

  // 7. brain_dispatch_closed seals the audit trail.
  const finalEvents = await readEventsSinceTs(db, dispatchStartedTs, task.id);
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
  //
  // FOUNDATIONAL FIX 2026-05-18: closedEvents was previously declared
  // inside the metrics try-block, so the cascade block below threw
  // ReferenceError ('closedEvents is not defined') every time
  // dispatchHadTerminal was true. The thrown error was caught by the
  // surrounding warn-logger but the cascade never ran — every committed
  // root left its refinement children in ready_tasks_view, the scheduler
  // re-dispatched them on the next tick, and the daemon climbed to
  // 99% CPU + 3.4GB RSS over ~2 hours. Hoisting the declaration outside
  // the try block fixes both the cascade AND the runaway resource use.
  let dispatchHadTerminal = false;
  let closedEvents: Awaited<ReturnType<typeof readEventsSinceTs>> = [];
  try {
    closedEvents = await readEventsSinceTs(db, dispatchStartedTs, task.id);
    const hasCommit = closedEvents.some((e) => e.kind === "task_committed");
    const hasFail = closedEvents.some((e) => e.kind === "task_failed");
    dispatchHadTerminal = hasCommit || hasFail;
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
  } catch { /* swallow — metrics are best-effort; closedEvents stays [] if the read failed */ }

  // Batch-2 directive closure: if a terminal event fired on this task,
  // check whether the whole directive is now done and emit
  // directive_closed idempotently. This closes the zombie-loop class
  // (scheduler kept re-dispatching tasks for finished directives).
  if (dispatchHadTerminal) {
    // Root commits are guarded at the emit boundary: a root with descendants
    // needs a current clean closure audit and every descendant already
    // terminal. Dangling descendants remain live for scheduler re-drive or
    // escalation instead of being fabricated as successful.
    // Upward cascade: if the brain committed only a child (e.g. MEASURE
    // verifier) without sealing the root, walk up the refines edges and
    // auto-commit parents whose every child is now terminal. Pairs with
    // the removed root-to-child cascade, this only handles
    // bottom-up completion after all children are terminal.
    try {
      const cascadedUp = cascadeUpwardWhenChildrenTerminal(db, task.id);
      if (cascadedUp > 0) {
        logger.info(
          { where: "task_dispatcher.cascade_upward", task_id: task.id, cascaded_up: cascadedUp },
          "cascaded task_committed upward — parents auto-committed because all children terminal",
        );
      }
    } catch (err) {
      logger.warn(
        { where: "task_dispatcher.cascade_upward", task_id: task.id, err: (err as Error).message },
        "cascadeUpwardWhenChildrenTerminal failed — parent task may remain in ready_tasks_view",
      );
    }
    try {
      maybeCloseFinishedDirective(db, task.directive_id);
    } catch (err) {
      logger.warn(
        { where: "task_dispatcher.maybe_close_finished_directive", directive_id: task.directive_id, err: (err as Error).message },
        "maybeCloseFinishedDirective failed — directive_closed not emitted (will retry on next terminal event)",
      );
    }
  }

  return {
    dispatch_id: dispatchId,
    task_id: task.id,
    events: await readEventsSinceTs(db, dispatchStartedTs, task.id),
    violations,
    bridge_result: bridgeResult,
  };
};

// Re-export readEventsForDispatch only because tests may want it; the helper
// is internal otherwise.
export { readEventsForDispatch };
