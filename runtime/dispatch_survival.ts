// Brain-dispatch survival predicate. The canonical "no brain mid-flight"
// probe used by the hot-reload quiescence gate and (transitively) the
// shutdown drain.
//
// Cites:
//   - XA3ABKERHD4H (0.72) — live brain dispatch survival should be
//     implemented first as session-token-stable reload quiescence: refuse
//     or delay code reload while brain_dispatched events lack matching
//     brain_dispatch_closed.
//   - 77N73035F97Z — canonical drain pattern (wait for in-flight brain
//     dispatches to close before tearing down).
//
// This file is deliberately tiny. It exports ONE pure function: a
// recency-bounded SQL probe over the canonical event ledger. The probe
// answers the structural question "is any brain dispatch currently
// in-flight?" without any side effects. Callers (the hot-reload
// quiescence callback in runtime/daemon.ts, and any future drain helpers)
// reuse it to make the same decision the substrate evidence supports.
//
// Why a recency filter? Pre-fix the daemon already had an isQuiescent
// probe but no age window — orphaned dispatches from a long-ago restart
// would refuse hot reload forever. The boot-time reconciler
// (reconcileBrainDispatchesAtBoot / reconcileOrphanedDispatches) closes
// orphans at every restart, so anything OLDER than the recency window
// is by definition either closed or unrecoverable; ignoring it lets new
// reloads proceed even if a legacy unclosed row is wedged in the
// ledger. The 1-hour window matches XA3ABKERHD4H's "live" definition.

import type { Database } from "bun:sqlite";

/** Recency window for the "live brain dispatch" probe. A brain_dispatched
 *  row older than this without a matching brain_dispatch_closed is
 *  treated as legacy / unrecoverable rather than in-flight, so the
 *  quiescence gate doesn't wedge forever on a ghost from a prior boot. */
export const ACTIVE_BRAIN_DISPATCH_RECENCY_MS = 60 * 60 * 1000; // 1 hour

/** Returns true when ZERO recent brain_dispatched rows lack a matching
 *  brain_dispatch_closed (per task_id, close ts >= dispatch ts). The
 *  recency filter excludes legacy orphans older than
 *  ACTIVE_BRAIN_DISPATCH_RECENCY_MS — boot reconciliation owns those.
 *
 *  Pure: no event emission, no DB writes. Callers compose the deferral
 *  audit (e.g. hotreload_deferred) when they want it. */
export const noActiveBrainDispatches = (db: Database): boolean => {
  try {
    const row = db
      .query(
        // NOTE: events.ts is stored in ISO-8601 with the literal "T" and
        // trailing "Z" (`2026-05-19T10:18:45.199Z`). SQLite's
        // `datetime('now', '-1 hour')` returns the space-separated form
        // (`2026-05-19 09:18:45`), so a textual `b.ts > datetime(...)`
        // would treat EVERY ISO timestamp as greater than every
        // SQLite-rendered datetime (because ASCII "T" > space). Wrap
        // both sides in `datetime(...)` so the comparison is on the
        // normalized lexical form. Without this normalization the
        // recency filter is silently inert and legacy orphans wedge
        // quiescence forever. Cite XA3ABKERHD4H.
        `SELECT 1 AS hit FROM events b
         WHERE b.kind = 'brain_dispatched'
           AND NOT EXISTS (
             SELECT 1 FROM events c
             WHERE c.kind = 'brain_dispatch_closed'
               AND c.task_id = b.task_id
               AND datetime(c.ts) >= datetime(b.ts)
           )
           AND datetime(b.ts) > datetime('now', '-1 hour')
         LIMIT 1`,
      )
      .get() as { hit: number } | null;
    return !row;
  } catch {
    // On query failure (closed DB, schema mismatch), fail OPEN — the
    // alternative is wedging quiescence forever. Boot reconciliation is
    // the deterministic backstop.
    return true;
  }
};

/** Count of recent in-flight brain dispatches (the live-orphan signal a
 *  crash leaves behind). After a native SIGILL/SIGSEGV the daemon's stop()
 *  never ran, so every `brain_dispatched` row from the dead generation lacks
 *  a `brain_dispatch_closed`. The watchdog (runtime/daemon_supervisor.ts)
 *  surfaces this count as recovery evidence — the respawned daemon's boot
 *  `reconcileBrainDispatchesAtBoot` is what actually closes/repicks them, so
 *  this probe is observational only (no side effects).
 *
 *  Uses the SAME recency window + datetime-normalized comparison as
 *  `noActiveBrainDispatches` so "recent" means the same thing everywhere:
 *  orphans older than ACTIVE_BRAIN_DISPATCH_RECENCY_MS are boot-reconciliation's
 *  job, not a crash-recovery signal. On query failure returns 0 (fail-quiet —
 *  this is a diagnostic, not a gate). */
export const recentOrphanDispatchCount = (db: Database): number => {
  try {
    const row = db
      .query(
        `SELECT COUNT(*) AS n FROM events b
         WHERE b.kind = 'brain_dispatched'
           AND NOT EXISTS (
             SELECT 1 FROM events c
             WHERE c.kind = 'brain_dispatch_closed'
               AND c.task_id = b.task_id
               AND datetime(c.ts) >= datetime(b.ts)
           )
           AND datetime(b.ts) > datetime('now', '-1 hour')`,
      )
      .get() as { n: number } | null;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
};
