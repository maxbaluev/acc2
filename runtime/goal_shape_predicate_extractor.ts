// acc2 Tier-S5 — goal-shape predicate extractor.
// Per roadmap Tier-S5 (brain KC G3PR7X6TCD4T57D7T6GXCDY9AW, ranked #3
// leverage): goal_shape is a free-form string emitted by the brain in
// act_tuple_recorded / act_artifact_score_updated payloads. Without a
// feedback signal that measures whether a given goal_shape PREDICTS
// trajectory similarity (low variance of closure_residual across acts
// sharing the shape), every posterior-per-goal_class predicate
// downstream (T2.2, T2.3, T4.1) reads a noisy index.
//
// This extractor scans `act_artifact_score_updated` events in a bounded
// 14-day window (LIMIT 5000), groups by `goal_shape`, computes per-shape
// metrics (sample_count, mean_residual, std_residual, effective_score),
// and admits one act_artifact{kind:"goal_shape_strategy_predicate"} row
// per distinct shape. The row's Beta posterior is calibrated so each
// observed sample contributes proportionally to the effective_score:
//   alpha = 1 + effective_score * sample_count
//   beta  = 1 + (1 - effective_score) * sample_count
//
// Idempotency: a re-run UPDATEs the existing row's metrics + posterior
// while preserving `created_at`. Bounded: yields every 25 distinct
// goal_shapes.
//
// effective_score = (1 - mean_residual) * (1 - normalized_std)
// where normalized_std = min(std_residual, 1). LOW variance means the
// goal_shape tag groups similar trajectories together — which is the
// whole point of a goal_shape.

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { emitEvent } from "./events";
import { poolQuery } from "./sql_pool_singleton";

const YIELD_EVERY_N = 25;
const PREDICATE_KIND = "goal_shape_strategy_predicate";
const MIN_SAMPLE_COUNT = 5;
const HASH_PREFIX_LEN = 16;

const yieldToEventLoop = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0));

type ScoreUpdatedRow = {
  id: string;
  ts: string;
  payload: string | null;
};

const parsePayload = (raw: string | null): Record<string, unknown> => {
  if (!raw) return {};
  try {
    const p = JSON.parse(raw) as unknown;
    return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const numberOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const predicateId = (goalShape: string): string => {
  // goal_shape values can be 16-hex shape hashes, free-form strings, or
  // long phrases. Always hash for a fixed-length id to keep the
  // act_artifact.id column compact and idempotent across reruns.
  const h = createHash("sha256").update(goalShape).digest("hex").slice(0, HASH_PREFIX_LEN);
  return `goalshape_${h}`;
};

export type GoalShapePredicateSummary = {
  scanned: number;
  distinct_shapes: number;
  rows_admitted: number;
  rows_updated: number;
  skipped_below_threshold: number;
  skipped_empty_shape: number;
};

type ShapeMetrics = {
  goal_shape: string;
  sample_count: number;
  mean_residual: number;
  std_residual: number;
  effective_score: number;
  last_observed_ts: string;
};

const computeMetrics = (
  goalShape: string,
  residuals: number[],
  lastObservedTs: string,
): ShapeMetrics => {
  const n = residuals.length;
  const mean = residuals.reduce((s, r) => s + r, 0) / n;
  // Population variance — small n, no Bessel correction needed; the
  // signal is "how dispersed are residuals under this tag", not a
  // hypothesis test.
  const variance = residuals.reduce((s, r) => s + (r - mean) * (r - mean), 0) / n;
  const std = Math.sqrt(variance);
  const normalizedStd = Math.min(Math.max(std, 0), 1);
  const meanClamped = Math.min(Math.max(mean, 0), 1);
  const effective = (1 - meanClamped) * (1 - normalizedStd);
  return {
    goal_shape: goalShape,
    sample_count: n,
    mean_residual: mean,
    std_residual: std,
    effective_score: effective,
    last_observed_ts: lastObservedTs,
  };
};

const upsertPredicateRow = (
  db: Database,
  metrics: ShapeMetrics,
): { id: string; created: boolean } => {
  const id = predicateId(metrics.goal_shape);
  const alpha = 1 + metrics.effective_score * metrics.sample_count;
  const beta = 1 + (1 - metrics.effective_score) * metrics.sample_count;
  const body = JSON.stringify({
    goal_shape: metrics.goal_shape,
    sample_count: metrics.sample_count,
    mean_residual: metrics.mean_residual,
    std_residual: metrics.std_residual,
    effective_score: metrics.effective_score,
    last_observed_ts: metrics.last_observed_ts,
  });
  const nowIso = new Date().toISOString();
  const existing = db
    .query("SELECT id FROM act_artifact WHERE id = ? LIMIT 1")
    .get(id) as { id: string } | null;
  if (existing) {
    db.run(
      `UPDATE act_artifact
         SET body = ?,
             posterior_alpha = ?,
             posterior_beta = ?,
             score = ?,
             confidence = ?,
             recent_residual_mean = ?,
             updated_at = ?
       WHERE id = ?`,
      [
        body,
        alpha,
        beta,
        metrics.effective_score,
        // Confidence proxy: each sample adds discrimination. Same
        // 1 - 1/√(α+β) shape used elsewhere in the substrate so the
        // value composes with cross-extractor consumers.
        1 - 1 / Math.sqrt(alpha + beta),
        metrics.mean_residual,
        nowIso,
        id,
      ],
    );
    return { id, created: false };
  }
  const declaredSandbox = JSON.stringify({
    runtime: "bun",
    substrate_access: "ro",
    cpu_ms: 100,
    wall_ms: 1000,
    memory_mb: 8,
    fs_read: [],
    fs_write: [],
    net_allow: [],
    proc_allow: [],
  });
  db.run(
    `INSERT INTO act_artifact (
       id, runtime, body, declared_sandbox, state_root, kind,
       posterior_alpha, posterior_beta, score, confidence,
       recent_residual_mean, recent_kill_count, status, name,
       fixture_input, fixture_expected_residual,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      "bun",
      body,
      declaredSandbox,
      `substrate/goal_shape_strategy/${id}`,
      PREDICATE_KIND,
      alpha,
      beta,
      metrics.effective_score,
      1 - 1 / Math.sqrt(alpha + beta),
      metrics.mean_residual,
      0,
      "admitted",
      metrics.goal_shape,
      JSON.stringify({ goal_shape: metrics.goal_shape }),
      0.5,
      nowIso,
      nowIso,
    ],
  );
  return { id, created: true };
};

/**
 * Scan recent act_artifact_score_updated events, group by goal_shape,
 * compute per-shape variance metrics, and admit/update one
 * act_artifact{kind:"goal_shape_strategy_predicate"} row per shape with
 * sample_count >= MIN_SAMPLE_COUNT. Empty goal_shape strings are
 * silently skipped (they carry no predictive signal). Re-runs UPDATE
 * existing rows in place and preserve `created_at`.
 */
export const extractGoalShapePredicates = async (
  db: Database,
  opts?: { maxEvents?: number; windowDays?: number },
): Promise<GoalShapePredicateSummary> => {
  const maxEvents = Math.max(1, opts?.maxEvents ?? 5000);
  const windowDays = Math.max(1, opts?.windowDays ?? 14);
  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const summary: GoalShapePredicateSummary = {
    scanned: 0,
    distinct_shapes: 0,
    rows_admitted: 0,
    rows_updated: 0,
    skipped_below_threshold: 0,
    skipped_empty_shape: 0,
  };

  // Windowed scan of recent score-update events. Route through the SQL
  // worker-thread pool when present so the heavy time-window read doesn't
  // block the main loop (Bun.SQL is fake-async). The full window aggregate is
  // genuinely needed each tick (per-shape residual variance), so this is
  // pool-routed but NOT watermarked.
  const rows = (await poolQuery<ScoreUpdatedRow>(
    db,
    `SELECT id, ts, payload FROM events
      WHERE kind = 'act_artifact_score_updated' AND ts > ?
      ORDER BY ts ASC LIMIT ?`,
    [cutoff, maxEvents],
  ));

  // Group residuals by goal_shape. Track last_observed_ts per shape.
  const byShape = new Map<string, { residuals: number[]; lastTs: string }>();
  for (const row of rows) {
    summary.scanned++;
    const payload = parsePayload(row.payload);
    const shapeRaw = payload.goal_shape;
    const residual = numberOrNull(payload.residual);
    if (residual === null) continue;
    if (typeof shapeRaw !== "string" || shapeRaw.length === 0) {
      summary.skipped_empty_shape++;
      continue;
    }
    const entry = byShape.get(shapeRaw);
    if (entry) {
      entry.residuals.push(residual);
      // Events were selected ORDER BY ts ASC; this tail value is the
      // most recent observation for the shape.
      entry.lastTs = row.ts;
    } else {
      byShape.set(shapeRaw, { residuals: [residual], lastTs: row.ts });
    }
  }
  summary.distinct_shapes = byShape.size;

  // Walk shapes; admit/update rows above threshold. Bounded — yield
  // every 25 distinct shapes so the daemon's event loop stays
  // responsive on large windows.
  let processedSinceYield = 0;
  for (const [shape, { residuals, lastTs }] of byShape.entries()) {
    if (processedSinceYield >= YIELD_EVERY_N) {
      await yieldToEventLoop();
      processedSinceYield = 0;
    }
    processedSinceYield++;

    if (residuals.length < MIN_SAMPLE_COUNT) {
      summary.skipped_below_threshold++;
      continue;
    }
    const metrics = computeMetrics(shape, residuals, lastTs);
    const { id, created } = upsertPredicateRow(db, metrics);
    if (created) summary.rows_admitted++;
    else summary.rows_updated++;

    emitEvent(db, {
      kind: "goal_shape_strategy_observed",
      substrate_origin: "substrate_auto",
      context_refs: [id],
      payload: {
        goal_shape: shape,
        predicate_act_artifact_id: id,
        sample_count: metrics.sample_count,
        mean_residual: metrics.mean_residual,
        std_residual: metrics.std_residual,
        effective_score: metrics.effective_score,
        last_observed_ts: metrics.last_observed_ts,
        created,
      },
    });
  }

  return summary;
};
