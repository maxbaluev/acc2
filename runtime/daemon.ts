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
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { closeDb, openDb } from "../substrate/db";
import { runViews } from "../substrate/views";
import { emitEvent } from "./events";
import { subscribe, resetBus, type BusEvent } from "./event_bus";
import { newAdminToken } from "./ids";
import { createMcpServer } from "./mcp_server";
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
import {
  isReady,
  pendingWorkers,
  registerWorker,
  markWorkerReady,
  setOnReady,
  resetReadiness,
  readyAt,
} from "./readiness";

export const DEFAULT_DAEMON_PORT = 9387;
export const DEFAULT_AUX_PORT_OFFSET = 1;
export const DEFAULT_SOCKET_DIR = join(homedir(), ".accint");
export const DEFAULT_SOCKET_FILE = join(DEFAULT_SOCKET_DIR, "v2.sock");
export const DEFAULT_TOKEN_FILE = join(DEFAULT_SOCKET_DIR, "v2.sock.token");
export const DEFAULT_STATE_DB = resolve(import.meta.dirname ?? ".", "..", "state", "accint.db");

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
  try { if (existsSync(path)) rmSync(path, { force: true }); } catch { /* swallow */ }
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
  const stateDbPath = opts.stateDbPath ?? DEFAULT_STATE_DB;
  const socketFile = opts.socketFile ?? DEFAULT_SOCKET_FILE;
  const tokenFile = opts.tokenFile ?? DEFAULT_TOKEN_FILE;
  const host = opts.host ?? "127.0.0.1";

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
    try { closeDb(stateDbPath); } catch { /* swallow */ }
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

  // Batch 3.OPS readiness: always-on workers must be registered up-front
  // so /ready can refuse traffic until each has completed its first tick.
  registerWorker("amendment");
  registerWorker("metrics_gauge_refresh");
  if (process.env.ACC2_INTEGRITY_AUTOSTART !== "0") registerWorker("integrity");
  if (process.env.ACC2_EMBEDDER_AUTOSTART === "1") registerWorker("embedder");
  if (process.env.ACC2_REHAB_AUTOSTART === "1") registerWorker("rehabilitation");
  if (process.env.ACC2_ROLLING_AUTOSTART === "1") registerWorker("rolling_reviewer");
  if (process.env.ACC2_FATHER_AUTOSTART === "1") registerWorker("father");
  if (process.env.ACC2_AUTOSCHEDULER === "1") registerWorker("scheduler");

  // Phase E: amendment worker — drain unapplied directive_amended events on
  // a configurable interval (default 2s; tests may pin a shorter value via
  // ACC2_AMENDMENT_TICK_MS). Errors are swallowed so a malformed amendment
  // can't kill the daemon (each surfaces its own diagnostic events anyway).
  let amendmentMarked = false;
  const amendmentTickMs = Number(process.env.ACC2_AMENDMENT_TICK_MS ?? 2000);
  const amendmentTick = setInterval(() => {
    void (async () => {
      try {
        const unapplied = findUnappliedAmendments(db);
        for (const id of unapplied) {
          try { await applyAmendment(db, id); } catch { /* swallow per-amendment */ }
        }
      } catch { /* swallow */ }
      if (!amendmentMarked) { markWorkerReady("amendment"); amendmentMarked = true; }
    })();
  }, amendmentTickMs);
  // Fire one synchronous mark right away so amendment readiness does
  // not block /ready for 2s on a quiet daemon.
  markWorkerReady("amendment");
  amendmentMarked = true;
  workers.push(() => clearInterval(amendmentTick));

  // Batch 3.OPS: gauge refresh (every 30s) keeps the SQLite-backed gauges
  // (substrate_events_total, code_artifacts_*) live for /metrics scrapes.
  const gaugeTick = setInterval(() => { refreshGauges(db, startedAtMs); }, 30_000);
  refreshGauges(db, startedAtMs); // initial snapshot
  markWorkerReady("metrics_gauge_refresh");
  workers.push(() => clearInterval(gaugeTick));

  // Batch 3.OPS: DB integrity worker. Default ON unless explicitly
  // disabled (ACC2_INTEGRITY_AUTOSTART=0 for tests). Tick interval is
  // 6h by default; configurable via ACC2_INTEGRITY_INTERVAL_MS.
  if (process.env.ACC2_INTEGRITY_AUTOSTART !== "0") {
    const integrityIntervalMs = Number(
      process.env.ACC2_INTEGRITY_INTERVAL_MS ?? 6 * 60 * 60 * 1000,
    );
    let integrityMarked = false;
    const integrityTick = setInterval(() => {
      void (async () => {
        try { await integrityWorkerTick(db); } catch (err) {
          logger.warn({ err: (err as Error).message }, "integrity worker tick failed");
        }
        if (!integrityMarked) { markWorkerReady("integrity"); integrityMarked = true; }
      })();
    }, integrityIntervalMs);
    // Mark ready immediately — the boot-time runIntegrityCheck already
    // proved the substrate is healthy. The interval tick repeats every
    // 6h thereafter.
    markWorkerReady("integrity");
    integrityMarked = true;
    workers.push(() => clearInterval(integrityTick));
  }

  // Phase F: optional embedder worker. Default off — tests must not hit
  // the OpenAI API. Enable with ACC2_EMBEDDER_AUTOSTART=1 in production.
  // Tick every 10s with batch=20; errors swallowed so a single bad row
  // can't kill the daemon.
  if (process.env.ACC2_EMBEDDER_AUTOSTART === "1") {
    let embedderMarked = false;
    const embedderTick = setInterval(() => {
      void (async () => {
        try { await embedderWorkerTick(db, { batchSize: 20 }); } catch { /* swallow */ }
        if (!embedderMarked) { markWorkerReady("embedder"); embedderMarked = true; }
      })();
    }, 10_000);
    // Run one tick synchronously at boot so /ready can flip without
    // waiting 10s.
    void (async () => {
      try { await embedderWorkerTick(db, { batchSize: 20 }); } catch { /* swallow */ }
      if (!embedderMarked) { markWorkerReady("embedder"); embedderMarked = true; }
    })();
    workers.push(() => clearInterval(embedderTick));
  }

  // Phase H: optional rehabilitation worker. Default off — tests must not
  // run controlled fixture invocations as a side effect. Enable with
  // ACC2_REHAB_AUTOSTART=1. Tick interval defaults to 30 minutes
  // (ACC2_REHAB_TICK_MS, 1_800_000ms); the 14-day cooldown still gates each
  // candidate so checking more often only matters when many artifacts crossed
  // the cooldown simultaneously. Worker respects the canonical deadline
  // pattern: a `runningTick` boolean swallows overlapping ticks so a slow
  // fixture cannot stack worker invocations.
  if (process.env.ACC2_REHAB_AUTOSTART === "1") {
    const rehabTickMs = Number(process.env.ACC2_REHAB_TICK_MS ?? 30 * 60 * 1000);
    // Rehab readiness flips on registration; we do NOT run a synchronous
    // initial tick because rehab can spawn subprocess fixtures.
    markWorkerReady("rehabilitation");
    let rehabRunning = false;
    const rehabTick = setInterval(() => {
      if (rehabRunning) return; // deadline pattern: skip overlapping ticks
      rehabRunning = true;
      void (async () => {
        try {
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
            (event) => { try { emitEvent(db, event); } catch { /* swallow */ } },
          );
        } catch { /* swallow */ }
        finally { rehabRunning = false; }
      })();
    }, rehabTickMs);
    workers.push(() => clearInterval(rehabTick));
  }

  // Phase I: optional rolling-review worker. Default off — tests don't want
  // rolling reviews firing automatically. Enable with
  // ACC2_ROLLING_AUTOSTART=1. Tick every 60s; errors swallowed so a single
  // malformed directive can't kill the daemon. Father (Phase K) will turn
  // this on in production.
  if (process.env.ACC2_ROLLING_AUTOSTART === "1") {
    let rollingMarked = false;
    const rollingTick = setInterval(() => {
      void (async () => {
        try { await rollingReviewerWorkerTick(db); } catch { /* swallow */ }
        if (!rollingMarked) { markWorkerReady("rolling_reviewer"); rollingMarked = true; }
      })();
    }, 60_000);
    void (async () => {
      try { await rollingReviewerWorkerTick(db); } catch { /* swallow */ }
      if (!rollingMarked) { markWorkerReady("rolling_reviewer"); rollingMarked = true; }
    })();
    workers.push(() => clearInterval(rollingTick));
  }

  // Phase K: optional Father worker. Default off — tests don't want Father
  // firing automatically. Enable with ACC2_FATHER_AUTOSTART=1. Per §14
  // Father's cadence is 5 min normal; tests can pass a smaller interval
  // explicitly. When Father is enabled it ALSO processes rolling reviews on
  // its own tick (simplification: one autostart flag for the whole
  // orchestration — owner-controlled, per task brief K.4). Father has zero
  // LLM-call capability; it only opens directives compiled from templates
  // and records its cycle.
  if (process.env.ACC2_FATHER_AUTOSTART === "1") {
    const fatherIntervalMs = Number(process.env.ACC2_FATHER_INTERVAL_MS ?? 5 * 60 * 1000);
    let fatherMarked = false;
    const fatherTick = setInterval(() => {
      void (async () => {
        try {
          // Drive rolling reviews here so Father owns the whole long-horizon
          // orchestration when enabled (§K.4).
          await rollingReviewerWorkerTick(db);
        } catch { /* swallow */ }
        try { await fatherIterate(db); } catch { /* swallow */ }
        if (!fatherMarked) { markWorkerReady("father"); fatherMarked = true; }
      })();
    }, fatherIntervalMs);
    // Father is registered as ready immediately — its 5-min cadence is
    // too long to gate /ready behind.
    markWorkerReady("father");
    fatherMarked = true;
    workers.push(() => clearInterval(fatherTick));
  }

  // Phase E: optional autoscheduler. Default off — tests don't want the
  // scheduler firing dispatches. Enable with ACC2_AUTOSCHEDULER=1.
  let schedulerAbort: AbortController | null = null;
  if (process.env.ACC2_AUTOSCHEDULER === "1") {
    schedulerAbort = new AbortController();
    markWorkerReady("scheduler");
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
          });
          await new Promise((r) => setTimeout(r, 2000));
        }
      } catch { /* swallow */ }
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
    for (const dispose of workers) dispose();
    try {
      emitEvent(db, {
        kind: "daemon_shutdown",
        substrate_origin: "substrate_auto",
        payload: { pid: process.pid, uptime_ms: Date.now() - startedAtMs },
      });
    } catch { /* db may already be closed */ }
    try { auxServer?.stop(true); } catch { /* swallow */ }
    try { if (mcpServer) await mcpServer.stop(); } catch { /* swallow */ }
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
    } catch { /* swallow — emission failure should not crash boot */ }
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
    try { await mcpServer.stop(); } catch { /* swallow */ }
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
    return Response.json({
      status: "ok",
      pid: process.pid,
      uptime_ms: Date.now() - startedAtMs,
      db_path: stateDbPath,
      events_count: countEvents(db),
      mcp_port: mcpPort,
      aux_port: auxPort,
      mcp_transport: "fastmcp:httpStream",
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
