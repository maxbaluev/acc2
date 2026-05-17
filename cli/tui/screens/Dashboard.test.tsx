// cli/tui/screens/Dashboard.test.tsx — isolated render test for the
// six-panel dashboard. Verifies that the seven-question wiring renders
// every canonical surface (live counts, refinement legend, learning
// numbers, change tallies) when fed a seeded snapshot. Parallels
// App.test.tsx but skips the App-level wiring so a failure in this
// suite localizes to the Dashboard component itself.

import React from "react";
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { Dashboard } from "./Dashboard";
import { initialSnapshot, type DashboardSnapshot } from "../state/store";

const seedSnapshot = (): DashboardSnapshot => {
  const snap = initialSnapshot();
  snap.loading = false;
  snap.dispatch = [
    {
      directive_id: "DALPHA0001",
      root_task_id: "TR-A",
      lifecycle_status: "completed",
      status_reason: null,
      residual: 0.05,
      latest_signal_at: "2026-05-17T00:00:00Z",
      terminal_kind: "task_committed",
      evidence_event_id: "EVT-ALPHA",
      queued_reason: null,
    },
    {
      directive_id: "DBETA0002",
      root_task_id: "TR-B",
      lifecycle_status: "failed",
      status_reason: "verifier_residual_high",
      residual: 0.7,
      latest_signal_at: "2026-05-17T00:00:00Z",
      terminal_kind: "task_failed",
      evidence_event_id: "EVT-BETA",
      queued_reason: null,
    },
  ];
  snap.ready_tasks = [
    { directive_id: "DALPHA0001", task_id: "TASKR1", goal: "refine knowledge candidate" },
  ];
  snap.pending_decisions = [
    {
      group_key: "rules/x|a1",
      target: ".claude/rules/orchestrator-runtime.md",
      anchor: "a1",
      duplicate_count: 5,
      representative_event_id: "EVT_REP_X",
      newest_ts: "2026-05-17T00:00:00Z",
      shape_quality_score: 1.0,
      target_risk_score: 1.0,
      staleness_score: 0.2,
      group_decline_reason: null,
      decision_rank: 0.95,
    },
  ];
  snap.pending_decisions_total = 1;
  snap.learning = { knowledge_total: 88, knowledge_24h: 4, contradictions: 2, recipes_recent: 3, artifacts_recent: 0 };
  snap.changes = { applied_24h: 11, failed_24h: 1, irreversible_24h: 0, closed_directives: [{ directive_id: "DALPHA0001", closure_residual: 0.05, ts: "2026-05-17T00:00:00Z" }] };
  snap.next = { ready_count: 3, active_objectives: 7, conflicts: 1, rolling_review_due: 2 };
  snap.owner_profile = { detected_language: "en", autonomy_score: 0.5, autonomy_score_floor: 0.4 };
  return snap;
};

describe("Dashboard component", () => {
  test("renders all six panels with substrate-bound numbers and lifecycle vocab", () => {
    const { lastFrame, unmount } = render(
      React.createElement(Dashboard, { snapshot: seedSnapshot(), focus: "inbox" }),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("INBOX (pending decisions: 1)");
    expect(frame).toContain("DISPATCH TRUTH (last 24h)");
    expect(frame).toContain("DAG (current directive)");
    expect(frame).toContain("LEARNING");
    expect(frame).toContain("NEXT (if I do nothing)");
    expect(frame).toContain("CHANGES (last 24h)");
    // canonical lifecycle tokens, exact strings
    expect(frame).toContain("completed");
    expect(frame).toContain("failed");
    // closure residual rendered next to the completed dispatch
    expect(frame).toContain("0.05");
    // Refinement-edge glyph distinct from requires arrow.
    expect(frame).toContain("↻ refines");
    expect(frame).toContain("→ requires");
    // Changes panel tallies surfaced.
    expect(frame).toContain("11");
    // Inbox decision-rank visible.
    expect(frame).toContain("0.95");
    unmount();
  });
});
