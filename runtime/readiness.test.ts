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
    registerWorker("father", 60_000);
    markWorkerReady("amendment");
    markWorkerReady("father");
    recordWorkerTick("amendment");
    recordWorkerTick("father", Date.now() - 5 * 60_000); // 5min lag, way over 3*60s
    const stuck = stuckWorkers();
    expect(stuck.map((s) => s.worker)).toEqual(["father"]);
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
