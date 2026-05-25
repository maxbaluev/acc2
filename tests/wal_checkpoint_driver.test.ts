// acc2 reactivity fix (2026-05-24) — timed WAL checkpoint driver tests.
//
// The writer connection now sets `wal_autocheckpoint = 0` (synchronous
// checkpoint-on-COMMIT disabled — the ~5s loop-stall is gone from the emit
// hot path). The checkpoint cadence is OWNED by
// runtime/wal_checkpoint_driver.ts:
//
//   1. autocheckpoint=0 is set on the writer (pragma assertion).
//   2. decideCheckpointMode is the pure passive-vs-truncate decision.
//   3. The timed driver runs PASSIVE on schedule (steady state).
//   4. The size guard escalates to TRUNCATE when the WAL exceeds the cap
//      (simulated with a tiny cap + a burst of rows).
//   5. stop() clears the timer (no leak).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "../runtime/events";
import {
  DEFAULT_CHECKPOINT_INTERVAL_MS,
  DEFAULT_FORCE_CHECKPOINT_BYTES,
  decideCheckpointMode,
  runCheckpointTick,
  startWalCheckpointDriver,
} from "../runtime/wal_checkpoint_driver";

const tmpDbPath = (): string =>
  join(mkdtempSync(join(tmpdir(), "acc2-walckpt-")), "state.db");

afterEach(() => closeDb());

describe("decideCheckpointMode (pure)", () => {
  test("below cap → PASSIVE (non-blocking steady-state reclaimer)", () => {
    expect(decideCheckpointMode(0, DEFAULT_FORCE_CHECKPOINT_BYTES)).toBe("PASSIVE");
    expect(decideCheckpointMode(DEFAULT_FORCE_CHECKPOINT_BYTES - 1, DEFAULT_FORCE_CHECKPOINT_BYTES)).toBe("PASSIVE");
  });
  test("at-or-above cap → TRUNCATE (unbounded-growth backstop)", () => {
    expect(decideCheckpointMode(DEFAULT_FORCE_CHECKPOINT_BYTES, DEFAULT_FORCE_CHECKPOINT_BYTES)).toBe("TRUNCATE");
    expect(decideCheckpointMode(DEFAULT_FORCE_CHECKPOINT_BYTES * 4, DEFAULT_FORCE_CHECKPOINT_BYTES)).toBe("TRUNCATE");
  });
  test("default interval is low-frequency, off the hot path", () => {
    expect(DEFAULT_CHECKPOINT_INTERVAL_MS).toBeGreaterThanOrEqual(10_000);
  });
});

describe("writer pragma: wal_autocheckpoint disabled", () => {
  test("openDb writer has wal_autocheckpoint = 0", () => {
    const dbPath = tmpDbPath();
    const db = openDb(dbPath);
    const row = db.query<{ wal_autocheckpoint: number }, []>("PRAGMA wal_autocheckpoint").get();
    expect(row?.wal_autocheckpoint).toBe(0);
  });
});

describe("runCheckpointTick", () => {
  test("PASSIVE under cap; never throws; returns a result tuple", () => {
    const dbPath = tmpDbPath();
    const db = openDb(dbPath);
    // A handful of writes to produce a (tiny) WAL well under the default cap.
    for (let i = 0; i < 50; i++) {
      emitEvent(db, { kind: "knowledge_candidate", substrate_origin: "substrate_auto", payload: { i } });
    }
    const result = runCheckpointTick(db, dbPath);
    expect(result.mode).toBe("PASSIVE");
    expect(result.stat_error).toBe("");
    expect(result.checkpoint_result).not.toBeNull();
  });

  test("size guard escalates to TRUNCATE when WAL exceeds a tiny cap", () => {
    const dbPath = tmpDbPath();
    const db = openDb(dbPath);
    // Force the cap absurdly small so any non-empty WAL trips the backstop.
    const prev = process.env.ACC2_WAL_FORCE_CHECKPOINT_BYTES;
    process.env.ACC2_WAL_FORCE_CHECKPOINT_BYTES = "1024";
    try {
      // Burst rows so the WAL sidecar exceeds 1KB before any checkpoint.
      for (let i = 0; i < 500; i++) {
        emitEvent(db, {
          kind: "knowledge_candidate",
          substrate_origin: "substrate_auto",
          payload: { i, blob: "x".repeat(256) },
        });
      }
      const walBytes = statSync(`${dbPath}-wal`).size;
      expect(walBytes).toBeGreaterThan(1024);
      const result = runCheckpointTick(db, dbPath);
      expect(result.mode).toBe("TRUNCATE");
      expect(result.checkpoint_result).not.toBeNull();
      // TRUNCATE reclaims the WAL to (near) zero — the runaway is impossible.
      const afterBytes = statSync(`${dbPath}-wal`).size;
      expect(afterBytes).toBeLessThan(walBytes);
    } finally {
      if (prev === undefined) delete process.env.ACC2_WAL_FORCE_CHECKPOINT_BYTES;
      else process.env.ACC2_WAL_FORCE_CHECKPOINT_BYTES = prev;
    }
  });
});

describe("startWalCheckpointDriver lifecycle", () => {
  test("runs a PASSIVE tick on schedule and stop() clears the timer", async () => {
    const dbPath = tmpDbPath();
    const db = openDb(dbPath);
    for (let i = 0; i < 20; i++) {
      emitEvent(db, { kind: "knowledge_candidate", substrate_origin: "substrate_auto", payload: { i } });
    }
    let ticks = 0;
    const driver = startWalCheckpointDriver(db, dbPath, {
      intervalMs: 20,
      onCheckpoint: (r) => {
        ticks += 1;
        expect(r.mode).toBe("PASSIVE");
      },
    });
    // Wait long enough for at least one scheduled tick.
    await new Promise((r) => setTimeout(r, 80));
    driver.stop();
    expect(ticks).toBeGreaterThanOrEqual(1);
    const ticksAtStop = ticks;
    // After stop(), no further ticks fire.
    await new Promise((r) => setTimeout(r, 80));
    expect(ticks).toBe(ticksAtStop);
    // stop() is idempotent.
    driver.stop();
  });
});
