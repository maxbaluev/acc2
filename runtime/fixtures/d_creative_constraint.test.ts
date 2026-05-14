import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../../substrate/db";
import { openFixtureCreativeConstraint } from "./d_creative_constraint";
import { schedulerTick } from "../task_scheduler";

afterAll(() => closeDb());
beforeEach(() => closeDb());

describe("fixture_d_creative_constraint — Batch 5 universal-goal pilot (§10.4)", () => {
  test("directive opens → haiku composed → syllable verifier scores zero → task commits", async () => {
    const db = openDb(":memory:");
    const { directiveId, taskId } = await openFixtureCreativeConstraint(db);

    const tick = await schedulerTick(db, { directiveId });
    expect(tick.dispatched).toContain(taskId);

    const scored = db
      .query("SELECT residual, payload FROM events WHERE kind = 'action_scored' AND directive_id = ?")
      .get(directiveId) as { residual: number; payload: string } | null;
    expect(scored).not.toBeNull();
    expect(scored!.residual).toBe(0);

    // The action's result envelope must carry exactly three lines.
    const payload = JSON.parse(scored!.payload) as Record<string, unknown>;
    const actionResult = payload.action_result as { result: { lines: string[] } } | null;
    expect(actionResult).not.toBeNull();
    expect(Array.isArray(actionResult!.result.lines)).toBe(true);
    expect(actionResult!.result.lines.length).toBe(3);

    const committed = db
      .query("SELECT residual FROM events WHERE kind = 'task_committed' AND directive_id = ?")
      .get(directiveId) as { residual: number } | null;
    expect(committed).not.toBeNull();
    expect(committed!.residual).toBeLessThan(0.3);
  }, 60_000);
});
