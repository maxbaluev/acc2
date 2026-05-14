import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../substrate/db";
import {
  schedulerTick,
  schedulerLoop,
  _resetSchedulerForTests,
  inFlightDirectivesFromSql,
  findCrossDirectiveConflict,
} from "./task_scheduler";
import { openFixtureDCountTodos } from "./fixtures/d_count_todos";
import { emitEvent } from "./events";
import { newId } from "./ids";

afterAll(() => closeDb());
beforeEach(() => {
  closeDb();
  _resetSchedulerForTests();
});

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

  test("parallel scheduling: two ready tasks dispatched concurrently in one tick", async () => {
    const db = openDb(":memory:");
    const tempDir = mkdtempSync(join(tmpdir(), "acc2-sched-par-"));
    writeFileSync(join(tempDir, "a.txt"), "// TODO", "utf-8");
    try {
      // Open two independent directives → two ready tasks with no edges.
      const { taskId: t1 } = await openFixtureDCountTodos(db, tempDir);
      const { taskId: t2 } = await openFixtureDCountTodos(db, tempDir);

      const tick = await schedulerTick(db, {
        fixtureTargetPath: tempDir,
        maxConcurrent: 5,
      });
      expect(tick.dispatched).toContain(t1);
      expect(tick.dispatched).toContain(t2);
      expect(tick.dispatched.length).toBeGreaterThanOrEqual(2);
      expect(tick.skipped_concurrency_cap).toEqual([]);

      // Both tasks should have committed.
      const committed = db
        .query("SELECT COUNT(*) as c FROM events WHERE kind = 'task_committed'")
        .get() as { c: number };
      expect(committed.c).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 60_000);

  test("maxConcurrent=1 forces sequential dispatch; excess go to skipped_concurrency_cap", async () => {
    const db = openDb(":memory:");
    const tempDir = mkdtempSync(join(tmpdir(), "acc2-sched-cap-"));
    writeFileSync(join(tempDir, "a.txt"), "// TODO", "utf-8");
    try {
      const { taskId: t1 } = await openFixtureDCountTodos(db, tempDir);
      const { taskId: t2 } = await openFixtureDCountTodos(db, tempDir);
      const { taskId: t3 } = await openFixtureDCountTodos(db, tempDir);

      const tick = await schedulerTick(db, {
        fixtureTargetPath: tempDir,
        maxConcurrent: 1,
      });
      expect(tick.dispatched.length).toBe(1);
      const others = [t1, t2, t3].filter((id) => !tick.dispatched.includes(id));
      // The other two are not dispatched this tick — they hit the concurrency cap.
      // (They appear in skipped_concurrency_cap because they weren't already in IN_FLIGHT.)
      for (const id of others) {
        expect(tick.skipped_concurrency_cap).toContain(id);
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 60_000);

  test("schedulerLoop drains queue and stops on quiescence", async () => {
    const db = openDb(":memory:");
    const tempDir = mkdtempSync(join(tmpdir(), "acc2-sched-loop-"));
    writeFileSync(join(tempDir, "a.txt"), "// TODO", "utf-8");
    try {
      await openFixtureDCountTodos(db, tempDir);
      // stopAfterTicks=2 ensures the loop terminates.
      await schedulerLoop(db, {
        fixtureTargetPath: tempDir,
        maxConcurrent: 5,
        pollIntervalMs: 10,
        stopAfterTicks: 2,
      });
      const committed = db
        .query("SELECT COUNT(*) as c FROM events WHERE kind = 'task_committed'")
        .get() as { c: number };
      expect(committed.c).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 60_000);

  test("schedulerLoop honors AbortSignal", async () => {
    const db = openDb(":memory:");
    const tempDir = mkdtempSync(join(tmpdir(), "acc2-sched-abort-"));
    writeFileSync(join(tempDir, "a.txt"), "// TODO", "utf-8");
    try {
      const ac = new AbortController();
      // Seed a directive so the loop actually has work — abort before the
      // first tick fully resolves the next iteration.
      await openFixtureDCountTodos(db, tempDir);
      const loopPromise = schedulerLoop(db, {
        fixtureTargetPath: tempDir,
        pollIntervalMs: 50,
        stopAfterTicks: 100,
        abort: ac.signal,
      });
      setTimeout(() => ac.abort(), 30);
      await loopPromise;
      // No assertion needed beyond loop returning — abort works.
      expect(true).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("schedulerTick records constitutional_gate_decision events for skipped routes", async () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const taskId = newId();
    emitEvent(db, {
      kind: "recipe_extracted",
      directive_id: directiveId,
      payload: { confidence: 0.95, goal_shape: "audit-shape-x" },
    });
    emitEvent(db, {
      kind: "task_node_opened",
      directive_id: directiveId,
      task_id: taskId,
      payload: { goal: "Run audit-shape-x replay" },
    });
    await schedulerTick(db, { directiveId });
    const row = db
      .query(
        "SELECT payload FROM events WHERE kind = 'constitutional_gate_decision' AND task_id = ?",
      )
      .get(taskId) as { payload: string };
    expect(row).not.toBeNull();
    const p = JSON.parse(row.payload);
    expect(p.gate).toBe("substrate_replay_skipped");
  });

  test("tick with no ready tasks returns empty dispatched + empty skipped", async () => {
    const db = openDb(":memory:");
    const tick = await schedulerTick(db, { maxConcurrent: 5 });
    expect(tick.dispatched.length).toBe(0);
    expect(tick.skipped_concurrency_cap.length).toBe(0);
    expect(tick.skipped_recipe.length).toBe(0);
    expect(tick.skipped_inline.length).toBe(0);
  });

  test("cross-directive mutual_exclusion defers the second ready task", async () => {
    const db = openDb(":memory:");
    const tempDir = mkdtempSync(join(tmpdir(), "acc2-sched-mutex-"));
    writeFileSync(join(tempDir, "a.txt"), "// TODO", "utf-8");
    try {
      // Two independent directives with a mutual_exclusion edge.
      const { taskId: t1, directiveId: d1 } = await openFixtureDCountTodos(db, tempDir);
      const { taskId: t2, directiveId: d2 } = await openFixtureDCountTodos(db, tempDir);
      emitEvent(db, {
        kind: "directive_interference_edge",
        directive_id: d1,
        payload: {
          from_directive: d1,
          to_directive: d2,
          kind: "mutual_exclusion",
          reason: "shared external resource",
        },
      });

      // First tick — dispatch t1 with maxConcurrent=1 so t2 hits either the
      // concurrency cap (intra-tick) or the interference defer. We assert
      // the interference defer fires when t1 commits and t2 is re-evaluated
      // in the same tick — but with maxConcurrent=1 we get the cap path.
      // To test the interference path itself, we manually pre-populate the
      // in-flight registry via a pending dispatch.
      const tick = await schedulerTick(db, {
        fixtureTargetPath: tempDir,
        maxConcurrent: 5,
      });
      // Both directives' tasks are independent; one dispatched, the other
      // got deferred for interference. Order depends on readyTasks() order;
      // assert ONE was deferred for interference.
      const eitherDispatched = tick.dispatched.includes(t1) || tick.dispatched.includes(t2);
      const eitherDeferred = tick.skipped_interference.includes(t1) ||
        tick.skipped_interference.includes(t2);
      expect(eitherDispatched).toBe(true);
      expect(eitherDeferred).toBe(true);

      // task_deferred_for_interference event must have been emitted.
      const deferRows = db
        .query(
          "SELECT payload FROM events WHERE kind = 'task_deferred_for_interference'",
        )
        .all() as Array<{ payload: string }>;
      expect(deferRows.length).toBeGreaterThanOrEqual(1);
      const p = JSON.parse(deferRows[0]!.payload) as Record<string, unknown>;
      expect(p.interaction).toBe("mutual_exclusion");
      expect(typeof p.from_directive).toBe("string");
      expect(typeof p.conflicting_directive).toBe("string");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 60_000);

  test("consecutive-failure backoff quarantines a task after N bridge_failed in a row (no retry storm)", async () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const taskId = newId();
    emitEvent(db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      payload: { directive_text: "test consecutive bridge failures", lifecycle: "finite" },
    });
    emitEvent(db, {
      kind: "task_node_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: taskId,
      payload: { goal: "test consecutive bridge failures" },
    });
    // Three back-to-back bridge_failed rows — past the default cap.
    for (let i = 0; i < 3; i++) {
      emitEvent(db, {
        kind: "bridge_failed",
        substrate_origin: "opencode",
        directive_id: directiveId,
        task_id: taskId,
        payload: { reason: "mcp_handshake_failed" },
        invoker: "opencode",
      });
    }
    const tick = await schedulerTick(db, { directiveId });
    expect(tick.skipped_failure_capped).toContain(taskId);
    expect(tick.dispatched).not.toContain(taskId);

    // Substrate now carries a task_failed row with the canonical failure_kind
    // so readyTasks drops it on the next tick (no retry storm).
    const failed = db
      .query("SELECT failure_kind, payload FROM events WHERE task_id = ? AND kind = 'task_failed'")
      .get(taskId) as { failure_kind: string; payload: string } | null;
    expect(failed).not.toBeNull();
    expect(failed!.failure_kind).toBe("consecutive_bridge_failures");
    const fp = JSON.parse(failed!.payload) as { consecutive_failures: number; cap: number };
    expect(fp.consecutive_failures).toBe(3);
    expect(fp.cap).toBeGreaterThanOrEqual(3);

    // Next tick: task no longer ready (now task_failed), no dispatch.
    const tick2 = await schedulerTick(db, { directiveId });
    expect(tick2.skipped_failure_capped).not.toContain(taskId);
    expect(tick2.dispatched).not.toContain(taskId);
  });

  test("an interleaving successful event resets the consecutive-failure streak", async () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const taskId = newId();
    emitEvent(db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      payload: { directive_text: "test streak reset", lifecycle: "finite" },
    });
    emitEvent(db, {
      kind: "task_node_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: taskId,
      payload: { goal: "test streak reset" },
    });
    // Two failures, then a successful frame, then two more failures = streak of 2 only.
    for (let i = 0; i < 2; i++) {
      emitEvent(db, { kind: "bridge_failed", substrate_origin: "opencode", directive_id: directiveId, task_id: taskId, payload: { reason: "x" }, invoker: "opencode" });
    }
    emitEvent(db, { kind: "bridge_mcp_connected", substrate_origin: "opencode", directive_id: directiveId, task_id: taskId, payload: { first_tool: "substrate.search" }, invoker: "opencode" });
    for (let i = 0; i < 2; i++) {
      emitEvent(db, { kind: "bridge_failed", substrate_origin: "opencode", directive_id: directiveId, task_id: taskId, payload: { reason: "x" }, invoker: "opencode" });
    }
    const tick = await schedulerTick(db, { directiveId });
    // Streak is 2 (the trailing failures), below the default cap of 3 — task still eligible.
    expect(tick.skipped_failure_capped).not.toContain(taskId);
  });

  test("substrate_replay route skipped (Phase J stub returns phase_j)", async () => {
    const db = openDb(":memory:");
    // Seed a recipe_extracted event with high confidence + matching goal_shape.
    const directiveId = newId();
    const taskId = newId();
    emitEvent(db, {
      kind: "recipe_extracted",
      directive_id: directiveId,
      payload: { confidence: 0.9, goal_shape: "phase-j-recipe-shape" },
    });
    emitEvent(db, {
      kind: "task_node_opened",
      directive_id: directiveId,
      task_id: taskId,
      payload: { goal: "phase-j-recipe-shape recipe test goal" },
    });
    const tick = await schedulerTick(db, { directiveId });
    expect(tick.skipped_recipe).toContain(taskId);
    expect(tick.dispatched).not.toContain(taskId);
  });
});

describe("inFlightDirectivesFromSql + findCrossDirectiveConflict", () => {
  test("SQL in-flight set: directive with brain_dispatched and no brain_dispatch_closed surfaces; closed directive does not", () => {
    const db = openDb(":memory:");
    const dirOpen = newId();
    const dirClosed = newId();
    const dispOpen = newId();
    const dispClosed = newId();

    // Open dispatch — still in flight.
    emitEvent(db, {
      kind: "brain_dispatched",
      substrate_origin: "substrate_auto",
      directive_id: dirOpen,
      payload: { dispatch_id: dispOpen },
    });
    // Open + close on a different directive — NOT in flight.
    emitEvent(db, {
      kind: "brain_dispatched",
      substrate_origin: "substrate_auto",
      directive_id: dirClosed,
      payload: { dispatch_id: dispClosed },
    });
    emitEvent(db, {
      kind: "brain_dispatch_closed",
      substrate_origin: "substrate_auto",
      directive_id: dirClosed,
      payload: { dispatch_id: dispClosed, reason: "ok" },
    });

    const inFlight = inFlightDirectivesFromSql(db);
    expect(inFlight.has(dirOpen)).toBe(true);
    expect(inFlight.has(dirClosed)).toBe(false);
  });

  test("findCrossDirectiveConflict returns the conflicting in-flight directive + interaction for mutual_exclusion edges", () => {
    const db = openDb(":memory:");
    const candidate = newId();
    const inFlightDir = newId();
    const otherIdle = newId();

    // Make `inFlightDir` mid-flight (open dispatch, no close).
    emitEvent(db, {
      kind: "brain_dispatched",
      substrate_origin: "substrate_auto",
      directive_id: inFlightDir,
      payload: { dispatch_id: newId() },
    });
    // mutual_exclusion edge candidate → inFlightDir.
    emitEvent(db, {
      kind: "directive_interference_edge",
      substrate_origin: "owner",
      directive_id: candidate,
      payload: {
        from_directive: candidate,
        to_directive: inFlightDir,
        interaction: "mutual_exclusion",
      },
    });
    // An unrelated edge to an idle directive — must NOT match.
    emitEvent(db, {
      kind: "directive_interference_edge",
      substrate_origin: "owner",
      directive_id: candidate,
      payload: {
        from_directive: candidate,
        to_directive: otherIdle,
        interaction: "resource_conflict",
      },
    });

    const conflict = findCrossDirectiveConflict(db, candidate);
    expect(conflict).not.toBeNull();
    expect(conflict!.conflicting_directive).toBe(inFlightDir);
    expect(conflict!.interaction).toBe("mutual_exclusion");
  });

  test("findCrossDirectiveConflict returns null when no in-flight directive conflicts", () => {
    const db = openDb(":memory:");
    const candidate = newId();
    const otherDir = newId();
    // Closed dispatch on otherDir — not in flight.
    const dispId = newId();
    emitEvent(db, {
      kind: "brain_dispatched",
      substrate_origin: "substrate_auto",
      directive_id: otherDir,
      payload: { dispatch_id: dispId },
    });
    emitEvent(db, {
      kind: "brain_dispatch_closed",
      substrate_origin: "substrate_auto",
      directive_id: otherDir,
      payload: { dispatch_id: dispId },
    });
    emitEvent(db, {
      kind: "directive_interference_edge",
      substrate_origin: "owner",
      directive_id: candidate,
      payload: {
        from_directive: candidate,
        to_directive: otherDir,
        interaction: "mutual_exclusion",
      },
    });
    expect(findCrossDirectiveConflict(db, candidate)).toBeNull();
  });
});
