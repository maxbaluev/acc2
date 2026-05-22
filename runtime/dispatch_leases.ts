// Durable SQLite dispatch-lease table — the cross-process authoritative
// claim on a brain dispatch.
//
// WHY THIS EXISTS
// ---------------
// runtime/task_scheduler.ts dedups brain dispatches with an in-memory
// `Set` (`IN_FLIGHT_BRAIN`). That Set is correct for a SINGLE daemon
// process but it (a) does not coordinate across MULTIPLE worker daemons
// sharing one substrate (the role-split's worker role), and (b) is lost
// on restart. This module adds a DURABLE, cross-process lease as the
// authoritative claim. The in-memory Set stays the fast-path cache; the
// lease is the slow-path cross-process authority.
//
// SAFETY INVARIANTS (load-bearing — a wrong lease wedges dispatch)
// ----------------------------------------------------------------
//   1. NO PERMANENT BLOCK. Every lease carries `expires_at`. An expired
//      lease is ALWAYS reclaimable by anyone — `claimDispatchLease`
//      atomically overwrites it. A crashed holder can never block a task
//      forever (boot reconcile also sweeps expired leases proactively).
//   2. NO DOUBLE-DISPATCH. The claim is a single atomic
//      `INSERT … ON CONFLICT … WHERE expires_at <= now` statement, so two
//      racing daemons cannot both win the same unexpired lease.
//   3. IDEMPOTENT RELEASE. `releaseDispatchLease` is a DELETE; calling it
//      on an absent row is a no-op. Re-release after restart is harmless.
//   4. FAIL-OPEN, NEVER STALL. If any lease-table operation throws, the
//      caller degrades to the in-memory dedup (the historical behavior)
//      rather than wedging dispatch. The lease is additive insurance, not
//      a new hard precondition.

import type { Database } from "bun:sqlite";
import { DEFAULT_TIMEOUT_MS } from "./bridge/config";
import { logger } from "./logger";

/** Lease TTL. A holder's lease auto-expires after the maximum brain wall
 *  time so a crashed/OOM-killed holder cannot block the task longer than
 *  one brain run could legitimately take. Pad slightly above the brain
 *  wall timeout so a lease never expires UNDER a still-running, healthy
 *  dispatch (which would let a second daemon double-dispatch). */
export const DISPATCH_LEASE_TTL_MS = DEFAULT_TIMEOUT_MS + 60_000;

/** Idempotent table creation. Called from substrate/db.ts `runMigrations`
 *  (CREATE TABLE IF NOT EXISTS) so fresh installs and upgraded DBs both
 *  have it. PRIMARY KEY on task_id makes the claim a single-row atomic
 *  upsert. Times are ISO-8601 strings (lexicographically comparable),
 *  matching the events table convention. */
export const ensureDispatchLeaseTable = (db: Database): void => {
  db.run(
    `CREATE TABLE IF NOT EXISTS dispatch_leases (
       task_id    TEXT PRIMARY KEY,
       holder     TEXT NOT NULL,
       leased_at  TEXT NOT NULL,
       expires_at TEXT NOT NULL
     )`,
  );
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_dispatch_leases_expires
       ON dispatch_leases(expires_at)`,
  );
};

/** Outcome of a claim attempt.
 *  - `claimed`: this holder now owns the lease (fresh or reclaimed-expired).
 *  - `held`: an unexpired lease is held by ANOTHER holder → caller defers.
 *  - `error`: the lease table failed; caller falls back to in-memory dedup. */
export type ClaimResult =
  | { status: "claimed"; holder: string; expires_at: string }
  | { status: "held"; holder: string; expires_at: string }
  | { status: "error"; error: string };

/** Atomically claim the dispatch lease for `taskId`.
 *
 *  Implemented as a single `INSERT … ON CONFLICT(task_id) DO UPDATE …
 *  WHERE excluded`-style upsert guarded by `expires_at <= now`: the row is
 *  written iff (a) no row exists, OR (b) the existing row is expired. A
 *  re-claim by the SAME holder also succeeds (idempotent renewal). Two
 *  racing daemons issue the same statement; SQLite serializes them on the
 *  single PK row, so exactly one observes `changes() === 1` for a contended
 *  unexpired lease — there is no window for both to claim.
 *
 *  Returns `held` (no change made) when the existing row belongs to a
 *  different holder and is not yet expired. Returns `error` (fail-open) on
 *  any SQL exception so the caller degrades to in-memory dedup.
 */
export const claimDispatchLease = (
  db: Database,
  taskId: string,
  holder: string,
  opts: { nowMs?: number; ttlMs?: number } = {},
): ClaimResult => {
  const nowMs = opts.nowMs ?? Date.now();
  const ttlMs = opts.ttlMs ?? DISPATCH_LEASE_TTL_MS;
  const nowIso = new Date(nowMs).toISOString();
  const expiresIso = new Date(nowMs + ttlMs).toISOString();
  try {
    // Single atomic upsert. The DO UPDATE branch fires only when the
    // existing row is expired OR already owned by this holder (renewal).
    // Otherwise ON CONFLICT leaves the row untouched and changes() === 0.
    const stmt = db.query(
      `INSERT INTO dispatch_leases (task_id, holder, leased_at, expires_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(task_id) DO UPDATE SET
         holder = excluded.holder,
         leased_at = excluded.leased_at,
         expires_at = excluded.expires_at
       WHERE dispatch_leases.expires_at <= ?3
          OR dispatch_leases.holder = ?2`,
    );
    stmt.run(taskId, holder, nowIso, expiresIso);
    // Read back the authoritative row: whoever owns it now, plus expiry.
    const row = db
      .query(`SELECT holder, expires_at FROM dispatch_leases WHERE task_id = ?1`)
      .get(taskId) as { holder: string; expires_at: string } | null;
    if (!row) {
      // Should not happen (we just upserted) — treat as error → fall back.
      return { status: "error", error: "lease_row_missing_after_upsert" };
    }
    if (row.holder === holder) {
      return { status: "claimed", holder, expires_at: row.expires_at };
    }
    // Row owned by someone else. It is necessarily UNEXPIRED — an expired
    // row would have been overwritten by the upsert above.
    return { status: "held", holder: row.holder, expires_at: row.expires_at };
  } catch (err) {
    const error = (err as Error).message ?? String(err);
    logger.warn(
      { where: "dispatch_leases.claim", task_id: taskId, err: error },
      "dispatch lease claim failed — falling back to in-memory dedup",
    );
    return { status: "error", error };
  }
};

/** Release the lease for `taskId`. Idempotent: deleting an absent row is a
 *  no-op. Returns true when a row was removed, false when none existed (or
 *  on error — releasing must never throw into the dispatch lifecycle). */
export const releaseDispatchLease = (db: Database, taskId: string): boolean => {
  try {
    const before = db
      .query(`SELECT 1 FROM dispatch_leases WHERE task_id = ?1`)
      .get(taskId);
    db.run(`DELETE FROM dispatch_leases WHERE task_id = ?1`, [taskId]);
    return before != null;
  } catch (err) {
    logger.warn(
      { where: "dispatch_leases.release", task_id: taskId, err: (err as Error).message },
      "dispatch lease release failed (idempotent; ignoring)",
    );
    return false;
  }
};

/** Sweep EXPIRED leases (expires_at <= now). Called at daemon boot —
 *  mirroring reconcileBrainDispatchesAtBoot — so a crashed holder's stale
 *  leases never block a fresh daemon. Returns the released task_ids for the
 *  audit log. Fail-open: returns [] on error. */
export const reconcileExpiredLeases = (
  db: Database,
  opts: { nowMs?: number } = {},
): string[] => {
  const nowIso = new Date(opts.nowMs ?? Date.now()).toISOString();
  try {
    const expired = db
      .query(`SELECT task_id FROM dispatch_leases WHERE expires_at <= ?1`)
      .all(nowIso) as Array<{ task_id: string }>;
    if (expired.length === 0) return [];
    db.run(`DELETE FROM dispatch_leases WHERE expires_at <= ?1`, [nowIso]);
    return expired.map((r) => r.task_id);
  } catch (err) {
    logger.warn(
      { where: "dispatch_leases.reconcile_expired", err: (err as Error).message },
      "expired-lease reconcile failed (fail-open)",
    );
    return [];
  }
};

/** Read-side helper: the current holder of a task's lease, or null when
 *  unleased/expired. Observability only — not a gating signal. */
export const dispatchLeaseHolder = (
  db: Database,
  taskId: string,
  opts: { nowMs?: number } = {},
): { holder: string; expires_at: string } | null => {
  const nowIso = new Date(opts.nowMs ?? Date.now()).toISOString();
  try {
    const row = db
      .query(
        `SELECT holder, expires_at FROM dispatch_leases
         WHERE task_id = ?1 AND expires_at > ?2`,
      )
      .get(taskId, nowIso) as { holder: string; expires_at: string } | null;
    return row ?? null;
  } catch {
    return null;
  }
};
