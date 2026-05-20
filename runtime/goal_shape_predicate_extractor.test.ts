// Tier-S5 goal-shape predicate extractor tests — proves the bounded
// extractor admits one act_artifact{kind:goal_shape_strategy_predicate}
// row per distinct goal_shape with sample_count >= 5, refreshes on
// re-run without duplicating rows, skips below-threshold and empty
// goal_shape strings, and computes the effective_score as
// (1 - mean_residual) * (1 - normalized_std_residual).

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { extractGoalShapePredicates } from "./goal_shape_predicate_extractor";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const newId = (): string =>
  crypto.randomUUID().replace(/-/g, "").slice(0, 26).toUpperCase();

const _baseTs = Date.now();
let _tsCounter = 0;
const tickTs = (): string => {
  _tsCounter += 1;
  return new Date(_baseTs + _tsCounter * 1000).toISOString();
};

const insertScoreUpdated = (
  db: ReturnType<typeof openDb>,
  fields: {
    goal_shape: string;
    residual: number;
    ts?: string;
  },
): string => {
  const id = newId();
  db.run(
    `INSERT INTO events (
       id, ts, directive_id, task_id, loop_id, substrate_origin, kind,
       payload, context_refs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      fields.ts ?? tickTs(),
      "d_test",
      "t_test",
      "l_test",
      "substrate_auto",
      "act_artifact_score_updated",
      JSON.stringify({
        artifact_id: `art_${id.slice(0, 8)}`,
        role: "action",
        residual: fields.residual,
        weight: 1,
        score: 0.5,
        confidence: 0.5,
        scored_event_id: newId(),
        goal_shape: fields.goal_shape,
      }),
      JSON.stringify([]),
    ],
  );
  return id;
};

const countPredicateRows = (db: ReturnType<typeof openDb>): number =>
  (db
    .query(`SELECT COUNT(*) AS n FROM act_artifact WHERE kind = 'goal_shape_strategy_predicate'`)
    .get() as { n: number }).n;

const readPredicateRow = (
  db: ReturnType<typeof openDb>,
  goalShape: string,
): {
  id: string;
  body: string;
  posterior_alpha: number;
  posterior_beta: number;
  score: number;
  confidence: number;
  created_at: string;
  updated_at: string;
} | null => {
  const row = db
    .query(
      `SELECT id, body, posterior_alpha, posterior_beta, score, confidence, created_at, updated_at
         FROM act_artifact
        WHERE kind = 'goal_shape_strategy_predicate' AND name = ?
        LIMIT 1`,
    )
    .get(goalShape) as
    | {
        id: string;
        body: string;
        posterior_alpha: number;
        posterior_beta: number;
        score: number;
        confidence: number;
        created_at: string;
        updated_at: string;
      }
    | null;
  return row;
};

describe("extractGoalShapePredicates", () => {
  test("goal_shape with 5 low-residual acts → admitted with high effective_score", async () => {
    const db = openDb(":memory:");
    // All residuals near 0 — perfect outcomes. Variance ≈ 0.
    for (const r of [0.05, 0.05, 0.05, 0.05, 0.05]) {
      insertScoreUpdated(db, { goal_shape: "shape_alpha", residual: r });
    }

    const summary = await extractGoalShapePredicates(db);
    expect(summary.scanned).toBe(5);
    expect(summary.distinct_shapes).toBe(1);
    expect(summary.rows_admitted).toBe(1);
    expect(summary.rows_updated).toBe(0);
    expect(summary.skipped_below_threshold).toBe(0);

    expect(countPredicateRows(db)).toBe(1);
    const row = readPredicateRow(db, "shape_alpha");
    expect(row).not.toBeNull();
    const body = JSON.parse(row!.body) as Record<string, number>;
    expect(body.sample_count).toBe(5);
    expect(body.mean_residual).toBeCloseTo(0.05, 8);
    expect(body.std_residual).toBeCloseTo(0, 8);
    // effective_score = (1 - 0.05) * (1 - 0) = 0.95
    expect(body.effective_score).toBeCloseTo(0.95, 6);
    expect(row!.score).toBeCloseTo(0.95, 6);
    // Posterior calibrated by sample_count: α = 1 + 0.95 * 5 = 5.75,
    // β = 1 + 0.05 * 5 = 1.25 → mean = α/(α+β) ≈ 0.821 (this is the
    // Beta mean, distinct from `score` which is the raw
    // effective_score). The test asserts the raw α and β values to
    // pin the calibration formula.
    expect(row!.posterior_alpha).toBeCloseTo(1 + 0.95 * 5, 6);
    expect(row!.posterior_beta).toBeCloseTo(1 + 0.05 * 5, 6);
  });

  test("goal_shape with high-variance residuals → admitted with low effective_score", async () => {
    const db = openDb(":memory:");
    // Residuals span the full [0,1] range — high variance → tag does
    // not predict outcome → effective_score should drop sharply.
    for (const r of [0.0, 0.25, 0.5, 0.75, 1.0]) {
      insertScoreUpdated(db, { goal_shape: "shape_chaos", residual: r });
    }

    const summary = await extractGoalShapePredicates(db);
    expect(summary.rows_admitted).toBe(1);

    const row = readPredicateRow(db, "shape_chaos");
    expect(row).not.toBeNull();
    const body = JSON.parse(row!.body) as Record<string, number>;
    expect(body.sample_count).toBe(5);
    expect(body.mean_residual).toBeCloseTo(0.5, 8);
    // Population std of [0, 0.25, 0.5, 0.75, 1.0] = sqrt(0.125) ≈ 0.3536
    expect(body.std_residual).toBeCloseTo(Math.sqrt(0.125), 6);
    // effective_score = (1 - 0.5) * (1 - 0.3536) ≈ 0.5 * 0.6464 ≈ 0.323
    const expected = (1 - 0.5) * (1 - Math.sqrt(0.125));
    expect(body.effective_score).toBeCloseTo(expected, 6);
    // High-variance score must be substantially lower than the
    // low-variance baseline (0.95).
    expect(body.effective_score).toBeLessThan(0.5);
  });

  test("goal_shape with only 3 samples → NOT admitted (below threshold)", async () => {
    const db = openDb(":memory:");
    for (const r of [0.1, 0.1, 0.1]) {
      insertScoreUpdated(db, { goal_shape: "shape_thin", residual: r });
    }

    const summary = await extractGoalShapePredicates(db);
    expect(summary.scanned).toBe(3);
    expect(summary.distinct_shapes).toBe(1);
    expect(summary.rows_admitted).toBe(0);
    expect(summary.rows_updated).toBe(0);
    expect(summary.skipped_below_threshold).toBe(1);
    expect(countPredicateRows(db)).toBe(0);
  });

  test("re-run updates posterior without duplicating row (idempotent)", async () => {
    const db = openDb(":memory:");
    for (const r of [0.1, 0.1, 0.1, 0.1, 0.1]) {
      insertScoreUpdated(db, { goal_shape: "shape_beta", residual: r });
    }

    const first = await extractGoalShapePredicates(db);
    expect(first.rows_admitted).toBe(1);
    expect(first.rows_updated).toBe(0);
    expect(countPredicateRows(db)).toBe(1);

    const originalRow = readPredicateRow(db, "shape_beta");
    expect(originalRow).not.toBeNull();
    const originalCreatedAt = originalRow!.created_at;

    // Insert two more acts under the same shape — residuals shift the
    // mean. Re-run must UPDATE the existing row (not INSERT a duplicate),
    // refresh sample_count + metrics + posterior, and preserve
    // created_at.
    insertScoreUpdated(db, { goal_shape: "shape_beta", residual: 0.4 });
    insertScoreUpdated(db, { goal_shape: "shape_beta", residual: 0.4 });

    const second = await extractGoalShapePredicates(db);
    expect(second.rows_admitted).toBe(0);
    expect(second.rows_updated).toBe(1);
    expect(countPredicateRows(db)).toBe(1);

    const updatedRow = readPredicateRow(db, "shape_beta");
    expect(updatedRow).not.toBeNull();
    expect(updatedRow!.id).toBe(originalRow!.id);
    expect(updatedRow!.created_at).toBe(originalCreatedAt);
    const updatedBody = JSON.parse(updatedRow!.body) as Record<string, number>;
    expect(updatedBody.sample_count).toBe(7);
    // mean shifted upward from 0.1 toward (5*0.1 + 2*0.4)/7 ≈ 0.186
    expect(updatedBody.mean_residual).toBeCloseTo((5 * 0.1 + 2 * 0.4) / 7, 6);
  });

  test("empty goal_shape string → skipped silently", async () => {
    const db = openDb(":memory:");
    for (const r of [0.1, 0.1, 0.1, 0.1, 0.1]) {
      insertScoreUpdated(db, { goal_shape: "", residual: r });
    }
    // Mix in a single valid shape with only 1 sample — below threshold,
    // also not admitted but counted as a distinct shape (the empty
    // string is skipped before grouping, the valid shape is grouped
    // then skipped at the threshold gate).
    insertScoreUpdated(db, { goal_shape: "shape_one", residual: 0.1 });

    const summary = await extractGoalShapePredicates(db);
    expect(summary.scanned).toBe(6);
    expect(summary.skipped_empty_shape).toBe(5);
    // Only the non-empty shape entered the grouping map.
    expect(summary.distinct_shapes).toBe(1);
    expect(summary.rows_admitted).toBe(0);
    expect(countPredicateRows(db)).toBe(0);
  });
});
