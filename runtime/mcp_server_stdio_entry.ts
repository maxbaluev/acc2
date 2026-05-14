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

import { openDb, runSchema } from "../substrate/db";
import { runViews } from "../substrate/views";
import { createMcpServer } from "./mcp_server";

const dbPath = process.env.ACC2_TEST_DB_PATH ?? ":memory:";
const db = openDb(dbPath);
runSchema(db);
runViews(db);

const server = createMcpServer({ db, invoker: "claude_root" });
await server.start({ transportType: "stdio" });
