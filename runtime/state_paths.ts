// acc2 state-path resolver — the single source of truth for every on-disk
// location the daemon, CLI, and tests share. ALL state-path resolution
// (state dir, socket file, admin-token file, SQLite DB path) flows through
// this module so init.ts, rpc.ts, daemon.ts, and the admin surfaces cannot
// disagree about where things live.
//
// Canonical layout (post Task 1):
//
//   ${stateDir}/v2.sock              ← daemon lock file
//   ${stateDir}/v2.sock.token        ← admin token (0600)
//   ${stateDir}/state.db             ← SQLite events ledger
//   ${stateDir}/logs/                ← daemon log files
//   ${stateDir}/tmp/                 ← scratch space
//
// NO `state/` subdirectory. Canonical state files live directly under
// `${stateDir}/`.
//
// Env-var precedence (each independent):
//
//   stateDir   = ACC2_STATE_DIR ?? ~/.accint
//
//   socketFile = ACC2_SOCKET_FILE ?? ${stateDir}/v2.sock
//   tokenFile  = ACC2_TOKEN_FILE  ?? ${stateDir}/v2.sock.token
//   dbPath     = ACC2_DB_PATH     ?? ${stateDir}/state.db
//
// `${stateDir}` ALWAYS resolves (to `~/.accint` when no env var is set),
// so `${stateDir}/state.db` is always reachable. There is NO repo-local
// dev fallback — the source tree is never a state location.
//
// Resolvers read process.env LAZILY on every call so the daemon (or tests)
// can change the env mid-process and pick up the new value on the next
// resolution.


import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

// ── State-dir resolver (single source of truth) ──────────────────────

export type StateDirResolution = {
  dir: string;
  /** Which env var (if any) drove the resolution. `null` when the default
   *  `~/.accint` was used. */
  source: "ACC2_STATE_DIR" | null;
};

/** Resolve the canonical state directory. Honours `ACC2_STATE_DIR`; falls
 *  back to `~/.accint` when unset. */
export const resolveStateDirVerbose = (): StateDirResolution => {
  const fromAcc2 = process.env.ACC2_STATE_DIR;
  if (fromAcc2 && fromAcc2.length > 0) {
    return { dir: fromAcc2, source: "ACC2_STATE_DIR" };
  }
  return { dir: join(homedir(), ".accint"), source: null };
};

/** Convenience: just return the directory string. Identical to
 *  `resolveStateDirVerbose().dir`. */
export const resolveStateDir = (): string => resolveStateDirVerbose().dir;

// ── Socket / token / db resolvers ────────────────────────────────────

/** Canonical socket-file path. Honors `ACC2_SOCKET_FILE` when set;
 *  otherwise places the file directly under the resolved state dir. */
export const resolveSocketFile = (): string => {
  const explicit = process.env.ACC2_SOCKET_FILE;
  if (explicit && explicit.length > 0) return explicit;
  return join(resolveStateDir(), "v2.sock");
};

/** Canonical admin-token file path. Honors `ACC2_TOKEN_FILE` when set;
 *  otherwise places the file directly under the resolved state dir. */
export const resolveTokenFile = (): string => {
  const explicit = process.env.ACC2_TOKEN_FILE;
  if (explicit && explicit.length > 0) return explicit;
  return join(resolveStateDir(), "v2.sock.token");
};

/** Canonical SQLite path. Honors `ACC2_DB_PATH` when set; otherwise
 *  always resolves to `${stateDir}/state.db`. The state dir itself is
 *  resolved from ACC2_STATE_DIR / `~/.accint` (in that order) — so this
 *  function ALWAYS returns a path under the operator's state directory,
 *  never the repo source tree. */
export const resolveDbPath = (): string => {
  const explicit = process.env.ACC2_DB_PATH;
  if (explicit && explicit.length > 0) return explicit;
  return join(resolveStateDir(), "state.db");
};

// ── Daemon port resolvers (single source of truth) ───────────────────
//
// The crash-resilience watchdog (runtime/daemon_supervisor.ts) must release
// the SAME ports the daemon binds (9387 MCP, 9388 aux). Resolving them here —
// honouring the same env vars startDaemon reads — keeps the supervisor and the
// daemon from disagreeing about which ports to free after a crash.

/** Default primary (MCP/fastmcp) daemon port. Mirrors
 *  runtime/daemon.ts:DEFAULT_DAEMON_PORT. */
export const DEFAULT_MCP_PORT = 9387;
/** Aux port = MCP port + 1 by default. */
export const DEFAULT_AUX_PORT_OFFSET = 1;

/** Canonical MCP port. Honours `V2_DAEMON_PORT`; falls back to 9387. */
export const resolveMcpPort = (): number => {
  const raw = process.env.V2_DAEMON_PORT;
  if (raw && raw.length > 0) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_MCP_PORT;
};

/** Canonical aux port. Honours `V2_DAEMON_AUX_PORT`; falls back to
 *  `resolveMcpPort() + 1`. */
export const resolveAuxPort = (): number => {
  const raw = process.env.V2_DAEMON_AUX_PORT;
  if (raw && raw.length > 0) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return resolveMcpPort() + DEFAULT_AUX_PORT_OFFSET;
};

/** The two ports a default daemon owns. The watchdog polls these for OS
 *  release before respawning so a crashed daemon's un-released ports never
 *  cause an EADDRINUSE stuck-state on the next start. */
export const resolveDaemonPorts = (): readonly [number, number] => [resolveMcpPort(), resolveAuxPort()];

// ── Lock-file inspection (stale-lock detection) ──────────────────────

/** The on-disk shape of the daemon lock file (`${stateDir}/v2.sock`). The
 *  daemon writes pid + ports + phase; the watchdog reads them to decide
 *  whether the incumbent is live or stale. Fields are optional because a
 *  malformed/partial lock must degrade to "stale" rather than throw. */
export type DaemonLockPayload = {
  pid?: number;
  port?: number;
  aux_port?: number;
  phase?: string;
  role?: string;
  started_at_ms?: number;
};

/** Read + parse the lock file at `lockPath` (defaults to the canonical
 *  socket file). Returns null when the file is absent or malformed — the
 *  caller treats null as "no live incumbent". */
export const readDaemonLock = (lockPath?: string): DaemonLockPayload | null => {
  const path = lockPath ?? resolveSocketFile();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as DaemonLockPayload;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
};

/** Default pid-liveness probe: `process.kill(pid, 0)` throws ESRCH when the
 *  pid is gone. Injectable so the watchdog tests can simulate a dead pid
 *  without a real process. */
export const defaultPidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export type StaleLockVerdict = {
  /** True when a lock file exists but its owner is gone/unknown — the
   *  crashed-daemon signature the watchdog must recover from. */
  stale: boolean;
  /** True when a lock file exists at all. */
  present: boolean;
  /** The pid recorded in the lock (when readable). */
  pid: number | null;
  /** Why the verdict is what it is — open string, never a closed enum. */
  reason: "no_lock" | "pid_alive" | "pid_dead" | "no_pid" | "malformed";
  payload: DaemonLockPayload | null;
};

/**
 * CRASH-RESILIENCE stale-lock detector. A daemon that died on a native Bun
 * SIGILL/SIGSEGV skips stop() entirely, leaving its lock file behind with a
 * pid that no longer exists. The watchdog calls this to decide whether to
 * reap the lock and respawn.
 *
 * Verdict:
 *   - no lock file            → `stale:false`, `reason:"no_lock"`.
 *   - lock + LIVE pid         → `stale:false`, `reason:"pid_alive"` (incumbent
 *                                is healthy/booting; do NOT reap or respawn).
 *   - lock + DEAD pid         → `stale:true`,  `reason:"pid_dead"` (crashed).
 *   - lock + no/zero pid      → `stale:true`,  `reason:"no_pid"`.
 *   - malformed lock          → `stale:true`,  `reason:"malformed"`.
 *
 * `pidAlive` is injectable so callers/tests can supply a deterministic probe.
 */
export const detectStaleLock = (
  lockPath?: string,
  pidAlive: (pid: number) => boolean = defaultPidAlive,
): StaleLockVerdict => {
  const path = lockPath ?? resolveSocketFile();
  if (!existsSync(path)) {
    return { stale: false, present: false, pid: null, reason: "no_lock", payload: null };
  }
  const payload = readDaemonLock(path);
  if (!payload) {
    // File exists but unparseable — a crashed/partial write. Treat as stale.
    return { stale: true, present: true, pid: null, reason: "malformed", payload: null };
  }
  const pid = typeof payload.pid === "number" && payload.pid > 0 ? payload.pid : null;
  if (pid === null) {
    return { stale: true, present: true, pid: null, reason: "no_pid", payload };
  }
  if (pidAlive(pid)) {
    return { stale: false, present: true, pid, reason: "pid_alive", payload };
  }
  return { stale: true, present: true, pid, reason: "pid_dead", payload };
};
