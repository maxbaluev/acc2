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
  /** Declared interval (ms) per worker — set when the worker registers so
   *  the stuck threshold (3× interval) can be computed without consulting
   *  daemon-side env defaults from outside. */
  tickIntervalMs: Map<string, number>;
};

const createState = (): ReadinessState => ({
  registered: new Set(),
  ready: new Set(),
  readyAtMs: null,
  onReady: null,
  lastTickMs: new Map(),
  tickIntervalMs: new Map(),
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
 *  so /health can compute the "stuck after 3× interval" threshold. */
export const registerWorker = (name: string, tickIntervalMs?: number): void => {
  state.registered.add(name);
  if (typeof tickIntervalMs === "number" && tickIntervalMs > 0) {
    state.tickIntervalMs.set(name, tickIntervalMs);
  }
};

/** Record a successful tick for the given worker — drives /health degraded
 *  state. Idempotent: calling twice in the same ms is fine. Safe to call
 *  for workers that did not declare an interval (the stuck check just
 *  skips them). */
export const recordWorkerTick = (name: string, atMs: number = Date.now()): void => {
  state.lastTickMs.set(name, atMs);
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

/** Internal snapshot for tests / diagnostics. */
export const _snapshot = (): { registered: string[]; ready: string[]; readyAtMs: number | null } => ({
  registered: Array.from(state.registered),
  ready: Array.from(state.ready),
  readyAtMs: state.readyAtMs,
});
