// Thin RPC helpers shared by every cli/* surface — daemon discovery, lock-file
// read, HTTP POST/GET against the auxiliary port, and a small MCP client
// factory for substrate.* method calls via fastmcp's StreamableHTTP transport.
//
// State-path resolution lives in `runtime/state_paths.ts` so init.ts, rpc.ts,
// and daemon.ts cannot disagree about where the socket / token files live.
// The resolvers are read LAZILY on every call (no module-level constant) so a
// test or harness changing the env var mid-process picks up the new value on
// the next call.
//
// Robustness: every fetch() bound by AbortSignal.timeout so a wedged daemon
// cannot hang the operator's CLI. Timeouts by endpoint:
//   /health          5s    — liveness probe; must be near-instant
//   /shutdown       10s    — graceful stop request
//   /external/push  10s    — owner-tagged event ingress
//   MCP tool calls  30s    — substrate.* / runtime.* surface
//   /events/stream  none   — long-lived SSE; the caller owns abort
//   acc daemon stop 10s    — daemonStop() wraps the /shutdown rpc

import { existsSync, readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { resolveSocketFile, resolveTokenFile } from "../runtime/state_paths";

/** Backwards-compatible accessor for the default socket path. Reads the
 *  current env every call — do NOT cache the returned string. Most call
 *  sites should let `resolvePorts` / `auxBaseUrl` / `mcpBaseUrl` do this
 *  internally; tests that want the literal default path call this. */
export const getDefaultSocketFile = (): string => resolveSocketFile();
/** Backwards-compatible accessor for the default admin-token path. */
export const getDefaultTokenFile = (): string => resolveTokenFile();

/** Per-endpoint fetch timeout taxonomy. Fail-fast: any of these expiring
 *  raises AbortError; the helper rewrites it into a clean ok:false envelope.
 *  Numbers chosen to bound operator-visible latency while leaving enough
 *  headroom for the daemon to do real work behind the route.
 *
 *  HEALTH_TIMEOUT_MS bumped from 5s to 30s after observing the daemon
 *  legitimately take 4-15s to serve /health under load: bun:sqlite runs
 *  synchronously on the JS event loop, and any heavy worker tick
 *  (amendment processor, extractors, candidate merger over a 130k-event
 *  ledger) can monopolize the main thread for 10+ seconds. A 5s
 *  client-side deadline declared the daemon DEAD even though it was
 *  alive and would respond in 8s. Matches MCP_CALL_TIMEOUT_MS — both
 *  probes share the same underlying event-loop constraints. */
export const HEALTH_TIMEOUT_MS = 30_000;
export const SHUTDOWN_TIMEOUT_MS = 10_000;
export const EXTERNAL_PUSH_TIMEOUT_MS = 10_000;
// Default 60s for routine MCP reads (substrate.read on light views, get_event,
// search). Write-class calls (substrate.open_directive, substrate.emit on
// dense projection paths) pass an explicit longer timeout — see
// MCP_WRITE_TIMEOUT_MS. 30s was insufficient on warm substrates because
// emitEvent cascades fan out to many activation listeners synchronously
// (687 listeners observed 2026-05-19) and the projection chain can dwarf
// the 30s budget without the dispatch actually being broken.
export const MCP_CALL_TIMEOUT_MS = 60_000;
// 120s for write-class MCP calls — directive ingress runs intent_classifier,
// emit_event × ~5 with projection cascades, and stakeholder/conflict gates
// in one atomic handler. 2× the read budget covers the cascade tail.
export const MCP_WRITE_TIMEOUT_MS = 120_000;
export const DEFAULT_RPC_TIMEOUT_MS = 10_000;

export type DaemonLock = {
  pid: number;
  port: number;       // MCP (fastmcp httpStream) port
  aux_port?: number;  // auxiliary HTTP port (/health, /shutdown, /external/push)
  started_at_ms?: number;
  db_path?: string;
};

export const readDaemonLock = (socketFile?: string): DaemonLock | null => {
  const target = socketFile ?? resolveSocketFile();
  if (!existsSync(target)) return null;
  try { return JSON.parse(readFileSync(target, "utf8")) as DaemonLock; } catch { return null; }
};

export const readAdminToken = (tokenFile?: string): string | null => {
  const target = tokenFile ?? resolveTokenFile();
  if (!existsSync(target)) return null;
  try {
    const raw = readFileSync(target, "utf8");
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

/** Resolve a per-endpoint timeout from the URL. Keeps the helpers thin —
 *  callers pass the endpoint URL, this function applies the canonical
 *  taxonomy. Callers that want a different number set `timeoutMs` explicitly. */
const resolveTimeoutMs = (url: string, override?: number): number => {
  if (typeof override === "number" && override > 0) return override;
  if (url.endsWith("/health")) return HEALTH_TIMEOUT_MS;
  if (url.endsWith("/shutdown")) return SHUTDOWN_TIMEOUT_MS;
  if (url.endsWith("/external/push")) return EXTERNAL_PUSH_TIMEOUT_MS;
  return DEFAULT_RPC_TIMEOUT_MS;
};

export const rpcGet = async <T = unknown>(url: string, opts?: { timeoutMs?: number }): Promise<T> => {
  const timeoutMs = resolveTimeoutMs(url, opts?.timeoutMs);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    try { return (text ? JSON.parse(text) : {}) as T; } catch {
      return { ok: false, error: `non_json:${text.slice(0, 200)}` } as T;
    }
  } catch (err) {
    const name = (err as Error).name;
    if (name === "TimeoutError" || name === "AbortError") {
      return { ok: false, error: `timeout:${timeoutMs}ms:${url}` } as T;
    }
    return { ok: false, error: `fetch_failed:${(err as Error).message}` } as T;
  }
};

export const rpcPostAuth = async <T = unknown>(
  url: string,
  token: string,
  body: unknown,
  opts?: { timeoutMs?: number },
): Promise<T> => {
  const timeoutMs = resolveTimeoutMs(url, opts?.timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    try { return (text ? JSON.parse(text) : {}) as T; } catch {
      return { ok: false, error: `non_json:${text.slice(0, 200)}` } as T;
    }
  } catch (err) {
    const name = (err as Error).name;
    if (name === "TimeoutError" || name === "AbortError") {
      return { ok: false, error: `timeout:${timeoutMs}ms:${url}` } as T;
    }
    return { ok: false, error: `fetch_failed:${(err as Error).message}` } as T;
  }
};

// ── SSE client (/events/stream) ────────────────────────────────────
//
// `acc watch` and any other inline observer call sseConnect() to subscribe
// to the daemon's event bus. Each yielded SseEvent corresponds to one
// `data: <json>\n\n` frame from the SSE endpoint. On disconnect the helper
// reconnects with exponential backoff (1s → 2s → 4s → 8s cap). Caller can
// stop the iteration by `break`ing out of the for-await loop or by passing
// an AbortSignal in opts; both paths cancel the fetch and close the stream.

export type SseEvent = {
  event_id: string;
  kind: string;
  ts: string;
  directive_id?: string;
  task_id?: string;
  substrate_origin?: string;
  payload?: unknown;
};

export type SseConnectOpts = RpcOpts & {
  /** Cancel the iteration externally. Aborting closes the fetch + ends the loop. */
  signal?: AbortSignal;
  /** Disable the exponential-backoff reconnect loop (default true). Useful
   *  in tests that want a single fetch and a deterministic end. */
  reconnect?: boolean;
  /** Override the initial backoff delay (ms). Default 1000. */
  backoffMs?: number;
  /** Override the cap on backoff delay (ms). Default 8000. */
  backoffCapMs?: number;
};

const parseSseFrame = (chunk: string): SseEvent | null => {
  // Each frame is one or more `field: value` lines separated by \n,
  // terminated by \n\n. We only care about `data:` lines; ignore the
  // `:`-prefixed comment lines (keepalive / connected pings).
  const lines = chunk.split("\n");
  let dataPayload = "";
  for (const line of lines) {
    if (line.startsWith("data:")) {
      dataPayload += line.slice(5).trimStart();
    } else if (line.startsWith(":")) {
      // comment — ignore
    }
  }
  if (!dataPayload) return null;
  try {
    const parsed = JSON.parse(dataPayload) as Record<string, unknown>;
    if (typeof parsed.event_id === "string" && typeof parsed.kind === "string" && typeof parsed.ts === "string") {
      return parsed as SseEvent;
    }
    return null;
  } catch { return null; }
};

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const t = setTimeout(() => { resolve(); }, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });

/** Open an SSE connection to <aux>/events/stream and yield each parsed
 *  event. Reconnects automatically on disconnect unless `reconnect=false`.
 *  Throw-safe: if the daemon is unreachable from the very first attempt we
 *  surface the fetch error so the caller can decide to abort or retry. */
export async function* sseConnect(opts: SseConnectOpts = {}): AsyncGenerator<SseEvent> {
  const reconnect = opts.reconnect !== false;
  const initial = opts.backoffMs ?? 1000;
  const cap = opts.backoffCapMs ?? 8000;
  let backoff = initial;
  while (!opts.signal?.aborted) {
    const base = auxBaseUrl(opts);
    if (!base) {
      if (!reconnect) throw new Error("daemon not running — start it with `acc daemon start`");
      await sleep(backoff, opts.signal);
      backoff = Math.min(backoff * 2, cap);
      continue;
    }
    let res: Response;
    try {
      res = await fetch(`${base}/events/stream`, {
        method: "GET",
        headers: { accept: "text/event-stream" },
        signal: opts.signal,
      });
    } catch (err) {
      if (opts.signal?.aborted) return;
      if (!reconnect) throw err;
      await sleep(backoff, opts.signal);
      backoff = Math.min(backoff * 2, cap);
      continue;
    }
    if (!res.ok || !res.body) {
      if (!reconnect) throw new Error(`sse_failed:${res.status}`);
      await sleep(backoff, opts.signal);
      backoff = Math.min(backoff * 2, cap);
      continue;
    }
    // Reset backoff on a successful connect.
    backoff = initial;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!opts.signal?.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE frame separator is \n\n; we split on the literal sequence.
        let idx = buffer.indexOf("\n\n");
        while (idx !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const ev = parseSseFrame(frame);
          if (ev) yield ev;
          idx = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // Disconnect / cancel — fall through to reconnect (or exit). This is
      // expected on graceful close; SSE is long-lived and the caller owns
      // abort. No emit because we have no db handle from a CLI surface.
    } finally {
      try {
        await reader.cancel();
      } catch (cancelErr) {
        // cancel after close throws — benign tail in the disconnect path
        void cancelErr;
      }
    }
    if (!reconnect || opts.signal?.aborted) return;
    await sleep(backoff, opts.signal);
    backoff = Math.min(backoff * 2, cap);
  }
}

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

// ── Persistent MCP client (2026-05-21 SQLite bottleneck audit fix) ──
// Pre-fix: every mcpCall opened a NEW StreamableHTTPClientTransport →
// new MCP session on the daemon's fastmcp registry. One `acc task`
// invocation makes 10-20 mcpCalls (open_directive, recent_events, two
// owner_input emits, owner_insight, plus poll loop calls). At 10-20
// sessions per CLI invocation, repeated `acc task` invocations across
// terminals saturated fastmcp's session table — observed 48K+ sessions
// established during a single 4h session, with the daemon spending its
// CPU on session-establishment overhead rather than tool execution.
//
// Post-fix: per-process cached client. First mcpCall in the process
// connects once; subsequent calls reuse the same client + transport.
// Process exit closes the client (registered via process.on("exit")).
// Each `acc task` now opens ONE session instead of 10-20. Multiplied
// across multiple terminals and the orchestrator, this drops the
// daemon's session pressure by ~95%.
type CachedMcpClient = {
  client: Client;
  baseUrl: string;
  connecting: Promise<void> | null;
};
let cachedMcp: CachedMcpClient | null = null;
let mcpCloseHookInstalled = false;

const installMcpCloseHook = (): void => {
  if (mcpCloseHookInstalled) return;
  mcpCloseHookInstalled = true;
  const close = async (): Promise<void> => {
    if (cachedMcp) {
      try { await cachedMcp.client.close(); } catch { /* swallow */ }
      cachedMcp = null;
    }
  };
  // Bun + node both honor "beforeExit"; "exit" is too late for async.
  process.on("beforeExit", () => { void close(); });
  process.on("SIGINT", () => { void close().finally(() => process.exit(130)); });
  process.on("SIGTERM", () => { void close().finally(() => process.exit(143)); });
};

const getMcpClient = async (baseUrl: string, timeoutMs: number): Promise<Client> => {
  installMcpCloseHook();
  if (cachedMcp && cachedMcp.baseUrl === baseUrl) {
    // Wait for any in-flight connect, then return the shared client.
    if (cachedMcp.connecting) await cachedMcp.connecting;
    return cachedMcp.client;
  }
  // If a prior cached client exists for a different base (daemon restart
  // moved the port), tear it down before creating the new one.
  if (cachedMcp) {
    try { await cachedMcp.client.close(); } catch { /* swallow */ }
    cachedMcp = null;
  }
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
  const client = new Client({ name: "acc2-cli", version: "0.0.1" }, { capabilities: {} });
  const connecting = Promise.race([
    client.connect(transport),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`mcp_connect_timeout:${timeoutMs}ms`)), timeoutMs),
    ),
  ]) as Promise<void>;
  cachedMcp = { client, baseUrl, connecting };
  try {
    await connecting;
    cachedMcp.connecting = null;
    return client;
  } catch (err) {
    // Connect failed — drop the cache so the next call retries fresh.
    cachedMcp = null;
    try { await client.close(); } catch { /* swallow */ }
    throw err;
  }
};

/** Invalidate the cached MCP client. Used by recovery paths that detect
 *  a wedged connection (call timeout, transport error) so the next
 *  mcpCall reconnects fresh instead of reusing a dead client. */
export const invalidateMcpClient = async (): Promise<void> => {
  if (!cachedMcp) return;
  const prev = cachedMcp;
  cachedMcp = null;
  try { await prev.client.close(); } catch { /* swallow */ }
};

/** Open an MCP client against the daemon's MCP port, invoke one tool.
 *  This is the canonical CLI → substrate call path for substrate.* methods.
 *  Connection is reused across calls in the same process (cached client);
 *  the daemon sees ONE session per CLI process instead of one per call.
 *  Robustness: the entire connect + callTool path is bounded by
 *  `MCP_CALL_TIMEOUT_MS` (30s default; bridge → daemon tool calls). On
 *  timeout the cached client is invalidated so the next call reconnects. */
export const mcpCall = async (
  toolName: string,
  args: Record<string, unknown>,
  opts: RpcOpts & { timeoutMs?: number } = {},
): Promise<McpEnvelope> => {
  const base = requireMcp(opts);
  const timeoutMs = opts.timeoutMs ?? MCP_CALL_TIMEOUT_MS;
  let client: Client;
  try {
    client = await getMcpClient(base, timeoutMs);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (msg.includes("timeout") || msg.includes("Timeout") || msg.includes("RequestTimeout")) {
      return { ok: false, error: `timeout:${timeoutMs}ms:mcp_connect` };
    }
    return { ok: false, error: `mcp_connect_failed:${msg}` };
  }
  try {
    const res = await client.callTool(
      { name: toolName, arguments: args },
      undefined,
      { timeout: timeoutMs },
    ) as { content: Array<{ type: string; text?: string }> };
    return parseEnvelope(res);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    // Invalidate the cached client on transport-level error so the next
    // call doesn't reuse a dead connection. Tool-level errors (validation,
    // domain) preserve the client.
    if (msg.includes("timeout") || msg.includes("Timeout") || msg.includes("RequestTimeout") || msg.includes("transport") || msg.includes("ECONN")) {
      await invalidateMcpClient();
      return { ok: false, error: `timeout:${timeoutMs}ms:mcp:${toolName}` };
    }
    return { ok: false, error: `mcp_call_failed:${msg}` };
  }
};
