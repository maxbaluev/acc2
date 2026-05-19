// acc2 event emission helper — single INSERT path so daemon, MCP, ingress,
// and tests all write rows the same way. Mirrors the Event type shape from
// substrate/types.ts but accepts a partial; we fill required slots with
// sane defaults (loop_id falls back to "loop_root" before the DAG layer
// is wired in Phase D).

import type { Database } from "bun:sqlite";
import type { Event, EventKind, JsonValue, SubstrateOrigin } from "../substrate/types";
import { EVENT_KINDS, getCurrentEventKinds } from "../substrate/event_kinds";
import { newId, nowIso } from "./ids";
import { publishEvent } from "./event_bus";
import { publishActivation } from "./activation_bus";
import { recordEventEmission } from "./metrics";
import { screenCodeArtifactCandidate } from "./artifact_candidate_screen";

export type EmitEventInput = {
  kind: EventKind;
  substrate_origin?: SubstrateOrigin;
  directive_id?: string;
  task_id?: string;
  parent_task_id?: string | null;
  loop_id?: string;
  payload?: JsonValue;
  context_refs?: string[];
  predicted_residual?: number;
  action_artifact_id?: string;
  verifier_artifact_id?: string;
  outcome?: Event["outcome"];
  residual?: number;
  payload_hash?: string;
  blob_ref?: string;
  failure_kind?: Event["failure_kind"];
  invoker?: SubstrateOrigin;
  /** Internal recursion guard for substrate-side source-event projectors. */
  projectActTuple?: boolean;
  /** Raw float32 little-endian bytes of the embedding vector. The events
   *  table BLOB column accepts this directly. Set ONLY by the embedder
   *  worker — most call sites leave it undefined. */
  embedding?: Uint8Array;
  /** Embedding model/version stamp. Stored alongside the BLOB so the
   *  reranker can exclude mixed-version sets (v2-design §19 risk 16). */
  embedding_version?: string;
};

export type EmittedEvent = { id: string; ts: string };

type JsonObject = { [k: string]: JsonValue };

type NormalizedActTuple = {
  intent: string;
  reasoning_summary: string;
  effect_summary: string;
  verifier_kind: string;
  predicted_residual: number;
  observed_residual: number;
  action_artifact_id: string;
  verifier_artifact_id: string;
  outcome: Event["outcome"];
  source_act_id?: string;
  cited_knowledge_ids: string[];
  cited_artifact_ids: string[];
  affected_resources: string[];
  candidate_event_ids: string[];
  co_actors: string[];
  owner_observed_outcome?: JsonValue;
};

const isObject = (value: JsonValue | undefined): value is JsonObject =>
  !!value && typeof value === "object" && !Array.isArray(value);

const hasStructuredFailureClassification = (payload: JsonObject | null): boolean => {
  if (!payload) return false;
  if (typeof payload.failure_kind === "string" && payload.failure_kind.trim().length > 0) return true;
  const source = payload.classification_source;
  return !!source && typeof source === "object" && !Array.isArray(source);
};

const normalizeTaskFailedPayload = (input: EmitEventInput): { payload: JsonValue; failure_kind?: string } => {
  const payload = isObject(input.payload) ? input.payload : {};
  const explicitFailureKind = input.failure_kind ?? (typeof payload.failure_kind === "string" && payload.failure_kind.trim().length > 0
    ? payload.failure_kind.trim()
    : undefined);
  if (explicitFailureKind || hasStructuredFailureClassification(payload)) {
    return { payload, failure_kind: explicitFailureKind };
  }
  return {
    payload: {
      ...payload,
      classification_source: {
        source: "runtime.emitEvent",
        basis: "task_failed_without_emitter_failure_kind",
        note: "Emitter did not provide a failure_kind; classification remains open-ended and should be refined by the producing runtime.",
      },
    },
  };
};

/** Closure-audit normalization (parallel to task_failed). When the brain
 *  emits task_closure_audited without a numeric closure_residual, the
 *  TUI renders `closure_residual=undefined` which is meaningless — and
 *  downstream credit/scoring code coerces undefined→NaN. Inject a
 *  classification_source marker so the substrate retains the provenance
 *  while the renderer + downstream consumers can detect "unmeasured"
 *  vs "measured zero". */
const normalizeClosureAuditPayload = (input: EmitEventInput): JsonValue => {
  const payload = isObject(input.payload) ? input.payload : {};
  const residual = payload.closure_residual;
  const hasNumericResidual = typeof residual === "number" && Number.isFinite(residual);
  const hasSource = !!payload.classification_source && typeof payload.classification_source === "object";
  if (hasNumericResidual || hasSource) return payload;
  return {
    ...payload,
    classification_source: {
      source: "runtime.emitEvent",
      basis: "task_closure_audited_without_numeric_residual",
      note: "Emitter did not provide a numeric closure_residual; the closure verifier should refine this. Renderers should treat residual as <unset>.",
    },
  };
};

/** Lesson-extracted normalization. Same shape as task_failed: when
 *  lesson_kind is missing, surface it as a classification_source so the
 *  tail/observability layer doesn't render `lesson_kind=?` (which the
 *  operator reads as "the substrate doesn't know what kind of lesson
 *  this is"). The producing brain or worker should refine. */
const normalizeLessonExtractedPayload = (input: EmitEventInput): JsonValue => {
  const payload = isObject(input.payload) ? input.payload : {};
  const lessonKind = payload.lesson_kind;
  const hasKind = typeof lessonKind === "string" && lessonKind.trim().length > 0;
  const hasSource = !!payload.classification_source && typeof payload.classification_source === "object";
  if (hasKind || hasSource) return payload;
  return {
    ...payload,
    classification_source: {
      source: "runtime.emitEvent",
      basis: "lesson_extracted_without_lesson_kind",
      note: "Emitter did not provide a lesson_kind; classification remains open-ended and should be refined by the producing runtime.",
    },
  };
};

const projectionKey = (sourceActId: string, projectionKind: string, targetIdOrRole: string): string =>
  sourceActId + ":" + projectionKind + ":" + targetIdOrRole;

const existingProjection = (db: Database, kind: EventKind, key: string): EmittedEvent | null => {
  const row = db
    .query<{ id: string; ts: string }, [string, string]>(
      "SELECT id, ts FROM events WHERE kind = ? AND json_extract(payload, '$.projection_key') = ? ORDER BY ts ASC LIMIT 1",
    )
    .get(kind, key);
  return row ? { id: row.id, ts: row.ts } : null;
};

const emitProjectedEvent = (
  db: Database,
  sourceActId: string,
  projectionKind: string,
  targetIdOrRole: string,
  input: EmitEventInput,
): EmittedEvent => {
  const key = projectionKey(sourceActId, projectionKind, targetIdOrRole);
  const existing = existingProjection(db, input.kind, key);
  if (existing) return existing;
  const payload = isObject(input.payload) ? input.payload : {};
  return emitEvent(db, {
    ...input,
    payload: {
      ...payload,
      projection_key: key,
    },
  });
};

const requireString = (payload: JsonObject, key: string): string => {
  const value = payload[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("invalid_act_tuple_recorded:" + key + "_required");
  }
  return value;
};

const optionalStringArray = (payload: JsonObject, key: string): string[] => {
  const value = payload[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error("invalid_act_tuple_recorded:" + key + "_must_be_string_array");
  }
  // Runtime check above narrows every element to a non-empty string,
  // but TypeScript can't carry the narrowing through Array's structural
  // type. Cast is safe — every escape path throws.
  return value as string[];
};

const requireResidual = (value: unknown, key: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("invalid_act_tuple_recorded:" + key + "_must_be_number_0_1");
  }
  return value;
};

const normalizeActTuple = (input: EmitEventInput): NormalizedActTuple => {
  if (!isObject(input.payload)) throw new Error("invalid_act_tuple_recorded:payload_object_required");
  const payload = input.payload;
  const predicted = requireResidual(input.predicted_residual ?? payload.predicted_residual, "predicted_residual");
  const observed = requireResidual(input.residual ?? payload.observed_residual ?? payload.residual, "observed_residual");
  const actionArtifact = input.action_artifact_id ?? (typeof payload.action_artifact_id === "string" ? payload.action_artifact_id : undefined);
  const verifierArtifact = input.verifier_artifact_id ?? (typeof payload.verifier_artifact_id === "string" ? payload.verifier_artifact_id : undefined);
  if (!actionArtifact) throw new Error("invalid_act_tuple_recorded:action_artifact_id_required");
  if (!verifierArtifact) throw new Error("invalid_act_tuple_recorded:verifier_artifact_id_required");
  const outcome = input.outcome ?? (observed < 0.3 ? "succeeded" : "failed");
  if (outcome !== "succeeded" && outcome !== "failed" && outcome !== "pending" && outcome !== "abandoned" && outcome !== "rolling_active" && outcome !== "amended") {
    throw new Error("invalid_act_tuple_recorded:outcome_invalid");
  }
  const logicalSourceActId = typeof payload.source_act_id === "string" && payload.source_act_id.trim().length > 0
    ? payload.source_act_id.trim()
    : undefined;
  return {
    intent: requireString(payload, "intent"),
    reasoning_summary: requireString(payload, "reasoning_summary"),
    effect_summary: requireString(payload, "effect_summary"),
    verifier_kind: requireString(payload, "verifier_kind"),
    predicted_residual: predicted,
    observed_residual: observed,
    action_artifact_id: actionArtifact,
    verifier_artifact_id: verifierArtifact,
    outcome,
    source_act_id: logicalSourceActId,
    cited_knowledge_ids: optionalStringArray(payload, "cited_knowledge_ids"),
    cited_artifact_ids: optionalStringArray(payload, "cited_artifact_ids"),
    affected_resources: optionalStringArray(payload, "affected_resources"),
    candidate_event_ids: optionalStringArray(payload, "candidate_event_ids"),
    co_actors: optionalStringArray(payload, "co_actors"),
    owner_observed_outcome: payload.owner_observed_outcome,
  };
};

const projectActTupleRecorded = (db: Database, source: {
  id: string;
  directive_id: string;
  task_id: string;
  parent_task_id: string | null;
  loop_id: string;
  context_refs: string[];
  act: NormalizedActTuple;
}): { predicted: EmittedEvent; scored: EmittedEvent } => {
  const sourceActId = source.act.source_act_id ?? source.id;
  const sourceEventId = source.id;
  const sourceRefs = sourceActId === sourceEventId ? [sourceEventId] : [sourceEventId, sourceActId];
  const base = {
    directive_id: source.directive_id,
    task_id: source.task_id,
    parent_task_id: source.parent_task_id,
    loop_id: source.loop_id,
    substrate_origin: "substrate_auto" as const,
    projectActTuple: false,
  };
  const bindings: EmittedEvent[] = [];
  for (const [role, ids] of [
    ["knowledge", source.act.cited_knowledge_ids],
    ["artifact", source.act.cited_artifact_ids],
  ] as const) {
    for (let rank = 0; rank < ids.length; rank++) {
      const targetId = ids[rank]!;
      bindings.push(emitProjectedEvent(db, sourceActId, "retrieval_binding", role + ":" + targetId, {
        ...base,
        kind: "retrieval_binding",
        context_refs: [...sourceRefs, targetId],
        payload: {
          source_act_id: sourceActId,
          source_act_event_id: sourceEventId,
          projected_from: "act_tuple_recorded",
          ...(role === "knowledge" ? { source_event_id: targetId } : { source_artifact_id: targetId }),
          rank,
          binding_surface: "act_tuple_projection",
          co_actors: source.act.co_actors,
          cited_role: role,
        },
      }));
    }
  }
  const projectedContext = [...sourceRefs, ...bindings.map((binding) => binding.id), ...source.context_refs];
  const predicted = emitProjectedEvent(db, sourceActId, "action_predicted", "primary", {
    ...base,
    kind: "action_predicted",
    action_artifact_id: source.act.action_artifact_id,
    verifier_artifact_id: source.act.verifier_artifact_id,
    predicted_residual: source.act.predicted_residual,
    context_refs: projectedContext,
    payload: {
      source_act_id: sourceActId,
      source_act_event_id: sourceEventId,
      projected_from: "act_tuple_recorded",
      intent: source.act.intent,
      reasoning_summary: source.act.reasoning_summary,
      effect_summary: source.act.effect_summary,
      verifier_kind: source.act.verifier_kind,
      cited_knowledge_ids: source.act.cited_knowledge_ids,
      cited_artifact_ids: source.act.cited_artifact_ids,
      co_actors: source.act.co_actors,
      affected_resources: source.act.affected_resources,
    },
  });
  const scored = emitProjectedEvent(db, sourceActId, "action_scored", "primary", {
    ...base,
    kind: "action_scored",
    action_artifact_id: source.act.action_artifact_id,
    verifier_artifact_id: source.act.verifier_artifact_id,
    predicted_residual: source.act.predicted_residual,
    residual: source.act.observed_residual,
    outcome: source.act.outcome,
    context_refs: [...sourceRefs, predicted.id, ...source.context_refs],
    payload: {
      source_act_id: sourceActId,
      source_act_event_id: sourceEventId,
      action_predicted_event_id: predicted.id,
      projected_from: "act_tuple_recorded",
      verifier_kind: source.act.verifier_kind,
      co_actors: source.act.co_actors,
      residual: source.act.observed_residual,
      // OutcomeStatus | undefined → coerce to null. JsonValue forbids
      // undefined; passing it through would silently omit the field
      // from JSON.stringify and break audit-trail completeness.
      outcome: source.act.outcome ?? null,
    },
  });
  const confirmationTargets = source.act.candidate_event_ids.length > 0
    ? source.act.candidate_event_ids.map((candidateId) => ({ candidateId, projectionTarget: candidateId }))
    : [{ candidateId: sourceEventId, projectionTarget: "source" }];
  for (const { candidateId, projectionTarget } of confirmationTargets) {
    emitProjectedEvent(db, sourceActId, "candidate_confirmed", projectionTarget, {
      ...base,
      kind: "candidate_confirmed",
      context_refs: [candidateId, ...sourceRefs, scored.id],
      payload: {
        source_act_id: sourceActId,
        source_act_event_id: sourceEventId,
        action_scored_event_id: scored.id,
        projected_from: "act_tuple_recorded",
        reason: "act_tuple_lifecycle_projection",
      },
    });
  }
  // Phantom-apply gate: skip applied_change_committed projection when
  // the source act is the bridge-cycle EXIT boundary, not a real
  // mutation. Pre-fix every opencode brain cycle wrote an
  // applied_change_committed event with summary="bridge_completed
  // final_response_chars=N" and affected_resources=[] — operator
  // dashboards saw "Δ✓ applied" on every brain cycle while working
  // tree never moved, and substrate audit envelopes were vacuous (cite
  // KC H3PXSDV32X47: auto_apply worker writes phantom rows; this is
  // the substrate-side closure). The discriminator is precise:
  // bridge-exit acts use the fixed artifact-id pair
  // (opencode_brain_exit_action, opencode_bridge_exit_verifier).
  // Legitimate non-mutation acts (owner-credit, observation, research)
  // with empty affected_resources still project — they aren't bridge
  // closures.
  const isBridgeExitAct = source.act.action_artifact_id === "opencode_brain_exit_action"
    && source.act.verifier_artifact_id === "opencode_bridge_exit_verifier";
  if (!isBridgeExitAct) emitProjectedEvent(db, sourceActId, "applied_change_committed", "primary", {
    ...base,
    kind: "applied_change_committed",
    action_artifact_id: source.act.action_artifact_id,
    verifier_artifact_id: source.act.verifier_artifact_id,
    predicted_residual: source.act.predicted_residual,
    residual: source.act.observed_residual,
    outcome: source.act.outcome,
    context_refs: [...sourceRefs, predicted.id, scored.id, ...source.context_refs],
    payload: {
      source_act_id: sourceActId,
      source_act_event_id: sourceEventId,
      action_predicted_event_id: predicted.id,
      action_scored_event_id: scored.id,
      projected_from: "act_tuple_recorded",
      status: source.act.outcome === "succeeded" ? "applied" : "failed",
      source_kind: "act_tuple_recorded",
      summary: source.act.effect_summary,
      co_actors: source.act.co_actors,
      affected_resources: source.act.affected_resources,
    },
  });
  if (source.act.owner_observed_outcome !== undefined) {
    emitProjectedEvent(db, sourceActId, "owner_observed_outcome_recorded", "primary", {
      ...base,
      kind: "owner_observed_outcome_recorded",
      residual: source.act.observed_residual,
      outcome: source.act.outcome,
      context_refs: [...sourceRefs, scored.id],
      payload: {
        source_act_id: sourceActId,
        source_act_event_id: sourceEventId,
        action_scored_event_id: scored.id,
        projected_from: "act_tuple_recorded",
        observed_outcome: source.act.owner_observed_outcome,
      },
    });
  }
  return { predicted, scored };
};
/** Insert a single event row and return its id + timestamp. The caller owns
 *  selecting `substrate_origin` — daemon events use `substrate_auto`, MCP
 *  RPC events tag the actual invoker, external-push tags `owner` etc. */
export const emitEvent = (db: Database, input: EmitEventInput): EmittedEvent => {
  // Brain convergence audit boxbz1d1q axis I (2026-05-15): the substrate.emit
  // MCP handler rejects unknown event kinds at the wire boundary, but
  // daemon-side workers writing through this helper could persist any
  // string cast to EventKind. Apply the same gate so the rule is uniform
  // — typos in worker code surface as a thrown error instead of silently
  // landing in the ledger and bypassing embedding / health-metric / view
  // routing.
  //
  // Test bypass: the test suite uses synthetic `*_test_*` kinds (catalogued
  // in substrate/event_kinds.test.ts TEST_ONLY_KINDS) to exercise the bus
  // surface without polluting the production registry. We accept those
  // under the convention plus the explicit ACC2_BRIDGE_MODE=mock env that
  // tests/preload.ts pins. Production daemon (no env, no `*_test_*` kind)
  // gets the strict gate.
  // Hot-reload (2026-05-17): consult the live cachedKinds map through
  // getCurrentEventKinds() so kinds registered after a substrate/event_kinds.ts
  // swap (via runtime/reloadable.ts) become valid without a daemon restart.
  // Importing EVENT_KINDS captures the value at module-load time; that
  // binding cannot be updated, but getCurrentEventKinds() reads the
  // mutable cache the reloadable slot swaps.
  if (!(input.kind in getCurrentEventKinds())) {
    const isTestKind = typeof input.kind === "string" && input.kind.includes("_test_");
    const isTestMode = process.env.ACC2_BRIDGE_MODE === "mock" || process.env.NODE_ENV === "test";
    if (!isTestKind && !isTestMode) {
      throw new Error(
        `unknown_event_kind:${input.kind}; register it in substrate/event_kinds.ts EVENT_KINDS before emitting`,
      );
    }
  }
  // SINGLE-TERMINAL-PER-TASK GATE (FOUNDATIONAL FIX 2026-05-17):
  // Live ledger evidence — task A5G7ZPNQV13634WX received BOTH task_committed
  // (from brain via MCP) at 03:36:51 AND task_failed (from dispatcher
  // refinement-depth-cap via direct emitEvent) at 03:36:57. Two competing
  // terminal events for the same task is a substrate-integrity violation:
  // dispatch_resolved_view classification, closure scoring, credit
  // distribution, and supervisor logic all assume at most one terminal
  // per task. The gate refuses the SECOND terminal emit when a first is
  // already in the ledger. First-wins semantics — whichever code path
  // reached the substrate first claims the outcome; subsequent emits get
  // a structured refusal (thrown, since this is a substrate invariant).
  const actTuple = input.kind === "act_tuple_recorded" ? normalizeActTuple(input) : null;

  const projectionPayload = isObject(input.payload) ? input.payload : null;
  const inputProjectionKey = typeof projectionPayload?.projection_key === "string" ? projectionPayload.projection_key : null;
  if (inputProjectionKey) {
    const existing = existingProjection(db, input.kind, inputProjectionKey);
    if (existing) return existing;
  }
  if (input.kind === "task_committed" || input.kind === "task_failed") {
    if (input.task_id) {
      const existing = db
        .query<{ kind: string; id: string }, [string]>(
          `SELECT id, kind FROM events
           WHERE task_id = ? AND kind IN ('task_committed', 'task_failed')
           ORDER BY ts ASC LIMIT 1`,
        )
        .get(input.task_id);
      if (existing) {
        // Idempotent re-emit of the SAME terminal kind is allowed (returns
        // the existing event's id+ts so callers' downstream wiring still
        // resolves). Conflicting terminal (other kind) is REFUSED to
        // preserve the substrate invariant.
        if (existing.kind === input.kind) {
          const existingTs = db
            .query<{ ts: string }, [string]>(`SELECT ts FROM events WHERE id = ?`)
            .get(existing.id);
          return { id: existing.id, ts: existingTs?.ts ?? "" };
        }
        // Test bypass: same env discipline as the kind gate above so
        // existing test fixtures that intentionally emit conflicting
        // terminals (testing edge-case classifiers) still work.
        const isTestMode = process.env.ACC2_BRIDGE_MODE === "mock" || process.env.NODE_ENV === "test";
        if (!isTestMode) {
          throw new Error(
            `terminal_event_conflict:task=${input.task_id};existing=${existing.kind} (id=${existing.id});refused_emit=${input.kind};hint=a task can have at most one terminal event. First-wins semantics — the existing ${existing.kind} stands. If the dispatcher/worker emitting this competing terminal needs to record a non-terminal observation (e.g. refinement-depth concern, late-arriving residual), use a non-terminal kind like dispatcher_violation or knowledge_candidate instead.`,
          );
        }
      }
    }
  }
  const id = newId();
  const ts = nowIso();
  const directive_id = input.directive_id ?? id; // self-rooted if not supplied
  const task_id = input.task_id ?? id;
  const loop_id = input.loop_id ?? "loop_root";
  const substrate_origin = input.substrate_origin ?? "substrate_auto";
  const taskFailure = input.kind === "task_failed" ? normalizeTaskFailedPayload(input) : null;
  // Closure-audit + lesson-extracted normalization run at the same
  // emit boundary so missing classifier fields surface as a structured
  // classification_source (NOT as renderer "undefined" / "?" — see
  // cli/observe.ts task_closure_audited + lesson_extracted renderers).
  const closurePayload = input.kind === "task_closure_audited" ? normalizeClosureAuditPayload(input) : null;
  const lessonPayload = input.kind === "lesson_extracted" ? normalizeLessonExtractedPayload(input) : null;
  const eventPayload = taskFailure?.payload
    ?? closurePayload
    ?? lessonPayload
    ?? input.payload
    ?? {};
  const eventFailureKind = taskFailure?.failure_kind ?? input.failure_kind;
  const payload = JSON.stringify(eventPayload);
  const context_refs = JSON.stringify(input.context_refs ?? []);

  db.run(
    `INSERT INTO events (
       id, ts, directive_id, task_id, parent_task_id, loop_id,
       substrate_origin, kind, payload, context_refs,
       predicted_residual, action_artifact_id, verifier_artifact_id,
       outcome, residual, embedding, embedding_version,
       payload_hash, blob_ref, failure_kind, invoker
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, ts, directive_id, task_id, input.parent_task_id ?? null, loop_id,
      substrate_origin, input.kind, payload, context_refs,
      input.predicted_residual ?? null,
      input.action_artifact_id ?? null,
      input.verifier_artifact_id ?? null,
      input.outcome ?? null,
      input.residual ?? null,
      input.embedding ?? null,
      input.embedding_version ?? null,
      input.payload_hash ?? null,
      input.blob_ref ?? null,
      eventFailureKind ?? null,
      input.invoker ?? null,
    ],
  );
  // Phase 1.β: broadcast to the in-process bus so SSE subscribers and tests
  // see the event without polling SQLite. The bus catches subscriber errors
  // so this is fail-soft.
  // FOUNDATIONAL FIX 2026-05-17: include the top-level act-loop columns
  // (action_artifact_id, verifier_artifact_id, predicted_residual, outcome,
  // residual, failure_kind, invoker, parent_task_id, loop_id) so SSE
  // consumers see the full event shape. Pre-fix the bus omitted these,
  // and the acc tail renderer showed "action=— verifier=—" for every
  // action_predicted because the bus frame had no act-loop fields to read.
  publishEvent({
    event_id: id,
    kind: input.kind,
    ts,
    directive_id,
    task_id,
    substrate_origin,
    payload: eventPayload as JsonValue,
    invoker: input.invoker ?? null,
    parent_task_id: input.parent_task_id ?? null,
    loop_id: input.loop_id ?? null,
    action_artifact_id: input.action_artifact_id ?? null,
    verifier_artifact_id: input.verifier_artifact_id ?? null,
    predicted_residual: input.predicted_residual ?? null,
    outcome: input.outcome ?? null,
    residual: input.residual ?? null,
    failure_kind: eventFailureKind ?? null,
  });
  // Brain elegance bc8je5f3x (2026-05-15): also publish to the activation
  // bus so workers awaiting specific event kinds wake immediately
  // instead of polling. Polling remains the safety-net fallback.
  publishActivation({
    event_id: id,
    kind: input.kind,
    ts,
    directive_id,
    task_id,
    // Auto-share-knowledge (2026-05-16): propagate payload so subscribers
    // can act on content mid-flight (knowledge propagation worker, cross-
    // terminal mirror, in-flight brain dispatches).
    payload: eventPayload as JsonValue,
  });
  // Batch 3.OPS: Prometheus counter — one increment per kind. Fail-soft
  // so a metrics misconfiguration cannot block emission. The kind is the
  // only context we need; full err goes to the logger so audits can spot
  // a metrics provider misconfiguration.
  try {
    recordEventEmission(input.kind);
  } catch (err) {
    // Lazy-import to keep the hot path free of the logger import cycle.
    void err;
  }
  if (actTuple && input.projectActTuple !== false) {
    const projection = projectActTupleRecorded(db, {
      id,
      directive_id,
      task_id,
      parent_task_id: input.parent_task_id ?? null,
      loop_id,
      context_refs: input.context_refs ?? [],
      act: actTuple,
    });
    // Close the projected act's credit tail through the canonical Shapley
    // distributor. emitEvent stays synchronous; posterior refresh is
    // best-effort and idempotent via source_act_id projection keys.
    void import("./credit").then(({ distributeCredit }) => distributeCredit(db, {
      action_event_id: projection.predicted.id,
      observation_event_id: projection.scored.id,
      scored_event_id: projection.scored.id,
      predicted_residual: actTuple.predicted_residual,
      observed_residual: actTuple.observed_residual,
    })).catch(() => { /* credit retry can be driven from projected rows */ });
  }
  if (input.kind === "owner_observed_outcome_recorded") {
    void import("./credit").then(({ distributeOwnerObservedOutcomeCredit }) => distributeOwnerObservedOutcomeCredit(db, id)).catch(() => {
      /* owner-observed credit retry can be driven from the ledger row */
    });
  }
  // F6 — universal internal Act scoring for closure audit verdicts.
  // task_closure_audited is a substrate-internal verdict (the closure
  // verifier judged whether the directive met its goal). Record it
  // as an act_tuple so the owner-observed completeness signal that
  // arrives later (or the contradicting failure that arrives if the
  // verdict was wrong) credits the closure verifier posterior.
  if (input.kind === "task_closure_audited") {
    try {
      const payload = isObject(input.payload) ? input.payload : {};
      const closureResidual = typeof payload.closure_residual === "number" && Number.isFinite(payload.closure_residual)
        ? payload.closure_residual
        : 0.5;
      const verdict = typeof payload.verdict === "string" ? payload.verdict : "audited";
      const { recordInternalAct } = require("./internal_act_projection") as typeof import("./internal_act_projection");
      recordInternalAct(db, {
        intent: "score closure verdict",
        actionHandle: "closure_verifier_v1",
        verifierHandle: "owner_observed_completeness",
        verifierKind: "deterministic_code",
        predictedResidual: closureResidual,
        reasoningSummary: `closure verdict=${verdict} residual=${closureResidual.toFixed(2)}`,
        actionSummary: `task_closure_audited emitted for task ${input.task_id ?? id}`,
        effectSummary: `closure verdict landed; commit-gate threshold reads residual`,
        directiveId: input.directive_id,
        taskId: input.task_id,
        sourceEventId: id,
        sourceActId: "closure_verifier_v1:" + (input.task_id ?? id),
        extra: {
          verdict,
          closure_residual: closureResidual,
        },
      });
    } catch { /* fail-soft: closure audit already landed */ }
  }
  // F6 extension — universal internal Act scoring for lesson
  // extraction. Each lesson_extracted row IS a bet: the substrate (or
  // brain, when it emits) is asserting "this pattern will help
  // prevent future failures of the same shape". The verifier
  // (future_failure_prevention_rate) closes the credit chain when
  // later closure audits / owner-observed outcomes either confirm or
  // contradict the prediction. One act per lesson emit is the right
  // scoping: lessons are individually retrievable and individually
  // citeable, so each one earns or loses posterior independently.
  if (input.kind === "lesson_extracted") {
    try {
      const payload = isObject(input.payload) ? input.payload : {};
      const summary = typeof payload.summary === "string" ? payload.summary : "lesson extracted";
      const lessonKind = typeof payload.kind === "string"
        ? payload.kind
        : (typeof payload.lesson_kind === "string" ? payload.lesson_kind : "general");
      const { recordInternalAct } = require("./internal_act_projection") as typeof import("./internal_act_projection");
      recordInternalAct(db, {
        intent: "extract reusable lesson",
        actionHandle: "lesson_extractor_v1",
        verifierHandle: "future_failure_prevention_rate",
        verifierKind: "deterministic_code",
        // Lessons are moderate-confidence bets — they generalize from
        // one trajectory and may not transfer cleanly. 0.4 mirrors the
        // F6 brief's predicted_residual for this decision class.
        predictedResidual: 0.4,
        reasoningSummary: `lesson_extracted kind=${lessonKind}`,
        actionSummary: `lesson_extracted emitted for task ${input.task_id ?? id}`,
        effectSummary: summary.length > 0 ? summary.slice(0, 200) : "lesson row landed on ledger",
        directiveId: input.directive_id,
        taskId: input.task_id,
        sourceEventId: id,
        // One act per lesson emit — projection key derives from the
        // lesson event id so re-emitting the same row collapses to
        // the same projection.
        sourceActId: "lesson_extractor_v1:" + id,
        extra: {
          lesson_kind: lessonKind,
          lesson_event_id: id,
        },
      });
    } catch { /* fail-soft: lesson_extracted already landed */ }
  }
  // F6 completion (decision 9) — entity model attribute write. Every
  // stakeholder_state_recorded row commits one declared_utility +
  // inferred_constraints + visibility tuple to the entity model; that
  // commitment is a substrate decision whose accuracy later evidence
  // either confirms or contradicts. recordEntityAttributeAct projects
  // the write as an act so subsequent_evidence_agreement closes the
  // credit chain when downstream observations either match or refute
  // the recorded value.
  if (input.kind === "stakeholder_state_recorded") {
    try {
      const payload = isObject(input.payload) ? input.payload : {};
      const entityId = typeof payload.stakeholder_id === "string" ? payload.stakeholder_id : (input.task_id ?? id);
      const { recordEntityAttributeAct } = require("./owner_entity_acts") as typeof import("./owner_entity_acts");
      recordEntityAttributeAct(db, {
        entityId,
        attributeName: "declared_utility",
        attributeValue: (payload.declared_utility ?? null) as JsonValue,
        sourceEventId: id,
        directiveId: input.directive_id,
        taskId: input.task_id,
        extra: {
          inferred_constraints: (payload.inferred_constraints ?? null) as JsonValue,
          information_visibility: (payload.information_visibility ?? null) as JsonValue,
        },
      });
    } catch { /* fail-soft: stakeholder row already landed */ }
  }
  // F6 completion (decision 10) — owner profile attribute write. The
  // adjudicator emits two related kinds: owner_insight_candidate
  // proposes a single field/value, owner_profile_recorded commits a
  // merged snapshot. We wire ONLY the snapshot here — the commit is
  // the actual attribute write. Candidates are intermediate proposals
  // whose own credit closes when the promoter either merges them into a
  // snapshot or rejects them; wiring the candidate kind at this boundary
  // would cascade act_tuple_recorded → applied_change_committed
  // projections back into the autonomy_adjuster's outcome window and
  // create a feedback loop (the adjuster reads applied_change_committed
  // to compute its delta, and a synthetic projection makes the loop
  // self-feeding). Direct call sites that propose a candidate from
  // owner-stated intent can still invoke recordOwnerProfileAttributeAct
  // explicitly; the emit boundary stays scoped to commits.
  if (input.kind === "owner_profile_recorded") {
    try {
      const payload = isObject(input.payload) ? input.payload : {};
      const source = typeof payload.promotion_route === "string"
        ? `promoter:${payload.promotion_route}`
        : "promoter";
      const { recordOwnerProfileAttributeAct } = require("./owner_entity_acts") as typeof import("./owner_entity_acts");
      recordOwnerProfileAttributeAct(db, {
        field: "*",
        value: payload as JsonValue,
        source,
        sourceEventId: id,
        directiveId: input.directive_id,
        taskId: input.task_id,
        extra: {
          owner_event_kind: input.kind,
        },
      });
    } catch { /* fail-soft: owner profile row already landed */ }
  }
  // RLM retrieval credit attribution (brain task FX9PZDQ3W932,
  // 2026-05-18). Every action_scored event walks its context_refs for
  // retrieval_binding rows and emits retrieval_credit_attributed per
  // binding so retrieval_credit_view.credit_attributed_count is
  // non-zero in production. Closes the 88ESCTN8XN6J always-on-consumer
  // gap for the new credit loop without a 5-min worker delay —
  // attribution is deterministic given the inputs, so we fire at the
  // write boundary (same pattern as distributeCredit for
  // act_tuple_recorded). Synchronous, idempotent via projection_key.
  if (input.kind === "action_scored") {
    try {
      void import("./retrieval_credit").then(({ attributeRetrievalCredit }) => {
        attributeRetrievalCredit(db, {
          scored_event_id: id,
          context_refs: input.context_refs ?? [],
          residual: input.residual,
          directive_id: input.directive_id,
          task_id: input.task_id,
        });
      }).catch(() => { /* swallow; can be re-driven from the action_scored row */ });
    } catch { /* defensive */ }
  }
  // Code-artifact-candidate emit-side screen (dark-gate observability,
  // 2026-05-18). The candidate row lands first so its id is stable; the
  // screen returns sibling refusal events (predicate_gate_rejected,
  // atms_strategy_first_violation, lane_routing_refused) that we then
  // emit synchronously with the candidate id in context_refs. The
  // candidate stays in the ledger so audit/replay see what was attempted;
  // the refusal events explain why downstream gates blocked it.
  if (input.kind === "act_artifact_candidate") {
    try {
      const { refusals } = screenCodeArtifactCandidate(db, {
        payload: input.payload,
        directive_id: input.directive_id,
        task_id: input.task_id,
      });
      for (const refusal of refusals) {
        const refusalEvent = emitEvent(db, {
          kind: refusal.kind,
          substrate_origin: "substrate_auto",
          directive_id: input.directive_id,
          task_id: input.task_id,
          context_refs: [id],
          payload: refusal.payload,
        });
        // F6 — universal internal Act scoring. Each refusal is an
        // internal substrate decision (the gate fired and refused
        // the candidate). Record it as an act_tuple so an owner
        // confirmation that the refusal was correct later credits
        // the gate's posterior. Verifier handle stays conceptual
        // until the downstream confirmation lands. Lazy-import to
        // avoid the events ↔ internal_act_projection cycle.
        try {
          const { recordInternalAct } = require("./internal_act_projection") as typeof import("./internal_act_projection");
          recordInternalAct(db, {
            intent: "trigger predicate gate refusal",
            actionHandle: "predicate_gate_v1",
            verifierHandle: "owner_refusal_confirmation",
            verifierKind: "deterministic_code",
            // Refusals are high-confidence by construction: the gate
            // matched a structural rule. Predicted residual stays
            // low until owner evidence contradicts the refusal.
            predictedResidual: 0.1,
            reasoningSummary: `gate refused candidate via ${refusal.kind}`,
            actionSummary: `emitted ${refusal.kind} citing candidate ${id}`,
            effectSummary: `gate refusal blocks candidate from downstream admission`,
            directiveId: input.directive_id,
            taskId: input.task_id,
            sourceEventId: refusalEvent.id,
            sourceActId: "predicate_gate_v1:" + id + ":" + refusal.kind,
            extra: {
              refusal_kind: refusal.kind,
              candidate_event_id: id,
            },
          });
        } catch { /* fail-soft: screen refusal already landed */ }
      }
    } catch (err) {
      // Screen failures must not poison the candidate emission. The
      // candidate row already landed; a dead screen is observable as
      // missing refusal rows on the next audit, not as a thrown emit.
      void err;
    }
  }
  return { id, ts };
};

/** Fetch one event by id, parsing the JSON payload + context_refs back to
 *  structured shape. Returns null if no row matches. */
export const getEventById = (db: Database, id: string): Event | null => {
  const row = db.query("SELECT * FROM events WHERE id = ?").get(id) as Record<string, unknown> | null;
  if (!row) return null;
  return {
    id: row.id as string,
    ts: row.ts as string,
    directive_id: row.directive_id as string,
    task_id: row.task_id as string,
    parent_task_id: (row.parent_task_id as string | null) ?? null,
    loop_id: row.loop_id as string,
    substrate_origin: row.substrate_origin as SubstrateOrigin,
    kind: row.kind as EventKind,
    payload: JSON.parse((row.payload as string) ?? "{}") as JsonValue,
    context_refs: JSON.parse((row.context_refs as string) ?? "[]") as string[],
    predicted_residual: (row.predicted_residual as number | null) ?? undefined,
    action_artifact_id: (row.action_artifact_id as string | null) ?? undefined,
    verifier_artifact_id: (row.verifier_artifact_id as string | null) ?? undefined,
    outcome: (row.outcome as Event["outcome"]) ?? undefined,
    residual: (row.residual as number | null) ?? undefined,
    payload_hash: (row.payload_hash as string | null) ?? undefined,
    blob_ref: (row.blob_ref as string | null) ?? undefined,
    failure_kind: (row.failure_kind as Event["failure_kind"]) ?? undefined,
    invoker: (row.invoker as SubstrateOrigin | null) ?? undefined,
  };
};
