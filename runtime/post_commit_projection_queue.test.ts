// Deadlock-safety acceptance tests for the non-blocking post-commit
// projection queue (directive NHY908W0EX5Q72KGWXMASPFEY0, amendments
// B0DVM2APWX + 9J0CSDP7ND, 2026-05-24).
//
// Each test maps to one of the directive's deadlock-safety invariants:
//   (a) DURABILITY BEFORE ACK     — emit/enqueue returns before any drain.
//   (b) NO DROPPED EVENTS / ORDER — every enqueued task runs exactly once,
//                                   in strict FIFO order, even under overlap.
//   (c) FIRE-ONCE WATCHDOG        — a wedged drain fires the watchdog once.
//   (d) BOUNDED + BACKPRESSURE    — enqueue past the cap is rejected with a
//                                   loud overflow signal, never silent/OOM.

import { describe, expect, test } from "bun:test";
import {
  PostCommitProjectionQueue,
  type PostCommitQueueConfig,
  type QueueClock,
  type QueueSinks,
} from "./post_commit_projection_queue";

const cfg = (over: Partial<PostCommitQueueConfig> = {}): PostCommitQueueConfig => ({
  maxEventsPerSlice: 25,
  maxWallMsPerSlice: 20,
  maxQueueDepth: 50_000,
  watchdogMs: 30_000,
  ...over,
});

const noSinks = (): QueueSinks => ({ onOverflow: () => {}, onWatchdog: () => {} });

/** Deterministic injected clock + timer registry the tests drive by hand. */
const makeClock = () => {
  let nowMs = 0;
  const timers: Array<{ id: number; cb: () => void; dueAt: number }> = [];
  let nextId = 1;
  const clock: QueueClock = {
    now: () => nowMs,
    setTimeout: (cb, ms) => {
      const id = nextId++;
      timers.push({ id, cb, dueAt: nowMs + ms });
      return id;
    },
    clearTimeout: (handle) => {
      const idx = timers.findIndex((t) => t.id === handle);
      if (idx >= 0) timers.splice(idx, 1);
    },
  };
  return {
    clock,
    advance: (ms: number) => { nowMs += ms; },
    /** Fire every timer due at or before now, oldest first. Returns count. */
    flushDue: async (): Promise<number> => {
      let fired = 0;
      // Loop because a fired timer may schedule another due timer.
      for (let guard = 0; guard < 100_000; guard++) {
        const idx = timers.findIndex((t) => t.dueAt <= nowMs);
        if (idx < 0) break;
        const [t] = timers.splice(idx, 1);
        t.cb();
        fired++;
        // let any awaited microtask in a drain slice settle
        await Promise.resolve();
      }
      return fired;
    },
    pending: () => timers.length,
  };
};

describe("post-commit projection queue — durability-before-ack (a)", () => {
  test("enqueue returns synchronously before the first slice runs", async () => {
    const c = makeClock();
    const q = new PostCommitProjectionQueue(cfg(), noSinks(), c.clock);
    let ran = 0;
    // enqueue MUST return immediately; the task body MUST NOT have run yet
    // (the queue schedules a setTimeout(0) before the first slice).
    q.enqueue({ label: "t", sourceEventId: "e1", run: () => { ran++; } });
    expect(ran).toBe(0);
    expect(q.depth()).toBe(1);
    // Only after the event loop turns (the scheduled timer fires) does it run.
    await c.flushDue();
    expect(ran).toBe(1);
    expect(q.depth()).toBe(0);
  });
});

describe("post-commit projection queue — no dropped events + FIFO (b)", () => {
  test("every enqueued task runs exactly once in FIFO order, including a heavy cascade", async () => {
    const c = makeClock();
    // Tiny per-slice budget so the 1000-task cascade spans many slices and
    // must yield repeatedly — proves no task is dropped across yields.
    const q = new PostCommitProjectionQueue(cfg({ maxEventsPerSlice: 7, maxWallMsPerSlice: 1_000_000 }), noSinks(), c.clock);
    const order: number[] = [];
    for (let i = 0; i < 1000; i++) {
      q.enqueue({ label: `t${i}`, sourceEventId: `e${i}`, run: () => { order.push(i); } });
    }
    await c.flushDue();
    expect(order.length).toBe(1000);
    // Strict FIFO: order is 0..999 with no gaps or duplicates.
    expect(order).toEqual(Array.from({ length: 1000 }, (_, i) => i));
    expect(q.drainedCount()).toBe(1000);
    expect(q.depth()).toBe(0);
  });

  test("a task enqueued mid-drain (overlap) is appended to the tail, never lost", async () => {
    const c = makeClock();
    const q = new PostCommitProjectionQueue(cfg({ maxEventsPerSlice: 1, maxWallMsPerSlice: 1_000_000 }), noSinks(), c.clock);
    const order: string[] = [];
    // The first task, while running, enqueues a second. The single running
    // flag must NOT start a concurrent drainer; the nested enqueue appends.
    q.enqueue({
      label: "first",
      sourceEventId: "e1",
      run: () => {
        order.push("first");
        q.enqueue({ label: "nested", sourceEventId: "e2", run: () => { order.push("nested"); } });
      },
    });
    await c.flushDue();
    expect(order).toEqual(["first", "nested"]);
  });

  test("a throwing task does not wedge the FIFO — later tasks still run", async () => {
    const c = makeClock();
    const q = new PostCommitProjectionQueue(cfg(), noSinks(), c.clock);
    const ran: string[] = [];
    q.enqueue({ label: "bad", sourceEventId: "e1", run: () => { throw new Error("boom"); } });
    q.enqueue({ label: "good", sourceEventId: "e2", run: () => { ran.push("good"); } });
    await c.flushDue();
    expect(ran).toEqual(["good"]);
    expect(q.drainedCount()).toBe(2);
  });

  test("async tasks are awaited within a slice and preserve ordering", async () => {
    // Real timers here: the drain awaits each async task's promise, which
    // needs genuine microtask turns the fake clock cannot fully model.
    // flushForTest drives the real drain loop to quiescence.
    const q = new PostCommitProjectionQueue(cfg());
    const order: number[] = [];
    for (let i = 0; i < 5; i++) {
      q.enqueue({
        label: `a${i}`,
        sourceEventId: `e${i}`,
        run: async () => { await Promise.resolve(); order.push(i); },
      });
    }
    await q.flushForTest();
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("post-commit projection queue — fire-once watchdog (c)", () => {
  test("a wedged drain (zero progress) fires the watchdog exactly once", async () => {
    const c = makeClock();
    const watchdogFires: Array<{ watchdogId: string; hungForMs: number }> = [];
    const sinks: QueueSinks = {
      onOverflow: () => {},
      onWatchdog: (info) => { watchdogFires.push({ watchdogId: info.watchdogId, hungForMs: info.hungForMs }); },
    };
    // A task that never resolves: the drain awaits it forever, making zero
    // progress. The watchdog must fire once after watchdogMs.
    let resolveHang: (() => void) | null = null;
    const q = new PostCommitProjectionQueue(cfg({ watchdogMs: 1000 }), sinks, c.clock);
    q.enqueue({
      label: "hang",
      sourceEventId: "e1",
      run: () => new Promise<void>((res) => { resolveHang = res; }),
    });
    // Turn the loop so the drain starts + arms the watchdog (and blocks on
    // the never-resolving task).
    const idx0 = c.pending();
    expect(idx0).toBeGreaterThan(0);
    // Fire the setTimeout(0) that starts the drain. The drain awaits the
    // hanging task, so flushDue's microtask settle returns control here.
    // Manually fire the start timer without draining the hang.
    await c.flushDue();
    // Advance past the watchdog budget and fire it.
    c.advance(1001);
    await c.flushDue();
    expect(watchdogFires.length).toBe(1);
    expect(watchdogFires[0]!.hungForMs).toBeGreaterThanOrEqual(1000);
    // Advancing further does NOT fire a second watchdog (fire-once).
    c.advance(5000);
    await c.flushDue();
    expect(watchdogFires.length).toBe(1);
    // Cleanup: let the hang resolve so no dangling promise.
    resolveHang?.();
  });

  test("slow-but-progressing work does NOT fire the watchdog", async () => {
    const c = makeClock();
    let watchdogFired = 0;
    const sinks: QueueSinks = { onOverflow: () => {}, onWatchdog: () => { watchdogFired++; } };
    // Each task advances the clock a little (slow) but the queue keeps
    // draining (progress). The watchdog re-arms on progress instead of firing.
    const q = new PostCommitProjectionQueue(cfg({ watchdogMs: 100, maxEventsPerSlice: 1, maxWallMsPerSlice: 1_000_000 }), sinks, c.clock);
    for (let i = 0; i < 10; i++) {
      q.enqueue({ label: `s${i}`, sourceEventId: `e${i}`, run: () => { c.advance(50); } });
    }
    await c.flushDue();
    expect(q.drainedCount()).toBe(10);
    expect(watchdogFired).toBe(0);
  });
});

describe("post-commit projection queue — bounded + backpressure (d)", () => {
  test("enqueue past the cap is rejected with a loud overflow signal, never silent", () => {
    const overflows: Array<{ droppedLabel: string; queueDepth: number; cap: number }> = [];
    const sinks: QueueSinks = {
      onOverflow: (info) => { overflows.push({ droppedLabel: info.droppedLabel, queueDepth: info.queueDepth, cap: info.cap }); },
      onWatchdog: () => {},
    };
    const c = makeClock();
    // Cap at 3; do NOT drain (no flushDue), so the queue stays full.
    const q = new PostCommitProjectionQueue(cfg({ maxQueueDepth: 3 }), sinks, c.clock);
    expect(q.enqueue({ label: "a", sourceEventId: "e1", run: () => {} })).toBe(true);
    expect(q.enqueue({ label: "b", sourceEventId: "e2", run: () => {} })).toBe(true);
    expect(q.enqueue({ label: "c", sourceEventId: "e3", run: () => {} })).toBe(true);
    // 4th enqueue exceeds the cap → rejected + overflow signal.
    expect(q.enqueue({ label: "d", sourceEventId: "e4", run: () => {} })).toBe(false);
    expect(overflows.length).toBe(1);
    expect(overflows[0]!.droppedLabel).toBe("d");
    expect(overflows[0]!.cap).toBe(3);
    expect(overflows[0]!.queueDepth).toBe(3);
    // The bounded queue never grew past the cap (OOM guard).
    expect(q.depth()).toBe(3);
  });
});
