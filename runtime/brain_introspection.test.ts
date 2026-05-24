// Tests for the brain self-introspection surface — system_map,
// brain_self_audit, trajectory_replay, prompt_self_inspect. Each builder
// is a pure read over a fresh in-memory substrate; we seed the events
// table by hand to keep the tests hermetic.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { runViews } from "../substrate/views";
import { emitEvent, flushPostCommitProjectionsForTest, resetPostCommitProjectionsForTest } from "./events";
import {
  buildBrainSelfAudit,
  buildPromptSelfInspect,
  buildSystemMap,
  buildTrajectoryReplay,
  renderBrainSelfAuditSection,
} from "./brain_introspection";

afterAll(() => closeDb());
beforeEach(() => {
  // Non-blocking post-commit cascade (directive NHY908W0EX5Q72KGWXMASPFEY0):
  // emitEvent defers heavy projections onto the bounded post-commit queue.
  // Reset between cases; the audit test drains before aggregating.
  resetPostCommitProjectionsForTest();
  closeDb();
});

describe("buildSystemMap", () => {
  test("returns a non-empty catalog covering kinds + views + tools + runtimes", () => {
    const db = openDb(":memory:");
    runViews(db);
    const map = buildSystemMap(db);
    expect(map.event_kinds.total).toBeGreaterThan(100);
    expect(Object.keys(map.event_kinds.by_producer)).toEqual(
      expect.arrayContaining(["brain", "claude", "runtime", "substrate"]),
    );
    expect(map.event_kinds.brain_emissible.length).toBeGreaterThan(0);
    expect(map.event_kinds.brain_emissible.every((k) => k.producer === "brain" || k.producer === "both")).toBe(true);
    expect(map.views.total).toBeGreaterThan(20);
    expect(map.views.names).toContain("dispatch_resolved_view");
    expect(map.tools.substrate_methods).toContain("substrate.emit");
    expect(map.tools.runtime_methods).toContain("runtime.system_map");
    expect(map.tools.runtime_methods).toContain("runtime.brain_self_audit");
    expect(map.tools.runtime_methods).toContain("runtime.trajectory_replay");
    expect(map.tools.runtime_methods).toContain("runtime.prompt_self_inspect");
    expect(map.runtimes).toEqual(["bun", "uv", "camofox-browser"]);
  });

  test("artifact_registry.top_by_score honours quarantine filter and the K cap", () => {
    const db = openDb(":memory:");
    runViews(db);
    const now = new Date().toISOString();
    // Two artifacts; one quarantined. Only the admitted one should
    // appear in top_by_score.
    db.run(
      `INSERT INTO act_artifact (id, runtime, body, declared_sandbox, state_root, name, fixture_input, fixture_expected_residual, status, score, confidence, created_at, updated_at)
       VALUES (?, 'bun', 'export const x=1', '{"runtime":"bun"}', '/tmp', 'visible', '{}', 0.0, 'admitted', 0.8, 0.6, ?, ?)`,
      ["art_visible", now, now],
    );
    db.run(
      `INSERT INTO act_artifact (id, runtime, body, declared_sandbox, state_root, name, fixture_input, fixture_expected_residual, status, score, confidence, created_at, updated_at)
       VALUES (?, 'bun', 'export const y=2', '{"runtime":"bun"}', '/tmp', 'hidden', '{}', 0.0, 'quarantined', 0.9, 0.7, ?, ?)`,
      ["art_hidden", now, now],
    );
    const map = buildSystemMap(db, { artifactTopK: 5 });
    expect(map.artifact_registry.top_by_score.map((a) => a.id)).toEqual(["art_visible"]);
    expect(map.artifact_registry.total).toBe(1);
  });
});

describe("buildBrainSelfAudit", () => {
  test("fresh substrate returns zeroed report card", () => {
    const db = openDb(":memory:");
    runViews(db);
    const audit = buildBrainSelfAudit(db);
    expect(audit.emissions.total).toBe(0);
    expect(audit.citations.promotion_rate).toBe(0);
    expect(audit.proposals.accept_rate).toBe(0);
    expect(audit.residuals.samples).toBe(0);
    expect(audit.residuals.p50).toBeNull();
  });

  test("recent_brain_failures catches dispatcher_violation rows tagged substrate_auto by following the task_id chain back to brain emissions", () => {
    // Pre-fix: brain_self_audit filtered `substrate_origin = 'opencode'
    // OR invoker = 'opencode'`. dispatcher_violation rows are emitted by
    // the dispatcher with substrate_origin='substrate_auto' (the
    // dispatcher worker is the immediate author), so the old filter
    // never surfaced them. Fix: also include rows whose task_id appears
    // in at least one brain-emitted event in the same window.
    const db = openDb(":memory:");
    runViews(db);
    const directiveId = "dir_brain_failure";
    const taskId = "task_brain_failure";
    // Brain emits action_predicted on the task.
    emitEvent(db, {
      kind: "action_predicted",
      substrate_origin: "opencode",
      directive_id: directiveId,
      task_id: taskId,
      action_artifact_id: "a1",
      verifier_artifact_id: "v1",
      predicted_residual: 0.4,
      payload: { intent: "test" },
    });
    // Substrate-side dispatcher then emits dispatcher_violation against
    // the same task_id with substrate_auto origin.
    emitEvent(db, {
      kind: "dispatcher_violation",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      task_id: taskId,
      failure_kind: "cycle_1_only_breach",
      payload: { reason: "test breach" },
    });
    const audit = buildBrainSelfAudit(db);
    expect(audit.recent_brain_failures.length).toBe(1);
    expect(audit.recent_brain_failures[0]?.kind).toBe("dispatcher_violation");
    expect(audit.recent_brain_failures[0]?.task_id).toBe(taskId);
  });

  test("populated substrate aggregates emissions, citations, residuals, proposals", async () => {
    const db = openDb(":memory:");
    runViews(db);
    const directiveId = "dir_audit";
    const taskId = "task_audit";

    // Brain-origin emissions: 2 knowledge_candidates, 1 lesson, 1 amendment.
    for (let i = 0; i < 2; i++) {
      emitEvent(db, {
        kind: "knowledge_candidate",
        substrate_origin: "opencode",
        directive_id: directiveId,
        task_id: taskId,
        payload: { claim: `kc ${i}` },
      });
    }
    emitEvent(db, {
      kind: "lesson_extracted",
      substrate_origin: "opencode",
      directive_id: directiveId,
      task_id: taskId,
      payload: { summary: "l1" },
    });
    emitEvent(db, {
      kind: "contract_amendment_proposed",
      substrate_origin: "opencode",
      directive_id: directiveId,
      task_id: taskId,
      payload: { target_resource: "repo:foo.ts", anchor: "X" },
    });
    // One promotion + one apply outcome (committed) so accept_rate > 0.
    // Emit the REAL production promotion event (`knowledge_promoted`,
    // emitted by the extractor promotion spine) carrying `candidate_id`
    // — NOT the phantom `origin_promoted` kind that nothing in production
    // ever emits. This exercises the same event production actually emits.
    emitEvent(db, {
      kind: "knowledge_promoted",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      task_id: taskId,
      payload: { candidate_id: "cand_k1" },
    });
    emitEvent(db, {
      kind: "applied_change_committed",
      substrate_origin: "claude_root",
      directive_id: directiveId,
      task_id: taskId,
      payload: { source_kind: "contract_amendment_proposed", status: "success" },
    });
    // Two action_scored residuals — one passing, one over threshold.
    // Pass action_artifact_id so the action_scored null-id lift gate
    // (runtime/events.ts brain lesson TA4X4Q36XH38789BWQMV2AYB3W) sees
    // a registered handle and projects normally without emitting a
    // sibling dispatcher_violation.
    emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      task_id: taskId,
      action_artifact_id: "test_action_handle",
      verifier_artifact_id: "test_verifier_handle",
      residual: 0.1,
      payload: { residual: 0.1, verifier_kind: "deterministic_code" },
    });
    emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      task_id: taskId,
      action_artifact_id: "test_action_handle",
      verifier_artifact_id: "test_verifier_handle",
      residual: 0.6,
      payload: { residual: 0.6, verifier_kind: "deterministic_code" },
    });
    await flushPostCommitProjectionsForTest();

    const audit = buildBrainSelfAudit(db);
    expect(audit.emissions.total).toBe(4);
    expect(audit.emissions.by_kind.knowledge_candidate).toBe(2);
    expect(audit.emissions.by_kind.lesson_extracted).toBe(1);
    expect(audit.emissions.by_kind.contract_amendment_proposed).toBe(1);
    expect(audit.citations.knowledge_candidates_emitted).toBe(2);
    expect(audit.citations.knowledge_candidates_promoted).toBe(1);
    expect(audit.citations.promotion_rate).toBeCloseTo(0.5, 5);
    expect(audit.proposals.lesson_extracted_count).toBe(1);
    expect(audit.proposals.contract_amendment_proposed_count).toBe(1);
    // F6 extension: lesson_extracted now triggers a lesson_extractor_v1
    // internal-act projection, which emits one applied_change_committed
    // alongside the direct applied_change_committed the fixture seeds.
    expect(audit.proposals.applied_committed_count).toBe(2);
    expect(audit.proposals.accept_rate).toBeCloseTo(1.0, 5);
    // F6 extension: the lesson_extractor_v1 projection also adds one
    // action_scored row (predicted_residual=0.4), so the sample count
    // includes that alongside the fixture's two scored emits.
    expect(audit.residuals.samples).toBe(3);
    expect(audit.residuals.p50).not.toBeNull();
  });
});

describe("buildTrajectoryReplay", () => {
  test("returns null for unknown directive", () => {
    const db = openDb(":memory:");
    runViews(db);
    expect(buildTrajectoryReplay(db, "missing")).toBeNull();
  });

  test("walks directive → tasks → terminals + lessons + amendments", () => {
    const db = openDb(":memory:");
    runViews(db);
    const directiveId = "dir_traj";
    emitEvent(db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: directiveId,
      payload: { directive_text: "test directive" },
    });
    // Two task nodes — one committed, one open.
    emitEvent(db, {
      kind: "task_node_opened",
      substrate_origin: "opencode",
      directive_id: directiveId,
      task_id: "t1",
      payload: { goal: "first task" },
    });
    emitEvent(db, {
      kind: "task_committed",
      substrate_origin: "opencode",
      directive_id: directiveId,
      task_id: "t1",
      payload: { summary: "done" },
    });
    emitEvent(db, {
      kind: "task_node_opened",
      substrate_origin: "opencode",
      directive_id: directiveId,
      task_id: "t2",
      parent_task_id: "t1",
      payload: { goal: "child task" },
    });
    // One lesson and one amendment.
    emitEvent(db, {
      kind: "lesson_extracted",
      substrate_origin: "opencode",
      directive_id: directiveId,
      task_id: "t1",
      payload: { summary: "learn-x" },
    });
    emitEvent(db, {
      kind: "contract_amendment_proposed",
      substrate_origin: "opencode",
      directive_id: directiveId,
      task_id: "t1",
      payload: { target_resource: "repo:a.ts", anchor: "Y" },
    });

    const replay = buildTrajectoryReplay(db, directiveId);
    expect(replay).not.toBeNull();
    expect(replay!.directive_text).toBe("test directive");
    expect(replay!.task_count).toBe(2);
    expect(replay!.nodes.map((n) => n.task_id)).toEqual(["t1", "t2"]);
    expect(replay!.nodes[0]!.status).toBe("committed");
    expect(replay!.nodes[1]!.status).toBe("open");
    expect(replay!.nodes[1]!.parent_task_id).toBe("t1");
    expect(replay!.lessons.length).toBeGreaterThan(0);
    expect(replay!.amendments[0]!.target_resource).toBe("repo:a.ts");
  });
});

describe("buildPromptSelfInspect", () => {
  test("returns null for unknown task", async () => {
    const db = openDb(":memory:");
    runViews(db);
    expect(await buildPromptSelfInspect(db, "missing")).toBeNull();
  });

  test("returns section names + budgets + truncation list for a real task", async () => {
    const db = openDb(":memory:");
    runViews(db);
    const directiveId = "dir_inspect";
    const taskId = "task_inspect";
    emitEvent(db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: directiveId,
      payload: { directive_text: "self-inspect test" },
    });
    emitEvent(db, {
      kind: "task_node_opened",
      substrate_origin: "opencode",
      directive_id: directiveId,
      task_id: taskId,
      payload: { goal: "test goal" },
    });
    const inspect = await buildPromptSelfInspect(db, taskId, { includePreview: true });
    expect(inspect).not.toBeNull();
    expect(inspect!.directive_id).toBe(directiveId);
    expect(inspect!.sections.length).toBeGreaterThan(0);
    expect(inspect!.sections.map((s) => s.name)).toContain("task_goal");
    expect(inspect!.preview.length).toBeGreaterThan(0);
  });
});

describe("renderBrainSelfAuditSection", () => {
  test("renders a tight prompt block with header + headline metrics", () => {
    const db = openDb(":memory:");
    runViews(db);
    const audit = buildBrainSelfAudit(db);
    const block = renderBrainSelfAuditSection(audit);
    expect(block).toContain("BRAIN SELF-AUDIT");
    expect(block).toContain("emissions=");
    expect(block).toContain("citations:");
    expect(block).toContain("proposals:");
    expect(block).toContain("residuals:");
    expect(block).toContain("effectiveness:");
  });
});
