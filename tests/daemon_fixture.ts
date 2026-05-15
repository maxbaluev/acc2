import { afterAll, beforeAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../substrate/db";
import { startDaemon, stopDaemon, type DaemonHandle } from "../runtime/daemon";

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
  let prevPort: string | undefined;
  let prevAuxPort: string | undefined;
  const portRange = opts.portRange ?? 1000;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), opts.tmpPrefix));
    const port = opts.mcpBase + Math.floor(Math.random() * portRange);
    const auxPort = opts.auxBase + Math.floor(Math.random() * portRange);
    handle = await startDaemon({
      port,
      auxPort,
      stateDbPath: join(dir, opts.dbName),
      socketFile: join(dir, "v2.sock"),
      tokenFile: join(dir, "v2.sock.token"),
      externalPushToken: opts.externalPushToken,
    });

    if (opts.setEnvPorts ?? true) {
      prevPort = process.env.V2_DAEMON_PORT;
      prevAuxPort = process.env.V2_DAEMON_AUX_PORT;
      process.env.V2_DAEMON_PORT = String(port);
      process.env.V2_DAEMON_AUX_PORT = String(auxPort);
    }
  });

  afterAll(async () => {
    if (handle) await stopDaemon(handle);
    handle = null;
    closeDb();
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (opts.setEnvPorts ?? true) {
      if (prevPort === undefined) delete process.env.V2_DAEMON_PORT;
      else process.env.V2_DAEMON_PORT = prevPort;
      if (prevAuxPort === undefined) delete process.env.V2_DAEMON_AUX_PORT;
      else process.env.V2_DAEMON_AUX_PORT = prevAuxPort;
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
