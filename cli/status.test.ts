import { describe, expect, test } from "bun:test";
import { renderStatusReport, type StatusReport, isTier0ReplayEvent, COMPOUNDING_EVENT_KINDS } from "./status";

describe("renderStatusReport", () => {
  test("renders owner-state status fields for one-screen CLI/TUI reuse", () => {
    const report: StatusReport = {
      generated_at: "2026-05-16T00:00:00.000Z",
      contract: { name: "acc_current_state", version: 1, lifecycle_values: ["live", "queued_at_cap", "completed", "failed", "zombie"], sources: {} },
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


describe("compounding metric veracity", () => {
  // Regression for the metric-veracity bug: compounded/tier0 reported 0 even
  // while knowledge/recipes/artifacts were plainly growing, because the metric
  // only read the near-always-empty applied_lesson_effectiveness_view chain.
  // The fix counts genuine compounding-signal events from the ledger.

  test("tier-0 replay hit is detected from a real substrate_replay dispatch_decided event", () => {
    const replayDispatch = {
      event_id: "E_replay",
      ts: "2026-05-23T00:00:00.000Z",
      kind: "dispatch_decided",
      payload: { route: "substrate_replay", recipe_id: "R1" },
    };
    const freshDispatch = {
      event_id: "E_fresh",
      ts: "2026-05-23T00:00:01.000Z",
      kind: "dispatch_decided",
      payload: { route: "opencode_brain" },
    };
    expect(isTier0ReplayEvent(replayDispatch)).toBe(true);
    expect(isTier0ReplayEvent(freshDispatch)).toBe(false);
    // Alternative reusable-trajectory replay flag also counts.
    expect(isTier0ReplayEvent({ kind: "task_committed", payload: { reusable_trajectory_replay_selected: true } })).toBe(true);
    expect(isTier0ReplayEvent({ kind: "action_scored", payload: { recipe_replayed: 1 } })).toBe(true);
  });

  test("compounding signal kinds are the genuine credit/confirmation events, not the empty effectiveness chain", () => {
    // These are the real compounding events the substrate emits during credit
    // distribution and knowledge confirmation — the metric now counts them.
    expect(COMPOUNDING_EVENT_KINDS).toContain("candidate_confirmed");
    expect(COMPOUNDING_EVENT_KINDS).toContain("knowledge_propagated");
    expect(COMPOUNDING_EVENT_KINDS).toContain("meta_credit_projected");
    expect(COMPOUNDING_EVENT_KINDS).toContain("coalition_credit_distributed");
    expect(COMPOUNDING_EVENT_KINDS).toContain("dense_closure_credit_distributed");
  });

  test("status.ts derives compounded/tier0 from recent_events, not solely the effectiveness view", async () => {
    const source = await Bun.file(new URL("./status.ts", import.meta.url)).text();
    // compounded_total adds genuine compounding events to any effectiveness-view hits.
    expect(source).toContain('countTrue(effectivenessRows, "compounded") + compoundingEvents.length');
    // tier0 adds substrate_replay dispatch hits.
    expect(source).toContain('dispatchDecidedEvents.filter(isTier0ReplayEvent).length');
    // and the new event fetches are wired in.
    expect(source).toContain("recentEvents([...COMPOUNDING_EVENT_KINDS])");
    expect(source).toContain('recentEvents(["dispatch_decided"])');
  });
});


test("status-live-pending-owner-decision-source-regression", async () => {
  const source = await Bun.file(new URL("./status.ts", import.meta.url)).text();
  expect(source).toContain('pending_owner_decisions: ["pending_owner_decision_queue_live_view"]');
  expect(source).toContain('readView("pending_owner_decision_queue_live_view")');
  expect(source).toContain('rows<Record<string, unknown>>("pending_owner_decision_queue_live_view", pendingEnv)');
  expect(source).not.toContain('pending_owner_decisions: ["pending_owner_decision_queue_view"]');
});
