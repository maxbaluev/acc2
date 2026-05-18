import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import {
  buildOwnerFeedbackSummarySection,
  buildOwnerProfileSection,
  buildOwnerRenderingPolicySection,
  composePrompt,
  estimateTokens,
  readOwnerProfile,
} from "./prompt_composer";
import type { OwnerRenderingPolicyRow } from "../substrate/views";
import { newId } from "./ids";
import { goalShape } from "./goal_shape";
import { seedFoundationalKnowledge } from "../substrate/seed";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const openTask = (db: ReturnType<typeof openDb>): { directiveId: string; taskId: string } => {
  seedFoundationalKnowledge(db, { ownerApproved: true });
  const directiveId = newId();
  const taskId = newId();
  emitEvent(db, {
    kind: "directive_opened",
    substrate_origin: "owner",
    directive_id: directiveId,
    task_id: directiveId,
    payload: { directive_text: "Count files containing TODO substring", lifecycle: "finite" },
  });
  emitEvent(db, {
    kind: "task_node_opened",
    substrate_origin: "owner",
    directive_id: directiveId,
    task_id: taskId,
    payload: { goal: "Count TODO files", lifecycle: "finite", urgency: "normal" },
  });
  return { directiveId, taskId };
};

describe("prompt_composer", () => {
  test("CLAUDE.md stays slim and points moved context at promoted knowledge", () => {
    const contract = readFileSync(new URL("../CLAUDE.md", import.meta.url), "utf8");
    expect(estimateTokens(contract)).toBeLessThan(3000);
    expect(contract.split("\n").length).toBeLessThan(180);
    expect(contract).toContain("## Universal Intent Ingress");
    expect(contract).toContain("Let dispatch choose by residual evidence");
    expect(contract).toContain("owner-control signals");
    expect(contract).toContain("rendering_signals, autonomy_signals, control_signals, risk_signals, collaboration_signals, and goal_continuity_signals");
    expect(contract).toContain("examples, rationale, inventories, historical anti-pattern evidence, and long recipes");
    expect(contract).toContain("goal-shape tags");
    expect(contract).not.toContain("First action on every owner directive");
    expect(contract).not.toContain("commit hashes");
  });

  test("composes under default budget with P0 sections always present", () => {
    const db = openDb(":memory:");
    const { taskId } = openTask(db);
    const composed = composePrompt(db, { taskId });
    expect(composed.text.length).toBeGreaterThan(0);
    expect(estimateTokens(composed.text)).toBeLessThan(8000);
    const sectionNames = composed.sections.map((s) => s.name);
    expect(sectionNames).toContain("exit_invariant");
    expect(sectionNames).toContain("task_goal");
    expect(sectionNames).toContain("runtimes_available");
    expect(sectionNames).toContain("workflow");
    expect(sectionNames).toContain("do_not");
  });

  test("EXIT INVARIANT is structurally pinned (load-bearing fix for brain_silent_exit, audit 2026-05-16)", () => {
    // Foundational fix: the bridge classifier split (commit 59b2872) revealed
    // 87% of bridge_failed events were `brain_silent_exit` — opencode running
    // cleanly to exit_code:0 in the handshake window without invoking ANY
    // substrate.* tool. The classifier split was step 1 (better diagnostics);
    // this prompt-side enforcement is step 2 (prevent the failure mode at the
    // root). The clause MUST appear, MUST be at p=0, and MUST land FIRST in
    // section order so the brain reads "you MUST call substrate.* before exit"
    // before anything else.
    const db = openDb(":memory:");
    const { taskId } = openTask(db);
    const composed = composePrompt(db, { taskId });

    // Structural marker — must appear verbatim in rendered text.
    expect(composed.text).toContain("EXIT INVARIANT");
    expect(composed.text).toContain("MUST invoke at least one substrate.* tool call before exit");
    expect(composed.text).toContain("brain_silent_exit");

    // Must be p=0 (never dropped under budget pressure).
    const exitInvariant = composed.sections.find((s) => s.name === "exit_invariant");
    expect(exitInvariant).toBeDefined();
    expect(exitInvariant?.priorityP).toBe(0);

    // Must land FIRST in section order so the brain reads it first.
    expect(composed.sections[0]?.name).toBe("exit_invariant");

    // DO NOT block must also pin the same rule (defense-in-depth — brain
    // reading the DO NOT block alone still sees the prohibition).
    expect(composed.text).toContain("Exit having produced only conversational text");
  });

  test("renders brain prompt policy from typed policy_bundle rows, not local constants", () => {
    const source = readFileSync(new URL("./prompt_composer.ts", import.meta.url), "utf8");
    expect(source).not.toContain("const WORKFLOW_TEXT");
    expect(source).not.toContain("const NOT_DO_TEXT");
    expect(source).not.toContain("const EXIT_INVARIANT_TEXT");
    expect(source).not.toContain("const RUNTIMES_AVAILABLE_TEXT");
    expect(source).not.toContain("const EMISSION_GRAMMARS_TEXT");

    const db = openDb(":memory:");
    const { taskId } = openTask(db);
    emitEvent(db, {
      kind: "knowledge_promoted",
      substrate_origin: "substrate_auto",
      payload: {
        type: "policy_bundle",
        surface: "brain_prompt",
        section_name: "workflow",
        priority: 0,
        version: "test.override",
        body: "YOUR WORKFLOW (test override):\n  POLICY_BUNDLE_OVERRIDE_WORKFLOW",
        policy_bundle: {
          type: "policy_bundle",
          surface: "brain_prompt",
          section_name: "workflow",
          priority: 0,
          version: "test.override",
          body: "YOUR WORKFLOW (test override):\n  POLICY_BUNDLE_OVERRIDE_WORKFLOW",
        },
      },
    });
    emitEvent(db, {
      kind: "knowledge_promoted",
      substrate_origin: "substrate_auto",
      payload: {
        type: "policy_bundle",
        surface: "brain_prompt",
        section_name: "do_not",
        priority: 0,
        version: "test.override",
        body: "DO NOT (test override):\n  - POLICY_BUNDLE_OVERRIDE_DO_NOT",
        policy_bundle: {
          type: "policy_bundle",
          surface: "brain_prompt",
          section_name: "do_not",
          priority: 0,
          version: "test.override",
          body: "DO NOT (test override):\n  - POLICY_BUNDLE_OVERRIDE_DO_NOT",
        },
      },
    });

    const composed = composePrompt(db, { taskId });
    expect(composed.text).toContain("POLICY_BUNDLE_OVERRIDE_WORKFLOW");
    expect(composed.text).toContain("POLICY_BUNDLE_OVERRIDE_DO_NOT");
    expect(composed.sections.find((s) => s.name === "workflow")?.priorityP).toBe(0);
    expect(composed.sections.find((s) => s.name === "do_not")?.priorityP).toBe(0);
  });

  test("EXISTING DECOMPOSITION section surfaces same-directive task_node_opened siblings to prevent re-decomposition explosion (audit 2026-05-17)", () => {
    // FOUNDATIONAL FIX: pre-fix the brain dispatched against the root task
    // blind to its prior cycles' children. Each re-dispatch on a multi-Q root
    // produced a fresh batch of Q1-Q6 task_node_opened events. The hot-reload
    // directive accumulated 62 task_node_opened events for what should have
    // been 7 (root + 6 questions). This test pins that:
    //  (a) every same-directive task_node_opened other than the current task
    //      appears in the EXISTING DECOMPOSITION section,
    //  (b) committed/failed/open status is rendered per sibling group,
    //  (c) the section is p=0 so budget pressure cannot drop it,
    //  (d) the "do NOT open siblings" prohibition is present verbatim.
    const db = openDb(":memory:");
    seedFoundationalKnowledge(db, { ownerApproved: true });
    const directiveId = newId();
    const rootId = newId();
    const q1Id = newId();
    const q2Id = newId();

    emitEvent(db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: directiveId,
      payload: { directive_text: "Multi-Q root with prior decomposition" },
    });
    emitEvent(db, {
      kind: "task_node_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: rootId,
      payload: { goal: "Root multi-question task" },
    });
    emitEvent(db, {
      kind: "task_node_opened",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      task_id: q1Id,
      payload: { goal: "Q1 DETECTION: choose primary mechanism" },
    });
    emitEvent(db, {
      kind: "task_committed",
      substrate_origin: "opencode",
      directive_id: directiveId,
      task_id: q1Id,
      payload: {},
    });
    emitEvent(db, {
      kind: "task_node_opened",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      task_id: q2Id,
      payload: { goal: "Q2 RELOAD MECHANISM: choose smallest delta" },
    });

    const composed = composePrompt(db, { taskId: rootId });

    expect(composed.text).toContain("EXISTING DECOMPOSITION FOR THIS DIRECTIVE");
    expect(composed.text).toContain("Q1 DETECTION");
    expect(composed.text).toContain("Q2 RELOAD MECHANISM");
    expect(composed.text).toContain("committed=1");
    expect(composed.text).toContain("open=1");
    expect(composed.text).toContain("do NOT open siblings");

    const section = composed.sections.find((s) => s.name === "existing_decomposition");
    expect(section).toBeDefined();
    expect(section?.priorityP).toBe(0);

    // Fresh directive with no siblings: the section must NOT appear.
    const freshDirectiveId = newId();
    const freshTaskId = newId();
    emitEvent(db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: freshDirectiveId,
      task_id: freshDirectiveId,
      payload: { directive_text: "Fresh directive" },
    });
    emitEvent(db, {
      kind: "task_node_opened",
      substrate_origin: "owner",
      directive_id: freshDirectiveId,
      task_id: freshTaskId,
      payload: { goal: "Fresh root task" },
    });
    const freshComposed = composePrompt(db, { taskId: freshTaskId });
    expect(freshComposed.sections.find((s) => s.name === "existing_decomposition")).toBeUndefined();
    expect(freshComposed.text).not.toContain("EXISTING DECOMPOSITION FOR THIS DIRECTIVE");
  });

  test("returns the fixture marker for fixture_d_count_todos prompts", () => {
    const db = openDb(":memory:");
    const { taskId } = openTask(db);
    const composed = composePrompt(db, { taskId });
    expect(composed.text).toContain("FIXTURE: fixture_d_count_todos");
  });

  test("renders universal act-loop metadata and target_resources URI grammar", () => {
    const db = openDb(":memory:");
    const { taskId } = openTask(db);
    const composed = composePrompt(db, { taskId });
    expect(composed.text).toContain("CONSTANT ACT-LOOP METADATA");
    expect(composed.text).toContain("target_resources:");
    expect(composed.text).toContain("repo:runtime/foo.ts");
    expect(composed.text).toContain("target_resource:");
    expect(composed.text).toContain("resource_uri:");
    expect(composed.text).toContain("anchored_replace_v1");
    expect(composed.text).toContain("browser_session:research/customer-a");
    expect(composed.text).toContain("sensor:habit_tracker/<stream>");
    expect(composed.text).not.toContain('target_files:        ["path/to/touched.ts", ...]');
  });

  test("under heavy budget pressure, P4 sections drop first", () => {
    const db = openDb(":memory:");
    const { taskId } = openTask(db);
    emitEvent(db, {
      kind: "task_failed",
      substrate_origin: "substrate_auto",
      task_id: taskId,
      failure_kind: "artifact_runtime_error",
      payload: { failure_kind: "artifact_runtime_error" },
    });
    emitEvent(db, {
      kind: "constitutional_gate_decision",
      substrate_origin: "substrate_auto",
      task_id: taskId,
      payload: { gate: "brain_concurrency_cap" },
    });
    // Tiny budget — even with approximate token counting we should not fit P4.
    const composed = composePrompt(db, { taskId, budgetTokens: 150 });
    // P0 sections must remain — but seeded constitutional gates / active
    // failures must drop before higher-priority owner/task context.
    expect(composed.truncated).toContain("active_failures");
    expect(composed.truncated).toContain("constitutional_gates");
  });

  test("returns a clear stub when task not found", () => {
    const db = openDb(":memory:");
    const composed = composePrompt(db, { taskId: "nonexistent_task" });
    expect(composed.text).toContain("TASK NOT FOUND");
  });

  test("includes promoted-knowledge entries when present", () => {
    const db = openDb(":memory:");
    const { taskId } = openTask(db);
    emitEvent(db, {
      kind: "knowledge_promoted",
      substrate_origin: "substrate_auto",
      payload: { text: "Prefer recursive grep over shell find", score: 0.88, tags: ["pattern"] },
    });
    const composed = composePrompt(db, { taskId });
    expect(composed.text).toContain("Prefer recursive grep");
  });

  test("renders WATCHED OUTPUTS with the upstream observation when a watch edge exists", () => {
    const db = openDb(":memory:");
    const { directiveId, taskId } = openTask(db);
    const upstream = newId();
    emitEvent(db, {
      kind: "task_node_opened",
      directive_id: directiveId,
      task_id: upstream,
      payload: { goal: "upstream emit" },
    });
    emitEvent(db, {
      kind: "task_edge_recorded",
      directive_id: directiveId,
      task_id: taskId,
      payload: { from_task: upstream, to_task: taskId, kind: "watches", consistency_mode: "snapshot_now" },
    });
    emitEvent(db, {
      kind: "action_scored",
      directive_id: directiveId,
      task_id: upstream,
      payload: { observed_value: "PROBE_WATCH_TOKEN" },
    });
    const composed = composePrompt(db, { taskId });
    expect(composed.text).toContain("WATCHED OUTPUTS");
    expect(composed.text).toContain("PROBE_WATCH_TOKEN");
  });

  test("WATCHED OUTPUTS reads as (none) when no watch edges target this task", () => {
    const db = openDb(":memory:");
    const { taskId } = openTask(db);
    const composed = composePrompt(db, { taskId });
    expect(composed.text).toContain("WATCHED OUTPUTS: (none)");
  });

  test("when retrievedKnowledge is supplied, RETRIEVED KNOWLEDGE renders the rerank lines instead of recency", () => {
    const db = openDb(":memory:");
    const { taskId } = openTask(db);
    // Seed a recency stand-in entry; rerank must override it, but
    // goal-shape promoted knowledge is still appended as contract context.
    emitEvent(db, {
      kind: "knowledge_promoted",
      substrate_origin: "substrate_auto",
      payload: { text: "RECENCY_FALLBACK_STAND_IN", score: 0.7 },
    });
    emitEvent(db, {
      kind: "knowledge_promoted",
      substrate_origin: "substrate_auto",
      payload: { text: "GOAL_SHAPE_WITH_RERANK", score: 0.6, goal_shape: goalShape("Count files containing TODO substring") },
    });
    const composed = composePrompt(db, {
      taskId,
      retrievedKnowledge: {
        hits: [
          {
            event_id: "evt_rerank_top",
            kind: "knowledge_promoted",
            distance: 0.12,
            posterior: 0.9,
            rerank_score: 1.5,
            origin: "claude_root",
            snippet: "RERANK_FROM_INDEX_TOPHIT",
            aspect_scores: { claim_vector: 0.8 },
            domain_scores: { accint_knowledge_efficiency: 1 },
            routing_score_breakdown: { similarity: 0.9, posterior: 0.9, origin_bias: 1, aspect_boost: 0.8, domain_boost: 1, routing_multiplier: 1.5 },
          },
        ],
        retrieved_at: "2026-05-13T12:00:00Z",
        mixed_version_excluded: 0,
        query_embedding_unavailable: false,
      },
    });
    expect(composed.text).toContain("RERANK_FROM_INDEX_TOPHIT");
    expect(composed.text).toContain("GOAL_SHAPE_WITH_RERANK");
    expect(composed.text).toContain("aspect:claim_vector=0.80");
    expect(composed.text).toContain("domain:accint_knowledge_efficiency=1.00");
    expect(composed.text).not.toContain("RECENCY_FALLBACK_STAND_IN");
  });

  test("when retrievedArtifacts is supplied, CODE ARTIFACT REGISTRY renders the rerank lines", () => {
    const db = openDb(":memory:");
    const { taskId } = openTask(db);
    const composed = composePrompt(db, {
      taskId,
      retrievedArtifacts: {
        hits: [
          {
            event_id: "evt_artifact_top",
            kind: "code_artifact_admitted",
            distance: 0.2,
            posterior: 0.8,
            rerank_score: 1.4,
            origin: "opencode",
            snippet: "RERANK_ARTIFACT_TOPHIT",
            aspect_scores: {},
            domain_scores: {},
            routing_score_breakdown: { similarity: 0.9, posterior: 0.8, origin_bias: 1, aspect_boost: 0, domain_boost: 0, routing_multiplier: 1 },
          },
        ],
        retrieved_at: "2026-05-13T12:00:00Z",
        mixed_version_excluded: 0,
        query_embedding_unavailable: false,
      },
    });
    expect(composed.text).toContain("RERANK_ARTIFACT_TOPHIT");
  });

  test("estimateTokens returns positive integer counts via the real tokenizer", () => {
    expect(estimateTokens("hello world")).toBeGreaterThan(0);
    expect(estimateTokens("")).toBeGreaterThanOrEqual(0);
    // Tokens should be fewer than characters for typical English text.
    expect(estimateTokens("hello world this is a longer test sentence"))
      .toBeLessThan("hello world this is a longer test sentence".length);
  });

  test("OWNER PROFILE section renders defaults stub when no owner_profile_recorded row exists, and renders the latest profile fields when one does", () => {
    const db = openDb(":memory:");
    const { taskId } = openTask(db);
    // Before any owner_profile_recorded: section MUST be present with the
    // bootstrap policy block — the brain learns to look for it and apply
    // the sparse-profile heuristics (plain language, one question at a
    // time, explain on first encounter).
    const composedDefaults = composePrompt(db, { taskId });
    expect(composedDefaults.text).toContain("## OWNER PROFILE");
    expect(composedDefaults.text).toContain("bootstrap_policy: sparse profile");
    expect(composedDefaults.text).toContain("do not assume English");
    expect(composedDefaults.text).toContain("autonomy_score:");
    expect(composedDefaults.text).toContain("owner_policy (situational projection; open-ended Records, no persona enums):");

    // Emit one owner_profile_recorded with non-default fields, then recompose.
    emitEvent(db, {
      kind: "owner_profile_recorded",
      substrate_origin: "substrate_auto",
      payload: {
        detected_language: "ru",
        autonomy_score: 0.3,
        rendering_signals: { code_density: 0.8 },
        autonomy_signals: { parallel_apply: 0.7 },
        control_signals: { explicit_approval: 0.6, ask_before_apply: 0.8 },
        risk_signals: { multi_file_diff_caution: 0.9, protected_target_sensitivity: 0.7 },
        collaboration_signals: { batch_updates: 0.5 },
        goal_continuity_signals: { long_arc_memory: 0.4 },
        hot_topics: ["onboarding", "recipes"],
        things_to_never_do: ["docs/operator-install.md"],
        manual_review_patterns: ["runtime/*.test.ts"],
        time_window: { timezone: "UTC", days: ["mon", "tue"], start_hour: 9, end_hour: 17 },
        autonomy_scope: { include: ["cli/**", "runtime/**"], exclude: ["**/*.test.ts"] },
      },
    });
    const profile = readOwnerProfile(db);
    expect(profile.detected_language).toBe("ru");
    expect(profile.autonomy_score).toBe(0.3);

    const rendered = buildOwnerProfileSection(profile, {
      recentOwnerContext: [
        { id: "e_owner", ts: "2026-05-16T00:00:00.000Z", kind: "owner_decision_recorded", directive_id: "d", text: "Owner consent granted; apply anchored amendment" },
        { id: "e_owner_2", ts: "2026-05-16T00:01:00.000Z", kind: "owner_input_received", directive_id: "d", text: "Ask before applying if the runtime diff is ambiguous" },
      ],
      directive: { text: "Implement runtime amendments against current master", goal: "runtime amendment", urgency: "normal", lifecycle: "finite" },
    });
    expect(rendered).toContain("## OWNER PROFILE");
    expect(rendered).toContain("detected_language: ru");
    expect(rendered).toContain("owner_policy (situational projection; open-ended Records, no persona enums):");
    expect(rendered).toContain("recent_consent=1");
    expect(rendered).toContain("recent_control_language=1");
    expect(rendered).toContain("directive_risk=");
    expect(rendered).toContain("owner_control_need=");
    expect(rendered).toContain("profile_control_signal=");
    expect(rendered).toContain("profile_risk_signal=");
    expect(rendered).toContain("action_policy: surface evidence, anchors, residuals");
    expect(rendered).toContain("comprehension_policy:");
    expect(rendered).toContain("source_mix: profile_maps=control.ask_before_apply,control.explicit_approval,risk.multi_file_diff_caution");
    expect(rendered).toContain("owner_language_policy: respond to owner-visible summaries in detected_language");
    expect(rendered).toContain("autonomy_score: 0.30");
    expect(rendered).toContain("rendering_signals (continuous, open-ended Record<string,number>): code_density=0.80");
    expect(rendered).toContain("autonomy_signals (continuous, open-ended Record<string,number>): parallel_apply=0.70");
    expect(rendered).toContain("control_signals (continuous, open-ended Record<string,number>): ask_before_apply=0.80, explicit_approval=0.60");
    expect(rendered).toContain("risk_signals (continuous, open-ended Record<string,number>): multi_file_diff_caution=0.90, protected_target_sensitivity=0.70");
    expect(rendered).toContain("collaboration_signals (continuous, open-ended Record<string,number>): batch_updates=0.50");
    expect(rendered).toContain("goal_continuity_signals (continuous, open-ended Record<string,number>): long_arc_memory=0.40");
    expect(rendered).toContain("hot_topics: onboarding, recipes");
    expect(rendered).toContain("things_to_never_do:");
    expect(rendered).toContain("- docs/operator-install.md");
    expect(rendered).toContain("manual_review_patterns:");
    expect(rendered).toContain("- runtime/*.test.ts");
    expect(rendered).toContain("time_window: 9:00-17:00 mon,tue UTC");
    expect(rendered).toContain("autonomy_scope: include=[cli/**, runtime/**] exclude=[**/*.test.ts]");

    const composed = composePrompt(db, { taskId });
    expect(composed.text).toContain("## OWNER PROFILE");
    expect(composed.text).toContain("detected_language: ru");
    expect(composed.text).toContain("autonomy_score: 0.30");
    expect(composed.text).toContain("owner_policy (situational projection; open-ended Records, no persona enums):");
    // OWNER PROFILE must render BEFORE OWNER CONTEXT (amendment shape).
    const profileIdx = composed.text.indexOf("## OWNER PROFILE");
    const contextIdx = composed.text.indexOf("OWNER CONTEXT");
    expect(profileIdx).toBeGreaterThan(-1);
    expect(contextIdx).toBeGreaterThan(profileIdx);
  });

});

// ── owner-rendering policy + feedback summary section ────────────────
describe("buildOwnerRenderingPolicySection + buildOwnerFeedbackSummarySection", () => {
  const policy = (overrides: Partial<OwnerRenderingPolicyRow> = {}): OwnerRenderingPolicyRow => ({
    profile_event_id: "PROF1",
    profile_ts: "2026-05-17T00:00:00Z",
    profile_payload: {},
    preferred_terms: [],
    avoided_terms: [],
    declined_concepts: [],
    understood_concepts: [],
    exposed_concepts: [],
    things_to_never_do: [],
    manual_review_patterns: [],
    autonomy_score: 1.0,
    autonomy_scope: [],
    detected_language: "en",
    recent_correction_count: 0,
    recent_decline_count: 0,
    recent_ignored_count: 0,
    recent_satisfaction_count: 0,
    recent_clarification_count: 0,
    recent_override_count: 0,
    policy_health: 1.0,
    ...overrides,
  });

  test("null policy renders default invariants only", () => {
    const text = buildOwnerRenderingPolicySection(null);
    expect(text).toContain("## OWNER RENDERING POLICY");
    expect(text).toContain("no owner_profile_recorded row yet");
    expect(text).toContain("Primary owner-visible text MUST NOT contain event_ids");
  });

  test("policy with preferred / avoided / declined / things_to_never_do renders them inline", () => {
    const text = buildOwnerRenderingPolicySection(policy({
      preferred_terms: ["plain", "simple"],
      avoided_terms: ["dispatch", "residual"],
      declined_concepts: ["telemetry"],
      things_to_never_do: ["force-push to main"],
      manual_review_patterns: ["release tags"],
      autonomy_score: 0.3,
    }));
    expect(text).toContain("preferred_terms (use these in primary surfaces): plain, simple");
    expect(text).toContain("avoided_terms (do not use in primary surfaces): dispatch, residual");
    expect(text).toContain("declined_concepts");
    expect(text).toContain("things_to_never_do");
    expect(text).toContain("- force-push to main");
    expect(text).toContain("manual_review_patterns");
    expect(text).toContain("autonomy_score: 0.30");
  });

  test("feedback summary renders aggregates when present, default copy when window is empty", () => {
    const empty = buildOwnerFeedbackSummarySection(policy());
    expect(empty).toContain("no rendering feedback yet");

    const nonEmpty = buildOwnerFeedbackSummarySection(policy({
      recent_correction_count: 2,
      recent_decline_count: 1,
      recent_satisfaction_count: 1,
    }));
    expect(nonEmpty).toContain("corrections: 2");
    expect(nonEmpty).toContain("declines: 1");
    expect(nonEmpty).toContain("satisfaction: 1");
  });
});


describe("prompt_composer goal-shape knowledge fallback", () => {
  test("promoted knowledge with matching goal_shape is pulled before recency-only rows", () => {
    const db = openDb(":memory:");
    const { taskId } = openTask(db);
    emitEvent(db, { kind: "knowledge_promoted", substrate_origin: "substrate_auto", payload: { text: "RECENT_BUT_GENERIC", score: 0.9 } });
    emitEvent(db, { kind: "knowledge_promoted", substrate_origin: "substrate_auto", payload: { text: "GOAL_SHAPE_MATCHED_KNOWLEDGE", score: 0.6, goal_shape: goalShape("Count files containing TODO substring") } });
    const composed = composePrompt(db, { taskId, budgetTokens: 1200 });
    expect(composed.text.indexOf("GOAL_SHAPE_MATCHED_KNOWLEDGE")).toBeLessThan(composed.text.indexOf("RECENT_BUT_GENERIC"));
  });

  test("promoted knowledge with matching goal_shape_tags is pulled before recency-only rows", () => {
    const db = openDb(":memory:");
    const { taskId } = openTask(db);
    emitEvent(db, { kind: "knowledge_promoted", substrate_origin: "substrate_auto", payload: { text: "RECENT_BUT_GENERIC_TAG_CASE", score: 0.9 } });
    emitEvent(db, { kind: "knowledge_promoted", substrate_origin: "substrate_auto", payload: { text: "TAG_MATCHED_MOVED_CONTRACT_KNOWLEDGE", score: 0.6, goal_shape_tags: ["todo"] } });
    const composed = composePrompt(db, { taskId, budgetTokens: 1200 });
    expect(composed.text.indexOf("TAG_MATCHED_MOVED_CONTRACT_KNOWLEDGE")).toBeLessThan(composed.text.indexOf("RECENT_BUT_GENERIC_TAG_CASE"));
  });

  test("direct promoted moved-contract knowledge renders rich payload text without a candidate join", () => {
    const db = openDb(":memory:");
    const { taskId } = openTask(db);
    emitEvent(db, { kind: "knowledge_promoted", substrate_origin: "substrate_auto", payload: { claim: "DIRECT_PROMOTED_CONTRACT_CLAIM", evidence: ["moved from CLAUDE.md"], implications: ["retrieve by goal shape"], score: 0.7, goal_shape_tags: ["todo"] } });
    const composed = composePrompt(db, { taskId, budgetTokens: 1200 });
    expect(composed.text).toContain("DIRECT_PROMOTED_CONTRACT_CLAIM");
    expect(composed.text).toContain("evidence: moved from CLAUDE.md");
    expect(composed.text).toContain("implications: retrieve by goal shape");
    expect(composed.text).not.toContain("(no text)");
  });
});
