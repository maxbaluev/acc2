import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { getArtifact } from "./artifact_store";
import { opencodeQuery, opencodeQueryMock, spawnRealOpencode } from "./bridge";
import { newId } from "./ids";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const originalBridgeMode = process.env.ACC2_BRIDGE_MODE;
afterEach(() => {
  if (originalBridgeMode === undefined) delete process.env.ACC2_BRIDGE_MODE;
  else process.env.ACC2_BRIDGE_MODE = originalBridgeMode;
});

describe("bridge (Phase D mock, default mode)", () => {
  test("returns success for fixture_d_count_todos prompts and admits both artifacts", async () => {
    const db = openDb(":memory:");
    process.env.ACC2_BRIDGE_MODE = "mock";
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

  test("returns success for the example.com title fetch prompt and admits both artifacts", async () => {
    const db = openDb(":memory:");
    process.env.ACC2_BRIDGE_MODE = "mock";
    const prompt = [
      "Fetch the URL https://example.com via Bun.fetch (the bun runtime).",
      "Parse the HTML response and extract the contents of the <title> tag.",
      "Return the observation as JSON in the shape { result: { title: string } }.",
      "Author TWO bun code artifacts:",
      "  1. ACTION artifact: a bun script using `Bun.fetch(\"https://example.com\")`",
      "  2. VERIFIER artifact: a bun script that reads the action's observation",
      "Admit both via substrate.admit_artifact and emit ONE action_predicted event",
    ].join("\n");

    const result = await opencodeQuery({ prompt, taskId: newId(), directiveId: newId() }, db);
    expect(result.ok).toBe(true);

    const admitted = db
      .query("SELECT COUNT(*) as c FROM events WHERE kind = 'code_artifact_admitted'")
      .get() as { c: number };
    expect(admitted.c).toBe(2);

    const predictedRows = db
      .query("SELECT action_artifact_id, verifier_artifact_id, payload FROM events WHERE kind = 'action_predicted'")
      .all() as Array<{ action_artifact_id: string | null; verifier_artifact_id: string | null; payload: string }>;
    expect(predictedRows.length).toBe(1);
    const predicted = predictedRows[0]!;
    expect(predicted.action_artifact_id).toBeTruthy();
    expect(predicted.verifier_artifact_id).toBeTruthy();

    const action = getArtifact(db, predicted.action_artifact_id!);
    const verifier = getArtifact(db, predicted.verifier_artifact_id!);
    expect(action?.body ?? "").toContain("Bun.fetch(\"https://example.com\")");
    expect(verifier?.body ?? "").toContain("ACC2_INPUTS");
  }, 30_000);

  test("returns auth_missing for prompts without the fixture marker", async () => {
    const db = openDb(":memory:");
    process.env.ACC2_BRIDGE_MODE = "mock";
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

  test("explicit opencodeQueryMock entry stays callable for legacy callers", async () => {
    const db = openDb(":memory:");
    const result = await opencodeQueryMock(
      {
        prompt: "FIXTURE: fixture_d_count_todos — direct mock entry",
        taskId: newId(),
        directiveId: newId(),
      },
      db,
    );
    expect(result.ok).toBe(true);
  }, 30_000);
});

describe("bridge (real subprocess, opt-in via ACC2_BRIDGE_MODE=real)", () => {
  test("real spawn surface returns a structured failure when opencode is absent", async () => {
    const db = openDb(":memory:");
    // Inject a spawnFn that throws as if `opencode` weren't on PATH.
    const fakeSpawn = (() => {
      throw new Error("ENOENT: opencode not found");
    }) as unknown as typeof Bun.spawn;
    const result = await spawnRealOpencode(
      { prompt: "real-spawn probe", taskId: newId(), directiveId: newId() },
      db,
      { spawnFn: fakeSpawn },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.kind).toBe("auth_missing");
    }
    const failed = db
      .query("SELECT COUNT(*) as c FROM events WHERE kind = 'bridge_failed'")
      .get() as { c: number };
    expect(failed.c).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
