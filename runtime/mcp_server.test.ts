// acc2 MCP server test — exercises the fastmcp surface via stdio transport.
//
// The production daemon binds fastmcp on httpStream + a sibling Bun.serve for
// /external/push, /health, /shutdown. Tests use the stdio transport against
// the SAME FastMCP instance so we don't have to pick free ports per test or
// race the Streamable-HTTP handshake — we get end-to-end protocol coverage
// (ListTools, CallTool, schema rejection) without an HTTP socket.
//
// The MCP-standard client used here is `@modelcontextprotocol/sdk/client` (a
// transitive dep of fastmcp). It opens an stdio pair against a child bun
// process running `mcp_server_stdio_entry.ts`, which boots a fresh in-memory
// SQLite + a fastmcp server on stdio. Each test isolates state via a fresh
// child process so concurrent test files cannot bleed into each other.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpMethods } from "./mcp_server";

const STDIO_ENTRY = join(import.meta.dir, "mcp_server_stdio_entry.ts");

type ToolCallResponse = { content: Array<{ type: string; text?: string }> };

type Harness = {
  client: Client;
  transport: StdioClientTransport;
  dir: string;
  dbPath: string;
};

const spawnHarness = async (): Promise<Harness> => {
  const dir = mkdtempSync(join(tmpdir(), "acc2-mcp-stdio-"));
  const dbPath = join(dir, "mcp.db");
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", STDIO_ENTRY],
    env: {
      ...process.env,
      ACC2_TEST_DB_PATH: dbPath,
    },
    stderr: "pipe",
  });
  const client = new Client(
    { name: "acc2-test-client", version: "0.0.1" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return { client, transport, dir, dbPath };
};

const closeHarness = async (h: Harness): Promise<void> => {
  try { await h.client.close(); } catch { /* swallow */ }
  try { await h.transport.close(); } catch { /* swallow */ }
  rmSync(h.dir, { recursive: true, force: true });
};

/** Parse the JSON-stringified McpResult that every tool returns as its first
 *  text-content block. fastmcp ships strings as one TextContent entry. */
const parseEnvelope = (res: ToolCallResponse): { ok: boolean; result?: any; error?: string } => {
  const first = res.content?.[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error(`unexpected MCP content shape: ${JSON.stringify(res)}`);
  }
  return JSON.parse(first.text);
};

describe("fastmcp substrate tools — stdio transport", () => {
  let h: Harness | null = null;

  beforeEach(async () => { h = await spawnHarness(); });
  afterEach(async () => { if (h) await closeHarness(h); h = null; });

  test("ListTools exposes every substrate method exactly once", async () => {
    const listed = await h!.client.listTools();
    const names = listed.tools.map((t) => t.name).sort();
    const expected = [...McpMethods].sort();
    expect(names).toEqual(expected);
    // Each tool advertises its zod-derived input schema.
    for (const tool of listed.tools) {
      expect(tool.inputSchema).toBeTruthy();
      expect(typeof tool.inputSchema).toBe("object");
    }
  });

  test("substrate.emit inserts an event and returns its id + ts", async () => {
    const res = (await h!.client.callTool({
      name: "substrate.emit",
      arguments: { kind: "owner_input_received", payload: { text: "hello" } },
    })) as ToolCallResponse;
    const env = parseEnvelope(res);
    expect(env.ok).toBe(true);
    expect(typeof env.result.id).toBe("string");
    expect(env.result.id.length).toBeGreaterThan(0);
    expect(typeof env.result.ts).toBe("string");
  });

  test("substrate.get_event round-trips the event we just emitted", async () => {
    const emit = parseEnvelope(
      (await h!.client.callTool({
        name: "substrate.emit",
        arguments: { kind: "owner_input_received", payload: { text: "round-trip" } },
      })) as ToolCallResponse,
    );
    const id = emit.result.id as string;
    const got = parseEnvelope(
      (await h!.client.callTool({
        name: "substrate.get_event",
        arguments: { id },
      })) as ToolCallResponse,
    );
    expect(got.ok).toBe(true);
    expect(got.result.id).toBe(id);
    expect(got.result.kind).toBe("owner_input_received");
    expect(got.result.payload.text).toBe("round-trip");
  });

  test("substrate.get_event with an unknown id returns ok:false event_not_found", async () => {
    const env = parseEnvelope(
      (await h!.client.callTool({
        name: "substrate.get_event",
        arguments: { id: "doesnotexist000000000000" },
      })) as ToolCallResponse,
    );
    expect(env.ok).toBe(false);
    expect(env.error).toBe("event_not_found");
  });

  test("substrate.run_artifact returns the Phase C stub", async () => {
    const env = parseEnvelope(
      (await h!.client.callTool({
        name: "substrate.run_artifact",
        arguments: { artifact_id: "anything" },
      })) as ToolCallResponse,
    );
    expect(env.ok).toBe(false);
    expect(env.error).toBe("runtime_not_yet_implemented");
  });

  test("substrate.run_verifier returns the Phase C stub", async () => {
    const env = parseEnvelope(
      (await h!.client.callTool({
        name: "substrate.run_verifier",
        arguments: { verifier_artifact_id: "anything" },
      })) as ToolCallResponse,
    );
    expect(env.ok).toBe(false);
    expect(env.error).toBe("runtime_not_yet_implemented");
  });

  test("substrate.credit returns the Phase H stub", async () => {
    const env = parseEnvelope(
      (await h!.client.callTool({
        name: "substrate.credit",
        arguments: {},
      })) as ToolCallResponse,
    );
    expect(env.ok).toBe(false);
    expect(env.error).toBe("credit_pipeline_phase_h");
  });

  test("substrate.read with unknown view returns view_not_implemented", async () => {
    const env = parseEnvelope(
      (await h!.client.callTool({
        name: "substrate.read",
        arguments: { view_name: "judgment_packet" },
      })) as ToolCallResponse,
    );
    expect(env.ok).toBe(false);
    expect(env.error).toContain("view_not_implemented:");
  });

  test("substrate.search returns the recent-events stub shape", async () => {
    await h!.client.callTool({
      name: "substrate.emit",
      arguments: { kind: "owner_input_received", payload: { text: "a" } },
    });
    await h!.client.callTool({
      name: "substrate.emit",
      arguments: { kind: "owner_input_received", payload: { text: "b" } },
    });
    const env = parseEnvelope(
      (await h!.client.callTool({
        name: "substrate.search",
        arguments: { query: "anything", opts: { k: 5 } },
      })) as ToolCallResponse,
    );
    expect(env.ok).toBe(true);
    expect(env.result.mode).toBe("recent_events_stub");
    expect(Array.isArray(env.result.hits)).toBe(true);
    expect(env.result.hits.length).toBeGreaterThanOrEqual(2);
  });

  test("calling an unknown tool surfaces an MCP error (not a silent success)", async () => {
    let threw = false;
    try {
      await h!.client.callTool({
        name: "substrate.does_not_exist",
        arguments: {},
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("substrate.get_event with missing required parameters is rejected by the schema", async () => {
    // `substrate.get_event` requires `id`. Calling with no arguments must
    // fail the schema check before reaching the handler.
    let threw = false;
    try {
      await h!.client.callTool({
        name: "substrate.get_event",
        arguments: {},
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
