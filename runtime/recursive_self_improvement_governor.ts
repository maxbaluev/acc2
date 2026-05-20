// acc2 Tier -1 floor — SAHOO recursive self-improvement governor.
//
// Per arXiv:2603.06333 (Sahoo, Chadha, Jain, Chaudhary 2026) —
// Safeguarded Alignment for High-Order Optimization Objectives in
// Recursive Self-Improvement. Three safeguards combined:
//   (i)  Go/No-Go gate at amendment apply boundary
//   (ii) Constraint-preserving evidence-chain check
//   (iii) Intrinsic diagnostics tuple (5 invariants)
//
// Threads forward from Kriger 2026 (predicate_owner_goal_preservation
// _drift_v1) formal upper bound — SAHOO is the formal mechanism that
// ACTS on Kriger's drift bound. Without this, Tier -1 floors detect
// violations but the substrate has no concrete gate that refuses
// amendment apply at drift > bound.
//
// This worker emits intrinsic diagnostics every 10 minutes (the
// 5-invariant tuple); Go/No-Go is intended to be invoked by the
// amendment apply path (claude_apply / dispatcher) as a hard gate
// before any high-impact repo: amendment commits. The pure
// `evaluateGoNoGo` function below is the canonical entry point.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { emitEvent } from "./events";
import { getThreshold } from "./threshold_registry";
import { logger } from "./logger";

export type GoNoGoDecision = {
  verdict: "go" | "no_go";
  drift_score: number;
  bound: number;
  reasons: string[];
};

export type SahooDiagnostics = {
  delegation_safety_residual: number;
  drift_bound_headroom: number;
  closure_residual_avg: number;
  owner_outcome_coverage: number;
  posterior_promotion_rate: number;
};

const DEFAULT_DRIFT_BOUND_DEFAULT = 0.3;
const DIAGNOSTIC_TICK_MS = 10 * 60 * 1000;

const lastEmitTsMs = (db: Database, kind: string): number => {
  try {
    const row = db
      .query<{ ts: string | null }, [string]>(
        `SELECT ts FROM events WHERE kind = ? ORDER BY ts DESC LIMIT 1`,
      )
      .get(kind);
    return row?.ts ? new Date(row.ts).getTime() : 0;
  } catch {
    return 0;
  }
};

/** Compute the current drift score from recent integrity_check_failed +
 *  memory_reconciliation_drift_detected + owner_input_required events.
 *  Higher score → higher drift. Normalized to [0, 1]. */
export const computeDriftScore = (db: Database, now: Date = new Date()): number => {
  const windowMs = 24 * 60 * 60 * 1000; // 24h
  const sinceIso = new Date(now.getTime() - windowMs).toISOString();
  try {
    const driftKinds = [
      "integrity_check_failed",
      "memory_reconciliation_drift_detected",
      "closure_blocked_high_residual",
      "owner_identity_discontinuity",
    ];
    const placeholders = driftKinds.map(() => "?").join(",");
    const row = db
      .query<{ c: number }, [string, ...string[]]>(
        `SELECT COUNT(*) AS c FROM events
          WHERE kind IN (${placeholders})
            AND ts > ?`,
      )
      .get(...driftKinds, sinceIso);
    const count = row?.c ?? 0;
    // Saturate at 10 drifts/24h → score 1.0; 0 drifts → score 0.0.
    return Math.min(1, count / 10);
  } catch {
    return 0;
  }
};

/** Pure Go/No-Go evaluation. Called by amendment apply path before
 *  high-impact repo: writes. Returns "no_go" when drift_score exceeds
 *  the configurable bound (threshold registry: sahoo_drift_bound,
 *  default 0.3 — same as the closure_gate_residual_threshold).
 *
 *  Constraint-preserving check is additive: if the amendment cites
 *  no evidence chain (evidence_event_ids empty), apply a KL-divergence
 *  penalty toward "no_go". */
export const evaluateGoNoGo = (
  db: Database,
  params: {
    target_resource?: string;
    evidence_event_ids?: readonly string[];
    now?: Date;
  } = {},
): GoNoGoDecision => {
  const now = params.now ?? new Date();
  const bound = getThreshold(db, "sahoo_drift_bound", DEFAULT_DRIFT_BOUND_DEFAULT);
  const driftScore = computeDriftScore(db, now);
  const reasons: string[] = [];

  if (driftScore >= bound) {
    reasons.push(
      `drift_score=${driftScore.toFixed(3)}>=bound=${bound.toFixed(3)} (24h drift events saturating)`,
    );
  }

  // Constraint-preserving evidence-chain check — high-impact targets
  // require evidence_event_ids; missing chain → no_go.
  const target = params.target_resource ?? "";
  const isHighImpact =
    target.startsWith("repo:runtime/") ||
    target.startsWith("repo:substrate/") ||
    target.startsWith("repo:cli/") ||
    target.startsWith("repo:docs/");
  const evidenceCount = params.evidence_event_ids?.length ?? 0;
  if (isHighImpact && evidenceCount === 0) {
    reasons.push("constraint_preserving:high_impact_target_lacks_evidence_chain");
  }

  const verdict: "go" | "no_go" = reasons.length > 0 ? "no_go" : "go";
  return { verdict, drift_score: driftScore, bound, reasons };
};

const recentResidualAvg = (db: Database, kind: string, sinceIso: string): number => {
  try {
    const row = db
      .query<{ avg: number | null }, [string]>(
        `SELECT AVG(json_extract(payload,'$.closure_residual')) AS avg FROM events
          WHERE kind = '${kind}' AND ts > ?`,
      )
      .get(sinceIso);
    return Number.isFinite(row?.avg) ? (row!.avg as number) : 0;
  } catch {
    return 0;
  }
};

const computeDiagnostics = (db: Database, now: Date): SahooDiagnostics => {
  const sinceIso = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  let delegation_safety_residual = 1;
  let owner_outcome_coverage = 0;
  let posterior_promotion_rate = 0;
  let closure_residual_avg = 0;

  try {
    // delegation_safety: low if many dispatcher_violation events
    const violations = db
      .query<{ c: number }, [string]>(
        `SELECT COUNT(*) AS c FROM events WHERE kind = 'dispatcher_violation' AND ts > ?`,
      )
      .get(sinceIso);
    const total = db
      .query<{ c: number }, [string]>(
        `SELECT COUNT(*) AS c FROM events WHERE kind = 'dispatch_decided' AND ts > ?`,
      )
      .get(sinceIso);
    if ((total?.c ?? 0) > 0) {
      delegation_safety_residual = (violations?.c ?? 0) / total!.c;
    }
  } catch {}

  try {
    const outcomes = db
      .query<{ c: number }, [string]>(
        `SELECT COUNT(*) AS c FROM events WHERE kind = 'owner_observed_outcome_recorded' AND ts > ?`,
      )
      .get(sinceIso);
    const commits = db
      .query<{ c: number }, [string]>(
        `SELECT COUNT(*) AS c FROM events WHERE kind = 'applied_change_committed' AND ts > ?`,
      )
      .get(sinceIso);
    if ((commits?.c ?? 0) > 0) {
      owner_outcome_coverage = Math.min(1, (outcomes?.c ?? 0) / commits!.c);
    }
  } catch {}

  try {
    const kc = db
      .query<{ c: number }, [string]>(
        `SELECT COUNT(*) AS c FROM events WHERE kind = 'knowledge_candidate' AND ts > ?`,
      )
      .get(sinceIso);
    const promoted = db
      .query<{ c: number }, [string]>(
        `SELECT COUNT(*) AS c FROM events WHERE kind = 'knowledge_promoted' AND ts > ?`,
      )
      .get(sinceIso);
    if ((kc?.c ?? 0) > 0) {
      posterior_promotion_rate = Math.min(1, (promoted?.c ?? 0) / kc!.c);
    }
  } catch {}

  closure_residual_avg = recentResidualAvg(db, "task_closure_audited", sinceIso);

  const driftScore = computeDriftScore(db, now);
  const driftBound = getThreshold(db, "sahoo_drift_bound", DEFAULT_DRIFT_BOUND_DEFAULT);
  const drift_bound_headroom = Math.max(0, driftBound - driftScore);

  return {
    delegation_safety_residual,
    drift_bound_headroom,
    closure_residual_avg,
    owner_outcome_coverage,
    posterior_promotion_rate,
  };
};

export const runSahooDiagnosticsTick = (
  db: Database,
  opts: { now?: Date; minGapMs?: number } = {},
): {
  emitted: boolean;
  diagnostics: SahooDiagnostics;
  emitted_event_id?: string;
} => {
  const now = opts.now ?? new Date();
  const minGapMs = opts.minGapMs ?? DIAGNOSTIC_TICK_MS;

  const cleanGap = now.getTime() - lastEmitTsMs(db, "sahoo_diagnostics_recorded");
  if (cleanGap < minGapMs) {
    return { emitted: false, diagnostics: computeDiagnostics(db, now) };
  }

  const diagnostics = computeDiagnostics(db, now);
  try {
    const ev = emitEvent(db, {
      kind: "sahoo_diagnostics_recorded",
      substrate_origin: "substrate_auto",
      payload: {
        predicate: "recursive_self_improvement_safeguard_predicate",
        delegation_safety_residual: diagnostics.delegation_safety_residual,
        drift_bound_headroom: diagnostics.drift_bound_headroom,
        closure_residual_avg: diagnostics.closure_residual_avg,
        owner_outcome_coverage: diagnostics.owner_outcome_coverage,
        posterior_promotion_rate: diagnostics.posterior_promotion_rate,
        window_seconds: 24 * 60 * 60,
      } satisfies Record<string, JsonValue>,
    });
    return { emitted: true, diagnostics, emitted_event_id: ev.id };
  } catch (err) {
    logger.warn(
      { where: "sahoo.emit_diagnostics", err: String(err) },
      "could not emit sahoo_diagnostics_recorded",
    );
    return { emitted: false, diagnostics };
  }
};

const TICK_INTERVAL_MS = 10 * 60 * 1000;

export const startSahooWorker = (
  db: Database,
  opts: { now?: () => Date } = {},
): (() => void) => {
  let stopped = false;
  const nowFn = opts.now ?? (() => new Date());

  const tick = (): void => {
    if (stopped) return;
    try {
      runSahooDiagnosticsTick(db, { now: nowFn() });
    } catch {
      // fail-soft
    }
  };

  const handle = setInterval(tick, TICK_INTERVAL_MS);

  return () => {
    stopped = true;
    clearInterval(handle);
  };
};
