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
  runIntegrityCheck,
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
