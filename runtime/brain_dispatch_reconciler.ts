// Boot-time reconciliation of in-flight brain dispatches that survived
// (or did NOT survive) a daemon restart. The substrate guarantee: every
// `brain_dispatched` row eventually has a matching `brain_dispatch_closed`
// row keyed by the same `dispatch_id`. When the daemon is killed
// mid-dispatch, this guarantee is broken until the next boot, when this
// module emits a synthetic `brain_dispatch_closed` with
// `closure_reason=restart_reconciled` for every orphan.
//
// Cites:
//   - HNS3F5D0F15E0 (brain_dispatch_closed provenance is the canonical
//     minimal restart-loss fix, not a synthetic terminal-fail row).
//   - XA3ABKERHD4H  (session-token-stable reload — quiescence layer
//     refuses code reload while open dispatches lack matching closes).
//
// This module is DELIBERATELY narrow. It owns:
//   1. `getOpenBrainDispatches(db)` — read-side view of live dispatches.
//   2. `reconcileBrainDispatchesAtBoot(db, sessionToken)` — at daemon
//      startup, before `daemon_started` is emitted, close every orphan
//      with the boot-time session token recorded on the close row.
//
// The mid-session age-aware reconciler stays in `integrity_worker.ts`
// (it has different staleness semantics). The two paths share the SQL
// shape via the helper below.

import type { Database } from "bun:sqlite";
import { emitEvent } from "./events";

// ── Boot session token (process-local) ─────────────────────────────────
// Stable identifier minted once per daemon boot. Stamped on every
// `brain_dispatched` row spawned by this daemon AND on the synthetic
// `brain_dispatch_closed` rows the boot reconciler emits, so a later
// audit can correlate every dispatch to the daemon process that owned
// it. The token is just a free string — production daemon sets it to
// the boot ISO timestamp + pid; tests may set whatever value they want.
let BOOT_SESSION_TOKEN: string | null = null;

/** Set the boot session token. Called exactly once by the daemon at
 *  startup. The value is then readable by the opencode bridge spawn
 *  site (via `getBootSessionToken`) for inclusion in the
 *  `brain_dispatched` payload. */
export const setBootSessionToken = (token: string): void => { BOOT_SESSION_TOKEN = token; };

/** Read the boot session token. Returns null when the daemon never set
 *  one (e.g. a test that imported the bridge directly without booting a
 *  daemon). Callers must tolerate null — the field is observability
 *  metadata, not a gating signal. */
export const getBootSessionToken = (): string | null => BOOT_SESSION_TOKEN;

/** Test-only reset. Lets the daemon test fixture re-mint the token
 *  cleanly between cases without leaking module state. */
export const _resetBootSessionTokenForTests = (): void => { BOOT_SESSION_TOKEN = null; };

export type OpenBrainDispatch = {
  dispatch_event_id: string;
  dispatch_id: string | null;
  directive_id: string | null;
  task_id: string | null;
  started_at_ms: number | null;
  subprocess_pid: number | null;
  session_token: string | null;
  opened_at_iso: string;
};

const parsePayload = (raw: string | null | undefined): Record<string, unknown> => {
  if (!raw || typeof raw !== "string") return {};
  try { return JSON.parse(raw) as Record<string, unknown>; }
  catch { return {}; }
};

const asString = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const asNumber = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Live brain dispatches: every `brain_dispatched` row whose
 *  `payload.dispatch_id` has no matching `brain_dispatch_closed`. Used
 *  by the boot reconciler AND by the restart quiescence loop during
 *  shutdown. The join is by `dispatch_id` so concurrent dispatches with
 *  the same task can both be tracked.
 *
 *  Returns the rows in open order (oldest first) so a caller iterating
 *  the list always processes the longest-running dispatch first. */
export const getOpenBrainDispatches = (db: Database): OpenBrainDispatch[] => {
  const openRows = db
    .query(
      `SELECT e.id AS dispatch_event_id, e.directive_id, e.task_id, e.ts, e.payload
       FROM events e
       WHERE e.kind = 'brain_dispatched'
       ORDER BY e.ts ASC`,
    )
    .all() as Array<{ dispatch_event_id: string; directive_id: string | null; task_id: string | null; ts: string; payload: string }>;

  const closedIds = new Set<string>();
  const closedRows = db
    .query(`SELECT payload FROM events WHERE kind = 'brain_dispatch_closed'`)
    .all() as Array<{ payload: string }>;
  for (const r of closedRows) {
    const payload = parsePayload(r.payload);
    const id = asString(payload.dispatch_id);
    if (id) closedIds.add(id);
  }

  const out: OpenBrainDispatch[] = [];
  for (const r of openRows) {
    const payload = parsePayload(r.payload);
    const dispatchId = asString(payload.dispatch_id);
    if (dispatchId && closedIds.has(dispatchId)) continue;
    out.push({
      dispatch_event_id: r.dispatch_event_id,
      dispatch_id: dispatchId,
      directive_id: r.directive_id,
      task_id: r.task_id,
      started_at_ms: asNumber(payload.started_at_ms),
      subprocess_pid: asNumber(payload.subprocess_pid),
      session_token: asString(payload.session_token),
      opened_at_iso: r.ts,
    });
  }
  return out;
};

export const DEFAULT_BRAIN_DISPATCH_MAX_AGE_MS = 25 * 60 * 1000;

export type BrainDispatchOrphanCloseReason =
  | "orphaned_dead_generation"
  | "orphaned_dead_pid"
  | "orphaned_max_age"
  | "orphaned_boot_reconcile";

export type ClosedBrainDispatch = {
  dispatch_event_id: string;
  dispatch_id: string;
  task_id: string | null;
  directive_id: string | null;
  closure_reason: BrainDispatchOrphanCloseReason | "restart_reconciled";
  age_ms: number;
};

const pidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

const dispatchAgeMs = (row: OpenBrainDispatch, nowMs: number): number => {
  if (row.started_at_ms !== null) return Math.max(0, nowMs - row.started_at_ms);
  const openedAt = Date.parse(row.opened_at_iso);
  return Number.isFinite(openedAt) ? Math.max(0, nowMs - openedAt) : 0;
};

const classifyOpenDispatch = (
  row: OpenBrainDispatch,
  opts: { currentSessionToken?: string | null; maxAgeMs: number; nowMs: number; closeAllOpen?: boolean },
): { reason: BrainDispatchOrphanCloseReason; ageMs: number } | null => {
  const ageMs = dispatchAgeMs(row, opts.nowMs);
  if (opts.closeAllOpen) return { reason: "orphaned_boot_reconcile", ageMs };
  if (row.session_token && opts.currentSessionToken && row.session_token !== opts.currentSessionToken) {
    return { reason: "orphaned_dead_generation", ageMs };
  }
  if (row.subprocess_pid !== null && !pidAlive(row.subprocess_pid)) {
    return { reason: "orphaned_dead_pid", ageMs };
  }
  if (ageMs >= opts.maxAgeMs) return { reason: "orphaned_max_age", ageMs };
  return null;
};

export const closeOrphanedBrainDispatches = (
  db: Database,
  opts: {
    currentSessionToken?: string | null;
    maxAgeMs?: number;
    nowMs?: number;
    closeAllOpen?: boolean;
    closureReasonOverride?: "restart_reconciled";
  } = {},
): ClosedBrainDispatch[] => {
  const nowMs = opts.nowMs ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_BRAIN_DISPATCH_MAX_AGE_MS;
  const closed: ClosedBrainDispatch[] = [];
  for (const row of getOpenBrainDispatches(db)) {
    if (!row.dispatch_id) continue;
    const classification = classifyOpenDispatch(row, {
      currentSessionToken: opts.currentSessionToken ?? null,
      maxAgeMs,
      nowMs,
      closeAllOpen: opts.closeAllOpen,
    });
    if (!classification) continue;
    const closureReason = opts.closureReasonOverride ?? classification.reason;
    emitEvent(db, {
      kind: "brain_dispatch_closed",
      substrate_origin: "substrate_auto",
      directive_id: row.directive_id ?? undefined,
      task_id: row.task_id ?? undefined,
      payload: {
        dispatch_id: row.dispatch_id,
        closure_reason: closureReason,
        orphan_reason: classification.reason,
        closed_at_ms: nowMs,
        current_session_token: opts.currentSessionToken ?? null,
        original_dispatch_event_id: row.dispatch_event_id,
        original_started_at_ms: row.started_at_ms,
        original_subprocess_pid: row.subprocess_pid,
        original_session_token: row.session_token,
        stale_age_ms: classification.ageMs,
        max_age_ms: maxAgeMs,
      },
    });
    closed.push({
      dispatch_event_id: row.dispatch_event_id,
      dispatch_id: row.dispatch_id,
      task_id: row.task_id,
      directive_id: row.directive_id,
      closure_reason: closureReason,
      age_ms: classification.ageMs,
    });
  }
  return closed;
};

export type ReconcileSummary = {
  reconciled_count: number;
  reconciled_dispatch_ids: string[];
  ts_window_iso: { earliest: string | null; latest: string | null };
  boot_session_token: string;
};

/** Close every orphaned `brain_dispatched` row with a synthetic
 *  `brain_dispatch_closed { closure_reason: "restart_reconciled" }`.
 *  Idempotent: a second call after the first emits no new closes (the
 *  dispatches are no longer "open" once their closes land).
 *
 *  Called at daemon boot BEFORE `daemon_started` emits so the ledger is
 *  honest about the prior-restart state before any new dispatch fires. */
export const reconcileBrainDispatchesAtBoot = (
  db: Database,
  bootSessionToken: string,
): ReconcileSummary => {
  const open = getOpenBrainDispatches(db);
  let earliest: string | null = null;
  let latest: string | null = null;
  for (const row of open) {
    if (!row.dispatch_id) continue;
    if (earliest === null || row.opened_at_iso < earliest) earliest = row.opened_at_iso;
    if (latest === null || row.opened_at_iso > latest) latest = row.opened_at_iso;
  }
  const closed = closeOrphanedBrainDispatches(db, {
    currentSessionToken: bootSessionToken,
    closeAllOpen: true,
    closureReasonOverride: "restart_reconciled",
  });
  const reconciledIds = closed.map((row) => row.dispatch_id);
  return {
    reconciled_count: reconciledIds.length,
    reconciled_dispatch_ids: reconciledIds,
    ts_window_iso: { earliest, latest },
    boot_session_token: bootSessionToken,
  };
};
