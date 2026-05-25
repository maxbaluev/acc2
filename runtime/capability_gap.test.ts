import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import { insertArtifact } from "./artifact_store";
import {
  aggregateGoalShapeResiduals,
  detectCapabilityGaps,
  composeAuthorDirective,
  capabilityGapWorkerTick,
  CAPGAP_MIN_OBSERVATIONS_FOR_TEST,
  CAPGAP_RESIDUAL_THRESHOLD_FOR_TEST,
} from "./capability_gap";

afterAll(() => closeDb());
beforeEach(() => closeDb());

// Seed a failing artifact (status quarantined/retired) plus a run of
// act_artifact_score_updated rows carrying { artifact_id, residual, goal_shape }
// — the exact shape runtime/credit.ts emits.
const seedFailingArtifact = (
  db: ReturnType<typeof openDb>,
  opts: {
    id: string;
    status: "quarantined" | "retired" | "admitted";
    goalShape: string;
    residual: number;
    observations: number;
    intent?: string;
  },
): void => {
  insertArtifact(db, {
    id: opts.id,
    runtime: "bun",
    kind: "runtime_action",
    body: "// failing artifact",
    declaredSandbox: null,
    stateRoot: null,
    posteriorAlpha: 1,
    posteriorBeta: 6,
    score: 0.14,
    confidence: 0.6,
    recentResidualMean: 0.85,
    recentKillCount: 0,
    status: opts.status,
    name: null,
    fixtureInput: null,
    fixtureExpectedResidual: null,
    intent: opts.intent ?? "do the failing thing",
  });
  emitScoreEvents(db, opts.id, opts.goalShape, opts.residual, opts.observations);
};

// Emit N act_artifact_score_updated rows for an existing artifact (used
// when an artifact already exists or needs a second goal_shape sample).
const emitScoreEvents = (
  db: ReturnType<typeof openDb>,
  artifactId: string,
  goalShape: string,
  residual: number,
  observations: number,
): void => {
  for (let i = 0; i < observations; i++) {
    emitEvent(db, {
      kind: "act_artifact_score_updated",
      substrate_origin: "substrate_auto",
      action_artifact_id: artifactId,
      payload: {
        artifact_id: artifactId,
        role: "action",
        residual,
        score: 0.14,
        confidence: 0.6,
        scored_event_id: `scored_${artifactId}_${goalShape}_${i}`,
        goal_shape: goalShape,
      },
    });
  }
};

describe("capability_gap detector", () => {
  test("aggregateGoalShapeResiduals groups recent score-updated residuals per goal_shape", () => {
    const db = openDb(":memory:");
    seedFailingArtifact(db, { id: "art_agg", status: "quarantined", goalShape: "shapeA", residual: 0.9, observations: 6 });
    emitScoreEvents(db, "art_agg", "shapeB", 0.1, 3);
    const agg = aggregateGoalShapeResiduals(db, "art_agg");
    expect(agg.get("shapeA")?.observations).toBe(6);
    expect(agg.get("shapeA")?.mean).toBeCloseTo(0.9, 5);
    expect(agg.get("shapeB")?.observations).toBe(3);
    expect(agg.get("shapeB")?.mean).toBeCloseTo(0.1, 5);
  });

  test("fires capability_gap_detected for a repeatedly-failing quarantined artifact+goal_shape", () => {
    const db = openDb(":memory:");
    seedFailingArtifact(db, { id: "art_fire", status: "quarantined", goalShape: "shape_fire", residual: 0.92, observations: 6 });
    const r = capabilityGapWorkerTick(db);
    expect(r.scanned).toBe(1);
    expect(r.detected).toBe(1);
    expect(r.dispatched).toBe(1);

    const gapRows = db.query(
      `SELECT payload FROM events WHERE kind='capability_gap_detected'`,
    ).all() as Array<{ payload: string }>;
    expect(gapRows.length).toBe(1);
    const p = JSON.parse(gapRows[0]!.payload);
    expect(p.goal_shape).toBe("shape_fire");
    expect(p.failing_artifact_id).toBe("art_fire");
    expect(p.artifact_kind).toBe("runtime_action");
    expect(p.residual_evidence.observations).toBe(6);
    expect(p.residual_evidence.mean).toBeCloseTo(0.92, 5);
    expect(typeof p.reason).toBe("string");
  });

  test("does NOT fire below the residual threshold", () => {
    const db = openDb(":memory:");
    // High observations but low residual — the goal_shape IS served.
    seedFailingArtifact(db, { id: "art_lowres", status: "quarantined", goalShape: "shape_ok", residual: 0.2, observations: 8 });
    const r = capabilityGapWorkerTick(db);
    expect(r.detected).toBe(0);
    expect(r.dispatched).toBe(0);
    expect(r.below_threshold).toBeGreaterThanOrEqual(1);
    expect(detectCapabilityGaps(db).length).toBe(0);
  });

  test("does NOT fire below the observation threshold", () => {
    const db = openDb(":memory:");
    // High residual but too few observations — not enough evidence.
    seedFailingArtifact(db, { id: "art_fewobs", status: "quarantined", goalShape: "shape_few", residual: 0.95, observations: CAPGAP_MIN_OBSERVATIONS_FOR_TEST - 1 });
    const r = capabilityGapWorkerTick(db);
    expect(r.detected).toBe(0);
    expect(r.dispatched).toBe(0);
  });

  test("does NOT fire for a healthy (admitted) artifact even with high residual sample", () => {
    const db = openDb(":memory:");
    // Defensive loop has NOT quarantined this — Gate 1 blocks it.
    seedFailingArtifact(db, { id: "art_healthy", status: "admitted", goalShape: "shape_h", residual: 0.95, observations: 8 });
    const r = capabilityGapWorkerTick(db);
    expect(r.scanned).toBe(0);
    expect(r.detected).toBe(0);
  });

  test("idempotent — second tick on the same unresolved gap does not re-detect or re-dispatch", () => {
    const db = openDb(":memory:");
    seedFailingArtifact(db, { id: "art_idem", status: "retired", goalShape: "shape_idem", residual: 0.9, observations: 7 });
    const r1 = capabilityGapWorkerTick(db);
    expect(r1.detected).toBe(1);
    expect(r1.dispatched).toBe(1);
    const r2 = capabilityGapWorkerTick(db);
    expect(r2.detected).toBe(0);
    expect(r2.dispatched).toBe(0);
    expect(r2.already_open).toBeGreaterThanOrEqual(1);
    // Exactly one gap event total.
    const n = (db.query(`SELECT COUNT(*) AS n FROM events WHERE kind='capability_gap_detected'`).get() as { n: number }).n;
    expect(n).toBe(1);
  });

  test("re-detects after the gap is resolved", () => {
    const db = openDb(":memory:");
    seedFailingArtifact(db, { id: "art_resolve", status: "quarantined", goalShape: "shape_res", residual: 0.9, observations: 7 });
    const r1 = capabilityGapWorkerTick(db);
    expect(r1.detected).toBe(1);
    // Resolve the gap (replacement authored) — closes the idempotency window.
    emitEvent(db, {
      kind: "capability_gap_resolved",
      substrate_origin: "substrate_auto",
      action_artifact_id: "art_resolve",
      payload: { goal_shape: "shape_res", failing_artifact_id: "art_resolve" },
    });
    const r2 = capabilityGapWorkerTick(db);
    expect(r2.detected).toBe(1);
  });

  test("dispatch seam produces a well-formed author directive (directive_opened + root task)", () => {
    const db = openDb(":memory:");
    seedFailingArtifact(db, { id: "art_seam", status: "quarantined", goalShape: "shape_seam", residual: 0.88, observations: 6, intent: "render the weekly digest" });
    capabilityGapWorkerTick(db);

    const dirs = db.query(
      `SELECT directive_id, payload FROM events WHERE kind='directive_opened' AND substrate_origin='substrate_auto'`,
    ).all() as Array<{ directive_id: string; payload: string }>;
    expect(dirs.length).toBe(1);
    const dp = JSON.parse(dirs[0]!.payload);
    expect(dp.capability_gap_for_artifact_id).toBe("art_seam");
    expect(dp.capability_gap_goal_shape).toBe("shape_seam");
    expect(typeof dp.directive_text).toBe("string");
    expect(dp.directive_text).toContain("act_artifact_candidate");
    expect(dp.directive_text).toContain("render the weekly digest");
    expect(dp.lifecycle).toBe("finite");

    // Root task_node_opened under the new directive (scheduler picks this up).
    const tasks = db.query(
      `SELECT directive_id, task_id, parent_task_id FROM events WHERE kind='task_node_opened' AND directive_id = ?`,
    ).all(dirs[0]!.directive_id) as Array<{ directive_id: string; task_id: string; parent_task_id: string | null }>;
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.parent_task_id).toBeNull();
    expect(tasks[0]!.task_id).toBe(`${dirs[0]!.directive_id}_root`);
  });

  test("composeAuthorDirective instructs the brain to author (not modify in place) and carries evidence", () => {
    const db = openDb(":memory:");
    seedFailingArtifact(db, { id: "art_compose", status: "quarantined", goalShape: "shape_c", residual: 0.9, observations: 6, intent: "send onboarding email" });
    const text = composeAuthorDirective(db, {
      goal_shape: "shape_c",
      failing_artifact_id: "art_compose",
      artifact_kind: "runtime_action",
      residual_evidence: { mean: 0.9, observations: 6 },
      reason: "test",
    });
    expect(text).toContain("send onboarding email");
    expect(text).toContain("shape_c");
    expect(text).toContain("act_artifact_candidate");
    expect(text).toContain("Do NOT modify the failing artifact in place");
    expect(text).toContain("0.900");
  });

  test("respects dispatchLimitPerTick across multiple gaps", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 5; i++) {
      seedFailingArtifact(db, { id: `art_cap_${i}`, status: "quarantined", goalShape: `shape_${i}`, residual: 0.9, observations: 6 });
    }
    const r = capabilityGapWorkerTick(db, { dispatchLimitPerTick: 2 });
    expect(r.dispatched).toBe(2);
    expect(r.detected).toBe(2);
  });

  test("threshold mirrors are exported and align with the quarantine band", () => {
    expect(CAPGAP_RESIDUAL_THRESHOLD_FOR_TEST).toBe(0.7);
    expect(CAPGAP_MIN_OBSERVATIONS_FOR_TEST).toBe(5);
  });
});
