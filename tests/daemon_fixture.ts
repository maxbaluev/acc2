import { afterAll, afterEach, beforeAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../substrate/db";
import { startDaemon, stopDaemon, type DaemonHandle } from "../runtime/daemon";
import { getFreePortPair } from "./free_port";

type SharedDaemonOpts = {
  tmpPrefix: string;
  dbName: string;
  mcpBase: number;
  auxBase: number;
  portRange?: number;
  setEnvPorts?: boolean;
  externalPushToken?: string;
};

type SharedDaemonFixture = {
  handle: () => DaemonHandle;
  dir: () => string;
};

export const useSharedDaemon = (opts: SharedDaemonOpts): SharedDaemonFixture => {
  let handle: DaemonHandle | null = null;
  let dir = "";
  let port = 0;
  let auxPort = 0;
  // PER-FILE env snapshot — taken once in beforeAll. Per-test rebinding
  // (in beforeEach below) re-applies our ports even if a sibling test
  // file's useSharedDaemon overwrote them. FOUNDATIONAL FIX 2026-05-17:
  // pre-fix the env vars were set ONCE in beforeAll, so when Bun ran
  // multiple test files in parallel each one's beforeAll raced and the
  // last-write won for the whole shared env. The cli/dispatch.test
  // failures in the full suite (and passes in isolation) were caused
  // by this race — cli code path read V2_DAEMON_PORT pointing at a
  // sibling file's daemon, called the wrong port, got connection
  // refused, and runDispatch returned exit 1.
  let prevPort: string | undefined;
  let prevAuxPort: string | undefined;
  let prevMcpServerUrl: string | undefined;
  const useEnv = opts.setEnvPorts ?? true;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), opts.tmpPrefix));
    if (useEnv) {
      prevPort = process.env.V2_DAEMON_PORT;
      prevAuxPort = process.env.V2_DAEMON_AUX_PORT;
      prevMcpServerUrl = process.env.V2_MCP_SERVER_URL;
    }
    // Collision-retry: random ports in a shared band collide when parallel
    // test files (or repeated attempts) pick the same port before release,
    // producing "Failed to start server. Is port X in use?". Retry with a
    // fresh random port on bind failure rather than failing the whole file.
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      // OS-assigned free ports (collision-free); the retry covers the tiny
      // close→reuse window. opts.mcpBase/auxBase + portRange are legacy and
      // ignored — getFreePort never collides with the live daemon or siblings.
      const pair = getFreePortPair();
      port = pair.mcp;
      auxPort = pair.aux;
      try {
        handle = await startDaemon({
          port,
          auxPort,
          stateDbPath: join(dir, opts.dbName),
          socketFile: join(dir, "v2.sock"),
          tokenFile: join(dir, "v2.sock.token"),
          externalPushToken: opts.externalPushToken,
        });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        const msg = String((err as Error)?.message ?? err);
        // Only retry on a port-binding collision; rethrow anything else.
        if (!/port|EADDRINUSE|address already in use|Failed to start server/i.test(msg)) throw err;
        try { if (handle) await stopDaemon(handle); } catch { /* best effort */ }
        handle = null;
      }
    }
    if (lastErr) throw lastErr;
  });

  // Per-test re-bind of env vars protects against parallel-file races where
  // a sibling fixture overwrote daemon connection state. MCP URL must move
  // with the port or bridge subprocesses can call the wrong daemon.
  beforeEach(() => {
    if (useEnv && handle) {
      process.env.V2_DAEMON_PORT = String(port);
      process.env.V2_DAEMON_AUX_PORT = String(auxPort);
      process.env.V2_MCP_SERVER_URL = `http://127.0.0.1:${port}/mcp`;
    }
  });

  afterEach(() => {
    // Leave the env on this fixture's ports between tests in this file.
    // The afterAll restore handles cleanup.
  });

  afterAll(async () => {
    if (handle) await stopDaemon(handle);
    handle = null;
    closeDb();
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (useEnv) {
      if (prevPort === undefined) delete process.env.V2_DAEMON_PORT;
      else process.env.V2_DAEMON_PORT = prevPort;
      if (prevAuxPort === undefined) delete process.env.V2_DAEMON_AUX_PORT;
      else process.env.V2_DAEMON_AUX_PORT = prevAuxPort;
      if (prevMcpServerUrl === undefined) delete process.env.V2_MCP_SERVER_URL;
      else process.env.V2_MCP_SERVER_URL = prevMcpServerUrl;
    }
  });

  return {
    handle: () => {
      if (!handle) throw new Error("shared daemon fixture not started");
      return handle;
    },
    dir: () => dir,
  };
};
