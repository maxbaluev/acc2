// acc2 Tier -1 floor — storage integrity worker.
//
// Per docs/roadmap.md Tier -1: SQLite WAL + filesystem integrity is a
// floor that MUST hold before posterior scoring is meaningful. This
// worker:
//
//   1. Runs `PRAGMA integrity_check`. Any result other than the single
//      "ok" row triggers integrity_check_failed.
//   2. Runs `PRAGMA wal_checkpoint(TRUNCATE)`. Emits `wal_checkpointed`
//      with the (busy, log, checkpointed) tuple.
//   3. On both passing, emits `storage_integrity_check` with residual=0.
//
// Emit cadence: 5 minutes. Idempotent (at most one emit per interval).
// Predicate row: storage_integrity_predicate (substrate/seed.ts).
//
// NOTE: a separate `integrity_worker` (runtime/integrity_worker.ts)
// runs at a 6-h cadence as part of crash-recovery diagnostics; this
// worker is the Tier -1 floor evidence emitter and ticks much more
// frequently. The two coexist intentionally — different scoring
// audiences, different cadences.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { emitEvent } from "./events";
import { logger } from "./logger";

export const STORAGE_INTEGRITY_TICK_MS = 5 * 60 * 1000;
const MIN_GAP_MS = 5 * 60 * 1000;

export type StorageIntegrityOptions = {
  now?: Date;
  minGapMs?: number;
};

export type StorageIntegritySummary = {
  integrity_status: "ok" | string;
  wal_log_pages: number;
  wal_checkpointed_pages: number;
  emitted_check_event_id?: string;
  emitted_checkpoint_event_id?: string;
  emitted_failure_event_id?: string;
  skipped: boolean;
};

const lastEmitTsMs = (db: Database, kind: string): number => {
  const row = db
    .query<{ ts: string }, [string]>(
      `SELECT ts FROM events WHERE kind = ? ORDER BY ts DESC LIMIT 1`,
    )
    .get(kind);
  if (!row?.ts) return 0;
  const t = Date.parse(row.ts);
  return Number.isFinite(t) ? t : 0;
};

const readIntegrityCheck = (db: Database): "ok" | string => {
  try {
    const rows = db.query("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    if (rows.length === 0) return "no_rows";
    if (rows.length === 1 && rows[0].integrity_check === "ok") return "ok";
    return rows.map((r) => r.integrity_check).join("; ");
  } catch (err) {
    return `integrity_check_threw:${(err as Error).message}`;
  }
};

type WalCheckpointRow = { busy: number; log: number; checkpointed: number } | null;

const runWalCheckpointTruncate = (db: Database): { busy: number; log: number; checkpointed: number } | null => {
  try {
    const row = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as WalCheckpointRow;
    return row ?? null;
  } catch (err) {
    logger.warn(
      { where: "storage_integrity.wal_checkpoint", err: (err as Error).message },
      "wal_checkpoint(TRUNCATE) threw — continuing with integrity emit",
    );
    return null;
  }
};

/** One worker tick. Runs PRAGMA integrity_check + wal_checkpoint(TRUNCATE),
 *  emits storage_integrity_check on pass and integrity_check_failed on
 *  corruption. Always emits wal_checkpointed when the checkpoint
 *  succeeds, regardless of integrity outcome. Fail-soft. */
export const storageIntegrityWorkerTick = (
  db: Database,
  opts: StorageIntegrityOptions = {},
): StorageIntegritySummary => {
  const now = opts.now ?? new Date();
  const minGapMs = Math.max(0, opts.minGapMs ?? MIN_GAP_MS);

  // Idempotency — at most one emit per interval. Compare against the
  // worker's own primary emit kind; floor-wide integrity_check_failed
  // rows are shared across all Tier -1 workers, so gating on them
  // would couple cadences.
  const lastClean = lastEmitTsMs(db, "storage_integrity_check");
  if (now.getTime() - lastClean < minGapMs) {
    return {
      integrity_status: "skipped",
      wal_log_pages: 0,
      wal_checkpointed_pages: 0,
      skipped: true,
    };
  }

  const integrityStatus = readIntegrityCheck(db);
  const checkpointRow = runWalCheckpointTruncate(db);
  const walLogPages = checkpointRow?.log ?? 0;
  const walCheckpointedPages = checkpointRow?.checkpointed ?? 0;

  const summary: StorageIntegritySummary = {
    integrity_status: integrityStatus,
    wal_log_pages: walLogPages,
    wal_checkpointed_pages: walCheckpointedPages,
    skipped: false,
  };

  // Always emit wal_checkpointed when the pragma returned a tuple, even
  // when integrity failed — operators need the WAL trace independent of
  // corruption signal.
  if (checkpointRow) {
    try {
      const emitted = emitEvent(db, {
        kind: "wal_checkpointed",
        substrate_origin: "substrate_auto",
        payload: {
          busy: checkpointRow.busy,
          log_pages: checkpointRow.log,
          checkpointed_pages: checkpointRow.checkpointed,
          trigger: "storage_integrity_worker",
        } as JsonValue,
      });
      summary.emitted_checkpoint_event_id = emitted.id;
    } catch (err) {
      logger.warn(
        { where: "storage_integrity.emit_wal", err: (err as Error).message },
        "wal_checkpointed emit failed",
      );
    }
  }

  try {
    if (integrityStatus === "ok") {
      const emitted = emitEvent(db, {
        kind: "storage_integrity_check",
        substrate_origin: "substrate_auto",
        payload: {
          residual: 0,
          integrity_status: "ok",
          wal_log_pages: walLogPages,
          wal_checkpointed_pages: walCheckpointedPages,
          predicate: "storage_integrity_predicate",
        } as JsonValue,
      });
      summary.emitted_check_event_id = emitted.id;
    } else {
      const emitted = emitEvent(db, {
        kind: "integrity_check_failed",
        substrate_origin: "substrate_auto",
        payload: {
          floor: "storage_integrity",
          predicate: "storage_integrity_predicate",
          integrity_status: integrityStatus,
          wal_log_pages: walLogPages,
          wal_checkpointed_pages: walCheckpointedPages,
          marker: "storage_integrity_violation_v1",
        } as JsonValue,
      });
      summary.emitted_failure_event_id = emitted.id;
      logger.error(
        { integrity_status: integrityStatus, wal_log_pages: walLogPages },
        "storage integrity floor violated — corruption detected",
      );
    }
  } catch (err) {
    logger.warn(
      { where: "storage_integrity.emit", err: (err as Error).message },
      "storage_integrity emit failed — report not lost",
    );
  }

  return summary;
};
