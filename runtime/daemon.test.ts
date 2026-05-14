// acc2 daemon test — single-instance lock, /health, /shutdown, lifecycle
// events. The daemon now binds TWO ports:
//   - primary (mcpPort)   — fastmcp httpStream transport (MCP-only)
//   - auxiliary (auxPort) — Bun.serve for /external/push, /health, /shutdown
// All HTTP tests in this file hit the auxiliary port. The MCP wire is exercised
// in mcp_server.test.ts via the stdio transport.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../substrate/db";
import { startDaemon, stopDaemon, type DaemonHandle } from "./daemon";

// Tight daemon-only band, disjoint from sibling test files.
// mcp ∈ [30000, 31000), aux ∈ [31000, 32000) — keeps both inside 16-bit range
// and away from external_ingress.test.ts ([8000, 11000)) and
// cli/dispatch.test.ts ([12000, 18000)).
const pickPort = () => 30000 + Math.floor(Math.random() * 1000);
const pickPortPair = () => {
  const mcp = pickPort();
  const aux = 31000 + Math.floor(Math.random() * 1000);
  return { mcp, aux };
};

const mkTmp = (): { dir: string; dbPath: string; socketFile: string; tokenFile: string } => {
  const dir = mkdtempSync(join(tmpdir(), "acc2-daemon-"));
  return {
    dir,
    dbPath: join(dir, "test.db"),
    socketFile: join(dir, "v2.sock"),
    tokenFile: join(dir, "v2.sock.token"),
  };
};

const cleanup = async (handle: DaemonHandle | null, tmp: ReturnType<typeof mkTmp>): Promise<void> => {
  if (handle) {
    try { await stopDaemon(handle); } catch { /* swallow */ }
  }
  closeDb();
  rmSync(tmp.dir, { recursive: true, force: true });
};

describe("startDaemon — boot + health + shutdown", () => {
  let handle: DaemonHandle | null = null;
  let tmp = mkTmp();

  beforeEach(() => { tmp = mkTmp(); });
  afterEach(async () => { await cleanup(handle, tmp); handle = null; });

  test("opens both ports, binds the lock, emits daemon_started + daemon_index_rebuilt", async () => {
    const ports = pickPortPair();
    handle = await startDaemon({
      port: ports.mcp, auxPort: ports.aux, stateDbPath: tmp.dbPath,
      socketFile: tmp.socketFile, tokenFile: tmp.tokenFile,
    });
    expect(handle.server).toBeTruthy();
    expect(handle.mcpServer).toBeTruthy();
    expect(handle.port).toBe(ports.mcp);
    expect(handle.auxPort).toBe(ports.aux);
    expect(existsSync(tmp.socketFile)).toBe(true);
    expect(existsSync(tmp.tokenFile)).toBe(true);

    // Re-open the db (cache returns the same handle the daemon is using).
    const db = openDb(tmp.dbPath);
    const kinds = db
      .query("SELECT kind FROM events ORDER BY ts")
      .all() as Array<{ kind: string }>;
    const set = new Set(kinds.map((r) => r.kind));
    expect(set.has("daemon_started")).toBe(true);
    expect(set.has("daemon_index_rebuilt")).toBe(true);
  });

  test("GET /health (on auxPort) returns { status: ok, mcp_transport: 'fastmcp:httpStream', … }", async () => {
    const ports = pickPortPair();
    handle = await startDaemon({
      port: ports.mcp, auxPort: ports.aux, stateDbPath: tmp.dbPath,
      socketFile: tmp.socketFile, tokenFile: tmp.tokenFile,
    });
    const res = await fetch(`http://127.0.0.1:${handle.auxPort}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(typeof body.pid).toBe("number");
    expect(typeof body.uptime_ms).toBe("number");
    expect(body.db_path).toBe(tmp.dbPath);
    expect(typeof body.events_count).toBe("number");
    expect(body.mcp_port).toBe(handle.port);
    expect(body.aux_port).toBe(handle.auxPort);
    expect(body.mcp_transport).toBe("fastmcp:httpStream");
  });

  test("stopDaemon emits daemon_shutdown, removes the lockfile, closes both ports", async () => {
    const ports = pickPortPair();
    handle = await startDaemon({
      port: ports.mcp, auxPort: ports.aux, stateDbPath: tmp.dbPath,
      socketFile: tmp.socketFile, tokenFile: tmp.tokenFile,
    });
    const auxPort = handle.auxPort;
    await stopDaemon(handle);
    handle = null;

    expect(existsSync(tmp.socketFile)).toBe(false);

    // Subsequent fetch must fail — aux server has stopped.
    let failed = false;
    try { await fetch(`http://127.0.0.1:${auxPort}/health`); } catch { failed = true; }
    expect(failed).toBe(true);

    // Reopen the db (fresh cache slot) and confirm daemon_shutdown landed.
    const db = openDb(tmp.dbPath);
    const row = db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'daemon_shutdown'").get() as { n: number };
    expect(row.n).toBeGreaterThanOrEqual(1);
  });

  test("second-instance attempt under the same socket lock fails fast", async () => {
    const ports = pickPortPair();
    handle = await startDaemon({
      port: ports.mcp, auxPort: ports.aux, stateDbPath: tmp.dbPath,
      socketFile: tmp.socketFile, tokenFile: tmp.tokenFile,
    });

    // Try again — same socket file, this process is alive, so we expect a throw.
    const other = pickPortPair();
    let caught: Error | null = null;
    try {
      await startDaemon({
        port: other.mcp, auxPort: other.aux, stateDbPath: join(tmp.dir, "other.db"),
        socketFile: tmp.socketFile, tokenFile: tmp.tokenFile,
      });
    } catch (err) { caught = err as Error; }
    expect(caught).toBeTruthy();
    expect(caught!.message).toContain("daemon already running");
  });

  test("POST /shutdown (on auxPort) with the admin token gracefully stops the daemon", async () => {
    const ports = pickPortPair();
    handle = await startDaemon({
      port: ports.mcp, auxPort: ports.aux, stateDbPath: tmp.dbPath,
      socketFile: tmp.socketFile, tokenFile: tmp.tokenFile,
    });
    const adminToken = handle.adminToken;
    const auxPort = handle.auxPort;

    const res = await fetch(`http://127.0.0.1:${auxPort}/shutdown`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; status?: string };
    expect(body.ok).toBe(true);
    expect(body.status).toBe("shutting_down");

    // Give the setTimeout a beat to fire.
    await new Promise((r) => setTimeout(r, 200));
    handle = null;

    // Lockfile removed.
    expect(existsSync(tmp.socketFile)).toBe(false);
  });

  test("POST /shutdown without the admin token returns 401", async () => {
    const ports = pickPortPair();
    handle = await startDaemon({
      port: ports.mcp, auxPort: ports.aux, stateDbPath: tmp.dbPath,
      socketFile: tmp.socketFile, tokenFile: tmp.tokenFile,
    });
    const res = await fetch(`http://127.0.0.1:${handle.auxPort}/shutdown`, {
      method: "POST",
      headers: { authorization: "Bearer not-the-real-token" },
    });
    expect(res.status).toBe(401);
  });
});
