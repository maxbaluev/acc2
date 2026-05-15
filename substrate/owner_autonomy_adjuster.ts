// Outcome-driven adjuster for OwnerProfile.autonomy_score (universal,
// continuous, no enum). Closes the four-link credit chain (k_555) for
// the autonomy decision:
//
//   1. CREATE: auto-apply worker mutates a file under the
//      autonomy_score gate.
//   2. RETRIEVE: it cites the owner_profile_recorded row at gate-eval.
//   3. MUTATE: this adjuster (extractor tick) scans the SUBSEQUENT
//      applied_change_committed / applied_change_failed /
//      irreversible_effect_recorded events and adjusts autonomy_score
//      accordingly.
//   4. CREDIT: the new owner_profile_recorded carries the updated
//      score; the next auto-apply decision reads from it.
//
// Why this matters: without an adjuster, the score is "continuous" in
// type but static in practice — every owner sits at the default
// forever. The whole point of a learnable score is that the substrate
// EARNS the owner's trust through outcomes. One bad apply must mean
// something; ten good applies must mean something.
//
// Universal: same adjuster runs for every owner, but each owner's
// trajectory is unique (their own outcomes shape their own score).
// No bucketing, no "trusted owners get +X" — every event independently
// contributes.

import type { Database } from "bun:sqlite";
import { emitEvent } from "../runtime/events";
import type { JsonValue } from "./types";
import { OWNER_PROFILE_DEFAULTS } from "./types";

// ── Adjustment magnitudes ───────────────────────────────────────────
//
// Calibrated for a gradual rise (good outcomes need to accumulate) and
// a meaningful fall (a single bad outcome must register). The default
// score is 0.5; the multi-file threshold is 0.4. So:
//
//   - From the default, one applied_change_failed (-0.10) drops to 0.40,
//     right at the gate. The owner needs to recover (succeed a few
//     times) before multi-file applies resume — exactly the desired
//     "one failure tightens trust briefly" behavior.
//   - One irreversible_effect_recorded (-0.25) drops to 0.25, well
//     below the gate. Multi-file applies block until the score
//     recovers ~8 successful applies later.
//   - Each applied_change_committed contributes +0.02 — needs ~25
//     consecutive successes from a fresh owner to reach 1.0. Encourages
//     a measured ramp, not a single-success surge.

export const AUTONOMY_DELTA_ON_SUCCESS = 0.02;
export const AUTONOMY_DELTA_ON_FAILURE = -0.10;
export const AUTONOMY_DELTA_ON_IRREVERSIBLE = -0.25;

/** Confidence the adjuster claims on each emitted candidate. High
 *  (≥ 0.85) so the Layer-2 extractor's confidence-route auto-promotes
 *  without owner approval — outcomes ARE the owner's signal. */
export const AUTONOMY_ADJUSTER_CONFIDENCE = 0.9;

/** Window: how far back the adjuster looks for unprocessed outcome
 *  events. Idempotency is enforced via context_refs back-pointers —
 *  events whose ids already appear in a prior adjuster candidate's
 *  context_refs are skipped. The window is a perf bound, not a
 *  correctness bound. */
export const AUTONOMY_ADJUSTER_WINDOW = 200;

type OutcomeRow = {
  id: string;
  kind: string;
  ts: string;
};

/** Pure helper: given a starting score, a floor, and a list of outcome
 *  event kinds, compute the new score after applying each event's
 *  delta in chronological order, clamped to [floor, 1]. Floor honors
 *  the owner's autonomy_score_floor (substrate cannot drive trust
 *  below the owner-declared minimum). */
export const applyAutonomyAdjustments = (
  startingScore: number,
  floor: number,
  outcomeKinds: ReadonlyArray<string>,
): number => {
  let score = startingScore;
  for (const kind of outcomeKinds) {
    if (kind === "applied_change_committed") score += AUTONOMY_DELTA_ON_SUCCESS;
    else if (kind === "applied_change_failed") score += AUTONOMY_DELTA_ON_FAILURE;
    else if (kind === "irreversible_effect_recorded") score += AUTONOMY_DELTA_ON_IRREVERSIBLE;
    if (score > 1) score = 1;
    if (score < floor) score = floor;
  }
  return score;
};

const readLatestProfileScore = (db: Database): { score: number; floor: number } => {
  const row = db
    .query(
      `SELECT payload FROM events
       WHERE kind = 'owner_profile_recorded'
       ORDER BY ts DESC, rowid DESC
       LIMIT 1`,
    )
    .get() as { payload: string } | undefined;
  let score = OWNER_PROFILE_DEFAULTS.autonomy_score as number;
  let floor = 0;
  if (row?.payload) {
    try {
      const p = JSON.parse(row.payload) as Record<string, unknown>;
      if (typeof p.autonomy_score === "number") score = p.autonomy_score;
      if (typeof p.autonomy_score_floor === "number") floor = p.autonomy_score_floor;
    } catch {
      // fall through to defaults
    }
  }
  return { score, floor };
};

/** Find which outcome events have already been folded into a prior
 *  adjuster candidate. An adjuster candidate carries its consumed
 *  event ids in context_refs. */
const readConsumedOutcomeIds = (db: Database): Set<string> => {
  const rows = db
    .query(
      `SELECT context_refs FROM events
       WHERE kind = 'owner_insight_candidate'
         AND json_extract(payload, '$.field') = 'autonomy_score'
         AND json_extract(payload, '$.source') = 'autonomy_adjuster'
       ORDER BY ts DESC, rowid DESC
       LIMIT 50`,
    )
    .all() as Array<{ context_refs: string | null }>;
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.context_refs) continue;
    try {
      const arr = JSON.parse(r.context_refs) as unknown[];
      for (const x of arr) {
        if (typeof x === "string") seen.add(x);
      }
    } catch {
      // skip malformed refs
    }
  }
  return seen;
};

const readRecentOutcomeRows = (db: Database): OutcomeRow[] => {
  return db
    .query(
      `SELECT id, kind, ts FROM events
       WHERE kind IN ('applied_change_committed', 'applied_change_failed', 'irreversible_effect_recorded')
       ORDER BY ts ASC, rowid ASC
       LIMIT ?`,
    )
    .all(AUTONOMY_ADJUSTER_WINDOW) as OutcomeRow[];
};

export type AutonomyAdjusterSummary = {
  consumed: number;
  delta: number;
  prior_score: number;
  new_score: number;
  emitted: boolean;
};

/** One tick of the autonomy adjuster. Reads recent outcome events;
 *  skips ones already folded into a prior adjuster candidate; computes
 *  the new score; emits a single owner_insight_candidate when at least
 *  one unconsumed outcome exists. The Layer-2 extractor promotes via
 *  the confidence route (≥ 0.85). Pure on the data path: idempotent
 *  re-runs emit nothing when no new outcomes have landed. */
export const runOwnerAutonomyAdjusterTick = (db: Database): AutonomyAdjusterSummary => {
  const { score: priorScore, floor } = readLatestProfileScore(db);
  const consumed = readConsumedOutcomeIds(db);
  const outcomes = readRecentOutcomeRows(db);
  const unconsumed = outcomes.filter((r) => !consumed.has(r.id));
  if (unconsumed.length === 0) {
    return { consumed: 0, delta: 0, prior_score: priorScore, new_score: priorScore, emitted: false };
  }
  const newScore = applyAutonomyAdjustments(priorScore, floor, unconsumed.map((r) => r.kind));
  const delta = newScore - priorScore;
  // Skip emit if the score didn't move (e.g. all outcomes were clamped
  // by floor or ceiling). Saves a no-op candidate row.
  if (Math.abs(delta) < 1e-9) {
    return { consumed: unconsumed.length, delta: 0, prior_score: priorScore, new_score: newScore, emitted: false };
  }
  const eventIds = unconsumed.map((r) => r.id);
  const successCount = unconsumed.filter((r) => r.kind === "applied_change_committed").length;
  const failureCount = unconsumed.filter((r) => r.kind === "applied_change_failed").length;
  const irreversibleCount = unconsumed.filter((r) => r.kind === "irreversible_effect_recorded").length;
  emitEvent(db, {
    kind: "owner_insight_candidate",
    substrate_origin: "substrate_auto",
    payload: {
      field: "autonomy_score",
      value: newScore,
      confidence: AUTONOMY_ADJUSTER_CONFIDENCE,
      source: "autonomy_adjuster",
      claim: `autonomy_score adjusted from ${priorScore.toFixed(2)} to ${newScore.toFixed(2)} ` +
        `over ${unconsumed.length} outcome event(s): ` +
        `${successCount} success(es) (+${(successCount * AUTONOMY_DELTA_ON_SUCCESS).toFixed(2)}), ` +
        `${failureCount} failure(s) (${(failureCount * AUTONOMY_DELTA_ON_FAILURE).toFixed(2)}), ` +
        `${irreversibleCount} irreversible (${(irreversibleCount * AUTONOMY_DELTA_ON_IRREVERSIBLE).toFixed(2)})`,
      delta,
      prior_score: priorScore,
      floor,
    } as JsonValue,
    context_refs: eventIds,
  });
  return {
    consumed: unconsumed.length,
    delta,
    prior_score: priorScore,
    new_score: newScore,
    emitted: true,
  };
};
