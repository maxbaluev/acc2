// acc2 Tier -1 floor — hot/cold archival worker.
//
// Per docs/Architecture.md commit 6b8ebea + brain KC from task TE6P3958
// (conf=0.86): "Hot/cold archival is the ONLY candidate that bounds default
// aggregate-query cost independently of event production rate."
//
// Live evidence (pre-fix): 301K events in 5.5 days, 746 MB state.db,
// projected 50 GB/year. Without bounded hot retention, every aggregate
// scan (`SELECT * FROM events WHERE ...`) grows linearly with event
// production. Hot/cold archival caps hot-DB row count at
// archival_retention_days × daily-rate; older rows are moved to monthly
// state-archive-YYYY-MM.db files and removed from the hot ledger.
//
// Sweep is:
//   1. Read archival_retention_days threshold (default 30).
//   2. SELECT events older than cutoff, bounded LIMIT 50000 per sweep.
//   3. Group by YYYY-MM bucket.
//   4. For each bucket, open state-archive-YYYY-MM.db (sibling of
//      stateDbPath), CREATE TABLE IF NOT EXISTS events mirroring
//      substrate/schema.sql, BEGIN TRANSACTION, INSERT OR IGNORE rows
//      in chunks of 1000, verify by sample (100 ids: count in archive
//      == count selected from hot), COMMIT, then DELETE on hot.
//   5. On verify mismatch: ROLLBACK archive, emit
//      archival_integrity_failed, leave hot untouched.
//   6. Emit archival_sweep_completed with the bucket map.
//
// Idempotent: INSERT OR IGNORE on (id) lets repeated sweeps land
// without duplication; the hot DELETE drains the row entirely on
// success. Fail-soft: any unexpected error logs + emits the integrity
// failure event but never crashes the daemon.

import type { Database } from "bun:sqlite";
import { Database as Sqlite } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import type { JsonValue } from "../substrate/types";
import { emitEvent } from "./events";
import { logger } from "./logger";
import { poolQuery } from "./sql_pool_singleton";
import { getThreshold } from "./threshold_registry";

export const ARCHIVAL_TICK_MS = 6 * 60 * 60 * 1000; // 6h
const SWEEP_LIMIT = 50_000;
const COPY_CHUNK = 1000;
const VERIFY_SAMPLE = 100;

// ── Mnemonic sovereignty curation (Lin et al. 2026, arXiv:2604.16548) ─
//
// "Mnemonic sovereignty protects not merely stored content but a system's
// sovereign capacity to govern its own past. Memory-lifecycle framework
// first asks what memory should represent, not just how to store it."
//
// Pre-fix: every event archived by age regardless of value. High-value
// (owner_observed_outcome_recorded) and decorative (worker_tick_completed)
// flowed identically into cold archives. Hot DB stayed bloated with
// low-signal events while owner-channel evidence aged into cold storage.
//
// Policy: classify each event_kind into one of four curation modes:
//   - always_keep: never archive (owner-channel, root commits, high-score
//                  promotions). These stay in HOT permanently.
//   - archive_cold: current move-by-age behavior (default).
//   - compress_summary: high-volume telemetry kinds get aggregated into
//                       hourly summary rows; originals dropped.
//   - drop: pure noise (resolved transient errors); purge without archive.
export type CurationMode = "always_keep" | "archive_cold" | "compress_summary" | "drop" | "evict";

const ALWAYS_KEEP_KINDS = new Set<string>([
  // Owner-channel evidence: rarest + highest value.
  "owner_observed_outcome_recorded",
  "owner_input_received",
  "owner_input_required",
  "owner_decision_recorded",
  "owner_insight_candidate",
  "owner_profile_recorded",
  // Knowledge graph backbone.
  "knowledge_promoted",
  "contract_amendment_proposed",
  "closure_blocked_high_residual",
  "closure_override_acknowledged",
  // Tier -1 floor violations (rare; load-bearing for audit).
  "integrity_check_failed",
  "memory_reconciliation_drift_detected",
  "owner_identity_discontinuity",
  // Constitutional events.
  "constitutional_ratification_recorded",
  "constitutional_ratification_refused",
  // Causal spine + substrate memory: these compound and must remain hot.
  "task_committed",
  "task_closure_audited",
  "act_tuple_recorded",
  "action_predicted",
  "action_scored",
  "causal_edge_observed",
  "causal_edge_credited",
  "retrieval_credit_attributed",
  "knowledge_candidate",
  "act_artifact_candidate",
  "act_artifact_admitted",
  "act_artifact_promoted",
  "lesson_extracted",
]);

const COMPRESS_SUMMARY_KINDS = new Set<string>([
  // High-volume telemetry — aggregate to hourly summary.
  "worker_tick_completed",
  "sql_worker_pool_metrics",
  "event_authenticity_check",
  "storage_integrity_check",
  "wal_checkpointed",
  "memory_reconciliation_completed",
  "sahoo_diagnostics_recorded",
  "kernel_sandbox_check",
  "owner_identity_check",
  "deterministic_computation_check",
]);

const NOISY_OPERATIONAL_ARCHIVE_KINDS = new Set<string>([
  // Operational telemetry: not load-bearing after 30 days, but preserve
  // provenance in the monthly archive instead of keeping it hot forever.
  "father_yielded",
  // 2026-05-23 event-class tiering: artifact_kind_inference_uncertain moved
  // OUT of archive_cold and INTO EPHEMERAL_TELEMETRY_KINDS — its only
  // consumer is a lifetime health COUNT(*) (now backed by a retained
  // aggregate), so a short-TTL hot purge is correct; the 30-day move-to-cold
  // never fired on a young DB and let 10K+ rows accumulate hot.
]);

const DROP_KINDS = new Set<string>([
  // Pure noise that doesn't need archive (recovered transient errors).
  "knowledge_candidate_redundant",
  // 2026-05-21 Tier 5 T5.1: pure operational telemetry — liveness/metrics
  // with ZERO credit/knowledge/owner value, no downstream references. On a
  // young high-volume DB these dominate the event table (worker_tick_completed
  // alone was 11K of 326K) and bloat every worker scan; age-based archival
  // (30-day cutoff) never prunes them on a <30-day-old DB. Drop them after a
  // SHORT retention (DROP_RETENTION_DAYS) so the hot ledger stays bounded.
  // NONE of these are in ALWAYS_KEEP, and none are cited by credit/retrieval.
  "worker_tick_completed",
  "worker_tick_overrun",
  "bridge_frame_received",
  "sql_worker_pool_metrics",
]);

// ── Event-class tiering: ephemeral telemetry eviction (2026-05-23) ───
//
// The hot `events` table conflates DURABLE compounding memory (knowledge,
// act_artifacts, amendments, credit posteriors, lifecycle) with DISPOSABLE
// process telemetry. The latter has zero compounding/credit/retrieval value
// yet dominates row count on a young high-volume DB (live evidence: ~403K
// rows / 1 GB, ~80-90% pure telemetry), slowing prompt composition, boot,
// and every MCP aggregate scan.
//
// EPHEMERAL_TELEMETRY_KINDS is the EXPLICIT, AUDITABLE allowlist of kinds
// PROVEN safe-to-evict — each entry's only consumers are observability /
// health-counter aggregates (which now read a RETAINED running count, not
// the raw rows), NOT credit / retrieval / knowledge / lifecycle. The set is
// deliberately CONSERVATIVE: when a kind's eviction-safety is uncertain it
// is LEFT OUT. Eviction is a SHORT-TTL DELETE from the hot ledger via
// runTelemetryEvictionSweep, distinct from:
//   - DROP_KINDS (already-handled liveness/metrics; 2-day purge)
//   - the 30-day age-based move-to-cold archival sweep.
//
// Proof of safety (repo-wide grep, excl. node_modules/.claude — see the
// 2026-05-23 perf/event-class-tiering investigation):
//   recipe_promotion_deferred — DEFUNCT kind, absorbed into
//     knowledge_candidate/knowledge_promoted (event_kinds.ts ~L823). NOT
//     registered in EVENT_KINDS, NOT in any HEALTH_METRIC/EMBEDDABLE set,
//     never emitted by current code. The only references are a dead
//     cli/observe.ts narrative-render case + its test. ~18K legacy rows
//     in the live ledger with ZERO consumers. Purest possible evict.
//   artifact_kind_inference_uncertain — emitted per deferred row by
//     runtime/artifact_kind_backfill_worker.ts. Its idempotency guard
//     reads artifact_kind_inferred (NOT _uncertain), so eviction cannot
//     re-trigger emission. Sole consumer is the lifetime COUNT(*) in
//     cli/admin_substrate_status.ts (HEALTH_METRIC_KINDS). That count is
//     PRESERVED: the sweep increments meta["evicted_count:<kind>"] before
//     deleting, and admin-status reads live-rows + retained-count.
const EPHEMERAL_TELEMETRY_KINDS = new Set<string>([
  "recipe_promotion_deferred",
  "artifact_kind_inference_uncertain",
]);

// Short TTL — telemetry retains only recent-debugging value. Rows of an
// EPHEMERAL_TELEMETRY_KIND older than this are purged. Override via
// ACC2_TELEMETRY_EVICTION_RETENTION_HOURS.
const TELEMETRY_EVICTION_RETENTION_HOURS = (() => {
  const raw = process.env.ACC2_TELEMETRY_EVICTION_RETENTION_HOURS;
  if (typeof raw === "string" && raw.length > 0) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1) return n;
  }
  return 1;
})();

const EVICTED_COUNT_META_PREFIX = "evicted_count:";

/** Retained running count of rows evicted for a kind. Health/observability
 *  counters that previously read raw rows MUST add this to their live count
 *  so eviction does not silently shrink a lifetime metric. */
export const retainedEvictedCount = (db: Database, kind: string): number => {
  const row = db
    .query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?")
    .get(`${EVICTED_COUNT_META_PREFIX}${kind}`);
  if (!row) return 0;
  const n = parseInt(row.value, 10);
  return Number.isFinite(n) ? n : 0;
};

const bumpRetainedEvictedCount = (db: Database, kind: string, delta: number): void => {
  if (delta <= 0) return;
  const prior = retainedEvictedCount(db, kind);
  db.run(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [`${EVICTED_COUNT_META_PREFIX}${kind}`, String(prior + delta)],
  );
};

const adjustLiveRollup = (db: Database, kind: string, day: string, delta: number): void => {
  if (delta === 0) return;
  try {
    db.run("UPDATE event_kind_rollup SET live_count = MAX(0, live_count + ?) WHERE kind = ?", [delta, kind]);
    db.run("UPDATE event_day_kind_rollup SET live_count = MAX(0, live_count + ?) WHERE day = ? AND kind = ?", [delta, day, kind]);
  } catch { /* pre-rollup DBs are tolerated until migrations run */ }
};

const recordArchiveSummary = (db: Database, rows: Array<{ id: string; kind: string; ts: string }>, reason: string): void => {
  const buckets = new Map<string, { kind: string; hour: string; count: number; first_ts: string; last_ts: string }>();
  for (const row of rows) {
    const hour = row.ts.slice(0, 13);
    const key = `${row.kind}:${hour}`;
    const prior = buckets.get(key);
    if (!prior) buckets.set(key, { kind: row.kind, hour, count: 1, first_ts: row.ts, last_ts: row.ts });
    else {
      prior.count++;
      if (row.ts < prior.first_ts) prior.first_ts = row.ts;
      if (row.ts > prior.last_ts) prior.last_ts = row.ts;
    }
  }
  for (const summary of buckets.values()) {
    try {
      db.run(
        `INSERT INTO event_archive_summary (id, kind, bucket, count, first_ts, last_ts, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET count = excluded.count, first_ts = excluded.first_ts, last_ts = excluded.last_ts`,
        [`${reason}:${summary.kind}:${summary.hour}`, summary.kind, summary.hour, summary.count, summary.first_ts, summary.last_ts, reason, new Date().toISOString()],
      );
    } catch { /* summary is best-effort; deletion remains bounded */ }
  }
};

// Short retention for DROP_KINDS — telemetry needs ~recent debugging value
// only, not the 30-day archive window. Drop-class rows older than this are
// purged (not archived) by runDropSweep. Override via ACC2_DROP_RETENTION_DAYS.
const DROP_RETENTION_DAYS = (() => {
  const raw = process.env.ACC2_DROP_RETENTION_DAYS;
  if (typeof raw === "string" && raw.length > 0) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1) return n;
  }
  return 2;
})();

/** Per docs/Architecture.md commit 6b8ebea + Lin et al. 2026 mnemonic
 *  sovereignty: classify each event_kind into curation mode. Default
 *  archive_cold preserves the original behavior; the carve-out sets
 *  above add semantic curation.
 *
 *  Research frontier: this fixed classifier is the SAFE FALLBACK, not the
 *  final memory manager. A learned curation policy should later score
 *  keep / merge / archive / evict against downstream retrieval usefulness,
 *  closure/owner outcomes, boot/readiness cost, and prompt-composition cost,
 *  while preserving ALWAYS_KEEP and security/integrity carve-outs as hard
 *  floors. Do not add a parallel taxonomy; make the learned policy an
 *  act_artifact / promoted-knowledge bundle and keep this function as the
 *  deterministic fallback when the policy is absent or high residual. */
export const curationModeForKind = (kind: string): CurationMode => {
  if (EPHEMERAL_TELEMETRY_KINDS.has(kind)) return "evict";
  if (DROP_KINDS.has(kind)) return "drop";
  if (ALWAYS_KEEP_KINDS.has(kind)) return "always_keep";
  if (COMPRESS_SUMMARY_KINDS.has(kind)) return "compress_summary";
  if (NOISY_OPERATIONAL_ARCHIVE_KINDS.has(kind)) return "archive_cold";
  return "archive_cold";
};

// Mirror substrate/schema.sql events table columns (lines 34-56). Keep
// in lockstep — adding a column to schema.sql means adding it here.
const EVENTS_COLUMNS = [
  "id",
  "ts",
  "directive_id",
  "task_id",
  "parent_task_id",
  "loop_id",
  "substrate_origin",
  "kind",
  "payload",
  "context_refs",
  "predicted_residual",
  "action_artifact_id",
  "verifier_artifact_id",
  "outcome",
  "residual",
  "embedding",
  "embedding_version",
  "payload_hash",
  "blob_ref",
  "failure_kind",
  "invoker",
] as const;

const ARCHIVE_EVENTS_DDL = `
CREATE TABLE IF NOT EXISTS events (
  id                    TEXT PRIMARY KEY,
  ts                    TEXT NOT NULL,
  directive_id          TEXT NOT NULL,
  task_id               TEXT NOT NULL,
  parent_task_id        TEXT,
  loop_id               TEXT NOT NULL,
  substrate_origin      TEXT NOT NULL,
  kind                  TEXT NOT NULL,
  payload               TEXT NOT NULL,
  context_refs          TEXT NOT NULL DEFAULT '[]',
  predicted_residual    REAL,
  action_artifact_id    TEXT,
  verifier_artifact_id  TEXT,
  outcome               TEXT,
  residual              REAL,
  embedding             BLOB,
  embedding_version     TEXT,
  payload_hash          TEXT,
  blob_ref              TEXT,
  failure_kind          TEXT,
  invoker               TEXT
);
CREATE INDEX IF NOT EXISTS idx_archive_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_archive_events_kind_ts ON events(kind, ts);
`;

export type ArchivalSweepOptions = {
  stateDbPath: string;
  nowMs?: number;
  retentionDays?: number; // override; default reads from threshold registry
  sweepLimit?: number;
};

export type ArchivalSummary = {
  scanned: number;
  archived_by_month: Record<string, number>;
  deleted: number;
  errors: number;
  retention_days: number;
  cutoff_iso: string;
  emitted_event_id?: string;
  skipped: boolean;
};

const archivePathForMonth = (stateDbPath: string, yyyymm: string): string => {
  return join(dirname(stateDbPath), `state-archive-${yyyymm}.db`);
};

const monthBucket = (tsIso: string): string => {
  // YYYY-MM substring. Defensive — if ts is malformed, bucket the row
  // into a sentinel so the sweep can still complete and surface the
  // anomaly.
  if (typeof tsIso !== "string" || tsIso.length < 7) return "unknown";
  return tsIso.slice(0, 7);
};

type EventRowFull = {
  id: string;
  ts: string;
  directive_id: string;
  task_id: string;
  parent_task_id: string | null;
  loop_id: string;
  substrate_origin: string;
  kind: string;
  payload: string;
  context_refs: string;
  predicted_residual: number | null;
  action_artifact_id: string | null;
  verifier_artifact_id: string | null;
  outcome: string | null;
  residual: number | null;
  embedding: Uint8Array | null;
  embedding_version: string | null;
  payload_hash: string | null;
  blob_ref: string | null;
  failure_kind: string | null;
  invoker: string | null;
};

const openArchiveDb = (path: string): Database => {
  const db = new Sqlite(path, { create: true, strict: true });
  db.exec(ARCHIVE_EVENTS_DDL);
  return db;
};

/** One archival sweep. Idempotent — re-running has no effect when no
 *  rows fall past the cutoff or when the candidate ids are already in
 *  the archive AND already removed from hot. */
export const runArchivalSweep = async (
  hotDb: Database,
  opts: ArchivalSweepOptions,
): Promise<ArchivalSummary> => {
  const now = opts.nowMs ?? Date.now();
  const retentionDays =
    opts.retentionDays ?? getThreshold(hotDb, "archival_retention_days", 30);
  const cutoffMs = now - retentionDays * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();
  const limit = opts.sweepLimit ?? SWEEP_LIMIT;

  const summary: ArchivalSummary = {
    scanned: 0,
    archived_by_month: {},
    deleted: 0,
    errors: 0,
    retention_days: retentionDays,
    cutoff_iso: cutoffIso,
    skipped: false,
  };

  // 1. Select candidate rows from hot, bounded. Mnemonic-sovereignty
  // curation (Lin et al. 2026, arXiv:2604.16548): owner-channel +
  // knowledge-graph-backbone + Tier-1-floor-violation events are
  // ALWAYS_KEEP — excluded from the sweep so they stay in hot DB
  // permanently. Drop-class kinds are also excluded (purged separately
  // via a future drop sweep, not move-to-cold).
  const alwaysKeepList = Array.from(ALWAYS_KEEP_KINDS);
  const dropList = Array.from(DROP_KINDS);
  // Ephemeral-telemetry kinds are purged by runTelemetryEvictionSweep on a
  // SHORT TTL, never moved to cold — exclude them here so a row can't be
  // both archived and evicted.
  const evictList = Array.from(EPHEMERAL_TELEMETRY_KINDS);
  const exclusionList = [...alwaysKeepList, ...dropList, ...evictList];
  const exclusionPlaceholders = exclusionList.map(() => "?").join(",");
  // T3.8/T5: route the heavy candidate scan through the SQL worker-thread pool
  // when the daemon installed one (mirrors embedder.readUnembedded). This
  // SELECT walks the events table by ts on a large (700MB+) DB — running it on
  // the main loop under Bun's fake-async SQL blocks emitEvent + MCP IO for
  // seconds per 6h tick. poolQuery off-loads it to a worker thread and falls
  // back to the synchronous main-thread read when no pool (unit tests /
  // ACC2_DISABLE_SQL_POOL) — same rows, same order, same results.
  const candidateSql =
    `SELECT ${EVENTS_COLUMNS.join(", ")} FROM events
        WHERE ts < ?
          AND kind NOT IN (${exclusionPlaceholders})
        ORDER BY ts ASC
        LIMIT ?`;
  const candidates = await poolQuery<EventRowFull>(hotDb, candidateSql, [cutoffIso, ...exclusionList, limit]);
  summary.scanned = candidates.length;

  if (candidates.length === 0) {
    // Emit a no-op sweep summary so health-metric consumers see
    // continuity — absence of evidence vs evidence of absence.
    try {
      const emitted = emitEvent(hotDb, {
        kind: "archival_sweep_completed",
        substrate_origin: "substrate_auto",
        payload: {
          scanned: 0,
          archived_by_month: {},
          deleted: 0,
          errors: 0,
          retention_days: retentionDays,
          cutoff_iso: cutoffIso,
        } as JsonValue,
      });
      summary.emitted_event_id = emitted.id;
    } catch (err) {
      logger.warn(
        { where: "archival_worker.emit_empty", err: (err as Error).message },
        "archival_sweep_completed (empty) emit failed",
      );
    }
    return summary;
  }

  // 2. Group by YYYY-MM bucket.
  const buckets = new Map<string, EventRowFull[]>();
  for (const row of candidates) {
    const key = monthBucket(row.ts);
    let list = buckets.get(key);
    if (!list) {
      list = [];
      buckets.set(key, list);
    }
    list.push(row);
  }

  const placeholders = EVENTS_COLUMNS.map(() => "?").join(", ");
  const insertSql = `INSERT OR IGNORE INTO events (${EVENTS_COLUMNS.join(", ")}) VALUES (${placeholders})`;

  // 3. Per-bucket: open archive, transact, copy, verify, COMMIT (or
  //    ROLLBACK + integrity event), then DELETE from hot on success.
  for (const [yyyymm, rows] of buckets) {
    const archivePath = archivePathForMonth(opts.stateDbPath, yyyymm);
    let archiveDb: Database | null = null;
    try {
      archiveDb = openArchiveDb(archivePath);
      const insertStmt = archiveDb.prepare(insertSql);

      archiveDb.exec("BEGIN");
      let copiedThisBucket = 0;
      for (let i = 0; i < rows.length; i += COPY_CHUNK) {
        const chunk = rows.slice(i, i + COPY_CHUNK);
        for (const r of chunk) {
          insertStmt.run(
            r.id,
            r.ts,
            r.directive_id,
            r.task_id,
            r.parent_task_id,
            r.loop_id,
            r.substrate_origin,
            r.kind,
            r.payload,
            r.context_refs,
            r.predicted_residual,
            r.action_artifact_id,
            r.verifier_artifact_id,
            r.outcome,
            r.residual,
            r.embedding,
            r.embedding_version,
            r.payload_hash,
            r.blob_ref,
            r.failure_kind,
            r.invoker,
          );
          copiedThisBucket++;
        }
      }

      // 4. Verify — sample VERIFY_SAMPLE ids (or all when bucket
      //    smaller) and confirm presence inside the open transaction.
      const sampleIds: string[] = [];
      const step = Math.max(1, Math.floor(rows.length / VERIFY_SAMPLE));
      for (let i = 0; i < rows.length && sampleIds.length < VERIFY_SAMPLE; i += step) {
        sampleIds.push(rows[i].id);
      }
      const verifyPlaceholders = sampleIds.map(() => "?").join(", ");
      const verifyRow = archiveDb
        .query<{ c: number }, string[]>(
          `SELECT COUNT(*) AS c FROM events WHERE id IN (${verifyPlaceholders})`,
        )
        .get(...sampleIds);
      const archiveCount = verifyRow?.c ?? 0;
      if (archiveCount !== sampleIds.length) {
        archiveDb.exec("ROLLBACK");
        summary.errors++;
        try {
          emitEvent(hotDb, {
            kind: "archival_integrity_failed",
            substrate_origin: "substrate_auto",
            payload: {
              bucket: yyyymm,
              archive_path: archivePath,
              expected_count: sampleIds.length,
              archive_count: archiveCount,
              candidates_count: rows.length,
              copied_this_bucket: copiedThisBucket,
              reason: "verify_count_mismatch",
            } as JsonValue,
          });
        } catch (emitErr) {
          logger.warn(
            { where: "archival_worker.emit_integrity_fail", err: (emitErr as Error).message },
            "archival_integrity_failed emit failed",
          );
        }
        // Hot row untouched (no DELETE issued). Continue with next
        // bucket so a single corrupted archive can't starve the rest.
        continue;
      }

      archiveDb.exec("COMMIT");

      // 5. DELETE matching ids from hot. Chunk to keep the IN clause
      //    bounded.
      let deletedThisBucket = 0;
      for (let i = 0; i < rows.length; i += COPY_CHUNK) {
        const chunk = rows.slice(i, i + COPY_CHUNK);
        const ids = chunk.map((r) => r.id);
        const delPlaceholders = ids.map(() => "?").join(", ");
        hotDb.run(`DELETE FROM vec_events WHERE event_id IN (${delPlaceholders})`, ids);
        const result = hotDb.run(
          `DELETE FROM events WHERE id IN (${delPlaceholders})`,
          ids,
        );
        // bun:sqlite returns { changes } as `changes` property.
        const changes = (result as unknown as { changes?: number }).changes ?? 0;
        deletedThisBucket += changes;
        for (const r of chunk) adjustLiveRollup(hotDb, r.kind, r.ts.slice(0, 10), -1);
      }

      summary.archived_by_month[yyyymm] = copiedThisBucket;
      summary.deleted += deletedThisBucket;
    } catch (err) {
      summary.errors++;
      try {
        if (archiveDb) archiveDb.exec("ROLLBACK");
      } catch {
        /* swallow */
      }
      logger.warn(
        { where: "archival_worker.bucket", bucket: yyyymm, err: (err as Error).message },
        "archival sweep bucket failed",
      );
      try {
        emitEvent(hotDb, {
          kind: "archival_integrity_failed",
          substrate_origin: "substrate_auto",
          payload: {
            bucket: yyyymm,
            archive_path: archivePath,
            reason: "exception",
            error: (err as Error).message,
          } as JsonValue,
        });
      } catch (emitErr) {
        logger.warn(
          { where: "archival_worker.emit_integrity_fail", err: (emitErr as Error).message },
          "archival_integrity_failed emit failed (exception path)",
        );
      }
    } finally {
      if (archiveDb) {
        try {
          archiveDb.close();
        } catch {
          /* swallow */
        }
      }
    }
  }

  // 6. Emit terminal sweep summary on the hot ledger.
  try {
    const emitted = emitEvent(hotDb, {
      kind: "archival_sweep_completed",
      substrate_origin: "substrate_auto",
      payload: {
        scanned: summary.scanned,
        archived_by_month: summary.archived_by_month,
        deleted: summary.deleted,
        errors: summary.errors,
        retention_days: retentionDays,
        cutoff_iso: cutoffIso,
      } as JsonValue,
    });
    summary.emitted_event_id = emitted.id;
  } catch (err) {
    logger.warn(
      { where: "archival_worker.emit_summary", err: (err as Error).message },
      "archival_sweep_completed emit failed",
    );
  }

  return summary;
};

export type DropSweepSummary = {
  scanned: number;
  dropped: number;
  retention_days: number;
  cutoff_iso: string;
};

/** 2026-05-21 Tier 5 T5.1: bounded DROP-sweep. Purges DROP_KINDS rows older
 *  than DROP_RETENTION_DAYS WITHOUT archiving — they are pure operational
 *  noise (telemetry/metrics) with no credit/knowledge/owner value. This is
 *  the hot-retention boundary the age-based move-to-cold sweep can't provide
 *  on a young high-volume DB (nothing is >30 days old yet, so the bulk —
 *  worker_tick_completed / bridge_frame_received / sql_worker_pool_metrics —
 *  never gets pruned and bloats every worker scan). Bounded by `limit` per
 *  sweep (default SWEEP_LIMIT) so a single tick can't lock the writer.
 *  Idempotent + safe: only DROP_KINDS, only past the cutoff, ALWAYS_KEEP
 *  kinds can never enter DROP_KINDS by construction. */
export const runDropSweep = async (
  hotDb: Database,
  opts?: { retentionDays?: number; limit?: number; nowMs?: number },
): Promise<DropSweepSummary> => {
  const retentionDays = opts?.retentionDays ?? DROP_RETENTION_DAYS;
  const nowMs = opts?.nowMs ?? Date.now();
  const limit = opts?.limit ?? SWEEP_LIMIT;
  const cutoffIso = new Date(nowMs - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const dropList = Array.from(DROP_KINDS);
  const summary: DropSweepSummary = { scanned: 0, dropped: 0, retention_days: retentionDays, cutoff_iso: cutoffIso };
  if (dropList.length === 0) return summary;

  const ph = dropList.map(() => "?").join(", ");
  // Select candidate ids (bounded), then delete in chunks. ts comparison is
  // ISO-vs-ISO (cutoffIso is an ISO string) — index-friendly, no datetime()
  // string-format trap. Heavy READ scan → route through the SQL worker pool
  // when present (sync fallback when absent), mirroring readUnembedded.
  const ids = (await poolQuery<{ id: string }>(
    hotDb,
    `SELECT id FROM events WHERE kind IN (${ph}) AND ts < ? ORDER BY ts ASC LIMIT ?`,
    [...dropList, cutoffIso, limit],
  )).map((r) => r.id);
  summary.scanned = ids.length;
  if (ids.length === 0) return summary;

  const rowsForSummary = hotDb
    .query<{ id: string; kind: string; ts: string }, string[]>(`SELECT id, kind, ts FROM events WHERE id IN (${ids.map(() => "?").join(", ")})`)
    .all(...ids) as Array<{ id: string; kind: string; ts: string }>;
  recordArchiveSummary(hotDb, rowsForSummary, "drop");

  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const delPh = chunk.map(() => "?").join(", ");
    try {
      const result = hotDb.run(`DELETE FROM events WHERE id IN (${delPh})`, chunk);
      summary.dropped += (result as unknown as { changes?: number }).changes ?? 0;
      for (const id of chunk) {
        const row = rowsForSummary.find((r) => r.id === id);
        if (row) adjustLiveRollup(hotDb, row.kind, row.ts.slice(0, 10), -1);
      }
    } catch (err) {
      logger.warn({ where: "archival_worker.drop_sweep", err: (err as Error).message }, "drop-sweep chunk failed");
    }
  }
  try {
    emitEvent(hotDb, {
      kind: "archival_sweep_completed",
      substrate_origin: "substrate_auto",
      payload: { sweep_kind: "drop", scanned: summary.scanned, dropped: summary.dropped, retention_days: retentionDays, cutoff_iso: cutoffIso } as JsonValue,
    });
  } catch { /* fail-soft */ }
  if (summary.dropped > 0) {
    logger.info({ dropped: summary.dropped, retention_days: retentionDays }, "drop-sweep purged noise telemetry");
  }
  return summary;
};

export type TelemetryEvictionSummary = {
  scanned: number;
  evicted: number;
  by_kind: Record<string, number>;
  retention_hours: number;
  cutoff_iso: string;
  emitted_event_id?: string;
};

/** 2026-05-23 event-class tiering: bounded eviction sweep for
 *  EPHEMERAL_TELEMETRY_KINDS. DELETEs rows of those PROVEN-safe kinds older
 *  than a SHORT TTL (default 1h) from the hot `events` table — they carry
 *  zero compounding/credit/retrieval value. Before deleting, the lifetime
 *  count for each kind is preserved into meta["evicted_count:<kind>"] so
 *  observability/health counters that read raw rows can add the retained
 *  aggregate back and report correctly. Emits one telemetry_evicted event
 *  per non-empty sweep so the eviction is itself visible in the ledger.
 *
 *  Conservative + safe by construction: only EPHEMERAL_TELEMETRY_KINDS,
 *  only past the cutoff, bounded by `limit` per sweep. ALWAYS_KEEP /
 *  credit / retrieval / lifecycle kinds can never enter the allowlist. */
export const runTelemetryEvictionSweep = async (
  hotDb: Database,
  opts?: { retentionHours?: number; limit?: number; nowMs?: number },
): Promise<TelemetryEvictionSummary> => {
  const retentionHours = opts?.retentionHours ?? TELEMETRY_EVICTION_RETENTION_HOURS;
  const nowMs = opts?.nowMs ?? Date.now();
  const limit = opts?.limit ?? SWEEP_LIMIT;
  const cutoffIso = new Date(nowMs - retentionHours * 60 * 60 * 1000).toISOString();
  const kindList = Array.from(EPHEMERAL_TELEMETRY_KINDS);
  const summary: TelemetryEvictionSummary = {
    scanned: 0,
    evicted: 0,
    by_kind: {},
    retention_hours: retentionHours,
    cutoff_iso: cutoffIso,
  };
  if (kindList.length === 0) return summary;

  // Select candidate (id, kind) past the cutoff, bounded. ISO-vs-ISO ts
  // comparison is index-friendly (idx_events_kind_ts / idx_events_ts). Heavy
  // READ scan → route through the SQL worker pool when present (sync fallback
  // when absent), mirroring readUnembedded.
  const ph = kindList.map(() => "?").join(", ");
  const rows = await poolQuery<{ id: string; kind: string; ts: string }>(
    hotDb,
    `SELECT id, kind, ts FROM events WHERE kind IN (${ph}) AND ts < ? ORDER BY ts ASC LIMIT ?`,
    [...kindList, cutoffIso, limit],
  );
  summary.scanned = rows.length;
  if (rows.length === 0) return summary;
  recordArchiveSummary(hotDb, rows, "telemetry_eviction");

  const idsByKind = new Map<string, string[]>();
  for (const r of rows) {
    let list = idsByKind.get(r.kind);
    if (!list) {
      list = [];
      idsByKind.set(r.kind, list);
    }
    list.push(r.id);
  }

  const CHUNK = 500;
  for (const [kind, ids] of idsByKind) {
    let deletedThisKind = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const delPh = chunk.map(() => "?").join(", ");
      try {
        // Drop any retrieval-index rows first (none for these non-embeddable
        // kinds today, but symmetric with the archival DELETE path).
        hotDb.run(`DELETE FROM vec_events WHERE event_id IN (${delPh})`, chunk);
        const result = hotDb.run(`DELETE FROM events WHERE id IN (${delPh})`, chunk);
        deletedThisKind += (result as unknown as { changes?: number }).changes ?? 0;
        for (const id of chunk) {
          const row = rows.find((r) => r.id === id);
          if (row) adjustLiveRollup(hotDb, row.kind, row.ts.slice(0, 10), -1);
        }
      } catch (err) {
        logger.warn(
          { where: "archival_worker.telemetry_eviction", kind, err: (err as Error).message },
          "telemetry-eviction chunk failed",
        );
      }
    }
    if (deletedThisKind > 0) {
      // Preserve the lifetime count BEFORE the rows are gone for good.
      bumpRetainedEvictedCount(hotDb, kind, deletedThisKind);
      summary.by_kind[kind] = deletedThisKind;
      summary.evicted += deletedThisKind;
    }
  }

  if (summary.evicted > 0) {
    try {
      const emitted = emitEvent(hotDb, {
        kind: "telemetry_evicted",
        substrate_origin: "substrate_auto",
        payload: {
          by_kind: summary.by_kind,
          count: summary.evicted,
          retention_hours: retentionHours,
          cutoff_iso: cutoffIso,
        } as JsonValue,
      });
      summary.emitted_event_id = emitted.id;
    } catch (err) {
      logger.warn(
        { where: "archival_worker.emit_telemetry_evicted", err: (err as Error).message },
        "telemetry_evicted emit failed",
      );
    }
    logger.info(
      { evicted: summary.evicted, by_kind: summary.by_kind, retention_hours: retentionHours },
      "telemetry-eviction purged ephemeral telemetry from hot ledger",
    );
  }
  return summary;
};

/** Start the 6-hour archival tick. Returns a stop function. */
export const startArchivalWorker = (
  db: Database,
  opts: { stateDbPath: string; tickMs?: number },
): (() => void) => {
  const tickMs = opts.tickMs ?? ARCHIVAL_TICK_MS;
  const handle = setInterval(() => {
    void runArchivalSweep(db, { stateDbPath: opts.stateDbPath }).catch((err) => {
      logger.warn(
        { where: "archival_worker.tick", err: (err as Error).message },
        "archival sweep threw at top-level",
      );
    });
    // Tier 5 T5.1: also purge pure-noise telemetry past the short retention
    // (the hot-retention boundary the age-based archive can't give a young DB).
    void runDropSweep(db).catch((err) => {
      logger.warn(
        { where: "archival_worker.drop_tick", err: (err as Error).message },
        "drop sweep threw at top-level",
      );
    });
    // 2026-05-23 event-class tiering: evict EPHEMERAL_TELEMETRY_KINDS past
    // the short TTL (preserving lifetime health counts in meta).
    void runTelemetryEvictionSweep(db).catch((err) => {
      logger.warn(
        { where: "archival_worker.telemetry_eviction_tick", err: (err as Error).message },
        "telemetry-eviction sweep threw at top-level",
      );
    });
  }, tickMs);
  return () => clearInterval(handle);
};

/** Internal — list sibling archive files for tests/inspection. Kept
 *  here so the worker file owns its sibling-file convention; the
 *  public listing surface lives in substrate/cold_db.ts. */
export const _listArchivesForDir = (stateDbPath: string): string[] => {
  const dir = dirname(stateDbPath);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^state-archive-\d{4}-\d{2}\.db$/.test(basename(f)))
    .sort()
    .map((f) => join(dir, f));
};
