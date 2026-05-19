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
