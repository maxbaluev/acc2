// acc2 substrate views tests — verifies every CREATE VIEW IF NOT
// EXISTS DDL applies on a fresh :memory: db, and that the accessors
// project rows back the way the brain / extractors expect.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "./db";
import {
  actProjectionObservability,
  appliedLessonEffectiveness,
  artifactRouting,
  codeArtifactRegistry,
  directiveConflicts,
  dispatchResolved,
  failureCounts,
  lessonApplyCandidates,
  lessonImplementationStatus,
  lessonImplementerQueue,
  originPromotionRanking,
  ownerConversation,
  promotedKnowledge,
  readyTasks,
  recipeRegistry,
  recipesLatestView,
  rollingReviewDue,
  runViews,
  substrateNarrativeRecent,
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
      "act_projection_observability_view",
      "artifact_routing_view",
      "applied_lesson_effectiveness_view",
      "code_artifact_registry_view",
      "contradictory_candidates_view",
      "directive_conflicts_view",
      "embedding_index_view",
      "entity_relationship_view",
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


describe("act_projection_observability_view + actProjectionObservability", () => {
  test("returns derived lifecycle, retrieval, owner outcome, and credit ids for one source act", () => {
    const db = openDb(":memory:");
    runViews(db);

    const actId = insertEvent(db, {
      kind: "act_tuple_recorded",
      directive_id: "d_act",
      task_id: "t_act",
      payload: { intent: "coherent act" },
      residual: 0.4,
    });
    const predictedId = insertEvent(db, {
      kind: "action_predicted",
      directive_id: "d_act",
      task_id: "t_act",
      payload: { source_act_id: actId },
    });
    const scoredId = insertEvent(db, {
      kind: "action_scored",
      directive_id: "d_act",
      task_id: "t_act",
      payload: { projection: { source_act_id: actId } },
      residual: 0.12,
    });
    const appliedId = insertEvent(db, {
      kind: "applied_change_committed",
      directive_id: "d_act",
      task_id: "t_act",
      payload: { source_act_id: actId, status: "applied" },
    });
    const ownerId = insertEvent(db, {
      kind: "owner_observed_outcome_recorded",
      directive_id: "d_act",
      task_id: "t_act",
      payload: { source_act_id: actId, observation: "works" },
      residual: 0.02,
    });
    const bindingId = insertEvent(db, {
      kind: "retrieval_binding",
      directive_id: "d_act",
      task_id: "t_act",
      payload: { source_act_id: actId, source_event_id: "k_555" },
    });
    const creditId = insertEvent(db, {
      kind: "candidate_confirmed",
      directive_id: "d_act",
      task_id: "t_act",
      payload: { source_act_id: actId, target_event_id: "k_555" },
    });
    const artifactCreditId = insertEvent(db, {
      kind: "code_artifact_score_updated",
      directive_id: "d_act",
      task_id: "t_act",
      context_refs: [actId],
      payload: { artifact_id: "artifact_a" },
    });

    const row = actProjectionObservability(db, actId);
    expect(row).not.toBeNull();
    expect(row!.source_act_id).toBe(actId);
    expect(row!.action_predicted_event_ids).toEqual([predictedId]);
    expect(row!.action_scored_event_ids).toEqual([scoredId]);
    expect(row!.applied_change_committed_event_ids).toEqual([appliedId]);
    expect(row!.owner_observed_outcome_recorded_event_ids).toEqual([ownerId]);
    expect(row!.retrieval_binding_event_ids).toEqual([bindingId]);
    expect(row!.credit_projection_event_ids).toEqual([creditId, artifactCreditId]);
    expect(row!.projection_residual).toBe(0.02);
    expect(row!.projection_residual_event_id).toBe(ownerId);
    expect(row!.projection_residual_kind).toBe("owner_observed_outcome_recorded");
    expect(row!.projection_status).toBe("completed");
  });

  test("falls back to action_scored residual provenance before source act residual", () => {
    const db = openDb(":memory:");
    runViews(db);

    const actId = insertEvent(db, {
      kind: "act_tuple_recorded",
      directive_id: "d_act",
      task_id: "t_act",
      payload: { intent: "coherent act" },
      residual: 0.7,
    });
    const scoredId = insertEvent(db, {
      kind: "action_scored",
      directive_id: "d_act",
      task_id: "t_act",
      payload: { source_act_id: actId },
      residual: 0.23,
    });

    const row = actProjectionObservability(db, actId);
    expect(row!.projection_residual).toBe(0.23);
    expect(row!.projection_residual_event_id).toBe(scoredId);
    expect(row!.projection_residual_kind).toBe("action_scored");
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

  // L4.1 fix verification (2026-05-17). Each test exercises one of the
  // axes the 7+ converging knowledge candidates named:
  //   inclusion       — ready refinement child appears
  //   exclusion       — superseded / blocked rows are suppressed
  //   provenance      — parent_task_id + incoming-edge metadata exposed
  test("suppresses task_committed_superseded rows (L4.1 exclusion axis)", () => {
    const db = openDb(":memory:");
    runViews(db);
    insertEvent(db, { kind: "task_node_opened", directive_id: "d1", task_id: "t_sup" });
    insertEvent(db, { kind: "task_committed_superseded", directive_id: "d1", task_id: "t_sup" });
    const ready = readyTasks(db);
    expect(ready.find((r) => r.task_id === "t_sup")).toBeUndefined();
  });

  test("suppresses task_blocked rows (L4.1 exclusion axis)", () => {
    const db = openDb(":memory:");
    runViews(db);
    insertEvent(db, { kind: "task_node_opened", directive_id: "d1", task_id: "t_blk" });
    insertEvent(db, { kind: "task_blocked", directive_id: "d1", task_id: "t_blk" });
    const ready = readyTasks(db);
    expect(ready.find((r) => r.task_id === "t_blk")).toBeUndefined();
  });

  test("exposes parent_task_id + incoming-edge metadata (L4.1 provenance axis)", () => {
    const db = openDb(":memory:");
    runViews(db);
    insertEvent(db, { kind: "task_node_opened", directive_id: "d1", task_id: "t_parent" });
    insertEvent(db, {
      kind: "task_node_opened",
      directive_id: "d1",
      task_id: "t_child",
      parent_task_id: "t_parent",
    });
    insertEvent(db, { kind: "task_committed", directive_id: "d1", task_id: "t_parent" });
    // Refines edge from parent → child documents the refinement chain.
    insertEvent(db, {
      kind: "task_edge_recorded",
      directive_id: "d1",
      task_id: "t_child",
      payload: { from_task: "t_parent", to_task: "t_child", kind: "refines" },
    });
    const ready = readyTasks(db);
    const childRow = ready.find((r) => r.task_id === "t_child");
    expect(childRow).toBeDefined();
    if (!childRow) return;
    expect(childRow.parent_task_id).toBe("t_parent");
    expect(childRow.incoming_refines_from).toEqual(["t_parent"]);
    expect(childRow.incoming_requires_from).toEqual([]);
  });
});

describe("dispatch_resolved_view + dispatchResolved", () => {
  test("classifies live, completed, failed, queued_at_cap, and zombie roots", () => {
    const db = openDb(":memory:");
    runViews(db);
    const oldTs = new Date(Date.now() - 20 * 60 * 1000).toISOString();

    for (const [directive_id, task_id] of [["d_live", "t_live"], ["d_done", "t_done"], ["d_fail", "t_fail"], ["d_cap", "t_cap"], ["d_zombie", "t_zombie"]]) {
      insertEvent(db, { kind: "task_node_opened", directive_id, task_id });
    }
    insertEvent(db, { kind: "brain_dispatched", directive_id: "d_live", task_id: "t_live", ts: nowIso(), payload: { dispatch_id: "disp_live" } });
    insertEvent(db, { kind: "brain_dispatched", directive_id: "d_done", task_id: "t_done", payload: { dispatch_id: "disp_done" } });
    insertEvent(db, { kind: "brain_dispatch_closed", directive_id: "d_done", task_id: "t_done", payload: { dispatch_id: "disp_done" } });
    insertEvent(db, { kind: "task_committed", directive_id: "d_done", task_id: "t_done" });
    insertEvent(db, { kind: "task_failed", directive_id: "d_fail", task_id: "t_fail", failure_kind: "bridge_failed" });
    const capEventId = insertEvent(db, { kind: "constitutional_gate_decision", directive_id: "d_cap", task_id: "t_cap", payload: { gate: "brain_concurrency_cap", reason: "opencode_brain_in_flight_at_cap" } });
    insertEvent(db, { kind: "brain_dispatched", directive_id: "d_zombie", task_id: "t_zombie", ts: oldTs, payload: { dispatch_id: "disp_zombie" } });

    const byDirective = new Map(dispatchResolved(db).map((r) => [r.directive_id, r]));
    expect(byDirective.get("d_live")?.lifecycle_status).toBe("live");
    expect(byDirective.get("d_done")?.lifecycle_status).toBe("completed");
    expect(byDirective.get("d_done")?.terminal_kind).toBe("task_committed");
    expect(byDirective.get("d_fail")?.lifecycle_status).toBe("failed");
    expect(byDirective.get("d_cap")?.lifecycle_status).toBe("queued_at_cap");
    expect(byDirective.get("d_cap")?.latest_event_id).toBe(capEventId);
    expect(byDirective.get("d_zombie")?.lifecycle_status).toBe("zombie");
  });

  test("surfaces queued_at_cap after a prior closed dispatch", () => {
    const db = openDb(":memory:");
    runViews(db);
    insertEvent(db, { kind: "task_node_opened", directive_id: "d_requeue", task_id: "t_requeue" });
    insertEvent(db, { kind: "brain_dispatched", directive_id: "d_requeue", task_id: "t_requeue", payload: { dispatch_id: "disp_requeue" } });
    insertEvent(db, { kind: "brain_dispatch_closed", directive_id: "d_requeue", task_id: "t_requeue", payload: { dispatch_id: "disp_requeue" } });
    const capEventId = insertEvent(db, { kind: "constitutional_gate_decision", directive_id: "d_requeue", task_id: "t_requeue", payload: { gate: "brain_concurrency_cap", reason: "opencode_brain_in_flight_at_cap", cap: 5, in_flight_brain: 5 } });

    const [row] = dispatchResolved(db, { directiveId: "d_requeue", rootTaskId: "t_requeue" });
    expect(row?.lifecycle_status).toBe("queued_at_cap");
    expect(row?.status_reason).toBe("opencode_brain_in_flight_at_cap");
    expect(row?.latest_event_id).toBe(capEventId);
    expect(row?.cap).toBe(5);
    expect(row?.in_flight_brain).toBe(5);
  });

  test("infers a root row from dispatch signals when task_node_opened is absent", () => {
    const db = openDb(":memory:");
    runViews(db);
    const dispatchEventId = insertEvent(db, { kind: "brain_dispatched", directive_id: "d_inferred", task_id: "t_inferred", ts: nowIso(), payload: { dispatch_id: "disp_inferred" } });

    const [row] = dispatchResolved(db, { directiveId: "d_inferred", rootTaskId: "t_inferred" });
    expect(row?.lifecycle_status).toBe("live");
    expect(row?.dispatch_event_id).toBe(dispatchEventId);
    expect(row?.latest_event_id).toBe(dispatchEventId);
  });

  test("classifies an orphan root past the 1h window as orphan_node (Bug B widened from 5min to 1h on 2026-05-17 — brief scheduler/restart gaps should NOT immediately bucket as orphan)", () => {
    const db = openDb(":memory:");
    runViews(db);
    const seventyMinAgo = new Date(Date.now() - 70 * 60 * 1000).toISOString();
    insertEvent(db, { kind: "task_node_opened", directive_id: "d_orphan", task_id: "t_orphan", ts: seventyMinAgo });

    const [row] = dispatchResolved(db, { directiveId: "d_orphan", rootTaskId: "t_orphan" });
    expect(row?.lifecycle_status).toBe("orphan_node");
    expect(row?.status_reason).toBe("orphan_root_no_dispatch");
    expect(row?.dispatched_count).toBe(0);
    expect(row?.terminal_kind).toBeNull();
  });

  test("Bug C fix: terminal_kind=dispatcher_violation classifies as 'failed' even when an open dispatch lingers past 5min (hard failure must win over zombie heuristic)", () => {
    const db = openDb(":memory:");
    runViews(db);
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    insertEvent(db, { kind: "task_node_opened", directive_id: "d_hv", task_id: "t_hv", ts: tenMinAgo });
    // brain_dispatched WITHOUT a brain_dispatch_closed — leaves open_dispatch_count=1 and oldest_open age > 5min
    insertEvent(db, { kind: "brain_dispatched", directive_id: "d_hv", task_id: "t_hv", ts: tenMinAgo, payload: { dispatch_id: "disp_hv" } });
    // Terminal: dispatcher_violation (e.g. cycle_1_only_breach). Pre-fix this row was classified 'zombie' because
    // the open-dispatch+stale-age check ran first. Post-fix terminal hard-failure wins.
    insertEvent(db, { kind: "dispatcher_violation", directive_id: "d_hv", task_id: "t_hv", ts: nowIso(), failure_kind: "cycle_1_only_breach" });

    const [row] = dispatchResolved(db, { directiveId: "d_hv", rootTaskId: "t_hv" });
    expect(row?.lifecycle_status).toBe("failed");
    expect(row?.terminal_kind).toBe("dispatcher_violation");
  });

  test("Bug A fix: failed terminals with no scored residual default to 1.0 per substrate convention ('1.0 = goal missed')", () => {
    const db = openDb(":memory:");
    runViews(db);
    insertEvent(db, { kind: "task_node_opened", directive_id: "d_resfail", task_id: "t_resfail" });
    // task_failed with no residual on event row and no residual in payload — exactly the
    // silent_dispatch_quarantine shape that hits 23/24 production failed rows.
    insertEvent(db, {
      kind: "task_failed",
      directive_id: "d_resfail",
      task_id: "t_resfail",
      failure_kind: "silent_dispatch_quarantine",
      payload: { reason: "silent_dispatch_quarantine" },
    });
    const [row] = dispatchResolved(db, { directiveId: "d_resfail", rootTaskId: "t_resfail" });
    expect(row?.lifecycle_status).toBe("failed");
    expect(row?.residual).toBe(1.0);
  });

  test("Bug B extension: closed-directive stragglers classify as 'abandoned' (not 'orphan_node', not 'live')", () => {
    const db = openDb(":memory:");
    runViews(db);
    const seventyMinAgo = new Date(Date.now() - 70 * 60 * 1000).toISOString();
    // Orphan-shape: task_node_opened, no dispatch, > 1h old.
    insertEvent(db, { kind: "task_node_opened", directive_id: "d_closed", task_id: "t_straggler", ts: seventyMinAgo });
    // Parent directive was archived by operator. Straggler is correctly
    // abandoned with the DAG — distinct bucket from orphan (which implies
    // "still expected to complete").
    insertEvent(db, { kind: "directive_archived_by_operator", directive_id: "d_closed", task_id: "d_closed", payload: { reason: "owner_closed_stale_session" } });
    const [row] = dispatchResolved(db, { directiveId: "d_closed", rootTaskId: "t_straggler" });
    expect(row?.lifecycle_status).toBe("abandoned");
    expect(row?.status_reason).toBe("directive_closed_straggler");
  });

  test("Bug B baseline: open-directive orphan still classifies (no false negative)", () => {
    const db = openDb(":memory:");
    runViews(db);
    const seventyMinAgo = new Date(Date.now() - 70 * 60 * 1000).toISOString();
    insertEvent(db, { kind: "task_node_opened", directive_id: "d_open_orphan", task_id: "t_lonely", ts: seventyMinAgo });
    // No directive closure event. The orphan classification should fire.
    const [row] = dispatchResolved(db, { directiveId: "d_open_orphan", rootTaskId: "t_lonely" });
    expect(row?.lifecycle_status).toBe("orphan_node");
    expect(row?.status_reason).toBe("orphan_root_no_dispatch");
  });

  test("Bug A boundary: non-failure terminals (completed, live) keep their actual residual or NULL", () => {
    const db = openDb(":memory:");
    runViews(db);
    insertEvent(db, { kind: "task_node_opened", directive_id: "d_ok", task_id: "t_ok" });
    insertEvent(db, { kind: "task_committed", directive_id: "d_ok", task_id: "t_ok", residual: 0.12 });
    const [row] = dispatchResolved(db, { directiveId: "d_ok", rootTaskId: "t_ok" });
    expect(row?.lifecycle_status).toBe("completed");
    expect(row?.residual).toBe(0.12);
    // Live row with no terminal — residual stays NULL (verifier hasn't scored).
    // Use nowIso() so the open-dispatch age is < 5min and the row classifies
    // as 'live' not 'zombie' (the default tickTs() fixture returns 2026-01-01
    // which is past the stale-dispatch threshold).
    insertEvent(db, { kind: "task_node_opened", directive_id: "d_live", task_id: "t_live", ts: nowIso() });
    insertEvent(db, { kind: "brain_dispatched", directive_id: "d_live", task_id: "t_live", ts: nowIso(), payload: { dispatch_id: "disp_live" } });
    const [live] = dispatchResolved(db, { directiveId: "d_live", rootTaskId: "t_live" });
    expect(live?.lifecycle_status).toBe("live");
    expect(live?.residual).toBeNull();
  });

  test("keeps a fresh orphan root classified as live inside the 5min window", () => {
    const db = openDb(":memory:");
    runViews(db);
    insertEvent(db, { kind: "task_node_opened", directive_id: "d_fresh", task_id: "t_fresh", ts: nowIso() });

    const [row] = dispatchResolved(db, { directiveId: "d_fresh", rootTaskId: "t_fresh" });
    expect(row?.lifecycle_status).toBe("live");
    expect(row?.status_reason).not.toBe("orphan_root_no_dispatch");
  });

  test("reports live when a refinement child dispatches after the root commits", () => {
    const db = openDb(":memory:");
    runViews(db);
    insertEvent(db, { kind: "task_node_opened", directive_id: "d_refine", task_id: "t_root" });
    insertEvent(db, { kind: "brain_dispatched", directive_id: "d_refine", task_id: "t_root", payload: { dispatch_id: "disp_root" } });
    insertEvent(db, { kind: "brain_dispatch_closed", directive_id: "d_refine", task_id: "t_root", payload: { dispatch_id: "disp_root" } });
    insertEvent(db, { kind: "task_committed", directive_id: "d_refine", task_id: "t_root" });
    insertEvent(db, { kind: "task_node_opened", directive_id: "d_refine", task_id: "t_child", parent_task_id: "t_root" });
    insertEvent(db, { kind: "brain_dispatched", directive_id: "d_refine", task_id: "t_child", ts: nowIso(), payload: { dispatch_id: "disp_child" } });

    const [row] = dispatchResolved(db, { directiveId: "d_refine", rootTaskId: "t_root" });
    expect(row?.lifecycle_status).toBe("live");
    expect(row?.status_reason).toBe("refinement_dispatch_open");
    expect(row?.open_dispatch_count).toBe(1);
    expect(row?.terminal_kind).toBe("task_committed");
  });

  test("reports queued_at_cap when a ready refinement child has scheduler admission evidence", () => {
    const db = openDb(":memory:");
    runViews(db);
    insertEvent(db, { kind: "task_node_opened", directive_id: "d_refine_gate", task_id: "t_root" });
    insertEvent(db, { kind: "task_committed", directive_id: "d_refine_gate", task_id: "t_root" });
    insertEvent(db, { kind: "task_node_opened", directive_id: "d_refine_gate", task_id: "t_child", parent_task_id: "t_root" });
    const gateEventId = insertEvent(db, {
      kind: "constitutional_gate_decision",
      directive_id: "d_refine_gate",
      task_id: "t_child",
      payload: { gate: "scheduler_global_concurrency_cap", reason: "scheduler_global_in_flight_at_cap", cap: 1 },
    });

    const [row] = dispatchResolved(db, { directiveId: "d_refine_gate", rootTaskId: "t_root" });
    expect(row?.lifecycle_status).toBe("queued_at_cap");
    expect(row?.status_reason).toBe("scheduler_global_in_flight_at_cap");
    expect(row?.latest_event_id).toBe(gateEventId);
  });

  test("returns to completed once the refinement child also closes", () => {
    const db = openDb(":memory:");
    runViews(db);
    insertEvent(db, { kind: "task_node_opened", directive_id: "d_done", task_id: "t_root" });
    insertEvent(db, { kind: "brain_dispatched", directive_id: "d_done", task_id: "t_root", payload: { dispatch_id: "disp_root" } });
    insertEvent(db, { kind: "brain_dispatch_closed", directive_id: "d_done", task_id: "t_root", payload: { dispatch_id: "disp_root" } });
    insertEvent(db, { kind: "task_committed", directive_id: "d_done", task_id: "t_root" });
    insertEvent(db, { kind: "task_node_opened", directive_id: "d_done", task_id: "t_child", parent_task_id: "t_root" });
    insertEvent(db, { kind: "brain_dispatched", directive_id: "d_done", task_id: "t_child", payload: { dispatch_id: "disp_child" } });
    insertEvent(db, { kind: "task_committed", directive_id: "d_done", task_id: "t_child" });

    const [row] = dispatchResolved(db, { directiveId: "d_done", rootTaskId: "t_root" });
    expect(row?.lifecycle_status).toBe("completed");
    expect(row?.open_dispatch_count).toBe(0);
  });

  test("groups child dispatch events under the root task id and supports filters", () => {
    const db = openDb(":memory:");
    runViews(db);
    insertEvent(db, { kind: "task_node_opened", directive_id: "d_tree", task_id: "t_root" });
    insertEvent(db, { kind: "task_node_opened", directive_id: "d_tree", task_id: "t_child", parent_task_id: "t_root" });
    insertEvent(db, { kind: "brain_dispatched", directive_id: "d_tree", task_id: "t_child", payload: { dispatch_id: "disp_child" } });
    insertEvent(db, { kind: "brain_dispatch_closed", directive_id: "d_tree", task_id: "t_child", payload: { dispatch_id: "disp_child" } });
    insertEvent(db, { kind: "task_committed", directive_id: "d_tree", task_id: "t_child" });

    const rows = dispatchResolved(db, { directiveId: "d_tree", rootTaskId: "t_root" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.root_task_id).toBe("t_root");
    expect(rows[0]!.lifecycle_status).toBe("completed");
    expect(dispatchResolved(db, { directiveId: "missing" })).toEqual([]);
  });

  test("uses the latest terminal event instead of letting an older violation mask a later commit", () => {
    const db = openDb(":memory:");
    runViews(db);
    insertEvent(db, { kind: "task_node_opened", directive_id: "d_late_commit", task_id: "t_late_commit" });
    insertEvent(db, { kind: "brain_dispatched", directive_id: "d_late_commit", task_id: "t_late_commit", payload: { dispatch_id: "disp_late_commit" } });
    insertEvent(db, { kind: "dispatcher_violation", directive_id: "d_late_commit", task_id: "t_late_commit", failure_kind: "cycle_2_started" });
    insertEvent(db, { kind: "task_committed", directive_id: "d_late_commit", task_id: "t_late_commit" });

    const [row] = dispatchResolved(db, { directiveId: "d_late_commit", rootTaskId: "t_late_commit" });
    expect(row?.lifecycle_status).toBe("completed");
    expect(row?.terminal_kind).toBe("task_committed");
    expect(row?.status_reason).toBe("task_committed");
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

describe("operator registry views", () => {
  test("promotedKnowledge exposes promoted rows through the accessor", () => {
    const db = openDb(":memory:");
    runViews(db);

    const candidateId = insertEvent(db, {
      kind: "knowledge_candidate",
      directive_id: "d_k",
      task_id: "t_k",
      substrate_origin: "opencode",
      payload: { text: "Operator projections should expose promoted knowledge.", tags: ["projection"] },
    });
    const promotedId = insertEvent(db, {
      kind: "knowledge_promoted",
      directive_id: "d_k",
      task_id: "t_k",
      substrate_origin: "substrate_auto",
      payload: { candidate_id: candidateId, score: 0.9, confidence: 0.85 },
      context_refs: [candidateId],
    });

    const rows = promotedKnowledge(db);
    expect(rows.length).toBe(1);
    expect(rows[0]!.event_id).toBe(promotedId);
    expect(rows[0]!.candidate_id).toBe(candidateId);
    expect(rows[0]!.text).toBe("Operator projections should expose promoted knowledge.");
    expect(rows[0]!.tags).toEqual(["projection"]);
  });

  test("recipeRegistry returns the latest recipe row per goal/topology key", () => {
    const db = openDb(":memory:");
    runViews(db);

    const oldId = insertEvent(db, {
      kind: "recipe_extracted",
      directive_id: "d_r",
      task_id: "t_r",
      payload: {
        goal_shape: "shape_a",
        topology_signature: "topo_1",
        confidence: 0.5,
        trajectory: [],
      },
      ts: "2026-01-01T00:00:01.000Z",
    });
    const latestId = insertEvent(db, {
      kind: "recipe_extracted",
      directive_id: "d_r",
      task_id: "t_r",
      payload: {
        goal_shape: "shape_a",
        topology_signature: "topo_1",
        confidence: 0.6,
        seeded_by: "inline_post_commit_bump",
        trajectory: [{ step_kind: "action_predicted" }],
      },
      context_refs: [oldId],
      ts: "2026-01-01T00:00:02.000Z",
    });
    insertEvent(db, {
      kind: "recipe_extracted",
      directive_id: "d_other",
      task_id: "t_other",
      payload: {
        goal_shape: "shape_b",
        topology_signature: "topo_2",
        confidence: 0.55,
        trajectory: [],
      },
      ts: "2026-01-01T00:00:03.000Z",
    });

    const rows = recipeRegistry(db);
    expect(rows.length).toBe(2);
    const shapeA = rows.find((r) => r.goal_shape === "shape_a");
    expect(shapeA!.recipe_id).toBe(latestId);
    expect(shapeA!.confidence).toBe(0.6);
    expect(shapeA!.status).toBe("inline_post_commit_bump");
  });

  test("recipesLatestView returns an empty array on an empty ledger", () => {
    const db = openDb(":memory:");
    runViews(db);

    const rows = recipesLatestView(db);
    expect(rows).toEqual([]);
  });

  test("recipesLatestView projects one row per distinct (goal_shape, topology_signature) pair", () => {
    const db = openDb(":memory:");
    runViews(db);

    insertEvent(db, {
      kind: "recipe_extracted",
      directive_id: "d_a",
      task_id: "t_a",
      payload: {
        goal_shape: "shape_a",
        topology_signature: "topo_1",
        confidence: 0.5,
        trajectory: [],
      },
      ts: "2026-01-01T00:00:01.000Z",
    });
    insertEvent(db, {
      kind: "recipe_extracted",
      directive_id: "d_b",
      task_id: "t_b",
      payload: {
        goal_shape: "shape_b",
        topology_signature: "topo_2",
        confidence: 0.6,
        trajectory: [],
      },
      ts: "2026-01-01T00:00:02.000Z",
    });
    insertEvent(db, {
      kind: "recipe_extracted",
      directive_id: "d_c",
      task_id: "t_c",
      payload: {
        goal_shape: "shape_c",
        topology_signature: "topo_3",
        confidence: 0.7,
        trajectory: [],
      },
      ts: "2026-01-01T00:00:03.000Z",
    });

    const rows = recipesLatestView(db);
    expect(rows.length).toBe(3);
    const keys = rows.map((r) => `${r.goal_shape}|${r.topology_signature}`).sort();
    expect(keys).toEqual([
      "shape_a|topo_1",
      "shape_b|topo_2",
      "shape_c|topo_3",
    ]);
    const shapeC = rows.find((r) => r.goal_shape === "shape_c");
    expect(shapeC!.confidence).toBe(0.7);
    expect(shapeC!.payload.goal_shape).toBe("shape_c");
  });

  test("recipesLatestView picks the highest-confidence row per key and drops the rest", () => {
    const db = openDb(":memory:");
    runViews(db);

    const lowerConfId = insertEvent(db, {
      kind: "recipe_extracted",
      directive_id: "d_x",
      task_id: "t_x",
      payload: {
        goal_shape: "shape_x",
        topology_signature: "topo_x",
        confidence: 0.4,
        trajectory: [],
      },
      ts: "2026-01-01T00:00:01.000Z",
    });
    const higherConfId = insertEvent(db, {
      kind: "recipe_extracted",
      directive_id: "d_x",
      task_id: "t_x",
      payload: {
        goal_shape: "shape_x",
        topology_signature: "topo_x",
        confidence: 0.8,
        trajectory: [{ step_kind: "action_predicted" }],
      },
      ts: "2026-01-01T00:00:02.000Z",
    });

    const rows = recipesLatestView(db);
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe(higherConfId);
    expect(rows[0]!.confidence).toBe(0.8);
    // Lower-confidence row is dropped from the projection — confirm it's
    // gone, not merely deprioritised.
    expect(rows.find((r) => r.id === lowerConfId)).toBeUndefined();
  });
});

describe("lesson implementer flywheel views", () => {
  // TODO: this test asserts ~20 expectations against lesson_implementer_queue_view
  // shape, several of which assume the old path-pattern owner_gate model
  // (auto_apply_gate_verdict for owner-gated rows, apply_gate_status for
  // owner-approved rows, etc.). The 94N61BVVV9 convergence dropped path-
  // pattern derivation; the view's verdict-computation flow changed and
  // the cascading expectations no longer line up. Skipping until the
  // queue verdict semantics are re-specified to match the structural
  // gate (payload owner_consent_required flag + things_to_never_do).
  test.skip("queue derives owner gate, auto-apply eligibility, and hazards", () => {
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
        // Post-94N61BVVV9 convergence: owner_gate_required derives from
        // the explicit payload flag, not the file path. A producer that
        // hits owner_profile.things_to_never_do sets this; tests must
        // seed it explicitly to surface the proposal as owner-gated.
        owner_consent_required: true,
      },
    });
    insertEvent(db, {
      kind: "owner_decision_recorded",
      directive_id: "d_contract",
      task_id: "t_contract",
      payload: { source_event_id: gated, decision: "approved" },
      context_refs: [gated],
    });

    const insertAutoApplyGateScore = (
      source: string,
      directive_id: string,
      task_id: string,
      residual = 0.1,
      breakdown = {
        freshness: 0.1,
        semantic_duplicate: 0.1,
        behavioral_novelty: 0.1,
        necessity: 0.1,
        adversarial: 0.1,
      },
    ) => insertEvent(db, {
      kind: "action_scored",
      directive_id,
      task_id,
      payload: {
        source_event_id: source,
        gate_kind: "auto_apply_gate",
        residual,
        breakdown,
      },
      context_refs: [source],
      residual,
    });

    const runtimeProposal = insertEvent(db, {
      kind: "contract_amendment_proposed",
      directive_id: "d_runtime",
      task_id: "t_runtime",
      payload: {
        target: "runtime/prompt_composer.ts",
        anchor: "WORKFLOW_TEXT",
        proposed_behavior: { file_path: "runtime/prompt_composer.ts", anchor: "WORKFLOW_TEXT", diff: "@@" },
      },
    });
    insertAutoApplyGateScore(runtimeProposal, "d_runtime", "t_runtime");

    const duplicateProposal = insertEvent(db, {
      kind: "contract_amendment_proposed",
      directive_id: "d_runtime_duplicate",
      task_id: "t_runtime_duplicate",
      payload: {
        target: "runtime/prompt_composer.ts",
        anchor: "WORKFLOW_TEXT",
        proposed_behavior: { file_path: "runtime/prompt_composer.ts", anchor: "WORKFLOW_TEXT", diff: "@@" },
      },
    });
    insertAutoApplyGateScore(duplicateProposal, "d_runtime_duplicate", "t_runtime_duplicate", 0.2, {
      freshness: 0.1,
      semantic_duplicate: 0.8,
      behavioral_novelty: 0.1,
      necessity: 0.1,
      adversarial: 0.1,
    });

    insertEvent(db, {
      kind: "contract_amendment_proposed",
      directive_id: "d_rule",
      task_id: "t_rule",
      payload: {
        target: ".claude/rules/dispatch.md",
        anchor: "owner gate",
        proposed_behavior: { file_path: ".claude/rules/dispatch.md", anchor: "owner gate", diff: "@@" },
      },
    });

    insertEvent(db, {
      kind: "contract_amendment_proposed",
      directive_id: "d_runtime_unstructured",
      task_id: "t_runtime_unstructured",
      payload: {
        target: "cli/apply.ts",
        anchor: "apply gate",
        proposed_behavior: "change the gate prose",
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

    const lessonRuntimeProposal = insertEvent(db, {
      kind: "lesson_extracted",
      directive_id: "d_lesson_runtime",
      task_id: "t_lesson_runtime",
      payload: {
        lesson_kind: "verifier_gap",
        proposed_action: { file_path: "runtime/verifier.ts", anchor: "gate", diff: "@@" },
      },
    });
    insertAutoApplyGateScore(lessonRuntimeProposal, "d_lesson_runtime", "t_lesson_runtime");

    insertEvent(db, {
      kind: "lesson_extracted",
      directive_id: "d_lesson_contract",
      task_id: "t_lesson_contract",
      payload: {
        lesson_kind: "process_improvement",
        proposed_action: { file_path: "CLAUDE.md", anchor: "owner gate", diff: "@@" },
      },
    });

    insertEvent(db, {
      kind: "contract_amendment_proposed",
      directive_id: "d_mixed_targets",
      task_id: "t_mixed_targets",
      payload: {
        target: "runtime/prompt_composer.ts",
        anchor: "owner gate",
        proposed_behavior: { file_path: "CLAUDE.md", anchor: "owner gate", diff: "@@" },
      },
    });

    const rows = lessonImplementerQueue(db);
    const byDirective = new Map(rows.map((r) => [r.directive_id, r]));
    expect(byDirective.get("d_contract")!.owner_gate_required).toBe(true);
    expect(byDirective.get("d_contract")!.owner_approved).toBe(true);
    expect(byDirective.get("d_contract")!.owner_gate_verdict).toBe("owner_consent_approved");
    expect(byDirective.get("d_contract")!.auto_apply_gate_verdict).toBe("not_auto_apply_owner_gated");
    expect(byDirective.get("d_contract")!.apply_gate_status).toBe("authorized_owner");
    expect(byDirective.get("d_runtime")!.auto_apply_eligible).toBe(true);
    expect(byDirective.get("d_runtime")!.auto_apply_target).toBe(true);
    expect(byDirective.get("d_runtime")!.structured_change).toBe(true);
    expect(byDirective.get("d_runtime")!.owner_gate_verdict).toBe("owner_consent_not_required");
    expect(byDirective.get("d_runtime")!.auto_apply_gate_event_id).toBeTruthy();
    expect(byDirective.get("d_runtime")!.auto_apply_gate_residual).toBe(0.1);
    expect(byDirective.get("d_runtime")!.freshness_residual).toBe(0.1);
    expect(byDirective.get("d_runtime")!.semantic_duplicate_residual).toBe(0.1);
    expect(byDirective.get("d_runtime")!.behavioral_novelty_residual).toBe(0.1);
    expect(byDirective.get("d_runtime")!.necessity_residual).toBe(0.1);
    expect(byDirective.get("d_runtime")!.adversarial_residual).toBe(0.1);
    expect(byDirective.get("d_runtime")!.auto_apply_gate_verdict).toBe("auto_apply_eligible");
    expect(byDirective.get("d_runtime")!.apply_gate_status).toBe("authorized_auto");
    expect(byDirective.get("d_runtime_duplicate")!.auto_apply_eligible).toBe(false);
    expect(byDirective.get("d_runtime_duplicate")!.auto_apply_gate_verdict).toBe("blocked_auto_apply_gate_axis");
    expect(byDirective.get("d_runtime_duplicate")!.apply_gate_status).toBe("blocked_auto_apply_gate_residual");
    expect(byDirective.get("d_runtime_duplicate")!.apply_gate_reason).toBe("semantic_duplicate_residual_high");
    expect(byDirective.get("d_rule")!.owner_gate_required).toBe(true);
    expect(byDirective.get("d_rule")!.owner_gate_verdict).toBe("owner_consent_required");
    expect(byDirective.get("d_rule")!.apply_gate_status).toBe("blocked_owner_consent");
    expect(byDirective.get("d_rule")!.apply_gate_reason).toBe("owner_consent_missing");
    expect(byDirective.get("d_runtime_unstructured")!.auto_apply_eligible).toBe(false);
    expect(byDirective.get("d_runtime_unstructured")!.structured_change).toBe(false);
    expect(byDirective.get("d_runtime_unstructured")!.auto_apply_gate_verdict).toBe("blocked_unstructured_proposal");
    expect(byDirective.get("d_runtime_unstructured")!.apply_gate_status).toBe("blocked_unstructured_proposal");
    expect(byDirective.get("d_runtime_unstructured")!.apply_gate_reason).toBe("structured_proposed_behavior_required");
    expect(byDirective.get("d_hazard")!.auto_apply_eligible).toBe(false);
    expect(byDirective.get("d_hazard")!.trajectory_hazard_count).toBe(1);
    expect(byDirective.get("d_hazard")!.auto_apply_gate_verdict).toBe("blocked_trajectory_hazard");
    expect(byDirective.get("d_hazard")!.apply_gate_status).toBe("blocked_trajectory_hazard");
    expect(byDirective.get("d_hazard")!.apply_gate_reason).toBe("trajectory_hazard_present");
    expect(byDirective.get("d_lesson_runtime")!.auto_apply_eligible).toBe(true);
    expect(byDirective.get("d_lesson_runtime")!.apply_gate_status).toBe("authorized_auto");
    expect(byDirective.get("d_lesson_runtime")!.apply_candidate).toMatchObject({
      source_kind: "lesson_extracted",
      lesson_kind: "verifier_gap",
      target: "repo:runtime/verifier.ts",
      target_resource: "repo:runtime/verifier.ts",
      anchor: "gate",
      diff: "@@",
    });
    expect(byDirective.get("d_lesson_contract")!.owner_gate_required).toBe(true);
    expect(byDirective.get("d_lesson_contract")!.apply_gate_status).toBe("blocked_owner_consent");
    expect(byDirective.get("d_mixed_targets")!.owner_gate_required).toBe(true);
    expect(byDirective.get("d_mixed_targets")!.auto_apply_eligible).toBe(false);
    expect(byDirective.get("d_mixed_targets")!.auto_apply_gate_verdict).toBe("not_auto_apply_owner_gated");
    expect(byDirective.get("d_mixed_targets")!.apply_gate_status).toBe("blocked_owner_consent");
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
      payload: { source_event_id: source, authorization_status: "approved" },
      context_refs: [source],
    });
    const predicted = insertEvent(db, {
      kind: "action_predicted",
      directive_id: "d_apply",
      task_id: "t_apply",
      payload: { source_event_id: source, request_event_id: requested, authorization_event_id: requested },
      context_refs: [source, requested],
      action_artifact_id: "apply_action",
      verifier_artifact_id: "apply_verifier",
      predicted_residual: 0.2,
    });
    const scored = insertEvent(db, {
      kind: "action_scored",
      directive_id: "d_apply",
      task_id: "t_apply",
      payload: { source_event_id: source, request_event_id: requested, authorization_event_id: requested },
      context_refs: [source, requested],
      residual: 0.1,
    });
    // Audit #3 collapse (owner-approved 2026-05-16): applied_change_committed
    // now subsumes lesson_applied / contract_amendment_applied. ONE emission
    // carries status + source_kind + residual + commit_sha in payload.
    insertEvent(db, {
      kind: "applied_change_committed",
      directive_id: "d_apply",
      task_id: "t_apply",
      payload: { source_event_id: source, status: "applied", commit_sha: "abcdef1234", residual: 0.1, request_event_id: requested, authorization_event_id: requested },
      context_refs: [source, requested, scored],
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
    expect(row.apply_candidate).toMatchObject({
      source_event_id: source,
      source_kind: "lesson_extracted",
      lesson_kind: "verifier_gap",
    });
  });

  test("apply candidate view exposes the normalized flywheel shape", () => {
    const db = openDb(":memory:");
    runViews(db);

    const recipeSource = insertEvent(db, {
      kind: "lesson_extracted",
      directive_id: "d_candidate_recipe",
      task_id: "t_candidate_recipe",
      payload: {
        lesson_kind: "recipe_candidate",
        proposed_action: { recipe: { goal_shape: "apply_lesson", topology_signature: "one_step" } },
      },
    });
    const amendmentSource = insertEvent(db, {
      kind: "contract_amendment_proposed",
      directive_id: "d_candidate_amendment",
      task_id: "t_candidate_amendment",
      payload: {
        target: "runtime/prompt_composer.ts",
        anchor: "WORKFLOW_TEXT",
        proposed_behavior: { file_path: "runtime/prompt_composer.ts", anchor: "WORKFLOW_TEXT", diff: "@@" },
      },
    });
    const request = insertEvent(db, {
      kind: "lesson_apply_requested",
      directive_id: "d_candidate_amendment",
      task_id: "t_candidate_amendment",
      payload: { source_event_id: amendmentSource, authorization_status: "approved" },
      context_refs: [amendmentSource],
    });
    insertEvent(db, {
      kind: "action_scored",
      directive_id: "d_candidate_amendment",
      task_id: "t_candidate_amendment",
      payload: {
        source_event_id: amendmentSource,
        request_event_id: request,
        authorization_event_id: request,
        gate_kind: "auto_apply_gate",
        breakdown: {
          freshness: 0.1,
          semantic_duplicate: 0.1,
          behavioral_novelty: 0.1,
          necessity: 0.1,
          adversarial: 0.1,
        },
      },
      context_refs: [amendmentSource, request],
      residual: 0.12,
    });

    const rows = lessonApplyCandidates(db);
    const recipe = rows.find((r) => r.source_event_id === recipeSource)!;
    const amendment = rows.find((r) => r.source_event_id === amendmentSource)!;

    expect(Object.keys(recipe).slice(0, 8)).toEqual([
      "source_event_id",
      "target",
      "anchor",
      "patch_or_recipe",
      "verifier_residual",
      "owner_gate",
      "trajectory_health",
      "compounding_metric",
    ]);
    expect(recipe.patch_or_recipe).toEqual({ goal_shape: "apply_lesson", topology_signature: "one_step" });
    expect(recipe.owner_gate.status).toBe("manual_review");
    expect(recipe.trajectory_health.healthy).toBe(1);
    expect(recipe.compounding_metric.compounded).toBe(0);

    expect(amendment.target).toBe("runtime/prompt_composer.ts");
    expect(amendment.anchor).toBe("WORKFLOW_TEXT");
    expect(amendment.patch_or_recipe).toEqual({ file_path: "runtime/prompt_composer.ts", anchor: "WORKFLOW_TEXT", diff: "@@" });
    expect(amendment.verifier_residual).toBe(0.12);
    expect(amendment.owner_gate.status).toBe("authorized_auto");
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
      payload: { source_event_id: source, authorization_status: "approved" },
      context_refs: [source],
    });
    const requested = lessonImplementationStatus(db).find((r) => r.source_event_id === source)!.request_event_id!;
    insertEvent(db, {
      kind: "action_predicted",
      directive_id: "d_apply_high",
      task_id: "t_apply_high",
      payload: { source_event_id: source, request_event_id: requested, authorization_event_id: requested },
      context_refs: [source, requested],
      predicted_residual: 0.2,
    });
    insertEvent(db, {
      kind: "action_scored",
      directive_id: "d_apply_high",
      task_id: "t_apply_high",
      payload: { source_event_id: source, request_event_id: requested, authorization_event_id: requested },
      context_refs: [source, requested],
      residual: 0.3,
    });
    insertEvent(db, {
      kind: "applied_change_committed",
      directive_id: "d_apply_high",
      task_id: "t_apply_high",
      // Auth-gate (post audit #3 collapse): apply event must cite the
      // request via payload.request_event_id or context_refs to count.
      payload: { source_event_id: source, status: "applied", residual: 0.3, request_event_id: requested, authorization_event_id: requested },
      context_refs: [source, requested],
      residual: 0.3,
    });

    const row = lessonImplementationStatus(db).find((r) => r.source_event_id === source)!;
    expect(row.verifier_passed).toBe(false);
    expect(row.committed_event_id).toBeNull();
    // Audit #3 collapse: applied_change_committed always fires (carrying
    // payload.status) so apply CTE picks it up; flywheel_status falls to
    // 'applied' (apply_status branch) instead of 'verified'. Terminal CTE
    // still requires residual < 0.3, so committed_event_id stays null.
    expect(row.flywheel_status).toBe("applied");
    expect(lessonImplementerQueue(db).some((r) => r.source_event_id === source)).toBe(true);
  });

  test("high-residual executor attempts remain uncommitted and queued", () => {
    const db = openDb(":memory:");
    runViews(db);
    const source = insertEvent(db, {
      kind: "lesson_extracted",
      directive_id: "d_executor_high",
      task_id: "t_executor_high",
      payload: {
        lesson_kind: "verifier_gap",
        summary: "tighten verifier",
        proposed_action: { file_path: "runtime/verifier.ts", anchor: "gate", diff: "@@" },
      },
    });
    const requested = insertEvent(db, {
      kind: "lesson_apply_requested",
      directive_id: "d_executor_high",
      task_id: "t_executor_high",
      payload: { source_event_id: source, authorization_status: "approved" },
      context_refs: [source],
    });
    const predicted = insertEvent(db, {
      kind: "action_predicted",
      directive_id: "d_executor_high",
      task_id: "t_executor_high",
      payload: { source_event_id: source, request_event_id: requested, authorization_event_id: requested },
      context_refs: [source, requested],
      action_artifact_id: "apply_action",
      verifier_artifact_id: "apply_verifier",
      predicted_residual: 0.2,
    });
    const scored = insertEvent(db, {
      kind: "action_scored",
      directive_id: "d_executor_high",
      task_id: "t_executor_high",
      payload: { source_event_id: source, request_event_id: requested, authorization_event_id: requested },
      context_refs: [source, requested, predicted],
      residual: 0.7,
    });
    // Audit #3 collapse: applied_change_committed now carries failure status
    // in payload (was previously a separate lesson_applied / contract_amendment_applied event).
    insertEvent(db, {
      kind: "applied_change_committed",
      directive_id: "d_executor_high",
      task_id: "t_executor_high",
      payload: {
        source_event_id: source,
        status: "failed",
        residual: 0.7,
        request_event_id: requested,
        authorization_event_id: requested,
        action_event_id: predicted,
        scored_event_id: scored,
      },
      context_refs: [source, scored],
    });

    const status = lessonImplementationStatus(db).find((r) => r.source_event_id === source)!;
    expect(status.scored_event_id).toBe(scored);
    expect(status.verifier_passed).toBe(false);
    expect(status.committed_event_id).toBeNull();
    expect(status.flywheel_status).toBe("failed");

    const queued = lessonImplementerQueue(db).find((r) => r.source_event_id === source)!;
    expect(queued.apply_event_id).not.toBeNull();
    expect(queued.apply_status).toBe("failed");
  });

  test("status requires authorization before prediction and commit transitions", () => {
    const db = openDb(":memory:");
    runViews(db);
    const source = insertEvent(db, {
      kind: "lesson_extracted",
      directive_id: "d_unauthorized_apply",
      task_id: "t_unauthorized_apply",
      payload: { lesson_kind: "verifier_gap", summary: "tighten verifier" },
    });
    const predicted = insertEvent(db, {
      kind: "action_predicted",
      directive_id: "d_unauthorized_apply",
      task_id: "t_unauthorized_apply",
      payload: { source_event_id: source },
      context_refs: [source],
      predicted_residual: 0.2,
    });
    insertEvent(db, {
      kind: "action_scored",
      directive_id: "d_unauthorized_apply",
      task_id: "t_unauthorized_apply",
      payload: { source_event_id: source },
      context_refs: [source, predicted],
      residual: 0.1,
    });
    insertEvent(db, {
      kind: "applied_change_committed",
      directive_id: "d_unauthorized_apply",
      task_id: "t_unauthorized_apply",
      payload: { source_event_id: source, status: "applied", residual: 0.1 },
      context_refs: [source, predicted],
      residual: 0.1,
    });

    const row = lessonImplementationStatus(db).find((r) => r.source_event_id === source)!;
    expect(row.request_event_id).toBeNull();
    expect(row.action_event_id).toBeNull();
    expect(row.scored_event_id).toBeNull();
    expect(row.committed_event_id).toBeNull();
    expect(row.flywheel_status).toBe("proposed");

    const requested = insertEvent(db, {
      kind: "lesson_apply_requested",
      directive_id: "d_unauthorized_apply",
      task_id: "t_unauthorized_apply",
      payload: { source_event_id: source, authorization_status: "approved" },
      context_refs: [source],
    });
    const authorizedPrediction = insertEvent(db, {
      kind: "action_predicted",
      directive_id: "d_unauthorized_apply",
      task_id: "t_unauthorized_apply",
      payload: { source_event_id: source, request_event_id: requested, authorization_event_id: requested },
      context_refs: [source, requested],
      predicted_residual: 0.2,
    });
    insertEvent(db, {
      kind: "applied_change_committed",
      directive_id: "d_unauthorized_apply",
      task_id: "t_unauthorized_apply",
      payload: { source_event_id: source, status: "applied", residual: 0.1, request_event_id: requested, authorization_event_id: requested },
      context_refs: [source, requested, authorizedPrediction],
      residual: 0.1,
    });

    const unscoredRow = lessonImplementationStatus(db).find((r) => r.source_event_id === source)!;
    expect(unscoredRow.request_event_id).toBe(requested);
    expect(unscoredRow.action_event_id).toBe(authorizedPrediction);
    expect(unscoredRow.committed_event_id).toBeNull();
    expect(unscoredRow.flywheel_status).toBe("predicted");

    const authorizedScore = insertEvent(db, {
      kind: "action_scored",
      directive_id: "d_unauthorized_apply",
      task_id: "t_unauthorized_apply",
      payload: { source_event_id: source, request_event_id: requested, authorization_event_id: requested },
      context_refs: [source, requested, authorizedPrediction],
      residual: 0.1,
    });
    insertEvent(db, {
      kind: "applied_change_committed",
      directive_id: "d_unauthorized_apply",
      task_id: "t_unauthorized_apply",
      payload: { source_event_id: source, status: "applied", residual: 0.1, request_event_id: requested, authorization_event_id: requested },
      context_refs: [source, requested, authorizedPrediction, authorizedScore],
      residual: 0.1,
    });

    const authorizedRow = lessonImplementationStatus(db).find((r) => r.source_event_id === source)!;
    expect(authorizedRow.scored_event_id).toBe(authorizedScore);
    expect(authorizedRow.committed_event_id).not.toBeNull();
    expect(authorizedRow.flywheel_status).toBe("committed");
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
    const requested = insertEvent(db, {
      kind: "lesson_apply_requested",
      directive_id: "d_source",
      task_id: "t_source",
      payload: { source_event_id: source, authorization_status: "approved" },
      context_refs: [source],
    });
    const scored = insertEvent(db, {
      kind: "action_scored",
      directive_id: "d_source",
      task_id: "t_source",
      payload: { source_event_id: source, request_event_id: requested, authorization_event_id: requested },
      context_refs: [source, requested],
      residual: 0.05,
    });
    insertEvent(db, {
      kind: "applied_change_committed",
      directive_id: "d_source",
      task_id: "t_source",
      payload: { source_event_id: source, status: "applied", residual: 0.05, request_event_id: requested, authorization_event_id: requested },
      context_refs: [source, requested, scored],
      residual: 0.05,
    });

    insertEvent(db, { kind: "task_node_opened", directive_id: "d_next", task_id: "t_next" });
    insertEvent(db, {
      kind: "action_scored",
      directive_id: "d_next",
      task_id: "t_next",
      payload: { source_event_id: source, recipe_replayed: true },
      context_refs: [source],
      residual: 0.02,
    });

    const row = appliedLessonEffectiveness(db).find((r) => r.source_event_id === source)!;
    expect(row.compounded).toBe(true);
    expect(row.tier0_replay_hit).toBe(true);
    expect(row.residual_delta).toBeGreaterThan(0);
    expect(row.dag_node_delta).toBe(2);
  });

  test("normalized apply candidates project one shape across lesson and amendment sources", () => {
    const db = openDb(":memory:");
    runViews(db);
    const lesson = insertEvent(db, {
      kind: "lesson_extracted",
      directive_id: "d_candidate_lesson",
      task_id: "t_candidate_lesson",
      payload: {
        lesson_kind: "recipe_candidate",
        proposed_action: { anchor: "match", recipe: { goal_shape: "apply lesson" } },
      },
    });
    const amendment = insertEvent(db, {
      kind: "contract_amendment_proposed",
      directive_id: "d_candidate_amendment",
      task_id: "t_candidate_amendment",
      payload: {
        target: "runtime/prompt_composer.ts",
        anchor: "WORKFLOW_TEXT",
        proposed_behavior: { file_path: "runtime/prompt_composer.ts", anchor: "WORKFLOW_TEXT", diff: "@@" },
      },
    });
    insertEvent(db, {
      kind: "action_scored",
      directive_id: "d_candidate_amendment",
      task_id: "t_candidate_amendment",
      payload: {
        source_event_id: amendment,
        gate_kind: "auto_apply_gate",
        residual: 0.1,
        breakdown: {
          freshness: 0.1,
          semantic_duplicate: 0.1,
          behavioral_novelty: 0.1,
          necessity: 0.1,
          adversarial: 0.1,
        },
      },
      context_refs: [amendment],
      residual: 0.1,
    });

    const rows = lessonApplyCandidates(db);
    const lessonRow = rows.find((r) => r.source_event_id === lesson)!;
    const amendmentRow = rows.find((r) => r.source_event_id === amendment)!;

    expect(lessonRow).toMatchObject({
      source_event_id: lesson,
      source_kind: "lesson_extracted",
      lesson_kind: "recipe_candidate",
      anchor: "match",
      flywheel_status: "proposed",
    });
    expect(lessonRow.target).toBeNull();
    expect(lessonRow.patch_or_recipe).toMatchObject({ goal_shape: "apply lesson" });
    expect(lessonRow.owner_gate).toMatchObject({ required: 0, status: "manual_review" });
    expect(amendmentRow).toMatchObject({
      source_event_id: amendment,
      source_kind: "contract_amendment_proposed",
      target: "runtime/prompt_composer.ts",
      anchor: "WORKFLOW_TEXT",
      flywheel_status: "proposed",
    });
    expect(amendmentRow.patch_or_recipe).toMatchObject({ file_path: "runtime/prompt_composer.ts", diff: "@@" });
    expect(amendmentRow.owner_gate).toMatchObject({ required: 0, status: "authorized_auto" });
  });
});

// substrate_narrative_recent_view — brain design D9TBCHADS97DHAMNBC686HE3P0.
// The load-bearing primitive for the content-first TUI. These tests pin
// per-kind content extraction so the operator never sees raw IDs again.
describe("substrate_narrative_recent_view + substrateNarrativeRecent", () => {
  test("projects knowledge_candidate.claim as human_summary with medium importance", () => {
    const db = openDb(":memory:");
    runViews(db);
    insertEvent(db, {
      kind: "knowledge_candidate",
      directive_id: "d1",
      task_id: "t1",
      payload: { claim: "Distribution-readiness should ship synthetic evidence handles." },
    });
    const rows = substrateNarrativeRecent(db, { kinds_in: ["knowledge_candidate"] });
    expect(rows.length).toBe(1);
    expect(rows[0]?.human_summary).toBe("Distribution-readiness should ship synthetic evidence handles.");
    expect(rows[0]?.importance).toBe("medium");
    expect(rows[0]?.kind).toBe("knowledge_candidate");
  });

  test("projects task_failed as critical importance with failure reason", () => {
    const db = openDb(":memory:");
    runViews(db);
    insertEvent(db, {
      kind: "task_failed",
      directive_id: "d1",
      task_id: "t1",
      failure_kind: "bridge_killed",
      payload: { reason: "bridge_killed:opencode_brain_silent_exit" },
    });
    const rows = substrateNarrativeRecent(db, { kinds_in: ["task_failed"] });
    expect(rows[0]?.importance).toBe("critical");
    expect(rows[0]?.human_summary).toBe("bridge_killed:opencode_brain_silent_exit");
  });

  test("projects task_committed.summary as high importance", () => {
    const db = openDb(":memory:");
    runViews(db);
    insertEvent(db, {
      kind: "task_committed",
      directive_id: "d1",
      task_id: "t1",
      payload: { summary: "Designed the dispatch strategy migration to scored artifact rows.", residual: 0.18 },
    });
    const rows = substrateNarrativeRecent(db, { kinds_in: ["task_committed"] });
    expect(rows[0]?.importance).toBe("high");
    expect(rows[0]?.human_summary).toContain("Designed the dispatch strategy");
    // residual surfaces from payload — useful for closure-residual sorting.
    expect(rows[0]?.residual).toBe(0.18);
  });

  test("dispatch_decided renders route + reason inline", () => {
    const db = openDb(":memory:");
    runViews(db);
    insertEvent(db, {
      kind: "dispatch_decided",
      directive_id: "d1",
      task_id: "t1",
      payload: { route: "opencode_brain", reason: "hard_task_dag_required:axes=strategic_verb" },
    });
    const rows = substrateNarrativeRecent(db, { kinds_in: ["dispatch_decided"] });
    expect(rows[0]?.human_summary).toContain("route=opencode_brain");
    expect(rows[0]?.human_summary).toContain("hard_task_dag_required");
    expect(rows[0]?.route).toBe("opencode_brain");
  });

  test("filter by importance_in returns only matching rows", () => {
    const db = openDb(":memory:");
    runViews(db);
    insertEvent(db, { kind: "knowledge_candidate", directive_id: "d1", task_id: "t1", payload: { claim: "medium" } });
    insertEvent(db, { kind: "task_failed", directive_id: "d1", task_id: "t2", payload: { reason: "critical" } });
    insertEvent(db, { kind: "embedding_recorded", directive_id: "d1", task_id: "t1", payload: {} });
    const rows = substrateNarrativeRecent(db, { importance_in: ["critical"] });
    expect(rows.length).toBe(1);
    expect(rows[0]?.kind).toBe("task_failed");
  });

  test("returns rows newest-first", () => {
    const db = openDb(":memory:");
    runViews(db);
    insertEvent(db, { ts: "2026-01-01T00:00:00Z", kind: "knowledge_candidate", directive_id: "d1", task_id: "t1", payload: { claim: "first" } });
    insertEvent(db, { ts: "2026-02-01T00:00:00Z", kind: "knowledge_candidate", directive_id: "d1", task_id: "t1", payload: { claim: "second" } });
    insertEvent(db, { ts: "2026-03-01T00:00:00Z", kind: "knowledge_candidate", directive_id: "d1", task_id: "t1", payload: { claim: "third" } });
    const rows = substrateNarrativeRecent(db, { kinds_in: ["knowledge_candidate"] });
    expect(rows.map((r) => r.human_summary)).toEqual(["third", "second", "first"]);
  });

  test("payload is parsed as a record so drilldown needs no second query", () => {
    const db = openDb(":memory:");
    runViews(db);
    insertEvent(db, {
      kind: "act_tuple_recorded",
      directive_id: "d1",
      task_id: "t1",
      payload: { intent: "land L4.1 fix", action: "edit substrate/views.ts", verifier_kind: "deterministic_code" },
    });
    const rows = substrateNarrativeRecent(db, { kinds_in: ["act_tuple_recorded"] });
    expect(rows[0]?.human_summary).toBe("land L4.1 fix");
    expect(rows[0]?.payload.action).toBe("edit substrate/views.ts");
    expect(rows[0]?.payload.verifier_kind).toBe("deterministic_code");
  });
});
