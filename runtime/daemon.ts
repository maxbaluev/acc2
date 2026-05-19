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
// V2_DAEMON_AUX_PORT). Per v2-design.md §5.1 the daemon is single-instance
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
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Database } from "bun:sqlite";
import { closeDb, openDb, getAllPoolStats } from "../substrate/db";
import { runViews } from "../substrate/views";
import { emitEvent } from "./events";
import { subscribe, resetBus, type BusEvent } from "./event_bus";
import { onEvent, type ActivationPayload } from "./activation_bus";
import type { EventKind } from "../substrate/event_kinds";
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
import { embedderWorkerTick } from "./embedder";
import { rehabilitationWorkerTick, getArtifact } from "./artifact_store";
import { runBunArtifact } from "./runtimes/bun";
import { runUvArtifact } from "./runtimes/uv";
import { runCamofoxArtifact } from "./runtimes/camofox";
import type { JsonValue, SandboxDecl } from "../substrate/types";
import { logger } from "./logger";
import { metricsHandler, refreshGauges } from "./metrics";
import { integrityWorkerTick, runIntegrityCheck, reconcileOrphanedDispatches } from "./integrity_worker";
import { reconcileBrainDispatchesAtBoot, getOpenBrainDispatches, setBootSessionToken } from "./brain_dispatch_reconciler";
import { waitForBrainQuiescence } from "./restart_quiescence";
import {
  getCurrentGitHead,
  writeChildGitHead,
  removeChildGitHead,
  resolveChildGitHeadPath,
} from "./daemon_supervisor";
import { isWorkerEnabled } from "./worker_autostart";
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
  stuckWorkers,
} from "./readiness";

export const DEFAULT_DAEMON_PORT = 9387;
export const DEFAULT_AUX_PORT_OFFSET = 1;

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
 *  at most ~60 rows/hour while still letting auditors reconstruct tick
 *  liveness from the substrate (audit-#5 fix, 2026-05-15). */
const WORKER_TICK_EVENT_DAMPEN_MS = 60_000;
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
      }
    })();
  };
};

const RESTART_DRAIN_TIMEOUT_MS = 30_000;

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
const refreshHealthCounts = (db: Database): void => {
  const now = Date.now();
  const recentCutoff = new Date(now - 30 * 60 * 1000).toISOString();
  const recent = (kinds: string[]): number => {
    try {
      const placeholders = kinds.map(() => "?").join(",");
      const row = db
        .query(`SELECT COUNT(*) AS c FROM events WHERE kind IN (${placeholders}) AND ts >= ?`)
        .get(...kinds, recentCutoff) as { c: number };
      return row.c;
    } catch { return 0; }
  };
  try {
    healthCountsCache = {
      events_count: countEvents(db),
      pathology_exhausted: recent(["pathology_budget_exhausted"]),
      pathology_debited: recent(["pathology_budget_debited"]),
      brain_failed: recent(["bridge_failed", "dispatcher_violation"]),
      window_iso: recentCutoff,
      computed_at_ms: now,
    };
  } catch { /* keep prior cache on transient SQL error */ }
};
const readHealthCounts = (_db: Database): HealthCountsCache => healthCountsCache;

const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
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


  // Single-instance guard: if the lock file exists AND names a live pid,
  // refuse to start. A stale lock (pid not alive) gets reaped.
  if (existsSync(socketFile)) {
    try {
      const prev = JSON.parse(await Bun.file(socketFile).text()) as { pid?: number };
      if (prev.pid && pidAlive(prev.pid)) {
        throw new Error(`daemon already running on pid ${prev.pid}`);
      }
      tryRemove(socketFile);
      tryRemove(tokenFile);
    } catch (err) {
      if ((err as Error).message?.startsWith("daemon already running")) throw err;
      tryRemove(socketFile);
      tryRemove(tokenFile);
    }
  }

  ensureDir(stateDbPath);
  const db = openDb(stateDbPath);
  runViews(db);

  // Batch 3.OPS: pre-traffic boot checks.
  //   1. Run PRAGMA integrity_check. On non-"ok" result, stderr diagnostic
  //      + exit 1 — silent corruption is worse than a loud refusal.
  //   2. Reconcile in-flight dispatches: any `brain_dispatched` row whose
  //      task did not close in the previous boot is marked as
  //      `dispatch_recovered_orphan`; the scheduler will re-pick the task
  //      on its next ready_tasks_view check.
  const bootIntegrity = await runIntegrityCheck(db);
  if (!bootIntegrity.ok) {
    const msg =
      `acc2 daemon: REFUSING TO START — PRAGMA integrity_check failed: ` +
      `${bootIntegrity.pragma_integrity_check}`;
    process.stderr.write(msg + "\n");
    logger.fatal({ pragma_result: bootIntegrity.pragma_integrity_check }, msg);
    try { closeDb(stateDbPath); } catch (closeErr) {
      logger.debug({ where: "daemon.boot.integrity_close", err: String(closeErr) }, "closeDb after integrity refusal failed");
    }
    throw new Error(msg);
  }
  const orphans = reconcileOrphanedDispatches(db);
  if (orphans.length > 0) {
    logger.info({ orphan_count: orphans.length }, "reconciled orphan dispatches at boot");
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

  // Phase F: rebuild the in-memory embedding index from substrate. On fresh
  // installs this is an empty index; the worker tick fills it as new
  // embeddable events accumulate.
  const index = EmbeddingIndex.rebuildFromDb(db);

  // Batch 3.OPS: reset readiness slot so a same-process restart starts
  // with a clean tracker.
  resetReadiness();

  const adminToken = newAdminToken();
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
  type ReactiveTriggerKind = EventKind | "*";
  type ReactiveWorkerEntry = {
    worker: string;
    expectedIntervalMs: number;
    minReactiveGapMs: number;
    run: () => void;
    skippedReactiveFires: number;
    lastReactiveFireMs: number;
  };
  const reactiveWorkers: ReactiveWorkerEntry[] = [];
  const emitReactiveFire = (entry: ReactiveWorkerEntry, source: "event" | "safety_net", trigger?: ActivationPayload): void => {
    try {
      const payload: { [k: string]: JsonValue } = {
        worker: entry.worker,
        activation_source: source,
        skipped_reactive_fires: entry.skippedReactiveFires,
        expected_interval_ms: entry.expectedIntervalMs,
      };
      if (trigger?.kind) payload.trigger_kind = trigger.kind;
      if (trigger?.event_id) payload.trigger_event_id = trigger.event_id;
      emitEvent(db, {
        kind: "worker_tick_completed",
        substrate_origin: "substrate_auto",
        payload,
      });
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
  setTimeout(() => { try { refreshHealthCounts(db); } catch { /* swallow */ } }, 250);
  // Hard timer: /health cache freshness degrades with elapsed time even if no ledger event arrives.
  const healthCountsTick = setInterval(() => {
    try { refreshHealthCounts(db); } catch { /* keep stale cache */ }
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
  registerWorker("amendment", amendmentTickMs);
  registerWorker("metrics_gauge_refresh", gaugeTickMs);
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

  // Phase E: amendment worker — drain unapplied directive_amended events when
  // directive amendments arrive. The shared reactive safety net is the fallback
  // for missed in-process notifications. Errors are surfaced as error_caught
  // events (one per amendment) so a malformed amendment can't kill the daemon
  // AND never vanishes silently.
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
    // Mark ready immediately — the boot-time runIntegrityCheck already
    // proved the substrate is healthy. Reactive event wakes handle new rows;
    // the shared safety net still covers stale dispatch/task scans.
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

  // Brain contract Q471RAN88X0H513V8BC3BTW0AW Phase F (2026-05-17):
  // rendering-audit worker. Scans recent rendered_owner_message_recorded
  // rows that lack feedback, runs the rendering verifier, and emits
  // owner_rendering_feedback_recorded with feedback_kind=auto_verifier|
  // auto_verifier_clean so the policy posterior moves on machine
  // evidence. Closes the 88ESCTN8XN6J gap ("flywheel persisted but
  // unconsumed by any always-on worker"). 5-min reactive cadence;
  // reactive_safety_net is the genuine deadline.
  const RENDERING_AUDIT_INTERVAL_MS = 5 * 60 * 1000;
  if (isWorkerEnabled("rendering_audit")) {
    const { renderingAuditWorkerTick } = await import("./rendering_audit_worker");
    let renderingAuditMarked = false;
    const renderingAuditTickHandle = supervisedTick(db, "rendering_audit", RENDERING_AUDIT_INTERVAL_MS, async () => {
      renderingAuditWorkerTick(db);
      if (!renderingAuditMarked) { markWorkerReady("rendering_audit"); renderingAuditMarked = true; }
    });
    registerReactiveWorker("rendering_audit", RENDERING_AUDIT_INTERVAL_MS, ["rendered_owner_message_recorded", "owner_rendering_feedback_recorded", "owner_observed_outcome_recorded"], renderingAuditTickHandle, { minReactiveGapMs: 60_000 });
    markWorkerReady("rendering_audit");
    renderingAuditMarked = true;
    recordWorkerTick("rendering_audit");
    // rendering_audit is activation-driven; activationDisposers are cleared on shutdown.
  }

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
      extractDirectiveInterference,
      extractOwnerProfilePromotions,
    } = await import("../substrate/extractors");
    const { runOwnerVocabularyExtractorTick } = await import("../substrate/owner_vocabulary_extractor");
    const { runOwnerAutonomyAdjusterTick } = await import("../substrate/owner_autonomy_adjuster");
    const runExtractorsOnce = async (): Promise<void> => {
      try { extractKnowledgePromotions(db); } catch (err) {
        logger.warn({ where: "daemon.extractors.knowledge", err: (err as Error).message }, "knowledge extractor tick failed");
      }
      try { extractActArtifactScores(db); } catch (err) {
        logger.warn({ where: "daemon.extractors.act_artifact", err: (err as Error).message }, "act artifact extractor tick failed");
      }
      try { extractRecipeCandidates(db); } catch (err) {
        logger.warn({ where: "daemon.extractors.recipes", err: (err as Error).message }, "recipe extractor tick failed");
      }
      try { extractSemanticDedup(db); } catch (err) {
        logger.warn({ where: "daemon.extractors.semantic_dedup", err: (err as Error).message }, "semantic-dedup extractor tick failed");
      }
      // Auto cross-directive interference (organism-alignment Track C,
      // 2026-05-15): scan act_artifact.target_resources/target_files for cross-directive
      // overlap and emit resource_conflict edges so the scheduler defers
      // racing dispatches. Idempotent — re-runs dedupe against existing
      // edges.
      try { extractDirectiveInterference(db); } catch (err) {
        logger.warn({ where: "daemon.extractors.directive_interference", err: (err as Error).message }, "directive-interference extractor tick failed");
      }
      // Owner profile promotions (Layer-2 conversation-as-learning-surface,
      // DSGSAZGMF1): owner_insight_candidate → owner_profile_recorded via
      // confidence ≥ 0.85 / owner-approval bypass / sibling cosine.
      try { extractOwnerProfilePromotions(db); } catch (err) {
        logger.warn({ where: "daemon.extractors.owner_profile", err: (err as Error).message }, "owner-profile extractor tick failed");
      }
      // Owner vocabulary mining (DSGSAZGMF1, universal): scan owner_input_received
      // history for the owner's distinctive n-grams + explicit rejection
      // patterns. Emits owner_insight_candidate rows for preferred_terms
      // and avoided_terms which the promotion pass above merges into the
      // canonical owner_profile_recorded row.
      try { runOwnerVocabularyExtractorTick(db); } catch (err) {
        logger.warn({ where: "daemon.extractors.owner_vocabulary", err: (err as Error).message }, "owner-vocabulary extractor tick failed");
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
    registerReactiveWorker("extractors", EXTRACTORS_INTERVAL_MS, ["knowledge_candidate", "act_artifact_candidate", "code_artifact_candidate", "action_scored", "task_committed", "lesson_extracted", "owner_insight_candidate", "owner_input_received", "owner_observed_outcome_recorded", "applied_change_committed", "applied_change_failed", "irreversible_effect_recorded"], extractorsTickHandle, { minReactiveGapMs: EXTRACTORS_INTERVAL_MS });
    // Round-2 audit (2026-05-15): run ONE extractor pass synchronously at
    // boot so candidates accumulated while the daemon was off don't have
    // to wait the full 5-min cadence before being promoted. Marks ready
    // AFTER the first pass completes so /ready reflects real liveness.
    void (async () => {
      try {
        await runExtractorsOnce();
      } finally {
        markWorkerReady("extractors");
        extractorsMarked = true;
        recordWorkerTick("extractors");
      }
    })();
    // extractors is activation-driven; activationDisposers are cleared on shutdown.
  }

  // auto_apply worker deleted (owner-approved 2026-05-16): the orchestrator
  // (Claude Code) reads brain proposals directly via MCP and decides inline
  // vs Agent subagent per the scored low_risk_inline lane. No autonomous
  // landing path; the operator-driven loop closes credit via cli/apply.ts.

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
      // Quiescence = no brain dispatch currently in-flight. Cheap SQL
      // probe: count brain_dispatched events that have no matching
      // brain_dispatch_closed after the same ts.
      const isQuiescent = (): boolean => {
        try {
          const row = db
            .query(
              `SELECT COUNT(*) AS c FROM events b
               WHERE b.kind = 'brain_dispatched'
                 AND NOT EXISTS (
                   SELECT 1 FROM events c
                   WHERE c.kind = 'brain_dispatch_closed'
                     AND c.task_id = b.task_id
                     AND c.ts >= b.ts
                 )`,
            )
            .get() as { c: number };
          return row.c === 0;
        } catch { return true; }
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
      const pendingEmbeddings = (db.query("SELECT COUNT(*) AS c FROM events WHERE embedding IS NULL").get() as { c: number }).c;
      await embedderWorkerTick(db, { batchSize: pendingEmbeddings > 500 ? 200 : pendingEmbeddings > 100 ? 100 : 20 });
      if (!embedderMarked) { markWorkerReady("embedder"); embedderMarked = true; }
    }, {
      // Embedder ticks legitimately take 15-35s during heavy backlog
      // drain (OpenAI roundtrip × adaptive batchSize 200). Only flag
      // overrun when the wedge is structural — ≥ 6× the interval. The
      // skip-fire still happens every tick (correct); we just stop
      // alarming the operator on normal drain work.
      overrunThresholdMs: embedderIntervalMs * 6,
    });
    registerReactiveWorker("embedder", embedderIntervalMs, ["*"], embedderTick, { minReactiveGapMs: embedderIntervalMs });
    // Run one tick synchronously at boot so /ready can flip without
    // waiting 10s.
    void (async () => {
      try {
        const pendingEmbeddings = (db.query("SELECT COUNT(*) AS c FROM events WHERE embedding IS NULL").get() as { c: number }).c;
        await embedderWorkerTick(db, { batchSize: pendingEmbeddings > 500 ? 200 : pendingEmbeddings > 100 ? 100 : 20 });
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
      if (!embedderMarked) { markWorkerReady("embedder"); embedderMarked = true; }
    })();
    // embedder is activation-driven; activationDisposers are cleared on shutdown.
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
            const fixtureInput = row.fixtureInput ?? null;
            const observation = row.runtime === "bun"
              ? await runBunArtifact({
                  artifactId: row.id,
                  body: row.body,
                  declaredSandbox: row.declaredSandbox as Extract<SandboxDecl, { runtime: "bun" }>,
                  inputs: fixtureInput,
                })
              : row.runtime === "uv"
                ? await runUvArtifact({
                    artifactId: row.id,
                    body: row.body,
                    declaredSandbox: row.declaredSandbox as Extract<SandboxDecl, { runtime: "uv" }>,
                    inputs: fixtureInput,
                  })
                : await runCamofoxArtifact({
                    artifactId: row.id,
                    body: row.body,
                    declaredSandbox: row.declaredSandbox as Extract<SandboxDecl, { runtime: "camofox-browser" }>,
                    inputs: fixtureInput,
                  });
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
      experienceCompressionWorkerTick(db);
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
      runLifecycleClosureSweep(db);
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
      runContractAmendmentConsumer(db, { maxRows: consumerBatchSize });
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
  } // end if (!skipWorkers)

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
    for (const dispose of workers) dispose();
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
          recovery_action: drain.completed ? "none" : "kill_remaining_live_opencode_then_boot_recovery_repick",
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
    // Drop any lingering SSE subscribers — the daemon owns the bus singleton
    // and a new daemon instance in the same process must start clean.
    resetBus();
    // Reset readiness slot so a same-process restart starts clean.
    resetReadiness();
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
  try {
    mcpServer = createMcpServer({ db, invoker: "claude_root", index, ingressState });
    await mcpServer.start({
      transportType: "httpStream",
      httpStream: { host, port },
    });
  } catch (err) {
    for (const dispose of workers) dispose();
    closeDb(stateDbPath);
    throw new Error(`failed to bind MCP port ${port}: ${(err as Error).message}`);
  }

  // 2. Bind the auxiliary HTTP server on auxPort. If this fails, tear down
  //    the MCP transport so we don't leak the primary port.
  try {
    auxServer = Bun.serve({
      port: auxPort,
      hostname: host,
      fetch: (req) => routeAux(req, db, ingressState, adminToken, stop, startedAtMs, stateDbPath, port, auxPort),
    });
  } catch (err) {
    for (const dispose of workers) dispose();
    try { await mcpServer?.stop(); } catch (stopErr) {
      logger.debug({ where: "daemon.boot.aux_bind_recovery", err: String(stopErr) }, "mcp stop during aux-bind failure");
    }
    closeDb(stateDbPath);
    throw new Error(`failed to bind aux port ${auxPort}: ${(err as Error).message}`);
  }

  } // end if (!skipPorts)

  writeLockFile(socketFile, {
    pid: process.pid,
    port: skipPorts ? -1 : port,
    aux_port: skipPorts ? -1 : auxPort,
    started_at_ms: startedAtMs,
    db_path: stateDbPath,
    role,
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
  // Per v2-design.md §5.1 the canonical embedding index is sqlite-vec
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
      hotreload: hotreloadState,
      activation_listener_count: activationListenerCount,
      pathology_budget_exhausted_recent_count: counts.pathology_exhausted,
      pathology_budget_debited_recent_count: counts.pathology_debited,
      brain_failed_recent_count: counts.brain_failed,
      health_window_iso: counts.window_iso,
      sql_pool_stats: poolStats,
      wal_stats: walStats,
      credentials,
      loaded_git_head: loadedGitHead,
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
  void (async () => {
    try {
      const handle = await startDaemon();
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
      logger.fatal({ err: (err as Error).message }, "acc2 daemon failed to start");
      process.stderr.write(`acc2 daemon failed to start: ${(err as Error).message}\n`);
      process.exit(1);
    }
  })();
}
