// cli/tui/transport/substrate-client.ts — thin wrapper over aux reads + sseConnect.
//
// The TUI never opens SQLite directly (per cli/watch.ts:23 substrate has
// converged; direct reads are forbidden). Every view read goes through
// substrate.read; every live event stream goes through sseConnect. This
// module exists so the TUI components depend on ONE typed surface and the
// transport can be swapped in tests by passing a mock SubstrateClient.

import { auxRead, auxRecentEvents, sseConnect, auxBaseUrl, rpcGet, type SseEvent } from "../../rpc";

export type ViewEnvelope<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; error: string };

export type SubstrateClient = {
  read: <T = unknown>(viewName: string, args?: Record<string, unknown>) => Promise<ViewEnvelope<T>>;
  recentEvents: (kinds: string[], k?: number) => Promise<ViewEnvelope<{ events: SseEvent[] }>>;
  health: () => Promise<{ ok: boolean; status: string; uptime_s?: number; events_count?: unknown; pid?: unknown; stuck_workers?: unknown[] }>;
  sseConnect: (opts?: { signal?: AbortSignal }) => AsyncGenerator<SseEvent>;
};

const callRead = async <T>(viewName: string, args: Record<string, unknown> = {}): Promise<ViewEnvelope<T>> => {
  try {
    const env = await auxRead<T>(viewName, args);
    if (env.ok) return { ok: true, result: env.result as T };
    return { ok: false, error: env.error };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
};

const callRecent = async (kinds: string[], k = 200): Promise<ViewEnvelope<{ events: SseEvent[] }>> => {
  try {
    const env = await auxRecentEvents({ kinds, k });
    if (env.ok) return { ok: true, result: env.result as { events: SseEvent[] } };
    return { ok: false, error: env.error };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
};

const callHealth = async (): Promise<{ ok: boolean; status: string; uptime_s?: number; events_count?: unknown; pid?: unknown; stuck_workers?: unknown[] }> => {
  // Daemon health lives on the aux-port HTTP endpoint (/health), not MCP.
  // The same surface `acc daemon status` + cli/status.ts use. An MCP call to a
  // non-existent runtime.health method would silently return ok:false and
  // the TUI would render uptime=? events=? verdict=DEAD against a live
  // daemon — which is exactly the symptom the owner caught.
  try {
    const base = auxBaseUrl();
    if (!base) return { ok: false, status: "not_running" };
    const r = await rpcGet<Record<string, unknown>>(`${base}/health`);
    return {
      ok: true,
      status: String(r.status ?? "unknown"),
      uptime_s: typeof r.uptime_ms === "number" ? Math.round(r.uptime_ms / 1000) : undefined,
      events_count: r.events_count,
      pid: r.pid,
      stuck_workers: Array.isArray(r.stuck_workers) ? r.stuck_workers : [],
    };
  } catch (err) {
    return { ok: false, status: `error:${(err as Error).message}` };
  }
};

export const realSubstrateClient = (): SubstrateClient => ({
  read: callRead,
  recentEvents: callRecent,
  health: callHealth,
  sseConnect: (opts) => sseConnect({ signal: opts?.signal, reconnect: true }),
});

export type { SseEvent };
