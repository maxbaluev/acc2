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
import { closeDb, openDb } from "../substrate/db";
import { runViews } from "../substrate/views";
import { emitEvent } from "./events";
import { subscribe, resetBus, type BusEvent } from "./event_bus";
import { newAdminToken } from "./ids";
import { createMcpServer } from "./mcp_server";
import {
  migrateLegacyLayout,
  resolveDbPath, resolveSocketFile, resolveStateDir, resolveTokenFile,
} from "./state_paths";
import { createExternalIngressState, handleExternalPush, type ExternalIngressState } from "./external_ingress";
import type { FastMCP } from "fastmcp";
import { applyAmendment, findUnappliedAmendments } from "./amendment_handler";
import { schedulerLoop } from "./task_scheduler";
import { rollingReviewerWorkerTick } from "./rolling_reviewer";
import { fatherIterate } from "./father";
import { EmbeddingIndex } from "./embedding_index";
import { embedderWorkerTick } from "./embedder";
import { rehabilitationWorkerTick, getArtifact } from "./artifact_store";
import { runBunArtifact } from "./runtimes/bun";
import { runUvArtifact } from "./runtimes/uv";
import { runCamofoxArtifact } from "./runtimes/camofox";
import type { SandboxDecl } from "../substrate/types";
import { logger } from "./logger";
import { metricsHandler, refreshGauges } from "./metrics";
import { integrityWorkerTick, runIntegrityCheck, reconcileOrphanedDispatches } from "./integrity_worker";
import { isWorkerEnabled } from "./worker_autostart";
import {
  isReady,
  pendingWorkers,
  registerWorker,
  markWorkerReady,
  setOnReady,
  resetReadiness,
  readyAt,
  recordWorkerTick,
  stuckWorkers,
} from "./readiness";

export const DEFAULT_DAEMON_PORT = 9387;
export const DEFAULT_AUX_PORT_OFFSET = 1;

/** Default socket/token/db paths are computed on demand from the shared
 *  resolver. The exported constants below preserve the legacy module API
 *  but evaluate at first import — DO NOT cache them anywhere downstream;
 *  the daemon itself always re-reads via the resolvers below. */
export const DEFAULT_SOCKET_FILE = resolveSocketFile();
export const DEFAULT_TOKEN_FILE = resolveTokenFile();
export const DEFAULT_STATE_DB = resolveDbPath();

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
  stop: () => Promise<void>;
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
): (() => void) => {
  let running = false;
  let runningSinceMs = 0;
  return () => {
    const now = Date.now();
    if (running) {
      const observedMs = now - runningSinceMs;
      logger.warn(
        { worker: workerName, expected_ms: intervalMs, observed_ms: observedMs },
        "worker tick overrun — previous tick still running, skipping this fire",
      );
      try {
        emitEvent(db, {
          kind: "worker_tick_overrun",
          substrate_origin: "substrate_auto",
          payload: {
            worker: workerName,
            expected_ms: intervalMs,
            observed_ms: observedMs,
          },
        });
      } catch (err) {
        logger.debug(
          { where: "supervisedTick.emit_overrun", err: String(err) },
          "could not emit worker_tick_overrun (db likely closed)",
        );
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

const countEvents = (db: Database): number => {
  const row = db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number } | null;
  return row?.n ?? 0;
};

const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/** Start the daemon. Throws if the socket file already exists AND its pid is
 *  alive (second-instance guard). On boot emits daemon_started +
 *  daemon_index_rebuilt; on graceful stop emits daemon_shutdown. */
export const startDaemon = async (opts: DaemonOpts = {}): Promise<DaemonHandle> => {
  const port = opts.port ?? Number(process.env.V2_DAEMON_PORT ?? DEFAULT_DAEMON_PORT);
  const auxPort = opts.auxPort ?? Number(process.env.V2_DAEMON_AUX_PORT ?? port + DEFAULT_AUX_PORT_OFFSET);
  // Resolve paths LAZILY through the shared resolver so an env var set
  // between module-load and startDaemon (common in tests that pin paths
  // per-case) is honoured. Constants above are cached at module-load only.
  const stateDbPath = opts.stateDbPath ?? resolveDbPath();
  const socketFile = opts.socketFile ?? resolveSocketFile();
  const tokenFile = opts.tokenFile ?? resolveTokenFile();
  const host = opts.host ?? "127.0.0.1";

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

  // Layout migration runs BEFORE the daemon touches the socket / token /
  // db files so a legacy `${stateDir}/state/<file>` install is pulled
  // forward in one boot. We pass `null` for the DB handle here because
  // the DB has not been opened yet; once openDb succeeds below we
  // re-fire the helper with the live handle so the audit event lands.
  // When the caller passes explicit overrides (tests pin a tmp dir),
  // we skip the migration entirely — the override paths are scoped to
  // the test's tmp dir, not the operator's real state dir.
  if (opts.stateDbPath === undefined && opts.socketFile === undefined && opts.tokenFile === undefined) {
    migrateLegacyLayout(resolveStateDir(), null);
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

  // Background workers — for B3 just a heartbeat tick (no-op closure, but
  // proves the supervisor loop is structurally present and stoppable).
  const workers: Array<() => void> = [];
  const heartbeat = setInterval(() => { /* phase F: embedder catch-up, posterior updater, … */ }, 5000);
  workers.push(() => clearInterval(heartbeat));

  // Worker tick intervals — declared here so /health can compute the
  // "stuck after 3× interval" threshold without reading env vars twice.
  const amendmentTickMs = Number(process.env.ACC2_AMENDMENT_TICK_MS ?? 2000);
  const gaugeTickMs = 30_000;
  const integrityIntervalMs = Number(
    process.env.ACC2_INTEGRITY_INTERVAL_MS ?? 6 * 60 * 60 * 1000,
  );
  const embedderIntervalMs = 10_000;
  const rehabIntervalMs = 6 * 60 * 60 * 1000;
  const rollingIntervalMs = 60_000;
  const fatherIntervalMs = Number(process.env.ACC2_FATHER_INTERVAL_MS ?? 5 * 60 * 1000);

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
  registerWorker("amendment", amendmentTickMs);
  registerWorker("metrics_gauge_refresh", gaugeTickMs);
  if (isWorkerEnabled("integrity")) registerWorker("integrity", integrityIntervalMs);
  if (isWorkerEnabled("embedder")) registerWorker("embedder", embedderIntervalMs);
  if (isWorkerEnabled("rehabilitation")) registerWorker("rehabilitation", rehabIntervalMs);
  if (isWorkerEnabled("rolling_reviewer")) registerWorker("rolling_reviewer", rollingIntervalMs);
  if (isWorkerEnabled("father")) registerWorker("father", fatherIntervalMs);
  if (isWorkerEnabled("scheduler")) registerWorker("scheduler");
  if (isWorkerEnabled("supervisor")) registerWorker("supervisor", Number(process.env.ACC2_SUPERVISOR_INTERVAL_MS ?? 30_000));
  if (isWorkerEnabled("compaction")) registerWorker("compaction", Number(process.env.ACC2_COMPACTION_INTERVAL_MS ?? 60 * 60 * 1000));
  // Brain audit B (2026-05-15): register the Model-D extractors worker
  // so candidate→promoted advancement happens on a bounded cadence,
  // not by chance dispatch through Father.
  if (isWorkerEnabled("extractors")) registerWorker("extractors", Number(process.env.ACC2_EXTRACTORS_INTERVAL_MS ?? 5 * 60 * 1000));

  // Phase E: amendment worker — drain unapplied directive_amended events on
  // a configurable interval (default 2s; tests may pin a shorter value via
  // ACC2_AMENDMENT_TICK_MS). Errors are surfaced as error_caught events
  // (one per amendment) so a malformed amendment can't kill the daemon AND
  // never vanishes silently.
  let amendmentMarked = false;
  const amendmentTick = setInterval(
    supervisedTick(db, "amendment", amendmentTickMs, async () => {
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
    }),
    amendmentTickMs,
  );
  // Fire one synchronous mark right away so amendment readiness does
  // not block /ready for 2s on a quiet daemon.
  markWorkerReady("amendment");
  amendmentMarked = true;
  recordWorkerTick("amendment");
  workers.push(() => clearInterval(amendmentTick));

  // Batch 3.OPS: gauge refresh (every 30s) keeps the SQLite-backed gauges
  // (substrate_events_total, code_artifacts_*) live for /metrics scrapes.
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
  // disabled (`ACC2_DISABLE_WORKERS=integrity` for tests). Tick interval
  // is 6h by default; configurable via ACC2_INTEGRITY_INTERVAL_MS.
  if (isWorkerEnabled("integrity")) {
    let integrityMarked = false;
    const integrityTick = setInterval(
      supervisedTick(db, "integrity", integrityIntervalMs, async () => {
        await integrityWorkerTick(db);
        if (!integrityMarked) { markWorkerReady("integrity"); integrityMarked = true; }
      }),
      integrityIntervalMs,
    );
    // Mark ready immediately — the boot-time runIntegrityCheck already
    // proved the substrate is healthy. The interval tick repeats every
    // 6h thereafter.
    markWorkerReady("integrity");
    integrityMarked = true;
    recordWorkerTick("integrity");
    workers.push(() => clearInterval(integrityTick));
  }

  // Batch 8.B: supervisor worker — runs the three stuck/loop detectors
  // (redispatch storm / DAG explosion / bridge health) on a tight 30s
  // interval. Default ON unless ACC2_DISABLE_WORKERS=supervisor.
  // Decoupled from the integrity worker (whose default tick is 6h, far
  // too slow to catch tight loops live).
  const SUPERVISOR_INTERVAL_MS = Number(process.env.ACC2_SUPERVISOR_INTERVAL_MS ?? 30_000);
  if (isWorkerEnabled("supervisor")) {
    const { supervisorTick } = await import("./supervisor");
    let supervisorMarked = false;
    const supervisorTickHandle = setInterval(
      supervisedTick(db, "supervisor", SUPERVISOR_INTERVAL_MS, async () => {
        supervisorTick(db);
        if (!supervisorMarked) { markWorkerReady("supervisor"); supervisorMarked = true; }
      }),
      SUPERVISOR_INTERVAL_MS,
    );
    markWorkerReady("supervisor");
    supervisorMarked = true;
    recordWorkerTick("supervisor");
    workers.push(() => clearInterval(supervisorTickHandle));
  }

  // Batch 10: substrate compactor — periodic pruning of bridge_frame_received
  // rows older than COMPACTION_FRAME_RETENTION_MS (24h default). The
  // canonical events (brain_dispatched, action_predicted, action_scored,
  // task_committed) STAY forever; only the per-frame mirror is pruned.
  // Runs hourly so steady-state growth never exceeds one day of frames.
  const COMPACTION_INTERVAL_MS = Number(process.env.ACC2_COMPACTION_INTERVAL_MS ?? 60 * 60 * 1000);
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
  // open knowledge_candidate and code_artifact rows that have crossed
  // the promotion thresholds. Pre-fix the only way these advanced was
  // chance dispatch through Father; substrate counts showed 0/53
  // code_artifact_promoted and 0/70 recipe_promoted. Running on a
  // bounded 5-min cadence makes promotion a substrate liveness function.
  const EXTRACTORS_INTERVAL_MS = Number(process.env.ACC2_EXTRACTORS_INTERVAL_MS ?? 5 * 60 * 1000);
  if (isWorkerEnabled("extractors")) {
    // Brain convergence axis F (2026-05-15): the extractors worker now
    // also runs extractRecipeCandidates and extractSemanticDedup so
    // recipe extraction is a substrate liveness function on the same
    // 5-min cadence; pre-fix Father's recipe_extraction_pass template
    // was the only path, leaving long gaps when Father was busy on
    // other objectives.
    const {
      extractKnowledgePromotions,
      extractCodeArtifactScores,
      extractRecipeCandidates,
      extractSemanticDedup,
      extractDirectiveInterference,
      extractOwnerProfilePromotions,
    } = await import("../substrate/extractors");
    const { runOwnerVocabularyExtractorTick } = await import("../substrate/owner_vocabulary_extractor");
    const runExtractorsOnce = async (): Promise<void> => {
      try { extractKnowledgePromotions(db); } catch (err) {
        logger.warn({ where: "daemon.extractors.knowledge", err: (err as Error).message }, "knowledge extractor tick failed");
      }
      try { extractCodeArtifactScores(db); } catch (err) {
        logger.warn({ where: "daemon.extractors.code_artifact", err: (err as Error).message }, "code artifact extractor tick failed");
      }
      try { extractRecipeCandidates(db); } catch (err) {
        logger.warn({ where: "daemon.extractors.recipes", err: (err as Error).message }, "recipe extractor tick failed");
      }
      try { extractSemanticDedup(db); } catch (err) {
        logger.warn({ where: "daemon.extractors.semantic_dedup", err: (err as Error).message }, "semantic-dedup extractor tick failed");
      }
      // Auto cross-directive interference (organism-alignment Track C,
      // 2026-05-15): scan code_artifact.target_resources/target_files for cross-directive
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
    };
    let extractorsMarked = false;
    const extractorsTickHandle = setInterval(
      supervisedTick(db, "extractors", EXTRACTORS_INTERVAL_MS, async () => {
        await runExtractorsOnce();
        if (!extractorsMarked) { markWorkerReady("extractors"); extractorsMarked = true; }
      }),
      EXTRACTORS_INTERVAL_MS,
    );
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
    workers.push(() => clearInterval(extractorsTickHandle));
  }

  // Auto-apply worker (brain proposal DGT1MKXY, 2026-05-15): scans
  // lesson_implementer_queue_view for auto_apply_eligible rows and emits
  // auto_apply_signaled events. Stage-1 only emits signals (orchestrator
  // picks up the work); stage-2 (future) will do the mechanical apply.
  // 60s tick is conservative — apply-eligible rows accumulate slowly.
  const AUTO_APPLY_INTERVAL_MS = Number(process.env.ACC2_AUTO_APPLY_INTERVAL_MS ?? 60 * 1000);
  if (isWorkerEnabled("auto_apply")) {
    const { runAutoApplyWorkerTick } = await import("./auto_apply_worker");
    let autoApplyMarked = false;
    const autoApplyTickHandle = setInterval(
      supervisedTick(db, "auto_apply", AUTO_APPLY_INTERVAL_MS, async () => {
        runAutoApplyWorkerTick(db);
        if (!autoApplyMarked) { markWorkerReady("auto_apply"); autoApplyMarked = true; }
      }),
      AUTO_APPLY_INTERVAL_MS,
    );
    markWorkerReady("auto_apply");
    autoApplyMarked = true;
    recordWorkerTick("auto_apply");
    workers.push(() => clearInterval(autoApplyTickHandle));
  }

  // Brain audit bqlr29psq (2026-05-15): daemon source hot-reload worker.
  // Watches runtime/, substrate/, cli/ via fs.watch (recursive). When a
  // change matches HOTRELOAD_MANIFEST, emits daemon_hotreload_triggered
  // and applies the declared strategy (in_process / quiescent_only /
  // full_restart). The daemon stays alive on syntax errors — the
  // previous module reference is never overwritten.
  //
  // Opt-out: set ACC2_DISABLE_HOTRELOAD=1.
  if (process.env.ACC2_DISABLE_HOTRELOAD !== "1") {
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
    const embedderTick = setInterval(
      supervisedTick(db, "embedder", embedderIntervalMs, async () => {
        await embedderWorkerTick(db, { batchSize: 20 });
        if (!embedderMarked) { markWorkerReady("embedder"); embedderMarked = true; }
      }),
      embedderIntervalMs,
    );
    // Run one tick synchronously at boot so /ready can flip without
    // waiting 10s.
    void (async () => {
      try {
        await embedderWorkerTick(db, { batchSize: 20 });
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
    workers.push(() => clearInterval(embedderTick));
  }

  // Phase H: rehabilitation worker. Default ON — production wants
  // quarantined artifacts to get a recovery chance on the canonical
  // cadence. Opt-OUT via `ACC2_DISABLE_WORKERS=rehabilitation`
  // (tests/preload.ts pins the full set so unit tests don't spawn
  // fixture subprocesses). Tick interval defaults to 30 minutes
  // (ACC2_REHAB_TICK_MS, 1_800_000ms); the 14-day cooldown still gates
  // each candidate so checking more often only matters when many
  // artifacts crossed the cooldown simultaneously. Worker respects the
  // canonical deadline pattern: a `runningTick` boolean swallows
  // overlapping ticks so a slow fixture cannot stack worker invocations.
  if (isWorkerEnabled("rehabilitation")) {
    const rehabTickMs = Number(process.env.ACC2_REHAB_TICK_MS ?? 30 * 60 * 1000);
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

  // Phase I: rolling-review worker. Default ON — production wants
  // rolling-active directives to receive cadence-driven re-opens.
  // Opt-OUT via `ACC2_DISABLE_WORKERS=rolling_reviewer`
  // (tests/preload.ts pins the full set). Tick every 60s; errors
  // swallowed so a single malformed directive can't kill the daemon.
  // Father (Phase K) drives the same loop on its own tick when both
  // are on.
  if (isWorkerEnabled("rolling_reviewer")) {
    let rollingMarked = false;
    const rollingTick = setInterval(
      supervisedTick(db, "rolling_reviewer", rollingIntervalMs, async () => {
        await rollingReviewerWorkerTick(db);
        if (!rollingMarked) { markWorkerReady("rolling_reviewer"); rollingMarked = true; }
      }),
      rollingIntervalMs,
    );
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
    workers.push(() => clearInterval(rollingTick));
  }

  // Phase K: Father worker. Default ON — production wants the
  // long-horizon orchestrator driving objective re-ranking and rolling
  // reviews on the canonical 5-min cadence (§14). Opt-OUT via
  // `ACC2_DISABLE_WORKERS=father` (tests/preload.ts pins the full set).
  // Tests that want Father deterministically can also pin
  // ACC2_FATHER_INTERVAL_MS to a smaller value. When Father is enabled
  // it ALSO processes rolling reviews on its own tick (simplification:
  // one autostart flag for the whole orchestration — owner-controlled,
  // per task brief K.4). Father has zero LLM-call capability; it only
  // opens directives compiled from templates and records its cycle.
  if (isWorkerEnabled("father")) {
    let fatherMarked = false;
    const fatherTick = setInterval(
      supervisedTick(db, "father", fatherIntervalMs, async () => {
        // Drive rolling reviews here so Father owns the whole long-horizon
        // orchestration when enabled (§K.4). Failures in EITHER step are
        // surfaced individually as error_caught — neither aborts the tick.
        try {
          await rollingReviewerWorkerTick(db);
        } catch (err) {
          logger.warn(
            { err: (err as Error).message },
            "father.rollingReview failed — surfaced as error_caught",
          );
          try {
            emitEvent(db, {
              kind: "error_caught",
              substrate_origin: "substrate_auto",
              payload: {
                where: "daemon.father.rolling_reviewer_step",
                recoverable: true,
                message: (err as Error).message,
              },
            });
          } catch (emitErr) {
            logger.debug({ err: String(emitErr) }, "could not emit error_caught (db closed)");
          }
        }
        try {
          await fatherIterate(db);
        } catch (err) {
          logger.warn(
            { err: (err as Error).message },
            "father.iterate failed — surfaced as error_caught",
          );
          try {
            emitEvent(db, {
              kind: "error_caught",
              substrate_origin: "substrate_auto",
              payload: {
                where: "daemon.father.iterate_step",
                recoverable: true,
                message: (err as Error).message,
              },
            });
          } catch (emitErr) {
            logger.debug({ err: String(emitErr) }, "could not emit error_caught (db closed)");
          }
        }
        if (!fatherMarked) { markWorkerReady("father"); fatherMarked = true; }
      }),
      fatherIntervalMs,
    );
    // Father is registered as ready immediately — its 5-min cadence is
    // too long to gate /ready behind.
    markWorkerReady("father");
    fatherMarked = true;
    recordWorkerTick("father");
    workers.push(() => clearInterval(fatherTick));
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

  // Declare `stop` BEFORE Bun.serve so the fetch closure can capture it; the
  // handles are filled in after binding succeeds.
  let auxServer: Server | null = null;
  let mcpServer: FastMCP | null = null;
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    // Kill any live opencode subprocesses BEFORE tearing down workers so
    // brain dispatches cannot survive past daemon shutdown as orphans-to-init
    // (the live evidence pattern that produced stale-MCP-URL handshake
    // failures on the next daemon boot). SIGTERM first, SIGKILL at +1.5s.
    try {
      const { killAllLiveOpencodeProcs } = await import("./bridge/opencode");
      const killed = killAllLiveOpencodeProcs();
      if (killed > 0) logger.info({ killed_opencode_procs: killed }, "daemon shutdown — terminated live brain subprocesses");
    } catch (err) {
      logger.debug({ where: "daemon.stop.kill_opencode_procs", err: String(err) }, "killAllLiveOpencodeProcs import/call failed (best-effort)");
    }
    for (const dispose of workers) dispose();
    try {
      emitEvent(db, {
        kind: "daemon_shutdown",
        substrate_origin: "substrate_auto",
        payload: { pid: process.pid, uptime_ms: Date.now() - startedAtMs },
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

  // 1. Bind the FastMCP HTTP-streaming transport on the primary port.
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
    try { await mcpServer.stop(); } catch (stopErr) {
      logger.debug({ where: "daemon.boot.aux_bind_recovery", err: String(stopErr) }, "mcp stop during aux-bind failure");
    }
    closeDb(stateDbPath);
    throw new Error(`failed to bind aux port ${auxPort}: ${(err as Error).message}`);
  }

  writeLockFile(socketFile, {
    pid: process.pid,
    port,
    aux_port: auxPort,
    started_at_ms: startedAtMs,
    db_path: stateDbPath,
  });
  writeLockFile(tokenFile, { admin_token: adminToken });

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
  // Layout-migration audit. We fire the helper with the live DB so the
  // ledger carries the canonical `cli_layout_migrated` audit row when a
  // rename happened. The helper is a no-op when the trigger condition is
  // absent.
  if (opts.stateDbPath === undefined && opts.socketFile === undefined && opts.tokenFile === undefined) {
    // Re-fire migrateLegacyLayout with the live DB so a migration that
    // happened above now lands the `cli_layout_migrated` event in the
    // ledger. Idempotent: if no legacy files remain, returns immediately.
    migrateLegacyLayout(resolveStateDir(), db);
  }
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
 *  caller's perspective. Tests use this. */
export const stopDaemon = async (handle: DaemonHandle): Promise<void> => {
  await handle.stop();
};

// ── Auxiliary HTTP routing (non-MCP) ───────────────────────────────

const routeAux = async (
  req: Request,
  db: Database,
  ingressState: ExternalIngressState,
  adminToken: string,
  stop: () => Promise<void>,
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
    const recentCutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const recent = (kinds: string[]): number => {
      try {
        const placeholders = kinds.map(() => "?").join(",");
        const row = db
          .query(
            `SELECT COUNT(*) AS c FROM events WHERE kind IN (${placeholders}) AND ts >= ?`,
          )
          .get(...kinds, recentCutoff) as { c: number };
        return row.c;
      } catch { return 0; }
    };
    const pathologyExhaustedRecent = recent(["pathology_budget_exhausted"]);
    const pathologyDebitedRecent = recent(["pathology_budget_debited"]);
    const brainFailedRecent = recent(["bridge_failed", "dispatcher_violation"]);
    return Response.json({
      status: stuck.length === 0 ? "ok" : "degraded",
      pid: process.pid,
      uptime_ms: Date.now() - startedAtMs,
      db_path: stateDbPath,
      events_count: countEvents(db),
      mcp_port: mcpPort,
      aux_port: auxPort,
      mcp_transport: "fastmcp:httpStream",
      stuck_workers: stuck,
      hotreload: hotreloadState,
      activation_listener_count: activationListenerCount,
      pathology_budget_exhausted_recent_count: pathologyExhaustedRecent,
      pathology_budget_debited_recent_count: pathologyDebitedRecent,
      brain_failed_recent_count: brainFailedRecent,
      health_window_iso: recentCutoff,
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
    setTimeout(() => { void stop(); }, 50);
    return Response.json({ ok: true, status: "shutting_down" });
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
          const frame =
            `data: ${JSON.stringify({
              event_id: event.event_id,
              kind: event.kind,
              ts: event.ts,
              directive_id: event.directive_id,
              task_id: event.task_id,
              substrate_origin: event.substrate_origin,
              payload: event.payload,
            })}\n\n`;
          controller.enqueue(encoder.encode(frame));
        } catch {
          // Best effort — if the controller is closed the bus will catch
          // the throw on the NEXT publish and drop us.
          try { unsubscribe(); } catch { /* swallow */ }
        }
      };
      const unsubscribe = subscribe(subscriber);
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
