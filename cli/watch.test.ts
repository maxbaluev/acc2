// acc2 watch CLI test — boot a daemon on free ports, subscribe via sseConnect,
// emit a synthetic event, assert the SSE client sees it within 2s; drive
// runWatch programmatically with a captured buffer and assert the event kind
// shows up in the rendered output.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../substrate/db";
import { startDaemon, stopDaemon, type DaemonHandle } from "../runtime/daemon";
import { emitEvent } from "../runtime/events";
import { sseConnect, mcpCall } from "./rpc";
import { runWatch, renderFrame } from "./watch";

// Disjoint port band from dispatch.test.ts (12000/17000) and daemon.test.ts
// (30000/31000) and runtime/*.test.ts ([19000, 60000)) — choose [38000, 39500).
const MCP_BASE = 38000;
const AUX_BASE = 38500;
const pickMcp = () => MCP_BASE + Math.floor(Math.random() * 500);
const pickAux = () => AUX_BASE + Math.floor(Math.random() * 500);

let handle: DaemonHandle | null = null;
let dir = "";
let prevPort: string | undefined;
let prevAuxPort: string | undefined;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "acc2-watch-"));
  const port = pickMcp();
  const auxPort = pickAux();
  handle = await startDaemon({
    port, auxPort, stateDbPath: join(dir, "watch.db"),
    socketFile: join(dir, "v2.sock"), tokenFile: join(dir, "v2.sock.token"),
  });
  prevPort = process.env.V2_DAEMON_PORT;
  prevAuxPort = process.env.V2_DAEMON_AUX_PORT;
  process.env.V2_DAEMON_PORT = String(port);
  process.env.V2_DAEMON_AUX_PORT = String(auxPort);
});

afterEach(async () => {
  if (handle) await stopDaemon(handle);
  handle = null;
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  if (prevPort === undefined) delete process.env.V2_DAEMON_PORT;
  else process.env.V2_DAEMON_PORT = prevPort;
  if (prevAuxPort === undefined) delete process.env.V2_DAEMON_AUX_PORT;
  else process.env.V2_DAEMON_AUX_PORT = prevAuxPort;
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
    emitEvent(handle!.db, {
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
      emitEvent(handle!.db, {
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
    emitEvent(handle!.db, {
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
});

describe("runWatch programmatic", () => {
  test("runWatch buffers events and renders the kind text", async () => {
    // Pre-emit a watcher event so the initial recent_events fill captures it.
    emitEvent(handle!.db, {
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

    // Fire-and-forget: emit a synthetic event ~500ms into the run, after the
    // SSE consumer has had time to subscribe. Bumped from 200→500ms +
    // durationMs 1200→3000 to be robust against parallel-test IO contention.
    setTimeout(() => {
      try {
        emitEvent(handle!.db, {
          kind: "watch_test_inflight" as never,
          substrate_origin: "substrate_auto",
          payload: { stage: "mid_run" },
        });
      } catch { /* swallow */ }
    }, 500);

    await runWatch([], { durationMs: 3000, writer, pollIntervalMs: 10_000 });

    const joined = buffer.join("");
    expect(joined).toContain("watch_test_inflight");
  }, 15_000);
});
