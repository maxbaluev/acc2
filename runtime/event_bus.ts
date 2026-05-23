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

import type { EventKind, JsonValue, SubstrateOrigin } from "../substrate/types";

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

