// Daemon lifecycle — boot / health / aux-read endpoints (part 1 of the
// split lifecycle suite; shared fixtures in ./daemon_test_helpers.ts).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../substrate/db";
import { startDaemon, stopDaemon, isDaemonAlreadyRunningError, getBootIntegrityState, runBudgetedSweep, type DaemonHandle, type BudgetedStep } from "./daemon";
import { handleGetEvent, handleRead } from "./mcp_server/substrate_tools";
import { recordReadAttemptStart, recordReadSuccess, READ_PATH_LATENCY_MS } from "./readiness";
import { handleRecentEvents } from "./mcp_server/runtime_tools";
import { isSchedulerDraining } from "./task_scheduler";
import { getSqlPool, clearSqlPool } from "./sql_pool_singleton";
import { getFreePortPair, startDaemonOnFreePorts } from "../tests/free_port";
import { mkTmp, bootHandle, cleanup, pickPortPair, parsePayload, type Tmp } from "./daemon_test_helpers";

describe("startDaemon — boot + health + aux reads (part 1)", () => {
  let handle: DaemonHandle | null = null;
  let tmp = mkTmp();

  beforeEach(() => { tmp = mkTmp(); });
  afterEach(async () => { await cleanup(handle, tmp); handle = null; });
  test("opens both ports, binds the lock, emits daemon_started + daemon_index_rebuilt", async () => {
    handle = await bootHandle(tmp);
    expect(handle.server).toBeTruthy();
    expect(handle.mcpServer).toBeTruthy();
    expect(typeof handle.port).toBe("number");
    expect(typeof handle.auxPort).toBe("number");
    expect(handle.port).not.toBe(handle.auxPort);
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
    handle = await bootHandle(tmp);
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
    expect(body.mcp_sessions).toMatchObject({
      active_sessions: 0,
      max_sessions: expect.any(Number),
      idle_ttl_ms: expect.any(Number),
      reaper_interval_ms: expect.any(Number),
    });
    // Robustness: /health now carries a stuck_workers array. On a fresh
    // daemon every worker just ticked, so the array is empty.
    expect(Array.isArray(body.stuck_workers)).toBe(true);
    expect((body.stuck_workers as unknown[]).length).toBe(0);
  });

  test("aux read endpoints match the canonical MCP read handlers", async () => {
    handle = await bootHandle(tmp);
    const { emitEvent } = await import("./events");
    const emitted = emitEvent(handle.db, {
      kind: "owner_input_received",
      substrate_origin: "owner",
      payload: { text: "aux-read-parity" },
    });
    const ctx = { db: handle.db, invoker: "claude_root" as const, index: null, ingressState: handle.ingressState };

    const post = async (path: string, body: unknown): Promise<{ status: number; body: unknown }> => {
      const res = await fetch("http://127.0.0.1:" + handle!.auxPort + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    };

    const readArgs = { view_name: "failure_view", args: {} };
    expect(await post("/read", readArgs)).toEqual({
      status: 200,
      body: await handleRead(ctx, readArgs),
    });

    const recentArgs = { k: 1, kinds: ["owner_input_received"] };
    expect(await post("/recent-events", recentArgs)).toEqual({
      status: 200,
      body: handleRecentEvents(ctx, recentArgs),
    });

    const getArgs = { id: emitted.id };
    expect(await post("/get-event", getArgs)).toEqual({
      status: 200,
      body: handleGetEvent(ctx, getArgs),
    });
  });

  test("aux read endpoints reject malformed envelopes without reaching MCP", async () => {
    handle = await bootHandle(tmp);
    const res = await fetch("http://127.0.0.1:" + handle.auxPort + "/get-event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "invalid_params" });
  });

  test("aux read endpoints do not create FastMCP sessions", async () => {
    handle = await bootHandle(tmp);
    const health = async (): Promise<Record<string, unknown>> => {
      const res = await fetch("http://127.0.0.1:" + handle!.auxPort + "/health");
      expect(res.status).toBe(200);
      return await res.json() as Record<string, unknown>;
    };
    const sessionCount = async (): Promise<number> => {
      const body = await health();
      const sessions = body.mcp_sessions as { active_sessions?: number } | undefined;
      return sessions?.active_sessions ?? -1;
    };

    expect(await sessionCount()).toBe(0);

    const post = async (path: string, body: unknown): Promise<void> => {
      const res = await fetch("http://127.0.0.1:" + handle!.auxPort + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBeLessThan(500);
      await res.text();
    };

    await post("/read", { view_name: "failure_view", args: {} });
    await post("/recent-events", { k: 1 });
    await post("/get-event", { id: "missing_event_id" });

    expect(await sessionCount()).toBe(0);
  });

  test("INSTANT-BOOT: health=ok is reachable WITHOUT the boot integrity check completing", async () => {
    // The boot PRAGMA quick_check (formerly synchronous, pre-bind, scanning
    // every page of the ≈1GB state.db) is now deferred to AFTER the ports
    // bind + /health serves. startDaemon resolving + /health returning
    // status:ok must NOT depend on the integrity scan having run. We assert
    // /health is ok while boot_integrity is still `pending` (the scan is
    // scheduled via setTimeout(BOOT_HEAVY_PASS_DELAY_MS) and has not fired
    // by the time the daemon is serving).
    const fresh = mkTmp();
    const localHandle = await startDaemonOnFreePorts(startDaemon, {
      stateDbPath: fresh.dbPath,
      socketFile: fresh.socketFile,
      tokenFile: fresh.tokenFile,
    });
    try {
      // The deferred check has not fired yet; the in-process getter must
      // report `pending` immediately after boot resolved.
      expect(getBootIntegrityState().status).toBe("pending");

      // /health serves status:ok with the integrity scan still pending —
      // proving health is decoupled from the (deferred) boot integrity check.
      const res = await fetch(`http://127.0.0.1:${localHandle.auxPort}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("ok");
      const bi = body.boot_integrity as { status?: string };
      expect(bi.status).toBe("pending");

      // The deferred check still RUNS (correctness preserved): wait for it to
      // transition off `pending` to `ok` on this fresh, healthy temp DB.
      const deadline = Date.now() + 8000;
      while (getBootIntegrityState().status === "pending" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(getBootIntegrityState().status).toBe("ok");
    } finally {
      await stopDaemon(localHandle);
      closeDb();
      rmSync(fresh.dir, { recursive: true, force: true });
    }
  });

});
