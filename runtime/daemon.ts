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
import { newAdminToken } from "./ids";
import { createMcpServer } from "./mcp_server";
import { createExternalIngressState, handleExternalPush, type ExternalIngressState } from "./external_ingress";
import type { FastMCP } from "fastmcp";

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
    closeDb(stateDbPath);
    tryRemove(socketFile);
    tryRemove(tokenFile);
  };

  // 1. Bind the FastMCP HTTP-streaming transport on the primary port.
  try {
    mcpServer = createMcpServer({ db, invoker: "claude_root" });
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
  emitEvent(db, {
    kind: "daemon_index_rebuilt",
    substrate_origin: "substrate_auto",
    payload: { mode: "stub", note: "phase_f_real_hnsw_rebuild_pending" },
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

  return Response.json({ ok: false, error: `unknown_route:${url.pathname}` }, { status: 404 });
};

// ── Entrypoint when invoked directly (`bun runtime/daemon.ts`) ─────

if (import.meta.main) {
  void (async () => {
    try {
      const handle = await startDaemon();
      console.log(
        `acc2 daemon: pid=${process.pid} mcp=http://127.0.0.1:${handle.port} ` +
          `aux=http://127.0.0.1:${handle.auxPort} db=${handle.stateDbPath}`,
      );
    } catch (err) {
      console.error(`acc2 daemon failed to start: ${(err as Error).message}`);
      process.exit(1);
    }
  })();
}
