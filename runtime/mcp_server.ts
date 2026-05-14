// acc2 MCP server — backward-compatible re-export shim.
//
// The implementation was split into a `runtime/mcp_server/` directory:
//   - mcp_server/index.ts            — createMcpServer entry + handleMcpRequest
//                                      + canonical McpMethods whitelist
//   - mcp_server/substrate_tools.ts  — 17 substrate.* handlers
//   - mcp_server/runtime_tools.ts    — 7  runtime.* handlers
//   - mcp_server/types.ts            — McpContext / McpResult / McpServerOptions
//                                      + every shared zod schema
//
// This shim keeps `from "./mcp_server"` / `from "../runtime/mcp_server"`
// imports resolving identically so every existing consumer (daemon.ts,
// mcp_server_stdio_entry.ts, mcp_server.test.ts, audit.test.ts) continues
// to work without changes.

export * from "./mcp_server/index";
