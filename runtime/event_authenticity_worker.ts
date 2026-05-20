// acc2 Tier -1 floor — event authenticity worker.
//
// Per docs/roadmap.md Tier -1: floors are absence-of-violation evidence
// plus immediate quarantine on violation. This worker periodically
// samples recent events and verifies the row was written via the
// canonical `emitEvent` path — heuristic check on `substrate_origin`
// (closed set of known origins) and required fields (`ts`, `kind`,
// `id`). The substrate already enforces this at the write boundary;
// the worker is the periodic absence-of-violation evidence emitter
// that keeps the floor visible to the brain.
//
// Emit cadence: 60s. Idempotent (at most one emit per minute).
// Predicate row: event_authenticity_predicate (substrate/seed.ts).
//
// On clean pass: emit `event_authenticity_check` with residual=0.
// On any tampered row (unrecognized substrate_origin or missing
// required field): emit `integrity_check_failed` with the offending
// row id and the violation kind.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { emitEvent } from "./events";
import { logger } from "./logger";

export const EVENT_AUTHENTICITY_TICK_MS = 60 * 1000;
const SAMPLE_WINDOW_SECONDS = 3600;
const DEFAULT_SAMPLE_SIZE = 100;
const MIN_GAP_MS = 60 * 1000;

// Canonical substrate_origin set used by emitEvent. Any value outside
// this set is treated as a tamper signal (the column is open-string
// for forward compatibility but production writers stamp one of
// these). Expand here when a new authenticated emitter ships.
const KNOWN_SUBSTRATE_ORIGINS: ReadonlySet<string> = new Set([
  "substrate",
  "substrate_auto",
  "runtime",
  "claude",
  "claude_inline",
  "claude_root",
  "claude_orchestrator",
  "brain",
  "opencode",
  "opencode_brain",
  "father",
  "owner",
  "recipe",
]);

type EventRow = {
  id: string | null;
  ts: string | null;
  kind: string | null;
  substrate_origin: string | null;
};

export type EventAuthenticityOptions = {
  sampleSize?: number;
  windowSeconds?: number;
  now?: Date;
  minGapMs?: number;
};

export type EventAuthenticitySummary = {
  sampled: number;
  passed: number;
  failed: number;
  emitted_kind: "event_authenticity_check" | "integrity_check_failed" | "skipped";
  emitted_event_id?: string;
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

/** One worker tick. Samples up to `sampleSize` of the last hour's
 *  events; verifies each row has known substrate_origin + required
 *  fields. Emits event_authenticity_check on full pass,
 *  integrity_check_failed on any tampered row. Fail-soft: SQL
 *  errors are logged but do not crash the daemon. */
export const eventAuthenticityWorkerTick = (
  db: Database,
  opts: EventAuthenticityOptions = {},
): EventAuthenticitySummary => {
  const now = opts.now ?? new Date();
  const sampleSize = Math.max(1, opts.sampleSize ?? DEFAULT_SAMPLE_SIZE);
  const windowSeconds = Math.max(60, opts.windowSeconds ?? SAMPLE_WINDOW_SECONDS);
  const minGapMs = Math.max(0, opts.minGapMs ?? MIN_GAP_MS);

  // Idempotency — at most one emit per minute. Compare against the
  // worker's own primary emit kind; floor-wide integrity_check_failed
  // rows are shared across all Tier -1 workers, so gating on them
  // would couple cadences.
  const cleanGap = now.getTime() - lastEmitTsMs(db, "event_authenticity_check");
  if (cleanGap < minGapMs) {
    return { sampled: 0, passed: 0, failed: 0, emitted_kind: "skipped" };
  }

  const sinceIso = new Date(now.getTime() - windowSeconds * 1000).toISOString();
  let rows: EventRow[] = [];
  try {
    rows = db
      .query<EventRow, [string, number]>(
        `SELECT id, ts, kind, substrate_origin
           FROM events
          WHERE ts >= ?
          ORDER BY ts DESC
          LIMIT ?`,
      )
      .all(sinceIso, sampleSize);
  } catch (err) {
    logger.warn(
      { where: "event_authenticity.sample", err: (err as Error).message },
      "event_authenticity sample query failed",
    );
    return { sampled: 0, passed: 0, failed: 0, emitted_kind: "skipped" };
  }

  const violations: Array<{ id: string | null; reason: string; substrate_origin: string | null; kind: string | null }> = [];
  let passed = 0;
  for (const row of rows) {
    if (!row.id || !row.ts || !row.kind) {
      violations.push({ id: row.id, reason: "missing_required_field", substrate_origin: row.substrate_origin, kind: row.kind });
      continue;
    }
    if (!row.substrate_origin || !KNOWN_SUBSTRATE_ORIGINS.has(row.substrate_origin)) {
      violations.push({ id: row.id, reason: "unrecognized_substrate_origin", substrate_origin: row.substrate_origin, kind: row.kind });
      continue;
    }
    passed++;
  }

  const sampled = rows.length;
  const failed = violations.length;

  try {
    if (failed === 0) {
      const emitted = emitEvent(db, {
        kind: "event_authenticity_check",
        substrate_origin: "substrate_auto",
        payload: {
          sampled,
          passed,
          residual: sampled === 0 ? 0 : (passed === sampled ? 0 : 1),
          window_seconds: windowSeconds,
          predicate: "event_authenticity_predicate",
        } as JsonValue,
      });
      return { sampled, passed, failed, emitted_kind: "event_authenticity_check", emitted_event_id: emitted.id };
    }
    const emitted = emitEvent(db, {
      kind: "integrity_check_failed",
      substrate_origin: "substrate_auto",
      payload: {
        floor: "event_authenticity",
        predicate: "event_authenticity_predicate",
        sampled,
        passed,
        failed,
        violations: violations.slice(0, 25),
        marker: "event_authenticity_violation_v1",
      } as JsonValue,
    });
    logger.error(
      { sampled, passed, failed, violations: violations.slice(0, 5) },
      "event authenticity floor violated — sample contained tampered rows",
    );
    return { sampled, passed, failed, emitted_kind: "integrity_check_failed", emitted_event_id: emitted.id };
  } catch (err) {
    logger.warn(
      { where: "event_authenticity.emit", err: (err as Error).message },
      "event_authenticity emit failed — report not lost",
    );
    return { sampled, passed, failed, emitted_kind: "skipped" };
  }
};
