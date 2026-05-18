// acc2 substrate connection layer — bun:sqlite in WAL mode.
// Single source of truth for opening / closing / transacting against
// the events + code_artifact tables. Schema is applied on first open
// per path; connections are cached so re-opens reuse the same handle.
//
// Migration policy (F9, SQLPOOLARCH01, cites 3P7NAMR63901):
//   Two parallel public surfaces:
//     - `openDb(path)` / `closeDb(path)`           — single Database
//       handle, synchronous, the original API. Use for boot, tests,
//       and any path that already holds a synchronous bun:sqlite handle.
//     - `openDbPool(path, opts)` / `closeDbPool(path)` — async pool
//       wrapper. Use for any new code path that could run concurrently
//       with another terminal or brain subprocess. The pool serializes
//       writes through a single writer slot (SQLite WAL allows one
//       writer at a time) and shares N reader connections round-robin.
//   The contract is compatibility-preserving: no call site migration
//   in this commit. Existing callers continue to use openDb/closeDb;
//   new multi-terminal-aware callers adopt openDbPool/closeDbPool.
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
import { runViews } from "./views";

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
  // WAL hygiene (foundational fix 2026-05-16). Pre-fix the WAL grew to
  // 303MB in a single session because the integrity worker (the only
  // explicit checkpoint caller) fires every 6h AND the daemon was
  // crashing every 3h (now fixed by e446993). SQLite's default
  // wal_autocheckpoint is 1000 pages (~4MB) but only fires on COMMIT
  // boundaries — long-running readers (background workers holding open
  // queries) can block checkpoint indefinitely. journal_size_limit is
  // the structural backstop: after any checkpoint, the WAL file is
  // truncated to at most this many bytes (forcing the next writes to
  // recycle space rather than grow the file). 64MB is generous for
  // normal bursts but bounds worst case.
  db.run("PRAGMA wal_autocheckpoint = 2000");
  db.run("PRAGMA journal_size_limit = 67108864");
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
 *  six provenance/intent columns (intent, summary, target_files,
 *  target_resources, source_candidate_id, owner_gate_verdict). Fresh installs get them via
 *  schema.sql's CREATE TABLE; existing DBs need ALTER TABLE here. Each
 *  ALTER is wrapped in a try/catch so re-running this on an already-
 *  migrated DB is a no-op (SQLite raises "duplicate column name" which
 *  we swallow). No other patterns of fallback — the column either
 *  exists or it doesn't. */
const ARTIFACT_METADATA_COLUMNS: Array<{ name: string; ddl: string }> = [
  { name: "intent",              ddl: "ALTER TABLE code_artifact ADD COLUMN intent TEXT" },
  { name: "summary",             ddl: "ALTER TABLE code_artifact ADD COLUMN summary TEXT" },
  { name: "target_files",        ddl: "ALTER TABLE code_artifact ADD COLUMN target_files TEXT" },
  { name: "target_resources",    ddl: "ALTER TABLE code_artifact ADD COLUMN target_resources TEXT" },
  { name: "source_candidate_id", ddl: "ALTER TABLE code_artifact ADD COLUMN source_candidate_id TEXT" },
  { name: "owner_gate_verdict",  ddl: "ALTER TABLE code_artifact ADD COLUMN owner_gate_verdict TEXT" },
  // L8 (2026-05-17): free-string kind discriminator. NOT NULL with
  // default 'code_artifact' so existing rows get the canonical legacy
  // value. The seedCodeArtifacts code path overwrites for newly-added
  // typed rows (e.g. 'dispatch_strategy_v1'). Index added in schema.sql.
  { name: "kind",                ddl: "ALTER TABLE code_artifact ADD COLUMN kind TEXT NOT NULL DEFAULT 'code_artifact'" },
  // C5 (2026-05-18, contract HJJS1665H961B2SRYHC5J85D14): artifact
  // provenance chain. Three columns sit directly on code_artifact so
  // graph walks are pure SQL — no side table needed, matching the
  // additive-column pattern the contract picked.
  { name: "supersedes",          ddl: "ALTER TABLE code_artifact ADD COLUMN supersedes TEXT" },
  { name: "superseded_by",       ddl: "ALTER TABLE code_artifact ADD COLUMN superseded_by TEXT" },
  { name: "lost_version_count",  ddl: "ALTER TABLE code_artifact ADD COLUMN lost_version_count INTEGER NOT NULL DEFAULT 0" },
];

const EVENT_HOT_PATH_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_events_kind_ts ON events(kind, ts)",
  "CREATE INDEX IF NOT EXISTS idx_events_task_kind_ts ON events(task_id, kind, ts)",
  "CREATE INDEX IF NOT EXISTS idx_events_directive_kind_ts ON events(directive_id, kind, ts)",
  "CREATE INDEX IF NOT EXISTS idx_events_action_artifact_kind_ts ON events(action_artifact_id, kind, ts)",
  "CREATE INDEX IF NOT EXISTS idx_events_projection_key ON events(json_extract(payload, '$.projection_key')) WHERE json_extract(payload, '$.projection_key') IS NOT NULL",
  // C5 (2026-05-18) provenance indexes — mirrors schema.sql so older DBs
  // upgraded via runMigrations() get the same lookup shape.
  "CREATE INDEX IF NOT EXISTS idx_code_artifact_supersedes    ON code_artifact(supersedes)    WHERE supersedes IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS idx_code_artifact_superseded_by ON code_artifact(superseded_by) WHERE superseded_by IS NOT NULL",
];

export const runMigrations = (db: Database): void => {
  // Order matters: ALTER TABLE columns FIRST, then CREATE INDEX. The
  // C5 (supersedes / superseded_by) indexes reference columns added
  // by the migration below; running them in reverse order fails on
  // any pre-C5 DB with `no such column: supersedes`.
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

  for (const ddl of EVENT_HOT_PATH_INDEXES) db.run(ddl);

  // L8 backfill: dispatch_strategy seed rows (admitted with
  // state_root='dispatch/strategy') predate the kind column.
  // Tag them so the strategy_ranker can use the cleaner kind
  // discriminator. Idempotent — only updates rows that still carry
  // the default 'code_artifact' value.
  try {
    db.run(
      `UPDATE code_artifact SET kind = 'dispatch_strategy_v1'
       WHERE state_root = 'dispatch/strategy' AND kind = 'code_artifact'`,
    );
  } catch (err) {
    // Migration is best-effort; if the kind column doesn't exist yet
    // (very old install pre-this-migration) we'll swallow the throw
    // — runMigrations runs first so this path is normally safe.
    const msg = (err as Error).message ?? "";
    if (!/no such column/.test(msg)) throw err;
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
  // Organism-alignment (2026-05-15): runViews was previously called
  // separately by daemon.ts + a handful of tests, leaving prompt_composer
  // tests / unit-level callers with a half-built substrate where queries
  // against views (lesson_implementer_queue_view, active_objectives_view,
  // etc.) raised "no such table". Now every openDb() yields a fully
  // queryable substrate. Idempotent — runViews uses CREATE IF NOT EXISTS
  // or DROP+CREATE under each view definition.
  runViews(db);
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


export type SqliteDbPoolOptions = {
  maxReaders?: number;
};

export type ReaderLease = {
  db: Database;
  release: () => void;
};

type ReaderWaiter = {
  resolve: (lease: ReaderLease) => void;
  reject: (err: Error) => void;
};

const DEFAULT_READER_POOL_SIZE = 4;

const applyReaderPragmas = (db: Database): void => {
  db.run("PRAGMA query_only = ON");
  db.run("PRAGMA busy_timeout = 2000");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA cache_size = 2000");
  db.run("PRAGMA mmap_size = 268435456");
};

/** F9 writer pool pragmas: tuned for multi-terminal contention.
 *  Cites 3P7NAMR63901. Five settings are load-bearing per the
 *  67MB-WAL incident — document inline so a future refactor does not
 *  strip them:
 *    - `journal_mode = wal`          one writer + many readers, no blocking
 *    - `synchronous = NORMAL`        durable enough for WAL, much faster than FULL
 *    - `wal_autocheckpoint = 1000`   auto-checkpoint every 1000 pages
 *    - `busy_timeout = 5000`         wait up to 5s on writer contention
 *    - `mmap_size = 268435456`       256MB memory-mapped reads
 *  applyWalPragmas sets four of these on the writer; this helper
 *  re-applies `wal_autocheckpoint = 1000` (the writer pragmas default
 *  to 2000) so the pool path matches the documented contract value of
 *  1000 pages (~4MB checkpoint cadence). */
const applyPoolWriterPragmas = (db: Database): void => {
  db.run("PRAGMA wal_autocheckpoint = 1000");
  db.run("PRAGMA busy_timeout = 5000");
};

export type SqliteDbPoolStats = {
  connections_total: number;
  connections_idle: number;
  connections_busy: number;
  write_queue_depth: number;
  total_reads: number;
  total_writes: number;
  last_checkpoint_ms_ago: number;
  db_path: string;
  closed: boolean;
};

export class SqliteDbPool {
  readonly dbPath: string;
  readonly maxReaders: number;
  private readonly writer: Database;
  private readonly idleReaders: Database[] = [];
  private readonly allReaders = new Set<Database>();
  private readonly readerWaiters: ReaderWaiter[] = [];
  private writerTail: Promise<unknown> = Promise.resolve();
  private activeReaders = 0;
  private closing = false;
  private closed = false;
  private readerDrainResolve: (() => void) | null = null;
  // F9 stats counters (lifetime, per-pool).
  private totalReads = 0;
  private totalWrites = 0;
  private writeQueueDepth = 0;
  private lastCheckpointAtMs = -1;

  constructor(dbPath: string, opts: SqliteDbPoolOptions = {}) {
    this.dbPath = dbPath;
    this.maxReaders = Math.max(1, Math.floor(opts.maxReaders ?? DEFAULT_READER_POOL_SIZE));
    this.writer = new Database(dbPath, { create: true, strict: true });
    applyWalPragmas(this.writer);
    applyPoolWriterPragmas(this.writer);
    loadSqliteVec(this.writer);
    runSchema(this.writer);
    runMigrations(this.writer);
    runViews(this.writer);
  }

  async withWriter<T>(fn: (db: Database) => T | Promise<T>): Promise<T> {
    if (this.closing || this.closed) throw new Error("sqlite_pool_closed");
    this.writeQueueDepth += 1;
    const run = this.writerTail.then(async () => {
      if (this.closed) throw new Error("sqlite_pool_closed");
      return await fn(this.writer);
    });
    this.writerTail = run.catch(() => undefined);
    try {
      const result = await run;
      this.totalWrites += 1;
      return result;
    } finally {
      this.writeQueueDepth = Math.max(0, this.writeQueueDepth - 1);
    }
  }

  async acquireReader(): Promise<ReaderLease> {
    if (this.closing || this.closed) throw new Error("sqlite_pool_closed");
    this.totalReads += 1;
    const idle = this.idleReaders.pop();
    if (idle) return this.makeLease(idle);
    if (this.allReaders.size < this.maxReaders) return this.makeLease(this.openReader());
    return await new Promise<ReaderLease>((resolve, reject) => {
      this.readerWaiters.push({ resolve, reject });
    });
  }

  /** F9 snapshot stats helper. Returns a synchronous projection of pool state.
   *  Wired into the daemon /health endpoint so `acc daemon status` can surface
   *  reader/writer utilisation, write-queue depth, and lifetime counters. */
  stats(): SqliteDbPoolStats {
    const idle = this.idleReaders.length;
    const busy = this.activeReaders;
    const total = this.allReaders.size + 1; // +1 for writer
    const lastCheckpointMsAgo = this.lastCheckpointAtMs < 0 ? -1 : Date.now() - this.lastCheckpointAtMs;
    return {
      connections_total: total,
      connections_idle: idle,
      connections_busy: busy,
      write_queue_depth: this.writeQueueDepth,
      total_reads: this.totalReads,
      total_writes: this.totalWrites,
      last_checkpoint_ms_ago: lastCheckpointMsAgo,
      db_path: this.dbPath,
      closed: this.closed,
    };
  }

  async withReader<T>(fn: (db: Database) => T | Promise<T>): Promise<T> {
    const lease = await this.acquireReader();
    try {
      return await fn(lease.db);
    } finally {
      lease.release();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    for (const waiter of this.readerWaiters.splice(0)) {
      waiter.reject(new Error("sqlite_pool_closed"));
    }
    await this.writerTail.catch(() => undefined);
    if (this.activeReaders > 0) {
      await new Promise<void>((resolve) => {
        this.readerDrainResolve = resolve;
      });
    }
    for (const reader of this.allReaders) {
      try { reader.close(); } catch { /* already closed */ }
    }
    this.allReaders.clear();
    this.idleReaders.length = 0;
    try { this.writer.close(); } catch { /* already closed */ }
    this.closed = true;
  }

  private openReader(): Database {
    const db = new Database(this.dbPath, { readonly: true, strict: true });
    loadSqliteVec(db);
    applyReaderPragmas(db);
    this.allReaders.add(db);
    return db;
  }

  private makeLease(db: Database): ReaderLease {
    this.activeReaders += 1;
    let released = false;
    return {
      db,
      release: () => {
        if (released) return;
        released = true;
        this.activeReaders -= 1;
        if (this.closing || this.closed) {
          if (this.activeReaders === 0) this.readerDrainResolve?.();
          return;
        }
        const waiter = this.readerWaiters.shift();
        if (waiter) {
          waiter.resolve(this.makeLease(db));
          return;
        }
        this.idleReaders.push(db);
      },
    };
  }
}

const _poolCache = new Map<string, SqliteDbPool>();

export const openDbPool = (dbPath: string, opts: SqliteDbPoolOptions = {}): SqliteDbPool => {
  const cached = _poolCache.get(dbPath);
  if (cached) return cached;
  const pool = new SqliteDbPool(dbPath, opts);
  _poolCache.set(dbPath, pool);
  return pool;
};

export const closeDbPool = async (dbPath: string): Promise<void> => {
  const pool = _poolCache.get(dbPath);
  if (!pool) return;
  _poolCache.delete(dbPath);
  await pool.close();
};

/** F9 standalone stats helper. Public surface for callers that hold a
 *  pool reference (e.g. daemon /health, ops diagnostics). Equivalent to
 *  calling `pool.stats()`. */
export const getPoolStats = (pool: SqliteDbPool): SqliteDbPoolStats => pool.stats();

/** F9 multi-pool view: emit a stats row per cached pool. Used by the
 *  daemon /health endpoint when multiple pools may be open. Returns an
 *  array so the caller can render every row without knowing the pool
 *  paths up front. */
export const getAllPoolStats = (): SqliteDbPoolStats[] => {
  const out: SqliteDbPoolStats[] = [];
  for (const [, pool] of _poolCache) out.push(pool.stats());
  return out;
};

export const closeDbPools = async (): Promise<void> => {
  const pools = Array.from(_poolCache);
  _poolCache.clear();
  await Promise.all(pools.map(([, pool]) => pool.close()));
};
