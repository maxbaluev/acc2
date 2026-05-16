import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../../substrate/db";
import { openFixtureResearchSummary } from "./d_research_summary";
import { schedulerTick, drainInFlightDispatches } from "../task_scheduler";

afterAll(() => closeDb());
beforeEach(() => closeDb());

describe("fixture_d_research_summary — Batch 5 universal-goal pilot (§10.3)", () => {
  test("directive opens → corpus summarized → keywords present → task commits", async () => {
    const db = openDb(":memory:");
    const { directiveId, taskId } = await openFixtureResearchSummary(db);

    const tick = await schedulerTick(db, { directiveId });
    await drainInFlightDispatches();
    expect(tick.dispatched).toContain(taskId);

    const scored = db
      .query("SELECT residual, payload FROM events WHERE kind = 'action_scored' AND directive_id = ?")
      .get(directiveId) as { residual: number; payload: string } | null;
    expect(scored).not.toBeNull();
    expect(scored!.residual).toBe(0);

    // The action's result envelope must carry a summary string of legible length.
    const payload = JSON.parse(scored!.payload) as Record<string, unknown>;
    const actionResult = payload.action_result as { result: { summary: string; char_count: number } } | null;
    expect(actionResult).not.toBeNull();
    expect(typeof actionResult!.result.summary).toBe("string");
    expect(actionResult!.result.summary.length).toBeGreaterThanOrEqual(40);

    const committed = db
      .query("SELECT residual FROM events WHERE kind = 'task_committed' AND directive_id = ?")
      .get(directiveId) as { residual: number } | null;
    expect(committed).not.toBeNull();
    expect(committed!.residual).toBeLessThan(0.3);
  }, 60_000);
});
