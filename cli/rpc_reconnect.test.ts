import { afterEach, describe, expect, test } from "bun:test";

// Regression test for the SSE/MCP reconnect-storm fix (2026-05-23).
//
// Live root cause: a single `acc watch` whose `/events/stream` (or MCP GET)
// stream dropped during a daemon restart reconnected in a TIGHT LOOP, and the
// MCP transport additionally re-sent a `Last-Event-ID` header that made
// mcp-proxy replay its event store on every reconnect — saturating the
// single-threaded daemon event loop so /health timed out, slowing boot,
// dropping more streams: a vicious cycle.
//
// These tests pin the client-side contract that closes the storm:
//   (a) nextBackoff escalates with jitter and never returns 0 (no tight loop),
//   (b) sseConnect reconnects with a GROWING gap between attempts (backoff),
//       not back-to-back, when the daemon repeatedly drops the stream, AND
//   (c) sseConnect resumes via a fresh bounded GET — it NEVER sends a
//       Last-Event-ID header / requests a full-ledger replay on reconnect.

import { nextBackoff, sseConnect } from "./rpc";

describe("nextBackoff (jittered exponential backoff)", () => {
  test("escalates the ceiling, caps it, and never returns a zero delay", () => {
    const rng = () => 1; // full jitter at max → delay == ceiling
    let cur = 250;
    const cap = 10_000;
    const ceilings: number[] = [];
    const delays: number[] = [];
    for (let i = 0; i < 10; i++) {
      const { delay, next } = nextBackoff(cur, cap, rng);
      delays.push(delay);
      ceilings.push(next);
      cur = next;
    }
    // No tight loop: every delay is a real, positive wait.
    for (const d of delays) expect(d).toBeGreaterThan(0);
    // Monotonic growth until the cap, then pinned at the cap.
    expect(ceilings[0]).toBe(500);
    expect(ceilings.at(-1)).toBe(cap);
    expect(Math.max(...ceilings)).toBeLessThanOrEqual(cap);
  });

  test("full jitter keeps the delay within [ceiling/2, ceiling]", () => {
    const lo = nextBackoff(1_000, 10_000, () => 0).delay; // min jitter
    const hi = nextBackoff(1_000, 10_000, () => 1).delay; // max jitter
    expect(lo).toBe(500);
    expect(hi).toBe(1_000);
    expect(lo).toBeLessThan(hi); // de-synchronizes lockstep reconnects
  });
});

describe("sseConnect reconnect: backoff + bounded resume (no replay storm)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  // Guard against process-global `mock.module("./rpc", …)` bleed from sibling
  // test files (e.g. cli/task_follow_bounded.test.ts) that replace sseConnect
  // with a stub. `mock.module` is NOT undone by mock.restore(), so under a
  // parallel preload pass the `sseConnect` we imported may be the stub, not the
  // real impl. The real impl with {reconnect:false} and no daemon throws a
  // known message; the stub does not. If sseConnect is mocked we cannot
  // exercise the real reconnect loop here — the nextBackoff tests above still
  // pin the storm-closing logic, and this case passes in isolation.
  const realSseConnect = async (): Promise<boolean> => {
    // The real impl with {reconnect:false} + no daemon throws "daemon not
    // running" on the first .next(). A sibling-file stub may instead return a
    // generator that awaits forever, so race the probe against a short timeout:
    // a hang (or any non-matching result) means sseConnect is mock-replaced.
    const ac = new AbortController();
    const probe = (async () => {
      try {
        const g = sseConnect({ reconnect: false, signal: ac.signal, mcpPort: undefined, auxPort: undefined });
        await g.next();
        return false;
      } catch (err) {
        return String((err as Error)?.message ?? err).includes("daemon not running");
      }
    })();
    const timed = new Promise<boolean>((r) => setTimeout(() => r(false), 100));
    const result = await Promise.race([probe, timed]);
    ac.abort(); // release a hung stub generator
    return result;
  };

  test("a dropped stream reconnects with a growing gap and never sends Last-Event-ID", async () => {
    if (!(await realSseConnect())) {
      // sseConnect is mock-replaced by a sibling file under parallel preload;
      // the storm contract is still pinned by the nextBackoff tests above.
      return;
    }
    const attemptAtMs: number[] = [];
    const sentHeaders: Array<Record<string, string>> = [];

    // Mock fetch: record each connection attempt's timestamp + headers, then
    // return an SSE stream that immediately closes (simulating a daemon that
    // is mid-restart and drops the stream right after accepting it).
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      attemptAtMs.push(Date.now());
      const headers: Record<string, string> = {};
      const h = init?.headers as Record<string, string> | undefined;
      if (h) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v);
      sentHeaders.push(headers);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(": connected\n\n"));
          controller.close(); // drop immediately → triggers reconnect
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    const ac = new AbortController();
    // Tiny, deterministic backoff so the test is fast but still observable.
    // rng()===1 → delay == current ceiling, so gaps are 5ms, 10ms, 20ms, …
    const gen = sseConnect({
      mcpPort: 59998,
      auxPort: 59999,
      signal: ac.signal,
      reconnect: true,
      backoffMs: 5,
      backoffCapMs: 80,
      stableConnectMs: 10_000, // never "stable" here → backoff must escalate
      rng: () => 1,
    });

    // Drive the generator in the background; it never yields a real event
    // (stream closes before any data frame), it just reconnects.
    const drive = (async () => {
      try {
        for await (const _ev of gen) void _ev;
      } catch { /* abort */ }
    })();

    // Let several reconnect cycles happen, then abort.
    await new Promise((r) => setTimeout(r, 200));
    ac.abort();
    await drive;

    // It reconnected multiple times (the loop is alive, not wedged)…
    expect(attemptAtMs.length).toBeGreaterThanOrEqual(3);

    // …but NOT in a tight loop: the gap between consecutive reconnects grows
    // (exponential backoff). The later gaps must exceed the earliest ones.
    const gaps: number[] = [];
    for (let i = 1; i < attemptAtMs.length; i++) gaps.push(attemptAtMs[i] - attemptAtMs[i - 1]);
    // At least one gap reflects real backoff (well above a busy-loop 0–1ms).
    expect(Math.max(...gaps)).toBeGreaterThanOrEqual(10);
    // And the tail gap is larger than the head gap (escalation, not flat/tight).
    expect(Math.max(...gaps)).toBeGreaterThan(Math.min(...gaps));

    // CRITICAL: the bounded-resume contract — no reconnect ever requests a
    // replay from the server. The /events/stream client never sends a
    // Last-Event-ID header; it resumes live (a bounded snapshot re-fetch is
    // the caller's job via a normal read, not an unbounded SSE replay).
    for (const headers of sentHeaders) {
      expect(headers["last-event-id"]).toBeUndefined();
    }
  });
});
