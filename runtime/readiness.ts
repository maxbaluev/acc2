// acc2 daemon readiness tracker — Kubernetes-style /ready gate.
//
// `/health` proves the process is alive and the aux port responds.
// `/ready` is stricter: it proves every enabled background worker has
// completed at least its first tick. The split mirrors k8s liveness vs
// readiness — operators wire load-balancers and autoscalers to /ready
// so a daemon that booted but hasn't finished embedder/amendment startup
// does not receive traffic.
//
// Workers register their existence at daemon-start with `register(name)`.
// Each worker calls `markReady(name)` after its FIRST tick completes
// successfully. `isReady()` returns true once every registered worker
// has marked itself ready. The first transition to ready fires the
// optional `onReady` callback (the daemon emits `daemon_ready` there).
//
// This module is fail-soft: re-registering an existing worker is a
// no-op; marking an unregistered worker prints a warning via logger
// but does not throw.

import { logger } from "./logger";

export type ReadinessState = {
  /** Names registered at daemon-start (one per enabled background worker). */
  registered: Set<string>;
  /** Names whose first tick has completed. */
  ready: Set<string>;
  /** Set when isReady() first returns true. */
  readyAtMs: number | null;
  /** Single-fire callback (emit daemon_ready event from the daemon). */
  onReady: (() => void) | null;
  /** Last successful-tick timestamp (ms since epoch) per worker — drives
   *  /health degraded-state detection. A worker that hasn't ticked in
   *  3× its declared interval is reported as stuck. */
  lastTickMs: Map<string, number>;
  /** Tier D D1: timestamp (ms) at which a worker's CURRENT tick started, IFF
   *  it has not yet completed. Cleared on completion (recordWorkerTick). A
   *  worker present here with (now - started) past threshold is STUCK-IN-
   *  FLIGHT — the case lastTickMs/stuckWorkers cannot see (a tick that began
   *  but never returned, e.g. the supervisor scanning 325K events for 33s).
   *  This is the heartbeat that names the spinning worker in one read. */
  tickStartedMs: Map<string, number>;
  /** Declared interval (ms) per worker — set when the worker registers so
   *  the stuck threshold (3× interval) can be computed without consulting
   *  daemon-side env defaults from outside. */
  tickIntervalMs: Map<string, number>;
  /** Workers that are activation-driven (reactive: tick when subscribed
   *  events fire, with the shared safety-net as upper-bound). Reactive
   *  workers are NOT subject to the heartbeat-deadline stuck check on an
   *  idle substrate — their "no ticks for N×interval" is HEALTHY idle, not
   *  a fault. The shared reactive safety net is the only true deadline
   *  (and it covers them collectively rather than per-worker). */
  reactive: Set<string>;
};

const createState = (): ReadinessState => ({
  registered: new Set(),
  ready: new Set(),
  readyAtMs: null,
  onReady: null,
  lastTickMs: new Map(),
  tickStartedMs: new Map(),
  tickIntervalMs: new Map(),
  reactive: new Set(),
});

let state: ReadinessState = createState();

/** Reset the readiness state. Called by daemon shutdown so a subsequent
 *  startDaemon in the same Bun process starts with a clean slate. */
export const resetReadiness = (): void => {
  state = createState();
};

/** Register a worker name. Idempotent. Must be called BEFORE the worker
 *  starts ticking (otherwise the first markReady would arrive against
 *  an unregistered slot). Optionally records the worker's tick interval
 *  so /health can compute the "stuck after 3× interval" threshold.
 *
 *  Timer-driven workers (genuine heartbeat: each tick MUST fire on its
 *  declared interval) should call this without `markReactive`.
 *  Activation-driven (reactive) workers should call `markWorkerReactive`
 *  AFTER subscribing — they tick when events fire, not on a heartbeat,
 *  so the per-worker stuck threshold no longer applies; the shared
 *  reactive safety net is the deadline that DOES apply (and is reported
 *  separately as the `reactive_safety_net` worker). */
export const registerWorker = (name: string, tickIntervalMs?: number): void => {
  state.registered.add(name);
  if (typeof tickIntervalMs === "number" && tickIntervalMs > 0) {
    state.tickIntervalMs.set(name, tickIntervalMs);
  }
};

/** Mark a worker as activation-driven (reactive). After this call the
 *  per-worker heartbeat-deadline stuck check is skipped for this worker:
 *  no events firing on an idle substrate is HEALTHY for a reactive
 *  worker, not stuck. The shared reactive safety net (registered as the
 *  `reactive_safety_net` worker) is the deadline that DOES apply across
 *  reactive workers collectively.
 *
 *  Idempotent. Calling for an unregistered worker is a no-op (the timer
 *  registration order in daemon.ts pairs registerWorker + this call). */
export const markWorkerReactive = (name: string): void => {
  state.reactive.add(name);
};

/** Record a successful tick for the given worker — drives /health degraded
 *  state. Idempotent: calling twice in the same ms is fine. Safe to call
 *  for workers that did not declare an interval (the stuck check just
 *  skips them). */
export const recordWorkerTick = (name: string, atMs: number = Date.now()): void => {
  state.lastTickMs.set(name, atMs);
  // Tick completed — clear the in-flight marker (Tier D D1).
  state.tickStartedMs.delete(name);
};

/** Tier D D1: mark a worker tick as STARTED (in-flight). Paired with
 *  recordWorkerTick (completion) which clears it. supervisedTick calls this
 *  the moment a tick body begins so a never-returning tick is observable. */
export const recordWorkerTickStart = (name: string, atMs: number = Date.now()): void => {
  state.tickStartedMs.set(name, atMs);
};

/** Tier D D1: clear ONLY the in-flight marker (does NOT set lastTickMs).
 *  Called in supervisedTick's finally so a tick that threw is no longer
 *  reported stuck-in-flight, without being falsely counted as a success. */
export const clearWorkerTickInFlight = (name: string): void => {
  state.tickStartedMs.delete(name);
};

/** Tier D D1: workers whose CURRENT tick started but has not completed for
 *  longer than `thresholdMs` (default 60s). This is the diagnosis the
 *  daemon lacked this session — a stuck/spinning worker tick is named in
 *  one read instead of blind restart-bisection. Returns the worker name +
 *  how long its tick has been in-flight. */
export const inFlightStuckWorkers = (
  thresholdMs = 60_000,
  nowMs: number = Date.now(),
): Array<{ worker: string; in_flight_ms: number }> => {
  const out: Array<{ worker: string; in_flight_ms: number }> = [];
  for (const [name, startedMs] of state.tickStartedMs) {
    const inFlight = nowMs - startedMs;
    if (inFlight > thresholdMs) out.push({ worker: name, in_flight_ms: inFlight });
  }
  return out.sort((a, b) => b.in_flight_ms - a.in_flight_ms);
};

/** Return any registered worker that has not ticked within 3× its declared
 *  interval. Workers without a declared interval (e.g. one-shot integrity
 *  check) are skipped. Returned `last_tick_ms_ago` is `null` for workers
 *  that have never ticked since boot. */
export const stuckWorkers = (
  nowMs: number = Date.now(),
): Array<{ worker: string; last_tick_ms_ago: number | null; tick_interval_ms: number }> => {
  const out: Array<{ worker: string; last_tick_ms_ago: number | null; tick_interval_ms: number }> = [];
  for (const name of state.registered) {
    // Reactive workers tick on event activation, not on a heartbeat — the
    // shared reactive safety net is their only true deadline (and is
    // reported as the `reactive_safety_net` worker when it stalls). Skip
    // per-worker stuck reporting for them; "no ticks on idle substrate"
    // is HEALTHY for reactive subscriptions.
    if (state.reactive.has(name)) continue;
    const interval = state.tickIntervalMs.get(name);
    if (!interval) continue;
    const last = state.lastTickMs.get(name);
    if (last === undefined) {
      // Never ticked since registration — only flag once the readiness flip
      // is past (i.e. the worker SHOULD have ticked by now).
      if (state.readyAtMs !== null && nowMs - state.readyAtMs > interval * 3) {
        out.push({ worker: name, last_tick_ms_ago: null, tick_interval_ms: interval });
      }
      continue;
    }
    const ago = nowMs - last;
    if (ago > interval * 3) {
      out.push({ worker: name, last_tick_ms_ago: ago, tick_interval_ms: interval });
    }
  }
  return out;
};

/** Mark a worker's first tick as complete. After every registered worker
 *  has been marked, the first call to `isReady()` returns true and any
 *  `onReady` callback fires exactly once. */
export const markWorkerReady = (name: string): void => {
  if (!state.registered.has(name)) {
    logger.warn({ worker: name }, "markWorkerReady called for unregistered worker");
    return;
  }
  if (state.ready.has(name)) return;
  state.ready.add(name);
  if (state.ready.size === state.registered.size && state.readyAtMs === null) {
    state.readyAtMs = Date.now();
    const cb = state.onReady;
    if (cb) {
      try { cb(); } catch (err) {
        logger.warn({ err: (err as Error).message }, "onReady callback threw");
      }
    }
  }
};

/** True when every registered worker has marked itself ready. */
export const isReady = (): boolean => {
  if (state.registered.size === 0) {
    // No workers registered yet → not ready. The daemon registers at
    // boot before any /ready probe can arrive.
    return false;
  }
  return state.ready.size === state.registered.size;
};

/** Names of registered workers that have NOT yet marked themselves
 *  ready. Used by /ready to populate the 503 response body. */
export const pendingWorkers = (): string[] => {
  const out: string[] = [];
  for (const name of state.registered) {
    if (!state.ready.has(name)) out.push(name);
  }
  return out;
};

/** Register the single-fire onReady callback. Called by the daemon at
 *  boot to emit `daemon_ready` the moment readiness flips. */
export const setOnReady = (cb: () => void): void => {
  state.onReady = cb;
  // If readiness already flipped before the callback was set (race in
  // tests), fire immediately.
  if (state.readyAtMs !== null) {
    try { cb(); } catch (err) {
      logger.warn({ err: (err as Error).message }, "onReady callback threw (deferred)");
    }
  }
};

/** Timestamp (ms since epoch) of the first transition to ready, or null
 *  if not yet ready. */
export const readyAt = (): number | null => state.readyAtMs;
