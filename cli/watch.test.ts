// acc2 watch CLI test — boot a daemon on free ports, subscribe via sseConnect,
// emit a synthetic event, assert the SSE client sees it within 2s; drive
// runWatch programmatically with a captured buffer and assert the event kind
// shows up in the rendered output.

import { describe, expect, test } from "bun:test";
import { emitEvent } from "../runtime/events";
import { sseConnect, mcpCall } from "./rpc";
import { runWatch, renderFrame } from "./watch";
import { useSharedDaemon } from "../tests/daemon_fixture";

// Disjoint port band from dispatch.test.ts (12000/17000) and daemon.test.ts
// (30000/31000) and runtime/*.test.ts ([19000, 60000)) — choose [38000, 39500).
const MCP_BASE = 38000;
const AUX_BASE = 38500;
const daemon = useSharedDaemon({
  tmpPrefix: "acc2-watch-",
  dbName: "watch.db",
  mcpBase: MCP_BASE,
  auxBase: AUX_BASE,
  portRange: 500,
});

describe("SSE /events/stream + sseConnect", () => {
  test("sseConnect yields events emitted into the daemon's bus", async () => {
    // Spin up the consumer first so the bus subscriber is in place before we
    // emit the synthetic event.
    const abort = new AbortController();
    const received: Array<{ event_id: string; kind: string }> = [];
    const consumer = (async () => {
      for await (const ev of sseConnect({ signal: abort.signal, reconnect: false })) {
        received.push({ event_id: ev.event_id, kind: ev.kind });
        if (received.find((r) => r.kind === "watch_test_synthetic")) break;
      }
    })();

    // Give the consumer a beat to connect + register the bus subscriber.
    await new Promise((r) => setTimeout(r, 200));

    // Emit a synthetic event directly into the daemon's db.
    emitEvent(daemon.handle().db, {
      kind: "watch_test_synthetic" as never,
      substrate_origin: "substrate_auto",
      payload: { hello: "world" },
    });

    // Wait up to 2s for the SSE client to receive it.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !received.find((r) => r.kind === "watch_test_synthetic")) {
      await new Promise((r) => setTimeout(r, 50));
    }
    abort.abort();
    try { await consumer; } catch { /* swallow */ }

    expect(received.find((r) => r.kind === "watch_test_synthetic")).toBeTruthy();
  }, 15_000);

  test("runtime.recent_events returns events filtered by kind", async () => {
    // Pre-populate three synthetic events, with a small delay so the
    // millisecond-granularity ts strings stay distinct (the DB ORDER BY ts
    // is then deterministic).
    for (let i = 0; i < 3; i++) {
      emitEvent(daemon.handle().db, {
        kind: "watch_test_seed" as never,
        substrate_origin: "substrate_auto",
        payload: { i },
      });
      await new Promise((r) => setTimeout(r, 5));
    }
    const env = await mcpCall("runtime.recent_events", { k: 10, kinds: ["watch_test_seed"] });
    expect(env.ok).toBe(true);
    const result = (env as { ok: true; result: { events: Array<{ kind: string; payload: { i: number } }> } }).result;
    expect(result.events.length).toBe(3);
    for (const e of result.events) expect(e.kind).toBe("watch_test_seed");
    // Order is ts-ASC; with the inter-emit delay, i=0 must come before i=2.
    const indices = result.events.map((e) => e.payload.i);
    expect(indices[0]).toBeLessThan(indices[2]!);
  });

  test("runtime.recent_events without kinds returns the most recent K across all kinds", async () => {
    emitEvent(daemon.handle().db, {
      kind: "watch_test_any" as never,
      substrate_origin: "substrate_auto",
      payload: {},
    });
    const env = await mcpCall("runtime.recent_events", { k: 5 });
    expect(env.ok).toBe(true);
    const result = (env as { ok: true; result: { events: Array<{ kind: string }> } }).result;
    expect(result.events.length).toBeGreaterThanOrEqual(1);
    // The most recent event should be the watch_test_any we just emitted.
    expect(result.events[result.events.length - 1]!.kind).toBe("watch_test_any");
  });
});

describe("renderFrame", () => {
  test("renders events region with kind text", () => {
    const state = {
      events: [
        {
          event_id: "ev_aaa",
          ts: "2026-05-13T10:30:00.000Z",
          kind: "directive_opened",
          directive_id: "d_xyz123456789",
          task_id: "t_001",
          payload: { text: "hello" },
        },
      ],
      active: [],
      ready: [],
      artifacts: [],
      health: { pid: 12345, uptime_ms: 1234, events_count: 1, mcp_port: 38000, aux_port: 38001 },
    };
    const out = renderFrame(state, 120, 40);
    expect(out).toContain("directive_opened");
    expect(out).toContain("Recent Events");
    expect(out).toContain("Daemon");
    expect(out).toContain("pid=12345");
  });

  test("handles a tall event buffer by showing only the tail", () => {
    const events = Array.from({ length: 60 }, (_, i) => ({
      event_id: `ev_${i}`,
      ts: "2026-05-13T10:30:00.000Z",
      kind: `kind_${i}`,
      directive_id: `d_${i}`,
      task_id: `t_${i}`,
      payload: {},
    }));
    const state = {
      events,
      active: [],
      ready: [],
      artifacts: [],
      health: {},
    };
    const out = renderFrame(state, 120, 40);
    // The latest event (kind_59) MUST be visible; the oldest (kind_0) MUST not.
    expect(out).toContain("kind_59");
    expect(out.includes("kind_0 ")).toBe(false);
  });

  test("renders the brain in-flight panel when bridge_invoked is open", () => {
    const state = {
      events: [
        { event_id: "inv_ev", ts: new Date(Date.now() - 7000).toISOString(), kind: "bridge_invoked", directive_id: "D1", task_id: "T1", payload: {} },
        { event_id: "intent_ev", ts: new Date(Date.now() - 6000).toISOString(), kind: "action_predicted", directive_id: "D1", task_id: "T1", payload: { intent: "audit substrate dataflow holes" } },
        { event_id: "msg_ev", ts: new Date(Date.now() - 2000).toISOString(), kind: "brain_message_emitted", directive_id: "D1", task_id: "T1", payload: { text: "reasoning step three: cross-checking views" } },
      ],
      active: [], ready: [], artifacts: [], health: {},
    };
    const out = renderFrame(state, 140, 40);
    expect(out).toContain("BRAIN");
    expect(out).toContain("audit substrate dataflow holes");
    expect(out).toContain("reasoning step three");
  });

  test("suppresses brain in-flight panel when bridge_completed lands", () => {
    const state = {
      events: [
        { event_id: "inv_ev", ts: "2026-05-13T10:00:00.000Z", kind: "bridge_invoked", directive_id: "D1", task_id: "T1", payload: {} },
        { event_id: "done_ev", ts: "2026-05-13T10:01:00.000Z", kind: "bridge_completed", directive_id: "D1", task_id: "T1", payload: {} },
      ],
      active: [], ready: [], artifacts: [], health: {},
    };
    const out = renderFrame(state, 140, 40);
    expect(out).not.toContain("BRAIN ⚡");
  });

  test("renders DAG view as canonical entry surface (brain audit bs00e26fx)", () => {
    const state = {
      events: [
        { event_id: "d_ev", ts: "2026-05-13T10:00:00.000Z", kind: "directive_opened", directive_id: "D1", task_id: "D1", payload: { text: "ship dag tui" } },
        { event_id: "t1_ev", ts: "2026-05-13T10:01:00.000Z", kind: "task_node_opened", directive_id: "D1", task_id: "T1", payload: { goal: "root task" } },
        { event_id: "t2_ev", ts: "2026-05-13T10:02:00.000Z", kind: "task_node_opened", directive_id: "D1", task_id: "T2", payload: { goal: "sub task" } },
        { event_id: "edge_ev", ts: "2026-05-13T10:03:00.000Z", kind: "task_edge_recorded", directive_id: "D1", task_id: "T2", payload: { from_task: "T1", to_task: "T2", kind: "refines" } },
        { event_id: "score_ev", ts: "2026-05-13T10:04:00.000Z", kind: "action_scored", directive_id: "D1", task_id: "T2", payload: { residual: 0.1 } },
      ],
      active: [], ready: [], artifacts: [], health: {},
    };
    const out = renderFrame(state, 140, 40);
    expect(out).toContain("Task DAG");
    expect(out).toContain("ship dag tui");
    // sub task is reachable via "refines T1->T2" edge labeling
    expect(out).toContain("sub task");
    expect(out).toContain("refines");
    expect(out).toContain("action_scored");
  });
});

describe("runWatch programmatic", () => {
  test("runWatch buffers events and renders the kind text", async () => {
    // Pre-emit a watcher event so the initial recent_events fill captures it.
    emitEvent(daemon.handle().db, {
      kind: "watch_test_runwatch" as never,
      substrate_origin: "substrate_auto",
      payload: { hello: "watch" },
    });

    const buffer: string[] = [];
    const writer = (s: string) => { buffer.push(s); };

    // Run for 500ms with poll=10s (so the side-region poll never fires inside
    // the window). The initial render + SSE subscription should both flow.
    await runWatch([], { durationMs: 500, writer, pollIntervalMs: 10_000 });

    const joined = buffer.join("");
    expect(joined).toContain("Recent Events");
    expect(joined).toContain("watch_test_runwatch");
  }, 15_000);

  test("runWatch picks up SSE events emitted DURING the run", async () => {
    const buffer: string[] = [];
    const writer = (s: string) => { buffer.push(s); };

    // Fire-and-forget: emit after the SSE consumer has had time to subscribe.
    setTimeout(() => {
      try {
        emitEvent(daemon.handle().db, {
          kind: "watch_test_inflight" as never,
          substrate_origin: "substrate_auto",
          payload: { stage: "mid_run" },
        });
      } catch { /* swallow */ }
    }, 250);

    await runWatch([], { durationMs: 1200, writer, pollIntervalMs: 10_000 });

    const joined = buffer.join("");
    expect(joined).toContain("watch_test_inflight");
  }, 15_000);
});
