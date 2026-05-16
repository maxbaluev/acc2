import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import { buildOwnerProfileSection, composePrompt, estimateTokens, readOwnerProfile } from "./prompt_composer";
import { newId } from "./ids";
import { goalShape } from "./goal_shape";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const openTask = (db: ReturnType<typeof openDb>): { directiveId: string; taskId: string } => {
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
  test("composes under default budget with P0 sections always present", () => {
    const db = openDb(":memory:");
    const { taskId } = openTask(db);
    const composed = composePrompt(db, { taskId });
    expect(composed.text.length).toBeGreaterThan(0);
    expect(estimateTokens(composed.text)).toBeLessThan(8000);
    const sectionNames = composed.sections.map((s) => s.name);
    expect(sectionNames).toContain("task_goal");
    expect(sectionNames).toContain("runtimes_available");
    expect(sectionNames).toContain("workflow");
    expect(sectionNames).toContain("do_not");
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
    // Tiny budget — even with approximate token counting we should not fit P4.
    const composed = composePrompt(db, { taskId, budgetTokens: 150 });
    // P0 sections must remain — but constitutional gates / active failures
    // must drop first.
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
    // Seed a recency stand-in entry; rerank must override it.
    emitEvent(db, {
      kind: "knowledge_promoted",
      substrate_origin: "substrate_auto",
      payload: { text: "RECENCY_FALLBACK_STAND_IN", score: 0.7 },
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
        control_signals: { explicit_approval: 0.6 },
        risk_signals: { multi_file_diff_caution: 0.9 },
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
      recentOwnerContext: [{ id: "e_owner", ts: "2026-05-16T00:00:00.000Z", kind: "owner_decision_recorded", directive_id: "d", text: "Owner consent granted; apply anchored amendment" }],
      directive: { text: "Implement runtime amendments against current master", goal: "runtime amendment", urgency: "normal", lifecycle: "finite" },
    });
    expect(rendered).toContain("## OWNER PROFILE");
    expect(rendered).toContain("detected_language: ru");
    expect(rendered).toContain("owner_policy (situational projection; open-ended Records, no persona enums):");
    expect(rendered).toContain("recent_consent=1");
    expect(rendered).toContain("directive_risk=");
    expect(rendered).toContain("owner_language_policy: respond to owner-visible summaries in detected_language");
    expect(rendered).toContain("autonomy_score: 0.30");
    expect(rendered).toContain("rendering_signals (continuous, open-ended Record<string,number>): code_density=0.80");
    expect(rendered).toContain("autonomy_signals (continuous, open-ended Record<string,number>): parallel_apply=0.70");
    expect(rendered).toContain("control_signals (continuous, open-ended Record<string,number>): explicit_approval=0.60");
    expect(rendered).toContain("risk_signals (continuous, open-ended Record<string,number>): multi_file_diff_caution=0.90");
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


describe("prompt_composer goal-shape knowledge fallback", () => {
  test("promoted knowledge with matching goal_shape is pulled before recency-only rows", () => {
    const db = openDb(":memory:");
    const { taskId } = openTask(db);
    emitEvent(db, { kind: "knowledge_promoted", substrate_origin: "substrate_auto", payload: { text: "RECENT_BUT_GENERIC", score: 0.9 } });
    emitEvent(db, { kind: "knowledge_promoted", substrate_origin: "substrate_auto", payload: { text: "GOAL_SHAPE_MATCHED_KNOWLEDGE", score: 0.6, goal_shape: goalShape("Count files containing TODO substring") } });
    const composed = composePrompt(db, { taskId, budgetTokens: 1200 });
    expect(composed.text.indexOf("GOAL_SHAPE_MATCHED_KNOWLEDGE")).toBeLessThan(composed.text.indexOf("RECENT_BUT_GENERIC"));
  });
});
