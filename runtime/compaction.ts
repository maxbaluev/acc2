// acc2 substrate compaction (Batch 10, 2026-05-15) — owner directive:
//   "make most reactive smart and fast and universal and elegant and
//    efficient organism on planet"
//
// The substrate's events table is append-only AND unbounded. Live evidence
// (15030 events after one operator session) showed 44% of rows are
// `bridge_frame_received` — opencode subprocess JSON-event frames the
// bridge mirrors for cycle-1 enforcement AND audit. Once a dispatch closes
// (brain_dispatch_closed lands), these frames are observation-only — no
// view, no scheduler path, no extractor, no retrieval surface consumes
// them. They bloat the row count, slow SQL scans, and inflate WAL.
//
// Compaction is a periodic worker that PRUNES `bridge_frame_received`
// older than COMPACTION_FRAME_RETENTION_MS for dispatches that have
// already closed. The dispatch ID itself, brain_dispatched, and the
// closing event all stay forever — only the per-frame mirror is removed.
//
// Why pruning, not archival to a frozen table:
//   - The frames are mirror data — the canonical signal is the
//     `brain_dispatch_closed` row + its `events_count` field. Recovering
//     the raw frames requires re-running the dispatch, not reading an
//     archive.
//   - Operators inspecting recent flow use `acc events --kind ...` which
//     queries the live events table. An archive table that operators
//     never query is dead weight.
//   - SQLite handles row deletes well with WAL + VACUUM. The integrity
//     worker already runs WAL checkpoint.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { emitEvent } from "./events";
import { logger } from "./logger";

/** Retention window. Frames older than this are eligible for pruning.
 *  24 hours gives operators a full day to inspect a closed dispatch via
 *  `acc events` before the frames vanish. Override via
 *  ACC2_COMPACTION_RETENTION_MS. */
export const COMPACTION_FRAME_RETENTION_MS = Number(
  process.env.ACC2_COMPACTION_RETENTION_MS ?? 24 * 60 * 60 * 1000,
);

/** Cap on rows pruned per tick. Keeps the compaction worker bounded so it
 *  never holds the DB write lock for long. 5000/tick × hourly = 120k/day
 *  in steady state, far above realistic frame volume. */
export const COMPACTION_BATCH_SIZE = 5_000;

export type CompactionReport = {
  pruned_frames: number;
  cutoff_iso: string;
};

/** Prune bridge_frame_received rows older than the retention window AND
 *  whose dispatch has already closed (brain_dispatch_closed / task_failed
 *  / task_committed on the same task_id, at >= the frame's ts). Returns
 *  the number of rows actually deleted. Idempotent; safe to call
 *  repeatedly. */
export const compactBridgeFrames = (
  db: Database,
  opts?: { nowMs?: number; batchSize?: number },
): CompactionReport => {
  const nowMs = opts?.nowMs ?? Date.now();
  const batchSize = opts?.batchSize ?? COMPACTION_BATCH_SIZE;
  const cutoffIso = new Date(nowMs - COMPACTION_FRAME_RETENTION_MS).toISOString();

  // Frames whose owning task has a terminal event AT OR AFTER the frame's
  // ts are safe to prune. A frame older than `cutoffIso` whose dispatch is
  // still in-flight (no closing event) stays — the bridge may still be
  // consuming it. In practice all >24h frames have closed long ago.
  const result = db
    .query(
      `DELETE FROM events WHERE id IN (
         SELECT f.id FROM events f
         WHERE f.kind = 'bridge_frame_received'
           AND f.ts < ?
           AND EXISTS (
             SELECT 1 FROM events c
             WHERE c.task_id = f.task_id
               AND c.kind IN ('brain_dispatch_closed', 'task_committed', 'task_failed', 'task_abandoned')
               AND c.ts >= f.ts
           )
         LIMIT ?
       )`,
    )
    .run(cutoffIso, batchSize);

  const pruned = Number(result.changes ?? 0);
  return { pruned_frames: pruned, cutoff_iso: cutoffIso };
};

/** One compaction worker tick. Prunes frames + emits a substrate event
 *  with the result when pruning happened. Safe to call repeatedly. */
export const compactionWorkerTick = (db: Database): CompactionReport => {
  try {
    const report = compactBridgeFrames(db);
    if (report.pruned_frames > 0) {
      try {
        emitEvent(db, {
          kind: "substrate_compacted",
          substrate_origin: "substrate_auto",
          payload: {
            pruned_frames: report.pruned_frames,
            cutoff_iso: report.cutoff_iso,
            retention_ms: COMPACTION_FRAME_RETENTION_MS,
          } as JsonValue,
        });
      } catch (err) {
        logger.warn(
          { where: "compaction.emit", err: (err as Error).message },
          "substrate_compacted emit failed (rows already pruned)",
        );
      }
    }
    return report;
  } catch (err) {
    logger.warn(
      { where: "compaction.tick", err: (err as Error).message },
      "compaction tick failed",
    );
    return { pruned_frames: 0, cutoff_iso: new Date().toISOString() };
  }
};
