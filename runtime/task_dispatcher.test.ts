import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../substrate/db";
import { dispatchReadyTask } from "./task_dispatcher";
import { opencodeQueryAdversarialCycle2, opencodeQueryHighResidual } from "./bridge/index";
import { readyTasks } from "./task_topology";
import { openFixtureDCountTodos } from "./fixtures/d_count_todos";
import { emitEvent } from "./events";
import { newId } from "./ids";

afterAll(() => closeDb());
beforeEach(() => closeDb());

describe("task_dispatcher", () => {
  test("happy path: action_predicted → action → verifier → action_scored → task_committed", async () => {
    const db = openDb(":memory:");
    const tempDir = mkdtempSync(join(tmpdir(), "acc2-disp-"));
    writeFileSync(join(tempDir, "a.txt"), "no marker here", "utf-8");
    writeFileSync(join(tempDir, "b.txt"), "// TODO fix me", "utf-8");
    writeFileSync(join(tempDir, "c.txt"), "another TODO line", "utf-8");

    try {
      const { directiveId, taskId } = await openFixtureDCountTodos(db, tempDir);
      const ready = readyTasks(db, directiveId);
      expect(ready.length).toBeGreaterThan(0);
      const task = ready[0]!;
      expect(task.id).toBe(taskId);

      const result = await dispatchReadyTask(db, task, { fixtureTargetPath: tempDir });
      expect(result.violations).toEqual([]);
      expect(result.bridge_result?.ok).toBe(true);

      const actionPredicted = db
        .query("SELECT COUNT(*) as c FROM events WHERE kind = 'action_predicted' AND task_id = ?")
        .get(taskId) as { c: number };
      expect(actionPredicted.c).toBe(1);

      const actionScored = db
        .query("SELECT residual FROM events WHERE kind = 'action_scored' AND task_id = ?")
        .get(taskId) as { residual: number } | null;
      expect(actionScored).not.toBeNull();
      expect(actionScored!.residual).toBe(0);

      const taskCommitted = db
        .query("SELECT residual FROM events WHERE kind = 'task_committed' AND task_id = ?")
        .get(taskId) as { residual: number } | null;
      expect(taskCommitted).not.toBeNull();
      expect(taskCommitted!.residual).toBe(0);

      const closed = db
        .query("SELECT COUNT(*) as c FROM events WHERE kind = 'brain_dispatch_closed' AND task_id = ?")
        .get(taskId) as { c: number };
      expect(closed.c).toBe(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 60_000);

  test("cycle-1 enforcement: adversarial brain_cycle_2_started → dispatcher_violation + dispatch closes", async () => {
    const db = openDb(":memory:");
    const { directiveId, taskId } = await openFixtureDCountTodos(db, "/tmp");
    const ready = readyTasks(db, directiveId);
    const task = ready[0]!;

    const result = await dispatchReadyTask(db, task, {
      bridge: opencodeQueryAdversarialCycle2,
    });
    expect(result.violations).toContain("cycle_1_only_breach");

    const violation = db
      .query(
        "SELECT failure_kind FROM events WHERE kind = 'dispatcher_violation' AND task_id = ?",
      )
      .get(taskId) as { failure_kind: string } | null;
    expect(violation).not.toBeNull();
    expect(violation!.failure_kind).toBe("cycle_1_only_breach");

    const closed = db
      .query("SELECT COUNT(*) as c FROM events WHERE kind = 'brain_dispatch_closed' AND task_id = ?")
      .get(taskId) as { c: number };
    expect(closed.c).toBe(1);

    // The action artifact MUST NOT have run — no action_predicted, no action_scored.
    const scored = db
      .query("SELECT COUNT(*) as c FROM events WHERE kind = 'action_scored' AND task_id = ?")
      .get(taskId) as { c: number };
    expect(scored.c).toBe(0);

    // The task is NOT committed.
    const committed = db
      .query("SELECT COUNT(*) as c FROM events WHERE kind = 'task_committed' AND task_id = ?")
      .get(taskId) as { c: number };
    expect(committed.c).toBe(0);
  }, 30_000);

  test("high-residual dispatch emits refinement edge + new task_node_opened child", async () => {
    const db = openDb(":memory:");
    const { directiveId, taskId } = await openFixtureDCountTodos(db, "/tmp");
    const ready = readyTasks(db, directiveId);
    const task = ready[0]!;

    const result = await dispatchReadyTask(db, task, {
      bridge: opencodeQueryHighResidual,
    });
    expect(result.violations).toEqual([]);

    // action_scored landed with residual=1
    const scored = db
      .query("SELECT residual FROM events WHERE kind = 'action_scored' AND task_id = ?")
      .get(taskId) as { residual: number } | null;
    expect(scored).not.toBeNull();
    expect(scored!.residual).toBe(1);

    // NO task_committed event
    const committed = db
      .query("SELECT COUNT(*) as c FROM events WHERE kind = 'task_committed' AND task_id = ?")
      .get(taskId) as { c: number };
    expect(committed.c).toBe(0);

    // task_failed (refinement_depth_exceeded) MUST NOT fire at depth 0
    const failed = db
      .query("SELECT COUNT(*) as c FROM events WHERE kind = 'task_failed' AND task_id = ?")
      .get(taskId) as { c: number };
    expect(failed.c).toBe(0);

    // A refinement edge MUST exist from this task to a new child.
    const refines = db
      .query(
        "SELECT payload FROM events WHERE kind = 'task_edge_recorded' AND directive_id = ?",
      )
      .all(directiveId) as Array<{ payload: string }>;
    const refinementEdge = refines
      .map((r) => JSON.parse(r.payload) as Record<string, unknown>)
      .find((p) => p.kind === "refines" && p.from_task === taskId);
    expect(refinementEdge).not.toBeUndefined();

    // A new task_node_opened for the refinement child.
    const child = refinementEdge!.to_task as string;
    const childOpened = db
      .query("SELECT payload FROM events WHERE kind = 'task_node_opened' AND task_id = ?")
      .get(child) as { payload: string } | null;
    expect(childOpened).not.toBeNull();
    const childPayload = JSON.parse(childOpened!.payload);
    expect(childPayload.refines_task_id).toBe(taskId);
    expect(childPayload.prior_residual).toBe(1);
  }, 30_000);

  test("at depth 4 (below cap), refinement edge still emits — task_failed must not fire", async () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const ids = Array.from({ length: 5 }, () => newId());
    for (let i = 0; i < 5; i++) {
      emitEvent(db, {
        kind: "task_node_opened",
        directive_id: directiveId,
        task_id: ids[i]!,
        payload: { goal: `chain-${i}` },
      });
      if (i > 0) {
        emitEvent(db, {
          kind: "task_edge_recorded",
          directive_id: directiveId,
          task_id: ids[i]!,
          payload: { from_task: ids[i - 1]!, to_task: ids[i]!, kind: "refines" },
        });
      }
    }
    const deep = ids[4]!; // depth = 4 (1 below cap=5)
    const { nodes } = (await import("./task_topology")).readDagForDirective(db, directiveId);
    const node = nodes.find((n) => n.id === deep)!;

    const result = await dispatchReadyTask(db, node, { bridge: opencodeQueryHighResidual });
    expect(result.violations).toEqual([]);
    // Must emit a refinement edge (depth becomes 5), NOT task_failed.
    const failed = db
      .query("SELECT COUNT(*) as c FROM events WHERE kind = 'task_failed' AND task_id = ?")
      .get(deep) as { c: number };
    expect(failed.c).toBe(0);
    const edges = db
      .query("SELECT payload FROM events WHERE kind = 'task_edge_recorded' AND directive_id = ?")
      .all(directiveId) as Array<{ payload: string }>;
    const newEdge = edges
      .map((r) => JSON.parse(r.payload) as Record<string, unknown>)
      .find((p) => p.from_task === deep && p.kind === "refines");
    expect(newEdge).not.toBeUndefined();
  }, 30_000);

  test("Phase H: action_scored triggers credit pipeline → code_artifact_score_updated events fire", async () => {
    const db = openDb(":memory:");
    const tempDir = mkdtempSync(join(tmpdir(), "acc2-disp-credit-"));
    writeFileSync(join(tempDir, "a.txt"), "// TODO one", "utf-8");

    try {
      const { directiveId, taskId } = await openFixtureDCountTodos(db, tempDir);
      const ready = readyTasks(db, directiveId);
      const task = ready[0]!;

      const result = await dispatchReadyTask(db, task, { fixtureTargetPath: tempDir });
      expect(result.violations).toEqual([]);

      // Credit pipeline emits at least 2 code_artifact_score_updated events
      // (action artifact + verifier artifact). Each one is keyed to the
      // scored event id in its payload.
      const updated = db
        .query(
          "SELECT COUNT(*) as c FROM events WHERE kind = 'code_artifact_score_updated' AND task_id = ?",
        )
        .get(taskId) as { c: number };
      expect(updated.c).toBeGreaterThanOrEqual(2);

      // The dispatcher routes through distributeCredit — not the legacy
      // applyResidualOutcome path. We assert the credit-pipeline contract:
      // for each action_scored on this task, at least one
      // code_artifact_score_updated cites the scored event id in its
      // payload.
      const scored = db
        .query(
          "SELECT id FROM events WHERE kind = 'action_scored' AND task_id = ?",
        )
        .get(taskId) as { id: string };
      const updates = db
        .query(
          "SELECT payload FROM events WHERE kind = 'code_artifact_score_updated' AND task_id = ?",
        )
        .all(taskId) as Array<{ payload: string }>;
      const linked = updates.find((r) => {
        try {
          return (JSON.parse(r.payload) as { scored_event_id?: string }).scored_event_id === scored.id;
        } catch { return false; }
      });
      expect(linked).toBeTruthy();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 60_000);

  test("Phase J: substrate_replay route commits without calling the bridge", async () => {
    const db = openDb(":memory:");
    const tempDir = mkdtempSync(join(tmpdir(), "acc2-disp-replay-"));
    writeFileSync(join(tempDir, "a.txt"), "// TODO\n");

    try {
      // Build a 3-success history so extractRecipeCandidates emits a recipe.
      const { extractRecipeCandidates } = await import("../substrate/extractors");
      const { updateRecipeConfidence } = await import("./recipe_replay");

      for (let i = 0; i < 3; i++) {
        const { directiveId, taskId } = await openFixtureDCountTodos(db, tempDir);
        const ready = readyTasks(db, directiveId);
        await dispatchReadyTask(db, ready[0]!, { fixtureTargetPath: tempDir });
        await new Promise((r) => setTimeout(r, 5));
      }
      // Task 5: extractRecipeFromCommit fires inline on every task_committed,
      // so the first dispatch already seeded a confidence=1.0 recipe — the
      // 3-shape statistical extractor's run is a structural fallback that
      // skips composite keys it already saw. Either path is acceptable here;
      // the test only needs A recipe to exist before the replay dispatch
      // below.
      extractRecipeCandidates(db);
      const recipeRow = db
        .query("SELECT id FROM events WHERE kind = 'recipe_extracted' ORDER BY ts DESC LIMIT 1")
        .get() as { id: string };
      expect(recipeRow).not.toBeNull();
      // Inline-seeded recipes land at confidence=0.5; +0.05 per successful
      // bump. The new replay threshold is 0.85 (= seven proven replays). We
      // bump 7× here to push the recipe above the floor — this is exactly the
      // hardening contract from runtime/crisis_mode.ts (see the comment on
      // recipe_confidence_threshold). Pre-fix the threshold was 0.6 (= one
      // bump from the 0.5 seed); the loose threshold + loose goal_shape match
      // caused false-positive replays of unrelated recipes against new
      // directives. 0.85 = SEVEN proven replays = real evidence.
      for (let i = 0; i < 7; i++) updateRecipeConfidence(db, recipeRow.id, true);

      const bridgeBefore = (db
        .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'bridge_invoked'")
        .get() as { c: number }).c;

      // Fresh fixture run — dispatcher should route to substrate_replay.
      const { directiveId, taskId } = await openFixtureDCountTodos(db, tempDir);
      const ready = readyTasks(db, directiveId);
      const task = ready.find((r) => r.id === taskId)!;

      // Track: bridge MUST NOT be called. We pass a spy bridge that throws.
      let bridgeWasCalled = false;
      const result = await dispatchReadyTask(db, task, {
        fixtureTargetPath: tempDir,
        bridge: async () => {
          bridgeWasCalled = true;
          return { ok: false, reason: { kind: "auth_missing" } };
        },
      });
      expect(bridgeWasCalled).toBe(false);
      expect(result.violations).toEqual([]);

      const invoked = db
        .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'recipe_invoked' AND task_id = ?")
        .get(taskId) as { c: number };
      expect(invoked.c).toBe(1);

      const bridgeAfter = (db
        .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'bridge_invoked'")
        .get() as { c: number }).c;
      expect(bridgeAfter).toBe(bridgeBefore);

      const committed = db
        .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'task_committed' AND task_id = ?")
        .get(taskId) as { c: number };
      expect(committed.c).toBe(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 90_000);

  test("Batch 3.CLEANUP: self_modification_recorded fires when the action observation declares modified_paths under /system/acc2/", async () => {
    // The dispatcher emits self_modification_recorded immediately after
    // task_committed when (a) the action observation carries a
    // `modified_paths` array AND (b) at least one path falls under the acc2
    // codebase root. This narrow heuristic wires §10.1's self-improvement
    // walkthrough into the event stream so the substrate can see when a
    // brain-authored dispatch mutated the v2 source tree itself.
    const db = openDb(":memory:");
    const { admitArtifact } = await import("./artifact_admission");
    const { directiveId, taskId } = await openFixtureDCountTodos(db, "/tmp");
    const ready = readyTasks(db, directiveId);
    const task = ready[0]!;

    // Custom bridge: admit an action whose observation prints
    // `modified_paths` (a string array containing an acc2-relative path) plus
    // a permissive verifier (residual=0 always). Both artifacts are bun.
    const customBridge = async (
      req: { directiveId: string; taskId: string; prompt: string },
      bridgeDb: typeof db,
    ): Promise<{ ok: true; final_response: string; usage: { tokens: number }; emitted_event_ids: string[] }> => {
      const ACTION_BODY = `
        const paths = [
          "/home/maxbaluev/bos2/system/acc2/runtime/task_dispatcher.ts",
          "/home/maxbaluev/bos2/some/unrelated/file.ts",
        ];
        // Use the wrapped convention (matches fixture_d_count_todos shape) so
        // the dispatcher's heuristic exercises the result.modified_paths path.
        process.stdout.write("@@RESULT@@ " + JSON.stringify({ result: { modified_paths: paths } }) + "\\n");
      `;
      const VERIFIER_BODY = `process.stdout.write("@@RESULT@@ " + JSON.stringify({ residual: 0 }) + "\\n");`;
      const emit = (ev: { directive_id?: string; task_id?: string; invoker?: string; [k: string]: unknown }) => {
        emitEvent(bridgeDb, {
          ...ev as Parameters<typeof emitEvent>[1],
          directive_id: (ev.directive_id as string) ?? req.directiveId,
          task_id: (ev.task_id as string) ?? req.taskId,
          invoker: (ev.invoker as Parameters<typeof emitEvent>[1]["invoker"]) ?? "opencode",
        });
      };
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
      const action = await admitArtifact(
        bridgeDb,
        {
          runtime: "bun",
          body: ACTION_BODY,
          declaredSandbox: sandbox,
          fixtureInput: null,
          fixtureExpectedResidualBelow: 1.1,
          name: "self_mod_action_fixture",
        },
        emit,
      );
      if (!action.ok) throw new Error("admit failed: " + action.reason);
      const verifier = await admitArtifact(
        bridgeDb,
        {
          runtime: "bun",
          body: VERIFIER_BODY,
          declaredSandbox: sandbox,
          fixtureInput: { result: { modified_paths: [] } },
          fixtureExpectedResidualBelow: 1.1,
          name: "self_mod_verifier_fixture",
        },
        emit,
      );
      if (!verifier.ok) throw new Error("admit failed: " + verifier.reason);
      emitEvent(bridgeDb, {
        kind: "action_predicted",
        substrate_origin: "opencode",
        directive_id: req.directiveId,
        task_id: req.taskId,
        action_artifact_id: action.artifactId,
        verifier_artifact_id: verifier.artifactId,
        predicted_residual: 0.05,
        payload: { intent: "self-modification fixture" },
        invoker: "opencode",
      });
      return {
        ok: true,
        final_response: "self-mod fixture",
        usage: { tokens: 0 },
        emitted_event_ids: [],
      };
    };

    const result = await dispatchReadyTask(db, task, {
      bridge: customBridge as Parameters<typeof dispatchReadyTask>[2] extends infer D
        ? D extends { bridge?: infer B } ? B : never
        : never,
    });
    expect(result.violations).toEqual([]);
    const committed = db
      .query("SELECT COUNT(*) as c FROM events WHERE kind = 'task_committed' AND task_id = ?")
      .get(taskId) as { c: number };
    expect(committed.c).toBe(1);

    const selfMod = db
      .query("SELECT payload FROM events WHERE kind = 'self_modification_recorded' AND task_id = ?")
      .get(taskId) as { payload: string } | null;
    expect(selfMod).not.toBeNull();
    if (!selfMod) return;
    const payload = JSON.parse(selfMod.payload) as Record<string, unknown>;
    const modifiedPaths = payload.modified_paths as string[];
    expect(Array.isArray(modifiedPaths)).toBe(true);
    // Only paths under the acc2 root survive the filter — the unrelated path
    // must be dropped, the acc2-relative path must be kept.
    expect(modifiedPaths.length).toBe(1);
    expect(modifiedPaths[0]).toContain("/system/acc2/");
    expect(payload.total_declared_paths).toBe(2);
    expect(payload.detection).toBe("action_observation_modified_paths_acc2_root");
  }, 60_000);

  test("Batch 3.CLEANUP: self_modification_recorded does NOT fire when modified_paths are all outside acc2 root", async () => {
    const db = openDb(":memory:");
    const { admitArtifact } = await import("./artifact_admission");
    const { directiveId, taskId } = await openFixtureDCountTodos(db, "/tmp");
    const ready = readyTasks(db, directiveId);
    const task = ready[0]!;

    const customBridge = async (
      req: { directiveId: string; taskId: string; prompt: string },
      bridgeDb: typeof db,
    ): Promise<{ ok: true; final_response: string; usage: { tokens: number }; emitted_event_ids: string[] }> => {
      const ACTION_BODY = `
        process.stdout.write("@@RESULT@@ " + JSON.stringify({ result: { modified_paths: ["/tmp/foo.txt", "/var/log/bar"] } }) + "\\n");
      `;
      const VERIFIER_BODY = `process.stdout.write("@@RESULT@@ " + JSON.stringify({ residual: 0 }) + "\\n");`;
      const emit = (ev: Record<string, unknown>) => {
        emitEvent(bridgeDb, {
          ...ev as Parameters<typeof emitEvent>[1],
          directive_id: (ev.directive_id as string) ?? req.directiveId,
          task_id: (ev.task_id as string) ?? req.taskId,
          invoker: (ev.invoker as Parameters<typeof emitEvent>[1]["invoker"]) ?? "opencode",
        });
      };
      const sandbox = {
        runtime: "bun" as const,
        fs_read: ["**/*"], fs_write: [], net_allow: [], proc_allow: [],
        substrate_access: "none" as const,
        cpu_ms: 5000, wall_ms: 5000, memory_mb: 128,
      };
      const action = await admitArtifact(bridgeDb, {
        runtime: "bun", body: ACTION_BODY, declaredSandbox: sandbox,
        fixtureInput: null, fixtureExpectedResidualBelow: 1.1,
        name: "non_self_mod_action_fixture",
      }, emit);
      const verifier = await admitArtifact(bridgeDb, {
        runtime: "bun", body: VERIFIER_BODY, declaredSandbox: sandbox,
        fixtureInput: { result: {} }, fixtureExpectedResidualBelow: 1.1,
        name: "non_self_mod_verifier_fixture",
      }, emit);
      if (!action.ok || !verifier.ok) throw new Error("admit failed");
      emitEvent(bridgeDb, {
        kind: "action_predicted", substrate_origin: "opencode",
        directive_id: req.directiveId, task_id: req.taskId,
        action_artifact_id: action.artifactId, verifier_artifact_id: verifier.artifactId,
        predicted_residual: 0.05, payload: { intent: "non-acc2 modify" }, invoker: "opencode",
      });
      return { ok: true, final_response: "x", usage: { tokens: 0 }, emitted_event_ids: [] };
    };
    await dispatchReadyTask(db, task, {
      bridge: customBridge as Parameters<typeof dispatchReadyTask>[2] extends infer D
        ? D extends { bridge?: infer B } ? B : never
        : never,
    });
    const selfMod = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'self_modification_recorded' AND task_id = ?")
      .get(taskId) as { c: number };
    expect(selfMod.c).toBe(0);
  }, 60_000);

  test("refinement depth cap fires task_failed with refinement_depth_exceeded after 5 levels", async () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    // Build a 6-deep refines chain manually so the dispatched task starts at depth=5.
    const ids = Array.from({ length: 6 }, () => newId());
    for (let i = 0; i < 6; i++) {
      emitEvent(db, {
        kind: "task_node_opened",
        directive_id: directiveId,
        task_id: ids[i]!,
        payload: { goal: `chain-step-${i}` },
      });
      if (i > 0) {
        emitEvent(db, {
          kind: "task_edge_recorded",
          directive_id: directiveId,
          task_id: ids[i]!,
          payload: { from_task: ids[i - 1]!, to_task: ids[i]!, kind: "refines" },
        });
      }
    }
    // The deepest task is at depth=5. Dispatching it through high-residual
    // MUST hit the cap and emit task_failed instead of opening a 6th refine.
    const deepest = ids[5]!;
    const { nodes } = (await import("./task_topology")).readDagForDirective(db, directiveId);
    const deepNode = nodes.find((n) => n.id === deepest)!;
    expect(deepNode).toBeTruthy();

    const result = await dispatchReadyTask(db, deepNode, {
      bridge: opencodeQueryHighResidual,
    });
    expect(result.violations).toEqual([]);

    const failed = db
      .query(
        "SELECT failure_kind, residual FROM events WHERE kind = 'task_failed' AND task_id = ?",
      )
      .get(deepest) as { failure_kind: string; residual: number } | null;
    expect(failed).not.toBeNull();
    expect(failed!.failure_kind).toBe("refinement_depth_exceeded");
    expect(failed!.residual).toBe(1);

    // NO refinement edge should be emitted past the cap.
    const refinementEdges = db
      .query(
        "SELECT payload FROM events WHERE kind = 'task_edge_recorded' AND directive_id = ?",
      )
      .all(directiveId) as Array<{ payload: string }>;
    const newRefines = refinementEdges
      .map((r) => JSON.parse(r.payload) as Record<string, unknown>)
      .filter((p) => p.kind === "refines" && p.from_task === deepest);
    expect(newRefines.length).toBe(0);
  }, 30_000);

  test("bridge-timeout safety net: auto-commit fires when closure_audited landed cleanly before bridge timeout", async () => {
    // Live-ledger evidence (2026-05-15 01:13:39 / 01:13:48) showed a real
    // brain run that reached task_closure_audited but then lost the
    // dispatch to bridge_failed:timeout 9s later — before task_committed
    // could be emitted. The next dispatch re-did the full cycle from
    // scratch. The fix: when bridge_failed.kind === "timeout" AND a clean
    // task_closure_audited landed in the dispatch window (residual < 0.3),
    // the substrate auto-emits task_committed citing the closure event.
    const db = openDb(":memory:");
    const directiveId = newId();
    const taskId = newId();

    emitEvent(db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: directiveId,
      payload: { directive_text: "fixture", lifecycle: "finite" },
    });
    emitEvent(db, {
      kind: "task_node_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: taskId,
      parent_task_id: null,
      payload: { goal: "long-running goal exceeding bridge window" },
    });

    // Custom bridge: emits task_closure_audited with low residual, then
    // returns a timeout failure (mimicking the production pattern).
    const customBridge = async (
      req: { directiveId: string; taskId: string; prompt: string },
      bridgeDb: typeof db,
    ): Promise<{ ok: false; reason: { kind: "timeout"; detail?: string } }> => {
      emitEvent(bridgeDb, {
        kind: "task_closure_audited",
        substrate_origin: "brain",
        directive_id: req.directiveId,
        task_id: req.taskId,
        payload: {
          closure_residual: 0.12,
          breakdown: { goal_solved: 1, sub_tasks_covered: 1, lessons_captured: 1, violation_count: 0 },
          original_goal_text: "long-running goal exceeding bridge window",
          covered_sub_tasks: [],
          uncovered_aspects: [],
        },
      });
      return { ok: false, reason: { kind: "timeout", detail: "test_simulated_timeout" } };
    };

    const result = await dispatchReadyTask(
      db,
      { id: taskId, directive_id: directiveId, parent_id: null, goal: "long goal", status: "ready" },
      { bridge: customBridge as unknown as typeof dispatchReadyTask extends (db: unknown, t: unknown, d: { bridge?: infer B }) => unknown ? B : never },
    );

    expect(result.bridge_result?.ok).toBe(false);

    const committed = db
      .query("SELECT residual, payload FROM events WHERE kind = 'task_committed' AND task_id = ?")
      .get(taskId) as { residual: number; payload: string } | null;
    expect(committed).not.toBeNull();
    expect(committed!.residual).toBe(0.12);
    const cp = JSON.parse(committed!.payload);
    expect(cp.reason).toBe("auto_commit_on_bridge_timeout_after_clean_closure_audit");
    expect(cp.closure_residual).toBe(0.12);
  }, 30_000);

  test("bridge-timeout safety net: does NOT auto-commit when closure_residual is too high", async () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const taskId = newId();

    emitEvent(db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: directiveId,
      payload: { directive_text: "fixture", lifecycle: "finite" },
    });
    emitEvent(db, {
      kind: "task_node_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: taskId,
      parent_task_id: null,
      payload: { goal: "incomplete goal" },
    });

    const customBridge = async (
      req: { directiveId: string; taskId: string; prompt: string },
      bridgeDb: typeof db,
    ): Promise<{ ok: false; reason: { kind: "timeout"; detail?: string } }> => {
      // closure_residual = 0.45 — above the 0.3 commit threshold; should NOT auto-commit
      emitEvent(bridgeDb, {
        kind: "task_closure_audited",
        substrate_origin: "brain",
        directive_id: req.directiveId,
        task_id: req.taskId,
        payload: {
          closure_residual: 0.45,
          breakdown: { goal_solved: 0.5, sub_tasks_covered: 0.4, lessons_captured: 0.6, violation_count: 0 },
          original_goal_text: "incomplete goal",
          covered_sub_tasks: [],
          uncovered_aspects: ["main_step_unfinished"],
        },
      });
      return { ok: false, reason: { kind: "timeout", detail: "test_simulated_timeout" } };
    };

    await dispatchReadyTask(
      db,
      { id: taskId, directive_id: directiveId, parent_id: null, goal: "incomplete", status: "ready" },
      { bridge: customBridge as unknown as typeof dispatchReadyTask extends (db: unknown, t: unknown, d: { bridge?: infer B }) => unknown ? B : never },
    );

    const committed = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'task_committed' AND task_id = ?")
      .get(taskId) as { c: number };
    expect(committed.c).toBe(0);
  }, 30_000);
});
