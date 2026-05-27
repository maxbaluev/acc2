import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { newId } from "./ids";
import {
  compactBridgeFrames,
  compactDerivedEvents,
  compactionWorkerTick,
  COMPACTABLE_DERIVED_EVENT_KINDS,
  COMPACTION_DERIVED_RETENTION_MS,
  COMPACTION_FRAME_RETENTION_MS,
} from "./compaction";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const insertEvent = (
  db: ReturnType<typeof openDb>,
  kind: string,
  ts: string,
  taskId: string,
  directiveId: string,
  payload: object = {},
) => {
  db.query(
    `INSERT INTO events (id, ts, kind, substrate_origin, directive_id, task_id, loop_id, payload)
     VALUES (?, ?, ?, 'substrate_auto', ?, ?, '', ?)`,
  ).run(newId(), ts, kind, directiveId, taskId, JSON.stringify(payload));
};

describe("compaction.compactBridgeFrames", () => {
  test("does not touch frames within the retention window", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    const taskId = newId();
    const directiveId = newId();
    // Frame at -1h (well inside the 24h retention window)
    insertEvent(db, "bridge_frame_received", new Date(now - 60 * 60 * 1000).toISOString(), taskId, directiveId);
    insertEvent(db, "brain_dispatch_closed", new Date(now - 60 * 60 * 1000).toISOString(), taskId, directiveId);
    const report = compactBridgeFrames(db, { nowMs: now });
    expect(report.pruned_frames).toBe(0);
    const left = db.query("SELECT COUNT(*) AS c FROM events WHERE kind = 'bridge_frame_received'").get() as { c: number };
    expect(left.c).toBe(1);
  });

  test("prunes frames older than retention AND whose dispatch closed", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    const taskId = newId();
    const directiveId = newId();
    const frameTs = new Date(now - (COMPACTION_FRAME_RETENTION_MS + 60_000)).toISOString();
    insertEvent(db, "bridge_frame_received", frameTs, taskId, directiveId);
    // Closing event SLIGHTLY after the frame, still in the past.
    const closeTs = new Date(now - (COMPACTION_FRAME_RETENTION_MS - 1000)).toISOString();
    insertEvent(db, "brain_dispatch_closed", closeTs, taskId, directiveId);
    const report = compactBridgeFrames(db, { nowMs: now });
    expect(report.pruned_frames).toBe(1);
    const left = db.query("SELECT COUNT(*) AS c FROM events WHERE kind = 'bridge_frame_received'").get() as { c: number };
    expect(left.c).toBe(0);
    // The closing event is preserved
    const closed = db.query("SELECT COUNT(*) AS c FROM events WHERE kind = 'brain_dispatch_closed'").get() as { c: number };
    expect(closed.c).toBe(1);
  });

  test("does NOT prune frames whose dispatch is still in-flight", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    const taskId = newId();
    const directiveId = newId();
    const frameTs = new Date(now - (COMPACTION_FRAME_RETENTION_MS + 60_000)).toISOString();
    insertEvent(db, "bridge_frame_received", frameTs, taskId, directiveId);
    // NO closing event — dispatch still open even though > 24h old.
    const report = compactBridgeFrames(db, { nowMs: now });
    expect(report.pruned_frames).toBe(0);
    const left = db.query("SELECT COUNT(*) AS c FROM events WHERE kind = 'bridge_frame_received'").get() as { c: number };
    expect(left.c).toBe(1);
  });

  test("respects batchSize cap (bounded write lock window)", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    const oldTs = new Date(now - (COMPACTION_FRAME_RETENTION_MS + 60_000)).toISOString();
    const taskId = newId();
    const directiveId = newId();
    // Seed many frames, all under one closed dispatch
    for (let i = 0; i < 10; i++) {
      insertEvent(db, "bridge_frame_received", oldTs, taskId, directiveId);
    }
    insertEvent(db, "brain_dispatch_closed", oldTs, taskId, directiveId);
    const report = compactBridgeFrames(db, { nowMs: now, batchSize: 3 });
    expect(report.pruned_frames).toBe(3);
    const left = db.query("SELECT COUNT(*) AS c FROM events WHERE kind = 'bridge_frame_received'").get() as { c: number };
    expect(left.c).toBe(7);
  });

  test("never touches non-frame event kinds (canonical events stay forever)", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    const oldTs = new Date(now - (COMPACTION_FRAME_RETENTION_MS + 60_000)).toISOString();
    const taskId = newId();
    const directiveId = newId();
    insertEvent(db, "task_committed", oldTs, taskId, directiveId);
    insertEvent(db, "action_predicted", oldTs, taskId, directiveId);
    insertEvent(db, "brain_dispatched", oldTs, taskId, directiveId);
    insertEvent(db, "lesson_extracted", oldTs, taskId, directiveId);
    compactBridgeFrames(db, { nowMs: now });
    const counts = db
      .query("SELECT kind, COUNT(*) AS c FROM events GROUP BY kind ORDER BY kind")
      .all() as Array<{ kind: string; c: number }>;
    expect(counts.length).toBe(4);
    for (const r of counts) expect(r.c).toBe(1);
  });
});

describe("compaction.compactDerivedEvents", () => {
  const oldDerivedTs = (now: number) =>
    new Date(now - (COMPACTION_DERIVED_RETENTION_MS + 60_000)).toISOString();
  const youngDerivedTs = (now: number) =>
    new Date(now - (COMPACTION_DERIVED_RETENTION_MS - 60_000)).toISOString();

  test("prunes derived telemetry rows older than the 7d retention window", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    const taskId = newId();
    const directiveId = newId();
    for (const kind of COMPACTABLE_DERIVED_EVENT_KINDS) {
      insertEvent(db, kind, oldDerivedTs(now), taskId, directiveId);
    }
    const pruned = compactDerivedEvents(db, { nowMs: now });
    expect(pruned).toBe(COMPACTABLE_DERIVED_EVENT_KINDS.length);
    const left = db
      .query(`SELECT COUNT(*) AS c FROM events WHERE kind IN (${COMPACTABLE_DERIVED_EVENT_KINDS.map(() => "?").join(",")})`)
      .get(...COMPACTABLE_DERIVED_EVENT_KINDS) as { c: number };
    expect(left.c).toBe(0);
  });

  test("keeps derived telemetry rows newer than the retention window", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    const taskId = newId();
    const directiveId = newId();
    for (const kind of COMPACTABLE_DERIVED_EVENT_KINDS) {
      insertEvent(db, kind, youngDerivedTs(now), taskId, directiveId);
    }
    const pruned = compactDerivedEvents(db, { nowMs: now });
    expect(pruned).toBe(0);
    const left = db
      .query(`SELECT COUNT(*) AS c FROM events WHERE kind IN (${COMPACTABLE_DERIVED_EVENT_KINDS.map(() => "?").join(",")})`)
      .get(...COMPACTABLE_DERIVED_EVENT_KINDS) as { c: number };
    expect(left.c).toBe(COMPACTABLE_DERIVED_EVENT_KINDS.length);
  });

  test("never prunes non-listed kinds even when aged", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    const ts = oldDerivedTs(now);
    const taskId = newId();
    const directiveId = newId();
    // candidate_confirmed + origin_calibration_recorded were EXCLUDED as
    // load-bearing (credit/retrieval binding; calibration rollup). They must
    // survive the derived sweep regardless of age.
    insertEvent(db, "candidate_confirmed", ts, taskId, directiveId);
    insertEvent(db, "origin_calibration_recorded", ts, taskId, directiveId);
    insertEvent(db, "task_committed", ts, taskId, directiveId);
    insertEvent(db, "retrieval_binding", ts, taskId, directiveId);
    const pruned = compactDerivedEvents(db, { nowMs: now });
    expect(pruned).toBe(0);
    const counts = db
      .query("SELECT kind, COUNT(*) AS c FROM events GROUP BY kind")
      .all() as Array<{ kind: string; c: number }>;
    expect(counts.length).toBe(4);
    for (const r of counts) expect(r.c).toBe(1);
  });

  test("prunes the four added telemetry kinds after retention but never the credit/knowledge spine", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    const ts = oldDerivedTs(now);
    const taskId = newId();
    const directiveId = newId();
    const addedTelemetryKinds = [
      "brain_liveness_heartbeat",
      "sandbox_unenforced_warning",
      "task_deferred_for_interference",
      "constitutional_gate_decision",
    ] as const;
    // Every added kind must be in the compactable allowlist.
    for (const kind of addedTelemetryKinds) {
      expect(COMPACTABLE_DERIVED_EVENT_KINDS).toContain(kind);
      insertEvent(db, kind, ts, taskId, directiveId);
    }
    // The credit/knowledge spine kind must survive regardless of age.
    insertEvent(db, "candidate_confirmed", ts, taskId, directiveId);
    const pruned = compactDerivedEvents(db, { nowMs: now });
    expect(pruned).toBe(addedTelemetryKinds.length);
    // All four telemetry kinds gone.
    const telemetryLeft = db
      .query(`SELECT COUNT(*) AS c FROM events WHERE kind IN (${addedTelemetryKinds.map(() => "?").join(",")})`)
      .get(...addedTelemetryKinds) as { c: number };
    expect(telemetryLeft.c).toBe(0);
    // Credit/knowledge spine row untouched.
    const spineLeft = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'candidate_confirmed'")
      .get() as { c: number };
    expect(spineLeft.c).toBe(1);
  });

  test("excludes the load-bearing kinds from the compactable set", () => {
    // Structural guard: the credit/retrieval-binding and calibration-rollup
    // kinds must never appear in the prune allowlist.
    expect(COMPACTABLE_DERIVED_EVENT_KINDS).not.toContain("candidate_confirmed");
    expect(COMPACTABLE_DERIVED_EVENT_KINDS).not.toContain("origin_calibration_recorded");
  });

  test("respects batchSize cap (bounded write lock window)", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    const ts = oldDerivedTs(now);
    const taskId = newId();
    const directiveId = newId();
    for (let i = 0; i < 10; i++) {
      insertEvent(db, "worker_tick_completed", ts, taskId, directiveId);
    }
    const pruned = compactDerivedEvents(db, { nowMs: now, batchSize: 3 });
    expect(pruned).toBe(3);
    const left = db.query("SELECT COUNT(*) AS c FROM events WHERE kind = 'worker_tick_completed'").get() as { c: number };
    expect(left.c).toBe(7);
  });
});

describe("compactionWorkerTick", () => {
  test("emits substrate_compacted only when rows were actually pruned", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    const oldTs = new Date(now - (COMPACTION_FRAME_RETENTION_MS + 60_000)).toISOString();
    const taskId = newId();
    const directiveId = newId();
    insertEvent(db, "bridge_frame_received", oldTs, taskId, directiveId);
    insertEvent(db, "brain_dispatch_closed", oldTs, taskId, directiveId);
    const r1 = compactionWorkerTick(db);
    expect(r1.pruned_frames).toBe(1);
    const evt = db.query("SELECT COUNT(*) AS c FROM events WHERE kind = 'substrate_compacted'").get() as { c: number };
    expect(evt.c).toBe(1);

    // Second tick: nothing to prune; do NOT emit a fresh substrate_compacted.
    const r2 = compactionWorkerTick(db);
    expect(r2.pruned_frames).toBe(0);
    const evt2 = db.query("SELECT COUNT(*) AS c FROM events WHERE kind = 'substrate_compacted'").get() as { c: number };
    expect(evt2.c).toBe(1);
  });

  test("prunes aged derived telemetry and reports pruned_derived in the tick", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    const oldTs = new Date(now - (COMPACTION_DERIVED_RETENTION_MS + 60_000)).toISOString();
    const taskId = newId();
    const directiveId = newId();
    insertEvent(db, "worker_tick_completed", oldTs, taskId, directiveId);
    insertEvent(db, "sql_worker_pool_metrics", oldTs, taskId, directiveId);
    const r1 = compactionWorkerTick(db);
    expect(r1.pruned_frames).toBe(0);
    expect(r1.pruned_derived).toBe(2);
    // substrate_compacted is emitted even when only derived rows were pruned.
    const evt = db
      .query("SELECT payload FROM events WHERE kind = 'substrate_compacted'")
      .all() as Array<{ payload: string }>;
    expect(evt.length).toBe(1);
    const payload = JSON.parse(evt[0].payload) as { pruned_derived: number };
    expect(payload.pruned_derived).toBe(2);

    // Second tick: nothing left to prune; no fresh substrate_compacted.
    const r2 = compactionWorkerTick(db);
    expect(r2.pruned_derived).toBe(0);
    const evt2 = db.query("SELECT COUNT(*) AS c FROM events WHERE kind = 'substrate_compacted'").get() as { c: number };
    expect(evt2.c).toBe(1);
  });
});
