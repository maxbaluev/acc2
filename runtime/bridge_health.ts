// acc2 bridge-health gate (Batch 8.A, 2026-05-15).
//
// Cites brain-authored lesson_extracted event 5SWP11NZFS3YX68Y95T164HT9W
// emitted by directive PPVP3S5V9506DA6A1BZ9ZCWPKW (the user's
// self-verification directive) at 2026-05-15T02:10:08.725Z. Summary:
//
//   "Agent-spawn/DAG completion audits must treat repeated bridge_stuck,
//    no_frames_received, mcp_handshake_failed, and
//    consecutive_bridge_failures_exceeded_cap as a current structural
//    blocker even when dispatcher_violation is zero and recipe replay
//    works."
//
//   proposed_action: "Add a pre-dispatch bridge-health gate or scheduler
//    backoff that pauses repeated opencode dispatch after
//    bridge_stuck/no-frame streaks and opens a diagnostic task instead
//    of spawning duplicate stale dispatches."
//
// The brain identified that the existing per-task `consecutive_bridge_failures`
// cap (runtime/task_scheduler.ts) is too narrow — it counts failures on ONE
// task and quarantines that task only. But when the bridge itself is sick
// (transient OpenAI / network / opencode-subprocess issues), MULTIPLE tasks
// fail in rapid succession across DIFFERENT directives. Each waits its own
// 3-failure cap before quarantining; meanwhile slot churn keeps re-spawning
// doomed opencode subprocesses, burning tokens and amplifying instability.
//
// This module adds a GLOBAL bridge-health gate that observes failures across
// all tasks. When ≥ BRIDGE_DEGRADATION_THRESHOLD bridge_failed events
// land within BRIDGE_FAILURE_WINDOW_MS, the substrate emits
// `bridge_health_degraded` and the scheduler refuses to dispatch new
// opencode_brain calls until BRIDGE_HEALTH_COOLDOWN_MS has elapsed
// without further failures. substrate_replay (Tier-0 recipe) and
// claude_inline lanes remain available — only the brain lane is paused.
//
// On cooldown expiry, `bridge_health_recovered` fires and the gate clears.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { emitEvent } from "./events";

/** Window over which bridge_failed events accumulate toward the
 *  degradation threshold. 60s gives enough span to detect "system is
 *  sick right now" while ignoring single transient blips. */
export const BRIDGE_FAILURE_WINDOW_MS = 60_000;

/** Bridge_failed count within BRIDGE_FAILURE_WINDOW_MS that flips the
 *  gate to degraded. 3 is the same threshold the per-task cap uses; at
 *  the global scope it means "3 failures across the whole substrate
 *  within 60s = systemic, not a single-task glitch". */
export const BRIDGE_DEGRADATION_THRESHOLD = 3;

/** Base cooldown — after flipping to degraded, the gate stays closed
 *  for at least this long WITHOUT further failures before clearing.
 *  30s gives transient OpenAI / opencode-subprocess issues time to
 *  resolve while still resuming dispatch promptly when the bridge is
 *  healthy. The EFFECTIVE cooldown grows exponentially on consecutive
 *  rapid re-degrades — see effectiveCooldownMs() below. */
export const BRIDGE_HEALTH_COOLDOWN_MS = 30_000;

/** Cap on the effective cooldown — even after many consecutive
 *  re-degrades, the gate releases at this ceiling so we never lock
 *  the brain lane out permanently. 10 min lets the operator notice
 *  and intervene before the lockout becomes a foot-gun. */
export const BRIDGE_HEALTH_COOLDOWN_CAP_MS = 600_000;

/** Window over which we count recent `bridge_health_degraded`
 *  emissions for the exponential-backoff calculation. A re-degrade
 *  inside this window is treated as "the same storm" and doubles
 *  the cooldown. Outside the window, the streak resets. */
export const BRIDGE_HEALTH_BACKOFF_WINDOW_MS = 10 * 60_000;

/** Count `bridge_health_degraded` events in the trailing
 *  BRIDGE_HEALTH_BACKOFF_WINDOW_MS. Used to grow the cooldown:
 *  effective = base * 2^(degradeCount-1), capped at the cap. */
const recentDegradeCount = (db: Database, nowMs: number): number => {
  const cutoffIso = new Date(nowMs - BRIDGE_HEALTH_BACKOFF_WINDOW_MS).toISOString();
  const row = db
    .query(
      `SELECT COUNT(*) AS c FROM events WHERE kind = 'bridge_health_degraded' AND ts >= ?`,
    )
    .get(cutoffIso) as { c: number };
  return row.c;
};

/** Effective cooldown for the CURRENT recovery attempt — base * 2^(N-1)
 *  where N is the count of bridge_health_degraded events in the
 *  trailing backoff window (including the in-progress one). Capped at
 *  BRIDGE_HEALTH_COOLDOWN_CAP_MS so the brain lane is never locked
 *  permanently. */
export const effectiveCooldownMs = (db: Database, nowMs?: number): number => {
  const n = recentDegradeCount(db, nowMs ?? Date.now());
  if (n <= 1) return BRIDGE_HEALTH_COOLDOWN_MS;
  const exp = Math.min(15, n - 1); // 2^15 safety against overflow
  const scaled = BRIDGE_HEALTH_COOLDOWN_MS * Math.pow(2, exp);
  return Math.min(BRIDGE_HEALTH_COOLDOWN_CAP_MS, scaled);
};

/** True iff the gate is currently closed: a `bridge_health_degraded`
 *  has fired with no subsequent `bridge_health_recovered`. */
export const isBridgeHealthDegraded = (db: Database): boolean => {
  const latest = db
    .query(
      `SELECT kind FROM events
       WHERE kind IN ('bridge_health_degraded', 'bridge_health_recovered')
       ORDER BY ts DESC, rowid DESC LIMIT 1`,
    )
    .get() as { kind: string } | null;
  if (!latest) return false;
  return latest.kind === "bridge_health_degraded";
};

/** Count bridge_failed events within the last BRIDGE_FAILURE_WINDOW_MS.
 *  Used by maybeMarkDegraded and surfaced in the degraded event payload
 *  so the operator can see the trigger condition. */
const recentBridgeFailures = (
  db: Database,
  nowMs: number,
): { distinct_task_count: number; failure_event_count: number; cutoff_iso: string } => {
  const cutoffIso = new Date(nowMs - BRIDGE_FAILURE_WINDOW_MS).toISOString();
  const row = db
    .query(
      `SELECT
         COUNT(*) AS failure_event_count,
         COUNT(DISTINCT COALESCE(NULLIF(task_id, ''), id)) AS distinct_task_count
       FROM events
       WHERE kind = 'bridge_failed' AND ts >= ?`,
    )
    .get(cutoffIso) as { failure_event_count: number; distinct_task_count: number };
  return {
    distinct_task_count: row.distinct_task_count,
    failure_event_count: row.failure_event_count,
    cutoff_iso: cutoffIso,
  };
};

/** Emit `bridge_health_degraded` once when:
 *    (a) the gate is currently OPEN (not already degraded), AND
 *    (b) ≥ BRIDGE_DEGRADATION_THRESHOLD bridge_failed events exist
 *        within the BRIDGE_FAILURE_WINDOW_MS window.
 *  Returns true when an event was emitted. Idempotent across repeated
 *  calls — the open-gate precondition prevents double-emits. The
 *  emitted payload carries the effective cooldown (exponential backoff
 *  on rapid re-degrades) so observers can see when the gate releases. */
export const maybeMarkDegraded = (
  db: Database,
  opts?: { nowMs?: number },
): boolean => {
  if (isBridgeHealthDegraded(db)) return false;
  const nowMs = opts?.nowMs ?? Date.now();
  const { distinct_task_count, failure_event_count, cutoff_iso } = recentBridgeFailures(db, nowMs);
  if (distinct_task_count < BRIDGE_DEGRADATION_THRESHOLD) return false;
  // Count THIS degrade as the next one in the backoff streak — the
  // cooldown we publish is what the upcoming recovery check will use.
  const projectedDegrades = recentDegradeCount(db, nowMs) + 1;
  const projectedCooldownMs = Math.min(
    BRIDGE_HEALTH_COOLDOWN_CAP_MS,
    BRIDGE_HEALTH_COOLDOWN_MS * Math.pow(2, Math.min(15, Math.max(0, projectedDegrades - 1))),
  );
  emitEvent(db, {
    kind: "bridge_health_degraded",
    substrate_origin: "substrate_auto",
    payload: {
      reason: "bridge_failure_streak_exceeded",
      distinct_task_count,
      failure_event_count,
      window_ms: BRIDGE_FAILURE_WINDOW_MS,
      threshold: BRIDGE_DEGRADATION_THRESHOLD,
      window_cutoff_iso: cutoff_iso,
      recent_degrade_streak: projectedDegrades,
      effective_cooldown_ms: projectedCooldownMs,
      base_cooldown_ms: BRIDGE_HEALTH_COOLDOWN_MS,
      cooldown_cap_ms: BRIDGE_HEALTH_COOLDOWN_CAP_MS,
      cite_brain_lesson: "5SWP11NZFS3YX68Y95T164HT9W",
    } as JsonValue,
  });
  return true;
};

/** Emit `bridge_health_recovered` once when:
 *    (a) the gate is currently CLOSED (degraded), AND
 *    (b) ZERO bridge_failed events have landed within the EFFECTIVE
 *        cooldown — base * 2^(streak-1), capped at the cap. On the
 *        first degrade in a quiet window, this is the 30s base. On
 *        consecutive rapid re-degrades it grows: 60s, 120s, 240s, …
 *  Returns true when an event was emitted. Called on each supervisor
 *  tick; cheap (two count queries). */
export const maybeMarkRecovered = (
  db: Database,
  opts?: { nowMs?: number },
): boolean => {
  if (!isBridgeHealthDegraded(db)) return false;
  const nowMs = opts?.nowMs ?? Date.now();
  const cooldownMs = effectiveCooldownMs(db, nowMs);
  const cutoffIso = new Date(nowMs - cooldownMs).toISOString();
  const row = db
    .query(
      `SELECT COUNT(*) AS c FROM events WHERE kind = 'bridge_failed' AND ts >= ?`,
    )
    .get(cutoffIso) as { c: number };
  if (row.c > 0) return false;
  emitEvent(db, {
    kind: "bridge_health_recovered",
    substrate_origin: "substrate_auto",
    payload: {
      cooldown_ms: cooldownMs,
      base_cooldown_ms: BRIDGE_HEALTH_COOLDOWN_MS,
      cooldown_cap_ms: BRIDGE_HEALTH_COOLDOWN_CAP_MS,
      cite_brain_lesson: "5SWP11NZFS3YX68Y95T164HT9W",
    } as JsonValue,
  });
  return true;
};
