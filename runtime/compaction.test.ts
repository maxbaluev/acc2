import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { newId } from "./ids";
import {
  compactBridgeFrames,
  compactDerivedEvents,
  compactionWorkerTick,
  COMPACTABLE_DERIVED_EVENT_KINDS,
  COMPACTION_DERIVED_MIN_RETENTION_MS,
  COMPACTION_DERIVED_RETENTION_MS,
  COMPACTION_FRAME_RETENTION_MS,
  COMPACTION_HIGHRATE_RETENTION_MS,
  HIGH_RATE_TELEMETRY_KINDS,
  retentionForKind,
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

  test("keeps NON-high-rate derived telemetry rows newer than the 7d window", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    const taskId = newId();
    const directiveId = newId();
    // Only non-high-rate derived kinds follow the 7d/1d window. High-rate
    // kinds now follow the short 1h tier and would be pruned at this age, so
    // they are excluded here (their behavior is covered in compaction.highRateTier).
    const nonHighRate = COMPACTABLE_DERIVED_EVENT_KINDS.filter(
      (k) => !HIGH_RATE_TELEMETRY_KINDS.includes(k),
    );
    expect(nonHighRate.length).toBeGreaterThan(0);
    for (const kind of nonHighRate) {
      insertEvent(db, kind, youngDerivedTs(now), taskId, directiveId);
    }
    const pruned = compactDerivedEvents(db, { nowMs: now });
    expect(pruned).toBe(0);
    const left = db
      .query(`SELECT COUNT(*) AS c FROM events WHERE kind IN (${nonHighRate.map(() => "?").join(",")})`)
      .get(...nonHighRate) as { c: number };
    expect(left.c).toBe(nonHighRate.length);
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

describe("compaction.highRateTier", () => {
  // A ts older than the 1h high-rate window but YOUNGER than the 1d derived
  // floor — proves the high-rate tier prunes on its own shorter cutoff and
  // does not wait for the derived MIN.
  const betweenHighRateAndDerivedMinTs = (now: number) =>
    new Date(now - (COMPACTION_HIGHRATE_RETENTION_MS + 60_000)).toISOString();
  // A ts younger than the 1d derived MIN floor (and thus younger than the 7d
  // default) — non-high-rate derived kinds must survive at this age.
  const youngerThanDerivedMinTs = (now: number) =>
    new Date(now - (COMPACTION_DERIVED_MIN_RETENTION_MS - 60 * 60 * 1000)).toISOString();

  test("default high-rate retention is 1h", () => {
    expect(COMPACTION_HIGHRATE_RETENTION_MS).toBe(60 * 60 * 1000);
  });

  test("retentionForKind: high-rate kinds resolve to the short window, others to the derived window", () => {
    for (const k of HIGH_RATE_TELEMETRY_KINDS) {
      expect(retentionForKind(k)).toBe(COMPACTION_HIGHRATE_RETENTION_MS);
    }
    // brain_reasoning_recorded is compactable but NOT high-rate.
    expect(retentionForKind("brain_reasoning_recorded")).toBe(COMPACTION_DERIVED_RETENTION_MS);
    // A kind in neither set still resolves to the derived window (caller's
    // pressure-compressed value when supplied).
    expect(retentionForKind("anything", { derivedRetentionMs: 123 })).toBe(123);
  });

  test("prunes high-rate kinds older than 1h even when younger than the 1d derived MIN", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    const taskId = newId();
    const directiveId = newId();
    // Age between the 1h high-rate window and the 1d derived floor.
    const ts = betweenHighRateAndDerivedMinTs(now);
    // Sanity: this ts is younger than the derived MIN, so the OLD single-tier
    // behavior (cutoff at the 1d floor) would NOT have pruned these.
    expect(now - new Date(ts).getTime()).toBeLessThan(COMPACTION_DERIVED_MIN_RETENTION_MS);

    // Insert every high-rate kind EXCEPT bridge_frame_received (which the
    // derived pass deliberately leaves to compactBridgeFrames).
    const highRateNonFrame = HIGH_RATE_TELEMETRY_KINDS.filter((k) => k !== "bridge_frame_received");
    for (const kind of highRateNonFrame) {
      insertEvent(db, kind, ts, taskId, directiveId);
    }
    // A non-high-rate derived kind at the SAME (young) age must survive the
    // derived 1d/7d window.
    insertEvent(db, "brain_reasoning_recorded", ts, taskId, directiveId);
    // Credit/knowledge spine kind must NEVER be pruned regardless of age.
    insertEvent(db, "candidate_confirmed", ts, taskId, directiveId);

    // Run with the pressure-compressed derived window at its 1d floor — the
    // most aggressive derived window — to prove the high-rate tier prunes
    // EARLIER than even the floor.
    const pruned = compactDerivedEvents(db, {
      nowMs: now,
      retentionMs: COMPACTION_DERIVED_MIN_RETENTION_MS,
    });
    expect(pruned).toBe(highRateNonFrame.length);

    // All high-rate non-frame kinds gone.
    const hrLeft = db
      .query(`SELECT COUNT(*) AS c FROM events WHERE kind IN (${highRateNonFrame.map(() => "?").join(",")})`)
      .get(...highRateNonFrame) as { c: number };
    expect(hrLeft.c).toBe(0);
    // Non-high-rate derived kind survives (younger than the 1d derived window).
    const derivedLeft = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'brain_reasoning_recorded'")
      .get() as { c: number };
    expect(derivedLeft.c).toBe(1);
    // Credit spine survives.
    const spineLeft = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'candidate_confirmed'")
      .get() as { c: number };
    expect(spineLeft.c).toBe(1);
  });

  test("keeps non-high-rate derived kinds on the 7d/1d window (not the 1h tier)", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    const taskId = newId();
    const directiveId = newId();
    // Old enough for the 1h high-rate tier but younger than the 7d derived
    // window — a non-high-rate derived kind must SURVIVE.
    const ts = youngerThanDerivedMinTs(now);
    insertEvent(db, "brain_reasoning_recorded", ts, taskId, directiveId);
    insertEvent(db, "sql_worker_pool_metrics", ts, taskId, directiveId);
    const pruned = compactDerivedEvents(db, { nowMs: now });
    expect(pruned).toBe(0);
    const left = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind IN ('brain_reasoning_recorded','sql_worker_pool_metrics')")
      .get() as { c: number };
    expect(left.c).toBe(2);
  });

  test("derived pass never deletes bridge_frame_received (no double-delete with compactBridgeFrames)", () => {
    const db = openDb(":memory:");
    const now = Date.now();
    const taskId = newId();
    const directiveId = newId();
    // A very old, closed frame — eligible for compactBridgeFrames AND older
    // than the 1h high-rate window. The DERIVED pass must still leave it alone
    // (only compactBridgeFrames owns frame deletion), so the two passes never
    // contend for the same row.
    const frameTs = new Date(now - (COMPACTION_FRAME_RETENTION_MS + 60_000)).toISOString();
    insertEvent(db, "bridge_frame_received", frameTs, taskId, directiveId);
    insertEvent(db, "brain_dispatch_closed", frameTs, taskId, directiveId);

    const prunedDerived = compactDerivedEvents(db, { nowMs: now });
    expect(prunedDerived).toBe(0); // derived pass did NOT touch the frame
    const stillThere = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'bridge_frame_received'")
      .get() as { c: number };
    expect(stillThere.c).toBe(1);

    // The frame path prunes it; a follow-up derived pass is still a no-op
    // (idempotent, no error).
    const frameReport = compactBridgeFrames(db, { nowMs: now });
    expect(frameReport.pruned_frames).toBe(1);
    expect(compactDerivedEvents(db, { nowMs: now })).toBe(0);
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
