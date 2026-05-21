// acc2 integrity worker tests — PRAGMA integrity_check round-trip,
// corrupt-db detection, orphaned-dispatch reconciliation, WAL hygiene.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import {
  integrityWorkerTick,
  reconcileOrphanedDispatches,
  reconcilePreDispatchOrphans,
  reconcileStaleDispatches,
  runIntegrityCheck,
  STALE_DISPATCH_THRESHOLD_MS,
} from "./integrity_worker";

const eventsByKind = (db: Database, kind: string): Array<Record<string, unknown>> => {
  return db
    .query("SELECT * FROM events WHERE kind = ? ORDER BY ts ASC")
    .all(kind) as Array<Record<string, unknown>>;
};

describe("runIntegrityCheck — healthy db", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "acc2-integrity-"));
    dbPath = join(tmpDir, "state.db");
  });

  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns ok=true with pragma 'ok' on a fresh substrate", async () => {
    const db = openDb(dbPath);
    const report = await runIntegrityCheck(db);
    expect(report.ok).toBe(true);
    expect(report.pragma_integrity_check).toBe("ok");
    expect(report.events_count).toBe(0);
    expect(report.embeddings_count).toBe(0);
    expect(report.duration_ms).toBeGreaterThanOrEqual(0);
  });

  test("events_count reflects existing rows", async () => {
    const db = openDb(dbPath);
    emitEvent(db, { kind: "directive_opened", payload: { directive_text: "x" } });
    emitEvent(db, { kind: "directive_opened", payload: { directive_text: "y" } });
    const report = await runIntegrityCheck(db);
    expect(report.ok).toBe(true);
    expect(report.events_count).toBeGreaterThanOrEqual(2);
  });
});

describe("integrityWorkerTick — emits the correct event", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "acc2-integrity-tick-"));
    dbPath = join(tmpDir, "state.db");
  });

  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("healthy db → emits integrity_check_completed", async () => {
    const db = openDb(dbPath);
    await integrityWorkerTick(db);
    const rows = eventsByKind(db, "integrity_check_completed");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(rows[0].payload as string) as Record<string, unknown>;
    expect(payload.pragma_result).toBe("ok");
    expect(typeof payload.duration_ms).toBe("number");
    expect(typeof payload.wal_size_bytes).toBe("number");
  });

  test("does NOT emit integrity_check_failed when healthy", async () => {
    const db = openDb(dbPath);
    await integrityWorkerTick(db);
    const fails = eventsByKind(db, "integrity_check_failed");
    expect(fails.length).toBe(0);
  });
});

describe("reconcileOrphanedDispatches — emits dispatch_recovered_orphan", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "acc2-orphan-"));
    dbPath = join(tmpDir, "state.db");
  });

  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("an unclosed brain_dispatched row produces one orphan recovery", () => {
    const db = openDb(dbPath);
    // Emit a brain_dispatched without a closing event.
    emitEvent(db, {
      kind: "brain_dispatched",
      directive_id: "d_orphan_1",
      task_id: "t_orphan_1",
      payload: { dispatch_id: "disp_1" },
    });
    const recovered = reconcileOrphanedDispatches(db);
    expect(recovered.length).toBe(1);
    expect(recovered[0].task_id).toBe("t_orphan_1");
    const rows = eventsByKind(db, "dispatch_recovered_orphan");
    expect(rows.length).toBe(1);
  });

  test("a closed brain_dispatched row does NOT produce an orphan", () => {
    const db = openDb(dbPath);
    emitEvent(db, {
      kind: "brain_dispatched",
      directive_id: "d_closed_1",
      task_id: "t_closed_1",
      payload: { dispatch_id: "disp_closed" },
    });
    emitEvent(db, {
      kind: "brain_dispatch_closed",
      directive_id: "d_closed_1",
      task_id: "t_closed_1",
      payload: { dispatch_id: "disp_closed" },
    });
    const recovered = reconcileOrphanedDispatches(db);
    expect(recovered.length).toBe(0);
  });

  test("a task_failed row also closes the dispatch", () => {
    const db = openDb(dbPath);
    emitEvent(db, {
      kind: "brain_dispatched",
      directive_id: "d_failed_1",
      task_id: "t_failed_1",
      payload: { dispatch_id: "disp_failed" },
    });
    emitEvent(db, {
      kind: "task_failed",
      directive_id: "d_failed_1",
      task_id: "t_failed_1",
      payload: { dispatch_id: "disp_failed" },
    });
    const recovered = reconcileOrphanedDispatches(db);
    expect(recovered.length).toBe(0);
  });

  test("multiple orphans across different tasks", () => {
    const db = openDb(dbPath);
    for (let i = 0; i < 3; i++) {
      emitEvent(db, {
        kind: "brain_dispatched",
        directive_id: `d_orphan_${i}`,
        task_id: `t_orphan_${i}`,
        payload: { dispatch_id: `disp_${i}` },
      });
    }
    const recovered = reconcileOrphanedDispatches(db);
    expect(recovered.length).toBe(3);
  });

  test("recovery emits brain_dispatch_closed with dispatch_id + restart_orphan_recovered (YEF00QZM lease closure)", () => {
    const db = openDb(dbPath);
    emitEvent(db, {
      kind: "brain_dispatched",
      directive_id: "d_lease",
      task_id: "t_lease",
      payload: { dispatch_id: "disp_lease_xyz" },
    });
    const recovered = reconcileOrphanedDispatches(db);
    expect(recovered.length).toBe(1);
    const closes = eventsByKind(db, "brain_dispatch_closed");
    expect(closes.length).toBe(1);
    const closePayload = JSON.parse(closes[0]!.payload) as Record<string, unknown>;
    expect(closePayload.reason).toBe("restart_orphan_recovered");
    expect(closePayload.dispatch_id).toBe("disp_lease_xyz");
    expect(typeof closePayload.original_dispatch_event_id).toBe("string");
    // The dispatch_recovered_orphan now also carries recovery_close_event_id
    // for traceability.
    const orphans = eventsByKind(db, "dispatch_recovered_orphan");
    const orphanPayload = JSON.parse(orphans[0]!.payload) as Record<string, unknown>;
    expect(orphanPayload.recovery_close_event_id).toBe(closes[0]!.id);
  });

  test("recovery is idempotent — a SECOND reconcile does NOT emit a duplicate close (lease already closed)", () => {
    const db = openDb(dbPath);
    emitEvent(db, {
      kind: "brain_dispatched",
      directive_id: "d_idem_close",
      task_id: "t_idem_close",
      payload: { dispatch_id: "disp_idem" },
    });
    expect(reconcileOrphanedDispatches(db).length).toBe(1);
    // After the first reconcile the lease has a brain_dispatch_closed event.
    // The second reconcile's query now finds zero unclosed rows because
    // the close itself satisfies the "no closing event" predicate.
    expect(reconcileOrphanedDispatches(db).length).toBe(0);
    expect(eventsByKind(db, "brain_dispatch_closed").length).toBe(1);
    expect(eventsByKind(db, "dispatch_recovered_orphan").length).toBe(1);
  });

  test("HOT_RELOAD_BRIDGE_ZERO_LOSS_TEST: restart recovery accounts for every parallel in-flight dispatch", () => {
    const db = openDb(dbPath);
    const directiveId = "YEF00QZM2S4T973MTJ3Q8EJ534";
    const taskIds = Array.from({ length: 15 }, (_, i) => `restart_parallel_task_${i}`);

    for (const taskId of taskIds) {
      emitEvent(db, {
        kind: "task_node_opened",
        directive_id: directiveId,
        task_id: taskId,
        payload: { goal: "parallel brain dispatch interrupted by daemon restart" },
      });
      emitEvent(db, {
        kind: "brain_dispatched",
        directive_id: directiveId,
        task_id: taskId,
        payload: { dispatch_id: `disp_${taskId}` },
      });
    }

    const recovered = reconcileOrphanedDispatches(db);
    expect(recovered.map((r) => r.task_id).sort()).toEqual([...taskIds].sort());

    const unaccounted = db
      .query(`
        SELECT d.task_id
        FROM events d
        WHERE d.kind = 'brain_dispatched'
          AND d.directive_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM events c
            WHERE c.task_id = d.task_id
              AND c.kind IN ('brain_dispatch_closed', 'dispatcher_violation', 'task_failed', 'task_committed')
              AND c.ts >= d.ts
          )
        ORDER BY d.task_id ASC
      `)
      .all(directiveId) as Array<{ task_id: string }>;
    expect(unaccounted).toEqual([]);

    const restartInterruptedFailures = db
      .query(`
        SELECT task_id
        FROM events
        WHERE directive_id = ?
          AND kind = 'task_failed'
          AND (failure_kind = 'restart_interrupted' OR json_extract(payload, '$.reason') = 'restart_interrupted')
      `)
      .all(directiveId) as Array<{ task_id: string }>;
    expect(restartInterruptedFailures).toEqual([]);
    const dispatcherViolations = db
      .query(`
        SELECT task_id
        FROM events
        WHERE directive_id = ?
          AND kind = 'dispatcher_violation'
      `)
      .all(directiveId) as Array<{ task_id: string }>;
    expect(dispatcherViolations).toEqual([]);

    const closesByTask = new Map(
      eventsByKind(db, "brain_dispatch_closed").map((row) => [row.task_id, JSON.parse(row.payload as string) as Record<string, unknown>]),
    );
    for (const taskId of taskIds) {
      expect(closesByTask.get(taskId)?.reason).toBe("restart_orphan_recovered");
      expect(closesByTask.get(taskId)?.dispatch_id).toBe(`disp_${taskId}`);
    }

    expect(reconcileOrphanedDispatches(db)).toEqual([]);
  });
});

describe("reconcileStaleDispatches — mid-session zombie sweep", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "acc2-stale-"));
    dbPath = join(tmpDir, "state.db");
  });

  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("a freshly-started dispatch (under age threshold) is NOT flagged stale", () => {
    const db = openDb(dbPath);
    emitEvent(db, {
      kind: "brain_dispatched",
      directive_id: "d_fresh",
      task_id: "t_fresh",
      payload: { dispatch_id: "disp_fresh" },
    });
    // Default age threshold is 15 min — a row emitted milliseconds ago is
    // safely below it. Healthy in-flight dispatches must not be flagged.
    const recovered = reconcileStaleDispatches(db);
    expect(recovered.length).toBe(0);
  });

  test("a stale dispatch (older than threshold) IS flagged and emits dispatch_recovered_orphan", () => {
    const db = openDb(dbPath);
    // Spoof the dispatch timestamp by writing it directly with an old ts.
    // The emitEvent helper stamps `nowIso()`; we override via raw insert.
    const oldTs = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    db.query(
      `INSERT INTO events (id, ts, kind, substrate_origin, directive_id, task_id, loop_id, payload)
       VALUES (?, ?, 'brain_dispatched', 'substrate_auto', ?, ?, '', ?)`,
    ).run("e_stale_disp", oldTs, "d_stale", "t_stale", JSON.stringify({ dispatch_id: "disp_stale" }));

    const recovered = reconcileStaleDispatches(db);
    expect(recovered.length).toBe(1);
    expect(recovered[0].task_id).toBe("t_stale");
    expect(recovered[0].age_ms).toBeGreaterThanOrEqual(STALE_DISPATCH_THRESHOLD_MS);
    const orphans = eventsByKind(db, "dispatch_recovered_orphan");
    expect(orphans.length).toBe(1);
    // YEF00QZM lease closure: the stale-reconcile path ALSO emits
    // brain_dispatch_closed with reason='stale_orphan_recovered'.
    const closes = eventsByKind(db, "brain_dispatch_closed");
    expect(closes.length).toBe(1);
    const closePayload = JSON.parse(closes[0]!.payload) as Record<string, unknown>;
    expect(closePayload.reason).toBe("stale_orphan_recovered");
    expect(closePayload.dispatch_id).toBe("disp_stale");
    const orphanPayload = JSON.parse(orphans[0]!.payload) as Record<string, unknown>;
    expect(orphanPayload.recovery_close_event_id).toBe(closes[0]!.id);
  });

  test("a stale dispatch already recovered is NOT flagged again — idempotent", () => {
    const db = openDb(dbPath);
    const oldTs = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    db.query(
      `INSERT INTO events (id, ts, kind, substrate_origin, directive_id, task_id, loop_id, payload)
       VALUES (?, ?, 'brain_dispatched', 'substrate_auto', ?, ?, '', ?)`,
    ).run("e_stale_2", oldTs, "d_idem", "t_idem", JSON.stringify({ dispatch_id: "disp_idem" }));

    expect(reconcileStaleDispatches(db).length).toBe(1);
    // Second sweep should be a no-op — the orphan event already exists.
    expect(reconcileStaleDispatches(db).length).toBe(0);
    expect(eventsByKind(db, "dispatch_recovered_orphan").length).toBe(1);
  });

  test("a stale dispatch with a closing event (committed/failed/closed/violation) is NOT flagged", () => {
    const db = openDb(dbPath);
    const oldTs = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    db.query(
      `INSERT INTO events (id, ts, kind, substrate_origin, directive_id, task_id, loop_id, payload)
       VALUES (?, ?, 'brain_dispatched', 'substrate_auto', ?, ?, '', ?)`,
    ).run("e_closed_old", oldTs, "d_closed_old", "t_closed_old", JSON.stringify({ dispatch_id: "disp_old" }));
    // Closing event lands slightly later but still in the past.
    const closedTs = new Date(Date.now() - 25 * 60 * 1000).toISOString();
    db.query(
      `INSERT INTO events (id, ts, kind, substrate_origin, directive_id, task_id, loop_id, payload)
       VALUES (?, ?, 'brain_dispatch_closed', 'substrate_auto', ?, ?, '', ?)`,
    ).run("e_closed_old_close", closedTs, "d_closed_old", "t_closed_old", JSON.stringify({ dispatch_id: "disp_old" }));

    const recovered = reconcileStaleDispatches(db);
    expect(recovered.length).toBe(0);
  });
});


describe("runIntegrityCheck — corrupt db", () => {
  // We construct a corrupted db file by writing garbage bytes to it and
  // then opening with bun:sqlite. The PRAGMA integrity_check should fail.
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "acc2-corrupt-"));
    dbPath = join(tmpDir, "corrupt.db");
  });

  afterEach(() => {
    try { closeDb(dbPath); } catch { /* swallow */ }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("corrupted db file → ok=false, error text exposed", async () => {
    // First create a valid db, then truncate + corrupt page header.
    const db1 = openDb(dbPath);
    emitEvent(db1, { kind: "directive_opened", payload: { directive_text: "x" } });
    closeDb(dbPath);

    // Corrupt the middle of the file by writing zeroes over page 1's
    // payload area (offset 100-200). SQLite reserves header for first
    // 100 bytes; corrupting page contents triggers integrity_check.
    const bytes = readFileSync(dbPath);
    for (let i = 100; i < Math.min(500, bytes.length); i++) bytes[i] = 0xFF;
    writeFileSync(dbPath, bytes);

    // Reopen with bun:sqlite directly. We use a manual Database open
    // here (not openDb) because openDb's runSchema would refuse on a
    // corrupted file and we want to test runIntegrityCheck specifically.
    const rawDb = new Database(dbPath, { create: false, strict: true });
    try { rawDb.loadExtension(sqliteVec.getLoadablePath()); } catch { /* swallow */ }
    try {
      const report = await runIntegrityCheck(rawDb);
      // EITHER the integrity check rows show errors OR the queries
      // themselves throw — either way the report flags non-ok.
      expect(report.ok).toBe(false);
      expect(report.pragma_integrity_check).not.toBe("ok");
    } finally {
      try { rawDb.close(); } catch { /* swallow */ }
    }
  });
});

describe("reconcilePreDispatchOrphans", () => {
  test("reaps only stale directives orphaned before dispatch (not fresh, not dispatched)", () => {
    const db = openDb(":memory:");
    try {
      const now = Date.now();
      const oldTs = new Date(now - 30 * 60 * 1000).toISOString();
      const freshTs = new Date(now - 2 * 60 * 1000).toISOString();
      // Stale pre-dispatch orphan → should be reaped.
      emitEvent(db, { kind: "directive_opened", substrate_origin: "substrate_auto", task_id: "STALE_ORPHAN", directive_id: "d1", payload: {} });
      db.run("UPDATE events SET ts=? WHERE task_id='STALE_ORPHAN'", [oldTs]);
      // Fresh directive still waiting for the scheduler → must NOT be reaped.
      emitEvent(db, { kind: "directive_opened", substrate_origin: "substrate_auto", task_id: "FRESH", directive_id: "d2", payload: {} });
      db.run("UPDATE events SET ts=? WHERE task_id='FRESH'", [freshTs]);
      // Stale but already dispatched → must NOT be reaped (the brain-dispatch
      // reconciler owns that case).
      emitEvent(db, { kind: "directive_opened", substrate_origin: "substrate_auto", task_id: "DISPATCHED", directive_id: "d3", payload: {} });
      emitEvent(db, { kind: "brain_dispatched", substrate_origin: "substrate_auto", task_id: "DISPATCHED", directive_id: "d3", payload: {} });
      db.run("UPDATE events SET ts=? WHERE task_id='DISPATCHED'", [oldTs]);

      const reaped = reconcilePreDispatchOrphans(db, { now: new Date(now).toISOString() });
      expect(reaped.length).toBe(1);
      expect(reaped[0].task_id).toBe("STALE_ORPHAN");
      // A task_abandoned event was emitted for the orphan.
      const abandoned = eventsByKind(db, "task_abandoned");
      expect(abandoned.length).toBe(1);
      expect(abandoned[0].task_id).toBe("STALE_ORPHAN");
    } finally {
      closeDb(":memory:");
    }
  });
});
