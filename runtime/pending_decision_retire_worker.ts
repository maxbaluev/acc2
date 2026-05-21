// acc2 pending_decision_retire_worker — auto-prune pending-owner-decision
// queue noise per brain validation dispatch (2026-05-19).
//
// Brain validation REFUSED Option A (full removal of the
// pending_owner_decision_queue_view) because the audit trail for failed
// amendments matters — the surface IS valuable for owner visibility into
// what the brain wanted but couldn't auto-apply. The brain recommended
// Option B+: keep the surface, auto-retire the three stale classes that
// pollute it.
//
// Retire shapes:
//
//   1. anchor_missing — the amendment's proposed anchor doesn't resolve
//      against the target file (or the diff is malformed: empty after,
//      empty before, missing diff). The pending_owner_decision_queue_view
//      already classifies these via decline_candidate_reason; this worker
//      observes the classification and retires.
//
//   2. test_file_target — target_resource looks like a test path
//      (tests/**, *.test.ts, *.spec.ts, *.test.tsx, *.spec.tsx). These
//      should never have been routed to operator review — the brain's
//      test-lane handles them, and dropping a contract_amendment_proposed
//      against a test file is almost always a misroute artifact.
//
//   3. stale — the source contract_amendment_proposed is older than the
//      configurable age threshold (default 7 days) and has not received
//      an owner_decision_recorded or any other terminator. Cites KC
//      YKJYRGVJJX21XAMQS042PMK7JG.
//
// Idempotency: every retire emit consults the existing
// `pending_decision_retired` events for the source event id; re-running
// the worker on already-retired rows is a no-op.
//
// The companion `pending_owner_decision_queue_live_view` (substrate/views.ts)
// excludes any source_event_id that has a pending_decision_retired row, so
// `acc admin pending-decisions` (which now projects through the LIVE view)
// shows only the un-retired remainder. The historical
// pending_owner_decision_queue_view stays for audit.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { emitEvent } from "./events";

/** Default age threshold (7 days, in ms) past which an unresolved
 *  pending_owner_decision row is treated as stale. */
export const STALE_PENDING_DECISION_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type RetireReason =
  | "stale"
  | "test_file_target"
  | "anchor_missing";

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
  /** Rows skipped because they did not match ANY retire predicate. These
   *  stay on the live view — they ARE the legitimate operator-decision
   *  candidates the surface exists to surface. */
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

/** True when the target string looks like a test-file path. The brain
 *  occasionally routes amendments against test files for owner review,
 *  but tests are the brain's own lane — the operator should never have
 *  been asked. Patterns checked: `tests/**`, `*.test.ts(x)`, `*.spec.ts(x)`. */
export const isTestFileTarget = (target: string | null | undefined): boolean => {
  if (typeof target !== "string" || target.length === 0) return false;
  // Normalize a repo: prefix the lesson-implementer view sometimes adds.
  const normalized = target.startsWith("repo:") ? target.slice(5) : target;
  if (normalized.startsWith("tests/") || normalized.includes("/tests/")) return true;
  if (/\.(test|spec)\.[tj]sx?$/i.test(normalized)) return true;
  return false;
};

type ScanRow = {
  source_event_id: string;
  ts: string;
  target: string | null;
  anchor: string | null;
  candidate_diff: string | null;
  decline_candidate_reason: string | null;
};

/** Classify a row from the pending-decision scan. Returns the FIRST
 *  matching retire reason, or null when the row should stay live. The
 *  order — anchor_missing → test_file_target → stale — matches the
 *  priority documented in the payload contract: anchor problems and
 *  test-file misroutes are categorical (retire regardless of age);
 *  stale is the age-based fallback for everything else. */
export const classifyRetire = (
  row: ScanRow,
  nowMs: number,
  staleAgeMs: number,
): RetireReason | null => {
  if (row.decline_candidate_reason !== null) return "anchor_missing";
  if (isTestFileTarget(row.target)) return "test_file_target";
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
    by_reason: { stale: 0, test_file_target: 0, anchor_missing: 0 },
    skipped_already_retired: 0,
    skipped_not_eligible: 0,
    errors: [],
  };

  // The pending_owner_decision_queue_view groups rows by (target, anchor)
  // so a single visible group can correspond to many underlying source
  // event ids. To produce ONE retire event per amendment row (not per
  // group), we scan the underlying base shape — every
  // contract_amendment_proposed that the view would surface — via the
  // same CTE shape inlined here. We deliberately do NOT push retired
  // rows back into the historical view; the LIVE view filters them out
  // instead so the audit trail stays intact.
  let rows: ScanRow[];
  try {
    rows = db
      .query<ScanRow, [number]>(
        `WITH base AS (
           SELECT
             q.source_event_id,
             q.ts,
             CASE WHEN q.target LIKE 'repo:%' THEN substr(q.target, 6) ELSE q.target END AS target,
             q.anchor,
             q.candidate_diff
           FROM lesson_implementer_queue_view q
           WHERE q.source_kind = 'contract_amendment_proposed'
             -- 2026-05-21: structurally-broken amendments (empty anchor)
             -- are un-appliable REGARDLESS of gate status — include them in
             -- the retire scan even when they are not owner-gated /
             -- manual-review. Pre-fix the scan was scoped to gated rows
             -- only, so ~190 of 265 anchorless amendments accumulated
             -- forever (the worker retired the gated subset but never the
             -- rest). An amendment with no anchor can never resolve a target
             -- location, so it is safe to retire on sight.
             AND (q.owner_gate_required = 1
                  OR q.apply_gate_status = 'manual_review'
                  OR q.anchor IS NULL
                  OR length(trim(q.anchor)) = 0)
             AND (q.apply_status IS NULL)
             AND (q.candidate_diff IS NULL OR json_valid(q.candidate_diff) = 1)
             AND NOT EXISTS (
               SELECT 1 FROM events odr
               WHERE odr.kind = 'owner_decision_recorded'
                 AND (
                   json_extract(odr.payload, '$.source_event_id') = q.source_event_id
                   OR EXISTS (SELECT 1 FROM json_each(COALESCE(odr.context_refs, '[]')) WHERE value = q.source_event_id)
                 )
             )
         )
         SELECT
           b.source_event_id,
           b.ts,
           b.target,
           b.anchor,
           b.candidate_diff,
           CASE
             WHEN b.anchor IS NULL OR length(trim(b.anchor)) = 0 THEN 'anchor_missing'
             WHEN b.candidate_diff IS NULL THEN 'diff_missing'
             WHEN json_extract(b.candidate_diff, '$.kind') = 'anchored_replace_v1'
               AND length(COALESCE(json_extract(b.candidate_diff, '$.after'), '')) = 0 THEN 'empty_after'
             WHEN json_extract(b.candidate_diff, '$.kind') = 'anchored_replace_v1'
               AND length(COALESCE(json_extract(b.candidate_diff, '$.before'), '')) = 0 THEN 'empty_before'
             ELSE NULL
           END AS decline_candidate_reason
         FROM base b
         ORDER BY b.ts ASC
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
        anchor: row.anchor ?? null,
        // The decline_candidate_reason classification from the view is
        // preserved so a future audit can distinguish anchor_missing
        // vs. diff_missing vs. empty_after even though the canonical
        // reason field collapses all three into "anchor_missing".
        source_decline_candidate_reason: row.decline_candidate_reason ?? null,
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
