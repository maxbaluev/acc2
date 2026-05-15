// acc2 in-process activation bus (brain elegance bc8je5f3x, 2026-05-15).
//
// Reactivity primitive: when emitEvent successfully inserts a row into
// the events table, publish the event to in-process subscribers so
// workers can wake up immediately instead of waiting for their next
// poll tick. The substrate stays authoritative (the DB row is the
// canonical state; the bus is just a notification channel), so a
// missed notification (e.g. cross-process daemon → CLI) is recovered
// by the existing polling fallback.
//
// Pre-fix the scheduler polled every 250ms-1s and the supervisor every
// 30s. A fresh directive_opened event sat for up to 1s before dispatch
// began; a task_committed sat for up to 30s before the DAG cascade
// noticed. With the activation bus, those workers wake within ~1ms of
// the row hitting the ledger; the polling interval becomes a
// fallback max-timeout rather than the primary latency.
//
// Design constraints:
//   1. Pure in-process — no IPC, no network. Subscribers in the same
//      bun runtime as emitEvent see notifications; CLI subprocesses do
//      not. CLI surfaces continue to use SSE / /events/stream as their
//      reactivity surface.
//   2. Fire-and-forget — emitEvent does not block on subscriber work.
//      Slow subscribers can't backpressure the ledger.
//   3. Errors in subscribers are caught + logged, never propagated to
//      emitEvent's caller. Subscriber crashes don't break event flow.
//   4. Wildcard "*" subscribers receive every published event for
//      meta-observers (telemetry, debugging).

import type { EventKind } from "../substrate/event_kinds";
import { logger } from "./logger";

export type ActivationPayload = {
  event_id: string;
  ts: string;
  kind: EventKind;
  directive_id?: string;
  task_id?: string;
};

export type ActivationListener = (payload: ActivationPayload) => void | Promise<void>;

const listeners = new Map<EventKind | "*", Set<ActivationListener>>();

/** Subscribe to a specific event kind (or "*" for all). Returns a
 *  disposer that removes the listener. Listeners are called
 *  fire-and-forget — never await their work. */
export const onEvent = (
  kind: EventKind | "*",
  listener: ActivationListener,
): (() => void) => {
  let set = listeners.get(kind);
  if (!set) {
    set = new Set();
    listeners.set(kind, set);
  }
  set.add(listener);
  return () => {
    const s = listeners.get(kind);
    if (!s) return;
    s.delete(listener);
    if (s.size === 0) listeners.delete(kind);
  };
};

/** Publish an event to every subscriber for its kind plus every "*"
 *  subscriber. Called by emitEvent after the DB insert succeeds.
 *  Never throws. */
export const publishActivation = (payload: ActivationPayload): void => {
  const kindListeners = listeners.get(payload.kind);
  const wildcardListeners = listeners.get("*");
  const all: ActivationListener[] = [];
  if (kindListeners) for (const l of kindListeners) all.push(l);
  if (wildcardListeners) for (const l of wildcardListeners) all.push(l);
  if (all.length === 0) return;
  for (const l of all) {
    try {
      const result = l(payload);
      if (result && typeof (result as Promise<void>).then === "function") {
        (result as Promise<void>).catch((err) => {
          logger.debug(
            { where: "activation_bus.async_listener", kind: payload.kind, err: String(err) },
            "activation listener async error (swallowed)",
          );
        });
      }
    } catch (err) {
      logger.debug(
        { where: "activation_bus.sync_listener", kind: payload.kind, err: String(err) },
        "activation listener sync error (swallowed)",
      );
    }
  }
};

/** Build a Promise that resolves when ANY of the supplied event kinds
 *  is published. Auto-disposes the listener on resolve. Useful for
 *  scheduler-style loops that want `Promise.race([poll_timeout,
 *  activation_for(['directive_opened', 'task_node_opened'])])`. */
export const waitForActivation = (
  kinds: ReadonlyArray<EventKind>,
  signal?: AbortSignal,
): Promise<ActivationPayload | null> => {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(null);
      return;
    }
    const disposers: Array<() => void> = [];
    let resolved = false;
    const cleanup = (): void => {
      for (const d of disposers) {
        try { d(); } catch { /* swallow */ }
      }
      disposers.length = 0;
    };
    const onAbort = (): void => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(null);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    for (const k of kinds) {
      const dispose = onEvent(k, (payload) => {
        if (resolved) return;
        resolved = true;
        signal?.removeEventListener("abort", onAbort);
        cleanup();
        resolve(payload);
      });
      disposers.push(dispose);
    }
  });
};

/** Test/diagnostic surface: clear every subscriber. Tests use this
 *  between cases so leak-detection doesn't accumulate listeners. */
export const clearAllActivationListeners = (): void => {
  listeners.clear();
};

/** Count of currently-registered subscribers across all kinds.
 *  Useful in /health-style surfaces to confirm workers wired the bus. */
export const activationListenerCount = (): number => {
  let total = 0;
  for (const set of listeners.values()) total += set.size;
  return total;
};
