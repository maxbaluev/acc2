// acc2 watch CLI test — boot a daemon on free ports, subscribe via sseConnect,
// emit a synthetic event, assert the SSE client sees it within 2s; drive
// runWatch programmatically with a captured buffer and assert the event kind
// shows up in the rendered output.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitEvent } from "../runtime/events";
import { sseConnect, mcpCall } from "./rpc";
import { runWatch, renderFrame, renderPanelLines, readPendingDecisions, readDriftSummaries } from "./watch";
import { useSharedDaemon } from "../tests/daemon_fixture";
import { closeDb, openDb } from "../substrate/db";
import type { TrustMetrics } from "./trust";

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
    expect(out).toContain("Event Log");
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

describe("operator dashboard panels", () => {
  const makeTrust = (overrides: Partial<TrustMetrics> = {}): TrustMetrics => ({
    autonomy_score: 0.42,
    recipes_extracted: 7, recipes_replayed_success: 3, recipes_replayed_aborted: 1,
    knowledge_promoted_7d: 5, knowledge_demoted_7d: 1,
    artifacts_promoted_recent: [{ artifact_id: "art_abc123", ts: "2026-05-15T10:00:00.000Z", summary: "useful artifact" }],
    closure_residual_7d: { avg: 0.18, min: 0.05, max: 0.42, count: 9 },
    amendments_7d: { applied: 4, failed: 1, refused: 0 },
    recommendation: "trust looks healthy; consider raising father --max-cycles",
    ...overrides,
  });

  test("trust panel renders autonomy_score line", () => {
    const state = {
      events: [], active: [], ready: [], artifacts: [], health: {},
      view: "trust" as const,
      trust: makeTrust(),
      decisions: [], drift: [],
    };
    const out = renderFrame(state, 140, 40);
    expect(out).toContain("autonomy_score");
    expect(out).toContain("0.42");
    expect(out).toContain("recipes");
    expect(out).toContain("closure_residual");
    expect(out).toContain("recommendation");
    // Footer surfaces the first word of the recommendation.
    expect(out).toContain("trust=trust");
  });

  test("decisions panel renders pending HIDL + owner-gated amendment events", () => {
    const now = Date.now();
    const state = {
      events: [], active: [], ready: [], artifacts: [], health: {},
      view: "decisions" as const,
      decisions: [
        { event_id: "ev_hidl_001abcdef", kind: "hidl_action_required", target: "review proposal", anchor: "approve commit X?", age_ms: 3 * 60_000 },
        { event_id: "ev_oir_002defabc", kind: "owner_input_required", target: "language preference", anchor: "russian or english?", age_ms: 30 * 60_000 },
        { event_id: "ev_am_003fedcba", kind: "contract_amendment_proposed", target: "CLAUDE.md", anchor: "owner-facing chat language", age_ms: 5 * 3_600_000 },
      ],
      drift: [], trust: makeTrust(),
    };
    void now;
    const out = renderFrame(state, 160, 40);
    expect(out).toContain("Pending owner decisions");
    expect(out).toContain("hidl_action_required");
    expect(out).toContain("owner_input_required");
    expect(out).toContain("contract_amendment_proposed");
    expect(out).toContain("CLAUDE.md");
    expect(out).toContain("decisions=3");
  });

  test("verify drift panel renders directive summaries with drift/missing counts", () => {
    const state = {
      events: [], active: [], ready: [], artifacts: [], health: {},
      view: "drift" as const,
      drift: [
        { directive_id: "d_aaa11111", status: "committed", applied: 5, failed: 0, refused: 0, stranded: 0, drift: 2, missing: 1 },
        { directive_id: "d_bbb22222", status: "in-flight", applied: 1, failed: 0, refused: 0, stranded: 1, drift: 0, missing: 0 },
        { directive_id: "d_ccc33333", status: "committed", applied: 3, failed: 0, refused: 0, stranded: 0, drift: 0, missing: 0 },
      ],
      decisions: [], trust: makeTrust(),
    };
    const out = renderFrame(state, 160, 40);
    expect(out).toContain("Verify drift");
    // Directive ids are truncated to 8 chars in the table column.
    expect(out).toContain("d_aaa111");
    expect(out).toContain("d_bbb222");
    expect(out).toContain("d_ccc333");
    // Footer aggregates drift+missing across all directives (2+1 = 3).
    expect(out).toContain("drift=3");
  });

  test("readPendingDecisions joins unresolved owner_input_required + owner-gated amendments", () => {
    const dir = mkdtempSync(join(tmpdir(), "acc2-watch-decisions-"));
    const dbPath = join(dir, "decisions.db");
    try {
      const db = openDb(dbPath);
      const insert = (id: string, kind: string, payload: object, context_refs: unknown[] = []) =>
        db.run(`INSERT INTO events (id, ts, directive_id, task_id, loop_id, substrate_origin, kind, payload, context_refs)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, new Date(Date.now() - 60_000).toISOString(), "d_t", "t_t", "loop", "test", kind, JSON.stringify(payload), JSON.stringify(context_refs)]);
      // Anchor a directive_opened so readDriftSummaries finds the directive.
      insert("dir_opened", "directive_opened", { text: "test directive" });
      insert("oir_pending", "owner_input_required", { question: "stay open?" });
      insert("oir_resolved", "owner_input_required", { question: "answered already?" });
      insert("dec_for_resolved", "owner_decision_recorded", { decision: "yes" }, ["oir_resolved"]);
      insert("amp_gated", "contract_amendment_proposed", { target: "CLAUDE.md", anchor: "x" });
      insert("amp_ungated", "contract_amendment_proposed", { target: "runtime/foo.ts", anchor: "y" });
      const out = readPendingDecisions(db, Date.now());
      const ids = out.map((d) => d.event_id);
      expect(ids).toContain("oir_pending");
      expect(ids).toContain("amp_gated");
      expect(ids).not.toContain("oir_resolved");
      expect(ids).not.toContain("amp_ungated");
      // readDriftSummaries on the same DB produces a row for d_t (no commits in dir, so verify is harmless).
      const drifts = readDriftSummaries(db, dir, 5);
      expect(drifts.length).toBeGreaterThanOrEqual(1);
      expect(drifts[0]!.directive_id).toBe("d_t");
    } finally {
      closeDb(dbPath); // close ONLY our path so the daemon fixture's cached db survives
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("renderPanelLines health view renders pid + hotreload section", () => {
    const lines = renderPanelLines({
      events: [], active: [], ready: [], artifacts: [], health: {
        pid: 99, uptime_ms: 12345, events_count: 7, mcp_port: 38000, aux_port: 38001,
        stuck_workers: [{ worker: "embedder", last_tick_ms_ago: 99999 }],
        hotreload: { watched_module_count: 3, reload_total: 2, failure_total: 1, last_failure: { ts: "2026-05-15T10:00:00.000Z", module: "runtime/x.ts", reason: "syntax error" } },
      } as unknown as Parameters<typeof renderPanelLines>[0]["health"],
    } as Parameters<typeof renderPanelLines>[0], "health", 160);
    const joined = lines.join("\n");
    expect(joined).toContain("pid=99");
    expect(joined).toContain("stuck workers");
    expect(joined).toContain("embedder");
    expect(joined).toContain("hotreload");
    expect(joined).toContain("last_failure");
    expect(joined).toContain("syntax error");
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
    expect(joined).toContain("Event Log");
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
