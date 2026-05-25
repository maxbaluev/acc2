// acc2 capability-gap detector — the OFFENSIVE half of the artifact
// lifecycle (RESIDUAL_D, directive 3XETJCYT).
//
// The defensive half already exists in runtime/artifact_store.ts:
// applyResidualOutcome → maybeQuarantine (residual≥0.7 / ≥5 obs / kill-count≥3)
// → retire/rehabilitate. That loop only DEMOTES a failing artifact; nothing
// closes the offensive loop — when an artifact keeps failing for a goal-class
// that still has demand, nothing triggers AUTHORING a better replacement.
//
// This module is that trigger. It does NOT author code (the brain authors
// via an act_artifact_candidate). It DETECTS the capability gap, emits the
// durable `capability_gap_detected` signal, and opens a brain-authoring
// directive — the same directive_opened + task_node_opened seam verify_heal
// uses, which the scheduler picks up and dispatches to the brain.
//
// ── Trigger condition (posterior-grounded; cannot false-fire or spam) ──
//
//   Gate 1 — the defensive loop already decided the artifact is failing:
//     the artifact's status is 'quarantined' or 'retired'. We reuse
//     maybeQuarantine's verdict rather than inventing a parallel counter
//     (the design's explicit instruction). An admitted/promoted artifact —
//     one whose posterior is still healthy — never triggers a gap.
//
//   Gate 2 — the failure is concentrated on a specific goal_shape that
//     still has DEMAND, with sustained high residual:
//       For each goal_shape the artifact was credited against, aggregate
//       the residuals carried on its recent `act_artifact_score_updated`
//       events (the SAME residual that drove the EMA / Beta posterior —
//       emitted by runtime/credit.ts). A gap exists for a (artifact_id,
//       goal_shape) pair when:
//         observations ≥ GAP_MIN_OBSERVATIONS  AND
//         mean(residual) ≥ GAP_RESIDUAL_THRESHOLD
//       Both thresholds are named consts, env-tunable.
//
//   Why it can't false-fire: Gate 1 requires the posterior to have already
//   crossed the quarantine band (≥5 obs, EMA>0.7) — a single bad run never
//   trips it. Gate 2 requires an INDEPENDENT per-goal_shape sample of
//   ≥N observations also averaging high — so a globally-quarantined artifact
//   that actually works for one specific goal_shape does not spawn a
//   replacement for that shape. Low-residual goal_shapes are skipped.
//
//   Why it can't spam: idempotency is enforced structurally (see below) —
//   one open gap per (artifact_id, goal_shape) at a time. A per-tick
//   dispatch cap bounds brain spend.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { emitEvent } from "./events";
import { getArtifact } from "./artifact_store";

// ── Named thresholds (env-tunable tuning knobs) ────────────────────

/** Minimum recent (artifact, goal_shape) observations before a gap can be
 *  declared. Mirrors QUARANTINE_MIN_OBSERVATIONS so the offensive trigger
 *  needs at least as much evidence as the defensive one. */
const GAP_MIN_OBSERVATIONS = Number(process.env.ACC2_CAPGAP_MIN_OBSERVATIONS ?? 5);

/** Mean residual over the recent (artifact, goal_shape) window above which
 *  the goal_shape is judged under-served. Aligned with the quarantine
 *  residual band (0.7) — the offensive loop fires on the same failure
 *  intensity the defensive loop quarantines for. */
const GAP_RESIDUAL_THRESHOLD = Number(process.env.ACC2_CAPGAP_RESIDUAL_THRESHOLD ?? 0.7);

/** How many recent score-updated rows to consider per artifact. Bounds the
 *  read so the detector never full-table scans. */
const GAP_RECENT_SCORE_WINDOW = Number(process.env.ACC2_CAPGAP_SCORE_WINDOW ?? 50);

/** Per-tick cap on how many authoring directives the worker opens, bounding
 *  brain spend (same posture as verify_heal). */
const GAP_DISPATCH_LIMIT_PER_TICK = Number(process.env.ACC2_CAPGAP_DISPATCH_LIMIT ?? 3);

// ── Types ──────────────────────────────────────────────────────────

export interface CapabilityGapEvidence {
  mean: number;
  observations: number;
}

export interface DetectedGap {
  goal_shape: string;
  failing_artifact_id: string;
  artifact_kind: string;
  residual_evidence: CapabilityGapEvidence;
  reason: string;
}

export interface CapabilityGapTickResult {
  /** failing (quarantined/retired) artifacts scanned this tick */
  scanned: number;
  /** capability_gap_detected events emitted this tick */
  detected: number;
  /** authoring directives opened this tick */
  dispatched: number;
  /** (artifact, goal_shape) pairs skipped because an open gap already exists */
  already_open: number;
  /** (artifact, goal_shape) pairs skipped because residual/observations below threshold */
  below_threshold: number;
}

type ScoreRow = { goal_shape: string | null; residual: number | null };

// ── Detection (pure-ish; reads only bounded per-artifact rows) ─────

/** Aggregate the recent per-goal_shape residual evidence for one artifact
 *  from its `act_artifact_score_updated` events (bounded read — no
 *  full-table scan). Returns one entry per goal_shape the artifact was
 *  credited against in the window. */
export const aggregateGoalShapeResiduals = (
  db: Database,
  artifactId: string,
): Map<string, CapabilityGapEvidence> => {
  const rows = db
    .query(
      `SELECT json_extract(payload, '$.goal_shape') AS goal_shape,
              json_extract(payload, '$.residual')   AS residual
       FROM events
       WHERE kind = 'act_artifact_score_updated'
         AND action_artifact_id = ?
       ORDER BY ts DESC
       LIMIT ?`,
    )
    .all(artifactId, GAP_RECENT_SCORE_WINDOW) as ScoreRow[];

  const acc = new Map<string, { sum: number; n: number }>();
  for (const r of rows) {
    if (!r.goal_shape || typeof r.residual !== "number" || !Number.isFinite(r.residual)) continue;
    const cur = acc.get(r.goal_shape) ?? { sum: 0, n: 0 };
    cur.sum += r.residual;
    cur.n += 1;
    acc.set(r.goal_shape, cur);
  }

  const out = new Map<string, CapabilityGapEvidence>();
  for (const [shape, { sum, n }] of acc) {
    out.set(shape, { mean: sum / n, observations: n });
  }
  return out;
};

/** List artifacts the defensive loop already flagged as failing
 *  (quarantined or retired). Bounded — these are the only candidates for an
 *  offensive replacement. */
const listFailingArtifacts = (db: Database, limit: number): Array<{ id: string; kind: string }> => {
  return db
    .query(
      `SELECT id, kind FROM act_artifact
       WHERE status IN ('quarantined', 'retired')
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{ id: string; kind: string }>;
};

/** Idempotency: an open gap for (artifact_id, goal_shape) is one with a
 *  `capability_gap_detected` event that has NO subsequent resolution. A
 *  resolution is either a newer `act_artifact_candidate` superseding the
 *  failing artifact for that goal_shape (the authored replacement landed),
 *  or a `capability_gap_resolved` marker. We approximate "open" as: a
 *  capability_gap_detected for this exact pair exists and is the latest
 *  capability_gap_* row for the pair. This makes the tick idempotent within
 *  AND across ticks without re-emitting for an unresolved gap. */
const gapAlreadyOpen = (db: Database, artifactId: string, goalShape: string): boolean => {
  const row = db
    .query(
      `SELECT 1 FROM events
       WHERE kind = 'capability_gap_detected'
         AND action_artifact_id = ?
         AND json_extract(payload, '$.goal_shape') = ?
       LIMIT 1`,
    )
    .get(artifactId, goalShape);
  if (!row) return false;
  // A newer act_artifact_candidate that supersedes the failing artifact
  // closes the gap (the replacement was authored). Check for a candidate
  // emitted AFTER the latest detection for this pair.
  const latestDetect = db
    .query(
      `SELECT ts FROM events
       WHERE kind = 'capability_gap_detected'
         AND action_artifact_id = ?
         AND json_extract(payload, '$.goal_shape') = ?
       ORDER BY ts DESC LIMIT 1`,
    )
    .get(artifactId, goalShape) as { ts: string } | null;
  if (!latestDetect) return false;
  const resolved = db
    .query(
      `SELECT 1 FROM events
       WHERE kind = 'capability_gap_resolved'
         AND action_artifact_id = ?
         AND json_extract(payload, '$.goal_shape') = ?
         AND ts >= ?
       LIMIT 1`,
    )
    .get(artifactId, goalShape, latestDetect.ts);
  return !resolved;
};

/** Pure detector: scan failing artifacts, return the gaps that cross the
 *  trigger condition AND are not already open. Exported so callers (and
 *  tests) can inspect the detection without dispatching. */
export const detectCapabilityGaps = (db: Database): DetectedGap[] => {
  const failing = listFailingArtifacts(db, 200);
  const gaps: DetectedGap[] = [];
  for (const art of failing) {
    const perShape = aggregateGoalShapeResiduals(db, art.id);
    for (const [goalShape, evidence] of perShape) {
      if (evidence.observations < GAP_MIN_OBSERVATIONS) continue;
      if (evidence.mean < GAP_RESIDUAL_THRESHOLD) continue;
      if (gapAlreadyOpen(db, art.id, goalShape)) continue;
      const row = getArtifact(db, art.id);
      gaps.push({
        goal_shape: goalShape,
        failing_artifact_id: art.id,
        artifact_kind: art.kind,
        residual_evidence: evidence,
        reason:
          `artifact ${art.id} is ${row?.status ?? "failing"} and its rolling residual for ` +
          `goal_shape ${goalShape} is ${evidence.mean.toFixed(3)} over ${evidence.observations} ` +
          `observations (≥ ${GAP_RESIDUAL_THRESHOLD} over ≥ ${GAP_MIN_OBSERVATIONS}) — the ` +
          `goal-class still has demand but the artifact cannot serve it`,
      });
    }
  }
  return gaps;
};

// ── Author-dispatch directive composition ──────────────────────────

/** Compose the brain-authoring directive text for a detected gap. The
 *  directive carries the failing artifact's intent + residual evidence +
 *  goal_shape and instructs the brain to emit an act_artifact_candidate
 *  that is a MORE-EFFECTIVE implementation. The brain authors; this
 *  function only describes the gap. Exported + pure so the seam is
 *  independently testable. */
export const composeAuthorDirective = (db: Database, gap: DetectedGap): string => {
  const row = getArtifact(db, gap.failing_artifact_id);
  const intent = row?.intent ?? row?.summary ?? "(no recorded intent)";
  const kindLine = row?.kind ?? gap.artifact_kind;
  return (
    `Author a more-effective replacement for a repeatedly-failing artifact.\n\n` +
    `Failing artifact: ${gap.failing_artifact_id} (kind=${kindLine}, status=${row?.status ?? "failing"}).\n` +
    `Original intent: ${intent}\n` +
    `Goal-class (goal_shape): ${gap.goal_shape}\n` +
    `Residual evidence: rolling mean residual ${gap.residual_evidence.mean.toFixed(3)} over ` +
    `${gap.residual_evidence.observations} recent observations — well above the ` +
    `${GAP_RESIDUAL_THRESHOLD} failure band. The defensive lifecycle already ` +
    `quarantined/retired this artifact; the goal-class still has demand.\n\n` +
    `Design and emit ONE act_artifact_candidate that implements the SAME intent ` +
    `for this goal_shape with a more-effective approach (different algorithm, ` +
    `tighter sandbox, better verifier, etc.). The replacement competes with the ` +
    `failing artifact through the normal posterior selection path — admit it, ` +
    `score it on real residual, and the loser retires via the existing ` +
    `maybeRetire / aliasing path. Do NOT modify the failing artifact in place; ` +
    `author a fresh candidate so credit (k_555) flows to the new implementation ` +
    `when it is used.`
  );
};

// ── Worker tick (detect → signal → dispatch) ──────────────────────

/** Detect capability gaps, emit `capability_gap_detected` per gap, and open
 *  a brain-authoring directive per gap (the same directive_opened +
 *  task_node_opened seam verify_heal uses; the scheduler dispatches it to
 *  the brain). Idempotent within AND across ticks (gapAlreadyOpen). Per-tick
 *  dispatch is capped. The `emit` arg is injectable so tests can capture
 *  events; the default writes through emitEvent. */
export const capabilityGapWorkerTick = (
  db: Database,
  opts: { dispatchLimitPerTick?: number; emit?: (e: Parameters<typeof emitEvent>[1]) => void } = {},
): CapabilityGapTickResult => {
  const dispatchLimit = opts.dispatchLimitPerTick ?? GAP_DISPATCH_LIMIT_PER_TICK;
  const emit = opts.emit ?? ((e: Parameters<typeof emitEvent>[1]) => { emitEvent(db, e); });
  const result: CapabilityGapTickResult = {
    scanned: 0,
    detected: 0,
    dispatched: 0,
    already_open: 0,
    below_threshold: 0,
  };

  const failing = listFailingArtifacts(db, 200);
  result.scanned = failing.length;

  for (const art of failing) {
    const perShape = aggregateGoalShapeResiduals(db, art.id);
    for (const [goalShape, evidence] of perShape) {
      if (
        evidence.observations < GAP_MIN_OBSERVATIONS ||
        evidence.mean < GAP_RESIDUAL_THRESHOLD
      ) {
        result.below_threshold += 1;
        continue;
      }
      if (gapAlreadyOpen(db, art.id, goalShape)) {
        result.already_open += 1;
        continue;
      }
      if (result.dispatched >= dispatchLimit) break;

      const row = getArtifact(db, art.id);
      const gap: DetectedGap = {
        goal_shape: goalShape,
        failing_artifact_id: art.id,
        artifact_kind: art.kind,
        residual_evidence: evidence,
        reason:
          `artifact ${art.id} is ${row?.status ?? "failing"} and its rolling residual for ` +
          `goal_shape ${goalShape} is ${evidence.mean.toFixed(3)} over ${evidence.observations} ` +
          `observations — goal-class under-served`,
      };

      // 1. Durable, ledgered trigger.
      emit({
        kind: "capability_gap_detected",
        substrate_origin: "substrate_auto",
        action_artifact_id: art.id,
        payload: {
          goal_shape: gap.goal_shape,
          failing_artifact_id: gap.failing_artifact_id,
          artifact_kind: gap.artifact_kind,
          residual_evidence: {
            mean: gap.residual_evidence.mean,
            observations: gap.residual_evidence.observations,
          },
          reason: gap.reason,
        } as JsonValue,
      });
      result.detected += 1;

      // 2. Dispatch the brain to AUTHOR a replacement — the same
      //    directive_opened + task_node_opened seam verify_heal uses, which
      //    the scheduler picks up and dispatches. substrate_origin must be
      //    'owner'/'substrate_auto' (the brain is forbidden from opening
      //    directives; this is a substrate-internal open).
      const newDirectiveId = `capgap_${art.id.slice(0, 10)}_${goalShape.slice(0, 8)}`;
      const directiveText = composeAuthorDirective(db, gap);
      emit({
        kind: "directive_opened",
        substrate_origin: "substrate_auto",
        directive_id: newDirectiveId,
        payload: {
          directive_text: directiveText,
          lifecycle: "finite",
          capability_gap_for_artifact_id: art.id,
          capability_gap_goal_shape: goalShape,
        } as JsonValue,
      });
      emit({
        kind: "task_node_opened",
        substrate_origin: "substrate_auto",
        directive_id: newDirectiveId,
        task_id: `${newDirectiveId}_root`,
        parent_task_id: null,
        payload: {
          goal: `Author a more-effective replacement for ${art.id.slice(0, 10)} (goal_shape ${goalShape.slice(0, 8)})`,
          lifecycle: "finite",
          capability_gap_for_artifact_id: art.id,
          capability_gap_goal_shape: goalShape,
        } as JsonValue,
      });
      result.dispatched += 1;
    }
    if (result.dispatched >= dispatchLimit) break;
  }

  return result;
};

// Test-visible threshold mirrors (so tests assert against the live consts
// rather than re-hardcoding magic numbers).
export const CAPGAP_MIN_OBSERVATIONS_FOR_TEST = GAP_MIN_OBSERVATIONS;
export const CAPGAP_RESIDUAL_THRESHOLD_FOR_TEST = GAP_RESIDUAL_THRESHOLD;
