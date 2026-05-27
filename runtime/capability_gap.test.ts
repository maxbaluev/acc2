import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import { insertArtifact } from "./artifact_store";
import {
  aggregateGoalShapeResiduals,
  detectCapabilityGaps,
  composeAuthorDirective,
  composeProactiveAuthorDirective,
  capabilityGapWorkerTick,
  maybeOpenProactiveGap,
  openCapabilityGap,
  proactiveGapSuppressed,
  resolveProactiveGap,
  CAPGAP_MIN_OBSERVATIONS_FOR_TEST,
  CAPGAP_RESIDUAL_THRESHOLD_FOR_TEST,
  CAPGAP_PROACTIVE_FIT_THRESHOLD_FOR_TEST,
  CAPGAP_PROACTIVE_COOLDOWN_MS_FOR_TEST,
  CAPGAP_PROACTIVE_MAX_ATTEMPTS_FOR_TEST,
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

  test("composeAuthorDirective includes retrieved authoring knowledge guidance", () => {
    const db = openDb(":memory:");
    seedFailingArtifact(db, { id: "art_guided", status: "quarantined", goalShape: "shape_guided", residual: 0.9, observations: 6, intent: "send onboarding email" });
    emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "brain",
      payload: {
        claim: "artifact repair guidance for shape_guided should preserve concrete error evidence",
        summary: "artifact guidance summary",
      },
    });
    const text = composeAuthorDirective(db, {
      goal_shape: "shape_guided",
      failing_artifact_id: "art_guided",
      artifact_kind: "runtime_action",
      residual_evidence: { mean: 0.9, observations: 6 },
      reason: "test",
    });
    expect(text).toContain("Retrieved authoring knowledge and lessons to cite if used");
    expect(text).toContain("artifact repair guidance for shape_guided");
    expect(text).toContain("cited_knowledge_ids");
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

  test("failure-path gap event carries reason='artifact_failing' and trigger='failure'", () => {
    const db = openDb(":memory:");
    seedFailingArtifact(db, { id: "art_disc", status: "quarantined", goalShape: "shape_disc", residual: 0.9, observations: 6 });
    capabilityGapWorkerTick(db);
    const p = JSON.parse(
      (db.query(`SELECT payload FROM events WHERE kind='capability_gap_detected'`).get() as { payload: string }).payload,
    );
    expect(p.reason).toBe("artifact_failing");
    expect(p.trigger).toBe("failure");
    expect(p.residual_evidence.observations).toBe(6);
  });
});

describe("proactive capability_gap (gap-at-selection)", () => {
  test("opens proactive gap when best fit < threshold for an artifact-wanting goal", () => {
    const db = openDb(":memory:");
    const d = maybeOpenProactiveGap(db, {
      goal_shape: "shape_poor",
      goal_text: "render a quarterly investor digest",
      best_fit: CAPGAP_PROACTIVE_FIT_THRESHOLD_FOR_TEST - 0.1,
      candidate_count: 3,
      wants_artifact: true,
    });
    expect(d.opened).toBe(true);
    const gap = JSON.parse(
      (db.query(`SELECT payload FROM events WHERE kind='capability_gap_detected'`).get() as { payload: string }).payload,
    );
    expect(gap.reason).toBe("proactive_no_fit");
    expect(gap.trigger).toBe("selection");
    expect(gap.failing_artifact_id).toBeNull();
    expect(gap.fit_evidence.candidate_count).toBe(3);
    // Author directive opened (the brain authors a new capability).
    const dir = JSON.parse(
      (db.query(`SELECT payload FROM events WHERE kind='directive_opened'`).get() as { payload: string }).payload,
    );
    expect(dir.capability_gap_trigger).toBe("selection");
    expect(dir.capability_gap_goal_shape).toBe("shape_poor");
    expect(dir.directive_text).toContain("act_artifact_candidate");
    expect(dir.directive_text).toContain("render a quarterly investor digest");
  });

  test("opens proactive gap for the zero-candidate case when goal wants an artifact", () => {
    const db = openDb(":memory:");
    const d = maybeOpenProactiveGap(db, {
      goal_shape: "shape_none",
      goal_text: "post a status update to telegram",
      best_fit: 0,
      candidate_count: 0,
      wants_artifact: true,
    });
    expect(d.opened).toBe(true);
    const gap = JSON.parse(
      (db.query(`SELECT payload FROM events WHERE kind='capability_gap_detected'`).get() as { payload: string }).payload,
    );
    expect(gap.fit_evidence.candidate_count).toBe(0);
    expect(gap.evidence).toContain("0 admitted");
  });

  test("does NOT fire when a good-fit artifact exists", () => {
    const db = openDb(":memory:");
    const d = maybeOpenProactiveGap(db, {
      goal_shape: "shape_good",
      best_fit: CAPGAP_PROACTIVE_FIT_THRESHOLD_FOR_TEST + 0.2,
      candidate_count: 2,
      wants_artifact: true,
    });
    expect(d.opened).toBe(false);
    expect(d.skip_reason).toBe("good_fit_exists");
    expect((db.query(`SELECT COUNT(*) AS n FROM events WHERE kind='capability_gap_detected'`).get() as { n: number }).n).toBe(0);
  });

  test("fail-closed: does NOT fire when the goal does not want an artifact", () => {
    const db = openDb(":memory:");
    // zero candidates + wants_artifact=false (pure-knowledge / conversational).
    const d = maybeOpenProactiveGap(db, {
      goal_shape: "shape_chat",
      best_fit: 0,
      candidate_count: 0,
      wants_artifact: false,
    });
    expect(d.opened).toBe(false);
    expect(d.skip_reason).toBe("not_artifact_wanting");
  });

  test("fail-closed: does NOT fire when goal_shape is empty (ambiguous context)", () => {
    const db = openDb(":memory:");
    const d = maybeOpenProactiveGap(db, { goal_shape: "", best_fit: 0, candidate_count: 0, wants_artifact: true });
    expect(d.opened).toBe(false);
    expect(d.skip_reason).toBe("ambiguous_context");
  });

  test("idempotent — one open proactive gap per goal_shape, no spam", () => {
    const db = openDb(":memory:");
    const args = { goal_shape: "shape_idem_p", best_fit: 0.1, candidate_count: 1, wants_artifact: true };
    const r1 = maybeOpenProactiveGap(db, args);
    const r2 = maybeOpenProactiveGap(db, args);
    const r3 = maybeOpenProactiveGap(db, args);
    expect(r1.opened).toBe(true);
    expect(r2.opened).toBe(false);
    expect(r2.skip_reason).toBe("suppressed_open");
    expect(r3.opened).toBe(false);
    expect((db.query(`SELECT COUNT(*) AS n FROM events WHERE kind='capability_gap_detected'`).get() as { n: number }).n).toBe(1);
    expect((db.query(`SELECT COUNT(*) AS n FROM events WHERE kind='directive_opened'`).get() as { n: number }).n).toBe(1);
  });

  test("cooldown stops repeated proactive authoring after resolution", () => {
    const db = openDb(":memory:");
    const args = { goal_shape: "shape_cool", best_fit: 0.1, candidate_count: 1, wants_artifact: true };
    expect(maybeOpenProactiveGap(db, args).opened).toBe(true);
    // Resolve (an artifact got admitted) → gap no longer "open" but cooldown applies.
    resolveProactiveGap(db, "shape_cool", "art_built");
    // Anchor the cooldown arithmetic on the ACTUAL detection ts the seam wrote.
    // proactiveGapSuppressed compares the caller's nowMs against the stored
    // event ts (`nowMs - Date.parse(ts)`), and emitEvent stamps that ts from
    // the real wall clock — NOT from any nowMs passed to maybeOpenProactiveGap.
    // Anchoring the +/-1ms boundary offsets on a separately-captured Date.now()
    // left only a sub-millisecond margin against the execution delay between
    // that capture and the emit; under parallel-suite contention that delay
    // exceeded 1ms, so the "after" boundary fell back inside the cooldown window
    // — flaking the full-suite run while passing in isolation. Reading the
    // persisted ts back makes the boundary math independent of that delay.
    const detectMs = Date.parse(
      (db
        .query(
          `SELECT ts FROM events
             WHERE kind = 'capability_gap_detected'
               AND json_extract(payload, '$.goal_shape') = 'shape_cool'
               AND json_extract(payload, '$.reason') = 'proactive_no_fit'
             ORDER BY ts DESC LIMIT 1`,
        )
        .get() as { ts: string }).ts,
    );
    // Within the cooldown window after the detection → suppressed by cooldown.
    const within = maybeOpenProactiveGap(db, args, { nowMs: detectMs + CAPGAP_PROACTIVE_COOLDOWN_MS_FOR_TEST - 1 });
    expect(within.opened).toBe(false);
    expect(within.skip_reason).toBe("suppressed_cooldown");
    // After the cooldown elapses (and still poor fit) → re-opens.
    const after = maybeOpenProactiveGap(db, args, { nowMs: detectMs + CAPGAP_PROACTIVE_COOLDOWN_MS_FOR_TEST + 1 });
    expect(after.opened).toBe(true);
  });

  test("attempt-cap stops authoring for a persistently-unservable goal_shape", () => {
    const db = openDb(":memory:");
    const args = { goal_shape: "shape_hard", best_fit: 0.05, candidate_count: 1, wants_artifact: true };
    const base = Date.now();
    let cursor = base;
    let opens = 0;
    // Each cycle: open, resolve (author never produces a fit), advance past cooldown.
    for (let i = 0; i < CAPGAP_PROACTIVE_MAX_ATTEMPTS_FOR_TEST + 3; i++) {
      const r = maybeOpenProactiveGap(db, args, { nowMs: cursor });
      if (r.opened) {
        opens += 1;
        resolveProactiveGap(db, "shape_hard", `art_try_${i}`);
      } else {
        // Once attempt-cap hits, it stays suppressed.
        expect(["suppressed_attempt_cap", "suppressed_cooldown", "suppressed_open"]).toContain(r.skip_reason as string);
      }
      // Advance the clock past the cooldown so only the attempt-cap (not the
      // cooldown) can be the terminal suppressor.
      cursor += CAPGAP_PROACTIVE_COOLDOWN_MS_FOR_TEST + 1;
    }
    expect(opens).toBe(CAPGAP_PROACTIVE_MAX_ATTEMPTS_FOR_TEST);
    // The final state is attempt-capped.
    const final = maybeOpenProactiveGap(db, args, { nowMs: cursor + CAPGAP_PROACTIVE_COOLDOWN_MS_FOR_TEST * 10 });
    expect(final.opened).toBe(false);
    expect(final.skip_reason).toBe("suppressed_attempt_cap");
  });

  test("resolveProactiveGap closes an open proactive gap (composition with admission)", () => {
    const db = openDb(":memory:");
    maybeOpenProactiveGap(db, { goal_shape: "shape_admit", best_fit: 0.1, candidate_count: 1, wants_artifact: true });
    expect(proactiveGapSuppressed(db, "shape_admit").reason).toBe("open");
    const resolved = resolveProactiveGap(db, "shape_admit", "art_admitted");
    expect(resolved).toBe(true);
    // No longer "open" — now governed by cooldown.
    expect(proactiveGapSuppressed(db, "shape_admit").reason).not.toBe("open");
    // resolving again is a no-op (no open gap).
    expect(resolveProactiveGap(db, "shape_admit", "art_admitted")).toBe(false);
  });

  test("shared openCapabilityGap yields a well-formed author directive for BOTH triggers", () => {
    const db = openDb(":memory:");
    insertArtifact(db, {
      id: "art_shared_fail", runtime: "bun", kind: "runtime_action", body: "//", declaredSandbox: null,
      stateRoot: null, posteriorAlpha: 1, posteriorBeta: 6, score: 0.1, confidence: 0.5,
      recentResidualMean: 0.9, recentKillCount: 0, status: "quarantined", name: null,
      fixtureInput: null, fixtureExpectedResidual: null, intent: "ship the nightly report",
    });
    // Failure trigger via the shared seam.
    const f = openCapabilityGap(db, {
      goal_shape: "shape_sf", reason: "artifact_failing", trigger: "failure",
      evidence: "failing evidence", failing_artifact_id: "art_shared_fail", artifact_kind: "runtime_action",
      intent: "ship the nightly report", residual_evidence: { mean: 0.9, observations: 6 },
    });
    // Proactive trigger via the SAME seam.
    const p = openCapabilityGap(db, {
      goal_shape: "shape_sp", reason: "proactive_no_fit", trigger: "selection",
      evidence: "no fit", failing_artifact_id: null, artifact_kind: "unknown",
      goal_text: "draft the launch announcement", fit_evidence: { best_fit: 0.1, candidate_count: 2 },
    });

    const readDir = (directiveId: string) => JSON.parse(
      (db.query(`SELECT payload FROM events WHERE kind='directive_opened' AND directive_id = ?`).get(directiveId) as { payload: string }).payload,
    );
    const fdir = readDir(f.directive_id);
    const pdir = readDir(p.directive_id);
    // BOTH directives instruct authoring an act_artifact_candidate.
    expect(fdir.directive_text).toContain("act_artifact_candidate");
    expect(fdir.directive_text).toContain("ship the nightly report");
    expect(f.directive_id.startsWith("capgap_")).toBe(true);
    expect(pdir.directive_text).toContain("act_artifact_candidate");
    expect(pdir.directive_text).toContain("draft the launch announcement");
    expect(p.directive_id.startsWith("capgap_proactive_")).toBe(true);
    // BOTH open a root task_node under their directive.
    const readRoot = (directiveId: string) => db.query(
      `SELECT task_id, parent_task_id FROM events WHERE kind='task_node_opened' AND directive_id = ?`,
    ).get(directiveId) as { task_id: string; parent_task_id: string | null };
    const rootF = readRoot(f.directive_id);
    const rootP = readRoot(p.directive_id);
    expect(rootF.parent_task_id).toBeNull();
    expect(rootP.parent_task_id).toBeNull();
    expect(rootF.task_id).toBe(`${f.directive_id}_root`);
    expect(rootP.task_id).toBe(`${p.directive_id}_root`);
  });

  test("composeProactiveAuthorDirective describes zero-candidate vs poor-fit", () => {
    const zero = composeProactiveAuthorDirective({
      goal_shape: "s", reason: "proactive_no_fit", trigger: "selection", evidence: "",
      failing_artifact_id: null, artifact_kind: "unknown", goal_text: "g",
      fit_evidence: { best_fit: 0, candidate_count: 0 },
    });
    expect(zero).toContain("0 candidates");
    const poor = composeProactiveAuthorDirective({
      goal_shape: "s", reason: "proactive_no_fit", trigger: "selection", evidence: "",
      failing_artifact_id: null, artifact_kind: "unknown", goal_text: "g",
      fit_evidence: { best_fit: 0.2, candidate_count: 4 },
    });
    expect(poor).toContain("0.200");
    expect(poor).toContain("SANDREPAIR");
  });
});
