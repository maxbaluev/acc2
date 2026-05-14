import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../../substrate/db";
import { openFixtureBusinessOutreach } from "./d_business_outreach";
import { schedulerTick } from "../task_scheduler";

afterAll(() => closeDb());
beforeEach(() => closeDb());

describe("fixture_d_business_outreach — Batch 5 universal-goal pilot (§10.2)", () => {
  test("directive opens → brain dispatches → email written → verifier scores → task commits", async () => {
    const db = openDb(":memory:");
    const { directiveId, taskId } = await openFixtureBusinessOutreach(db);

    const tick = await schedulerTick(db, { directiveId });
    expect(tick.dispatched).toContain(taskId);

    const scored = db
      .query("SELECT residual FROM events WHERE kind = 'action_scored' AND directive_id = ?")
      .get(directiveId) as { residual: number } | null;
    expect(scored).not.toBeNull();
    expect(scored!.residual).toBe(0);

    const committed = db
      .query("SELECT residual FROM events WHERE kind = 'task_committed' AND directive_id = ?")
      .get(directiveId) as { residual: number } | null;
    expect(committed).not.toBeNull();
    expect(committed!.residual).toBeLessThan(0.3);

    const violations = db
      .query("SELECT COUNT(*) as c FROM events WHERE kind = 'dispatcher_violation' AND directive_id = ?")
      .get(directiveId) as { c: number };
    expect(violations.c).toBe(0);
  }, 60_000);
});
