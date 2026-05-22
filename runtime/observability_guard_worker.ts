// acc2 phase-2 (SJPF3VB9) — standing observability-fidelity guard worker.
//
// Institutionalizes two bug classes found this session as PERMANENT
// self-audits so they can never silently return:
//
//   1. WIRED-BUT-INERT LOOPS. A loop whose producer is wired but emits
//      0 over the trailing window while its upstream trigger fired
//      (e.g. counterfactual_closure_audited=0 while
//      counterfactual_alternative_recorded>0; coalition_credit_distributed=0
//      while action_scored crossed threshold). The wiring exists but the
//      loop is inert — invisible without an explicit absence audit.
//      → emits loop_inert_alert.
//
//   2. LYING METRICS. A status metric that diverges from ground truth
//      (e.g. the reported retrieval-index count vs. the count of
//      genuinely-embeddable events). → emits metric_veracity_alert.
//
//   3. ERROR FLOODS (loud problems). The same error_caught (where,message)
//      repeating hundreds of times over a short window — the LOUD failure
//      class the silent-loop/lying-metric checks could not catch. This
//      session, error_caught flooded 2245x/15min with the SAME message
//      (sql_worker_query_failed:no such module: vec0) and only the human
//      owner caught it via `acc watch`. A diversity of occasional
//      recoverable errors is normal; the SAME error repeating past a
//      threshold inside a short flood window is the signal.
//      → emits error_flood_alert naming the exact culprit.
//
// The worker is defensive per-check (try/catch around every check; a
// query error emits a guard_check_error breadcrumb but never crashes
// the tick) and idempotent (skips emitting a loop_inert_alert when one
// already exists for that loop_kind inside the same trailing window, so
// the hourly cadence does not spam the ledger).

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { emitEvent } from "./events";

const DEFAULT_WINDOW_HOURS = 24;

// Error-flood watch. Rationale: a flood is about RATE, not lifetime total —
// 50 of the SAME error in 24h is benign noise, but 50 in a single hour is a
// tight repeating loop screaming. So the flood window is INDEPENDENT of the
// main tick window: ERROR_FLOOD_WINDOW_HOURS=1 isolates rate, and
// ERROR_FLOOD_THRESHOLD=50 sits well above normal recoverable noise (a
// diverse handful of occasional errors) yet well below a real flood (the
// vec0 incident was 2245x/15min). Grouping by (where,message) means a
// healthy diversity of distinct occasional errors never trips it — only the
// SAME error repeating past threshold inside the flood window does.
const ERROR_FLOOD_THRESHOLD = 50;
const ERROR_FLOOD_WINDOW_HOURS = 1;

/** A wired loop and the upstream trigger that should keep it non-inert.
 *  upstream_kind is the simple-count case; upstream_query overrides it
 *  with a precise SQL count (param: sinceIso) when "the upstream fired"
 *  needs a filter — otherwise the guard false-positives (e.g. coalition
 *  cannot fire on lifted/worker action_scored that carry no real
 *  action_artifact_id, so counting ALL action_scored is a lying check). */
type InertLoopCheck = {
  loop_kind: string;
  upstream_kind: string;
  min_upstream: number;
  upstream_query?: string;
};

/** The real cases this session found — seed set. When upstream fired
 *  >= min_upstream times in the window but the loop emitted 0, the loop
 *  is wired-but-inert. */
const INERT_LOOP_CHECKS: readonly InertLoopCheck[] = [
  {
    loop_kind: "counterfactual_closure_audited",
    upstream_kind: "counterfactual_alternative_recorded",
    min_upstream: 50,
  },
  {
    // Coalition fires only on REPEATED joint-citation sets, which require
    // action_scored events that carry a real (non-null) action_artifact_id
    // — NOT the lifted/worker action_scored (action_artifact_id IS NULL)
    // that dominate the stream (~778/779 in 24h). Counting all action_scored
    // false-positived coalition as inert; the honest upstream is real-artifact
    // action_scored only, so coalition is correctly quiet when none repeat.
    loop_kind: "coalition_credit_distributed",
    upstream_kind: "action_scored",
    upstream_query:
      "SELECT COUNT(*) AS c FROM events WHERE kind = 'action_scored' AND json_extract(payload, '$.action_artifact_id') IS NOT NULL AND ts >= ?",
    min_upstream: 200,
  },
  {
    loop_kind: "meta_credit_projected",
    upstream_kind: "prompt_policy_section_selected",
    min_upstream: 50,
  },
  {
    // Causal-edge credit (Tier-S2): the extractor admits causal_edge_predicate
    // rows, but credit fires only when a co-citing act (>=2 cited_knowledge_ids)
    // carries an own residual. This loop was DOUBLE-inert (window mismatch +
    // unregistered event kind) and credited 0 despite 300+ triggers; once
    // fixed it credits in bulk. Upstream = co-citation acts carrying a residual
    // signal (predicted_residual), which is the real trigger for edge credit.
    loop_kind: "causal_edge_credited",
    upstream_kind: "act_tuple_recorded",
    upstream_query:
      "SELECT COUNT(*) AS c FROM events WHERE kind = 'act_tuple_recorded' AND json_array_length(json_extract(payload, '$.cited_knowledge_ids')) >= 2 AND json_extract(payload, '$.predicted_residual') IS NOT NULL AND ts >= ?",
    min_upstream: 50,
  },
];

/** A status metric, its reported source, and the ground-truth it must
 *  agree with within `tolerance`. Both queries return a single integer
 *  count. */
type MetricVeracityCheck = {
  metric_name: string;
  reported_query: string;
  ground_truth_query: string;
  tolerance: number;
};

const METRIC_VERACITY_CHECKS: readonly MetricVeracityCheck[] = [
  {
    // Retrieval-index integrity: EVERY vec_events row must resolve to a
    // live source — either an event row OR an act_artifact row (vec_events
    // indexes BOTH; an earlier version compared vec_events to events-only
    // embeddings and false-positived on the ~26 legitimate act_artifact
    // embeddings — a lying metric in the guard itself). The honest signal
    // is TRUE ORPHANS: vec_events rows resolving to neither. That count
    // MUST be 0 (the orphan-GC + archival cascade keep it 0). reported =
    // orphan count, ground_truth = 0, tolerance 0 → alerts iff any vec_events
    // row points at a vanished source.
    metric_name: "retrieval_index_orphans",
    reported_query:
      "SELECT COUNT(*) AS c FROM vec_events v WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.id = v.event_id) AND NOT EXISTS (SELECT 1 FROM act_artifact a WHERE a.id = v.event_id)",
    ground_truth_query: "SELECT 0 AS c",
    tolerance: 0,
  },
];

export type ObservabilityGuardOptions = {
  now?: Date;
  windowHours?: number;
};

export type ObservabilityGuardSummary = {
  inert_checks: number;
  inert_alerts_emitted: number;
  inert_skipped_idempotent: number;
  inert_skipped_healthy: number;
  metric_checks: number;
  metric_alerts_emitted: number;
  metric_skipped_within_tolerance: number;
  error_flood_checks: number;
  error_flood_alerts_emitted: number;
  error_flood_skipped_idempotent: number;
  check_errors: number;
  alert_event_ids: string[];
};

type EmitFn = typeof emitEvent;

const countSince = (db: Database, kind: string, sinceIso: string): number => {
  const row = db
    .query<{ c: number }, [string, string]>(
      "SELECT COUNT(*) AS c FROM events WHERE kind = ? AND ts >= ?",
    )
    .get(kind, sinceIso);
  return row?.c ?? 0;
};

const scalarCount = (db: Database, query: string): number => {
  const row = db.query<{ c: number }, []>(query).get();
  return row?.c ?? 0;
};

const inertAlertExistsInWindow = (
  db: Database,
  loopKind: string,
  sinceIso: string,
): boolean => {
  const row = db
    .query<{ x: number }, [string, string]>(
      `SELECT 1 AS x FROM events
        WHERE kind = 'loop_inert_alert'
          AND json_extract(payload, '$.loop_kind') = ?
          AND ts >= ?
        LIMIT 1`,
    )
    .get(loopKind, sinceIso);
  return row !== null;
};

const errorFloodAlertExistsInWindow = (
  db: Database,
  where: string,
  message: string,
  sinceIso: string,
): boolean => {
  const row = db
    .query<{ x: number }, [string, string, string]>(
      `SELECT 1 AS x FROM events
        WHERE kind = 'error_flood_alert'
          AND json_extract(payload, '$.where') = ?
          AND json_extract(payload, '$.message') = ?
          AND ts >= ?
        LIMIT 1`,
    )
    .get(where, message, sinceIso);
  return row !== null;
};

/**
 * One observability-fidelity sweep. Runs every inert-loop check, every
 * metric-veracity check, and the error-flood watch defensively; a single
 * failing query never aborts the others or crashes the tick.
 */
export const observabilityGuardTick = async (
  db: Database,
  emit: EmitFn = emitEvent,
  options: ObservabilityGuardOptions = {},
): Promise<ObservabilityGuardSummary> => {
  const now = options.now ?? new Date();
  const windowHours = options.windowHours && options.windowHours > 0
    ? options.windowHours
    : DEFAULT_WINDOW_HOURS;
  const windowMs = windowHours * 60 * 60 * 1000;
  const sinceIso = new Date(now.getTime() - windowMs).toISOString();

  const summary: ObservabilityGuardSummary = {
    inert_checks: 0,
    inert_alerts_emitted: 0,
    inert_skipped_idempotent: 0,
    inert_skipped_healthy: 0,
    metric_checks: 0,
    metric_alerts_emitted: 0,
    metric_skipped_within_tolerance: 0,
    error_flood_checks: 0,
    error_flood_alerts_emitted: 0,
    error_flood_skipped_idempotent: 0,
    check_errors: 0,
    alert_event_ids: [],
  };

  const recordError = (where: string, err: unknown): void => {
    summary.check_errors += 1;
    try {
      emit(db, {
        kind: "loop_inert_alert",
        substrate_origin: "substrate_auto",
        payload: {
          guard_check_error: true,
          where,
          error: String(err),
          window_hours: windowHours,
        } as JsonValue,
      });
    } catch {
      // A failure to emit the breadcrumb must not crash the tick.
    }
  };

  // ---- WIRED-BUT-INERT LOOP CHECKS ----
  for (const check of INERT_LOOP_CHECKS) {
    summary.inert_checks += 1;
    try {
      const upstreamCount = check.upstream_query
        ? (db.query<{ c: number }, [string]>(check.upstream_query).get(sinceIso)?.c ?? 0)
        : countSince(db, check.upstream_kind, sinceIso);
      if (upstreamCount < check.min_upstream) {
        // Upstream did not fire enough to expect the loop — not inert.
        summary.inert_skipped_healthy += 1;
        continue;
      }
      const loopCount = countSince(db, check.loop_kind, sinceIso);
      if (loopCount > 0) {
        // Loop is alive.
        summary.inert_skipped_healthy += 1;
        continue;
      }
      // Idempotency: do not re-alert if one already fired this window.
      if (inertAlertExistsInWindow(db, check.loop_kind, sinceIso)) {
        summary.inert_skipped_idempotent += 1;
        continue;
      }
      const emitted = emit(db, {
        kind: "loop_inert_alert",
        substrate_origin: "substrate_auto",
        payload: {
          loop_kind: check.loop_kind,
          upstream_kind: check.upstream_kind,
          upstream_count: upstreamCount,
          loop_count: loopCount,
          min_upstream: check.min_upstream,
          window_hours: windowHours,
        } as JsonValue,
      });
      summary.inert_alerts_emitted += 1;
      summary.alert_event_ids.push(emitted.id);
    } catch (err) {
      recordError(`inert:${check.loop_kind}`, err);
    }
  }

  // ---- LYING-METRIC (VERACITY) CHECKS ----
  for (const check of METRIC_VERACITY_CHECKS) {
    summary.metric_checks += 1;
    try {
      const reported = scalarCount(db, check.reported_query);
      const groundTruth = scalarCount(db, check.ground_truth_query);
      const divergence = Math.abs(reported - groundTruth);
      if (divergence <= check.tolerance) {
        summary.metric_skipped_within_tolerance += 1;
        continue;
      }
      const emitted = emit(db, {
        kind: "metric_veracity_alert",
        substrate_origin: "substrate_auto",
        payload: {
          metric: check.metric_name,
          reported,
          ground_truth: groundTruth,
          divergence,
          tolerance: check.tolerance,
          window_hours: windowHours,
        } as JsonValue,
      });
      summary.metric_alerts_emitted += 1;
      summary.alert_event_ids.push(emitted.id);
    } catch (err) {
      recordError(`metric:${check.metric_name}`, err);
    }
  }

  // ---- ERROR-FLOOD WATCH (loud problems) ----
  // Group recent error_caught by (where, message) over a SHORT flood window
  // (independent of the main tick window — a flood is about rate, not
  // lifetime total) and alert on any single group that exceeds the
  // threshold, naming the exact culprit. Defensive: a query failure here
  // never crashes the tick.
  summary.error_flood_checks += 1;
  try {
    const floodWindowMs = ERROR_FLOOD_WINDOW_HOURS * 60 * 60 * 1000;
    const floodSinceIso = new Date(now.getTime() - floodWindowMs).toISOString();
    const groups = db
      .query<{ where_: string | null; message: string | null; c: number }, [string, number]>(
        `SELECT json_extract(payload, '$.where') AS where_,
                substr(json_extract(payload, '$.message'), 1, 160) AS message,
                COUNT(*) AS c
           FROM events
          WHERE kind = 'error_caught' AND ts >= ?
          GROUP BY where_, message
         HAVING c > ?
          ORDER BY c DESC`,
      )
      .all(floodSinceIso, ERROR_FLOOD_THRESHOLD);
    for (const group of groups) {
      const where = group.where_ ?? "(unknown)";
      const message = group.message ?? "(none)";
      // Idempotency: skip if an error_flood_alert for the same
      // (where, message) already exists within the flood window.
      if (errorFloodAlertExistsInWindow(db, where, message, floodSinceIso)) {
        summary.error_flood_skipped_idempotent += 1;
        continue;
      }
      const emitted = emit(db, {
        kind: "error_flood_alert",
        substrate_origin: "substrate_auto",
        payload: {
          where,
          message,
          count: group.c,
          window_hours: ERROR_FLOOD_WINDOW_HOURS,
          threshold: ERROR_FLOOD_THRESHOLD,
        } as JsonValue,
      });
      summary.error_flood_alerts_emitted += 1;
      summary.alert_event_ids.push(emitted.id);
    }
  } catch (err) {
    recordError("error_flood", err);
  }

  return summary;
};

// Exported for tests / introspection.
export const __INERT_LOOP_CHECKS = INERT_LOOP_CHECKS;
export const __METRIC_VERACITY_CHECKS = METRIC_VERACITY_CHECKS;
export const __ERROR_FLOOD_THRESHOLD = ERROR_FLOOD_THRESHOLD;
export const __ERROR_FLOOD_WINDOW_HOURS = ERROR_FLOOD_WINDOW_HOURS;
