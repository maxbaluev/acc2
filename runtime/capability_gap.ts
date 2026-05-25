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

// ── Proactive (gap-at-SELECTION) thresholds ─────────────────────────
//
// The PROACTIVE half (directive KDZVSFNPM): a gap is detected at task-fit
// SELECTION time, not only after an artifact fails in use. When a goal
// arrives and NO admitted/promoted act_artifact fits it well — the best
// readArtifactFit value across the retrieved candidates is below
// PROACTIVE_GAP_FIT_THRESHOLD, OR there are zero candidate artifacts for an
// artifact-wanting goal — that goal_shape has an UNMET capability. The
// proactive detector opens the SAME capability_gap_detected → brain-author
// seam the failure path uses, discriminated by reason="proactive_no_fit" /
// trigger="selection".

/** Fit floor at selection time. readArtifactFit returns a fit value in [0,1]
 *  (the `artifact_fit` breakdown component, BEFORE the 0.75 + 0.5·fit
 *  multiplier transform). When the BEST candidate's fit is strictly below
 *  this, no admitted artifact serves the goal well — a proactive gap. Tuned
 *  conservatively (0.45) so a decent-fit artifact (fit ≥ 0.45) never spawns a
 *  redundant author; only genuinely poor/absent capability fires. */
const PROACTIVE_GAP_FIT_THRESHOLD = Number(process.env.ACC2_CAPGAP_PROACTIVE_FIT_THRESHOLD ?? 0.45);

/** Cooldown window (ms) before a proactive gap for the SAME goal_shape may be
 *  re-opened after a prior proactive open. Bounds authoring spend for a
 *  goal_shape the brain repeatedly fails to serve (combined with the
 *  attempt-cap below). Default 6h. */
const PROACTIVE_GAP_COOLDOWN_MS = Number(process.env.ACC2_CAPGAP_PROACTIVE_COOLDOWN_MS ?? 6 * 60 * 60 * 1000);

/** Hard cap on how many proactive authoring attempts a single goal_shape may
 *  trigger over its lifetime. Once the brain has authored this many times for
 *  a goal_shape WITHOUT a fitting artifact ever being admitted, the goal_shape
 *  is judged persistently-unservable and proactive authoring STOPS (the
 *  repair-exhausted / quarantine signals carry the same fail-stop posture).
 *  Prevents an unbuildable goal_shape from spamming the brain forever. */
const PROACTIVE_GAP_MAX_ATTEMPTS = Number(process.env.ACC2_CAPGAP_PROACTIVE_MAX_ATTEMPTS ?? 3);

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

/** Discriminates WHICH detector opened a gap so downstream (and the ledger)
 *  can tell the failure-driven path from the proactive selection path. Both
 *  open the SAME capability_gap_detected event + author-dispatch seam. */
export type CapabilityGapTrigger = "failure" | "selection";

/** Open-gap descriptor — the shared input both detectors hand to
 *  openCapabilityGap. The failure path supplies a failing_artifact_id +
 *  residual evidence; the proactive path supplies a goal_shape with no
 *  fitting artifact (failing_artifact_id is null, evidence carries the
 *  best-fit + candidate count). */
export interface OpenCapabilityGapInput {
  goal_shape: string;
  /** "artifact_failing" (failure path) or "proactive_no_fit" (selection). */
  reason: string;
  trigger: CapabilityGapTrigger;
  /** Human-readable evidence string for the gap event + author directive. */
  evidence: string;
  /** The failing artifact (failure path) or null (proactive — nothing fits). */
  failing_artifact_id: string | null;
  artifact_kind: string;
  /** Original intent to seed the author directive. When null (proactive zero-
   *  candidate case) the directive derives intent from the goal text. */
  intent?: string | null;
  /** Optional goal text (proactive path) so the author directive can describe
   *  what the owner asked for even when no failing artifact carries intent. */
  goal_text?: string | null;
  /** Structured residual/fit evidence carried on the event payload. */
  residual_evidence?: CapabilityGapEvidence;
  /** Proactive-only structured evidence (best fit + candidate count). */
  fit_evidence?: { best_fit: number; candidate_count: number };
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

// ── Proactive (selection-time) idempotency + cooldown + attempt-cap ──
//
// The proactive path keys gaps on goal_shape ALONE (there is no failing
// artifact). Reuses the same structural-idempotency pattern as gapAlreadyOpen
// but against the proactive discriminator (reason='proactive_no_fit').

/** Count of proactive (reason='proactive_no_fit') capability_gap_detected
 *  events ever emitted for a goal_shape — the lifetime attempt counter the
 *  attempt-cap reads. Bounded index range on (kind), filtered by payload. */
const proactiveAttemptCount = (db: Database, goalShape: string): number => {
  const row = db
    .query(
      `SELECT COUNT(*) AS n FROM events
       WHERE kind = 'capability_gap_detected'
         AND json_extract(payload, '$.goal_shape') = ?
         AND json_extract(payload, '$.reason') = 'proactive_no_fit'`,
    )
    .get(goalShape) as { n: number } | null;
  return row?.n ?? 0;
};

/** True when a proactive gap for this goal_shape should NOT be (re)opened:
 *   • an open proactive gap already exists (a proactive_no_fit detection with
 *     no later capability_gap_resolved for the same goal_shape), OR
 *   • the most recent proactive detection is within the cooldown window, OR
 *   • the lifetime attempt-cap has been reached (persistently-unservable).
 *  Mirrors gapAlreadyOpen's "latest detect with no later resolve" shape so
 *  one open proactive gap per goal_shape holds across ticks, plus the
 *  cooldown + attempt-cap that bound a goal_shape the brain cannot serve. */
export const proactiveGapSuppressed = (
  db: Database,
  goalShape: string,
  nowMs: number = Date.now(),
): { suppressed: boolean; reason: "open" | "cooldown" | "attempt_cap" | null; attempts: number } => {
  const attempts = proactiveAttemptCount(db, goalShape);
  if (attempts >= PROACTIVE_GAP_MAX_ATTEMPTS) {
    return { suppressed: true, reason: "attempt_cap", attempts };
  }
  const latestDetect = db
    .query(
      `SELECT ts FROM events
       WHERE kind = 'capability_gap_detected'
         AND json_extract(payload, '$.goal_shape') = ?
         AND json_extract(payload, '$.reason') = 'proactive_no_fit'
       ORDER BY ts DESC LIMIT 1`,
    )
    .get(goalShape) as { ts: string } | null;
  if (!latestDetect) return { suppressed: false, reason: null, attempts };
  const resolved = db
    .query(
      `SELECT 1 FROM events
       WHERE kind = 'capability_gap_resolved'
         AND json_extract(payload, '$.goal_shape') = ?
         AND ts >= ?
       LIMIT 1`,
    )
    .get(goalShape, latestDetect.ts);
  if (!resolved) return { suppressed: true, reason: "open", attempts };
  // Resolved — enforce the cooldown measured from the latest detection.
  const lastMs = Date.parse(latestDetect.ts);
  if (Number.isFinite(lastMs) && nowMs - lastMs < PROACTIVE_GAP_COOLDOWN_MS) {
    return { suppressed: true, reason: "cooldown", attempts };
  }
  return { suppressed: false, reason: null, attempts };
};

/** Resolve any OPEN proactive gap for a goal_shape — called when an artifact
 *  is admitted for that goal_shape (composition closure: proactive gap → brain
 *  authors → SANDREPAIR → admission → THIS resolves the gap → next selection
 *  finds a good fit). Emits one `capability_gap_resolved` marker so the gap is
 *  no longer suppressed-as-open (the cooldown then governs re-opens). No-op
 *  when no open proactive gap exists (idempotent / cheap). Returns true when a
 *  resolution marker was emitted. */
export const resolveProactiveGap = (
  db: Database,
  goalShape: string,
  admittedArtifactId: string,
  emit: (e: Parameters<typeof emitEvent>[1]) => void = (e) => { emitEvent(db, e); },
): boolean => {
  if (!goalShape) return false;
  const suppression = proactiveGapSuppressed(db, goalShape);
  // Only emit a resolution when a gap is actually open (not when suppressed by
  // cooldown / attempt-cap — those are already non-open states).
  if (!(suppression.suppressed && suppression.reason === "open")) return false;
  emit({
    kind: "capability_gap_resolved",
    substrate_origin: "substrate_auto",
    action_artifact_id: admittedArtifactId,
    payload: {
      goal_shape: goalShape,
      reason: "proactive_no_fit",
      trigger: "selection",
      resolved_by_artifact_id: admittedArtifactId,
    } as JsonValue,
  });
  return true;
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

/** Compose the brain-authoring directive for a PROACTIVE (selection-time) gap:
 *  a goal arrived and NO admitted artifact fit it (best fit below threshold,
 *  or zero candidates). There is no failing artifact to replace — the brain
 *  authors a NEW capability for the goal_shape from scratch. Pure + exported
 *  so the proactive seam is independently testable. */
export const composeProactiveAuthorDirective = (input: OpenCapabilityGapInput): string => {
  const goalText = input.goal_text?.trim() || input.intent?.trim() || "(no goal text recorded — derive from goal_shape)";
  const best = input.fit_evidence
    ? (input.fit_evidence.candidate_count === 0
        ? `no admitted act_artifact matched this goal at all (0 candidates)`
        : `the best of ${input.fit_evidence.candidate_count} candidate artifact(s) scored fit ${input.fit_evidence.best_fit.toFixed(3)}, below the ${PROACTIVE_GAP_FIT_THRESHOLD} selection floor`)
    : `no admitted artifact fit this goal`;
  return (
    `Author a NEW capability for a goal that has no fitting artifact (proactive capability gap).\n\n` +
    `Goal text: ${goalText}\n` +
    `Goal-class (goal_shape): ${input.goal_shape}\n` +
    `Selection evidence: at task-fit selection time, ${best}. The goal genuinely ` +
    `wants an executable artifact but the registry cannot serve it — this is an ` +
    `UNMET capability, detected proactively at selection rather than after a ` +
    `failure in use.\n\n` +
    `Design and emit ONE act_artifact_candidate that implements this goal_shape ` +
    `with an appropriate runtime, declared sandbox, interface schema, usage ` +
    `examples, and a verifier. It will be sandbox-tested-and-repaired before ` +
    `admission (SANDREPAIR), admitted on passing, then scored on real residual ` +
    `through the normal posterior selection path — so the next goal of this shape ` +
    `finds a good fit. Author a fresh candidate (do not modify any existing ` +
    `artifact) so credit (k_555) flows to the new implementation when it is used.`
  );
};

// ── Shared open seam (both detectors call this) ────────────────────

/** Result of opening one capability gap (failure OR proactive). */
export interface OpenedCapabilityGap {
  directive_id: string;
}

/** THE shared gap-open seam. Emits the durable `capability_gap_detected`
 *  signal AND opens the brain-authoring directive (directive_opened +
 *  task_node_opened root) — the SAME seam verify_heal/scheduler picks up.
 *  Both the failure-driven detector (capabilityGapWorkerTick) and the
 *  proactive selection detector (maybeOpenProactiveGap) call this, so the
 *  brain receives a uniform author dispatch regardless of trigger. The
 *  reason/trigger discriminator on the payload distinguishes them downstream.
 *  `emit` is injectable for tests; the default writes through emitEvent. ALL
 *  three events route through the same `emit` so a test captor sees them all
 *  and the ledger stays the single source of truth. */
export const openCapabilityGap = (
  db: Database,
  input: OpenCapabilityGapInput,
  emit: (e: Parameters<typeof emitEvent>[1]) => void = (e) => { emitEvent(db, e); },
): OpenedCapabilityGap => {
  // 1. Durable, ledgered trigger. action_artifact_id is the failing artifact
  //    when present (failure path) or null (proactive — nothing to point at).
  emit({
    kind: "capability_gap_detected",
    substrate_origin: "substrate_auto",
    action_artifact_id: input.failing_artifact_id ?? undefined,
    payload: {
      goal_shape: input.goal_shape,
      failing_artifact_id: input.failing_artifact_id,
      artifact_kind: input.artifact_kind,
      reason: input.reason,
      trigger: input.trigger,
      ...(input.residual_evidence
        ? { residual_evidence: { mean: input.residual_evidence.mean, observations: input.residual_evidence.observations } }
        : {}),
      ...(input.fit_evidence
        ? { fit_evidence: { best_fit: input.fit_evidence.best_fit, candidate_count: input.fit_evidence.candidate_count } }
        : {}),
      evidence: input.evidence,
    } as JsonValue,
  });

  // 2. Dispatch the brain to AUTHOR — directive_opened + task_node_opened root
  //    (substrate-internal open; the brain is forbidden from opening
  //    directives). Same seam the failure path uses.
  const idBase = input.failing_artifact_id
    ? `capgap_${input.failing_artifact_id.slice(0, 10)}_${input.goal_shape.slice(0, 8)}`
    : `capgap_proactive_${input.goal_shape.slice(0, 16)}`;
  const directiveText = input.trigger === "selection"
    ? composeProactiveAuthorDirective(input)
    : composeAuthorDirective(db, {
        goal_shape: input.goal_shape,
        failing_artifact_id: input.failing_artifact_id ?? "",
        artifact_kind: input.artifact_kind,
        residual_evidence: input.residual_evidence ?? { mean: 0, observations: 0 },
        reason: input.reason,
      });
  emit({
    kind: "directive_opened",
    substrate_origin: "substrate_auto",
    directive_id: idBase,
    payload: {
      directive_text: directiveText,
      lifecycle: "finite",
      capability_gap_trigger: input.trigger,
      capability_gap_reason: input.reason,
      capability_gap_for_artifact_id: input.failing_artifact_id,
      capability_gap_goal_shape: input.goal_shape,
    } as JsonValue,
  });
  emit({
    kind: "task_node_opened",
    substrate_origin: "substrate_auto",
    directive_id: idBase,
    task_id: `${idBase}_root`,
    parent_task_id: null,
    payload: {
      goal: input.failing_artifact_id
        ? `Author a more-effective replacement for ${input.failing_artifact_id.slice(0, 10)} (goal_shape ${input.goal_shape.slice(0, 8)})`
        : `Author a new capability for goal_shape ${input.goal_shape.slice(0, 16)} (proactive — no fitting artifact)`,
      lifecycle: "finite",
      capability_gap_trigger: input.trigger,
      capability_gap_for_artifact_id: input.failing_artifact_id,
      capability_gap_goal_shape: input.goal_shape,
    } as JsonValue,
  });
  return { directive_id: idBase };
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
      const evidenceStr =
        `artifact ${art.id} is ${row?.status ?? "failing"} and its rolling residual for ` +
        `goal_shape ${goalShape} is ${evidence.mean.toFixed(3)} over ${evidence.observations} ` +
        `observations — goal-class under-served`;

      // Both signal + author-dispatch flow through the SHARED open seam — the
      // failure path and the proactive path produce identical author dispatch
      // shapes, discriminated only by reason/trigger on the payload.
      openCapabilityGap(
        db,
        {
          goal_shape: goalShape,
          reason: "artifact_failing",
          trigger: "failure",
          evidence: evidenceStr,
          failing_artifact_id: art.id,
          artifact_kind: art.kind,
          intent: row?.intent ?? row?.summary ?? null,
          residual_evidence: evidence,
        },
        emit,
      );
      result.detected += 1;
      result.dispatched += 1;
    }
    if (result.dispatched >= dispatchLimit) break;
  }

  return result;
};

// ── Proactive (selection-time) detector ────────────────────────────

export interface ProactiveGapDecision {
  /** Whether a proactive gap was opened. */
  opened: boolean;
  /** Why it did NOT open (when opened=false). */
  skip_reason:
    | "not_artifact_wanting"
    | "good_fit_exists"
    | "ambiguous_context"
    | "suppressed_open"
    | "suppressed_cooldown"
    | "suppressed_attempt_cap"
    | null;
  goal_shape: string;
  best_fit: number;
  candidate_count: number;
  directive_id?: string;
}

/** Proactive gap detection at SELECTION time. Cheap comparison on already-
 *  computed fit scores (no extra heavy read on the hot path) — the EMISSION +
 *  dispatch is debounced via proactiveGapSuppressed.
 *
 *  Fires a capability_gap_detected (reason='proactive_no_fit', trigger=
 *  'selection') + author dispatch when:
 *    • the goal genuinely WANTS an executable artifact (wantsArtifact gate —
 *      fail-closed: if the dispatch context is ambiguous, do NOT fire), AND
 *    • either the BEST candidate fit is strictly below
 *      PROACTIVE_GAP_FIT_THRESHOLD, OR there are zero candidate artifacts, AND
 *    • no open proactive gap / cooldown / attempt-cap suppresses it.
 *
 *  Returns a decision (opened + skip_reason) so the caller can log without
 *  re-deriving. `emit` is injectable for tests. */
export const maybeOpenProactiveGap = (
  db: Database,
  input: {
    goal_shape: string;
    goal_text?: string | null;
    /** Best `artifact_fit` value across retrieved act_artifact candidates
     *  (the breakdown component, in [0,1]). undefined/0 candidates = none. */
    best_fit: number;
    candidate_count: number;
    /** Fail-closed gate: true only when the dispatch context says the goal
     *  wants an executable artifact (e.g. action/agent route, or the goal's
     *  semantic neighborhood retrieved act_artifact candidates). The CALLER
     *  derives this from substrate dispatch state — NOT a regex classifier. */
    wants_artifact: boolean;
  },
  opts: { emit?: (e: Parameters<typeof emitEvent>[1]) => void; nowMs?: number } = {},
): ProactiveGapDecision => {
  const decision: ProactiveGapDecision = {
    opened: false,
    skip_reason: null,
    goal_shape: input.goal_shape,
    best_fit: input.best_fit,
    candidate_count: input.candidate_count,
  };

  // Fail-closed: only fire for goals that genuinely want an artifact AND have
  // a non-empty goal_shape (an empty shape is an ambiguous context).
  if (!input.goal_shape) { decision.skip_reason = "ambiguous_context"; return decision; }
  if (!input.wants_artifact) { decision.skip_reason = "not_artifact_wanting"; return decision; }

  // A decent-fit artifact already serves this goal — no gap.
  const noCandidates = input.candidate_count <= 0;
  const poorFit = input.best_fit < PROACTIVE_GAP_FIT_THRESHOLD;
  if (!noCandidates && !poorFit) { decision.skip_reason = "good_fit_exists"; return decision; }

  // Debounce / bound: one open proactive gap per goal_shape, cooldown after
  // resolution, hard attempt-cap for persistently-unservable goal_shapes.
  const suppression = proactiveGapSuppressed(db, input.goal_shape, opts.nowMs);
  if (suppression.suppressed) {
    decision.skip_reason =
      suppression.reason === "attempt_cap" ? "suppressed_attempt_cap"
      : suppression.reason === "cooldown" ? "suppressed_cooldown"
      : "suppressed_open";
    return decision;
  }

  const evidenceStr = noCandidates
    ? `goal_shape ${input.goal_shape} retrieved 0 admitted act_artifact candidates at selection — unmet capability`
    : `goal_shape ${input.goal_shape} best candidate fit ${input.best_fit.toFixed(3)} < ${PROACTIVE_GAP_FIT_THRESHOLD} across ${input.candidate_count} candidate(s) — no fitting capability`;

  const opened = openCapabilityGap(
    db,
    {
      goal_shape: input.goal_shape,
      reason: "proactive_no_fit",
      trigger: "selection",
      evidence: evidenceStr,
      failing_artifact_id: null,
      artifact_kind: "unknown",
      goal_text: input.goal_text ?? null,
      fit_evidence: { best_fit: input.best_fit, candidate_count: input.candidate_count },
    },
    opts.emit,
  );
  decision.opened = true;
  decision.directive_id = opened.directive_id;
  return decision;
};

// Test-visible threshold mirrors (so tests assert against the live consts
// rather than re-hardcoding magic numbers).
export const CAPGAP_MIN_OBSERVATIONS_FOR_TEST = GAP_MIN_OBSERVATIONS;
export const CAPGAP_RESIDUAL_THRESHOLD_FOR_TEST = GAP_RESIDUAL_THRESHOLD;
export const CAPGAP_PROACTIVE_FIT_THRESHOLD_FOR_TEST = PROACTIVE_GAP_FIT_THRESHOLD;
export const CAPGAP_PROACTIVE_COOLDOWN_MS_FOR_TEST = PROACTIVE_GAP_COOLDOWN_MS;
export const CAPGAP_PROACTIVE_MAX_ATTEMPTS_FOR_TEST = PROACTIVE_GAP_MAX_ATTEMPTS;
