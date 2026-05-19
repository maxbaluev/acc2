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

describe("formatEvent — task_closure_audited rendering (live + legacy payloads)", () => {
  test("live payload with checks object: renders checks=passed/total", () => {
    const line = formatEvent({
      id: "ev_audit",
      kind: "task_closure_audited",
      ts: "2026-05-19T21:16:10.687Z",
      task_id: "t_root",
      payload: {
        closure_residual: 0.08,
        checks: {
          one_amendment_per_open_question: true,
          cited_event_ids_resolve: true,
          no_multi_brain_mention: true,
          claude_md_byte_delta_le_600: true,
        },
      },
    });
    expect(line).toContain("closure_residual=0.08");
    expect(line).toContain("checks=4/4");
    expect(line).not.toContain("covered=");
    expect(line.length).toBeLessThanOrEqual(MAX_EVENT_LINE_CHARS);
  });

  test("live payload with mixed pass/fail checks: surfaces failed count", () => {
    const line = formatEvent({
      id: "ev_audit_partial",
      kind: "task_closure_audited",
      ts: "2026-05-19T21:16:10.687Z",
      task_id: "t_root",
      payload: {
        closure_residual: 0.42,
        checks: { a: true, b: true, c: false, d: false, e: true },
      },
    });
    expect(line).toContain("checks=3/5");
    expect(line).toContain("failed=2");
    expect(line.length).toBeLessThanOrEqual(MAX_EVENT_LINE_CHARS);
  });

  test("legacy payload with covered_sub_tasks/uncovered_aspects: preserves old rendering", () => {
    const line = formatEvent({
      id: "ev_legacy",
      kind: "task_closure_audited",
      ts: "2026-05-19T21:16:10.687Z",
      task_id: "t_root",
      payload: {
        closure_residual: 0.18,
        covered_sub_tasks: ["a", "b", "c"],
        uncovered_aspects: ["d"],
      },
    });
    expect(line).toContain("closure_residual=0.18");
    expect(line).toContain("covered=3");
    expect(line).toContain("uncovered=1");
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
    expect(line).toContain("ACC_DISPATCH_RESOLVED");
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

describe("formatEvent — Hole 1: 10 high-volume kinds get dedicated renderers", () => {
  // These 10 kinds previously fell through to the default renderer producing
  // generic `kind=X ts=Y` lines. Each test pins glyph + kind + the primary
  // payload signal + ≤ MAX_EVENT_LINE_CHARS. Tests use { verbose: true } so
  // the NARRATIVE_KINDS filter does not suppress the output (none of these
  // ten kinds are in the narrative surface today).
  const V = { verbose: true } as const;

  test("brain_message_emitted renders text= prefix (truncated)", () => {
    const line = formatEvent({
      id: "ev_bm",
      kind: "brain_message_emitted",
      ts: "2026-05-19T12:00:00.000Z",
      task_id: "t_x",
      payload: { text: "z".repeat(500) },
    }, V);
    expect(line).toContain("🧠💬");
    expect(line).toContain("brain_message_emitted");
    expect(line).toContain("text=");
    expect(line.length).toBeLessThanOrEqual(MAX_EVENT_LINE_CHARS);
  });

  test("brain_reasoning_recorded renders summary= prefix", () => {
    const line = formatEvent({
      id: "ev_br",
      kind: "brain_reasoning_recorded",
      ts: "2026-05-19T12:00:00.000Z",
      task_id: "t_x",
      payload: { summary: "decomposing directive into 3 sub-tasks per docs/v2-design.md" },
    }, V);
    expect(line).toContain("🧠💭");
    expect(line).toContain("brain_reasoning_recorded");
    expect(line).toContain("summary=");
    expect(line).toContain("decomposing");
    expect(line.length).toBeLessThanOrEqual(MAX_EVENT_LINE_CHARS);
  });

  test("bridge_frame_received renders frame= prefix with tool name", () => {
    const line = formatEvent({
      id: "ev_bf",
      kind: "bridge_frame_received",
      ts: "2026-05-19T12:00:00.000Z",
      task_id: "t_x",
      payload: { frame_type: "tool_call", tool_name: "substrate.read" },
    }, V);
    expect(line).toContain("·");
    expect(line).toContain("bridge_frame_received");
    expect(line).toContain("frame=tool_call");
    expect(line).toContain("tool=substrate.read");
    expect(line.length).toBeLessThanOrEqual(MAX_EVENT_LINE_CHARS);
  });

  test("candidate_confirmed renders candidate= and confidence delta", () => {
    const line = formatEvent({
      id: "ev_cc",
      kind: "candidate_confirmed",
      ts: "2026-05-19T12:00:00.000Z",
      task_id: "t_x",
      payload: {
        candidate_id: "cand_abcdef0123456789",
        confidence_delta: 0.15,
        knowledge_id: "kn_xyz0123456789abcdef",
      },
    }, V);
    expect(line).toContain("📚✓");
    expect(line).toContain("candidate_confirmed");
    expect(line).toContain("candidate=cand_abcd");
    expect(line).toContain("conf+=0.15");
    expect(line.length).toBeLessThanOrEqual(MAX_EVENT_LINE_CHARS);
  });

  test("embedding_computed renders subject= and model (default fallback)", () => {
    const line = formatEvent({
      id: "ev_ec",
      kind: "embedding_computed",
      ts: "2026-05-19T12:00:00.000Z",
      task_id: "t_x",
      payload: { subject_event_id: "ev_subject_1234567890", dims: 1536 },
    }, V);
    expect(line).toContain("Ε");
    expect(line).toContain("embedding_computed");
    expect(line).toContain("subject=ev_subject_");
    expect(line).toContain("model=default");
    expect(line).toContain("dims=1536");
    expect(line.length).toBeLessThanOrEqual(MAX_EVENT_LINE_CHARS);
  });

  test("knowledge_propagated renders candidate= and fanout count", () => {
    const line = formatEvent({
      id: "ev_kp",
      kind: "knowledge_propagated",
      ts: "2026-05-19T12:00:00.000Z",
      task_id: "t_x",
      payload: {
        candidate_id: "cand_propagateme01234",
        target_directives: ["d1", "d2", "d3"],
      },
    }, V);
    // knowledge_propagated has no glyph entry; the kind name is still pinned.
    expect(line).toContain("knowledge_propagated");
    expect(line).toContain("candidate=cand_propa");
    expect(line).toContain("fanout=3");
    expect(line.length).toBeLessThanOrEqual(MAX_EVENT_LINE_CHARS);
  });

  test("origin_calibration_recorded renders origin + shape + Δα/Δβ", () => {
    const line = formatEvent({
      id: "ev_oc",
      kind: "origin_calibration_recorded",
      ts: "2026-05-19T12:00:00.000Z",
      task_id: "t_x",
      payload: {
        origin: "claude_inline",
        goal_shape: "code_edit_2026",
        alpha_delta: 1,
        beta_delta: 0,
      },
    }, V);
    expect(line).toContain("origin_calibration_recorded");
    expect(line).toContain("origin=claude_inline");
    expect(line).toContain("shape=code_edit_");
    expect(line).toContain("Δα=1");
    expect(line).toContain("Δβ=0");
    expect(line.length).toBeLessThanOrEqual(MAX_EVENT_LINE_CHARS);
  });

  test("recipe_promotion_deferred renders recipe= and reason", () => {
    const line = formatEvent({
      id: "ev_rpd",
      kind: "recipe_promotion_deferred",
      ts: "2026-05-19T12:00:00.000Z",
      task_id: "t_x",
      payload: {
        recipe_id: "rec_abcdef0123456789",
        reason: "insufficient_evidence",
      },
    }, V);
    expect(line).toContain("recipe_promotion_deferred");
    expect(line).toContain("recipe=rec_abcdef");
    expect(line).toContain("reason=insufficient_evidence");
    expect(line.length).toBeLessThanOrEqual(MAX_EVENT_LINE_CHARS);
  });

  test("retrieval_binding renders source + hits + top_score", () => {
    const line = formatEvent({
      id: "ev_rb",
      kind: "retrieval_binding",
      ts: "2026-05-19T12:00:00.000Z",
      task_id: "t_x",
      payload: {
        source_event_id: "ev_source_0123456789",
        retrieved_event_ids: ["e1", "e2", "e3", "e4", "e5"],
        score: 0.87,
      },
    }, V);
    expect(line).toContain("retrieval_binding");
    expect(line).toContain("source=ev_source_");
    expect(line).toContain("hits=5");
    expect(line).toContain("top_score=0.87");
    expect(line.length).toBeLessThanOrEqual(MAX_EVENT_LINE_CHARS);
  });

  test("worker_tick_completed renders worker + elapsed + status", () => {
    const line = formatEvent({
      id: "ev_wt",
      kind: "worker_tick_completed",
      ts: "2026-05-19T12:00:00.000Z",
      task_id: "t_x",
      payload: {
        worker_name: "embedding_worker",
        elapsed_ms: 42,
        status: "ok",
      },
    }, V);
    expect(line).toContain("worker_tick_completed");
    expect(line).toContain("worker=embedding_worker");
    expect(line).toContain("elapsed=42ms");
    expect(line).toContain("status=ok");
    expect(line.length).toBeLessThanOrEqual(MAX_EVENT_LINE_CHARS);
  });

  test("graceful fallback when payload fields are missing", () => {
    // Each renderer must not leak `undefined` for missing optional fields.
    const empty = formatEvent({
      id: "ev_empty",
      kind: "brain_message_emitted",
      ts: "2026-05-19T12:00:00.000Z",
      task_id: "t_x",
      payload: {},
    }, V);
    expect(empty).not.toContain("undefined");
    expect(empty).toContain("text=<unset>");
    expect(empty.length).toBeLessThanOrEqual(MAX_EVENT_LINE_CHARS);
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
    // these exact knobs to satisfy the panel UX predicate. Heartbeat
    // cadence constants pinned at 0 (2026-05-19): heartbeat lines were
    // removed in favor of SSE-transport keepalive; the synthetic lines
    // created panel noise without adding signal beyond what real event
    // emission already conveys.
    expect(MAX_EVENT_LINE_CHARS).toBe(120);
    expect(FOLLOW_HEARTBEAT_MS).toBe(0);
    expect(FOLLOW_HEARTBEAT_WINDOW_MS).toBe(0);
  });
});
