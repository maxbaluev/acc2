// acc2 observe CLI test — panel-friendly follow-tail invariants.
//
// Three load-bearing properties keep the Claude Code background_tasks
// shell-details panel readable during the first minute of every `acc task`
// dispatch (before any brain event has landed):
//
//  1. Every `formatEvent` line stays ≤ MAX_EVENT_LINE_CHARS (120). The
//     `trunc(line, MAX_EVENT_LINE_CHARS)` failsafe at the end of
//     `formatEvent` enforces this even when a single payload field would
//     overflow.
//  2. The `directive_opened` renderer collapses to a compact one-liner —
//     no full directive-text echo on the default panel surface; the body
//     lives in the ledger payload and `acc inspect` / `--verbose` pull it.
//  3. `formatFollowHeartbeat` renders the canonical
//     `[t+<s>s] waiting on brain · cycle c/m · e events · n nodes · p proposals`
//     line. Pre-event window omits the `last <kind> Ns ago` tail; once an
//     event has landed it carries the running last-kind + age.

import { describe, expect, test } from "bun:test";
import {
  MAX_EVENT_LINE_CHARS,
  FOLLOW_HEARTBEAT_MS,
  FOLLOW_HEARTBEAT_WINDOW_MS,
  formatEvent,
  formatFollowHeartbeat,
  formatFollowTerminalSentinel,
  resolveRootTaskIdFlag,
  type HeartbeatCounters,
} from "./observe";

describe("formatEvent — ≤ MAX_EVENT_LINE_CHARS invariant", () => {
  test("directive_opened renders as a single compact line", () => {
    const line = formatEvent({
      id: "ev_abc",
      kind: "directive_opened",
      ts: "2026-05-16T12:34:56.000Z",
      task_id: "tk_root_xyz",
      payload: {
        directive_text: "this is a very long directive text that would have eaten the panel window before the panel-friendly rewrite landed",
        lifecycle: "finite",
      },
    });
    expect(line).toBeTruthy();
    expect(line.length).toBeLessThanOrEqual(MAX_EVENT_LINE_CHARS);
    // Compact form — no `text=` field, no full directive echo.
    expect(line).not.toContain("text=");
    expect(line).not.toContain("very long directive");
    // Glyph + kind still present so operator can scan the panel.
    expect(line).toContain("directive_opened");
  });

  test("task_node_opened with a huge goal still fits ≤ 120 chars", () => {
    const line = formatEvent({
      id: "ev_node",
      kind: "task_node_opened",
      ts: "2026-05-16T12:34:56.000Z",
      task_id: "tk_subnode_xyz",
      payload: {
        rank: 1,
        goal: "x".repeat(500),
      },
    });
    expect(line.length).toBeLessThanOrEqual(MAX_EVENT_LINE_CHARS);
    expect(line).toContain("task_node_opened");
  });

  test("knowledge_candidate with a huge claim still fits ≤ 120 chars", () => {
    const line = formatEvent({
      id: "ev_kc",
      kind: "knowledge_candidate",
      ts: "2026-05-16T12:34:56.000Z",
      task_id: "tk_x",
      payload: { claim: "y".repeat(400), score: 0.42 },
    });
    expect(line.length).toBeLessThanOrEqual(MAX_EVENT_LINE_CHARS);
  });

  test("contract_amendment_proposed with a huge proposal still fits ≤ 120 chars", () => {
    const line = formatEvent({
      id: "ev_ca",
      kind: "contract_amendment_proposed",
      ts: "2026-05-16T12:34:56.000Z",
      task_id: "tk_x",
      payload: {
        target: "CLAUDE.md",
        anchor: "z".repeat(200),
        proposed_behavior: "w".repeat(400),
      },
    });
    expect(line.length).toBeLessThanOrEqual(MAX_EVENT_LINE_CHARS);
  });
});

describe("formatFollowTerminalSentinel", () => {
  test("prints a compact parseable terminal line", () => {
    const line = formatFollowTerminalSentinel({
      directive_id: "DIRECTIVE1234567890",
      root_task_id: "ROOTTASK1234567890",
      lifecycle_status: "completed",
      terminal_kind: "task_committed",
    });
    expect(line).toContain("ACC_TASK_TERMINAL");
    expect(line).toContain("status=completed");
    expect(line).toContain("reason=task_committed");
    expect(line.length).toBeLessThanOrEqual(MAX_EVENT_LINE_CHARS);
  });
});

describe("resolveRootTaskIdFlag", () => {
  test("accepts --root-task-id and --root aliases for resolved-view polling", () => {
    expect(resolveRootTaskIdFlag({ "root-task-id": "t_root" })).toBe("t_root");
    expect(resolveRootTaskIdFlag({ root: "t_alias" })).toBe("t_alias");
    expect(resolveRootTaskIdFlag({ root: true })).toBeUndefined();
  });
});

describe("formatFollowHeartbeat — panel pre-event signal", () => {
  test("pre-event window shape (no events yet)", () => {
    const startedAt = 1_700_000_000_000;
    const now = startedAt + 5_000;
    const counters: HeartbeatCounters = { events: 0, nodes: 0, proposals: 0, cycle: 1, maxCycles: 1 };
    const line = formatFollowHeartbeat(startedAt, counters, now);
    expect(line).toBe("[t+5s] waiting on brain · cycle 1/1 · 0 events · 0 nodes · 0 proposals");
    expect(line.length).toBeLessThanOrEqual(MAX_EVENT_LINE_CHARS);
  });

  test("post-event window carries last kind + age", () => {
    const startedAt = 1_700_000_000_000;
    const now = startedAt + 12_000;
    const counters: HeartbeatCounters = {
      events: 3, nodes: 2, proposals: 1, cycle: 1, maxCycles: 1,
      lastKind: "task_node_opened", lastEventAt: now - 7_000,
    };
    const line = formatFollowHeartbeat(startedAt, counters, now);
    expect(line).toContain("[t+12s]");
    expect(line).toContain("3 events");
    expect(line).toContain("2 nodes");
    expect(line).toContain("1 proposals");
    expect(line).toContain("last task_node_opened 7s ago");
    expect(line.length).toBeLessThanOrEqual(MAX_EVENT_LINE_CHARS);
  });

  test("cycle / maxCycles surface from brain_dispatched", () => {
    const startedAt = 1_700_000_000_000;
    const now = startedAt + 5_000;
    const counters: HeartbeatCounters = { events: 1, nodes: 0, proposals: 0, cycle: 1, maxCycles: 1 };
    const line = formatFollowHeartbeat(startedAt, counters, now);
    expect(line).toContain("cycle 1/1");
  });

  test("the constants the dispatch follow contract depends on", () => {
    // Compile-time + numeric pin — `acc task` follow surface relies on
    // these exact knobs to satisfy the panel UX predicate.
    expect(MAX_EVENT_LINE_CHARS).toBe(120);
    expect(FOLLOW_HEARTBEAT_MS).toBe(5_000);
    expect(FOLLOW_HEARTBEAT_WINDOW_MS).toBe(60_000);
  });
});
