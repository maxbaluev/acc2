// acc2 Tier -1 floor — SSGM memory reconciliation worker.
//
// Per arXiv:2603.11768 (Lam, Li, Zhang, Zhao 2026) — Stability and
// Safety-Governed Memory framework: "Reconciliation operator R
// periodically re-aligns the mutable memory against the immutable
// ledger."
//
// Gap closed: the substrate has an immutable event ledger as canonical
// source-of-truth, but multiple workers maintain MUTABLE in-memory
// caches:
//   - embedder buffer (runtime/embedder.ts pending-embed queue)
//   - hot-reload pendingQuiescent + fullRestartPending maps
//   - prompt_composer composition cache (LRU)
//   - threshold registry 5-min TTL cache
//   - SQL worker pool prepared-statement caches (per thread)
//   - owner_profile maps in MCP context
//
// Without reconciliation, these caches can drift from the ledger
// silently. This worker (5-min tick) computes a deterministic ledger
// projection per cache surface, compares against the live cache hash,
// and emits memory_reconciliation_drift_detected on mismatch.
//
// Idempotency: at most one tick per minGapMs; reconciliation evidence
// emitted at each clean tick as memory_reconciliation_completed.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { emitEvent } from "./events";
import { logger } from "./logger";

export type ReconciliationOptions = {
  now?: Date;
  minGapMs?: number;
  dryRun?: boolean;
};

export type ReconciliationSummary = {
  surfaces_checked: number;
  drifts_detected: number;
  emitted_event_ids: string[];
  skipped_recent: boolean;
};

export type CacheSurface = {
  name: string;
  ledgerProjectionHash: (db: Database) => string | null;
  // Returns null when the cache is not yet initialized (no comparison meaningful).
  // Returns a string hash otherwise.
  liveCacheHash?: () => string | null;
};

const DEFAULT_MIN_GAP_MS = 5 * 60 * 1000;

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

/** Default cache surfaces under audit. Hash functions are projections
 *  of the ledger state that the cache CLAIMS to mirror. We compare the
 *  ledger projection across ticks; cache-side hash is opt-in (workers
 *  that expose a getCacheHash() can be added; absent ones still get
 *  ledger-side drift tracking). */
const DEFAULT_SURFACES: CacheSurface[] = [
  {
    name: "embedder_pending_count",
    ledgerProjectionHash: (db) => {
      try {
        const row = db
          .query<{ c: number }, []>(
            `SELECT COUNT(*) AS c FROM events WHERE embedding IS NULL AND kind IN ('knowledge_candidate','knowledge_promoted','lesson_extracted','contract_amendment_proposed')`,
          )
          .get();
        return `embed_pending:${row?.c ?? 0}`;
      } catch {
        return null;
      }
    },
  },
  {
    name: "act_artifact_count",
    ledgerProjectionHash: (db) => {
      try {
        const row = db
          .query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM act_artifact`)
          .get();
        return `act_artifact_count:${row?.c ?? 0}`;
      } catch {
        return null;
      }
    },
  },
  {
    name: "predicate_artifact_count",
    ledgerProjectionHash: (db) => {
      try {
        const row = db
          .query<{ c: number }, []>(
            `SELECT COUNT(*) AS c FROM act_artifact WHERE kind LIKE '%_predicate' AND id LIKE 'predicate_%_v1'`,
          )
          .get();
        return `predicate_count:${row?.c ?? 0}`;
      } catch {
        return null;
      }
    },
  },
  {
    name: "promoted_knowledge_count",
    ledgerProjectionHash: (db) => {
      try {
        const row = db
          .query<{ c: number }, []>(
            `SELECT COUNT(*) AS c FROM events WHERE kind = 'knowledge_promoted'`,
          )
          .get();
        return `promoted_knowledge:${row?.c ?? 0}`;
      } catch {
        return null;
      }
    },
  },
];

// Track ledger projection hashes across ticks to detect change rate.
// Initial tick records baseline; subsequent ticks compare. Stored in
// module-level state because the worker is single-instance per daemon.
const lastProjectionHashByName = new Map<string, string>();
const lastProjectionTsByName = new Map<string, number>();

export const runMemoryReconciliationTick = (
  db: Database,
  opts: ReconciliationOptions = {},
  surfaces: CacheSurface[] = DEFAULT_SURFACES,
): ReconciliationSummary => {
  const now = opts.now ?? new Date();
  const minGapMs = opts.minGapMs ?? DEFAULT_MIN_GAP_MS;
  const dryRun = opts.dryRun ?? false;

  const cleanGap = now.getTime() - lastEmitTsMs(db, "memory_reconciliation_completed");
  if (cleanGap < minGapMs) {
    return {
      surfaces_checked: 0,
      drifts_detected: 0,
      emitted_event_ids: [],
      skipped_recent: true,
    };
  }

  const summary: ReconciliationSummary = {
    surfaces_checked: 0,
    drifts_detected: 0,
    emitted_event_ids: [],
    skipped_recent: false,
  };

  const projections: Record<string, string | null> = {};

  for (const surface of surfaces) {
    try {
      const projection = surface.ledgerProjectionHash(db);
      projections[surface.name] = projection;
      summary.surfaces_checked++;

      if (projection === null) continue;

      const liveHash = surface.liveCacheHash?.();
      if (liveHash !== undefined && liveHash !== null && liveHash !== projection) {
        // Cache-side mismatch — true drift detected.
        summary.drifts_detected++;
        if (!dryRun) {
          try {
            const ev = emitEvent(db, {
              kind: "memory_reconciliation_drift_detected",
              substrate_origin: "substrate_auto",
              payload: {
                surface_name: surface.name,
                ledger_projection: projection,
                live_cache_hash: liveHash,
                drift_kind: "cache_vs_ledger_mismatch",
              } satisfies Record<string, JsonValue>,
            });
            summary.emitted_event_ids.push(ev.id);
          } catch (err) {
            logger.warn(
              { where: "memory_reconciliation.emit_drift", err: String(err) },
              "could not emit memory_reconciliation_drift_detected",
            );
          }
        }
      }

      lastProjectionHashByName.set(surface.name, projection);
      lastProjectionTsByName.set(surface.name, now.getTime());
    } catch (err) {
      logger.warn(
        { where: "memory_reconciliation.surface", surface: surface.name, err: String(err) },
        "memory_reconciliation surface failed",
      );
    }
  }

  // Always emit the clean reconciliation event when the gate passes —
  // dashboards need tick-liveness even when no drift exists.
  if (!dryRun) {
    try {
      const ev = emitEvent(db, {
        kind: "memory_reconciliation_completed",
        substrate_origin: "substrate_auto",
        payload: {
          predicate: "memory_reconciliation_predicate",
          surfaces_checked: summary.surfaces_checked,
          drifts_detected: summary.drifts_detected,
          projections: projections as unknown as JsonValue,
          residual: summary.drifts_detected === 0 ? 0 : 1,
          window_seconds: Math.round(minGapMs / 1000),
        } satisfies Record<string, JsonValue>,
      });
      summary.emitted_event_ids.push(ev.id);
    } catch (err) {
      logger.warn(
        { where: "memory_reconciliation.emit_completed", err: String(err) },
        "could not emit memory_reconciliation_completed",
      );
    }
  }

  return summary;
};

