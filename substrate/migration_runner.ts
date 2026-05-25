// acc2 substrate/migrations registry — versioned schema migrations.
//
// Per brain dispatch VJDMME8JD961SE6F amendment 4AV2NPJW2H1HV0XQ3MR2ZV78KC
// + docs/Architecture.md: "A substrate/migrations registry is the
// ONLY path for state.db schema changes. Migrations are idempotent,
// ledger-audited (each application emits schema_migration_applied
// {version, ts, success}), and tested against representative organism
// snapshots before release."
//
// Migration file convention: substrate/migrations/v0NN_<short_name>.sql
//   - Three-digit zero-padded version number (sortable as text).
//   - Snake_case description after the number.
//   - One SQL file = one atomic migration.
//   - Idempotent statements ONLY: CREATE TABLE IF NOT EXISTS,
//     CREATE INDEX IF NOT EXISTS, etc. Migrations that need
//     procedural logic admit a sibling .ts file (future).
//
// Boot path: daemon calls runMigrations(db) AFTER schema.sql is applied
// but BEFORE seedActArtifacts(). Already-applied migrations are
// skipped via the schema_migration_applied event ledger; failures
// emit schema_migration_failed and refuse boot (fail-loud — silent
// migration corruption is worse than a loud refusal).
//
// Schema migrations are SHIPPED state (canonical.db side per
// Architecture.md), NOT brain-mediated mutation. acc upgrade
// applies them deterministically.

import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { emitEvent } from "../runtime/events";
import { logger } from "../runtime/logger";
import type { JsonValue } from "./types";

export type MigrationSummary = {
  applied: number;
  skipped_already_applied: number;
  failed: number;
  versions_applied: string[];
  errors: string[];
  /** Multi-gap halt safety: the version that failed mid-sequence, if any.
   *  When a migration fails, the runner STOPS — it does not attempt k+1.
   *  This is the version a behind organism's upgrade halted on; the
   *  earlier versions are applied + audited, this one is NOT marked
   *  applied (so a re-run after the fix retries cleanly), and the later
   *  versions are left untouched (skipped, not attempted). */
  failed_version: string | null;
  /** Versions present in the registry that were never attempted because an
   *  earlier migration failed and the runner halted. Empty on success. */
  not_attempted_versions: string[];
};

export type PendingMigrationInspection = {
  latest_version: string | null;
  applied_versions: string[];
  pending_versions: string[];
  pending_files: string[];
  total_files: number;
  up_to_date: boolean;
};

export type PendingMigration = {
  version: string;
  file: string;
  sql_bytes: number;
};

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");

/** Optional overrides for the migration source dir + version-order
 *  validation. Production callers pass nothing (the shipped
 *  substrate/migrations dir). Tests pass a temp dir holding synthetic
 *  v0NN_*.sql files to exercise multi-gap and mid-sequence-failure
 *  scenarios without touching the real registry. */
export type MigrationRunOptions = { migrationsDir?: string };

const versionAlreadyApplied = (db: Database, version: string): boolean => {
  try {
    const row = db
      .query<{ c: number }, [string, string]>(
        `SELECT COUNT(*) AS c FROM events
          WHERE kind = ?
            AND json_extract(payload, '$.version') = ?`,
      )
      .get("schema_migration_applied", version);
    return (row?.c ?? 0) > 0;
  } catch {
    return false;
  }
};

const listMigrationFiles = (dir: string = MIGRATIONS_DIR): string[] => {
  try {
    const stat = statSync(dir);
    if (!stat.isDirectory()) return [];
  } catch {
    return [];
  }
  try {
    return readdirSync(dir)
      .filter((f) => /^v\d{3}_.+\.sql$/.test(f))
      .sort(); // lexicographic = version order due to zero-padding
  } catch {
    return [];
  }
};

const extractVersion = (filename: string): string => {
  const m = filename.match(/^(v\d{3})_/);
  return m ? m[1] : filename;
};

/** Read-only enumeration of migrations not yet applied to this db (the
 *  schema_migration_applied event ledger is the sole marker). Used by
 *  `acc doctor`'s pending-migration check and update tooling to surface
 *  schema drift without mutating state. */
export const listPendingMigrations = (db: Database, opts: MigrationRunOptions = {}): PendingMigration[] => {
  const dir = opts.migrationsDir ?? MIGRATIONS_DIR;
  const pending: PendingMigration[] = [];
  for (const file of listMigrationFiles(dir)) {
    const version = extractVersion(file);
    if (versionAlreadyApplied(db, version)) continue;
    const fullPath = join(dir, file);
    let sqlText = "";
    try {
      sqlText = readFileSync(fullPath, "utf8");
    } catch {
      sqlText = "";
    }
    pending.push({ version, file: basename(file), sql_bytes: sqlText.length });
  }
  return pending;
};

export const inspectPendingMigrations = (db: Database, opts: MigrationRunOptions = {}): PendingMigrationInspection => {
  const dir = opts.migrationsDir ?? MIGRATIONS_DIR;
  const files = listMigrationFiles(dir);
  const pending = listPendingMigrations(db, opts);
  const pendingVersions = pending.map((m) => m.version);
  const appliedVersions = files.map(extractVersion).filter((v) => !pendingVersions.includes(v));
  return {
    latest_version: files.length > 0 ? extractVersion(files[files.length - 1]!) : null,
    applied_versions: appliedVersions,
    pending_versions: pendingVersions,
    pending_files: pending.map((m) => m.file),
    total_files: files.length,
    up_to_date: pendingVersions.length === 0,
  };
};

export const runVersionedMigrations = (db: Database, opts: MigrationRunOptions = {}): MigrationSummary => {
  const dir = opts.migrationsDir ?? MIGRATIONS_DIR;
  const summary: MigrationSummary = {
    applied: 0,
    skipped_already_applied: 0,
    failed: 0,
    versions_applied: [],
    errors: [],
    failed_version: null,
    not_attempted_versions: [],
  };

  const files = listMigrationFiles(dir);
  if (files.length === 0) return summary;

  // Multi-gap halt safety: a user many versions behind applies pending
  // migrations in version order (listMigrationFiles sorts lexicographically;
  // the v0NN zero-padded convention makes lexicographic == numeric version
  // order). If migration k FAILS we MUST STOP — applying k+1 on top of a
  // half-migrated schema risks the same RENAME/DROP corruption v002 guards
  // against. We record which version failed, leave it UNMARKED (so a re-run
  // after the fix retries it cleanly), and list every later version as
  // not-attempted so the caller knows the upgrade is incomplete.
  for (let idx = 0; idx < files.length; idx++) {
    const file = files[idx]!;
    const version = extractVersion(file);
    if (versionAlreadyApplied(db, version)) {
      summary.skipped_already_applied++;
      continue;
    }

    const fullPath = join(dir, file);
    let sqlText = "";
    try {
      sqlText = readFileSync(fullPath, "utf8");
    } catch (err) {
      summary.failed++;
      summary.failed_version = version;
      summary.errors.push(`read_failed:${file}:${(err as Error).message}`);
      try {
        emitEvent(db, {
          kind: "schema_migration_failed",
          substrate_origin: "substrate_auto",
          payload: {
            version,
            file: basename(file),
            phase: "read",
            error: (err as Error).message,
          } satisfies Record<string, JsonValue>,
        });
      } catch {}
      // HALT: do not attempt k+1..n on a failed sequence.
      summary.not_attempted_versions = files.slice(idx + 1).map(extractVersion);
      break;
    }

    try {
      db.exec("BEGIN");
      db.exec(sqlText);
      // Crash-window idempotency fix: the schema_migration_applied event is
      // the SOLE marker versionAlreadyApplied() consults. Emitting it AFTER
      // COMMIT left a window where the migration SQL was durable but the
      // marker was not (process crash, or a failed/swallowed emit) — on the
      // next boot the migration re-ran. v002 is NON-idempotent (it RENAMEs
      // act_artifact then DROPs the renamed table); re-applying it throws (or
      // worse, drops live data). Emit the marker INSIDE the same transaction
      // as the SQL so "applied" and "recorded-as-applied" commit atomically:
      // either both land or both roll back. emitEvent is a plain INSERT and
      // joins the open transaction; if it throws, the whole migration rolls
      // back and is retried cleanly next boot.
      emitEvent(db, {
        kind: "schema_migration_applied",
        substrate_origin: "substrate_auto",
        payload: {
          version,
          file: basename(file),
          sql_bytes: sqlText.length,
        } satisfies Record<string, JsonValue>,
      });
      db.exec("COMMIT");
      summary.applied++;
      summary.versions_applied.push(version);
    } catch (err) {
      // ROLLBACK leaves the DB exactly as it was before this migration's
      // BEGIN — the failed version is atomic (all-or-nothing) and is NOT
      // marked applied (the schema_migration_applied marker is emitted
      // INSIDE the same transaction, so it rolls back too). Earlier
      // versions already committed + audited stay applied.
      try { db.exec("ROLLBACK"); } catch {}
      summary.failed++;
      summary.failed_version = version;
      summary.errors.push(`exec_failed:${file}:${(err as Error).message}`);
      try {
        emitEvent(db, {
          kind: "schema_migration_failed",
          substrate_origin: "substrate_auto",
          payload: {
            version,
            file: basename(file),
            phase: "exec",
            error: (err as Error).message,
          } satisfies Record<string, JsonValue>,
        });
      } catch {}
      // HALT: a mid-sequence failure stops the run. Do NOT continue to
      // k+1 — the later migrations may assume the failed one's schema
      // shape. Record them as not-attempted so the upgrade is reported
      // incomplete and a re-run (after the operator fixes the failure)
      // resumes at the failed version.
      summary.not_attempted_versions = files.slice(idx + 1).map(extractVersion);
      break;
    }
  }

  return summary;
};

/** Resolve an act_artifact id through the alias chain. If the id was
 *  renamed via act_artifact_aliased events, returns the latest
 *  canonical id. Cycle-refused: if a cycle is detected (alias chain
 *  loops back to a visited id), returns the LAST id seen before the
 *  cycle (fail-soft, never throws).
 *
 *  Per brain ZM4HZPQFMS2D7E: "Predicate and artifact renames should
 *  use a generic act_artifact_aliased event so posterior credit
 *  follows old_id to new_id without creating predicate-specific
 *  evolution enums."
 *
 *  Append-only: latest alias for old_id wins. Credit resolution
 *  callers (runtime/credit.ts, retrieval) should invoke this before
 *  posterior update so the new id receives the credit. */
export const resolveAliasChain = (db: Database, id: string): string => {
  let current = id;
  const visited = new Set<string>([id]);
  const MAX_DEPTH = 16;
  for (let i = 0; i < MAX_DEPTH; i++) {
    let next: string | null = null;
    try {
      const row = db
        .query<{ new_id: string | null }, [string]>(
          `SELECT json_extract(payload, '$.new_id') AS new_id FROM events
            WHERE kind = 'act_artifact_aliased'
              AND json_extract(payload, '$.old_id') = ?
            ORDER BY ts DESC
            LIMIT 1`,
        )
        .get(current);
      next = row?.new_id ?? null;
    } catch {
      return current;
    }
    if (!next || next === current) return current;
    if (visited.has(next)) {
      // Cycle — return the LAST id before the cycle
      logger.warn(
        { where: "resolveAliasChain.cycle", id, cycle_id: next },
        "act_artifact_aliased chain cycle refused",
      );
      return current;
    }
    visited.add(next);
    current = next;
  }
  return current;
};

// ── Hot-path memoization for ALIAS_CHAI (directive 3XETJCYT) ─────────
//
// Every artifact lookup/credit path that resolves an OLD id → CURRENT id
// would otherwise run resolveAliasChain on the hot path. Each hop scans
// the events table filtered by json_extract(payload,'$.old_id') — the
// idx_events_act_artifact_aliased (kind, ts) partial index (v001) covers
// the kind+ORDER BY but NOT the old_id predicate, so a naive call is one
// indexed-range-scan-per-hop. Aliases are append-only and rare (one row
// per renamed handle per release), so a per-db process-lifetime cache is
// the correct shape: resolved id is stable until a NEW act_artifact_aliased
// row lands, at which point invalidateAliasCache(db) clears the map.
//
// Keyed by the Database object identity (WeakMap) so a fresh :memory: db
// in a test gets its own cache and the entry is GC'd with the db. The
// identity case (no alias) is cached as `id === id` so an un-aliased id
// costs exactly one map lookup after the first resolve.
const aliasResolutionCache = new WeakMap<Database, Map<string, string>>();

const cacheForDb = (db: Database): Map<string, string> => {
  let m = aliasResolutionCache.get(db);
  if (!m) {
    m = new Map<string, string>();
    aliasResolutionCache.set(db, m);
  }
  return m;
};

/** Invalidate the per-db alias resolution cache. Called from the
 *  emitEvent post-write boundary whenever an act_artifact_aliased row
 *  lands so the next resolveArtifactId reflects the new edge. Cheap:
 *  clears the whole map (alias mutations are rare; selective invalidation
 *  would have to walk the chain anyway). */
export const invalidateAliasCache = (db: Database): void => {
  const m = aliasResolutionCache.get(db);
  if (m) m.clear();
};

/** Canonical artifact-id resolver used by every lookup/credit/routing
 *  path (ALIAS_CHAI). Resolves OLD → CURRENT through the append-only
 *  act_artifact_aliased chain (multi-hop, cycle-refused via
 *  resolveAliasChain) and memoizes the result per-db. An un-aliased id
 *  resolves to itself (identity). This is the SINGLE seam through which
 *  accumulated posterior credit survives a rename across many version
 *  gaps — a citation of an old id lands on the current artifact's row,
 *  never a phantom. */
export const resolveArtifactId = (db: Database, id: string): string => {
  if (!id) return id;
  const cache = cacheForDb(db);
  const hit = cache.get(id);
  if (hit !== undefined) return hit;
  const resolved = resolveAliasChain(db, id);
  cache.set(id, resolved);
  return resolved;
};
