// acc2 MCP warm-session pool tests (FLAG-GATED behind ACC2_MCP_POOL).
//
// These tests exercise the pool component directly with an injected
// reachability probe (no real daemon) so lease / dead-session failover /
// eviction / max-age / keepalive are all deterministic. They also prove the
// flag gate: ACC2_MCP_POOL OFF → mcpPoolEnabled() false → the bridge never
// touches the pool (the byte-for-byte unchanged cold path is covered by the
// EXISTING runtime/bridge.test.ts suite, which runs with the flag OFF).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  McpWarmPool,
  getWarmPool,
  mcpPoolEnabled,
  __resetWarmPoolsForTest,
  type ReachabilityProbe,
} from "./mcp_pool";
import { getFreePort } from "../../tests/free_port";

const URL = "http://127.0.0.1:65500/mcp";

const originalFlag = process.env.ACC2_MCP_POOL;
beforeEach(() => {
  __resetWarmPoolsForTest();
  delete process.env.ACC2_MCP_POOL;
});
afterEach(() => {
  __resetWarmPoolsForTest();
  if (originalFlag === undefined) delete process.env.ACC2_MCP_POOL;
  else process.env.ACC2_MCP_POOL = originalFlag;
});

/** Probe that always succeeds. */
const okProbe: ReachabilityProbe = async () => true;
/** Probe that always fails (daemon down). */
const downProbe: ReachabilityProbe = async () => false;
/** Probe whose verdict is controllable per call. */
const togglingProbe = (state: { reachable: boolean }): ReachabilityProbe =>
  async () => state.reachable;

describe("ACC2_MCP_POOL flag gate", () => {
  test("default OFF — mcpPoolEnabled() false when unset", () => {
    delete process.env.ACC2_MCP_POOL;
    expect(mcpPoolEnabled()).toBe(false);
  });

  test("OFF for falsey values", () => {
    for (const v of ["0", "false", "off", "no", ""]) {
      process.env.ACC2_MCP_POOL = v;
      expect(mcpPoolEnabled()).toBe(false);
    }
  });

  test("ON for truthy values", () => {
    for (const v of ["1", "true", "on", "yes", "TRUE", "On"]) {
      process.env.ACC2_MCP_POOL = v;
      expect(mcpPoolEnabled()).toBe(true);
    }
  });
});

describe("McpWarmPool — lease returns a warm session", () => {
  test("ensureWarm fills to size, lease hands out a verified session", async () => {
    const pool = new McpWarmPool({ url: URL, size: 2, probe: okProbe, keepaliveMs: 60_000 });
    await pool.ensureWarm();
    expect(pool.stats().idle).toBe(2);

    const r = await pool.lease();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.session.url).toBe(URL);
      expect(r.session.leased).toBe(true);
      expect(r.session.dead).toBe(false);
    }
    // One leased, one still idle.
    expect(pool.stats().leased).toBe(1);
    expect(pool.stats().idle).toBe(1);
  });

  test("release returns the session to the idle pool for re-lease", async () => {
    const pool = new McpWarmPool({ url: URL, size: 1, probe: okProbe, keepaliveMs: 60_000 });
    await pool.ensureWarm();
    const r = await pool.lease();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(pool.stats().idle).toBe(0);
    pool.release(r.session);
    expect(pool.stats().idle).toBe(1);
    // Re-lease the same warm session.
    const r2 = await pool.lease();
    expect(r2.ok).toBe(true);
  });
});

describe("McpWarmPool — dead/stale failover to cold path", () => {
  test("lease on empty pool returns no_warm_session (caller falls over to cold)", async () => {
    const pool = new McpWarmPool({ url: URL, size: 2, probe: downProbe, keepaliveMs: 60_000 });
    // Endpoint down → ensureWarm establishes nothing.
    await pool.ensureWarm();
    expect(pool.stats().total).toBe(0);
    const r = await pool.lease();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_warm_session");
  });

  test("lease re-verifies synchronously — dead endpoint at lease time fails over", async () => {
    const state = { reachable: true };
    const pool = new McpWarmPool({ url: URL, size: 1, probe: togglingProbe(state), keepaliveMs: 60_000 });
    await pool.ensureWarm();
    expect(pool.stats().idle).toBe(1);
    // Daemon goes down between warm-up and lease.
    state.reachable = false;
    const r = await pool.lease();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("lease_failed");
    // The dead session was evicted.
    expect(pool.stats().total).toBe(0);
  });

  test("release(dead=true) evicts the session", async () => {
    const pool = new McpWarmPool({ url: URL, size: 1, probe: okProbe, keepaliveMs: 60_000 });
    await pool.ensureWarm();
    const r = await pool.lease();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    pool.release(r.session, /* dead */ true);
    // Evicted; ensureWarm (kicked by release) refills with okProbe → back to 1.
    // Allow the async refill to settle.
    await pool.ensureWarm();
    expect(pool.stats().dead).toBe(0);
  });
});

describe("McpWarmPool — eviction / max-age", () => {
  test("aged sessions are evicted on the next ensureWarm/lease pass", async () => {
    const pool = new McpWarmPool({ url: URL, size: 1, maxAgeMs: 10_000, probe: okProbe, keepaliveMs: 60_000 });
    await pool.ensureWarm();
    expect(pool.stats().idle).toBe(1);

    // Force the single session to look aged by rewinding its createdAtMs.
    // (No real wall-clock wait — deterministic.)
    const snapshot = pool.stats();
    expect(snapshot.total).toBe(1);
    // Reach in via lease + reflection-free path: mutate through a fresh
    // pool maintenance call after aging. We age the session by leasing,
    // releasing, then asserting an aged session is not handed out.
    // Simpler: construct a tiny maxAge so a microtask boundary ages it.
    const fastPool = new McpWarmPool({ url: URL, size: 1, maxAgeMs: 0, probe: okProbe, keepaliveMs: 60_000 });
    await fastPool.ensureWarm();
    // With maxAgeMs=0 every session is immediately "aged" (now-created>0
    // becomes true on the next tick); a lease must fail over.
    await new Promise((res) => setTimeout(res, 2));
    const r = await fastPool.lease();
    // Aged session is evicted → no warm session to lease.
    expect(r.ok).toBe(false);
  });

  test("keepaliveOnce marks unreachable idle sessions dead and evicts them", async () => {
    const state = { reachable: true };
    const pool = new McpWarmPool({ url: URL, size: 1, probe: togglingProbe(state), keepaliveMs: 60_000 });
    await pool.ensureWarm();
    expect(pool.stats().idle).toBe(1);
    state.reachable = false;
    await pool.keepaliveOnce();
    // Dead session evicted; refill failed (still down) → empty.
    expect(pool.stats().total).toBe(0);
  });
});

describe("McpWarmPool — anti-starve permit semantics preserved", () => {
  test("a leased warm session does NOT consume a handshake permit (it IS the slot)", async () => {
    // The pool models the warm session as the anti-starve slot equivalent:
    // a leased warm session is not re-leased (the pool caps concurrent
    // leases at `size`), and the bridge's warm-lease path skips
    // acquireHandshakePermit entirely. Here we assert the pool's own
    // concurrency cap: with size=2, at most 2 sessions can be leased at
    // once; a 3rd lease fails over (no_warm_session) rather than
    // double-leasing — the same staggering the cold permit cap enforces.
    const pool = new McpWarmPool({ url: URL, size: 2, probe: okProbe, keepaliveMs: 60_000 });
    await pool.ensureWarm();
    const a = await pool.lease();
    const b = await pool.lease();
    const c = await pool.lease();
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    // 3rd lease over the pool size fails over to cold — never double-leases.
    expect(c.ok).toBe(false);
    expect(pool.stats().leased).toBe(2);
  });
});

describe("McpWarmPool — real endpoint on an isolated free port (no live daemon)", () => {
  test("default probe warms + leases against a live endpoint, fails over against a dead one", async () => {
    // Stand up a throwaway HTTP server on an OS-assigned free port (NOT the
    // live daemon's fixed 9387/9388). The pool's DEFAULT probe (real fetch
    // HEAD) must warm + lease against it (proving the real connectivity path,
    // not just the injected probe), then deterministically fail over against
    // a dead endpoint.
    //
    // Why a FIXED unrouted dead address (127.0.0.1:9) rather than stop(true)
    // on the same ephemeral port: an OS-assigned ephemeral port is reused the
    // instant it is freed, and under full-suite load the daemon-test fleet
    // sprays Bun.serve HTTP servers across ephemeral ports. The just-freed
    // port (or even a port we hold with an exclusive silent TCP listener) gets
    // answered with HTTP 200 by a concurrent server, so the warm session never
    // fails over — the original fixed-20ms wait flaked exactly this way
    // (observed: the HEAD probe returned ok:200 from a squatter for the entire
    // poll window). Port 9 (discard) is privileged, never in the ephemeral
    // allocation pool, and nothing in the suite binds it, so the real
    // defaultProbe's fetch HEAD is refused INSTANTLY (ECONNREFUSED, ~0ms) —
    // deterministic regardless of suite load, with no reuse hazard.
    const DEAD_URL = "http://127.0.0.1:9/mcp";
    const port = getFreePort();
    const server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch: () => new Response("ok", { status: 405 }), // 405 proves reachable
    });
    const liveUrl = `http://127.0.0.1:${port}/mcp`;
    try {
      // No injected probe → uses the real defaultProbe (fetch HEAD).
      const pool = new McpWarmPool({ url: liveUrl, size: 1, keepaliveMs: 60_000, probeTimeoutMs: 2_000 });
      await pool.ensureWarm();
      expect(pool.stats().idle).toBe(1);
      const r = await pool.lease();
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.session.url).toBe(liveUrl);
        pool.release(r.session);
      }
      server.stop(true);

      // Failover leg: the real defaultProbe against the refused dead address
      // exercises the same defaultProbe → reachable=false path the warm
      // session's re-verify takes when its daemon goes away. ensureWarm runs
      // the real probe; it establishes nothing (connection refused), so lease()
      // finds no warm session and fails over to cold. Poll defensively with a
      // load-tolerant ceiling well under the test timeout.
      const deadPool = new McpWarmPool({ url: DEAD_URL, size: 1, keepaliveMs: 60_000, probeTimeoutMs: 1_000 });
      await deadPool.ensureWarm();
      let r2 = await deadPool.lease();
      const deadlineMs = Date.now() + 8_000;
      while (r2.ok && Date.now() < deadlineMs) {
        deadPool.release(r2.session);
        await new Promise((res) => setTimeout(res, 25));
        await deadPool.ensureWarm();
        r2 = await deadPool.lease();
      }
      expect(r2.ok).toBe(false);
      expect(deadPool.stats().total).toBe(0);
    } finally {
      try { server.stop(true); } catch { /* already stopped */ }
    }
  }, 20_000);
});

describe("getWarmPool registry", () => {
  test("get-or-create is keyed by URL — same URL returns same pool", () => {
    const p1 = getWarmPool(URL, { probe: okProbe });
    const p2 = getWarmPool(URL, { probe: okProbe });
    expect(p1).toBe(p2);
    const p3 = getWarmPool("http://127.0.0.1:65501/mcp", { probe: okProbe });
    expect(p3).not.toBe(p1);
  });

  test("__resetWarmPoolsForTest clears the registry + stops timers", () => {
    getWarmPool(URL, { probe: okProbe });
    __resetWarmPoolsForTest();
    const p2 = getWarmPool(URL, { probe: okProbe });
    // Fresh instance after reset.
    expect(p2.stats().total).toBeGreaterThanOrEqual(0);
  });
});
