import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../substrate/db";
import { dispatchReadyTask } from "./task_dispatcher";
import { opencodeQueryAdversarialCycle2, opencodeQueryHighResidual } from "./bridge";
import { readyTasks } from "./task_topology";
import { openFixtureDCountTodos } from "./fixtures/d_count_todos";
import { emitEvent } from "./events";
import { newId } from "./ids";

afterAll(() => closeDb());
beforeEach(() => closeDb());

describe("task_dispatcher", () => {
  test("happy path: action_predicted → action → verifier → action_scored → task_committed", async () => {
    const db = openDb(":memory:");
    const tempDir = mkdtempSync(join(tmpdir(), "acc2-disp-"));
    writeFileSync(join(tempDir, "a.txt"), "no marker here", "utf-8");
    writeFileSync(join(tempDir, "b.txt"), "// TODO fix me", "utf-8");
    writeFileSync(join(tempDir, "c.txt"), "another TODO line", "utf-8");

    try {
      const { directiveId, taskId } = await openFixtureDCountTodos(db, tempDir);
      const ready = readyTasks(db, directiveId);
      expect(ready.length).toBeGreaterThan(0);
      const task = ready[0]!;
      expect(task.id).toBe(taskId);

      const result = await dispatchReadyTask(db, task, { fixtureTargetPath: tempDir });
      expect(result.violations).toEqual([]);
      expect(result.bridge_result?.ok).toBe(true);

      const actionPredicted = db
        .query("SELECT COUNT(*) as c FROM events WHERE kind = 'action_predicted' AND task_id = ?")
        .get(taskId) as { c: number };
      expect(actionPredicted.c).toBe(1);

      const actionScored = db
        .query("SELECT residual FROM events WHERE kind = 'action_scored' AND task_id = ?")
        .get(taskId) as { residual: number } | null;
      expect(actionScored).not.toBeNull();
      expect(actionScored!.residual).toBe(0);

      const taskCommitted = db
        .query("SELECT residual FROM events WHERE kind = 'task_committed' AND task_id = ?")
        .get(taskId) as { residual: number } | null;
      expect(taskCommitted).not.toBeNull();
      expect(taskCommitted!.residual).toBe(0);

      const closed = db
        .query("SELECT COUNT(*) as c FROM events WHERE kind = 'brain_dispatch_closed' AND task_id = ?")
        .get(taskId) as { c: number };
      expect(closed.c).toBe(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 60_000);

  test("cycle-1 enforcement: adversarial brain_cycle_2_started → dispatcher_violation + dispatch closes", async () => {
    const db = openDb(":memory:");
    const { directiveId, taskId } = await openFixtureDCountTodos(db, "/tmp");
    const ready = readyTasks(db, directiveId);
    const task = ready[0]!;

    const result = await dispatchReadyTask(db, task, {
      bridge: opencodeQueryAdversarialCycle2,
    });
    expect(result.violations).toContain("cycle_1_only_breach");

    const violation = db
      .query(
        "SELECT failure_kind FROM events WHERE kind = 'dispatcher_violation' AND task_id = ?",
      )
      .get(taskId) as { failure_kind: string } | null;
    expect(violation).not.toBeNull();
    expect(violation!.failure_kind).toBe("cycle_1_only_breach");

    const closed = db
      .query("SELECT COUNT(*) as c FROM events WHERE kind = 'brain_dispatch_closed' AND task_id = ?")
      .get(taskId) as { c: number };
    expect(closed.c).toBe(1);

    // The action artifact MUST NOT have run — no action_predicted, no action_scored.
    const scored = db
      .query("SELECT COUNT(*) as c FROM events WHERE kind = 'action_scored' AND task_id = ?")
      .get(taskId) as { c: number };
    expect(scored.c).toBe(0);

    // The task is NOT committed.
    const committed = db
      .query("SELECT COUNT(*) as c FROM events WHERE kind = 'task_committed' AND task_id = ?")
      .get(taskId) as { c: number };
    expect(committed.c).toBe(0);
  }, 30_000);

  test("high-residual dispatch emits refinement edge + new task_node_opened child", async () => {
    const db = openDb(":memory:");
    const { directiveId, taskId } = await openFixtureDCountTodos(db, "/tmp");
    const ready = readyTasks(db, directiveId);
    const task = ready[0]!;

    const result = await dispatchReadyTask(db, task, {
      bridge: opencodeQueryHighResidual,
    });
    expect(result.violations).toEqual([]);

    // action_scored landed with residual=1
    const scored = db
      .query("SELECT residual FROM events WHERE kind = 'action_scored' AND task_id = ?")
      .get(taskId) as { residual: number } | null;
    expect(scored).not.toBeNull();
    expect(scored!.residual).toBe(1);

    // NO task_committed event
    const committed = db
      .query("SELECT COUNT(*) as c FROM events WHERE kind = 'task_committed' AND task_id = ?")
      .get(taskId) as { c: number };
    expect(committed.c).toBe(0);

    // task_failed (refinement_depth_exceeded) MUST NOT fire at depth 0
    const failed = db
      .query("SELECT COUNT(*) as c FROM events WHERE kind = 'task_failed' AND task_id = ?")
      .get(taskId) as { c: number };
    expect(failed.c).toBe(0);

    // A refinement edge MUST exist from this task to a new child.
    const refines = db
      .query(
        "SELECT payload FROM events WHERE kind = 'task_edge_recorded' AND directive_id = ?",
      )
      .all(directiveId) as Array<{ payload: string }>;
    const refinementEdge = refines
      .map((r) => JSON.parse(r.payload) as Record<string, unknown>)
      .find((p) => p.kind === "refines" && p.from_task === taskId);
    expect(refinementEdge).not.toBeUndefined();

    // A new task_node_opened for the refinement child.
    const child = refinementEdge!.to_task as string;
    const childOpened = db
      .query("SELECT payload FROM events WHERE kind = 'task_node_opened' AND task_id = ?")
      .get(child) as { payload: string } | null;
    expect(childOpened).not.toBeNull();
    const childPayload = JSON.parse(childOpened!.payload);
    expect(childPayload.refines_task_id).toBe(taskId);
    expect(childPayload.prior_residual).toBe(1);
  }, 30_000);

  test("at depth 4 (below cap), refinement edge still emits — task_failed must not fire", async () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const ids = Array.from({ length: 5 }, () => newId());
    for (let i = 0; i < 5; i++) {
      emitEvent(db, {
        kind: "task_node_opened",
        directive_id: directiveId,
        task_id: ids[i]!,
        payload: { goal: `chain-${i}` },
      });
      if (i > 0) {
        emitEvent(db, {
          kind: "task_edge_recorded",
          directive_id: directiveId,
          task_id: ids[i]!,
          payload: { from_task: ids[i - 1]!, to_task: ids[i]!, kind: "refines" },
        });
      }
    }
    const deep = ids[4]!; // depth = 4 (1 below cap=5)
    const { nodes } = (await import("./task_topology")).readDagForDirective(db, directiveId);
    const node = nodes.find((n) => n.id === deep)!;

    const result = await dispatchReadyTask(db, node, { bridge: opencodeQueryHighResidual });
    expect(result.violations).toEqual([]);
    // Must emit a refinement edge (depth becomes 5), NOT task_failed.
    const failed = db
      .query("SELECT COUNT(*) as c FROM events WHERE kind = 'task_failed' AND task_id = ?")
      .get(deep) as { c: number };
    expect(failed.c).toBe(0);
    const edges = db
      .query("SELECT payload FROM events WHERE kind = 'task_edge_recorded' AND directive_id = ?")
      .all(directiveId) as Array<{ payload: string }>;
    const newEdge = edges
      .map((r) => JSON.parse(r.payload) as Record<string, unknown>)
      .find((p) => p.from_task === deep && p.kind === "refines");
    expect(newEdge).not.toBeUndefined();
  }, 30_000);

  test("Phase H: action_scored triggers credit pipeline → code_artifact_score_updated events fire", async () => {
    const db = openDb(":memory:");
    const tempDir = mkdtempSync(join(tmpdir(), "acc2-disp-credit-"));
    writeFileSync(join(tempDir, "a.txt"), "// TODO one", "utf-8");

    try {
      const { directiveId, taskId } = await openFixtureDCountTodos(db, tempDir);
      const ready = readyTasks(db, directiveId);
      const task = ready[0]!;

      const result = await dispatchReadyTask(db, task, { fixtureTargetPath: tempDir });
      expect(result.violations).toEqual([]);

      // Credit pipeline emits at least 2 code_artifact_score_updated events
      // (action artifact + verifier artifact). Each one is keyed to the
      // scored event id in its payload.
      const updated = db
        .query(
          "SELECT COUNT(*) as c FROM events WHERE kind = 'code_artifact_score_updated' AND task_id = ?",
        )
        .get(taskId) as { c: number };
      expect(updated.c).toBeGreaterThanOrEqual(2);

      // The dispatcher routes through distributeCredit — not the legacy
      // applyResidualOutcome path. We assert the credit-pipeline contract:
      // for each action_scored on this task, at least one
      // code_artifact_score_updated cites the scored event id in its
      // payload.
      const scored = db
        .query(
          "SELECT id FROM events WHERE kind = 'action_scored' AND task_id = ?",
        )
        .get(taskId) as { id: string };
      const updates = db
        .query(
          "SELECT payload FROM events WHERE kind = 'code_artifact_score_updated' AND task_id = ?",
        )
        .all(taskId) as Array<{ payload: string }>;
      const linked = updates.find((r) => {
        try {
          return (JSON.parse(r.payload) as { scored_event_id?: string }).scored_event_id === scored.id;
        } catch { return false; }
      });
      expect(linked).toBeTruthy();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 60_000);

  test("Phase J: substrate_replay route commits without calling the bridge", async () => {
    const db = openDb(":memory:");
    const tempDir = mkdtempSync(join(tmpdir(), "acc2-disp-replay-"));
    writeFileSync(join(tempDir, "a.txt"), "// TODO\n");

    try {
      // Build a 3-success history so extractRecipeCandidates emits a recipe.
      const { extractRecipeCandidates } = await import("../substrate/extractors");
      const { updateRecipeConfidence } = await import("./recipe_replay");

      for (let i = 0; i < 3; i++) {
        const { directiveId, taskId } = await openFixtureDCountTodos(db, tempDir);
        const ready = readyTasks(db, directiveId);
        await dispatchReadyTask(db, ready[0]!, { fixtureTargetPath: tempDir });
        await new Promise((r) => setTimeout(r, 5));
      }
      const summary = extractRecipeCandidates(db);
      expect(summary.extracted).toBeGreaterThanOrEqual(1);
      const recipeRow = db
        .query("SELECT id FROM events WHERE kind = 'recipe_extracted' ORDER BY ts DESC LIMIT 1")
        .get() as { id: string };
      // Bump twice to bring 0.5 prior up to 0.6 default threshold.
      updateRecipeConfidence(db, recipeRow.id, true);
      updateRecipeConfidence(db, recipeRow.id, true);

      const bridgeBefore = (db
        .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'bridge_invoked'")
        .get() as { c: number }).c;

      // Fresh fixture run — dispatcher should route to substrate_replay.
      const { directiveId, taskId } = await openFixtureDCountTodos(db, tempDir);
      const ready = readyTasks(db, directiveId);
      const task = ready.find((r) => r.id === taskId)!;

      // Track: bridge MUST NOT be called. We pass a spy bridge that throws.
      let bridgeWasCalled = false;
      const result = await dispatchReadyTask(db, task, {
        fixtureTargetPath: tempDir,
        bridge: async () => {
          bridgeWasCalled = true;
          return { ok: false, reason: { kind: "auth_missing" } };
        },
      });
      expect(bridgeWasCalled).toBe(false);
      expect(result.violations).toEqual([]);

      const invoked = db
        .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'recipe_invoked' AND task_id = ?")
        .get(taskId) as { c: number };
      expect(invoked.c).toBe(1);

      const bridgeAfter = (db
        .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'bridge_invoked'")
        .get() as { c: number }).c;
      expect(bridgeAfter).toBe(bridgeBefore);

      const committed = db
        .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'task_committed' AND task_id = ?")
        .get(taskId) as { c: number };
      expect(committed.c).toBe(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 90_000);

  test("refinement depth cap fires task_failed with refinement_depth_exceeded after 5 levels", async () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    // Build a 6-deep refines chain manually so the dispatched task starts at depth=5.
    const ids = Array.from({ length: 6 }, () => newId());
    for (let i = 0; i < 6; i++) {
      emitEvent(db, {
        kind: "task_node_opened",
        directive_id: directiveId,
        task_id: ids[i]!,
        payload: { goal: `chain-step-${i}` },
      });
      if (i > 0) {
        emitEvent(db, {
          kind: "task_edge_recorded",
          directive_id: directiveId,
          task_id: ids[i]!,
          payload: { from_task: ids[i - 1]!, to_task: ids[i]!, kind: "refines" },
        });
      }
    }
    // The deepest task is at depth=5. Dispatching it through high-residual
    // MUST hit the cap and emit task_failed instead of opening a 6th refine.
    const deepest = ids[5]!;
    const { nodes } = (await import("./task_topology")).readDagForDirective(db, directiveId);
    const deepNode = nodes.find((n) => n.id === deepest)!;
    expect(deepNode).toBeTruthy();

    const result = await dispatchReadyTask(db, deepNode, {
      bridge: opencodeQueryHighResidual,
    });
    expect(result.violations).toEqual([]);

    const failed = db
      .query(
        "SELECT failure_kind, residual FROM events WHERE kind = 'task_failed' AND task_id = ?",
      )
      .get(deepest) as { failure_kind: string; residual: number } | null;
    expect(failed).not.toBeNull();
    expect(failed!.failure_kind).toBe("refinement_depth_exceeded");
    expect(failed!.residual).toBe(1);

    // NO refinement edge should be emitted past the cap.
    const refinementEdges = db
      .query(
        "SELECT payload FROM events WHERE kind = 'task_edge_recorded' AND directive_id = ?",
      )
      .all(directiveId) as Array<{ payload: string }>;
    const newRefines = refinementEdges
      .map((r) => JSON.parse(r.payload) as Record<string, unknown>)
      .filter((p) => p.kind === "refines" && p.from_task === deepest);
    expect(newRefines.length).toBe(0);
  }, 30_000);
});
