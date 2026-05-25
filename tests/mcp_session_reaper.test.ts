// acc2 MCP session reaper tests (2026-05-23, owner-directed reliability fix).
//
// ROOT CAUSE under test: fastmcp's httpStream transport leaks one
// FastMCPSession per ungracefully-closed client; sessions accumulate in
// `server.sessions` forever and peg daemon CPU. The reaper force-closes
// dead / idle / over-cap sessions (which triggers fastmcp's own
// splice-from-#sessions cleanup) and emits mcp_sessions_reaped.
//
// Cases:
//   A. DEAD session pruned (transport gone), LIVE recent session kept.
//   B. IDLE session past TTL pruned; fresh session within TTL kept.
//   C. OVER-CAP eviction: surplus oldest-first reaped down to the cap.
//   D. Graceful disconnect drops the tracking row (no false idle-reap).
//   E. runMcpSessionReaperTick emits mcp_sessions_reaped only when ≥1 reaped.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import {
  McpSessionReaper,
  runMcpSessionReaperTick,
  type ReapableServer,
  type ReapableSession,
} from "../runtime/mcp_session_reaper";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const NOW = Date.now();

/** A controllable mock session. `transport` undefined ⇒ DEAD (closed). */
class MockSession implements ReapableSession {
  closed = false;
  server: { transport?: unknown };
  constructor(opts: { dead?: boolean } = {}) {
    this.server = { transport: opts.dead ? undefined : {} };
  }
  async close(): Promise<void> {
    this.closed = true;
    // Mirror fastmcp: closing severs the underlying transport.
    this.server = { transport: undefined };
  }
}

const serverOf = (sessions: ReapableSession[]): ReapableServer => ({ sessions });

describe("mcp_session_reaper", () => {
  test("(A) dead session pruned, live recent session kept", async () => {
    const reaper = new McpSessionReaper({ idleTtlMs: 60_000, maxSessions: 1000 });
    const dead = new MockSession({ dead: true });
    const live = new MockSession();
    const result = await reaper.reapOnce(serverOf([dead, live]), NOW);

    expect(result.reaped_dead).toBe(1);
    expect(result.reaped_idle).toBe(0);
    expect(result.reaped_over_cap).toBe(0);
    expect(result.remaining).toBe(1);
    expect(dead.closed).toBe(true);
    expect(live.closed).toBe(false);
  });

  test("(B) idle session past TTL pruned; fresh session kept", async () => {
    const idleTtlMs = 60_000;
    const reaper = new McpSessionReaper({ idleTtlMs, maxSessions: 1000 });
    const stale = new MockSession();
    const fresh = new MockSession();

    // Observe `stale` well in the past so its first-seen clock has aged out.
    reaper.noteConnect(stale, NOW - idleTtlMs - 5_000);
    // `fresh` is first observed THIS tick (noteConnect inside reapOnce).
    const result = await reaper.reapOnce(serverOf([stale, fresh]), NOW);

    expect(result.reaped_idle).toBe(1);
    expect(result.reaped_dead).toBe(0);
    expect(stale.closed).toBe(true);
    expect(fresh.closed).toBe(false);
    expect(result.remaining).toBe(1);
  });

  test("(C) over-cap eviction reaps oldest-first down to the cap", async () => {
    const reaper = new McpSessionReaper({ idleTtlMs: 60 * 60_000, maxSessions: 2 });
    const a = new MockSession(); // oldest
    const b = new MockSession();
    const c = new MockSession();
    const d = new MockSession(); // newest
    reaper.noteConnect(a, NOW - 4_000);
    reaper.noteConnect(b, NOW - 3_000);
    reaper.noteConnect(c, NOW - 2_000);
    reaper.noteConnect(d, NOW - 1_000);

    const result = await reaper.reapOnce(serverOf([a, b, c, d]), NOW);

    // 4 sessions, cap 2, none dead/idle ⇒ evict 2 oldest (a, b).
    expect(result.reaped_over_cap).toBe(2);
    expect(result.remaining).toBe(2);
    expect(a.closed).toBe(true);
    expect(b.closed).toBe(true);
    expect(c.closed).toBe(false);
    expect(d.closed).toBe(false);
  });

  test("(D) graceful disconnect drops tracking row — no false idle reap", async () => {
    const idleTtlMs = 60_000;
    const reaper = new McpSessionReaper({ idleTtlMs, maxSessions: 1000 });
    const s = new MockSession();
    // Observed long ago...
    reaper.noteConnect(s, NOW - idleTtlMs - 10_000);
    // ...but fastmcp emits disconnect (graceful close already spliced it).
    reaper.noteDisconnect(s);
    // A *new* session object reuses nothing; fastmcp's array no longer has `s`.
    const fresh = new MockSession();
    const result = await reaper.reapOnce(serverOf([fresh]), NOW);

    expect(result.total).toBe(1);
    expect(result.reaped_idle).toBe(0);
    expect(result.reaped_dead).toBe(0);
    expect(fresh.closed).toBe(false);
  });

  test("(F) actively-served long-lived session is NOT reaped despite an ancient connect time", async () => {
    // The root-cause regression: the operator's chat holds one Streamable-HTTP
    // session for hours. Age-based reaping culled it every ~10 min mid-use.
    // Activity-based idle keeps it while it is served.
    const idleTtlMs = 60_000;
    const reaper = new McpSessionReaper({ idleTtlMs, maxSessions: 1000 });
    const chat = new MockSession();
    reaper.noteConnect(chat, NOW - idleTtlMs * 10); // connected long ago
    reaper.noteActivity(chat, NOW - 1_000);          // but active 1s ago
    const result = await reaper.reapOnce(serverOf([chat]), NOW);
    expect(result.reaped_idle).toBe(0);
    expect(chat.closed).toBe(false);
    expect(result.remaining).toBe(1);
  });

  test("(G) the onmessage probe stamps activity AND preserves the original handler exactly", async () => {
    const idleTtlMs = 60_000;
    const reaper = new McpSessionReaper({ idleTtlMs, maxSessions: 1000 });
    const received: unknown[] = [];
    let sawThis: unknown;
    const transport = {
      onmessage(this: unknown, msg: unknown, extra?: unknown) { sawThis = this; received.push([msg, extra]); },
    };
    const session: ReapableSession = { server: { transport }, close: async () => {} };
    // First seen ancient — would age out under the OLD age-based reap.
    reaper.noteConnect(session, NOW - idleTtlMs * 5);
    reaper.attachActivityProbe(session);
    // A message crosses the transport → probe stamps activity, original runs.
    (transport.onmessage as (m: unknown, e?: unknown) => void).call(transport, { method: "tools/call" }, { k: 1 });
    expect(received).toEqual([[{ method: "tools/call" }, { k: 1 }]]); // forwarded args
    expect(sawThis).toBe(transport);                                   // forwarded `this`
    // Despite the ancient connect time, the just-observed activity keeps it.
    const result = await reaper.reapOnce(serverOf([session]), NOW);
    expect(result.reaped_idle).toBe(0);
  });

  test("(H) over-cap eviction evicts LEAST-recently-active, sparing the active long-lived session", async () => {
    const reaper = new McpSessionReaper({ idleTtlMs: 60 * 60_000, maxSessions: 1 });
    const oldButActive = new MockSession(); // connected first
    const newButIdle = new MockSession();   // connected later
    reaper.noteConnect(oldButActive, NOW - 10_000);
    reaper.noteConnect(newButIdle, NOW - 1_000);
    reaper.noteActivity(oldButActive, NOW - 100); // most recently active
    const result = await reaper.reapOnce(serverOf([oldButActive, newButIdle]), NOW);
    expect(result.reaped_over_cap).toBe(1);
    expect(oldButActive.closed).toBe(false); // survived — most recently active
    expect(newButIdle.closed).toBe(true);    // evicted — least recently active
  });

  test("(E) tick emits mcp_sessions_reaped only when ≥1 reaped", async () => {
    const db = openDb(":memory:");
    const reaper = new McpSessionReaper({ idleTtlMs: 60_000, maxSessions: 1000 });

    // Clean pass: nothing reaped → no event.
    const live = new MockSession();
    await runMcpSessionReaperTick(db, reaper, serverOf([live]), NOW);
    let rows = db
      .query("SELECT COUNT(*) AS n FROM events WHERE kind = 'mcp_sessions_reaped'")
      .get() as { n: number };
    expect(rows.n).toBe(0);

    // Dead session present → event emitted with the breakdown.
    const dead = new MockSession({ dead: true });
    await runMcpSessionReaperTick(db, reaper, serverOf([live, dead]), NOW);
    rows = db
      .query("SELECT COUNT(*) AS n FROM events WHERE kind = 'mcp_sessions_reaped'")
      .get() as { n: number };
    expect(rows.n).toBe(1);

    const payloadRow = db
      .query("SELECT payload FROM events WHERE kind = 'mcp_sessions_reaped' LIMIT 1")
      .get() as { payload: string };
    const payload = JSON.parse(payloadRow.payload) as Record<string, number>;
    expect(payload.reaped_total).toBe(1);
    expect(payload.reaped_dead).toBe(1);
    expect(payload.remaining).toBe(1);
    expect(dead.closed).toBe(true);
  });
});
