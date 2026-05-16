// acc2 watch CLI test - daemon SSE plus universal six-pane rendering.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitEvent } from "../runtime/events";
import { sseConnect, mcpCall } from "./rpc";
import { runWatch, renderFrame, renderPanelLines, readPendingDecisions, readDriftSummaries } from "./watch";
import { useSharedDaemon } from "../tests/daemon_fixture";
import { closeDb, openDb } from "../substrate/db";

const MCP_BASE = 38000;
const AUX_BASE = 38500;
const daemon = useSharedDaemon({
  tmpPrefix: "acc2-watch-",
  dbName: "watch.db",
  mcpBase: MCP_BASE,
  auxBase: AUX_BASE,
  portRange: 500,
});

const baseState = () => ({
  events: [],
  active: [],
  ready: [],
  artifacts: [],
  knowledge: [],
  graphRows: [],
  health: {},
});

describe("SSE /events/stream + sseConnect", () => {
  test("sseConnect yields events emitted into the daemon's bus", async () => {
    const abort = new AbortController();
    const received: Array<{ event_id: string; kind: string }> = [];
    const consumer = (async () => {
      for await (const ev of sseConnect({ signal: abort.signal, reconnect: false })) {
        received.push({ event_id: ev.event_id, kind: ev.kind });
        if (received.find((r) => r.kind === "watch_test_synthetic")) break;
      }
    })();

    await new Promise((r) => setTimeout(r, 200));
    emitEvent(daemon.handle().db, {
      kind: "watch_test_synthetic" as never,
      substrate_origin: "substrate_auto",
      payload: { hello: "world" },
    });

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !received.find((r) => r.kind === "watch_test_synthetic")) {
      await new Promise((r) => setTimeout(r, 50));
    }
    abort.abort();
    try { await consumer; } catch { /* swallow */ }
    expect(received.find((r) => r.kind === "watch_test_synthetic")).toBeTruthy();
  }, 15_000);

  test("runtime.recent_events returns events filtered by kind", async () => {
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
    expect(result.events.map((e) => e.payload.i)[0]).toBeLessThan(result.events.map((e) => e.payload.i)[2]!);
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
    expect(result.events[result.events.length - 1]!.kind).toBe("watch_test_any");
  });
});

describe("renderFrame", () => {
  test("renders the universal six-pane shell with SSE event grounding", () => {
    const out = renderFrame({
      ...baseState(),
      events: [{ event_id: "ev_aaa", ts: "2026-05-13T10:30:00.000Z", kind: "directive_opened", directive_id: "d_xyz123456789", task_id: "t_001", payload: { text: "hello" } }],
      health: { pid: 12345, uptime_ms: 1234, events_count: 1, mcp_port: 38000, aux_port: 38001 },
    }, 140, 42);
    expect(out).toContain("Now");
    expect(out).toContain("Decisions");
    expect(out).toContain("Work Graph");
    expect(out).toContain("Evidence");
    expect(out).toContain("Health");
    expect(out).toContain("Diagnostics");
    expect(out).toContain("directive_opened");
    expect(out).toContain("pid=12345");
  });

  test("renders a non-technical wedding-planning directive with the same pane shape", () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    const out = renderFrame({
      ...baseState(),
      ownerProfile: { rendering_signals: { code_density: 0.1, ops_vocabulary: 0.1 }, preferred_terms: [], avoided_terms: [] },
      active: [{ directive_id: "D_WED", opened_ts: recent, text: "plan a wedding for June", lifecycle: "finite", status: "active" }],
      ready: [{ task_id: "T_VENUE", directive_id: "D_WED", goal: "compare venue options", status: "ready" }],
      events: [{ event_id: "ev_decision", ts: recent, kind: "owner_input_required", directive_id: "D_WED", task_id: "T_VENUE", payload: { question: "choose indoor or outdoor?" } }],
      decisions: [{ event_id: "ev_decision", kind: "owner_input_required", target: "choose indoor or outdoor?", anchor: "venue", age_ms: 60_000 }],
      health: {},
    }, 140, 42);
    expect(out).toContain("plan a wedding");
    expect(out).toContain("compare venue options");
    expect(out).toContain("choose indoor or outdoor");
    expect(out).toContain("Work Graph");
    expect(out).not.toContain("code_density=0.10");
  });

  test("renders a technical brain dispatch with ids, residuals, and graph edges in the same pane shape", () => {
    const out = renderFrame({
      ...baseState(),
      ownerProfile: { rendering_signals: { code_density: 1, ops_vocabulary: 0.8 }, preferred_terms: [], avoided_terms: [] },
      events: [
        { event_id: "d_ev", ts: "2026-05-13T10:00:00.000Z", kind: "directive_opened", directive_id: "D1", task_id: "D1", payload: { text: "ship dag tui" } },
        { event_id: "t1_ev", ts: "2026-05-13T10:01:00.000Z", kind: "task_node_opened", directive_id: "D1", task_id: "T1", payload: { goal: "root task" } },
        { event_id: "t2_ev", ts: "2026-05-13T10:02:00.000Z", kind: "task_node_opened", directive_id: "D1", task_id: "T2", payload: { goal: "sub task" } },
        { event_id: "edge_ev", ts: "2026-05-13T10:03:00.000Z", kind: "task_edge_recorded", directive_id: "D1", task_id: "T2", payload: { from_task: "T1", to_task: "T2", kind: "refines" } },
        { event_id: "score_ev", ts: "2026-05-13T10:04:00.000Z", kind: "action_scored", directive_id: "D1", task_id: "T2", payload: { residual: 0.1 } },
      ],
      graphRows: [
        { event_id: "t1_ev", ts: "2026-05-13T10:01:00.000Z", directive_id: "D1", task_id: "T1", row_kind: "node", payload: { goal: "root task" } },
        { event_id: "t2_ev", ts: "2026-05-13T10:02:00.000Z", directive_id: "D1", task_id: "T2", row_kind: "node", payload: { goal: "sub task" } },
        { event_id: "edge_ev", ts: "2026-05-13T10:03:00.000Z", directive_id: "D1", task_id: "T2", row_kind: "edge", payload: { from_task: "T1", to_task: "T2", kind: "refines" } },
      ],
      health: {},
    }, 150, 42);
    expect(out).toContain("code_density=1.00");
    expect(out).toContain("action_scored");
    expect(out).toContain("refines");
    expect(out).toContain("sub task");
  });

  test("renders the brain in-flight line when bridge_invoked is open", () => {
    const out = renderFrame({
      ...baseState(),
      events: [
        { event_id: "inv_ev", ts: new Date(Date.now() - 7000).toISOString(), kind: "bridge_invoked", directive_id: "D1", task_id: "T1", payload: {} },
        { event_id: "intent_ev", ts: new Date(Date.now() - 6000).toISOString(), kind: "action_predicted", directive_id: "D1", task_id: "T1", payload: { intent: "audit substrate dataflow holes" } },
        { event_id: "msg_ev", ts: new Date(Date.now() - 2000).toISOString(), kind: "brain_message_emitted", directive_id: "D1", task_id: "T1", payload: { text: "reasoning step three" } },
      ],
      health: {},
    }, 150, 42);
    expect(out).toContain("brain in flight");
    expect(out).toContain("audit substrate dataflow holes");
    expect(out).toContain("reasoning step three");
  });
});

describe("operator panes", () => {
  test("health pane renders pid, hotreload, trust, rolling reviews, and stakeholders", () => {
    const lines = renderPanelLines({
      ...baseState(),
      health: {
        pid: 99, uptime_ms: 12345, events_count: 7, mcp_port: 38000, aux_port: 38001,
        stuck_workers: [{ worker: "embedder", last_tick_ms_ago: 99999 }],
        hotreload: { watched_module_count: 3, reload_total: 2, failure_total: 1, last_failure: { ts: "2026-05-15T10:00:00.000Z", module: "runtime/x.ts", reason: "syntax error" } },
      },
      trust: {
        autonomy_score: 0.42,
        recipes_extracted: 7, recipes_replayed_success: 3, recipes_replayed_aborted: 1,
        knowledge_promoted_7d: 5, knowledge_demoted_7d: 1,
        artifacts_promoted_recent: [],
        closure_residual_7d: { avg: 0.18, min: 0.05, max: 0.42, count: 9 },
        amendments_7d: { applied: 4, failed: 1, refused: 0 },
        recommendation: "trust looks healthy",
      },
      rollingReviews: [{ past_due: 1 }],
      stakeholders: [{ stakeholder_id: "family" }],
    }, "health", 160).join("\n");
    expect(lines).toContain("pid=99");
    expect(lines).toContain("stuck worker");
    expect(lines).toContain("embedder");
    expect(lines).toContain("hotreload");
    expect(lines).toContain("last_failure");
    expect(lines).toContain("syntax error");
    expect(lines).toContain("autonomy_score=0.42");
    expect(lines).toContain("rolling reviews due=1/1");
    expect(lines).toContain("stakeholder_state_view rows=1");
  });

  test("readPendingDecisions joins unresolved owner_input_required + owner-gated repo amendments", () => {
    const dir = mkdtempSync(join(tmpdir(), "acc2-watch-decisions-"));
    const dbPath = join(dir, "decisions.db");
    try {
      const db = openDb(dbPath);
      const insert = (id: string, kind: string, payload: object, context_refs: unknown[] = []) =>
        db.run(`INSERT INTO events (id, ts, directive_id, task_id, loop_id, substrate_origin, kind, payload, context_refs)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, new Date(Date.now() - 60_000).toISOString(), "d_t", "t_t", "loop", "test", kind, JSON.stringify(payload), JSON.stringify(context_refs)]);
      insert("dir_opened", "directive_opened", { text: "test directive" });
      insert("oir_pending", "owner_input_required", { question: "stay open?" });
      insert("oir_resolved", "owner_input_required", { question: "answered already?" });
      insert("dec_for_resolved", "owner_decision_recorded", { decision: "yes" }, ["oir_resolved"]);
      insert("amp_gated", "contract_amendment_proposed", { target_resource: "repo:CLAUDE.md", anchor: "x" });
      insert("amp_ungated", "contract_amendment_proposed", { target_resource: "repo:runtime/foo.ts", anchor: "y" });
      const out = readPendingDecisions(db, Date.now());
      const ids = out.map((d) => d.event_id);
      expect(ids).toContain("oir_pending");
      expect(ids).toContain("amp_gated");
      expect(ids).not.toContain("oir_resolved");
      expect(ids).not.toContain("amp_ungated");
      const drifts = readDriftSummaries(db, dir, 5);
      expect(drifts.length).toBeGreaterThanOrEqual(1);
      expect(drifts[0]!.directive_id).toBe("d_t");
    } finally {
      closeDb(dbPath);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runWatch programmatic", () => {
  test("runWatch buffers events and renders the kind text", async () => {
    emitEvent(daemon.handle().db, {
      kind: "watch_test_runwatch" as never,
      substrate_origin: "substrate_auto",
      payload: { hello: "watch" },
    });

    const buffer: string[] = [];
    await runWatch([], { durationMs: 500, writer: (s) => { buffer.push(s); }, pollIntervalMs: 10_000 });

    const joined = buffer.join("");
    expect(joined).toContain("Now");
    expect(joined).toContain("watch_test_runwatch");
  }, 15_000);

  test("runWatch picks up SSE events emitted DURING the run", async () => {
    const buffer: string[] = [];
    setTimeout(() => {
      try {
        emitEvent(daemon.handle().db, {
          kind: "watch_test_inflight" as never,
          substrate_origin: "substrate_auto",
          payload: { stage: "mid_run" },
        });
      } catch { /* swallow */ }
    }, 250);

    await runWatch([], { durationMs: 1200, writer: (s) => { buffer.push(s); }, pollIntervalMs: 10_000 });
    expect(buffer.join("")).toContain("watch_test_inflight");
  }, 15_000);
});
