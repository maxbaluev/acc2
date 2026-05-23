import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Reconciled against corrected impl MQKZJKZX (corrects reverted H4CRN2J8).
//
// The corrected impl exposes ONLY `detachOnDeadline` on TailOpts; there is no
// `detachOnObserverError` / `detachMessage` option, and the detach line is a
// fixed string emitted by runTailStream/runTailPoll. The observer (MCP)
// read errors are already swallowed inside `readResolvedTerminalRow`
// (`mcpCall(...).catch(() => null)`), so a throwing observer cannot leak to
// stderr and cannot itself terminate the follow — the deadline budget is the
// sole bounding mechanism. The three assertions below are preserved:
//   (a) exits on dispatch terminal,
//   (b) detaches + exit 0 on observer (MCP) error (bounded by the deadline,
//       error string NOT leaked),
//   (c) detaches + exit 0 when the max-follow deadline elapses (the case the
//       first attempt failed: the SSE generator returns gracefully on abort,
//       so the detach-exit lives in runTailStream's post-loop fallthrough and
//       its aborted-catch branch, not only a throw path).

let mcpImpl: (...args: unknown[]) => Promise<unknown>;
let sseImpl: (opts: { signal?: AbortSignal }) => AsyncGenerator<unknown>;

// Spread the real module so this mock overrides ONLY mcpCall + sseConnect.
// `mock.module` is process-global and is NOT undone by `mock.restore()`, so a
// non-spread stub would clobber every OTHER export (e.g. nextBackoff, the real
// sseConnect) for sibling test files loaded in the same parallel preload pass
// (observed: cli/rpc_reconnect.test.ts failing only when co-loaded). Spreading
// keeps all un-stubbed exports live.
const realRpc = await import("./rpc");
mock.module("./rpc", () => ({
  ...realRpc,
  mcpCall: (...args: unknown[]) => mcpImpl(...args),
  sseConnect: (opts: { signal?: AbortSignal }) => sseImpl(opts),
}));

const { runTail } = await import("./observe");

const DETACH_LINE =
  "acc task: follow budget elapsed; detached while the directive continues in the background";

const captureConsole = () => {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
  return {
    out,
    err,
    restore: () => {
      console.log = origLog;
      console.error = origErr;
    },
  };
};

// SSE generator that never yields and returns gracefully once aborted — the
// exact production shape that the first attempt's deadline-detach missed.
async function* waitForAbort(opts: { signal?: AbortSignal }): AsyncGenerator<unknown> {
  if (!opts.signal?.aborted) {
    await new Promise<void>((resolve) =>
      opts.signal?.addEventListener("abort", () => resolve(), { once: true }),
    );
  }
}

describe("acc task bounded follow exits", () => {
  beforeEach(() => {
    mcpImpl = async () => ({ ok: true, result: [] });
    sseImpl = waitForAbort;
  });

  afterEach(() => {
    mock.restore();
  });

  test("exits when dispatch_resolved_view reports completed", async () => {
    mcpImpl = async () => ({
      ok: true,
      result: [{
        directive_id: "D1234567890123456789012345",
        root_task_id: "T1234567890123456789012345",
        lifecycle_status: "completed",
        terminal_kind: "task_committed",
      }],
    });
    const cap = captureConsole();
    const code = await runTail({
      directive: "D1234567890123456789012345",
      rootTaskId: "T1234567890123456789012345",
      stream: true,
      exitOnTerminal: true,
      detachOnDeadline: true,
      deadlineMs: Date.now() + 10_000,
    });
    cap.restore();

    expect(code).toBe(0);
    expect(cap.out.join("\n")).toContain("ACC_DISPATCH_RESOLVED");
    expect(cap.out.join("\n")).toContain("status=completed");
    expect(cap.err).toHaveLength(0);
  });

  test("detaches cleanly when observer MCP read times out", async () => {
    // Observer read throws on every call. The corrected impl swallows it inside
    // readResolvedTerminalRow (.catch(() => null)), so the throw never leaks to
    // stderr and the follow is bounded only by the deadline → clean detach+exit0.
    mcpImpl = async () => { throw new Error("Request timed out"); };
    const cap = captureConsole();
    const code = await runTail({
      directive: "D1234567890123456789012345",
      rootTaskId: "T1234567890123456789012345",
      stream: true,
      exitOnTerminal: true,
      detachOnDeadline: true,
      deadlineMs: Date.now() + 5,
    });
    cap.restore();

    expect(code).toBe(0);
    expect(cap.out.join("\n")).toContain(DETACH_LINE);
    expect(cap.err.join("\n")).not.toContain("Request timed out");
  });

  test("detaches cleanly when the max follow budget elapses", async () => {
    const cap = captureConsole();
    const code = await runTail({
      directive: "D1234567890123456789012345",
      rootTaskId: "T1234567890123456789012345",
      stream: true,
      exitOnTerminal: true,
      detachOnDeadline: true,
      deadlineMs: Date.now() + 5,
    });
    cap.restore();

    expect(code).toBe(0);
    expect(cap.out.join("\n")).toContain(DETACH_LINE);
    expect(cap.err.join("\n")).not.toContain("deadline exceeded");
  });
});
