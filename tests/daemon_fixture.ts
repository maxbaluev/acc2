import { afterAll, afterEach, beforeAll, beforeEach } from "bun:test";
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
  const portRange = opts.portRange ?? 1000;
  const useEnv = opts.setEnvPorts ?? true;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), opts.tmpPrefix));
    port = opts.mcpBase + Math.floor(Math.random() * portRange);
    auxPort = opts.auxBase + Math.floor(Math.random() * portRange);
    handle = await startDaemon({
      port,
      auxPort,
      stateDbPath: join(dir, opts.dbName),
      socketFile: join(dir, "v2.sock"),
      tokenFile: join(dir, "v2.sock.token"),
      externalPushToken: opts.externalPushToken,
    });
    if (useEnv) {
      prevPort = process.env.V2_DAEMON_PORT;
      prevAuxPort = process.env.V2_DAEMON_AUX_PORT;
    }
  });

  // Per-test re-bind of env vars — protects against parallel-file races
  // where another fixture's beforeAll overwrote our ports. Each test in
  // THIS file sees the correct daemon ports at the moment it runs.
  beforeEach(() => {
    if (useEnv && handle) {
      process.env.V2_DAEMON_PORT = String(port);
      process.env.V2_DAEMON_AUX_PORT = String(auxPort);
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
