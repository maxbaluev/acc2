import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import {
  buildAlignmentActionPolicySection,
  buildOwnerFeedbackSummarySection,
  buildOwnerProfileSection,
  buildOwnerRenderingPolicySection,
  buildOwnerStateBeliefSection,
  buildOwnerStateFeedbackSummarySection,
  buildTopLawsSection,
  composePrompt,
  estimateTokens,
  readOwnerProfile,
} from "./prompt_composer";
import type { OwnerRenderingPolicyRow, OwnerStateBeliefRow, TopLawRow } from "../substrate/views";
import { newId } from "./ids";
import { goalShape } from "./goal_shape";
import { seedFoundationalKnowledge } from "../substrate/seed";
import { _resetPromptCacheForTests } from "./prompt_cache";

afterAll(() => closeDb());
beforeEach(() => {
  closeDb();
  // RLMQ_PROMPT_COMP: the composition cache is process-global; reset it
  // between tests so a prior test's stored entry can never serve a later
  // test's compose (and so the cache-hit/miss tests below are deterministic).
  _resetPromptCacheForTests();
});

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
  test("CLAUDE.md stays slim and points moved context at promoted knowledge", async () => {
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

  test("composes under default budget with P0 sections always present", async () => {
    const db = openDb(":memory:");
    const { taskId } = openTask(db);
    const composed = await composePrompt(db, { taskId });
    expect(composed.text.length).toBeGreaterThan(0);
    expect(estimateTokens(composed.text)).toBeLessThan(8000);
    const sectionNames = composed.sections.map((s) => s.name);
    expect(sectionNames).toContain("exit_invariant");
    expect(sectionNames).toContain("task_goal");
    expect(sectionNames).toContain("runtimes_available");
    expect(sectionNames).toContain("workflow");
    expect(sectionNames).toContain("do_not");
  });

  test("uses the same prompt section set for research, question, code, outreach, and project goals", async () => {
    const db = openDb(":memory:");
    seedFoundationalKnowledge(db, { ownerApproved: true });
    const goals = [
      "Deep research the market for privacy-preserving analytics",
      "Answer what residual means in acc2",
      "Change runtime prompt composer tests",
      "Plan a business outreach campaign for Lakeland clinics",
      "Run a multi-stage project to publish a report",
    ];
    const sectionSets = await Promise.all(goals.map(async (goal) => {
      const directiveId = newId();
      const taskId = newId();
      emitEvent(db, { kind: "directive_opened", substrate_origin: "owner", directive_id: directiveId, task_id: directiveId, payload: { directive_text: goal } });
      emitEvent(db, { kind: "task_node_opened", substrate_origin: "owner", directive_id: directiveId, task_id: taskId, payload: { goal } });
      return (await composePrompt(db, { taskId })).sections.map((s) => s.name);
    }));
    expect(new Set(sectionSets.map((sections) => JSON.stringify(sections))).size).toBe(1);
    expect(sectionSets[0]).not.toContain("fixture_marker");
  });

  test("EXIT INVARIANT is structurally pinned (load-bearing fix for brain_silent_exit, audit 2026-05-16)", async () => {
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
    const composed = await composePrompt(db, { taskId });

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

  test("renders brain prompt policy from typed policy_bundle rows, not local constants", async () => {
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

    const composed = await composePrompt(db, { taskId });
    expect(composed.text).toContain("POLICY_BUNDLE_OVERRIDE_WORKFLOW");
    expect(composed.text).toContain("POLICY_BUNDLE_OVERRIDE_DO_NOT");
    expect(composed.sections.find((s) => s.name === "workflow")?.priorityP).toBe(0);
    expect(composed.sections.find((s) => s.name === "do_not")?.priorityP).toBe(0);
  });

  test("EXISTING DECOMPOSITION section surfaces same-directive task_node_opened siblings to prevent re-decomposition explosion (audit 2026-05-17)", async () => {
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

    const composed = await composePrompt(db, { taskId: rootId });

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
    const freshComposed = await composePrompt(db, { taskId: freshTaskId });
    expect(freshComposed.sections.find((s) => s.name === "existing_decomposition")).toBeUndefined();
    expect(freshComposed.text).not.toContain("EXISTING DECOMPOSITION FOR THIS DIRECTIVE");
  });

  test("PROVEN DECOMPOSITION STRATEGY section binds the outcome-scored decomposition_strategy_predicate row to a matching goal (Tier-S1 retrieval-binding leg)", async () => {
    const db = openDb(":memory:");
    seedFoundationalKnowledge(db, { ownerApproved: true });

    // Insert a scored decomposition_strategy_predicate row exactly as the
    // extractor's upsertPredicateRow does: id=decomp_<shape>, body carries the
    // outcome-derived metrics, posterior is Beta(alpha,beta). Audit goals map
    // to shape_category "audit_evidence_sweep" via categorizeGoalShapeSemantic.
    const insertDecompPredicate = (
      shape: string,
      effectiveScore: number,
      sampleCount: number,
      meanResidual: number,
    ): void => {
      const id = `decomp_${shape}`;
      const alpha = 1 + effectiveScore * sampleCount;
      const beta = 1 + (1 - effectiveScore) * sampleCount;
      const nowIso = new Date().toISOString();
      db.run(
        `INSERT INTO act_artifact (
           id, runtime, body, declared_sandbox, state_root, kind,
           posterior_alpha, posterior_beta, score, confidence,
           recent_residual_mean, recent_kill_count, status, name,
           fixture_input, fixture_expected_residual, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          "bun",
          JSON.stringify({
            shape_category: shape,
            sample_count: sampleCount,
            mean_residual: meanResidual,
            std_residual: 0.05,
            effective_score: effectiveScore,
            avg_fan_out: 4.2,
            avg_max_depth: 2.1,
            avg_total_nodes: 6.0,
            last_observed_ts: nowIso,
          }),
          JSON.stringify({ runtime: "bun" }),
          `substrate/decomposition_strategy/${id}`,
          "decomposition_strategy_predicate",
          alpha,
          beta,
          effectiveScore,
          1 - 1 / Math.sqrt(alpha + beta),
          meanResidual,
          0,
          "admitted",
          shape,
          JSON.stringify({ shape_category: shape }),
          0.5,
          nowIso,
          nowIso,
        ],
      );
    };

    // A well-closing audit shape (high score, enough samples) → surfaced.
    insertDecompPredicate("audit_evidence_sweep", 0.82, 12, 0.18);

    const directiveId = newId();
    const taskId = newId();
    emitEvent(db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: directiveId,
      payload: { directive_text: "Audit the dispatch pipeline for residual drift", lifecycle: "finite" },
    });
    emitEvent(db, {
      kind: "task_node_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: taskId,
      payload: { goal: "Audit the dispatch pipeline for residual drift", lifecycle: "finite" },
    });

    const composed = await composePrompt(db, { taskId });
    const section = composed.sections.find((s) => s.name === "proven_decomposition_strategy");
    expect(section).toBeDefined();
    expect(section?.priorityP).toBe(1); // advisory, drops first under budget pressure
    expect(composed.text).toContain("PROVEN DECOMPOSITION STRATEGY");
    expect(composed.text).toContain("audit_evidence_sweep");
    // Residual-derived metrics surface verbatim so credit binding is honest.
    expect(composed.text).toContain("effective_score=0.82");
    expect(composed.text).toContain("mean closure_residual=0.18");
    // Citation binding: the scored predicate id is cited so outcome credit flows.
    expect(composed.text).toContain("[cite decomp_audit_evidence_sweep]");

    // Below the advisory floor: a low-score row (or too few samples) must NOT
    // surface — surfacing a poorly-closing shape would be noise, not signal.
    const lowDb = openDb(":memory:");
    seedFoundationalKnowledge(lowDb, { ownerApproved: true });
    const lowDirId = newId();
    const lowTaskId = newId();
    emitEvent(lowDb, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: lowDirId,
      task_id: lowDirId,
      payload: { directive_text: "Build the parallel ingestion bundle", lifecycle: "finite" },
    });
    emitEvent(lowDb, {
      kind: "task_node_opened",
      substrate_origin: "owner",
      directive_id: lowDirId,
      task_id: lowTaskId,
      payload: { goal: "Build the parallel ingestion bundle", lifecycle: "finite" },
    });
    // No matching predicate row at all → section absent.
    const lowComposed = await composePrompt(lowDb, { taskId: lowTaskId });
    expect(lowComposed.sections.find((s) => s.name === "proven_decomposition_strategy")).toBeUndefined();
    expect(lowComposed.text).not.toContain("PROVEN DECOMPOSITION STRATEGY");
  });

  test("PROVEN TRAJECTORY MOTIF section binds the outcome-scored trajectory_motif_predicate row to a directive on the motif's path (Tier-S3 retrieval-binding leg)", async () => {
    // Insert a scored trajectory_motif_predicate row exactly as the
    // trajectory_motif_extractor's ensureMotifRow + calibrateMotifScore do:
    // id=motif_<n>_<hash>, body carries { kinds, length, frequency,
    // avg_closure_residual }, and `score` is calibrated to 1 -
    // avg_closure_residual (a motif whose directives closed with LOW residual
    // is a GOOD recipe → high score). The motif key is geometry-only (event
    // kinds), so the compose-time match is the directive's OWN trajectory-so-far
    // — never guessed goal shape.
    const insertMotifPredicate = (
      id: string,
      kinds: string[],
      frequency: number,
      avgClosureResidual: number,
    ): void => {
      const score = Math.max(0, Math.min(1, 1 - avgClosureResidual));
      const nowIso = new Date().toISOString();
      db.run(
        `INSERT INTO act_artifact (
           id, runtime, body, declared_sandbox, state_root, kind,
           posterior_alpha, posterior_beta, score, confidence,
           recent_residual_mean, recent_kill_count, status, name,
           fixture_input, fixture_expected_residual, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          "bun",
          JSON.stringify({
            kinds,
            length: kinds.length,
            frequency,
            avg_closure_residual: avgClosureResidual,
          }),
          JSON.stringify({ runtime: "bun" }),
          `substrate/trajectory_motif/${id}`,
          "trajectory_motif_predicate",
          1.0,
          1.0,
          score,
          0.5,
          avgClosureResidual,
          0,
          "admitted",
          kinds.join(">"),
          JSON.stringify({ kinds }),
          0.5,
          nowIso,
          nowIso,
        ],
      );
    };

    const db = openDb(":memory:");
    seedFoundationalKnowledge(db, { ownerApproved: true });

    // A well-closing recurring recipe (high score = low residual, ≥5 samples).
    const motifKinds = ["directive_opened", "task_node_opened", "task_committed"];
    insertMotifPredicate("motif_3_proven", motifKinds, 11, 0.16);

    // Open a directive whose trajectory-so-far IS this motif's leading path:
    // directive_opened → task_node_opened. The motif is anchored to that tail,
    // so it's a proven continuation the brain should see.
    const directiveId = newId();
    const taskId = newId();
    emitEvent(db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: directiveId,
      payload: { directive_text: "Ship the embedding-cache compounding lever", lifecycle: "finite" },
    });
    emitEvent(db, {
      kind: "task_node_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: taskId,
      payload: { goal: "Ship the embedding-cache compounding lever", lifecycle: "finite" },
    });

    const composed = await composePrompt(db, { taskId });
    const section = composed.sections.find((s) => s.name === "proven_trajectory_motif");
    expect(section).toBeDefined();
    expect(section?.priorityP).toBe(1); // advisory, drops first under budget pressure
    expect(composed.text).toContain("PROVEN TRAJECTORY MOTIF");
    // Residual-derived metrics surface verbatim so credit binding is honest.
    expect(composed.text).toContain("effective_score=0.84");
    expect(composed.text).toContain("mean closure_residual=0.16");
    expect(composed.text).toContain("directive_opened → task_node_opened → task_committed");
    // Citation binding: the scored predicate id is cited so outcome credit flows.
    expect(composed.text).toContain("[cite motif_3_proven]");

    // Below the advisory floor (too few samples) → absent even when anchored.
    // openDb(":memory:") returns the cached singleton, so reuse `db` and drop
    // the well-closing row first; only a below-floor motif remains.
    const fewDb = db;
    fewDb.run(`DELETE FROM act_artifact WHERE kind = 'trajectory_motif_predicate'`);
    const fewMotifKinds = ["directive_opened", "task_node_opened", "task_committed"];
    const fewScore = 1 - 0.16;
    const fewIso = new Date().toISOString();
    fewDb.run(
      `INSERT INTO act_artifact (
         id, runtime, body, declared_sandbox, state_root, kind,
         posterior_alpha, posterior_beta, score, confidence,
         recent_residual_mean, recent_kill_count, status, name,
         fixture_input, fixture_expected_residual, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "motif_3_rare",
        "bun",
        JSON.stringify({ kinds: fewMotifKinds, length: 3, frequency: 2, avg_closure_residual: 0.16 }),
        JSON.stringify({ runtime: "bun" }),
        "substrate/trajectory_motif/motif_3_rare",
        "trajectory_motif_predicate",
        1.0,
        1.0,
        fewScore,
        0.5,
        0.16,
        0,
        "admitted",
        fewMotifKinds.join(">"),
        JSON.stringify({ kinds: fewMotifKinds }),
        0.5,
        fewIso,
        fewIso,
      ],
    );
    const fewDirId = newId();
    const fewTaskId = newId();
    emitEvent(fewDb, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: fewDirId,
      task_id: fewDirId,
      payload: { directive_text: "Ship a rarely-seen recipe", lifecycle: "finite" },
    });
    emitEvent(fewDb, {
      kind: "task_node_opened",
      substrate_origin: "owner",
      directive_id: fewDirId,
      task_id: fewTaskId,
      payload: { goal: "Ship a rarely-seen recipe", lifecycle: "finite" },
    });
    const fewComposed = await composePrompt(fewDb, { taskId: fewTaskId });
    expect(fewComposed.sections.find((s) => s.name === "proven_trajectory_motif")).toBeUndefined();
    expect(fewComposed.text).not.toContain("PROVEN TRAJECTORY MOTIF");

    // Below the advisory floor (low score = high closure_residual) → absent
    // even with ample samples. A poorly-closing recipe is noise, not signal.
    fewDb.run(`DELETE FROM act_artifact WHERE kind = 'trajectory_motif_predicate'`);
    insertMotifPredicate("motif_3_poorly_closing", motifKinds, 30, 0.7); // score 0.30 < 0.55
    const poorComposed = await composePrompt(fewDb, { taskId: fewTaskId });
    expect(poorComposed.sections.find((s) => s.name === "proven_trajectory_motif")).toBeUndefined();
    expect(poorComposed.text).not.toContain("PROVEN TRAJECTORY MOTIF");
  });

  test("returns the fixture marker for fixture_d_count_todos prompts", async () => {
    const db = openDb(":memory:");
    const { taskId } = openTask(db);
    const composed = await composePrompt(db, { taskId });
    expect(composed.text).toContain("FIXTURE: fixture_d_count_todos");
  });

  test("renders universal act-loop metadata and target_resources URI grammar", async () => {
    const db = openDb(":memory:");
    const { taskId } = openTask(db);
    const composed = await composePrompt(db, { taskId });
    expect(composed.text).toContain("CONSTANT ACT-LOOP METADATA");
    expect(composed.text).toContain("target_resources:");
    expect(composed.text).toContain("repo:runtime/foo.ts");
    expect(composed.text).toContain("target_resource:");
    // resource_uri alias no longer taught (Q3 deletion batch 3) — target_resource is canonical
    expect(composed.text).not.toContain("resource_uri:");
    expect(composed.text).toContain("contract_amendment_proposed");
    expect(composed.text).toContain("browser_session:research/customer-a");
    expect(composed.text).toContain("sensor:habit_tracker/<stream>");
    expect(composed.text).not.toContain('target_files:        ["path/to/touched.ts", ...]');
    // RLMQ_PROMPT_COMP: the emission grammar must teach the ONE semantic
    // current-file apply path and frame legacy before/after snippets as
    // advisory context only (never a text-match gate). Guards against a
    // regression that re-introduces anchor-text matching into the grammar.
    expect(composed.text).toContain("semantic");
    expect(composed.text.toLowerCase()).toContain("advisory");
    expect(composed.text.toLowerCase()).not.toContain("anchor-text matching gate");
  });

  test("RLMQ_PROMPT_COMP: composing the same task twice reuses the cached prompt (miss then hit)", async () => {
    const db = openDb(":memory:");
    const { taskId } = openTask(db);
    const first = await composePrompt(db, { taskId });
    const second = await composePrompt(db, { taskId });
    // The second compose must equal the first verbatim — served from cache.
    expect(second.text).toBe(first.text);
    const misses = db.query(
      "SELECT COUNT(*) AS c FROM events WHERE kind = 'prompt_composition_cache_miss' AND task_id = ?",
    ).get(taskId) as { c: number };
    const hits = db.query(
      "SELECT COUNT(*) AS c FROM events WHERE kind = 'prompt_composition_cache_hit' AND task_id = ?",
    ).get(taskId) as { c: number };
    expect(misses.c).toBe(1);
    expect(hits.c).toBe(1);
  });

  test("RLMQ_PROMPT_COMP: a NEW non-telemetry event invalidates the cache (recompose misses again)", async () => {
    const db = openDb(":memory:");
    const { taskId } = openTask(db);
    await composePrompt(db, { taskId }); // miss + store
    await composePrompt(db, { taskId }); // hit
    // Real substrate movement (not composer telemetry) must advance the
    // high-water mark and invalidate the entry.
    emitEvent(db, {
      kind: "knowledge_promoted",
      substrate_origin: "substrate_auto",
      payload: { text: "fresh substrate movement", score: 0.5 },
    });
    await composePrompt(db, { taskId }); // miss again
    const misses = db.query(
      "SELECT COUNT(*) AS c FROM events WHERE kind = 'prompt_composition_cache_miss' AND task_id = ?",
    ).get(taskId) as { c: number };
    expect(misses.c).toBe(2);
  });

  test("RLMQ_PROMPT_COMP: fallback promoted-knowledge ranks by relevance score, not pure recency", async () => {
    const db = openDb(":memory:");
    const { taskId } = openTask(db);
    // Older row with a HIGH score, then a NEWER row with a LOW score, both
    // without goal-shape tags (same relevance class). Relevance-first
    // ordering must surface the high-score row above the newer low-score one.
    emitEvent(db, {
      kind: "knowledge_promoted",
      substrate_origin: "substrate_auto",
      payload: { text: "HIGH_SCORE_OLDER relevance-first marker", score: 0.95 },
    });
    emitEvent(db, {
      kind: "knowledge_promoted",
      substrate_origin: "substrate_auto",
      payload: { text: "LOW_SCORE_NEWER recency marker", score: 0.05 },
    });
    const composed = await composePrompt(db, { taskId });
    const hi = composed.text.indexOf("HIGH_SCORE_OLDER");
    const lo = composed.text.indexOf("LOW_SCORE_NEWER");
    expect(hi).toBeGreaterThanOrEqual(0);
    // The high-score (older) row must appear BEFORE the low-score (newer) one.
    expect(hi).toBeLessThan(lo === -1 ? Number.MAX_SAFE_INTEGER : lo);
  });

  test("under heavy budget pressure, P4 sections drop first", async () => {
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
    const composed = await composePrompt(db, { taskId, budgetTokens: 150 });
    // P0 sections must remain — but seeded constitutional gates / active
    // failures must drop before higher-priority owner/task context.
    expect(composed.truncated).toContain("active_failures");
    expect(composed.truncated).toContain("constitutional_gates");
  });

  test("returns a clear stub when task not found", async () => {
    const db = openDb(":memory:");
    const composed = await composePrompt(db, { taskId: "nonexistent_task" });
    expect(composed.text).toContain("TASK NOT FOUND");
  });

  test("includes promoted-knowledge entries when present", async () => {
    const db = openDb(":memory:");
    const { taskId } = openTask(db);
    emitEvent(db, {
      kind: "knowledge_promoted",
      substrate_origin: "substrate_auto",
      // RLMQ_PROMPT_COMP: fallback knowledge now ranks relevance-score-first
      // within a goal-shape class (not recency-first). Score 0.99 keeps this
      // row competitive with the seeded policy-bundle rows (score 0.95) so the
      // presence assertion holds under the new ordering.
      payload: { text: "Prefer recursive grep over shell find", score: 0.99, tags: ["pattern"] },
    });
    const composed = await composePrompt(db, { taskId });
    expect(composed.text).toContain("Prefer recursive grep");
  });

  test("renders WATCHED OUTPUTS with the upstream observation when a watch edge exists", async () => {
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
      action_artifact_id: "test_action_handle",
      verifier_artifact_id: "test_verifier_handle",
      payload: { observed_value: "PROBE_WATCH_TOKEN", verifier_kind: "deterministic_code" },
    });
    const composed = await composePrompt(db, { taskId });
    expect(composed.text).toContain("WATCHED OUTPUTS");
    expect(composed.text).toContain("PROBE_WATCH_TOKEN");
  });

  test("WATCHED OUTPUTS reads as (none) when no watch edges target this task", async () => {
    const db = openDb(":memory:");
    const { taskId } = openTask(db);
    const composed = await composePrompt(db, { taskId });
    expect(composed.text).toContain("WATCHED OUTPUTS: (none)");
  });

  test("when retrievedKnowledge is supplied, RETRIEVED KNOWLEDGE renders the rerank lines instead of recency", async () => {
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
    const composed = await composePrompt(db, {
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

  test("when retrievedArtifacts is supplied, CODE ARTIFACT REGISTRY renders the rerank lines", async () => {
    const db = openDb(":memory:");
    const { taskId } = openTask(db);
    const composed = await composePrompt(db, {
      taskId,
      retrievedArtifacts: {
        hits: [
          {
            event_id: "evt_artifact_top",
            kind: "act_artifact_admitted",
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

  test("estimateTokens returns positive integer counts via the real tokenizer", async () => {
    expect(estimateTokens("hello world")).toBeGreaterThan(0);
    expect(estimateTokens("")).toBeGreaterThanOrEqual(0);
    // Tokens should be fewer than characters for typical English text.
    expect(estimateTokens("hello world this is a longer test sentence"))
      .toBeLessThan("hello world this is a longer test sentence".length);
  });

  test("OWNER PROFILE section renders defaults stub when no owner_profile_recorded row exists, and renders the latest profile fields when one does", async () => {
    const db = openDb(":memory:");
    const { taskId } = openTask(db);
    // Before any owner_profile_recorded: section MUST be present with the
    // bootstrap policy block — the brain learns to look for it and apply
    // the sparse-profile heuristics (plain language, one question at a
    // time, explain on first encounter).
    const composedDefaults = await composePrompt(db, { taskId });
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

    const composed = await composePrompt(db, { taskId });
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

// ── compose-substage perf hygiene (2026-05-24) ───────────────────────
// The four largest compose sub-stages (read_owner_context,
// policy_section.*.posterior_bundle, read_other_active_goals,
// read_policy_bundle_sections) are ALL routed through poolQuery — none is a
// synchronous main-loop blocker. Their multi-second wall-times are SQL
// worker-pool queue contention, not query cost. Two structural guards:
//   1. attribution markers — every profiled subStage label carries [sync] or
//      [pooled] so future attribution is unambiguous.
//   2. memoization — selectPolicyBundleByPosterior fetches an identical row set
//      for every section (goal_shape always "", task_class filters in JS), so
//      the fetch is memoized once per compose and the 6 sections filter the
//      cached rows. Equivalence: each section still gets its own JS match/sort.
describe("compose substage attribution + memoization", () => {
  test("every profiled subStage label carries a [sync] or [pooled] attribution marker", () => {
    const source = readFileSync(new URL("./prompt_composer.ts", import.meta.url), "utf8");
    // Match both string-quoted and template-literal subStage labels.
    const labelRe = /subStage\(\s*(?:`([^`]+)`|"([^"]+)")/g;
    const unmarked: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = labelRe.exec(source)) !== null) {
      const label = m[1] ?? m[2] ?? "";
      if (!label.includes("[sync]") && !label.includes("[pooled]")) unmarked.push(label);
    }
    expect(unmarked).toEqual([]);
    // The four originally-ambiguous heavy sub-stages must now be marked pooled.
    expect(source).toContain("read_owner_context[pooled]");
    expect(source).toContain("read_other_active_goals[pooled]");
    expect(source).toContain("read_policy_bundle_sections[pooled]");
    expect(source).toContain(".posterior_bundle[pooled]`");
  });

  test("policy-bundle fetch is memoized once per compose (single SELECT shape, JS per-section filter)", () => {
    const source = readFileSync(new URL("./prompt_composer.ts", import.meta.url), "utf8");
    // The hoisted memo helper exists and the per-section selector reads from it
    // instead of issuing its own poolQuery.
    expect(source).toContain("let policyBundleRowsPromise");
    expect(source).toContain("const policyBundleRows = (): Promise<Record<string, unknown>[]>");
    expect(source).toContain("const rows = await policyBundleRows();");
    // selectPolicyBundleByPosterior must NOT contain its own poolQuery on
    // act_artifact prompt_policy_bundle (that fetch moved into the memo).
    const selStart = source.indexOf("const selectPolicyBundleByPosterior");
    const selEnd = source.indexOf("matches.sort", selStart);
    const selBody = source.slice(selStart, selEnd);
    expect(selBody).not.toContain("poolQuery");
    expect(selBody).not.toContain("FROM act_artifact");
  });

  test("memoized fetch preserves per-section bundle selection (semantics equivalence)", async () => {
    const db = openDb(":memory:");
    const { taskId } = openTask(db);
    const nowIso = new Date().toISOString();
    // Seed two prompt_policy_bundle rows targeting distinct sections. Each
    // section's JS filter (task_class = section name) must still pick its own
    // bundle body from the shared, memoized row set.
    const seedBundle = (id: string, section: string, body: string, score: number): void => {
      db.run(
        `INSERT INTO act_artifact (
           id, runtime, body, declared_sandbox, state_root, kind,
           posterior_alpha, posterior_beta, score, confidence,
           recent_residual_mean, recent_kill_count, status, name,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          "bun",
          JSON.stringify({ policy_bundle: { section_name: section, body, type: "policy_bundle", surface: "brain_prompt" }, task_class: section }),
          JSON.stringify({ runtime: "bun" }),
          `substrate/policy_bundle/${id}`,
          "prompt_policy_bundle",
          9,
          1,
          score,
          0.9,
          0.1,
          0,
          "admitted",
          section,
          nowIso,
          nowIso,
        ],
      );
    };
    seedBundle("pb_workflow", "workflow", "MEMOIZED-WORKFLOW-MARKER", 0.95);
    seedBundle("pb_do_not", "do_not", "MEMOIZED-DONOT-MARKER", 0.9);

    const composed = await composePrompt(db, { taskId });
    // Both section-specific bodies must surface — proving the single shared
    // fetch is filtered per-section exactly as the prior per-call fetch did.
    expect(composed.text).toContain("MEMOIZED-WORKFLOW-MARKER");
    expect(composed.text).toContain("MEMOIZED-DONOT-MARKER");
    closeDb();
  });

  test("EXPLAIN guard: heavy compose reads SEARCH via index, never full-SCAN the events table", () => {
    const db = openDb(":memory:");
    seedFoundationalKnowledge(db, { ownerApproved: true });
    const plan = (sql: string, params: unknown[] = []): string =>
      (db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as [])) as Array<{ detail?: string }>)
        .map((r) => r.detail ?? "")
        .join(" | ");

    // owner_conversation_view + active_objectives_view + policy bundle reads
    // must use SEARCH (indexed), never "SCAN events" (full-table scan on the
    // ~420k-row ledger). A SCAN of events here would be the regression.
    const ownerPlan = plan(
      "SELECT event_id, ts, directive_id, kind, payload FROM owner_conversation_view ORDER BY ts DESC LIMIT ?",
      [8],
    );
    expect(ownerPlan).not.toContain("SCAN events");
    expect(ownerPlan).toContain("idx_events_kind");

    const policyPlan = plan(
      `SELECT payload FROM events WHERE kind='knowledge_promoted'
         AND COALESCE(json_extract(payload,'$.policy_bundle.surface'),json_extract(payload,'$.surface'))=?
         AND COALESCE(json_extract(payload,'$.type'),json_extract(payload,'$.policy_bundle.type'))='policy_bundle'
        ORDER BY ts DESC, rowid DESC LIMIT 100`,
      ["brain_prompt"],
    );
    expect(policyPlan).not.toContain("SCAN events");

    const bundlePlan = plan(
      `SELECT id FROM act_artifact WHERE kind='prompt_policy_bundle'
         AND status IN ('admitted','promoted')
        ORDER BY score DESC, confidence DESC, updated_at DESC LIMIT 200`,
    );
    expect(bundlePlan).not.toContain("SCAN act_artifact USING");
    closeDb();
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

  test("null policy renders default invariants only", async () => {
    const text = buildOwnerRenderingPolicySection(null);
    expect(text).toContain("## OWNER RENDERING POLICY");
    expect(text).toContain("no owner_profile_recorded row yet");
    expect(text).toContain("Primary owner-visible text MUST NOT contain event_ids");
  });

  test("policy with declined / things_to_never_do renders them inline; preferred/avoided terms are NOT mirrored", async () => {
    const text = buildOwnerRenderingPolicySection(policy({
      preferred_terms: ["plain", "simple"],
      avoided_terms: ["dispatch", "residual"],
      declined_concepts: ["telemetry"],
      things_to_never_do: ["force-push to main"],
      manual_review_patterns: ["release tags"],
      autonomy_score: 0.3,
    }));
    // vocabulary-mirroring subsystem removed: word-forms are never injected.
    expect(text).not.toContain("preferred_terms");
    expect(text).not.toContain("avoided_terms");
    expect(text).toContain("declined_concepts");
    expect(text).toContain("things_to_never_do");
    expect(text).toContain("- force-push to main");
    expect(text).toContain("manual_review_patterns");
    expect(text).toContain("autonomy_score: 0.30");
  });

  test("feedback summary renders aggregates when present, default copy when window is empty", async () => {
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
  test("promoted knowledge with matching goal_shape is pulled before recency-only rows", async () => {
    const db = openDb(":memory:");
    const { taskId } = openTask(db);
    // High generic score keeps the comparison row inside the top-K under the
    // relevance-score tier; the goal_shape MATCH class must still outrank it.
    emitEvent(db, { kind: "knowledge_promoted", substrate_origin: "substrate_auto", payload: { text: "RECENT_BUT_GENERIC", score: 0.99 } });
    emitEvent(db, { kind: "knowledge_promoted", substrate_origin: "substrate_auto", payload: { text: "GOAL_SHAPE_MATCHED_KNOWLEDGE", score: 0.6, goal_shape: goalShape("Count files containing TODO substring") } });
    const composed = await composePrompt(db, { taskId, budgetTokens: 4000 });
    expect(composed.text.indexOf("GOAL_SHAPE_MATCHED_KNOWLEDGE")).toBeGreaterThanOrEqual(0);
    expect(composed.text.indexOf("GOAL_SHAPE_MATCHED_KNOWLEDGE")).toBeLessThan(composed.text.indexOf("RECENT_BUT_GENERIC"));
  });

  test("promoted knowledge with matching goal_shape_tags is pulled before recency-only rows", async () => {
    const db = openDb(":memory:");
    const { taskId } = openTask(db);
    emitEvent(db, { kind: "knowledge_promoted", substrate_origin: "substrate_auto", payload: { text: "RECENT_BUT_GENERIC_TAG_CASE", score: 0.99 } });
    emitEvent(db, { kind: "knowledge_promoted", substrate_origin: "substrate_auto", payload: { text: "TAG_MATCHED_MOVED_CONTRACT_KNOWLEDGE", score: 0.6, goal_shape_tags: ["todo"] } });
    const composed = await composePrompt(db, { taskId, budgetTokens: 4000 });
    expect(composed.text.indexOf("TAG_MATCHED_MOVED_CONTRACT_KNOWLEDGE")).toBeGreaterThanOrEqual(0);
    expect(composed.text.indexOf("TAG_MATCHED_MOVED_CONTRACT_KNOWLEDGE")).toBeLessThan(composed.text.indexOf("RECENT_BUT_GENERIC_TAG_CASE"));
  });

  test("direct promoted moved-contract knowledge renders rich payload text without a candidate join", async () => {
    const db = openDb(":memory:");
    const { taskId } = openTask(db);
    emitEvent(db, { kind: "knowledge_promoted", substrate_origin: "substrate_auto", payload: { claim: "DIRECT_PROMOTED_CONTRACT_CLAIM", evidence: ["moved from CLAUDE.md"], implications: ["retrieve by goal shape"], score: 0.7, goal_shape_tags: ["todo"] } });
    const composed = await composePrompt(db, { taskId, budgetTokens: 1200 });
    expect(composed.text).toContain("DIRECT_PROMOTED_CONTRACT_CLAIM");
    expect(composed.text).toContain("evidence: moved from CLAUDE.md");
    expect(composed.text).toContain("implications: retrieve by goal shape");
    expect(composed.text).not.toContain("(no text)");
  });
});

// ── owner world-model belief sections (Phase H2 of CY7E62DSNX1DZ1BTD56845D994) ──
describe("buildOwnerStateBeliefSection + buildAlignmentActionPolicySection + buildOwnerStateFeedbackSummarySection", () => {
  const belief = (overrides: Partial<OwnerStateBeliefRow> = {}): OwnerStateBeliefRow => ({
    hypothesis_event_id: "HYPO_1",
    hypothesis_ts: "2026-05-18T00:00:00Z",
    hypothesis_origin: "claude_inline",
    belief_source: "explicit_hypothesis",
    latent_state: {},
    confidence: {},
    observation_refs: [],
    evidence_refs: [],
    evidence_counts: {},
    evidence_count: 0,
    decay_after_iso: null,
    uncertainty: 0.5,
    temporal_decay_factor: 1,
    decayed_uncertainty: 0.5,
    recent_prediction_error_count: 0,
    recent_avg_prediction_error: null,
    belief_age_ms: 60_000,
    is_stale: false,
    ...overrides,
  });

  test("null belief renders the cold-install hint", async () => {
    const text = buildOwnerStateBeliefSection(null);
    expect(text).toContain("## OWNER STATE BELIEF");
    expect(text).toContain("no owner_state_hypothesis_recorded row yet");
  });

  test("belief with latent_state surfaces axes inline + cites hypothesis_event_id", async () => {
    const text = buildOwnerStateBeliefSection(belief({
      latent_state: {
        emotional_register: "tired",
        attention_budget: "low",
        decision_style: "direct_confirm",
        latent_larger_goal: "fast iteration",
        recent_disappointments: ["broken hot-reload"],
      },
      confidence: { emotional_register: 0.7, attention_budget: 0.6 },
      observation_refs: ["OBS1", "OBS2"],
      uncertainty: 0.3,
    }));
    expect(text).toContain("hypothesis_event_id: HYPO_1");
    expect(text).toContain("emotional_register: tired (conf 0.70)");
    expect(text).toContain("attention_budget: low");
    expect(text).toContain("decision_style: direct_confirm");
    expect(text).toContain("latent_larger_goal: fast iteration");
    expect(text).toContain("recent_disappointments: broken hot-reload");
    expect(text).toContain("grounded_in (event_ids): OBS1, OBS2");
  });

  test("belief with prediction_error >= 0.5 surfaces high-error WARNING", async () => {
    const text = buildOwnerStateFeedbackSummarySection(belief({
      recent_prediction_error_count: 3,
      recent_avg_prediction_error: 0.6,
    }));
    expect(text).toContain("prediction_error_count: 3");
    expect(text).toContain("avg_prediction_error: 0.600");
    expect(text).toContain("WARNING");
  });

  test("belief is_stale=true is surfaced inline so the brain refreshes the hypothesis", async () => {
    const text = buildOwnerStateBeliefSection(belief({ is_stale: true }));
    expect(text).toContain("STALE");
  });

  test("alignment_action_policy renders all 8 decision rules when belief is present", async () => {
    const text = buildAlignmentActionPolicySection(belief());
    expect(text).toContain("## ALIGNMENT ACTION POLICY");
    expect(text).toContain("things_to_never_do");
    expect(text).toContain("alignment_action_selected");
    expect(text).toContain("uncertainty > 0.6");
  });

  test("alignment_action_policy short-circuits on null belief", async () => {
    const text = buildAlignmentActionPolicySection(null);
    expect(text).toContain("no owner_state_belief");
  });

  test("buildTopLawsSection renders ranked laws with event_id citation hint (Phase I3+)", async () => {
    const laws: TopLawRow[] = [
      { event_id: "LAW1", ts: "2026-05-18", substrate_origin: "brain", candidate_id: null, directive_id: null, score: 0.95, confidence: 0.9, text: "Citation is mutation (k_554)", tags: [], context_refs: [], law_rank: 1 },
      { event_id: "LAW2", ts: "2026-05-18", substrate_origin: "brain", candidate_id: null, directive_id: null, score: 0.92, confidence: 0.88, text: "Retrieval binding (k_201) — knowledge compounds only when retrieval is behaviorally binding", tags: [], context_refs: [], law_rank: 2 },
    ];
    const text = buildTopLawsSection(laws);
    expect(text).toContain("## TOP LAWS");
    expect(text).toContain("1. LAW1 (score 0.95)");
    expect(text).toContain("Citation is mutation");
    expect(text).toContain("2. LAW2 (score 0.92)");
    expect(text).toContain("citation is mutation (k_554)");
  });

  test("buildTopLawsSection renders empty hint when no laws", async () => {
    const text = buildTopLawsSection([]);
    expect(text).toContain("## TOP LAWS");
    expect(text).toContain("substrate is still learning");
  });
});
