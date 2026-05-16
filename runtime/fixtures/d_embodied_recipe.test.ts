import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../../substrate/db";
import { openFixtureEmbodiedRecipe } from "./d_embodied_recipe";
import { schedulerTick, drainInFlightDispatches } from "../task_scheduler";

afterAll(() => closeDb());
beforeEach(() => closeDb());

describe("fixture_d_embodied_recipe — Batch 5 universal-goal pilot (§10.7)", () => {
  test("directive opens → step list constructed → every step references ingredient → task commits", async () => {
    const db = openDb(":memory:");
    const { directiveId, taskId } = await openFixtureEmbodiedRecipe(db);

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
      result: { ingredients: string[]; steps: string[]; step_count: number };
    } | null;
    expect(actionResult).not.toBeNull();
    expect(actionResult!.result.steps.length).toBeGreaterThan(0);
    // Each step must mention at least one ingredient.
    const lowerIngs = actionResult!.result.ingredients.map((s) => s.toLowerCase());
    for (const step of actionResult!.result.steps) {
      const lower = step.toLowerCase();
      const hit = lowerIngs.some((ing) => lower.includes(ing));
      expect(hit).toBe(true);
    }

    const committed = db
      .query("SELECT residual FROM events WHERE kind = 'task_committed' AND directive_id = ?")
      .get(directiveId) as { residual: number } | null;
    expect(committed).not.toBeNull();
    expect(committed!.residual).toBeLessThan(0.3);
  }, 60_000);
});
