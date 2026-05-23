// acc2 in-process event bus — broadcasts daemon-side `emitEvent` calls to any
// registered subscriber. Used by the SSE `/events/stream` endpoint (and the
// `runtime.recent_events` MCP tool) so `acc watch` can see events as they
// land without polling SQLite.
//
// Design constraints (Architecture.md, §21):
//   - In-process only. The bus lives in the daemon's bun process; subscribers
//     are HTTP response controllers held by the auxiliary Bun.serve handler.
//   - Synchronous broadcast — every subscriber callback is invoked from inside
//     `publishEvent` (right after the SQL INSERT) so an SSE client never sees
//     a row that the substrate hasn't yet committed.
//   - One subscriber may throw without affecting siblings. We catch + drop
//     the bad subscriber so a crashed SSE controller can never block the
//     emit path.
//   - No persistence here — the events table is canonical. The bus is a fan
//     out, not a queue.
//
// Wiring: `runtime/events.ts:emitEvent` calls `publishEvent` after a
// successful INSERT. The daemon's auxiliary HTTP server registers an SSE
// subscriber per open `/events/stream` connection. Tests can register their
// own subscribers to inspect daemon-side emission without going over HTTP.

import type { Event, EventKind, JsonValue, SubstrateOrigin } from "../substrate/types";

/** A bus payload — the minimum fields an SSE client / TUI needs to render
 *  one event row. Mirrors the event-table shape but is shaped for emission,
 *  not for storage. Callers should NOT re-derive event rows from the bus —
 *  the events table is the source of truth.
 *  FOUNDATIONAL FIX 2026-05-17: includes the top-level act-loop columns
 *  (action_artifact_id, verifier_artifact_id, predicted_residual, outcome,
 *  residual, failure_kind, invoker, parent_task_id, loop_id) so SSE
 *  consumers (acc tail, acc watch TUI) see the same shape as the events
 *  table — pre-fix the renderer rendered "action=— verifier=—" for
 *  action_predicted because these columns never reached the bus. */
export type BusEvent = {
  event_id: string;
  kind: EventKind;
  ts: string;
  directive_id: string;
  task_id: string;
  substrate_origin: SubstrateOrigin;
  payload: JsonValue;
  invoker?: string | null;
  parent_task_id?: string | null;
  loop_id?: string | null;
  action_artifact_id?: string | null;
  verifier_artifact_id?: string | null;
  predicted_residual?: number | null;
  outcome?: string | null;
  residual?: number | null;
  failure_kind?: string | null;
};

export type BusSubscriber = (event: BusEvent) => void;

const subscribers = new Set<BusSubscriber>();

/** Register a subscriber. Returns an unsubscribe function. Multiple
 *  subscribers can coexist (one per SSE client, one per test, …). */
export const subscribe = (fn: BusSubscriber): (() => void) => {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
};

/** Drop every registered subscriber. Used by the daemon shutdown path and
 *  by tests that want a clean slate between cases. */
export const resetBus = (): void => {
  subscribers.clear();
};

/** Number of currently-registered subscribers. Tests use this to assert
 *  cleanup after a controller disconnects. */
export const subscriberCount = (): number => subscribers.size;

/** Publish one event to every subscriber. Misbehaving subscribers are
 *  caught and dropped so a crashed SSE controller cannot block the emit
 *  path. Called from `runtime/events.ts:emitEvent` immediately after the
 *  INSERT completes. */
export const publishEvent = (event: BusEvent): void => {
  if (subscribers.size === 0) return;
  // Snapshot so a subscriber that itself calls subscribe/unsubscribe during
  // its handler does not mutate the iterator under us.
  const snapshot = Array.from(subscribers);
  for (const fn of snapshot) {
    try { fn(event); } catch { subscribers.delete(fn); }
  }
};

/** Helper: convert a partial event (the shape emitEvent already has on
 *  hand) into a BusEvent. The events.ts helper calls this after its
 *  INSERT so the bus payload matches what `substrate.get_event` would
 *  return. */
export const toBusEvent = (row: {
  id: string;
  kind: EventKind;
  ts: string;
  directive_id: string;
  task_id: string;
  substrate_origin: SubstrateOrigin;
  payload: JsonValue;
  invoker?: string | null;
  parent_task_id?: string | null;
  loop_id?: string | null;
  action_artifact_id?: string | null;
  verifier_artifact_id?: string | null;
  predicted_residual?: number | null;
  outcome?: string | null;
  residual?: number | null;
  failure_kind?: string | null;
}): BusEvent => ({
  event_id: row.id,
  kind: row.kind,
  ts: row.ts,
  directive_id: row.directive_id,
  task_id: row.task_id,
  substrate_origin: row.substrate_origin,
  payload: row.payload,
  invoker: row.invoker ?? null,
  parent_task_id: row.parent_task_id ?? null,
  loop_id: row.loop_id ?? null,
  action_artifact_id: row.action_artifact_id ?? null,
  verifier_artifact_id: row.verifier_artifact_id ?? null,
  predicted_residual: row.predicted_residual ?? null,
  outcome: row.outcome ?? null,
  residual: row.residual ?? null,
  failure_kind: row.failure_kind ?? null,
});

/** Test convenience — synthesize a Bus event from a fully-shaped Event row
 *  (used by the recent-events MCP fallback). */
export const eventToBusEvent = (e: Event): BusEvent => ({
  event_id: e.id,
  kind: e.kind,
  ts: e.ts,
  directive_id: e.directive_id,
  task_id: e.task_id,
  substrate_origin: e.substrate_origin,
  payload: e.payload,
  invoker: (e as Event & { invoker?: string | null }).invoker ?? null,
  parent_task_id: (e as Event & { parent_task_id?: string | null }).parent_task_id ?? null,
  loop_id: (e as Event & { loop_id?: string | null }).loop_id ?? null,
  action_artifact_id: (e as Event & { action_artifact_id?: string | null }).action_artifact_id ?? null,
  verifier_artifact_id: (e as Event & { verifier_artifact_id?: string | null }).verifier_artifact_id ?? null,
  predicted_residual: (e as Event & { predicted_residual?: number | null }).predicted_residual ?? null,
  outcome: (e as Event & { outcome?: string | null }).outcome ?? null,
  residual: (e as Event & { residual?: number | null }).residual ?? null,
  failure_kind: (e as Event & { failure_kind?: string | null }).failure_kind ?? null,
});
