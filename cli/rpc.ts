// Thin RPC helpers shared by every cli/* surface — daemon discovery, lock-file
// read, HTTP POST/GET against the auxiliary port, and a small MCP client
// factory for substrate.* method calls via fastmcp's StreamableHTTP transport.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const DEFAULT_SOCKET_FILE = join(homedir(), ".accint", "v2.sock");
export const DEFAULT_TOKEN_FILE = join(homedir(), ".accint", "v2.sock.token");

export type DaemonLock = {
  pid: number;
  port: number;       // MCP (fastmcp httpStream) port
  aux_port?: number;  // auxiliary HTTP port (/health, /shutdown, /external/push)
  started_at_ms?: number;
  db_path?: string;
};

export const readDaemonLock = (socketFile = DEFAULT_SOCKET_FILE): DaemonLock | null => {
  if (!existsSync(socketFile)) return null;
  try { return JSON.parse(readFileSync(socketFile, "utf8")) as DaemonLock; } catch { return null; }
};

export const readAdminToken = (tokenFile = DEFAULT_TOKEN_FILE): string | null => {
  if (!existsSync(tokenFile)) return null;
  try {
    const raw = readFileSync(tokenFile, "utf8");
    return (JSON.parse(raw) as { admin_token?: string }).admin_token ?? null;
  } catch { return null; }
};

export type RpcOpts = { mcpPort?: number; auxPort?: number; socketFile?: string };

const envMcpPort = (): number | null => {
  const v = Number(process.env.V2_DAEMON_PORT ?? 0);
  return v > 0 ? v : null;
};
const envAuxPort = (): number | null => {
  const v = Number(process.env.V2_DAEMON_AUX_PORT ?? 0);
  return v > 0 ? v : null;
};

export const resolvePorts = (opts: RpcOpts = {}): { mcp: number; aux: number } | null => {
  const mcp = opts.mcpPort ?? envMcpPort();
  const aux = opts.auxPort ?? envAuxPort();
  if (mcp && aux) return { mcp, aux };
  if (mcp && !aux) return { mcp, aux: mcp + 1 };
  const lock = readDaemonLock(opts.socketFile);
  if (!lock) return null;
  return { mcp: lock.port, aux: lock.aux_port ?? lock.port + 1 };
};

export const auxBaseUrl = (opts: RpcOpts = {}): string | null => {
  const ports = resolvePorts(opts);
  return ports ? `http://127.0.0.1:${ports.aux}` : null;
};

export const mcpBaseUrl = (opts: RpcOpts = {}): string | null => {
  const ports = resolvePorts(opts);
  return ports ? `http://127.0.0.1:${ports.mcp}/mcp` : null;
};

export const requireAux = (opts: RpcOpts = {}): string => {
  const u = auxBaseUrl(opts);
  if (!u) throw new Error("daemon not running — start it with `acc daemon start`");
  return u;
};

export const requireMcp = (opts: RpcOpts = {}): string => {
  const u = mcpBaseUrl(opts);
  if (!u) throw new Error("daemon not running — start it with `acc daemon start`");
  return u;
};

export const rpcGet = async <T = unknown>(url: string): Promise<T> => {
  const res = await fetch(url);
  const text = await res.text();
  try { return (text ? JSON.parse(text) : {}) as T; } catch { return { ok: false, error: `non_json:${text.slice(0, 200)}` } as T; }
};

export const rpcPostAuth = async <T = unknown>(url: string, token: string, body: unknown): Promise<T> => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  try { return (text ? JSON.parse(text) : {}) as T; } catch { return { ok: false, error: `non_json:${text.slice(0, 200)}` } as T; }
};

// ── MCP client (fastmcp StreamableHTTP) ────────────────────────────

export type McpEnvelope =
  | { ok: true; result: any }
  | { ok: false; error: string };

const parseEnvelope = (res: { content: Array<{ type: string; text?: string }> }): McpEnvelope => {
  const first = res.content?.[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    return { ok: false, error: "unexpected_mcp_shape" };
  }
  try { return JSON.parse(first.text) as McpEnvelope; } catch { return { ok: false, error: `bad_envelope:${first.text.slice(0, 80)}` }; }
};

/** Open an MCP client against the daemon's MCP port, invoke one tool, close.
 *  This is the canonical CLI → substrate call path for substrate.* methods. */
export const mcpCall = async (toolName: string, args: Record<string, unknown>, opts: RpcOpts = {}): Promise<McpEnvelope> => {
  const base = requireMcp(opts);
  const transport = new StreamableHTTPClientTransport(new URL(base));
  const client = new Client({ name: "acc2-cli", version: "0.0.1" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const res = await client.callTool({ name: toolName, arguments: args }) as { content: Array<{ type: string; text?: string }> };
    return parseEnvelope(res);
  } finally {
    try { await client.close(); } catch { /* swallow */ }
  }
};
