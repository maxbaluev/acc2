// `acc inspect <task_id>` window-honesty tests.
//
// runtime.recent_events caps the window at 200 rows server-side; acc inspect
// filters that window client-side by task_id prefix. A task whose events
// scrolled out of the most-recent-200 window must NOT be reported as
// "no events for task" (a false-negative implying the task never existed) —
// it must be reported as out-of-window and the operator pointed at the
// index-backed `acc dispatch` surface. A non-full window with no match is a
// genuine absence.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let mcpImpl: (...args: unknown[]) => Promise<unknown>;

const realRpc = await import("./rpc");
mock.module("./rpc", () => ({
  ...realRpc,
  mcpCall: (...args: unknown[]) => mcpImpl(...args),
}));

const { runInspect } = await import("./observe");

const captureConsole = () => {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
  return { out, err, restore: () => { console.log = origLog; console.error = origErr; } };
};

const makeEvents = (count: number, taskId: string) =>
  Array.from({ length: count }, (_, i) => ({
    event_id: `E${i}`,
    kind: "task_node_opened",
    ts: new Date(Date.now() + i).toISOString(),
    directive_id: "D_other",
    task_id: taskId,
    payload: { rank: i },
  }));

describe("acc inspect window honesty", () => {
  beforeEach(() => { mcpImpl = async () => ({ ok: true, result: { events: [] } }); });
  afterEach(() => { mock.restore(); });

  test("full window with no match reports out-of-window + points at acc dispatch (not false 'no events')", async () => {
    // 200 events all for a DIFFERENT task → window is saturated, target task
    // matches nothing.
    mcpImpl = async () => ({ ok: true, result: { events: makeEvents(200, "T_other_task") } });
    const cap = captureConsole();
    const code = await runInspect("T_missing_task");
    cap.restore();
    expect(code).toBe(1);
    const errText = cap.err.join("\n");
    expect(errText).toContain("not in the most recent");
    expect(errText).toContain("acc dispatch");
    // Must NOT use the absence wording that implies the task never existed.
    expect(errText).not.toContain("no events for task");
  });

  test("partial window with no match reports genuine absence", async () => {
    // Only 10 events in the window (< cap) → we CAN prove the task is absent.
    mcpImpl = async () => ({ ok: true, result: { events: makeEvents(10, "T_other_task") } });
    const cap = captureConsole();
    const code = await runInspect("T_missing_task");
    cap.restore();
    expect(code).toBe(1);
    const errText = cap.err.join("\n");
    expect(errText).toContain("no events for task");
    expect(errText).not.toContain("not in the most recent");
  });

  test("found task at the window head flags possible truncation", async () => {
    // The matched task's first event is the OLDEST in the saturated window →
    // earlier events may have been dropped; chronology is flagged partial.
    mcpImpl = async () => ({ ok: true, result: { events: makeEvents(200, "T_target") } });
    const cap = captureConsole();
    const code = await runInspect("T_target");
    cap.restore();
    expect(code).toBe(0);
    expect(cap.out.join("\n")).toContain("task T_target");
    expect(cap.err.join("\n")).toContain("may be truncated");
  });
});
