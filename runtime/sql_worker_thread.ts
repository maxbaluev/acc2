// acc2 SQL worker-thread script — runs INSIDE each worker_threads child.
//
// Why: Bun.SQL is fake-async — every db.query(sql).all(params) call blocks
// the parent event loop synchronously. With heavy aggregate reads (view
// projections, full-table sweeps, idempotency probes) firing on every MCP
// call and worker tick, the main daemon thread saturates and worker ticks
// overrun their intervals. Routing those reads through a pool of
// node:worker_threads (each owning its own readonly bun:sqlite handle)
// keeps the main loop free for emitEvent + MCP orchestration + bridge IO.
//
// Wire protocol (parentPort messages):
//   incoming { type: "query", id, sql, params } → outgoing { type: "result", id, rows }
//                                              OR { type: "error", id, message }
//   incoming { type: "shutdown" }              → graceful exit, closes db
//   outgoing { type: "ready" }                 → boot signal once db is open
//
// The pool manager (runtime/sql_worker_pool.ts) round-robins jobs across
// these threads; each thread maintains a small prepared-statement LRU so
// repeated SQL (the same view projection ticking on every call) reuses
// the prepared object.

import { parentPort, workerData } from "node:worker_threads";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";

type WorkerData = {
  dbPath: string;
  prepareCacheSize?: number;
};

type IncomingMsg =
  | { type: "query"; id: number; sql: string; params: unknown[] }
  | { type: "shutdown" };

type OutgoingMsg =
  | { type: "ready" }
  | { type: "result"; id: number; rows: unknown[]; elapsed_ms: number }
  | { type: "error"; id: number; message: string };

if (!parentPort) {
  // Should never happen — sql_worker_thread.ts is only valid as a worker
  // entrypoint. Exit immediately so the pool manager respawns or surfaces
  // the boot failure.
  throw new Error("sql_worker_thread: parentPort missing (must run inside worker_threads)");
}

const data = workerData as WorkerData;
if (!data?.dbPath) {
  throw new Error("sql_worker_thread: workerData.dbPath missing");
}

// Open the connection as read-only — every callsite migrated through the
// pool is a SELECT. Write paths (emitEvent, action_predicted projections,
// idempotency markers) stay on the main thread by design.
const db = new Database(data.dbPath, { readonly: true, create: false });
// Load the sqlite-vec (vec0) extension into THIS worker connection. The
// main connection loads it in substrate/db.ts, but worker threads open
// their own Database — without this, any vec_events (vec0 virtual table)
// query routed through the pool fails with `no such module: vec0`
// (observed: embedder orphan-GC + reproject flooding error_caught 2245×/15min).
db.loadExtension(sqliteVec.getLoadablePath());
// PRAGMA tuning for the read-only worker connections. The hot read path is
// heavy aggregate / index / vec0-KNN scans over a multi-hundred-MB-to-GB
// events table; the OLD policy (2MB cache, no mmap) starved these reads,
// causing page-faulting that (a) inflated pooled-read latency under a
// dispatch burst and (b) held read locks long enough to block WAL-checkpoint
// reclaim on the main writer (the 17MB-WAL / commit-stall loop-block).
//   - mmap_size: memory-map the DB so reads come from the SHARED OS page
//     cache instead of per-page syscalls. This is the big win on a large DB
//     and does NOT multiply RAM across workers — every worker maps the same
//     file, so the OS page cache is shared (virtual address space only).
//   - cache_size: a modest 64MB private page cache (read-only conns never
//     write WAL, so this does not "fight the writer" — the old comment's
//     reasoning was inverted).
//   - temp_store=MEMORY: GROUP BY / ORDER BY spill tables stay in RAM.
// All are best-effort and env-tunable (ACC2_SQL_WORKER_MMAP_BYTES).
const mmapBytes = Number(process.env.ACC2_SQL_WORKER_MMAP_BYTES ?? 2147483648);
try { db.exec("PRAGMA journal_mode = WAL"); } catch { /* read-only conn cannot change journal; best effort */ }
try { db.exec(`PRAGMA mmap_size = ${Number.isFinite(mmapBytes) && mmapBytes >= 0 ? mmapBytes : 2147483648}`); } catch { /* best effort */ }
try { db.exec("PRAGMA cache_size = -65536"); } catch { /* best effort */ }
try { db.exec("PRAGMA temp_store = MEMORY"); } catch { /* best effort */ }

// Small LRU for prepared statements. Same SQL string → same prepared
// object. Eviction policy: when size exceeds limit, evict the
// least-recently-used entry. JS Map preserves insertion order which we
// reorder on access by delete+set so iteration order == LRU order.
const PREPARE_CACHE_SIZE = Math.max(8, data.prepareCacheSize ?? 64);
const prepareCache = new Map<string, ReturnType<Database["query"]>>();

const getPrepared = (sql: string): ReturnType<Database["query"]> => {
  const cached = prepareCache.get(sql);
  if (cached) {
    // Touch to mark MRU.
    prepareCache.delete(sql);
    prepareCache.set(sql, cached);
    return cached;
  }
  const stmt = db.query(sql);
  prepareCache.set(sql, stmt);
  if (prepareCache.size > PREPARE_CACHE_SIZE) {
    // Evict LRU (first entry in iteration order).
    const oldestKey = prepareCache.keys().next().value;
    if (oldestKey !== undefined) {
      const oldStmt = prepareCache.get(oldestKey);
      prepareCache.delete(oldestKey);
      try { (oldStmt as unknown as { finalize?: () => void })?.finalize?.(); } catch { /* best effort */ }
    }
  }
  return stmt;
};

const post = (msg: OutgoingMsg): void => {
  parentPort!.postMessage(msg);
};

const handleQuery = (msg: { id: number; sql: string; params: unknown[] }): void => {
  const startedAt = performance.now();
  try {
    const stmt = getPrepared(msg.sql);
    const rows = (msg.params.length > 0
      ? stmt.all(...(msg.params as Parameters<typeof stmt.all>))
      : stmt.all()) as unknown[];
    post({ type: "result", id: msg.id, rows, elapsed_ms: performance.now() - startedAt });
  } catch (err) {
    post({ type: "error", id: msg.id, message: (err as Error).message ?? String(err) });
  }
};

parentPort.on("message", (msg: IncomingMsg) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "shutdown") {
    try {
      for (const [, stmt] of prepareCache) {
        try { (stmt as unknown as { finalize?: () => void })?.finalize?.(); } catch { /* best effort */ }
      }
      prepareCache.clear();
      db.close();
    } catch { /* best effort during shutdown */ }
    // Exit cleanly so the pool can observe the natural termination.
    process.exit(0);
  }
  if (msg.type === "query") {
    handleQuery(msg);
    return;
  }
});

// Tell the pool we're alive and ready to accept queries.
post({ type: "ready" });
