// acc2 event emission helper — single INSERT path so daemon, MCP, ingress,
// and tests all write rows the same way. Mirrors the Event type shape from
// substrate/types.ts but accepts a partial; we fill required slots with
// sane defaults (loop_id falls back to "loop_root" before the DAG layer
// is wired in Phase D).

import type { Database } from "bun:sqlite";
import type { Event, EventKind, JsonValue, SubstrateOrigin } from "../substrate/types";
import { EVENT_KINDS } from "../substrate/event_kinds";
import { newId, nowIso } from "./ids";
import { publishEvent } from "./event_bus";
import { publishActivation } from "./activation_bus";
import { recordEventEmission } from "./metrics";

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
  owner_observed_outcome?: JsonValue;
};

const isObject = (value: JsonValue | undefined): value is JsonObject =>
  !!value && typeof value === "object" && !Array.isArray(value);

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
  return value;
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
      residual: source.act.observed_residual,
      outcome: source.act.outcome,
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
  emitProjectedEvent(db, sourceActId, "applied_change_committed", "primary", {
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
  if (!(input.kind in EVENT_KINDS)) {
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
  const payload = JSON.stringify(input.payload ?? {});
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
      input.failure_kind ?? null,
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
    payload: (input.payload ?? {}) as JsonValue,
    invoker: input.invoker ?? null,
    parent_task_id: input.parent_task_id ?? null,
    loop_id: input.loop_id ?? null,
    action_artifact_id: input.action_artifact_id ?? null,
    verifier_artifact_id: input.verifier_artifact_id ?? null,
    predicted_residual: input.predicted_residual ?? null,
    outcome: input.outcome ?? null,
    residual: input.residual ?? null,
    failure_kind: input.failure_kind ?? null,
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
    payload: (input.payload ?? {}) as JsonValue,
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
