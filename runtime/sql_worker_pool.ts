// acc2 SQL worker-thread pool — main-thread manager.
//
// Why: Bun.SQL is fake-async — every heavy aggregate SQL read blocks the
// event loop. The pool spawns N worker_threads (each owning its own
// readonly bun:sqlite connection), round-robins SELECT jobs to them, and
// returns the rows over the message channel. Main thread keeps emitEvent
// + MCP orchestration + bridge IO on its own loop.
//
// Per-thread protocol lives in runtime/sql_worker_thread.ts.
//
// Pool semantics:
//   - Round-robin distribution; backpressure when in-flight queue exceeds
//     `taskQueueLimit` (reject with `pool_queue_overflow`).
//   - Per-query timeout (default 30s, configurable via
//     ACC2_SQL_QUERY_TIMEOUT_MS) — guards against runaway view SQL.
//   - Reliability: if a worker thread dies (process exit), respawn a
//     replacement; in-flight jobs on the dead worker reject with
//     `worker_thread_died`.
//   - Metrics: pending / active / completed / avg_wait_ms with rolling
//     p50/p90/p99 of wait durations. The daemon emits
//     `sql_worker_pool_metrics` every 30s with these numbers.

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";

export type SqlPoolConfig = {
  workerCount: number;
  dbPath: string;
  taskQueueLimit: number;
  /** Per-query timeout (ms). Default 30000. */
  queryTimeoutMs?: number;
  /** Prepared-statement LRU size per worker. Default 64. */
  prepareCacheSize?: number;
};

export type SqlPoolMetrics = {
  workers: number;
  pending: number;
  active: number;
  completed: number;
  failed: number;
  rejected_overflow: number;
  timed_out: number;
  worker_respawns: number;
  avg_wait_ms: number;
  p50_wait_ms: number;
  p90_wait_ms: number;
  p99_wait_ms: number;
  avg_exec_ms: number;
};

type PendingJob = {
  id: number;
  sql: string;
  params: unknown[];
  enqueuedAt: number;
  resolve: (rows: unknown[]) => void;
  reject: (err: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
  assignedWorker: number | null;
};

const DEFAULT_QUERY_TIMEOUT_MS = 30_000;
const ROLLING_WAIT_SAMPLES = 256;

const resolveWorkerScript = (): string => {
  // The worker script lives next to this file. Resolve via import.meta.url
  // so the resolution is robust to test runners launching from arbitrary
  // CWDs and to bundled/transpiled deployments where __dirname is unset.
  const here = fileURLToPath(import.meta.url);
  return resolvePath(here, "..", "sql_worker_thread.ts");
};

export class SqlWorkerPool {
  private readonly cfg: SqlPoolConfig;
  private readonly workerScript: string;
  private workers: Worker[] = [];
  private workerReady: boolean[] = [];
  private workerActiveJobs: Map<number, PendingJob>[] = [];
  private nextWorkerIdx = 0;
  private nextJobId = 1;
  private readonly jobsById = new Map<number, PendingJob>();
  private completedCount = 0;
  private failedCount = 0;
  private rejectedOverflow = 0;
  private timedOutCount = 0;
  private workerRespawns = 0;
  private readonly waitSamples: number[] = [];
  private readonly execSamples: number[] = [];
  private shuttingDown = false;

  constructor(cfg: SqlPoolConfig) {
    this.cfg = {
      ...cfg,
      queryTimeoutMs: cfg.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
      prepareCacheSize: cfg.prepareCacheSize ?? 64,
    };
    this.workerScript = resolveWorkerScript();
    for (let i = 0; i < this.cfg.workerCount; i++) this.spawnWorker(i);
  }

  private spawnWorker(idx: number): void {
    const w = new Worker(this.workerScript, {
      workerData: {
        dbPath: this.cfg.dbPath,
        prepareCacheSize: this.cfg.prepareCacheSize,
      },
    });
    this.workers[idx] = w;
    this.workerReady[idx] = false;
    this.workerActiveJobs[idx] = new Map();

    w.on("message", (msg: unknown) => {
      if (!msg || typeof msg !== "object") return;
      const m = msg as { type: string; id?: number; rows?: unknown[]; message?: string; elapsed_ms?: number };
      if (m.type === "ready") {
        this.workerReady[idx] = true;
        return;
      }
      if (m.type === "result" && typeof m.id === "number") {
        const job = this.jobsById.get(m.id);
        if (!job) return; // already timed out / cancelled
        this.completeJob(job, m.rows ?? [], typeof m.elapsed_ms === "number" ? m.elapsed_ms : null);
        return;
      }
      if (m.type === "error" && typeof m.id === "number") {
        const job = this.jobsById.get(m.id);
        if (!job) return;
        this.failJob(job, new Error(`sql_worker_query_failed:${m.message ?? "unknown"}`));
        return;
      }
    });

    w.on("error", (err) => {
      // Worker-level error: fail all in-flight jobs for this worker and
      // respawn. Don't propagate to the daemon (avoid taking down the
      // process from a single bad worker).
      const active = this.workerActiveJobs[idx];
      if (active) {
        for (const job of active.values()) {
          this.failJob(job, new Error(`sql_worker_thread_error:${(err as Error)?.message ?? String(err)}`));
        }
      }
    });

    w.on("exit", (code) => {
      if (this.shuttingDown) return;
      // Unexpected exit: respawn. Fail any still-active jobs first.
      const active = this.workerActiveJobs[idx];
      if (active) {
        for (const job of active.values()) {
          this.failJob(job, new Error(`worker_thread_died:exit_code=${code}`));
        }
      }
      this.workerRespawns++;
      this.spawnWorker(idx);
    });
  }

  private completeJob(job: PendingJob, rows: unknown[], execMs: number | null): void {
    this.jobsById.delete(job.id);
    if (job.assignedWorker !== null) {
      this.workerActiveJobs[job.assignedWorker]?.delete(job.id);
    }
    if (job.timeoutHandle) clearTimeout(job.timeoutHandle);
    const waitMs = Date.now() - job.enqueuedAt;
    this.waitSamples.push(waitMs);
    if (this.waitSamples.length > ROLLING_WAIT_SAMPLES) this.waitSamples.shift();
    if (execMs !== null) {
      this.execSamples.push(execMs);
      if (this.execSamples.length > ROLLING_WAIT_SAMPLES) this.execSamples.shift();
    }
    this.completedCount++;
    job.resolve(rows);
  }

  private failJob(job: PendingJob, err: Error): void {
    if (!this.jobsById.has(job.id)) return;
    this.jobsById.delete(job.id);
    if (job.assignedWorker !== null) {
      this.workerActiveJobs[job.assignedWorker]?.delete(job.id);
    }
    if (job.timeoutHandle) clearTimeout(job.timeoutHandle);
    this.failedCount++;
    job.reject(err);
  }

  /** Submit a SELECT job to the pool. Returns the rows array. */
  query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (this.shuttingDown) {
      return Promise.reject(new Error("sql_pool_shutting_down"));
    }
    if (this.jobsById.size >= this.cfg.taskQueueLimit) {
      this.rejectedOverflow++;
      return Promise.reject(new Error(`pool_queue_overflow:in_flight=${this.jobsById.size};limit=${this.cfg.taskQueueLimit}`));
    }
    return new Promise<T[]>((resolve, reject) => {
      const id = this.nextJobId++;
      const job: PendingJob = {
        id,
        sql,
        params,
        enqueuedAt: Date.now(),
        resolve: (rows: unknown[]) => resolve(rows as T[]),
        reject,
        timeoutHandle: null,
        assignedWorker: null,
      };
      this.jobsById.set(id, job);

      // Round-robin dispatch. Increment first so we don't re-pick the same
      // worker on every call when N=1 and a long query is still resolving.
      const workerIdx = this.nextWorkerIdx % this.workers.length;
      this.nextWorkerIdx = (this.nextWorkerIdx + 1) % this.workers.length;
      job.assignedWorker = workerIdx;
      this.workerActiveJobs[workerIdx].set(id, job);

      const timeoutMs = this.cfg.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
      job.timeoutHandle = setTimeout(() => {
        if (!this.jobsById.has(id)) return;
        const timedOutWorker = job.assignedWorker;
        this.timedOutCount++;
        this.failJob(job, new Error(`sql_pool_query_timeout:${timeoutMs}ms`));
        if (timedOutWorker !== null) {
          void this.workers[timedOutWorker]?.terminate().catch(() => undefined);
        }
      }, timeoutMs);

      this.workers[workerIdx].postMessage({
        type: "query",
        id,
        sql,
        params,
      });
    });
  }

  metrics(): SqlPoolMetrics {
    const samples = this.waitSamples.slice().sort((a, b) => a - b);
    const pct = (p: number): number => {
      if (samples.length === 0) return 0;
      const idx = Math.min(samples.length - 1, Math.floor((p / 100) * samples.length));
      return samples[idx];
    };
    const avg = (arr: number[]): number => (arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length);
    const active = this.workerActiveJobs.reduce((sum, m) => sum + m.size, 0);
    return {
      workers: this.workers.length,
      pending: this.jobsById.size,
      active,
      completed: this.completedCount,
      failed: this.failedCount,
      rejected_overflow: this.rejectedOverflow,
      timed_out: this.timedOutCount,
      worker_respawns: this.workerRespawns,
      avg_wait_ms: avg(this.waitSamples),
      p50_wait_ms: pct(50),
      p90_wait_ms: pct(90),
      p99_wait_ms: pct(99),
      avg_exec_ms: avg(this.execSamples),
    };
  }

  /** Drain in-flight jobs then terminate workers. `drainBudgetMs` is the
   *  max time we wait for pending jobs to finish; after that we hard-kill
   *  remaining workers and reject still-pending jobs. */
  async shutdown(drainBudgetMs = 5_000): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const drainStart = Date.now();
    while (this.jobsById.size > 0 && Date.now() - drainStart < drainBudgetMs) {
      await new Promise<void>((r) => setTimeout(r, 25));
    }
    // Reject any still-pending jobs.
    for (const job of this.jobsById.values()) {
      if (job.timeoutHandle) clearTimeout(job.timeoutHandle);
      job.reject(new Error("sql_pool_shutting_down"));
    }
    this.jobsById.clear();
    // Send shutdown signal then terminate (terminate is hard-stop).
    await Promise.all(this.workers.map(async (w) => {
      try { w.postMessage({ type: "shutdown" }); } catch { /* worker may already be dead */ }
      try { await w.terminate(); } catch { /* best effort */ }
    }));
  }
}

/** Convenience factory matching the contract documented in the
 *  contract's direction text. */
export const startSqlWorkerPool = (cfg: SqlPoolConfig): SqlWorkerPool => new SqlWorkerPool(cfg);

/** Host-aware default SQL worker count. Reads (the embedder's unembedded
 *  scan, retrieval, health/aggregate reads) run OFF the daemon's single event
 *  loop through this pool and parallelize via SQLite WAL; with too few workers
 *  they queue behind each other under load (observed: reads stalling 4-12s
 *  while the embedder held a worker, on an otherwise-idle 20-core host). A flat
 *  default of 4 under-utilises larger hosts. Scale to ~half the cores, clamped
 *  to [4, 12] so tiny hosts stay conservative and huge hosts don't over-spawn
 *  worker threads. Writes still serialize on the single writer (unaffected);
 *  this only widens READ concurrency, which is the non-reactive symptom.
 *  ACC2_SQL_WORKER_COUNT overrides explicitly. */
const defaultSqlWorkerCount = (): number => {
  let cores = 4;
  try {
    cores = (require("node:os") as typeof import("node:os")).cpus().length || 4;
  } catch {
    cores = 4;
  }
  return Math.max(4, Math.min(12, Math.floor(cores / 2)));
};

/** Resolve pool config from env + caller-supplied dbPath. */
export const resolveSqlPoolConfigFromEnv = (dbPath: string): SqlPoolConfig => {
  const fromEnv = (name: string, fallback: number): number => {
    const raw = process.env[name];
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    dbPath,
    workerCount: fromEnv("ACC2_SQL_WORKER_COUNT", defaultSqlWorkerCount()),
    taskQueueLimit: fromEnv("ACC2_SQL_TASK_QUEUE_LIMIT", 256),
    queryTimeoutMs: fromEnv("ACC2_SQL_QUERY_TIMEOUT_MS", DEFAULT_QUERY_TIMEOUT_MS),
    prepareCacheSize: fromEnv("ACC2_SQL_PREPARE_CACHE_SIZE", 64),
  };
};
