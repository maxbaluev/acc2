// acc2 readiness — stuck-worker detection.
//
// /health surfaces "degraded" with the stuck_workers array when any
// registered worker hasn't ticked in 3× its declared interval. These tests
// exercise the in-memory state machine directly so the gate is provable
// without spinning a daemon.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  isReady,
  markWorkerReady,
  recordWorkerTick,
  recordWorkerTickStart,
  clearWorkerTickInFlight,
  inFlightStuckWorkers,
  registerWorker,
  resetReadiness,
  setOnReady,
  stuckWorkers,
  recordReadAttemptStart,
  recordReadSuccess,
  recordReadFailure,
  readPathStatus,
  READ_PATH_STALE_MS,
  READ_PATH_LATENCY_MS,
} from "./readiness";

describe("readiness — stuckWorkers detection", () => {
  beforeEach(() => { resetReadiness(); });
  afterEach(() => { resetReadiness(); });

  test("returns empty array when no workers registered", () => {
    expect(stuckWorkers()).toEqual([]);
  });

  test("workers without declared interval are skipped", () => {
    registerWorker("scheduler");
    markWorkerReady("scheduler");
    // No interval → not eligible for stuck detection regardless of age.
    const fakeNow = Date.now() + 24 * 60 * 60 * 1000;
    expect(stuckWorkers(fakeNow)).toEqual([]);
  });

  test("worker that just ticked is not stuck", () => {
    registerWorker("amendment", 2000);
    markWorkerReady("amendment");
    recordWorkerTick("amendment");
    expect(stuckWorkers()).toEqual([]);
  });

  test("worker missing 3× its interval shows up as stuck with last_tick_ms_ago", () => {
    registerWorker("amendment", 2000);
    markWorkerReady("amendment");
    // Tick 10s ago — over 3× the 2s interval.
    const tenSecondsAgo = Date.now() - 10_000;
    recordWorkerTick("amendment", tenSecondsAgo);
    const stuck = stuckWorkers();
    expect(stuck.length).toBe(1);
    expect(stuck[0].worker).toBe("amendment");
    expect(stuck[0].tick_interval_ms).toBe(2000);
    expect(stuck[0].last_tick_ms_ago).toBeGreaterThanOrEqual(9_500);
  });

  test("worker that never ticked but is past readyAt + 3× interval is stuck (last_tick_ms_ago=null)", () => {
    registerWorker("amendment", 1000);
    // Flip readiness so the never-ticked branch can fire. The transition
    // happens when the last registered worker is marked ready.
    let onReadyCalled = false;
    setOnReady(() => { onReadyCalled = true; });
    markWorkerReady("amendment");
    expect(onReadyCalled).toBe(true);
    expect(isReady()).toBe(true);
    // Probe with a now well past readyAt + 3*1000.
    const stuck = stuckWorkers(Date.now() + 5_000);
    expect(stuck.length).toBe(1);
    expect(stuck[0].worker).toBe("amendment");
    expect(stuck[0].last_tick_ms_ago).toBeNull();
  });

  test("multiple workers, only laggards show up", () => {
    registerWorker("amendment", 1000);
    registerWorker("owner_autonomy", 60_000);
    markWorkerReady("amendment");
    markWorkerReady("owner_autonomy");
    recordWorkerTick("amendment");
    recordWorkerTick("owner_autonomy", Date.now() - 5 * 60_000); // 5min lag, way over 3*60s
    const stuck = stuckWorkers();
    expect(stuck.map((s) => s.worker)).toEqual(["owner_autonomy"]);
  });
});

describe("readiness — Tier D D1 in-flight stuck detection", () => {
  beforeEach(() => { resetReadiness(); });
  afterEach(() => { resetReadiness(); });

  test("names a worker whose tick started but never completed past threshold", () => {
    const now = Date.now();
    recordWorkerTickStart("supervisor", now - 90_000); // in-flight 90s
    recordWorkerTickStart("embedder", now - 5_000);     // in-flight 5s (ok)
    const stuck = inFlightStuckWorkers(60_000, now);
    expect(stuck.map((s) => s.worker)).toEqual(["supervisor"]);
    expect(stuck[0].in_flight_ms).toBeGreaterThanOrEqual(90_000);
  });

  test("recordWorkerTick (success) clears the in-flight marker", () => {
    const now = Date.now();
    recordWorkerTickStart("supervisor", now - 90_000);
    recordWorkerTick("supervisor");
    expect(inFlightStuckWorkers(60_000, now)).toEqual([]);
  });

  test("clearWorkerTickInFlight (failure path) clears without marking a tick", () => {
    const now = Date.now();
    recordWorkerTickStart("extractors", now - 120_000);
    clearWorkerTickInFlight("extractors");
    expect(inFlightStuckWorkers(60_000, now)).toEqual([]);
    // It must NOT count as a completed tick (lastTickMs untouched) — a
    // failed tick is neither stuck-in-flight nor falsely "ticked".
    registerWorker("extractors", 30_000);
    // (no recordWorkerTick was called, so stuckWorkers logic is unaffected)
  });
});

describe("readiness — READ-PATH starvation probe", () => {
  beforeEach(() => { resetReadiness(); });
  afterEach(() => { resetReadiness(); });

  test("quiet daemon with no read attempts is NOT starved", () => {
    expect(readPathStatus().starved).toBe(false);
    expect(readPathStatus().reason).toBeNull();
  });

  test("a healthy completed read keeps the read path not-starved", () => {
    recordReadAttemptStart();
    recordReadSuccess(5);
    const s = readPathStatus();
    expect(s.starved).toBe(false);
    expect(s.last_latency_ms).toBe(5);
    expect(s.in_flight_ms).toBeNull();
  });

  test("a read in flight longer than the latency ceiling is starved (meltdown shape)", () => {
    const now = Date.now();
    recordReadAttemptStart(now - (READ_PATH_LATENCY_MS + 5_000));
    // No success recorded — the view is hanging, exactly like the 10s
    // aux-read timeout during the hot-ledger meltdown.
    const s = readPathStatus(now);
    expect(s.starved).toBe(true);
    expect(s.reason).toBe("in_flight_exceeds_latency");
    expect(s.in_flight_ms).toBeGreaterThanOrEqual(READ_PATH_LATENCY_MS);
  });

  test("reads attempted but no success within the staleness window is starved", () => {
    const now = Date.now();
    // Attempt was recent (within stale window) but the read failed/never
    // succeeded, draining the in-flight slot without a success stamp.
    recordReadAttemptStart(now - 1_000);
    recordReadFailure(now - 1_000);
    const s = readPathStatus(now);
    expect(s.starved).toBe(true);
    expect(s.reason).toBe("no_success_since_attempt");
  });

  test("a stale prior success with a fresh attempt and no new success is starved", () => {
    const now = Date.now();
    recordReadAttemptStart(now - (READ_PATH_STALE_MS + 60_000));
    recordReadSuccess(5, now - (READ_PATH_STALE_MS + 60_000)); // old success
    // New attempt arrives but does not complete (in flight, but not yet past
    // the latency ceiling) — the prior success is stale.
    recordReadAttemptStart(now - 1_000);
    const s = readPathStatus(now);
    expect(s.starved).toBe(true);
    expect(s.reason).toBe("no_success_since_attempt");
  });

  test("last completed read slower than the ceiling is starved", () => {
    recordReadAttemptStart();
    recordReadSuccess(READ_PATH_LATENCY_MS + 1_000);
    const s = readPathStatus();
    expect(s.starved).toBe(true);
    expect(s.reason).toBe("last_latency_exceeds");
  });

  test("concurrent reads: in-flight clears only when the LAST one drains", () => {
    const now = Date.now();
    recordReadAttemptStart(now - 2_000);
    recordReadAttemptStart(now - 1_000);
    recordReadSuccess(5, now); // one drains
    expect(readPathStatus(now).in_flight_ms).not.toBeNull(); // still one in flight
    recordReadSuccess(5, now); // last drains
    expect(readPathStatus(now).in_flight_ms).toBeNull();
  });

  test("isReady() fails closed when the read path is starved even with all workers ready", () => {
    registerWorker("amendment", 1000);
    markWorkerReady("amendment");
    // Workers all ticking → worker gate is satisfied.
    expect(isReady()).toBe(true);
    // Now starve the read path: a read hung past the latency ceiling.
    recordReadAttemptStart(Date.now() - (READ_PATH_LATENCY_MS + 5_000));
    expect(isReady()).toBe(false);
    // Drain it with a healthy success → /ready recovers.
    recordReadSuccess(5);
    expect(isReady()).toBe(true);
  });

  test("read-path gate is ADDITIVE — a starved read path never makes a worker-pending daemon ready", () => {
    registerWorker("amendment", 1000);
    // Worker NOT marked ready → worker gate refuses regardless of read path.
    expect(isReady()).toBe(false);
    recordReadAttemptStart();
    recordReadSuccess(5); // healthy read path
    expect(isReady()).toBe(false); // still refused: worker gate unsatisfied
  });
});
