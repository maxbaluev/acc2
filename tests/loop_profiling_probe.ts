// acc2 — ON-branch probe for ACC2_PROFILE_LOOP profiling.
//
// Run as a CHILD process by runtime/mcp_server/loop_profiling.test.ts with
// ACC2_PROFILE_LOOP=1 in the env. The gate is a module-level const, so the
// only way to exercise the armed path with a fresh module instance is a fresh
// process. This is NOT a *.test.ts file so the suite runner ignores it; it is
// the fixture the loop_profiling test spawns and parses.
//
// Exercises BOTH hooks and prints PROBE_OK on success:
//   - profileMcpExecute wraps a deliberately-slow handler → emits the
//     {event:"slow_mcp_request", method:"substrate.read", duration_ms} line.
//   - startLoopLagMonitor arms a real interval, the loop is then blocked
//     synchronously for > the threshold, and the monitor emits
//     {event:"event_loop_blocked", lag_ms}; the disposer clears the timer.

import { profileMcpExecute, PROFILE_LOOP_ENABLED, SLOW_MCP_THRESHOLD_MS } from "../runtime/mcp_server/index";
import { startLoopLagMonitor } from "../runtime/daemon";

const fail = (msg: string): never => {
  console.error(`PROBE_FAIL: ${msg}`);
  process.exit(1);
};

const main = async (): Promise<void> => {
  if (!PROFILE_LOOP_ENABLED) fail("gate not enabled in child process");

  // 1. profileMcpExecute must return a NEW wrapper (not identity) when armed.
  const slow = async (_args: unknown): Promise<string> => {
    const until = performance.now() + SLOW_MCP_THRESHOLD_MS + 100;
    while (performance.now() < until) {
      /* busy-wait > threshold so duration_ms crosses the slow bar */
    }
    return "ok";
  };
  const wrapped = profileMcpExecute("substrate.read", slow);
  if (wrapped === (slow as unknown)) fail("expected a wrapper, got identity when armed");
  await wrapped({}); // → logs slow_mcp_request{method:"substrate.read"}

  // 2. startLoopLagMonitor must arm a real interval. Block the loop > 1s so
  //    the monitor's next tick observes lag and emits event_loop_blocked.
  const dispose = startLoopLagMonitor();
  if (typeof dispose !== "function") fail("monitor disposer not a function");
  // Let the interval take its first reading, then wedge the loop.
  await new Promise((r) => setTimeout(r, 120));
  const blockUntil = performance.now() + 1300;
  while (performance.now() < blockUntil) {
    /* synchronous block — the loop cannot service the lag-monitor tick */
  }
  // Yield so the backed-up interval callback runs and logs the lag.
  await new Promise((r) => setTimeout(r, 200));
  dispose(); // clears the interval — process can now exit cleanly

  console.log("PROBE_OK");
  process.exit(0);
};

void main();
