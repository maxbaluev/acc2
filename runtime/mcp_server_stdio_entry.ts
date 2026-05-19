// acc2 MCP server — stdio harness for tests.
//
// This file is the child-process entrypoint used by mcp_server.test.ts to
// drive the fastmcp server over stdio without binding an HTTP port. The
// shape is intentionally minimal: open a fresh SQLite at ACC2_TEST_DB_PATH
// (or :memory: if unset), run schema + views, build the FastMCP instance
// with `createMcpServer`, and start it on the stdio transport.
//
// Stderr is left untouched — fastmcp writes its protocol logs there and the
// test's StdioClientTransport captures stderr so failures surface cleanly.
//
// When ACC2_TEST_MODE=1 the entry registers an additional `runtime.test_reset`
// tool that truncates every state table so a single long-lived stdio harness
// can be reused across tests. The tool is gated to this entry — production
// MCP surfaces (daemon httpStream) never see it.

import { z } from "zod";
import { openDb, runSchema } from "../substrate/db";
import { runViews } from "../substrate/views";
import { createMcpServer } from "./mcp_server";

const dbPath = process.env.ACC2_TEST_DB_PATH ?? ":memory:";
const db = openDb(dbPath);
runSchema(db);
runViews(db);

const server = createMcpServer({ db, invoker: "claude_root" });

if (process.env.ACC2_TEST_MODE === "1") {
  // Test-only reset tool: truncates every state table so a single long-lived
  // stdio harness can be reused across tests in mcp_server.test.ts. Gated
  // behind ACC2_TEST_MODE=1 and registered ONLY in this stdio entry — it is
  // never wired into the production daemon's MCP surface.
  server.addTool({
    name: "runtime.test_reset",
    description:
      "Test-only: truncate events, act_artifact, vec_events, meta. " +
      "Registered exclusively when ACC2_TEST_MODE=1 in the stdio entry.",
    parameters: z.object({}),
    execute: async (): Promise<string> => {
      try {
        db.exec("DELETE FROM events");
        db.exec("DELETE FROM act_artifact");
        try { db.exec("DELETE FROM vec_events"); } catch { /* virtual table may refuse if not loaded */ }
        db.exec("DELETE FROM meta");
        return JSON.stringify({ ok: true, result: { reset: true } });
      } catch (err) {
        return JSON.stringify({
          ok: false,
          error: `test_reset_failed:${(err as Error).message}`,
        });
      }
    },
  });
}

await server.start({ transportType: "stdio" });
