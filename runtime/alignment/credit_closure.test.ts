// Phase Align — Principle 6: credit chain closure.
//
// Architecture.md Rule 3 + §17 Phase H: every `action_scored` event
// MUST produce at least one credit-distribution side-effect — concretely a
// `act_artifact_score_updated` event linked to the same scoring row. The
// four-link chain is `create → retrieve → mutate retrieval state → credit
// outcome` (k_555); the substrate enforces it structurally.
//
// Two code paths emit action_scored:
//   1. `task_dispatcher.dispatchReadyTask` — already wired through
//      `distributeCredit` (try/catch with applyResidualOutcome fallback).
//   2. `recipe_replay.replayRecipe` — Phase Align adds the parallel
//      distributeCredit call so replay outcomes credit cited entities the
//      same way fresh brain dispatches do.
//
// This test exercises path 2 (the one this pass tightened): admit a recipe,
// replay it, count `action_scored` rows and assert at least one
// `act_artifact_score_updated` cites the scored event for every score row.

import { afterAll, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../../substrate/db";
import { admitArtifact } from "../artifact_admission";
import { emitEvent } from "../events";
import { newId } from "../ids";
import { replayRecipe, type RecipeMatch } from "../recipe_replay";
import type { TaskNode } from "../task_topology";

afterAll(() => closeDb());

describe("alignment / credit_closure (Principle 6)", () => {
  test("recipe replay's action_scored produces act_artifact_score_updated rows", async () => {
    closeDb();
    const db = openDb(":memory:");

    const directiveId = newId();
    const taskId = newId();
    const sandbox = {
      runtime: "bun" as const,
      fs_read: ["**/*"],
      fs_write: [],
      net_allow: [],
      proc_allow: [],
      substrate_access: "none" as const,
      cpu_ms: 5000,
      wall_ms: 5000,
      memory_mb: 128,
    };

    // Admit deterministic action + verifier artifacts. The action returns
    // {result:{value:1}}; the verifier always returns residual=0 so the
    // replay commits cleanly and the credit pipeline runs the success path.
    const action = await admitArtifact(
      db,
      {
        runtime: "bun",
        body: `process.stdout.write("@@RESULT@@ " + JSON.stringify({ result: { value: 1 } }) + "\\n");`,
        declaredSandbox: sandbox,
        fixtureInput: {},
        fixtureExpectedResidualBelow: 1.1,
        name: "credit_closure_action",
      },
      (ev) => emitEvent(db, { ...ev, directive_id: directiveId, task_id: taskId, invoker: "opencode" }),
    );
    const verifier = await admitArtifact(
      db,
      {
        runtime: "bun",
        body: `process.stdout.write("@@RESULT@@ " + JSON.stringify({ residual: 0 }) + "\\n");`,
        declaredSandbox: sandbox,
        fixtureInput: {},
        fixtureExpectedResidualBelow: 1.1,
        name: "credit_closure_verifier",
      },
      (ev) => emitEvent(db, { ...ev, directive_id: directiveId, task_id: taskId, invoker: "opencode" }),
    );
    expect(action.ok).toBe(true);
    expect(verifier.ok).toBe(true);
    if (!action.ok || !verifier.ok) return;

    // Open the directive + task so credit emission has parent context.
    emitEvent(db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: taskId,
      payload: { directive_text: "credit-closure replay fixture" },
    });
    emitEvent(db, {
      kind: "task_node_opened",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      task_id: taskId,
      payload: { goal: "credit-closure replay fixture", lifecycle: "finite", urgency: "normal" },
    });

    // Hand-craft a RecipeMatch with one action_predicted step.
    const recipeId = newId();
    const match: RecipeMatch = {
      recipe_id: recipeId,
      recipe_knowledge_event_id: recipeId,
      knowledge_id: recipeId,
      goal_shape: "credit_closure_replay_fixture::n1",
      topology_signature: "topo_00000000::1",
      confidence: 0.9,
      trajectory: [
        {
          step_kind: "action_predicted",
          artifact_id: action.artifactId,
          verifier_artifact_id: verifier.artifactId,
          payload_template: {},
          predicted_residual: 0.05,
        },
      ],
      cited_act_artifact_ids: [action.artifactId, verifier.artifactId],
    };

    const task: TaskNode = {
      id: taskId,
      directive_id: directiveId,
      parent_id: null,
      goal: "credit-closure replay fixture",
      status: "ready",
    };

    const out = await replayRecipe(db, task, match);
    expect(out.task_committed).toBe(true);

    // For every action_scored row on this task, there must be at least one
    // act_artifact_score_updated row referencing the scored event id (the
    // distributeCredit pipeline writes scored_event_id into payload).
    const scoredRows = db
      .query(
        `SELECT id FROM events WHERE kind = 'action_scored' AND task_id = ?`,
      )
      .all(taskId) as Array<{ id: string }>;
    expect(scoredRows.length).toBeGreaterThanOrEqual(1);

    for (const s of scoredRows) {
      const credited = db
        .query(
          `SELECT COUNT(*) AS c FROM events
           WHERE kind = 'act_artifact_score_updated'
             AND payload LIKE '%' || ? || '%'`,
        )
        .get(s.id) as { c: number };
      expect(credited.c).toBeGreaterThanOrEqual(1);
    }
  });
});
