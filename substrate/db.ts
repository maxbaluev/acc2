// acc2 substrate connection layer — bun:sqlite in WAL mode.
// Single source of truth for opening / closing / transacting against
// the events + code_artifact tables. Schema is applied on first open
// per path; connections are cached so re-opens reuse the same handle.
//
// sqlite-vec extension:
//   Loaded once per connection right before schema application so the
//   vec0 virtual table in schema.sql can be created. The extension is
//   shipped by the `sqlite-vec` npm package; its loadable path resolves
//   to `node_modules/sqlite-vec-<platform>-<arch>/vec0.<ext>`. Failure
//   to load is a hard fault (we throw) — vec0 is now the canonical
//   embedding index per v2-design.md §5.1, replacing the in-memory
//   linear-scan. We do NOT fall back silently; a broken vec0 surface
//   would degrade retrieval invisibly which is worse than failing fast.

import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import schemaSql from "./schema.sql" with { type: "text" };

// ── Per-path connection cache ──────────────────────────────────────
// One live `Database` per path. closeDb(path) flushes + removes the entry
// so the next openDb(path) mints a fresh handle. Same close-then-fresh
// semantic as v1's getDb (.opencode/tool/acc-state/db.ts lines 175-260).
const _dbCache = new Map<string, Database>();

// ── Pragma policy (matches v1 SHARED_POLICY shape) ─────────────────
// journal_mode = wal is best-effort: :memory: silently falls back to
// "memory" — that branch is allowed. All other pragmas are mandatory:
// if the driver rejects them we want the error loud.
const applyWalPragmas = (db: Database): void => {
  try {
    db.run("PRAGMA journal_mode = wal");
  } catch (err) {
    // :memory: silently falls back to "memory" — the journal pragma raises
    // there. We keep the swallow but emit a stderr trace under verbose mode
    // so a real failure on a file-backed DB doesn't vanish.
    if (process.env.ACC2_DB_VERBOSE === "1") {
      process.stderr.write(`acc2 db: PRAGMA journal_mode=wal refused (${(err as Error).message})\n`);
    }
  }
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA cache_size = 10000");
  db.run("PRAGMA mmap_size = 268435456");
};

/** Load the sqlite-vec extension into the open connection. Idempotent —
 *  Bun's bun:sqlite handles repeated loads of the same shared object
 *  gracefully (subsequent calls are no-ops). Throws on failure: see the
 *  module header for why we do not fall back silently. */
const loadSqliteVec = (db: Database): void => {
  db.loadExtension(sqliteVec.getLoadablePath());
};

/** Execute the schema DDL against the open connection.
 *  Schema is idempotent (CREATE … IF NOT EXISTS), so calling this on a
 *  pre-existing DB is a no-op. Kept as a named export so callers (tests,
 *  daemon boot, future migrations) can run it explicitly. */
export const runSchema = (db: Database): void => {
  db.exec(schemaSql);
};

/** Brain dataflow audit bxdhdkm9e #3 (2026-05-15): code_artifact gained
 *  five provenance/intent columns (intent, summary, target_files,
 *  source_candidate_id, owner_gate_verdict). Fresh installs get them via
 *  schema.sql's CREATE TABLE; existing DBs need ALTER TABLE here. Each
 *  ALTER is wrapped in a try/catch so re-running this on an already-
 *  migrated DB is a no-op (SQLite raises "duplicate column name" which
 *  we swallow). No other patterns of fallback — the column either
 *  exists or it doesn't. */
const ARTIFACT_METADATA_COLUMNS: Array<{ name: string; ddl: string }> = [
  { name: "intent",              ddl: "ALTER TABLE code_artifact ADD COLUMN intent TEXT" },
  { name: "summary",             ddl: "ALTER TABLE code_artifact ADD COLUMN summary TEXT" },
  { name: "target_files",        ddl: "ALTER TABLE code_artifact ADD COLUMN target_files TEXT" },
  { name: "source_candidate_id", ddl: "ALTER TABLE code_artifact ADD COLUMN source_candidate_id TEXT" },
  { name: "owner_gate_verdict",  ddl: "ALTER TABLE code_artifact ADD COLUMN owner_gate_verdict TEXT" },
];

export const runMigrations = (db: Database): void => {
  for (const col of ARTIFACT_METADATA_COLUMNS) {
    try {
      db.run(col.ddl);
    } catch (err) {
      // "duplicate column name" — column already exists. Any other
      // error is real and should propagate.
      const msg = (err as Error).message ?? "";
      if (!msg.includes("duplicate column name")) throw err;
    }
  }
};

/** Open (or reuse) a connection to `dbPath`, apply pragmas, run schema.
 *  `:memory:` is supported and gets its own cache slot — useful for tests.
 *  Throws if SQLite cannot open the file (e.g. parent dir missing); we
 *  do NOT silently fall back to in-memory for non-test paths. */
export const openDb = (dbPath: string): Database => {
  const cached = _dbCache.get(dbPath);
  if (cached) return cached;

  const db = new Database(dbPath, { create: true, strict: true });
  _dbCache.set(dbPath, db);

  applyWalPragmas(db);
  // Order matters: load the vec0 extension BEFORE runSchema so the
  // `CREATE VIRTUAL TABLE IF NOT EXISTS vec_events USING vec0(...)`
  // statement in schema.sql can resolve the `vec0` module.
  loadSqliteVec(db);
  runSchema(db);
  runMigrations(db);
  return db;
};

/** Flush + close + drop cache entry. Pass a path to close that one,
 *  or omit the arg to close every cached connection. */
export const closeDb = (dbPath?: string): void => {
  if (dbPath !== undefined) {
    const db = _dbCache.get(dbPath);
    if (db) {
      try { db.close(); } catch { /* already closed */ }
      _dbCache.delete(dbPath);
    }
    return;
  }
  for (const [, db] of Array.from(_dbCache)) {
    try { db.close(); } catch { /* already closed */ }
  }
  _dbCache.clear();
};

/** Run `fn` inside a BEGIN IMMEDIATE transaction. Commits if `fn`
 *  returns normally; rolls back if it throws. The IMMEDIATE lock
 *  reserves the write slot at BEGIN so concurrent writers serialize
 *  cleanly without surprise SQLITE_BUSY mid-transaction. */
export const withImmediateTransaction = <T>(db: Database, fn: () => T): T => {
  db.run("BEGIN IMMEDIATE");
  let result: T;
  try {
    result = fn();
  } catch (err) {
    try { db.run("ROLLBACK"); } catch { /* swallow secondary errors */ }
    throw err;
  }
  db.run("COMMIT");
  return result;
};
