// acc2 — gated runtime loop-blocker profiling (ACC2_PROFILE_LOOP).
//
// Pins the zero-cost-when-off contract for the two observability hooks we
// added to hunt the ~16s event-loop block during an opencode brain connect-
// burst:
//   1. profileMcpExecute (runtime/mcp_server/index.ts) — per-MCP-request
//      duration logging; logs {event:"slow_mcp_request", method, duration_ms}
//      when a request exceeds the slow threshold.
//   2. startLoopLagMonitor (runtime/daemon.ts) — a setInterval that logs
//      {event:"event_loop_blocked", lag_ms} when the loop is wedged > 1s.
//
// Both are gated behind ACC2_PROFILE_LOOP=1. The gate is read at module-eval
// time, so the ON-branch is exercised in a subprocess that boots with the env
// var set and the OFF-branch is asserted directly in this process (env unset).

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// ── OFF branch (default; env unset in the test harness) ─────────────
// When the flag is off, the profiling wrappers must be true no-ops so there
// is zero overhead and no behavior change.
describe("loop profiling — gated OFF (default, no overhead)", () => {
  test("profileMcpExecute returns the original executor unchanged", async () => {
    delete process.env.ACC2_PROFILE_LOOP;
    const { profileMcpExecute, PROFILE_LOOP_ENABLED } = await import("./index");
    expect(PROFILE_LOOP_ENABLED).toBe(false);
    const exec = async (_args: unknown): Promise<string> => "ok";
    // Identity: no wrapper closure allocated, no timing path.
    expect(profileMcpExecute("substrate.read", exec)).toBe(exec);
  });

  test("startLoopLagMonitor arms nothing and returns a no-op disposer", async () => {
    delete process.env.ACC2_PROFILE_LOOP;
    const { startLoopLagMonitor, PROFILE_LOOP_ENABLED } = await import("../daemon");
    expect(PROFILE_LOOP_ENABLED).toBe(false);
    // The disposer must be safe to call (no interval was created).
    const dispose = startLoopLagMonitor();
    expect(typeof dispose).toBe("function");
    expect(() => dispose()).not.toThrow();
  });
});

// ── ON branch (ACC2_PROFILE_LOOP=1, fresh module load in a subprocess) ──
// The gate is a module-level const, so we boot a child Bun process with the
// env var set, exercise both hooks, and assert the structured log lines land.
describe("loop profiling — gated ON (ACC2_PROFILE_LOOP=1)", () => {
  test("slow handler logs slow_mcp_request; loop-lag monitor is created + cleared", async () => {
    const script = join(import.meta.dir, "..", "..", "tests", "loop_profiling_probe.ts");
    const proc = Bun.spawn(["bun", script], {
      env: {
        ...process.env,
        ACC2_PROFILE_LOOP: "1",
        // Force pino to emit JSON we can parse (test mode is silent).
        NODE_ENV: "development",
        ACC2_LOG_LEVEL: "warn",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const combined = `${out}\n${err}`;
    expect(code, `probe failed:\n${combined}`).toBe(0);
    // 1. slow_mcp_request fired for the deliberately-slow handler.
    expect(combined).toContain("slow_mcp_request");
    expect(combined).toContain("substrate.read");
    // 2. The probe asserts the monitor arms a live timer and the disposer
    //    clears it, printing PROBE_OK only when both held.
    expect(combined).toContain("PROBE_OK");
  });
});
