// Symmetric Claude-Code engine bridge — scaffold tests (increment 1/2).
//
// These tests prove the Claude bridge mirrors the opencode bridge lifecycle
// (cc_dispatched → cc_frame_received → cc_dispatch_closed), respects the SHARED
// cycle-1 gate + first-frame watchdog seams, and — critically — NEVER launches
// a real `claude` or `opencode` subprocess. The real-spawn path is driven
// entirely through the injected `spawnFn` seam with canned stream-json frames.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { closeDb, openDb } from "../../substrate/db";
import {
  spawnRealClaudeCode,
  claudeCodeQueryMock,
  materializeClaudeMcpConfig,
  FIXTURE_CC_IMPLEMENT_MARKER,
} from "./index";
import { newId } from "../ids";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const readEventKinds = (db: Database, taskId: string): string[] =>
  db
    .query<{ kind: string }, [string]>("SELECT kind FROM events WHERE task_id = ? ORDER BY rowid")
    .all(taskId)
    .map((r) => r.kind);

const readOrigins = (db: Database, taskId: string): Set<string> =>
  new Set(
    db
      .query<{ substrate_origin: string }, [string]>(
        "SELECT substrate_origin FROM events WHERE task_id = ?",
      )
      .all(taskId)
      .map((r) => r.substrate_origin),
  );

/** Build a fakeSpawn that streams the given JSON-line frames on stdout, then
 *  exits with the given code. NEVER launches a real process — proves the
 *  bridge's spawn seam is the only path to subprocess execution. Records the
 *  argv it was called with so the test can assert the binary + flags. */
const makeFakeSpawn = (opts: {
  frames: string[];
  exitCode?: number;
  capture?: { argv?: string[]; env?: Record<string, string | undefined> };
}) => {
  const enc = new TextEncoder();
  const body = opts.frames.map((f) => f + "\n").join("");
  let offered = false;
  const fakeSpawn = ((argv: string[], spawnOpts: { env?: Record<string, string | undefined> }) => {
    if (opts.capture) {
      opts.capture.argv = argv;
      opts.capture.env = spawnOpts?.env;
    }
    return {
      pid: 424242,
      stdout: {
        getReader: () => ({
          read: async () => {
            if (offered) return { done: true, value: undefined };
            offered = true;
            return { done: false, value: enc.encode(body) };
          },
        }),
      },
      stderr: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
      kill: () => true,
      exited: Promise.resolve(opts.exitCode ?? 0),
    };
  }) as unknown as typeof Bun.spawn;
  return fakeSpawn;
};

describe("claude bridge — hermetic mock (no subprocess)", () => {
  test("mock spawns lifecycle, runs a cycle, emits cc_* events, closes — and admits an action_predicted", async () => {
    const db = openDb(":memory:");
    const taskId = newId();
    const result = await claudeCodeQueryMock(
      { prompt: `implement this. ${FIXTURE_CC_IMPLEMENT_MARKER}`, taskId, directiveId: "d_cc_mock" },
      db,
    );
    expect(result.ok).toBe(true);
    const kinds = readEventKinds(db, taskId);
    // Full symmetric lifecycle present.
    expect(kinds).toContain("cc_dispatched");
    expect(kinds).toContain("cc_frame_received");
    expect(kinds).toContain("cc_dispatch_closed");
    // The act tuple flows through the SAME admission path opencode uses.
    expect(kinds).toContain("action_predicted");
    expect(kinds).toContain("bridge_completed");
    // cc_dispatched precedes cc_dispatch_closed.
    expect(kinds.indexOf("cc_dispatched")).toBeLessThan(kinds.indexOf("cc_dispatch_closed"));
    // Engine attribution is "claude_code", symmetric to opencode's "opencode".
    expect(readOrigins(db, taskId).has("claude_code")).toBe(true);
  });

  test("mock declines an unrecognized prompt with the supported-marker list and still closes the dispatch", async () => {
    const db = openDb(":memory:");
    const taskId = newId();
    const result = await claudeCodeQueryMock(
      { prompt: "no fixture marker here", taskId, directiveId: "d_cc_unrec" },
      db,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.kind).toBe("mock_bridge_prompt_unrecognized");
    const kinds = readEventKinds(db, taskId);
    expect(kinds).toContain("cc_dispatched");
    expect(kinds).toContain("cc_dispatch_closed");
  });
});

describe("claude bridge — real spawn via injected seam (no real claude/opencode)", () => {
  test("spawns headless claude, MCP-connects, runs a cycle, emits cc_* events, closes — and never launches a real process", async () => {
    const db = openDb(":memory:");
    const taskId = newId();
    const capture: { argv?: string[]; env?: Record<string, string | undefined> } = {};
    // Canned stream-json: a tool_use frame that hits a v2 MCP tool (handshake),
    // then a result frame carrying the final text.
    const fakeSpawn = makeFakeSpawn({
      capture,
      frames: [
        JSON.stringify({ type: "tool_use", tool: "substrate.read" }),
        JSON.stringify({ type: "result", result: "implementation complete" }),
      ],
    });
    const result = await spawnRealClaudeCode(
      { prompt: "implement X", taskId, directiveId: "d_cc_real", dispatchId: "dispatch_cc_1" },
      db,
      {
        spawnFn: fakeSpawn,
        mcpServerUrl: "http://127.0.0.1:45999/mcp",
        skipMcpReadinessProbe: true,
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.final_response).toContain("implementation complete");

    // Spawn mechanism: the injected seam was called with the headless claude
    // CLI + stream-json + --mcp-config (the daemon endpoint injection).
    expect(capture.argv?.[0]).toBe("claude");
    expect(capture.argv).toContain("-p");
    expect(capture.argv).toContain("--output-format");
    expect(capture.argv).toContain("stream-json");
    expect(capture.argv).toContain("--mcp-config");
    // It must NOT be invoking opencode.
    expect(capture.argv).not.toContain("opencode");

    const kinds = readEventKinds(db, taskId);
    expect(kinds).toContain("cc_dispatched");
    expect(kinds).toContain("cc_frame_received");
    expect(kinds).toContain("bridge_mcp_connected"); // handshake detected
    expect(kinds).toContain("cc_dispatch_closed");
    expect(kinds).toContain("bridge_completed");
  });

  test("respects the SHARED cycle-1 gate: a brain_cycle_2_started frame is a violation that fails the dispatch", async () => {
    const db = openDb(":memory:");
    const taskId = newId();
    const fakeSpawn = makeFakeSpawn({
      frames: [
        JSON.stringify({ type: "tool_use", tool: "substrate.read" }),
        // Self-iteration attempt — the shared isCycleViolation predicate rejects it.
        JSON.stringify({ type: "brain_cycle_2_started" }),
      ],
    });
    const result = await spawnRealClaudeCode(
      { prompt: "implement X", taskId, directiveId: "d_cc_cycle" },
      db,
      { spawnFn: fakeSpawn, mcpServerUrl: "http://127.0.0.1:45999/mcp", skipMcpReadinessProbe: true },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.kind).toBe("subprocess_crash");
    const kinds = readEventKinds(db, taskId);
    const failed = db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM events WHERE task_id = ? AND kind = 'bridge_failed'",
      )
      .all(taskId);
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.some((r) => r.payload.includes("cycle_violation"))).toBe(true);
    expect(kinds).toContain("cc_dispatch_closed");
  });

  test("fails fast (no spawn) when V2_MCP_SERVER_URL is missing", async () => {
    const db = openDb(":memory:");
    const taskId = newId();
    let spawnCalled = false;
    const fakeSpawn = (() => {
      spawnCalled = true;
      throw new Error("should not be called");
    }) as unknown as typeof Bun.spawn;
    const result = await spawnRealClaudeCode(
      { prompt: "implement X", taskId, directiveId: "d_cc_nomcp" },
      db,
      { spawnFn: fakeSpawn, mcpServerUrl: "" },
    );
    expect(result.ok).toBe(false);
    expect(spawnCalled).toBe(false);
    const kinds = readEventKinds(db, taskId);
    expect(kinds).not.toContain("cc_dispatched");
  });

  test("non-zero subprocess exit surfaces a structured bridge_failed", async () => {
    const db = openDb(":memory:");
    const taskId = newId();
    const fakeSpawn = makeFakeSpawn({ frames: [], exitCode: 1 });
    const result = await spawnRealClaudeCode(
      { prompt: "implement X", taskId, directiveId: "d_cc_crash" },
      db,
      { spawnFn: fakeSpawn, mcpServerUrl: "http://127.0.0.1:45999/mcp", skipMcpReadinessProbe: true },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.kind).toBe("subprocess_crash");
    expect(readEventKinds(db, taskId)).toContain("cc_dispatch_closed");
  });
});

describe("claude bridge — MCP config materializer (symmetric to opencode)", () => {
  test("materializes a --mcp-config file declaring v2's daemon endpoint", () => {
    const dir = mkdtempSync(join(tmpdir(), "acc2-cc-cfg-test-"));
    try {
      const { configPath } = materializeClaudeMcpConfig({
        mcpServerUrl: "http://127.0.0.1:46000/mcp",
        configDir: dir,
      });
      expect(existsSync(configPath)).toBe(true);
      const cfg = JSON.parse(readFileSync(configPath, "utf8"));
      expect(cfg.mcpServers).toBeDefined();
      const serverNames = Object.keys(cfg.mcpServers);
      expect(serverNames.length).toBe(1);
      const server = cfg.mcpServers[serverNames[0]!];
      expect(server.url).toBe("http://127.0.0.1:46000/mcp");
      expect(server.type).toBe("http");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
