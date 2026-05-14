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
 *  headroom for the daemon to do real work behind the route. */
export const HEALTH_TIMEOUT_MS = 5_000;
export const SHUTDOWN_TIMEOUT_MS = 10_000;
export const EXTERNAL_PUSH_TIMEOUT_MS = 10_000;
export const MCP_CALL_TIMEOUT_MS = 30_000;
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

/** Open an MCP client against the daemon's MCP port, invoke one tool, close.
 *  This is the canonical CLI → substrate call path for substrate.* methods.
 *  Robustness: the entire connect + callTool path is bounded by
 *  `MCP_CALL_TIMEOUT_MS` (30s default; bridge → daemon tool calls). A wedged
 *  daemon now produces a structured `{ ok:false, error:"timeout:..." }`
 *  envelope instead of hanging the CLI indefinitely. */
export const mcpCall = async (
  toolName: string,
  args: Record<string, unknown>,
  opts: RpcOpts & { timeoutMs?: number } = {},
): Promise<McpEnvelope> => {
  const base = requireMcp(opts);
  const timeoutMs = opts.timeoutMs ?? MCP_CALL_TIMEOUT_MS;
  const transport = new StreamableHTTPClientTransport(new URL(base));
  const client = new Client({ name: "acc2-cli", version: "0.0.1" }, { capabilities: {} });
  try {
    // Bound the connect step explicitly — a wedged transport handshake
    // would otherwise sit forever waiting on the daemon's first frame.
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`mcp_connect_timeout:${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
    // callTool accepts a RequestOptions.timeout — feeds the protocol's own
    // RequestTimeout enforcement so the daemon side learns the request was
    // abandoned and frees its slot.
    const res = await client.callTool(
      { name: toolName, arguments: args },
      undefined,
      { timeout: timeoutMs },
    ) as { content: Array<{ type: string; text?: string }> };
    return parseEnvelope(res);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (msg.includes("timeout") || msg.includes("Timeout") || msg.includes("RequestTimeout")) {
      return { ok: false, error: `timeout:${timeoutMs}ms:mcp:${toolName}` };
    }
    return { ok: false, error: `mcp_call_failed:${msg}` };
  } finally {
    try {
      await client.close();
    } catch (closeErr) {
      // close() throws when the client never connected — benign during
      // shutdown / timeout paths. Caller already has the envelope it needs.
      void closeErr;
    }
  }
};
