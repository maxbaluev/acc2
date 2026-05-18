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
import type { Event, JsonValue } from "../substrate/types";
import { emitEvent } from "./events";
import { newId } from "./ids";
import { composePrompt } from "./prompt_composer";
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
  cascadeRootCommitToDescendants,
  cascadeUpwardWhenChildrenTerminal,
  maybeCloseFinishedDirective,
} from "./directive_closure";
import { readCurrentMode } from "./crisis_mode";
import { isCycleViolation } from "./cycle_one_gate";
import { recordDispatch, recordActionResidual } from "./metrics";
import { extractRecipeFromCommit } from "../substrate/extractors";

const REFINEMENT_DEPTH_CAP = 5;
const TREE_SEARCH_FANOUT_THRESHOLD = 5;

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
  const decision = decideDispatch(db, task);
  const dispatchDecisionEvidence = dispatchEvidencePayload(decision);
  emitEvent(db, {
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

    const replayRunArtifact = deps.runArtifact
      ? async (replayDb: Database, artifactId: string, inputs: JsonValue) => {
          const artifact = getArtifact(replayDb, artifactId);
          if (!artifact) {
            return { ok: false, result: null, error: "artifact_not_found:" + artifactId };
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
      retrievedKnowledge = await retrieve(db, deps.index, {
        text: task.goal ?? task.directive_id,
        k: 8,
        kindFilter: ["knowledge_candidate", "knowledge_promoted", "knowledge_synthesized"],
        goalText: task.goal,
      });
      // Organism-alignment audit b3qc9ryzj #4 (2026-05-15): retrieve
      // task-similar code artifacts too — the registry has a reranked
      // prompt path but pre-fix the dispatcher only fed it posterior-
      // sorted results (artifact_routing_view), not task-similarity
      // aware. Now the brain's CODE ARTIFACT REGISTRY prompt section
      // gets cosine × posterior × origin reranked artifacts.
      try {
        retrievedArtifacts = await retrieve(db, deps.index, {
          text: task.goal ?? task.directive_id,
          k: 6,
          kindFilter: ["code_artifact_candidate", "code_artifact_admitted", "code_artifact_promoted"],
          goalText: task.goal,
        });
        if (retrievedArtifacts.query_embedding_unavailable) retrievedArtifacts = null;
      } catch { retrievedArtifacts = null; }
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
  const composer = await resolveComposePrompt();
  const composed = composer(db, { taskId: task.id, retrievedKnowledge, retrievedArtifacts, retrievalUnavailable });
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
            if (alreadyCommitted) {
              timeoutRecoveryOutcome = "already_committed";
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
    if (actionArtifact && verifierArtifact) {
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

      const actionObs = await runArtifact({
        artifactId: actionArtifact.id,
        body: actionArtifact.body,
        declaredSandbox: actionArtifact.declaredSandbox,
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
        // Run the verifier on the observation.
        const verifierObs = await runArtifact({
          artifactId: verifierArtifact.id,
          body: verifierArtifact.body,
          declaredSandbox: verifierArtifact.declaredSandbox,
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
          // for Father / the rolling reviewer to fire the 3-success
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
          const edgeRows = db
            .query("SELECT payload FROM events WHERE directive_id = ? AND kind = 'task_edge_recorded' ORDER BY ts ASC")
            .all(task.directive_id) as Array<{ payload: string }>;
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
          const auditRows = db
            .query("SELECT task_id, payload FROM events WHERE directive_id = ? AND kind = 'task_closure_audited' ORDER BY ts ASC")
            .all(task.directive_id) as Array<{ task_id: string; payload: string }>;
          const closureResiduals = auditRows.flatMap((row) => {
            if (!lineageTaskIds.has(row.task_id)) return [];
            try {
              const payload = JSON.parse(row.payload ?? "{}") as Record<string, unknown>;
              return typeof payload.closure_residual === "number" ? [payload.closure_residual] : [];
            } catch {
              return [];
            }
          });
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
              outcome: "committed",
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
  let closedEvents: ReturnType<typeof readEventsSinceTs> = [];
  try {
    closedEvents = readEventsSinceTs(db, dispatchStartedTs, task.id);
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
    // Orphan-children fix (2026-05-15): when the brain commits a directive's
    // ROOT task (the closure_residual<0.3 audit covers all sub-goals), its
    // refinement children are often left in `ready_tasks_view` with no
    // terminal event. They get re-dispatched on the next scheduler tick,
    // bridge-fail with timeout, and burn tokens on work the root already
    // completed. Cascade-emit `task_committed` for every dangling descendant
    // BEFORE the close check so maybeCloseFinishedDirective finds them all
    // terminal and the directive actually closes.
    try {
      const committedRow = closedEvents.find((e) => e.kind === "task_committed" && e.task_id === task.id);
      if (committedRow) {
        const payload = committedRow.payload as { closure_residual?: number } | null;
        const cascaded = cascadeRootCommitToDescendants(
          db,
          task.id,
          payload?.closure_residual,
        );
        if (cascaded > 0) {
          logger.info(
            { where: "task_dispatcher.cascade_root_commit", root_task_id: task.id, cascaded },
            "cascaded task_committed to dangling descendants of committed root",
          );
        }
      }
    } catch (err) {
      logger.warn(
        { where: "task_dispatcher.cascade_root_commit", task_id: task.id, err: (err as Error).message },
        "cascadeRootCommitToDescendants failed — descendants may remain in ready_tasks_view",
      );
    }
    // Upward cascade: if the brain committed only a child (e.g. MEASURE
    // verifier) without sealing the root, walk up the refines edges and
    // auto-commit parents whose every child is now terminal. Pairs with
    // cascadeRootCommitToDescendants — together they handle both
    // top-down and bottom-up partial commits the brain might emit.
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
    events: readEventsSinceTs(db, dispatchStartedTs, task.id),
    violations,
    bridge_result: bridgeResult,
  };
};

// Re-export readEventsForDispatch only because tests may want it; the helper
// is internal otherwise.
export { readEventsForDispatch };
