// substrate/migrations runner tests per docs/Architecture.md.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "./db";
import { emitEvent } from "../runtime/events";
import {
  runVersionedMigrations,
  resolveAliasChain,
  resolveArtifactId,
  listPendingMigrations,
  inspectPendingMigrations,
} from "./migration_runner";

afterAll(() => closeDb());
beforeEach(() => closeDb());

describe("migration_runner", () => {
  test("runVersionedMigrations applies the v001 baseline + emits schema_migration_applied", () => {
    const db = openDb(":memory:");
    const summary = runVersionedMigrations(db);
    expect(summary.failed).toBe(0);
    expect(summary.applied + summary.skipped_already_applied).toBeGreaterThanOrEqual(1);
    if (summary.applied > 0) {
      expect(summary.versions_applied).toContain("v001");
      const ev = db
        .query<{ c: number }, []>(
          `SELECT COUNT(*) AS c FROM events WHERE kind = 'schema_migration_applied'`,
        )
        .get();
      expect(ev?.c).toBeGreaterThanOrEqual(1);
    }
  });

  test("runVersionedMigrations is idempotent — re-run skips already-applied migrations", () => {
    const db = openDb(":memory:");
    const first = runVersionedMigrations(db);
    const second = runVersionedMigrations(db);
    expect(second.applied).toBe(0);
    expect(second.skipped_already_applied).toBeGreaterThanOrEqual(first.applied);
    expect(second.failed).toBe(0);
  });

  test("v003 world-model projection migration is idempotent and creates only event-backed indexes", () => {
    const db = openDb(":memory:");
    const first = runVersionedMigrations(db);
    expect(first.failed).toBe(0);
    expect(first.versions_applied).toContain("v003");
    const indexes = (db.query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_events_world_model_%' ORDER BY name`).all() ?? []).map((r) => r.name);
    expect(indexes).toEqual(["idx_events_world_model_delta_task_ts", "idx_events_world_model_snapshot_task_ts"]);
    const second = runVersionedMigrations(db);
    expect(second.applied).toBe(0);
    expect(second.failed).toBe(0);
  });

  test("crash-window atomicity: the schema_migration_applied marker is committed in the SAME transaction as the migration SQL (every applied version has exactly one durable marker, no partial-apply re-run risk)", () => {
    // The marker event is the SOLE idempotency signal. If it lands in a
    // separate write after COMMIT, a crash between COMMIT and the emit leaves
    // the SQL durable but the version unrecorded → re-run. v002 is
    // NON-idempotent (RENAME act_artifact → DROP), so a re-run would throw or
    // destroy data. After the fix the marker commits atomically with the SQL:
    // for every version reported applied there is exactly one durable marker,
    // and a re-run skips it without re-executing the destructive SQL.
    const db = openDb(":memory:");
    const summary = runVersionedMigrations(db);
    expect(summary.failed).toBe(0);

    for (const version of summary.versions_applied) {
      const markerCount = (db
        .query<{ c: number }, [string]>(
          `SELECT COUNT(*) AS c FROM events
            WHERE kind = 'schema_migration_applied'
              AND json_extract(payload, '$.version') = ?`,
        )
        .get(version))?.c ?? 0;
      expect(markerCount).toBe(1);
    }

    // Re-run: every previously-applied version is skipped via its durable
    // marker; the non-idempotent v002 SQL must NOT execute again.
    const rerun = runVersionedMigrations(db);
    expect(rerun.applied).toBe(0);
    expect(rerun.failed).toBe(0);
    expect(rerun.skipped_already_applied).toBe(summary.applied);

    // act_artifact survived (not dropped by a destructive v002 re-apply).
    const tableExists = (db
      .query<{ c: number }, []>(
        `SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='act_artifact'`,
      )
      .get())?.c ?? 0;
    expect(tableExists).toBe(1);
  });

  test("listPendingMigrations enumerates unapplied versions before run and is empty after (read-only — no schema_migration_applied emitted)", () => {
    const db = openDb(":memory:");
    const before = listPendingMigrations(db);
    // Read-only enumeration must not have applied anything.
    const markerCountAfterList = (db
      .query<{ c: number }, []>(
        `SELECT COUNT(*) AS c FROM events WHERE kind = 'schema_migration_applied'`,
      )
      .get())?.c ?? 0;
    expect(markerCountAfterList).toBe(0);

    const summary = runVersionedMigrations(db);
    expect(before.length).toBe(summary.applied);
    for (const p of before) {
      expect(p.version).toMatch(/^v\d{3}$/);
      expect(p.file).toMatch(/\.sql$/);
      expect(p.sql_bytes).toBeGreaterThan(0);
      expect(summary.versions_applied).toContain(p.version);
    }

    // After applying, nothing is pending.
    expect(listPendingMigrations(db)).toEqual([]);
  });
});

describe("migration_runner multi-gap + mid-sequence halt (a user many versions behind)", () => {
  // Each test seeds a temp migrations dir with synthetic v0NN_*.sql files
  // so we can exercise multi-gap ordering and a deliberately-failing
  // migration WITHOUT touching the real substrate/migrations registry.
  const seedDir = (files: Array<{ name: string; sql: string }>): string => {
    const dir = mkdtempSync(join(tmpdir(), "acc2-migrations-"));
    for (const f of files) writeFileSync(join(dir, f.name), f.sql);
    return dir;
  };

  const versionMarkers = (db: ReturnType<typeof openDb>): string[] =>
    (db
      .query<{ version: string }, []>(
        `SELECT json_extract(payload, '$.version') AS version FROM events
          WHERE kind = 'schema_migration_applied'
          ORDER BY ts ASC`,
      )
      .all() ?? [])
      .map((r) => r.version)
      .filter((v) => /^v\d{3}$/.test(v));

  test("a user many versions behind applies ALL pending migrations in correct version order", () => {
    const db = openDb(":memory:");
    const dir = seedDir([
      // Deliberately out of readdir order to prove the sort is version-order.
      { name: "v030_three.sql", sql: "CREATE TABLE IF NOT EXISTS mg_three (x INTEGER);" },
      { name: "v010_one.sql", sql: "CREATE TABLE IF NOT EXISTS mg_one (x INTEGER);" },
      { name: "v020_two.sql", sql: "CREATE TABLE IF NOT EXISTS mg_two (x INTEGER);" },
    ]);
    try {
      const summary = runVersionedMigrations(db, { migrationsDir: dir });
      expect(summary.failed).toBe(0);
      expect(summary.applied).toBe(3);
      // Applied IN version order regardless of readdir order.
      expect(summary.versions_applied).toEqual(["v010", "v020", "v030"]);
      // Marker emit order matches version order too.
      expect(versionMarkers(db)).toEqual(["v010", "v020", "v030"]);
      // All three tables exist.
      for (const t of ["mg_one", "mg_two", "mg_three"]) {
        const c = (db.query<{ c: number }, [string]>(
          `SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name=?`,
        ).get(t))?.c ?? 0;
        expect(c).toBe(1);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("mid-sequence migration FAILURE halts safely: earlier applied+audited, failing one NOT marked, later ones NOT attempted", () => {
    const db = openDb(":memory:");
    const dir = seedDir([
      { name: "v010_one.sql", sql: "CREATE TABLE IF NOT EXISTS mh_one (x INTEGER);" },
      { name: "v020_two.sql", sql: "CREATE TABLE IF NOT EXISTS mh_two (x INTEGER);" },
      // Deliberate failure: invalid SQL.
      { name: "v030_boom.sql", sql: "THIS IS NOT VALID SQL;" },
      // Must NOT be attempted because v030 failed and the runner halts.
      { name: "v040_four.sql", sql: "CREATE TABLE IF NOT EXISTS mh_four (x INTEGER);" },
    ]);
    try {
      const summary = runVersionedMigrations(db, { migrationsDir: dir });
      // Two earlier versions applied + audited.
      expect(summary.applied).toBe(2);
      expect(summary.versions_applied).toEqual(["v010", "v020"]);
      expect(versionMarkers(db)).toEqual(["v010", "v020"]);
      // The failing version is reported and NOT marked applied.
      expect(summary.failed).toBe(1);
      expect(summary.failed_version).toBe("v030");
      const v030Marker = (db.query<{ c: number }, []>(
        `SELECT COUNT(*) AS c FROM events
          WHERE kind = 'schema_migration_applied'
            AND json_extract(payload, '$.version') = 'v030'`,
      ).get())?.c ?? 0;
      expect(v030Marker).toBe(0);
      // A schema_migration_failed row records WHICH version failed.
      const failMarker = (db.query<{ c: number }, []>(
        `SELECT COUNT(*) AS c FROM events
          WHERE kind = 'schema_migration_failed'
            AND json_extract(payload, '$.version') = 'v030'`,
      ).get())?.c ?? 0;
      expect(failMarker).toBe(1);
      // Later version NOT attempted (no marker, table not created).
      expect(summary.not_attempted_versions).toEqual(["v040"]);
      const v040Marker = (db.query<{ c: number }, []>(
        `SELECT COUNT(*) AS c FROM events
          WHERE kind = 'schema_migration_applied'
            AND json_extract(payload, '$.version') = 'v040'`,
      ).get())?.c ?? 0;
      expect(v040Marker).toBe(0);
      const v040Table = (db.query<{ c: number }, []>(
        `SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='mh_four'`,
      ).get())?.c ?? 0;
      expect(v040Table).toBe(0);
      // DB left consistent: the two earlier tables exist, failed one's table does not.
      for (const t of ["mh_one", "mh_two"]) {
        const c = (db.query<{ c: number }, [string]>(
          `SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name=?`,
        ).get(t))?.c ?? 0;
        expect(c).toBe(1);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("re-run after a halted failure resumes at the failed version (earlier ones skipped, not re-executed)", () => {
    const db = openDb(":memory:");
    const dir = seedDir([
      { name: "v010_one.sql", sql: "CREATE TABLE IF NOT EXISTS rr_one (x INTEGER);" },
      { name: "v020_boom.sql", sql: "TOTALLY INVALID;" },
    ]);
    try {
      const first = runVersionedMigrations(db, { migrationsDir: dir });
      expect(first.applied).toBe(1);
      expect(first.failed_version).toBe("v020");
      // Operator "fixes" v020 by replacing the bad SQL with valid SQL.
      writeFileSync(join(dir, "v020_boom.sql"), "CREATE TABLE IF NOT EXISTS rr_two (x INTEGER);");
      const second = runVersionedMigrations(db, { migrationsDir: dir });
      // v010 already applied → skipped, NOT re-executed; v020 now applies.
      expect(second.skipped_already_applied).toBe(1);
      expect(second.applied).toBe(1);
      expect(second.versions_applied).toEqual(["v020"]);
      expect(second.failed).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("inspectPendingMigrations honors the injected dir and reports order", () => {
    const db = openDb(":memory:");
    const dir = seedDir([
      { name: "v010_a.sql", sql: "CREATE TABLE IF NOT EXISTS ip_a (x INTEGER);" },
      { name: "v020_b.sql", sql: "CREATE TABLE IF NOT EXISTS ip_b (x INTEGER);" },
    ]);
    try {
      const before = inspectPendingMigrations(db, { migrationsDir: dir });
      expect(before.pending_versions).toEqual(["v010", "v020"]);
      expect(before.up_to_date).toBe(false);
      runVersionedMigrations(db, { migrationsDir: dir });
      const after = inspectPendingMigrations(db, { migrationsDir: dir });
      expect(after.up_to_date).toBe(true);
      expect(after.pending_versions).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("canonical reconciliation: local row shadows a release-renamed canonical id, posterior survives", () => {
  test("a local artifact row that shadows a canonical id the release ALIASED resolves to the local CURRENT id with posterior intact", () => {
    // Compose attachCanonicalDbIfPresent (local main.act_artifact shadows
    // same-id canonical rows on read) with resolveArtifactId (release rename
    // via act_artifact_aliased). Scenario: a release renamed the canonical
    // handle `canon_old` → `local_current`, and the local organism holds a
    // current-id row carrying accumulated posterior credit. A by-id lookup
    // of the OLD canonical id must land on the LOCAL current row, posterior
    // intact — canonical is a read-only baseline and never overwrites local.
    const db = openDb(":memory:");
    // Local current-id row with accumulated posterior (alpha=7 > baseline 1).
    db.run(
      `INSERT INTO act_artifact (
         id, runtime, body, declared_sandbox, state_root, kind,
         posterior_alpha, posterior_beta, score, confidence,
         recent_residual_mean, recent_kill_count, status, name,
         created_at, updated_at
       ) VALUES (?, 'bun', '// local current body', '{}', NULL, 'runtime_action',
         7.0, 2.0, 0.78, 0.6, 0.0, 0, 'admitted', NULL,
         '2026-05-24T00:00:00.000Z', '2026-05-24T00:00:00.000Z')`,
      ["local_current"],
    );
    // The release's rename edge: canonical old id → local current id.
    emitEvent(db, {
      kind: "act_artifact_aliased",
      substrate_origin: "substrate_auto",
      payload: { old_id: "canon_old", new_id: "local_current", reason: "release_rename" },
    });

    // Read-side resolution: the OLD canonical id resolves to the local current id.
    expect(resolveArtifactId(db, "canon_old")).toBe("local_current");

    // The current row's accumulated posterior survived (never overwritten by
    // a canonical baseline value).
    const row = db
      .query<{ posterior_alpha: number; posterior_beta: number; score: number }, [string]>(
        `SELECT posterior_alpha, posterior_beta, score FROM act_artifact WHERE id = ?`,
      )
      .get(resolveArtifactId(db, "canon_old"));
    expect(row?.posterior_alpha).toBe(7.0);
    expect(row?.posterior_beta).toBe(2.0);
    expect(row?.score).toBeCloseTo(0.78, 5);

    // No phantom row was created for the old canonical id.
    const phantom = (db
      .query<{ c: number }, [string]>(`SELECT COUNT(*) AS c FROM act_artifact WHERE id = ?`)
      .get("canon_old"))?.c ?? 0;
    expect(phantom).toBe(0);
  });
});

describe("resolveAliasChain", () => {
  test("returns id unchanged when no alias exists", () => {
    const db = openDb(":memory:");
    expect(resolveAliasChain(db, "predicate_foo_v1")).toBe("predicate_foo_v1");
  });

  test("follows single alias to new_id", () => {
    const db = openDb(":memory:");
    emitEvent(db, {
      kind: "act_artifact_aliased",
      substrate_origin: "substrate_auto",
      payload: {
        old_id: "predicate_owner_state_estimator_v1",
        new_id: "predicate_continual_owner_state_v1",
        reason: "S0_replan_8tier_decomposition",
      },
    });
    expect(resolveAliasChain(db, "predicate_owner_state_estimator_v1")).toBe(
      "predicate_continual_owner_state_v1",
    );
  });

  test("follows multi-step alias chain to terminal new_id", () => {
    const db = openDb(":memory:");
    emitEvent(db, {
      kind: "act_artifact_aliased",
      substrate_origin: "substrate_auto",
      payload: { old_id: "A", new_id: "B", reason: "step_1" },
    });
    emitEvent(db, {
      kind: "act_artifact_aliased",
      substrate_origin: "substrate_auto",
      payload: { old_id: "B", new_id: "C", reason: "step_2" },
    });
    emitEvent(db, {
      kind: "act_artifact_aliased",
      substrate_origin: "substrate_auto",
      payload: { old_id: "C", new_id: "D", reason: "step_3" },
    });
    expect(resolveAliasChain(db, "A")).toBe("D");
    expect(resolveAliasChain(db, "B")).toBe("D");
    expect(resolveAliasChain(db, "C")).toBe("D");
    expect(resolveAliasChain(db, "D")).toBe("D");
  });

  test("cycle is refused (returns last non-cycle id, doesn't throw)", () => {
    const db = openDb(":memory:");
    emitEvent(db, {
      kind: "act_artifact_aliased",
      substrate_origin: "substrate_auto",
      payload: { old_id: "X", new_id: "Y", reason: "step_1" },
    });
    emitEvent(db, {
      kind: "act_artifact_aliased",
      substrate_origin: "substrate_auto",
      payload: { old_id: "Y", new_id: "X", reason: "cycle_attempt" },
    });
    const result = resolveAliasChain(db, "X");
    // Cycle refused — function returns one of {X, Y} without infinite loop.
    expect(["X", "Y"]).toContain(result);
  });
});
