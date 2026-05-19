// acc2 WAL pressure observation worker — F-resilience contract
// (C33Q10NV557DDEMMHH4TD42MVR, design KC 5J3F8PCJD12VKA95SZAATFMJR0).
//
// Background. F9 (commit 30d4ec5) set `wal_autocheckpoint = 1000` pages
// so SQLite auto-checkpoints every ~4MB of page churn. The autocheckpoint
// path only fires at COMMIT boundaries, however, and a single big
// transaction (e.g. the pre-batching lifecycle closure sweep that emitted
// 2917 terminators in one logical pass) fills many pages without yielding
// a commit boundary. Observed pathology this session: the daemon's WAL
// grew from ~67MB to 206MB during a burst sweep and the /health endpoint
// became unresponsive for 30+ seconds while the writer thread held the
// pager lock. Manual recovery was kill + wal_checkpoint(TRUNCATE) + restart.
//
// This worker is the opportunistic backstop. Every tick it stats the
// `<db_path>-wal` sidecar and, if size > threshold (default 100MB,
// override via ACC2_WAL_PRESSURE_THRESHOLD_MB), runs
// `PRAGMA wal_checkpoint(PASSIVE)`. PASSIVE never blocks writers — it
// attempts to advance the checkpoint pointer to whatever frames are
// currently not held by active readers, and reports back how many frames
// were checkpointed. This is purely observational + advisory: if the
// checkpoint can't make progress (long-running reader holds frames) the
// worker simply records the result and tries again next tick.
//
// The summary returned by runWalPressureCheck is the canonical shape
// surfaced through /health's wal_stats key so operators can see WAL
// pressure building BEFORE the daemon stalls — addresses the diagnostic
// blindness this session's manual recovery exposed.

import type { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { resolveDbPath } from "./state_paths";

/** Result of one wal_pressure_check tick. The shape doubles as the
 *  payload exposed on /health.wal_stats so operators can diff sizes
 *  between successive probes. */
export type WalPressureSummary = {
  /** Size in bytes of `<db_path>-wal` at stat time. 0 when the WAL
   *  sidecar does not exist (in-memory DB, or no writes since boot). */
  wal_size_bytes: number;
  /** Configured threshold in bytes. */
  threshold_bytes: number;
  /** True when the size crossed the threshold and a checkpoint was
   *  attempted on this tick. */
  checkpoint_ran: boolean;
  /** Raw row returned by `PRAGMA wal_checkpoint(PASSIVE)`. SQLite
   *  returns `{busy, log, checkpointed}` — busy=0 means the checkpoint
   *  acquired the lock; log is the total WAL frames before checkpoint;
   *  checkpointed is the count of frames successfully advanced. Null
   *  when checkpoint_ran=false or when the pragma threw. */
  checkpoint_result: { busy: number; log: number; checkpointed: number } | null;
  /** ISO timestamp of this tick, set by runWalPressureCheck. */
  ts: string;
  /** Stat-failure marker. When the WAL sidecar cannot be stat'd (file
   *  missing is expected; permission denied or other unexpected
   *  ENOENT-adjacent errors are surfaced). Empty string when stat
   *  succeeded or the missing-file branch was taken. */
  stat_error: string;
};

export type WalPressureOptions = {
  /** Explicit DB path. Defaults to resolveDbPath() so the worker
   *  follows ACC2_DB_PATH / ACC2_STATE_DIR. */
  dbPath?: string;
  /** Threshold in MB. Defaults to ACC2_WAL_PRESSURE_THRESHOLD_MB env
   *  var or 100. */
  thresholdMb?: number;
};

const DEFAULT_THRESHOLD_MB = 100;

const resolveThresholdBytes = (opts: WalPressureOptions): number => {
  if (typeof opts.thresholdMb === "number" && opts.thresholdMb > 0) {
    return Math.floor(opts.thresholdMb * 1024 * 1024);
  }
  const env = Number(process.env.ACC2_WAL_PRESSURE_THRESHOLD_MB);
  const mb = Number.isFinite(env) && env > 0 ? env : DEFAULT_THRESHOLD_MB;
  return Math.floor(mb * 1024 * 1024);
};

const statWalSize = (dbPath: string): { size: number; error: string } => {
  const walPath = `${dbPath}-wal`;
  try {
    const st = statSync(walPath);
    return { size: st.size, error: "" };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    // ENOENT is the normal "no writes yet / in-memory DB" branch — not
    // an error, just zero pressure.
    if (code === "ENOENT") return { size: 0, error: "" };
    return { size: 0, error: `${code || "stat_failed"}:${(err as Error).message}` };
  }
};

/** Run one tick of the WAL pressure check. Pure on `db` + filesystem; the
 *  daemon caller registers the periodic invocation. */
export const runWalPressureCheck = (
  db: Database,
  options: WalPressureOptions = {},
): WalPressureSummary => {
  const dbPath = options.dbPath ?? resolveDbPath();
  const thresholdBytes = resolveThresholdBytes(options);
  const stat = statWalSize(dbPath);
  const summary: WalPressureSummary = {
    wal_size_bytes: stat.size,
    threshold_bytes: thresholdBytes,
    checkpoint_ran: false,
    checkpoint_result: null,
    ts: new Date().toISOString(),
    stat_error: stat.error,
  };

  if (stat.size < thresholdBytes) return summary;

  summary.checkpoint_ran = true;
  try {
    // PASSIVE is the non-blocking variant: it advances the checkpoint
    // pointer over whatever frames are not held by active readers, and
    // returns without waiting if a reader is in the way. TRUNCATE /
    // FULL would risk stalling /health and the MCP server during the
    // exact burst we are trying to drain.
    const row = db
      .query<{ busy: number; log: number; checkpointed: number }, []>(
        "PRAGMA wal_checkpoint(PASSIVE)",
      )
      .get();
    if (row) summary.checkpoint_result = row;
  } catch (err) {
    summary.checkpoint_result = null;
    summary.stat_error = summary.stat_error || `checkpoint_failed:${(err as Error).message}`;
  }
  return summary;
};

/** Last successful summary, exposed through /health so the operator can
 *  watch pressure build between probes. The daemon worker writes this
 *  slot every tick; readers may see {} until the first tick lands. */
let lastSummary: WalPressureSummary | null = null;

export const getLastWalPressureSummary = (): WalPressureSummary | null => lastSummary;

export const setLastWalPressureSummary = (s: WalPressureSummary | null): void => {
  lastSummary = s;
};
