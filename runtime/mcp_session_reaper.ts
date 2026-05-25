// acc2 MCP session garbage collector.
//
// ROOT CAUSE this module fixes. The daemon hosts ONE fastmcp server over the
// httpStream (Streamable-HTTP) transport. fastmcp creates exactly one
// FastMCPSession per client CONNECTION — every `acc task`, every orchestrator
// poll, every opencode brain dispatch opens its own session. fastmcp removes
// a session from its internal `#sessions` array only when the underlying
// transport's `onclose` fires (mcp-proxy → cleanupServer → fastmcp splices
// `#sessions` + emits `disconnect`). For an UNGRACEFULLY-closed client (TCP /
// SSE socket dies without a clean DELETE), the server-side transport.onclose
// does NOT fire promptly, so the session LEAKS — it stays in `server.sessions`
// forever. After hundreds-to-~1000 leaked sessions accumulate, the daemon
// event loop spends most cycles servicing them and CPU pegs at 93-100%.
//
// THE GC. fastmcp exposes `server.sessions` read-only; there is no public
// `removeSession`. But each `FastMCPSession` has `close()`, which calls the
// underlying SDK `Server.close()`, which closes the transport, which fires
// `transport.onclose` → mcp-proxy `cleanupServer` → fastmcp's onClose splices
// `#sessions`. So calling `session.close()` IS the canonical removal path.
// The reaper force-closes sessions that are:
//   - DEAD     — `session.server.transport` is already `undefined` (the SDK
//                Server closed its transport but fastmcp hasn't spliced it),
//   - IDLE     — no MESSAGE observed on the session's transport for longer than
//                `idleTtlMs` (a leaked session goes silent; an alive one keeps
//                emitting — tool calls, notifications, ping/pong), or
//   - OVER CAP — when total sessions exceed `maxSessions`, evict the
//                least-recently-active surplus first.
// A live, recently-ACTIVE session is always kept.
//
// IDLE = idle-since-last-activity, NOT session age (fixed 2026-05-25). The
// previous check reaped on age-since-first-seen, which is correct for a
// transient CLI/opencode dispatch (~6 min) but WRONG for a long-lived client:
// the Claude Code chat holds ONE Streamable-HTTP session for the whole
// conversation (hours). Age-based reaping culled that session every ~10 min
// MID-USE, dropping the operator's MCP tools. Activity tracking distinguishes
// "old but actively serving" (keep) from "leaked and silent" (reap): the
// reaper wraps the transport's `onmessage` once per session to stamp a
// last-activity time, and reaps only sessions silent past the TTL.
//
// The `disconnect` event hook (wired in mcp_server/index.ts) drops a session's
// tracking row the moment fastmcp removes it gracefully, so the reaper's
// first-seen registry never grows unbounded and never mistakes a graceful
// reconnect for a leak.
//
// This module is pure logic over an injectable session shape so it unit-tests
// without a real daemon / real fastmcp server. The daemon wires it as a
// periodic worker (runtime/daemon.ts) gated by isWorkerEnabled, exactly like
// every other worker.

import type { Database } from "bun:sqlite";
import { emitEvent } from "./events";
import { logger } from "./logger";

/** Default idle TTL (ms). A session with NO transport message for longer than
 *  this is treated as leaked/silent and reaped. Measured from last ACTIVITY
 *  (not connect time), so it bounds genuinely-silent sessions while never
 *  culling an actively-served one. 30 min comfortably spans human-paced gaps
 *  between an operator's chat tool calls while still reclaiming leaked CLI /
 *  opencode sessions well under the cap. Override via
 *  ACC2_MCP_SESSION_IDLE_TTL_MS. */
export const DEFAULT_SESSION_IDLE_TTL_MS = 30 * 60_000;

/** Default hard cap on concurrent sessions. The substrate's real concurrency
 *  (CLI + orchestrator polls + bounded parallel brain dispatch) sits well
 *  under this; crossing it means sessions are leaking. Over-cap surplus is
 *  evicted oldest-first regardless of TTL. Override via
 *  ACC2_MCP_SESSION_MAX. */
export const DEFAULT_MAX_SESSIONS = 64;

/** Default reaper tick cadence (ms). Override via ACC2_MCP_SESSION_REAP_MS. */
export const DEFAULT_REAP_INTERVAL_MS = 30_000;

const envInt = (name: string, fallback: number, min: number, max: number): number => {
  const raw = process.env[name];
  if (typeof raw === "string" && raw.length > 0) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= min && n <= max) return n;
  }
  return fallback;
};

export const resolveSessionIdleTtlMs = (): number =>
  envInt("ACC2_MCP_SESSION_IDLE_TTL_MS", DEFAULT_SESSION_IDLE_TTL_MS, 30_000, 6 * 60 * 60_000);
export const resolveMaxSessions = (): number =>
  envInt("ACC2_MCP_SESSION_MAX", DEFAULT_MAX_SESSIONS, 4, 100_000);
export const resolveReapIntervalMs = (): number =>
  envInt("ACC2_MCP_SESSION_REAP_MS", DEFAULT_REAP_INTERVAL_MS, 1_000, 10 * 60_000);

/** The minimal slice of a FastMCPSession the reaper depends on. Kept
 *  structural so tests inject plain objects and the real FastMCPSession (which
 *  has `close(): Promise<void>` and `get server(): { transport?: unknown }`)
 *  satisfies it. */
export interface ReapableSession {
  /** The underlying SDK Server. `server.transport` is `undefined` once the
   *  connection is closed — our DEAD signal. Optional/loose because tests
   *  inject simplified shapes. */
  readonly server?: { readonly transport?: unknown } | undefined;
  /** fastmcp's readiness flag. A never-ready session that has aged out is a
   *  leak; a ready session is kept unless dead/idle/over-cap. */
  readonly isReady?: boolean;
  close(): Promise<void> | void;
}

/** The minimal slice of a FastMCP server the reaper depends on. */
export interface ReapableServer {
  readonly sessions: ReapableSession[];
}

/** Per-session tracking row. `firstSeenMs` is when the session was first
 *  observed; `lastActivityMs` is the last time a message crossed its transport
 *  (initialised to firstSeenMs, then bumped by the onmessage probe). Idle-TTL
 *  eviction is measured from `lastActivityMs`. */
type SessionTrack = { firstSeenMs: number; lastActivityMs: number };

/** The reaper's session registry, keyed by the session object identity.
 *  WeakMap so a session GC'd by the JS runtime drops its row automatically;
 *  the `disconnect` hook also drops rows on graceful close. */
export class McpSessionReaper {
  readonly idleTtlMs: number;
  readonly maxSessions: number;
  private readonly tracks = new WeakMap<ReapableSession, SessionTrack>();
  /** Transports whose `onmessage` we have already wrapped — wrap exactly once
   *  per transport so reconnects (new transport object) re-probe but a stable
   *  transport is not double-wrapped. */
  private readonly probed = new WeakSet<object>();

  constructor(opts?: { idleTtlMs?: number; maxSessions?: number }) {
    this.idleTtlMs = opts?.idleTtlMs ?? resolveSessionIdleTtlMs();
    this.maxSessions = opts?.maxSessions ?? resolveMaxSessions();
  }

  /** Record a freshly-connected session so its clocks start now. Called from
   *  the fastmcp `connect` hook (and idempotently from `reapOnce` for any
   *  session it sees for the first time). */
  noteConnect(session: ReapableSession, nowMs: number = Date.now()): void {
    if (!this.tracks.has(session)) this.tracks.set(session, { firstSeenMs: nowMs, lastActivityMs: nowMs });
  }

  /** Drop a session's tracking row. Called from the fastmcp `disconnect` hook
   *  so gracefully-closed sessions never linger in the registry. */
  noteDisconnect(session: ReapableSession): void {
    this.tracks.delete(session);
  }

  /** Stamp a session as active right now (its transport saw a message). */
  noteActivity(session: ReapableSession, nowMs: number = Date.now()): void {
    const track = this.tracks.get(session);
    if (track) track.lastActivityMs = nowMs;
    else this.tracks.set(session, { firstSeenMs: nowMs, lastActivityMs: nowMs });
  }

  /** Wrap the session transport's `onmessage` ONCE so every inbound message
   *  (tool call, notification, ping/pong) stamps last-activity. Fully
   *  defensive: only wraps a function handler the SDK has already installed,
   *  preserves it exactly (forwards `this` + all args), never throws, and falls
   *  back to no-op if the transport/handler is not yet present (re-tried next
   *  tick). A leaked, silent session is never stamped → it ages out and is
   *  reaped; an actively-served session is stamped continuously → kept. */
  attachActivityProbe(session: ReapableSession): void {
    try {
      const transport = (session.server as { transport?: unknown } | undefined)?.transport as
        | { onmessage?: unknown }
        | undefined;
      if (!transport || typeof transport !== "object") return;
      if (this.probed.has(transport)) return;
      const original = transport.onmessage;
      if (typeof original !== "function") return; // SDK handler not installed yet — try next tick
      const reaper = this;
      (transport as { onmessage: unknown }).onmessage = function (this: unknown, ...args: unknown[]) {
        try { reaper.noteActivity(session); } catch { /* timestamp is best-effort, never break message flow */ }
        return (original as (...a: unknown[]) => unknown).apply(this, args);
      };
      this.probed.add(transport);
    } catch { /* probing is best-effort; on any failure the age-fallback still bounds leaks */ }
  }

  /** True iff the session's underlying transport is already gone (the SDK
   *  Server closed but fastmcp has not yet spliced it). */
  private isDead(session: ReapableSession): boolean {
    // `server` present but `transport` undefined === closed connection.
    // A session with no `server` at all is treated as not-yet-dead (it may be
    // mid-handshake) and falls through to the idle-TTL check.
    return session.server != null && session.server.transport == null;
  }

  private isIdleExpired(session: ReapableSession, nowMs: number): boolean {
    const track = this.tracks.get(session);
    if (!track) return false; // just observed this tick → not expired yet
    // Idle = silent since last activity, NOT old since connect. An actively-
    // served long-lived session (e.g. the operator's chat) keeps lastActivityMs
    // fresh and is never reaped; a leaked, silent session ages out.
    return nowMs - track.lastActivityMs > this.idleTtlMs;
  }

  /**
   * One reap pass over `server.sessions`. Pure decision logic + best-effort
   * `close()` on each victim; never throws (a close failure is logged and the
   * pass continues). Returns the decision breakdown for observability + tests.
   *
   * Selection:
   *   1. DEAD sessions (transport gone) — always reaped.
   *   2. IDLE sessions (silent since last activity longer than idleTtlMs) — reaped.
   *   3. OVER-CAP surplus — after (1)+(2), if survivors still exceed
   *      maxSessions, the LEAST-RECENTLY-ACTIVE survivors are reaped down to
   *      the cap (so an actively-served long-lived session is evicted last).
   * Live, recently-active, within-cap sessions are kept.
   */
  async reapOnce(server: ReapableServer, nowMs: number = Date.now()): Promise<{
    total: number;
    reaped_dead: number;
    reaped_idle: number;
    reaped_over_cap: number;
    remaining: number;
    close_failures: number;
  }> {
    const sessions = server.sessions ?? [];
    const total = sessions.length;
    // First-seen bookkeeping + attach the activity probe for any session we
    // have not tracked/probed yet (idempotent; covers sessions that connected
    // before any explicit noteConnect hook fired).
    for (const s of sessions) {
      this.noteConnect(s, nowMs);
      this.attachActivityProbe(s);
    }

    const victims = new Set<ReapableSession>();
    let reaped_dead = 0;
    let reaped_idle = 0;
    for (const s of sessions) {
      if (this.isDead(s)) {
        victims.add(s);
        reaped_dead++;
      } else if (this.isIdleExpired(s, nowMs)) {
        victims.add(s);
        reaped_idle++;
      }
    }

    // Over-cap eviction: survivors beyond the cap, oldest-first.
    let reaped_over_cap = 0;
    const survivors = sessions.filter((s) => !victims.has(s));
    if (survivors.length > this.maxSessions) {
      const surplus = survivors
        .map((s) => ({ s, lastActivityMs: this.tracks.get(s)?.lastActivityMs ?? nowMs }))
        .sort((a, b) => a.lastActivityMs - b.lastActivityMs) // least-recently-active first
        .slice(0, survivors.length - this.maxSessions);
      for (const { s } of surplus) {
        victims.add(s);
        reaped_over_cap++;
      }
    }

    let close_failures = 0;
    for (const v of victims) {
      this.tracks.delete(v);
      try {
        await v.close();
      } catch (err) {
        close_failures++;
        logger.debug(
          { where: "mcp_session_reaper.close", err: String(err) },
          "session.close() failed during reap (best-effort)",
        );
      }
    }

    const reapedTotal = reaped_dead + reaped_idle + reaped_over_cap;
    return {
      total,
      reaped_dead,
      reaped_idle,
      reaped_over_cap,
      remaining: total - reapedTotal,
      close_failures,
    };
  }
}

/** One worker tick: run the reaper over the live fastmcp server and emit
 *  `mcp_sessions_reaped` to the ledger when ≥1 session was reaped (silence on
 *  a clean pass keeps the ledger quiet — the GC only narrates when it acts).
 *  Fail-soft: any error is logged, never thrown, so a reap failure can never
 *  crash the daemon. */
export const runMcpSessionReaperTick = async (
  db: Database,
  reaper: McpSessionReaper,
  server: ReapableServer,
  nowMs: number = Date.now(),
): Promise<void> => {
  const result = await reaper.reapOnce(server, nowMs);
  const reapedTotal = result.reaped_dead + result.reaped_idle + result.reaped_over_cap;
  if (reapedTotal === 0) return;
  try {
    emitEvent(db, {
      kind: "mcp_sessions_reaped",
      substrate_origin: "substrate_auto",
      payload: {
        reaped_total: reapedTotal,
        reaped_dead: result.reaped_dead,
        reaped_idle: result.reaped_idle,
        reaped_over_cap: result.reaped_over_cap,
        remaining: result.remaining,
        sessions_before: result.total,
        close_failures: result.close_failures,
        idle_ttl_ms: reaper.idleTtlMs,
        max_sessions: reaper.maxSessions,
      },
    });
  } catch (err) {
    logger.debug(
      { where: "runMcpSessionReaperTick.emit", err: String(err) },
      "could not emit mcp_sessions_reaped (db likely closed)",
    );
  }
  logger.info(
    {
      reaped_total: reapedTotal,
      reaped_dead: result.reaped_dead,
      reaped_idle: result.reaped_idle,
      reaped_over_cap: result.reaped_over_cap,
      remaining: result.remaining,
    },
    "mcp session reaper reclaimed leaked/dead/over-cap sessions",
  );
};
