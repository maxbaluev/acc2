// acc2 substrate views tests — verifies every CREATE VIEW IF NOT
// EXISTS DDL applies on a fresh :memory: db, and that the accessors
// project rows back the way the brain / extractors expect.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "./db";
import {
  appliedLessonEffectiveness,
  artifactRouting,
  codeArtifactRegistry,
  directiveConflicts,
  failureCounts,
  lessonImplementationStatus,
  lessonImplementerQueue,
  originPromotionRanking,
  ownerConversation,
  readyTasks,
  rollingReviewDue,
  runViews,
  taskGraphFor,
  watchEdgeObservations,
} from "./views";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const newId = (): string =>
  crypto.randomUUID().replace(/-/g, "").slice(0, 26).toUpperCase();
const nowIso = (): string => new Date().toISOString();

// Ts-monotonic helper so tests order rows deterministically.
let _tsCounter = 0;
const tickTs = (): string => {
  _tsCounter += 1;
  return new Date(Date.UTC(2026, 0, 1, 0, 0, _tsCounter)).toISOString();
};

const insertEvent = (
  db: ReturnType<typeof openDb>,
  fields: {
    kind: string;
    directive_id: string;
    task_id: string;
    parent_task_id?: string | null;
    loop_id?: string;
    substrate_origin?: string;
    payload?: unknown;
    context_refs?: string[];
    failure_kind?: string | null;
    residual?: number | null;
    predicted_residual?: number | null;
    action_artifact_id?: string | null;
    verifier_artifact_id?: string | null;
    ts?: string;
  },
): string => {
  const id = newId();
  db.run(
    `INSERT INTO events (
       id, ts, directive_id, task_id, parent_task_id, loop_id,
       substrate_origin, kind, payload, context_refs, failure_kind, residual,
       predicted_residual, action_artifact_id, verifier_artifact_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      fields.ts ?? tickTs(),
      fields.directive_id,
      fields.task_id,
      fields.parent_task_id ?? null,
      fields.loop_id ?? "loop_t",
      fields.substrate_origin ?? "claude_root",
      fields.kind,
      JSON.stringify(fields.payload ?? {}),
      JSON.stringify(fields.context_refs ?? []),
      fields.failure_kind ?? null,
      fields.residual ?? null,
      fields.predicted_residual ?? null,
      fields.action_artifact_id ?? null,
      fields.verifier_artifact_id ?? null,
    ],
  );
  return id;
};

describe("runViews", () => {
  test("creates every named view on a fresh :memory: db without error", () => {
    const db = openDb(":memory:");
    runViews(db);
    const views = (db
      .query("SELECT name FROM sqlite_master WHERE type='view' ORDER BY name")
      .all() as Array<{ name: string }>).map((r) => r.name);
    for (const expected of [
      "artifact_routing_view",
      "applied_lesson_effectiveness_view",
      "code_artifact_registry_view",
      "contradictory_candidates_view",
      "directive_conflicts_view",
      "embedding_index_view",
      "failure_view",
      "irreversible_effects_view",
      "lesson_implementation_status_view",
      "lesson_implementer_queue_view",
      "owner_conversation_view",
      "ready_tasks_view",
      "rolling_review_due_view",
      "task_graph_view",
      "watch_edge_observations_view",
    ]) {
      expect(views).toContain(expected);
    }
  });

  test("idempotent — running twice does not throw", () => {
    const db = openDb(":memory:");
    runViews(db);
    expect(() => runViews(db)).not.toThrow();
  });
});

describe("task_graph_view + taskGraphFor", () => {
  test("returns node + edge rows for one directive's DAG", () => {
    const db = openDb(":memory:");
    runViews(db);

    insertEvent(db, {
      kind: "task_node_opened",
      directive_id: "d1",
      task_id: "t_a",
      payload: { goal: "alpha" },
    });
    insertEvent(db, {
      kind: "task_node_opened",
      directive_id: "d1",
      task_id: "t_b",
      payload: { goal: "beta" },
    });
    insertEvent(db, {
      kind: "task_edge_recorded",
      directive_id: "d1",
      task_id: "t_b",
      payload: { from: "t_a", to: "t_b", kind: "requires" },
    });
    // Unrelated directive's row must NOT appear in the d1 projection.
    insertEvent(db, {
      kind: "task_node_opened",
      directive_id: "d2",
      task_id: "t_z",
      payload: { goal: "zulu" },
    });

    const rows = taskGraphFor(db, "d1");
    const nodes = rows.filter((r) => r.row_kind === "node");
    const edges = rows.filter((r) => r.row_kind === "edge");
    expect(nodes).toHaveLength(2);
    expect(edges).toHaveLength(1);
    expect(nodes.map((n) => n.task_id).sort()).toEqual(["t_a", "t_b"]);
    expect(edges[0]!.payload).toMatchObject({ from: "t_a", to: "t_b", kind: "requires" });
  });
});

describe("watch_edge_observations_view + watchEdgeObservations", () => {
  test("surfaces latest upstream observation for a downstream watcher", () => {
    const db = openDb(":memory:");
    runViews(db);

    // A watches→ B; A emits two action_scored events; the view returns the
    // most-recent one.
    insertEvent(db, { kind: "task_node_opened", directive_id: "d1", task_id: "t_a" });
    insertEvent(db, { kind: "task_node_opened", directive_id: "d1", task_id: "t_b" });
    insertEvent(db, {
      kind: "task_edge_recorded",
      directive_id: "d1",
      task_id: "t_b",
      payload: { from_task: "t_a", to_task: "t_b", kind: "watches", consistency_mode: "snapshot_now" },
    });
    insertEvent(db, {
      kind: "action_scored",
      directive_id: "d1",
      task_id: "t_a",
      payload: { iter: 1, value: "early" },
    });
    insertEvent(db, {
      kind: "action_scored",
      directive_id: "d1",
      task_id: "t_a",
      payload: { iter: 2, value: "LATEST_PROBE" },
    });

    const rows = watchEdgeObservations(db, "t_b");
    // One row per (upstream, event_kind): task_node_opened + action_scored.
    // The action_scored row carries the LATEST of the two iterations.
    const scored = rows.find((r) => r.event_kind === "action_scored");
    expect(scored).toBeDefined();
    expect(scored!.downstream_task_id).toBe("t_b");
    expect(scored!.upstream_task_id).toBe("t_a");
    expect(scored!.consistency_mode).toBe("snapshot_now");
    expect((scored!.payload as Record<string, unknown>).value).toBe("LATEST_PROBE");
  });

  test("returns empty result when no watch edges target the task", () => {
    const db = openDb(":memory:");
    runViews(db);
    insertEvent(db, { kind: "task_node_opened", directive_id: "d1", task_id: "t_solo" });
    insertEvent(db, {
      kind: "action_scored",
      directive_id: "d1",
      task_id: "t_solo",
      payload: { iter: 1 },
    });
    expect(watchEdgeObservations(db, "t_solo")).toEqual([]);
  });

  test("multiple watched upstreams each contribute a row per event_kind", () => {
    const db = openDb(":memory:");
    runViews(db);
    for (const t of ["t_u1", "t_u2", "t_down"]) {
      insertEvent(db, { kind: "task_node_opened", directive_id: "d1", task_id: t });
    }
    insertEvent(db, {
      kind: "task_edge_recorded",
      directive_id: "d1",
      task_id: "t_down",
      payload: { from_task: "t_u1", to_task: "t_down", kind: "watches", consistency_mode: "snapshot_now" },
    });
    insertEvent(db, {
      kind: "task_edge_recorded",
      directive_id: "d1",
      task_id: "t_down",
      payload: { from_task: "t_u2", to_task: "t_down", kind: "watches", consistency_mode: "snapshot_now" },
    });
    insertEvent(db, {
      kind: "artifact_observed",
      directive_id: "d1",
      task_id: "t_u1",
      payload: { from: "u1" },
    });
    insertEvent(db, {
      kind: "artifact_observed",
      directive_id: "d1",
      task_id: "t_u2",
      payload: { from: "u2" },
    });

    const rows = watchEdgeObservations(db, "t_down");
    // One row per (upstream, event_kind). The task_node_opened on each
    // upstream + the artifact_observed both surface; the unique upstream
    // ids are still exactly {t_u1, t_u2}.
    const upstreams = Array.from(new Set(rows.map((r) => r.upstream_task_id))).sort();
    expect(upstreams).toEqual(["t_u1", "t_u2"]);
    const observed = rows.filter((r) => r.event_kind === "artifact_observed");
    expect(observed.map((r) => r.upstream_task_id).sort()).toEqual(["t_u1", "t_u2"]);
  });
});

describe("ready_tasks_view + readyTasks", () => {
  test("excludes tasks whose 'requires' upstream has not committed", () => {
    const db = openDb(":memory:");
    runViews(db);

    insertEvent(db, { kind: "task_node_opened", directive_id: "d1", task_id: "t_a" });
    insertEvent(db, { kind: "task_node_opened", directive_id: "d1", task_id: "t_b" });
    insertEvent(db, {
      kind: "task_edge_recorded",
      directive_id: "d1",
      task_id: "t_b",
      payload: { from: "t_a", to: "t_b", kind: "requires" },
    });

    // Before t_a commits: only t_a is ready (t_b is blocked).
    let ready = readyTasks(db);
    expect(ready.map((r) => r.task_id).sort()).toEqual(["t_a"]);

    insertEvent(db, { kind: "task_committed", directive_id: "d1", task_id: "t_a" });

    // After t_a commits: t_b is ready (t_a is removed because it has committed).
    ready = readyTasks(db);
    expect(ready.map((r) => r.task_id).sort()).toEqual(["t_b"]);
  });

  test("tasks with no incoming edges are ready by default", () => {
    const db = openDb(":memory:");
    runViews(db);
    insertEvent(db, { kind: "task_node_opened", directive_id: "d1", task_id: "t_lonely" });
    const ready = readyTasks(db);
    expect(ready.map((r) => r.task_id)).toContain("t_lonely");
  });
});

describe("code_artifact_registry_view + codeArtifactRegistry", () => {
  test("orders by score DESC, only admitted + promoted", () => {
    const db = openDb(":memory:");
    runViews(db);

    const insertArtifact = (id: string, score: number, status: string) => {
      const ts = nowIso();
      db.run(
        `INSERT INTO code_artifact (
           id, runtime, body, declared_sandbox, state_root,
           posterior_alpha, posterior_beta, score, confidence,
           recent_residual_mean, recent_kill_count, status, name,
           fixture_input, fixture_expected_residual,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          "bun",
          "// stub",
          JSON.stringify({ runtime: "bun", cpu_ms: 1000, wall_ms: 1000, memory_mb: 64 }),
          "state/x",
          1,
          1,
          score,
          0.5,
          0,
          0,
          status,
          id,
          "{}",
          0,
          ts,
          ts,
        ],
      );
    };

    insertArtifact("a_low", 0.20, "admitted");
    insertArtifact("a_high", 0.95, "promoted");
    insertArtifact("a_mid", 0.55, "admitted");
    insertArtifact("a_quarantined", 0.99, "quarantined"); // must NOT appear

    const reg = codeArtifactRegistry(db);
    const ids = reg.map((r) => r.id);
    expect(ids).toEqual(["a_high", "a_mid", "a_low"]);
    expect(ids).not.toContain("a_quarantined");

    // Runtime filter exercise.
    const filtered = codeArtifactRegistry(db, "bun");
    expect(filtered.length).toBe(3);
    expect(codeArtifactRegistry(db, "uv").length).toBe(0);
  });
});

describe("artifact_routing_view + artifactRouting", () => {
  test("ranks by score × (1 - residual_mean)", () => {
    const db = openDb(":memory:");
    runViews(db);
    const ts = nowIso();
    const insert = (id: string, score: number, residualMean: number) =>
      db.run(
        `INSERT INTO code_artifact (
           id, runtime, body, declared_sandbox, state_root,
           posterior_alpha, posterior_beta, score, confidence,
           recent_residual_mean, recent_kill_count, status, name,
           fixture_input, fixture_expected_residual,
           created_at, updated_at
         ) VALUES (?, 'bun', '//', '{}', 'st', 1, 1, ?, 0.5, ?, 0, 'admitted', ?, '{}', 0, ?, ?)`,
        [id, score, residualMean, id, ts, ts],
      );
    insert("hi_score_hi_resid", 0.90, 0.80); // routing = 0.18
    insert("mid_score_lo_resid", 0.60, 0.05); // routing = 0.57
    const ranked = artifactRouting(db);
    expect(ranked[0]!.id).toBe("mid_score_lo_resid");
    expect(ranked[1]!.id).toBe("hi_score_hi_resid");
    expect(ranked[0]!.routing_score).toBeGreaterThan(ranked[1]!.routing_score);
  });
});

describe("failure_view + failureCounts", () => {
  test("tallies task_failed events by failure_kind", () => {
    const db = openDb(":memory:");
    runViews(db);
    insertEvent(db, {
      kind: "task_failed",
      directive_id: "d1",
      task_id: "t1",
      failure_kind: "verification_high_residual",
    });
    insertEvent(db, {
      kind: "task_failed",
      directive_id: "d1",
      task_id: "t2",
      failure_kind: "verification_high_residual",
    });
    insertEvent(db, {
      kind: "task_failed",
      directive_id: "d1",
      task_id: "t3",
      failure_kind: "bridge_timeout",
    });
    const fc = failureCounts(db);
    const byKind = new Map(fc.map((r) => [r.failure_kind, r.count]));
    expect(byKind.get("verification_high_residual")).toBe(2);
    expect(byKind.get("bridge_timeout")).toBe(1);
  });
});

describe("owner_conversation_view + ownerConversation", () => {
  test("only includes owner_input_received + owner_decision_recorded, in ts order", () => {
    const db = openDb(":memory:");
    runViews(db);
    const tsEarly = new Date(Date.UTC(2026, 0, 1, 0, 0, 1)).toISOString();
    const tsMid   = new Date(Date.UTC(2026, 0, 1, 0, 0, 2)).toISOString();
    const tsLate  = new Date(Date.UTC(2026, 0, 1, 0, 0, 3)).toISOString();

    insertEvent(db, { kind: "owner_decision_recorded", directive_id: "d1", task_id: "t1", substrate_origin: "owner", ts: tsLate });
    insertEvent(db, { kind: "owner_input_received",    directive_id: "d1", task_id: "t1", substrate_origin: "owner", ts: tsEarly });
    insertEvent(db, { kind: "task_node_opened",         directive_id: "d1", task_id: "t2", ts: tsMid });

    const rows = ownerConversation(db);
    expect(rows.map((r) => r.kind)).toEqual(["owner_input_received", "owner_decision_recorded"]);
    expect(rows.map((r) => r.ts)).toEqual([tsEarly, tsLate]);
  });
});

describe("directive_conflicts_view + directiveConflicts (Phase DAG follow-up)", () => {
  test("projects from_directive / to_directive / interaction columns from payload", () => {
    const db = openDb(":memory:");
    runViews(db);
    insertEvent(db, {
      kind: "directive_interference_edge",
      directive_id: "d_from",
      task_id: "d_from",
      payload: {
        from_directive: "d_from",
        to_directive: "d_to",
        interaction: "mutual_exclusion",
        reason: "shared budget",
      },
    });
    const rows = directiveConflicts(db);
    expect(rows.length).toBe(1);
    expect(rows[0]!.from_directive).toBe("d_from");
    expect(rows[0]!.to_directive).toBe("d_to");
    expect(rows[0]!.interaction).toBe("mutual_exclusion");
    // Filter by directiveId should return rows where it appears on either side.
    expect(directiveConflicts(db, "d_to").length).toBe(1);
    expect(directiveConflicts(db, "d_other").length).toBe(0);
  });

  test("falls back to payload.kind when payload.interaction is absent (Phase I emitters)", () => {
    const db = openDb(":memory:");
    runViews(db);
    insertEvent(db, {
      kind: "directive_interference_edge",
      directive_id: "d_a",
      task_id: "d_a",
      payload: { from_directive: "d_a", to_directive: "d_b", kind: "blocks" },
    });
    const rows = directiveConflicts(db);
    expect(rows.length).toBe(1);
    expect(rows[0]!.interaction).toBe("blocks");
  });
});

describe("rolling_review_due_view + rollingReviewDue (Phase DAG follow-up)", () => {
  test("surfaces every rolling_active directive with a past_due boolean", () => {
    const db = openDb(":memory:");
    runViews(db);
    // Past-due directive.
    insertEvent(db, {
      kind: "directive_opened",
      directive_id: "d_past",
      task_id: "d_past",
      payload: {
        lifecycle: "rolling_active",
        review_cadence: "weekly",
        next_review_due: "2020-01-01T00:00:00.000Z",
      },
    });
    // Future-due directive (now is 2026-05-14 per test fixtures).
    insertEvent(db, {
      kind: "directive_opened",
      directive_id: "d_future",
      task_id: "d_future",
      payload: {
        lifecycle: "rolling_active",
        review_cadence: "monthly",
        next_review_due: "2099-01-01T00:00:00.000Z",
      },
    });
    const rows = rollingReviewDue(db);
    const byId = new Map(rows.map((r) => [r.directive_id, r]));
    expect(byId.has("d_past")).toBe(true);
    expect(byId.has("d_future")).toBe(true);
    expect(byId.get("d_past")!.past_due).toBe(true);
    expect(byId.get("d_future")!.past_due).toBe(false);
  });
});

describe("origin_promotion_by_directive_view + originPromotionRanking (Phase DAG follow-up)", () => {
  test("ranks origins by promoted count for a goal_shape", () => {
    const db = openDb(":memory:");
    runViews(db);
    // Two directives — both bucketing into the same goal_shape under the
    // synthetic hash below.
    insertEvent(db, {
      kind: "directive_opened",
      directive_id: "d_x",
      task_id: "d_x",
      payload: { directive_text: "shape-alpha task one" },
    });
    insertEvent(db, {
      kind: "directive_opened",
      directive_id: "d_y",
      task_id: "d_y",
      payload: { directive_text: "shape-alpha task two" },
    });
    // brain promoted 3 times under d_x; claude promoted 1 time under d_y.
    for (let i = 0; i < 3; i++) {
      insertEvent(db, {
        kind: "knowledge_promoted",
        directive_id: "d_x",
        task_id: "d_x",
        substrate_origin: "opencode",
        payload: { candidate_id: `c${i}` },
      });
    }
    insertEvent(db, {
      kind: "knowledge_promoted",
      directive_id: "d_y",
      task_id: "d_y",
      substrate_origin: "claude_root",
      payload: { candidate_id: "c_y" },
    });

    // Synthetic shape hasher: all directives map to "shape_alpha".
    const goalShape = (_: string): string => "shape_alpha";
    const ranking = originPromotionRanking(db, goalShape, "shape_alpha");
    expect(ranking.length).toBe(2);
    expect(ranking[0]!.substrate_origin).toBe("opencode");
    expect(ranking[0]!.promoted_count).toBe(3);
    expect(ranking[1]!.substrate_origin).toBe("claude_root");
    expect(ranking[1]!.promoted_count).toBe(1);
  });

  test("returns empty array when no rows match the target shape", () => {
    const db = openDb(":memory:");
    runViews(db);
    insertEvent(db, {
      kind: "directive_opened",
      directive_id: "d_x",
      task_id: "d_x",
      payload: { directive_text: "irrelevant" },
    });
    insertEvent(db, {
      kind: "knowledge_promoted",
      directive_id: "d_x",
      task_id: "d_x",
      substrate_origin: "opencode",
      payload: {},
    });
    const goalShape = (_: string): string => "wrong_shape";
    const ranking = originPromotionRanking(db, goalShape, "target_shape_none");
    expect(ranking.length).toBe(0);
  });
});

describe("lesson implementer flywheel views", () => {
  test("queue derives owner gate, auto-apply eligibility, and hazards", () => {
    const db = openDb(":memory:");
    runViews(db);

    const gated = insertEvent(db, {
      kind: "contract_amendment_proposed",
      directive_id: "d_contract",
      task_id: "t_contract",
      payload: {
        target: "docs/v2-design.md",
        anchor: "§11.5",
        proposed_behavior: { file_path: "docs/v2-design.md", anchor: "§11.5", diff: "@@" },
      },
    });
    insertEvent(db, {
      kind: "owner_decision_recorded",
      directive_id: "d_contract",
      task_id: "t_contract",
      payload: { source_event_id: gated, decision: "approved" },
      context_refs: [gated],
    });

    insertEvent(db, {
      kind: "contract_amendment_proposed",
      directive_id: "d_runtime",
      task_id: "t_runtime",
      payload: {
        target: "runtime/prompt_composer.ts",
        anchor: "WORKFLOW_TEXT",
        proposed_behavior: { file_path: "runtime/prompt_composer.ts", anchor: "WORKFLOW_TEXT", diff: "@@" },
      },
    });

    insertEvent(db, {
      kind: "contract_amendment_proposed",
      directive_id: "d_hazard",
      task_id: "t_hazard",
      payload: {
        target: "runtime/task_dispatcher.ts",
        anchor: "dispatch",
        proposed_behavior: { file_path: "runtime/task_dispatcher.ts", anchor: "dispatch", diff: "@@" },
      },
    });
    insertEvent(db, {
      kind: "dispatcher_violation",
      directive_id: "d_hazard",
      task_id: "t_hazard",
      payload: { failure_kind: "cycle_1_only_breach" },
    });

    const rows = lessonImplementerQueue(db);
    const byDirective = new Map(rows.map((r) => [r.directive_id, r]));
    expect(byDirective.get("d_contract")!.owner_gate_required).toBe(true);
    expect(byDirective.get("d_contract")!.owner_approved).toBe(true);
    expect(byDirective.get("d_runtime")!.auto_apply_eligible).toBe(true);
    expect(byDirective.get("d_hazard")!.auto_apply_eligible).toBe(false);
    expect(byDirective.get("d_hazard")!.trajectory_hazard_count).toBe(1);
  });

  test("status projects requested, predicted, scored, applied, and committed transitions", () => {
    const db = openDb(":memory:");
    runViews(db);
    const source = insertEvent(db, {
      kind: "lesson_extracted",
      directive_id: "d_apply",
      task_id: "t_apply",
      payload: { lesson_kind: "verifier_gap", summary: "tighten verifier" },
    });
    const requested = insertEvent(db, {
      kind: "lesson_apply_requested",
      directive_id: "d_apply",
      task_id: "t_apply",
      payload: { source_event_id: source },
      context_refs: [source],
    });
    const predicted = insertEvent(db, {
      kind: "action_predicted",
      directive_id: "d_apply",
      task_id: "t_apply",
      payload: { source_event_id: source },
      context_refs: [source, requested],
      action_artifact_id: "apply_action",
      verifier_artifact_id: "apply_verifier",
      predicted_residual: 0.2,
    });
    const scored = insertEvent(db, {
      kind: "action_scored",
      directive_id: "d_apply",
      task_id: "t_apply",
      payload: { source_event_id: source },
      context_refs: [source, requested],
      residual: 0.1,
    });
    insertEvent(db, {
      kind: "lesson_applied",
      directive_id: "d_apply",
      task_id: "t_apply",
      payload: { source_event_id: source, status: "applied", commit_sha: "abcdef1234" },
      context_refs: [source, scored],
    });
    insertEvent(db, {
      kind: "applied_change_committed",
      directive_id: "d_apply",
      task_id: "t_apply",
      payload: { source_event_id: source, status: "applied", commit_sha: "abcdef1234", residual: 0.1 },
      context_refs: [source, scored],
      residual: 0.1,
    });

    const row = lessonImplementationStatus(db).find((r) => r.source_event_id === source)!;
    expect(row.request_event_id).toBe(requested);
    expect(row.action_event_id).toBe(predicted);
    expect(row.action_artifact_id).toBe("apply_action");
    expect(row.verifier_artifact_id).toBe("apply_verifier");
    expect(row.predicted_residual).toBe(0.2);
    expect(row.scored_event_id).toBe(scored);
    expect(row.verifier_passed).toBe(true);
    expect(row.flywheel_status).toBe("committed");
    expect(row.commit_sha).toBe("abcdef1234");
  });

  test("queue and status do not treat high-residual attempts as committed", () => {
    const db = openDb(":memory:");
    runViews(db);
    const source = insertEvent(db, {
      kind: "lesson_extracted",
      directive_id: "d_apply_high",
      task_id: "t_apply_high",
      payload: { lesson_kind: "verifier_gap", summary: "tighten verifier" },
    });
    insertEvent(db, {
      kind: "lesson_apply_requested",
      directive_id: "d_apply_high",
      task_id: "t_apply_high",
      payload: { source_event_id: source },
      context_refs: [source],
    });
    insertEvent(db, {
      kind: "action_predicted",
      directive_id: "d_apply_high",
      task_id: "t_apply_high",
      payload: { source_event_id: source },
      context_refs: [source],
      predicted_residual: 0.2,
    });
    insertEvent(db, {
      kind: "action_scored",
      directive_id: "d_apply_high",
      task_id: "t_apply_high",
      payload: { source_event_id: source },
      context_refs: [source],
      residual: 0.3,
    });

    const row = lessonImplementationStatus(db).find((r) => r.source_event_id === source)!;
    expect(row.verifier_passed).toBe(false);
    expect(row.committed_event_id).toBeNull();
    expect(row.flywheel_status).toBe("verified");
    expect(lessonImplementerQueue(db).some((r) => r.source_event_id === source)).toBe(true);
  });

  test("effectiveness marks compounded when the next cited trajectory is cheaper", () => {
    const db = openDb(":memory:");
    runViews(db);
    const source = insertEvent(db, {
      kind: "lesson_extracted",
      directive_id: "d_source",
      task_id: "t_source",
      payload: { lesson_kind: "recipe_candidate", summary: "cache the shape" },
    });
    for (const task_id of ["t_source", "t_source_a", "t_source_b"]) {
      insertEvent(db, { kind: "task_node_opened", directive_id: "d_source", task_id });
    }
    insertEvent(db, {
      kind: "action_scored",
      directive_id: "d_source",
      task_id: "t_source",
      payload: {},
      residual: 0.4,
    });
    insertEvent(db, {
      kind: "applied_change_committed",
      directive_id: "d_source",
      task_id: "t_source",
      payload: { source_event_id: source, status: "applied", residual: 0.05 },
      context_refs: [source],
      residual: 0.05,
    });

    insertEvent(db, { kind: "task_node_opened", directive_id: "d_next", task_id: "t_next" });
    insertEvent(db, {
      kind: "action_scored",
      directive_id: "d_next",
      task_id: "t_next",
      payload: { source_event_id: source, recipe_replayed: true },
      context_refs: [source],
      residual: 0.2,
    });

    const row = appliedLessonEffectiveness(db).find((r) => r.source_event_id === source)!;
    expect(row.compounded).toBe(true);
    expect(row.tier0_replay_hit).toBe(true);
    expect(row.residual_delta).toBeCloseTo(0.2);
    expect(row.dag_node_delta).toBe(2);
  });
});
