// acc2 — cold archive query surface.
//
// Pairs with runtime/archival_worker.ts. The worker moves rows older
// than archival_retention_days to monthly sibling files
// `state-archive-YYYY-MM.db`. This module exposes:
//
//   - listArchives(stateDbPath)            → sorted archive paths
//   - openColdDb(archivePath)              → readonly Database handle
//   - searchAcrossArchives(hotDb, dir, sql, params, opts) → union
//
// Cold DBs are READ-ONLY. Nothing in the runtime mutates them after
// the archival sweep COMMITs; opening readonly enforces that
// structurally so a stray `INSERT` from a misbehaving caller cannot
// corrupt the archive history.

import { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const ARCHIVE_FILE_RE = /^state-archive-\d{4}-\d{2}\.db$/;

/** Return absolute paths of every state-archive-YYYY-MM.db file in
 *  the same directory as stateDbPath. Sorted ASC (oldest first). */
export const listArchives = (stateDbPath: string): string[] => {
  const dir = dirname(stateDbPath);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => ARCHIVE_FILE_RE.test(basename(f)))
    .sort()
    .map((f) => join(dir, f));
};

/** Open a cold archive read-only. The caller MUST close the returned
 *  handle. */
export const openColdDb = (archivePath: string): Database => {
  return new Database(archivePath, { readonly: true, strict: true });
};

export type SearchAcrossArchivesOptions = {
  /** When false, skip cold archives (hot only). Default true. */
  includeCold?: boolean;
  /** When true, skip the hot DB (cold only). Default false. */
  hotOnlyCold?: boolean;
  /** Max rows per source. Default unlimited (caller-bounded sql). */
  perSourceLimit?: number;
};

/** Run `sql` against the hot DB and (optionally) every cold archive,
 *  unioning the results into one array. The sql + params shape MUST
 *  be valid against the canonical events schema; cold DBs share that
 *  schema verbatim. No deduplication — the (id) primary key makes
 *  cross-source duplicates structurally impossible because rows move
 *  via verify-then-delete.
 *
 *  archiveDir may be either a state.db file path or its containing
 *  directory; listArchives resolves the directory either way. */
export const searchAcrossArchives = async <T = Record<string, unknown>>(
  hotDb: Database,
  archiveDir: string,
  sql: string,
  params: unknown[] = [],
  opts: SearchAcrossArchivesOptions = {},
): Promise<T[]> => {
  const includeCold = opts.includeCold !== false;
  const hotOnlyCold = opts.hotOnlyCold === true;
  const results: T[] = [];

  // Hot first (most recent rows; caller may LIMIT in sql).
  if (!hotOnlyCold) {
    const hotRows = hotDb.query<T, unknown[]>(sql).all(...params);
    for (const r of hotRows) results.push(r);
  }

  if (!includeCold) return results;

  // Resolve archive directory: caller may pass either a state.db path
  // or its containing directory. listArchives takes a stateDbPath, so
  // synthesize one when only the dir was passed.
  const probe = archiveDir.endsWith(".db") ? archiveDir : join(archiveDir, "state.db");
  const archives = listArchives(probe);
  for (const path of archives) {
    let cold: Database | null = null;
    try {
      cold = openColdDb(path);
      const coldRows = cold.query<T, unknown[]>(sql).all(...params);
      for (const r of coldRows) results.push(r);
    } finally {
      if (cold) {
        try {
          cold.close();
        } catch {
          /* swallow */
        }
      }
    }
  }

  return results;
};
