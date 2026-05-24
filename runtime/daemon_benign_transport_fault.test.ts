// acc2 — focused unit tests for the benign transport-reconnect fault
// classifier + the ledger-emit decision helper. These are PURE functions
// exported from daemon.ts, so we test them directly without booting a daemon
// (importing ./daemon has side-effect-free top-level — the heavy work is all
// inside startDaemon()).
//
// EVIDENCE: mcp-proxy's StreamableHTTPServerTransport.handleGetRequest throws
// `Conflict: Only one SSE stream is allowed per session` on every MCP client
// SSE reconnect — 11,068 times in one daemon lifetime. The classifier must
// match THAT message and must NOT match an arbitrary real error.

import { describe, expect, test } from "bun:test";
import { isBenignTransportReconnectFault, shouldEmitLedgerEventForFault } from "./daemon";

describe("isBenignTransportReconnectFault", () => {
  test("matches the mcp-proxy SSE-conflict message (exact)", () => {
    expect(
      isBenignTransportReconnectFault("Conflict: Only one SSE stream is allowed per session"),
    ).toBe(true);
  });

  test("matches case-insensitively and as a substring", () => {
    expect(isBenignTransportReconnectFault("ONLY ONE SSE STREAM IS ALLOWED PER SESSION")).toBe(true);
    expect(
      isBenignTransportReconnectFault("Error [transport]: only one sse stream is allowed per session (sid=abc)"),
    ).toBe(true);
  });

  test("does NOT match an arbitrary real error", () => {
    expect(isBenignTransportReconnectFault("TypeError: x is not a function")).toBe(false);
    expect(isBenignTransportReconnectFault("ECONNREFUSED 127.0.0.1:5432")).toBe(false);
    expect(isBenignTransportReconnectFault("Cannot read properties of undefined")).toBe(false);
  });

  test("handles empty / falsy input safely", () => {
    expect(isBenignTransportReconnectFault("")).toBe(false);
  });
});

describe("shouldEmitLedgerEventForFault", () => {
  test("non-benign faults always emit a ledger event (existing behavior)", () => {
    expect(shouldEmitLedgerEventForFault(false, false)).toBe(true);
    expect(shouldEmitLedgerEventForFault(false, true)).toBe(true);
  });

  test("benign faults emit exactly once per daemon lifetime (rolled-up)", () => {
    // First benign fault: rolled-up row not yet emitted → emit it.
    expect(shouldEmitLedgerEventForFault(true, false)).toBe(true);
    // Subsequent benign faults: rolled-up row already emitted → suppress.
    expect(shouldEmitLedgerEventForFault(true, true)).toBe(false);
  });
});
