// acc2 T2.1 — universal threshold registry tests. Covers cold-start
// default fallback, admitted-row read, cache TTL behavior, manual
// invalidation, seedThresholdPredicate insert + invalidation, and
// multi-row highest-score winner.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { nowIso } from "./ids";
import type { Database } from "bun:sqlite";
import {
  getThreshold,
  invalidateThresholdCache,
  seedThresholdPredicate,
} from "./threshold_registry";

afterAll(() => closeDb());
beforeEach(() => {
  closeDb();
  invalidateThresholdCache();
});

const insertRawThresholdRow = (
  db: Database,
  args: {
    id: string;
    name: string;
    value: number;
    score?: number;
    status?: string;
  },
): void => {
  const ts = nowIso();
  db.run(
    `INSERT INTO act_artifact (
       id, runtime, body, declared_sandbox, state_root, kind,
       posterior_alpha, posterior_beta, score, confidence,
       recent_residual_mean, recent_kill_count, status, name,
       fixture_input, fixture_expected_residual,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      args.id,
      "bun",
      JSON.stringify({ value: args.value }),
      JSON.stringify({ runtime: "bun", cpu_ms: 100, wall_ms: 1000, memory_mb: 8 }),
      `substrate/threshold/${args.name}`,
      "threshold_predicate",
      1.0, 1.0, args.score ?? 0.5, 0.5,
      0.0, 0, args.status ?? "admitted", args.name,
      JSON.stringify(null), 0.5,
      ts, ts,
    ],
  );
};

describe("threshold_registry — cold-start safety", () => {
  test("returns hardcoded default when no row exists", () => {
    const db = openDb(":memory:");
    const v = getThreshold(db, "novelty_bonus_multiplier", 1.5);
    expect(v).toBe(1.5);
  });

  test("returns row.body.value when admitted threshold_predicate row exists", () => {
    const db = openDb(":memory:");
    insertRawThresholdRow(db, {
      id: "threshold_test_one",
      name: "test_one",
      value: 2.7,
      score: 0.9,
    });
    const v = getThreshold(db, "test_one", 1.0);
    expect(v).toBe(2.7);
  });

  test("ignores non-admitted rows (e.g., quarantined)", () => {
    const db = openDb(":memory:");
    insertRawThresholdRow(db, {
      id: "threshold_quarantined",
      name: "quarantined_one",
      value: 9.9,
      score: 0.95,
      status: "quarantined",
    });
    const v = getThreshold(db, "quarantined_one", 1.0);
    expect(v).toBe(1.0); // fallback default
  });

  test("returns promoted-row value", () => {
    const db = openDb(":memory:");
    insertRawThresholdRow(db, {
      id: "threshold_promo",
      name: "promo_one",
      value: 3.14,
      score: 0.8,
      status: "promoted",
    });
    const v = getThreshold(db, "promo_one", 0.1);
    expect(v).toBe(3.14);
  });
});

describe("threshold_registry — caching", () => {
  test("cache returns cached value within TTL even if row changes", () => {
    const db = openDb(":memory:");
    insertRawThresholdRow(db, {
      id: "threshold_cached",
      name: "cached_one",
      value: 1.1,
      score: 0.7,
    });
    const first = getThreshold(db, "cached_one", 99.0);
    expect(first).toBe(1.1);

    // Mutate the underlying row's body.
    db.run(
      `UPDATE act_artifact SET body = ? WHERE id = ?`,
      [JSON.stringify({ value: 8.8 }), "threshold_cached"],
    );
    const second = getThreshold(db, "cached_one", 99.0);
    expect(second).toBe(1.1); // cache wins
  });

  test("invalidateThresholdCache forces re-read", () => {
    const db = openDb(":memory:");
    insertRawThresholdRow(db, {
      id: "threshold_inv",
      name: "inv_one",
      value: 2.2,
      score: 0.7,
    });
    const first = getThreshold(db, "inv_one", 0.0);
    expect(first).toBe(2.2);

    db.run(
      `UPDATE act_artifact SET body = ? WHERE id = ?`,
      [JSON.stringify({ value: 5.5 }), "threshold_inv"],
    );
    invalidateThresholdCache("inv_one");
    const second = getThreshold(db, "inv_one", 0.0);
    expect(second).toBe(5.5);
  });

  test("invalidateThresholdCache() with no arg clears all", () => {
    const db = openDb(":memory:");
    insertRawThresholdRow(db, { id: "a", name: "name_a", value: 1.1, score: 0.7 });
    insertRawThresholdRow(db, { id: "b", name: "name_b", value: 2.2, score: 0.7 });
    expect(getThreshold(db, "name_a", 0.0)).toBe(1.1);
    expect(getThreshold(db, "name_b", 0.0)).toBe(2.2);
    db.run(`UPDATE act_artifact SET body = ? WHERE id = ?`, [JSON.stringify({ value: 9.9 }), "a"]);
    db.run(`UPDATE act_artifact SET body = ? WHERE id = ?`, [JSON.stringify({ value: 8.8 }), "b"]);
    invalidateThresholdCache();
    expect(getThreshold(db, "name_a", 0.0)).toBe(9.9);
    expect(getThreshold(db, "name_b", 0.0)).toBe(8.8);
  });
});

describe("threshold_registry — seedThresholdPredicate", () => {
  test("inserts a row, invalidates cache, subsequent getThreshold returns new value", () => {
    const db = openDb(":memory:");
    // Cold start: default wins, caches default.
    expect(getThreshold(db, "seed_one", 1.5)).toBe(1.5);

    // Seed inserts a new admitted row with value 2.5.
    seedThresholdPredicate(db, "seed_one", 2.5);

    // Without invalidate, the cached 1.5 would persist; seed invalidates,
    // so a subsequent read picks up the new row.
    expect(getThreshold(db, "seed_one", 1.5)).toBe(2.5);
  });

  test("idempotent — second seed call does not overwrite the first row", () => {
    const db = openDb(":memory:");
    seedThresholdPredicate(db, "idem_one", 2.5);
    expect(getThreshold(db, "idem_one", 0.0)).toBe(2.5);

    // Second seed with a different value should be a no-op.
    seedThresholdPredicate(db, "idem_one", 9.9);
    expect(getThreshold(db, "idem_one", 0.0)).toBe(2.5);

    const rows = db
      .query("SELECT COUNT(*) AS c FROM act_artifact WHERE kind = ? AND name = ?")
      .get("threshold_predicate", "idem_one") as { c: number };
    expect(rows.c).toBe(1);
  });
});

describe("threshold_registry — multi-row tie-breaking", () => {
  test("multiple admitted rows with same name → highest-score wins", () => {
    const db = openDb(":memory:");
    insertRawThresholdRow(db, {
      id: "threshold_low",
      name: "multi_one",
      value: 1.0,
      score: 0.4,
    });
    insertRawThresholdRow(db, {
      id: "threshold_hi",
      name: "multi_one",
      value: 7.7,
      score: 0.95,
    });
    insertRawThresholdRow(db, {
      id: "threshold_mid",
      name: "multi_one",
      value: 4.0,
      score: 0.6,
    });
    const v = getThreshold(db, "multi_one", 0.0);
    expect(v).toBe(7.7);
  });
});

describe("threshold_registry — malformed body fallback", () => {
  test("falls back to default when body has no numeric value field", () => {
    const db = openDb(":memory:");
    db.run(
      `INSERT INTO act_artifact (
         id, runtime, body, declared_sandbox, state_root, kind,
         posterior_alpha, posterior_beta, score, confidence,
         recent_residual_mean, recent_kill_count, status, name,
         fixture_input, fixture_expected_residual,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "threshold_bad",
        "bun",
        JSON.stringify({ no_value_here: "yep" }),
        JSON.stringify({ runtime: "bun", cpu_ms: 100, wall_ms: 1000, memory_mb: 8 }),
        "substrate/threshold/bad_one",
        "threshold_predicate",
        1.0, 1.0, 0.9, 0.5,
        0.0, 0, "admitted", "bad_one",
        JSON.stringify(null), 0.5,
        nowIso(), nowIso(),
      ],
    );
    const v = getThreshold(db, "bad_one", 4.2);
    expect(v).toBe(4.2);
  });
});
