// acc2 pending_decision_retire_worker — expire unresolved owner-consent
// decisions after the configured age threshold. The pending-decision surface is
// consent-only; this worker no longer classifies amendment structure.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { emitEvent } from "./events";

/** Default age threshold (7 days, in ms) past which an unresolved
 *  pending_owner_decision row is treated as stale. */
export const STALE_PENDING_DECISION_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Age threshold (1 hour, in ms) past which an unresolved owner_input_required
 *  probe row caused by a missing RUNTIME-INJECTED env var (e.g. ACC2_INPUTS) is
 *  treated as a stale operational probe blocker rather than a real owner
 *  decision. These rows fire during runtime invocation when an artifact
 *  references an env var the dispatcher injects at spawn time; they are not
 *  genuine owner-consent decisions and should not accrete in pending_decisions.
 *  Far shorter than the 7-day consent path because they are short-lived
 *  operational noise. */
export const STALE_MISSING_ENV_PROBE_AGE_MS = 60 * 60 * 1000;

/** Env vars the dispatcher injects into the spawn env at execution time and
 *  that are therefore NEVER legitimately "missing" from the owner's
 *  perspective. An owner_input_required(missing_env_credentials) row whose
 *  missing_env_vars are ALL members of this set is a false operational probe
 *  blocker, safe to auto-retire after STALE_MISSING_ENV_PROBE_AGE_MS. Mirrors
 *  the RUNTIME_INJECTED_ENV guard the runtimes apply at spawn time. */
export const RUNTIME_INJECTED_ENV = new Set<string>(["ACC2_INPUTS"]);

export type RetireReason = "stale" | "stale_missing_env_probe";

export type RetireSummary = {
  /** Pending rows the worker considered (the size of the source scan). */
  scanned: number;
  /** Rows actually retired in this tick. */
  retired: number;
  /** Per-reason breakdown of retires. */
  by_reason: Record<RetireReason, number>;
  /** owner_input_required probe rows the worker considered this tick (the size
   *  of the missing-env probe scan, distinct from the consent scan). */
  env_probe_scanned: number;
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
  /** Override missing-env probe age threshold. Default
   *  STALE_MISSING_ENV_PROBE_AGE_MS. */
  missingEnvProbeAgeMs?: number;
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

/** A row from the owner_input_required missing-env probe scan. */
type EnvProbeRow = {
  source_event_id: string;
  ts: string;
  missing_env_vars: string | null;
};

/** True when EVERY missing env var on a missing_env_credentials probe row is a
 *  RUNTIME-INJECTED var (so the gate is a false operational blocker, not a real
 *  owner credential request) AND the row is older than the probe age threshold.
 *  A row with any non-injected missing var is a genuine owner credential
 *  request and must NOT be auto-retired here. */
export const isStaleMissingEnvProbe = (
  row: EnvProbeRow,
  nowMs: number,
  probeAgeMs: number,
): boolean => {
  const rowMs = Date.parse(row.ts);
  if (!Number.isFinite(rowMs) || nowMs - rowMs < probeAgeMs) return false;
  let vars: unknown;
  try {
    vars = row.missing_env_vars == null ? null : JSON.parse(row.missing_env_vars);
  } catch {
    return false;
  }
  if (!Array.isArray(vars) || vars.length === 0) return false;
  return vars.every((v) => typeof v === "string" && RUNTIME_INJECTED_ENV.has(v));
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
  const missingEnvProbeAgeMs =
    options.missingEnvProbeAgeMs ?? STALE_MISSING_ENV_PROBE_AGE_MS;
  const maxRows = Math.max(1, options.maxRows ?? 500);
  const dryRun = options.dryRun ?? false;
  const summary: RetireSummary = {
    scanned: 0,
    retired: 0,
    by_reason: { stale: 0, stale_missing_env_probe: 0 },
    env_probe_scanned: 0,
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

  // ── Missing-env probe path (distinct from the 7-day consent path) ──────────
  // owner_input_required rows with reason=missing_env_credentials whose missing
  // vars are ALL runtime-injected (e.g. ACC2_INPUTS) are false operational
  // probe blockers, not real owner decisions. They inflate pending_decisions
  // and block owner state. Retire them after a much shorter 1h threshold via
  // the SAME pending_decision_retired event the consent path emits, keyed on
  // the owner_input_required event id (idempotent: rows already retired or
  // already resolved by an owner_input_received citation are skipped).
  let envRows: EnvProbeRow[];
  try {
    envRows = db
      .query<EnvProbeRow, [number]>(
        `SELECT e.id AS source_event_id, e.ts,
           json_extract(e.payload, '$.missing_env_vars') AS missing_env_vars
         FROM events e
         WHERE e.kind = 'owner_input_required'
           AND json_extract(e.payload, '$.reason') = 'missing_env_credentials'
           AND NOT EXISTS (
             SELECT 1 FROM events oir
             WHERE oir.kind = 'owner_input_received'
               AND (json_extract(oir.payload, '$.source_event_id') = e.id
                 OR json_extract(oir.payload, '$.request_event_id') = e.id
                 OR EXISTS (SELECT 1 FROM json_each(COALESCE(oir.context_refs, '[]')) WHERE value = e.id))
           )
           AND NOT EXISTS (
             SELECT 1 FROM events ret
             WHERE ret.kind = 'pending_decision_retired'
               AND json_extract(ret.payload, '$.amendment_event_id') = e.id
           )
         ORDER BY e.ts ASC
         LIMIT ?`,
      )
      .all(maxRows);
  } catch (err) {
    summary.errors.push(`env_probe_scan_failed:${(err as Error).message}`);
    return summary;
  }

  summary.env_probe_scanned = envRows.length;

  for (const row of envRows) {
    if (!isStaleMissingEnvProbe(row, nowMs, missingEnvProbeAgeMs)) {
      summary.skipped_not_eligible++;
      continue;
    }
    // The scan already excludes rows with an existing pending_decision_retired,
    // but re-check defensively to stay idempotent under concurrent ticks.
    if (hasExistingRetire(db, row.source_event_id)) {
      summary.skipped_already_retired++;
      continue;
    }
    summary.by_reason.stale_missing_env_probe++;
    summary.retired++;
    if (dryRun) continue;
    try {
      const payload: JsonValue = {
        amendment_event_id: row.source_event_id,
        reason: "stale_missing_env_probe",
        retired_at: now.toISOString(),
        target: null,
        amendment_ts: row.ts,
        missing_env_vars: row.missing_env_vars
          ? (JSON.parse(row.missing_env_vars) as JsonValue)
          : null,
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
      summary.by_reason.stale_missing_env_probe--;
    }
  }

  return summary;
};
