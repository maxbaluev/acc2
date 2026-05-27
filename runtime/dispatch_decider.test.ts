import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { runViews } from "../substrate/views";
import { decideDispatch, extractSemanticDagSignals, decompositionValueFromSignals, selectExecutor } from "./dispatch_decider";
import type { TaskNode } from "./task_topology";
import { emitEvent } from "./events";
import { newId } from "./ids";
import { goalShape } from "./goal_shape";
import { insertArtifact } from "./artifact_store";
import type { JsonValue, SandboxDecl } from "../substrate/types";

const TEST_SANDBOX: SandboxDecl = {
  runtime: "bun",
  fs_read: ["**/*"],
  fs_write: [],
  net_allow: [],
  proc_allow: [],
  substrate_access: "none",
  cpu_ms: 100,
  wall_ms: 100,
  memory_mb: 64,
};

afterAll(() => closeDb());
beforeEach(() => closeDb());

const sampleTask = (overrides: Partial<TaskNode> = {}): TaskNode => ({
  id: "t_sample",
  directive_id: "d_sample",
  parent_id: null,
  goal: "Count files containing TODO in scripts/cli/",
  status: "pending",
  ...overrides,
});

describe("dispatch_decider", () => {
  test("returns opencode_brain when no recipes or inline patterns are present", () => {
    const db = openDb(":memory:");
    const decision = decideDispatch(db, sampleTask());
    expect(decision.route).toBe("opencode_brain");
    if (decision.route === "opencode_brain") {
      expect(decision.reason).toBe("no_recipe_no_inline_match");
      expect(["low", "mid", "high"]).toContain(decision.predicted_complexity);
    }
  });

  test("exposes open-ended route axes and learned verifier evidence on every decision", () => {
    const db = openDb(":memory:");
    emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate_auto",
      action_artifact_id: "test_action_handle",
      verifier_artifact_id: "test_verifier_handle",
      residual: 0.1,
      payload: {
        verifier_kind: "deterministic_code",
        outcome_dimensions: { one_shot_confidence: 0.9, information_gap: 0.2 },
        reliability_profile: { reversibility: 0.8, owner_control_need: 0.3 },
        verifier_result: { breakdown: { decomposition_value: 0.4, cost_pressure: 0.7, time_sensitivity: 0.6 } },
      },
    });
    const decision = decideDispatch(db, sampleTask({ goal: "fix typo", target_resources: ["repo:docs/README.md"] } as Partial<TaskNode>));
    expect(decision.routing_axes.one_shot_confidence).toBeGreaterThan(0.5);
    expect(decision.routing_axes.information_gap).toBeGreaterThanOrEqual(0);
    expect(decision.route_scores.opencode_brain).toBeGreaterThanOrEqual(0);
    expect(decision.route_scores.claude_inline).toBeGreaterThanOrEqual(0);
    expect(decision.verifier_evidence.action_scored_rows_considered).toBeGreaterThan(0);
  });

  test("estimates short goals as low complexity", () => {
    const db = openDb(":memory:");
    const decision = decideDispatch(db, sampleTask({ goal: "count todos" }));
    expect(decision.route).toBe("opencode_brain");
    if (decision.route === "opencode_brain") {
      expect(decision.predicted_complexity).toBe("low");
    }
  });

  test("strategic audit/design work is NOT pre-classified by regex — it routes to the universal lane", () => {
    // CLEAN-BREAK (universal-workflow design DKDWVBTX): there is no
    // classifyHardTask regex/keyword judgment. A directive whose text used to
    // trip the "strategic_verb" / "multi_surface_target" classifier now routes
    // through the same universal opencode_brain lane as everything else — the
    // LM decides decomposition, not a deterministic verb matcher. Risk/
    // decomposition is surfaced as routing_axes evidence, not a hard verdict.
    const db = openDb(":memory:");
    emitEvent(db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: "d_hard",
      payload: {
        directive_text: "Audit and refactor runtime plus cli dispatch behavior",
        lifecycle: "finite",
      },
    });
    const decision = decideDispatch(db, sampleTask({
      directive_id: "d_hard",
      goal: "design dispatch behavior",
      target_resources: ["repo:runtime/dispatch_decider.ts", "repo:cli/dispatch.ts"],
    } as Partial<TaskNode>));
    // Valid universal route, never undefined.
    expect(decision.route).toBe("opencode_brain");
    // No regex hard-task reason leaks into the decision.
    expect(decision.reason).not.toContain("hard_task_dag_required");
    // The structural target count is still surfaced as evidence (NOT a verdict).
    expect(decision.verifier_evidence.target_count).toBe(2);
    // Decomposition is an axis the LM can act on, not a pre-gate.
    expect(decision.routing_axes.decomposition_value).toBeGreaterThanOrEqual(0);
  });

  test("routes to substrate_replay when a high-confidence recipe matches", () => {
    const db = openDb(":memory:");
    runViews(db);
    // Synthetic recipe targeting the task's goal text. topology_signature
    // is "" so the seed-style empty-topology exception applies (this is the
    // ONE legacy escape kept after recipe-match hardening — it covers
    // hand-seeded recipes from substrate/seed.ts that have no topology
    // stamp). confidence 0.9 is comfortably above the new 0.85 floor.
    emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "substrate_auto",
      directive_id: "d_recipe",
      task_id: "t_recipe",
      payload: {
        recipe_shape: { enabled: true },
        goal_shape: "count_todos_in_scripts::n1",
        topology_signature: "",
        confidence: 0.9,
        trajectory: [
          { step_kind: "action_predicted", artifact_id: "art_x", verifier_artifact_id: "art_v", payload_template: {} },
        ],
      },
    });
    const task = sampleTask({ goal: "count TODOs in scripts/cli/" });
    const decision = decideDispatch(db, task);
    expect(decision.route).toBe("substrate_replay");
    if (decision.route === "substrate_replay") {
      expect(decision.reason).toBe("recipe_match");
    }
  });

  test("a high-confidence recipe match is feasible for any directive — no hard-task gate blocks substrate_replay", () => {
    // CLEAN-BREAK (universal-workflow design DKDWVBTX): recipe-replay
    // feasibility is no longer gated by regex hard-task classification. A
    // directive whose verbs used to force "hard_task_dag_required" now routes
    // to substrate_replay on the strength of the recipe's confidence alone —
    // there is no replay-residual override gate keyed to a hardness verdict.
    const db = openDb(":memory:");
    runViews(db);
    const recipe = emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "substrate_auto",
      directive_id: "d_recipe",
      task_id: "t_recipe",
      payload: {
        recipe_shape: { enabled: true },
        goal_shape: goalShape("audit runtime design"),
        topology_signature: "",
        confidence: 0.95,
        trajectory: [
          { step_kind: "action_predicted", artifact_id: "art_x", verifier_artifact_id: "art_v", payload_template: {} },
        ],
      },
    });
    const decision = decideDispatch(db, sampleTask({ goal: "audit runtime design" }));
    expect(decision.route).toBe("substrate_replay");
    if (decision.route === "substrate_replay") {
      expect(decision.recipe_id).toBe(recipe.id);
      expect(decision.reason).toBe("recipe_match");
    }
    // No regex hard-task reason or override-verified branch survives.
    expect(decision.reason).not.toContain("hard_task_dag_required");
    expect(decision.reason).not.toContain("recipe_match_hard_override_verified");
  });

  test("inline lane is not blocked by hard-task classification — matching patterns make it feasible", () => {
    // CLEAN-BREAK (universal-workflow design DKDWVBTX): the inline lane is no
    // longer removed from feasibleRoutes by a regex hardness verdict. With a
    // promoted low-risk pattern matching every target_resource, the inline
    // lane is feasible; residual-scored selection (plus learned/peer
    // posteriors) decides whether it actually wins. Either way the route is a
    // valid universal lane, never undefined.
    const db = openDb(":memory:");
    runViews(db);
    emitEvent(db, {
      kind: "knowledge_promoted",
      substrate_origin: "substrate_auto",
      directive_id: "d_inline",
      task_id: "t_inline",
      payload: {
        tags: ["low_risk_inline_pattern"],
        pattern_kind: "glob",
        pattern: "repo:runtime/*.ts",
        score: 0.9,
        confidence: 0.8,
      },
    });
    emitEvent(db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: "d_hard_inline",
      payload: { directive_text: "Audit and refactor runtime dispatch behavior", lifecycle: "finite" },
    });
    const decision = decideDispatch(db, sampleTask({
      directive_id: "d_hard_inline",
      goal: "audit runtime dispatch behavior",
      target_resources: ["repo:runtime/dispatch_decider.ts"],
    } as Partial<TaskNode>));
    // A valid route is always produced.
    expect(["opencode_brain", "claude_inline"]).toContain(decision.route);
    // No regex hard-task reason leaks in regardless of which lane scores highest.
    expect(decision.reason).not.toContain("hard_task_dag_required");
    expect(decision.reason).not.toContain("no_verified_recipe_override");
    // The inline lane was admitted as feasible (claude_inline is one of the
    // routes scored), proving hardness did not pre-strip it.
    expect(decision.route_scores.claude_inline).toBeGreaterThanOrEqual(0);
  });

  test("routes inline only when every target_resource matches a scheme-aware pattern", () => {
    const db = openDb(":memory:");
    runViews(db);
    emitEvent(db, {
      kind: "knowledge_promoted",
      substrate_origin: "substrate_auto",
      directive_id: "d_inline",
      task_id: "t_inline",
      payload: {
        tags: ["low_risk_inline_pattern"],
        pattern_kind: "glob",
        pattern: "repo:docs/*.md",
        score: 0.9,
        confidence: 0.8,
      },
    });
    const decision = decideDispatch(db, sampleTask({
      goal: "fix doc typo",
      target_resources: ["repo:docs/README.md"],
    } as Partial<TaskNode>));
    expect(decision.route).toBe("claude_inline");
  });

  test("does not route inline from legacy target_files alone", () => {
    const db = openDb(":memory:");
    runViews(db);
    emitEvent(db, {
      kind: "knowledge_promoted",
      substrate_origin: "substrate_auto",
      directive_id: "d_inline",
      task_id: "t_inline",
      payload: {
        tags: ["low_risk_inline_pattern"],
        pattern_kind: "glob",
        pattern: "repo:docs/*.md",
        score: 0.9,
        confidence: 0.8,
      },
    });
    const decision = decideDispatch(db, sampleTask({
      goal: "fix doc typo",
      target_files: ["docs/README.md"],
    } as Partial<TaskNode>));
    // The intent of this test: legacy `target_files` alone does NOT match the
    // inline glob pattern (which keys on `target_resources`), so the inline
    // lane is not feasible and never selected. Amendment 0MD1R9T8 made
    // claude_agent a co-equal feasible executor (no live-peer gate), so the
    // residual-scored selection may pick claude_agent over opencode_brain on
    // their pre-existing base axis scores — both are valid brain executors. The
    // load-bearing assertion is simply: not claude_inline.
    expect(decision.route).not.toBe("claude_inline");
  });

  test("crisis-mode lowers the recipe threshold so a mid-confidence recipe still routes", () => {
    const db = openDb(":memory:");
    runViews(db);
    const directiveId = newId();
    // Open directive with urgency=crisis so readCurrentMode returns CRISIS_MODE.
    emitEvent(db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: directiveId,
      payload: { directive_text: "scrape inventory", urgency: "crisis", lifecycle: "finite" },
    });
    // Recipe seeded at 0.75 — above the 0.7 crisis threshold but below the
    // 0.85 normal threshold, so it ONLY routes when crisis mode is active.
    emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      task_id: directiveId,
      payload: {
        recipe_shape: { enabled: true },
        goal_shape: "scrape_inventory::n1",
        topology_signature: "",
        confidence: 0.75,
        trajectory: [
          { step_kind: "action_predicted", artifact_id: "art_x", verifier_artifact_id: "art_v", payload_template: {} },
        ],
      },
    });
    const task = sampleTask({
      directive_id: directiveId,
      goal: "scrape inventory of warehouse",
    });
    const decision = decideDispatch(db, task);
    expect(decision.route).toBe("substrate_replay");
  });
  test("uses peer accuracy posteriors before choosing between feasible peer lanes", () => {
    const db = openDb(":memory:");
    runViews(db);
    const directiveText = "fix doc typo posterior routed";
    const shape = goalShape(directiveText);
    emitEvent(db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: "d_shape",
      task_id: "t_shape",
      payload: { directive_text: directiveText, lifecycle: "finite" },
    });
    emitEvent(db, {
      kind: "knowledge_promoted",
      substrate_origin: "substrate_auto",
      directive_id: "d_inline",
      task_id: "t_inline",
      payload: {
        tags: ["low_risk_inline_pattern"],
        pattern_kind: "glob",
        pattern: "repo:docs/*.md",
        score: 0.9,
        confidence: 0.8,
      },
    });
    const nowTs = new Date().toISOString();
    db.run(
      `INSERT INTO act_artifact (id, runtime, kind, body, declared_sandbox, posterior_alpha, posterior_beta, score, confidence, status, name, fixture_expected_residual, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `brain_accuracy_predicate:opencode:${shape}`,
        "bun",
        "brain_accuracy_predicate",
        `// peer=opencode goal_shape=${shape}`,
        "{}",
        9,
        1,
        0.95,
        0.8,
        "admitted",
        `brain_accuracy_predicate_opencode_${shape}`,
        0,
        nowTs,
        nowTs,
      ],
    );
    db.run(
      `INSERT INTO act_artifact (id, runtime, kind, body, declared_sandbox, posterior_alpha, posterior_beta, score, confidence, status, name, fixture_expected_residual, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `brain_accuracy_predicate:claude_inline:${shape}`,
        "bun",
        "brain_accuracy_predicate",
        `// peer=claude_inline goal_shape=${shape}`,
        "{}",
        1,
        9,
        0.05,
        0.8,
        "admitted",
        `brain_accuracy_predicate_claude_inline_${shape}`,
        0,
        nowTs,
        nowTs,
      ],
    );

    const decision = decideDispatch(db, sampleTask({
      directive_id: "d_shape",
      goal: directiveText,
      target_resources: ["repo:docs/README.md"],
    } as Partial<TaskNode>));

    expect(decision.route).toBe("opencode_brain");
    expect(decision.route_scores.opencode_brain).toBeGreaterThan(decision.route_scores.claude_inline);
    expect(decision.verifier_evidence.peer_accuracy_adjustment_applied).toBe(1);
    expect(decision.verifier_evidence.peer_accuracy_opencode_brain_score).toBeGreaterThan(0.9);
    expect(decision.verifier_evidence.peer_accuracy_claude_inline_predicted_residual).toBeGreaterThan(0.9);
  });

  test("uses learned open-ended axes to choose among feasible non-blocked routes", () => {
    const db = openDb(":memory:");
    runViews(db);
    emitEvent(db, {
      kind: "knowledge_promoted",
      substrate_origin: "substrate_auto",
      directive_id: "d_inline",
      task_id: "t_inline",
      payload: {
        tags: ["low_risk_inline_pattern"],
        pattern_kind: "glob",
        pattern: "repo:docs/*.md",
        score: 0.9,
        confidence: 0.8,
      },
    });
    emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate_auto",
      action_artifact_id: "test_action_handle",
      verifier_artifact_id: "test_verifier_handle",
      residual: 0.2,
      payload: {
        verifier_kind: "deterministic_code",
        verifier_result: {
          breakdown: {
            one_shot_confidence: 0.1,
            information_gap: 0.9,
            reversibility: 0.2,
            owner_control_need: 0.8,
            decomposition_value: 0.9,
            cost_pressure: 0.2,
            time_sensitivity: 0.2,
          },
        },
      },
    });

    const decision = decideDispatch(db, sampleTask({
      goal: "fix doc typo",
      target_resources: ["repo:docs/README.md"],
    } as Partial<TaskNode>));

    expect(decision.route).toBe("opencode_brain");
    expect(decision.route_scores.opencode_brain).toBeGreaterThan(decision.route_scores.claude_inline);
    expect(decision.verifier_evidence.selected_route_score).toBe(decision.route_scores.opencode_brain);
    // Amendment 0MD1R9T8 (increment 2/2): claude_agent is now a CO-EQUAL
    // feasible executor lane (substrate-spawnable via runtime/bridge/claude.ts),
    // no longer gated on a live external peer. Feasible routes here are
    // opencode_brain + claude_inline (matched glob) + claude_agent = 3. This
    // design leaf is not an apply leaf, so opencode_brain still wins.
    expect(decision.verifier_evidence.feasible_route_count).toBe(3);
  });

  describe("semantic DAG signals", () => {
    test("trivial one-shot text scores high one_shot_answer_fit and zero independent deliverables", () => {
      const sig = extractSemanticDagSignals("what is the daemon pid");
      expect(sig.independent_deliverable_count).toBe(0);
      expect(sig.gate_count).toBe(0);
      expect(sig.one_shot_answer_fit).toBeGreaterThan(0.8);
    });

    test("numbered-list directive with parts + closure verifier scores many deliverables + gates", () => {
      const sig = extractSemanticDagSignals(`PART A — first thing
PART B — second thing
PART C — third thing

The closure verifier must audit X and the residual must be < 0.3.
Cite real papers (title + arxiv id). Each retained DISTINCT proposal must explicitly name what it cannot absorb.`);
      expect(sig.independent_deliverable_count).toBeGreaterThanOrEqual(3);
      expect(sig.gate_count).toBeGreaterThanOrEqual(2);
      expect(sig.evidence_modality_count).toBeGreaterThanOrEqual(2);
      expect(sig.one_shot_answer_fit).toBeLessThan(0.5);
    });

    test("the 12-axis research directive that fooled the decider now scores high decomposition", () => {
      // Regression: previous dispatch CDK88BVD scored decomposition_value low
      // for this directive and went one-shot, missing the brain's lesson
      // VZE6Q5PS / EEEF091H mandate.
      const directiveText = `Scientific research: dramatically improve acc2 across 12 axes. Cite real papers.

1. UNIVERSAL FOR ANY HUMAN TASK
2. FAST + EFFICIENT
3. PROMPT EFFICIENT
4. TRULY UNIVERSAL
5. CONTEXT-ROT
6. SITUATIONAL JUDGMENT
7. UNIFIED COGNITION
8. SELF-EVOLVING
9. CONTINUOUSLY COMPRESS COMPLEXITY
10. NATURALLY COLLABORATIVE
11. GROUNDED WORLD MODELS
12. MINIMIZE GAP

Closure verifier must audit that the proposal cites concrete papers, identifies the minimal substrate-side change for each axis, avoids advisory flags.`;
      const sig = extractSemanticDagSignals(directiveText);
      expect(sig.independent_deliverable_count).toBeGreaterThanOrEqual(12);
      expect(sig.gate_count).toBeGreaterThanOrEqual(1);
      expect(sig.evidence_modality_count).toBeGreaterThanOrEqual(2);
      expect(sig.one_shot_answer_fit).toBeLessThan(0.3);
      // The composite decomposition_value must rise to "obviously needs DAG".
      const decomposition = decompositionValueFromSignals(sig, 0.20);
      expect(decomposition).toBeGreaterThan(0.7);
    });

    test("decompositionValueFromSignals never lowers the heuristic baseline", () => {
      const trivialSig = extractSemanticDagSignals("hi");
      // A trivial signal payload — heuristic baseline of 0.85 must still win.
      expect(decompositionValueFromSignals(trivialSig, 0.85)).toBeGreaterThanOrEqual(0.85);
    });

    test("buildDispatchDecisionEvidence surfaces semantic signals in verifier_evidence", () => {
      const db = openDb(":memory:");
      runViews(db);
      emitEvent(db, {
        kind: "directive_opened",
        substrate_origin: "claude_root",
        directive_id: "d_sem",
        payload: {
          directive_text: `PART A — design X. PART B — design Y. PART C — design Z. Closure verifier must audit each part. Cite arxiv papers.`,
        },
      });
      const decision = decideDispatch(db, sampleTask({
        directive_id: "d_sem",
        goal: "research and design multi-axis improvements",
      }));
      const ve = decision.verifier_evidence;
      expect(ve.semantic_independent_deliverable_count).toBeGreaterThanOrEqual(3);
      expect(ve.semantic_gate_count).toBeGreaterThanOrEqual(1);
      expect(ve.semantic_evidence_modality_count).toBeGreaterThanOrEqual(1);
      expect(typeof ve.semantic_one_shot_answer_fit).toBe("number");
      expect(typeof ve.semantic_decomposition_baseline).toBe("number");
      // Final decomposition_value should land high.
      expect(decision.routing_axes.decomposition_value).toBeGreaterThan(0.5);
    });
  });
});

// ── Amendment A12ET3SF — active strategy ranking (not shadow) ──────
import { seedActArtifacts } from "../substrate/seed";

describe("dispatch_decider — active strategy ranking (amendment A12ET3SF)", () => {
  test("strategy_ranks is populated and active route-delta merge ran (not payload-only shadow evidence)", () => {
    const db = openDb(":memory:");
    runViews(db);
    seedActArtifacts(db);
    // Make claude_inline feasible so a strategy that prefers it can affect scoring.
    emitEvent(db, {
      kind: "knowledge_promoted",
      substrate_origin: "substrate_auto",
      directive_id: "d_strat",
      task_id: "t_strat",
      payload: { tags: ["low_risk_inline_pattern"], pattern_kind: "glob", pattern: "repo:docs/*.md", score: 0.9, confidence: 0.8 },
    });
    const decision = decideDispatch(db, sampleTask({ goal: "fix doc typo", target_resources: ["repo:docs/README.md"] } as Partial<TaskNode>));
    // Active field is populated and mirrored to the back-compat name.
    expect(Array.isArray(decision.strategy_ranks)).toBe(true);
    expect(decision.strategy_ranks!.length).toBeGreaterThan(0);
    expect(decision.strategy_shadow_ranks).toEqual(decision.strategy_ranks);
    // The ACTIVE merge ran: verifier_evidence records the strategy rank count
    // and that fail-soft did NOT trip (ranks were non-empty). If rankings were
    // payload-only shadow evidence these fields would be absent.
    expect(decision.verifier_evidence.strategy_rank_count).toBeGreaterThan(0);
    expect(decision.verifier_evidence.strategy_ranker_fail_soft).toBe(0);
  });
});

// ── Amendment XFCDK2 — runtime selection by scored posterior, NOT regex ──
//
// The former keyword/regex lifts (text "python"→uv, "browser"→camofox) are
// removed: the project contract forbids regex for language understanding.
// Runtime choice is now driven by artifact posterior, recent action_scored
// outcomes, runtime availability, and STRUCTURAL `runtime:<x>:` target
// resources only. These tests pin the new scored behavior and replace the two
// prior tests (`a python-shaped task text scores uv highest` /
// `a browser-shaped task text scores camofox-browser highest`) that asserted
// the old keyword-regex routing this amendment deletes.
describe("dispatch_decider — runtime selection by scored posterior (amendment XFCDK2)", () => {
  test("free-text keywords alone do NOT force-route a runtime (no regex language matching)", () => {
    const db = openDb(":memory:");
    runViews(db);
    emitEvent(db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: "d_py",
      payload: { directive_text: "Load the CSV with pandas and run a numpy regression in python", lifecycle: "finite" },
    });
    const decision = decideDispatch(db, sampleTask({
      directive_id: "d_py",
      goal: "analyze data with pandas numpy in python",
    } as Partial<TaskNode>));
    const rs = decision.runtime_selection;
    expect(rs).toBeDefined();
    // With no artifact posterior, no outcomes, and no runtime: target, the
    // word "python" does NOT lift uv above the neutral baseline — every
    // candidate stays tied. The OLD regex would have forced uv > bun here.
    expect(rs!.candidate_scores.uv).toBeCloseTo(rs!.candidate_scores.bun ?? 0, 5);
    expect(rs!.candidate_scores.uv).toBeCloseTo(rs!.candidate_scores["camofox-browser"] ?? 0, 5);
  });

  test("a 'python'-mentioning task is NOT force-routed when posterior/availability favor another runtime", () => {
    const db = openDb(":memory:");
    runViews(db);
    // Admit a high-posterior bun artifact AND mark uv unavailable. The scored
    // path must pick bun even though the text screams "python/pandas/numpy".
    emitEvent(db, {
      kind: "runtime_self_diagnostic_recorded",
      substrate_origin: "substrate_auto",
      payload: { runtime: "uv", fault_kind: "runtime_unavailable" },
    });
    db.run(
      `INSERT INTO act_artifact (
         id, runtime, body, declared_sandbox, state_root,
         posterior_alpha, posterior_beta, score, confidence,
         recent_residual_mean, recent_kill_count, status, name,
         fixture_input, fixture_expected_residual, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "art_bun_high", "bun", "// stub",
        JSON.stringify({ runtime: "bun", cpu_ms: 1000, wall_ms: 1000, memory_mb: 64 }),
        "state/x", 1, 1, 0.97, 0.95, 0, 0, "promoted", "bun runner",
        "{}", 0, "2026-05-26T00:00:00Z", "2026-05-26T00:00:00Z",
      ],
    );
    emitEvent(db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: "d_py2",
      payload: { directive_text: "Load the CSV with pandas and run a numpy regression in python", lifecycle: "finite" },
    });
    const decision = decideDispatch(db, sampleTask({
      directive_id: "d_py2",
      goal: "analyze data with pandas numpy in python",
    } as Partial<TaskNode>));
    const rs = decision.runtime_selection;
    expect(rs).toBeDefined();
    // Posterior (bun=0.97) + availability penalty on uv decide the winner —
    // the "python" keyword does not override the scored evidence.
    expect(rs!.selected_runtime).toBe("bun");
    expect(rs!.candidate_scores.bun).toBeGreaterThan(rs!.candidate_scores.uv ?? 0);
  });

  test("a structural runtime: target resource (not free text) deterministically lifts its runtime", () => {
    const db = openDb(":memory:");
    runViews(db);
    emitEvent(db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: "d_struct",
      payload: { directive_text: "do the thing", lifecycle: "finite" },
    });
    const decision = decideDispatch(db, sampleTask({
      directive_id: "d_struct",
      goal: "run the analysis",
      target_resources: ["runtime:python:analysis.py"],
    } as Partial<TaskNode>));
    const rs = decision.runtime_selection;
    expect(rs).toBeDefined();
    // The structural scheme (runtime:python:) — NOT a regex on prose — lifts uv.
    expect(rs!.selected_runtime).toBe("uv");
    expect(rs!.candidate_scores.uv).toBeGreaterThan(rs!.candidate_scores.bun ?? 0);
  });
});

// ── Amendment XN9P09R6 — no stale hard-task preclassifier ──────────
import * as DispatchDeciderModule from "./dispatch_decider";

describe("dispatch_decider — no stale lanes (amendment XN9P09R6)", () => {
  test("no classifyHardTask / hard_task_regex symbol is exported", () => {
    const exported = Object.keys(DispatchDeciderModule);
    expect(exported).not.toContain("classifyHardTask");
    expect(exported).not.toContain("hard_task_regex");
    expect(exported.some((k) => /classifyHardTask|hard_task_regex|HARD_TASK/i.test(k))).toBe(false);
  });

  test("a keyword-heavy strategic goal keeps substrate_replay selectable when a high-confidence recipe scores highest", () => {
    const db = openDb(":memory:");
    runViews(db);
    emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "substrate_auto",
      directive_id: "d_recipe_strat",
      task_id: "t_recipe_strat",
      payload: {
        recipe_shape: { enabled: true },
        goal_shape: goalShape("design and audit the runtime architecture"),
        topology_signature: "",
        confidence: 0.95,
        trajectory: [
          { step_kind: "action_predicted", artifact_id: "art_x", verifier_artifact_id: "art_v", payload_template: {} },
        ],
      },
    });
    const decision = decideDispatch(db, sampleTask({ goal: "design and audit the runtime architecture" }));
    // Strategic verbs did NOT prune substrate_replay; it stays feasible and
    // wins because its scored route is highest.
    expect(decision.route_scores.substrate_replay).toBeGreaterThanOrEqual(0);
    expect(decision.route).toBe("substrate_replay");
    expect(decision.reason).not.toContain("hard_task");
  });
});

describe("dispatch_decider executor-selection (increment 2/2 CC bridge)", () => {
  // Seed a task_node_opened so selectExecutor's ledger fallback can read the
  // structural implementation-leaf markers (the thin scheduler TaskNode carries
  // only id/goal/status).
  const seedTaskNode = (
    db: ReturnType<typeof openDb>,
    taskId: string,
    directiveId: string,
    payload: Record<string, unknown>,
  ) =>
    emitEvent(db, {
      kind: "task_node_opened",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      task_id: taskId,
      payload: { goal: "leaf", ...payload } as JsonValue,
    });

  test("deterministic fallback: design/research leaf prefers opencode (no scored policy)", () => {
    const db = openDb(":memory:");
    const task = sampleTask({ id: "t_design", directive_id: "d_design", goal: "design and research the architecture" });
    seedTaskNode(db, "t_design", "d_design", { goal: task.goal });
    const sel = selectExecutor(db, task, goalShape(task.goal));
    expect(sel.preferred_route).toBe("opencode_brain");
    expect(sel.decision_policy_artifact_id).toBeNull();
    expect(sel.reason).toBe("deterministic_default_to_opencode_brain");
  });

  test("deterministic fallback: implementation/apply leaf prefers claude_agent (no scored policy)", () => {
    const db = openDb(":memory:");
    const task = sampleTask({ id: "t_impl", directive_id: "d_impl", goal: "apply the amendment" });
    // source_proposal_id + requires_deliverable are the contract-amendment
    // apply-leaf markers; executor selection routes them to claude_agent.
    seedTaskNode(db, "t_impl", "d_impl", {
      goal: task.goal,
      source_proposal_id: "prop_abc",
      requires_deliverable: true,
      executor_hint: "claude_agent",
      target_files: ["runtime/foo.ts"],
    });
    const sel = selectExecutor(db, task, goalShape(task.goal));
    expect(sel.preferred_route).toBe("claude_agent");
    expect(sel.decision_policy_artifact_id).toBeNull();
    expect(sel.reason).toBe("deterministic_implementation_leaf_to_claude_agent");
    expect(sel.weight).toBeGreaterThan(0);
  });

  test("scored policy wins: an admitted executor_selection policy overrides the structural default", () => {
    const db = openDb(":memory:");
    const goal = "design the runtime";
    const shape = goalShape(goal);
    // Admit a scored_decision_policy_v1 row that declares executor=claude_agent
    // for this goal_shape. The retriever reads body via LIKE on decision_kind +
    // goal_shape; the POLICY literal carries the params.
    insertArtifact(db, {
      runtime: "bun",
      body: [
        "// scored_decision_policy_v1",
        `// decision_kind: executor_selection`,
        `// goal_shape_key: ${shape}`,
        `const POLICY = { decision_kind: "executor_selection", goal_shape_key: "${shape}", policy_params: { executor: "claude_agent", confidence: 0.9 } };`,
        "console.log(POLICY);",
      ].join("\n"),
      declaredSandbox: TEST_SANDBOX,
      stateRoot: null,
      posteriorAlpha: 8,
      posteriorBeta: 1,
      score: 0.85,
      confidence: 0.8,
      recentResidualMean: 0,
      recentKillCount: 0,
      status: "promoted",
      name: "executor_selection_policy_v1",
      fixtureInput: null,
      fixtureExpectedResidual: 0,
      intent: null,
      summary: null,
      targetFiles: null,
      kind: "scored_decision_policy_v1",
    } as never);
    runViews(db);
    // A design leaf (would default to opencode) — the scored policy flips it.
    const task = sampleTask({ id: "t_pol", directive_id: "d_pol", goal });
    seedTaskNode(db, "t_pol", "d_pol", { goal });
    const sel = selectExecutor(db, task, shape);
    expect(sel.preferred_route).toBe("claude_agent");
    expect(sel.decision_policy_artifact_id).not.toBeNull();
    expect(sel.reason).toBe("scored_executor_selection_policy");
    expect(sel.weight).toBeCloseTo(0.9, 1);
  });

  test("claude_agent route is co-equally feasible and wins for an implementation leaf via the delta", () => {
    const db = openDb(":memory:");
    const task = sampleTask({ id: "t_win", directive_id: "d_win", goal: "apply edits to runtime" });
    seedTaskNode(db, "t_win", "d_win", {
      goal: task.goal,
      executor_hint: "claude_agent",
      requires_deliverable: true,
      target_files: ["runtime/x.ts"],
    });
    const decision = decideDispatch(db, task);
    expect(decision.route).toBe("claude_agent");
    if (decision.route === "claude_agent") {
      expect(decision.reason).toContain("executor_selection");
      expect((decision.acceptance_predicate as Record<string, unknown>).executor).toBe("claude_agent");
    }
    // The executor-selection evidence is surfaced for downstream credit.
    expect(decision.verifier_evidence.executor_selection_weight).toBeGreaterThan(0);
  });
});

// ── P4 universalization — decider READS route-axis posteriors (CWHVYFX9) ──
//
// closure_check: BEFORE route selection the decider folds the
// dispatch_route_axis_factor posteriors into the axis contribution. ADDITIVE
// — a well-evidenced axis posterior nudges the axis value; cold-start is a
// no-op so the existing routing logic is preserved verbatim.
describe("P4 route-axis-factor posterior feedback (amendment CWHVYFX9)", () => {
  // Seed a scored_entity row directly so the test controls the posterior
  // (entity_kind=dispatch_route_axis_factor is the same row credit.ts writes).
  const seedAxisPosterior = (
    db: ReturnType<typeof openDb>,
    axisKey: string,
    alpha: number,
    beta: number,
    score: number,
    confidence: number,
  ): void => {
    db.run(
      `INSERT INTO scored_entity (entity_id, entity_kind, posterior_alpha, posterior_beta, score, confidence, updated_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(entity_id) DO UPDATE SET
         posterior_alpha = excluded.posterior_alpha,
         posterior_beta = excluded.posterior_beta,
         score = excluded.score,
         confidence = excluded.confidence,
         updated_ts = excluded.updated_ts`,
      ["dispatch_route_axis_factor:" + axisKey, "dispatch_route_axis_factor", alpha, beta, score, confidence, new Date().toISOString()],
    );
  };

  test("high-confidence axis posterior nudges the axis value and surfaces evidence keys", () => {
    const db = openDb(":memory:");
    const task = sampleTask({ goal: "fix doc typo", target_resources: ["repo:docs/README.md"] } as Partial<TaskNode>);
    // Baseline (no posterior) one_shot_confidence value.
    const baseline = decideDispatch(db, task).routing_axes.one_shot_confidence;
    closeDb();

    const db2 = openDb(":memory:");
    // Strong posterior pulling one_shot_confidence DOWN to 0.0 at high confidence.
    seedAxisPosterior(db2, "one_shot_confidence", 1, 9, 0.0, 0.9);
    const decision = decideDispatch(db2, task);
    // The axis was nudged toward the posterior score (0.0) at confidence 0.9.
    expect(decision.routing_axes.one_shot_confidence).toBeLessThan(baseline);
    // Evidence is surfaced so the read is observable + auditable.
    expect(decision.verifier_evidence.route_axis_factor_posterior_applied).toBe(1);
    expect(decision.verifier_evidence.route_axis_factor_one_shot_confidence_posterior_confidence).toBeCloseTo(0.9, 6);
    closeDb();
  });

  test("cold-start (no posterior row) leaves routing axes unchanged", () => {
    const db = openDb(":memory:");
    const task = sampleTask({ goal: "fix doc typo", target_resources: ["repo:docs/README.md"] } as Partial<TaskNode>);
    const baseline = decideDispatch(db, task).routing_axes.one_shot_confidence;
    closeDb();

    const db2 = openDb(":memory:");
    const decision = decideDispatch(db2, task);
    expect(decision.routing_axes.one_shot_confidence).toBeCloseTo(baseline, 6);
    // No posterior applied → applied flag is 0.
    expect(decision.verifier_evidence.route_axis_factor_posterior_applied).toBe(0);
    closeDb();
  });
});
