// acc2 WAL checkpoint driver — reactivity fix (2026-05-24).
//
// PROBLEM. The single bun event loop has a single-writer main-thread
// connection. With `PRAGMA wal_autocheckpoint = 2000` SQLite ran a
// checkpoint synchronously on a COMMIT boundary whenever the WAL crossed
// ~2000 pages. During a dispatch burst the 10-thread read pool holds read
// locks, so the auto-checkpoint cannot reclaim frames — the WAL grows to
// ~17MB and the checkpoint that eventually fires on a COMMIT stalls the
// loop ~5s (the residual reactivity spike).
//
// FIX. substrate/db.ts now sets `wal_autocheckpoint = 0` on the writer
// connection (synchronous checkpoint-on-COMMIT disabled — the stall is
// gone from the emit hot path). This driver OWNS the checkpoint cadence
// OFF the hot path:
//
//   * A low-frequency timer (default 12s, ACC2_WAL_CHECKPOINT_INTERVAL_MS)
//     runs `PRAGMA wal_checkpoint(PASSIVE)`. PASSIVE never blocks on
//     active readers — it reclaims whatever frames are free and returns
//     immediately, so it CANNOT stall the loop. This is the steady-state
//     reclaimer.
//
//   * A WAL-SIZE BACKSTOP (the unbounded-growth guard, mandatory per the
//     67MB-WAL incident note in substrate/db.ts): before each tick we
//     stat `<db_path>-wal`. If it exceeds ACC2_WAL_FORCE_CHECKPOINT_BYTES
//     (default 64MB, matching journal_size_limit), we escalate to
//     `PRAGMA wal_checkpoint(TRUNCATE)` which forces reclamation even
//     under reader contention. TRUNCATE may briefly block, but it only
//     fires in the rare runaway case — never on the steady-state path.
//     This makes unbounded WAL growth impossible while autocheckpoint=0.
//
// The passive-vs-truncate decision is factored into the pure exported
// helper `decideCheckpointMode` so it is unit-testable without a daemon.
//
// Readers are NOT touched: PASSIVE checkpoints are safe with concurrent
// readers, and synchronous=NORMAL durability is unchanged.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { statSync } from "node:fs";
import { emitEvent } from "./events";
import { logger } from "./logger";

export type CheckpointMode = "PASSIVE" | "TRUNCATE";

/** Default steady-state interval. Low enough that the WAL never has time
 *  to grow large between reclaims (≈12s); high enough that the PASSIVE
 *  pragma is negligible overhead. Env-tunable. */
export const DEFAULT_CHECKPOINT_INTERVAL_MS = 12_000;

/** Default WAL-size cap that escalates PASSIVE→TRUNCATE. Matches
 *  journal_size_limit (64MB) so the truncate backstop and the
 *  truncate-on-checkpoint limit reinforce each other. Env-tunable. */
export const DEFAULT_FORCE_CHECKPOINT_BYTES = 64 * 1024 * 1024;

const resolveIntervalMs = (): number => {
  const raw = Number(process.env.ACC2_WAL_CHECKPOINT_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_CHECKPOINT_INTERVAL_MS;
};

const resolveForceBytes = (): number => {
  const raw = Number(process.env.ACC2_WAL_FORCE_CHECKPOINT_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_FORCE_CHECKPOINT_BYTES;
};

/** Pure decision: given the current WAL size in bytes and the force cap,
 *  choose the checkpoint mode. At-or-above the cap we escalate to
 *  TRUNCATE (the unbounded-growth backstop); otherwise PASSIVE (the
 *  non-blocking steady-state reclaimer). Exported for unit tests. */
export const decideCheckpointMode = (walSizeBytes: number, forceBytes: number): CheckpointMode =>
  walSizeBytes >= forceBytes ? "TRUNCATE" : "PASSIVE";

/** Stat `<db_path>-wal`. Missing sidecar (ENOENT) is the normal
 *  "no writes yet / :memory:" branch and reports 0 bytes, not an error. */
const statWalBytes = (dbPath: string): { bytes: number; error: string } => {
  try {
    return { bytes: statSync(`${dbPath}-wal`).size, error: "" };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    if (code === "ENOENT") return { bytes: 0, error: "" };
    return { bytes: 0, error: `${code || "stat_failed"}:${(err as Error).message}` };
  }
};

export type CheckpointTickResult = {
  mode: CheckpointMode;
  wal_size_bytes: number;
  force_bytes: number;
  /** Raw `{busy, log, checkpointed}` tuple from the pragma, or null on throw. */
  checkpoint_result: { busy: number; log: number; checkpointed: number } | null;
  stat_error: string;
  ts: string;
};

/** Run one checkpoint tick: stat the WAL, pick the mode, run the pragma.
 *  Pure on `db` + filesystem (no timers, no daemon state) so a test can
 *  drive it directly. Never throws — pragma failures are captured in the
 *  returned tuple. */
export const runCheckpointTick = (db: Database, dbPath: string): CheckpointTickResult => {
  const forceBytes = resolveForceBytes();
  const stat = statWalBytes(dbPath);
  const mode = decideCheckpointMode(stat.bytes, forceBytes);
  const result: CheckpointTickResult = {
    mode,
    wal_size_bytes: stat.bytes,
    force_bytes: forceBytes,
    checkpoint_result: null,
    stat_error: stat.error,
    ts: new Date().toISOString(),
  };
  try {
    const row = db
      .query<{ busy: number; log: number; checkpointed: number }, []>(
        `PRAGMA wal_checkpoint(${mode})`,
      )
      .get();
    if (row) result.checkpoint_result = row;
  } catch (err) {
    result.stat_error = result.stat_error || `checkpoint_failed:${(err as Error).message}`;
  }
  return result;
};

export type CheckpointDriverOptions = {
  /** Override the steady-state interval (ms). Defaults to the env knob. */
  intervalMs?: number;
  /** Called after the writer pool/handle records lastCheckpointAtMs, so the
   *  daemon can park the timestamp on the same field the pool already tracks. */
  onCheckpoint?: (result: CheckpointTickResult) => void;
};

export type CheckpointDriverHandle = {
  /** Clear the interval. Idempotent. */
  stop: () => void;
};

/** Start the timed checkpoint driver. Returns a handle whose `stop()`
 *  clears the interval (wire into the daemon `workers` teardown list so
 *  no timer leaks across restart). The interval is `.unref()`-ed so it
 *  never keeps the process alive on its own.
 *
 *  Emit policy: PASSIVE ticks are NOT emitted (they fire every ~12s and
 *  would bloat the ledger). Only the rare TRUNCATE escalation — the
 *  backstop path — emits a `wal_checkpointed` event so operators can see
 *  the WAL ran away and was force-reclaimed. */
export const startWalCheckpointDriver = (
  db: Database,
  dbPath: string,
  opts: CheckpointDriverOptions = {},
): CheckpointDriverHandle => {
  const intervalMs = opts.intervalMs ?? resolveIntervalMs();
  let stopped = false;

  const tick = (): void => {
    if (stopped) return;
    let result: CheckpointTickResult;
    try {
      result = runCheckpointTick(db, dbPath);
    } catch (err) {
      // runCheckpointTick is built not to throw, but guard the timer body
      // so a surprise (e.g. db closed mid-tick) can never kill the loop.
      logger.debug(
        { where: "wal_checkpoint_driver.tick", err: (err as Error).message },
        "checkpoint tick threw (db likely closed)",
      );
      return;
    }
    opts.onCheckpoint?.(result);
    // Only the TRUNCATE backstop emits — never the steady-state PASSIVE.
    if (result.mode === "TRUNCATE" && result.checkpoint_result) {
      try {
        emitEvent(db, {
          kind: "wal_checkpointed",
          substrate_origin: "substrate_auto",
          payload: {
            busy: result.checkpoint_result.busy,
            log_pages: result.checkpoint_result.log,
            checkpointed_pages: result.checkpoint_result.checkpointed,
            wal_size_bytes: result.wal_size_bytes,
            force_bytes: result.force_bytes,
            trigger: "wal_checkpoint_driver_force_truncate",
          } as JsonValue,
        });
      } catch (err) {
        logger.debug(
          { where: "wal_checkpoint_driver.emit", err: (err as Error).message },
          "wal_checkpointed emit failed (db likely closed)",
        );
      }
    }
  };

  const timer = setInterval(tick, intervalMs);
  // Do not keep the event loop alive purely for this timer.
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
};
