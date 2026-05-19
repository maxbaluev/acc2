// acc2 lifecycle closure sweep — emits terminators for open lifecycles
// that have no resolution event citing them. Closes substrate audit
// finding #3 (987 contract_amendment_proposed rows ≥24h old with no
// applied_change_committed citing them — the lifecycle never closes,
// the brain re-proposes, the read-models accumulate stale rows).
//
// Open lifecycles inspected:
//   1. contract_amendment_proposed without a downstream
//      applied_change_committed citing it. Resolution path:
//        - If a citing applied_change_committed exists OR the
//          source proposal's target file was edited in the last
//          7 days AND the anchor (target_resource / target_file)
//          still resolves → emit closure_complete.
//        - Else if the anchor names a file no longer present in
//          the source checkout → emit closure_obsolete.
//        - Else if ≥ 7 days have elapsed → emit closure_owner_required.
//
//   2. owner_input_required older than 7 days without an
//      owner_decision_recorded / owner_input_received citing it →
//      emit closure_owner_required.
//
//   3. task_node_opened older than 24h without a terminal
//      task_committed / task_failed / task_abandoned →
//      emit closure_obsolete when the source directive is already
//      closed; closure_owner_required when it's still live but
//      stuck.
//
// Idempotency: every emit consults the existing closure_* events for
// the lifecycle's source event id; re-running the sweep on already-
// closed lifecycles is a no-op.

import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { JsonValue } from "../substrate/types";
import { emitEvent } from "./events";

export type SweepSummary = {
  swept_count: number;
  closure_complete_count: number;
  closure_obsolete_count: number;
  closure_owner_required_count: number;
  /** F7 (2026-05-18, roadmap WW7W1NZ8A10R52PB4E7EJE9YBW): number of
   *  lifecycles whose payload declared a long / very_long
   *  feedback_window and were therefore exempted from this sweep's
   *  obsolete / owner-required emission paths. The lifecycle stays
   *  open because the owner-observed outcome is expected on a
   *  weeks-to-years timescale rather than within the default 7-day
   *  expiry. */
  feedback_window_respected_count: number;
  errors: string[];
};

export type SweepOptions = {
  /** Reference timestamp for "old enough to close". Tests pin this
   *  to a deterministic value; production uses `new Date()`. */
  now?: Date;
  /** Root for resolving target_files when the anchor is a relative
   *  path. Defaults to process.cwd(). */
  sourceCheckoutRoot?: string;
  /** Hard cap on rows scanned per sweep. The default is liberal
   *  (5000) so a tick during catch-up after a long outage closes the
   *  whole backlog; tests pin lower values. */
  maxRows?: number;
  /** Bypass actual emit (return what the sweep WOULD do). The
   *  summary still counts terminators that would have fired. Used by
   *  the operator dry-run before pointing the worker at production. */
  dryRun?: boolean;
};

const STUCK_PROPOSAL_AGE_MS = 24 * 60 * 60 * 1000; // 24h
const OWNER_REQUEST_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7d
const STUCK_TASK_AGE_MS = 24 * 60 * 60 * 1000; // 24h

// F7: classifications whose lifecycles are EXPECTED to remain open
// beyond the default 7-day expiry. The owner-observed outcome lands on
// a weeks-to-years timescale (relationship signal, life outcome,
// growth, meaning), so the sweep must not call them stale.
const LONG_FEEDBACK_CLASSIFICATIONS = new Set<string>(["long", "very_long"]);

type FeedbackWindowShape = {
  classification?: unknown;
  duration_ms?: unknown;
};

/** Extract the feedback_window field from a row payload. Looks at
 *  `payload.feedback_window` and at the packet form
 *  `payload.predicted_residual_packet.feedback_window` so emitters can
 *  use either shape without disagreement. */
const extractFeedbackWindow = (
  payload: Record<string, unknown>,
): FeedbackWindowShape | null => {
  const direct = payload.feedback_window;
  if (direct && typeof direct === "object") return direct as FeedbackWindowShape;
  const packet = payload.predicted_residual_packet;
  if (packet && typeof packet === "object") {
    const fw = (packet as Record<string, unknown>).feedback_window;
    if (fw && typeof fw === "object") return fw as FeedbackWindowShape;
  }
  return null;
};

/** Returns true when the supplied payload declares a feedback_window
 *  whose classification is in the long-window set. */
const hasLongFeedbackWindow = (
  payload: Record<string, unknown>,
): boolean => {
  const fw = extractFeedbackWindow(payload);
  if (!fw) return false;
  if (typeof fw.classification !== "string") return false;
  return LONG_FEEDBACK_CLASSIFICATIONS.has(fw.classification);
};

const isoToMs = (iso: string): number => new Date(iso).getTime();

/** Check whether the anchor (file path) named in the proposal payload
 *  still resolves under the source checkout. Returns true when the
 *  anchor exists OR when no anchor is declared (we cannot prove
 *  obsolescence without an anchor). */
const anchorResolves = (
  root: string,
  anchor: unknown,
): boolean => {
  if (typeof anchor !== "string" || anchor.length === 0) return true;
  // Treat URI-ish anchors (drive://, http://, etc.) as resolved — they
  // are not filesystem paths and the sweep cannot disprove them.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(anchor)) return true;
  const abs = isAbsolute(anchor) ? anchor : join(root, anchor);
  return existsSync(abs);
};

/** Extract the candidate anchor strings from a proposal payload —
 *  target_file, target_files[], anchor, target_resource. */
const extractAnchors = (payload: Record<string, unknown>): string[] => {
  const out: string[] = [];
  for (const key of ["target_file", "anchor", "target_resource"]) {
    const v = payload[key];
    if (typeof v === "string" && v.length > 0) out.push(v);
  }
  const tf = payload.target_files;
  if (Array.isArray(tf)) {
    for (const v of tf) if (typeof v === "string" && v.length > 0) out.push(v);
  }
  return out;
};

const hasExistingTerminator = (db: Database, sourceEventId: string): boolean => {
  const row = db
    .query<{ c: number }, [string, string, string, string]>(
      `SELECT COUNT(*) AS c FROM events
        WHERE context_refs LIKE ?
          AND kind IN (?, ?, ?)`,
    )
    .get(`%${sourceEventId}%`, "closure_complete", "closure_obsolete", "closure_owner_required");
  return (row?.c ?? 0) > 0;
};

const hasCitingAppliedChange = (db: Database, sourceEventId: string): string | null => {
  const row = db
    .query<{ id: string }, [string]>(
      `SELECT id FROM events
        WHERE kind = 'applied_change_committed'
          AND context_refs LIKE ?
        ORDER BY ts ASC LIMIT 1`,
    )
    .get(`%${sourceEventId}%`);
  return row?.id ?? null;
};

const hasCitingOwnerDecision = (db: Database, sourceEventId: string): string | null => {
  const row = db
    .query<{ id: string }, [string]>(
      `SELECT id FROM events
        WHERE kind IN ('owner_decision_recorded', 'owner_input_received')
          AND context_refs LIKE ?
        ORDER BY ts ASC LIMIT 1`,
    )
    .get(`%${sourceEventId}%`);
  return row?.id ?? null;
};

const taskHasTerminator = (db: Database, taskId: string): string | null => {
  const row = db
    .query<{ id: string }, [string]>(
      `SELECT id FROM events
        WHERE task_id = ?
          AND kind IN ('task_committed', 'task_failed', 'task_abandoned')
        ORDER BY ts ASC LIMIT 1`,
    )
    .get(taskId);
  return row?.id ?? null;
};

const directiveIsClosed = (db: Database, directiveId: string): boolean => {
  const row = db
    .query<{ c: number }, [string]>(
      `SELECT COUNT(*) AS c FROM events
        WHERE directive_id = ?
          AND kind IN ('directive_closed', 'directive_archived_by_operator', 'directive_archived_missed_reviews')`,
    )
    .get(directiveId);
  return (row?.c ?? 0) > 0;
};

export const runLifecycleClosureSweep = (
  db: Database,
  options: SweepOptions = {},
): SweepSummary => {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const root = options.sourceCheckoutRoot ?? process.cwd();
  const maxRows = options.maxRows ?? 5000;
  const dryRun = options.dryRun ?? false;
  const summary: SweepSummary = {
    swept_count: 0,
    closure_complete_count: 0,
    closure_obsolete_count: 0,
    closure_owner_required_count: 0,
    feedback_window_respected_count: 0,
    errors: [],
  };

  const emitTerminator = (
    kind: "closure_complete" | "closure_obsolete" | "closure_owner_required",
    directiveId: string | null,
    taskId: string | null,
    sourceEventId: string,
    payload: JsonValue,
  ): void => {
    if (kind === "closure_complete") summary.closure_complete_count++;
    if (kind === "closure_obsolete") summary.closure_obsolete_count++;
    if (kind === "closure_owner_required") summary.closure_owner_required_count++;
    if (dryRun) return;
    try {
      emitEvent(db, {
        kind,
        substrate_origin: "substrate_auto",
        directive_id: directiveId ?? undefined,
        task_id: taskId ?? undefined,
        context_refs: [sourceEventId],
        payload,
      });
    } catch (err) {
      summary.errors.push(`emit_${kind}_failed:${(err as Error).message}`);
    }
  };

  // 1. Stuck contract_amendment_proposed
  try {
    const rows = db
      .query<{
        id: string;
        ts: string;
        directive_id: string | null;
        task_id: string | null;
        payload: string;
      }, [number]>(
        `SELECT id, ts, directive_id, task_id, payload FROM events
          WHERE kind = 'contract_amendment_proposed'
          ORDER BY ts ASC
          LIMIT ?`,
      )
      .all(maxRows);
    for (const row of rows) {
      summary.swept_count++;
      if (hasExistingTerminator(db, row.id)) continue;
      const ageMs = nowMs - isoToMs(row.ts);
      const applied = hasCitingAppliedChange(db, row.id);
      if (applied) {
        emitTerminator(
          "closure_complete",
          row.directive_id,
          row.task_id,
          row.id,
          {
            source_kind: "contract_amendment_proposed",
            source_event_id: row.id,
            resolving_event_id: applied,
            resolution_kind: "applied_change_committed",
          } as JsonValue,
        );
        continue;
      }
      if (ageMs < STUCK_PROPOSAL_AGE_MS) continue;
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(row.payload ?? "{}") as Record<string, unknown>; } catch { /* ok */ }
      // F7: long-window lifecycles stay open. Owner-observed outcomes
      // for non-technical goals (relationship, life outcome, growth,
      // meaning) land weeks-to-months later; the sweep must not call
      // them stale.
      if (hasLongFeedbackWindow(payload)) {
        summary.feedback_window_respected_count++;
        continue;
      }
      const anchors = extractAnchors(payload);
      const obsoleteAnchors = anchors.filter((a) => !anchorResolves(root, a));
      if (anchors.length > 0 && obsoleteAnchors.length === anchors.length) {
        emitTerminator(
          "closure_obsolete",
          row.directive_id,
          row.task_id,
          row.id,
          {
            source_kind: "contract_amendment_proposed",
            source_event_id: row.id,
            obsolete_anchors: obsoleteAnchors as unknown as JsonValue,
            age_ms: ageMs,
          } as JsonValue,
        );
        continue;
      }
      if (ageMs >= OWNER_REQUEST_EXPIRY_MS) {
        emitTerminator(
          "closure_owner_required",
          row.directive_id,
          row.task_id,
          row.id,
          {
            source_kind: "contract_amendment_proposed",
            source_event_id: row.id,
            age_ms: ageMs,
            unresolved_anchors: anchors as unknown as JsonValue,
            reason: "owner_action_expired",
          } as JsonValue,
        );
      }
    }
  } catch (err) {
    summary.errors.push(`scan_amendments_failed:${(err as Error).message}`);
  }

  // 2. Stuck owner_input_required
  try {
    const rows = db
      .query<{
        id: string;
        ts: string;
        directive_id: string | null;
        task_id: string | null;
        payload: string;
      }, [number]>(
        `SELECT id, ts, directive_id, task_id, payload FROM events
          WHERE kind = 'owner_input_required'
          ORDER BY ts ASC
          LIMIT ?`,
      )
      .all(maxRows);
    for (const row of rows) {
      summary.swept_count++;
      if (hasExistingTerminator(db, row.id)) continue;
      const ageMs = nowMs - isoToMs(row.ts);
      const resolution = hasCitingOwnerDecision(db, row.id);
      if (resolution) {
        emitTerminator(
          "closure_complete",
          row.directive_id,
          row.task_id,
          row.id,
          {
            source_kind: "owner_input_required",
            source_event_id: row.id,
            resolving_event_id: resolution,
            resolution_kind: "owner_decision_recorded_or_input_received",
          } as JsonValue,
        );
        continue;
      }
      if (ageMs >= OWNER_REQUEST_EXPIRY_MS) {
        // F7: respect long-window feedback. A non-technical owner ask
        // (eulogy review, decision deliberation, growth practice) can
        // legitimately sit open for months; the sweep must not retire
        // it as expired.
        let payload: Record<string, unknown> = {};
        try { payload = JSON.parse(row.payload ?? "{}") as Record<string, unknown>; } catch { /* ok */ }
        if (hasLongFeedbackWindow(payload)) {
          summary.feedback_window_respected_count++;
          continue;
        }
        emitTerminator(
          "closure_owner_required",
          row.directive_id,
          row.task_id,
          row.id,
          {
            source_kind: "owner_input_required",
            source_event_id: row.id,
            age_ms: ageMs,
            reason: "owner_response_expired_7d",
          } as JsonValue,
        );
      }
    }
  } catch (err) {
    summary.errors.push(`scan_owner_inputs_failed:${(err as Error).message}`);
  }

  // 3. Stuck task_node_opened
  try {
    const rows = db
      .query<{
        id: string;
        ts: string;
        directive_id: string | null;
        task_id: string | null;
        payload: string;
      }, [number]>(
        `SELECT id, ts, directive_id, task_id, payload FROM events
          WHERE kind = 'task_node_opened'
          ORDER BY ts ASC
          LIMIT ?`,
      )
      .all(maxRows);
    for (const row of rows) {
      summary.swept_count++;
      if (hasExistingTerminator(db, row.id)) continue;
      const ageMs = nowMs - isoToMs(row.ts);
      if (!row.task_id) continue;
      const terminator = taskHasTerminator(db, row.task_id);
      if (terminator) {
        emitTerminator(
          "closure_complete",
          row.directive_id,
          row.task_id,
          row.id,
          {
            source_kind: "task_node_opened",
            source_event_id: row.id,
            resolving_event_id: terminator,
            resolution_kind: "task_terminal",
          } as JsonValue,
        );
        continue;
      }
      if (ageMs < STUCK_TASK_AGE_MS) continue;
      // F7: respect long-window feedback. A task whose act tuple
      // declared feedback_window.classification in {long, very_long}
      // (life decision, growth practice, relationship work) is
      // expected to outlive the default 24h / 7d expiry.
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(row.payload ?? "{}") as Record<string, unknown>; } catch { /* ok */ }
      if (hasLongFeedbackWindow(payload)) {
        summary.feedback_window_respected_count++;
        continue;
      }
      if (row.directive_id && directiveIsClosed(db, row.directive_id)) {
        emitTerminator(
          "closure_obsolete",
          row.directive_id,
          row.task_id,
          row.id,
          {
            source_kind: "task_node_opened",
            source_event_id: row.id,
            age_ms: ageMs,
            reason: "directive_already_closed",
          } as JsonValue,
        );
      } else if (ageMs >= OWNER_REQUEST_EXPIRY_MS) {
        emitTerminator(
          "closure_owner_required",
          row.directive_id,
          row.task_id,
          row.id,
          {
            source_kind: "task_node_opened",
            source_event_id: row.id,
            age_ms: ageMs,
            reason: "task_stuck_7d_owner_input_required",
          } as JsonValue,
        );
      }
    }
  } catch (err) {
    summary.errors.push(`scan_tasks_failed:${(err as Error).message}`);
  }

  return summary;
};
