import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../../substrate/db";
import { openFixtureHealthDecision } from "./d_health_decision";
import { schedulerTick } from "../task_scheduler";

afterAll(() => closeDb());
beforeEach(() => closeDb());

describe("fixture_d_health_decision — Batch 5 universal-goal pilot (§10.6)", () => {
  test("directive opens → remedy recommended with citation + disclaimer → task commits", async () => {
    const db = openDb(":memory:");
    const { directiveId, taskId } = await openFixtureHealthDecision(db);

    const tick = await schedulerTick(db, { directiveId });
    expect(tick.dispatched).toContain(taskId);

    const scored = db
      .query("SELECT residual, payload FROM events WHERE kind = 'action_scored' AND directive_id = ?")
      .get(directiveId) as { residual: number; payload: string } | null;
    expect(scored).not.toBeNull();
    expect(scored!.residual).toBe(0);

    // The action's result envelope must include a non-empty recommendation,
    // a citation_knowledge_id (so the verifier's "cites a knowledge entry"
    // check passed), and a safety note containing the canonical phrase.
    const payload = JSON.parse(scored!.payload) as Record<string, unknown>;
    const actionResult = payload.action_result as {
      result: { recommendation: string; citation_knowledge_id: string; safety_note: string };
    } | null;
    expect(actionResult).not.toBeNull();
    expect(actionResult!.result.recommendation.length).toBeGreaterThan(0);
    expect(actionResult!.result.citation_knowledge_id.length).toBeGreaterThan(0);
    expect(actionResult!.result.safety_note.toLowerCase()).toContain("consult a clinician");

    const committed = db
      .query("SELECT residual FROM events WHERE kind = 'task_committed' AND directive_id = ?")
      .get(directiveId) as { residual: number } | null;
    expect(committed).not.toBeNull();
    expect(committed!.residual).toBeLessThan(0.3);
  }, 60_000);
});
