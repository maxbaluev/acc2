import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../../substrate/db";
import { openFixtureMultiStakeholder } from "./d_multi_stakeholder";
import { schedulerTick } from "../task_scheduler";

afterAll(() => closeDb());
beforeEach(() => closeDb());

describe("fixture_d_multi_stakeholder — Batch 5 universal-goal pilot (§10.5)", () => {
  test("directive opens → intersection picked → verifier scores zero → task commits", async () => {
    const db = openDb(":memory:");
    const { directiveId, taskId } = await openFixtureMultiStakeholder(db);

    const tick = await schedulerTick(db, { directiveId });
    expect(tick.dispatched).toContain(taskId);

    const scored = db
      .query("SELECT residual, payload FROM events WHERE kind = 'action_scored' AND directive_id = ?")
      .get(directiveId) as { residual: number; payload: string } | null;
    expect(scored).not.toBeNull();
    expect(scored!.residual).toBe(0);

    // The chosen value must be a number and the result must report a feasible
    // intersection across all stakeholders.
    const payload = JSON.parse(scored!.payload) as Record<string, unknown>;
    const actionResult = payload.action_result as {
      result: { chosen: number | null; feasible: boolean; stakeholders: Array<{ low: number; high: number }> };
    } | null;
    expect(actionResult).not.toBeNull();
    expect(actionResult!.result.feasible).toBe(true);
    expect(typeof actionResult!.result.chosen).toBe("number");

    const committed = db
      .query("SELECT residual FROM events WHERE kind = 'task_committed' AND directive_id = ?")
      .get(directiveId) as { residual: number } | null;
    expect(committed).not.toBeNull();
    expect(committed!.residual).toBeLessThan(0.3);
  }, 60_000);
});
