// CRASH-RESILIENCE: bounded shutdown (resource-spec AHV73KJDK54P3FF7D2NDV9TQ2C).
//
// The measured stuck-state: a graceful stop()/restart TIMED OUT at 40s under
// load because stop() awaited mcpServer.stop() UNBOUNDED. fastmcp's stop()
// does not promptly release its http listener and can hang indefinitely on an
// overloaded daemon, so the restart never completed — manual kill required.
//
// The fix wraps every shutdown await in `withTimeout(label, promise, budget)`,
// which RESOLVES (never rejects) on timeout so stop() force-proceeds to lock
// removal + DB close. These tests pin that behaviour at the unit level: a
// never-resolving promise must NOT make withTimeout hang past its budget, and
// a fast promise must pass through its value untouched.

import { describe, expect, test } from "bun:test";
import { withTimeout } from "./daemon";

describe("withTimeout — bounded shutdown step (never hangs)", () => {
  test("a never-resolving promise resolves with timedOut:true within the budget", async () => {
    const budgetMs = 80;
    // Simulate fastmcp's wedged stop(): a promise that never settles.
    const neverResolves = new Promise<void>(() => { /* deliberately never resolves */ });
    const start = Date.now();
    const result = await withTimeout("mcpServer.stop", neverResolves, budgetMs);
    const elapsed = Date.now() - start;

    expect(result.timedOut).toBe(true);
    expect(result.value).toBeUndefined();
    // Hard bound: must resolve close to the budget, never run unbounded.
    // Generous ceiling to stay non-flaky under parallel CI load.
    expect(elapsed).toBeLessThan(budgetMs + 1500);
  });

  test("a fast-resolving promise passes its value through with timedOut:false", async () => {
    const result = await withTimeout("fast", Promise.resolve(42), 1000);
    expect(result.timedOut).toBe(false);
    expect(result.value).toBe(42);
  });

  test("a rejecting promise is swallowed (timedOut:false, value undefined) — best-effort", async () => {
    const result = await withTimeout("rejects", Promise.reject(new Error("boom")), 1000);
    expect(result.timedOut).toBe(false);
    expect(result.value).toBeUndefined();
  });

  test("the shutdown sequence is bounded even when EVERY step hangs", async () => {
    // Model the real stop() teardown: mcpServer.stop + sqlPool.shutdown both
    // wedged. The point is the SUM of bounded steps is itself bounded — the
    // restart always completes. We race the composed sequence against a hard
    // ceiling and assert it finishes.
    const mcpBudget = 60;
    const sqlBudget = 60;
    const hang = () => new Promise<void>(() => { /* never resolves */ });

    const start = Date.now();
    await withTimeout("mcpServer.stop", hang(), mcpBudget);
    await withTimeout("sqlPool.shutdown", hang(), sqlBudget);
    const elapsed = Date.now() - start;

    // Two sequential bounded steps → bounded total. Never the 40s wedge.
    expect(elapsed).toBeLessThan(mcpBudget + sqlBudget + 2000);
  });
});
