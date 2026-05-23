import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../../substrate/db";
import { openFixtureMultiStakeholder } from "./d_multi_stakeholder";
import { schedulerTick, drainInFlightDispatches } from "../task_scheduler";

// This fixture exercises the NORMAL universal-goal-pilot path (deterministic
// intersection-picker action + verifier → residual 0). The generate-and-select
// organism lane (ACC2_GENERATE_SELECT=1, production-enabled in .env) would
// reroute this ambiguous + report-like directive to a live-LLM lane that cannot
// run in a test env (no LLM selection → residual 1). Pin the flag OFF so the
// fixture tests the path it intends, independent of the deployment .env.
const _priorGenerateSelect = process.env.ACC2_GENERATE_SELECT;
beforeEach(() => {
  delete process.env.ACC2_GENERATE_SELECT;
  closeDb();
});
afterAll(() => {
  if (_priorGenerateSelect === undefined) delete process.env.ACC2_GENERATE_SELECT;
  else process.env.ACC2_GENERATE_SELECT = _priorGenerateSelect;
  closeDb();
});

describe("fixture_d_multi_stakeholder — Batch 5 universal-goal pilot (§10.5)", () => {
  test("directive opens → intersection picked → verifier scores zero → task commits", async () => {
    const db = openDb(":memory:");
    const { directiveId, taskId } = await openFixtureMultiStakeholder(db);

    const tick = await schedulerTick(db, { directiveId });
    await drainInFlightDispatches();
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
