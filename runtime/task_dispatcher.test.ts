import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue, SandboxDecl } from "../substrate/types";
import { closeDb, openDb } from "../substrate/db";
import { dispatchReadyTask } from "./task_dispatcher";
import { opencodeQueryAdversarialCycle2 } from "./bridge/index";
import type { BridgeRequest, BridgeResult } from "./bridge/index";
import { readDagForDirective, readyTasks } from "./task_topology";
import { openFixtureDCountTodos } from "./fixtures/d_count_todos";
import { emitEvent } from "./events";
import { newId } from "./ids";
import { insertArtifact } from "./artifact_store";
import type { UnifiedRuntimeInvocation, UnifiedRuntimeObservation } from "./runtimes";

afterAll(() => closeDb());
beforeEach(() => closeDb());

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

const insertTestArtifact = (db: Database, name: string) => insertArtifact(db, {
  runtime: "bun",
  body: name,
  declaredSandbox: TEST_SANDBOX,
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

const inMemoryAct = (opts: {
  actionResult: JsonValue;
  verifierResidual: number;
  predictedResidual?: number;
}) => {
  const actionResults = new Map<string, JsonValue>();
  const verifierResiduals = new Map<string, number>();
  const bridge = async (req: BridgeRequest, db: Database): Promise<BridgeResult> => {
    emitEvent(db, {
      kind: "bridge_invoked",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: { fixture: "in_memory_dispatcher_test" },
      invoker: "opencode",
    });
    const action = insertTestArtifact(db, "in_memory_dispatcher_action");
    const verifier = insertTestArtifact(db, "in_memory_dispatcher_verifier");
    actionResults.set(action.id, opts.actionResult);
    verifierResiduals.set(verifier.id, opts.verifierResidual);
    emitEvent(db, {
      kind: "action_predicted",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      action_artifact_id: action.id,
      verifier_artifact_id: verifier.id,
      predicted_residual: opts.predictedResidual ?? 0.05,
      payload: { intent: "in-memory dispatcher fixture", target_path: req.fixtureTargetPath ?? "." },
      invoker: "opencode",
    });
    emitEvent(db, {
      kind: "bridge_completed",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: { action_artifact_id: action.id, verifier_artifact_id: verifier.id },
      invoker: "opencode",
    });
    return { ok: true, final_response: "in-memory action_predicted emitted", usage: { tokens: 0 }, emitted_event_ids: [] };
  };
  const runArtifact = async (inv: UnifiedRuntimeInvocation): Promise<UnifiedRuntimeObservation> => {
    inv.emit?.({
      kind: "artifact_observed",
      substrate_origin: "substrate_auto",
      action_artifact_id: inv.artifactId,
      payload: { phase: "completed", duration_ms: 0 },
    });
    return {
      ok: true,
      result: verifierResiduals.has(inv.artifactId)
        ? { residual: verifierResiduals.get(inv.artifactId)! }
        : actionResults.get(inv.artifactId) ?? null,
      irreversibleEffects: [],
      durationMs: 0,
      exitCode: 0,
      stderrTail: "",
      sandboxWarnings: [],
    };
  };
  return { bridge, runArtifact };
};

describe("task_dispatcher", () => {
  test("happy path: action_predicted → action → verifier → action_scored → task_committed", async () => {
    const db = openDb(":memory:");
    const { directiveId, taskId } = await openFixtureDCountTodos(db, "/tmp");
    const ready = readyTasks(db, directiveId);
    expect(ready.length).toBeGreaterThan(0);
    const task = ready[0]!;
    expect(task.id).toBe(taskId);
    const act = inMemoryAct({ actionResult: { result: { count: 2 } }, verifierResidual: 0 });

    const result = await dispatchReadyTask(db, task, act);
    expect(result.violations).toEqual([]);
    expect(result.bridge_result?.ok).toBe(true);

    const actionPredicted = db
      .query("SELECT COUNT(*) as c FROM events WHERE kind = 'action_predicted' AND task_id = ?")
      .get(taskId) as { c: number };
    expect(actionPredicted.c).toBe(1);

    const actionScored = db
      .query("SELECT residual, payload FROM events WHERE kind = 'action_scored' AND task_id = ?")
      .get(taskId) as { residual: number; payload: string } | null;
    expect(actionScored).not.toBeNull();
    expect(actionScored!.residual).toBe(0);
    const scoredPayload = JSON.parse(actionScored!.payload) as Record<string, any>;
    expect(scoredPayload.routing_axes.one_shot_confidence).toBeGreaterThanOrEqual(0);
    expect(scoredPayload.route_scores.opencode_brain).toBeGreaterThanOrEqual(0);
    expect(scoredPayload.dispatch_verifier_evidence.target_count).toBeGreaterThanOrEqual(0);

    const dispatchDecided = db
      .query("SELECT payload FROM events WHERE kind = 'dispatch_decided' AND task_id = ?")
      .get(taskId) as { payload: string } | null;
    expect(dispatchDecided).not.toBeNull();
    const dispatchPayload = JSON.parse(dispatchDecided!.payload) as Record<string, any>;
    expect(dispatchPayload.routing_axes.one_shot_confidence).toBeGreaterThanOrEqual(0);
    expect(dispatchPayload.routing_axes.information_gap).toBeGreaterThanOrEqual(0);
    expect(dispatchPayload.routing_axes.reversibility).toBeGreaterThanOrEqual(0);
    expect(dispatchPayload.routing_axes.owner_control_need).toBeGreaterThanOrEqual(0);
    expect(dispatchPayload.routing_axes.decomposition_value).toBeGreaterThanOrEqual(0);
    expect(dispatchPayload.routing_axes.cost_pressure).toBeGreaterThanOrEqual(0);
    expect(dispatchPayload.routing_axes.time_sensitivity).toBeGreaterThanOrEqual(0);
    expect(dispatchPayload.route_scores.opencode_brain).toBeGreaterThanOrEqual(0);
    expect(dispatchPayload.verifier_evidence.target_count).toBeGreaterThanOrEqual(0);
    // 2026-05-17: dispatch_decided must carry strategy_shadow_ranks so
    // claude_inline_ready_leaves_view + closure_audited can credit the
    // top-ranked strategy. The decider attaches the field; this test
    // pins that the emit path does NOT strip it.
    expect(Array.isArray(dispatchPayload.strategy_shadow_ranks)).toBe(true);

    // The constitutional_gate_decision audit mirror of the same decision
    // must carry the SAME shape — historically it diverged from dispatch_decided
    // because each emit site hand-rebuilt its payload. Pinning the shape here
    // means new DispatchDecisionEvidence fields propagate to BOTH audit emits
    // via the shared dispatchEvidencePayload helper.
    const gateDecision = db
      .query("SELECT payload FROM events WHERE kind = 'constitutional_gate_decision' AND task_id = ?")
      .get(taskId) as { payload: string } | null;
    expect(gateDecision).not.toBeNull();
    const gatePayload = JSON.parse(gateDecision!.payload) as Record<string, any>;
    expect(Array.isArray(gatePayload.strategy_shadow_ranks)).toBe(true);
    expect(gatePayload.routing_axes.one_shot_confidence).toBeGreaterThanOrEqual(0);
    expect(gatePayload.route_scores.opencode_brain).toBeGreaterThanOrEqual(0);

    const taskCommitted = db
      .query("SELECT residual FROM events WHERE kind = 'task_committed' AND task_id = ?")
      .get(taskId) as { residual: number } | null;
    expect(taskCommitted).not.toBeNull();
    expect(taskCommitted!.residual).toBe(0);

    const closed = db
      .query("SELECT COUNT(*) as c FROM events WHERE kind = 'brain_dispatch_closed' AND task_id = ?")
      .get(taskId) as { c: number };
    expect(closed.c).toBe(1);
  });

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
  }, 10_000);

  test("root commit with dangling descendant is blocked instead of cascaded", async () => {
    const db = openDb(":memory:");
    const { directiveId, taskId } = await openFixtureDCountTodos(db, "/tmp");
    const ready = readyTasks(db, directiveId);
    const task = ready[0]!;

    const childTaskId = newId();
    emitEvent(db, {
      kind: "task_node_opened",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      task_id: childTaskId,
      parent_task_id: taskId,
      payload: { goal: "refinement child", refines_task_id: taskId },
    });
    emitEvent(db, {
      kind: "task_edge_recorded",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      task_id: taskId,
      payload: { from_task: taskId, to_task: childTaskId, kind: "refines" },
    });

    const act = inMemoryAct({ actionResult: { result: { count: 2 } }, verifierResidual: 0 });
    const result = await dispatchReadyTask(db, task, act);
    expect(result.violations).toEqual([]);

    const rootCommit = db
      .query("SELECT COUNT(*) as c FROM events WHERE kind = 'task_committed' AND task_id = ?")
      .get(taskId) as { c: number };
    expect(rootCommit.c).toBe(0);

    const childCommit = db
      .query("SELECT COUNT(*) as c FROM events WHERE kind = 'task_committed' AND task_id = ?")
      .get(childTaskId) as { c: number };
    expect(childCommit.c).toBe(0);

    const violation = db
      .query("SELECT payload FROM events WHERE kind = 'dispatcher_violation' AND task_id = ? AND failure_kind = 'root_commit_blocked'")
      .get(taskId) as { payload: string } | null;
    expect(violation).not.toBeNull();
    expect(JSON.parse(violation!.payload).refused_reason).toBe("missing_clean_closure_audit");
  }, 10_000);

  test("high-residual dispatch emits refinement edge + new task_node_opened child", async () => {
    const db = openDb(":memory:");
    const { directiveId, taskId } = await openFixtureDCountTodos(db, "/tmp");
    const ready = readyTasks(db, directiveId);
    const task = ready[0]!;

    const act = inMemoryAct({ actionResult: { result: { value: 1 } }, verifierResidual: 1, predictedResidual: 0.95 });
    const result = await dispatchReadyTask(db, task, act);
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
  }, 10_000);

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
    const { nodes } = readDagForDirective(db, directiveId);
    const node = nodes.find((n) => n.id === deep)!;

    const act = inMemoryAct({ actionResult: { result: { value: 1 } }, verifierResidual: 1, predictedResidual: 0.95 });
    const result = await dispatchReadyTask(db, node, act);
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
  }, 10_000);

  test("Phase H: action_scored triggers credit pipeline → act_artifact_score_updated events fire", async () => {
    const db = openDb(":memory:");
    const { directiveId, taskId } = await openFixtureDCountTodos(db, "/tmp");
    const ready = readyTasks(db, directiveId);
    const task = ready[0]!;
    const act = inMemoryAct({ actionResult: { result: { count: 1 } }, verifierResidual: 0 });

    const result = await dispatchReadyTask(db, task, act);
    expect(result.violations).toEqual([]);

    // Credit pipeline emits at least 2 act_artifact_score_updated events
    // (action artifact + verifier artifact). Each one is keyed to the
    // scored event id in its payload.
    const updated = db
      .query(
        "SELECT COUNT(*) as c FROM events WHERE kind = 'act_artifact_score_updated' AND task_id = ?",
      )
      .get(taskId) as { c: number };
    expect(updated.c).toBeGreaterThanOrEqual(2);

    // The dispatcher routes through distributeCredit — not the legacy
    // applyResidualOutcome path. We assert the credit-pipeline contract:
    // for each action_scored on this task, at least one
    // act_artifact_score_updated cites the scored event id in its
    // payload.
    const scored = db
      .query(
        "SELECT id FROM events WHERE kind = 'action_scored' AND task_id = ?",
      )
      .get(taskId) as { id: string };
    const updates = db
      .query(
        "SELECT payload FROM events WHERE kind = 'act_artifact_score_updated' AND task_id = ?",
      )
      .all(taskId) as Array<{ payload: string }>;
    const linked = updates.find((r) => {
      try {
        return (JSON.parse(r.payload) as { scored_event_id?: string }).scored_event_id === scored.id;
      } catch { return false; }
    });
    expect(linked).toBeTruthy();
  });

  test("Phase J: substrate_replay route commits without calling the bridge", async () => {
    const db = openDb(":memory:");
    const tempDir = mkdtempSync(join(tmpdir(), "acc2-disp-replay-"));
    writeFileSync(join(tempDir, "a.txt"), "// TODO\n");

    try {
      // Seed the replay route directly. Recipe extraction/three-success history
      // is covered elsewhere; this dispatcher test only needs a confident,
      // matching recipe so it can assert bridge bypass behavior.
      const { insertArtifact } = await import("./artifact_store");
      const sandbox = { runtime: "bun" as const, fs_read: ["**/*"], fs_write: [], net_allow: [], proc_allow: [], cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 };
      const actionResult = { result: { count: 1 } };
      const action = insertArtifact(db, {
        runtime: "bun",
        body: "dispatcher_replay_test_action",
        declaredSandbox: sandbox,
        stateRoot: null,
        posteriorAlpha: 1,
        posteriorBeta: 1,
        score: 0.5,
        confidence: 0.3,
        recentResidualMean: 0,
        recentKillCount: 0,
        status: "admitted",
        name: "dispatcher_replay_test_action",
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
        body: "dispatcher_replay_test_verifier",
        declaredSandbox: sandbox,
        stateRoot: null,
        posteriorAlpha: 1,
        posteriorBeta: 1,
        score: 0.5,
        confidence: 0.3,
        recentResidualMean: 0,
        recentKillCount: 0,
        status: "admitted",
        name: "dispatcher_replay_test_verifier",
        fixtureInput: null,
        fixtureExpectedResidual: 0,
        intent: null,
        summary: null,
        targetFiles: null,
        sourceCandidateId: null,
        ownerGateVerdict: null,
      });
      const runReplayArtifact = async (inv: UnifiedRuntimeInvocation): Promise<UnifiedRuntimeObservation> => {
        inv.emit?.({
          kind: "artifact_observed",
          substrate_origin: "substrate_auto",
          action_artifact_id: inv.artifactId,
          payload: { phase: "completed", duration_ms: 0 },
        });
        return {
          ok: true,
          result: inv.artifactId === verifier.id ? { residual: 0 } : actionResult,
          irreversibleEffects: [],
          durationMs: 0,
          exitCode: 0,
          stderrTail: "",
          sandboxWarnings: [],
        };
      };

      const recipeRow = emitEvent(db, {
        kind: "knowledge_candidate",
        substrate_origin: "substrate_auto",
        directive_id: "d_dispatcher_replay_seed",
        task_id: "t_dispatcher_replay_seed",
        payload: {
          recipe_shape: { enabled: true },
          goal_shape: "count_files_target_directory::n1",
          topology_signature: "",
          confidence: 0.9,
          trajectory: [{ step_kind: "action_predicted", artifact_id: action.id, verifier_artifact_id: verifier.id, payload_template: { target_path: tempDir }, predicted_residual: 0 }],
        },
      });

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
        runArtifact: runReplayArtifact,
      });
      expect(bridgeWasCalled).toBe(false);
      expect(result.violations).toEqual([]);

      const invoked = db
        .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'dispatch_decided' AND json_extract(payload, '$.route') = 'substrate_replay' AND task_id = ?")
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
  }, 10_000);

  test("Batch 3.CLEANUP: self_modification_recorded fires when the action observation declares modified_paths under /system/acc2/", async () => {
    // The dispatcher emits self_modification_recorded immediately after
    // task_committed when (a) the action observation carries a
    // `modified_paths` array AND (b) at least one path falls under the acc2
    // codebase root. This narrow heuristic wires §10.1's self-improvement
    // walkthrough into the event stream so the substrate can see when a
    // brain-authored dispatch mutated the v2 source tree itself.
    const db = openDb(":memory:");
    const { directiveId, taskId } = await openFixtureDCountTodos(db, "/tmp");
    const ready = readyTasks(db, directiveId);
    const task = ready[0]!;
    const act = inMemoryAct({
      actionResult: {
        result: {
          modified_paths: [
            "/home/maxbaluev/bos2/system/acc2/runtime/task_dispatcher.ts",
            "/home/maxbaluev/bos2/some/unrelated/file.ts",
          ],
        },
      },
      verifierResidual: 0,
    });

    const result = await dispatchReadyTask(db, task, act);
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
  }, 10_000);

  test("Batch 3.CLEANUP: self_modification_recorded does NOT fire when modified_paths are all outside acc2 root", async () => {
    const db = openDb(":memory:");
    const { directiveId, taskId } = await openFixtureDCountTodos(db, "/tmp");
    const ready = readyTasks(db, directiveId);
    const task = ready[0]!;
    const act = inMemoryAct({
      actionResult: { result: { modified_paths: ["/tmp/foo.txt", "/var/log/bar"] } },
      verifierResidual: 0,
    });

    await dispatchReadyTask(db, task, act);
    const selfMod = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'self_modification_recorded' AND task_id = ?")
      .get(taskId) as { c: number };
    expect(selfMod.c).toBe(0);
  }, 10_000);

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
    const { nodes } = readDagForDirective(db, directiveId);
    const deepNode = nodes.find((n) => n.id === deepest)!;
    expect(deepNode).toBeTruthy();

    const act = inMemoryAct({ actionResult: { result: { value: 1 } }, verifierResidual: 1, predictedResidual: 0.95 });
    const result = await dispatchReadyTask(db, deepNode, act);
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
  }, 10_000);

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
  }, 10_000);

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
  }, 10_000);

  // ── Productive-timeout continuation (2026-05-23) ──────────────────────
  // A wall-clock timeout that fired MID-PRODUCTIVE-WORK must NOT terminally
  // fail the task. The dispatcher re-opens the work via the existing
  // refinement-edge mechanism so the scheduler resumes it on a fresh cycle.
  // A zero-progress timeout (genuinely wedged) stays a hard failure. The
  // refinement-depth cap still bounds repeated productive timeouts so a
  // perpetually-slow task eventually fails (no infinite resume).

  /** Bridge stub: emits a productive-shape bridge_failed:timeout (frames>0,
   *  brain emissions>0, first_frame_seen) then returns the timeout result —
   *  mirroring the real opencode bridge's killed-by-overall-timeout path. */
  const productiveTimeoutBridge = async (
    req: { directiveId: string; taskId: string; prompt: string },
    bridgeDb: Database,
  ): Promise<{ ok: false; reason: { kind: "timeout"; ms_elapsed: number } }> => {
    emitEvent(bridgeDb, {
      kind: "bridge_failed",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: {
        reason: "timeout",
        timeout_mode: "overall_wall_clock",
        frames_received_count: 68,
        brain_obs_emit_count: 20,
        budget_observed: { terminal_reason: "timeout", first_frame_seen: true, wall_ms: 1_600_000 },
      } as JsonValue,
      invoker: "opencode",
    });
    return { ok: false, reason: { kind: "timeout", ms_elapsed: 1_500_000 } };
  };

  /** Bridge stub: zero-progress timeout — first_frame_seen=false, no frames,
   *  no brain emissions. Genuinely wedged; must stay a hard failure. */
  const wedgedTimeoutBridge = async (
    req: { directiveId: string; taskId: string; prompt: string },
    bridgeDb: Database,
  ): Promise<{ ok: false; reason: { kind: "timeout"; ms_elapsed: number } }> => {
    emitEvent(bridgeDb, {
      kind: "bridge_failed",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: {
        reason: "timeout",
        timeout_mode: "overall_wall_clock",
        frames_received_count: 0,
        brain_obs_emit_count: 0,
        budget_observed: { terminal_reason: "timeout", first_frame_seen: false, wall_ms: 1_600_000 },
      } as JsonValue,
      invoker: "opencode",
    });
    return { ok: false, reason: { kind: "timeout", ms_elapsed: 1_500_000 } };
  };

  const castBridge = <B>(b: B) =>
    b as unknown as typeof dispatchReadyTask extends (db: unknown, t: unknown, d: { bridge?: infer X }) => unknown ? X : never;

  test("productive timeout opens a continuation refinement edge (task NOT terminally failed)", async () => {
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
      payload: { goal: "long productive goal that exceeds the wall-clock budget" },
    });

    const result = await dispatchReadyTask(
      db,
      { id: taskId, directive_id: directiveId, parent_id: null, goal: "long goal", status: "ready" },
      { bridge: castBridge(productiveTimeoutBridge) },
    );
    expect(result.bridge_result?.ok).toBe(false);

    // The task is NOT terminally failed.
    const failed = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'task_failed' AND task_id = ?")
      .get(taskId) as { c: number };
    expect(failed.c).toBe(0);

    // A continuation child was opened via the refinement-edge mechanism.
    const childNode = db
      .query("SELECT task_id, payload FROM events WHERE kind = 'task_node_opened' AND parent_task_id = ?")
      .get(taskId) as { task_id: string; payload: string } | null;
    expect(childNode).not.toBeNull();
    const childPayload = JSON.parse(childNode!.payload);
    expect(childPayload.continuation_reason).toBe("productive_timeout_continuation");
    expect(childPayload.refines_task_id).toBe(taskId);

    const edge = db
      .query("SELECT payload FROM events WHERE kind = 'task_edge_recorded' AND task_id = ?")
      .get(childNode!.task_id) as { payload: string } | null;
    expect(edge).not.toBeNull();
    const edgePayload = JSON.parse(edge!.payload);
    expect(edgePayload.kind).toBe("refines");
    expect(edgePayload.from_task).toBe(taskId);

    // Parent is superseded (drops out of readyTasks); the continuation child
    // becomes the ready task the scheduler resumes on a fresh cycle.
    const superseded = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'task_committed_superseded' AND task_id = ?")
      .get(taskId) as { c: number };
    expect(superseded.c).toBe(1);
    const ready = readyTasks(db, directiveId).map((t) => t.id);
    expect(ready).not.toContain(taskId);
    expect(ready).toContain(childNode!.task_id);

    // brain_dispatch_closed records the continuation outcome for observability.
    const closed = db
      .query("SELECT payload FROM events WHERE kind = 'brain_dispatch_closed' AND task_id = ?")
      .get(taskId) as { payload: string } | null;
    expect(JSON.parse(closed!.payload).productive_timeout_continuation).toBe("opened");
  }, 10_000);

  test("zero-progress timeout stays a hard failure (no continuation edge)", async () => {
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
      payload: { goal: "wedged goal — no progress before the wall clock" },
    });

    await dispatchReadyTask(
      db,
      { id: taskId, directive_id: directiveId, parent_id: null, goal: "wedged", status: "ready" },
      { bridge: castBridge(wedgedTimeoutBridge) },
    );

    // No continuation child opened — a zero-progress timeout is genuinely
    // wedged and must not resume.
    const child = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'task_node_opened' AND parent_task_id = ?")
      .get(taskId) as { c: number };
    expect(child.c).toBe(0);
    const superseded = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'task_committed_superseded' AND task_id = ?")
      .get(taskId) as { c: number };
    expect(superseded.c).toBe(0);
    const closed = db
      .query("SELECT payload FROM events WHERE kind = 'brain_dispatch_closed' AND task_id = ?")
      .get(taskId) as { payload: string } | null;
    expect(JSON.parse(closed!.payload).productive_timeout_continuation).toBe("not_attempted");
  }, 10_000);

  test("repeated productive timeouts are bounded — at the refinement-depth cap the lineage fails (no infinite resume)", async () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const rootTaskId = newId();

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
      task_id: rootTaskId,
      parent_task_id: null,
      payload: { goal: "perpetually-slow goal that always times out productively" },
    });

    // Drive the continuation chain: each productive timeout opens the next
    // refinement child, growing refinementDepth by 1. After REFINEMENT_DEPTH_CAP
    // (5) the lineage must terminalize with task_failed instead of resuming.
    let currentTaskId = rootTaskId;
    let sawDepthCappedFailure = false;
    for (let i = 0; i < 8; i++) {
      await dispatchReadyTask(
        db,
        { id: currentTaskId, directive_id: directiveId, parent_id: null, goal: "slow", status: "ready" },
        { bridge: castBridge(productiveTimeoutBridge) },
      );
      const failed = db
        .query("SELECT payload FROM events WHERE kind = 'task_failed' AND task_id = ? AND failure_kind = 'refinement_depth_exceeded'")
        .get(currentTaskId) as { payload: string } | null;
      if (failed) {
        expect(JSON.parse(failed.payload).reason).toContain("productive_timeout_continuation");
        sawDepthCappedFailure = true;
        break;
      }
      const child = db
        .query("SELECT task_id FROM events WHERE kind = 'task_node_opened' AND parent_task_id = ?")
        .get(currentTaskId) as { task_id: string } | null;
      expect(child).not.toBeNull();
      currentTaskId = child!.task_id;
    }
    // The chain terminated within the cap — it did NOT resume forever.
    expect(sawDepthCappedFailure).toBe(true);
  }, 20_000);

  // Perf isolation (2026-05-24): the dispatcher's heavy read scans
  // (readEventsSinceTs / readEventsForDispatch over `events`, the act_artifact
  // policy scan, the task_edge_recorded plateau scan) now route through
  // poolQuery so they run off the daemon main loop. poolQuery uses the SAME db
  // handle + SQL + params as the old sync path, so the off-loop path must
  // return rows/order identical to the sync-fallback path. This test runs the
  // same happy-path dispatch twice — once with a mock pool installed (off-loop
  // lane), once without (sync fallback) — and asserts the resulting event
  // ledgers are byte-identical, plus that the mock pool actually fielded the
  // heavy event-table scans.
  test("off-loop poolQuery path returns dispatch results identical to the sync fallback", async () => {
    const { setSqlPool, clearSqlPool } = await import("./sql_pool_singleton");
    type AnyPool = import("./sql_worker_pool").SqlWorkerPool;

    const runDispatch = async (db: Database) => {
      const { directiveId, taskId } = await openFixtureDCountTodos(db, "/tmp");
      const task = readyTasks(db, directiveId)[0]!;
      const act = inMemoryAct({ actionResult: { result: { count: 2 } }, verifierResidual: 0 });
      const result = await dispatchReadyTask(db, task, act);
      // Snapshot the full event ledger the dispatch produced — the heavy read
      // scans feed the events the dispatch returns + every downstream emit.
      const ledger = db
        .query("SELECT kind, residual, payload FROM events WHERE task_id = ? ORDER BY ts ASC, id ASC")
        .all(taskId) as Array<{ kind: string; residual: number | null; payload: string }>;
      return { result, ledger, taskId };
    };

    // 1. Sync-fallback lane — no pool installed (the default unit-test path).
    clearSqlPool();
    const syncDb = openDb(":memory:");
    const sync = await runDispatch(syncDb);
    closeDb();

    // 2. Off-loop lane — a mock pool delegating to the SAME db handle via the
    //    identical SQL + params. Records the SQL it fielded so we can confirm
    //    the heavy scans were routed through it.
    const offloopDb = openDb(":memory:");
    const seenSql: string[] = [];
    const mockPool = {
      query: async <T = unknown>(sql: string, params: SQLQueryBindings[] = []): Promise<T[]> => {
        seenSql.push(sql);
        // Delegate off-loop (await yields the loop) to the same db handle.
        await Promise.resolve();
        return offloopDb.query(sql).all(...params) as T[];
      },
    } as unknown as AnyPool;
    setSqlPool(mockPool);
    let offloop: Awaited<ReturnType<typeof runDispatch>>;
    try {
      offloop = await runDispatch(offloopDb);
    } finally {
      clearSqlPool();
    }
    closeDb();

    // The mock pool fielded the heavy event-table read scan at least once
    // (readEventsSinceTs runs several times per dispatch).
    expect(seenSql.some((s) => s.includes("FROM events WHERE ts >= ? AND task_id = ?"))).toBe(true);

    // Identical dispatch behavior: same violations, same bridge ok, and the
    // SAME multiset of emitted event kinds. We compare sorted kind counts
    // rather than the raw sequence because the credit/projection cascade emits
    // several near-simultaneous events whose interleaving order is not stable
    // across runs (random ids + async yields) — the off-loop poolQuery yields
    // the loop, which can reorder same-ts emits without changing WHAT is
    // emitted. poolQuery runs the identical SQL on the same db handle, so the
    // rows each scan returns are identical; only the cascade interleave varies.
    const kindCounts = (ledger: Array<{ kind: string }>) => {
      const m: Record<string, number> = {};
      for (const r of ledger) m[r.kind] = (m[r.kind] ?? 0) + 1;
      return m;
    };
    expect(offloop.result.violations).toEqual(sync.result.violations);
    expect(offloop.result.bridge_result?.ok).toBe(sync.result.bridge_result?.ok);
    expect(kindCounts(offloop.ledger)).toEqual(kindCounts(sync.ledger));
    expect([...offloop.ledger.map((r) => r.residual)].sort()).toEqual(
      [...sync.ledger.map((r) => r.residual)].sort(),
    );
    // task_committed must land on both lanes with residual 0.
    const offCommit = offloop.ledger.find((r) => r.kind === "task_committed");
    const syncCommit = sync.ledger.find((r) => r.kind === "task_committed");
    expect(offCommit?.residual).toBe(0);
    expect(syncCommit?.residual).toBe(0);
  });
});

// Increment 2/2 — executor-selection + apply-routing wiring.
// (amendments TRJRC1NZ, BDAXGS1M, 0MD1R9T8 — and the WITHDRAWAL of AW5AY83Z's
//  direct CC-bridge spawn, which violated the symmetric-peer protocol.)
//
// PROTOCOL INVARIANT (Architecture.md §"Participation is symmetric"): the
// substrate must NOT spawn Claude Code programmatically. A leaf routed to the
// claude_agent lane is ENQUEUED as a claude_agent_job_requested event that a
// registered Claude PEER drains over MCP — never a `claude -p` subprocess.
describe("task_dispatcher claude_agent route enqueues a peer job (no CC spawn)", () => {
  // Seed a directive + an APPLY leaf task carrying the explicit executor_hint
  // so the decider's executor-selection routes it to the claude_agent lane.
  const seedApplyLeaf = (db: Database): { directiveId: string; taskId: string } => {
    const directiveId = newId();
    const taskId = newId();
    emitEvent(db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: directiveId,
      payload: { directive_text: "apply the amendment edits", lifecycle: "finite" } as JsonValue,
    });
    emitEvent(db, {
      kind: "task_node_opened",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      task_id: taskId,
      parent_task_id: null,
      payload: {
        goal: "apply the amendment edits to runtime/foo.ts",
        // contract-amendment apply-leaf markers → executor_selection → claude_agent
        executor_hint: "claude_agent",
        source_proposal_id: "prop_xyz",
        requires_deliverable: true,
        target_files: ["runtime/foo.ts"],
        lifecycle: "finite",
      } as JsonValue,
    });
    return { directiveId, taskId };
  };

  test("claude_agent route emits claude_agent_job_requested and spawns NO subprocess", async () => {
    const db = openDb(":memory:");
    const { directiveId, taskId } = seedApplyLeaf(db);
    const ready = readyTasks(db, directiveId);
    const task = ready.find((r) => r.id === taskId)!;
    expect(task).toBeDefined();

    // Inject a bridge spy that fails loudly if the dispatcher ever tried to
    // run a brain subprocess for this lane (it must not — the peer drains it).
    let bridgeCalls = 0;
    const bridgeSpy = async (_req: BridgeRequest, _db: Database): Promise<BridgeResult> => {
      bridgeCalls += 1;
      return { ok: true, final_response: "should-not-run", usage: { tokens: 0 }, emitted_event_ids: [] };
    };

    const result = await dispatchReadyTask(db, task, { bridge: bridgeSpy });

    // The dispatch decided the claude_agent lane.
    const decided = db
      .query("SELECT payload FROM events WHERE kind = 'dispatch_decided' AND task_id = ?")
      .get(taskId) as { payload: string } | null;
    expect(decided).not.toBeNull();
    expect(JSON.parse(decided!.payload).route).toBe("claude_agent");

    // The leaf was ENQUEUED for a peer over the substrate, not executed.
    const job = db
      .query("SELECT payload FROM events WHERE kind = 'claude_agent_job_requested' AND task_id = ?")
      .get(taskId) as { payload: string } | null;
    expect(job).not.toBeNull();

    // No CC subprocess lifecycle row, and NO brain bridge subprocess ran.
    const ccDispatched = db
      .query("SELECT COUNT(*) as c FROM events WHERE kind = 'cc_dispatched' AND task_id = ?")
      .get(taskId) as { c: number };
    expect(ccDispatched.c).toBe(0);
    expect(bridgeCalls).toBe(0);
    expect(result.violations).toEqual([]);
  }, 10_000);

  test("a non-apply (design/research) leaf routes to opencode, NOT the claude_agent peer lane", async () => {
    const db = openDb(":memory:");
    const { directiveId, taskId } = await openFixtureDCountTodos(db, "/tmp");
    const ready = readyTasks(db, directiveId);
    const task = ready[0]!;

    const act = inMemoryAct({ actionResult: { result: { count: 2 } }, verifierResidual: 0 });
    const result = await dispatchReadyTask(db, task, act);
    expect(result.violations).toEqual([]);

    const decided = db
      .query("SELECT payload FROM events WHERE kind = 'dispatch_decided' AND task_id = ?")
      .get(taskId) as { payload: string } | null;
    expect(JSON.parse(decided!.payload).route).not.toBe("claude_agent");

    // No peer job was enqueued for an ordinary design/research leaf.
    const job = db
      .query("SELECT COUNT(*) as c FROM events WHERE kind = 'claude_agent_job_requested' AND task_id = ?")
      .get(taskId) as { c: number };
    expect(job.c).toBe(0);
  }, 10_000);
});

// Amendment KN78GX0J — PRE-action owner-control hard gate in the dispatcher.
describe("task_dispatcher owner-control gate (amendment KN78GX0J)", () => {
  const SANDBOX: SandboxDecl = {
    runtime: "bun", fs_read: ["**/*"], fs_write: [], net_allow: [], proc_allow: [],
    substrate_access: "none", cpu_ms: 100, wall_ms: 100, memory_mb: 64,
  };
  const mkArtifact = (db: Database, name: string) => insertArtifact(db, {
    runtime: "bun", body: name, declaredSandbox: SANDBOX, stateRoot: null,
    posteriorAlpha: 1, posteriorBeta: 1, score: 0.5, confidence: 0.3,
    recentResidualMean: 0, recentKillCount: 0, status: "admitted", name,
    fixtureInput: null, fixtureExpectedResidual: 0.2,
  });

  const seedRootTask = (db: Database, directiveId: string, taskId: string) => {
    emitEvent(db, { kind: "directive_opened", substrate_origin: "owner", directive_id: directiveId, task_id: taskId, payload: { directive_text: "do the irreversible thing" } });
    emitEvent(db, { kind: "task_node_opened", substrate_origin: "substrate_auto", directive_id: directiveId, task_id: taskId, parent_task_id: null, payload: { goal: "do the irreversible thing" } });
  };

  const irreversibleBridge = (db0: Database) => {
    let ran = false;
    const bridge = async (req: BridgeRequest, db: Database): Promise<BridgeResult> => {
      const action = mkArtifact(db, "owner_gate_action");
      const verifier = mkArtifact(db, "owner_gate_verifier");
      emitEvent(db, {
        kind: "action_predicted",
        substrate_origin: "opencode",
        directive_id: req.directiveId,
        task_id: req.taskId,
        action_artifact_id: action.id,
        verifier_artifact_id: verifier.id,
        predicted_residual: 0.05,
        payload: {
          intent: "irreversible action",
          target_path: ".",
          action_summary: "publish a public release",
          irreversible_effects: [{ kind: "publish", description: "publishes to a public registry" }],
          owner_state_belief: { uncertainty: 0.05, confidence: 0.95, latent_state: { autonomy: "high" } },
        },
        invoker: "opencode",
      });
      return { ok: true, final_response: "predicted", usage: { tokens: 0 }, emitted_event_ids: [] };
    };
    const runArtifact = async (inv: UnifiedRuntimeInvocation): Promise<UnifiedRuntimeObservation> => {
      ran = true;
      return { ok: true, result: { residual: 0 }, irreversibleEffects: [], durationMs: 0, exitCode: 0, stderrTail: "", sandboxWarnings: [] };
    };
    return { bridge, runArtifact, didRun: () => ran };
  };

  test("planned-irreversible artifact is NOT invoked when consent is missing; hidl_action_required emitted, no action_scored success", async () => {
    const db = openDb(":memory:");
    const directiveId = "dir_owner_gate";
    const taskId = newId();
    seedRootTask(db, directiveId, taskId);
    const act = irreversibleBridge(db);
    await dispatchReadyTask(db, { id: taskId, directive_id: directiveId, parent_id: null, goal: "do the irreversible thing", status: "ready" }, act);

    // The artifact MUST NOT have run.
    expect(act.didRun()).toBe(false);

    // A hidl_action_required gate was emitted.
    const gate = db.query("SELECT payload FROM events WHERE kind = 'hidl_action_required' AND task_id = ?").get(taskId) as { payload: string } | null;
    expect(gate).not.toBeNull();
    expect(JSON.parse(gate!.payload).reason).toBe("irreversible_effect_requires_consent");

    // No successful action_scored landed (residual 0 success path never ran).
    const scoredSuccess = db.query("SELECT COUNT(*) AS c FROM events WHERE kind = 'action_scored' AND task_id = ? AND residual = 0").get(taskId) as { c: number };
    expect(scoredSuccess.c).toBe(0);

    // No artifact_observed for the action artifact (proves no execution).
    const observed = db.query("SELECT COUNT(*) AS c FROM events WHERE kind = 'artifact_observed' AND task_id = ?").get(taskId) as { c: number };
    expect(observed.c).toBe(0);
  });
});

describe("deliverable compounding dispatch (Component C)", () => {
  const insertGroundbaseFixture = (db: Database, directiveId: string) => {
    const dataClass = (id: string, kind: string, body: string, targetResources?: string[], supersededBy?: string) =>
      insertArtifact(db, {
        id,
        runtime: null,
        kind,
        body,
        declaredSandbox: null,
        stateRoot: null,
        posteriorAlpha: 1,
        posteriorBeta: 1,
        score: 0.5,
        confidence: 0.3,
        recentResidualMean: 0,
        recentKillCount: 0,
        status: "admitted",
        name: id,
        fixtureInput: null,
        fixtureExpectedResidual: null,
        targetResources: targetResources ?? null,
        supersededBy: supersededBy ?? null,
      });
    dataClass("gb_body", "deliverable_body", "Prior-best report: intro, summary, analysis.");
    dataClass("gb_outline", "deliverable_outline_lock", "1. Intro\n2. Summary\n3. Analysis");
    dataClass("gb_reqs", "deliverable_requirements_ledger", JSON.stringify({ requirements: ["include analysis", "cite sources"] }));
    dataClass(
      "gb_root",
      "deliverable_groundbase",
      JSON.stringify({
        current_best_artifact_id: "gb_body",
        locked_outline_artifact_id: "gb_outline",
        requirements_ledger_artifact_id: "gb_reqs",
        satisfied_requirement_ids: ["r1", "r2"],
      }),
      [`ledger:directive/${directiveId}`],
    );
  };

  test("dispatcher resolves the groundbase via the store selector and inlines it into the brain prompt", async () => {
    const db = openDb(":memory:");
    const { directiveId, taskId } = await openFixtureDCountTodos(db, "/tmp");
    insertGroundbaseFixture(db, directiveId);
    const task = readyTasks(db, directiveId)[0]!;

    let capturedPrompt = "";
    const base = inMemoryAct({ actionResult: { result: { count: 2 } }, verifierResidual: 0 });
    const bridge = async (req: BridgeRequest, innerDb: Database): Promise<BridgeResult> => {
      capturedPrompt = req.prompt;
      return base.bridge(req, innerDb);
    };

    await dispatchReadyTask(db, task, { bridge, runArtifact: base.runArtifact });
    // Server-side inlining: the brain prompt carries the prior-best body +
    // locked outline + cumulative requirements — no filesystem read required.
    expect(capturedPrompt).toContain("DELIVERABLE GROUNDBASE");
    expect(capturedPrompt).toContain("intro, summary, analysis");
    expect(capturedPrompt).toContain("3. Analysis");
    expect(capturedPrompt).toContain("include analysis");
  });

  test("residual-driven refinement edge carries prior-best artifact id + deliverable semantics + targeted-delta contract", async () => {
    const db = openDb(":memory:");
    const { directiveId, taskId } = await openFixtureDCountTodos(db, "/tmp");
    insertGroundbaseFixture(db, directiveId);
    const task = readyTasks(db, directiveId)[0]!;

    // High residual → dispatcher opens a refinement edge (depth 0, below cap).
    const act = inMemoryAct({ actionResult: { result: { count: 2 } }, verifierResidual: 0.6 });
    await dispatchReadyTask(db, task, act);

    const edges = db
      .query("SELECT payload FROM events WHERE kind = 'task_edge_recorded' AND directive_id = ?")
      .all(directiveId) as Array<{ payload: string }>;
    const refines = edges
      .map((e) => JSON.parse(e.payload) as Record<string, unknown>)
      .find((p) => p.kind === "refines" && p.from_task === task.id);
    expect(refines).toBeDefined();
    expect(refines!.refinement_semantics).toBe("deliverable_compounding_v1");
    expect(refines!.base_artifact_id).toBe("gb_body");
    expect(refines!.preserve_previously_satisfied_requirements).toBe(true);
    expect(refines!.change_scope).toBe("targeted_delta_only");
    expect(refines!.requirements_count).toBe(2);

    // The refinement task goal carries the deliverable refinement contract.
    const refinedTaskId = refines!.to_task as string;
    const refinedNode = db
      .query("SELECT payload FROM events WHERE kind = 'task_node_opened' AND task_id = ?")
      .get(refinedTaskId) as { payload: string } | null;
    expect(refinedNode).not.toBeNull();
    const goal = (JSON.parse(refinedNode!.payload) as { goal: string }).goal;
    expect(goal).toContain("DELIVERABLE REFINEMENT CONTRACT");
    expect(goal).toContain("current_best_artifact_id=gb_body");
    expect(goal).toContain("supersedes=gb_body");
  });

  // MBZC8AZP / E3X6EH6D — admission guard. A brain-dispatch must NEVER fire for
  // a task whose `task_node_opened` ledger row is absent. Pre-fix, brain_dispatched
  // fired before composePrompt, the composer returned a `TASK NOT FOUND` stub, and
  // the bridge was called on garbage — surfacing as bursts of
  // bridge_failed: prompt_composer_task_not_found / dispatch_zombie_missing_task.
  test("admission guard: missing task_node_opened → dispatcher_violation, NO brain_dispatched, NO bridge call", async () => {
    const db = openDb(":memory:");
    // A real directive exists, but the task node was never opened (or was abandoned
    // and its row is gone): synthesize a TaskNode whose id has no task_node_opened row.
    emitEvent(db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: "dir_guard",
      task_id: "root_guard",
      payload: { goal: "guard directive" } as JsonValue,
      invoker: "owner",
    });
    const ghostTaskId = newId();
    const ghost = {
      id: ghostTaskId,
      directive_id: "dir_guard",
      parent_id: null,
      goal: "ghost task with no task_node_opened row",
      status: "ready" as const,
    };

    let bridgeCalled = false;
    const spyBridge = async (_req: BridgeRequest, _db: Database): Promise<BridgeResult> => {
      bridgeCalled = true;
      return { ok: true, final_response: "should not run", usage: { tokens: 0 }, emitted_event_ids: [] };
    };

    const result = await dispatchReadyTask(db, ghost, {
      bridge: spyBridge as unknown as typeof dispatchReadyTask extends (db: unknown, t: unknown, d: { bridge?: infer B }) => unknown ? B : never,
    });

    // Bridge was never invoked.
    expect(bridgeCalled).toBe(false);
    // No brain_dispatched event for the ghost task.
    const brainDispatched = db
      .query("SELECT COUNT(*) as c FROM events WHERE kind = 'brain_dispatched' AND task_id = ?")
      .get(ghostTaskId) as { c: number };
    expect(brainDispatched.c).toBe(0);
    // A dispatcher_violation WAS emitted with the missing-node failure_kind.
    const violation = db
      .query("SELECT failure_kind, payload FROM events WHERE kind = 'dispatcher_violation' AND task_id = ?")
      .get(ghostTaskId) as { failure_kind: string; payload: string } | null;
    expect(violation).not.toBeNull();
    expect(violation!.failure_kind).toBe("missing_task_node_opened_for_brain_dispatch");
    // The returned violations array carries the reason; no bridge_result was set.
    expect(result.violations).toContain("missing_task_node_opened_for_brain_dispatch");
    expect(result.bridge_result).toBeUndefined();
    // No prompt was composed → no bridge_invoked / bridge_failed / bridge_completed.
    const promptSide = db
      .query("SELECT COUNT(*) as c FROM events WHERE kind IN ('bridge_invoked','bridge_failed','bridge_completed') AND task_id = ?")
      .get(ghostTaskId) as { c: number };
    expect(promptSide.c).toBe(0);
  });
});
