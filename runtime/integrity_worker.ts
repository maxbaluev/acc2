// acc2 DB integrity worker — periodic PRAGMA integrity_check + WAL hygiene.
//
// Per docs/production-readiness.md (Top-2 / blocker #2-ops), the daemon
// must run a periodic SQLite integrity check so silent corruption surfaces
// as a substrate event rather than as a mysterious crash. The worker:
//
//   1. Runs `PRAGMA integrity_check` (full check; SQLite returns "ok" or
//      one or more error rows).
//   2. Measures WAL file size on disk (via PRAGMA wal_checkpoint to read
//      the current frame count, multiplied by page_size).
//   3. If WAL > 100 MB, runs `PRAGMA wal_checkpoint(TRUNCATE)` to force
//      a checkpoint and emits `wal_checkpointed`.
//   4. Emits `integrity_check_failed` (NEW kind) with the error text when
//      the check fails — the daemon does NOT auto-restart; operator
//      decides. Emits `integrity_check_completed` otherwise.
//
// The worker is fail-soft: a transient SQL error must not crash the
// daemon. The boot-time check (called from daemon.ts:startDaemon BEFORE
// accepting traffic) IS fail-fast — it returns the report and the
// daemon decides whether to exit.

import type { Database } from "bun:sqlite";
import { emitEvent } from "./events";
import { logger } from "./logger";

const WAL_CHECKPOINT_THRESHOLD_BYTES = 100 * 1024 * 1024; // 100 MB

export type IntegrityReport = {
  ok: boolean;
  pragma_integrity_check: "ok" | string;
  wal_size_bytes: number;
  events_count: number;
  embeddings_count: number;
  duration_ms: number;
};

const readPageSize = (db: Database): number => {
  try {
    const row = db.query("PRAGMA page_size").get() as { page_size: number } | null;
    return row?.page_size ?? 4096;
  } catch {
    return 4096;
  }
};

/** Read the current WAL size in bytes. SQLite exposes the WAL frame count
 *  via `PRAGMA wal_checkpoint(PASSIVE)` (returns busy, log, checkpointed)
 *  but the resulting frame count is the number of pages currently in the
 *  WAL. Multiplied by page_size gives byte count. */
const readWalSizeBytes = (db: Database): number => {
  try {
    // PRAGMA wal_checkpoint(PASSIVE) returns: busy, log, checkpointed
    // `log` is the WAL frame count.
    const row = db.query("PRAGMA wal_checkpoint(PASSIVE)").get() as
      | { busy: number; log: number; checkpointed: number }
      | null;
    if (!row) return 0;
    const pageSize = readPageSize(db);
    return Math.max(0, (row.log ?? 0) * pageSize);
  } catch {
    return 0;
  }
};

/** Run one integrity check and return the report. Does NOT emit events —
 *  the caller (boot-time or worker tick) decides whether to emit. */
export const runIntegrityCheck = async (db: Database): Promise<IntegrityReport> => {
  const startMs = Date.now();
  let integrityResult: "ok" | string = "ok";
  let ok = true;
  try {
    const rows = db.query("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    if (rows.length === 0) {
      integrityResult = "no_rows";
      ok = false;
    } else if (rows.length === 1 && rows[0].integrity_check === "ok") {
      integrityResult = "ok";
      ok = true;
    } else {
      integrityResult = rows.map((r) => r.integrity_check).join("; ");
      ok = false;
    }
  } catch (err) {
    integrityResult = (err as Error).message ?? "integrity_check_threw";
    ok = false;
  }

  const wal_size_bytes = readWalSizeBytes(db);
  let events_count = 0;
  let embeddings_count = 0;
  try {
    const e = db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number } | null;
    events_count = e?.n ?? 0;
  } catch (err) {
    logger.debug({ where: "integrity.events_count", err: String(err) }, "events count failed");
  }
  try {
    const v = db.query("SELECT COUNT(*) AS n FROM vec_events").get() as { n: number } | null;
    embeddings_count = v?.n ?? 0;
  } catch (err) {
    logger.debug({ where: "integrity.embeddings_count", err: String(err) }, "vec_events count failed");
  }

  return {
    ok,
    pragma_integrity_check: integrityResult,
    wal_size_bytes,
    events_count,
    embeddings_count,
    duration_ms: Date.now() - startMs,
  };
};

/** Run the WAL checkpoint truncation when size exceeds threshold. Emits
 *  `wal_checkpointed` on success. Returns the new size. */
export const maybeCheckpointWal = (db: Database): { checkpointed: boolean; new_size_bytes: number } => {
  const sizeBefore = readWalSizeBytes(db);
  if (sizeBefore < WAL_CHECKPOINT_THRESHOLD_BYTES) {
    return { checkpointed: false, new_size_bytes: sizeBefore };
  }
  try {
    db.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
    const sizeAfter = readWalSizeBytes(db);
    emitEvent(db, {
      kind: "wal_checkpointed",
      substrate_origin: "substrate_auto",
      payload: {
        size_before_bytes: sizeBefore,
        size_after_bytes: sizeAfter,
        threshold_bytes: WAL_CHECKPOINT_THRESHOLD_BYTES,
      },
    });
    return { checkpointed: true, new_size_bytes: sizeAfter };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "wal checkpoint failed");
    return { checkpointed: false, new_size_bytes: sizeBefore };
  }
};

/** Background worker tick — runs an integrity check, emits the
 *  corresponding event, and conditionally truncates the WAL. */
export const integrityWorkerTick = async (db: Database): Promise<IntegrityReport> => {
  const report = await runIntegrityCheck(db);
  try {
    if (report.ok) {
      emitEvent(db, {
        kind: "integrity_check_completed",
        substrate_origin: "substrate_auto",
        payload: {
          pragma_result: report.pragma_integrity_check,
          wal_size_bytes: report.wal_size_bytes,
          events_count: report.events_count,
          embeddings_count: report.embeddings_count,
          duration_ms: report.duration_ms,
        },
      });
      logger.debug(
        {
          wal_size_bytes: report.wal_size_bytes,
          events_count: report.events_count,
          duration_ms: report.duration_ms,
        },
        "integrity check completed",
      );
    } else {
      emitEvent(db, {
        kind: "integrity_check_failed",
        substrate_origin: "substrate_auto",
        payload: {
          pragma_result: report.pragma_integrity_check,
          wal_size_bytes: report.wal_size_bytes,
          events_count: report.events_count,
          embeddings_count: report.embeddings_count,
          duration_ms: report.duration_ms,
          // Stack-trace marker so log explorers can group these.
          marker: "integrity_check_failed_v1",
        },
      });
      logger.error(
        {
          pragma_result: report.pragma_integrity_check,
          wal_size_bytes: report.wal_size_bytes,
        },
        "integrity check FAILED — operator action required",
      );
    }
  } catch (err) {
    // Emission failure must not crash the worker — the report stands. Log
    // at warn since this is structurally important state.
    logger.warn(
      { where: "integrity.emit", err: (err as Error).message },
      "integrity event emission failed — report not lost (in-memory)",
    );
  }
  // After emit, opportunistically truncate WAL if it's grown past
  // threshold. (We do this AFTER the check emission so the audit log
  // reflects the state at check time.)
  maybeCheckpointWal(db);
  return report;
};

/** Reconcile in-flight dispatches at boot. Each `brain_dispatched` row
 *  without a matching `brain_dispatch_closed` / `dispatcher_violation` /
 *  `task_failed` is treated as an orphan (the daemon was killed
 *  mid-dispatch). We emit `dispatch_recovered_orphan` for each so the
 *  audit trail records the recovery; we do NOT re-dispatch — the
 *  scheduler's next ready_tasks_view check will pick the task up. */
export const reconcileOrphanedDispatches = (db: Database): Array<{ dispatch_event_id: string; task_id: string }> => {
  const rows = db
    .query(
      `SELECT e.id AS dispatch_event_id, e.task_id, e.directive_id, e.payload
       FROM events e
       WHERE e.kind = 'brain_dispatched'
         AND NOT EXISTS (
           SELECT 1 FROM events c
           WHERE c.task_id = e.task_id
             AND c.kind IN ('brain_dispatch_closed', 'dispatcher_violation', 'task_failed')
             AND c.ts >= e.ts
         )`,
    )
    .all() as Array<{ dispatch_event_id: string; task_id: string; directive_id: string; payload: string }>;
  const orphans: Array<{ dispatch_event_id: string; task_id: string }> = [];
  for (const row of rows) {
    try {
      emitEvent(db, {
        kind: "dispatch_recovered_orphan",
        substrate_origin: "substrate_auto",
        directive_id: row.directive_id,
        task_id: row.task_id,
        payload: {
          original_dispatch_event_id: row.dispatch_event_id,
          recovery_action: "scheduler_will_repick",
        },
      });
      orphans.push({ dispatch_event_id: row.dispatch_event_id, task_id: row.task_id });
    } catch (err) {
      // Skip on emission failure; the next boot will retry. Log so the
      // audit trail isn't entirely silent.
      logger.warn(
        {
          where: "integrity.reconcile_orphan",
          dispatch_event_id: row.dispatch_event_id,
          err: (err as Error).message,
        },
        "could not emit dispatch_recovered_orphan",
      );
    }
  }
  if (orphans.length > 0) {
    logger.warn({ count: orphans.length }, "recovered orphaned dispatches from previous boot");
  }
  return orphans;
};
