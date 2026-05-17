// cli/tui/App.test.tsx — Ink-testing-library coverage for the TUI shell.
//
// We exercise the App component against a hand-built mock SubstrateClient
// (no daemon required) so the test is hermetic. The two acceptance
// invariants covered here:
//
//   1. The dashboard renders every canonical panel title with the
//      lifecycle-status vocabulary preserved exactly. Tests the
//      "data-binding → UI" wiring end-to-end without spinning a daemon.
//   2. Typing into the command palette and pressing Enter emits a
//      canonical `acc <argv>` invocation through the onCommand callback.
//      Tests that the palette IS the CLI surface.

import React from "react";
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { App } from "./App";
import type { SubstrateClient } from "./transport/substrate-client";
import { initialSnapshot } from "./state/store";
import type { CommandIntent } from "./components/CommandPalette";

const stubClient = (): SubstrateClient => ({
  read: async () => ({ ok: true, result: [] }),
  recentEvents: async () => ({ ok: true, result: { events: [] } }),
  health: async () => ({ ok: true, status: "ok", uptime_s: 3600, events_count: 100, stuck_workers: [] }),
  sseConnect: async function* () { /* no events */ },
});

const seededSnapshot = () => {
  const snap = initialSnapshot();
  snap.loading = false;
  snap.health = { daemon_status: "ok", uptime_s: 3600, events_count: 42, bridge_recent_failures: 0, bridge_recent_completions: 1, verdict: "ALIVE" };
  snap.dispatch = [
    {
      directive_id: "D1ABCDEFGHIJK",
      root_task_id: "TR-ABCDE",
      lifecycle_status: "live",
      status_reason: "in_progress",
      residual: null,
      latest_signal_at: "2026-05-17T00:00:00Z",
      terminal_kind: null,
      evidence_event_id: null,
      queued_reason: null,
    },
    {
      directive_id: "D2QRSTUVWX",
      root_task_id: "TR-WXYZ",
      lifecycle_status: "queued_at_cap",
      status_reason: "scheduler_cap",
      residual: null,
      latest_signal_at: "2026-05-17T00:00:00Z",
      terminal_kind: null,
      evidence_event_id: null,
      queued_reason: "cap_2_ahead",
    },
    {
      directive_id: "D3DONEABCDE",
      root_task_id: "TR-DONE1",
      lifecycle_status: "completed",
      status_reason: "task_committed",
      residual: 0.18,
      latest_signal_at: "2026-05-17T00:00:00Z",
      terminal_kind: "task_committed",
      evidence_event_id: "EVT-DONE",
      queued_reason: null,
    },
  ];
  snap.pending_decisions = [
    {
      group_key: "docs/foo|anchor1",
      target: "docs/foo.md",
      anchor: "anchor1",
      duplicate_count: 3,
      representative_event_id: "EVT_REP1",
      newest_ts: "2026-05-17T00:00:00Z",
      shape_quality_score: 1.0,
      target_risk_score: 0.65,
      staleness_score: 0.1,
      group_decline_reason: null,
      decision_rank: 0.82,
    },
  ];
  snap.pending_decisions_total = 1;
  snap.learning = { knowledge_total: 12, knowledge_24h: 3, contradictions: 0, recipes_recent: 1, artifacts_recent: 2 };
  snap.brain_activity = {
    amendments: [
      { event_id: "AMENDEV_ABC123", ts: "2026-05-17T00:00:00Z", target: "CLAUDE.md", anchor: "## Act And Verification", has_diff: true, applied: false },
      { event_id: "AMENDEV_DONE99", ts: "2026-05-17T00:01:00Z", target: "CLAUDE.md", anchor: "## Actors", has_diff: true, applied: true },
    ],
    pending_amendment_count: 1,
    knowledge: [{ event_id: "KEV_42", ts: "2026-05-17T00:02:00Z", claim: "Unified act_tuple_recorded envelope is the elegant primitive." }],
    lessons: [{ event_id: "LEV_24", ts: "2026-05-17T00:03:00Z", summary: "Per-mutation wrappers bloat the event table." }],
  };
  snap.changes = { applied_24h: 4, failed_24h: 0, irreversible_24h: 0, closed_directives: [] };
  snap.next = { ready_count: 2, active_objectives: 5, conflicts: 0, rolling_review_due: 1 };
  snap.owner_profile = {
    detected_language: "en",
    autonomy_score: 0.62,
    autonomy_score_floor: 0.4,
    preferred_terms: ["substrate"],
    avoided_terms: [],
  };
  return snap;
};

describe("acc watch — Ink TUI shell", () => {
  test("dashboard renders all six canonical panels and preserves lifecycle vocabulary verbatim", () => {
    const client = stubClient();
    const { lastFrame, unmount } = render(
      React.createElement(App, { client, pollDisabled: true, initial: seededSnapshot() }),
    );
    const frame = lastFrame() ?? "";
    // Canonical panel titles bound 1:1 to substrate views — proving the
    // seven-question framework is rendered, not paraphrased.
    expect(frame).toContain("INBOX");
    expect(frame).toContain("DISPATCH TRUTH");
    expect(frame).toContain("DAG");
    expect(frame).toContain("LEARNING");
    expect(frame).toContain("NEXT");
    expect(frame).toContain("CHANGES");
    // Lifecycle vocabulary preserved exactly — never relabeled.
    expect(frame).toContain("live");
    expect(frame).toContain("queued_at_cap");
    // Residual shows only on terminal rows (completed/failed); live and
    // queued rows surface the substrate-owned status_reason instead.
    expect(frame).toContain("residual=0.18");
    expect(frame).toContain("reason=in_progress");
    expect(frame).toContain("reason=scheduler_cap");
    // Refinement edges visually distinct from requires/watches in the DAG legend.
    expect(frame).toContain("requires");
    expect(frame).toContain("refines");
    expect(frame).toContain("watches");
    // Owner identity surfaced in the status line.
    expect(frame).toContain("autonomy=0.62");
    unmount();
  });

  test("brain-activity drawer surfaces recent contract amendments + pending count + event_ids", async () => {
    const client = stubClient();
    const { lastFrame, unmount } = render(
      React.createElement(App, {
        client,
        pollDisabled: true,
        initial: seededSnapshot(),
        initialDrawer: "brain",
      }),
    );


    const frame = lastFrame() ?? "";
    expect(frame).toContain("BRAIN ACTIVITY");
    expect(frame).toContain("pending amendments: 1");
    expect(frame).toContain("AMENDEV_ABC1");
    expect(frame).toContain("AMENDEV_DONE");
    expect(frame).toContain("✓");
    expect(frame).toContain("act_tuple_recorded envelope");
    expect(frame).toContain("Per-mutation wrappers");
    unmount();
  });

  test("hotkey 'i' opens INBOX drawer with empty buffer — no Esc required", async () => {
    const client = stubClient();
    const { stdin, lastFrame, unmount } = render(
      React.createElement(App, { client, pollDisabled: true, initial: seededSnapshot() }),
    );
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    stdin.write("i");
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("pending_owner_decision_queue_view");
    unmount();
  });

  test("command palette emits a canonical `acc task ...` argv when the operator types into it", async () => {
    const intents: CommandIntent[] = [];
    const client = stubClient();
    const { stdin, unmount } = render(
      React.createElement(App, {
        client,
        pollDisabled: true,
        initial: seededSnapshot(),
        onCommand: (intent) => { intents.push(intent); },
      }),
    );

    // The palette is active by default. Ink's keypress parser only
    // recognizes `\r` as the return key when it is the WHOLE chunk;
    // a multi-char chunk falls through as opaque text. Additionally,
    // ink-testing-library's Stdin.write replaces `data` on every call,
    // so two writes inside one microtask drop the first. Both
    // constraints force one char per write with a flush in between.
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    const sequence = "task hello world";
    for (const ch of sequence) {
      stdin.write(ch);
      await tick();
    }
    stdin.write("\r");
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(intents.length).toBe(1);
    const intent = intents[0]!;
    expect(intent.kind).toBe("shell");
    if (intent.kind === "shell") {
      expect(intent.argv[0]).toBe("task");
      expect(intent.argv[1]).toBe("hello world");
      expect(intent.raw).toBe("task hello world");
    }
    unmount();
  });
});
