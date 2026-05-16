import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../../substrate/db";
import { openFixtureCrisisResponse } from "./d_crisis_response";
import { schedulerTick, drainInFlightDispatches } from "../task_scheduler";
import { readCurrentMode, CRISIS_MODE } from "../crisis_mode";

afterAll(() => closeDb());
beforeEach(() => closeDb());

describe("fixture_d_crisis_response — Batch 5 universal-goal pilot (§10.9)", () => {
  test("directive opens with urgency=crisis → crisis_mode_engaged fires → triage plan → task commits", async () => {
    const db = openDb(":memory:");
    const { directiveId, taskId } = await openFixtureCrisisResponse(db);

    // crisis_mode_engaged must have fired alongside directive_opened.
    const engaged = db
      .query("SELECT id, payload FROM events WHERE kind = 'crisis_mode_engaged' AND directive_id = ?")
      .all(directiveId) as Array<{ id: string; payload: string }>;
    expect(engaged.length).toBeGreaterThanOrEqual(1);

    // readCurrentMode resolves to CRISIS_MODE (raises max_concurrent to 20).
    const mode = readCurrentMode(db, directiveId);
    expect(mode).toEqual(CRISIS_MODE);
    expect(mode.max_concurrent).toBe(20);

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
      result: { triage_steps: string[]; urgency: string };
    } | null;
    expect(actionResult).not.toBeNull();
    expect(actionResult!.result.triage_steps.length).toBeGreaterThanOrEqual(3);
    expect(actionResult!.result.urgency).toBe("crisis");

    const committed = db
      .query("SELECT residual FROM events WHERE kind = 'task_committed' AND directive_id = ?")
      .get(directiveId) as { residual: number } | null;
    expect(committed).not.toBeNull();
    expect(committed!.residual).toBeLessThan(0.3);
  }, 60_000);
});
