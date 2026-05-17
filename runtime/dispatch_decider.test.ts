import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { runViews } from "../substrate/views";
import { classifyHardTask, decideDispatch, extractSemanticDagSignals, decompositionValueFromSignals } from "./dispatch_decider";
import type { TaskNode } from "./task_topology";
import { emitEvent } from "./events";
import { newId } from "./ids";
import { goalShape } from "./goal_shape";

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
      residual: 0.1,
      payload: {
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

  test("classifies strategic audit/design work as hard with measured axes", () => {
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
    const classification = classifyHardTask(db, sampleTask({
      directive_id: "d_hard",
      goal: "design hard-task classifier",
      target_resources: ["repo:runtime/dispatch_decider.ts", "repo:cli/dispatch.ts"],
    } as Partial<TaskNode>));
    expect(classification.is_hard).toBe(true);
    expect(classification.axes).toContain("strategic_verb");
    expect(classification.axes).toContain("multi_surface_target");
    expect(classification.diagnostics.surface_count).toBe(2);
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
      kind: "recipe_extracted",
      substrate_origin: "substrate_auto",
      directive_id: "d_recipe",
      task_id: "t_recipe",
      payload: {
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

  test("forces hard tasks to DAG when a recipe match has not proven low replay residuals", () => {
    const db = openDb(":memory:");
    runViews(db);
    emitEvent(db, {
      kind: "recipe_extracted",
      substrate_origin: "substrate_auto",
      directive_id: "d_recipe",
      task_id: "t_recipe",
      payload: {
        goal_shape: goalShape("audit runtime design"),
        topology_signature: "",
        confidence: 0.95,
        trajectory: [
          { step_kind: "action_predicted", artifact_id: "art_x", verifier_artifact_id: "art_v", payload_template: {} },
        ],
      },
    });
    const decision = decideDispatch(db, sampleTask({ goal: "audit runtime design" }));
    expect(decision.route).toBe("opencode_brain");
    if (decision.route === "opencode_brain") {
      expect(decision.predicted_complexity).toBe("high");
      expect(decision.reason).toContain("hard_task_dag_required");
      expect(decision.reason).toContain("recipe_replay_observed=0");
      expect(decision.reason).toContain("diagnostics=word_count=");
    }
  });

  test("forces hard tasks to DAG before the inline lane even when targets match low-risk patterns", () => {
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
    expect(decision.route).toBe("opencode_brain");
    if (decision.route === "opencode_brain") {
      expect(decision.reason).toContain("hard_task_dag_required");
      expect(decision.reason).toContain("no_verified_recipe_override");
    }
  });

  test("allows recipe override for hard tasks only after recent replay residuals are low", () => {
    const db = openDb(":memory:");
    runViews(db);
    const recipe = emitEvent(db, {
      kind: "recipe_extracted",
      substrate_origin: "substrate_auto",
      directive_id: "d_recipe",
      task_id: "t_recipe",
      payload: {
        goal_shape: goalShape("audit runtime design"),
        topology_signature: "",
        confidence: 0.95,
        trajectory: [
          { step_kind: "action_predicted", artifact_id: "art_x", verifier_artifact_id: "art_v", payload_template: {} },
        ],
      },
    });
    for (const residual of [0.05, 0.08, 0.1]) {
      emitEvent(db, {
        kind: "action_scored",
        substrate_origin: "recipe",
        directive_id: "d_prior",
        task_id: newId(),
        residual,
        payload: { recipe_replayed: true, recipe_id: recipe.id, residual },
      });
    }
    emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate_auto",
      directive_id: "d_prior",
      task_id: newId(),
      residual: 0.03,
      payload: {
        dispatch_axes: {
          one_shot_confidence: 1,
          information_gap: 0,
          decomposition_value: 0,
          cost_pressure: 1,
          time_sensitivity: 1,
          reversibility: 1,
          owner_control_need: 0,
        },
      },
    });
    const decision = decideDispatch(db, sampleTask({ goal: "audit runtime design" }));
    expect(decision.route).toBe("substrate_replay");
    if (decision.route === "substrate_replay") {
      expect(decision.recipe_id).toBe(recipe.id);
      expect(decision.reason).toBe("recipe_match_hard_override_verified");
    }
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
    expect(decision.route).toBe("opencode_brain");
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
      kind: "recipe_extracted",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      task_id: directiveId,
      payload: {
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
  test("uses originPromotionByGoalShape before choosing between feasible brain and inline lanes", () => {
    const db = openDb(":memory:");
    runViews(db);
    const directiveText = "fix doc typo posterior routed";
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
    for (let i = 0; i < 4; i++) {
      emitEvent(db, {
        kind: "knowledge_candidate",
        substrate_origin: "opencode",
        directive_id: "d_shape",
        task_id: "opencode_candidate_" + i,
        payload: { claim: "brain candidate " + i },
      });
      emitEvent(db, {
        kind: "knowledge_promoted",
        substrate_origin: "opencode",
        directive_id: "d_shape",
        task_id: "opencode_promoted_" + i,
        payload: { candidate_id: "brain_candidate_" + i },
      });
      emitEvent(db, {
        kind: "knowledge_candidate",
        substrate_origin: "claude_inline",
        directive_id: "d_shape",
        task_id: "claude_candidate_" + i,
        payload: { claim: "inline candidate " + i },
      });
    }

    const decision = decideDispatch(db, sampleTask({
      directive_id: "d_shape",
      goal: directiveText,
      target_resources: ["repo:docs/README.md"],
    } as Partial<TaskNode>));

    expect(decision.route).toBe("opencode_brain");
    expect(decision.route_scores.opencode_brain).toBeGreaterThan(decision.route_scores.claude_inline);
    expect(decision.verifier_evidence.origin_promotion_adjustment_applied).toBe(1);
    expect(decision.verifier_evidence.origin_promotion_opencode_brain_posterior).toBe(1);
    expect(decision.verifier_evidence.origin_promotion_claude_inline_posterior).toBe(0);
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
      residual: 0.2,
      payload: {
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
    expect(decision.verifier_evidence.feasible_route_count).toBe(2);
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
