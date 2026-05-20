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

import type { SqlWorkerPool } from "./sql_worker_pool";

let pool: SqlWorkerPool | null = null;

export const setSqlPool = (p: SqlWorkerPool | null): void => {
  pool = p;
};

export const getSqlPool = (): SqlWorkerPool | null => pool;

export const clearSqlPool = (): void => {
  pool = null;
};
