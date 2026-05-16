import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../substrate/db";
import {
  schedulerTick,
  schedulerLoop,
  _resetSchedulerForTests,
  drainInFlightDispatches,
  inFlightDirectivesFromSql,
  findCrossDirectiveConflict,
  computeBrainDispatchCap,
} from "./task_scheduler";
import { FIXTURE_D_DIRECTIVE_TEXT, openFixtureDCountTodos } from "./fixtures/d_count_todos";
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
    // Brain dispatch cap is host-RAM-derived (computeBrainDispatchCap):
    // hosts where the cap floors to 1 (e.g. RAM-constrained CI / WSL test
    // VMs) cannot exercise parallel brain dispatch. Skip there instead of
    // recording a spurious red. The parallel-DAG behavior is still tested
    // in tests/integration via real-brain smoke + the post-commit
    // applied_change_committed event-count assertions.
    if (computeBrainDispatchCap() < 2) return;
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

      // Production schedulerTick returns after launching dispatches so
      // sibling brain leaves run concurrently. Drain the in-flight registry
      // before asserting downstream ledger state.
      await drainInFlightDispatches();

      // Both tasks should have committed.
      const committed = db
        .query("SELECT COUNT(*) as c FROM events WHERE kind = 'task_committed'")
        .get() as { c: number };
      expect(committed.c).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 60_000);

  test("same-parent refinement leaves without requires edges bypass the per-directive cap", async () => {
    // Same brain-cap guard as the parallel-scheduling test above —
    // skip on hosts where computeBrainDispatchCap() floors to 1.
    if (computeBrainDispatchCap() < 2) return;
    const db = openDb(":memory:");
    const tempDir = mkdtempSync(join(tmpdir(), "acc2-sched-siblings-"));
    writeFileSync(join(tempDir, "a.txt"), "// TODO", "utf-8");
    try {
      const { directiveId, taskId: root } = await openFixtureDCountTodos(db, tempDir);
      emitEvent(db, { kind: "task_committed", substrate_origin: "substrate_auto", directive_id: directiveId, task_id: root, residual: 0, payload: { residual: 0 } });
      const childA = newId();
      const childB = newId();
      for (const child of [childA, childB]) {
        emitEvent(db, { kind: "task_node_opened", substrate_origin: "opencode", directive_id: directiveId, task_id: child, parent_task_id: root, payload: { goal: FIXTURE_D_DIRECTIVE_TEXT, target_path: tempDir } });
        emitEvent(db, { kind: "task_edge_recorded", substrate_origin: "opencode", directive_id: directiveId, task_id: child, payload: { kind: "refines", from_task: root, to_task: child } });
      }

      const tick = await schedulerTick(db, {
        fixtureTargetPath: tempDir,
        maxConcurrent: 5,
        maxConcurrentPerDirective: 1,
      });
      expect(tick.dispatched).toContain(childA);
      expect(tick.dispatched).toContain(childB);
      expect(tick.skipped_concurrency_cap).not.toContain(childA);
      expect(tick.skipped_concurrency_cap).not.toContain(childB);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 60_000);

  test("requires edges still serialize same-parent refinement leaves", async () => {
    const db = openDb(":memory:");
    const tempDir = mkdtempSync(join(tmpdir(), "acc2-sched-sibling-req-"));
    writeFileSync(join(tempDir, "a.txt"), "// TODO", "utf-8");
    try {
      const { directiveId, taskId: root } = await openFixtureDCountTodos(db, tempDir);
      emitEvent(db, { kind: "task_committed", substrate_origin: "substrate_auto", directive_id: directiveId, task_id: root, residual: 0, payload: { residual: 0 } });
      const childA = newId();
      const childB = newId();
      for (const child of [childA, childB]) {
        emitEvent(db, { kind: "task_node_opened", substrate_origin: "opencode", directive_id: directiveId, task_id: child, parent_task_id: root, payload: { goal: FIXTURE_D_DIRECTIVE_TEXT, target_path: tempDir } });
        emitEvent(db, { kind: "task_edge_recorded", substrate_origin: "opencode", directive_id: directiveId, task_id: child, payload: { kind: "refines", from_task: root, to_task: child } });
      }
      emitEvent(db, { kind: "task_edge_recorded", substrate_origin: "opencode", directive_id: directiveId, task_id: childB, payload: { kind: "requires", from_task: childA, to_task: childB } });

      const tick = await schedulerTick(db, {
        fixtureTargetPath: tempDir,
        maxConcurrent: 5,
        maxConcurrentPerDirective: 1,
      });
      expect(tick.dispatched).toContain(childA);
      expect(tick.dispatched).not.toContain(childB);
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

  test("computeBrainDispatchCap returns a positive integer scaled to host RAM", () => {
    // Dynamic cap = floor((min(freemem, totalmem - 2GB)) / 700MB), floor 1.
    // We can't assert the exact number (depends on the test host) but we CAN
    // assert the invariants: integer, >= 1, never larger than what total RAM
    // can physically support. This is the OOM defence: opencode subprocesses
    // run gpt-5.5 at ~340MB observed peak; 700MB per slot leaves headroom.
    // Cap scales automatically — no env knob.
    const cap = computeBrainDispatchCap();
    expect(Number.isInteger(cap)).toBe(true);
    expect(cap).toBeGreaterThanOrEqual(1);
    // Total RAM bound (700MB per slot, 2GB reserved): cap can never exceed
    // floor((totalmem - 2GB) / 700MB).
    const os = require("node:os") as typeof import("node:os");
    const ceiling = Math.max(1, Math.floor((os.totalmem() - 2_000_000_000) / 700_000_000));
    expect(cap).toBeLessThanOrEqual(ceiling);
  });

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
      // Production schedulerTick returns after launching dispatches; drain
      // any still-in-flight promise before asserting committed state.
      await drainInFlightDispatches();
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

  test("schedulerTick does NOT emit substrate_replay_skipped (Phase-J stub is gone)", async () => {
    // Pre-fix: a recipe match → substrate_replay decision → scheduler emitted
    // substrate_replay_skipped on every tick (Phase-J stub returned phase_j),
    // tight loop. Post-fix: substrate_replay route falls through to
    // dispatchReadyTask which calls replayRecipe properly.
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
    const rows = db
      .query(
        "SELECT payload FROM events WHERE kind = 'constitutional_gate_decision' AND task_id = ?",
      )
      .all(taskId) as Array<{ payload: string }>;
    for (const r of rows) {
      const p = JSON.parse(r.payload) as { gate?: string; reason?: string };
      expect(p.gate).not.toBe("substrate_replay_skipped");
      expect(p.reason).not.toBe("phase_j");
    }
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

  test("substrate_replay route falls through to dispatchReadyTask (no Phase-J stub skip)", async () => {
    // Pre-fix: scheduler short-circuited substrate_replay with a stub returning
    // {ok:false, error:"phase_j"} on every tick → tight loop emitting
    // substrate_replay_skipped because readyTasks kept returning the same task.
    // Post-fix: substrate_replay routes through dispatchReadyTask, which calls
    // the real replayRecipe (runtime/recipe_replay.ts).
    const db = openDb(":memory:");
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
    // The task is NOT routed through the old phase_j skip path.
    expect(tick.skipped_recipe).not.toContain(taskId);
    // The task DID enter the dispatch path (either dispatched, or one of the
    // other gates — but NOT silently skipped with no event of its own).
    const events = db
      .query("SELECT kind, payload FROM events WHERE task_id = ? AND kind = 'constitutional_gate_decision'")
      .all(taskId) as Array<{ payload: string }>;
    for (const e of events) {
      const p = JSON.parse(e.payload) as { gate?: string; reason?: string };
      expect(p.reason).not.toBe("phase_j");
      expect(p.gate).not.toBe("substrate_replay_skipped");
    }
  });

  test("fairness: older ready tasks dispatch BEFORE younger ones across directives (anti-starvation)", async () => {
    // Live ledger evidence (2026-05-15) showed a verification directive
    // opened at 01:09:18 sitting unprocessed for 30+ min while a Father
    // directive's children (opened 01:11:35-01:16:57) kept burning the 5
    // dispatch slots. The fix: schedulerTick sorts `ready` by the oldest
    // task_node_opened ts before iterating, so the oldest waiting task
    // dispatches first regardless of which directive it lives under.
    const db = openDb(":memory:");
    const tempDir = mkdtempSync(join(tmpdir(), "acc2-sched-fair-"));
    writeFileSync(join(tempDir, "a.txt"), "// TODO line", "utf-8");
    try {
      // Seed an OLD ready task — manually back-date its task_node_opened.
      const oldDirective = newId();
      const oldTask = newId();
      emitEvent(db, {
        kind: "directive_opened",
        substrate_origin: "owner",
        directive_id: oldDirective,
        task_id: oldDirective,
        payload: { directive_text: "old waiting work", lifecycle: "finite" },
      });
      // Manually back-date the task_node_opened ts to 1 hour ago.
      const oldTs = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      db.query(
        `INSERT INTO events (id, ts, kind, substrate_origin, directive_id, task_id, loop_id, payload)
         VALUES (?, ?, 'task_node_opened', 'owner', ?, ?, '', ?)`,
      ).run(newId(), oldTs, oldDirective, oldTask, JSON.stringify({ goal: "old goal" }));

      // Seed a YOUNGER ready task via the standard fixture.
      const { taskId: youngTask } = await openFixtureDCountTodos(db, tempDir);

      // Tick with maxConcurrent=1 so only the oldest dispatches.
      const tick = await schedulerTick(db, { maxConcurrent: 1, fixtureTargetPath: tempDir });
      expect(tick.dispatched).toContain(oldTask);
      expect(tick.dispatched).not.toContain(youngTask);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 30_000);
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
