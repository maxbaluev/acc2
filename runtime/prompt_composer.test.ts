import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import { buildOwnerProfileSection, composePrompt, estimateTokens, readOwnerProfile } from "./prompt_composer";
import { newId } from "./ids";

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
          },
        ],
        retrieved_at: "2026-05-13T12:00:00Z",
        mixed_version_excluded: 0,
        query_embedding_unavailable: false,
      },
    });
    expect(composed.text).toContain("RERANK_FROM_INDEX_TOPHIT");
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
    // "no owner profile recorded yet" stub — the brain learns to look for it.
    const composedDefaults = composePrompt(db, { taskId });
    expect(composedDefaults.text).toContain("## OWNER PROFILE");
    expect(composedDefaults.text).toContain("(no owner profile recorded yet)");

    // Emit one owner_profile_recorded with non-default fields, then recompose.
    emitEvent(db, {
      kind: "owner_profile_recorded",
      substrate_origin: "substrate_auto",
      payload: {
        detected_language: "ru",
        autonomy_score: 0.3,
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

    const rendered = buildOwnerProfileSection(profile);
    expect(rendered).toContain("## OWNER PROFILE");
    expect(rendered).toContain("detected_language: ru");
    expect(rendered).toContain("autonomy_score: 0.30");
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
    // OWNER PROFILE must render BEFORE OWNER CONTEXT (amendment shape).
    const profileIdx = composed.text.indexOf("## OWNER PROFILE");
    const contextIdx = composed.text.indexOf("OWNER CONTEXT");
    expect(profileIdx).toBeGreaterThan(-1);
    expect(contextIdx).toBeGreaterThan(profileIdx);
  });
});
