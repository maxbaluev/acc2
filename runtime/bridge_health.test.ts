import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import {
  isBridgeHealthDegraded,
  maybeMarkDegraded,
  maybeMarkRecovered,
  effectiveCooldownMs,
  BRIDGE_DEGRADATION_THRESHOLD,
  BRIDGE_FAILURE_WINDOW_MS,
  BRIDGE_HEALTH_COOLDOWN_MS,
  BRIDGE_HEALTH_COOLDOWN_CAP_MS,
  BRIDGE_HEALTH_BACKOFF_WINDOW_MS,
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
    const degraded = db
      .query("SELECT payload FROM events WHERE kind = 'bridge_health_degraded' ORDER BY rowid DESC LIMIT 1")
      .get() as { payload: string };
    const payload = JSON.parse(degraded.payload) as Record<string, unknown>;
    expect(payload.distinct_task_count).toBe(BRIDGE_DEGRADATION_THRESHOLD);
    expect(payload.failure_event_count).toBe(BRIDGE_DEGRADATION_THRESHOLD);
    expect(payload).not.toHaveProperty("event_count");
  });

  test("maybeMarkDegraded counts distinct failing task identities, not repeated rows for one task", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    for (let i = 0; i < BRIDGE_DEGRADATION_THRESHOLD + 2; i++) {
      seedBridgeFailed(db, new Date(now - 1000 * i).toISOString(), "t_repeated");
    }
    expect(maybeMarkDegraded(db, { nowMs: now })).toBe(false);
    expect(isBridgeHealthDegraded(db)).toBe(false);
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

  test("effectiveCooldownMs returns base on first degrade", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    expect(effectiveCooldownMs(db, now)).toBe(BRIDGE_HEALTH_COOLDOWN_MS);
  });

  test("effectiveCooldownMs doubles per rapid re-degrade in the backoff window", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    // 1 prior degrade in window → cooldown = base
    emitEvent(db, {
      kind: "bridge_health_degraded",
      substrate_origin: "substrate_auto",
      payload: { reason: "seed_1" },
    });
    expect(effectiveCooldownMs(db, now)).toBe(BRIDGE_HEALTH_COOLDOWN_MS);
    // 2 prior degrades → cooldown = base * 2
    emitEvent(db, {
      kind: "bridge_health_degraded",
      substrate_origin: "substrate_auto",
      payload: { reason: "seed_2" },
    });
    expect(effectiveCooldownMs(db, now)).toBe(BRIDGE_HEALTH_COOLDOWN_MS * 2);
    // 3 prior degrades → cooldown = base * 4
    emitEvent(db, {
      kind: "bridge_health_degraded",
      substrate_origin: "substrate_auto",
      payload: { reason: "seed_3" },
    });
    expect(effectiveCooldownMs(db, now)).toBe(BRIDGE_HEALTH_COOLDOWN_MS * 4);
  });

  test("effectiveCooldownMs is capped at BRIDGE_HEALTH_COOLDOWN_CAP_MS", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    // Pile in many degrades. base=30s * 2^N grows unbounded; verify cap.
    for (let i = 0; i < 20; i++) {
      emitEvent(db, {
        kind: "bridge_health_degraded",
        substrate_origin: "substrate_auto",
        payload: { reason: `seed_${i}` },
      });
    }
    expect(effectiveCooldownMs(db, now)).toBe(BRIDGE_HEALTH_COOLDOWN_CAP_MS);
  });

  test("effectiveCooldownMs resets to base once degrades fall outside the backoff window", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    // Seed an OLD degrade outside the window — should not count.
    db.query(
      `INSERT INTO events (id, ts, kind, substrate_origin, directive_id, task_id, loop_id, payload)
       VALUES ('e_old', ?, 'bridge_health_degraded', 'substrate_auto', '', '', '', '{}')`,
    ).run(new Date(now - BRIDGE_HEALTH_BACKOFF_WINDOW_MS - 60_000).toISOString());
    expect(effectiveCooldownMs(db, now)).toBe(BRIDGE_HEALTH_COOLDOWN_MS);
  });

  test("maybeMarkDegraded payload includes effective_cooldown_ms reflecting backoff", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    // Prime with one prior degrade so the NEW degrade is the second in window.
    emitEvent(db, {
      kind: "bridge_health_degraded",
      substrate_origin: "substrate_auto",
      payload: { reason: "prior" },
    });
    // Then "recover" so the gate is OPEN and the next maybeMarkDegraded fires.
    emitEvent(db, {
      kind: "bridge_health_recovered",
      substrate_origin: "substrate_auto",
      payload: {},
    });
    for (let i = 0; i < BRIDGE_DEGRADATION_THRESHOLD; i++) {
      seedBridgeFailed(db, new Date(now - 1000 * i).toISOString(), `t_${i}`);
    }
    expect(maybeMarkDegraded(db, { nowMs: now })).toBe(true);
    const row = db
      .query(
        "SELECT payload FROM events WHERE kind = 'bridge_health_degraded' ORDER BY rowid DESC LIMIT 1",
      )
      .get() as { payload: string };
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    expect(payload.recent_degrade_streak).toBe(2);
    expect(payload.effective_cooldown_ms).toBe(BRIDGE_HEALTH_COOLDOWN_MS * 2);
    expect(payload.base_cooldown_ms).toBe(BRIDGE_HEALTH_COOLDOWN_MS);
    expect(payload.cooldown_cap_ms).toBe(BRIDGE_HEALTH_COOLDOWN_CAP_MS);
  });

  test("maybeMarkRecovered uses the effective (backoff-grown) cooldown, not the base", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    // Two prior degrades + recovery → next recovery uses base*2.
    emitEvent(db, {
      kind: "bridge_health_degraded",
      substrate_origin: "substrate_auto",
      payload: { reason: "d1" },
    });
    emitEvent(db, {
      kind: "bridge_health_degraded",
      substrate_origin: "substrate_auto",
      payload: { reason: "d2" },
    });
    // Place a bridge_failed inside base*2 but outside base. This must BLOCK
    // recovery with the new logic (under old flat-base logic it would have
    // recovered already).
    const failureTs = new Date(now - (BRIDGE_HEALTH_COOLDOWN_MS + 5_000)).toISOString();
    seedBridgeFailed(db, failureTs, "t_blocker");
    expect(maybeMarkRecovered(db, { nowMs: now })).toBe(false);
    expect(isBridgeHealthDegraded(db)).toBe(true);
  });
});
