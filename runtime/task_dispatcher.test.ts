import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../substrate/db";
import { dispatchReadyTask } from "./task_dispatcher";
import { opencodeQueryAdversarialCycle2 } from "./bridge";
import { readyTasks } from "./task_topology";
import { openFixtureDCountTodos } from "./fixtures/d_count_todos";

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
});
