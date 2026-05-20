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

const WAL_CHECKPOINT_THRESHOLD_BYTES = 20 * 1024 * 1024; // 20 MB (foundational fix 2026-05-16 — was 100MB; pair with PRAGMA wal_autocheckpoint=2000 + journal_size_limit=64MB in substrate/db.ts).

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
  // Mid-session zombie sweep: any brain_dispatched older than
  // STALE_DISPATCH_THRESHOLD_MS (15 min) with no closing event is a dead
  // dispatch — the dispatcher crashed, the bridge hung, or the subprocess
  // got OOM-killed. We emit dispatch_recovered_orphan so the scheduler's
  // next tick re-picks the task. Wrapped in try/catch because integrity
  // ticks must not crash the worker.
  try {
    reconcileStaleDispatches(db);
  } catch (err) {
    logger.warn(
      { where: "integrity.reconcile_stale_dispatches", err: (err as Error).message },
      "mid-session stale-dispatch reconcile failed — will retry next tick",
    );
  }

  // Supervisor runs on its OWN worker now (60s tick, see runtime/daemon.ts).
  // It WAS piggybacked here, but the integrity worker ticks every 6 HOURS
  // — far too slow to catch redispatch storms or DAG explosions.
  // Decoupled 2026-05-15.

  // After emit, opportunistically truncate WAL if it's grown past
  // threshold. (We do this AFTER the check emission so the audit log
  // reflects the state at check time.)
  maybeCheckpointWal(db);
  return report;
};

/** Mid-session dispatch staleness threshold. A brain_dispatched row older
 *  than this with no closing event is treated as a zombie. 15 minutes is a
 *  comfortable margin above the worst-case opencode latency (5 min default
 *  timeout × 2 retries + slack). reconcileStaleDispatches uses this; the
 *  boot-time reconcileOrphanedDispatches has no age filter (the daemon was
 *  killed, every in-flight dispatch is dead). */
export const STALE_DISPATCH_THRESHOLD_MS = 15 * 60 * 1000;

/** Parse the original brain_dispatched payload to recover its dispatch_id.
 *  The orphan-recovery path uses this to emit a properly-keyed
 *  brain_dispatch_closed event (per YEF00QZM lesson HJFTSQ4V2 — closing
 *  the lease durably is what lets the scheduler deterministically
 *  redispatch the same task_id). Returns null when the payload is missing
 *  or malformed; callers should still emit the close (the dispatch_id is
 *  best-effort enrichment, not load-bearing). */
const parseOriginalDispatchId = (row: { payload?: string | null }): string | null => {
  if (!row.payload || typeof row.payload !== "string") return null;
  try {
    const parsed = JSON.parse(row.payload) as Record<string, unknown>;
    const dispatchId = parsed.dispatch_id;
    return typeof dispatchId === "string" && dispatchId.length > 0 ? dispatchId : null;
  } catch {
    return null;
  }
};


/** Age-aware version of reconcileOrphanedDispatches, safe to call from any
 *  worker tick (not just boot). Two extra guards relative to the boot
 *  version: (1) the dispatch must be older than `minAgeMs` so a healthy
 *  in-flight call isn't flagged; (2) we skip dispatches that already have
 *  a `dispatch_recovered_orphan` row so repeated ticks don't re-emit the
 *  same recovery. The scheduler still re-picks the task on the next
 *  ready_tasks_view scan. */
export const reconcileStaleDispatches = (
  db: Database,
  opts?: { minAgeMs?: number; nowMs?: number },
): Array<{ dispatch_event_id: string; task_id: string; age_ms: number }> => {
  const minAgeMs = opts?.minAgeMs ?? STALE_DISPATCH_THRESHOLD_MS;
  const nowMs = opts?.nowMs ?? Date.now();
  const cutoffIso = new Date(nowMs - minAgeMs).toISOString();

  const rows = db
    .query(
      `SELECT e.id AS dispatch_event_id, e.task_id, e.directive_id, e.ts, e.payload
       FROM events e
       WHERE e.kind = 'brain_dispatched'
         AND e.ts <= ?
         AND NOT EXISTS (
           SELECT 1 FROM events c
           WHERE c.task_id = e.task_id
             AND c.kind IN (
               'brain_dispatch_closed', 'dispatcher_violation',
               'task_committed', 'task_failed', 'task_abandoned',
               'task_blocked', 'task_committed_superseded'
             )
             AND c.ts >= e.ts
         )
         AND NOT EXISTS (
           -- Dedupe: skip if ALREADY recovered AND closed. Per YEF00QZM
           -- lesson, legacy rows that were recovered before lease-closure
           -- shipped (no brain_dispatch_closed in tandem) must NOT be
           -- skipped — they need their close emitted before the scheduler
           -- can deterministically redispatch. The recovered+closed pair
           -- is the durable terminal state.
           SELECT 1 FROM events r
           WHERE r.kind = 'dispatch_recovered_orphan'
             AND json_extract(r.payload, '$.original_dispatch_event_id') = e.id
             AND json_extract(r.payload, '$.recovery_close_event_id') IS NOT NULL
         )`,
    )
    .all(cutoffIso) as Array<{ dispatch_event_id: string; task_id: string; directive_id: string; ts: string; payload: string }>;

  const recovered: Array<{ dispatch_event_id: string; task_id: string; age_ms: number }> = [];
  for (const row of rows) {
    const ageMs = nowMs - Date.parse(row.ts);
    try {
      // Close the lease FIRST (per YEF00QZM lesson: closing interrupted
      // dispatch leases durably is what lets the scheduler deterministically
      // redispatch the same task_id; without it, the dispatch_id stays
      // "in-flight" forever from the perspective of any consumer that joins
      // brain_dispatched ↔ brain_dispatch_closed).
      const dispatchId = parseOriginalDispatchId(row as { payload?: string });
      const closeEvent = emitEvent(db, {
        kind: "brain_dispatch_closed",
        substrate_origin: "substrate_auto",
        directive_id: row.directive_id,
        task_id: row.task_id,
        payload: {
          dispatch_id: dispatchId,
          reason: "stale_orphan_recovered",
          original_dispatch_event_id: row.dispatch_event_id,
          stale_age_ms: ageMs,
        },
      });
      emitEvent(db, {
        kind: "dispatch_recovered_orphan",
        substrate_origin: "substrate_auto",
        directive_id: row.directive_id,
        task_id: row.task_id,
        payload: {
          original_dispatch_event_id: row.dispatch_event_id,
          recovery_close_event_id: closeEvent.id,
          recovery_action: "scheduler_will_repick",
          recovery_path: "mid_session_stale_reconcile",
          stale_age_ms: ageMs,
          min_age_ms: minAgeMs,
        },
      });
      recovered.push({ dispatch_event_id: row.dispatch_event_id, task_id: row.task_id, age_ms: ageMs });
    } catch (err) {
      logger.warn(
        {
          where: "integrity.reconcile_stale_dispatch",
          dispatch_event_id: row.dispatch_event_id,
          err: (err as Error).message,
        },
        "could not emit dispatch_recovered_orphan (mid-session)",
      );
    }
  }
  if (recovered.length > 0) {
    logger.warn(
      { count: recovered.length, min_age_ms: minAgeMs },
      "recovered stale dispatches mid-session — scheduler will re-pick",
    );
  }
  return recovered;
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
             AND c.kind IN (
               'brain_dispatch_closed', 'dispatcher_violation',
               'task_committed', 'task_failed', 'task_abandoned',
               'task_blocked', 'task_committed_superseded'
             )
             AND c.ts >= e.ts
         )
         AND NOT EXISTS (
           -- Dedupe: skip if ALREADY recovered AND closed. Per YEF00QZM
           -- lesson HJFTSQ4V2, legacy rows recovered before lease-closure
           -- shipped (no brain_dispatch_closed in tandem) must NOT be
           -- skipped — they need their close emitted before the scheduler
           -- can deterministically redispatch the same task_id. Without
           -- this, the worker tick re-emits dispatch_recovered_orphan every
           -- cadence for the same orphans, flooding the SQLite write queue
           -- (~56 events / 10min observed 2026-05-16 when 9 orphans persisted).
           SELECT 1 FROM events r
           WHERE r.kind = 'dispatch_recovered_orphan'
             AND r.task_id = e.task_id
             AND json_extract(r.payload, '$.original_dispatch_event_id') = e.id
             AND json_extract(r.payload, '$.recovery_close_event_id') IS NOT NULL
         )`,
    )
    .all() as Array<{ dispatch_event_id: string; task_id: string; directive_id: string; payload: string }>;
  const orphans: Array<{ dispatch_event_id: string; task_id: string }> = [];
  for (const row of rows) {
    try {
      // Close the lease FIRST (per YEF00QZM lesson). Without an explicit
      // brain_dispatch_closed, downstream joins that count "open" leases
      // never reach zero for the old dispatch_id, and the scheduler can't
      // tell a hard-killed subprocess from an in-flight one.
      const dispatchId = parseOriginalDispatchId(row);
      const closeEvent = emitEvent(db, {
        kind: "brain_dispatch_closed",
        substrate_origin: "substrate_auto",
        directive_id: row.directive_id,
        task_id: row.task_id,
        payload: {
          dispatch_id: dispatchId,
          // Canonical reason for the boot-side orphan-close path
          // (XA3ABKERHD4H survival spec). `restart_orphan_recovered`
          // is retained for any pinned reader; the survival-spec
          // `daemon_restart_during_dispatch` is alongside it and
          // `recovered: true` marks the synthetic terminal so the
          // ledger is explicit that no clean close ever happened.
          reason: "restart_orphan_recovered",
          closure_reason: "daemon_restart_during_dispatch",
          recovered: true,
          original_dispatch_event_id: row.dispatch_event_id,
        },
      });
      emitEvent(db, {
        kind: "dispatch_recovered_orphan",
        substrate_origin: "substrate_auto",
        directive_id: row.directive_id,
        task_id: row.task_id,
        payload: {
          original_dispatch_event_id: row.dispatch_event_id,
          recovery_close_event_id: closeEvent.id,
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
