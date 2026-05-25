// acc2 substrate connection layer — bun:sqlite in WAL mode.
// Single source of truth for opening / closing / transacting against
// the events + act_artifact tables. Schema is applied on first open
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
//   embedding index per Architecture.md, replacing the in-memory
//   linear-scan. We do NOT fall back silently; a broken vec0 surface
//   would degrade retrieval invisibly which is worse than failing fast.

import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import schemaSql from "./schema.sql" with { type: "text" };
import { runViews } from "./views";
import { ensureArtifactKindMetadataTable } from "./artifact_kind_metadata";
import { ensureDispatchLeaseTable } from "../runtime/dispatch_leases";

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
  // busy_timeout MUST be the FIRST pragma — before journal_mode=wal and any
  // other operation. Otherwise concurrent multi-process startup (e.g. the
  // role-split server + worker daemons opening the same file-backed DB at
  // once) races on WAL setup/recovery and the `journal_mode=wal` or first
  // migration hits `SQLITE_BUSY`/`SQLITE_BUSY_RECOVERY` with NO busy-wait
  // configured → the daemon dies on open. Set it first so every subsequent
  // open-time operation waits-and-retries on a held lock instead of failing.
  // 15s covers WAL crash-recovery by a sibling process. Env-overridable.
  const busyMs = Number(process.env.ACC2_DB_BUSY_TIMEOUT_MS ?? 15000);
  db.run(`PRAGMA busy_timeout = ${Number.isFinite(busyMs) && busyMs >= 0 ? busyMs : 15000}`);
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
  db.run("PRAGMA foreign_keys = ON");
  // 2026-05-21 tuning bump: 326K-event substrate showed worker first-ticks
  // doing aggregate queries that thrashed the 40MB page cache. Bumping
  // cache to ~200MB (50K pages × 4KB) keeps frequently-queried views
  // (event_kind_occurrence, worker_liveness, etc.) hot.
  db.run("PRAGMA cache_size = 50000");
  // 1GB mmap supports the current state.db growth path (782MB observed)
  // without re-mmapping on each new page. Linux maps lazily so unused
  // bytes don't reserve physical memory.
  db.run("PRAGMA mmap_size = 1073741824");
  // Temp tables and intermediate sorts live in RAM, not on disk. Speeds
  // up aggregate worker queries that materialize temp result sets.
  db.run("PRAGMA temp_store = MEMORY");
  // WAL hygiene (foundational fix 2026-05-16; reactivity fix 2026-05-24).
  //
  // HISTORY (load-bearing — do NOT strip without reading the 67MB-WAL
  // incident note below): pre-fix the WAL grew to 303MB in a single
  // session because the integrity worker (the only explicit checkpoint
  // caller) fired every 6h AND the daemon crashed every 3h. SQLite's
  // default wal_autocheckpoint is 1000 pages (~4MB) but only fires at
  // COMMIT boundaries — long-running readers (the 10-thread read pool
  // holding open queries during a dispatch burst) block the checkpoint
  // from reclaiming frames, so the WAL grows AND, when a checkpoint
  // finally does run synchronously on a COMMIT, it stalls the single
  // bun event loop ~5s (the residual reactivity spike).
  //
  // REACTIVITY FIX (2026-05-24): set wal_autocheckpoint = 0 to DISABLE
  // the synchronous checkpoint-on-COMMIT path entirely. This removes the
  // ~5s stall from the emit hot path. The checkpoint cadence is now
  // OWNED by an explicit OFF-hot-path driver: runtime/wal_checkpoint_driver.ts,
  // a low-frequency timer wired into the daemon lifecycle that runs
  // PRAGMA wal_checkpoint(PASSIVE) (never blocks on readers) every
  // ACC2_WAL_CHECKPOINT_INTERVAL_MS (default 12s), with a hard WAL-size
  // backstop that escalates to wal_checkpoint(TRUNCATE) when the WAL
  // exceeds ACC2_WAL_FORCE_CHECKPOINT_BYTES (default 64MB).
  //
  // 67MB-WAL INCIDENT GUARD: disabling autocheckpoint is ONLY safe
  // because (a) the timed driver reclaims on a fixed cadence regardless
  // of COMMIT boundaries, and (b) the size backstop FORCES a TRUNCATE
  // checkpoint under reader contention before the WAL can run away.
  // journal_size_limit below remains the structural truncate-on-checkpoint
  // backstop. Unbounded growth is impossible as long as the driver runs;
  // if the driver is ever removed, autocheckpoint MUST be restored to a
  // non-zero page count or the WAL will grow without bound.
  db.run("PRAGMA wal_autocheckpoint = 0");
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

/** Brain dataflow audit bxdhdkm9e #3 (2026-05-15): act_artifact gained
 *  six provenance/intent columns (intent, summary, target_files,
 *  target_resources, source_candidate_id, owner_gate_verdict). Fresh installs get them via
 *  schema.sql's CREATE TABLE; existing DBs need ALTER TABLE here. Each
 *  ALTER is wrapped in a try/catch so re-running this on an already-
 *  migrated DB is a no-op (SQLite raises "duplicate column name" which
 *  we swallow). No other patterns of fallback — the column either
 *  exists or it doesn't.
 *
 *  F4a (2026-05-18, roadmap WW7W1NZ8A10R52PB4E7EJE9YBW): the table was
 *  renamed code_artifact → act_artifact. ALTER TABLE statements target
 *  the new name; the rename step in runMigrations runs before column
 *  ALTERs so production DBs holding `code_artifact` rows transition
 *  cleanly. */
const ARTIFACT_METADATA_COLUMNS: Array<{ name: string; ddl: string }> = [
  { name: "intent",              ddl: "ALTER TABLE act_artifact ADD COLUMN intent TEXT" },
  { name: "summary",             ddl: "ALTER TABLE act_artifact ADD COLUMN summary TEXT" },
  { name: "target_files",        ddl: "ALTER TABLE act_artifact ADD COLUMN target_files TEXT" },
  { name: "target_resources",    ddl: "ALTER TABLE act_artifact ADD COLUMN target_resources TEXT" },
  { name: "source_candidate_id", ddl: "ALTER TABLE act_artifact ADD COLUMN source_candidate_id TEXT" },
  { name: "owner_gate_verdict",  ddl: "ALTER TABLE act_artifact ADD COLUMN owner_gate_verdict TEXT" },
  // L8 (2026-05-17): free-string kind discriminator. NOT NULL with
  // default 'runtime_action' post-F4a; historical rows carry legacy
  // 'code_artifact' values which coexist (kind is an open string, not
  // an enum). The seed path overwrites for newly-added typed rows
  // (e.g. 'dispatch_strategy_v1'). Index added in schema.sql.
  { name: "kind",                ddl: "ALTER TABLE act_artifact ADD COLUMN kind TEXT NOT NULL DEFAULT 'runtime_action'" },
  // C5 (2026-05-18, contract HJJS1665H961B2SRYHC5J85D14): artifact
  // provenance chain. Three columns sit directly on act_artifact so
  // graph walks are pure SQL — no side table needed, matching the
  // additive-column pattern the contract picked.
  { name: "supersedes",          ddl: "ALTER TABLE act_artifact ADD COLUMN supersedes TEXT" },
  { name: "superseded_by",       ddl: "ALTER TABLE act_artifact ADD COLUMN superseded_by TEXT" },
  { name: "lost_version_count",  ddl: "ALTER TABLE act_artifact ADD COLUMN lost_version_count INTEGER NOT NULL DEFAULT 0" },
  // UNIVERSAL_ (2026-05-24, directive 3XETJCYT, kc BD86CJ6HQS): first-
  // class, domain-NEUTRAL interface metadata (purpose / goal_shapes /
  // usage_examples / preconditions / effects / cost_profile /
  // reliability_profile / inputs_schema / outputs_schema). ONE nullable
  // JSON column — a polymorphic payload field, not a fixed enum or side
  // table — so the substrate + brain can understand/select ANY artifact
  // (Telegram action, browser flow, calendar handle, checklist, contact,
  // script) by the same shape. NULL for legacy rows (backward-compatible).
  { name: "interface_metadata", ddl: "ALTER TABLE act_artifact ADD COLUMN interface_metadata TEXT" },
];

const EVENT_HOT_PATH_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_events_kind_ts ON events(kind, ts)",
  "CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts)",
  "CREATE INDEX IF NOT EXISTS idx_events_task_kind_ts ON events(task_id, kind, ts)",
  "CREATE INDEX IF NOT EXISTS idx_events_directive_kind_ts ON events(directive_id, kind, ts)",
  "CREATE INDEX IF NOT EXISTS idx_events_action_artifact_kind_ts ON events(action_artifact_id, kind, ts)",
  "CREATE INDEX IF NOT EXISTS idx_events_projection_key ON events(json_extract(payload, '$.projection_key')) WHERE json_extract(payload, '$.projection_key') IS NOT NULL",
  // JSON-path indexes on the hottest payload extractions (2026-05-21
  // SQLite bottleneck audit). Inventory: source_event_id appears in 27
  // SQL sites, retrieval_binding_event_id in 16, knowledge_id in 8,
  // source_act_id in 9, source_rendered_event_id in 5. Every view that
  // joins by these fields (lesson_implementation_status_view,
  // retrieval_credit_view, applied_lesson_effectiveness_view, etc.)
  // previously did full-table scan over 355K rows because the
  // json_extract was not indexed. Partial WHERE clauses keep these
  // indexes small (only rows where the field is non-null).
  "CREATE INDEX IF NOT EXISTS idx_events_payload_source_event_id ON events(json_extract(payload, '$.source_event_id')) WHERE json_extract(payload, '$.source_event_id') IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS idx_events_payload_knowledge_id ON events(json_extract(payload, '$.knowledge_id')) WHERE json_extract(payload, '$.knowledge_id') IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS idx_events_payload_source_act_id ON events(json_extract(payload, '$.source_act_id')) WHERE json_extract(payload, '$.source_act_id') IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS idx_events_payload_retrieval_binding_event_id ON events(json_extract(payload, '$.retrieval_binding_event_id')) WHERE json_extract(payload, '$.retrieval_binding_event_id') IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS idx_events_payload_artifact_id ON events(json_extract(payload, '$.artifact_id')) WHERE json_extract(payload, '$.artifact_id') IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS idx_events_payload_dispatch_id ON events(json_extract(payload, '$.dispatch_id')) WHERE json_extract(payload, '$.dispatch_id') IS NOT NULL",
  // C5 (2026-05-18) provenance indexes — mirrors schema.sql so older DBs
  // upgraded via runMigrations() get the same lookup shape.
  "CREATE INDEX IF NOT EXISTS idx_act_artifact_supersedes    ON act_artifact(supersedes)    WHERE supersedes IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS idx_act_artifact_superseded_by ON act_artifact(superseded_by) WHERE superseded_by IS NOT NULL",
  // 2026-05-22 covering-index audit: father autonomy loop's recent-by-origin
  // query (runtime/father.ts:857 — WHERE substrate_origin=? ORDER BY ts DESC
  // LIMIT N) was a SCAN events USING INDEX idx_events_ts (walk-and-filter,
  // ~12ms/call on the 374K-row live DB). (substrate_origin, ts) converts it to
  // a single SEARCH seek (~0.16ms, ~77x). Mirrors schema.sql for older DBs.
  "CREATE INDEX IF NOT EXISTS idx_events_origin_ts ON events(substrate_origin, ts)",
  // trajectory_motif_extractor's per-tick `ts>cutoff ORDER BY directive_id, ts`
  // scan forced USE TEMP B-TREE (no (directive_id, ts) index — the kind-in-middle
  // idx_events_directive_kind_ts can't serve it). 186ms → 14ms (~13x), byte-identical.
  "CREATE INDEX IF NOT EXISTS idx_events_directive_ts ON events(directive_id, ts)",
  // 2026-05-22 per-dispatch hot-path audit: prompt_composer.readRecentFailures
  // (runtime/prompt_composer.ts — `SELECT failure_kind, ts FROM events WHERE
  // failure_kind IS NOT NULL ORDER BY ts DESC LIMIT 3`) runs on EVERY dispatch.
  // Pre-fix it was a SCAN events USING INDEX idx_events_ts that walked the ts
  // index backwards filtering on the unindexed failure_kind column, rejecting
  // ~374K rows before finding 3 non-null. A partial (failure_kind, ts) index
  // (only ~322 rows have a non-null failure_kind) turns it into a covering
  // SEARCH seek. EXPLAIN on the 374K-row live-DB copy: 10.7ms → 0.16ms (~67x),
  // identical result set. Partial WHERE keeps the index tiny.
  "CREATE INDEX IF NOT EXISTS idx_events_failure_kind_ts ON events(failure_kind, ts) WHERE failure_kind IS NOT NULL",
  // 2026-05-23 dispatch hot-path audit (ACC2_PROFILE_LOOP=1): substrate.open_directive
  // showed up to 56s with low loop lag — SQL-WORKER-POOL STARVATION, not event-loop
  // block. The dedup query (findOpenDirectiveByText in
  // runtime/mcp_server/substrate_tools.ts) filters
  // `kind='directive_opened' AND json_extract(payload,'$.directive_text') = ?`.
  // Pre-fix the dedup leaned on idx_events_kind_ts (kind=?), seeking ALL
  // directive_opened rows and applying the json_extract(directive_text) equality
  // as a per-row filter (plus a json parse each). On 400K rows that hogged a
  // pool worker for seconds; during a dispatch burst (find_recipe + vec0 KNN +
  // open_directive + brain reads on the 10-worker pool) it queued 50s+. A partial
  // expression index keyed on (json_extract(...,'$.directive_text'), ts)
  // restricted to directive_opened rows turns the dedup into a point SEARCH on
  // directive_text. Including ts in the index lets the (expr, ts) order also
  // serve the ORDER BY ts ASC tiebreak, so the planner prefers it over
  // idx_events_kind_ts (a bare (expr) index loses that tie by forcing a temp
  // sort). Partial WHERE keeps it tiny. Transparent: identical dedup results.
  // EXPLAIN: SEARCH events USING INDEX idx_events_kind_ts (kind=?) →
  // SEARCH events USING INDEX idx_events_directive_text_opened (<expr>=?).
  "CREATE INDEX IF NOT EXISTS idx_events_directive_text_opened ON events(json_extract(payload, '$.directive_text'), ts) WHERE kind = 'directive_opened'",
];

/** F4a table rename (2026-05-18, roadmap WW7W1NZ8A10R52PB4E7EJE9YBW):
 *  code_artifact → act_artifact. Three production states are handled:
 *
 *    1. Fresh install: schema.sql CREATE TABLE IF NOT EXISTS already
 *       created `act_artifact`; no `code_artifact` exists. The rename
 *       block is a no-op.
 *    2. Legacy install: only `code_artifact` exists. The schema.sql
 *       CREATE TABLE IF NOT EXISTS act_artifact runs FIRST and creates
 *       an empty act_artifact. We detect this (empty act_artifact +
 *       non-empty code_artifact) and: drop the empty act_artifact,
 *       RENAME TABLE code_artifact TO act_artifact, then drop the
 *       legacy code_artifact_registry_view alias.
 *    3. Mid-migration install: both tables exist with rows (cannot
 *       happen on a healthy substrate but production DBs may have
 *       drifted via prior partial migrations). We refuse to merge — a
 *       human must resolve the divergence. The check is: if both
 *       tables exist AND both have >0 rows, throw with a clear message.
 *
 *  Idempotent: re-running on a post-migration DB walks the "fresh
 *  install" branch and exits cleanly. */
const ensureEventRollupTables = (db: Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_kind_rollup (
      kind TEXT PRIMARY KEY,
      total_count INTEGER NOT NULL DEFAULT 0,
      live_count INTEGER NOT NULL DEFAULT 0,
      first_ts TEXT NOT NULL,
      last_ts TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS event_day_kind_rollup (
      day TEXT NOT NULL,
      kind TEXT NOT NULL,
      total_count INTEGER NOT NULL DEFAULT 0,
      live_count INTEGER NOT NULL DEFAULT 0,
      first_ts TEXT NOT NULL,
      last_ts TEXT NOT NULL,
      PRIMARY KEY (day, kind)
    );
    CREATE TABLE IF NOT EXISTS event_kind_origin_rollup (
      kind TEXT NOT NULL,
      substrate_origin TEXT NOT NULL,
      PRIMARY KEY (kind, substrate_origin)
    );
    CREATE TABLE IF NOT EXISTS event_archive_summary (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      bucket TEXT NOT NULL,
      count INTEGER NOT NULL,
      first_ts TEXT NOT NULL,
      last_ts TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_event_archive_summary_kind_bucket
      ON event_archive_summary(kind, bucket);
  `);
  db.exec(`
    INSERT INTO event_kind_rollup (kind, total_count, live_count, first_ts, last_ts)
    SELECT kind, COUNT(*), COUNT(*), MIN(ts), MAX(ts) FROM events
    GROUP BY kind
    ON CONFLICT(kind) DO UPDATE SET
      live_count = excluded.live_count,
      first_ts = excluded.first_ts,
      last_ts = excluded.last_ts;
    INSERT INTO event_day_kind_rollup (day, kind, total_count, live_count, first_ts, last_ts)
    SELECT substr(ts, 1, 10), kind, COUNT(*), COUNT(*), MIN(ts), MAX(ts) FROM events
    GROUP BY substr(ts, 1, 10), kind
    ON CONFLICT(day, kind) DO UPDATE SET
      live_count = excluded.live_count,
      first_ts = excluded.first_ts,
      last_ts = excluded.last_ts;
    INSERT OR IGNORE INTO event_kind_origin_rollup (kind, substrate_origin)
    SELECT DISTINCT kind, substrate_origin FROM events;
  `);
};

const runActArtifactRename = (db: Database): void => {
  const tablesExist = (name: string): boolean => {
    const row = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    ).get(name) as { name?: string } | null;
    return !!row?.name;
  };
  const rowCount = (name: string): number => {
    try {
      const r = db.query(`SELECT count(*) AS n FROM ${name}`).get() as { n: number } | null;
      return r?.n ?? 0;
    } catch {
      return 0;
    }
  };

  const hasLegacy = tablesExist("code_artifact");
  const hasCanonical = tablesExist("act_artifact");
  if (!hasLegacy) return;

  const legacyRows = rowCount("code_artifact");
  const canonicalRows = hasCanonical ? rowCount("act_artifact") : 0;

  if (hasCanonical && canonicalRows > 0 && legacyRows > 0) {
    throw new Error(
      `act_artifact_rename_conflict: both code_artifact (${legacyRows} rows) ` +
      `and act_artifact (${canonicalRows} rows) carry data. Manual reconciliation ` +
      `required — pick the authoritative table and DROP the other before re-opening.`,
    );
  }

  if (hasCanonical && canonicalRows === 0) {
    // Empty stub act_artifact created by schema.sql's CREATE TABLE IF
    // NOT EXISTS. Drop it so RENAME can take over. Drop dependent
    // views/indexes first — SQLite refuses to drop a table referenced
    // by a view, and SQLite stores view-text as plain text so an
    // orphan act_artifact_registry_view will block the next operation.
    try { db.run("DROP VIEW IF EXISTS act_artifact_registry_view"); } catch { /* swallow */ }
    try { db.run("DROP VIEW IF EXISTS artifact_routing_view"); } catch { /* swallow */ }
    for (const idx of [
      "idx_act_artifact_runtime",
      "idx_act_artifact_status",
      "idx_act_artifact_score",
      "idx_act_artifact_kind",
      "idx_act_artifact_supersedes",
      "idx_act_artifact_superseded_by",
    ]) {
      try { db.run(`DROP INDEX IF EXISTS ${idx}`); } catch { /* swallow */ }
    }
    db.run("DROP TABLE act_artifact");
  }

  if (legacyRows === 0 && !hasCanonical) {
    // Legacy table exists but is empty AND no canonical table.
    // schema.sql's CREATE TABLE IF NOT EXISTS act_artifact already ran
    // before this function (runSchema runs first), so this branch is
    // unreachable in practice. Defensive: drop the empty legacy table.
    db.run("DROP TABLE code_artifact");
    return;
  }

  db.run("ALTER TABLE code_artifact RENAME TO act_artifact");

  // The legacy view code_artifact_registry_view (created by older runs
  // of substrate/views.ts on this DB) still points to the now-renamed
  // table. Drop it so views.ts can recreate the canonical
  // act_artifact_registry_view alone.
  try { db.run("DROP VIEW IF EXISTS code_artifact_registry_view"); } catch { /* swallow */ }

  // Legacy indexes carry the old name. SQLite RENAME TABLE leaves them
  // attached to the renamed table; drop them so the new index names
  // (idx_act_artifact_*) can be created by schema.sql / migrations
  // without collision.
  for (const legacyIdx of [
    "idx_code_artifact_runtime",
    "idx_code_artifact_status",
    "idx_code_artifact_score",
    "idx_code_artifact_kind",
    "idx_code_artifact_supersedes",
    "idx_code_artifact_superseded_by",
  ]) {
    try { db.run(`DROP INDEX IF EXISTS ${legacyIdx}`); } catch { /* swallow */ }
  }
};

// Phase 2 distribution: attach the packaged canonical.db (Lin et al.
// 2026 mnemonic-sovereignty + brain 4YBZ1E7MAX49Q4Z0 K1+L1+M3+N1).
// `canonical.db` lives in the package at `substrate/canonical.db` and
// contains release-owned read-only seeds. Runtime reads union with
// main; main precedence on id conflict (organism rows shadow canonical).
// Missing file is non-fatal — pre-Phase-2 organisms and fresh installs
// before canonical.db packaging both work without it.
const attachCanonicalDbIfPresent = (db: Database): void => {
  try {
    const fs = require("node:fs");
    const path = require("node:path");
    // canonical.db lives in substrate/ alongside seed.ts; the runtime
    // resolves relative to the substrate module dir to survive both
    // dev and packaged-install layouts.
    const canonicalPath = path.join(import.meta.dir, "canonical.db");
    if (!fs.existsSync(canonicalPath)) return;
    // ATTACH in read-only mode using URI form so the read-only flag is
    // honored on every SQLite build (mode=ro requires uri=1).
    const escaped = canonicalPath.replace(/'/g, "''");
    db.exec(`ATTACH DATABASE 'file:${escaped}?mode=ro' AS canonical`);
  } catch (err) {
    // Fail-soft: canonical.db is additive — pre-Phase-2 installs
    // operate without it. The attach is best-effort; runtime queries
    // that union canonical.X with main.X must tolerate the canonical
    // schema being absent (via try/catch or pragma table_info probe).
    if (typeof console !== "undefined") {
      console.warn("[substrate/db] attachCanonicalDbIfPresent skipped:", String(err).slice(0, 200));
    }
  }
};

export const runMigrations = (db: Database): void => {
  // Order matters:
  //   1. RENAME code_artifact → act_artifact (if needed) so later ALTERs
  //      target the canonical name on every DB.
  //   2. ALTER TABLE columns (idempotent: swallow duplicate-column).
  //   3. CREATE INDEX on the renamed table.
  //   4. Backfill kind discriminator for typed seed rows.
  runActArtifactRename(db);
  ensureEventRollupTables(db);

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

  // Recreate the canonical indexes on the (possibly renamed) table.
  // Idempotent via CREATE INDEX IF NOT EXISTS.
  for (const ddl of [
    "CREATE INDEX IF NOT EXISTS idx_act_artifact_runtime ON act_artifact(runtime)",
    "CREATE INDEX IF NOT EXISTS idx_act_artifact_status  ON act_artifact(status)",
    "CREATE INDEX IF NOT EXISTS idx_act_artifact_score   ON act_artifact(score DESC)",
    "CREATE INDEX IF NOT EXISTS idx_act_artifact_kind    ON act_artifact(kind)",
  ]) {
    db.run(ddl);
  }

  for (const ddl of EVENT_HOT_PATH_INDEXES) {
    try {
      db.run(ddl);
    } catch (err) {
      // A legacy / partial `events` table reached via the RENAME-only
      // migration path (no full runSchema) can lack a column a newer
      // hot-path index references (e.g. failure_kind). On a real DB
      // runSchema always creates the full events table first, so this
      // only fires for synthetic minimal-schema callers; the index is
      // simply not needed there yet. Tolerate the missing column the
      // same way the act_artifact ADD COLUMN loop tolerates duplicates;
      // re-throw anything else so genuine DDL faults still surface.
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("no such column")) throw err;
    }
  }

  // F4c (2026-05-18, contract 897XTN2GF11XB9D4N45N2R9W58): ensure the
  // artifact_kind_metadata table exists AND is seeded with the legacy
  // `atms_report_v*` prefix kinds. Both steps are idempotent (CREATE
  // TABLE IF NOT EXISTS + INSERT … ON CONFLICT DO NOTHING).
  ensureArtifactKindMetadataTable(db);

  // Durable dispatch-lease table (multi-worker-daemon coordination +
  // restart-durable brain-dispatch claims). Idempotent CREATE TABLE IF NOT
  // EXISTS — backs the in-memory IN_FLIGHT_BRAIN dedup in
  // runtime/task_scheduler.ts as the cross-process authoritative claim.
  ensureDispatchLeaseTable(db);

  // L8 backfill: dispatch_strategy seed rows (admitted with
  // state_root='dispatch/strategy') predate the kind column.
  // Tag them so the strategy_ranker can use the cleaner kind
  // discriminator. Idempotent — only updates rows that still carry
  // the legacy 'code_artifact' default.
  try {
    db.run(
      `UPDATE act_artifact SET kind = 'dispatch_strategy_v1'
       WHERE state_root = 'dispatch/strategy' AND kind IN ('code_artifact', 'runtime_action')`,
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
  // Phase 2 distribution (docs/Architecture.md, brain
  // 4YBZ1E7MAX49Q4Z0 K1+L1+M3+N1): attach packaged canonical.db
  // read-only when present. Runtime read paths can union
  // canonical.act_artifact with main.act_artifact (main precedence
  // on id conflict). Missing canonical.db is non-fatal — fresh
  // installs and pre-Phase-2 organisms both work.
  attachCanonicalDbIfPresent(db);
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
 *    - `wal_autocheckpoint = 0`      synchronous checkpoint-on-COMMIT DISABLED
 *    - `busy_timeout = 5000`         wait up to 5s on writer contention
 *    - `mmap_size = 268435456`       256MB memory-mapped reads
 *  applyWalPragmas already sets `wal_autocheckpoint = 0` on the writer
 *  (reactivity fix 2026-05-24 — see the long note there). This helper
 *  only re-asserts it for the pool writer (defence-in-depth against a
 *  future refactor that re-introduces a non-zero default upstream) and
 *  bumps busy_timeout to 5s for multi-terminal write contention. The
 *  checkpoint cadence for BOTH the openDb writer and the pool writer is
 *  owned by runtime/wal_checkpoint_driver.ts, NOT by autocheckpoint. */
const applyPoolWriterPragmas = (db: Database): void => {
  db.run("PRAGMA wal_autocheckpoint = 0");
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
