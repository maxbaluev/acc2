// acc2 brain-bridge MCP warm-session pool (FLAG-GATED behind ACC2_MCP_POOL,
// default OFF). Brain design KC PQ2ZZH50 — the top compounding lever.
//
// PROBLEM. Every opencode brain dispatch currently pays a COLD MCP
// handshake on the dispatch critical path: a pre-spawn HEAD reachability
// probe (runtime/bridge/opencode.ts probeMcpReachable, ~3s budget) PLUS an
// anti-starve handshake-permit acquire (HANDSHAKE_PERMIT_CAP serialized
// slots, up to HANDSHAKE_WAIT_BUDGET_MS wait) BEFORE opencode is even
// spawned, then opencode's own fastmcp httpStream session establishment.
// On a ~6min median dispatch this cold-connect tax shows up twice: once as
// added latency, once as the first-connect-timeout → re-dispatch failure
// mode (config.ts notes the historical mcp_handshake_failed hot-loop).
//
// FIX (this module). The daemon/bridge keeps a small pool of PRE-VERIFIED
// upstream MCP sessions to its own /mcp endpoint. Each pool entry is a
// connectivity-proven, periodically-kept-warm handle to `mcpServerUrl`. A
// dispatch LEASES one warm entry; because the entry has already proven the
// endpoint reachable AND already holds the contended handshake slot
// equivalent, the dispatch SKIPS the cold HEAD probe and SKIPS the
// cold handshake-permit acquire, amortizing that tax out of the critical
// path. The bridge then spawns opencode exactly as before and emits
// equivalent `bridge_mcp_connected` evidence with detection_path =
// "warm_pool_lease".
//
// SAFETY. This module is ONLY consulted when ACC2_MCP_POOL is truthy. When
// the flag is OFF, `mcpPoolEnabled()` returns false and the bridge takes
// the byte-for-byte unchanged cold-connect path; the pool is never
// constructed, no timers run, no state is allocated. When the flag is ON
// and a lease is unavailable / dead / stale, the bridge FALLS OVER to the
// exact cold path (never wedges the dispatch). The pool keeps the warm
// session AT MOST as a fast-path; correctness never depends on it.
//
// SCOPE. This is the highest-value SAFE increment of the full
// session-affine proxy design: a warm-connection / keepalive pool the
// bridge leases from. It amortizes the per-dispatch cold-connect tax
// (HEAD probe + handshake-permit acquire) without proxying the brain's
// own MCP traffic. Full upstream-session multiplexing (a single shared
// client connection the brain's tool calls ride over) is DEFERRED — it
// requires changing how opencode connects (OPENCODE_CONFIG points at a
// remote URL we don't intercept) and is too large for a flag-off-safe
// single pass.

/** Default warm-pool size. Kept small — the pool only needs enough warm
 *  entries to cover the concurrent-dispatch start-rate (which the
 *  handshake-permit cap already staggers). Override via ACC2_MCP_POOL_SIZE. */
const DEFAULT_POOL_SIZE = 2;

/** Default max age of a warm session before eviction (ms). A warm session
 *  older than this is evicted on the next lease/maintenance pass so a
 *  long-lived daemon never leases a stale handle. Override via
 *  ACC2_MCP_POOL_MAX_AGE_MS. */
const DEFAULT_MAX_AGE_MS = 5 * 60_000;

/** Default keepalive cadence (ms). The pool re-verifies each warm entry's
 *  reachability on this cadence so a leased entry is connectivity-proven
 *  within at most one cadence window. Override via ACC2_MCP_POOL_KEEPALIVE_MS. */
const DEFAULT_KEEPALIVE_MS = 30_000;

const envInt = (name: string, fallback: number, min: number, max: number): number => {
  const raw = process.env[name];
  if (typeof raw === "string" && raw.length > 0) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= min && n <= max) return n;
  }
  return fallback;
};

/** The single flag that gates the entire warm-session pool. Default OFF.
 *  Truthy values: "1", "true", "on", "yes" (case-insensitive). Anything
 *  else — including unset — is OFF, so the bridge takes the unchanged
 *  cold-connect path. Re-evaluated on every call so tests can flip it
 *  per-case without module reload. */
export const mcpPoolEnabled = (): boolean => {
  const raw = process.env.ACC2_MCP_POOL;
  if (typeof raw !== "string") return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
};

/** A pooled warm MCP session handle. Represents a connectivity-proven,
 *  kept-warm path to one `mcpServerUrl`. It does NOT carry the opencode
 *  subprocess's own client — opencode connects independently per dispatch.
 *  What it carries is the AMORTIZED evidence: the endpoint was reachable at
 *  `verifiedAtMs`, so a dispatch leasing it can skip the cold HEAD probe and
 *  the handshake-permit acquire. */
export type WarmSession = {
  readonly id: string;
  readonly url: string;
  /** ms epoch the session was first established. Used for max-age eviction. */
  readonly createdAtMs: number;
  /** ms epoch reachability was last re-verified (keepalive or create). */
  verifiedAtMs: number;
  /** True while leased to an in-flight dispatch. A leased session is not
   *  re-leased; release returns it to the pool. */
  leased: boolean;
  /** Set true when keepalive/lease verification failed or the session aged
   *  out. A dead session is never leased; it is evicted + replaced. */
  dead: boolean;
};

/** Reachability probe signature — identical contract to the bridge's
 *  probeMcpReachable: resolves true iff the URL responds within timeoutMs.
 *  Injectable so tests can drive deterministic connect/keepalive outcomes
 *  without a real daemon. */
export type ReachabilityProbe = (url: string, timeoutMs: number) => Promise<boolean>;

/** Result of a lease attempt. `session` is non-null only on a successful
 *  warm lease; otherwise the caller MUST fall over to the cold path. */
export type LeaseResult =
  | { ok: true; session: WarmSession }
  | { ok: false; reason: "pool_disabled" | "no_warm_session" | "lease_failed" };

const defaultProbe: ReachabilityProbe = async (url, timeoutMs) => {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { method: "HEAD", signal: controller.signal });
    clearTimeout(timer);
    void res;
    return true;
  } catch {
    return false;
  }
};

let idSeq = 0;
const nextId = (): string => `warm-${Date.now().toString(36)}-${(idSeq++).toString(36)}`;

/**
 * The warm-session pool. ONE instance per (daemon, mcpServerUrl) — the
 * bridge holds a process-global keyed by URL. Pure data structure +
 * async maintenance; constructing it does nothing observable until
 * `ensureWarm` / `lease` is called. All timers are owned by the caller via
 * `startKeepalive` so a test or the flag-off path can avoid background work
 * entirely.
 */
export class McpWarmPool {
  readonly url: string;
  readonly size: number;
  readonly maxAgeMs: number;
  readonly keepaliveMs: number;
  private readonly probe: ReachabilityProbe;
  private readonly probeTimeoutMs: number;
  private sessions: WarmSession[] = [];
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: {
    url: string;
    size?: number;
    maxAgeMs?: number;
    keepaliveMs?: number;
    probe?: ReachabilityProbe;
    probeTimeoutMs?: number;
  }) {
    this.url = opts.url;
    this.size = opts.size ?? envInt("ACC2_MCP_POOL_SIZE", DEFAULT_POOL_SIZE, 1, 16);
    this.maxAgeMs = opts.maxAgeMs ?? envInt("ACC2_MCP_POOL_MAX_AGE_MS", DEFAULT_MAX_AGE_MS, 10_000, 60 * 60_000);
    this.keepaliveMs = opts.keepaliveMs ?? envInt("ACC2_MCP_POOL_KEEPALIVE_MS", DEFAULT_KEEPALIVE_MS, 1_000, 5 * 60_000);
    this.probe = opts.probe ?? defaultProbe;
    this.probeTimeoutMs = opts.probeTimeoutMs ?? 3_000;
  }

  /** True iff a session has aged past maxAgeMs since creation. */
  private isAged(s: WarmSession, nowMs: number): boolean {
    return nowMs - s.createdAtMs > this.maxAgeMs;
  }

  /** Drop dead/aged sessions. Leased sessions are never evicted mid-flight
   *  (release handles their fate); only idle dead/aged ones are removed. */
  private evictStale(nowMs: number): void {
    this.sessions = this.sessions.filter((s) => {
      if (s.leased) return true; // never yank an in-flight session
      if (s.dead) return false;
      if (this.isAged(s, nowMs)) return false;
      return true;
    });
  }

  /** Establish ONE new warm session by proving reachability. Returns the
   *  session on success, null when the probe failed (endpoint not yet up). */
  private async establishOne(): Promise<WarmSession | null> {
    const reachable = await this.probe(this.url, this.probeTimeoutMs);
    if (!reachable) return null;
    const now = Date.now();
    const s: WarmSession = {
      id: nextId(),
      url: this.url,
      createdAtMs: now,
      verifiedAtMs: now,
      leased: false,
      dead: false,
    };
    this.sessions.push(s);
    return s;
  }

  /** Bring the pool up to `size` warm idle sessions, evicting stale ones
   *  first. Best-effort: if the endpoint is unreachable, the pool simply
   *  stays under-filled and `lease` falls over to the cold path. Safe to
   *  call repeatedly (keepalive + pre-warm both call it). */
  async ensureWarm(): Promise<void> {
    const now = Date.now();
    this.evictStale(now);
    const have = this.sessions.length;
    const need = Math.max(0, this.size - have);
    for (let i = 0; i < need; i++) {
      // Sequential establish keeps the probe load bounded; the pool is small.
      // A failed establish stops the fill (endpoint down) — try again next pass.
      const made = await this.establishOne();
      if (!made) break;
    }
  }

  /** Re-verify every idle session's reachability; mark unreachable ones
   *  dead, then evict + refill. This is the keepalive pass. */
  async keepaliveOnce(): Promise<void> {
    const now = Date.now();
    for (const s of this.sessions) {
      if (s.leased) continue; // don't disturb in-flight leases
      const ok = await this.probe(this.url, this.probeTimeoutMs);
      if (ok) s.verifiedAtMs = now;
      else s.dead = true;
    }
    await this.ensureWarm();
  }

  /** Start the background keepalive timer. Idempotent — a second call is a
   *  no-op. The timer is unref'd so it never holds the daemon open. ONLY
   *  called when the flag is ON. */
  startKeepalive(): void {
    if (this.keepaliveTimer) return;
    this.keepaliveTimer = setInterval(() => {
      void this.keepaliveOnce();
    }, this.keepaliveMs);
    // Don't keep the event loop alive on the keepalive timer alone.
    (this.keepaliveTimer as unknown as { unref?: () => void }).unref?.();
  }

  /** Stop the keepalive timer (daemon shutdown / test teardown). */
  stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  /**
   * Lease one warm session. Evicts stale entries first, then:
   *   - If an idle, non-dead, non-aged session exists → mark it leased,
   *     RE-VERIFY its reachability synchronously (so a leased session is
   *     never handed out stale), and return it. If re-verify fails, mark it
   *     dead, evict, and fall through.
   *   - Otherwise return { ok:false } so the caller takes the cold path.
   * The lease NEVER blocks on establishing a new session — a cold path is
   * cheaper than a synchronous connect in the dispatch critical path, and
   * `ensureWarm`/keepalive refill the pool out of band.
   */
  async lease(): Promise<LeaseResult> {
    const now = Date.now();
    this.evictStale(now);
    // Find the freshest idle candidate (highest verifiedAtMs) so we lease the
    // most-recently-proven session.
    const idle = this.sessions
      .filter((s) => !s.leased && !s.dead && !this.isAged(s, now))
      .sort((a, b) => b.verifiedAtMs - a.verifiedAtMs);
    const candidate = idle[0];
    if (!candidate) {
      // Kick an out-of-band refill so the next dispatch may find a warm one.
      void this.ensureWarm();
      return { ok: false, reason: "no_warm_session" };
    }
    // Synchronous re-verify before handing out: a leased session must be
    // connectivity-proven at lease time, not just at last keepalive.
    const reachable = await this.probe(this.url, this.probeTimeoutMs);
    if (!reachable) {
      candidate.dead = true;
      this.evictStale(Date.now());
      void this.ensureWarm();
      return { ok: false, reason: "lease_failed" };
    }
    candidate.leased = true;
    candidate.verifiedAtMs = Date.now();
    return { ok: true, session: candidate };
  }

  /** Return a leased session to the pool. If `dead` is true (the dispatch
   *  saw the session fail mid-flight), the session is evicted and the pool
   *  refilled. Otherwise it returns to the idle set for re-lease. */
  release(session: WarmSession, dead = false): void {
    const s = this.sessions.find((x) => x.id === session.id);
    if (!s) return;
    s.leased = false;
    if (dead) {
      s.dead = true;
      this.evictStale(Date.now());
      void this.ensureWarm();
    }
  }

  /** Observability snapshot for /health + tests. Read-only. */
  stats(): { total: number; idle: number; leased: number; dead: number; aged: number } {
    const now = Date.now();
    let idle = 0, leased = 0, dead = 0, aged = 0;
    for (const s of this.sessions) {
      if (s.dead) dead++;
      else if (s.leased) leased++;
      else if (this.isAged(s, now)) aged++;
      else idle++;
    }
    return { total: this.sessions.length, idle, leased, dead, aged };
  }
}

// ── Process-global pool registry, keyed by URL ──────────────────────────
// The bridge holds at most one pool per mcpServerUrl. Lazily constructed on
// first `getWarmPool(url)` — and ONLY when the flag is ON (the bridge guards
// the call with mcpPoolEnabled()). Keyed by URL so a test daemon on a free
// port and the live daemon never share a pool.

const POOLS = new Map<string, McpWarmPool>();

/** Get-or-create the warm pool for `url`. Starts keepalive on first create.
 *  Caller MUST have checked `mcpPoolEnabled()` — this function does not
 *  re-check the flag, so a test can construct a pool deterministically. */
export const getWarmPool = (url: string, opts?: { probe?: ReachabilityProbe; probeTimeoutMs?: number }): McpWarmPool => {
  let pool = POOLS.get(url);
  if (!pool) {
    pool = new McpWarmPool({ url, probe: opts?.probe, probeTimeoutMs: opts?.probeTimeoutMs });
    POOLS.set(url, pool);
    pool.startKeepalive();
    // Kick an initial fill so the FIRST dispatch can already find a warm one.
    void pool.ensureWarm();
  }
  return pool;
};

/** Stop every warm pool's keepalive timer and drop the registry. Called from
 *  daemon.stop() so a graceful shutdown (and especially a same-process restart)
 *  never leaves a keepalive interval probing a now-dead daemon URL forever.
 *  The timers are .unref()'d so they don't block process exit, but in an
 *  in-process restart the old daemon's pool would otherwise keep probing the
 *  stale URL while the new daemon spins up a fresh pool on a new port — an
 *  unbounded timer + state leak across daemon generations. Idempotent: clearing
 *  an already-empty registry is a no-op. */
export const shutdownWarmPools = (): void => {
  for (const pool of POOLS.values()) pool.stopKeepalive();
  POOLS.clear();
};

/** Test-only: drop all pools + stop their timers. Pools are process-global,
 *  so a leaked timer or warm entry from one test file would bleed into
 *  another. Tests call this in setup/teardown to start from a clean state. */
export const __resetWarmPoolsForTest = (): void => {
  shutdownWarmPools();
};
