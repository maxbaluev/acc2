import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { closeDb, openDb } from "./db";
import { emitEvent } from "../runtime/events";
import {
  applyAutonomyAdjustments,
  AUTONOMY_DELTA_ON_SUCCESS,
  AUTONOMY_DELTA_ON_FAILURE,
  AUTONOMY_DELTA_ON_IRREVERSIBLE,
  runOwnerAutonomyAdjusterTick,
} from "./owner_autonomy_adjuster";

describe("applyAutonomyAdjustments — pure", () => {
  test("zero outcomes leaves score unchanged", () => {
    expect(applyAutonomyAdjustments(0.5, 0, [])).toBe(0.5);
  });

  test("one applied_change_committed nudges score up", () => {
    expect(applyAutonomyAdjustments(0.5, 0, ["applied_change_committed"]))
      .toBeCloseTo(0.5 + AUTONOMY_DELTA_ON_SUCCESS, 5);
  });

  test("one applied_change_failed drops score by 0.10", () => {
    expect(applyAutonomyAdjustments(0.5, 0, ["applied_change_failed"]))
      .toBeCloseTo(0.5 + AUTONOMY_DELTA_ON_FAILURE, 5);
  });

  test("one irreversible_effect drops score by 0.25", () => {
    expect(applyAutonomyAdjustments(0.5, 0, ["irreversible_effect_recorded"]))
      .toBeCloseTo(0.5 + AUTONOMY_DELTA_ON_IRREVERSIBLE, 5);
  });

  test("score clamps to [floor, 1] — ceiling", () => {
    const kinds = Array(100).fill("applied_change_committed");
    expect(applyAutonomyAdjustments(0.9, 0, kinds)).toBe(1);
  });

  test("score clamps to [floor, 1] — owner-declared floor", () => {
    const kinds = Array(10).fill("applied_change_failed");
    // 10 failures × -0.10 from 0.5 → would be -0.5; clamped to floor 0.3.
    expect(applyAutonomyAdjustments(0.5, 0.3, kinds)).toBe(0.3);
  });

  test("score clamps to [floor, 1] — no floor → 0", () => {
    const kinds = Array(10).fill("applied_change_failed");
    expect(applyAutonomyAdjustments(0.5, 0, kinds)).toBe(0);
  });

  test("mixed outcomes applied chronologically", () => {
    // 0.5 + 5*0.02 (=0.10) - 1*0.10 (=-0.10) - 1*0.25 (=-0.25) = 0.25
    const kinds = [
      ...Array(5).fill("applied_change_committed"),
      "applied_change_failed",
      "irreversible_effect_recorded",
    ];
    expect(applyAutonomyAdjustments(0.5, 0, kinds)).toBeCloseTo(0.25, 5);
  });

  test("unknown event kinds are ignored", () => {
    expect(applyAutonomyAdjustments(0.5, 0, ["some_other_kind", "task_committed"]))
      .toBe(0.5);
  });
});

describe("runOwnerAutonomyAdjusterTick — DB driver", () => {
  let db: Database;
  beforeEach(() => { db = openDb(":memory:"); });
  afterEach(() => { closeDb(); });

  test("no outcomes → no candidate emitted", () => {
    const summary = runOwnerAutonomyAdjusterTick(db);
    expect(summary.emitted).toBe(false);
    expect(summary.consumed).toBe(0);
    const candidates = db
      .query("SELECT COUNT(*) as c FROM events WHERE kind='owner_insight_candidate'")
      .get() as { c: number };
    expect(candidates.c).toBe(0);
  });

  test("one applied_change_committed → emits +0.02 candidate", () => {
    emitEvent(db, {
      kind: "applied_change_committed",
      substrate_origin: "claude_root",
      payload: { target: "runtime/foo.ts" },
    });
    const summary = runOwnerAutonomyAdjusterTick(db);
    expect(summary.emitted).toBe(true);
    expect(summary.consumed).toBe(1);
    expect(summary.delta).toBeCloseTo(AUTONOMY_DELTA_ON_SUCCESS, 5);
    expect(summary.new_score).toBeCloseTo(0.5 + AUTONOMY_DELTA_ON_SUCCESS, 5);

    const candidate = db
      .query(`SELECT payload FROM events WHERE kind='owner_insight_candidate'`)
      .get() as { payload: string };
    const p = JSON.parse(candidate.payload) as Record<string, unknown>;
    expect(p.field).toBe("autonomy_score");
    expect(p.source).toBe("autonomy_adjuster");
    expect(p.value).toBeCloseTo(0.5 + AUTONOMY_DELTA_ON_SUCCESS, 5);
  });

  test("irreversible_effect_recorded → emits -0.25 candidate", () => {
    emitEvent(db, {
      kind: "irreversible_effect_recorded",
      substrate_origin: "runtime",
      payload: { effect: "dropped database" },
    });
    const summary = runOwnerAutonomyAdjusterTick(db);
    expect(summary.emitted).toBe(true);
    expect(summary.new_score).toBeCloseTo(0.25, 5);
  });

  test("idempotent — re-running on same outcomes emits nothing new", () => {
    emitEvent(db, {
      kind: "applied_change_committed",
      substrate_origin: "claude_root",
      payload: { target: "runtime/foo.ts" },
    });
    const first = runOwnerAutonomyAdjusterTick(db);
    expect(first.emitted).toBe(true);

    const second = runOwnerAutonomyAdjusterTick(db);
    expect(second.emitted).toBe(false);
    expect(second.consumed).toBe(0);
  });

  test("respects floor from latest owner_profile_recorded", () => {
    // Owner-declared floor 0.6 — score should never drop below.
    emitEvent(db, {
      kind: "owner_profile_recorded",
      substrate_origin: "substrate_auto",
      payload: { autonomy_score: 0.7, autonomy_score_floor: 0.6 },
    });
    // 5 failures × -0.10 = -0.50; from 0.7 → 0.2; clamped to floor 0.6.
    for (let i = 0; i < 5; i++) {
      emitEvent(db, {
        kind: "applied_change_failed",
        substrate_origin: "substrate_auto",
        payload: { target: "runtime/foo.ts" },
      });
    }
    const summary = runOwnerAutonomyAdjusterTick(db);
    expect(summary.emitted).toBe(true);
    expect(summary.new_score).toBe(0.6);
  });

  test("new outcomes after a prior tick get consumed on the next tick", () => {
    emitEvent(db, {
      kind: "applied_change_committed",
      substrate_origin: "claude_root",
      payload: { target: "runtime/foo.ts" },
    });
    runOwnerAutonomyAdjusterTick(db);

    emitEvent(db, {
      kind: "applied_change_failed",
      substrate_origin: "substrate_auto",
      payload: { target: "runtime/bar.ts" },
    });
    const summary = runOwnerAutonomyAdjusterTick(db);
    expect(summary.emitted).toBe(true);
    expect(summary.consumed).toBe(1);
    expect(summary.delta).toBeCloseTo(AUTONOMY_DELTA_ON_FAILURE, 5);
  });

  test("score already at ceiling → no emit (delta = 0)", () => {
    emitEvent(db, {
      kind: "owner_profile_recorded",
      substrate_origin: "substrate_auto",
      payload: { autonomy_score: 1.0 },
    });
    emitEvent(db, {
      kind: "applied_change_committed",
      substrate_origin: "claude_root",
      payload: { target: "runtime/foo.ts" },
    });
    const summary = runOwnerAutonomyAdjusterTick(db);
    expect(summary.emitted).toBe(false);
    expect(summary.delta).toBe(0);
  });
});
