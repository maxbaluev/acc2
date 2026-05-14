import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { opencodeQuery } from "./bridge";
import { newId } from "./ids";

afterAll(() => closeDb());
beforeEach(() => closeDb());

describe("bridge (Phase D mock)", () => {
  test("returns success for fixture_d_count_todos prompts and admits both artifacts", async () => {
    const db = openDb(":memory:");
    const result = await opencodeQuery(
      {
        prompt: "FIXTURE: fixture_d_count_todos — count TODOs",
        taskId: newId(),
        directiveId: newId(),
      },
      db,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.emitted_event_ids.length).toBeGreaterThan(0);
    }
    const admitted = db
      .query("SELECT COUNT(*) as c FROM events WHERE kind = 'code_artifact_admitted'")
      .get() as { c: number };
    expect(admitted.c).toBe(2);
    const predicted = db
      .query("SELECT COUNT(*) as c FROM events WHERE kind = 'action_predicted'")
      .get() as { c: number };
    expect(predicted.c).toBe(1);
  }, 30_000);

  test("returns auth_missing for prompts without the fixture marker", async () => {
    const db = openDb(":memory:");
    const result = await opencodeQuery(
      { prompt: "some other directive", taskId: newId(), directiveId: newId() },
      db,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.kind).toBe("auth_missing");
    }
    const failed = db
      .query("SELECT COUNT(*) as c FROM events WHERE kind = 'bridge_failed'")
      .get() as { c: number };
    expect(failed.c).toBe(1);
  });
});
