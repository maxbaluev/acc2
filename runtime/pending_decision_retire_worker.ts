// acc2 pending_decision_retire_worker — expire unresolved owner-consent
// decisions after the configured age threshold. The pending-decision surface is
// consent-only; this worker no longer classifies amendment structure.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { emitEvent } from "./events";

/** Default age threshold (7 days, in ms) past which an unresolved
 *  pending_owner_decision row is treated as stale. */
export const STALE_PENDING_DECISION_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type RetireReason = "stale";

export type RetireSummary = {
  /** Pending rows the worker considered (the size of the source scan). */
  scanned: number;
  /** Rows actually retired in this tick. */
  retired: number;
  /** Per-reason breakdown of retires. */
  by_reason: Record<RetireReason, number>;
  /** Rows skipped because a pending_decision_retired event already exists
   *  for the same source event id (idempotency dedup). */
  skipped_already_retired: number;
  /** Rows skipped because they are still recent unresolved owner-consent decisions. */
  skipped_not_eligible: number;
  /** error_caught style strings for failed retire emits. */
  errors: string[];
};

export type RetireOptions = {
  /** Reference timestamp for staleness. Tests pin deterministic values. */
  now?: Date;
  /** Override stale age threshold. Default STALE_PENDING_DECISION_AGE_MS. */
  staleAgeMs?: number;
  /** Hard cap on rows examined per tick. Default 500. */
  maxRows?: number;
  /** Dry-run: count what would retire without emitting. */
  dryRun?: boolean;
};

type ScanRow = {
  source_event_id: string;
  ts: string;
  target: string | null;
  owner_gate_required: number;
};

/** Classify a row from the consent-only scan. Only stale unresolved owner-consent
 *  decisions retire; recent consent decisions remain live. */
export const classifyRetire = (
  row: ScanRow,
  nowMs: number,
  staleAgeMs: number,
): RetireReason | null => {
  if (row.owner_gate_required !== 1) return null;
  const rowMs = Date.parse(row.ts);
  if (Number.isFinite(rowMs) && nowMs - rowMs >= staleAgeMs) return "stale";
  return null;
};

const hasExistingRetire = (
  db: Database,
  sourceEventId: string,
): boolean => {
  const row = db
    .query<{ c: number }, [string, string]>(
      `SELECT COUNT(*) AS c FROM events
        WHERE kind = ?
          AND json_extract(payload, '$.amendment_event_id') = ?`,
    )
    .get("pending_decision_retired", sourceEventId);
  return (row?.c ?? 0) > 0;
};

/** Single tick of the worker. Scans the pending_owner_decision_queue_view
 *  for retire candidates, emits pending_decision_retired per match, and
 *  returns a structured summary the daemon's supervisedTick can log. */
export const runPendingDecisionRetireWorker = (
  db: Database,
  options: RetireOptions = {},
): RetireSummary => {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const staleAgeMs = options.staleAgeMs ?? STALE_PENDING_DECISION_AGE_MS;
  const maxRows = Math.max(1, options.maxRows ?? 500);
  const dryRun = options.dryRun ?? false;
  const summary: RetireSummary = {
    scanned: 0,
    retired: 0,
    by_reason: { stale: 0 },
    skipped_already_retired: 0,
    skipped_not_eligible: 0,
    errors: [],
  };

  // The pending_owner_decision_queue_view groups rows by target, so a single
  // visible group can correspond to many underlying source event ids. Scan the
  // consent-only base rows directly to retire each stale decision idempotently.
  let rows: ScanRow[];
  try {
    rows = db
      .query<ScanRow, [number]>(
        `SELECT q.source_event_id, q.ts,
           CASE WHEN q.target LIKE 'repo:%' THEN substr(q.target, 6) ELSE q.target END AS target,
           CASE WHEN q.owner_gate_required = 1 THEN 1 ELSE 0 END AS owner_gate_required
         FROM lesson_implementer_queue_view q
         WHERE q.source_kind = 'contract_amendment_proposed'
            AND q.owner_gate_required = 1
           AND (q.apply_status IS NULL)
           AND NOT EXISTS (
             SELECT 1 FROM events odr
             WHERE odr.kind = 'owner_decision_recorded'
               AND (json_extract(odr.payload, '$.source_event_id') = q.source_event_id
                 OR EXISTS (SELECT 1 FROM json_each(COALESCE(odr.context_refs, '[]')) WHERE value = q.source_event_id))
           )
           AND NOT EXISTS (
             SELECT 1 FROM events ret
             WHERE ret.kind = 'pending_decision_retired'
               AND json_extract(ret.payload, '$.amendment_event_id') = q.source_event_id
           )
         ORDER BY q.ts ASC
         LIMIT ?`,
      )
      .all(maxRows);
  } catch (err) {
    summary.errors.push(`scan_failed:${(err as Error).message}`);
    return summary;
  }

  summary.scanned = rows.length;

  for (const row of rows) {
    const reason = classifyRetire(row, nowMs, staleAgeMs);
    if (reason === null) {
      summary.skipped_not_eligible++;
      continue;
    }
    if (hasExistingRetire(db, row.source_event_id)) {
      summary.skipped_already_retired++;
      continue;
    }
    summary.by_reason[reason]++;
    summary.retired++;
    if (dryRun) continue;
    try {
      const payload: JsonValue = {
        amendment_event_id: row.source_event_id,
        reason,
        retired_at: now.toISOString(),
        target: row.target ?? null,
        amendment_ts: row.ts,
      };
      emitEvent(db, {
        kind: "pending_decision_retired",
        substrate_origin: "substrate_auto",
        context_refs: [row.source_event_id],
        payload,
      });
    } catch (err) {
      summary.errors.push(
        `emit_retire_failed:${row.source_event_id}:${(err as Error).message}`,
      );
      summary.retired--;
      summary.by_reason[reason]--;
    }
  }

  return summary;
};
