// acc2 substrate connection layer — bun:sqlite in WAL mode.
// Single source of truth for opening / closing / transacting against
// the events + code_artifact tables. Schema is applied on first open
// per path; connections are cached so re-opens reuse the same handle.

import { Database } from "bun:sqlite";
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
  try { db.run("PRAGMA journal_mode = wal"); } catch { /* :memory: */ }
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA cache_size = 10000");
  db.run("PRAGMA mmap_size = 268435456");
};

/** Execute the schema DDL against the open connection.
 *  Schema is idempotent (CREATE … IF NOT EXISTS), so calling this on a
 *  pre-existing DB is a no-op. Kept as a named export so callers (tests,
 *  daemon boot, future migrations) can run it explicitly. */
export const runSchema = (db: Database): void => {
  db.exec(schemaSql);
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
  runSchema(db);
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
