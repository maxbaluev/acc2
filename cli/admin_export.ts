// `acc admin export <path>` — substrate backup helper (Batch 3.ADMIN).
//
// Two modes:
//
//   - LIVE  (default): the daemon is running. We run
//       PRAGMA wal_checkpoint(TRUNCATE)
//     on a fresh read connection so the WAL is flushed back into the
//     main DB file, then snapshot via the SQLite Online Backup API
//     (`VACUUM INTO <sibling>`) and tar the sibling. Daemon stays up.
//
//   - COLD  (`--cold`): the daemon must NOT be running. We tar the
//     accint.db + accint.db-wal + accint.db-shm files directly along
//     with profiles/ and (optionally) logs/.
//
// The archive layout is:
//
//   accint-export-<timestamp>.tar.gz
//   ├── manifest.json
//   │     { "version": "1.0", "exported_at": <iso>,
//   │       "source_state_dir": <path>, "schema_version": <N>,
//   │       "mode": "live" | "cold",
//   │       "event_count": <int>,
//   │       "sha256_db": <hex> }
//   ├── state/
//   │     accint.db                (snapshot OR direct copy)
//   │     accint.db-wal            (only in --cold mode)
//   │     accint.db-shm            (only in --cold mode)
//   │     profiles/                (browser profile roots)
//   │     logs/                    (optional, --include-logs)
//   │     cache/                   (optional, --include-logs)
//
// The schema_version is read from the `meta` table (key `schema_version`)
// when present; absent → "0". `import` uses this to refuse a downgrade
// across an incompatible schema bump.
//
// Emits a `state_exported` event into the source DB so the trajectory of
// every backup is auditable.

import { createHash } from "node:crypto";
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { emitEvent } from "../runtime/events";
import { resolveStateDir } from "../runtime/state_paths";

export type ExportMode = "live" | "cold";

export type ExportOptions = {
  /** Absolute or relative path to write the archive to.  A trailing `.tar.gz`
   *  is added automatically when absent. */
  archivePath: string;
  /** Default: live.  Use cold when the daemon is NOT running. */
  mode?: ExportMode;
  /** Include the logs/ + cache/ subtrees.  Default false (often huge). */
  includeLogs?: boolean;
  /** Source state dir.  Defaults to the canonical resolver — typically
   *  `$ACC2_STATE_DIR`, falling back to `~/.accint`.  All state files
   *  live DIRECTLY under this dir (no `state/` subdir) per the canonical
   *  layout. */
  stateDir?: string;
  /** Use a system command override.  Tests inject a stub that records the
   *  invocation instead of actually shelling out. */
  spawn?: (cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string };
  /** Override the timestamp for deterministic test fixtures. */
  nowIso?: () => string;
};

export type ExportResult = {
  ok: boolean;
  archivePath: string;
  sha256: string;
  eventCount: number;
  schemaVersion: string;
  mode: ExportMode;
  errors: string[];
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

const sha256OfFile = (path: string): string => {
  const buf = readFileSync(path);
  return createHash("sha256").update(buf).digest("hex");
};

const readSchemaVersion = (db: Database): string => {
  try {
    const row = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string } | null;
    return row?.value ?? "0";
  } catch { return "0"; }
};

const eventCount = (db: Database): number => {
  try {
    const row = db.query("SELECT COUNT(*) AS c FROM events").get() as { c: number } | null;
    return row?.c ?? 0;
  } catch { return 0; }
};

const ensureTarGzSuffix = (p: string): string => p.endsWith(".tar.gz") ? p : `${p}.tar.gz`;

/** Build the archive.  Returns the absolute archive path + sha256 of the
 *  embedded `state/accint.db`.  Errors are accumulated into `result.errors`
 *  rather than thrown; the caller decides whether to surface as exit-1. */
export const runExport = async (opts: ExportOptions): Promise<ExportResult> => {
  const mode: ExportMode = opts.mode ?? "live";
  const stateDir = opts.stateDir ?? defaultStateDir();
  const spawn = opts.spawn ?? defaultSpawn;
  const now = (opts.nowIso ?? (() => new Date().toISOString()))();
  const archivePath = resolve(ensureTarGzSuffix(opts.archivePath));
  const result: ExportResult = {
    ok: false,
    archivePath,
    sha256: "",
    eventCount: 0,
    schemaVersion: "0",
    mode,
    errors: [],
  };

  if (!existsSync(stateDir)) {
    result.errors.push(`state_dir_missing:${stateDir}`);
    return result;
  }

  // Stage the export tree under a scratch directory; tar from there so the
  // archive does not contain absolute paths.
  const stageRoot = join(
    process.env.TMPDIR ?? "/tmp",
    `accint-export-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
  );
  mkdirSync(stageRoot, { recursive: true });
  const stageStateDir = join(stageRoot, "state");
  mkdirSync(stageStateDir, { recursive: true });

  try {
    // The canonical filename is `state.db` (flat layout); the legacy
    // filename is `accint.db` (state/ subdir installs). Recognise both
    // so an export from either layout works without explicit hinting.
    const canonicalDb = join(stateDir, "state.db");
    const legacyDb = join(stateDir, "accint.db");
    const sourceDb = existsSync(canonicalDb) ? canonicalDb : legacyDb;
    if (!existsSync(sourceDb)) {
      result.errors.push(`source_db_missing:${sourceDb}`);
      return result;
    }
    // The archive carries `state/accint.db` as the canonical export
    // filename; the import side maps it back to whatever the running
    // daemon's canonical name is (state.db today).
    const targetDb = join(stageStateDir, "accint.db");

    if (mode === "live") {
      // LIVE: open a read connection on the source DB, checkpoint the WAL,
      // then VACUUM INTO a sibling file.  VACUUM INTO is the canonical
      // "snapshot-while-live" SQLite path — it produces a self-contained
      // image of the schema + data without holding writes for the full copy.
      const src = new Database(sourceDb, { create: false, strict: true });
      try {
        try { src.run("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* best-effort */ }
        src.run(`VACUUM INTO '${targetDb.replace(/'/g, "''")}'`);
      } finally { try { src.close(); } catch { /* swallow */ } }
    } else {
      // COLD: assume daemon is stopped; copy the three files directly.
      copyFileSync(sourceDb, targetDb);
      for (const ext of ["-wal", "-shm"]) {
        const p = `${sourceDb}${ext}`;
        if (existsSync(p)) copyFileSync(p, `${targetDb}${ext}`);
      }
    }

    // Profiles subtree — opportunistic copy if present.
    const sourceProfiles = join(stateDir, "profiles");
    if (existsSync(sourceProfiles)) {
      // Use cp -R for the subtree; shelling out is cheaper than a hand-rolled
      // recursive walk and stays portable across mac+linux.
      const r = spawn("cp", ["-R", sourceProfiles, join(stageStateDir, "profiles")]);
      if (r.status !== 0) result.errors.push(`cp_profiles_failed:${r.stderr.slice(0, 200)}`);
    }

    if (opts.includeLogs) {
      for (const sub of ["logs", "cache"]) {
        const p = resolve(stateDir, "..", sub);
        if (existsSync(p)) {
          const r = spawn("cp", ["-R", p, join(stageRoot, sub)]);
          if (r.status !== 0) result.errors.push(`cp_${sub}_failed:${r.stderr.slice(0, 200)}`);
        }
      }
    }

    // Read schema_version + event count from the SNAPSHOT (not the live db).
    const snap = new Database(targetDb, { create: false, strict: true });
    try {
      result.schemaVersion = readSchemaVersion(snap);
      result.eventCount = eventCount(snap);
    } finally { try { snap.close(); } catch { /* swallow */ } }

    result.sha256 = sha256OfFile(targetDb);

    const manifest = {
      version: "1.0",
      exported_at: now,
      source_state_dir: stateDir,
      schema_version: result.schemaVersion,
      mode,
      event_count: result.eventCount,
      sha256_db: result.sha256,
    };
    writeFileSync(join(stageRoot, "manifest.json"), JSON.stringify(manifest, null, 2));

    // Tar the staged tree.  -czf wraps gzip; -C cd's into the stage root so
    // the archive's leading path is `manifest.json` and `state/...`, not
    // `/tmp/...`.
    if (!existsSync(dirname(archivePath))) mkdirSync(dirname(archivePath), { recursive: true });
    const entries = readdirSync(stageRoot);
    const r = spawn("tar", ["-czf", archivePath, "-C", stageRoot, ...entries]);
    if (r.status !== 0) {
      result.errors.push(`tar_failed:${r.stderr.slice(0, 200)}`);
      return result;
    }

    // Emit the audit event on the SOURCE db (not the snapshot).
    try {
      const src = new Database(sourceDb, { create: false, strict: true });
      try {
        emitEvent(src, {
          kind: "state_exported",
          substrate_origin: "owner",
          payload: {
            archive_path: archivePath,
            sha256: result.sha256,
            event_count: result.eventCount,
            mode,
          },
        });
      } finally { try { src.close(); } catch { /* swallow */ } }
    } catch (err) {
      // Audit-event failure is non-fatal — the backup itself succeeded.
      result.errors.push(`audit_emit_failed:${(err as Error).message}`);
    }

    result.ok = true;
    return result;
  } finally {
    // Best-effort scratch cleanup.
    try { rmSync(stageRoot, { recursive: true, force: true }); } catch { /* leave it */ }
  }
};

/** Convenience used by tests to pre-check a freshly-built archive. */
export const archiveStatsForTest = (archivePath: string): { size: number; exists: boolean } => {
  if (!existsSync(archivePath)) return { size: 0, exists: false };
  return { size: statSync(archivePath).size, exists: true };
};
