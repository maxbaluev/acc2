// substrate/migrations runner tests per docs/Architecture.md.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "./db";
import { emitEvent } from "../runtime/events";
import { runVersionedMigrations, resolveAliasChain } from "./migration_runner";

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
