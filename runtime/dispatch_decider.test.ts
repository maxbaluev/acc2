import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { runViews } from "../substrate/views";
import { classifyHardTask, decideDispatch } from "./dispatch_decider";
import type { TaskNode } from "./task_topology";
import { emitEvent } from "./events";
import { newId } from "./ids";

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
        goal_shape: "audit_runtime_design::n1",
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
        goal_shape: "audit_runtime_design::n1",
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
});
