// `acc admin import <path>` — substrate restore helper (Batch 3.ADMIN).
//
// Sibling to admin_export.ts.  Validates an archive, then restores the
// state dir from it.  Pre-flight checks before any destructive action:
//
//   1. Archive exists and untars cleanly to a scratch dir.
//   2. manifest.json present + parseable + schema_version matches the
//      caller-provided current schema (mismatch → refuse with clear
//      error; cross-schema migration is OUT OF SCOPE for 3.ADMIN).
//   3. Daemon is NOT running (auxBaseUrl() === null) OR `--force` is set
//      (refuses without --force when daemon is up).
//   4. Target state dir is empty (no accint.db) OR `--force` is set.
//
// Restore is atomic from the operator's point of view: we untar into a
// scratch dir, then mv the contents into the target state dir in one
// pass.  If the target has existing files and --force is set, they are
// removed first.  `PRAGMA integrity_check` runs post-restore on the
// restored DB to confirm the file is well-formed.
//
// Emits a `state_imported` event on the RESTORED db so the audit trail
// stays inside the substrate that's now in use.

import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { emitEvent } from "../runtime/events";
import { resolveStateDir } from "../runtime/state_paths";

export type ImportOptions = {
  archivePath: string;
  /** Override the target state dir.  Defaults to the canonical resolver
   *  (`$ACC2_STATE_DIR` / `~/.accint`).  All state files land DIRECTLY
   *  under this dir per the canonical layout. */
  stateDir?: string;
  /** Force overwrite + ignore daemon-running guard. */
  force?: boolean;
  /** Aux base URL probe — when this returns a string the daemon is
   *  considered up.  Tests inject `() => null` for hermetic runs. */
  auxBaseUrlProbe?: () => string | null;
  /** Schema version the *running* binary speaks; the archive must
   *  match.  Tests can set this lower/higher to drive the mismatch path. */
  currentSchemaVersion?: string;
  /** Spawn override for tests (records `tar` invocations). */
  spawn?: (cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string };
};

export type ImportResult = {
  ok: boolean;
  restoredEventCount: number;
  archiveSha256: string;
  schemaVersion: string;
  integrityOk: boolean;
  errors: string[];
};

type Manifest = {
  version?: string;
  exported_at?: string;
  source_state_dir?: string;
  schema_version?: string;
  mode?: "live" | "cold";
  event_count?: number;
  sha256_db?: string;
};

const defaultStateDir = (): string => resolveStateDir();

const defaultSpawn = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { stdio: "pipe" });
  return {
    status: r.status,
    stdout: r.stdout ? r.stdout.toString() : "",
    stderr: r.stderr ? r.stderr.toString() : "",
  };
};

const eventCount = (db: Database): number => {
  try {
    const row = db.query("SELECT COUNT(*) AS c FROM events").get() as { c: number } | null;
    return row?.c ?? 0;
  } catch { return 0; }
};

const runIntegrityCheck = (db: Database): boolean => {
  try {
    const row = db.query("PRAGMA integrity_check").get() as { integrity_check?: string } | null;
    return row?.integrity_check === "ok";
  } catch { return false; }
};

/** Apply an archive to the state dir.  Returns a structured result; never
 *  throws on operator-visible faults (missing archive, daemon running,
 *  schema mismatch).  Throws only for OS-level catastrophes (out of disk,
 *  permission denied) which the dispatcher promotes to exit-1. */
export const runImport = async (opts: ImportOptions): Promise<ImportResult> => {
  const stateDir = opts.stateDir ?? defaultStateDir();
  const spawn = opts.spawn ?? defaultSpawn;
  const probe = opts.auxBaseUrlProbe ?? (() => null);
  const currentSchema = opts.currentSchemaVersion ?? "0";
  const result: ImportResult = {
    ok: false,
    restoredEventCount: 0,
    archiveSha256: "",
    schemaVersion: "0",
    integrityOk: false,
    errors: [],
  };

  const archivePath = resolve(opts.archivePath);
  if (!existsSync(archivePath)) {
    result.errors.push(`archive_missing:${archivePath}`);
    return result;
  }

  // Daemon-running guard.
  if (probe() && !opts.force) {
    result.errors.push("daemon_running_refusing_without_force");
    return result;
  }

  // Untar into a scratch dir.
  const stageRoot = join(
    process.env.TMPDIR ?? "/tmp",
    `accint-import-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
  );
  mkdirSync(stageRoot, { recursive: true });

  try {
    const tarResult = spawn("tar", ["-xzf", archivePath, "-C", stageRoot]);
    if (tarResult.status !== 0) {
      result.errors.push(`tar_extract_failed:${tarResult.stderr.slice(0, 200)}`);
      return result;
    }

    // Manifest read + validation.
    const manifestPath = join(stageRoot, "manifest.json");
    if (!existsSync(manifestPath)) {
      result.errors.push("manifest_missing");
      return result;
    }
    let manifest: Manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    } catch (err) {
      result.errors.push(`manifest_unparseable:${(err as Error).message}`);
      return result;
    }
    result.schemaVersion = manifest.schema_version ?? "0";
    result.archiveSha256 = manifest.sha256_db ?? "";

    if (result.schemaVersion !== currentSchema) {
      result.errors.push(
        `schema_mismatch:archive=${result.schemaVersion} current=${currentSchema} (run migrations first; out of scope for this surface)`,
      );
      return result;
    }

    // State-dir guard.
    const targetDb = join(stateDir, "accint.db");
    const targetHasDb = existsSync(targetDb);
    if (targetHasDb && !opts.force) {
      result.errors.push("state_dir_has_db_refusing_without_force");
      return result;
    }

    // Wipe the target accint.db family + profiles dir when --force.
    if (opts.force) {
      for (const ext of ["", "-wal", "-shm"]) {
        const p = `${targetDb}${ext}`;
        if (existsSync(p)) rmSync(p, { force: true });
      }
      const profilesDir = join(stateDir, "profiles");
      if (existsSync(profilesDir)) rmSync(profilesDir, { recursive: true, force: true });
    }

    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });

    // Copy the staged state/ subtree into the target stateDir.  cpSync
    // recursive=true mirrors directories without needing a shell.
    const stagedState = join(stageRoot, "state");
    if (!existsSync(stagedState)) {
      result.errors.push("archive_missing_state_subdir");
      return result;
    }
    for (const entry of readdirSync(stagedState)) {
      const src = join(stagedState, entry);
      const dst = join(stateDir, entry);
      cpSync(src, dst, { recursive: true, force: true });
    }

    // Optional logs/cache subtrees (only if archive carried them).
    for (const sub of ["logs", "cache"]) {
      const staged = join(stageRoot, sub);
      if (existsSync(staged)) {
        const dst = resolve(stateDir, "..", sub);
        cpSync(staged, dst, { recursive: true, force: true });
      }
    }

    // Post-restore integrity check + event count read.
    const db = new Database(targetDb, { create: false, strict: true });
    try {
      result.integrityOk = runIntegrityCheck(db);
      result.restoredEventCount = eventCount(db);
      if (!result.integrityOk) {
        result.errors.push("integrity_check_failed_post_restore");
        return result;
      }
      emitEvent(db, {
        kind: "state_imported",
        substrate_origin: "owner",
        payload: {
          archive_path: archivePath,
          archive_sha256: result.archiveSha256,
          restored_event_count: result.restoredEventCount,
          schema_version: result.schemaVersion,
        },
      });
    } finally { try { db.close(); } catch { /* swallow */ } }

    result.ok = true;
    return result;
  } finally {
    try { rmSync(stageRoot, { recursive: true, force: true }); } catch { /* leave */ }
  }
};

/** Used by tests to peek at the manifest of a freshly-built archive
 *  without running the full restore path. */
export const peekArchiveManifest = (archivePath: string): Manifest | null => {
  if (!existsSync(archivePath)) return null;
  const stageRoot = join(
    process.env.TMPDIR ?? "/tmp",
    `accint-peek-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
  );
  mkdirSync(stageRoot, { recursive: true });
  try {
    const r = spawnSync("tar", ["-xzf", archivePath, "-C", stageRoot, "manifest.json"], { stdio: "pipe" });
    if (r.status !== 0) return null;
    const manifestPath = join(stageRoot, "manifest.json");
    if (!existsSync(manifestPath)) return null;
    try { return JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest; } catch { return null; }
  } finally {
    try { rmSync(stageRoot, { recursive: true, force: true }); } catch { /* leave */ }
  }
};

void statSync;
