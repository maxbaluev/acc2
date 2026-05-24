// acc2 Tier -1 floor enforcement workers — unit tests.
//
// Per docs/roadmap.md Tier -1: floors precede posterior scoring. Each
// worker emits absence-of-violation evidence on its predicate's
// behalf, and quarantines / surfaces violations as
// integrity_check_failed rows.
//
// Coverage:
//   - event_authenticity_worker: clean pass + tamper detection
//   - storage_integrity_worker:  clean pass emits storage_integrity_check
//                                AND wal_checkpointed
//   - deterministic_computation_worker: empty DB yields sampled=0 +
//                                       residual=0 check row

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { newId } from "./ids";
import { eventAuthenticityWorkerTick } from "./event_authenticity_worker";
import { storageIntegrityWorkerTick } from "./storage_integrity_worker";
import { deterministicComputationWorkerTick } from "./deterministic_computation_worker";

const FIXED_NOW = new Date("2026-05-20T12:00:00.000Z");

afterAll(() => closeDb());
beforeEach(() => closeDb());

type Row = { payload: string; kind: string };

const insertRawEvent = (
  db: ReturnType<typeof openDb>,
  opts: {
    id?: string;
    ts?: string;
    kind: string;
    substrate_origin: string;
    payload?: Record<string, unknown>;
    action_artifact_id?: string;
    verifier_artifact_id?: string;
    residual?: number;
  },
): string => {
  const id = opts.id ?? newId();
  db.run(
    `INSERT INTO events (
       id, ts, directive_id, task_id, parent_task_id, loop_id,
       substrate_origin, kind, payload, context_refs,
       action_artifact_id, verifier_artifact_id, residual
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      opts.ts ?? FIXED_NOW.toISOString(),
      "directive_test",
      "task_test",
      null,
      "loop_root",
      opts.substrate_origin,
      opts.kind,
      JSON.stringify(opts.payload ?? {}),
      "[]",
      opts.action_artifact_id ?? null,
      opts.verifier_artifact_id ?? null,
      opts.residual ?? null,
    ],
  );
  return id;
};

const findEvent = (
  db: ReturnType<typeof openDb>,
  kind: string,
): Row | null =>
  db
    .query(`SELECT payload, kind FROM events WHERE kind = ? ORDER BY ts DESC LIMIT 1`)
    .get(kind) as Row | null;

const findEvents = (
  db: ReturnType<typeof openDb>,
  kind: string,
): Row[] =>
  db
    .query(`SELECT payload, kind FROM events WHERE kind = ? ORDER BY ts DESC`)
    .all(kind) as Row[];

describe("event_authenticity_worker (Tier -1)", () => {
  test("emits event_authenticity_check with residual=0 on clean DB", () => {
    const db = openDb(":memory:");
    // Seed a handful of canonical-origin events
    insertRawEvent(db, { kind: "directive_opened", substrate_origin: "claude" });
    insertRawEvent(db, { kind: "task_node_opened", substrate_origin: "brain" });
    insertRawEvent(db, { kind: "task_committed", substrate_origin: "brain" });

    const summary = eventAuthenticityWorkerTick(db, { now: FIXED_NOW, minGapMs: 0 });
    expect(summary.emitted_kind).toBe("event_authenticity_check");
    expect(summary.failed).toBe(0);
    expect(summary.passed).toBeGreaterThanOrEqual(3);

    const row = findEvent(db, "event_authenticity_check");
    expect(row).not.toBeNull();
    const payload = JSON.parse(row!.payload);
    expect(payload.residual).toBe(0);
    expect(payload.predicate).toBe("event_authenticity_predicate");
    expect(payload.sampled).toBeGreaterThanOrEqual(3);
    expect(payload.window_seconds).toBe(3600);
  });

  test("emits integrity_check_failed when a row with unknown substrate_origin is seeded", () => {
    const db = openDb(":memory:");
    insertRawEvent(db, { kind: "directive_opened", substrate_origin: "claude" });
    // Tamper row — substrate_origin not in the canonical set
    insertRawEvent(db, { kind: "directive_opened", substrate_origin: "unknown" });

    const summary = eventAuthenticityWorkerTick(db, { now: FIXED_NOW, minGapMs: 0 });
    expect(summary.emitted_kind).toBe("integrity_check_failed");
    expect(summary.failed).toBeGreaterThanOrEqual(1);

    const row = findEvent(db, "integrity_check_failed");
    expect(row).not.toBeNull();
    const payload = JSON.parse(row!.payload);
    expect(payload.floor).toBe("event_authenticity");
    expect(payload.predicate).toBe("event_authenticity_predicate");
    expect(Array.isArray(payload.violations)).toBe(true);
    expect(payload.violations.length).toBeGreaterThanOrEqual(1);
    // Tamper reason should be detected
    const reasons = payload.violations.map((v: { reason: string }) => v.reason);
    expect(reasons).toContain("unrecognized_substrate_origin");
    expect(payload.marker).toBe("event_authenticity_violation_v1");
  });
});

describe("storage_integrity_worker (Tier -1)", () => {
  test("emits storage_integrity_check with status=ok on a fresh DB", () => {
    const db = openDb(":memory:");
    const summary = storageIntegrityWorkerTick(db, { now: FIXED_NOW, minGapMs: 0 });
    expect(summary.skipped).toBe(false);
    expect(summary.integrity_status).toBe("ok");

    const row = findEvent(db, "storage_integrity_check");
    expect(row).not.toBeNull();
    const payload = JSON.parse(row!.payload);
    expect(payload.residual).toBe(0);
    expect(payload.integrity_status).toBe("ok");
    expect(payload.predicate).toBe("storage_integrity_predicate");
    expect(typeof payload.wal_log_pages).toBe("number");
    expect(typeof payload.wal_checkpointed_pages).toBe("number");
  });

  test("also emits wal_checkpointed event on the same tick", () => {
    const db = openDb(":memory:");
    storageIntegrityWorkerTick(db, { now: FIXED_NOW, minGapMs: 0 });

    const row = findEvent(db, "wal_checkpointed");
    expect(row).not.toBeNull();
    const payload = JSON.parse(row!.payload);
    expect(payload.trigger).toBe("storage_integrity_worker");
    expect(typeof payload.busy).toBe("number");
    expect(typeof payload.log_pages).toBe("number");
    expect(typeof payload.checkpointed_pages).toBe("number");
  });
});

describe("deterministic_computation_worker (Tier -1)", () => {
  test("emits deterministic_computation_check with sampled=0 on a DB with no eligible action_scored events", () => {
    const db = openDb(":memory:");
    const summary = deterministicComputationWorkerTick(db, { now: FIXED_NOW, minGapMs: 0 });
    expect(summary.emitted_kind).toBe("deterministic_computation_check");
    expect(summary.sampled).toBe(0);
    expect(summary.agreed).toBe(0);
    expect(summary.mismatched).toBe(0);

    const row = findEvent(db, "deterministic_computation_check");
    expect(row).not.toBeNull();
    const payload = JSON.parse(row!.payload);
    expect(payload.sampled).toBe(0);
    expect(payload.residual).toBe(0);
    expect(payload.tolerance).toBe(0.001);
    expect(payload.predicate).toBe("deterministic_computation_sanity_predicate");
  });

  test("idempotency — second tick within minGapMs is a no-op (skipped)", () => {
    const db = openDb(":memory:");
    // Use real-time now so the lastEmitTsMs read (which sees real-time
    // emit ts) lands inside the min-gap window after the first emit.
    const realNow = new Date();
    const first = deterministicComputationWorkerTick(db, { now: realNow, minGapMs: 0 });
    expect(first.emitted_kind).toBe("deterministic_computation_check");
    // Second tick at the same instant should hit the min-gap guard
    const second = deterministicComputationWorkerTick(db, { now: realNow });
    expect(second.emitted_kind).toBe("skipped");
    // Exactly one check row
    const rows = findEvents(db, "deterministic_computation_check");
    expect(rows.length).toBe(1);
  });
});
