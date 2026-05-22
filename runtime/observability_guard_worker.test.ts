// Observability-fidelity guard worker tests (phase-2 SJPF3VB9).
//
// Proves the two institutionalized self-audits:
//   1. An inert loop (upstream >= min, loop == 0) → loop_inert_alert.
//   2. A healthy loop (loop > 0) → NO alert.
//   3. A diverging metric (vec_events != genuine-embedding count) →
//      metric_veracity_alert.
//   4. A matching metric → no alert.
//   5. Idempotency — a second tick in the same window does NOT emit a
//      duplicate loop_inert_alert.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { newId } from "./ids";
import { observabilityGuardTick } from "./observability_guard_worker";
import { upsertVecEventRow, EMBEDDING_DIMS } from "./embedder";

const FIXED_NOW = new Date("2026-05-22T12:00:00.000Z");

afterAll(() => closeDb());
beforeEach(() => closeDb());

const recentTs = (ageMs: number): string =>
  new Date(FIXED_NOW.getTime() - ageMs).toISOString();

/** Insert a bare event row of a given kind at a given ts. */
const insertEvent = (
  db: ReturnType<typeof openDb>,
  kind: string,
  ts: string,
  opts: { embedding?: Uint8Array | null } = {},
): string => {
  const id = newId();
  db.run(
    `INSERT INTO events (
       id, ts, directive_id, task_id, parent_task_id, loop_id,
       substrate_origin, kind, payload, context_refs, embedding
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      ts,
      "directive_test",
      "task_test",
      null,
      "loop_root",
      "substrate_auto",
      kind,
      JSON.stringify({}),
      JSON.stringify([]),
      opts.embedding ?? null,
    ],
  );
  return id;
};

/** Insert N rows of a kind across the trailing window. */
const insertMany = (
  db: ReturnType<typeof openDb>,
  kind: string,
  count: number,
): void => {
  for (let i = 0; i < count; i += 1) {
    insertEvent(db, kind, recentTs(60_000 + i)); // ~1min ago, well inside 24h
  }
};

const countAlerts = (
  db: ReturnType<typeof openDb>,
  kind: "loop_inert_alert" | "metric_veracity_alert",
  loopKind?: string,
): number => {
  if (loopKind) {
    const row = db
      .query<{ c: number }, [string]>(
        `SELECT COUNT(*) AS c FROM events
          WHERE kind = 'loop_inert_alert'
            AND json_extract(payload, '$.loop_kind') = ?`,
      )
      .get(loopKind);
    return row?.c ?? 0;
  }
  const row = db
    .query<{ c: number }, [string]>(
      "SELECT COUNT(*) AS c FROM events WHERE kind = ? AND json_extract(payload, '$.guard_check_error') IS NULL",
    )
    .get(kind);
  return row?.c ?? 0;
};

describe("observabilityGuardTick — wired-but-inert loop detection", () => {
  test("inert loop (upstream >= min, loop == 0) emits loop_inert_alert", async () => {
    const db = openDb();
    // counterfactual_alternative_recorded fired 60 times (>= 50) but
    // counterfactual_closure_audited emitted 0 → wired-but-inert.
    insertMany(db, "counterfactual_alternative_recorded", 60);

    const summary = await observabilityGuardTick(db, undefined, { now: FIXED_NOW });

    expect(summary.inert_alerts_emitted).toBeGreaterThanOrEqual(1);
    expect(countAlerts(db, "loop_inert_alert", "counterfactual_closure_audited")).toBe(1);
  });

  test("healthy loop (loop > 0) emits NO alert", async () => {
    const db = openDb();
    insertMany(db, "counterfactual_alternative_recorded", 60);
    // Loop is alive: at least one closure audit fired.
    insertEvent(db, "counterfactual_closure_audited", recentTs(30_000));

    await observabilityGuardTick(db, undefined, { now: FIXED_NOW });

    expect(countAlerts(db, "loop_inert_alert", "counterfactual_closure_audited")).toBe(0);
  });

  test("upstream below min threshold emits NO alert", async () => {
    const db = openDb();
    // Only 10 upstream rows (< 50) — not enough to expect the loop.
    insertMany(db, "counterfactual_alternative_recorded", 10);

    await observabilityGuardTick(db, undefined, { now: FIXED_NOW });

    expect(countAlerts(db, "loop_inert_alert", "counterfactual_closure_audited")).toBe(0);
  });

  test("idempotency — second tick in same window emits no duplicate", async () => {
    const db = openDb();
    insertMany(db, "counterfactual_alternative_recorded", 60);

    await observabilityGuardTick(db, undefined, { now: FIXED_NOW });
    expect(countAlerts(db, "loop_inert_alert", "counterfactual_closure_audited")).toBe(1);

    // Run again a few minutes later — still inside the 24h window.
    const later = new Date(FIXED_NOW.getTime() + 5 * 60 * 1000);
    const summary2 = await observabilityGuardTick(db, undefined, { now: later });

    expect(summary2.inert_skipped_idempotent).toBeGreaterThanOrEqual(1);
    expect(countAlerts(db, "loop_inert_alert", "counterfactual_closure_audited")).toBe(1);
  });
});

describe("observabilityGuardTick — lying-metric (veracity) detection", () => {
  test("orphaned vec_events row (resolves to neither event nor act_artifact) emits metric_veracity_alert", async () => {
    const db = openDb();
    // Create a TRUE orphan: insert an event, project its vec_events row,
    // then delete the event — the vec_events row now points at a vanished
    // source. The honest retrieval-index integrity metric is orphan count,
    // which MUST be 0; a non-zero orphan count is the lying-metric/stale-
    // index signal the guard exists to catch.
    const orphanId = insertEvent(db, "action_predicted", recentTs(60_000));
    const emb = new Array(EMBEDDING_DIMS).fill(0.01);
    upsertVecEventRow(db, orphanId, emb, "v1");
    db.run("DELETE FROM events WHERE id = ?", [orphanId]);

    const summary = await observabilityGuardTick(db, undefined, { now: FIXED_NOW });

    expect(summary.check_errors).toBe(0);
    expect(summary.metric_alerts_emitted).toBeGreaterThanOrEqual(1);
    expect(countAlerts(db, "metric_veracity_alert")).toBeGreaterThanOrEqual(1);
  });

  test("matching metric emits no alert", async () => {
    const db = openDb();
    // No vec_events rows and no genuinely-embedded events → reported == ground == 0.
    const summary = await observabilityGuardTick(db, undefined, { now: FIXED_NOW });

    expect(summary.metric_skipped_within_tolerance).toBeGreaterThanOrEqual(1);
    expect(countAlerts(db, "metric_veracity_alert")).toBe(0);
  });
});

/** Insert an error_caught row carrying a (where, message) payload. */
const insertErrorCaught = (
  db: ReturnType<typeof openDb>,
  where: string,
  message: string,
  ageMs: number,
): void => {
  const id = newId();
  db.run(
    `INSERT INTO events (
       id, ts, directive_id, task_id, parent_task_id, loop_id,
       substrate_origin, kind, payload, context_refs, embedding
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      recentTs(ageMs),
      "directive_test",
      "task_test",
      null,
      "loop_root",
      "substrate_auto",
      "error_caught",
      JSON.stringify({ where, message, recoverable: true }),
      JSON.stringify([]),
      null,
    ],
  );
};

const countFloodAlerts = (
  db: ReturnType<typeof openDb>,
  where?: string,
  message?: string,
): number => {
  if (where && message) {
    const row = db
      .query<{ c: number }, [string, string]>(
        `SELECT COUNT(*) AS c FROM events
          WHERE kind = 'error_flood_alert'
            AND json_extract(payload, '$.where') = ?
            AND json_extract(payload, '$.message') = ?`,
      )
      .get(where, message);
    return row?.c ?? 0;
  }
  const row = db
    .query<{ c: number }, []>(
      "SELECT COUNT(*) AS c FROM events WHERE kind = 'error_flood_alert'",
    )
    .get();
  return row?.c ?? 0;
};

describe("observabilityGuardTick — error-flood watch", () => {
  test("same (where,message) repeated past threshold emits one error_flood_alert naming the culprit", async () => {
    const db = openDb();
    const where = "daemon.worker.sql_worker";
    const message = "sql_worker_query_failed:no such module: vec0";
    // 60 (> 50 threshold) of the SAME error, all inside the 1h flood window.
    for (let i = 0; i < 60; i += 1) {
      insertErrorCaught(db, where, message, 60_000 + i * 1000);
    }

    const summary = await observabilityGuardTick(db, undefined, { now: FIXED_NOW });

    expect(summary.error_flood_alerts_emitted).toBe(1);
    expect(countFloodAlerts(db, where, message)).toBe(1);
    // The alert names the exact culprit and reports the count/threshold.
    const row = db
      .query<{ payload: string }, []>(
        "SELECT payload FROM events WHERE kind = 'error_flood_alert' LIMIT 1",
      )
      .get();
    const payload = JSON.parse(row!.payload);
    expect(payload.where).toBe(where);
    expect(payload.message).toBe(message);
    expect(payload.count).toBe(60);
    expect(payload.threshold).toBe(50);
    expect(payload.window_hours).toBe(1);
  });

  test("a diversity of distinct errors (each below threshold) emits NO alert", async () => {
    const db = openDb();
    // 10 distinct errors, 10 occurrences each (< 50) → benign diversity.
    for (let g = 0; g < 10; g += 1) {
      for (let i = 0; i < 10; i += 1) {
        insertErrorCaught(db, `where_${g}`, `message_${g}`, 60_000 + i * 1000);
      }
    }

    const summary = await observabilityGuardTick(db, undefined, { now: FIXED_NOW });

    expect(summary.error_flood_alerts_emitted).toBe(0);
    expect(countFloodAlerts(db)).toBe(0);
  });

  test("idempotency — second tick in the same flood window does not re-alert", async () => {
    const db = openDb();
    const where = "daemon.worker.sql_worker";
    const message = "sql_worker_query_failed:no such module: vec0";
    for (let i = 0; i < 60; i += 1) {
      insertErrorCaught(db, where, message, 60_000 + i * 1000);
    }

    await observabilityGuardTick(db, undefined, { now: FIXED_NOW });
    expect(countFloodAlerts(db, where, message)).toBe(1);

    // Run again a few minutes later — still inside the 1h flood window.
    const later = new Date(FIXED_NOW.getTime() + 5 * 60 * 1000);
    const summary2 = await observabilityGuardTick(db, undefined, { now: later });

    expect(summary2.error_flood_skipped_idempotent).toBeGreaterThanOrEqual(1);
    expect(countFloodAlerts(db, where, message)).toBe(1);
  });
});
