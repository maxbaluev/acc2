// acc2 T1.1 — owner-outcome follow-up worker.
// Opens a HIDL action after an applied change has aged past the feedback
// window, so owner truth can enter the ledger as owner_observed_outcome_recorded.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { emitEvent } from "./events";

export type OwnerOutcomeFollowupOptions = {
  now?: Date;
  maxRows?: number;
  feedbackWindowMs?: number;
  dryRun?: boolean;
};

export type OwnerOutcomeFollowupSummary = {
  scanned: number;
  emitted_count: number;
  skipped_recent: number;
  skipped_ineligible: number;
  skipped_existing_followup: number;
  emitted_event_ids: string[];
};

type AppliedChangeRow = {
  id: string;
  ts: string;
  directive_id: string | null;
  task_id: string | null;
  context_refs: string | null;
  payload: string | null;
};

const DEFAULT_FEEDBACK_WINDOW_MS = 24 * 60 * 60 * 1000;

const parsePayload = (raw: string | null): Record<string, unknown> => {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
};

const parseContextRefs = (raw: string | null): string[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
};

const hasPriorFollowup = (db: Database, appliedChangeId: string): boolean => {
  const row = db
    .query<{ c: number }, [string, string, string]>(
      `SELECT COUNT(*) AS c FROM events
        WHERE (kind = 'hidl_action_required' OR kind = 'owner_observed_outcome_recorded')
          AND (context_refs LIKE ?
            OR json_extract(payload, '$.source_applied_change_event_id') = ?
            OR json_extract(payload, '$.source_event_id') = ?)`,
    )
    .get(`%${appliedChangeId}%`, appliedChangeId, appliedChangeId);
  return (row?.c ?? 0) > 0;
};

const isEligibleAppliedChange = (row: AppliedChangeRow): boolean => {
  const payload = parsePayload(row.payload);
  if (payload.status !== "applied") return false;
  const refs = parseContextRefs(row.context_refs);
  if (refs.includes(row.id)) return false;
  const affected = payload.affected_resources;
  return Array.isArray(affected) && affected.length > 0;
};

export const runOwnerOutcomeFollowupWorker = async (
  db: Database,
  options: OwnerOutcomeFollowupOptions = {},
): Promise<OwnerOutcomeFollowupSummary> => {
  const now = options.now ?? new Date();
  const feedbackWindowMs = Math.max(0, options.feedbackWindowMs ?? DEFAULT_FEEDBACK_WINDOW_MS);
  const maxRows = Math.max(1, options.maxRows ?? 100);
  const summary: OwnerOutcomeFollowupSummary = {
    scanned: 0,
    emitted_count: 0,
    skipped_recent: 0,
    skipped_ineligible: 0,
    skipped_existing_followup: 0,
    emitted_event_ids: [],
  };

  // STARVATION FIX (2026-05-23 isolation-hygiene audit): the prior query was
  // `ORDER BY ts ASC LIMIT maxRows` over ALL applied_change_committed rows.
  // Past ~maxRows applied changes, the absolute-oldest maxRows rows are all
  // either already-followed-up or within-window-stale, so the LIMIT is fully
  // consumed by rows the loop skips — and a NEWLY-aged-out change (which sits
  // at the tail of ts-ascending order) is never reached. The worker silently
  // stops emitting follow-ups at scale. Fix: push the feedback-window age
  // cutoff AND the prior-followup exclusion into SQL so the LIMIT applies to
  // the set of rows the worker can actually act on (aged-out, no follow-up
  // yet), oldest-first. `skipped_recent` is no longer observable from this
  // query path (the cutoff removes within-window rows before they are
  // scanned); the loop still defends the window for callers who pass a
  // larger feedbackWindowMs than the cutoff implies.
  const cutoffIso = new Date(now.getTime() - feedbackWindowMs).toISOString();
  const rows = db
    .query<AppliedChangeRow, [string, number]>(
      `SELECT id, ts, directive_id, task_id, context_refs, payload
        FROM events e
        WHERE kind = 'applied_change_committed'
          AND ts <= ?
          AND NOT EXISTS (
            SELECT 1 FROM events f
            WHERE (f.kind = 'hidl_action_required' OR f.kind = 'owner_observed_outcome_recorded')
              AND (f.context_refs LIKE '%' || e.id || '%'
                OR json_extract(f.payload, '$.source_applied_change_event_id') = e.id
                OR json_extract(f.payload, '$.source_event_id') = e.id)
          )
        ORDER BY ts ASC
        LIMIT ?`,
    )
    .all(cutoffIso, maxRows);

  for (const row of rows) {
    summary.scanned++;
    if (now.getTime() - new Date(row.ts).getTime() < feedbackWindowMs) {
      summary.skipped_recent++;
      continue;
    }
    if (!isEligibleAppliedChange(row)) {
      summary.skipped_ineligible++;
      continue;
    }
    if (hasPriorFollowup(db, row.id)) {
      summary.skipped_existing_followup++;
      continue;
    }
    if (options.dryRun) continue;

    const payload = parsePayload(row.payload);
    const emitted = emitEvent(db, {
      kind: "hidl_action_required",
      substrate_origin: "substrate_auto",
      directive_id: row.directive_id ?? undefined,
      task_id: row.task_id ?? undefined,
      context_refs: [row.id],
      payload: {
        summary: "Owner outcome feedback requested for an applied change.",
        reason: "owner_outcome_followup",
        source_applied_change_event_id: row.id,
        affected_resources: Array.isArray(payload.affected_resources) ? payload.affected_resources as JsonValue : [],
        suggested_action: "Reply with whether this change worked, did not work, or needs adjustment; the response will be recorded as owner-observed outcome evidence.",
        evidence_event_ids: [row.id],
      } as JsonValue,
    });
    summary.emitted_count++;
    summary.emitted_event_ids.push(emitted.id);
  }

  return summary;
};
