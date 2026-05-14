// Phase Align — Principle 3: cycle-1-only enforcement is structural across
// BOTH the mock and the real bridge.
//
// v2-design.md §3.7: cycle-1-only is a structural invariant, not advisory.
// Before Phase Align, the mock-bridge path and the real-bridge path each
// had their own enforcement copy. This test asserts that:
//   1. The two forbidden event kinds are owned by a single canonical export
//      (`cycle_one_gate.ts:CYCLE_ONE_FORBIDDEN_KINDS`).
//   2. The real bridge (spawnRealOpencode) kills the subprocess when its
//      streamed JSON contains a forbidden kind, recording the same
//      `bridge_failed` event the mock-bridge dispatcher would emit.

import { afterAll, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../../substrate/db";
import { CYCLE_ONE_FORBIDDEN_KINDS, isCycleViolation } from "../cycle_one_gate";
import { spawnRealOpencode } from "../bridge";
import { newId } from "../ids";
import { readFileSync } from "node:fs";
import { join } from "node:path";

afterAll(() => closeDb());

describe("alignment / cycle_one (Principle 3)", () => {
  test("forbidden-kind set is the single source of truth and is non-empty", () => {
    expect(CYCLE_ONE_FORBIDDEN_KINDS.size).toBeGreaterThanOrEqual(2);
    expect(CYCLE_ONE_FORBIDDEN_KINDS.has("brain_cycle_2_started")).toBe(true);
    expect(CYCLE_ONE_FORBIDDEN_KINDS.has("continue_cycle_requested")).toBe(true);
    expect(isCycleViolation("brain_cycle_2_started")).toBe(true);
    expect(isCycleViolation("continue_cycle_requested")).toBe(true);
    expect(isCycleViolation("action_predicted")).toBe(false);
    expect(isCycleViolation(null)).toBe(false);
    expect(isCycleViolation(undefined)).toBe(false);
  });

  test("both bridge and dispatcher route through the shared gate (source text)", () => {
    const bridgeText = readFileSync(join(import.meta.dir, "..", "bridge.ts"), "utf-8");
    const dispatcherText = readFileSync(join(import.meta.dir, "..", "task_dispatcher.ts"), "utf-8");
    expect(bridgeText.includes('from "./cycle_one_gate"')).toBe(true);
    expect(dispatcherText.includes('from "./cycle_one_gate"')).toBe(true);
    // Neither file should hand-roll its own literal forbidden-kind list.
    // We bar the literal disjunction that used to live in both places.
    expect(bridgeText).not.toContain(
      'kind === "brain_cycle_2_started" || kind === "continue_cycle_requested"',
    );
    expect(dispatcherText).not.toContain(
      'ev.kind === "brain_cycle_2_started" || ev.kind === "continue_cycle_requested"',
    );
  });

  test("spawnRealOpencode kills the subprocess on forbidden-kind emission", async () => {
    closeDb();
    const db = openDb(":memory:");

    // Fake `Bun.spawn`: returns a subprocess whose stdout immediately emits
    // a JSON line carrying kind:"brain_cycle_2_started". The gate must read
    // it, call `proc.kill("SIGTERM")`, and record bridge_failed with the
    // cycle_violation reason. exited resolves once we set killed = true.
    let killedSignal: string | null = null;
    let exitedResolve: ((code: number) => void) | null = null;
    const stdoutStream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(JSON.stringify({ type: "brain_cycle_2_started" }) + "\n"));
        // Hold stream open briefly so the SIGTERM path runs before close.
        setTimeout(() => controller.close(), 5);
      },
    });
    const stderrStream = new ReadableStream<Uint8Array>({
      start(controller) { controller.close(); },
    });
    const fakeProc = {
      stdout: stdoutStream,
      stderr: stderrStream,
      kill: (sig: string) => {
        killedSignal = sig;
        // simulate the process exiting after SIGTERM
        if (exitedResolve) { exitedResolve(143); exitedResolve = null; }
      },
      exited: new Promise<number>((resolve) => { exitedResolve = resolve; }),
    } as unknown as ReturnType<typeof Bun.spawn>;
    const fakeSpawn = (() => fakeProc) as unknown as typeof Bun.spawn;

    const result = await spawnRealOpencode(
      { prompt: "noop", taskId: newId(), directiveId: newId() },
      db,
      {
        spawnFn: fakeSpawn,
        timeoutMs: 30_000,
        // The bridge fails fast (parse_error / mcp_server_url_missing) when
        // V2_MCP_SERVER_URL is unset. Under `bun test --parallel --isolate`
        // each test worker is its own process, so env leaks from earlier
        // tests do not propagate; we must inject the URL explicitly so the
        // bridge reaches the cycle-violation gate this test is exercising.
        mcpServerUrl: "http://127.0.0.1:1/mcp",
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The bridge surfaces the violation as subprocess_crash with a
      // cycle_violation:<kind> stderr_tail — that's the canonical Phase D
      // shape and matches how the dispatcher emits dispatcher_violation.
      expect(result.reason.kind).toBe("subprocess_crash");
    }
    expect(killedSignal).toBe("SIGTERM");
    const failedRow = db
      .query("SELECT payload FROM events WHERE kind = 'bridge_failed' ORDER BY ts DESC LIMIT 1")
      .get() as { payload: string } | null;
    expect(failedRow).not.toBeNull();
    expect(failedRow!.payload).toContain("cycle_violation");
  });
});
