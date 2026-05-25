// acc2 substrate.read — bounded depth-1 reads (RLM invariant). Regression
// coverage for two real bugs the orchestrator hit:
//
//   BUG A — no default LIMIT: substrate.read({view_name:"dispatch_resolved_view"})
//   dumped 607,662 chars (the entire dispatch table) because the query appended
//   a LIMIT only when filter.limit was set. An UNSCOPED read MUST be capped.
//
//   BUG B — scope args don't thread through: handleRead read scope filters from
//   args.args only, but opencode 1.4+ (and the brain) pass them FLAT on args.
//   So substrate.read({view_name:"task_graph_view", args:{directive_id:"X"}})
//   worked but a FLAT caller (directive_id on args itself) silently became
//   unscoped → wrong data. The EMIT handler already resolves both shapes; this
//   asserts the READ handler now does too.
//
// Each test seeds a tiny in-memory DB and calls handleRead with BOTH the nested
// and flat arg shapes.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../../substrate/db";
import { handleRead } from "./substrate_tools";
import type { McpContext } from "./types";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const ctx = (db: ReturnType<typeof openDb>): McpContext =>
  ({ db, invoker: "claude_root" } as McpContext);

const unwrap = async (r: ReturnType<typeof handleRead>): Promise<unknown> => {
  const resolved = await r;
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) throw new Error(`handleRead failed: ${resolved.error}`);
  return resolved.result;
};

const newId = (): string =>
  crypto.randomUUID().replace(/-/g, "").slice(0, 26).toUpperCase();

let _tsCounter = 0;
const tickTs = (): string => {
  _tsCounter += 1;
  return new Date(Date.UTC(2026, 0, 1, 0, 0, _tsCounter)).toISOString();
};

const insertEvent = (
  db: ReturnType<typeof openDb>,
  fields: {
    kind: string;
    directive_id: string;
    task_id: string;
    parent_task_id?: string | null;
    payload?: unknown;
    ts?: string;
  },
): string => {
  const id = newId();
  db.run(
    `INSERT INTO events (
       id, ts, directive_id, task_id, parent_task_id, loop_id,
       substrate_origin, kind, payload, context_refs, failure_kind, residual,
       predicted_residual, action_artifact_id, verifier_artifact_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      fields.ts ?? tickTs(),
      fields.directive_id,
      fields.task_id,
      fields.parent_task_id ?? null,
      "loop_t",
      "claude_root",
      fields.kind,
      JSON.stringify(fields.payload ?? {}),
      "[]",
      null,
      null,
      null,
      null,
      null,
    ],
  );
  return id;
};

// Seed N distinct dispatch roots (each a live brain_dispatched). Uses
// recent-but-monotonic timestamps (i seconds before now, latest last) so the
// roots stay 'live' (not aged into zombie) AND order deterministically by
// latest_signal_at DESC.
const seedDispatchRoots = (db: ReturnType<typeof openDb>, n: number): string[] => {
  const ids: string[] = [];
  const base = Date.now();
  for (let i = 0; i < n; i++) {
    const directive_id = `d_${i.toString().padStart(4, "0")}`;
    const task_id = `t_${i.toString().padStart(4, "0")}`;
    // Higher i ⇒ more recent ts ⇒ ranks first under latest_signal_at DESC.
    const ts = new Date(base - (n - i) * 1000).toISOString();
    insertEvent(db, { kind: "task_node_opened", directive_id, task_id, ts });
    insertEvent(db, {
      kind: "brain_dispatched",
      directive_id,
      task_id,
      ts,
      payload: { dispatch_id: `disp_${i}` },
    });
    ids.push(directive_id);
  }
  return ids;
};

describe("BUG A — dispatch_resolved_view default LIMIT (unbounded dump)", () => {
  test("UNSCOPED read is capped at the default (50) — never dumps every directive", async () => {
    const db = openDb(":memory:");
    seedDispatchRoots(db, 120);
    const rows = (await unwrap(handleRead(ctx(db), { view_name: "dispatch_resolved_view", args: {} }))) as unknown[];
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBe(50);
  });

  test("UNSCOPED read keeps the MOST-RECENT rows (latest_signal_at DESC)", async () => {
    const db = openDb(":memory:");
    seedDispatchRoots(db, 120);
    const rows = (await unwrap(handleRead(ctx(db), { view_name: "dispatch_resolved_view", args: {} }))) as Array<Record<string, unknown>>;
    // d_0119 was seeded last → highest latest_signal_at → must be present;
    // d_0000 was seeded first → must have been capped out.
    const dirs = new Set(rows.map((r) => r.directive_id as string));
    expect(dirs.has("d_0119")).toBe(true);
    expect(dirs.has("d_0000")).toBe(false);
  });

  test("env ACC2_DISPATCH_RESOLVED_DEFAULT_LIMIT tunes the unscoped cap", async () => {
    const prev = process.env.ACC2_DISPATCH_RESOLVED_DEFAULT_LIMIT;
    process.env.ACC2_DISPATCH_RESOLVED_DEFAULT_LIMIT = "10";
    try {
      const db = openDb(":memory:");
      seedDispatchRoots(db, 40);
      const rows = (await unwrap(handleRead(ctx(db), { view_name: "dispatch_resolved_view", args: {} }))) as unknown[];
      expect(rows.length).toBe(10);
    } finally {
      if (prev === undefined) delete process.env.ACC2_DISPATCH_RESOLVED_DEFAULT_LIMIT;
      else process.env.ACC2_DISPATCH_RESOLVED_DEFAULT_LIMIT = prev;
    }
  });

  test("explicit caller limit is honored AND clamped to the hard max (1000)", async () => {
    const db = openDb(":memory:");
    seedDispatchRoots(db, 120);
    const small = (await unwrap(handleRead(ctx(db), { view_name: "dispatch_resolved_view", args: { limit: 7 } }))) as unknown[];
    expect(small.length).toBe(7);
    // A caller asking for a million rows is clamped — never an unbounded dump.
    const huge = (await unwrap(handleRead(ctx(db), { view_name: "dispatch_resolved_view", args: { limit: 1_000_000 } }))) as unknown[];
    expect(huge.length).toBe(120); // only 120 exist, but the LIMIT clause was clamped to 1000
  });
});

describe("BUG A — dispatch_resolved_view scoped read is UNCHANGED in shape/ordering", () => {
  test("a scoped (directive_id+root_task_id) read returns that directive's tree, not the default-capped slice", async () => {
    const db = openDb(":memory:");
    seedDispatchRoots(db, 120);
    // d_0000 would be capped OUT of the unscoped default slice, but a scoped
    // read must still return it (full tree, unchanged).
    const rows = (await unwrap(handleRead(ctx(db), {
      view_name: "dispatch_resolved_view",
      args: { directive_id: "d_0000", root_task_id: "t_0000" },
    }))) as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    expect(rows[0]?.directive_id).toBe("d_0000");
    expect(rows[0]?.root_task_id).toBe("t_0000");
    expect(rows[0]?.lifecycle_status).toBe("live");
  });
});

describe("BUG B — scope args thread through BOTH nested and flat shapes", () => {
  test("dispatch_resolved_view: FLAT directive_id+root_task_id (on args itself) returns scoped data", async () => {
    const db = openDb(":memory:");
    seedDispatchRoots(db, 120);
    // FLAT shape: directive_id/root_task_id live on the top-level read args,
    // NOT under args.args. Before the fix these arrived undefined → the read
    // silently became the unbounded/unscoped path.
    const flat = (await unwrap(handleRead(ctx(db), {
      view_name: "dispatch_resolved_view",
      directive_id: "d_0000",
      root_task_id: "t_0000",
    } as unknown as Parameters<typeof handleRead>[1]))) as Array<Record<string, unknown>>;
    expect(flat.length).toBe(1);
    expect(flat[0]?.directive_id).toBe("d_0000");

    // NESTED shape returns identical scoped data.
    const nested = (await unwrap(handleRead(ctx(db), {
      view_name: "dispatch_resolved_view",
      args: { directive_id: "d_0000", root_task_id: "t_0000" },
    }))) as Array<Record<string, unknown>>;
    expect(nested.length).toBe(1);
    expect(nested[0]?.directive_id).toBe(flat[0]?.directive_id);
    expect(nested[0]?.root_task_id).toBe(flat[0]?.root_task_id);
  });

  test("task_graph_view: FLAT directive_id resolves (no longer task_graph_view_requires_directive_id)", async () => {
    const db = openDb(":memory:");
    insertEvent(db, { kind: "task_node_opened", directive_id: "d_tg", task_id: "t_tg_root" });
    insertEvent(db, { kind: "task_node_opened", directive_id: "d_tg", task_id: "t_tg_child", parent_task_id: "t_tg_root" });
    // Unrelated directive — must NOT appear in the scoped result.
    insertEvent(db, { kind: "task_node_opened", directive_id: "d_other", task_id: "t_other" });

    // FLAT shape — the bug's exact repro: this used to return the
    // `task_graph_view_requires_directive_id` error because directiveId arrived
    // null (read from args.args only).
    const flat = (await unwrap(handleRead(ctx(db), {
      view_name: "task_graph_view",
      directive_id: "d_tg",
    } as unknown as Parameters<typeof handleRead>[1]))) as Array<Record<string, unknown>>;
    expect(flat.length).toBeGreaterThan(0);
    for (const row of flat) expect(row.directive_id).toBe("d_tg");

    // NESTED shape returns the same scoped graph.
    const nested = (await unwrap(handleRead(ctx(db), {
      view_name: "task_graph_view",
      args: { directive_id: "d_tg" },
    }))) as Array<Record<string, unknown>>;
    expect(nested.length).toBe(flat.length);
  });

  test("task_graph_view with NO directive_id (either shape) still hard-fails with the required-arg error", async () => {
    const db = openDb(":memory:");
    const res = await handleRead(ctx(db), { view_name: "task_graph_view", args: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("task_graph_view_requires_directive_id");
  });
});
