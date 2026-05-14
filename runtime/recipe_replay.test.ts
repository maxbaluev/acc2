// acc2 recipe replay tests — Phase J (v2-design.md §15).

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../substrate/db";
import { runViews } from "../substrate/views";
import { emitEvent } from "./events";
import { newId } from "./ids";
import { extractRecipeCandidates } from "../substrate/extractors";
import {
  findRecipeMatch,
  replayRecipe,
  updateRecipeConfidence,
  RECIPE_DEFAULT_MIN_CONFIDENCE,
} from "./recipe_replay";
import { openFixtureDCountTodos } from "./fixtures/d_count_todos";
import { dispatchReadyTask } from "./task_dispatcher";
import { readyTasks, readDagForDirective, type TaskNode } from "./task_topology";
import { admitArtifact } from "./artifact_admission";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Build a synthetic three-success recipe by driving the fixture through the
// dispatcher three times then running the extractor. Returns the recipe id +
// the directive that the fixture last opened. By default the seed bumps
// confidence twice so freshly-extracted recipes (prior 0.5) reach the
// default match threshold (0.6).
const seedThreeSuccessRecipe = async (
  tempDir: string,
  opts: { bumpConfidence?: boolean } = {},
): Promise<{
  db: ReturnType<typeof openDb>;
  recipeId: string;
  goalShape: string;
}> => {
  const bump = opts.bumpConfidence ?? true;
  const db = openDb(":memory:");
  runViews(db);
  for (let i = 0; i < 3; i++) {
    const { directiveId, taskId } = await openFixtureDCountTodos(db, tempDir);
    const ready = readyTasks(db, directiveId);
    expect(ready.length).toBeGreaterThan(0);
    expect(ready[0]!.id).toBe(taskId);
    await dispatchReadyTask(db, ready[0]!, { fixtureTargetPath: tempDir });
    // Stagger timestamps so the recipe extractor sees three distinct
    // committed shapes with the same goal_shape.
    await sleepMs(5);
  }
  const summary = extractRecipeCandidates(db);
  expect(summary.extracted).toBeGreaterThanOrEqual(1);
  const row = db
    .query(
      "SELECT id, payload FROM events WHERE kind = 'recipe_extracted' ORDER BY ts DESC LIMIT 1",
    )
    .get() as { id: string; payload: string };
  const p = JSON.parse(row.payload) as { goal_shape: string };
  if (bump) {
    updateRecipeConfidence(db, row.id, true);
    updateRecipeConfidence(db, row.id, true);
  }
  return { db, recipeId: row.id, goalShape: p.goal_shape };
};

describe("recipe_replay.findRecipeMatch", () => {
  test("returns null when no recipes have been extracted", () => {
    const db = openDb(":memory:");
    runViews(db);
    const task = {
      id: "t_sample",
      directive_id: "d_sample",
      parent_id: null,
      goal: "count todos in repo",
      status: "pending" as const,
    };
    const match = findRecipeMatch(db, task);
    expect(match).toBeNull();
  });

  test("returns the recipe when goal_shape matches and confidence >= threshold", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "acc2-recipe-find-"));
    writeFileSync(join(tempDir, "a.txt"), "// TODO\n");
    try {
      const { db, goalShape } = await seedThreeSuccessRecipe(tempDir);
      // Open a fresh fixture and try to match
      const { directiveId } = await openFixtureDCountTodos(db, tempDir);
      const { nodes } = readDagForDirective(db, directiveId);
      const task = nodes[0]!;
      const match = findRecipeMatch(db, task);
      expect(match).not.toBeNull();
      expect(match!.goal_shape).toBe(goalShape);
      expect(match!.confidence).toBeGreaterThanOrEqual(RECIPE_DEFAULT_MIN_CONFIDENCE - 0.01);
      expect(match!.trajectory.length).toBeGreaterThan(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 60_000);

  test("returns null when confidence falls below threshold", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "acc2-recipe-thresh-"));
    writeFileSync(join(tempDir, "a.txt"), "// TODO\n");
    try {
      // bumpConfidence=false so the recipe stays at the 0.5 prior; one failure
      // pushes to 0.4 which is below the 0.6 threshold.
      const { db, recipeId } = await seedThreeSuccessRecipe(tempDir, { bumpConfidence: false });
      // Hammer with failures so the confidence goes below 0.6
      for (let i = 0; i < 5; i++) {
        updateRecipeConfidence(db, recipeId, false);
      }
      const { directiveId } = await openFixtureDCountTodos(db, tempDir);
      const { nodes } = readDagForDirective(db, directiveId);
      const match = findRecipeMatch(db, nodes[0]!, { minConfidence: 0.6 });
      expect(match).toBeNull();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("recipe_replay.replayRecipe", () => {
  test("replays a matched recipe end-to-end without calling the brain", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "acc2-recipe-play-"));
    writeFileSync(join(tempDir, "a.txt"), "// TODO\n");
    writeFileSync(join(tempDir, "b.txt"), "// TODO again\n");
    try {
      const { db } = await seedThreeSuccessRecipe(tempDir);

      const bridgeBefore = (db
        .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'bridge_invoked'")
        .get() as { c: number }).c;

      const { directiveId, taskId } = await openFixtureDCountTodos(db, tempDir);
      const { nodes } = readDagForDirective(db, directiveId);
      const task = nodes.find((n) => n.id === taskId)!;
      const match = findRecipeMatch(db, task);
      expect(match).not.toBeNull();

      const outcome = await replayRecipe(db, task, match!);
      expect(outcome.task_committed).toBe(true);
      expect(outcome.abort_reason).toBeUndefined();

      // No new bridge_invoked — recipe replay never calls the brain.
      const bridgeAfter = (db
        .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'bridge_invoked'")
        .get() as { c: number }).c;
      expect(bridgeAfter).toBe(bridgeBefore);

      // task_committed emitted on this task
      const committed = db
        .query("SELECT residual FROM events WHERE kind = 'task_committed' AND task_id = ?")
        .get(taskId) as { residual: number } | null;
      expect(committed).not.toBeNull();
      expect(committed!.residual).toBeLessThan(0.3);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 60_000);

  test("aborts cleanly when a recipe's trajectory has no action_predicted step", async () => {
    const db = openDb(":memory:");
    runViews(db);
    // Synthetically insert a recipe with no trajectory.
    emitEvent(db, {
      kind: "recipe_extracted",
      substrate_origin: "substrate_auto",
      directive_id: "d_x",
      task_id: "t_x",
      payload: {
        goal_shape: "missing trajectory recipe",
        topology_signature: "topo_00000000::1",
        confidence: 0.9,
        trajectory: [],
      },
    });
    const recipeId = (db
      .query("SELECT id FROM events WHERE kind = 'recipe_extracted' LIMIT 1")
      .get() as { id: string }).id;
    const task = {
      id: "t_x",
      directive_id: "d_x",
      parent_id: null,
      goal: "missing trajectory recipe",
      status: "pending" as const,
    };
    const match = {
      recipe_id: recipeId,
      recipe_extracted_event_id: recipeId,
      goal_shape: "missing trajectory recipe",
      topology_signature: "topo_00000000::1",
      confidence: 0.9,
      trajectory: [],
    };
    const outcome = await replayRecipe(db, task, match);
    expect(outcome.task_committed).toBe(false);
    expect(outcome.abort_reason).toBe("trajectory_missing_action_step");

    const aborted = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'recipe_replay_aborted'")
      .get() as { c: number };
    expect(aborted.c).toBe(1);
  });

  test("verifier residual ≥ threshold aborts replay", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "acc2-recipe-abort-"));
    writeFileSync(join(tempDir, "a.txt"), "// TODO\n");
    try {
      const { db, recipeId } = await seedThreeSuccessRecipe(tempDir);
      // Replace the recipe's verifier artifact with one that always returns
      // residual = 1. We need a verifier whose body unconditionally outputs
      // {residual: 1}, admit it, and rewrite the recipe payload.
      const badVerifierBody = [
        "const result = { residual: 1 };",
        "console.log('@@RESULT@@ ' + JSON.stringify(result));",
      ].join("\n");

      // Admit through the artifact pipeline. The admission fixture passes
      // because we explicitly set fixtureExpectedResidualBelow=1.1.
      const admission = await admitArtifact(
        db,
        {
          runtime: "bun",
          body: badVerifierBody,
          declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
          fixtureInput: {},
          fixtureExpectedResidualBelow: 1.1,
        },
        (ev) => { emitEvent(db, ev); },
      );
      expect(admission.ok).toBe(true);
      const badVerifierId = admission.ok ? admission.artifactId : "";

      // Rewrite EVERY recipe_extracted row's trajectory to point at the bad
      // verifier (the matcher will pick the freshest by ts, which is a
      // confidence-bump row — we have to mutate that one too).
      const allRecipeRows = db
        .query(
          "SELECT id, payload FROM events WHERE kind = 'recipe_extracted'",
        )
        .all() as Array<{ id: string; payload: string }>;
      for (const r of allRecipeRows) {
        const p = JSON.parse(r.payload) as Record<string, unknown>;
        const trajectory = ((p.trajectory as Array<Record<string, unknown>>) ?? []).map((s) => ({
          ...s,
          verifier_artifact_id:
            s.step_kind === "action_predicted" ? badVerifierId : s.verifier_artifact_id,
        }));
        const newPayload = { ...p, trajectory };
        db.run("UPDATE events SET payload = ? WHERE id = ?", [JSON.stringify(newPayload), r.id]);
      }

      const { directiveId, taskId } = await openFixtureDCountTodos(db, tempDir);
      const { nodes } = readDagForDirective(db, directiveId);
      const task = nodes.find((n) => n.id === taskId)!;

      const match = findRecipeMatch(db, task);
      expect(match).not.toBeNull();
      // Confirm the bad verifier id is the one we just stamped.
      const actionStep = match!.trajectory.find((s) => s.step_kind === "action_predicted")!;
      expect(actionStep.verifier_artifact_id).toBe(badVerifierId);

      const outcome = await replayRecipe(db, task, match!);
      expect(outcome.task_committed).toBe(false);
      expect(outcome.abort_reason).toBe("verifier_residual_above_threshold");
      expect(outcome.residuals[0]).toBe(1);

      const aborted = db
        .query(
          "SELECT failure_kind FROM events WHERE kind = 'recipe_replay_aborted' AND task_id = ?",
        )
        .get(taskId) as { failure_kind: string } | null;
      expect(aborted).not.toBeNull();
      expect(aborted!.failure_kind).toBe("verification_high_residual");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("recipe_replay.replayRecipe — multi-step (Batch 4 Hole 4)", () => {
  test("a 2-step recipe replays BOTH action_predicted steps in order before commit", async () => {
    const db = openDb(":memory:");
    runViews(db);

    // Action 1 — emits a result that step 2 can consume.
    const action1Body = [
      "const inputs = JSON.parse(process.env.ACC2_INPUTS ?? 'null');",
      "console.log('@@RESULT@@ ' + JSON.stringify({ phase: 'step_one_done', echo: inputs }));",
    ].join("\n");
    const action1 = await admitArtifact(
      db,
      {
        runtime: "bun",
        body: action1Body,
        declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
        fixtureInput: {},
        fixtureExpectedResidualBelow: 1.1,
      },
      (ev) => { emitEvent(db, ev); },
    );
    expect(action1.ok).toBe(true);
    const action1Id = action1.ok ? action1.artifactId : "";

    // Action 2 — its result also goes through a verifier.
    const action2Body = [
      "const inputs = JSON.parse(process.env.ACC2_INPUTS ?? 'null');",
      "console.log('@@RESULT@@ ' + JSON.stringify({ phase: 'step_two_done', upstream: inputs }));",
    ].join("\n");
    const action2 = await admitArtifact(
      db,
      {
        runtime: "bun",
        body: action2Body,
        declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
        fixtureInput: {},
        fixtureExpectedResidualBelow: 1.1,
      },
      (ev) => { emitEvent(db, ev); },
    );
    expect(action2.ok).toBe(true);
    const action2Id = action2.ok ? action2.artifactId : "";

    // Shared verifier — always passes (residual = 0).
    const verifierBody = [
      "console.log('@@RESULT@@ ' + JSON.stringify({ residual: 0 }));",
    ].join("\n");
    const verifier = await admitArtifact(
      db,
      {
        runtime: "bun",
        body: verifierBody,
        declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
        fixtureInput: {},
        fixtureExpectedResidualBelow: 1.1,
      },
      (ev) => { emitEvent(db, ev); },
    );
    expect(verifier.ok).toBe(true);
    const verifierId = verifier.ok ? verifier.artifactId : "";

    // Hand-roll a recipe_extracted row whose trajectory has TWO action steps.
    const recipeRow = emitEvent(db, {
      kind: "recipe_extracted",
      substrate_origin: "substrate_auto",
      directive_id: "d_two_step",
      task_id: "t_two_step",
      payload: {
        goal_shape: "two step pipeline",
        topology_signature: "topo_00000000::1",
        confidence: 0.9,
        trajectory: [
          {
            step_kind: "action_predicted",
            artifact_id: action1Id,
            verifier_artifact_id: verifierId,
            payload_template: {},
            predicted_residual: 0,
          },
          {
            step_kind: "action_predicted",
            artifact_id: action2Id,
            verifier_artifact_id: verifierId,
            payload_template: {},
            predicted_residual: 0,
          },
        ],
      },
    });

    const task: TaskNode = {
      id: "t_two_step",
      directive_id: "d_two_step",
      parent_id: null,
      goal: "two step pipeline",
      status: "pending",
    } as unknown as TaskNode;

    const match = findRecipeMatch(db, task);
    expect(match).not.toBeNull();
    expect(match!.trajectory.length).toBe(2);

    const outcome = await replayRecipe(db, task, match!);
    expect(outcome.task_committed).toBe(true);
    expect(outcome.residuals.length).toBe(2);
    expect(outcome.residuals.every((r) => r === 0)).toBe(true);

    // Both action artifacts MUST have been invoked — one artifact_invoked
    // event per step (artifact_admission already burns one fixture run,
    // so we count action_predicted rows from substrate_origin='recipe'
    // for THIS task).
    const recipePredicted = db
      .query(
        "SELECT action_artifact_id, payload FROM events WHERE kind = 'action_predicted' AND substrate_origin = 'recipe' AND task_id = ?",
      )
      .all(task.id) as Array<{ action_artifact_id: string; payload: string }>;
    expect(recipePredicted.length).toBe(2);
    expect(recipePredicted[0]!.action_artifact_id).toBe(action1Id);
    expect(recipePredicted[1]!.action_artifact_id).toBe(action2Id);

    const p0 = JSON.parse(recipePredicted[0]!.payload) as Record<string, number>;
    const p1 = JSON.parse(recipePredicted[1]!.payload) as Record<string, number>;
    expect(p0.recipe_step_index).toBe(0);
    expect(p1.recipe_step_index).toBe(1);
    expect(p0.recipe_step_count).toBe(2);
    expect(p1.recipe_step_count).toBe(2);

    // action_scored ALSO emitted per step.
    const scored = db
      .query(
        "SELECT COUNT(*) AS c FROM events WHERE kind = 'action_scored' AND substrate_origin = 'recipe' AND task_id = ?",
      )
      .get(task.id) as { c: number };
    expect(scored.c).toBe(2);

    // task_committed fires ONCE at the end, citing the LAST step's
    // action + verifier artifacts.
    const committed = db
      .query(
        "SELECT action_artifact_id, verifier_artifact_id, payload, residual FROM events WHERE kind = 'task_committed' AND task_id = ?",
      )
      .all(task.id) as Array<{
        action_artifact_id: string;
        verifier_artifact_id: string;
        payload: string;
        residual: number;
      }>;
    expect(committed.length).toBe(1);
    expect(committed[0]!.action_artifact_id).toBe(action2Id);
    expect(committed[0]!.verifier_artifact_id).toBe(verifierId);
    expect(committed[0]!.residual).toBe(0);
    const commitPayload = JSON.parse(committed[0]!.payload) as Record<string, unknown>;
    expect(commitPayload.step_count).toBe(2);
    expect(Array.isArray(commitPayload.residuals)).toBe(true);

    void recipeRow;
  }, 60_000);

  test("a 2-step recipe aborts at the failing step and surfaces the worst residual", async () => {
    const db = openDb(":memory:");
    runViews(db);

    // Action 1 succeeds; action 2 also "runs" but its verifier always fails.
    const actionBody = [
      "console.log('@@RESULT@@ ' + JSON.stringify({ phase: 'done' }));",
    ].join("\n");
    const action1 = await admitArtifact(
      db,
      {
        runtime: "bun",
        body: actionBody,
        declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
        fixtureInput: {},
        fixtureExpectedResidualBelow: 1.1,
      },
      (ev) => { emitEvent(db, ev); },
    );
    const action2 = await admitArtifact(
      db,
      {
        runtime: "bun",
        body: actionBody,
        declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
        fixtureInput: {},
        fixtureExpectedResidualBelow: 1.1,
      },
      (ev) => { emitEvent(db, ev); },
    );

    const goodVerifierBody = "console.log('@@RESULT@@ ' + JSON.stringify({ residual: 0 }));";
    const badVerifierBody = "console.log('@@RESULT@@ ' + JSON.stringify({ residual: 1 }));";
    const goodVerifier = await admitArtifact(
      db,
      {
        runtime: "bun",
        body: goodVerifierBody,
        declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
        fixtureInput: {},
        fixtureExpectedResidualBelow: 1.1,
      },
      (ev) => { emitEvent(db, ev); },
    );
    const badVerifier = await admitArtifact(
      db,
      {
        runtime: "bun",
        body: badVerifierBody,
        declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
        fixtureInput: {},
        fixtureExpectedResidualBelow: 1.1,
      },
      (ev) => { emitEvent(db, ev); },
    );
    const action1Id = action1.ok ? action1.artifactId : "";
    const action2Id = action2.ok ? action2.artifactId : "";
    const goodVerifierId = goodVerifier.ok ? goodVerifier.artifactId : "";
    const badVerifierId = badVerifier.ok ? badVerifier.artifactId : "";

    emitEvent(db, {
      kind: "recipe_extracted",
      substrate_origin: "substrate_auto",
      directive_id: "d_partial",
      task_id: "t_partial",
      payload: {
        goal_shape: "two step partial",
        topology_signature: "topo_00000000::1",
        confidence: 0.9,
        trajectory: [
          {
            step_kind: "action_predicted",
            artifact_id: action1Id,
            verifier_artifact_id: goodVerifierId,
            payload_template: {},
            predicted_residual: 0,
          },
          {
            step_kind: "action_predicted",
            artifact_id: action2Id,
            verifier_artifact_id: badVerifierId,
            payload_template: {},
            predicted_residual: 0,
          },
        ],
      },
    });

    const task: TaskNode = {
      id: "t_partial",
      directive_id: "d_partial",
      parent_id: null,
      goal: "two step partial",
      status: "pending",
    } as unknown as TaskNode;

    const match = findRecipeMatch(db, task);
    expect(match).not.toBeNull();
    const outcome = await replayRecipe(db, task, match!);
    expect(outcome.task_committed).toBe(false);
    expect(outcome.abort_reason).toBe("verifier_residual_above_threshold");
    // Step 0 ran and produced residual 0; step 1 ran and produced residual 1.
    expect(outcome.residuals).toEqual([0, 1]);

    // No task_committed should land for this task.
    const committedCount = (db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'task_committed' AND task_id = ?")
      .get(task.id) as { c: number }).c;
    expect(committedCount).toBe(0);

    // The abort payload carries the step index + worst residual seen.
    const aborted = db
      .query("SELECT payload FROM events WHERE kind = 'recipe_replay_aborted' AND task_id = ?")
      .get(task.id) as { payload: string } | null;
    expect(aborted).not.toBeNull();
    const ap = JSON.parse(aborted!.payload) as Record<string, number>;
    expect(ap.step_index).toBe(1);
    expect(ap.step_count).toBe(2);
    expect(ap.residual).toBe(1);
    expect(ap.worst_residual).toBe(1);
  }, 60_000);
});

describe("recipe_replay.updateRecipeConfidence", () => {
  test("successful outcome bumps confidence by +0.05", () => {
    const db = openDb(":memory:");
    runViews(db);
    const recipeId = newId();
    db.run(
      `INSERT INTO events (id, ts, directive_id, task_id, loop_id, substrate_origin, kind, payload, context_refs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        recipeId,
        new Date().toISOString(),
        "d_recipe",
        "t_recipe",
        "loop_root",
        "substrate_auto",
        "recipe_extracted",
        JSON.stringify({ goal_shape: "x", topology_signature: "y", confidence: 0.5, trajectory: [] }),
        "[]",
      ],
    );
    const result = updateRecipeConfidence(db, recipeId, true);
    expect(result.newConfidence).toBeCloseTo(0.55, 5);
  });

  test("failed outcome cuts confidence by -0.10", () => {
    const db = openDb(":memory:");
    runViews(db);
    const recipeId = newId();
    db.run(
      `INSERT INTO events (id, ts, directive_id, task_id, loop_id, substrate_origin, kind, payload, context_refs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        recipeId,
        new Date().toISOString(),
        "d_recipe",
        "t_recipe",
        "loop_root",
        "substrate_auto",
        "recipe_extracted",
        JSON.stringify({ goal_shape: "x", topology_signature: "y", confidence: 0.5, trajectory: [] }),
        "[]",
      ],
    );
    const result = updateRecipeConfidence(db, recipeId, false);
    expect(result.newConfidence).toBeCloseTo(0.40, 5);
  });

  test("confidence is bounded [0, 0.95]", () => {
    const db = openDb(":memory:");
    runViews(db);
    const recipeId = newId();
    db.run(
      `INSERT INTO events (id, ts, directive_id, task_id, loop_id, substrate_origin, kind, payload, context_refs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        recipeId,
        new Date().toISOString(),
        "d_recipe",
        "t_recipe",
        "loop_root",
        "substrate_auto",
        "recipe_extracted",
        JSON.stringify({ goal_shape: "x", topology_signature: "y", confidence: 0.92, trajectory: [] }),
        "[]",
      ],
    );
    const result = updateRecipeConfidence(db, recipeId, true);
    expect(result.newConfidence).toBeLessThanOrEqual(0.95);
    // Now hammer with failures
    for (let i = 0; i < 20; i++) updateRecipeConfidence(db, recipeId, false);
    // Re-read freshest confidence
    const latest = db
      .query(
        "SELECT payload FROM events WHERE kind = 'recipe_extracted' ORDER BY ts DESC LIMIT 1",
      )
      .get() as { payload: string };
    const p = JSON.parse(latest.payload);
    expect(p.confidence).toBeGreaterThanOrEqual(0);
  });
});
