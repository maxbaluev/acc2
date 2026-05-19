// acc2 recipe inertia decay tests — Layer-2 SMART axis closure (brain audit
// QQEHAW97GS0AX7TEQ717Y3P174, 2026-05-15).

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { runViews } from "../substrate/views";
import { newId, nowIso } from "./ids";
import {
  applyRecipeInertiaDecay,
  RECIPE_INERTIA_DECAY,
  RECIPE_INERTIA_DECAY_DAYS,
  RECIPE_INERTIA_FLOOR,
} from "./recipe_inertia";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Hand-roll one recipe-shape knowledge row at a controlled ts. Bypasses emitEvent
 *  so we can backdate the row (decay logic uses ts for inertia-age math). */
const insertRecipeRow = (
  db: ReturnType<typeof openDb>,
  opts: {
    id?: string;
    ts: string;
    goalShape: string;
    topology: string;
    confidence: number;
    trajectory?: unknown[];
  },
): string => {
  const id = opts.id ?? newId();
  db.run(
    `INSERT INTO events (id, ts, directive_id, task_id, loop_id, substrate_origin, kind, payload, context_refs)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      opts.ts,
      "d_inertia",
      "t_inertia",
      "loop_root",
      "substrate_auto",
      "knowledge_candidate",
      JSON.stringify({
        recipe_shape: { enabled: true },
          goal_shape: opts.goalShape,
        topology_signature: opts.topology,
        confidence: opts.confidence,
        trajectory: opts.trajectory ?? [],
      }),
      "[]",
    ],
  );
  return id;
};

/** Hand-roll a replay-evidence row (action_predicted with substrate_origin
 *  'recipe' and payload.recipe_id = <id>) at a controlled ts. */
const insertReplayEvidence = (
  db: ReturnType<typeof openDb>,
  recipeId: string,
  ts: string,
): void => {
  db.run(
    `INSERT INTO events (id, ts, directive_id, task_id, loop_id, substrate_origin, kind, payload, context_refs)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId(),
      ts,
      "d_replay",
      "t_replay",
      "loop_root",
      "recipe",
      "action_predicted",
      JSON.stringify({ recipe_id: recipeId }),
      "[]",
    ],
  );
};

describe("recipe_inertia.applyRecipeInertiaDecay", () => {
  test("a 30-day-old recipe with zero replays gets one decay step per call (confidence × 0.95)", () => {
    const db = openDb(":memory:");
    runViews(db);

    const thirtyDaysAgo = new Date(Date.now() - 30 * MS_PER_DAY).toISOString();
    const recipeId = insertRecipeRow(db, {
      ts: thirtyDaysAgo,
      goalShape: "stale_recipe_one::n1",
      topology: "topo_stale_one::1",
      confidence: 0.8,
    });

    const outcome = applyRecipeInertiaDecay(db);
    expect(outcome.scanned).toBe(1);
    expect(outcome.decayed).toBe(1);
    expect(outcome.decayed_recipe_ids).toContain(recipeId);

    // A new recipe-shape knowledge row was emitted with confidence × (1 − 0.05).
    const decayRow = db
      .query(
        `SELECT payload, context_refs FROM events
         WHERE kind = 'knowledge_candidate' AND COALESCE(json_extract(payload, '$.recipe_shape.enabled'), 0) IN (1, 'true')
           AND json_extract(payload, '$.confidence_update') = 'inertia_decayed'
         ORDER BY ts DESC LIMIT 1`,
      )
      .get() as { payload: string; context_refs: string } | null;
    expect(decayRow).not.toBeNull();
    const p = JSON.parse(decayRow!.payload) as Record<string, unknown>;
    expect(p.goal_shape).toBe("stale_recipe_one::n1");
    expect(p.topology_signature).toBe("topo_stale_one::1");
    expect(p.previous_confidence).toBeCloseTo(0.8, 5);
    expect(p.confidence).toBeCloseTo(0.8 * (1 - RECIPE_INERTIA_DECAY), 5);
    expect(p.confidence_update).toBe("inertia_decayed");
    expect(p.derived_from_recipe_id).toBe(recipeId);

    // Cite-back: context_refs points at the prior canonical row.
    const refs = JSON.parse(decayRow!.context_refs) as string[];
    expect(refs).toContain(recipeId);
  });

  test("a fresh recipe (extracted within the inertia window, no replay) is NOT decayed", () => {
    const db = openDb(":memory:");
    runViews(db);

    const oneDayAgo = new Date(Date.now() - 1 * MS_PER_DAY).toISOString();
    insertRecipeRow(db, {
      ts: oneDayAgo,
      goalShape: "fresh_recipe_one::n1",
      topology: "topo_fresh_one::1",
      confidence: 0.8,
    });

    const outcome = applyRecipeInertiaDecay(db);
    expect(outcome.scanned).toBe(1);
    expect(outcome.decayed).toBe(0);
    expect(outcome.skipped_recent_replay).toBe(1);

    const decayRows = db
      .query(
        `SELECT id FROM events
         WHERE kind = 'knowledge_candidate' AND COALESCE(json_extract(payload, '$.recipe_shape.enabled'), 0) IN (1, 'true')
           AND json_extract(payload, '$.confidence_update') = 'inertia_decayed'`,
      )
      .all();
    expect(decayRows.length).toBe(0);
  });

  test("a stale recipe replayed within the inertia window is NOT decayed", () => {
    const db = openDb(":memory:");
    runViews(db);

    const thirtyDaysAgo = new Date(Date.now() - 30 * MS_PER_DAY).toISOString();
    const recipeId = insertRecipeRow(db, {
      ts: thirtyDaysAgo,
      goalShape: "active_recipe_one::n1",
      topology: "topo_active_one::1",
      confidence: 0.8,
    });
    // A replay 1 day ago resets the inactivity clock.
    const oneDayAgo = new Date(Date.now() - 1 * MS_PER_DAY).toISOString();
    insertReplayEvidence(db, recipeId, oneDayAgo);

    const outcome = applyRecipeInertiaDecay(db);
    expect(outcome.scanned).toBe(1);
    expect(outcome.decayed).toBe(0);
    expect(outcome.skipped_recent_replay).toBe(1);
  });

  test("confidence floor: decay never pushes confidence below RECIPE_INERTIA_FLOOR (0.1)", () => {
    const db = openDb(":memory:");
    runViews(db);

    const thirtyDaysAgo = new Date(Date.now() - 30 * MS_PER_DAY).toISOString();
    insertRecipeRow(db, {
      ts: thirtyDaysAgo,
      goalShape: "tiny_recipe_one::n1",
      topology: "topo_tiny_one::1",
      confidence: 0.105,
    });

    const outcome = applyRecipeInertiaDecay(db);
    expect(outcome.decayed).toBe(1);
    const decayRow = db
      .query(
        `SELECT payload FROM events
         WHERE kind = 'knowledge_candidate' AND COALESCE(json_extract(payload, '$.recipe_shape.enabled'), 0) IN (1, 'true')
           AND json_extract(payload, '$.confidence_update') = 'inertia_decayed'
         ORDER BY ts DESC LIMIT 1`,
      )
      .get() as { payload: string };
    const p = JSON.parse(decayRow.payload) as Record<string, number>;
    // 0.105 * 0.95 = 0.09975 → clamped to floor 0.1.
    expect(p.confidence).toBeCloseTo(RECIPE_INERTIA_FLOOR, 5);
  });

  test("already-at-floor: a recipe at 0.1 is skipped and no decay row emitted", () => {
    const db = openDb(":memory:");
    runViews(db);

    const thirtyDaysAgo = new Date(Date.now() - 30 * MS_PER_DAY).toISOString();
    insertRecipeRow(db, {
      ts: thirtyDaysAgo,
      goalShape: "floored_recipe_one::n1",
      topology: "topo_floored_one::1",
      confidence: RECIPE_INERTIA_FLOOR,
    });

    const outcome = applyRecipeInertiaDecay(db);
    expect(outcome.scanned).toBe(1);
    expect(outcome.decayed).toBe(0);
    expect(outcome.skipped_at_floor).toBe(1);
  });

  test("idempotent in the same second: two back-to-back calls decay each recipe ONCE", () => {
    const db = openDb(":memory:");
    runViews(db);

    const thirtyDaysAgo = new Date(Date.now() - 30 * MS_PER_DAY).toISOString();
    insertRecipeRow(db, {
      ts: thirtyDaysAgo,
      goalShape: "idempotent_recipe_one::n1",
      topology: "topo_idem_one::1",
      confidence: 0.8,
    });

    const first = applyRecipeInertiaDecay(db);
    expect(first.decayed).toBe(1);

    const second = applyRecipeInertiaDecay(db);
    // Second call within the same second sees the just-emitted decay row
    // and skips it. The new canonical row is the decayed one (confidence
    // 0.76); inertia still applies (still no replay), but the same-second
    // dedup gate intercepts.
    expect(second.decayed).toBe(0);
    expect(second.skipped_same_second).toBe(1);

    // Exactly ONE decay row in the ledger for this recipe key.
    const count = (db
      .query(
        `SELECT COUNT(*) AS c FROM events
         WHERE kind = 'knowledge_candidate' AND COALESCE(json_extract(payload, '$.recipe_shape.enabled'), 0) IN (1, 'true')
           AND json_extract(payload, '$.confidence_update') = 'inertia_decayed'
           AND json_extract(payload, '$.goal_shape') = 'idempotent_recipe_one::n1'`,
      )
      .get() as { c: number }).c;
    expect(count).toBe(1);
  });

  test("decay configurable via ACC2_RECIPE_INERTIA_DAYS env (default 14)", () => {
    // Sanity that the constant defaults to 14 unless the env was set by
    // the harness — the test runner doesn't pin this, so default applies.
    expect(RECIPE_INERTIA_DECAY_DAYS).toBe(
      Number(process.env.ACC2_RECIPE_INERTIA_DAYS ?? "14"),
    );
  });

  test("scans recipes_latest_view (handles multiple distinct keys per pass)", () => {
    const db = openDb(":memory:");
    runViews(db);

    const thirtyDaysAgo = new Date(Date.now() - 30 * MS_PER_DAY).toISOString();
    insertRecipeRow(db, {
      ts: thirtyDaysAgo,
      goalShape: "multi_one::n1",
      topology: "topo_multi_one::1",
      confidence: 0.8,
    });
    insertRecipeRow(db, {
      ts: thirtyDaysAgo,
      goalShape: "multi_two::n1",
      topology: "topo_multi_two::1",
      confidence: 0.7,
    });
    // A fresh one shouldn't decay.
    insertRecipeRow(db, {
      ts: new Date(Date.now() - 1 * MS_PER_DAY).toISOString(),
      goalShape: "multi_three::n1",
      topology: "topo_multi_three::1",
      confidence: 0.9,
    });

    const outcome = applyRecipeInertiaDecay(db);
    expect(outcome.scanned).toBe(3);
    expect(outcome.decayed).toBe(2);
    expect(outcome.skipped_recent_replay).toBe(1);
  });

  test("preserves the prior trajectory in the decay row so replay still has a payload to walk", () => {
    const db = openDb(":memory:");
    runViews(db);

    const thirtyDaysAgo = new Date(Date.now() - 30 * MS_PER_DAY).toISOString();
    const trajectory = [
      { step_kind: "action_predicted", artifact_id: "a_dummy", payload_template: {} },
    ];
    insertRecipeRow(db, {
      ts: thirtyDaysAgo,
      goalShape: "trajectory_preserved::n1",
      topology: "topo_traj::1",
      confidence: 0.8,
      trajectory,
    });

    applyRecipeInertiaDecay(db);

    const decayRow = db
      .query(
        `SELECT payload FROM events
         WHERE kind = 'knowledge_candidate' AND COALESCE(json_extract(payload, '$.recipe_shape.enabled'), 0) IN (1, 'true')
           AND json_extract(payload, '$.confidence_update') = 'inertia_decayed'
         ORDER BY ts DESC LIMIT 1`,
      )
      .get() as { payload: string };
    const p = JSON.parse(decayRow.payload) as Record<string, unknown>;
    expect(Array.isArray(p.trajectory)).toBe(true);
    expect((p.trajectory as unknown[]).length).toBe(1);
  });

  // Sanity for the unused import elsewhere — keeps `nowIso` referenced so
  // future test additions can use it without a fresh import line.
  void nowIso;
});
