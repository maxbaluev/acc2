// acc2 substrate compaction (Batch 10, 2026-05-15) — owner directive:
//   "make most reactive smart and fast and universal and elegant and
//    efficient organism on planet"
//
// The substrate's events table is append-only AND unbounded. Live evidence
// (15030 events after one operator session) showed 44% of rows are
// `bridge_frame_received` — opencode subprocess JSON-event frames the
// bridge mirrors for cycle-1 enforcement AND audit. Once a dispatch closes
// (brain_dispatch_closed lands), these frames are observation-only — no
// view, no scheduler path, no extractor, no retrieval surface consumes
// them. They bloat the row count, slow SQL scans, and inflate WAL.
//
// Compaction is a periodic worker that PRUNES `bridge_frame_received`
// older than COMPACTION_FRAME_RETENTION_MS for dispatches that have
// already closed. The dispatch ID itself, brain_dispatched, and the
// closing event all stay forever — only the per-frame mirror is removed.
//
// Why pruning, not archival to a frozen table:
//   - The frames are mirror data — the canonical signal is the
//     `brain_dispatch_closed` row + its `events_count` field. Recovering
//     the raw frames requires re-running the dispatch, not reading an
//     archive.
//   - Operators inspecting recent flow use `acc events --kind ...` which
//     queries the live events table. An archive table that operators
//     never query is dead weight.
//   - SQLite handles row deletes well with WAL + VACUUM. The integrity
//     worker already runs WAL checkpoint.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { emitEvent } from "./events";
import { logger } from "./logger";
import { evaluateLedgerCurationPressure } from "./archival_worker";

/** Retention window. Frames older than this are eligible for pruning.
 *  24 h gives operators a full day to inspect a closed dispatch via
 *  `acc events` before the frames vanish. This constant is the deterministic
 *  fallback for a learned compaction policy: observed audit-window demand,
 *  frame-volume pressure, bridge failure debugging value, boot/readiness cost,
 *  and prompt-composition cost should drive the threshold through scored
 *  evidence rather than another universal magic number. */
export const COMPACTION_FRAME_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Cap on rows pruned per tick. Keeps the compaction worker bounded so it
 *  never holds the DB write lock for long. 5000/tick × hourly = 120k/day
 *  in steady state, far above realistic frame volume. */
export const COMPACTION_BATCH_SIZE = 5_000;

/** Derived-telemetry kinds the compaction worker prunes once aged past
 *  COMPACTION_DERIVED_RETENTION_MS. Amendment SVB4GRXZ7H13QB1S8Z8RE0S7H4:
 *  live evidence showed state.db at 1.37 GB / 438k events over 12 days, with
 *  compaction pruning ONLY bridge_frame_received (~1.5% of the ledger) while
 *  uncompacted telemetry dominated → unbounded hot-ledger growth → slow boot.
 *
 *  This set is DELIBERATELY CONSERVATIVE — every member is a pure
 *  observation/telemetry kind already classified prunable by the archival
 *  worker (runtime/archival_worker.ts) with NO downstream view / extractor /
 *  credit / retrieval consumer beyond its active dispatch window:
 *    - worker_tick_completed / sql_worker_pool_metrics — DROP_KINDS:
 *      "pure operational telemetry … ZERO credit/knowledge/owner value, no
 *      downstream references."
 *    - brain_reasoning_recorded — EPHEMERAL_TELEMETRY_KINDS: read only inside
 *      the scheduler's RESEARCH_GRACE window (minutes-scale, ≤4 dispatches);
 *      views.ts references are comments only; archival evicts it at a 1h TTL,
 *      so a 7-day hot retention is amply safe.
 *
 *  Convergence fix (2026-05-26): live ledger at ~37k events was dominated by
 *  high-volume pure-telemetry kinds NOT in this set, starving the aux read
 *  server (read_path_starved → degraded flaps). Four more telemetry kinds are
 *  added — each verified (grep of every runtime/ reader) to have NO
 *  full-history reader, so age-based pruning past the retention window is safe:
 *    - brain_liveness_heartbeat — pure liveness telemetry; emitted by
 *      runtime/bridge/opencode.ts, ZERO DB readers (only emitters + comments).
 *    - sandbox_unenforced_warning — warning telemetry; emitted by
 *      artifact_admission.ts / runtimes/bun.ts, ZERO DB readers.
 *    - task_deferred_for_interference — scheduler deferral notice; emitted by
 *      task_scheduler.ts, ZERO DB readers.
 *    - constitutional_gate_decision — admission-decision telemetry. HAS two DB
 *      readers, both RECENCY-bounded, never full-history: prompt_composer.ts
 *      (`ORDER BY ts DESC LIMIT 10`) and owner_notification_worker.ts
 *      (`ORDER BY ts ASC LIMIT 100` deduped within a 1h window — fires once per
 *      fresh trigger, never replays week-old rows). resource_governor.ts /
 *      dispatch_decider.ts / task_scheduler.ts references are comments or
 *      emitters only. Active tasks always carry recent gate rows; rows older
 *      than the retention window belong to closed/abandoned tasks → safe.
 *
 *  Two kinds from the proposal were EXCLUDED as load-bearing:
 *    - candidate_confirmed — the credit/retrieval citation-binding mechanism
 *      (runtime/credit.ts, runtime/dense_closure_credit.ts) and a live
 *      credit_projection consumer in substrate/views.ts. Pruning it would
 *      sever the causal credit spine. Never compacted here.
 *    - origin_calibration_recorded — the archival worker rolls these up into
 *      telemetry_origin_calibration_rollup (retainOriginCalibrationAggregates)
 *      BEFORE eviction; a plain DELETE would silently lose calibration health
 *      aggregates. Excluded until/unless an aggregate-preserving path exists. */
export const COMPACTABLE_DERIVED_EVENT_KINDS: readonly string[] = [
  "brain_reasoning_recorded",
  "worker_tick_completed",
  "sql_worker_pool_metrics",
  "brain_liveness_heartbeat",
  "sandbox_unenforced_warning",
  "task_deferred_for_interference",
  "constitutional_gate_decision",
];

/** HIGH-RATE pure-telemetry kinds. Convergence fix (2026-05-26): these kinds
 *  are emitted per-operation at very high volume (measured: constitutional_gate
 *  _decision ~116/min — one per dispatch admission — accumulating ~167k rows
 *  before the derived MIN (1d) pruned them). They are observation-only with
 *  ZERO full-history readers (constitutional_gate_decision's only readers are
 *  recency-bounded ORDER BY ts DESC LIMIT 10/100; the rest have no DB reader),
 *  so a much shorter retention is safe. They get a dedicated 1h tier instead of
 *  the 7d/1d derived window so the hot ledger stays bounded under steady load.
 *
 *  Every member is ALSO a member of COMPACTABLE_DERIVED_EVENT_KINDS — the
 *  high-rate tier only chooses a SHORTER cutoff for these specific kinds; the
 *  remaining derived kinds keep the 7d/1d pressure window. bridge_frame_received
 *  is intentionally NOT here: it has its own lifecycle-gated 24h prune path
 *  (compactBridgeFrames) which the 1h tier does not touch — the two passes
 *  delete disjoint rows (this set is frame-free), so there is no double-delete. */
export const HIGH_RATE_TELEMETRY_KINDS: readonly string[] = [
  "constitutional_gate_decision",
  "bridge_frame_received",
  "worker_tick_completed",
  "task_deferred_for_interference",
  "brain_liveness_heartbeat",
  "sandbox_unenforced_warning",
];

/** Retention window for high-rate pure-telemetry kinds (HIGH_RATE_TELEMETRY_
 *  KINDS). 1 hour by default — these are emitted per-operation and have no
 *  full-history reader, so a short window keeps the hot ledger bounded under
 *  steady load. Env-overridable via ACC2_COMPACTION_HIGHRATE_RETENTION_MS for
 *  operators who need a longer debugging window. The value is read once at
 *  module load; pass `highRateRetentionMs` to compactDerivedEvents to override
 *  per-call (tests do this). */
const parseHighRateRetentionEnv = (): number => {
  const raw = process.env.ACC2_COMPACTION_HIGHRATE_RETENTION_MS;
  if (raw === undefined) return 60 * 60 * 1000; // 1h default
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 60 * 60 * 1000;
};
export const COMPACTION_HIGHRATE_RETENTION_MS = parseHighRateRetentionEnv();

/** Retention window for derived telemetry. Rows of a
 *  COMPACTABLE_DERIVED_EVENT_KINDS kind older than this are eligible to prune.
 *  7 days keeps a generous debugging window while bounding the hot ledger.
 *  Mirrors the deterministic-fallback rationale of the frame retention: a
 *  learned policy should eventually drive this through scored evidence. */
export const COMPACTION_DERIVED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Floor for the pressure-compressed derived-telemetry retention. Even at
 *  maximum ledger pressure, derived telemetry stays hot for at least this
 *  long so the most recent debugging window is preserved. */
export const COMPACTION_DERIVED_MIN_RETENTION_MS = 24 * 60 * 60 * 1000; // 1d

/** Map ledger pressure in [0,1] to a derived-telemetry retention window.
 *  pressure=0 → 7-day default; pressure=1 → 1-day floor. Shares the
 *  archival worker's pressure signal so compaction and archival compress
 *  on the SAME trigger (one policy, not two magic numbers). */
export const derivedRetentionForPressure = (pressure: number): number => {
  const p = Math.max(0, Math.min(1, pressure));
  const span = COMPACTION_DERIVED_RETENTION_MS - COMPACTION_DERIVED_MIN_RETENTION_MS;
  return Math.round(COMPACTION_DERIVED_RETENTION_MS - p * span);
};

export type CompactionReport = {
  pruned_frames: number;
  pruned_derived: number;
  cutoff_iso: string;
};

/** Prune bridge_frame_received rows older than the retention window AND
 *  whose dispatch has already closed (brain_dispatch_closed / task_failed
 *  / task_committed on the same task_id, at >= the frame's ts). Returns
 *  the number of rows actually deleted. Idempotent; safe to call
 *  repeatedly. */
export const compactBridgeFrames = (
  db: Database,
  opts?: { nowMs?: number; batchSize?: number },
): CompactionReport => {
  const nowMs = opts?.nowMs ?? Date.now();
  const batchSize = opts?.batchSize ?? COMPACTION_BATCH_SIZE;
  const cutoffIso = new Date(nowMs - COMPACTION_FRAME_RETENTION_MS).toISOString();

  // Frames whose owning task has a terminal event AT OR AFTER the frame's
  // ts are safe to prune. A frame older than `cutoffIso` whose dispatch is
  // still in-flight (no closing event) stays — the bridge may still be
  // consuming it. In practice all >24h frames have closed long ago.
  const result = db
    .query(
      `DELETE FROM events WHERE id IN (
         SELECT f.id FROM events f
         WHERE f.kind = 'bridge_frame_received'
           AND f.ts < ?
           AND EXISTS (
             SELECT 1 FROM events c
             WHERE c.task_id = f.task_id
               AND c.kind IN ('brain_dispatch_closed', 'task_committed', 'task_failed', 'task_abandoned')
               AND c.ts >= f.ts
           )
         LIMIT ?
       )`,
    )
    .run(cutoffIso, batchSize);

  const pruned = Number(result.changes ?? 0);
  return { pruned_frames: pruned, pruned_derived: 0, cutoff_iso: cutoffIso };
};

/** Resolve the retention window (ms) for a single derived-telemetry kind.
 *  HIGH_RATE_TELEMETRY_KINDS get the short 1h high-rate window; every other
 *  compactable derived kind gets the (pressure-compressed) derived window.
 *  This is the per-kind cutoff selector the prune passes thread their tier
 *  through — a kind in BOTH sets resolves to the high-rate (shorter) window. */
export const retentionForKind = (
  kind: string,
  opts?: { derivedRetentionMs?: number; highRateRetentionMs?: number },
): number => {
  const derivedMs = opts?.derivedRetentionMs ?? COMPACTION_DERIVED_RETENTION_MS;
  const highRateMs = opts?.highRateRetentionMs ?? COMPACTION_HIGHRATE_RETENTION_MS;
  return HIGH_RATE_TELEMETRY_KINDS.includes(kind) ? highRateMs : derivedMs;
};

/** Bounded prune of a set of derived kinds older than `cutoffIso`. Shared by
 *  both tiers; LIMIT keeps the write-lock window bounded. */
const pruneKindsOlderThan = (
  db: Database,
  kinds: readonly string[],
  cutoffIso: string,
  batchSize: number,
): number => {
  if (kinds.length === 0 || batchSize <= 0) return 0;
  const placeholders = kinds.map(() => "?").join(", ");
  const result = db
    .query(
      `DELETE FROM events WHERE id IN (
         SELECT id FROM events
         WHERE kind IN (${placeholders})
           AND ts < ?
         LIMIT ?
       )`,
    )
    .run(...kinds, cutoffIso, batchSize);
  return Number(result.changes ?? 0);
};

/** Prune aged derived-telemetry rows (COMPACTABLE_DERIVED_EVENT_KINDS), bounded
 *  by batchSize. Returns the total number of rows deleted across both tiers.
 *  Idempotent; safe to call repeatedly.
 *
 *  Two-tier retention (convergence fix 2026-05-26):
 *    - HIGH_RATE_TELEMETRY_KINDS (per-operation telemetry) are pruned past the
 *      short 1h high-rate window (COMPACTION_HIGHRATE_RETENTION_MS, env-
 *      overridable) — so they are evicted even when younger than the derived
 *      1d floor. bridge_frame_received is in the high-rate set but is NOT
 *      pruned here (it has its own lifecycle-gated compactBridgeFrames path);
 *      excluding it from this pass means the two prune passes touch disjoint
 *      rows — no double-delete, fully idempotent.
 *    - All OTHER compactable derived kinds keep the existing (pressure-
 *      compressed) 7d/1d derived window.
 *
 *  Unlike compactBridgeFrames, these kinds carry no per-task dispatch lifecycle
 *  — they are pure observation/telemetry with no downstream consumer past their
 *  short active window (see COMPACTABLE_DERIVED_EVENT_KINDS doc), so age alone
 *  is the prune predicate. load-bearing kinds (candidate_confirmed,
 *  origin_calibration_recorded) are intentionally NOT in either set. */
export const compactDerivedEvents = (
  db: Database,
  opts?: {
    nowMs?: number;
    batchSize?: number;
    retentionMs?: number;
    highRateRetentionMs?: number;
  },
): number => {
  if (COMPACTABLE_DERIVED_EVENT_KINDS.length === 0) return 0;
  const nowMs = opts?.nowMs ?? Date.now();
  const batchSize = opts?.batchSize ?? COMPACTION_BATCH_SIZE;
  // Unified pressure-triggered curation (amendment
  // CS4WFHZM7H4TN425GRSW39ZVMG): the derived-telemetry prune shares the SAME
  // pressure policy as archival. The caller (compactionWorkerTick) computes
  // the compressed retention from ledger pressure and passes it here; under
  // no pressure this defaults to the 7-day window (original behavior). The
  // load-bearing carve-outs are unchanged: candidate_confirmed and
  // origin_calibration_recorded are NOT in COMPACTABLE_DERIVED_EVENT_KINDS,
  // so pressure can never cause them to be pruned here.
  const derivedRetentionMs = opts?.retentionMs ?? COMPACTION_DERIVED_RETENTION_MS;
  const highRateRetentionMs = opts?.highRateRetentionMs ?? COMPACTION_HIGHRATE_RETENTION_MS;

  // Tier split. bridge_frame_received owns its own lifecycle-gated path
  // (compactBridgeFrames) so it is dropped from BOTH derived passes here —
  // keeping the two prune passes' deleted rows disjoint (no double-delete).
  const highRateKinds = COMPACTABLE_DERIVED_EVENT_KINDS.filter(
    (k) => HIGH_RATE_TELEMETRY_KINDS.includes(k) && k !== "bridge_frame_received",
  );
  const standardKinds = COMPACTABLE_DERIVED_EVENT_KINDS.filter(
    (k) => !HIGH_RATE_TELEMETRY_KINDS.includes(k),
  );

  const highRateCutoffIso = new Date(nowMs - highRateRetentionMs).toISOString();
  const standardCutoffIso = new Date(nowMs - derivedRetentionMs).toISOString();

  // Each pass is independently bounded by batchSize so neither can wedge the
  // write lock; the high-rate pass runs first since it is the bloat driver.
  const prunedHighRate = pruneKindsOlderThan(db, highRateKinds, highRateCutoffIso, batchSize);
  const prunedStandard = pruneKindsOlderThan(db, standardKinds, standardCutoffIso, batchSize);
  return prunedHighRate + prunedStandard;
};

/** One compaction worker tick. Prunes frames + emits a substrate event
 *  with the result when pruning happened. Safe to call repeatedly. */
export const compactionWorkerTick = (db: Database): CompactionReport => {
  try {
    const nowMs = Date.now();
    const frameReport = compactBridgeFrames(db, { nowMs });
    // Unified pressure-triggered curation (amendment
    // CS4WFHZM7H4TN425GRSW39ZVMG): derive the compaction derived-telemetry
    // retention from the SAME ledger-pressure policy archival uses. Under no
    // pressure the window stays at COMPACTION_DERIVED_RETENTION_MS (7d). As
    // the hot ledger crosses its row-count / db-size soft cap, the window
    // compresses linearly toward a 1-day floor so derived telemetry is
    // pruned sooner — bounding the ledger by pressure, not solely by a fixed
    // age. evaluateLedgerCurationPressure is a pure read (row count + page
    // size); it does not mutate state or touch credit-spine kinds.
    const policy = evaluateLedgerCurationPressure(db, {} as never, nowMs);
    const derivedRetentionMs = derivedRetentionForPressure(policy.pressure);
    // High-rate pure-telemetry kinds (HIGH_RATE_TELEMETRY_KINDS) use the short
    // 1h tier (env-overridable) instead of the derived 7d/1d window — they
    // are emitted per-operation and would otherwise dominate the hot ledger.
    const prunedDerived = compactDerivedEvents(db, {
      nowMs,
      retentionMs: derivedRetentionMs,
      highRateRetentionMs: COMPACTION_HIGHRATE_RETENTION_MS,
    });
    const report: CompactionReport = {
      pruned_frames: frameReport.pruned_frames,
      pruned_derived: prunedDerived,
      cutoff_iso: frameReport.cutoff_iso,
    };
    if (report.pruned_frames > 0 || report.pruned_derived > 0) {
      try {
        emitEvent(db, {
          kind: "substrate_compacted",
          substrate_origin: "substrate_auto",
          payload: {
            pruned_frames: report.pruned_frames,
            pruned_derived: report.pruned_derived,
            cutoff_iso: report.cutoff_iso,
            retention_ms: COMPACTION_FRAME_RETENTION_MS,
            derived_retention_ms: derivedRetentionMs,
            derived_retention_ms_default: COMPACTION_DERIVED_RETENTION_MS,
            highrate_retention_ms: COMPACTION_HIGHRATE_RETENTION_MS,
            highrate_telemetry_kinds: HIGH_RATE_TELEMETRY_KINDS as unknown as JsonValue,
            ledger_pressure: policy.pressure,
            ledger_pressure_source: policy.pressure_source,
            ledger_row_count: policy.row_count,
            ledger_db_size_bytes: policy.db_size_bytes,
            compactable_derived_kinds: COMPACTABLE_DERIVED_EVENT_KINDS as unknown as JsonValue,
          } as JsonValue,
        });
      } catch (err) {
        logger.warn(
          { where: "compaction.emit", err: (err as Error).message },
          "substrate_compacted emit failed (rows already pruned)",
        );
      }
    }
    return report;
  } catch (err) {
    logger.warn(
      { where: "compaction.tick", err: (err as Error).message },
      "compaction tick failed",
    );
    return { pruned_frames: 0, pruned_derived: 0, cutoff_iso: new Date().toISOString() };
  }
};
