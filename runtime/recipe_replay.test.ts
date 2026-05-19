// acc2 recipe replay tests — Phase J (v2-design.md §15).

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { closeDb, openDb } from "../substrate/db";
import type { JsonValue } from "../substrate/types";
import { runViews } from "../substrate/views";
import { emitEvent } from "./events";
import { newId } from "./ids";
import { insertArtifact } from "./artifact_store";
import {
  findRecipeMatch,
  replayRecipe,
  updateRecipeConfidence,
  RECIPE_DEFAULT_MIN_CONFIDENCE,
  type RecipeArtifactRunner,
} from "./recipe_replay";
import { openFixtureDCountTodos } from "./fixtures/d_count_todos";
import { readDagForDirective, type TaskNode } from "./task_topology";

afterAll(() => closeDb());
beforeEach(() => closeDb());

// Build the replay fixture directly instead of driving three full dispatcher
// cycles. Extractor coverage lives in substrate/extractors.test.ts; these tests
// only need a matching recipe row plus runnable action/verifier artifacts.
const TEST_BUN_SANDBOX = { runtime: "bun" as const, fs_read: ["**/*"], fs_write: [], net_allow: [], proc_allow: [], cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 };

const insertRecipeReplayTestArtifact = (db: ReturnType<typeof openDb>, body: string, name: string) => insertArtifact(db, {
  runtime: "bun",
  body,
  declaredSandbox: TEST_BUN_SANDBOX,
  stateRoot: null,
  posteriorAlpha: 1,
  posteriorBeta: 1,
  score: 0.5,
  confidence: 0.3,
  recentResidualMean: 0,
  recentKillCount: 0,
  status: "admitted",
  name,
  fixtureInput: null,
  fixtureExpectedResidual: 0,
  intent: null,
  summary: null,
  targetFiles: null,
  sourceCandidateId: null,
  ownerGateVerdict: null,
});

const recordFromJson = (value: JsonValue): Record<string, JsonValue> => (
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {}
);

const countTodos = (dir: string): number => {
  let count = 0;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) count += countTodos(full);
    else if (st.isFile() && readFileSync(full, "utf8").includes("TODO")) count++;
  }
  return count;
};

const runRecipeReplayTestArtifact: RecipeArtifactRunner = async (
  db: Database,
  artifactId: string,
  inputs: JsonValue,
) => {
  const row = db.query("SELECT name FROM act_artifact WHERE id = ?").get(artifactId) as { name: string | null } | null;
  if (!row) return { ok: false, result: null, error: "artifact_not_found" };
  const name = row.name ?? "";
  const inputRecord = recordFromJson(inputs);

  if (name.includes("bad_verifier") || name.includes("failing_verifier")) {
    return { ok: true, result: { residual: 1 } };
  }
  if (name === "recipe_replay_test_verifier") {
    const result = recordFromJson(inputRecord.result ?? null);
    return { ok: true, result: { residual: Number.isInteger(result.count) ? 0 : 1 } };
  }
  if (name.includes("verifier")) {
    return { ok: true, result: { residual: 0 } };
  }
  if (name === "recipe_replay_test_action") {
    const targetPath = typeof inputRecord.target_path === "string" ? inputRecord.target_path : ".";
    return { ok: true, result: { result: { count: countTodos(targetPath) } } };
  }
  if (name.includes("step_one_action")) {
    return { ok: true, result: { phase: "step_one_done", echo: inputs } };
  }
  if (name.includes("step_two_action")) {
    return { ok: true, result: { phase: "step_two_done", upstream: inputs } };
  }
  if (name.includes("partial_step")) {
    return { ok: true, result: { phase: "done" } };
  }
  return { ok: true, result: {} };
};

const replayTestOpts = { runArtifact: runRecipeReplayTestArtifact };

const seedThreeSuccessRecipe = async (
  tempDir: string,
  opts: { bumpConfidence?: boolean } = {},
): Promise<{
  db: ReturnType<typeof openDb>;
  recipeId: string;
  goalShape: string;
}> => {
  const db = openDb(":memory:");
  runViews(db);
  const action = insertArtifact(db, {
    runtime: "bun",
    body: [
      "import { readdirSync, readFileSync, statSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "const inputs = JSON.parse(process.env.ACC2_INPUTS ?? 'null') ?? {};",
      "let count = 0;",
      "const walk = (dir) => { for (const name of readdirSync(dir)) { const full = join(dir, name); const st = statSync(full); if (st.isDirectory()) walk(full); else if (st.isFile() && readFileSync(full, 'utf8').includes('TODO')) count++; } };",
      "walk(inputs.target_path ?? './');",
      "console.log('@@RESULT@@ ' + JSON.stringify({ result: { count } }));",
    ].join("\n"),
    declaredSandbox: TEST_BUN_SANDBOX,
    stateRoot: null,
    posteriorAlpha: 1,
    posteriorBeta: 1,
    score: 0.5,
    confidence: 0.3,
    recentResidualMean: 0,
    recentKillCount: 0,
    status: "admitted",
    name: "recipe_replay_test_action",
    fixtureInput: null,
    fixtureExpectedResidual: 0,
    intent: null,
    summary: null,
    targetFiles: null,
    sourceCandidateId: null,
    ownerGateVerdict: null,
  });
  const verifier = insertArtifact(db, {
    runtime: "bun",
    body: "const observation = JSON.parse(process.env.ACC2_INPUTS ?? 'null') ?? {}; const ok = Number.isInteger(observation?.result?.count); console.log('@@RESULT@@ ' + JSON.stringify({ residual: ok ? 0 : 1 }));",
    declaredSandbox: TEST_BUN_SANDBOX,
    stateRoot: null,
    posteriorAlpha: 1,
    posteriorBeta: 1,
    score: 0.5,
    confidence: 0.3,
    recentResidualMean: 0,
    recentKillCount: 0,
    status: "admitted",
    name: "recipe_replay_test_verifier",
    fixtureInput: null,
    fixtureExpectedResidual: 0,
    intent: null,
    summary: null,
    targetFiles: null,
    sourceCandidateId: null,
    ownerGateVerdict: null,
  });
  const confidence = opts.bumpConfidence === false ? 0.5 : 0.9;
  const recipeId = emitEvent(db, {
    kind: "recipe_extracted",
    substrate_origin: "substrate_auto",
    directive_id: "d_recipe_seed",
    task_id: "t_recipe_seed",
    payload: {
      goal_shape: "count_files_target_directory::n1",
      topology_signature: "",
      confidence,
      trajectory: [{ step_kind: "action_predicted", artifact_id: action.id, verifier_artifact_id: verifier.id, payload_template: { target_path: tempDir }, predicted_residual: 0 }],
    },
  }).id;
  return { db, recipeId, goalShape: "count_files_target_directory::n1" };
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
  });

  test("returns null when no recipe row crosses the threshold", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "acc2-recipe-thresh-"));
    writeFileSync(join(tempDir, "a.txt"), "// TODO\n");
    try {
      // bumpConfidence=false so the recipe stays at the 0.5 prior. Hammer
      // with failures — under the view-integrated matcher (Improvement 1,
      // brain audit QQEHAW97GS0AX7TEQ717Y3P174 2026-05-15) the view picks
      // the HIGHEST-confidence row per key, so failure-emitted lower-
      // confidence rows do NOT supplant the high-water row. Asking for
      // minConfidence ABOVE every observed row is the canonical way to
      // assert "nothing crossed the threshold". The fixture's inline
      // post-commit bumps top out at ≤ 0.6 with bumpConfidence=false,
      // so a minConfidence of 0.85 yields no match.
      const { db, recipeId } = await seedThreeSuccessRecipe(tempDir, { bumpConfidence: false });
      for (let i = 0; i < 5; i++) {
        updateRecipeConfidence(db, recipeId, false);
      }
      const { directiveId } = await openFixtureDCountTodos(db, tempDir);
      const { nodes } = readDagForDirective(db, directiveId);
      const match = findRecipeMatch(db, nodes[0]!, { minConfidence: 0.85 });
      expect(match).toBeNull();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
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

      const outcome = await replayRecipe(db, task, match!, replayTestOpts);
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
  });

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
      // {residual: 1}, insert it, and rewrite the recipe payload.
      const badVerifierBody = [
        "const result = { residual: 1 };",
        "console.log('@@RESULT@@ ' + JSON.stringify(result));",
      ].join("\n");

      const badVerifier = insertRecipeReplayTestArtifact(
        db,
        badVerifierBody,
        "recipe_replay_test_bad_verifier",
      );
      const badVerifierId = badVerifier.id;

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

      const outcome = await replayRecipe(db, task, match!, replayTestOpts);
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
  });
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
    const action1 = insertRecipeReplayTestArtifact(
      db,
      action1Body,
      "recipe_replay_test_step_one_action",
    );
    const action1Id = action1.id;

    // Action 2 — its result also goes through a verifier.
    const action2Body = [
      "const inputs = JSON.parse(process.env.ACC2_INPUTS ?? 'null');",
      "console.log('@@RESULT@@ ' + JSON.stringify({ phase: 'step_two_done', upstream: inputs }));",
    ].join("\n");
    const action2 = insertRecipeReplayTestArtifact(
      db,
      action2Body,
      "recipe_replay_test_step_two_action",
    );
    const action2Id = action2.id;

    // Shared verifier — always passes (residual = 0).
    const verifierBody = [
      "console.log('@@RESULT@@ ' + JSON.stringify({ residual: 0 }));",
    ].join("\n");
    const verifier = insertRecipeReplayTestArtifact(
      db,
      verifierBody,
      "recipe_replay_test_passing_verifier",
    );
    const verifierId = verifier.id;

    // Hand-roll a recipe_extracted row whose trajectory has TWO action steps.
    const recipeRow = emitEvent(db, {
      kind: "recipe_extracted",
      substrate_origin: "substrate_auto",
      directive_id: "d_two_step",
      task_id: "t_two_step",
      payload: {
        // Hardened matcher requires ≥3 underscore-separated tokens of length ≥3
        // with ≥0.9 overlap, so the recipe's goal_shape uses the production
        // shape `<token>_<token>_<token>::nN`. Topology "" is the legacy seed
        // escape kept for hand-rolled tests; production recipes carry an exact
        // hash that must match strictly.
        goal_shape: "two_step_pipeline::n1",
        topology_signature: "",
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
      goal: "two step pipeline task",
      status: "pending",
    } as unknown as TaskNode;

    const match = findRecipeMatch(db, task);
    expect(match).not.toBeNull();
    expect(match!.trajectory.length).toBe(2);

    const outcome = await replayRecipe(db, task, match!, replayTestOpts);
    expect(outcome.task_committed).toBe(true);
    expect(outcome.residuals.length).toBe(2);
    expect(outcome.residuals.every((r) => r === 0)).toBe(true);

    // Both action artifacts MUST have been invoked via replay. Count
    // action_predicted rows from substrate_origin='recipe' for THIS task.
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
  });

  test("a 2-step recipe aborts at the failing step and surfaces the worst residual", async () => {
    const db = openDb(":memory:");
    runViews(db);

    // Action 1 succeeds; action 2 also "runs" but its verifier always fails.
    const actionBody = [
      "console.log('@@RESULT@@ ' + JSON.stringify({ phase: 'done' }));",
    ].join("\n");
    const action1 = insertRecipeReplayTestArtifact(
      db,
      actionBody,
      "recipe_replay_test_partial_step_one_action",
    );
    const action2 = insertRecipeReplayTestArtifact(
      db,
      actionBody,
      "recipe_replay_test_partial_step_two_action",
    );

    const goodVerifierBody = "console.log('@@RESULT@@ ' + JSON.stringify({ residual: 0 }));";
    const badVerifierBody = "console.log('@@RESULT@@ ' + JSON.stringify({ residual: 1 }));";
    const goodVerifier = insertRecipeReplayTestArtifact(
      db,
      goodVerifierBody,
      "recipe_replay_test_partial_passing_verifier",
    );
    const badVerifier = insertRecipeReplayTestArtifact(
      db,
      badVerifierBody,
      "recipe_replay_test_partial_failing_verifier",
    );
    const action1Id = action1.id;
    const action2Id = action2.id;
    const goodVerifierId = goodVerifier.id;
    const badVerifierId = badVerifier.id;

    emitEvent(db, {
      kind: "recipe_extracted",
      substrate_origin: "substrate_auto",
      directive_id: "d_partial",
      task_id: "t_partial",
      payload: {
        goal_shape: "two_step_partial::n1",
        topology_signature: "",
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
      goal: "two step partial task",
      status: "pending",
    } as unknown as TaskNode;

    const match = findRecipeMatch(db, task);
    expect(match).not.toBeNull();
    const outcome = await replayRecipe(db, task, match!, replayTestOpts);
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
  });
});

// View-integration regression — Improvement 1 from brain audit
// QQEHAW97GS0AX7TEQ717Y3P174 (2026-05-15). The matcher is wired through
// recipes_latest_view; this test asserts that path is actually exercised
// (the matcher finds the recipe via the view, picking the highest-
// confidence row per (goal_shape, topology_signature) pair).
describe("recipe_replay.findRecipeMatch — recipes_latest_view integration", () => {
  test("matcher picks the HIGHEST-confidence row per key (view ordering)", () => {
    const db = openDb(":memory:");
    runViews(db);

    // Two recipe_extracted rows for the SAME key — the view should
    // surface the higher-confidence one to the matcher.
    const lowerId = newId();
    db.run(
      `INSERT INTO events (id, ts, directive_id, task_id, loop_id, substrate_origin, kind, payload, context_refs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        lowerId,
        "2026-01-01T00:00:01.000Z",
        "d_view_int",
        "t_view_int",
        "loop_root",
        "substrate_auto",
        "recipe_extracted",
        JSON.stringify({
          goal_shape: "view_integrated_recipe_one::n1",
          topology_signature: "",
          confidence: 0.5,
          trajectory: [
            { step_kind: "action_predicted", artifact_id: "a_dummy", payload_template: {} },
          ],
        }),
        "[]",
      ],
    );
    const higherId = newId();
    db.run(
      `INSERT INTO events (id, ts, directive_id, task_id, loop_id, substrate_origin, kind, payload, context_refs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        higherId,
        "2026-01-01T00:00:02.000Z",
        "d_view_int",
        "t_view_int",
        "loop_root",
        "substrate_auto",
        "recipe_extracted",
        JSON.stringify({
          goal_shape: "view_integrated_recipe_one::n1",
          topology_signature: "",
          confidence: 0.92,
          trajectory: [
            { step_kind: "action_predicted", artifact_id: "a_dummy", payload_template: {} },
          ],
        }),
        "[]",
      ],
    );

    const task: TaskNode = {
      id: "t_match_view",
      directive_id: "d_match_view",
      parent_id: null,
      goal: "view integrated recipe one",
      status: "pending",
    } as unknown as TaskNode;

    const match = findRecipeMatch(db, task);
    expect(match).not.toBeNull();
    // The view returns the higher-confidence row; the matcher cites its
    // id, not the older lower-confidence one.
    expect(match!.recipe_id).toBe(higherId);
    expect(match!.confidence).toBeCloseTo(0.92, 5);
  });

  test("surfaces recipes_latest_view failures instead of scanning recipe history", () => {
    const db = openDb(":memory:");
    runViews(db);
    db.run(
      `INSERT INTO events (id, ts, directive_id, task_id, loop_id, substrate_origin, kind, payload, context_refs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId(),
        "2026-01-01T00:00:03.000Z",
        "d_view_fail",
        "t_view_fail",
        "loop_root",
        "substrate_auto",
        "recipe_extracted",
        JSON.stringify({
          goal_shape: "view_failure_recipe::n1",
          topology_signature: "",
          confidence: 0.95,
          trajectory: [
            { step_kind: "action_predicted", artifact_id: "a_dummy", payload_template: {} },
          ],
        }),
        "[]",
      ],
    );
    db.run("DROP VIEW recipes_latest_view");

    const task: TaskNode = {
      id: "t_match_view_fail",
      directive_id: "d_match_view_fail",
      parent_id: null,
      goal: "view failure recipe",
      status: "pending",
    } as unknown as TaskNode;

    expect(() => findRecipeMatch(db, task)).toThrow(/recipes_latest_view/);
    const caught = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'error_caught'")
      .get() as { c: number };
    expect(caught.c).toBe(0);
  });
});

describe("recipe_replay.updateRecipeConfidence", () => {
  test("successful outcome bumps confidence by +0.05", () => {
    const db = openDb(":memory:");
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
