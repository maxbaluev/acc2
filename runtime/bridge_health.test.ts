import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import {
  isBridgeHealthDegraded,
  maybeMarkDegraded,
  maybeMarkRecovered,
  BRIDGE_DEGRADATION_THRESHOLD,
  BRIDGE_FAILURE_WINDOW_MS,
  BRIDGE_HEALTH_COOLDOWN_MS,
} from "./bridge_health";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const seedBridgeFailed = (db: ReturnType<typeof openDb>, ts: string, taskId = "t_x") => {
  db.query(
    `INSERT INTO events (id, ts, kind, substrate_origin, directive_id, task_id, loop_id, payload)
     VALUES (?, ?, 'bridge_failed', 'substrate_auto', ?, ?, '', ?)`,
  ).run(`e_${ts}_${taskId}`, ts, "d_x", taskId, JSON.stringify({ reason: "timeout" }));
};

describe("bridge_health gate", () => {
  test("isBridgeHealthDegraded returns false on a clean substrate", () => {
    const db = openDb(":memory:");
    expect(isBridgeHealthDegraded(db)).toBe(false);
  });

  test("maybeMarkDegraded is a no-op when failure count is below the threshold", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    for (let i = 0; i < BRIDGE_DEGRADATION_THRESHOLD - 1; i++) {
      seedBridgeFailed(db, new Date(now - 1000 * i).toISOString(), `t_${i}`);
    }
    expect(maybeMarkDegraded(db, { nowMs: now })).toBe(false);
    expect(isBridgeHealthDegraded(db)).toBe(false);
  });

  test("maybeMarkDegraded emits when the threshold is hit within the window", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    for (let i = 0; i < BRIDGE_DEGRADATION_THRESHOLD; i++) {
      seedBridgeFailed(db, new Date(now - 1000 * i).toISOString(), `t_${i}`);
    }
    expect(maybeMarkDegraded(db, { nowMs: now })).toBe(true);
    expect(isBridgeHealthDegraded(db)).toBe(true);
    const rows = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'bridge_health_degraded'")
      .get() as { c: number };
    expect(rows.c).toBe(1);
  });

  test("maybeMarkDegraded does NOT re-emit when already degraded (idempotent)", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    for (let i = 0; i < BRIDGE_DEGRADATION_THRESHOLD; i++) {
      seedBridgeFailed(db, new Date(now - 1000 * i).toISOString(), `t_${i}`);
    }
    expect(maybeMarkDegraded(db, { nowMs: now })).toBe(true);
    expect(maybeMarkDegraded(db, { nowMs: now })).toBe(false);
    const rows = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'bridge_health_degraded'")
      .get() as { c: number };
    expect(rows.c).toBe(1);
  });

  test("failures older than the window do NOT count toward the threshold", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    for (let i = 0; i < BRIDGE_DEGRADATION_THRESHOLD + 2; i++) {
      // Place every failure OUTSIDE the window
      seedBridgeFailed(db, new Date(now - BRIDGE_FAILURE_WINDOW_MS - 60_000 - i * 1000).toISOString(), `t_old_${i}`);
    }
    expect(maybeMarkDegraded(db, { nowMs: now })).toBe(false);
  });

  test("maybeMarkRecovered emits when degraded AND no failures within cooldown", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    // Seed failures + degraded marker, all OLDER than the cooldown window.
    const oldTs = new Date(now - BRIDGE_HEALTH_COOLDOWN_MS - 60_000).toISOString();
    for (let i = 0; i < BRIDGE_DEGRADATION_THRESHOLD; i++) {
      seedBridgeFailed(db, oldTs, `t_${i}`);
    }
    emitEvent(db, {
      kind: "bridge_health_degraded",
      substrate_origin: "substrate_auto",
      payload: { reason: "test_seed" },
    });
    expect(isBridgeHealthDegraded(db)).toBe(true);
    expect(maybeMarkRecovered(db, { nowMs: now })).toBe(true);
    expect(isBridgeHealthDegraded(db)).toBe(false);
  });

  test("maybeMarkRecovered does NOT fire while recent failures exist within cooldown", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    seedBridgeFailed(db, new Date(now - 1000).toISOString(), "t_recent");
    emitEvent(db, {
      kind: "bridge_health_degraded",
      substrate_origin: "substrate_auto",
      payload: { reason: "test_seed" },
    });
    expect(maybeMarkRecovered(db, { nowMs: now })).toBe(false);
    expect(isBridgeHealthDegraded(db)).toBe(true);
  });
});
