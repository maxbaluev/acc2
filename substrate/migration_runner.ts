// acc2 substrate/migrations registry — versioned schema migrations.
//
// Per brain dispatch VJDMME8JD961SE6F amendment 4AV2NPJW2H1HV0XQ3MR2ZV78KC
// + docs/Architecture.md §16: "A substrate/migrations registry is the
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
// Architecture.md §16), NOT brain-mediated mutation. acc upgrade
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
};

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");

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

const listMigrationFiles = (): string[] => {
  try {
    const stat = statSync(MIGRATIONS_DIR);
    if (!stat.isDirectory()) return [];
  } catch {
    return [];
  }
  try {
    return readdirSync(MIGRATIONS_DIR)
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

export const runVersionedMigrations = (db: Database): MigrationSummary => {
  const summary: MigrationSummary = {
    applied: 0,
    skipped_already_applied: 0,
    failed: 0,
    versions_applied: [],
    errors: [],
  };

  const files = listMigrationFiles();
  if (files.length === 0) return summary;

  for (const file of files) {
    const version = extractVersion(file);
    if (versionAlreadyApplied(db, version)) {
      summary.skipped_already_applied++;
      continue;
    }

    const fullPath = join(MIGRATIONS_DIR, file);
    let sqlText = "";
    try {
      sqlText = readFileSync(fullPath, "utf8");
    } catch (err) {
      summary.failed++;
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
      continue;
    }

    try {
      db.exec("BEGIN");
      db.exec(sqlText);
      db.exec("COMMIT");
      summary.applied++;
      summary.versions_applied.push(version);
      try {
        emitEvent(db, {
          kind: "schema_migration_applied",
          substrate_origin: "substrate_auto",
          payload: {
            version,
            file: basename(file),
            sql_bytes: sqlText.length,
          } satisfies Record<string, JsonValue>,
        });
      } catch (err) {
        logger.warn(
          { where: "migration_runner.emit_applied", version, err: String(err) },
          "could not emit schema_migration_applied",
        );
      }
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch {}
      summary.failed++;
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
