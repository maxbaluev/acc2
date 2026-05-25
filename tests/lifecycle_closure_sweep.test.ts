// acc2 F3 — lifecycle closure sweep tests (2026-05-18).
//
// Validates the three terminator emission paths:
//   (a) proposal whose anchor file was deleted → closure_obsolete
//   (b) proposal already followed by applied_change_committed →
//       closure_complete
//   (c) owner_input_required older than 7 days → closure_owner_required
//
// Also asserts idempotency: re-running the sweep on already-closed
// lifecycles is a no-op (no duplicate terminator emissions).

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "../runtime/events";
import { runLifecycleClosureSweep } from "../runtime/lifecycle_closure_sweep";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const NOW = new Date("2026-05-18T12:00:00.000Z");
const DAYS_AGO = (n: number): Date => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

/** Insert an event with a specific ts so the sweep can reason about age
 *  without waiting real wall-clock time. */
const insertEventAtTs = (
  db: ReturnType<typeof openDb>,
  kind: string,
  ts: Date,
  payload: Record<string, unknown>,
  directiveId: string,
  taskId: string,
): string => {
  const row = emitEvent(db, {
    kind: kind as Parameters<typeof emitEvent>[1]["kind"],
    substrate_origin: "opencode",
    directive_id: directiveId,
    task_id: taskId,
    payload: payload as Parameters<typeof emitEvent>[1]["payload"],
  });
  // Force the ts column on the row we just inserted.
  db.run("UPDATE events SET ts = ? WHERE id = ?", [ts.toISOString(), row.id]);
  return row.id;
};

const terminatorsFor = (db: ReturnType<typeof openDb>, sourceId: string) =>
  db
    .query<{ kind: string; payload: string }, [string]>(
      `SELECT kind, payload FROM events
        WHERE kind IN ('closure_complete', 'closure_obsolete', 'closure_owner_required')
          AND context_refs LIKE ?`,
    )
    .all(`%${sourceId}%`);

describe("runLifecycleClosureSweep — terminator emissions", () => {
  test("(a) proposal whose anchor file no longer exists → closure_obsolete", async () => {
    const db = openDb(":memory:");
    const sourceId = insertEventAtTs(
      db,
      "contract_amendment_proposed",
      DAYS_AGO(2),
      {
        target_file: "runtime/nonexistent_module_that_was_deleted.ts",
        current_behavior: "described",
      },
      "dir_a",
      "task_a",
    );
    // Use a synthetic source root that exists but does NOT contain
    // the named anchor — so the anchor cannot resolve.
    const root = mkdtempSync(join(tmpdir(), "acc2-sweep-obsolete-"));
    try {
      const summary = await runLifecycleClosureSweep(db, { now: NOW, sourceCheckoutRoot: root });
      expect(summary.closure_obsolete_count).toBeGreaterThanOrEqual(1);
      const terminators = terminatorsFor(db, sourceId);
      const obsolete = terminators.find((t) => t.kind === "closure_obsolete");
      expect(obsolete).toBeDefined();
      const payload = JSON.parse(obsolete!.payload) as Record<string, unknown>;
      expect(payload.source_event_id).toBe(sourceId);
      expect(payload.obsolete_anchors).toEqual(["runtime/nonexistent_module_that_was_deleted.ts"]);
    } finally {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  test("(b) proposal already followed by applied_change_committed → closure_complete", async () => {
    const db = openDb(":memory:");
    const root = mkdtempSync(join(tmpdir(), "acc2-sweep-complete-"));
    try {
      // Anchor that DOES exist so obsolete path doesn't compete.
      writeFileSync(join(root, "real_file.ts"), "// existing source", "utf8");
      const sourceId = insertEventAtTs(
        db,
        "contract_amendment_proposed",
        DAYS_AGO(2),
        { target_file: "real_file.ts" },
        "dir_b",
        "task_b",
      );
      // Emit applied_change_committed citing the proposal.
      emitEvent(db, {
        kind: "applied_change_committed",
        substrate_origin: "claude_root",
        directive_id: "dir_b",
        task_id: "task_b",
        context_refs: [sourceId],
        payload: { status: "ok", target_path: "real_file.ts" },
      });

      const summary = await runLifecycleClosureSweep(db, { now: NOW, sourceCheckoutRoot: root });
      expect(summary.closure_complete_count).toBeGreaterThanOrEqual(1);
      const terminators = terminatorsFor(db, sourceId);
      const complete = terminators.find((t) => t.kind === "closure_complete");
      expect(complete).toBeDefined();
      const payload = JSON.parse(complete!.payload) as Record<string, unknown>;
      expect(payload.resolution_kind).toBe("applied_change_committed");
    } finally {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  test("(c) owner_input_required older than 7 days → closure_owner_required", async () => {
    const db = openDb(":memory:");
    const sourceId = insertEventAtTs(
      db,
      "owner_input_required",
      DAYS_AGO(8),
      { reason: "auth_expired", summary: "please refresh credentials" },
      "dir_c",
      "task_c",
    );
    const summary = await runLifecycleClosureSweep(db, { now: NOW });
    expect(summary.closure_owner_required_count).toBeGreaterThanOrEqual(1);
    const terminators = terminatorsFor(db, sourceId);
    const owner = terminators.find((t) => t.kind === "closure_owner_required");
    expect(owner).toBeDefined();
    const payload = JSON.parse(owner!.payload) as Record<string, unknown>;
    expect(payload.source_kind).toBe("owner_input_required");
    expect(payload.reason).toBe("owner_response_expired_7d");
  });

  test("idempotency: re-running the sweep on already-closed lifecycles emits no duplicates", async () => {
    const db = openDb(":memory:");
    const sourceId = insertEventAtTs(
      db,
      "owner_input_required",
      DAYS_AGO(8),
      { reason: "auth_expired" },
      "dir_d",
      "task_d",
    );
    const first = await runLifecycleClosureSweep(db, { now: NOW });
    expect(first.closure_owner_required_count).toBeGreaterThanOrEqual(1);
    const before = terminatorsFor(db, sourceId).length;
    const second = await runLifecycleClosureSweep(db, { now: NOW });
    expect(second.closure_owner_required_count).toBe(0);
    const after = terminatorsFor(db, sourceId).length;
    expect(after).toBe(before);
  });

  test("dryRun mode returns counts WITHOUT emitting terminator rows", async () => {
    const db = openDb(":memory:");
    insertEventAtTs(
      db,
      "owner_input_required",
      DAYS_AGO(8),
      { reason: "auth_expired" },
      "dir_e",
      "task_e",
    );
    const dryRun = await runLifecycleClosureSweep(db, { now: NOW, dryRun: true });
    expect(dryRun.closure_owner_required_count).toBeGreaterThanOrEqual(1);
    const persisted = db
      .query<{ c: number }, []>(
        "SELECT COUNT(*) AS c FROM events WHERE kind IN ('closure_complete','closure_obsolete','closure_owner_required')",
      )
      .get();
    expect(persisted?.c).toBe(0);
  });

  // ── Ancestor-progress crediting (amendment ancestor_progress_crediting) ──
  // A stuck-aged root with a recently-progressing DESCENDANT must NOT be swept
  // to obsolete/owner-required; a truly idle subtree still IS.

  /** Like insertEventAtTs but also stamps parent_task_id, so we can build a
   *  decomposition subtree the sweep must walk. */
  const insertChildEventAtTs = (
    db: ReturnType<typeof openDb>,
    kind: string,
    ts: Date,
    payload: Record<string, unknown>,
    directiveId: string,
    taskId: string,
    parentTaskId: string | null,
  ): string => {
    const row = emitEvent(db, {
      kind: kind as Parameters<typeof emitEvent>[1]["kind"],
      substrate_origin: "opencode",
      directive_id: directiveId,
      task_id: taskId,
      parent_task_id: parentTaskId ?? undefined,
      payload: payload as Parameters<typeof emitEvent>[1]["payload"],
    });
    db.run("UPDATE events SET ts = ? WHERE id = ?", [ts.toISOString(), row.id]);
    return row.id;
  };

  test("(d) aged-open root with a RECENTLY-progressing descendant is NOT swept stuck", async () => {
    const db = openDb(":memory:");
    // Root opened 8 days ago (well past the 24h/7d thresholds), no terminator.
    const rootOpen = insertChildEventAtTs(
      db,
      "task_node_opened",
      DAYS_AGO(8),
      { goal: "deep graph root" },
      "dir_alive",
      "root_alive",
      null,
    );
    // A child opened under the root, also long ago.
    insertChildEventAtTs(
      db,
      "task_node_opened",
      DAYS_AGO(8),
      { goal: "phase C child" },
      "dir_alive",
      "child_alive",
      "root_alive",
    );
    // The child committed a deliverable JUST NOW (5 min before NOW) — well
    // inside the 1h ancestor-progress quiet window.
    insertChildEventAtTs(
      db,
      "knowledge_candidate",
      new Date(NOW.getTime() - 5 * 60 * 1000),
      { claim: "phase C lesson", confidence: 0.9 },
      "dir_alive",
      "child_alive",
      "root_alive",
    );

    const summary = await runLifecycleClosureSweep(db, { now: NOW });
    // No terminator for the root: descendant progress kept it alive.
    const rootTerminators = terminatorsFor(db, rootOpen);
    expect(rootTerminators.length).toBe(0);
  });

  test("(e) aged-open root with a TRULY IDLE subtree (no recent descendant progress) IS swept", async () => {
    const db = openDb(":memory:");
    const rootOpen = insertChildEventAtTs(
      db,
      "task_node_opened",
      DAYS_AGO(8),
      { goal: "deep graph root" },
      "dir_idle",
      "root_idle",
      null,
    );
    // Child opened long ago; its last structural progress is also 8 days ago —
    // far outside the 1h quiet window, so the subtree is genuinely idle.
    insertChildEventAtTs(
      db,
      "task_node_opened",
      DAYS_AGO(8),
      { goal: "phase C child" },
      "dir_idle",
      "child_idle",
      "root_idle",
    );
    insertChildEventAtTs(
      db,
      "knowledge_candidate",
      DAYS_AGO(8),
      { claim: "stale lesson", confidence: 0.9 },
      "dir_idle",
      "child_idle",
      "root_idle",
    );

    const summary = await runLifecycleClosureSweep(db, { now: NOW });
    // The idle root gets swept (directive still open → owner_required).
    const rootTerminators = terminatorsFor(db, rootOpen);
    expect(rootTerminators.length).toBeGreaterThanOrEqual(1);
    expect(rootTerminators.some((t) => t.kind === "closure_owner_required")).toBe(true);
  });
});
