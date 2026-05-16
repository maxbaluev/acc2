import { describe, expect, test } from "bun:test";
import { renderStatusReport, type StatusReport } from "./status";

describe("renderStatusReport", () => {
  test("renders owner-state status fields for one-screen CLI/TUI reuse", () => {
    const report: StatusReport = {
      generated_at: "2026-05-16T00:00:00.000Z",
      contract: { name: "acc_status_snapshot", version: 1, lifecycle_values: ["live", "queued_at_cap", "completed", "failed", "zombie"], sources: {} },
      daemon: { running: true, status: "ok", pid: 123, uptime_s: 7, stuck_workers: 0 },
      dispatch_lifecycle: { live: 1, queued_at_cap: 2, completed: 3, failed: 4, zombie: 5, total: 15 },
      pending_owner_decisions: { count: 6, top: [] },
      owner_profile: { autonomy_score: 0.8, autonomy_score_floor: 0.4, detected_language: "en", preferred_terms: ["contract", "event"], avoided_terms: ["agent"], things_to_never_do: [], manual_review_patterns: [], hot_topics: [], signal_summary: {} },
      learning: { knowledge_total: 10, knowledge_24h: 1, recipe_total: 20, recipe_24h: 2, artifact_total: 30, artifact_24h: 3, applied_lessons_total: 7, applied_lessons_24h: 1, compounded_total: 2, tier0_replay_hits: 1, avg_residual_delta: 0.12, contradictions: 4 },
      actual_changes: { applied_24h: 2, failed_24h: 1, refused_24h: 0, recent: [] },
      active_directives: [{ directive_id: "D1234567890", root_task_id: "T1234567890", status: "live", reason: "brain_dispatch_open", closure_residual: 0.12, latest_signal_at: "2026-05-16T00:00:00.000Z" }],
      ready_tasks: { count: 1, sample: [{ directive_id: "D1234567890", task_id: "T1234567890", goal: "ship status" }] },
      blocked: ["owner_decision_required=6"],
      next_action: "answer_owner_decision",
      failures: [{ failure_kind: "bridge_failed", count: 1, latest_ts: "2026-05-16T00:00:00.000Z" }],
      view_errors: {},
    };

    const out = renderStatusReport(report);
    expect(out).toContain("next_action=answer_owner_decision");
    expect(out).toContain("pending_decisions=6 autonomy_score=0.80");
    expect(out).toContain("live=1 queued_at_cap=2 completed=3 failed=4 zombie=5 total=15");
    expect(out).toContain("knowledge=10 (+1/24h) recipes=20 (+2/24h) artifacts=30 (+3/24h) applied_lessons=7 (+1/24h) compounded=2 tier0=1 contradictions=4");
    expect(out).toContain("applied_24h=2 failed_24h=1 refused_24h=0");
    expect(out).toContain("closure_residual=0.12");
  });
});
