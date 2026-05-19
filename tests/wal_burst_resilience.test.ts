// acc2 F-resilience — WAL burst-write resilience tests (2026-05-18).
//
// Contract C33Q10NV557DDEMMHH4TD42MVR. Closes the diagnostic gap
// observed this session: the lifecycle closure sweep emitted 2917
// terminators in 12.3 seconds inside one implicit transaction, the
// WAL grew from 67MB to 206MB, and the /health endpoint hung for
// 30+ seconds because the writer lock was held continuously and
// SQLite's wal_autocheckpoint=1000 only fires at COMMIT boundaries.
//
// The five falsifying cases mirror the contract scope:
//
//   A — Batched lifecycle sweep commits N transactions (N = ceil(500 /
//       batchSize)) rather than 1, so the writer lock is released
//       between batches and autocheckpoint can advance the WAL pointer.
//   B — runWalPressureCheck triggers wal_checkpoint(PASSIVE) when the
//       simulated WAL size exceeds the threshold.
//   C — Below the threshold, no checkpoint runs (purely opportunistic).
//   D — ACC2_WAL_PRESSURE_THRESHOLD_MB env var overrides the default.
//   E — /health payload exposes the wal_stats keys operators read.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, statSync, openSync, ftruncateSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "../runtime/events";
import { runLifecycleClosureSweep } from "../runtime/lifecycle_closure_sweep";
import {
  runWalPressureCheck,
  getLastWalPressureSummary,
  setLastWalPressureSummary,
} from "../runtime/wal_pressure_worker";
import { startDaemon, stopDaemon, type DaemonHandle } from "../runtime/daemon";

const NOW = new Date("2026-05-18T12:00:00.000Z");
const DAYS_AGO = (n: number): Date => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

describe("F-resilience case A — lifecycle sweep batches burst writes", () => {
  afterAll(() => closeDb());
  beforeEach(() => closeDb());
  test("synthetic burst of 500 terminators commits in ceil(500 / batchSize) batches", () => {
    const db = openDb(":memory:");
    // Seed 500 owner_input_required rows older than 7 days. Each one
    // becomes a closure_owner_required terminator in the sweep.
    for (let i = 0; i < 500; i++) {
      const row = emitEvent(db, {
        kind: "owner_input_required",
        substrate_origin: "opencode",
        directive_id: `dir_burst_${i}`,
        task_id: `task_burst_${i}`,
        payload: { reason: "auth_expired" },
      });
      db.run("UPDATE events SET ts = ? WHERE id = ?", [DAYS_AGO(8).toISOString(), row.id]);
    }

    const summary = runLifecycleClosureSweep(db, {
      now: NOW,
      batchSize: 100,
    });

    // 500 terminators, batch size 100 → 5 transactions.
    expect(summary.closure_owner_required_count).toBe(500);
    expect(summary.batches_committed).toBe(5);

    // Sanity: every row also landed in the events table.
    const persisted = db
      .query<{ c: number }, []>(
        "SELECT COUNT(*) AS c FROM events WHERE kind = 'closure_owner_required'",
      )
      .get();
    expect(persisted?.c).toBe(500);
  });

  test("a smaller batchSize splits the same workload into more transactions", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 250; i++) {
      const row = emitEvent(db, {
        kind: "owner_input_required",
        substrate_origin: "opencode",
        directive_id: `dir_split_${i}`,
        task_id: `task_split_${i}`,
        payload: { reason: "auth_expired" },
      });
      db.run("UPDATE events SET ts = ? WHERE id = ?", [DAYS_AGO(8).toISOString(), row.id]);
    }

    const summary = runLifecycleClosureSweep(db, {
      now: NOW,
      batchSize: 50,
    });

    expect(summary.closure_owner_required_count).toBe(250);
    // 250 / 50 = 5 full batches.
    expect(summary.batches_committed).toBe(5);
  });

  test("partial batch at the tail flushes in its own transaction", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 7; i++) {
      const row = emitEvent(db, {
        kind: "owner_input_required",
        substrate_origin: "opencode",
        directive_id: `dir_tail_${i}`,
        task_id: `task_tail_${i}`,
        payload: { reason: "auth_expired" },
      });
      db.run("UPDATE events SET ts = ? WHERE id = ?", [DAYS_AGO(8).toISOString(), row.id]);
    }

    const summary = runLifecycleClosureSweep(db, {
      now: NOW,
      batchSize: 3,
    });

    expect(summary.closure_owner_required_count).toBe(7);
    // 7 / 3 = 2 full batches + 1 residual tail flush = 3.
    expect(summary.batches_committed).toBe(3);
  });

  test("dryRun mode commits zero batches (no INSERTs reach the ledger)", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 50; i++) {
      const row = emitEvent(db, {
        kind: "owner_input_required",
        substrate_origin: "opencode",
        directive_id: `dir_dry_${i}`,
        task_id: `task_dry_${i}`,
        payload: { reason: "auth_expired" },
      });
      db.run("UPDATE events SET ts = ? WHERE id = ?", [DAYS_AGO(8).toISOString(), row.id]);
    }
    const summary = runLifecycleClosureSweep(db, { now: NOW, dryRun: true });
    expect(summary.closure_owner_required_count).toBeGreaterThanOrEqual(50);
    expect(summary.batches_committed).toBe(0);
  });
});

// Cases B / C / D — runWalPressureCheck behaviour. The worker stats the
// `<db_path>-wal` sidecar, so we materialise a real DB file on disk and
// inflate its WAL by ftruncate to simulate the burst pathology without
// having to actually burn through millions of pages.
describe("F-resilience cases B/C/D — WAL pressure observation worker", () => {
  let tmpDir = "";
  let dbPath = "";

  beforeEach(() => {
    closeDb();
    tmpDir = mkdtempSync(join(tmpdir(), "acc2-wal-pressure-"));
    dbPath = join(tmpDir, "state.db");
  });

  afterEach(() => {
    closeDb(dbPath);
    if (tmpDir) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  const inflateWal = (sizeBytes: number): void => {
    const walPath = `${dbPath}-wal`;
    // Force the WAL to materialise by performing one write.
    const db = openDb(dbPath);
    emitEvent(db, {
      kind: "owner_input_required",
      substrate_origin: "opencode",
      payload: { reason: "force_wal_materialise" },
    });
    // Now grow the WAL sidecar to the simulated size via ftruncate. The
    // pressure worker only stats the file — it does not parse WAL frames
    // — so size on disk is the signal it consumes.
    const fd = openSync(walPath, "r+");
    try { ftruncateSync(fd, sizeBytes); } finally { closeSync(fd); }
  };

  test("case B — simulated WAL above the threshold triggers wal_checkpoint(PASSIVE)", () => {
    inflateWal(150 * 1024 * 1024); // 150MB > default 100MB
    const db = openDb(dbPath);
    const summary = runWalPressureCheck(db, { dbPath, thresholdMb: 100 });
    expect(summary.checkpoint_ran).toBe(true);
    // PASSIVE always returns a row even when no frames advance; the
    // shape is { busy, log, checkpointed } and at least `log` is a
    // non-negative integer reflecting the WAL frame count.
    expect(summary.checkpoint_result).not.toBeNull();
    expect(typeof summary.checkpoint_result!.busy).toBe("number");
    expect(typeof summary.checkpoint_result!.log).toBe("number");
    expect(typeof summary.checkpoint_result!.checkpointed).toBe("number");
    expect(summary.threshold_bytes).toBe(100 * 1024 * 1024);
  });

  test("case C — WAL below the threshold leaves the checkpoint pragma alone", () => {
    inflateWal(5 * 1024 * 1024); // 5MB << 100MB
    const db = openDb(dbPath);
    const summary = runWalPressureCheck(db, { dbPath, thresholdMb: 100 });
    expect(summary.checkpoint_ran).toBe(false);
    expect(summary.checkpoint_result).toBeNull();
    // Stat'd size is reported even when no checkpoint runs — operators
    // need the trend.
    expect(summary.wal_size_bytes).toBeGreaterThanOrEqual(5 * 1024 * 1024);
  });

  test("case D — caller-supplied thresholdMb overrides the universal 100 MB default", () => {
    // ACC2_WAL_PRESSURE_THRESHOLD_MB env override removed in the
    // universality cleanup. Per-call thresholdMb stays as the canonical
    // override surface for tests (and future per-call adaptive callers).
    inflateWal(60 * 1024 * 1024); // 60 MB > 50 MB threshold, < 100 MB default
    const db = openDb(dbPath);
    const summary = runWalPressureCheck(db, { dbPath, thresholdMb: 50 });
    expect(summary.threshold_bytes).toBe(50 * 1024 * 1024);
    expect(summary.checkpoint_ran).toBe(true);
  });

  test("missing WAL sidecar reports size 0 without erroring", () => {
    // Use a path that exists as a directory but has no `<path>-wal`
    // sibling — the worker must not throw on ENOENT, just report 0.
    const ghostDbPath = join(tmpDir, "never_opened.db");
    const db = openDb(":memory:");
    const summary = runWalPressureCheck(db, { dbPath: ghostDbPath, thresholdMb: 100 });
    expect(summary.wal_size_bytes).toBe(0);
    expect(summary.checkpoint_ran).toBe(false);
    expect(summary.stat_error).toBe("");
  });
});

// Case E — /health payload exposes wal_stats. Booting a real daemon for
// one structural assertion is heavy but the canonical pattern in this
// codebase; the wal_stats keys are part of the operator-facing contract
// (we would have caught the burst hang earlier had they been visible).
describe("F-resilience case E — /health payload exposes wal_stats", () => {
  let tmpDir = "";
  let handle: DaemonHandle | null = null;
  let auxPort = 0;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "acc2-wal-health-"));
    const port = 28500 + Math.floor(Math.random() * 500);
    auxPort = port + 1;
    handle = await startDaemon({
      port,
      auxPort,
      stateDbPath: join(tmpDir, "state.db"),
      socketFile: join(tmpDir, "v2.sock"),
      tokenFile: join(tmpDir, "v2.sock.token"),
    });
  });

  afterAll(async () => {
    if (handle) await stopDaemon(handle);
    handle = null;
    closeDb();
    if (tmpDir) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  test("/health response contains wal_stats with the documented shape", async () => {
    const res = await fetch(`http://127.0.0.1:${auxPort}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("wal_stats");
    const walStats = body.wal_stats as Record<string, unknown>;
    expect(walStats).toHaveProperty("size_bytes");
    expect(walStats).toHaveProperty("threshold_bytes");
    expect(walStats).toHaveProperty("last_checkpoint_ts");
    expect(walStats).toHaveProperty("last_checkpoint_result");
    // size_bytes + threshold_bytes are non-negative integers.
    expect(typeof walStats.size_bytes).toBe("number");
    expect(typeof walStats.threshold_bytes).toBe("number");
    expect(walStats.size_bytes as number).toBeGreaterThanOrEqual(0);
    expect(walStats.threshold_bytes as number).toBeGreaterThanOrEqual(0);
  });

  test("getLastWalPressureSummary slot persists across calls (operator diagnostic)", () => {
    const seeded = {
      wal_size_bytes: 42 * 1024 * 1024,
      threshold_bytes: 100 * 1024 * 1024,
      checkpoint_ran: false,
      checkpoint_result: null,
      ts: NOW.toISOString(),
      stat_error: "",
    };
    setLastWalPressureSummary(seeded);
    const got = getLastWalPressureSummary();
    expect(got).not.toBeNull();
    expect(got!.wal_size_bytes).toBe(42 * 1024 * 1024);
    expect(got!.threshold_bytes).toBe(100 * 1024 * 1024);
    // Restore null for downstream tests.
    setLastWalPressureSummary(null);
  });
});
