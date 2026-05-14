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
// NO `state/` subdirectory. The old `${stateDir}/state/v2.sock.token` path
// is migrated forward on first sight (see migrateLegacyLayout).
//
// Env-var precedence (each independent):
//
//   stateDir   = ACC2_STATE_DIR ?? ACCINT_HOME ?? ~/.accint
//                (ACCINT_HOME is deprecated; emits a one-shot logger.warn +
//                 deprecation_warning_emitted event when it wins.)
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
// resolution. The deprecation warning is fired ONCE per process; we keep
// the latch in module scope.

import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { logger } from "./logger";
import { emitEvent } from "./events";

// ── Deprecation warn-once latch ───────────────────────────────────────

let accintHomeDeprecationLatched = false;

/** Test-only — reset the deprecation latch so a unit test can reassert
 *  the warn-once contract from a clean slate. NOT exported via the
 *  module's main API; callers must import explicitly. */
export const _resetDeprecationLatchForTests = (): void => {
  accintHomeDeprecationLatched = false;
};

// ── State-dir resolver (single source of truth) ──────────────────────

export type StateDirResolution = {
  dir: string;
  /** Which env var (if any) drove the resolution. `null` when the default
   *  `~/.accint` was used. */
  source: "ACC2_STATE_DIR" | "ACCINT_HOME" | null;
};

/** Resolve the canonical state directory. ACC2_STATE_DIR wins; ACCINT_HOME
 *  is honoured for back-compat and triggers the one-shot deprecation
 *  warning when it does. */
export const resolveStateDirVerbose = (): StateDirResolution => {
  const fromAcc2 = process.env.ACC2_STATE_DIR;
  if (fromAcc2 && fromAcc2.length > 0) {
    return { dir: fromAcc2, source: "ACC2_STATE_DIR" };
  }
  const fromAccintHome = process.env.ACCINT_HOME;
  if (fromAccintHome && fromAccintHome.length > 0) {
    return { dir: fromAccintHome, source: "ACCINT_HOME" };
  }
  return { dir: join(homedir(), ".accint"), source: null };
};

/** Convenience: just return the directory string. Identical to
 *  `resolveStateDirVerbose().dir`. */
export const resolveStateDir = (): string => resolveStateDirVerbose().dir;

/** Emit the ACCINT_HOME deprecation signal — at most once per process.
 *  Fires both a `logger.warn` (for operator-visible log streams) and a
 *  `deprecation_warning_emitted` event into the substrate so the ledger
 *  carries the audit. The event is best-effort; a failure to insert
 *  must NOT prevent the daemon from starting (the warning is advisory).
 *
 *  Call this from every site that touches the state dir. The latch
 *  guarantees the message appears once even when several sites race. */
export const maybeWarnAccintHomeDeprecated = (db: Database | null): void => {
  if (accintHomeDeprecationLatched) return;
  const res = resolveStateDirVerbose();
  if (res.source !== "ACCINT_HOME") return;
  accintHomeDeprecationLatched = true;
  try {
    logger.warn(
      { canonical: "ACC2_STATE_DIR", deprecated: "ACCINT_HOME" },
      "ACCINT_HOME is deprecated — set ACC2_STATE_DIR instead. ACCINT_HOME support will be removed in a future release.",
    );
  } catch { /* swallow — logger failure must not block boot */ }
  if (db) {
    try {
      emitEvent(db, {
        kind: "deprecation_warning_emitted",
        substrate_origin: "substrate_auto",
        payload: { key: "ACCINT_HOME", canonical: "ACC2_STATE_DIR" },
      });
    } catch { /* swallow — audit-event failure is non-fatal */ }
  }
};

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
 *  resolved from ACC2_STATE_DIR / ACCINT_HOME / `~/.accint` (in that
 *  order) — so this function ALWAYS returns a path under the operator's
 *  state directory, never the repo source tree. */
export const resolveDbPath = (): string => {
  const explicit = process.env.ACC2_DB_PATH;
  if (explicit && explicit.length > 0) return explicit;
  return join(resolveStateDir(), "state.db");
};

// ── Layout migration ──────────────────────────────────────────────────

/** One-time migration from the legacy `${stateDir}/state/<file>` layout
 *  to the canonical `${stateDir}/<file>` layout. Idempotent: if no
 *  legacy files exist, returns `{ migrated: false }`. If both legacy and
 *  canonical files exist, the canonical file wins (operator already
 *  migrated by hand) and we leave the legacy file alone.
 *
 *  The set of recognized legacy files is fixed: `v2.sock`, `v2.sock.token`,
 *  `accint.db` (+ `-wal` / `-shm` sidecars). Anything else that lived
 *  under `${stateDir}/state/` (logs, profiles, …) is NOT moved — the
 *  caller is expected to deal with those out-of-band.
 *
 *  Emits a `cli_layout_migrated` event into `db` per renamed file when
 *  `db` is non-null so the operator sees the migration in the ledger. */
export type MigrationResult = {
  migrated: boolean;
  renamed: Array<{ from: string; to: string }>;
};

const LEGACY_FILE_NAMES = [
  "v2.sock",
  "v2.sock.token",
  "state.db",
  "state.db-wal",
  "state.db-shm",
  // Historical: init.ts used to write `accint.db` under the `state/`
  // subdir. We treat it as a legacy artifact and rename to `state.db`
  // under the canonical flat layout so daemon resolves can find it.
  "accint.db",
  "accint.db-wal",
  "accint.db-shm",
] as const;

/** Map legacy filename → canonical filename. Most names pass through
 *  unchanged; the `accint.db*` family is renamed to `state.db*` so the
 *  canonical resolver finds them. */
const canonicalName = (legacy: string): string => {
  if (legacy === "accint.db") return "state.db";
  if (legacy === "accint.db-wal") return "state.db-wal";
  if (legacy === "accint.db-shm") return "state.db-shm";
  return legacy;
};

export const migrateLegacyLayout = (
  stateDir: string,
  db: Database | null = null,
): MigrationResult => {
  const legacyRoot = join(stateDir, "state");
  if (!existsSync(legacyRoot)) return { migrated: false, renamed: [] };
  const renamed: Array<{ from: string; to: string }> = [];
  // Ensure the canonical root exists — mkdir is idempotent.
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  for (const name of LEGACY_FILE_NAMES) {
    const legacyPath = join(legacyRoot, name);
    if (!existsSync(legacyPath)) continue;
    const canonicalPath = join(stateDir, canonicalName(name));
    if (existsSync(canonicalPath)) {
      // Canonical already populated — don't clobber. Operator can clean
      // up the legacy copy manually.
      continue;
    }
    try {
      renameSync(legacyPath, canonicalPath);
      renamed.push({ from: legacyPath, to: canonicalPath });
    } catch {
      // Best-effort: a single rename failure should not abort the others.
      continue;
    }
  }
  if (renamed.length > 0 && db) {
    try {
      emitEvent(db, {
        kind: "cli_layout_migrated",
        substrate_origin: "substrate_auto",
        payload: {
          state_dir: stateDir,
          renamed,
          canonical_layout: "flat",
          note: "moved legacy `${stateDir}/state/<file>` into `${stateDir}/<file>` per canonical layout",
        },
      });
    } catch { /* swallow — audit-event failure is non-fatal */ }
  }
  return { migrated: renamed.length > 0, renamed };
};
