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

/** Subscription metadata used for memory-bounding. `session_id` ties a
 *  subscriber to an MCP session identity so a session teardown can drop its
 *  SSE controllers; `lastActiveMs` lets the reaper evict idle/dead
 *  controllers (a crashed SSE client that never unsubscribed). */
type Subscription = {
  fn: BusSubscriber;
  session_id?: string;
  lastActiveMs: number;
};

const subscribers = new Map<BusSubscriber, Subscription>();

/** Hard cap on concurrent subscribers — a flood of dead SSE controllers
 *  (clients that disconnect without the unsubscribe firing) is exactly the
 *  unbounded-accumulation leak this fix closes. When exceeded, the oldest
 *  (least-recently-active) subscriber is evicted first. Universal value
 *  (ACC2_EVENT_BUS_MAX_SUBSCRIBERS overrides). */
export const EVENT_BUS_MAX_SUBSCRIBERS = (() => {
  const raw = Number(process.env.ACC2_EVENT_BUS_MAX_SUBSCRIBERS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 512;
})();

/** Idle eviction window — a subscriber that has not received a successful
 *  delivery in this long is treated as dead and reaped. Universal value
 *  (ACC2_EVENT_BUS_IDLE_MS overrides). */
export const EVENT_BUS_IDLE_MS = (() => {
  const raw = Number(process.env.ACC2_EVENT_BUS_IDLE_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 10 * 60_000;
})();

const evictOldest = (): void => {
  // Map preserves insertion order; the first key is the oldest registration.
  // We refine by lastActiveMs so a recently-active old subscriber is spared.
  let victim: BusSubscriber | undefined;
  let victimActive = Infinity;
  for (const [fn, sub] of subscribers) {
    if (sub.lastActiveMs < victimActive) {
      victimActive = sub.lastActiveMs;
      victim = fn;
    }
  }
  if (victim) subscribers.delete(victim);
};

/** Register a subscriber. Returns an unsubscribe function. Multiple
 *  subscribers can coexist (one per SSE client, one per test, …).
 *  `opts.session_id` ties the subscriber to an MCP session identity so a
 *  session teardown can drop its controllers via `unsubscribeSession`. */
export const subscribe = (
  fn: BusSubscriber,
  opts?: { session_id?: string },
): (() => void) => {
  subscribers.set(fn, { fn, session_id: opts?.session_id, lastActiveMs: Date.now() });
  if (subscribers.size > EVENT_BUS_MAX_SUBSCRIBERS) evictOldest();
  return () => { subscribers.delete(fn); };
};

/** Drop every subscriber tied to one MCP session identity. Called from the
 *  MCP session reaper / teardown so a dead session cannot leave SSE
 *  controllers accumulating on the bus. Returns the count dropped. */
export const unsubscribeSession = (session_id: string): number => {
  let dropped = 0;
  for (const [fn, sub] of subscribers) {
    if (sub.session_id === session_id) {
      subscribers.delete(fn);
      dropped++;
    }
  }
  return dropped;
};

/** Reap subscribers idle longer than `idleMs` (defaults to EVENT_BUS_IDLE_MS).
 *  A delivery failure already drops the subscriber inline; this catches the
 *  case where a controller silently stops consuming without throwing. Returns
 *  the count reaped. */
export const reapIdleSubscribers = (nowMs?: number, idleMs?: number): number => {
  const now = nowMs ?? Date.now();
  const window = idleMs ?? EVENT_BUS_IDLE_MS;
  let reaped = 0;
  for (const [fn, sub] of subscribers) {
    if (now - sub.lastActiveMs > window) {
      subscribers.delete(fn);
      reaped++;
    }
  }
  return reaped;
};

/** Current subscriber count — surfaced in /health so operators can see SSE
 *  controller accumulation building between probes. */
export const eventBusSubscriberCount = (): number => subscribers.size;

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
  const snapshot = Array.from(subscribers.values());
  const now = Date.now();
  for (const sub of snapshot) {
    try {
      sub.fn(event);
      sub.lastActiveMs = now;
    } catch {
      subscribers.delete(sub.fn);
    }
  }
};

