// acc2 substrate daemon — single bun process holding the WAL connection,
// background workers, AND two HTTP surfaces:
//   1. fastmcp MCP server (HTTP streaming) on the primary port — Claude Code
//      and opencode connect as native MCP clients here. The MCP wire is owned
//      entirely by fastmcp (no /mcp/<method> path; standard Streamable-HTTP).
//   2. A plain `Bun.serve` on the auxiliary port (= primary + 1) for the
//      non-MCP endpoints:
//        - POST /external/push  (external-service ingress, §5.2)
//        - GET  /health         (liveness probe)
//        - POST /shutdown       (auth-gated graceful stop)
//
// Why two ports? fastmcp's `httpStream` transport owns its port exclusively
// (the HTTP server it stands up implements the Streamable-HTTP MCP protocol).
// Keeping the auxiliary HTTP endpoints on a sibling port keeps the wire
// surfaces strictly orthogonal: MCP-only on the primary, non-MCP HTTP on the
// sidecar. Both ports are env-configurable (V2_DAEMON_PORT,
// V2_DAEMON_AUX_PORT). Per Architecture.md the daemon is single-instance
// via a lock file (~/.accint/v2.sock); a stale lock (pid not alive) is reaped.
//
// Lifecycle events:
//   - emits `daemon_started` at boot
//   - emits `daemon_index_rebuilt` after schema-init (the actual in-memory
//     HNSW rebuild is Phase F; this is the boot signal)
//   - emits `daemon_shutdown` on graceful stop
//
// Cycle-1-only dispatch is enforced by task_dispatcher.ts (Phase D); the
// daemon only owns supervision + IO here.

import type { Server } from "bun";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { Database } from "bun:sqlite";
import { closeDb, openDb, getAllPoolStats } from "../substrate/db";
import { runViews } from "../substrate/views";
import { seedActArtifacts } from "../substrate/seed";
import { emitEvent } from "./events";
import { subscribe, resetBus, type BusEvent } from "./event_bus";
import { onEvent, type ActivationPayload } from "./activation_bus";
import type { EventKind } from "../substrate/event_kinds";
import { ARTIFACT_CANDIDATE_KINDS, EMBEDDABLE_KINDS } from "../substrate/event_kinds";
import { newAdminToken } from "./ids";
import { createMcpServer } from "./mcp_server/index";
import {
  resolveDbPath, resolveSocketFile, resolveTokenFile,
} from "./state_paths";
import { createExternalIngressState, handleExternalPush, type ExternalIngressState } from "./external_ingress";
import type { FastMCP } from "fastmcp";
import { applyAmendment, findUnappliedAmendments } from "./amendment_handler";
import {
  drainInFlightDispatches,
  inFlightDispatchTaskIds,
  schedulerLoop,
  setSchedulerDraining,
} from "./task_scheduler";
import { rollingReviewerWorkerTick } from "./rolling_reviewer";
import { fatherJournalOnEvent } from "./father";
import { EmbeddingIndex } from "./embedding_index";
import { embedderWorkerTick, pendingEmbeddableCount } from "./embedder";
import { rehabilitationWorkerTick, getArtifact } from "./artifact_store";
import { runBunArtifact } from "./runtimes/bun";
import { runUvArtifact } from "./runtimes/uv";
import { runCamofoxArtifact } from "./runtimes/camofox";
import { lookupRunnerInRegistry, runArtifactForRuntime } from "./runtimes/index";
import type { BunSandboxDecl, CamofoxSandboxDecl, JsonValue, SandboxDecl, UvSandboxDecl } from "../substrate/types";
import { logger } from "./logger";
import { metricsHandler, refreshGauges } from "./metrics";
import { integrityWorkerTick, runIntegrityCheck, reconcileOrphanedDispatches, reconcilePreDispatchOrphans } from "./integrity_worker";
import { reconcileBrainDispatchesAtBoot, getOpenBrainDispatches, setBootSessionToken } from "./brain_dispatch_reconciler";
import { reconcileExpiredLeases } from "./dispatch_leases";
import { waitForBrainQuiescence } from "./restart_quiescence";
import { noActiveBrainDispatches } from "./dispatch_survival";
import { checkpointInterruptedDispatches } from "./dispatch_continuation";
import {
  getCurrentGitHead,
  writeChildGitHead,
  removeChildGitHead,
  resolveChildGitHeadPath,
} from "./daemon_supervisor";
import { isWorkerEnabled } from "./worker_autostart";
import { McpSessionReaper, runMcpSessionReaperTick, resolveReapIntervalMs } from "./mcp_session_reaper";
import {
  isReady,
  pendingWorkers,
  registerWorker,
  markWorkerReactive,
  markWorkerReady,
  setOnReady,
  resetReadiness,
  readyAt,
  recordWorkerTick,
  recordWorkerTickStart,
  clearWorkerTickInFlight,
  stuckWorkers,
  inFlightStuckWorkers,
} from "./readiness";
import { SqlWorkerPool, resolveSqlPoolConfigFromEnv } from "./sql_worker_pool";
import { setSqlPool, clearSqlPool } from "./sql_pool_singleton";

export const DEFAULT_DAEMON_PORT = 9387;
export const DEFAULT_AUX_PORT_OFFSET = 1;

/**
 * True if a TCP listener is already accepting connections on host:port.
 *
 * Used to (a) pre-detect an occupied MCP port BEFORE handing it to fastmcp —
 * which would otherwise emit an asynchronous, unhandled "Failed to start
 * server. Is port N in use?" 'error' that escapes the boot try/catch — and
 * (b) verify the port actually bound after fastmcp's fire-and-forget start().
 * A successful Bun.connect means "something is listening"; a connection
 * refused means "free". Best-effort: any non-connect outcome is treated as
 * not-listening so a transient probe error never wedges boot.
 */
const isPortListening = async (host: string, port: number): Promise<boolean> => {
  try {
    const socket = await Bun.connect({
      hostname: host,
      port,
      socket: { data() {}, open() {}, close() {}, error() {} },
    });
    socket.end();
    return true;
  } catch {
    return false;
  }
};

export type DaemonOpts = {
  /** MCP (fastmcp) port. Defaults to V2_DAEMON_PORT env, then 9387. */
  port?: number;
  /** Auxiliary HTTP port (/external/push, /health, /shutdown). Defaults to
   *  V2_DAEMON_AUX_PORT env, then `port + 1`. */
  auxPort?: number;
  stateDbPath?: string;
  socketFile?: string;
  tokenFile?: string;
  externalPushToken?: string | null;
  host?: string;
};

export type DaemonHandle = {
  /** Auxiliary Bun.serve server (port = auxPort). */
  server: Server;
  /** FastMCP server on the primary port (transport = httpStream). */
  mcpServer: FastMCP;
  db: Database;
  adminToken: string;
  startedAtMs: number;
  /** Primary (MCP) port. */
  port: number;
  /** Auxiliary port (non-MCP HTTP). */
  auxPort: number;
  stateDbPath: string;
  socketFile: string;
  tokenFile: string;
  ingressState: ExternalIngressState;
  workers: Array<() => void>;
  /** In-memory embedding index rebuilt at boot from embedding_index_view.
   *  Used by substrate.search for cosine × posterior retrieval. */
  index: EmbeddingIndex;
  /** Stop the daemon. `drainBudgetMs` is the bounded graceful drain budget
   *  for in-flight brain dispatches (default `RESTART_DRAIN_TIMEOUT_MS`,
   *  `0` for immediate kill). See `stop` doc comment for full semantics. */
  stop: (drainBudgetMs?: number) => Promise<void>;
};

const ensureDir = (path: string): void => {
  const d = dirname(path);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
};

const writeLockFile = (path: string, payload: Record<string, unknown>): void => {
  ensureDir(path);
  writeFileSync(path, JSON.stringify(payload, null, 2), { mode: 0o600 });
};

const tryRemove = (path: string): void => {
  try {
    if (existsSync(path)) rmSync(path, { force: true });
  } catch (err) {
    logger.debug({ where: "daemon.tryRemove", path, err: String(err) }, "remove failed (best-effort)");
  }
};

/** Wrap a tick body with per-tick deadline + overrun detection.
 *
 *  Semantics:
 *    - If the previous tick body is still running when the next interval
 *      fires, the new tick is SKIPPED and a `worker_tick_overrun` event is
 *      emitted (with `expected_ms` = interval, `observed_ms` = elapsed). The
 *      already-running tick is allowed to finish — we never cancel mid-body.
 *    - When the tick body completes successfully, `recordWorkerTick(name)`
 *      stamps the last-tick timestamp so /health can compute degraded state.
 *    - Errors thrown by the body are caught + logged + emitted as
 *      `error_caught` so per-tick failures never crash the daemon AND never
 *      vanish silently (audit-1: no swallow without at least a debug line).
 *
 *  Returns a tick callback suitable for `setInterval(fn, intervalMs)`. The
 *  callback returns void; internal Promise chains are fire-and-forget. */
/** Min interval (ms) between consecutive `worker_tick_completed` event
 *  emissions per worker. The scheduler ticks every 500ms = 7200/h; without
 *  dampening we'd write that to the ledger. The dampening keeps each worker
 *  at most ~12 rows/hour while still letting auditors reconstruct tick
 *  liveness from the substrate (audit-#5 fix, 2026-05-15). 2026-05-21
 *  bump: from 60s → 5min based on SQLite bottleneck audit. 44K
 *  worker_tick_completed events in 7 days = 12.6% of all writes. At 5min
 *  cadence the same dashboard observability holds (worker_liveness_view
 *  alarms when no tick in 15min) but ledger pressure drops 5x. */
const WORKER_TICK_EVENT_DAMPEN_MS = 5 * 60_000;
const lastEmittedWorkerTickMs = new Map<string, number>();

/** Emit a dampened `worker_tick_completed` for workers that don't go
 *  through supervisedTick (e.g. the scheduler runs in its own async loop).
 *  Brain audit D (2026-05-15) — the scheduler ticked but was invisible
 *  from the ledger before this helper. */
const emitWorkerTickIfDue = (
  db: Database,
  workerName: string,
  intervalMs: number,
): void => {
  const lastEmit = lastEmittedWorkerTickMs.get(workerName) ?? 0;
  const now = Date.now();
  if (now - lastEmit < WORKER_TICK_EVENT_DAMPEN_MS) return;
  lastEmittedWorkerTickMs.set(workerName, now);
  try {
    emitEvent(db, {
      kind: "worker_tick_completed",
      substrate_origin: "substrate_auto",
      payload: {
        worker: workerName,
        expected_interval_ms: intervalMs,
        dampen_ms: WORKER_TICK_EVENT_DAMPEN_MS,
      },
    });
  } catch (err) {
    logger.debug(
      { where: "emitWorkerTickIfDue", worker: workerName, err: String(err) },
      "could not emit worker_tick_completed (db likely closed)",
    );
  }
};

const supervisedTick = (
  db: Database,
  workerName: string,
  intervalMs: number,
  body: () => Promise<void>,
  opts?: { overrunThresholdMs?: number },
): (() => void) => {
  let running = false;
  let runningSinceMs = 0;
  // Per-worker overrun-emit threshold. Default to `intervalMs` (one
  // missed tick = one signal — old behavior). The embedder + similar
  // adaptive-batch workers legitimately take many seconds during heavy
  // drain (batchSize scales 20→100→200 based on backlog; OpenAI
  // embedding round-trips for the largest batches run ~30s). Pre-fix
  // those normal-drain ticks emitted worker_tick_overrun every tick,
  // spamming the health metric with no actionable signal (38 events in
  // 3 days, all on `embedder`, ALL during legitimate drain). Pass
  // `overrunThresholdMs: intervalMs * 6` (or similar) for workers that
  // legitimately exceed a single tick; signal still fires when the
  // worker is structurally stuck (multi-tick wedge) instead of just
  // doing slow but real work.
  const overrunThresholdMs = opts?.overrunThresholdMs ?? intervalMs;
  return () => {
    const now = Date.now();
    if (running) {
      const observedMs = now - runningSinceMs;
      // skip-fire is unconditional (the supervisor invariant); the
      // overrun EVENT only fires when the wedge is structurally bad
      // (observedMs > overrunThresholdMs). Log line stays for debug.
      logger.warn(
        { worker: workerName, expected_ms: intervalMs, observed_ms: observedMs, threshold_ms: overrunThresholdMs },
        "worker tick overrun — previous tick still running, skipping this fire",
      );
      if (observedMs > overrunThresholdMs) {
        try {
          emitEvent(db, {
            kind: "worker_tick_overrun",
            substrate_origin: "substrate_auto",
            payload: {
              worker: workerName,
              expected_ms: intervalMs,
              observed_ms: observedMs,
              overrun_threshold_ms: overrunThresholdMs,
            },
          });
        } catch (err) {
          logger.debug(
            { where: "supervisedTick.emit_overrun", err: String(err) },
            "could not emit worker_tick_overrun (db likely closed)",
          );
        }
      }
      return;
    }
    running = true;
    runningSinceMs = now;
    recordWorkerTickStart(workerName, now); // Tier D D1: in-flight heartbeat
    void (async () => {
      try {
        await body();
        recordWorkerTick(workerName);
        // Audit-#5 (2026-05-15): emit a rate-limited `worker_tick_completed`
        // so the substrate carries proof of liveness for every worker, not
        // just the process-local lastTickMs map. Dampened to
        // WORKER_TICK_EVENT_DAMPEN_MS so a 500ms scheduler tick doesn't
        // spam the ledger.
        const elapsedMs = Date.now() - runningSinceMs;
        const lastEmit = lastEmittedWorkerTickMs.get(workerName) ?? 0;
        if (Date.now() - lastEmit >= WORKER_TICK_EVENT_DAMPEN_MS) {
          lastEmittedWorkerTickMs.set(workerName, Date.now());
          try {
            emitEvent(db, {
              kind: "worker_tick_completed",
              substrate_origin: "substrate_auto",
              payload: {
                worker: workerName,
                expected_interval_ms: intervalMs,
                tick_duration_ms: elapsedMs,
                dampen_ms: WORKER_TICK_EVENT_DAMPEN_MS,
              },
            });
          } catch (err) {
            logger.debug(
              { where: "supervisedTick.emit_completed", err: String(err) },
              "could not emit worker_tick_completed (db likely closed)",
            );
          }
        }
      } catch (err) {
        logger.warn(
          { worker: workerName, err: (err as Error).message },
          "worker tick threw — caught and surfaced as error_caught",
        );
        try {
          emitEvent(db, {
            kind: "error_caught",
            substrate_origin: "substrate_auto",
            payload: {
              where: `daemon.worker.${workerName}`,
              recoverable: true,
              message: (err as Error).message,
            },
          });
        } catch (emitErr) {
          logger.debug(
            { where: "supervisedTick.emit_error_caught", err: String(emitErr) },
            "could not emit error_caught (db likely closed)",
          );
        }
      } finally {
        running = false;
        // Tier D D1: clear the in-flight marker even when the tick threw
        // (recordWorkerTick — which clears it — only runs on success).
        // Clears in-flight WITHOUT marking a successful tick (lastTickMs),
        // so a failed tick is neither stuck-in-flight nor falsely "ticked".
        clearWorkerTickInFlight(workerName);
      }
    })();
  };
};

// Graceful-restart drain budget. Was 30s — far shorter than a brain dispatch
// (median ~6min), so `acc daemon restart` orphaned in-flight brains across
// ALL terminals after 30s, killing other terminals' work mid-run. Raised to
// 180s (env-overridable) so a graceful restart waits out the bulk of in-flight
// dispatches before force-killing; the rare longer research dispatch resumes
// via boot-time orphan-recovery + the no-progress research grace rather than
// being lost. Operators who need an immediate stop pass drainBudgetMs=0.
// NOTE: this is the GRACEFUL path only — never `pkill -9` the daemon (SIGKILL
// bypasses this drain entirely and orphans every in-flight brain). Use
// `acc daemon restart`/`stop`, and prefer in_process hot-reload (no restart).
const RESTART_DRAIN_TIMEOUT_MS = (() => {
  const raw = process.env.ACC2_RESTART_DRAIN_TIMEOUT_MS;
  if (typeof raw === "string" && raw.length > 0) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 180_000;
})();

/** R2 instant-startup grace (2026-05-21). Boot-time catch-up passes
 *  (extractor sweep over the whole event table, embedder backlog drain)
 *  are deferred this many ms so the daemon binds ports + serves /health
 *  BEFORE their synchronous bun:sqlite scans grind the single event loop.
 *  Deliberately SHORT (3s) to keep the system reactive: the catch-up pass
 *  only handles work accumulated while the daemon was OFF; NEW events are
 *  served by the reactive activation-bus subscriptions immediately
 *  regardless of this delay. The complete fix is roadmap R1 (writer
 *  thread) which removes main-loop write blocking entirely; this defer is
 *  the surgical interim that makes boot-to-serving near-instant. Override
 *  via ACC2_BOOT_HEAVY_PASS_DELAY_MS. */
const BOOT_HEAVY_PASS_DELAY_MS = (() => {
  const raw = process.env.ACC2_BOOT_HEAVY_PASS_DELAY_MS;
  if (typeof raw === "string" && raw.length > 0) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 60_000) return n;
  }
  return 3_000;
})();

const countEvents = (db: Database): number => {
  const row = db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number } | null;
  return row?.n ?? 0;
};

// /health analytical counts cache. SQLite COUNT(*) on the events table runs
// synchronously under bun:sqlite and blocks the JS event loop; under research-
// dispatch load (100k+ events, active WAL writers) those four counts add up to
// >5s of latency. Previously the cache was a 5s TTL refreshed *inside* the
// /health handler — every miss blocked the request and on every probe race
// the TUI's HEALTH_TIMEOUT_MS=5_000 fired before COUNT(*) returned, marking
// the daemon DEAD even when it was alive. Foundational fix: the cache is
// initialized at boot with placeholder zeros, refreshed by a dedicated
// background interval (refreshHealthCountsTick), and `/health` ONLY reads the
// cache. The request path never touches SQL. Worst case under load is stale
// counts (operator observability), not a stuck /health endpoint.
type HealthCountsCache = {
  events_count: number;
  pathology_exhausted: number;
  pathology_debited: number;
  brain_failed: number;
  window_iso: string;
  computed_at_ms: number;
};
let healthCountsCache: HealthCountsCache = {
  events_count: 0,
  pathology_exhausted: 0,
  pathology_debited: 0,
  brain_failed: 0,
  window_iso: new Date(0).toISOString(),
  computed_at_ms: 0,
};
// T5: now async. The four COUNTs — a full `COUNT(*) FROM events` over the
// 360k+ row events table plus three recent-window COUNTs — block the
// synchronous bun:sqlite main loop for seconds under WAL-writer load. When
// this interval fires on the server-role process (which serves /health + MCP),
// that stall starves the request loop even though the refresh is off the
// request path. Routing the COUNTs through the SQL worker-thread pool moves
// them off-thread; the sync fallback stays correct for unit tests and
// ACC2_DISABLE_SQL_POOL diagnostics (matches embedder.ts's getSqlPool idiom).
const refreshHealthCounts = async (db: Database): Promise<void> => {
  const now = Date.now();
  const recentCutoff = new Date(now - 30 * 60 * 1000).toISOString();
  let pool: import("./sql_worker_pool").SqlWorkerPool | null = null;
  try {
    const poolMod = await import("./sql_pool_singleton");
    pool = poolMod.getSqlPool();
  } catch { /* tolerate — fall through to sync */ }

  const countSql = "SELECT COUNT(*) AS c FROM events";
  const recentSql = (kinds: string[]): string =>
    `SELECT COUNT(*) AS c FROM events WHERE kind IN (${kinds.map(() => "?").join(",")}) AND ts >= ?`;

  const recentSync = (kinds: string[]): number => {
    try {
      const row = db.query(recentSql(kinds)).get(...kinds, recentCutoff) as { c: number };
      return row.c;
    } catch { return 0; }
  };
  const recentPool = async (kinds: string[]): Promise<number> => {
    try {
      const rows = await pool!.query<{ c: number }>(recentSql(kinds), [...kinds, recentCutoff]);
      return rows[0]?.c ?? 0;
    } catch { return 0; }
  };

  try {
    if (pool) {
      const [eventsRows, exhausted, debited, failed] = await Promise.all([
        pool.query<{ c: number }>(countSql, []),
        recentPool(["pathology_budget_exhausted"]),
        recentPool(["pathology_budget_debited"]),
        recentPool(["bridge_failed", "dispatcher_violation"]),
      ]);
      healthCountsCache = {
        events_count: eventsRows[0]?.c ?? 0,
        pathology_exhausted: exhausted,
        pathology_debited: debited,
        brain_failed: failed,
        window_iso: recentCutoff,
        computed_at_ms: now,
      };
      return;
    }
    healthCountsCache = {
      events_count: countEvents(db),
      pathology_exhausted: recentSync(["pathology_budget_exhausted"]),
      pathology_debited: recentSync(["pathology_budget_debited"]),
      brain_failed: recentSync(["bridge_failed", "dispatcher_violation"]),
      window_iso: recentCutoff,
      computed_at_ms: now,
    };
  } catch { /* keep prior cache on transient SQL error */ }
};
const readHealthCounts = (_db: Database): HealthCountsCache => healthCountsCache;

// Boot integrity state (2026-05-23 instant-boot fix). The boot-time
// PRAGMA quick_check scans every page of the (≈1GB) state.db — seconds of
// SYNCHRONOUS bun:sqlite work that, when run BEFORE the MCP/aux ports bind,
// kept health=ok unreachable for the whole scan. The check now runs in a
// background task AFTER the ports are bound + /health is serving; its result
// is surfaced HERE (and on the `/health` body as `boot_integrity`) instead of
// gating the bind. `pending` is the honest state until the deferred check
// completes; corruption is surfaced as an `integrity_check_failed` event
// (the periodic 6h integrity worker also independently catches it). This is a
// process-global singleton because `/health`'s routeAux closure cannot capture
// per-boot locals; resetBootIntegrity() restores `pending` on each boot so a
// same-process restart never reports a stale prior-boot verdict.
type BootIntegrityState = {
  status: "pending" | "ok" | "failed" | "skipped";
  pragma_result: string | null;
  duration_ms: number | null;
  checked_at_ms: number | null;
};
let bootIntegrityState: BootIntegrityState = {
  status: "pending",
  pragma_result: null,
  duration_ms: null,
  checked_at_ms: null,
};
const resetBootIntegrity = (): void => {
  bootIntegrityState = { status: "pending", pragma_result: null, duration_ms: null, checked_at_ms: null };
};
const setBootIntegrity = (next: BootIntegrityState): void => { bootIntegrityState = next; };
/** Read the current boot-integrity verdict. Exported for the health handler
 *  and for tests that prove health=ok is reachable WHILE the check is still
 *  `pending` (i.e. the deferred check is not a precondition for serving). */
export const getBootIntegrityState = (): BootIntegrityState => bootIntegrityState;

const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/** Thrown when an atomic boot-intent lock is held by a LIVE daemon (booting
 *  or ready). Distinguished from generic boot failures so the CLI / daemon
 *  entrypoint can treat a second concurrent start as an IDEMPOTENT no-op
 *  (exit 0) rather than a crash (exit 1). The `phase` field reports whether
 *  the incumbent is still `booting` or already `ready`. */
export class DaemonAlreadyRunningError extends Error {
  readonly pid: number;
  readonly phase: string;
  constructor(pid: number, phase: string) {
    super(`daemon already ${phase === "ready" ? "running" : "booting"} (pid=${pid})`);
    this.name = "DaemonAlreadyRunningError";
    this.pid = pid;
    this.phase = phase;
  }
}

export const isDaemonAlreadyRunningError = (err: unknown): err is DaemonAlreadyRunningError =>
  err instanceof DaemonAlreadyRunningError ||
  (err instanceof Error && err.name === "DaemonAlreadyRunningError");

type BootLockPayload = {
  pid: number;
  started_at_ms: number;
  phase: "booting" | "ready";
  role: string;
  [k: string]: unknown;
};

/**
 * Atomically acquire the single-instance boot-intent lock at the VERY START
 * of daemon startup — BEFORE the ~150s of slow boot work (DB open, schema
 * migrations, seed, integrity check, MCP/aux bind).
 *
 * ROOT-CAUSE FIX (duplicate-daemon race): the lock file was previously only
 * WRITTEN at the end of boot (after ports bound), but the second-instance
 * GUARD ran at the start. During the long boot window the file did not yet
 * exist, so two concurrent `daemon start` calls BOTH saw "no lock", BOTH
 * proceeded to boot, and BOTH tried to bind MCP port — one won, the other
 * lingered as a duplicate/zombie daemon.ts proc.
 *
 * The fix closes the window with an EXCLUSIVE-CREATE (`wx` → O_CREAT|O_EXCL):
 *   - The create is atomic at the filesystem layer: exactly one of N racing
 *     processes succeeds; the rest get EEXIST.
 *   - On EEXIST we read the incumbent payload. If its pid is ALIVE the
 *     incumbent is booting or running → REFUSE this start with a
 *     DaemonAlreadyRunningError (caller treats it as an idempotent no-op).
 *   - If the pid is DEAD the lock is stale (crashed daemon) → reap (unlink)
 *     and retry the exclusive create ONCE. Stale-lock reaping for genuinely
 *     dead daemons is preserved so a crash never blocks startup forever.
 *
 * The lock is written with phase:"booting"; the existing end-of-boot
 * writeLockFile call rewrites the SAME path with the full ready payload
 * (phase:"ready" + ports), keeping `daemon status` working. Clean shutdown
 * (`stop`) unlinks the path as before.
 */
const acquireBootLock = (socketFile: string, role: string): void => {
  ensureDir(socketFile);
  const payload: BootLockPayload = {
    pid: process.pid,
    started_at_ms: Date.now(),
    phase: "booting",
    role,
  };
  const body = JSON.stringify(payload, null, 2);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // `wx` = O_WRONLY | O_CREAT | O_EXCL — fails with EEXIST if the file
      // already exists. This is the atomic single-writer primitive.
      const fd = openSync(socketFile, "wx", 0o600);
      try { writeSync(fd, body); } finally { closeSync(fd); }
      return; // acquired
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // File exists — inspect the incumbent.
      let prevPid: number | undefined;
      let prevPhase = "booting";
      try {
        const prev = JSON.parse(readFileSync(socketFile, "utf8")) as { pid?: number; phase?: string };
        prevPid = prev.pid;
        if (typeof prev.phase === "string") prevPhase = prev.phase;
      } catch {
        // Malformed lock — treat as stale and reap below.
        prevPid = undefined;
      }
      if (prevPid && pidAlive(prevPid)) {
        // Live incumbent — refuse cleanly. The caller (CLI / entrypoint)
        // turns this into an idempotent no-op; we do NOT pay the boot cost.
        throw new DaemonAlreadyRunningError(prevPid, prevPhase);
      }
      // Stale lock (dead pid or malformed) — reap and retry the exclusive
      // create exactly once. A second EEXIST after reaping means another
      // process won the reap-and-recreate race; that process is the live
      // owner, so the next loop iteration's pidAlive check will refuse.
      tryRemove(socketFile);
    }
  }
  // Both attempts exhausted (a competitor recreated the lock after our reap).
  // Re-read to refuse against the live owner if present.
  try {
    const prev = JSON.parse(readFileSync(socketFile, "utf8")) as { pid?: number; phase?: string };
    if (prev.pid && pidAlive(prev.pid)) {
      throw new DaemonAlreadyRunningError(prev.pid, typeof prev.phase === "string" ? prev.phase : "booting");
    }
  } catch (err) {
    if (isDaemonAlreadyRunningError(err)) throw err;
  }
  // Last resort: force-create over whatever is there (dead competitor).
  writeFileSync(socketFile, body, { mode: 0o600 });
};

/** Start the daemon. Throws if the socket file already exists AND its pid is
 *  alive (second-instance guard). On boot emits daemon_started +
 *  daemon_index_rebuilt; on graceful stop emits daemon_shutdown. */
export const startDaemon = async (opts: DaemonOpts = {}): Promise<DaemonHandle> => {
  // Fundamental architectural separation (foundational fix for /health
  // request-path starvation): the daemon can run in three roles, gated by
  // ACC2_DAEMON_ROLE.
  //   "all"    — single-process: bind HTTP/MCP ports AND run worker
  //              setIntervals. Default. Good for development and small
  //              installs; production benefits from the two-process split.
  //   "server" — bind HTTP/MCP ports; SKIP worker setIntervals. The main
  //              JS event loop stays free for /health and MCP request
  //              handlers, never blocked by synchronous bun:sqlite work
  //              from worker ticks.
  //   "worker" — run worker setIntervals; SKIP HTTP/MCP port bind. Opens
  //              its own bun:sqlite handle to the same state.db; SQLite
  //              WAL mode handles concurrent writers across processes
  //              (server daemon writes ingress events; worker daemon
  //              writes derived events; both safe).
  // Operators wanting the architectural separation start TWO daemons:
  //   ACC2_DAEMON_ROLE=server  acc daemon start
  //   ACC2_DAEMON_ROLE=worker  acc daemon start
  // Each uses a role-specific lock file (v2.sock vs v2.sock.worker) so
  // they don't fight the single-instance guard.
  const role = (process.env.ACC2_DAEMON_ROLE ?? "all").toLowerCase();
  if (role !== "all" && role !== "server" && role !== "worker") {
    throw new Error(`ACC2_DAEMON_ROLE must be one of: all | server | worker (got ${role})`);
  }
  const skipWorkers = role === "server";
  const skipPorts = role === "worker";

  const port = opts.port ?? Number(process.env.V2_DAEMON_PORT ?? DEFAULT_DAEMON_PORT);
  const auxPort = opts.auxPort ?? Number(process.env.V2_DAEMON_AUX_PORT ?? port + DEFAULT_AUX_PORT_OFFSET);
  // Resolve paths LAZILY through the shared resolver so an env var set
  // between module-load and startDaemon (common in tests that pin paths
  // per-case) is honoured. Constants above are cached at module-load only.
  const stateDbPath = opts.stateDbPath ?? resolveDbPath();
  // Role-scoped lock so server+worker can coexist as two processes.
  const baseSocketFile = opts.socketFile ?? resolveSocketFile();
  const socketFile = skipPorts ? `${baseSocketFile}.worker` : baseSocketFile;
  const tokenFile = opts.tokenFile ?? resolveTokenFile();
  const host = opts.host ?? "127.0.0.1";
  setSchedulerDraining(false);

  // The bridge spawns opencode subprocesses that need to reach BACK into
  // this daemon's MCP server (substrate.* / runtime.* tool surface). The
  // daemon knows its own host+port at bind time; export the URL into the
  // process env so subprocess spawns inherit it. Operator override (env
  // var already set) wins so a reverse-proxy / containerised deploy can
  // point opencode at a different URL. Without this, the bridge fails
  // with `mcp_server_url_missing` on every dispatch — a hole the operator
  // shouldn't have to discover the hard way.
  if (!process.env.V2_MCP_SERVER_URL) {
    process.env.V2_MCP_SERVER_URL = `http://${host}:${port}/mcp`;
  }


  // Single-instance guard — ATOMIC boot-intent lock acquired at the VERY
  // START of startup, BEFORE the ~150s of slow boot work below. This is the
  // root-cause fix for the duplicate-daemon race: the lock file is now
  // exclusive-created (O_EXCL) the instant we enter boot, not written at the
  // end after ports bind. Two concurrent `daemon start` calls can no longer
  // BOTH see "no lock" during the boot window — exactly one wins the atomic
  // create; the other reads the live-pid lock and refuses IMMEDIATELY
  // (before paying any boot cost) with a DaemonAlreadyRunningError. A stale
  // lock (dead pid) is still reaped so a crashed daemon never blocks startup.
  //
  // acquireBootLock throws DaemonAlreadyRunningError on a live incumbent; we
  // let it propagate so the entrypoint / CLI turns it into an idempotent
  // no-op (exit 0). On refusal we have not yet opened the DB or bound any
  // port, so there is nothing to tear down. The tokenFile is NOT reaped here
  // (the live incumbent owns it); a genuinely-stale tokenFile is harmless and
  // gets overwritten by the incumbent's own mint.
  acquireBootLock(socketFile, role);

  ensureDir(stateDbPath);
  const db = openDb(stateDbPath);
  runViews(db);

  // T3.8/T5: spawn the SQL worker-thread pool BEFORE workers register so
  // every migrated callsite finds it via getSqlPool() from its first
  // tick. Bun.SQL is fake-async — every heavy aggregate SELECT blocks
  // the main event loop synchronously. The pool routes those reads to
  // N=ACC2_SQL_WORKER_COUNT (default 4) worker_threads, each owning a
  // private readonly bun:sqlite handle, freeing the main loop for
  // emitEvent + MCP orchestration + bridge IO. Without this, worker
  // ticks overrun their intervals (3 / 21min pre-fix) and dispatch
  // orphan-recoveries spike (28 / 15min pre-fix). The pool is opt-out
  // via ACC2_DISABLE_SQL_POOL=1 (tests + diagnostics).
  let sqlPool: SqlWorkerPool | null = null;
  if (process.env.ACC2_DISABLE_SQL_POOL !== "1") {
    try {
      sqlPool = new SqlWorkerPool(resolveSqlPoolConfigFromEnv(stateDbPath));
      setSqlPool(sqlPool);
      logger.info(
        { workers: sqlPool.metrics().workers, db_path: stateDbPath },
        "sql_worker_pool started",
      );
    } catch (err) {
      logger.warn({ err: String(err) }, "sql_worker_pool start failed — falling back to main-thread reads");
      sqlPool = null;
    }
  }

  // 2026-05-20 (brain VJDMME8JD961SE6F amendment 4AV2NPJW2H1HV0XQ3MR2ZV78KC):
  // run versioned schema migrations BEFORE seedActArtifacts so any
  // schema changes are in place before the seeder admits rows.
  // substrate/migrations is the ONLY path for state.db schema changes
  // going forward (docs/Architecture.md). Per-migration application
  // is idempotent (versioned via schema_migration_applied event).
  try {
    const { runVersionedMigrations } = await import("../substrate/migration_runner");
    const migrationSummary = runVersionedMigrations(db);
    if (migrationSummary.applied > 0 || migrationSummary.failed > 0) {
      logger.info(
        {
          applied: migrationSummary.applied,
          skipped: migrationSummary.skipped_already_applied,
          failed: migrationSummary.failed,
          versions: migrationSummary.versions_applied,
        },
        "substrate/migrations applied at daemon boot",
      );
    }
    if (migrationSummary.failed > 0) {
      logger.warn(
        { errors: migrationSummary.errors },
        "substrate/migrations had failures — boot continues (fail-soft); see schema_migration_failed events",
      );
    }
  } catch (err) {
    logger.warn({ err: String(err) }, "runMigrations at daemon boot failed");
  }

  // 2026-05-19 (brain 198YWW39K94KH2ZQ1A7XHP2T8R): seed act_artifact rows
  // on every daemon boot. Idempotent via per-row content-hash meta keys
  // (substrate/seed.ts:hashSeedRow) — re-running the seeder neither
  // duplicates rows nor wipes posterior_alpha/beta/score/confidence on
  // already-live calibration. Closes the artifact-credit trunk leak by
  // ensuring substrate-primitive ids (knowledge_merger_v1,
  // dispatch_decider_v1, owner_profile_promoter_action, etc) are
  // registered BEFORE the credit pipeline starts processing
  // action_scored events. Without this, fresh production daemons that
  // never ran `acc init` would have every substrate-primitive
  // action_scored event fall through to the synthetic-actuator
  // fallback in credit.ts and lose the primary posterior update.
  try {
    const seedSummary = seedActArtifacts(db);
    if (seedSummary.inserted > 0 || (seedSummary.upgraded ?? 0) > 0) {
      logger.info(
        { inserted: seedSummary.inserted, upgraded: seedSummary.upgraded ?? 0, skipped: seedSummary.skipped },
        "seedActArtifacts at daemon boot",
      );
    }
  } catch (err) {
    // Seeding is best-effort at boot. If the seed path throws (schema
    // drift, partial migration), log and continue — the brain can still
    // operate on whatever rows exist; missing rows fall back to the
    // synthetic-actuator branch in credit.ts which is non-destructive.
    logger.warn({ err: String(err) }, "seedActArtifacts at daemon boot failed");
  }

  // Batch 3.OPS: pre-traffic boot checks.
  //   2. Reconcile in-flight dispatches: any `brain_dispatched` row whose
  //      task did not close in the previous boot is marked as
  //      `dispatch_recovered_orphan`; the scheduler will re-pick the task
  //      on its next ready_tasks_view check.
  //
  // INSTANT-BOOT (2026-05-23): the boot-time PRAGMA quick_check (formerly
  // run RIGHT HERE, synchronously, BEFORE the ports bind) scans every page
  // of the ≈1GB state.db — seconds of bun:sqlite work that blocked the
  // single event loop and kept health=ok unreachable for the whole scan
  // (the dominant pre-health cost on a production-sized ledger). It now runs
  // DEFERRED, AFTER the ports are bound + /health is already serving (see the
  // `runBootIntegrityCheck()` schedule below the bind). The check still RUNS
  // and still catches structural/page corruption — it just no longer gates
  // boot. Its verdict is surfaced via `bootIntegrityState` (and the `/health`
  // body's `boot_integrity` field) plus an `integrity_check_failed` event on
  // corruption; the periodic 6h integrity worker independently re-checks.
  // resetBootIntegrity() clears any prior-boot verdict so a same-process
  // restart starts at `pending`.
  resetBootIntegrity();
  const orphans = reconcileOrphanedDispatches(db);
  if (orphans.length > 0) {
    logger.info({ orphan_count: orphans.length }, "reconciled orphan dispatches at boot");
  }
  // Also reap PRE-dispatch orphans: directives opened but never reached the
  // dispatch stage before a prior restart (the 'zombie' rows in acc watch).
  const preDispatchOrphans = reconcilePreDispatchOrphans(db);
  if (preDispatchOrphans.length > 0) {
    logger.info({ pre_dispatch_orphan_count: preDispatchOrphans.length }, "reaped pre-dispatch orphan directives at boot");
  }
  // F8 boot reconciler: mint a session token for this daemon process and
  // close every `brain_dispatched` row still lacking a matching
  // `brain_dispatch_closed`. Runs BEFORE the `daemon_started` event so
  // the ledger is honest about prior-restart state before any new
  // dispatch fires. The token is also stamped on every fresh
  // `brain_dispatched` payload via getBootSessionToken so a later audit
  // can correlate dispatches to the daemon process that owned them.
  const bootSessionToken = `daemon-${process.pid}-${Date.now()}`;
  setBootSessionToken(bootSessionToken);
  const reconcileSummary = reconcileBrainDispatchesAtBoot(db, bootSessionToken);
  if (reconcileSummary.reconciled_count > 0) {
    logger.info(
      { reconciled_count: reconcileSummary.reconciled_count, boot_session_token: bootSessionToken },
      "reconciled live brain dispatches at boot (restart_reconciled)",
    );
  }
  // Durable dispatch-lease boot sweep: release EXPIRED leases so a crashed
  // holder's stale lease never blocks a fresh daemon from claiming the
  // task. Mirrors reconcileBrainDispatchesAtBoot — runs before
  // daemon_started. Unexpired leases are LEFT in place: another live worker
  // daemon may legitimately own them (the lease is cross-process).
  const releasedLeaseTaskIds = reconcileExpiredLeases(db);
  if (releasedLeaseTaskIds.length > 0) {
    logger.info(
      { released_count: releasedLeaseTaskIds.length, boot_session_token: bootSessionToken },
      "released expired dispatch leases at boot (crashed-holder reclaim)",
    );
  }

  // Phase F: rebuild the in-memory embedding index from substrate. On fresh
  // installs this is an empty index; the worker tick fills it as new
  // embeddable events accumulate.
  const index = EmbeddingIndex.rebuildFromDb(db);

  // Batch 3.OPS: reset readiness slot so a same-process restart starts
  // with a clean tracker.
  resetReadiness();

  const adminToken = newAdminToken();
  // 2026-05-21 owner-identity-continuity fix: every daemon boot mints a
  // fresh admin_token via newAdminToken() above, which writes a new
  // ~/.accint/v2.sock.token. The owner_identity_continuity_predicate
  // observes the token-file SHA changed and refuses autonomous commits
  // ("token_changed_without_admin_token_rotated_event"). Pre-fix only
  // owner-initiated `acc admin rotate-token` emitted the audit row, so
  // every daemon restart left the predicate in refuse state until
  // someone manually emitted the audit. The structural fix is at the
  // mint site: any new admin_token MUST be paired with an
  // admin_token_rotated event so the continuity predicate stays
  // honest. reason='daemon_restart' distinguishes this from operator-
  // initiated rotations (reason absent or 'operator_request').
  try {
    emitEvent(db, {
      kind: "admin_token_rotated",
      substrate_origin: "substrate_auto",
      payload: {
        token_file: tokenFile,
        new_token_preview: adminToken.slice(0, 8) + "...",
        reason: "daemon_restart",
        boot_session_token: `daemon-${process.pid}-${Date.now()}`,
      },
    });
  } catch (err) {
    // Audit is best-effort at boot — surface a warning but never block
    // daemon startup. The continuity predicate will still observe the
    // token change; the operator can emit the audit manually via
    // `acc admin rotate-token --noop-audit` (CLI follow-up).
    logger.warn(
      { where: "daemon.boot.admin_token_rotated_audit", err: String(err) },
      "could not emit admin_token_rotated at daemon boot",
    );
  }
  const ingressState = createExternalIngressState({
    ownerDefaultToken: opts.externalPushToken ?? process.env.ACC2_EXTERNAL_PUSH_TOKEN ?? null,
  });
  const startedAtMs = Date.now();

  // Background workers. Phase-B workers use activation_bus events as the
  // primary path. One daemon-owned low-frequency safety net remains as the
  // bounded fallback for missed in-process activation, matching the
  // task_scheduler Promise.race pattern and the restart-quiescence rule:
  // refuse time-based action until substrate evidence makes work eligible.
  const workers: Array<() => void> = [];
  const activationDisposers: Array<() => void> = [];
  // MCP session GC (2026-05-23). The reaper instance is shared between the
  // fastmcp connect/disconnect hooks (which feed its first-seen registry) and
  // the periodic worker tick (which force-closes leaked/dead/idle/over-cap
  // sessions). Declared here at startDaemon scope so both capture the same
  // instance; only constructed lazily on role=server/all (skipPorts no-ops).
  const mcpSessionReaper = new McpSessionReaper();
  type ReactiveTriggerKind = EventKind | "*";
  type ReactiveWorkerEntry = {
    worker: string;
    expectedIntervalMs: number;
    minReactiveGapMs: number;
    run: () => void;
    skippedReactiveFires: number;
    lastReactiveFireMs: number;
    lastTickEmitMs: number;
    suppressedTickEmits: number;
  };
  const reactiveWorkers: ReactiveWorkerEntry[] = [];
  const emitReactiveFire = (entry: ReactiveWorkerEntry, source: "event" | "safety_net", trigger?: ActivationPayload): void => {
    const now = Date.now();
    if (source === "event" && entry.lastTickEmitMs > 0 && now - entry.lastTickEmitMs < WORKER_TICK_EVENT_DAMPEN_MS) {
      entry.suppressedTickEmits++;
      return;
    }
    entry.lastTickEmitMs = now;
    try {
      const payload: { [k: string]: JsonValue } = {
        worker: entry.worker,
        activation_source: source,
        skipped_reactive_fires: entry.skippedReactiveFires,
        suppressed_tick_emits: entry.suppressedTickEmits,
        expected_interval_ms: entry.expectedIntervalMs,
        dampen_ms: WORKER_TICK_EVENT_DAMPEN_MS,
      };
      if (trigger?.kind) payload.trigger_kind = trigger.kind;
      if (trigger?.event_id) payload.trigger_event_id = trigger.event_id;
      emitEvent(db, {
        kind: "worker_tick_completed",
        substrate_origin: "substrate_auto",
        payload,
      });
      entry.suppressedTickEmits = 0;
    } catch { /* telemetry must not break activation or shutdown */ }
  };
  const fireReactiveWorker = (entry: ReactiveWorkerEntry, source: "event" | "safety_net", trigger?: ActivationPayload): void => {
    const now = Date.now();
    if (source === "event" && entry.minReactiveGapMs > 0 && now - entry.lastReactiveFireMs < entry.minReactiveGapMs) {
      entry.skippedReactiveFires++;
      return;
    }
    entry.lastReactiveFireMs = now;
    emitReactiveFire(entry, source, trigger);
    entry.run();
  };
  const registerReactiveWorker = (
    worker: string,
    expectedIntervalMs: number,
    triggerKinds: ReadonlyArray<ReactiveTriggerKind>,
    run: () => void,
    opts: { minReactiveGapMs?: number } = {},
  ): void => {
    const entry: ReactiveWorkerEntry = {
      worker,
      expectedIntervalMs,
      minReactiveGapMs: opts.minReactiveGapMs ?? 0,
      run,
      skippedReactiveFires: 0,
      lastReactiveFireMs: 0,
      lastTickEmitMs: 0,
      suppressedTickEmits: 0,
    };
    reactiveWorkers.push(entry);
    // Tell readiness this worker is activation-driven so the per-worker
    // heartbeat-deadline stuck check skips it. The shared reactive safety
    // net is the only true deadline that applies across reactive workers
    // (reported as `reactive_safety_net` when it stalls).
    markWorkerReactive(worker);
    for (const kind of triggerKinds) {
      activationDisposers.push(onEvent(kind, (payload) => fireReactiveWorker(entry, "event", payload)));
    }
  };

  // BIND-BEFORE-WORKERS (2026-05-22): the worker setup below registers
  // setIntervals and runs SYNCHRONOUS first-tick bun:sqlite scans
  // (embedder, integrity, rolling_reviewer, father, extractors, …). On a
  // production-sized ledger (367k+ events, ~782MB state.db) those first
  // ticks STARVE the single JS event loop for 104s+ (>180s with the
  // embedder enabled) — long enough to trip the startup watchdog and kill
  // the daemon before it ever binds. The fix: collect ALL worker setup
  // into this closure and KICK IT OFF AFTER the MCP/aux ports are bound,
  // the lock file is written, and startDaemon() has resolved. The ports
  // serve /health + MCP within a few seconds; the workers complete their
  // first ticks in the background afterward. Worker-readiness
  // (setOnReady/isReady → daemon_ready) is now an INTERNAL signal surfaced
  // in /health detail, NOT a precondition for binding or for startDaemon()
  // resolving. role=server (skipWorkers) still runs this closure but its
  // internal `if (!skipWorkers)` gate skips the heavy workers (the cheap
  // reactive safety net + health-counts refresher still register, exactly
  // as before); role=worker (skipPorts) runs every worker in this closure.
  const startWorkers = async (): Promise<void> => {
  // Stop-before-start guard: this closure is scheduled deferred (after the
  // bind + startDaemon resolve). A test or a fast restart can call stop()
  // BEFORE the deferred kickoff fires. If we proceed after stop(), we
  // register setIntervals + onEvent subscriptions that stop()'s `workers`
  // disposal already ran past — leaking timers and bus subscribers for the
  // life of the process (under `bun test --parallel` this leaked into
  // cross-test memory pressure → SIGILL crashes). `stopped` is the same flag
  // stop() sets; bail before registering anything. The registration phase
  // below (registerWorker batch + every registerReactiveWorker onEvent
  // subscription) runs SYNCHRONOUSLY to its first `await import(...)`, so an
  // event emitted by an immediate post-boot caller (e.g. directive_amended)
  // is caught by the reactive subscriptions — there is no pre-subscription
  // gap. Do NOT introduce an `await` before the reactive subscriptions are
  // installed.
  if (stopped) return;
  // The reactive safety net is the ONLY genuine heartbeat for the
  // activation-driven worker pool: it fires every safetyNetTickMs and
  // unconditionally ticks every reactive worker. Reactive workers do not
  // each have their own heartbeat (subscription firing IS their tick).
  // So readiness/health monitors this one timer — if IT stalls, every
  // reactive worker is dark. Registering it as a real readiness worker
  // makes that the canonical observable signal.
  const safetyNetTickMs = 30 * 60 * 1000;
  registerWorker("reactive_safety_net", safetyNetTickMs);
  let safetyNetReady = false;
  const reactiveSafetyNet = setInterval(() => {
    let missedWorkCount = 0;
    for (const entry of reactiveWorkers) {
      missedWorkCount += entry.skippedReactiveFires;
      entry.skippedReactiveFires = 0;
      fireReactiveWorker(entry, "safety_net");
    }
    recordWorkerTick("reactive_safety_net");
    if (!safetyNetReady) { markWorkerReady("reactive_safety_net"); safetyNetReady = true; }
    try {
      emitEvent(db, {
        kind: "worker_tick_completed",
        substrate_origin: "substrate_auto",
        payload: { worker: "reactive_safety_net", activation_source: "safety_net", missed_work_count: missedWorkCount, expected_interval_ms: safetyNetTickMs },
      });
    } catch { /* db may already be closed */ }
  }, safetyNetTickMs);
  // Mark reactive_safety_net ready immediately on first invocation: the
  // setInterval registration is the tick semantics, so the daemon can
  // be considered "ready" without waiting 30 minutes for the first
  // safety-net firing.
  recordWorkerTick("reactive_safety_net");
  markWorkerReady("reactive_safety_net");
  safetyNetReady = true;
  workers.push(() => {
    clearInterval(reactiveSafetyNet);
    for (const dispose of activationDisposers.splice(0)) dispose();
  });

  // Health counts refresher. Pushes the four COUNT(*) queries OFF the /health
  // request path entirely. The COUNT(*) on a 100k+ events table under active
  // WAL-writer load takes several seconds and blocks the bun:sqlite main
  // thread; running it every 5s starved the JS event loop and prevented
  // /health from responding within its 5s rpc timeout. With a 60s refresh
  // cadence and 3-5s worst-case tick blocking, /health probes outside the
  // blocking window (~92%+ of the time) return immediately from the cache.
  // First refresh is scheduled via setTimeout so daemon boot is not blocked
  // on the initial COUNT(*); /health returns cached zeros for the first ~1s
  // until the first refresh completes.
  setTimeout(() => { void refreshHealthCounts(db).catch(() => { /* swallow */ }); }, 250);
  // Hard timer: /health cache freshness degrades with elapsed time even if no ledger event arrives.
  const healthCountsTick = setInterval(() => {
    void refreshHealthCounts(db).catch(() => { /* keep stale cache */ });
  }, 60_000);
  workers.push(() => clearInterval(healthCountsTick));

  // Worker tick intervals — declared here so /health can compute the
  // "stuck after 3× interval" threshold without reading env vars twice.
  // For REACTIVE workers (markWorkerReactive in registerReactiveWorker)
  // these intervals are observational metadata only — the reactive
  // safety net (30 min) is the genuine deadline. Universal defaults
  // chosen so an operator who never tunes anything still gets sane
  // behavior; per the f13 frontier inventory, these will be replaced
  // by adaptive scoring in a later cohort, not by env knobs.
  // Amendment worker is reactive (subscription on directive_amended).
  // 2s is the observational label only — the actual cadence is
  // event-driven (instant on directive_amended) with the reactive
  // safety net as upper bound. Universal value; no env knob.
  const amendmentTickMs = 2000;
  const gaugeTickMs = 30_000;
  const integrityIntervalMs = 6 * 60 * 60 * 1000;
  const embedderIntervalMs = 10_000;
  const rehabIntervalMs = 6 * 60 * 60 * 1000;
  // Supervisor cadence — reactive worker, so 30s is observational.
  // Defined here so the readiness registerWorker call below can use it
  // without forward-referencing the value defined later in the file.
  const SUPERVISOR_INTERVAL_MS = 30_000;
  const rollingIntervalMs = 60_000;
  // Father is fully reactive (onEvent("*") subscription at line ~1296);
  // this constant is purely the observability label for readiness — the
  // "expected" cadence between journal entries. The reactive_safety_net
  // (30 min) is the genuine deadline. Universal value — no env knob.
  const fatherIntervalMs = 5 * 60 * 1000;
  // MCP session-reaper cadence (2026-05-23). Universal default 30s; the
  // genuine deadline is the same supervisedTick wrapper as every other worker.
  const mcpSessionReaperTickMs = resolveReapIntervalMs();

  // Batch 3.OPS readiness: always-on workers must be registered up-front
  // so /ready can refuse traffic until each has completed its first tick.
  // Robustness: declare each worker's tick interval so /health can flag
  // "stuck" workers that miss 3× consecutive ticks.
  //
  // All subsystems default ON. Production wants the full organism running
  // out of the box — embedder + recipe-replay + rolling-review + father +
  // scheduler. Tests opt OUT in tests/preload.ts (the suite must never call
  // OpenAI or alter long-lived state). The single canonical opt-out lever
  // is `ACC2_DISABLE_WORKERS` — comma-separated list of worker names
  // (see runtime/worker_autostart.ts).
  //
  // ROLE=server skip: the daemon registers no workers in server-only role
  // so the main event loop stays free for HTTP/MCP requests. Worker setup
  // also runs early before port binding; a "register only, no setInterval"
  // pre-step would still call expensive readiness paths, so the entire
  // block — registration plus setIntervals — is gated.
  if (!skipWorkers) {
  // Brain audit D (2026-05-15) closure: amendment + metrics_gauge_refresh
  // are part of the canonical ACC2_DISABLE_WORKERS taxonomy (WorkerName
  // union in runtime/worker_autostart.ts). Pre-fix these two registered
  // unconditionally so operators could not opt them out via the canonical
  // env var. Per the same audit lesson, isWorkerEnabled gates them now.
  if (isWorkerEnabled("amendment")) registerWorker("amendment", amendmentTickMs);
  if (isWorkerEnabled("metrics_gauge_refresh")) registerWorker("metrics_gauge_refresh", gaugeTickMs);
  if (isWorkerEnabled("integrity")) registerWorker("integrity", integrityIntervalMs);
  if (isWorkerEnabled("embedder")) registerWorker("embedder", embedderIntervalMs);
  if (isWorkerEnabled("rehabilitation")) registerWorker("rehabilitation", rehabIntervalMs);
  if (isWorkerEnabled("rolling_reviewer")) registerWorker("rolling_reviewer", rollingIntervalMs);
  if (isWorkerEnabled("father")) registerWorker("father", fatherIntervalMs);
  if (isWorkerEnabled("scheduler")) registerWorker("scheduler");
  if (isWorkerEnabled("supervisor")) registerWorker("supervisor", SUPERVISOR_INTERVAL_MS);
  if (isWorkerEnabled("compaction")) registerWorker("compaction", 60 * 60 * 1000);
  if (isWorkerEnabled("recipe_inertia")) registerWorker("recipe_inertia", 60 * 60 * 1000);
  if (isWorkerEnabled("verify_heal")) registerWorker("verify_heal", 60 * 60 * 1000);
  // Brain audit B (2026-05-15): register the Model-D extractors worker
  // so candidate→promoted advancement happens on a bounded cadence,
  // not by chance dispatch through Father.
  if (isWorkerEnabled("extractors")) registerWorker("extractors", 5 * 60 * 1000);
  // Experience compression worker (primitive #3 of SZG5PQ01 design,
  // owner-approved via amendment GHWARJHT1N26BA1T7HNSJJ5AAG from
  // Q2NTPKM dispatch). Clusters successful trajectories (low residual +
  // closure_residual < 0.3 + lesson_extracted) and emits compressed
  // knowledge_candidate/recipe-shape knowledge, plus retires stale lessons
  // via applied_change_committed status='refused' reason=
  // 'compression_supersede'. REUSE-FIRST: no new event kinds.
  // Default cadence 30min — fast enough to catch new patterns within
  // an active session, slow enough to keep the SQLite write queue
  // light.
  if (isWorkerEnabled("experience_compression")) registerWorker("experience_compression", 30 * 60 * 1000);
  // F3 (2026-05-18): lifecycle closure sweep. Default 6h cadence;
  // 6 h cadence (universal — reactive). Opt-out via
  // ACC2_DISABLE_WORKERS=lifecycle_closure_sweep.
  if (isWorkerEnabled("lifecycle_closure_sweep")) registerWorker("lifecycle_closure_sweep", 6 * 60 * 60 * 1000);
  // F11 (2026-05-18, contract 2AMJKN0GTX32790173EPYH6YT4): contract
  // amendment flywheel consumer. Default 5min cadence; overridable via
  // 5-min cadence (universal — reactive). Opt-out via
  // ACC2_DISABLE_WORKERS=contract_amendment_consumer.
  if (isWorkerEnabled("contract_amendment_consumer")) registerWorker("contract_amendment_consumer", 5 * 60 * 1000);
  // F-resilience: opportunistic WAL pressure check (default 30s).
  // Much shorter than the 6h lifecycle sweep — WAL pressure can develop
  // within seconds under a burst write storm; the worker has to be
  // ticking on a sub-minute cadence to catch it before /health stalls.
  if (isWorkerEnabled("wal_pressure_check")) registerWorker("wal_pressure_check", 30 * 1000);
  // 2026-05-19 (KCs YKJYRGVJJX21XAMQS042PMK7JG +
  // G3CBVAGY2S5QN5XDC1GR7GJP0G): pending_decision_retire_worker.
  // Auto-prunes stale / test-file-target / anchor-missing rows from
  // the pending_owner_decision_queue surface so the operator never
  // sees 40+ rows of brain-routing noise. Default 1h cadence; the
  // reactive activation is required because malformed anchorless
  // proposals can arrive in bursts and must not wait an hour before
  // disappearing from the live owner-decision surface.
  // Opt-OUT via ACC2_DISABLE_WORKERS=pending_decision_retire.
  if (isWorkerEnabled("pending_decision_retire")) registerWorker("pending_decision_retire", 60 * 60 * 1000);
  // 2026-05-19 (brain amendment 1Z3PMEYE7X44343E7K8ARCDY20, T1.1):
  // owner-outcome follow-up worker. Closes the owner-truth feedback
  // loop — substrate had 287K events but only 2
  // owner_observed_outcome_recorded rows. The worker scans
  // applied_change_committed events older than the feedback window
  // (default 24h) and emits one hidl_action_required per eligible
  // change asking the owner whether the change worked. Default 30min
  // cadence. Opt-out via ACC2_DISABLE_WORKERS=owner_outcome_followup.
  if (isWorkerEnabled("owner_outcome_followup")) registerWorker("owner_outcome_followup", 30 * 60 * 1000);
  // 2026-05-20 (T4.1 counterfactual credit, docs/roadmap.md Tier 6):
  // every selection boundary (artifact pick, route choice, retrieval
  // top-K filter) emits counterfactual_alternative_recorded with the
  // rejected candidate set + window_seconds. This worker scans rows
  // older than their window, looks up the chosen path's action_scored
  // residual, and emits act_artifact_score_updated against each
  // rejected candidate so selector posteriors learn from outcomes the
  // chosen path produced. Default 5-minute cadence.
  // Opt-out via ACC2_DISABLE_WORKERS=counterfactual_credit.
  if (isWorkerEnabled("counterfactual_credit")) registerWorker("counterfactual_credit", 5 * 60 * 1000);
  // 2026-05-22 (phase-2 SJPF3VB9): standing observability-fidelity guard.
  // Hourly tick — institutionalizes wired-but-inert loop detection
  // (loop_inert_alert) + lying-metric detection (metric_veracity_alert)
  // as permanent self-audits. Opt-out via
  // ACC2_DISABLE_WORKERS=observability_guard.
  if (isWorkerEnabled("observability_guard")) registerWorker("observability_guard", 60 * 60 * 1000);
  // 2026-05-23 (MCP session GC, owner-directed reliability fix): periodic
  // reaper that force-closes leaked/dead/idle/over-cap fastmcp sessions.
  // Only meaningful when this daemon binds the MCP port (role=server/all);
  // on role=worker (skipPorts) there is no mcpServer so the tick no-ops.
  // Opt-out via ACC2_DISABLE_WORKERS=mcp_session_reaper.
  if (!skipPorts && isWorkerEnabled("mcp_session_reaper")) registerWorker("mcp_session_reaper", mcpSessionReaperTickMs);
  // Tier -1 floors (docs/roadmap.md): absence-of-violation evidence
  // emitters. Each predicate (event_authenticity_predicate,
  // storage_integrity_predicate, deterministic_computation_sanity_predicate,
  // kernel_sandbox_integrity_predicate, owner_identity_continuity_predicate)
  // is admitted in substrate/seed.ts. Workers tick periodically and
  // emit *_check rows on clean pass, integrity_check_failed on violation.
  if (isWorkerEnabled("event_authenticity")) registerWorker("event_authenticity", 60 * 1000);
  if (isWorkerEnabled("storage_integrity_floor")) registerWorker("storage_integrity_floor", 5 * 60 * 1000);
  if (isWorkerEnabled("deterministic_computation")) registerWorker("deterministic_computation", 10 * 60 * 1000);
  if (isWorkerEnabled("kernel_sandbox")) registerWorker("kernel_sandbox", 5 * 60 * 1000);
  if (isWorkerEnabled("owner_identity")) registerWorker("owner_identity", 5 * 60 * 1000);

  // Phase E: amendment worker — drain unapplied directive_amended events when
  // directive amendments arrive. The shared reactive safety net is the fallback
  // for missed in-process notifications. Errors are surfaced as error_caught
  // events (one per amendment) so a malformed amendment can't kill the daemon
  // AND never vanishes silently.
  // Brain audit D (2026-05-15) closure: gate the amendment reactive
  // worker on isWorkerEnabled too (matches the registerWorker pre-check
  // earlier). Without this, ACC2_DISABLE_WORKERS=amendment opt-out
  // disabled the periodic tick registration but kept the reactive
  // dispatcher running — pathology surface for operators expecting
  // the env var to fully silence the worker.
  if (isWorkerEnabled("amendment")) {
    let amendmentMarked = false;
    const amendmentTick = supervisedTick(db, "amendment", amendmentTickMs, async () => {
      const unapplied = findUnappliedAmendments(db);
      for (const id of unapplied) {
        try {
          await applyAmendment(db, id);
        } catch (err) {
          logger.warn(
            { amendment_id: id, err: (err as Error).message },
            "applyAmendment failed — surfaced as error_caught, continuing",
          );
          try {
            emitEvent(db, {
              kind: "error_caught",
              substrate_origin: "substrate_auto",
              payload: {
                where: "daemon.amendment.apply",
                recoverable: true,
                amendment_id: id,
                message: (err as Error).message,
              },
            });
          } catch (emitErr) {
            logger.debug(
              { where: "daemon.amendment.emit", err: String(emitErr) },
              "could not emit error_caught (db likely closed)",
            );
          }
        }
      }
      if (!amendmentMarked) { markWorkerReady("amendment"); amendmentMarked = true; }
    });
    registerReactiveWorker("amendment", amendmentTickMs, ["directive_amended"], amendmentTick, { minReactiveGapMs: amendmentTickMs });
    // Fire one synchronous mark right away so amendment readiness does
    // not block /ready for 2s on a quiet daemon.
    markWorkerReady("amendment");
    amendmentMarked = true;
    recordWorkerTick("amendment");
  }
  // amendment is activation-driven; activationDisposers are cleared on shutdown.

  // Batch 3.OPS: gauge refresh (every 30s) keeps the SQLite-backed gauges
  // (substrate_events_total, act_artifacts_*) live for /metrics scrapes.
  // Hard timer: scrape freshness is elapsed-time based, not ledger-arrival control flow.
  const gaugeTick = setInterval(
    supervisedTick(db, "metrics_gauge_refresh", gaugeTickMs, async () => {
      refreshGauges(db, startedAtMs);
    }),
    gaugeTickMs,
  );
  refreshGauges(db, startedAtMs); // initial snapshot
  markWorkerReady("metrics_gauge_refresh");
  recordWorkerTick("metrics_gauge_refresh");
  workers.push(() => clearInterval(gaugeTick));

  // T3.8/T5: sql_worker_pool_metrics emitter. Every 30s the pool's
  // pending/active/completed counters + percentile wait/exec latencies
  // are written to the ledger so /metrics + dashboards can plot the
  // event-loop unblock progress. The pool is opt-out via
  // ACC2_DISABLE_SQL_POOL=1; when absent the interval is a no-op.
  const sqlPoolMetricsTickMs = 30_000;
  const sqlPoolMetricsTick = setInterval(() => {
    const p = sqlPool;
    if (!p) return;
    try {
      const m = p.metrics();
      emitEvent(db, {
        kind: "sql_worker_pool_metrics",
        substrate_origin: "substrate_auto",
        payload: {
          workers: m.workers,
          pending: m.pending,
          active: m.active,
          completed: m.completed,
          failed: m.failed,
          rejected_overflow: m.rejected_overflow,
          timed_out: m.timed_out,
          worker_respawns: m.worker_respawns,
          avg_wait_ms: m.avg_wait_ms,
          p50_wait_ms: m.p50_wait_ms,
          p90_wait_ms: m.p90_wait_ms,
          p99_wait_ms: m.p99_wait_ms,
          avg_exec_ms: m.avg_exec_ms,
        },
      });
    } catch (err) {
      logger.debug({ where: "daemon.sql_pool_metrics_tick", err: String(err) }, "emit failed (db likely closed)");
    }
  }, sqlPoolMetricsTickMs);
  workers.push(() => clearInterval(sqlPoolMetricsTick));

  // Batch 3.OPS: DB integrity worker. Default ON unless explicitly
  // disabled (`ACC2_DISABLE_WORKERS=integrity` for tests). 6h cadence
  // is universal — replaced by adaptive scoring in a later cohort.
  if (isWorkerEnabled("integrity")) {
    let integrityMarked = false;
    const integrityTick = supervisedTick(db, "integrity", integrityIntervalMs, async () => {
      await integrityWorkerTick(db);
      if (!integrityMarked) { markWorkerReady("integrity"); integrityMarked = true; }
    });
    registerReactiveWorker("integrity", integrityIntervalMs, ["brain_dispatched", "brain_dispatch_closed", "bridge_failed", "task_node_opened", "task_committed", "task_failed", "task_abandoned"], integrityTick, { minReactiveGapMs: integrityIntervalMs });
    // Mark ready immediately — worker readiness is decoupled from the
    // (now deferred) boot integrity scan. The deferred runBootIntegrityCheck
    // surfaces the page-level verdict via /health.boot_integrity; this
    // reactive worker re-checks on dispatch/task events and the periodic 6h
    // cadence. The shared safety net still covers stale dispatch/task scans.
    markWorkerReady("integrity");
    integrityMarked = true;
    recordWorkerTick("integrity");
    // integrity is activation-driven; activationDisposers are cleared on shutdown.
  }

  // Batch 8.B: supervisor worker — runs the three stuck/loop detectors
  // (redispatch storm / DAG explosion / bridge health) on a tight 30s
  // interval. Default ON unless ACC2_DISABLE_WORKERS=supervisor.
  // Decoupled from the integrity worker (whose default tick is 6h, far
  // too slow to catch tight loops live). SUPERVISOR_INTERVAL_MS is
  // declared up at the worker-tick-intervals block — 30 s is the
  // universal cadence for reactive supervisor checks.
  if (isWorkerEnabled("supervisor")) {
    const { supervisorTick } = await import("./supervisor");
    let supervisorMarked = false;
    const supervisorTickHandle = supervisedTick(db, "supervisor", SUPERVISOR_INTERVAL_MS, async () => {
      supervisorTick(db);
      if (!supervisorMarked) { markWorkerReady("supervisor"); supervisorMarked = true; }
    });
    registerReactiveWorker("supervisor", SUPERVISOR_INTERVAL_MS, ["brain_dispatched", "action_predicted", "task_node_opened", "task_committed", "task_failed", "task_abandoned", "bridge_failed", "bridge_completed"], supervisorTickHandle, { minReactiveGapMs: SUPERVISOR_INTERVAL_MS });
    markWorkerReady("supervisor");
    supervisorMarked = true;
    recordWorkerTick("supervisor");
    // supervisor is activation-driven; activationDisposers are cleared on shutdown.
  }

  // RLM-first clean break (2026-05-22): the rule-based rendering-audit
  // worker (verifyRendering jargon/ID post-check) was removed. The LM
  // renders owner-facing text in the owner's language at high quality,
  // instructed by the OWNER RENDERING POLICY prompt section. No
  // deterministic post-audit parallel path.

  // Batch 10: substrate compactor — periodic pruning of bridge_frame_received
  // rows older than COMPACTION_FRAME_RETENTION_MS (24h default). The
  // canonical events (brain_dispatched, action_predicted, action_scored,
  // task_committed) STAY forever; only the per-frame mirror is pruned.
  // Runs hourly so steady-state growth never exceeds one day of frames.
  // Hard timer: retention expiry is elapsed-time based, not event-arrival control flow.
  const COMPACTION_INTERVAL_MS = 60 * 60 * 1000;
  if (isWorkerEnabled("compaction")) {
    const { compactionWorkerTick } = await import("./compaction");
    let compactionMarked = false;
    const compactionTickHandle = setInterval(
      supervisedTick(db, "compaction", COMPACTION_INTERVAL_MS, async () => {
        compactionWorkerTick(db);
        if (!compactionMarked) { markWorkerReady("compaction"); compactionMarked = true; }
      }),
      COMPACTION_INTERVAL_MS,
    );
    markWorkerReady("compaction");
    compactionMarked = true;
    recordWorkerTick("compaction");
    workers.push(() => clearInterval(compactionTickHandle));
  }

  // Brain audit B (2026-05-15): extractors worker — periodic scan of
  // open knowledge_candidate and act_artifact rows that have crossed
  // the promotion thresholds. Pre-fix the only way these advanced was
  // chance dispatch through Father; substrate counts showed 0/53
  // act_artifact_promoted and 0/70 promoted recipe-shape knowledge. Running on a
  // bounded 5-min cadence makes promotion a substrate liveness function.
  const EXTRACTORS_INTERVAL_MS = 5 * 60 * 1000;
  if (isWorkerEnabled("extractors")) {
    // Brain convergence axis F (2026-05-15): the extractors worker now
    // also runs extractRecipeCandidates and extractSemanticDedup so
    // recipe extraction is a substrate liveness function on the same
    // 5-min cadence; pre-fix Father's recipe_extraction_pass template
    // was the only path, leaving long gaps when Father was busy on
    // other objectives.
    const {
      extractKnowledgePromotions,
      extractActArtifactScores,
      extractRecipeCandidates,
      extractSemanticDedup,
      extractCrossCandidateCorroboration,
      extractDirectiveInterference,
      extractOwnerProfilePromotions,
    } = await import("../substrate/extractors");
    const { runOwnerAutonomyAdjusterTick } = await import("../substrate/owner_autonomy_adjuster");
    const runExtractorsOnce = async (): Promise<void> => {
      try { await extractKnowledgePromotions(db); } catch (err) {
        logger.warn({ where: "daemon.extractors.knowledge", err: (err as Error).message }, "knowledge extractor tick failed");
      }
      try { await extractActArtifactScores(db); } catch (err) {
        logger.warn({ where: "daemon.extractors.act_artifact", err: (err as Error).message }, "act artifact extractor tick failed");
      }
      try { await extractRecipeCandidates(db); } catch (err) {
        logger.warn({ where: "daemon.extractors.recipes", err: (err as Error).message }, "recipe extractor tick failed");
      }
      try {
        const semanticDedup = await extractSemanticDedup(db);
        const redundant = Number((semanticDedup as { redundant_count?: number }).redundant_count ?? 0);
        const confirmed = Number((semanticDedup as { confirmed_count?: number }).confirmed_count ?? 0);
        if (redundant >= 10 && redundant > confirmed * 2) {
          const request = emitEvent(db, {
            kind: "brain_invocation_request",
            substrate_origin: "substrate_auto",
            payload: {
              request_reason: "extractor_dedup_noise_floor_rising",
              topic_keywords: ["semantic_dedup", "noise_floor", "knowledge_candidate_redundant"],
              triggering_event_ids: [],
              cited_artifact_ids: [],
              cited_knowledge_ids: [],
              emitter_identity: "extractors.semantic_dedup",
              urgency: "normal",
              metrics: { redundant_count: redundant, confirmed_count: confirmed },
            } as JsonValue,
          });
          logger.info({ request_event_id: request.id, redundant, confirmed }, "semantic-dedup extractor requested brain synthesis");
        }
      } catch (err) {
        logger.warn({ where: "daemon.extractors.semantic_dedup", err: (err as Error).message }, "semantic-dedup extractor tick failed");
      }
      // T1.3 cross-candidate semantic corroboration (2026-05-19): scan
      // unverified knowledge_candidate rows for nearest promoted-knowledge
      // neighbors via vec_events cosine and emit candidate_confirmed
      // (confirmation_source=semantic_corroboration) so the long tail of
      // never-cited candidates can still feed the Beta-posterior promotion
      // gate. Live evidence: 3324+ candidates vs ~311 promoted (~9.3%).
      try { await extractCrossCandidateCorroboration(db); } catch (err) {
        logger.warn({ where: "daemon.extractors.cross_candidate_corroboration", err: (err as Error).message }, "cross-candidate-corroboration extractor tick failed");
      }
      // Tier-S2 causal-edge posterior (brain KC G3PR7X6TCD4T57D7T6GXCDY9AW,
      // 2026-05-19): admit causal_edge_predicate rows for citation
      // co-occurrence and refinement edges so edges between substrate
      // entities can accumulate their own Beta posterior. Bounded: 500
      // acts per tick, 14-day window, yields every 25 rows.
      try {
        const { extractCausalEdges } = await import("./causal_edge_extractor");
        await extractCausalEdges(db);
      } catch (err) {
        logger.warn({ where: "daemon.extractors.causal_edges", err: (err as Error).message }, "causal-edge extractor tick failed");
      }
      // Tier-S5 goal-shape predicate (brain KC G3PR7X6TCD4T57D7T6GXCDY9AW,
      // 2026-05-19): scan recent act_artifact_score_updated events, group
      // residuals by goal_shape, and admit/refresh one
      // act_artifact{kind:goal_shape_strategy_predicate} row per shape.
      // Each row scores whether the goal_shape tag PREDICTS trajectory
      // similarity (low residual variance = good shape) — closes the
      // feedback loop for posterior-per-goal_class predicates (T2.2,
      // T2.3, T4.1). Bounded: 5000 events per tick, 14-day window,
      // yields every 25 distinct shapes.
      try {
        const { extractGoalShapePredicates } = await import("./goal_shape_predicate_extractor");
        await extractGoalShapePredicates(db);
      } catch (err) {
        logger.warn({ where: "daemon.extractors.goal_shape_predicates", err: (err as Error).message }, "goal-shape-predicate extractor tick failed");
      }
      // Tier-S3 trajectory-motif posterior (brain KC G3PR7X6TCD4T57D7T6GXCDY9AW,
      // 2026-05-19): admit trajectory_motif_predicate rows for frequent
      // multi-event n-grams (3-grams and 4-grams) across directives so
      // recipe shapes accumulate their own Beta posterior. Complementary
      // to S2 causal-edge — edges score pairs, motifs score sequences.
      // Bounded: 5000 events per tick, 30-day window, top 50 motifs,
      // yields every 25 directives.
      try {
        const { extractTrajectoryMotifs } = await import("./trajectory_motif_extractor");
        await extractTrajectoryMotifs(db);
      } catch (err) {
        logger.warn({ where: "daemon.extractors.trajectory_motifs", err: (err as Error).message }, "trajectory-motif extractor tick failed");
      }
      // Tier-S1 DAG decomposition strategy (brain KC G3PR7X6TCD4T57D7T6GXCDY9AW,
      // 2026-05-19): scan completed directives (those with
      // task_closure_audited) in a 30-day window, build per-directive
      // DAG fingerprints (fan_out, max_depth, total_nodes), bucket by
      // deterministic shape category (wide_shallow / deep_narrow /
      // balanced / tree_heavy / minimal / other), and admit/refresh one
      // act_artifact{kind:decomposition_strategy_predicate} row per
      // shape that meets the 5-sample threshold. Closes the Tier-S
      // sequence: substrate now learns whether a SHAPE predicts
      // closure_residual, not just whether a leaf does.
      try {
        const { extractDecompositionStrategy } = await import("./decomposition_strategy_extractor");
        await extractDecompositionStrategy(db);
      } catch (err) {
        logger.warn({ where: "daemon.extractors.decomposition_strategy", err: (err as Error).message }, "decomposition-strategy extractor tick failed");
      }
      // Auto cross-directive interference (organism-alignment Track C,
      // 2026-05-15): scan act_artifact.target_resources/target_files for cross-directive
      // overlap and emit resource_conflict edges so the scheduler defers
      // racing dispatches. Idempotent — re-runs dedupe against existing
      // edges.
      try { await extractDirectiveInterference(db); } catch (err) {
        logger.warn({ where: "daemon.extractors.directive_interference", err: (err as Error).message }, "directive-interference extractor tick failed");
      }
      // Owner profile promotions (Layer-2 conversation-as-learning-surface,
      // DSGSAZGMF1): owner_insight_candidate → owner_profile_recorded via
      // confidence ≥ 0.85 / owner-approval bypass / sibling cosine.
      try { await extractOwnerProfilePromotions(db); } catch (err) {
        logger.warn({ where: "daemon.extractors.owner_profile", err: (err as Error).message }, "owner-profile extractor tick failed");
      }
      // Outcome-driven autonomy_score adjuster (DSGSAZGMF1 follow-up,
      // 2026-05-15): fold recent applied_change_committed / failed /
      // irreversible_effect_recorded events into a delta on
      // owner_profile.autonomy_score. Idempotent via context_refs
      // back-pointers. Without this, the score is "continuous" in
      // type but static in practice — every owner sits at the default
      // forever. With it, the substrate EARNS trust through outcomes.
      try { runOwnerAutonomyAdjusterTick(db); } catch (err) {
        logger.warn({ where: "daemon.extractors.autonomy_adjuster", err: (err as Error).message }, "autonomy-adjuster tick failed");
      }
    };
    let extractorsMarked = false;
    const extractorsTickHandle = supervisedTick(db, "extractors", EXTRACTORS_INTERVAL_MS, async () => {
      await runExtractorsOnce();
      if (!extractorsMarked) { markWorkerReady("extractors"); extractorsMarked = true; }
    });
    registerReactiveWorker("extractors", EXTRACTORS_INTERVAL_MS, ["knowledge_candidate", ...ARTIFACT_CANDIDATE_KINDS, "action_scored", "task_committed", "lesson_extracted", "owner_insight_candidate", "owner_input_received", "owner_observed_outcome_recorded", "applied_change_committed", "applied_change_failed", "irreversible_effect_recorded"], extractorsTickHandle, { minReactiveGapMs: EXTRACTORS_INTERVAL_MS });
    // Round-2 audit (2026-05-15): run ONE extractor pass at boot so
    // candidates accumulated while the daemon was off don't wait the full
    // 5-min cadence. 2026-05-21 R2 instant-startup: DEFER this pass by
    // BOOT_HEAVY_PASS_DELAY_MS. runExtractorsOnce scans the whole event
    // table through ~10 extractors (causal_edge, trajectory_motif,
    // semantic_dedup, …); on the production-size DB its synchronous
    // bun:sqlite queries grind the single event loop for tens of seconds.
    // Running it immediately at boot starved the port-bind + first /health
    // window (measured: 56s embedder/extractor grind delayed listening).
    // Deferring lets the daemon bind ports and serve health FIRST, then
    // do the heavy backfill pass. /ready still flips only after the pass
    // (real liveness); /health + MCP serve from bind time.
    // INSTANT-STARTUP (perf fix): mark extractors ready IMMEDIATELY rather
    // than gating worker-readiness on the heavy boot pass. runExtractorsOnce
    // scans the whole event table through ~10 extractors and grinds the event
    // loop for tens-to-hundreds of seconds on a production DB; gating
    // markWorkerReady on it meant the "all workers completed first tick" gate
    // (and therefore the MCP port bind + /health) waited the FULL pass —
    // measured ~322s boot, leaving /health=000 for 5 minutes. The embedder
    // already marks ready immediately + defers its boot tick (same rationale);
    // extractors now matches. The heavy pass still runs (deferred, background);
    // it just no longer blocks the daemon from binding + serving.
    if (!extractorsMarked) { markWorkerReady("extractors"); extractorsMarked = true; }
    setTimeout(() => {
      void (async () => {
        try {
          await runExtractorsOnce();
        } finally {
          recordWorkerTick("extractors");
        }
      })();
    }, BOOT_HEAVY_PASS_DELAY_MS).unref();
    // extractors is activation-driven; activationDisposers are cleared on shutdown.
  }

  // auto_apply worker stage-2 contract: Claude Code is not the serial hand-
  // applier for every eligible amendment. A substrate worker may apply ONLY
  // lesson_implementer_queue_view rows with auto_apply_eligible=1, semantic
  // amendment intent over the current file state, no owner_profile things_to_never_do conflict,
  // no trajectory hazard, an isolated worktree at current default-branch HEAD,
  // and a zero-regression verifier run (`bun test --bail`) before emitting
  // applied_change_committed via cli/apply.ts recordApplyOutcome. Failures emit
  // applied_change_failed, leave the source checkout untouched, and preserve the
  // local worktree/patch path in the payload for reversible operator review.
  // Claude Code remains the owner-visible exception handler for owner-gated,
  // owner-sensitive, failing-test, or cross-surface proposals.

  // Brain audit bqlr29psq (2026-05-15): daemon source hot-reload worker.
  // Watches runtime/, substrate/, cli/ via fs.watch (recursive). When a
  // change matches HOTRELOAD_MANIFEST, emits daemon_hotreload_triggered
  // and applies the declared strategy (in_process / quiescent_only /
  // full_restart). The daemon stays alive on syntax errors — the
  // previous module reference is never overwritten.
  //
  // Opt-out via the canonical worker taxonomy: ACC2_DISABLE_WORKERS=hotreload.
  if (isWorkerEnabled("hotreload")) {
    try {
      const { startHotreloadWorker } = await import("./hotreload_worker");
      // Brain-dispatch survival gate (XA3ABKERHD4H, 77N73035F97Z):
      // quiescence is defined by the canonical recency-bounded predicate
      // `noActiveBrainDispatches` in runtime/dispatch_survival.ts — a
      // brain_dispatched row within the 1-hour recency window without a
      // matching brain_dispatch_closed counts as live. The recency window
      // excludes legacy orphans (boot reconciliation owns those) so the
      // quiescence gate doesn't wedge forever on a wedged historic row.
      //
      // When the predicate refuses, emit one `hotreload_deferred` audit
      // event per refusal so persistent deferrals show up as a
      // health_metric signal (operator's substrate-status should see
      // "reload deferred N times waiting on brain close"). The
      // hotreload_worker still owns the actual deferral semantics (it
      // calls isQuiescent during processChange and again from
      // drainPendingQuiescent when a close event lands) — we just add
      // the observability leg.
      let lastDeferredEmissionMs = 0;
      const DEFERRED_EMISSION_MIN_GAP_MS = 1_000; // dedupe rapid bursts
      const isQuiescent = (): boolean => {
        const quiescent = noActiveBrainDispatches(db);
        if (!quiescent) {
          const now = Date.now();
          if (now - lastDeferredEmissionMs >= DEFERRED_EMISSION_MIN_GAP_MS) {
            lastDeferredEmissionMs = now;
            try {
              emitEvent(db, {
                kind: "hotreload_deferred",
                substrate_origin: "substrate_auto",
                payload: {
                  reason: "brain_dispatched_without_close",
                  waiting_for_close: true,
                },
              });
            } catch (err) {
              logger.debug(
                { where: "daemon.hotreload.deferred_emit", err: String(err) },
                "could not emit hotreload_deferred (db may be closing)",
              );
            }
          }
        }
        return quiescent;
      };
      const projectRoot = process.env.ACC2_PROJECT_ROOT ?? process.cwd();
      const disposer = startHotreloadWorker(db, { projectRoot, isQuiescent });
      workers.push(disposer);
    } catch (err) {
      logger.warn(
        { where: "daemon.hotreload_worker.start", err: (err as Error).message },
        "hot-reload worker could not start — daemon continues without it",
      );
    }
  }

  // Phase F: embedder worker. Default ON — production wants every
  // text-bearing event embedded so substrate.search returns useful
  // results from the first directive forward. Opt-OUT via
  // `ACC2_DISABLE_WORKERS=embedder` (tests/preload.ts pins the full set
  // so the unit suite never hits the OpenAI API). Tick every 10s with
  // batch=20; errors surface as error_caught events so a single bad
  // row can't kill the daemon and never vanishes silently.
  if (isWorkerEnabled("embedder")) {
    let embedderMarked = false;
    const embedderTick = supervisedTick(db, "embedder", embedderIntervalMs, async () => {
      // Embeddable-only count (per FAWT1B3BT56S + T6EQS07X6X0V + VEC3MX7RD15F):
      // raw COUNT(*) WHERE embedding IS NULL over-counts massively because
      // substrate-internal chatter (worker_tick_completed, candidate_confirmed,
      // origin_calibration_recorded, bridge_frame_received, retrieval_binding,
      // embedding_computed, ...) is intentionally NEVER embedded. The daemon
      // saw 252K-event "backlog" on a DB whose actual embeddable backlog was
      // 1,543. The raw count then drove batchSize up to 200, which made the
      // per-tick SQL scan (WHERE kind IN (10 kinds) AND embedding IS NULL
      // ORDER BY ts LIMIT 200) sweep the whole event table to find a few
      // hundred matches — that scan was the wedge, not the OpenAI roundtrip.
      //
      // The embeddable-only count makes batch sizing honest. Cap batchSize
      // at 50 (well below OpenAI's 100-item per-request chunk) so worst-case
      // tick wall time stays bounded even on rare large backlogs.
      // 2026-05-21 main-loop-unlock fix: cap batch at 8 (was 50). The
      // embedder's OpenAI fetch is async (yields the loop), but the
      // per-row persist loop — UPDATE events + vec0 vector upsert ×
      // batchSize, all inside one synchronous BEGIN/COMMIT on the main
      // thread's db handle — is NOT yieldable. At batchSize=50 the vec0
      // (sqlite-vec) 1536-dim upserts pinned the event loop long enough
      // that the /health + MCP HEAD probe timed out (observed
      // mcp_unreachable_at_spawn at 13:39Z). Small batches keep each
      // tick's main-thread blocking bounded to <2s; the 10s reactive
      // cadence drains backlog steadily. The true fix (all writes off
      // the main thread via a dedicated writer worker) is roadmap Tier
      // "Main-Loop Write Isolation".
      const pendingEmbeddings = await pendingEmbeddableCount(db);
      const batchSize = Math.min(8, Math.max(1, pendingEmbeddings));
      // 2026-05-21 boot-death fix: do NOT index.reloadFromDb() after each
      // tick. reloadFromDb() = full EmbeddingIndex.rebuildFromDb (scans
      // embedding_index_view + decodes every embedded vector). A spurious
      // S0-wiring-dispatch amendment (K93WQJHW/B86VATTZ) added it after
      // every reactive embedder tick — repeated full-index rebuilds spun
      // the daemon to death post-bind (the boot hang debugged this session).
      // The embedder's persistEmbedding already upserts vec_events (the
      // durable store); vec0 MATCH queries hit the DB directly, so per-tick
      // in-memory reload is unnecessary. Periodic/incremental reload, if
      // ever needed, is a separate bounded concern — never per-tick.
      if (batchSize > 0) await embedderWorkerTick(db, { batchSize });
      if (!embedderMarked) { markWorkerReady("embedder"); embedderMarked = true; }
    }, {
      // Embedder ticks legitimately take 30-90s during heavy backlog
      // drain (OpenAI roundtrip × adaptive batchSize 200; the API gets
      // slower under per-org RPM pressure). Only flag overrun when the
      // wedge is structural — ≥ 10× the interval. The skip-fire still
      // happens every tick (correct); we just stop alarming the
      // operator on normal drain work.
      overrunThresholdMs: embedderIntervalMs * 10,
    });
    // 2026-05-21 MCP-saturation fix: replace wildcard subscription with the
    // EMBEDDABLE_KINDS set. Wildcard ["*"] caused embedder to re-fire on
    // every event emission (worker_tick_completed at 3.6/sec,
    // father_yielded at 1.7/sec, candidate_confirmed, origin_calibration_*
    // etc.). None of those kinds carry embeddable content, so each spurious
    // re-fire was wasted work that held the SQLite write lock and starved
    // the fastmcp HTTP request queue — the structural cause of CLI
    // mcp_call_failed:Request timed out at 120000ms observed across this
    // session (e.g., directive bmc10qmn1, bbeqlpgao). The embedder still
    // ticks at its 10s scheduled cadence for backlog drain, and the
    // EMBEDDABLE_KINDS list (knowledge_candidate, knowledge_promoted,
    // lesson_extracted, owner_input_received, etc.) is exactly the set of
    // emissions that can actually produce new vec_events rows.
    // 2026-05-21: minReactiveGapMs restored to embedderIntervalMs after
    // minReactiveGapMs:0 was found to DEATH-SPIRAL the daemon. With gap 0
    // the embedder fires on EVERY embeddable event; during boot (artifact
    // backfill + orphan reap + brain emissions burst events) a single
    // slow/stuck embedder tick + the constant re-firing churns the daemon
    // — observed this session: daemon binds, embedder logs "previous tick
    // still running" on every fire for ~30s, then the process dies
    // (resource exhaustion). Every OTHER reactive worker uses
    // minReactiveGapMs = its interval; the embedder's 0 was the lone
    // outlier and the lone death. A 10s gap (embedderIntervalMs) keeps
    // embeddings near-reactive (the worst-case staleness is one interval)
    // while preventing the fire-storm. The earlier "29 dropped fires /
    // query_embedding_unavailable" concern is addressed structurally by
    // supervisedTick's skip-gate, not by removing the rate limit.
    registerReactiveWorker("embedder", embedderIntervalMs, EMBEDDABLE_KINDS, embedderTick, { minReactiveGapMs: embedderIntervalMs });
    // Backlog drain is not reactive-only. registerReactiveWorker's safety
    // net fires every 30 minutes; with no new embeddable events, relying on
    // activation leaves historical unembedded rows idle. A dedicated bounded
    // interval keeps retrieval saturation trending to zero while the existing
    // supervisedTick running-gate prevents overlapping OpenAI/write work.
    const embedderBackfillTimer = setInterval(embedderTick, embedderIntervalMs);
    embedderBackfillTimer.unref();
    workers.push(() => clearInterval(embedderBackfillTimer));
    // Boot tick — fire embedding work asynchronously without blocking
    // daemon readiness. Pre-fix (2026-05-19, this commit): the boot
    // tick awaited a large OpenAI batch synchronously at startup
    // (batchSize up to 200 when pendingEmbeddings > 500). With a
    // 272K-event DB carrying a heavy unembedded backlog, each batch
    // call to OpenAI took 30-90s and starved the event loop for the
    // full duration. Bun.serve for the aux port (writeLockFile path)
    // was queued behind the embedder tick on the same event loop and
    // never fired; daemon was unreachable while pid was alive.
    //
    // Fix shape:
    //  - Mark embedder ready IMMEDIATELY so /ready flips and the
    //    aux-bind + writeLockFile path proceeds without waiting on
    //    the OpenAI roundtrip.
    //  - Cap the boot-tick batch at 8, matching the regular tick so
    //    main-thread vec0 persists stay bounded.
    //  - The regular 10s backfill interval drains historical backlog;
    //    reactive activation handles newly emitted embeddable events.
    //
    // Backlog drain shifts from "blocking startup" to "bounded
    // background work". The dedicated interval closes the retrieval
    // saturation hole without waiting for unrelated embeddable events.
    if (!embedderMarked) { markWorkerReady("embedder"); embedderMarked = true; }
    // 2026-05-21 R2 instant-startup: defer the embedder boot tick by
    // BOOT_HEAVY_PASS_DELAY_MS so its synchronous readUnembedded scan +
    // vec0 persist don't grind the event loop during the port-bind window.
    setTimeout(() => {
    void (async () => {
      try {
        // Boot-tick batch capped at 8 — same main-loop-unlock rationale as
        // the regular backfill tick above. The persist phase is synchronous
        // on the main thread; small batches bound the block. No per-tick
        // index.reloadFromDb() (boot-death fix — see above).
        await embedderWorkerTick(db, { batchSize: 8 });
        recordWorkerTick("embedder");
      } catch (err) {
        logger.warn(
          { err: (err as Error).message },
          "embedder boot-tick failed — surfaced as error_caught",
        );
        try {
          emitEvent(db, {
            kind: "error_caught",
            substrate_origin: "substrate_auto",
            payload: {
              where: "daemon.embedder.boot_tick",
              recoverable: true,
              message: (err as Error).message,
            },
          });
        } catch (emitErr) {
          logger.debug(
            { where: "daemon.embedder.boot_emit", err: String(emitErr) },
            "could not emit error_caught (db likely closed)",
          );
        }
      }
    })();
    }, BOOT_HEAVY_PASS_DELAY_MS).unref();
    // embedder has both event activation and a dedicated backlog interval;
    // activationDisposers and workers are cleared on shutdown.
  }

  // Phase H: rehabilitation worker. Default ON — production wants
  // quarantined artifacts to get a recovery chance on the canonical
  // cadence. Opt-OUT via `ACC2_DISABLE_WORKERS=rehabilitation`
  // (tests/preload.ts pins the full set so unit tests don't spawn
  // fixture subprocesses). 30-minute cadence is universal — the 14-day
  // quarantine cooldown still gates each candidate, so checking more
  // often only matters when many artifacts crossed the cooldown
  // simultaneously. Worker respects the canonical deadline pattern: a
  // `runningTick` boolean swallows overlapping ticks so a slow fixture
  // cannot stack worker invocations.
  // Hard timer: the 14-day quarantine cooldown becomes eligible by elapsed time.
  if (isWorkerEnabled("rehabilitation")) {
    const rehabTickMs = 30 * 60 * 1000;
    // Rehab readiness flips on registration; we do NOT run a synchronous
    // initial tick because rehab can spawn subprocess fixtures.
    markWorkerReady("rehabilitation");
    recordWorkerTick("rehabilitation");
    const rehabTick = setInterval(
      supervisedTick(db, "rehabilitation", rehabTickMs, async () => {
        await rehabilitationWorkerTick(
          db,
          async (artifactId) => {
            const row = getArtifact(db, artifactId);
            if (!row) return { ok: false, residual: 1 };
            // Path A (2026-05-20, contract A0DQT211JH): data-class rows
            // have runtime=null and no executable semantics; the rehab
            // worker cannot probe them via fixture invocation. Skip
            // with residual=1+ok=false so the cooldown re-fires; the
            // null-runtime row will stay quarantined indefinitely
            // unless an operator re-admits it via the data-class
            // admission path.
            if (row.runtime === null || !row.declaredSandbox) {
              logger.debug(
                { artifactId: row.id },
                "rehab tick skipped — null runtime (data-class row, no executable semantics)",
              );
              return { ok: false, residual: 1 };
            }
            const fixtureInput = row.fixtureInput ?? null;
            // Candidate B (brain dispatch SW94JRKNFD36Q7G9, 2026-05-19):
            // open Runtime in the rehab worker. Concrete fast-paths
            // stay hardcoded; unknown runtimes route through the
            // runtime_runner registry. Missing runner → skip the rehab
            // tick for this artifact with residual=1 + ok=false (the
            // worker treats this as a probe failure so a known-bad
            // runtime doesn't unblock quarantine).
            let observation: { ok: boolean; result?: JsonValue | null; error?: string };
            if (row.runtime === "bun") {
              observation = await runBunArtifact({
                artifactId: row.id,
                body: row.body,
                declaredSandbox: row.declaredSandbox as BunSandboxDecl,
                inputs: fixtureInput,
              });
            } else if (row.runtime === "uv") {
              observation = await runUvArtifact({
                artifactId: row.id,
                body: row.body,
                declaredSandbox: row.declaredSandbox as UvSandboxDecl,
                inputs: fixtureInput,
              });
            } else if (row.runtime === "camofox-browser") {
              observation = await runCamofoxArtifact({
                artifactId: row.id,
                body: row.body,
                declaredSandbox: row.declaredSandbox as CamofoxSandboxDecl,
                inputs: fixtureInput,
              });
            } else {
              const runner = lookupRunnerInRegistry(db, row.runtime);
              if (!runner) {
                logger.warn(
                  { artifactId: row.id, runtime: row.runtime },
                  "rehab tick skipped — unknown_runtime, no runtime_runner registry row",
                );
                return { ok: false, residual: 1 };
              }
              const obs = await runArtifactForRuntime({
                artifactId: row.id,
                body: row.body,
                declaredSandbox: row.declaredSandbox,
                inputs: fixtureInput,
                db,
              });
              observation = { ok: obs.ok, result: obs.result ?? null, error: obs.error };
            }
            const residual =
              observation.ok &&
              observation.result &&
              typeof observation.result === "object" &&
              !Array.isArray(observation.result) &&
              typeof (observation.result as Record<string, unknown>).residual === "number"
                ? (observation.result as { residual: number }).residual
                : (observation.ok ? 0 : 1);
            return { ok: observation.ok, residual };
          },
          (event) => {
            try {
              emitEvent(db, event);
            } catch (err) {
              logger.debug(
                { where: "daemon.rehab.emit", kind: event.kind, err: String(err) },
                "rehab event emission failed",
              );
            }
          },
        );
      }),
      rehabTickMs,
    );
    workers.push(() => clearInterval(rehabTick));
  }

  // SMART-axis Layer-2 decay (brain audit QQEHAW97 lesson): inert recipes
  // (never replayed for N days, default 14) get their confidence multiplied
  // by 0.95 per tick, floored at 0.1. Closes the lesson "Layer-2 intelligence
  // should decay inert rows, not just promote successful rows." Ticks hourly
  // (universal cadence); idempotent within the same wall-clock second via
  // applyRecipeInertiaDecay. Opt-OUT via `ACC2_DISABLE_WORKERS=recipe_inertia`.
  // Hard timer: inactivity decay measures elapsed time since replay.
  if (isWorkerEnabled("recipe_inertia")) {
    const inertiaTickMs = 60 * 60 * 1000;
    const { applyRecipeInertiaDecay } = await import("./recipe_inertia");
    markWorkerReady("recipe_inertia");
    recordWorkerTick("recipe_inertia");
    const inertiaTick = setInterval(
      supervisedTick(db, "recipe_inertia", inertiaTickMs, async () => {
        applyRecipeInertiaDecay(db);
      }),
      inertiaTickMs,
    );
    workers.push(() => clearInterval(inertiaTick));
  }

  // 2026-05-19 (KCs YKJYRGVJJX21XAMQS042PMK7JG +
  // G3CBVAGY2S5QN5XDC1GR7GJP0G): pending_decision_retire_worker tick.
  // Scans the pending_owner_decision_queue_view source rows on a 1h
  // cadence, emits pending_decision_retired for stale (age > 7d) /
  // test-file-target / anchor-missing rows. Idempotent: re-running the
  // tick on a row that already has a pending_decision_retired event
  // is a no-op. The companion pending_owner_decision_queue_live_view
  // filters retired rows out of the operator-facing
  // `acc admin pending-decisions` surface. Opt-OUT via
  // `ACC2_DISABLE_WORKERS=pending_decision_retire`.
  if (isWorkerEnabled("pending_decision_retire")) {
    const retireTickMs = 60 * 60 * 1000;
    const { runPendingDecisionRetireWorker } = await import("./pending_decision_retire_worker");
    markWorkerReady("pending_decision_retire");
    recordWorkerTick("pending_decision_retire");
    const runRetireTick = supervisedTick(db, "pending_decision_retire", retireTickMs, async () => {
      runPendingDecisionRetireWorker(db);
    });
    registerReactiveWorker("pending_decision_retire", retireTickMs, ["contract_amendment_proposed"], runRetireTick, { minReactiveGapMs: 30 * 1000 });
    const retireTick = setInterval(runRetireTick, retireTickMs);
    workers.push(() => clearInterval(retireTick));
  }

  // 2026-05-19 (brain amendment 1Z3PMEYE7X44343E7K8ARCDY20, T1.1):
  // owner-outcome follow-up worker tick. Scans applied_change_committed
  // events older than the feedback window (default 24h) with
  // affected_resources, emits one hidl_action_required per eligible
  // change asking the owner whether it worked. Owner's reply becomes
  // owner_observed_outcome_recorded (existing CLI path); credit flows
  // through the act-tuple chain. Idempotent — re-running the worker
  // doesn't double-fire on the same row. Default 30min cadence.
  // Opt-OUT via `ACC2_DISABLE_WORKERS=owner_outcome_followup`.
  if (isWorkerEnabled("owner_outcome_followup")) {
    const outcomeTickMs = 30 * 60 * 1000;
    const { runOwnerOutcomeFollowupWorker } = await import("./owner_outcome_followup_worker");
    let outcomeMarked = false;
    const outcomeTick = supervisedTick(db, "owner_outcome_followup", outcomeTickMs, async () => {
      await runOwnerOutcomeFollowupWorker(db);
      if (!outcomeMarked) { markWorkerReady("owner_outcome_followup"); outcomeMarked = true; }
    });
    const outcomeTimer = setInterval(outcomeTick, outcomeTickMs);
    markWorkerReady("owner_outcome_followup");
    recordWorkerTick("owner_outcome_followup");
    workers.push(() => clearInterval(outcomeTimer));
  }

  // 2026-05-20 (T4.1 counterfactual credit, docs/roadmap.md Tier 6):
  // counterfactual credit scorer worker tick. Scans
  // counterfactual_alternative_recorded events older than their
  // window_seconds, looks up the chosen path's action_scored residual,
  // and emits act_artifact_score_updated against each rejected
  // candidate so selector posteriors learn from outcomes the chosen
  // path produced. Idempotent via
  // projection_key=counterfactual_credit:{ev_id}:{rejected_id}.
  // Default 5min cadence.
  // Opt-OUT via `ACC2_DISABLE_WORKERS=counterfactual_credit`.
  if (isWorkerEnabled("counterfactual_credit")) {
    const counterfactualTickMs = 5 * 60 * 1000;
    const { runCounterfactualCreditWorker } = await import("./counterfactual_credit_worker");
    let counterfactualMarked = false;
    const counterfactualTick = supervisedTick(db, "counterfactual_credit", counterfactualTickMs, async () => {
      await runCounterfactualCreditWorker(db);
      if (!counterfactualMarked) { markWorkerReady("counterfactual_credit"); counterfactualMarked = true; }
    });
    const counterfactualTimer = setInterval(counterfactualTick, counterfactualTickMs);
    markWorkerReady("counterfactual_credit");
    recordWorkerTick("counterfactual_credit");
    workers.push(() => clearInterval(counterfactualTimer));
  }

  // 2026-05-22 (phase-2 SJPF3VB9 observability-fidelity ceiling):
  // standing observability-fidelity guard. Hourly sweep that
  // institutionalizes this session's two bug classes as PERMANENT
  // self-audits so they can never silently return:
  //   - loop_inert_alert       — a wired loop emitted 0 over the
  //     trailing window while its upstream trigger fired >= min_upstream
  //     (counterfactual / coalition / meta_credit).
  //   - metric_veracity_alert  — a status metric diverged from ground
  //     truth beyond tolerance (retrieval index).
  // Defensive per-check (a query error never crashes the tick) and
  // idempotent (no duplicate inert alert inside the same window).
  // Built Claude-side after the brain could not build the worker across
  // 3 dispatches. Opt-out via ACC2_DISABLE_WORKERS=observability_guard.
  if (isWorkerEnabled("observability_guard")) {
    const observabilityGuardTickMs = 60 * 60 * 1000;
    const { observabilityGuardTick } = await import("./observability_guard_worker");
    let observabilityGuardMarked = false;
    const observabilityGuardTickFn = supervisedTick(db, "observability_guard", observabilityGuardTickMs, async () => {
      await observabilityGuardTick(db);
      if (!observabilityGuardMarked) { markWorkerReady("observability_guard"); observabilityGuardMarked = true; }
    });
    const observabilityGuardTimer = setInterval(observabilityGuardTickFn, observabilityGuardTickMs);
    markWorkerReady("observability_guard");
    recordWorkerTick("observability_guard");
    workers.push(() => clearInterval(observabilityGuardTimer));
  }

  // 2026-05-19 (brain dispatch J4HP5SYT3N4GK45S Candidate A): one-shot
  // substrate-wide alias-removal sweep that backfills concrete `kind`
  // values onto act_artifact rows still carrying the legacy
  // `code_artifact` default. Idempotent — every row with an existing
  // artifact_kind_backfilled event is skipped, so reruns are no-ops.
  // Single-sweep semantics: kicked once on boot (NOT a periodic tick).
  // Opt-out via ACC2_DISABLE_WORKERS=artifact_kind_backfill.
  if (isWorkerEnabled("artifact_kind_backfill")) {
    registerWorker("artifact_kind_backfill");
    const { runArtifactKindBackfill } = await import("./artifact_kind_backfill_worker");
    markWorkerReady("artifact_kind_backfill");
    recordWorkerTick("artifact_kind_backfill");
    // Fire the sweep on the next tick so daemon boot stays non-blocking.
    // The sweep itself yields every 25 rows so it shares the event loop
    // with request handlers + reactive workers during the run.
    const backfillTimer = setTimeout(() => {
      void (async () => {
        try {
          const summary = await runArtifactKindBackfill(db);
          logger.info(
            {
              scanned: summary.scanned,
              backfilled: summary.backfilled,
              uncertain: summary.uncertain,
              skipped: summary.skipped_idempotent,
              errors: summary.errors.length,
              sweep_id: summary.sweep_id,
            },
            "artifact_kind_backfill sweep complete",
          );
        } catch (err) {
          logger.warn(
            { err: (err as Error).message },
            "artifact_kind_backfill sweep failed",
          );
        }
      })();
    }, 1000);
    workers.push(() => clearTimeout(backfillTimer));
  }

  // Experience compression worker (primitive #3 of SZG5PQ01,
  // owner-approved 2026-05-16 via amendment GHWARJHT). Clusters
  // successful trajectories by goal_shape + lesson_kind, emits
  // compressed knowledge_candidate/recipe-shape knowledge, retires stale
  // lessons. REUSE-FIRST: no new event kinds. Opt-OUT via
  // `ACC2_DISABLE_WORKERS=experience_compression`. 30-min reactive
  // cadence; reactive_safety_net is the genuine deadline.
  if (isWorkerEnabled("experience_compression")) {
    const compressionTickMs = 30 * 60 * 1000;
    const { experienceCompressionWorkerTick } = await import("./experience_compression_worker");
    markWorkerReady("experience_compression");
    recordWorkerTick("experience_compression");
    const compressionTick = supervisedTick(db, "experience_compression", compressionTickMs, async () => {
      await experienceCompressionWorkerTick(db);
    });
    registerReactiveWorker("experience_compression", compressionTickMs, ["task_closure_audited", "lesson_extracted", "task_committed", "action_scored", "knowledge_candidate", "knowledge_promoted", "applied_change_committed"], compressionTick, { minReactiveGapMs: compressionTickMs });
    // experience_compression is activation-driven; activationDisposers are cleared on shutdown.
  }

  // F3 (2026-05-18): lifecycle closure sweep. Periodic terminator
  // emission for open contract_amendment_proposed / owner_input_required
  // / task_node_opened rows that never received a downstream resolution
  // event. Opt-OUT via `ACC2_DISABLE_WORKERS=lifecycle_closure_sweep`.
  // 6-h reactive cadence; reactive_safety_net is the genuine deadline.
  if (isWorkerEnabled("lifecycle_closure_sweep")) {
    const sweepTickMs = 6 * 60 * 60 * 1000;
    const { runLifecycleClosureSweep } = await import("./lifecycle_closure_sweep");
    markWorkerReady("lifecycle_closure_sweep");
    recordWorkerTick("lifecycle_closure_sweep");
    const sweepTick = supervisedTick(db, "lifecycle_closure_sweep", sweepTickMs, async () => {
      await runLifecycleClosureSweep(db);
    });
    registerReactiveWorker("lifecycle_closure_sweep", sweepTickMs, ["contract_amendment_proposed", "owner_input_required", "task_node_opened", "applied_change_committed", "owner_decision_recorded", "owner_input_received", "task_committed", "task_failed", "task_abandoned", "closure_complete", "closure_obsolete", "closure_owner_required"], sweepTick, { minReactiveGapMs: sweepTickMs });
    // lifecycle_closure_sweep is activation-driven; safety net covers age-threshold scans.
  }

  // F11 (2026-05-18, contract 2AMJKN0GTX32790173EPYH6YT4): contract
  // amendment flywheel consumer. Triages unsettled
  // contract_amendment_proposed rows on a 5-minute cadence BEFORE
  // lifecycle_closure_sweep sees them as stuck. Per-proposal verdicts:
  // route_to_implementation (predicate + target_files concrete +
  // dependencies closed), route_to_clarification (missing fields),
  // closure_obsolete (supersession), closure_complete (redundancy).
  // Opt-OUT via `ACC2_DISABLE_WORKERS=contract_amendment_consumer`.
  // 5-min reactive cadence; reactive_safety_net is the genuine deadline.
  if (isWorkerEnabled("contract_amendment_consumer")) {
    const consumerTickMs = 5 * 60 * 1000;
    const consumerBatchSize = 100;
    const { runContractAmendmentConsumer } = await import("./contract_amendment_consumer");
    markWorkerReady("contract_amendment_consumer");
    recordWorkerTick("contract_amendment_consumer");
    const consumerTick = supervisedTick(db, "contract_amendment_consumer", consumerTickMs, async () => {
      await runContractAmendmentConsumer(db, { maxRows: consumerBatchSize });
    });
    registerReactiveWorker("contract_amendment_consumer", consumerTickMs, ["contract_amendment_proposed", "applied_change_committed", "closure_complete", "closure_obsolete", "closure_owner_required"], consumerTick, { minReactiveGapMs: consumerTickMs });
    // contract_amendment_consumer is activation-driven; bursts are debounced by minReactiveGapMs.
  }

  // F-resilience (2026-05-18, contract C33Q10NV557DDEMMHH4TD42MVR):
  // WAL pressure observation. Stats the `state.db-wal` sidecar every
  // 30s and runs PRAGMA wal_checkpoint(PASSIVE) when size > threshold
  // (default 100MB, override via ACC2_WAL_PRESSURE_THRESHOLD_MB). The
  // last successful summary is parked in the worker module so /health
  // can surface wal_stats — the diagnostic we lacked when the daemon
  // hung during the 2917-row burst sweep this session. Opt-OUT via
  // ACC2_DISABLE_WORKERS=wal_pressure_check. 30-s reactive cadence;
  // reactive_safety_net is the genuine deadline.
  if (isWorkerEnabled("wal_pressure_check")) {
    const walTickMs = 30 * 1000;
    const { runWalPressureCheck, setLastWalPressureSummary } = await import("./wal_pressure_worker");
    markWorkerReady("wal_pressure_check");
    recordWorkerTick("wal_pressure_check");
    const walTick = supervisedTick(db, "wal_pressure_check", walTickMs, async () => {
      const summary = runWalPressureCheck(db, { dbPath: stateDbPath });
      setLastWalPressureSummary(summary);
    });
    registerReactiveWorker("wal_pressure_check", walTickMs, ["bridge_frame_received", "action_scored", "task_committed", "task_node_opened", "contract_amendment_proposed", "closure_complete", "closure_obsolete", "closure_owner_required"], walTick, { minReactiveGapMs: walTickMs });
    // wal_pressure_check is activation-driven; safety net covers filesystem WAL growth without a ledger event.
  }

  // Self-healing chain Layer 3 (owner-approved 2026-05-16, option d):
  // periodically scans for old knowledge_contradiction_observed events
  // (Layer 2 drift signal) and opens corrective directives so the brain
  // designs a fix. Caps per-tick dispatch to bound brain spend. Opt-OUT
  // via `ACC2_DISABLE_WORKERS=verify_heal`. 1-h reactive cadence;
  // reactive_safety_net is the genuine deadline.
  if (isWorkerEnabled("verify_heal")) {
    const healTickMs = 60 * 60 * 1000;
    const { verifyHealWorkerTick } = await import("./verify_heal");
    markWorkerReady("verify_heal");
    recordWorkerTick("verify_heal");
    const healTick = supervisedTick(db, "verify_heal", healTickMs, async () => {
      verifyHealWorkerTick(db);
    });
    registerReactiveWorker("verify_heal", healTickMs, ["knowledge_contradiction_observed", "knowledge_candidate", "action_scored", "task_closure_audited"], healTick, { minReactiveGapMs: 5 * 60 * 1000 });
    // verify_heal is activation-driven; activationDisposers are cleared on shutdown.
  }

  // Phase I: rolling-review worker. Default ON — production wants
  // rolling-active directives to receive cadence-driven re-opens.
  // Opt-OUT via `ACC2_DISABLE_WORKERS=rolling_reviewer`
  // (tests/preload.ts pins the full set). Tick every 60s; errors
  // swallowed so a single malformed directive can't kill the daemon.
  // Father (Phase K) drives the same loop on its own tick when both
  // are on.
  if (isWorkerEnabled("rolling_reviewer")) {
    let rollingMarked = false;
    const rollingTick = supervisedTick(db, "rolling_reviewer", rollingIntervalMs, async () => {
      await rollingReviewerWorkerTick(db);
      if (!rollingMarked) { markWorkerReady("rolling_reviewer"); rollingMarked = true; }
    });
    registerReactiveWorker("rolling_reviewer", rollingIntervalMs, ["directive_opened", "directive_amended", "owner_decision_recorded", "owner_input_received", "task_committed"], rollingTick, { minReactiveGapMs: rollingIntervalMs });
    void (async () => {
      try {
        await rollingReviewerWorkerTick(db);
        recordWorkerTick("rolling_reviewer");
      } catch (err) {
        logger.warn(
          { err: (err as Error).message },
          "rolling_reviewer boot-tick failed — surfaced as error_caught",
        );
        try {
          emitEvent(db, {
            kind: "error_caught",
            substrate_origin: "substrate_auto",
            payload: {
              where: "daemon.rolling_reviewer.boot_tick",
              recoverable: true,
              message: (err as Error).message,
            },
          });
        } catch (emitErr) {
          logger.debug(
            { where: "daemon.rolling_reviewer.boot_emit", err: String(emitErr) },
            "could not emit error_caught (db likely closed)",
          );
        }
      }
      if (!rollingMarked) { markWorkerReady("rolling_reviewer"); rollingMarked = true; }
    })();
    // rolling_reviewer is activation-driven; safety net covers due-time arrival.
  }

  // Phase K: Father worker. Father is no longer a cadence-bound planner.
  // It observes the activation bus and emits a compact journal every N ledger
  // events. Rolling reviews, scheduling, dispatch, refinement, and retrieval
  // are owned by their dedicated substrate workers.
  if (isWorkerEnabled("father")) {
    // Father is activation-driven (onEvent("*") subscription) — it does
    // not heartbeat on fatherIntervalMs. Mark it reactive so readiness
    // skips its per-worker stuck check on idle substrate; the shared
    // reactive_safety_net is the genuine deadline that applies.
    markWorkerReactive("father");
    markWorkerReady("father");
    recordWorkerTick("father");
    const disposeFatherJournal = onEvent("*", (event) => {
      void fatherJournalOnEvent(db, event).catch((err) => {
        logger.warn(
          { err: (err as Error).message },
          "father.journal failed — surfaced as error_caught",
        );
        try {
          emitEvent(db, {
            kind: "error_caught",
            substrate_origin: "substrate_auto",
            payload: {
              where: "daemon.father.journal_step",
              recoverable: true,
              message: (err as Error).message,
            },
          });
        } catch (emitErr) {
          logger.debug({ err: String(emitErr) }, "could not emit error_caught (db closed)");
        }
      });
    });
    workers.push(disposeFatherJournal);
  }

  // Phase E: autoscheduler. Default ON — production wants the
  // scheduler drain-loop firing every ready dispatch as it lands.
  // Opt-OUT via `ACC2_DISABLE_WORKERS=scheduler` (tests/preload.ts pins
  // the full set so the unit suite drives the scheduler explicitly per
  // test).
  let schedulerAbort: AbortController | null = null;
  if (isWorkerEnabled("scheduler")) {
    schedulerAbort = new AbortController();
    markWorkerReady("scheduler");
    recordWorkerTick("scheduler");
    emitWorkerTickIfDue(db, "scheduler", 1000);
    void (async () => {
      try {
        // schedulerLoop returns on quiescence; we keep restarting it on a
        // long poll interval so new directives wake the loop without busy
        // spin.
        while (!schedulerAbort?.signal.aborted) {
          await schedulerLoop(db, {
            pollIntervalMs: 1000,
            maxConcurrent: 5,
            abort: schedulerAbort?.signal,
            // Knowledge audit bc5vdkrik #1 (2026-05-15): thread the
            // embedding index through to the dispatcher so depth-1
            // retrieval runs against the task goal text before the
            // brain prompt is composed. Without this the brain prompt's
            // KNOWLEDGE section is recency-only — operationally dead.
            index,
          });
          recordWorkerTick("scheduler");
          // Brain audit D (2026-05-15): the scheduler doesn't go through
          // supervisedTick, so we explicitly stamp dampened liveness here
          // — the ledger now carries scheduler ticks just like every
          // other worker.
          emitWorkerTickIfDue(db, "scheduler", 1000);
          await new Promise((r) => setTimeout(r, 2000));
        }
      } catch (err) {
        logger.error(
          { err: (err as Error).message, stack: (err as Error).stack },
          "scheduler loop crashed — surfacing as error_caught(unrecoverable)",
        );
        try {
          emitEvent(db, {
            kind: "error_caught",
            substrate_origin: "substrate_auto",
            payload: {
              where: "daemon.scheduler.loop",
              recoverable: false,
              message: (err as Error).message,
              stack: ((err as Error).stack ?? "").slice(0, 2048),
            },
          });
        } catch (emitErr) {
          logger.debug({ err: String(emitErr) }, "could not emit error_caught (db closed)");
        }
      }
    })();
    workers.push(() => schedulerAbort?.abort());
  }

  // ── Tier -1 floor enforcement workers ────────────────────────────────
  // Per docs/roadmap.md: floors precede posterior scoring. Each worker
  // emits absence-of-violation evidence on its predicate's behalf.
  // Predicate rows admitted in substrate/seed.ts.

  // event_authenticity_worker — 60s tick. Samples last-hour events,
  // verifies canonical substrate_origin + required fields.
  // Opt-OUT via ACC2_DISABLE_WORKERS=event_authenticity.
  if (isWorkerEnabled("event_authenticity")) {
    const tickMs = 60 * 1000;
    const { eventAuthenticityWorkerTick } = await import("./event_authenticity_worker");
    markWorkerReady("event_authenticity");
    recordWorkerTick("event_authenticity");
    const tick = supervisedTick(db, "event_authenticity", tickMs, async () => {
      eventAuthenticityWorkerTick(db);
    });
    const timer = setInterval(tick, tickMs);
    workers.push(() => clearInterval(timer));
  }

  // storage_integrity_worker — 5min tick. PRAGMA integrity_check +
  // wal_checkpoint(TRUNCATE). Emits wal_checkpointed per-run.
  // Opt-OUT via ACC2_DISABLE_WORKERS=storage_integrity_floor.
  if (isWorkerEnabled("storage_integrity_floor")) {
    const tickMs = 5 * 60 * 1000;
    const { storageIntegrityWorkerTick } = await import("./storage_integrity_worker");
    markWorkerReady("storage_integrity_floor");
    recordWorkerTick("storage_integrity_floor");
    const tick = supervisedTick(db, "storage_integrity_floor", tickMs, async () => {
      storageIntegrityWorkerTick(db);
    });
    const timer = setInterval(tick, tickMs);
    workers.push(() => clearInterval(timer));
  }

  // deterministic_computation_worker — 10min tick. Audits deterministic
  // verifier residual agreement; quarantines on mismatch.
  // Opt-OUT via ACC2_DISABLE_WORKERS=deterministic_computation.
  if (isWorkerEnabled("deterministic_computation")) {
    const tickMs = 10 * 60 * 1000;
    const { deterministicComputationWorkerTick } = await import("./deterministic_computation_worker");
    markWorkerReady("deterministic_computation");
    recordWorkerTick("deterministic_computation");
    const tick = supervisedTick(db, "deterministic_computation", tickMs, async () => {
      deterministicComputationWorkerTick(db);
    });
    const timer = setInterval(tick, tickMs);
    workers.push(() => clearInterval(timer));
  }

  // kernel_sandbox_worker — 5min tick. Samples recent artifact_invoked
  // events; verifies each has matching sandbox_enforced (or _degraded)
  // evidence. On 5+ gap, emits sandbox_degraded + quarantines offenders.
  // Opt-OUT via ACC2_DISABLE_WORKERS=kernel_sandbox.
  if (isWorkerEnabled("kernel_sandbox")) {
    const tickMs = 5 * 60 * 1000;
    const { kernelSandboxWorkerTick } = await import("./kernel_sandbox_worker");
    markWorkerReady("kernel_sandbox");
    recordWorkerTick("kernel_sandbox");
    const tick = supervisedTick(db, "kernel_sandbox", tickMs, async () => {
      kernelSandboxWorkerTick(db);
    });
    const timer = setInterval(tick, tickMs);
    workers.push(() => clearInterval(timer));
  }

  // owner_identity_worker — 5min tick. Hashes canonical actor identity
  // files (v2.sock.token + minted .ralph/.session-token); flags
  // owner_identity_discontinuity + owner_input_required on mid-flight
  // rotation without admin_token_rotated event.
  // Opt-OUT via ACC2_DISABLE_WORKERS=owner_identity.
  if (isWorkerEnabled("owner_identity")) {
    const tickMs = 5 * 60 * 1000;
    const { ownerIdentityWorkerTick } = await import("./owner_identity_worker");
    markWorkerReady("owner_identity");
    recordWorkerTick("owner_identity");
    const tick = supervisedTick(db, "owner_identity", tickMs, async () => {
      ownerIdentityWorkerTick(db);
    });
    const timer = setInterval(tick, tickMs);
    workers.push(() => clearInterval(timer));
  }

  // archival_worker — 6h tick. Hot/cold archival (docs/Architecture.md
  // commit 6b8ebea + brain KC TE6P3958, conf=0.86). Events older than
  // archival_retention_days (default 30) move into sibling
  // state-archive-YYYY-MM.db files; verify-then-delete keeps the hot
  // ledger bounded so aggregate scans don't grow with production rate.
  // Opt-OUT via ACC2_DISABLE_WORKERS=archival.
  if (isWorkerEnabled("archival")) {
    const tickMs = 6 * 60 * 60 * 1000;
    const { runArchivalSweep, runDropSweep, runTelemetryEvictionSweep } = await import(
      "./archival_worker"
    );
    const { resolveDbPath } = await import("./state_paths");
    const dbPath = resolveDbPath();
    markWorkerReady("archival");
    recordWorkerTick("archival");
    const tick = supervisedTick(db, "archival", tickMs, async () => {
      // 1. Age-based move-to-cold (30-day retention) — bounds the ledger
      //    independently of production rate over the long horizon.
      await runArchivalSweep(db, { stateDbPath: dbPath });
      // 2. Drop pure-noise liveness/metrics telemetry past the short
      //    retention (the hot-retention boundary the age-based archive
      //    can't give a young DB; previously wired only via the unused
      //    startArchivalWorker helper).
      await runDropSweep(db);
      // 3. 2026-05-23 event-class tiering: evict EPHEMERAL_TELEMETRY_KINDS
      //    (defunct/uncertain-inference telemetry with zero compounding
      //    value) past a SHORT TTL, preserving lifetime health counts in
      //    meta so observability counters still report correctly.
      await runTelemetryEvictionSweep(db);
    });
    const timer = setInterval(tick, tickMs);
    workers.push(() => clearInterval(timer));
    // Kick the first sweep ~10s after boot (off the boot-critical path) so
    // telemetry eviction + drop shrink the hot ledger IMMEDIATELY on every
    // start, not only after the first 6h interval. The eviction is the
    // bounded-ledger lever; deferring it 6h leaves a young/large hot DB slow
    // for hours. Each sweep is row-capped, so the startup kick is cheap.
    const kick = setTimeout(() => { void tick(); }, 10_000);
    kick.unref();
    workers.push(() => clearTimeout(kick));
  }

  // brain_invocation_worker — 30s tick. Substrate-side brain dispatch
  // primitive (per brain HCWM88JN0H6NDB8V amendment GMZ08ASMTD7W, cites
  // prior meta-verdict MYMQZFM2XX7732AQ conf=0.86). Any substrate
  // component emits brain_invocation_request when its verifier/view
  // detects design ambiguity, structural fault, repeated silent exits,
  // or insufficient synthesis. This worker dequeues, applies COSMIC
  // SSA loop prevention, dedups by (topic_keywords, triggering_event_ids),
  // and dispatches through the existing acc task path.
  // Opt-OUT via ACC2_DISABLE_WORKERS=brain_invocation.
  if (isWorkerEnabled("brain_invocation")) {
    const tickMs = 30 * 1000;
    const { runBrainInvocationTick } = await import("./brain_invocation_worker");
    markWorkerReady("brain_invocation");
    recordWorkerTick("brain_invocation");
    const tick = supervisedTick(db, "brain_invocation", tickMs, async () => {
      await runBrainInvocationTick(db);
    });
    const timer = setInterval(tick, tickMs);
    workers.push(() => clearInterval(timer));
  }

  // memory_reconciliation_worker — 5min tick. SSGM Lam et al. 2026
  // (arXiv:2603.11768) Reconciliation operator R: periodically align
  // mutable in-memory caches against immutable ledger.
  // Opt-OUT via ACC2_DISABLE_WORKERS=memory_reconciliation.
  if (isWorkerEnabled("memory_reconciliation")) {
    const tickMs = 5 * 60 * 1000;
    const { runMemoryReconciliationTick } = await import("./memory_reconciliation_worker");
    markWorkerReady("memory_reconciliation");
    recordWorkerTick("memory_reconciliation");
    const tick = supervisedTick(db, "memory_reconciliation", tickMs, async () => {
      runMemoryReconciliationTick(db);
    });
    const timer = setInterval(tick, tickMs);
    workers.push(() => clearInterval(timer));
  }

  // sahoo_governor_worker — 10min tick. SAHOO Sahoo et al. 2026
  // (arXiv:2603.06333) intrinsic diagnostics 5-tuple. The pure
  // evaluateGoNoGo function (exported from
  // recursive_self_improvement_governor.ts) is the Go/No-Go gate
  // callable from amendment apply path. Opt-OUT via
  // ACC2_DISABLE_WORKERS=sahoo_governor.
  if (isWorkerEnabled("sahoo_governor")) {
    const tickMs = 10 * 60 * 1000;
    const { runSahooDiagnosticsTick } = await import("./recursive_self_improvement_governor");
    markWorkerReady("sahoo_governor");
    recordWorkerTick("sahoo_governor");
    const tick = supervisedTick(db, "sahoo_governor", tickMs, async () => {
      runSahooDiagnosticsTick(db);
    });
    const timer = setInterval(tick, tickMs);
    workers.push(() => clearInterval(timer));
  }

  // mcp_session_reaper — periodic fastmcp session GC (2026-05-23). Only runs
  // when this daemon binds the MCP port (role=server/all); on role=worker
  // there is no mcpServer so the worker is not registered at all (guarded by
  // `!skipPorts` in the registration block above). The tick reads the live
  // `mcpServer.sessions` array and force-closes leaked/dead/idle/over-cap
  // sessions, which triggers fastmcp's own splice-from-#sessions cleanup.
  // Opt-OUT via ACC2_DISABLE_WORKERS=mcp_session_reaper.
  if (!skipPorts && isWorkerEnabled("mcp_session_reaper")) {
    markWorkerReady("mcp_session_reaper");
    recordWorkerTick("mcp_session_reaper");
    const tick = supervisedTick(db, "mcp_session_reaper", mcpSessionReaperTickMs, async () => {
      if (mcpServer) await runMcpSessionReaperTick(db, mcpSessionReaper, mcpServer);
    });
    const timer = setInterval(tick, mcpSessionReaperTickMs);
    workers.push(() => clearInterval(timer));
  }
  } // end if (!skipWorkers)
  }; // end startWorkers closure

  // Declare `stop` BEFORE Bun.serve so the fetch closure can capture it; the
  // handles are filled in after binding succeeds.
  let auxServer: Server | null = null;
  let mcpServer: FastMCP | null = null;
  let stopped = false;
  /** Bounded graceful drain on shutdown (amendment 8EAKQCJW5D).
   *
   *  `drainBudgetMs` controls the per-call drain budget:
   *   - `undefined` → default `RESTART_DRAIN_TIMEOUT_MS` graceful drain.
   *   - `0`         → immediate kill (no drain wait). Backward-compat path
   *                   for callers that need synchronous teardown (tests, the
   *                   second-instance recovery path) — still emits the drain
   *                   started/timed_out pair so observers see the choice.
   *   - any positive value → bounded graceful drain.
   *
   *  The contract: stop accepting new scheduler dispatches → emit
   *  `restart_drain_started` with the in-flight set + budget → wait for
   *  every in-flight dispatch to finish OR the budget to expire → kill the
   *  remaining live opencode procs → emit `daemon_shutdown` with
   *  `drained_count` + `interrupted_count` so operators can see exactly how
   *  many dispatches finished cleanly vs were force-killed. Boot recovery
   *  (reconcileOrphanedDispatches) is the deterministic backstop for any
   *  unclosed leases left after a force-kill. */
  const stop = async (drainBudgetMs?: number): Promise<void> => {
    if (stopped) return;
    stopped = true;
    const budgetMs = drainBudgetMs ?? RESTART_DRAIN_TIMEOUT_MS;
    setSchedulerDraining(true);
    const drainStartedAtMs = Date.now();
    const inFlightAtStart = inFlightDispatchTaskIds();
    const inFlightCountAtStart = inFlightAtStart.length;
    try {
      emitEvent(db, {
        kind: "restart_drain_started",
        substrate_origin: "substrate_auto",
        payload: {
          pid: process.pid,
          timeout_ms: budgetMs,
          in_flight_task_ids: inFlightAtStart,
          in_flight_count: inFlightCountAtStart,
        },
      });
    } catch (err) {
      logger.debug({ where: "daemon.stop.emit_restart_drain_started", err: String(err) }, "db may already be closed");
    }
    // splice(0) drains so the deferred startWorkers race close-out (which
    // also splices) cannot double-dispose: each disposer runs exactly once
    // regardless of which path observes it first.
    for (const dispose of workers.splice(0)) dispose();
    // Budget == 0 means "skip the wait, kill immediately". We still call the
    // drain helper with timeoutMs=0 so the standard event pair is emitted —
    // observers see exactly which path the shutdown took.
    const drain = await drainInFlightDispatches({ timeoutMs: budgetMs });
    // F8 quiescence: after the process-local IN_FLIGHT map drains, wait
    // for ledger-visible brain dispatches (matching `brain_dispatched`
    // rows without a `brain_dispatch_closed`) to close. This covers
    // cross-process dispatches the local map cannot see (multi-terminal
    // multi-brain). The remaining budget is the leftover from
    // drainInFlightDispatches; if it returned early we still give the
    // ledger up to that remainder.
    const quiescenceBudgetMs = Math.max(0, budgetMs - (Date.now() - drainStartedAtMs));
    if (quiescenceBudgetMs > 0) {
      const quiescence = await waitForBrainQuiescence(db, { budgetMs: quiescenceBudgetMs });
      if (quiescence.status === "timeout" && quiescence.open_count_final > 0) {
        logger.warn(
          { open_count: quiescence.open_count_final, waited_ms: quiescence.waited_ms },
          "shutdown quiescence timeout — open brain dispatches will be reconciled on next boot",
        );
      }
    } else {
      const stillOpen = getOpenBrainDispatches(db);
      if (stillOpen.length > 0) {
        logger.warn(
          { open_count: stillOpen.length },
          "shutdown budget exhausted before quiescence — open dispatches will be reconciled on next boot",
        );
      }
    }
    const drainElapsedMs = Date.now() - drainStartedAtMs;
    const interruptedTaskIds = drain.timed_out_task_ids;
    const interruptedCount = interruptedTaskIds.length;
    const drainedCount = Math.max(0, inFlightCountAtStart - interruptedCount);
    // ── No-job-loss-on-restart checkpoint (2026-05-23) ───────────────────
    // PROBLEM (observed live): a graceful restart whose drain budget expires
    // with brain dispatches still in flight SIGTERM-kills them. On the next
    // boot, reconcileOrphanedDispatches closes the dangling lease and the
    // scheduler re-picks the SAME task FROM SCRATCH — the in-progress brain
    // cycle's proposed amendments are abandoned (task_abandoned-equivalent).
    // FIX: before killing the leftover subprocesses, emit a refinement-edge
    // continuation for each interrupted dispatch (reusing the productive-
    // timeout continuation primitive). The next boot's scheduler then resumes
    // the work as a continuation child instead of restarting it. Bounded by
    // REFINEMENT_DEPTH_CAP so an interrupted-every-restart task terminalizes
    // rather than resuming forever. Best-effort — never blocks shutdown.
    let checkpoint = {
      checkpointed_task_ids: [] as string[],
      continuation_task_ids: [] as string[],
      depth_capped_task_ids: [] as string[],
      skipped_task_ids: [] as string[],
    };
    if (interruptedCount > 0) {
      try {
        checkpoint = checkpointInterruptedDispatches(db, interruptedTaskIds);
        if (checkpoint.checkpointed_task_ids.length > 0) {
          logger.info(
            {
              checkpointed: checkpoint.checkpointed_task_ids.length,
              continuations: checkpoint.continuation_task_ids,
              depth_capped: checkpoint.depth_capped_task_ids.length,
            },
            "checkpointed interrupted brain dispatches as refinement continuations — work resumes on next boot",
          );
        }
      } catch (err) {
        logger.warn(
          { where: "daemon.stop.checkpoint_interrupted", err: String(err) },
          "checkpointInterruptedDispatches failed — interrupted tasks fall back to boot orphan recovery",
        );
      }
    }
    try {
      emitEvent(db, {
        kind: drain.completed ? "restart_drain_completed" : "restart_drain_timed_out",
        substrate_origin: "substrate_auto",
        payload: {
          pid: process.pid,
          timeout_ms: budgetMs,
          drain_elapsed_ms: drainElapsedMs,
          in_flight_task_ids_at_start: inFlightAtStart,
          timed_out_task_ids: interruptedTaskIds,
          drained_count: drainedCount,
          interrupted_count: interruptedCount,
          checkpointed_task_ids: checkpoint.checkpointed_task_ids,
          continuation_task_ids: checkpoint.continuation_task_ids,
          checkpoint_depth_capped_task_ids: checkpoint.depth_capped_task_ids,
          recovery_action: drain.completed
            ? "none"
            : checkpoint.checkpointed_task_ids.length > 0
              ? "refinement_continuation_resumes_on_next_boot"
              : "kill_remaining_live_opencode_then_boot_recovery_repick",
        },
      });
    } catch (err) {
      logger.debug({ where: "daemon.stop.emit_restart_drain_finished", err: String(err) }, "db may already be closed");
    }
    // Only now terminate leftovers. Dispatches that completed during the drain
    // have already deregistered their live opencode proc; boot recovery re-picks
    // any killed task whose brain_dispatched lease remains unclosed.
    let killedOpencodeProcs = 0;
    try {
      const { killAllLiveOpencodeProcs } = await import("./bridge/opencode");
      killedOpencodeProcs = killAllLiveOpencodeProcs();
      if (killedOpencodeProcs > 0) logger.info({ killed_opencode_procs: killedOpencodeProcs }, "daemon shutdown — terminated remaining brain subprocesses after drain");
    } catch (err) {
      logger.debug({ where: "daemon.stop.kill_opencode_procs", err: String(err) }, "killAllLiveOpencodeProcs import/call failed (best-effort)");
    }
    try {
      emitEvent(db, {
        kind: "daemon_shutdown",
        substrate_origin: "substrate_auto",
        payload: {
          pid: process.pid,
          uptime_ms: Date.now() - startedAtMs,
          drain_budget_ms: budgetMs,
          drain_elapsed_ms: drainElapsedMs,
          in_flight_count_at_start: inFlightCountAtStart,
          drained_count: drainedCount,
          interrupted_count: interruptedCount,
          killed_opencode_procs: killedOpencodeProcs,
        },
      });
    } catch (err) {
      logger.debug({ where: "daemon.stop.emit_shutdown", err: String(err) }, "db may already be closed");
    }
    try { auxServer?.stop(true); } catch (err) {
      logger.debug({ where: "daemon.stop.aux_server", err: String(err) }, "aux server stop failed (best-effort)");
    }
    try { if (mcpServer) await mcpServer.stop(); } catch (err) {
      logger.debug({ where: "daemon.stop.mcp_server", err: String(err) }, "mcp server stop failed (best-effort)");
    }
    // NOTE: fastmcp's stop() does NOT promptly release the underlying http
    // listening socket in-process, so a same-port rebind in the same process
    // is unreliable. Production daemon restart is a SEPARATE process (full
    // exit releases the port); tests that restart in-process pick fresh ports.
    // Drop any lingering SSE subscribers — the daemon owns the bus singleton
    // and a new daemon instance in the same process must start clean.
    resetBus();
    // Reset readiness slot so a same-process restart starts clean.
    resetReadiness();
    // T3.8/T5: drain SQL worker-thread pool before closing the writer.
    // 2s budget — pool jobs are read-only SELECTs that should drain
    // promptly; anything still in flight after the budget is rejected
    // with sql_pool_shutting_down rather than silently hanging shutdown.
    if (sqlPool) {
      try { await sqlPool.shutdown(2000); } catch (err) {
        logger.debug({ where: "daemon.stop.sql_pool_shutdown", err: String(err) }, "pool shutdown failed (best-effort)");
      }
      clearSqlPool();
      sqlPool = null;
    }
    closeDb(stateDbPath);
    tryRemove(socketFile);
    tryRemove(tokenFile);
    // F10 canonical hot-reload: reap the child git HEAD sibling state
    // file so a stale value cannot mislead a supervisor that probes
    // before the next child writes its own HEAD.
    removeChildGitHead();
  };

  // Batch 3.OPS: register the daemon_ready emitter. Fires exactly once,
  // the moment every registered worker has completed its first tick.
  setOnReady(() => {
    try {
      emitEvent(db, {
        kind: "daemon_ready",
        substrate_origin: "substrate_auto",
        payload: {
          pid: process.pid,
          ready_at_ms: Date.now(),
          startup_duration_ms: Date.now() - startedAtMs,
        },
      });
      logger.info(
        { startup_duration_ms: Date.now() - startedAtMs },
        "daemon is ready — all workers completed first tick",
      );
    } catch (err) {
      // emission failure should not crash boot — log at debug only
      logger.debug({ where: "daemon.setOnReady.emit", err: String(err) }, "could not emit daemon_ready");
    }
  });

  // ROLE=worker skips port bind: a worker-only daemon does not serve
  // HTTP or MCP — its sole responsibility is running setIntervals against
  // the shared SQLite db. The server daemon (role=server) handles all
  // request traffic; this process never accepts inbound connections.
  if (!skipPorts) {

  // 1. Bind the FastMCP HTTP-streaming transport on the primary port.
  // Inbound MCP callers in production: opencode brain subprocess AND CLI
  // commands (acc state / acc tail / acc admin_* via cli/rpc.ts). Default
  // invoker is `claude_root` because the brain emits its identity via
  // `substrate_origin: "opencode"` in every payload per the prompt grammar
  // — the invoker default applies to CLI/orchestrator paths that don't set
  // origin explicitly. Brain-gates use the (origin OR invoker) discriminator
  // (`isBrainEmit` in substrate_tools.ts) to fire structurally on brain
  // emits while leaving CLI/orchestrator emits unmolested.
  //
  // Phase-level logging (2026-05-19, "improve errors catching"): each
  // boot phase logs entry + exit so a silent hang surfaces as the LAST
  // logged phase + a known-good prior phase. Bare Bun.serve / mcpServer.start
  // could previously hang with zero diagnostic; the surrounding logger calls
  // bracket the await and make the hang point identifiable.
  logger.info({ phase: "mcp_bind", port }, "daemon.boot.phase_start");
  try {
    mcpServer = createMcpServer({ db, invoker: "claude_root", index, ingressState });
    // MCP session GC (2026-05-23): feed the reaper's first-seen registry from
    // fastmcp's lifecycle events. `connect` starts a session's age clock;
    // `disconnect` (graceful close — fastmcp already spliced it from
    // #sessions) drops its tracking row so a graceful reconnect is never
    // mistaken for a leak. The periodic mcp_session_reaper worker handles
    // sessions that LEAK (never fire disconnect) via age/transport-death.
    mcpServer.on("connect", (event) => {
      try { mcpSessionReaper.noteConnect(event.session as unknown as import("./mcp_session_reaper").ReapableSession); }
      catch (err) { logger.debug({ where: "daemon.mcp.connect_hook", err: String(err) }, "noteConnect failed (best-effort)"); }
    });
    mcpServer.on("disconnect", (event) => {
      try { mcpSessionReaper.noteDisconnect(event.session as unknown as import("./mcp_session_reaper").ReapableSession); }
      catch (err) { logger.debug({ where: "daemon.mcp.disconnect_hook", err: String(err) }, "noteDisconnect failed (best-effort)"); }
    });
    // FastMCP wedge workaround (2026-05-19): mcpServer.start() resolves
    // promptly on a fresh DB but NEVER resolves on a large DB (276K events).
    // The HTTP port IS bound — we observe LISTEN on the port in ss output
    // and inbound MCP traffic is accepted — but the start() promise stays
    // pending forever. The cause is inside fastmcp's httpStream transport
    // and is opaque to us. Fix shape: fire start() without awaiting, then
    // poll the port directly to verify the bind. Bun.connect succeeds when
    // the server is listening; that's the actual readiness signal we need.
    // If the port doesn't bind within MCP_BIND_VERIFY_TIMEOUT_MS, throw a
    // diagnostic error — the daemon will exit 1 with a clear message rather
    // than hang silently.
    // fastmcp's start() binds the port SYNCHRONOUSLY as a side effect (port
    // visible in `ss` immediately after the call returns) but the returned
    // promise never resolves on a large DB. We don't await it. The port
    // is bound by the time control returns to us.
    logger.info({ phase: "mcp_bind", port }, "daemon.boot.phase_calling_start");
    // Pre-bind probe: if something is ALREADY listening on `port`, fastmcp's
    // underlying Node http server would emit an asynchronous, unhandled
    // 'error' ("Failed to start server. Is port N in use?") that escapes this
    // try/catch (the start() promise is fire-and-forget, see below) and
    // surfaces as an "unhandled error between tests" under `bun test
    // --parallel`. Detect the in-use case synchronously here and throw a
    // catchable EADDRINUSE so callers (startDaemonOnFreePorts retry loop)
    // can pick a fresh port instead of crashing.
    if (await isPortListening(host, port)) {
      throw new Error(`listen EADDRINUSE: port ${port} in use`);
    }
    // FastMCP's start() binds the port SYNCHRONOUSLY as a side effect but the
    // returned promise never resolves on a large DB, so we fire-and-forget.
    void mcpServer.start({
      transportType: "httpStream",
      httpStream: { host, port },
    }).catch((err) => {
      logger.warn({ phase: "mcp_bind_background", err: (err as Error).message }, "fastmcp start() rejected post-bind (best-effort log)");
    });
    // Post-bind verify: poll until the port accepts connections. If it never
    // binds within the timeout, the bind failed (e.g. lost a close→reuse
    // race after the probe above) — throw a catchable error rather than
    // leaving a half-started daemon and an unhandled async 'error'.
    let mcpBound = false;
    for (let i = 0; i < 40; i++) {
      if (await isPortListening(host, port)) { mcpBound = true; break; }
      await new Promise((r) => setTimeout(r, 25));
    }
    if (!mcpBound) {
      throw new Error(`listen EADDRINUSE: MCP port ${port} did not bind`);
    }
    logger.info({ phase: "mcp_bind", port }, "daemon.boot.phase_complete");
  } catch (err) {
    logger.fatal({ phase: "mcp_bind", port, err: (err as Error).message }, "daemon.boot.phase_failed");
    for (const dispose of workers) dispose();
    // Resource-leak fix (2026-05-23): the SQL worker-thread pool is spawned
    // BEFORE the port bind (so migrated callsites find it on their first
    // tick), so a bind failure here would otherwise orphan N worker_threads
    // AND leave the process-global singleton pointing at a DB we are about to
    // close. Under the startDaemonOnFreePorts retry loop every retry would
    // leak another pool. Shut it down on this failure path too — `stop()`
    // already does this on the success path, but this branch bypasses stop().
    if (sqlPool) {
      try { await sqlPool.shutdown(2000); } catch (poolErr) {
        logger.debug({ where: "daemon.boot.mcp_bind_recovery.sql_pool", err: String(poolErr) }, "sql pool shutdown during mcp-bind failure (best-effort)");
      }
      clearSqlPool();
      sqlPool = null;
    }
    closeDb(stateDbPath);
    // Release the boot-intent lock acquireBootLock wrote (phase:"booting").
    // Without this a failed bind leaves a stale lock that blocks the next
    // start until the dead-pid reaper fires — the retry should proceed
    // immediately. (DAEMON_BOOT_LOCK brain amendment.)
    tryRemove(socketFile);
    throw new Error(`failed to bind MCP port ${port}: ${(err as Error).message}`);
  }

  // 2. Bind the auxiliary HTTP server on auxPort. If this fails, tear down
  //    the MCP transport so we don't leak the primary port.
  logger.info({ phase: "aux_bind", aux_port: auxPort }, "daemon.boot.phase_start");
  try {
    auxServer = Bun.serve({
      port: auxPort,
      hostname: host,
      fetch: (req) => routeAux(req, db, ingressState, adminToken, stop, startedAtMs, stateDbPath, port, auxPort),
    });
    logger.info({ phase: "aux_bind", aux_port: auxPort }, "daemon.boot.phase_complete");
  } catch (err) {
    logger.fatal({ phase: "aux_bind", aux_port: auxPort, err: (err as Error).message }, "daemon.boot.phase_failed");
    for (const dispose of workers) dispose();
    try { await mcpServer?.stop(); } catch (stopErr) {
      logger.debug({ where: "daemon.boot.aux_bind_recovery", err: String(stopErr) }, "mcp stop during aux-bind failure");
    }
    // Resource-leak fix (2026-05-23): same as the mcp_bind failure path — the
    // SQL worker-thread pool was spawned before the bind, so tear it down here
    // too. Otherwise an aux-bind failure (which CAN happen independently: the
    // MCP port bound but auxPort is occupied) orphans N worker_threads.
    if (sqlPool) {
      try { await sqlPool.shutdown(2000); } catch (poolErr) {
        logger.debug({ where: "daemon.boot.aux_bind_recovery.sql_pool", err: String(poolErr) }, "sql pool shutdown during aux-bind failure (best-effort)");
      }
      clearSqlPool();
      sqlPool = null;
    }
    closeDb(stateDbPath);
    // Release the boot-intent lock so a retry can proceed (see mcp_bind
    // handler above). (DAEMON_BOOT_LOCK brain amendment.)
    tryRemove(socketFile);
    throw new Error(`failed to bind aux port ${auxPort}: ${(err as Error).message}`);
  }

  } // end if (!skipPorts)

  logger.info({ phase: "write_lock_file" }, "daemon.boot.phase_start");
  // Rewrite the boot-intent lock (acquireBootLock wrote phase:"booting" at the
  // top of startup) with the full ready payload now that ports are bound. The
  // phase:"ready" marker lets a concurrent probe distinguish a daemon that has
  // finished booting from one still in its boot window — both refuse a second
  // start, but the message differs ("running" vs "booting").
  writeLockFile(socketFile, {
    pid: process.pid,
    port: skipPorts ? -1 : port,
    aux_port: skipPorts ? -1 : auxPort,
    started_at_ms: startedAtMs,
    db_path: stateDbPath,
    role,
    phase: "ready",
  });

  // F10 canonical hot-reload (cite EJFZER4SBH3C51WF1J6KWX2V6G): write
  // the current git HEAD to a sibling state file so the outer
  // supervisor (a separate process) can compare against repo HEAD at
  // bounded detector ticks. Best-effort — a non-git checkout or a
  // missing git binary leaves no file, the supervisor degrades to
  // child_head_unavailable instead of swapping blindly.
  const loadedGitHead = getCurrentGitHead();
  if (loadedGitHead) {
    try {
      writeChildGitHead(loadedGitHead);
    } catch (err) {
      logger.debug(
        { where: "daemon.boot.write_loaded_git_head", err: String(err) },
        "could not persist loaded git HEAD (supervisor will see child_head_unavailable)",
      );
    }
  }
  // ROLE=worker writes a separate token file too so server+worker don't
  // clobber each other's admin token.
  const tokenFileForRole = skipPorts ? `${tokenFile}.worker` : tokenFile;
  writeLockFile(tokenFileForRole, { admin_token: adminToken });

  // OPENAI_API_KEY presence check (dark-gate audit 2026-05-18). The
  // retrieval-binding hook (scripts/retrieval-binding-hook.ts) and the
  // embedder use OPENAI_API_KEY to compute query embeddings + ranking
  // signal for substrate.search. Absent key → empty retrieval, empty
  // depth_1_retrieval, query_embedding_unavailable owner_input_required
  // surfacing. Three independent observations on 2026-05-18 (19:14,
  // 19:36, 19:52) all traced back to the daemon process not seeing the
  // env var. Do NOT crash — the daemon can run for closure audits,
  // worker ticks, and ledger reads without retrieval. Log loudly so
  // operator and docs surface the consequence at boot.
  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY.trim().length === 0) {
    process.stderr.write(
      "[daemon] WARNING: OPENAI_API_KEY is not set in the daemon process environment.\n" +
        "[daemon]   Consequence: retrieval-binding hook returns empty, query_embedding_unavailable\n" +
        "[daemon]   owner_input_required signals will fire on every search-anchored task, and the k_201\n" +
        "[daemon]   retrieval-credit closure breaks (no embedded query → no rank signal → no binding).\n" +
        "[daemon]   Set OPENAI_API_KEY in the environment that starts `acc daemon start` (e.g. via .env)\n" +
        "[daemon]   and restart the daemon. Daemon continues without the key for closure/worker paths\n" +
        "[daemon]   that don't depend on it.\n",
    );
  }

  // SERPER_API_KEY presence check (lesson 0R6EPM4AX54J — Serper-dependent
  // artifacts should surface key_source/missing-key status before live
  // Scholar/Search work). Daemon subprocesses inherit env from the shell
  // that spawned them; a missing key here silently degrades any live
  // research dispatch that calls Serper for web search or patent
  // enumeration. Same fail-loud-but-not-crash shape as the OPENAI warning.
  if (!process.env.SERPER_API_KEY || process.env.SERPER_API_KEY.trim().length === 0) {
    process.stderr.write(
      "[daemon] WARNING: SERPER_API_KEY is not set in the daemon process environment.\n" +
        "[daemon]   Consequence: any live-research brain dispatch that calls Serper for web search will\n" +
        "[daemon]   silently return empty results. Dispatches relying on patent enumeration, paper search,\n" +
        "[daemon]   or public web evidence will produce thin or empty deep-research KCs.\n" +
        "[daemon]   Set SERPER_API_KEY in the environment that starts `acc daemon start` (e.g. via .env)\n" +
        "[daemon]   and restart the daemon. Daemon continues without the key for closure/worker paths\n" +
        "[daemon]   that don't depend on it.\n",
    );
  }

  emitEvent(db, {
    kind: "daemon_started",
    substrate_origin: "substrate_auto",
    payload: {
      pid: process.pid,
      port,
      aux_port: auxPort,
      db_path: stateDbPath,
      started_at_ms: startedAtMs,
      transport: "fastmcp:httpStream",
    },
  });
  // Per Architecture.md the canonical embedding index is sqlite-vec
  // (substrate/schema.sql `vec_events` virtual table). The "rebuild"
  // step is now effectively instant — we backfill vec_events from the
  // legacy events.embedding BLOB column for cutover-window parity, then
  // hand back a thin wrapper over the SQL surface. The `mode` field
  // distinguishes the new path so log consumers (and the integration
  // smoke that asserts the event was emitted) can tell which storage
  // backed the daemon at boot.
  const vecCount = (
    db.query("SELECT COUNT(*) AS n FROM vec_events").get() as { n: number } | null
  )?.n ?? 0;
  emitEvent(db, {
    kind: "daemon_index_rebuilt",
    substrate_origin: "substrate_auto",
    payload: {
      mode: "sqlite_vec_backed",
      size: index.size(),
      vec_count: vecCount,
      note: "phase_f_sqlite_vec_index",
    },
  });

  // POSIX signal hooks — node-style, Bun honours them.
  const onSignal = () => { void stop().then(() => process.exit(0)); };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);

  // Unhandled rejection / exception handlers. Without these, an async
  // throw deep inside any third-party module (mcp-proxy, FastMCP, etc.)
  // becomes an unhandled rejection and Bun's default behavior is to
  // exit the process — taking down every in-flight brain dispatch with
  // it. Live ledger evidence today (2026-05-16): 12 daemon restarts in
  // one session, each one preceded by repeated
  // `[FastMCP error] Conflict: Only one SSE stream is allowed per
  // session` exceptions from mcp-proxy's handleGetRequest when an MCP
  // client reconnects to an existing session ID. Every restart orphans
  // every live brain dispatch (today: 5 orphans per restart) and forces
  // a scheduler re-pick that the follow-stream can't reattach to. The
  // handlers below log every such fault to daemon.log + the event
  // ledger and let the daemon keep running — third-party transport
  // faults must not be process-fatal.
  process.on("unhandledRejection", (reason, _promise) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    logger.error({ where: "daemon.unhandledRejection", reason: msg, stack }, "unhandled rejection — daemon will continue");
    try {
      emitEvent(db, {
        kind: "daemon_unhandled_rejection",
        substrate_origin: "substrate_auto",
        payload: { reason: msg, stack: stack?.slice(0, 2000) ?? null, source: "unhandledRejection" },
      });
    } catch { /* never let logging crash */ }
  });
  process.on("uncaughtException", (err) => {
    logger.error({ where: "daemon.uncaughtException", err: err.message, stack: err.stack }, "uncaught exception — daemon will continue");
    try {
      emitEvent(db, {
        kind: "daemon_unhandled_rejection",
        substrate_origin: "substrate_auto",
        payload: { reason: err.message, stack: err.stack?.slice(0, 2000) ?? null, source: "uncaughtException" },
      });
    } catch { /* never let logging crash */ }
  });

  // BIND-BEFORE-WORKERS kickoff (2026-05-22): ports are bound, the lock
  // file + token are written, daemon_started/daemon_index_rebuilt are
  // emitted, and signal handlers are installed. NOW — and only now —
  // schedule the worker setup. It runs on a fresh macrotask AFTER
  // startDaemon() resolves to its caller, so the heavy synchronous
  // first-tick scans (which previously starved the event loop for 100s+
  // on a 367k-event ledger and tripped the startup watchdog before the
  // ports ever bound) can no longer block the bind or the resolve. The
  // ports already serve /health + MCP; the workers complete their first
  // ticks in the background and setOnReady → daemon_ready still fires once
  // every registered worker has ticked. role=server (skipWorkers) and
  // role=worker (skipPorts) both still run startWorkers — the internal
  // `if (!skipWorkers)` gate decides which workers register, exactly as
  // before — only the timing relative to the bind changed.
  //
  // queueMicrotask (not setTimeout): startWorkers' SYNCHRONOUS prefix
  // (the registerWorker batch + every registerReactiveWorker
  // onEvent-subscription) must be installed before the first ledger event
  // an immediate post-boot caller emits, or that event slips past the
  // reactive subscriptions and only the 30-min safety net would catch it.
  // The microtask fires the instant startDaemon()'s promise resolves —
  // after the bind/lock/resolve, before any caller continuation runs — so
  // subscriptions are live with a zero-event gap. The heavy first-tick
  // scans (the actual event-loop starvers) still run in this background
  // task AFTER the ports are already serving, broken up by the worker
  // block's many `await import(...)` yields; they no longer gate the bind.
  queueMicrotask(() => {
    void startWorkers()
      .then(() => {
        // Race close-out: stop() may have fired during one of
        // startWorkers' `await import(...)` points, AFTER it had already
        // pushed some disposers into `workers` but BEFORE stop()'s own
        // disposal loop saw them (stop() drains `workers` once). Any such
        // late-registered timer/subscriber would leak for the process
        // lifetime — under `bun test --parallel` that leak accumulates
        // across the suite into memory pressure → SIGILL worker crashes.
        // If stop() ran, drain whatever startWorkers registered. Idempotent
        // with stop()'s own loop because both splice the shared array.
        if (stopped) {
          for (const dispose of workers.splice(0)) {
            try { dispose(); } catch { /* best-effort */ }
          }
        }
      })
      .catch((err) => {
        logger.error(
          { where: "daemon.startWorkers", err: (err as Error).message, stack: (err as Error).stack },
          "deferred worker setup failed — daemon serves ports but workers did not start; check for a worker-init throw",
        );
        try {
          emitEvent(db, {
            kind: "error_caught",
            substrate_origin: "substrate_auto",
            payload: {
              where: "daemon.startWorkers",
              recoverable: false,
              message: (err as Error).message,
            },
          });
        } catch { /* db may be closed */ }
      });
  });

  // INSTANT-BOOT deferred integrity check (2026-05-23). The boot-time
  // PRAGMA quick_check used to run synchronously BEFORE the ports bound,
  // scanning every page of the ≈1GB state.db and keeping health=ok
  // unreachable for the whole scan. It now runs HERE — after the ports are
  // bound, the lock is written `phase:"ready"`, and /health is already
  // serving `status:ok`. The check still RUNS (correctness preserved) and
  // still catches structural/page corruption; on failure it emits an
  // `integrity_check_failed` event (the same kind the periodic 6h worker
  // emits) instead of refusing a boot that has already succeeded — refusing
  // here would mean killing a daemon that is already serving traffic, which
  // is strictly worse than surfacing the verdict. The result is published to
  // `bootIntegrityState` for the `/health` `boot_integrity` field.
  //
  // Deferred via setTimeout(BOOT_HEAVY_PASS_DELAY_MS) + .unref() so the scan
  // does not contend with the first /health + MCP probes immediately after
  // bind; the scan itself is a single synchronous bun:sqlite pragma (it
  // cannot yield mid-scan) but by the time it fires the ports already serve,
  // so the brief block is on a warm daemon, not on the boot-critical path.
  // role=worker (skipPorts) also runs it so a worker-only daemon still
  // surfaces a boot verdict.
  const runBootIntegrityCheck = async (): Promise<void> => {
    if (stopped) return;
    try {
      const report = await runIntegrityCheck(db, { quick: true });
      if (stopped) return;
      if (report.ok) {
        setBootIntegrity({
          status: "ok",
          pragma_result: report.pragma_integrity_check,
          duration_ms: report.duration_ms,
          checked_at_ms: Date.now(),
        });
        logger.info(
          { duration_ms: report.duration_ms, events_count: report.events_count },
          "deferred boot integrity check passed (health was already serving)",
        );
      } else {
        setBootIntegrity({
          status: "failed",
          pragma_result: report.pragma_integrity_check,
          duration_ms: report.duration_ms,
          checked_at_ms: Date.now(),
        });
        const msg =
          `acc2 daemon: deferred boot PRAGMA quick_check FAILED: ${report.pragma_integrity_check}`;
        process.stderr.write(msg + "\n");
        logger.fatal({ pragma_result: report.pragma_integrity_check }, msg);
        try {
          emitEvent(db, {
            kind: "integrity_check_failed",
            substrate_origin: "substrate_auto",
            payload: {
              pragma_result: report.pragma_integrity_check,
              wal_size_bytes: report.wal_size_bytes,
              events_count: report.events_count,
              embeddings_count: report.embeddings_count,
              duration_ms: report.duration_ms,
              marker: "integrity_check_failed_v1",
              source: "boot_deferred",
            },
          });
        } catch (emitErr) {
          logger.debug({ where: "daemon.boot.deferred_integrity_emit", err: String(emitErr) }, "could not emit integrity_check_failed");
        }
      }
    } catch (err) {
      setBootIntegrity({
        status: "failed",
        pragma_result: (err as Error).message,
        duration_ms: null,
        checked_at_ms: Date.now(),
      });
      logger.warn({ where: "daemon.boot.deferred_integrity", err: String(err) }, "deferred boot integrity check threw");
    }
  };
  setTimeout(() => { void runBootIntegrityCheck(); }, BOOT_HEAVY_PASS_DELAY_MS).unref();

  return {
    server: auxServer,
    mcpServer,
    db,
    adminToken,
    startedAtMs,
    port,
    auxPort,
    stateDbPath,
    socketFile,
    tokenFile,
    ingressState,
    workers,
    index,
    stop,
  };
};

/** Programmatic shutdown — equivalent to SIGTERM but synchronous from the
 *  caller's perspective. Tests use this. `drainBudgetMs` is forwarded to
 *  `handle.stop` (see amendment 8EAKQCJW5D). */
export const stopDaemon = async (
  handle: DaemonHandle,
  drainBudgetMs?: number,
): Promise<void> => {
  await handle.stop(drainBudgetMs);
};

// ── Auxiliary HTTP routing (non-MCP) ───────────────────────────────

const routeAux = async (
  req: Request,
  db: Database,
  ingressState: ExternalIngressState,
  adminToken: string,
  stop: (drainBudgetMs?: number) => Promise<void>,
  startedAtMs: number,
  stateDbPath: string,
  mcpPort: number,
  auxPort: number,
): Promise<Response> => {
  const url = new URL(req.url);

  if (url.pathname === "/health" && req.method === "GET") {
    // Fail-fast surface: any worker that hasn't ticked in 3× its declared
    // interval shows up as "stuck". HTTP status stays 200 so liveness probes
    // don't restart the process — operators reading the body see the
    // degraded state directly.
    const stuck = stuckWorkers();
    // Tier D D1: workers whose CURRENT tick started but never completed past
    // 60s — the spinning/wedged-worker signal that named nothing this
    // session. Surfaced in /health so a hung daemon is diagnosable in one
    // probe (the supervisor-scanning-325K-events case).
    const inFlightStuck = inFlightStuckWorkers();
    let hotreloadState: unknown = null;
    try {
      const mod = await import("./hotreload_worker");
      hotreloadState = mod.getHotreloadState();
    } catch { /* worker may not have started; tolerate */ }
    // Brain convergence audit axis J (2026-05-15): surface in-process
    // observability that wasn't in /health before — pathology budget
    // pressure, recent brain failures, activation bus subscriber count.
    let activationListenerCount = 0;
    try {
      const mod = await import("./activation_bus");
      activationListenerCount = mod.activationListenerCount();
    } catch { /* tolerate */ }
    const counts = readHealthCounts(db);
    // F9: surface SQL pool stats so `acc daemon status` can see
    // reader/writer utilisation, write-queue depth, and lifetime counters
    // across every cached pool. Empty array when no pool is open.
    const poolStats = getAllPoolStats();
    // F-resilience: surface WAL pressure stats so operators can see
    // pressure building between probes. The shape is set by the
    // wal_pressure_check worker (runtime/wal_pressure_worker.ts) and
    // would have surfaced the 206MB WAL growth that caused the daemon
    // hang this session.
    let walStats: unknown = {
      size_bytes: 0,
      threshold_bytes: 0,
      last_checkpoint_ts: null,
      last_checkpoint_result: null,
    };
    try {
      const mod = await import("./wal_pressure_worker");
      const last = mod.getLastWalPressureSummary();
      if (last) {
        walStats = {
          size_bytes: last.wal_size_bytes,
          threshold_bytes: last.threshold_bytes,
          last_checkpoint_ts: last.checkpoint_ran ? last.ts : null,
          last_checkpoint_result: last.checkpoint_result,
        };
      } else {
        // Worker has not ticked yet (boot race or test mode with the
        // worker pinned off). Report the universal 100 MB threshold so
        // operators still see what would trigger a checkpoint.
        const thresholdMb = 100;
        walStats = {
          size_bytes: 0,
          threshold_bytes: Math.floor(thresholdMb * 1024 * 1024),
          last_checkpoint_ts: null,
          last_checkpoint_result: null,
        };
      }
    } catch { /* worker module not present; tolerate */ }
    // Credential presence flags (lesson 0R6EPM4AX54J). Operators reading
    // /health see whether the keys live-research and embedding paths
    // depend on are present in the daemon process env. Values report
    // presence only — the keys themselves are never exposed on the wire.
    const credPresent = (name: string): "present" | "missing" => {
      const value = process.env[name];
      return value && value.trim().length > 0 ? "present" : "missing";
    };
    const credentials = {
      openai: credPresent("OPENAI_API_KEY"),
      serper: credPresent("SERPER_API_KEY"),
    };
    // F10 canonical hot-reload: surface the child's loaded git HEAD so
    // the outer supervisor (and operators running `acc daemon status`)
    // can verify which commit the daemon is currently serving. The
    // helper re-reads the sibling state file each probe — cheap, and
    // a missing file is silently null (not a /health failure).
    let loadedGitHead: string | null = null;
    try {
      const fs = await import("node:fs");
      const path = resolveChildGitHeadPath();
      if (fs.existsSync(path)) {
        loadedGitHead = fs.readFileSync(path, "utf8").trim() || null;
      }
    } catch { /* tolerate */ }
    // T3.8/T5: SQL worker-thread pool surface. Reports null when the pool
    // is disabled (ACC2_DISABLE_SQL_POOL=1) so operators can distinguish
    // "pool disabled" from "pool present but idle".
    let sqlWorkerPoolStats: Record<string, number> | null = null;
    try {
      const mod = await import("./sql_pool_singleton");
      const p = mod.getSqlPool();
      if (p) sqlWorkerPoolStats = p.metrics() as unknown as Record<string, number>;
    } catch { /* tolerate */ }
    // Handshake gate state (2026-05-21, b9869bc multi-brain foundation).
    // Surfaces the in-process serialization gate that limits concurrent
    // MCP-handshake-window holders during burst-spawn periods. Operators
    // see queue depth + permit utilization via `acc daemon status` without
    // needing to read internal bridge state.
    let handshakeGate: Record<string, number> | null = null;
    try {
      const mod = await import("./bridge/opencode");
      handshakeGate = mod._handshakeGateStateForTests();
    } catch { /* bridge module may be unloadable in tests; tolerate */ }
    return Response.json({
      status: stuck.length === 0 ? "ok" : "degraded",
      pid: process.pid,
      uptime_ms: Date.now() - startedAtMs,
      db_path: stateDbPath,
      events_count: counts.events_count,
      mcp_port: mcpPort,
      aux_port: auxPort,
      mcp_transport: "fastmcp:httpStream",
      stuck_workers: stuck,
      in_flight_stuck_workers: inFlightStuck,
      hotreload: hotreloadState,
      activation_listener_count: activationListenerCount,
      pathology_budget_exhausted_recent_count: counts.pathology_exhausted,
      pathology_budget_debited_recent_count: counts.pathology_debited,
      brain_failed_recent_count: counts.brain_failed,
      health_window_iso: counts.window_iso,
      sql_pool_stats: poolStats,
      sql_worker_pool: sqlWorkerPoolStats,
      wal_stats: walStats,
      handshake_gate: handshakeGate,
      credentials,
      loaded_git_head: loadedGitHead,
      // INSTANT-BOOT (2026-05-23): the boot integrity check runs DEFERRED,
      // after the ports bind + /health serves. `pending` until the deferred
      // quick_check completes; `ok` / `failed` afterward. health=ok does NOT
      // depend on this — a `pending` boot_integrity with status=ok is the
      // normal just-booted state.
      boot_integrity: getBootIntegrityState(),
    });
  }

  if (url.pathname === "/ready" && req.method === "GET") {
    if (isReady()) {
      const readyAtMs = readyAt();
      return Response.json({
        status: "ready",
        pid: process.pid,
        uptime_ms: Date.now() - startedAtMs,
        ready_at_ms: readyAtMs,
        startup_duration_ms: readyAtMs ? readyAtMs - startedAtMs : null,
      });
    }
    return Response.json(
      {
        status: "not_ready",
        pid: process.pid,
        uptime_ms: Date.now() - startedAtMs,
        pending_workers: pendingWorkers(),
      },
      { status: 503 },
    );
  }

  if (url.pathname === "/metrics" && req.method === "GET") {
    return metricsHandler(req);
  }

  if (url.pathname === "/shutdown" && req.method === "POST") {
    const presented = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
    if (presented !== adminToken) {
      return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    // Amendment 8EAKQCJW5D: accept an optional `drain_budget_ms` from the
    // request body so restart paths can request a longer/shorter graceful
    // drain than the default. Absent / malformed body → use the default.
    // Numeric values are clamped to a non-negative integer; 0 means
    // "immediate kill". Anything else (string, null, missing) falls through
    // to the default budget.
    let drainBudgetMs: number | undefined = undefined;
    try {
      const ct = req.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) {
        const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
        const raw = body?.drain_budget_ms;
        if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
          drainBudgetMs = Math.floor(raw);
        }
      }
    } catch { /* swallow — fall through to default budget */ }
    const requested = drainBudgetMs;
    // Fence scheduler admission synchronously with shutdown acceptance.
    // Waiting for the delayed stop() call leaves a restart race where a
    // scheduler tick can admit fresh brain work after the operator already
    // requested a drain.
    setSchedulerDraining(true);
    setTimeout(() => { void stop(requested); }, 50);
    return Response.json({
      ok: true,
      status: "shutting_down",
      drain_budget_ms: requested ?? RESTART_DRAIN_TIMEOUT_MS,
    });
  }

  if (url.pathname === "/external/push") {
    return handleExternalPush(db, ingressState, req);
  }

  if (url.pathname === "/events/stream" && req.method === "GET") {
    return handleEventsStream(req);
  }

  return Response.json({ ok: false, error: `unknown_route:${url.pathname}` }, { status: 404 });
};

// ── SSE: /events/stream ─────────────────────────────────────────────
//
// One controller per open connection. We register a bus subscriber that
// formats each BusEvent into a `data: <json>\n\n` frame and pushes it to
// the controller. On disconnect (cancel) we unsubscribe so the bus never
// retains a dead controller. Heartbeat comments every 15s keep idle
// proxies from killing the connection.

const handleEventsStream = (req: Request): Response => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Emit a comment line so the client knows the stream is alive even
      // when no event has been published yet (some SSE consumers wait for
      // the first byte before resolving the connection promise).
      try { controller.enqueue(encoder.encode(": connected\n\n")); } catch { /* swallow */ }
      const subscriber = (event: BusEvent) => {
        try {
          // FOUNDATIONAL FIX 2026-05-17: forward ALL BusEvent fields
          // (including the act-loop columns) so SSE consumers see the
          // same shape as the events table. Pre-fix the frame omitted
          // action_artifact_id / verifier_artifact_id / predicted_residual
          // and downstream renderers showed "action=— verifier=—".
          const frame = `data: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(frame));
        } catch {
          // Best effort — if the controller is closed the bus will catch
          // the throw on the NEXT publish and drop us.
          try { unsubscribe(); } catch { /* swallow */ }
        }
      };
      const unsubscribe = subscribe(subscriber);
      // Hard timer: SSE keepalive measures connection idleness, not substrate work arrival.
      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(": keepalive\n\n")); } catch { /* swallow */ }
      }, 15_000);
      // Stop on abort signal from the request (client disconnect).
      req.signal.addEventListener("abort", () => {
        try { clearInterval(heartbeat); } catch { /* swallow */ }
        try { unsubscribe(); } catch { /* swallow */ }
        try { controller.close(); } catch { /* swallow */ }
      });
      // Attach cleanup metadata to the controller via a private cancel hook
      // — set on the stream directly below.
      (controller as unknown as { _accClose?: () => void })._accClose = () => {
        try { clearInterval(heartbeat); } catch { /* swallow */ }
        try { unsubscribe(); } catch { /* swallow */ }
      };
    },
    cancel(reason) {
      void reason;
      // ReadableStream's cancel runs when the consumer (or the runtime on
      // teardown) closes the stream. We have no direct controller handle
      // here — the abort/close path inside start() already runs unsubscribe.
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
};

// ── Entrypoint when invoked directly (`bun runtime/daemon.ts`) ─────

if (import.meta.main) {
  // Improved error catching (2026-05-19): silent hangs during startDaemon
  // were producing zero diagnostic output — daemon process alive, no log
  // line written, no port bound. Three structural fail-loud mechanisms:
  //
  //   1. uncaughtException + unhandledRejection handlers surface stray
  //      throws that bypass startDaemon's own try/catch (e.g., errors in
  //      timer callbacks, async cleanup paths, or worker init promises).
  //   2. A 90-second startup timeout converts hangs into thrown errors
  //      with a clear "startup_timeout" classification. If startDaemon
  //      doesn't resolve within 90 s, we abort with a diagnostic dump of
  //      the last log lines + a hint at which phase likely hung.
  //   3. process.stderr writes happen synchronously before exit so the
  //      daemon spawn wrapper (acc daemon start) sees the failure even
  //      if logger flushing fails.
  //
  // The 90-second budget is generous (normal startup is ~30 s on a large
  // DB; the timeout protects against indefinite hangs, not slow boots).
  process.on("uncaughtException", (err) => {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    try { logger.fatal({ err: msg }, "uncaughtException in daemon process"); } catch { /* logger may be down */ }
    process.stderr.write(`acc2 daemon uncaughtException: ${msg}\n`);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
    try { logger.fatal({ err: msg }, "unhandledRejection in daemon process"); } catch { /* logger may be down */ }
    process.stderr.write(`acc2 daemon unhandledRejection: ${msg}\n`);
    process.exit(1);
  });
  // Default raised 90s→180s for distribution robustness: boot waits for every
  // worker's first tick, and on a large ledger (300k+ events) or a slow/loaded
  // operator machine the catch-up first-ticks can take >90s (observed 101s
  // under daemon-swap contention), which false-killed the daemon mid-boot.
  // 180s gives headroom for a slow-but-completing boot; the real instant-serve
  // path is the role-split server role (skipWorkers). Env-overridable.
  const STARTUP_TIMEOUT_MS = Number(process.env.ACC2_DAEMON_STARTUP_TIMEOUT_MS ?? 180_000);
  void (async () => {
    let startupResolved = false;
    const startupTimeout = setTimeout(() => {
      if (startupResolved) return;
      const msg = `acc2 daemon startup timeout — startDaemon() did not resolve within ${STARTUP_TIMEOUT_MS}ms. Probable cause: an early phase (DB open / schema migration / worker first-tick / MCP bind / aux bind / writeLockFile) hung silently. Check /home/maxbaluev/.accint/logs/daemon.log for the last logged phase before timeout.`;
      try { logger.fatal({ timeout_ms: STARTUP_TIMEOUT_MS }, "acc2 daemon startup timeout"); } catch { /* logger may be down */ }
      process.stderr.write(msg + "\n");
      process.exit(2);
    }, STARTUP_TIMEOUT_MS);
    startupTimeout.unref();
    try {
      const handle = await startDaemon();
      startupResolved = true;
      clearTimeout(startupTimeout);
      logger.info(
        {
          pid: process.pid,
          mcp_url: `http://127.0.0.1:${handle.port}`,
          aux_url: `http://127.0.0.1:${handle.auxPort}`,
          db_path: handle.stateDbPath,
        },
        "acc2 daemon listening",
      );
    } catch (err) {
      startupResolved = true;
      clearTimeout(startupTimeout);
      // Idempotent no-op: another daemon already holds the atomic boot lock
      // (booting or running). This is the EXPECTED outcome of a second
      // concurrent `daemon start` — exit 0 cleanly, do NOT report a crash.
      if (isDaemonAlreadyRunningError(err)) {
        const m = err.message;
        try { logger.info({ pid: err.pid, phase: err.phase }, "acc2 daemon start is a no-op — another instance holds the boot lock"); } catch { /* logger may be down */ }
        process.stderr.write(`acc2 daemon: ${m} — start is a no-op\n`);
        process.exit(0);
      }
      const msg = err instanceof Error ? err.stack ?? err.message : String(err);
      logger.fatal({ err: msg }, "acc2 daemon failed to start");
      process.stderr.write(`acc2 daemon failed to start: ${msg}\n`);
      process.exit(1);
    }
  })();
}
