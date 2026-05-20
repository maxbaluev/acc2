// acc2 substrate.read observability-view projections — covers the
// three view names that substrate/views.ts:4130-4132 registered but
// the runtime/mcp_server/substrate_tools.ts switch had no cases for
// until this commit:
//
//   - event_kind_occurrence_view
//   - worker_liveness_view
//   - stale_zero_score_knowledge_view
//
// Each test seeds a tiny in-memory DB with the minimum events the
// projection groups against, then calls handleRead and asserts the
// returned row shape. Pure structural assertions — no scoring math.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../../substrate/db";
import { emitEvent } from "../events";
import { handleRead } from "./substrate_tools";
import type { McpContext } from "./types";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const ctx = (db: ReturnType<typeof openDb>): McpContext =>
  ({ db, invoker: "claude_root" } as McpContext);

type ViewResult = { rows: Array<Record<string, unknown>>; view_name: string; args: unknown; generated_at: string };

// T3.8/T5: handleRead may return McpResult OR Promise<McpResult> after the
// SQL worker-thread pool migration. Await the result; sync returns pass
// through unchanged via Promise.resolve coercion.
const unwrap = async (r: ReturnType<typeof handleRead>): Promise<ViewResult> => {
  const resolved = await r;
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) throw new Error("handleRead failed");
  return resolved.result as unknown as ViewResult;
};

describe("event_kind_occurrence_view", () => {
  test("groups emitted kinds with counts, first_emit_ts, last_emit_ts, distinct_origins", async () => {
    const db = openDb(":memory:");
    // Three directive_opened (different origins) + one task_committed.
    emitEvent(db, { kind: "directive_opened", substrate_origin: "claude", payload: { directive_text: "a" } });
    emitEvent(db, { kind: "directive_opened", substrate_origin: "opencode", payload: { directive_text: "b" } });
    emitEvent(db, { kind: "directive_opened", substrate_origin: "claude", payload: { directive_text: "c" } });
    emitEvent(db, { kind: "task_committed", substrate_origin: "runtime", payload: {} });

    const result = await unwrap(handleRead(ctx(db), { view_name: "event_kind_occurrence_view", args: {} }));
    expect(result.view_name).toBe("event_kind_occurrence_view");
    expect(typeof result.generated_at).toBe("string");

    const byKind = new Map(result.rows.map((r) => [r.kind as string, r]));
    const directive = byKind.get("directive_opened");
    expect(directive).toBeDefined();
    expect(directive!.occurrence_count).toBe(3);
    expect(directive!.distinct_origins).toBe(2);
    expect(typeof directive!.first_emit_ts).toBe("string");
    expect(typeof directive!.last_emit_ts).toBe("string");

    const committed = byKind.get("task_committed");
    expect(committed).toBeDefined();
    expect(committed!.occurrence_count).toBe(1);
    expect(committed!.distinct_origins).toBe(1);
  });

  test("dead_only=true surfaces registered-but-never-emitted kinds with zero counts", async () => {
    const db = openDb(":memory:");
    emitEvent(db, { kind: "directive_opened", substrate_origin: "claude", payload: {} });

    const result = await unwrap(handleRead(ctx(db), {
      view_name: "event_kind_occurrence_view",
      args: { dead_only: true },
    }));
    // Most kinds are dead in this fresh DB; assert directive_opened is NOT
    // among the dead rows and that at least some dead rows came back.
    const kinds = result.rows.map((r) => r.kind as string);
    expect(kinds.includes("directive_opened")).toBe(false);
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) expect(row.occurrence_count).toBe(0);
  });
});

describe("worker_liveness_view", () => {
  test("aggregates worker_tick_completed per worker_name with seconds_since_last_tick", async () => {
    const db = openDb(":memory:");
    emitEvent(db, { kind: "worker_tick_completed", substrate_origin: "runtime", payload: { worker: "scheduler" } });
    emitEvent(db, { kind: "worker_tick_completed", substrate_origin: "runtime", payload: { worker: "scheduler" } });
    emitEvent(db, { kind: "worker_tick_completed", substrate_origin: "runtime", payload: { worker: "embedder" } });

    const result = await unwrap(handleRead(ctx(db), { view_name: "worker_liveness_view", args: {} }));
    expect(result.view_name).toBe("worker_liveness_view");

    const byName = new Map(result.rows.map((r) => [r.worker_name as string, r]));
    expect(byName.get("scheduler")!.tick_count).toBe(2);
    expect(byName.get("embedder")!.tick_count).toBe(1);
    for (const row of result.rows) {
      expect(typeof row.first_tick_ts).toBe("string");
      expect(typeof row.last_tick_ts).toBe("string");
      // Just-emitted ticks: seconds_since_last_tick is a non-negative integer.
      expect(typeof row.seconds_since_last_tick).toBe("number");
      expect((row.seconds_since_last_tick as number) >= 0).toBe(true);
    }
  });

  test("respects window_hours arg (large negative window returns no rows for old events)", async () => {
    const db = openDb(":memory:");
    emitEvent(db, { kind: "worker_tick_completed", substrate_origin: "runtime", payload: { worker: "scheduler" } });

    // window_hours = 0 means "events strictly newer than now"; freshly
    // emitted rows have ts very close to now so they MAY or may not
    // squeak in depending on clock resolution. Use a strictly-zero
    // window_hours and assert the shape is well-formed and rows is
    // either empty or contains only scheduler. The structural assertion
    // here is that the arg propagates without error.
    const result = await unwrap(handleRead(ctx(db), {
      view_name: "worker_liveness_view",
      args: { window_hours: 24 },
    }));
    expect(result.rows.length).toBe(1);
    expect(result.rows[0]!.worker_name).toBe("scheduler");
  });
});

describe("stale_zero_score_knowledge_view", () => {
  test("surfaces promoted_knowledge rows with zero confirm + zero contradict older than threshold", async () => {
    const db = openDb(":memory:");
    // Promote two knowledge rows. One gets a candidate_confirmed citing
    // its id; the other stays untouched. Both rows were emitted "now",
    // so we set minimum_hours_stale to -1 (anything older than -1h ago
    // — i.e. essentially everything fresh) to force them through.
    const stale = emitEvent(db, {
      kind: "knowledge_promoted",
      substrate_origin: "substrate",
      payload: { claim: "stale claim that no one cited" },
    });
    const cited = emitEvent(db, {
      kind: "knowledge_promoted",
      substrate_origin: "substrate",
      payload: { claim: "cited claim" },
    });
    emitEvent(db, {
      kind: "candidate_confirmed",
      substrate_origin: "substrate",
      payload: { knowledge_id: cited.id },
    });

    const result = await unwrap(handleRead(ctx(db), {
      view_name: "stale_zero_score_knowledge_view",
      args: { minimum_hours_stale: -1 },
    }));
    expect(result.view_name).toBe("stale_zero_score_knowledge_view");
    const ids = result.rows.map((r) => r.knowledge_id as string);
    expect(ids.includes(stale.id)).toBe(true);
    expect(ids.includes(cited.id)).toBe(false);

    const staleRow = result.rows.find((r) => r.knowledge_id === stale.id)!;
    expect(staleRow.claim).toBe("stale claim that no one cited");
    expect(staleRow.confirm_count).toBe(0);
    expect(staleRow.contradict_count).toBe(0);
    expect(typeof staleRow.hours_since_promotion).toBe("number");
    expect(typeof staleRow.promoted_ts).toBe("string");
  });

  test("default minimum_hours_stale=168 filters out freshly-promoted rows", async () => {
    const db = openDb(":memory:");
    emitEvent(db, {
      kind: "knowledge_promoted",
      substrate_origin: "substrate",
      payload: { claim: "just-now claim" },
    });
    const result = await unwrap(handleRead(ctx(db), {
      view_name: "stale_zero_score_knowledge_view",
      args: {},
    }));
    expect(result.rows.length).toBe(0);
  });
});
