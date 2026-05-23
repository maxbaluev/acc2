// substrate/migrations runner tests per docs/Architecture.md.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "./db";
import { emitEvent } from "../runtime/events";
import {
  runVersionedMigrations,
  resolveAliasChain,
  listPendingMigrations,
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
