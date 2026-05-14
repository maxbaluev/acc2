// Phase Align — Principle 8: per-state-root mutex on every stateful runtime
// invocation.
//
// v2-design.md §11.2: stateful artifacts (camofox-browser is the canonical
// case in v2) queue against a per-state-root mutex. Concurrent invocations
// against the SAME `profile_root` serialize; different roots run in parallel.
//
// This test exercises the mutex directly via the runtime-internal test
// hook so the assertion is hermetic — no chromium spawn required. It runs
// two overlapping critical sections against the same root and asserts
// their execution windows do NOT overlap. A parallel-root pair is also
// exercised to prove the mutex doesn't over-serialize.

import { afterAll, describe, expect, test } from "bun:test";
import { closeDb } from "../../substrate/db";
import { __acquireProfileMutexForTest } from "../runtimes/camofox";

afterAll(() => closeDb());

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("alignment / state_root_mutex (Principle 8)", () => {
  test("two concurrent invocations on the same profile_root serialize", async () => {
    const root = "/tmp/alignment-mutex-root-a";
    const events: Array<{ id: string; phase: "enter" | "exit"; t: number }> = [];
    const start = performance.now();

    const job = (id: string) =>
      __acquireProfileMutexForTest(root, async () => {
        events.push({ id, phase: "enter", t: performance.now() - start });
        await sleep(30);
        events.push({ id, phase: "exit", t: performance.now() - start });
      });

    const a = job("A");
    const b = job("B");
    await Promise.all([a, b]);

    // The mutex guarantees: every entry/exit pair is contiguous in `events`.
    // I.e. once A enters, B does not enter until A exits.
    expect(events.length).toBe(4);
    expect(events[0]!.phase).toBe("enter");
    expect(events[1]!.phase).toBe("exit");
    expect(events[2]!.phase).toBe("enter");
    expect(events[3]!.phase).toBe("exit");
    expect(events[0]!.id).toBe(events[1]!.id);
    expect(events[2]!.id).toBe(events[3]!.id);
    expect(events[0]!.id).not.toBe(events[2]!.id);
  });

  test("different profile_roots run in parallel", async () => {
    const events: Array<{ id: string; phase: "enter" | "exit"; t: number }> = [];
    const start = performance.now();

    const job = (id: string, root: string) =>
      __acquireProfileMutexForTest(root, async () => {
        events.push({ id, phase: "enter", t: performance.now() - start });
        await sleep(30);
        events.push({ id, phase: "exit", t: performance.now() - start });
      });

    const a = job("A", "/tmp/alignment-mutex-root-parallel-1");
    const b = job("B", "/tmp/alignment-mutex-root-parallel-2");
    await Promise.all([a, b]);

    // Both enter before either exits: the windows overlap, proving the
    // mutex is keyed on the root, not global.
    expect(events.length).toBe(4);
    const aEnter = events.find((e) => e.id === "A" && e.phase === "enter")!;
    const bEnter = events.find((e) => e.id === "B" && e.phase === "enter")!;
    const aExit = events.find((e) => e.id === "A" && e.phase === "exit")!;
    const bExit = events.find((e) => e.id === "B" && e.phase === "exit")!;
    // The second `enter` must happen before either `exit` — that's the
    // structural proof the windows overlap.
    const secondEnter = Math.max(aEnter.t, bEnter.t);
    const firstExit = Math.min(aExit.t, bExit.t);
    expect(secondEnter).toBeLessThan(firstExit);
  });

  test("mcp_server.handleRunArtifact routes camofox through runCamofoxArtifact (source check)", async () => {
    // Verify the dispatch lane: substrate.run_artifact in the mcp_server
    // module must call runCamofoxArtifact for the camofox-browser runtime,
    // which is where the mutex is acquired. No "fast path" should bypass
    // it. After the mcp_server.ts module split the handler lives under
    // runtime/mcp_server/substrate_tools.ts; the structural assertion is
    // unchanged.
    const text = await Bun.file(
      new URL("../mcp_server/substrate_tools.ts", import.meta.url),
    ).text();
    expect(text).toContain("runCamofoxArtifact");
    // The dispatcher branches by row.runtime: bun, uv, then else (camofox).
    // The runtime is enumerated, no fast path bypasses runCamofoxArtifact.
    expect(text).toContain('row.runtime === "bun"');
    expect(text).toContain('row.runtime === "uv"');
  });
});
