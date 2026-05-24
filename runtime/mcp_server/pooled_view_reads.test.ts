// acc2 — substrate.read off-loop routing (T3.8/T5 reactivity fix).
//
// Proves the #1-offender hot views route their SELECT through the SQL worker
// pool when one is installed, and fall back to the synchronous db.query path
// when absent — with byte-identical result shapes either way. This pins the
// pool-with-sync-fallback contract so handleRead can never silently revert to
// running the heavy view scans synchronously on the daemon's single loop.

import { afterAll, beforeEach, afterEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../../substrate/db";
import { emitEvent } from "../events";
import { handleRead } from "./substrate_tools";
import { setSqlPool, clearSqlPool } from "../sql_pool_singleton";
import type { SqlWorkerPool } from "../sql_worker_pool";
import type { McpContext } from "./types";

afterAll(() => closeDb());
beforeEach(() => closeDb());
afterEach(() => clearSqlPool());

const ctx = (db: ReturnType<typeof openDb>): McpContext =>
  ({ db, invoker: "claude_root" } as McpContext);

const unwrap = async (r: ReturnType<typeof handleRead>): Promise<unknown> => {
  const resolved = await r;
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) throw new Error("handleRead failed");
  return resolved.result;
};

/** A fake SqlWorkerPool whose `query` executes the SAME SQL synchronously on
 *  the in-memory db (workers can't open a `:memory:` connection in a unit
 *  test) and records every call. This proves the read was ROUTED through the
 *  pool surface while keeping the rows identical to the sync path. */
const makeRecordingPool = (db: ReturnType<typeof openDb>) => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      calls.push({ sql, params });
      const rows = (params.length > 0 ? db.query(sql).all(...(params as never[])) : db.query(sql).all()) as T[];
      return Promise.resolve(rows);
    },
  } as unknown as SqlWorkerPool;
  return { pool, calls };
};

describe("substrate.read off-loop pool routing", () => {
  test("substrate_narrative_recent_view routes through the pool when present, sync when absent, identical rows", async () => {
    const db = openDb(":memory:");
    // directive_opened is a narrative-flagged kind that surfaces in the view.
    emitEvent(db, { kind: "directive_opened", substrate_origin: "claude", payload: { directive_text: "hello one" } });
    emitEvent(db, { kind: "directive_opened", substrate_origin: "claude", payload: { directive_text: "hello two" } });

    // 1. No pool installed → synchronous fallback path.
    clearSqlPool();
    const syncRows = (await unwrap(
      handleRead(ctx(db), { view_name: "substrate_narrative_recent_view", args: { limit: 10 } }),
    )) as Array<Record<string, unknown>>;
    expect(Array.isArray(syncRows)).toBe(true);
    expect(syncRows.length).toBe(2);

    // 2. Pool installed → routed off-loop. Same rows, pool.query observed.
    const { pool, calls } = makeRecordingPool(db);
    setSqlPool(pool);
    const pooledRows = (await unwrap(
      handleRead(ctx(db), { view_name: "substrate_narrative_recent_view", args: { limit: 10 } }),
    )) as Array<Record<string, unknown>>;

    expect(calls.length).toBe(1);
    expect(calls[0].sql).toContain("FROM substrate_narrative_recent_view");
    // Identical result shape + content between sync and pooled paths.
    expect(pooledRows).toEqual(syncRows);
  });

  test("ready_tasks_view routes through the pool when present, identical to sync", async () => {
    const db = openDb(":memory:");
    // A node with no incoming 'requires' edge is ready.
    emitEvent(db, {
      kind: "task_node_opened",
      directive_id: "d1",
      task_id: "t1",
      payload: { goal: "do the thing" },
    });

    clearSqlPool();
    const syncRows = (await unwrap(
      handleRead(ctx(db), { view_name: "ready_tasks_view", args: { limit: 50 } }),
    )) as Array<Record<string, unknown>>;

    const { pool, calls } = makeRecordingPool(db);
    setSqlPool(pool);
    const pooledRows = (await unwrap(
      handleRead(ctx(db), { view_name: "ready_tasks_view", args: { limit: 50 } }),
    )) as Array<Record<string, unknown>>;

    expect(calls.length).toBe(1);
    expect(calls[0].sql).toContain("FROM ready_tasks_view");
    expect(pooledRows).toEqual(syncRows);
  });

  test("artifact_routing_view + act_artifact_registry_view route through the pool when present", async () => {
    const db = openDb(":memory:");
    const { pool, calls } = makeRecordingPool(db);
    setSqlPool(pool);

    await unwrap(handleRead(ctx(db), { view_name: "act_artifact_registry_view", args: {} }));
    await unwrap(handleRead(ctx(db), { view_name: "artifact_routing_view", args: {} }));

    expect(calls.length).toBe(2);
    expect(calls[0].sql).toContain("FROM act_artifact_registry_view");
    expect(calls[1].sql).toContain("artifact_routing_view");
  });

  test("task_graph_view routes through the pool when present, identical to sync", async () => {
    const db = openDb(":memory:");
    emitEvent(db, {
      kind: "task_node_opened",
      directive_id: "dg",
      task_id: "tg1",
      payload: { goal: "g" },
    });

    clearSqlPool();
    const syncRows = (await unwrap(
      handleRead(ctx(db), { view_name: "task_graph_view", args: { directive_id: "dg" } }),
    )) as Array<Record<string, unknown>>;

    const { pool, calls } = makeRecordingPool(db);
    setSqlPool(pool);
    const pooledRows = (await unwrap(
      handleRead(ctx(db), { view_name: "task_graph_view", args: { directive_id: "dg" } }),
    )) as Array<Record<string, unknown>>;

    expect(calls.length).toBe(1);
    expect(calls[0].sql).toContain("FROM task_graph_view");
    expect(pooledRows).toEqual(syncRows);
  });

  test("pool rejection degrades to the synchronous read with identical rows", async () => {
    const db = openDb(":memory:");
    emitEvent(db, { kind: "directive_opened", substrate_origin: "claude", payload: { directive_text: "fallback me" } });

    clearSqlPool();
    const syncRows = (await unwrap(
      handleRead(ctx(db), { view_name: "substrate_narrative_recent_view", args: { limit: 10 } }),
    )) as Array<Record<string, unknown>>;

    // A pool that always rejects (overflow/timeout/worker death) must NOT
    // break the read — poolQuery fails closed to the sync path.
    const rejectingPool = {
      query<T>(): Promise<T[]> {
        return Promise.reject(new Error("pool_queue_overflow:in_flight=999;limit=256"));
      },
    } as unknown as SqlWorkerPool;
    setSqlPool(rejectingPool);

    const degradedRows = (await unwrap(
      handleRead(ctx(db), { view_name: "substrate_narrative_recent_view", args: { limit: 10 } }),
    )) as Array<Record<string, unknown>>;

    expect(degradedRows).toEqual(syncRows);
    expect(degradedRows.length).toBe(1);
  });
});
