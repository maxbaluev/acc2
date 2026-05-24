// `acc events --json` / `acc inspect --json` machine-readable surface tests.
//
// Regression for the confirmed bug: `acc events --json` was non-functional —
// `--json` was never parsed (no `json` field on EventsOpts, no flag wired in
// runObserve) and `runEvents` rendered exclusively through `formatEvent`,
// which suppresses every non-NARRATIVE_KINDS row. Two agents this session
// fell back to the `runtime.recent_events` read because the documented flag
// produced no parseable output (and silently dropped rows under the narrative
// filter, surfacing the misleading "no events matched filters (saw N)").
//
// These tests pin the fix:
//   1. `acc events --json` emits a single parseable JSON array of the raw
//      event rows — including non-narrative kinds that the human render
//      surface suppresses (no silent drop).
//   2. `--task` / `--kind` filters still apply under --json.
//   3. An empty match is a valid `[]`, never an error or a dropped row.
//   4. `acc inspect --json` shares the same machine-readable contract.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let mcpImpl: (...args: unknown[]) => Promise<unknown>;

const realRpc = await import("./rpc");
mock.module("./rpc", () => ({
  ...realRpc,
  mcpCall: (...args: unknown[]) => mcpImpl(...args),
  auxRecentEvents: (args: Record<string, unknown>) => mcpImpl("runtime.recent_events", args),
  auxRead: (viewName: string, args?: Record<string, unknown>) => mcpImpl("substrate.read", { view_name: viewName, args }),
}));

const { runEvents, runInspect } = await import("./observe");

const captureConsole = () => {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
  return { out, err, restore: () => { console.log = origLog; console.error = origErr; } };
};

// A seeded window mixing narrative and non-narrative kinds. `embedding_computed`
// and `worker_tick_completed` are substrate-internal (NOT in NARRATIVE_KINDS),
// so the human render path suppresses them — the --json path must NOT.
const seededEvents = () => [
  {
    event_id: "E_node",
    kind: "task_node_opened",
    ts: "2026-05-23T10:00:00.000Z",
    directive_id: "D_main",
    task_id: "T_alpha",
    payload: { rank: 1, goal: "do the thing" },
  },
  {
    event_id: "E_embed",
    kind: "embedding_computed", // non-narrative → suppressed by formatEvent
    ts: "2026-05-23T10:00:01.000Z",
    directive_id: "D_main",
    task_id: "T_alpha",
    payload: { count: 3, model: "x" },
  },
  {
    event_id: "E_commit",
    kind: "task_committed",
    ts: "2026-05-23T10:00:02.000Z",
    directive_id: "D_main",
    task_id: "T_beta",
    payload: { events_count: 5 },
  },
];

describe("acc events --json", () => {
  beforeEach(() => {
    mcpImpl = async () => ({ ok: true, result: { events: seededEvents() } });
  });
  afterEach(() => { mock.restore(); });

  test("emits a single parseable JSON array of the raw event rows", async () => {
    const cap = captureConsole();
    const code = await runEvents({ json: true });
    cap.restore();
    expect(code).toBe(0);
    // Exactly one stdout payload, and it must parse as JSON.
    expect(cap.out.length).toBe(1);
    const parsed = JSON.parse(cap.out[0]!);
    expect(Array.isArray(parsed)).toBe(true);
    // ALL rows present — including the non-narrative embedding_computed row
    // the human render path would have suppressed. No silent drop.
    expect(parsed.length).toBe(3);
    const ids = parsed.map((e: { event_id: string }) => e.event_id).sort();
    expect(ids).toEqual(["E_commit", "E_embed", "E_node"]);
    // Raw row shape preserved (not the one-line narrative string).
    const node = parsed.find((e: { event_id: string }) => e.event_id === "E_node");
    expect(node.kind).toBe("task_node_opened");
    expect(node.payload.goal).toBe("do the thing");
    // No misleading "no events matched filters" on stderr.
    expect(cap.err.join("\n")).not.toContain("no events matched");
  });

  test("--task filter still applies under --json", async () => {
    const cap = captureConsole();
    const code = await runEvents({ json: true, task: "T_alpha" });
    cap.restore();
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.out[0]!);
    expect(parsed.map((e: { event_id: string }) => e.event_id).sort()).toEqual(["E_embed", "E_node"]);
  });

  test("--kind filter still applies under --json (including non-narrative kinds)", async () => {
    const cap = captureConsole();
    const code = await runEvents({ json: true, kind: "embedding_computed" });
    cap.restore();
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.out[0]!);
    expect(parsed.length).toBe(1);
    expect(parsed[0].kind).toBe("embedding_computed");
  });

  test("empty match under --json is a valid `[]`, not an error or a drop", async () => {
    const cap = captureConsole();
    const code = await runEvents({ json: true, task: "T_nonexistent" });
    cap.restore();
    expect(code).toBe(0);
    expect(JSON.parse(cap.out[0]!)).toEqual([]);
    expect(cap.err.length).toBe(0);
  });

  test("regression: human (non-json) path RENDERS every matched row, never silently drops or misleads", async () => {
    // `acc events` is the honest bounded ledger-window reader. A window of
    // only non-narrative kinds matched by --kind must be RENDERED (not
    // suppressed): the old code printed the misleading "no events matched
    // filters (saw N)" even though rows DID match. The honest render prints
    // every matched row (verbose) and never emits a misleading empty message.
    const cap = captureConsole();
    const code = await runEvents({ kind: "embedding_computed" });
    cap.restore();
    expect(code).toBe(0);
    // The previously-suppressed non-narrative row is now printed on stdout.
    expect(cap.out.length).toBe(1);
    expect(cap.out.join("\n")).toContain("embedding_computed");
    // No misleading "no events matched" / "no rows matched" message, because
    // a row DID match.
    const errText = cap.err.join("\n");
    expect(errText).not.toContain("no events matched filters");
    expect(errText).not.toContain("no rows matched filters");
  });

  test("regression: honest empty message only fires when ZERO rows matched the filters", async () => {
    // When the window is non-empty but NO row matches the explicit filters,
    // the honest reader says so against the bounded window size — and does
    // NOT use the old misleading "no events matched filters (saw N)" wording.
    const cap = captureConsole();
    const code = await runEvents({ task: "T_nonexistent" });
    cap.restore();
    expect(code).toBe(0);
    expect(cap.out.length).toBe(0);
    const errText = cap.err.join("\n");
    expect(errText).toContain("no rows matched filters in the bounded");
    expect(errText).toContain("3-row window");
    expect(errText).not.toContain("no events matched filters");
  });
});

describe("acc inspect --json", () => {
  beforeEach(() => {
    mcpImpl = async () => ({ ok: true, result: { events: seededEvents() } });
  });
  afterEach(() => { mock.restore(); });

  test("emits parseable JSON of the task's raw event rows", async () => {
    const cap = captureConsole();
    const code = await runInspect("T_alpha", { json: true });
    cap.restore();
    expect(code).toBe(0);
    expect(cap.out.length).toBe(1);
    const parsed = JSON.parse(cap.out[0]!);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.map((e: { event_id: string }) => e.event_id).sort()).toEqual(["E_embed", "E_node"]);
  });

  test("no match under --json emits `[]` and exits 1", async () => {
    const cap = captureConsole();
    const code = await runInspect("T_missing", { json: true });
    cap.restore();
    expect(code).toBe(1);
    expect(JSON.parse(cap.out[0]!)).toEqual([]);
  });
});
