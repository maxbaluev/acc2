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
  /** Raw float32 little-endian bytes of the embedding vector. The events
   *  table BLOB column accepts this directly. Set ONLY by the embedder
   *  worker — most call sites leave it undefined. */
  embedding?: Uint8Array;
  /** Embedding model/version stamp. Stored alongside the BLOB so the
   *  reranker can exclude mixed-version sets (v2-design §19 risk 16). */
  embedding_version?: string;
};

export type EmittedEvent = { id: string; ts: string };

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
  publishEvent({
    event_id: id,
    kind: input.kind,
    ts,
    directive_id,
    task_id,
    substrate_origin,
    payload: (input.payload ?? {}) as JsonValue,
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
