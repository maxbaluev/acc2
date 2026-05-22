// acc2 — credential health check at daemon startup (lesson 0R6EPM4AX54J).
//
// Three falsifying cases:
//
//   A — SERPER_API_KEY unset emits a fail-loud warning to stderr at boot.
//   B — SERPER_API_KEY present emits no Serper warning at boot.
//   C — /health payload exposes credentials.{openai,serper} presence flags.
//
// The warning is emitted synchronously inside startDaemon (same shape as
// the OPENAI_API_KEY warning landed in fa8c644). The /health payload is
// the operator-facing read surface — values are presence flags only, the
// keys themselves are never exposed.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../substrate/db";
import { startDaemon, stopDaemon, type DaemonHandle } from "../runtime/daemon";
import { startDaemonOnFreePorts } from "./free_port";

const captureStderr = async <T>(fn: () => Promise<T>): Promise<{ result: T; chunks: string[] }> => {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  // Bun's process.stderr.write signature returns boolean; intercept all
  // shapes so anything emitted during startDaemon lands in `chunks`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: any, ..._rest: any[]): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
  try {
    const result = await fn();
    return { result, chunks };
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = original;
  }
};

describe("credential_health case A — SERPER_API_KEY unset emits stderr warning at boot", () => {
  let tmpDir = "";
  let handle: DaemonHandle | null = null;
  let prevSerper: string | undefined;
  let stderrChunks: string[] = [];

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "acc2-cred-missing-"));
    prevSerper = process.env.SERPER_API_KEY;
    delete process.env.SERPER_API_KEY;
    const { result, chunks } = await captureStderr(() =>
      startDaemonOnFreePorts(startDaemon, {
        stateDbPath: join(tmpDir, "state.db"),
        socketFile: join(tmpDir, "v2.sock"),
        tokenFile: join(tmpDir, "v2.sock.token"),
      }),
    );
    handle = result;
    stderrChunks = chunks;
  });

  afterAll(async () => {
    if (handle) await stopDaemon(handle);
    handle = null;
    closeDb();
    if (prevSerper === undefined) delete process.env.SERPER_API_KEY;
    else process.env.SERPER_API_KEY = prevSerper;
    if (tmpDir) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  test("startDaemon emits a Serper warning line to stderr when the key is absent", () => {
    const joined = stderrChunks.join("");
    expect(joined).toContain("SERPER_API_KEY is not set");
    expect(joined).toContain("silently return empty results");
  });
});

describe("credential_health case B — SERPER_API_KEY present emits no Serper warning at boot", () => {
  let tmpDir = "";
  let handle: DaemonHandle | null = null;
  let prevSerper: string | undefined;
  let stderrChunks: string[] = [];

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "acc2-cred-present-"));
    prevSerper = process.env.SERPER_API_KEY;
    process.env.SERPER_API_KEY = "test-serper-key-not-real";
    const { result, chunks } = await captureStderr(() =>
      startDaemonOnFreePorts(startDaemon, {
        stateDbPath: join(tmpDir, "state.db"),
        socketFile: join(tmpDir, "v2.sock"),
        tokenFile: join(tmpDir, "v2.sock.token"),
      }),
    );
    handle = result;
    stderrChunks = chunks;
  });

  afterAll(async () => {
    if (handle) await stopDaemon(handle);
    handle = null;
    closeDb();
    if (prevSerper === undefined) delete process.env.SERPER_API_KEY;
    else process.env.SERPER_API_KEY = prevSerper;
    if (tmpDir) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  test("startDaemon does NOT emit a Serper warning when the key is present", () => {
    const joined = stderrChunks.join("");
    expect(joined).not.toContain("SERPER_API_KEY is not set");
  });
});

describe("credential_health case C — /health payload exposes credentials presence flags", () => {
  let tmpDir = "";
  let handle: DaemonHandle | null = null;
  let auxPort = 0;
  let prevSerper: string | undefined;
  let prevOpenai: string | undefined;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "acc2-cred-health-"));
    prevSerper = process.env.SERPER_API_KEY;
    prevOpenai = process.env.OPENAI_API_KEY;
    // Pin known values so the /health payload is deterministic: present
    // OPENAI, missing SERPER. The keys themselves never appear on the wire.
    process.env.OPENAI_API_KEY = "test-openai-key-not-real";
    delete process.env.SERPER_API_KEY;
    handle = await startDaemonOnFreePorts(startDaemon, {
      stateDbPath: join(tmpDir, "state.db"),
      socketFile: join(tmpDir, "v2.sock"),
      tokenFile: join(tmpDir, "v2.sock.token"),
    });
    auxPort = handle.auxPort;
  });

  afterAll(async () => {
    if (handle) await stopDaemon(handle);
    handle = null;
    closeDb();
    if (prevSerper === undefined) delete process.env.SERPER_API_KEY;
    else process.env.SERPER_API_KEY = prevSerper;
    if (prevOpenai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevOpenai;
    if (tmpDir) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  test("/health response includes credentials.{openai,serper} with present/missing values", async () => {
    const res = await fetch(`http://127.0.0.1:${auxPort}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("credentials");
    const creds = body.credentials as Record<string, unknown>;
    expect(creds).toHaveProperty("openai");
    expect(creds).toHaveProperty("serper");
    expect(creds.openai).toBe("present");
    expect(creds.serper).toBe("missing");
    // Defense-in-depth: the key value must never appear in the payload.
    const wire = JSON.stringify(body);
    expect(wire).not.toContain("test-openai-key-not-real");
  });
});
