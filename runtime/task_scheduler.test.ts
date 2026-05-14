import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../substrate/db";
import { schedulerTick } from "./task_scheduler";
import { openFixtureDCountTodos } from "./fixtures/d_count_todos";

afterAll(() => closeDb());
beforeEach(() => closeDb());

describe("task_scheduler", () => {
  test("single tick dispatches the first ready task", async () => {
    const db = openDb(":memory:");
    const tempDir = mkdtempSync(join(tmpdir(), "acc2-sched-"));
    writeFileSync(join(tempDir, "a.txt"), "no marker here", "utf-8");
    writeFileSync(join(tempDir, "b.txt"), "// TODO fix me", "utf-8");
    try {
      const { taskId } = await openFixtureDCountTodos(db, tempDir);
      const tick = await schedulerTick(db, { fixtureTargetPath: tempDir });
      expect(tick.dispatched).toContain(taskId);
      expect(tick.skipped_recipe).toEqual([]);
      expect(tick.skipped_inline).toEqual([]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 60_000);
});
