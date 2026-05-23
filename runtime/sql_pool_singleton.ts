// acc2 SQL worker-thread pool — singleton accessor.
//
// The daemon spawns ONE pool per process at boot. Migration callsites
// (MCP view projections, artifact-kind backfill scan, embedder
// readUnembedded, extractor sweeps) call `getSqlPool()` to retrieve the
// pool when present, and fall back to the main-thread synchronous path
// when absent. This keeps the migration drop-in and lets unit tests
// (which never start the daemon) keep using the sync path with no env
// gymnastics.
//
// Why not pass the pool through every call: too many existing callsites
// already accept a `db` handle. Threading a pool through every layer
// would be a massive churn AND would conflict with the constraint of
// touching only the 5 highest-leverage callsites.

import type { Database } from "bun:sqlite";
import type { SqlWorkerPool } from "./sql_worker_pool";

let pool: SqlWorkerPool | null = null;

export const setSqlPool = (p: SqlWorkerPool | null): void => {
  pool = p;
};

export const getSqlPool = (): SqlWorkerPool | null => pool;

export const clearSqlPool = (): void => {
  pool = null;
};

/** Route a heavy read-only SELECT through the SQL worker-thread pool when the
 *  daemon has installed one, falling back to the synchronous bun:sqlite path
 *  otherwise. This is the canonical idiom (mirrors embedder.readUnembedded /
 *  causal_edge_extractor): periodic worker scans on a large `events` table
 *  block the main JS event loop under Bun's fake-async SQL, starving /health +
 *  MCP serving. Off-loading them to a worker thread keeps the main loop free.
 *
 *  Fail-closed to the sync path: if the pool query rejects (overflow, timeout,
 *  worker death), we fall back to the in-process synchronous read so the
 *  worker tick still produces its outputs — correctness over throughput. Unit
 *  tests + ACC2_DISABLE_SQL_POOL diagnostics never install a pool, so they
 *  always take the sync path with no behavioral change. Same row shape, same
 *  ordering, same results — only the execution thread differs. */
export const poolQuery = async <T = unknown>(
  db: Database,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> => {
  const p = pool;
  if (p) {
    try {
      return await p.query<T>(sql, params);
    } catch {
      // Pool rejected (overflow/timeout/worker death) — degrade to sync so the
      // tick body still completes with identical output.
    }
  }
  return db.query(sql).all(...params) as T[];
};
