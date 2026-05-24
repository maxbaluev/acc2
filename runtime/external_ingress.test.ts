// acc2 external-push ingress test — token auth, source registration, rate
// limit, quarantine. Tests target the auxiliary HTTP port (handle.auxPort)
// which hosts /external/push alongside /health and /shutdown.

import { beforeEach, describe, expect, test } from "bun:test";
import { useSharedDaemon } from "../tests/daemon_fixture";

// Tight ingress-only band, well-disjoint from runtime/daemon.test.ts
// ([19000, 60000)) and cli/dispatch.test.ts ([12000, 18000)) so all three
// test files can run in parallel without colliding on either port.
const MCP_BASE = 8000;
const AUX_BASE = 10000;

const TOKEN = "test-bearer-token-deadbeef";
const daemon = useSharedDaemon({
  tmpPrefix: "acc2-ingress-",
  dbName: "ingress.db",
  mcpBase: MCP_BASE,
  auxBase: AUX_BASE,
  externalPushToken: TOKEN,
  setEnvPorts: false,
});

beforeEach(() => {
  const handle = daemon.handle();
  handle.ingressState.buckets.clear();
  // Shrink the rate limit so we can exercise breaches without sending dozens
  // of requests; default is 60/min.
  handle.ingressState.rateLimitPerMin = 5;
});

const push = async (
  source: string,
  bearer: string | null,
  body: Record<string, unknown> = {},
): Promise<{ status: number; body: any }> => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(`http://127.0.0.1:${daemon.handle().auxPort}/external/push`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      source,
      kind: "external_event_received",
      payload: { hello: "world" },
      ...body,
    }),
  });
  return { status: res.status, body: await res.json() };
};

describe("POST /external/push", () => {
  test("valid token + body emits external_event_received and returns 200", async () => {
    const { status, body } = await push("test_source", TOKEN);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.event_id).toBe("string");
  });

  test("missing token returns 401", async () => {
    const { status, body } = await push("test_source", null);
    expect(status).toBe(401);
    expect(body.ok).toBe(false);
  });

  test("invalid token returns 401", async () => {
    const { status } = await push("test_source", "wrong-token");
    expect(status).toBe(401);
  });

  test("unregistered source returns 400", async () => {
    const { status, body } = await push("nope.example.com", TOKEN);
    expect(status).toBe(400);
    expect(body.error).toContain("unregistered_source:");
  });

  test("wrong kind (not external_event_received) returns 400", async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.handle().auxPort}/external/push`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ source: "test_source", kind: "owner_input_received", payload: {} }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("kind_must_be_external_event_received");
  });

  test("rate-limit breach 3 times in a row emits external_source_quarantined", async () => {
    for (let i = 0; i < 5; i++) {
      const { status } = await push("test_source", TOKEN);
      expect(status).toBe(200);
    }
    for (let i = 0; i < 3; i++) {
      const { status, body } = await push("test_source", TOKEN);
      expect(status).toBe(429);
      expect(body.error).toBe("rate_limit_exceeded");
    }
    const fourth = await push("test_source", TOKEN);
    expect(fourth.status).toBe(429);
    expect(fourth.body.error).toBe("source_quarantined");

    const db = daemon.handle().db;
    const row = db
      .query("SELECT COUNT(*) AS n FROM events WHERE kind = 'external_source_quarantined'")
      .get() as { n: number };
    expect(row.n).toBeGreaterThanOrEqual(1);
  });
});
