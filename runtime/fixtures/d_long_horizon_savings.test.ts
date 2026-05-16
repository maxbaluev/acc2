import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../../substrate/db";
import { openFixtureLongHorizonSavings } from "./d_long_horizon_savings";
import { schedulerTick, drainInFlightDispatches } from "../task_scheduler";

afterAll(() => closeDb());
beforeEach(() => closeDb());

describe("fixture_d_long_horizon_savings — Batch 5 universal-goal pilot (§10.8)", () => {
  test("directive opens → monthly contribution computed → total covers target → task commits", async () => {
    const db = openDb(":memory:");
    const { directiveId, taskId } = await openFixtureLongHorizonSavings(db);

    const tick = await schedulerTick(db, { directiveId });
    await drainInFlightDispatches();
    expect(tick.dispatched).toContain(taskId);

    const scored = db
      .query("SELECT residual, payload FROM events WHERE kind = 'action_scored' AND directive_id = ?")
      .get(directiveId) as { residual: number; payload: string } | null;
    expect(scored).not.toBeNull();
    expect(scored!.residual).toBe(0);

    const payload = JSON.parse(scored!.payload) as Record<string, unknown>;
    const actionResult = payload.action_result as {
      result: { target: number; months: number; monthly: number; total: number };
    } | null;
    expect(actionResult).not.toBeNull();
    expect(actionResult!.result.monthly).toBeGreaterThan(0);
    expect(actionResult!.result.total).toBeGreaterThanOrEqual(actionResult!.result.target);
    // Within +5% tolerance (matches the verifier's window).
    expect(actionResult!.result.total).toBeLessThanOrEqual(actionResult!.result.target * 1.05);

    const committed = db
      .query("SELECT residual FROM events WHERE kind = 'task_committed' AND directive_id = ?")
      .get(directiveId) as { residual: number } | null;
    expect(committed).not.toBeNull();
    expect(committed!.residual).toBeLessThan(0.3);
  }, 60_000);
});
