import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../../substrate/db";
import { openFixtureDCountTodos } from "./d_count_todos";
import { schedulerTick } from "../task_scheduler";

afterAll(() => closeDb());
beforeEach(() => closeDb());

describe("fixture_d_count_todos — Phase D MVP end-to-end", () => {
  test("directive opens → brain dispatches → action runs → verifier scores → task commits", async () => {
    const db = openDb(":memory:");
    const tempDir = mkdtempSync(join(tmpdir(), "acc2-fixD-"));
    // Three files: two contain TODO, one does not. Plus a nested dir to
    // exercise the recursive walker.
    writeFileSync(join(tempDir, "alpha.txt"), "// TODO implement me", "utf-8");
    writeFileSync(join(tempDir, "beta.txt"), "no marker", "utf-8");
    mkdirSync(join(tempDir, "nested"), { recursive: true });
    writeFileSync(join(tempDir, "nested", "gamma.txt"), "another TODO here", "utf-8");

    try {
      const { directiveId, taskId } = await openFixtureDCountTodos(db, tempDir);

      const tick = await schedulerTick(db, { fixtureTargetPath: tempDir });
      expect(tick.dispatched).toContain(taskId);

      // Required canonical event presence — one row each.
      const kinds = [
        "directive_opened",
        "task_node_opened",
        "brain_dispatched",
        "brain_dispatch_closed",
        "action_predicted",
        "artifact_invoked",
        "artifact_observed",
        "action_scored",
        "task_committed",
      ];
      for (const k of kinds) {
        const row = db
          .query("SELECT COUNT(*) as c FROM events WHERE kind = ? AND directive_id = ?")
          .get(k, directiveId) as { c: number };
        expect({ kind: k, count: row.c }).toEqual({ kind: k, count: expect.any(Number) });
        expect(row.c).toBeGreaterThan(0);
      }

      // Residual must be 0 (verifier returns 0 when count is integer ≥ 0).
      const scored = db
        .query(
          "SELECT residual, payload FROM events WHERE kind = 'action_scored' AND directive_id = ?",
        )
        .get(directiveId) as { residual: number; payload: string };
      expect(scored.residual).toBe(0);

      // The action's result envelope must report count >= 2 (two TODO files
      // — alpha.txt and nested/gamma.txt).
      const payload = JSON.parse(scored.payload) as Record<string, unknown>;
      const actionResult = payload.action_result as { result: { count: number } } | null;
      expect(actionResult).not.toBeNull();
      expect(actionResult!.result.count).toBeGreaterThanOrEqual(2);

      // No refinement edges emitted — the directive closes in a single dispatch.
      const refinements = db
        .query(
          "SELECT payload FROM events WHERE kind = 'task_edge_recorded' AND directive_id = ?",
        )
        .all(directiveId) as Array<{ payload: string }>;
      const refinesCount = refinements.filter((r) => {
        try {
          const p = JSON.parse(r.payload) as Record<string, unknown>;
          return p.kind === "refines";
        } catch {
          return false;
        }
      }).length;
      expect(refinesCount).toBe(0);

      // No dispatcher_violation rows.
      const violations = db
        .query(
          "SELECT COUNT(*) as c FROM events WHERE kind = 'dispatcher_violation' AND directive_id = ?",
        )
        .get(directiveId) as { c: number };
      expect(violations.c).toBe(0);

      // task_committed has residual = 0.
      const committed = db
        .query(
          "SELECT residual FROM events WHERE kind = 'task_committed' AND directive_id = ?",
        )
        .get(directiveId) as { residual: number };
      expect(committed.residual).toBe(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 60_000);
});
