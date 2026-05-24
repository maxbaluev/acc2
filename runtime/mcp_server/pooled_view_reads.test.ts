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
import { handleRead, handleFindRecipe, handleOpenDirective, handleSearch } from "./substrate_tools";
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

// ── Dispatch-window event-loop blockers (find_recipe / open_directive / search)
//
// Runtime profiling (ACC2_PROFILE_LOOP=1) measured these three handlers
// blocking the daemon's single loop during a brain dispatch:
//   substrate.find_recipe   ~20s   (recipes_latest_view scan + topology scan)
//   substrate.open_directive ~5s   (json_extract dedup scan + NOT IN subquery)
//   substrate.search        ~2.7s  (vec/event scan; recency stand-in here)
// Each now routes its heavy SELECT(s) through poolQuery (off the main loop when
// a pool is installed; sync db.query fallback otherwise). These tests pin the
// pool-with-sync-fallback contract + byte-identical results for all three.

describe("dispatch-window blockers route off-loop (find_recipe / open_directive / search)", () => {
  test("find_recipe routes recipes_latest_view + topology scans through the pool, identical match", async () => {
    const db = openDb(":memory:");
    // Seed a task_node_opened (gives directive_id + goal) and a matching
    // recipe-shape knowledge row so the matcher returns a non-null match.
    emitEvent(db, {
      kind: "task_node_opened",
      directive_id: "d_recipe",
      task_id: "t_recipe",
      payload: { goal: "scrape inventory" },
    });
    db.run(
      `INSERT INTO events (id, ts, directive_id, task_id, loop_id, substrate_origin, kind, payload, context_refs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "ev_recipe_seed",
        "2026-01-01T00:00:01.000Z",
        "d_recipe_src",
        "t_recipe_src",
        "loop_root",
        "substrate_auto",
        "knowledge_candidate",
        JSON.stringify({
          recipe_shape: { enabled: true },
          goal_shape: "scrape_inventory::n1",
          topology_signature: "",
          confidence: 0.92,
          trajectory: [{ step_kind: "action_predicted", artifact_id: "a_dummy", payload_template: {} }],
        }),
        "[]",
      ],
    );

    // 1. No pool → synchronous path.
    clearSqlPool();
    const syncRes = await handleFindRecipe(ctx(db), { task_id: "t_recipe" } as never);
    expect(syncRes.ok).toBe(true);
    if (!syncRes.ok) throw new Error("sync find_recipe failed");

    // 2. Pool installed → routed off-loop, identical match.
    const { pool, calls } = makeRecordingPool(db);
    setSqlPool(pool);
    const pooledRes = await handleFindRecipe(ctx(db), { task_id: "t_recipe" } as never);
    expect(pooledRes.ok).toBe(true);
    if (!pooledRes.ok) throw new Error("pooled find_recipe failed");

    // Both the topology event scan AND the recipes_latest_view scan went
    // through the pool surface.
    const sqls = calls.map((c) => c.sql);
    expect(sqls.some((s) => s.includes("FROM recipes_latest_view"))).toBe(true);
    expect(sqls.some((s) => s.includes("kind = 'task_node_opened'") && s.includes("directive_id = ?"))).toBe(true);
    expect(pooledRes.result).toEqual(syncRes.result);
    expect((pooledRes.result as Record<string, unknown>).recipe_id).toBe("ev_recipe_seed");
  });

  test("open_directive routes the dedup lookup through the pool, identical dedup id (WRITES stay on main thread)", async () => {
    const db = openDb(":memory:");
    // First open (no pool) creates the directive.
    clearSqlPool();
    const first = await handleOpenDirective(ctx(db), { directive_text: "Count TODOs off-loop" } as never);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("first open failed");
    const firstId = (first.result as Record<string, unknown>).directive_id as string;

    // Second open WITH pool → the dedup READ routes off-loop and returns the
    // same id; the directive-open writes stayed on the single writer (no
    // duplicate directive emitted).
    const { pool, calls } = makeRecordingPool(db);
    setSqlPool(pool);
    const second = await handleOpenDirective(ctx(db), { directive_text: "Count TODOs off-loop" } as never);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("second open failed");
    const secondResult = second.result as Record<string, unknown>;

    // The dedup lookup is the only thing routed through the pool here (writes
    // are not). Same id, dedup flag set.
    expect(calls.some((c) => c.sql.includes("kind = 'directive_opened'") && c.sql.includes("json_extract"))).toBe(true);
    expect(secondResult.directive_id).toBe(firstId);
    expect(secondResult.deduped).toBe(true);
  });

  test("search recency stand-in routes the events scan through the pool, identical hits", async () => {
    const db = openDb(":memory:");
    emitEvent(db, { kind: "directive_opened", substrate_origin: "claude", payload: { directive_text: "one" } });
    emitEvent(db, { kind: "directive_opened", substrate_origin: "claude", payload: { directive_text: "two" } });

    // ctx has no index → handleSearch takes the recency stand-in branch.
    clearSqlPool();
    const syncRes = await handleSearch(ctx(db), { query: "anything", opts: { k: 10 } } as never);
    expect(syncRes.ok).toBe(true);
    if (!syncRes.ok) throw new Error("sync search failed");

    const { pool, calls } = makeRecordingPool(db);
    setSqlPool(pool);
    const pooledRes = await handleSearch(ctx(db), { query: "anything", opts: { k: 10 } } as never);
    expect(pooledRes.ok).toBe(true);
    if (!pooledRes.ok) throw new Error("pooled search failed");

    expect(calls.some((c) => c.sql.includes("FROM events ORDER BY ts DESC LIMIT ?"))).toBe(true);
    expect(pooledRes.result).toEqual(syncRes.result);
    expect((pooledRes.result as Record<string, unknown>).mode).toBe("recent_events_stub");
  });
});
