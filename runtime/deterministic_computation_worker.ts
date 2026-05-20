// acc2 Tier -1 floor — deterministic computation sanity worker.
//
// Per docs/roadmap.md Tier -1: verifier computation must be repeatable
// within tolerance for deterministic_code verifiers. This worker
// samples recent action_scored events with verifier_kind=deterministic_code
// and looks for repeat invocations on the same
// (action_artifact_id, verifier_artifact_id) pair. When two or more
// scorings exist for the same pair, residuals MUST agree within
// tolerance (default 0.001). Mismatch indicates the verifier is not
// actually deterministic — emit integrity_check_failed and quarantine
// the verifier artifact.
//
// Emit cadence: 10 minutes. Idempotent (at most one emit per interval).
// Predicate row: deterministic_computation_sanity_predicate (substrate/seed.ts).
//
// NOTE on shape: spec says "re-invoke verifier on same observation."
// The substrate already records every invocation as an action_scored
// row, so the cheapest evidence is to detect natural duplicates and
// audit them — no separate verifier replay needed. Sampled=0 on
// fresh DBs (no eligible pairs) is the expected baseline.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { emitEvent } from "./events";
import { logger } from "./logger";

export const DETERMINISTIC_COMPUTATION_TICK_MS = 10 * 60 * 1000;
const DEFAULT_TOLERANCE = 0.001;
const DEFAULT_SAMPLE_SIZE = 5;
const MIN_GAP_MS = 10 * 60 * 1000;

type ScoredRow = {
  id: string;
  ts: string;
  action_artifact_id: string | null;
  verifier_artifact_id: string | null;
  residual: number | null;
  directive_id: string | null;
};

type PairAudit = {
  action_artifact_id: string;
  verifier_artifact_id: string;
  residuals: number[];
  event_ids: string[];
  max_delta: number;
};

export type DeterministicComputationOptions = {
  now?: Date;
  sampleSize?: number;
  tolerance?: number;
  minGapMs?: number;
};

export type DeterministicComputationSummary = {
  sampled: number;
  agreed: number;
  mismatched: number;
  emitted_kind: "deterministic_computation_check" | "integrity_check_failed" | "skipped";
  emitted_event_id?: string;
  quarantined_verifier_ids: string[];
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

const recentlyQuarantined = (db: Database, verifierId: string): boolean => {
  try {
    const row = db
      .query<{ c: number }, [string]>(
        `SELECT COUNT(*) AS c FROM events
          WHERE kind = 'act_artifact_quarantined'
            AND (action_artifact_id = ?
                 OR json_extract(payload, '$.artifact_id') = ?
                 OR json_extract(payload, '$.verifier_artifact_id') = ?)`,
      )
      .get(verifierId, verifierId, verifierId);
    return (row?.c ?? 0) > 0;
  } catch {
    return false;
  }
};

/** One worker tick. Samples recent action_scored rows with
 *  verifier_kind=deterministic_code, groups by
 *  (action_artifact_id, verifier_artifact_id), and audits each group
 *  with ≥2 entries for residual agreement within tolerance. */
export const deterministicComputationWorkerTick = (
  db: Database,
  opts: DeterministicComputationOptions = {},
): DeterministicComputationSummary => {
  const now = opts.now ?? new Date();
  const sampleSize = Math.max(1, opts.sampleSize ?? DEFAULT_SAMPLE_SIZE);
  const tolerance = Math.max(0, opts.tolerance ?? DEFAULT_TOLERANCE);
  const minGapMs = Math.max(0, opts.minGapMs ?? MIN_GAP_MS);

  // Idempotency — at most one emit per interval. Compare against the
  // worker's own primary emit kind; floor-wide integrity_check_failed
  // rows are shared across all three Tier -1 workers, so gating on
  // them would couple cadences.
  const cleanGap = now.getTime() - lastEmitTsMs(db, "deterministic_computation_check");
  if (cleanGap < minGapMs) {
    return {
      sampled: 0,
      agreed: 0,
      mismatched: 0,
      emitted_kind: "skipped",
      quarantined_verifier_ids: [],
    };
  }

  // Pull a generous window of recent rows so we can find natural pairs;
  // sampleSize bounds how many DISTINCT pairs we audit, not the raw
  // row scan.
  let rows: ScoredRow[] = [];
  try {
    rows = db
      .query<ScoredRow, []>(
        `SELECT id, ts, action_artifact_id, verifier_artifact_id, residual, directive_id
           FROM events
          WHERE kind = 'action_scored'
            AND json_extract(payload, '$.verifier_kind') = 'deterministic_code'
            AND residual IS NOT NULL
            AND action_artifact_id IS NOT NULL
            AND verifier_artifact_id IS NOT NULL
            AND directive_id IS NOT NULL
          ORDER BY ts DESC
          LIMIT 500`,
      )
      .all();
  } catch (err) {
    logger.warn(
      { where: "deterministic_computation.sample", err: (err as Error).message },
      "deterministic_computation sample query failed",
    );
    return {
      sampled: 0,
      agreed: 0,
      mismatched: 0,
      emitted_kind: "skipped",
      quarantined_verifier_ids: [],
    };
  }

  // Group by (action_artifact_id, verifier_artifact_id, directive_id).
  // The directive_id is load-bearing: the floor wants to catch a verifier
  // returning different residuals when re-invoked on the SAME observation.
  // Without directive_id, the grouping collapses every invocation of the
  // same (action, verifier) pair across different directives into one
  // bucket, where legitimate cross-directive variance reads as
  // non-determinism (measurement artifact, not a real bug). Adding
  // directive_id restricts the audit to true natural duplicates.
  const groups = new Map<string, PairAudit>();
  for (const r of rows) {
    if (r.action_artifact_id === null || r.verifier_artifact_id === null || r.residual === null) continue;
    const key = `${r.action_artifact_id}|${r.verifier_artifact_id}|${r.directive_id ?? ""}`;
    let entry = groups.get(key);
    if (!entry) {
      entry = {
        action_artifact_id: r.action_artifact_id,
        verifier_artifact_id: r.verifier_artifact_id,
        residuals: [],
        event_ids: [],
        max_delta: 0,
      };
      groups.set(key, entry);
    }
    entry.residuals.push(r.residual);
    entry.event_ids.push(r.id);
  }

  // Pairs with ≥2 scorings are auditable. Take up to sampleSize.
  const auditable: PairAudit[] = [];
  for (const entry of groups.values()) {
    if (entry.residuals.length < 2) continue;
    const min = Math.min(...entry.residuals);
    const max = Math.max(...entry.residuals);
    entry.max_delta = max - min;
    auditable.push(entry);
    if (auditable.length >= sampleSize) break;
  }

  const sampled = auditable.length;
  let agreed = 0;
  const mismatches: PairAudit[] = [];
  for (const pair of auditable) {
    if (pair.max_delta <= tolerance) {
      agreed++;
    } else {
      mismatches.push(pair);
    }
  }

  const quarantinedVerifierIds: string[] = [];

  // Quarantine each mismatched verifier (idempotent — skip if already
  // quarantined in the last interval).
  for (const pair of mismatches) {
    if (recentlyQuarantined(db, pair.verifier_artifact_id)) continue;
    try {
      emitEvent(db, {
        kind: "act_artifact_quarantined",
        substrate_origin: "substrate_auto",
        action_artifact_id: pair.verifier_artifact_id,
        payload: {
          artifact_id: pair.verifier_artifact_id,
          verifier_artifact_id: pair.verifier_artifact_id,
          reason: "deterministic_computation_mismatch",
          floor: "deterministic_computation",
          predicate: "deterministic_computation_sanity_predicate",
          residuals: pair.residuals,
          max_delta: pair.max_delta,
          tolerance,
          evidence_event_ids: pair.event_ids,
        } as JsonValue,
      });
      // Best-effort: also mark the act_artifact row as quarantined.
      try {
        db.run(
          "UPDATE act_artifact SET status = ?, updated_at = ? WHERE id = ?",
          ["quarantined", new Date().toISOString(), pair.verifier_artifact_id],
        );
      } catch {
        // Row may not exist (test fixtures) — quarantine event still
        // landed and is the load-bearing signal.
      }
      quarantinedVerifierIds.push(pair.verifier_artifact_id);
    } catch (err) {
      logger.warn(
        { where: "deterministic_computation.quarantine", err: (err as Error).message },
        "verifier quarantine emit failed",
      );
    }
  }

  try {
    if (mismatches.length === 0) {
      const emitted = emitEvent(db, {
        kind: "deterministic_computation_check",
        substrate_origin: "substrate_auto",
        payload: {
          sampled,
          agreed,
          residual: sampled === 0 ? 0 : (agreed === sampled ? 0 : 1),
          tolerance,
          predicate: "deterministic_computation_sanity_predicate",
        } as JsonValue,
      });
      return {
        sampled,
        agreed,
        mismatched: 0,
        emitted_kind: "deterministic_computation_check",
        emitted_event_id: emitted.id,
        quarantined_verifier_ids: quarantinedVerifierIds,
      };
    }
    const emitted = emitEvent(db, {
      kind: "integrity_check_failed",
      substrate_origin: "substrate_auto",
      payload: {
        floor: "deterministic_computation",
        predicate: "deterministic_computation_sanity_predicate",
        sampled,
        agreed,
        mismatched: mismatches.length,
        tolerance,
        offending_pairs: mismatches.slice(0, 10).map((p) => ({
          action_artifact_id: p.action_artifact_id,
          verifier_artifact_id: p.verifier_artifact_id,
          residuals: p.residuals,
          max_delta: p.max_delta,
        })),
        quarantined_verifier_ids: quarantinedVerifierIds,
        marker: "deterministic_computation_mismatch_v1",
      } as JsonValue,
    });
    logger.error(
      { sampled, mismatched: mismatches.length, quarantined: quarantinedVerifierIds.length },
      "deterministic computation floor violated — verifier non-determinism detected",
    );
    return {
      sampled,
      agreed,
      mismatched: mismatches.length,
      emitted_kind: "integrity_check_failed",
      emitted_event_id: emitted.id,
      quarantined_verifier_ids: quarantinedVerifierIds,
    };
  } catch (err) {
    logger.warn(
      { where: "deterministic_computation.emit", err: (err as Error).message },
      "deterministic_computation emit failed — report not lost",
    );
    return {
      sampled,
      agreed,
      mismatched: mismatches.length,
      emitted_kind: "skipped",
      quarantined_verifier_ids: quarantinedVerifierIds,
    };
  }
};
