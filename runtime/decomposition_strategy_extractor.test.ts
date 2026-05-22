// Tier-S1 decomposition-strategy extractor tests — proves the bounded
// extractor admits one act_artifact{kind:decomposition_strategy_predicate}
// row per shape_category that meets the 5-sample threshold, is
// idempotent across reruns (UPDATE not duplicate INSERT, preserve
// created_at), processes the > YIELD_EVERY_N=25 directives without
// early exit, and pins the back-compat surface of categorizeShape /
// categorizeShapeWithContributors / SHOULD_DECOMPOSE_PREDICATE_ARTIFACT
// against the post-1c1a52c (brain S1 ShapeCategory redesign) shape.
//
// Brain KCs that flagged the missing-test gap (Rank 3 priority):
//   KW2EMYV5DN1N, WYJJ3HRPJD7Q, ZSY1BXRSCX1Z, MMS2NESXEX13, E2GVQZWTNX75.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import {
  SHOULD_DECOMPOSE_PREDICATE_ARTIFACT,
  categorizeGoalShapeSemantic,
  categorizeShape,
  categorizeShapeWithContributors,
  extractDecompositionStrategy,
} from "./decomposition_strategy_extractor";

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

const insertEvent = (
  db: ReturnType<typeof openDb>,
  fields: {
    kind: string;
    directive_id?: string;
    task_id?: string;
    parent_task_id?: string | null;
    loop_id?: string;
    substrate_origin?: string;
    payload?: unknown;
    context_refs?: string[];
    ts?: string;
  },
): string => {
  const id = newId();
  db.run(
    `INSERT INTO events (
       id, ts, directive_id, task_id, parent_task_id, loop_id,
       substrate_origin, kind, payload, context_refs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      fields.ts ?? tickTs(),
      fields.directive_id ?? "d_test",
      fields.task_id ?? "t_test",
      fields.parent_task_id ?? null,
      fields.loop_id ?? "l_test",
      fields.substrate_origin ?? "substrate_auto",
      fields.kind,
      JSON.stringify(fields.payload ?? {}),
      JSON.stringify(fields.context_refs ?? []),
    ],
  );
  return id;
};

// Helper: seed a directive whose DAG fingerprint resolves to a known
// shape_category. The default fingerprint (fan_out=5, max_depth=2,
// total_nodes=6 — five sibling children under no parent) bucketizes to
// "audit_evidence_sweep" via the `fan_out >= 4 && max_depth <= 3` rule
// because no goal_class evidence is wired through closure_payload yet.
const seedAuditSweepDirective = (
  db: ReturnType<typeof openDb>,
  directiveId: string,
  closureResidual: number,
): void => {
  // Five sibling task_nodes (no parent_task_id, no refines edge) →
  // fan_out = 5, max_depth = 1, total_nodes = 5.
  for (let i = 0; i < 5; i += 1) {
    insertEvent(db, {
      kind: "task_node_opened",
      directive_id: directiveId,
      task_id: `${directiveId}_child_${i}`,
    });
  }
  // One closure event with the declared residual.
  insertEvent(db, {
    kind: "task_closure_audited",
    directive_id: directiveId,
    task_id: directiveId,
    payload: { closure_residual: closureResidual },
  });
};

const countPredicateRows = (db: ReturnType<typeof openDb>): number =>
  (db
    .query(
      `SELECT COUNT(*) AS n FROM act_artifact
       WHERE kind = 'decomposition_strategy_predicate'`,
    )
    .get() as { n: number }).n;

const readPredicateRow = (
  db: ReturnType<typeof openDb>,
  shapeCategory: string,
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
  return db
    .query(
      `SELECT id, body, posterior_alpha, posterior_beta, score, confidence,
              created_at, updated_at
         FROM act_artifact
        WHERE kind = 'decomposition_strategy_predicate' AND name = ?
        LIMIT 1`,
    )
    .get(shapeCategory) as
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
};

describe("categorizeShape (back-compat surface)", () => {
  test("total_nodes <= 1 → inline_atomic", () => {
    expect(categorizeShape(0, 0, 0)).toBe("inline_atomic");
    expect(categorizeShape(1, 1, 1)).toBe("inline_atomic");
  });

  test("wide-shallow geometry (fan_out >= 4, max_depth <= 3) → audit_evidence_sweep", () => {
    expect(categorizeShape(5, 2, 6)).toBe("audit_evidence_sweep");
    expect(categorizeShape(4, 1, 5)).toBe("audit_evidence_sweep");
  });

  test("deep geometry (max_depth >= 4) with no other signal → migrate_dependency_chain", () => {
    // fan_out=2 keeps it OUT of the audit branch and the build branch.
    expect(categorizeShape(2, 5, 10)).toBe("migrate_dependency_chain");
  });

  test("moderate fan-out (fan_out >= 3) with no other signal → explore_research_fanout", () => {
    // total_nodes > 1, fan_out = 3, max_depth = 2 — skips audit (need
    // fan_out >= 4 OR goal_audit), skips build/migrate/refactor (no
    // goal_class evidence, max_depth < 4), lands on explore.
    expect(categorizeShape(3, 2, 4)).toBe("explore_research_fanout");
  });

  test("low-fanout shallow geometry → mixed_strategy", () => {
    // total_nodes > 1 but every conditional bails — falls through.
    expect(categorizeShape(1, 1, 2)).toBe("mixed_strategy");
    expect(categorizeShape(2, 2, 3)).toBe("mixed_strategy");
  });

  test("deterministic: same input → same output across calls", () => {
    const a = categorizeShape(4, 2, 7);
    const b = categorizeShape(4, 2, 7);
    const c = categorizeShape(4, 2, 7);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});

describe("categorizeGoalShapeSemantic (pre-decomposition retrieval-binding map)", () => {
  test("maps goal text to the same semantic shape_category the extractor credits", () => {
    // These goal_class branches mirror categorizeShapeWithContributors's
    // semantic half so the advisory section binds the right scored row.
    expect(categorizeGoalShapeSemantic("Audit the dispatch pipeline")).toBe("audit_evidence_sweep");
    expect(categorizeGoalShapeSemantic("Build the parallel bundle")).toBe("build_parallel_bundle");
    expect(categorizeGoalShapeSemantic("Migrate the schema")).toBe("migrate_dependency_chain");
    expect(categorizeGoalShapeSemantic("Refactor the worker")).toBe("refactor_change_bundle");
    expect(categorizeGoalShapeSemantic("Synthesize the findings")).toBe("synthesize_adjudication");
    expect(categorizeGoalShapeSemantic("Explore the failure modes")).toBe("explore_research_fanout");
    expect(categorizeGoalShapeSemantic("Research the bridge")).toBe("explore_research_fanout");
  });

  test("owner/recovery/rolling/adjudication evidence wins over goal_class words", () => {
    expect(categorizeGoalShapeSemantic("Audit X", { owner_gate_count: 1 })).toBe("owner_gated_decision_tree");
    expect(categorizeGoalShapeSemantic("Audit X", { recovery_signal: 1 })).toBe("operational_recovery");
    expect(categorizeGoalShapeSemantic("Audit X", { rolling_signal: 1 })).toBe("rolling_maintenance");
    expect(categorizeGoalShapeSemantic("Audit X", { adjudication_signal: 1 })).toBe("synthesize_adjudication");
  });

  test("returns null when no semantic signal fires (don't guess a geometry bucket pre-decomposition)", () => {
    expect(categorizeGoalShapeSemantic("do the thing")).toBeNull();
    expect(categorizeGoalShapeSemantic("")).toBeNull();
  });
});

describe("categorizeShapeWithContributors", () => {
  test("returns shape_category + top_contributing_axes + contribution_scores", () => {
    const decision = categorizeShapeWithContributors(5, 2, 6);
    expect(typeof decision.shape_category).toBe("string");
    expect(Array.isArray(decision.top_contributing_axes)).toBe(true);
    expect(typeof decision.contribution_scores).toBe("object");
  });

  test("top_contributing_axes has at most 3 entries", () => {
    const decision = categorizeShapeWithContributors(6, 6, 15, {
      goal_class: "audit",
      target_resources: ["repo:a", "repo:b", "repo:c", "repo:d"],
      owner_gate_count: 1,
      recovery_signal: 1,
      rolling_signal: 1,
      adjudication_signal: 1,
    });
    expect(decision.top_contributing_axes.length).toBeLessThanOrEqual(3);
  });

  test("all contribution_scores values are clamped to [0, 1]", () => {
    // Pathological inputs that would otherwise blow past 1.0 — clamp01
    // must collapse them. fan_out=100 → fanout_parallelism would be
    // 100/6 ≈ 16.7 without clamp; with clamp it's 1.
    const decision = categorizeShapeWithContributors(100, 100, 500, {
      goal_class: "audit",
      target_resources: ["repo:a", "repo:b", "repo:c", "repo:d", "repo:e"],
      owner_gate_count: 5,
      recovery_signal: 10,
      rolling_signal: 10,
      adjudication_signal: 10,
    });
    for (const [, v] of Object.entries(decision.contribution_scores)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  test("goal_class=audit → category contains audit signal", () => {
    const decision = categorizeShapeWithContributors(2, 2, 4, {
      goal_class: "audit",
    });
    expect(decision.shape_category).toBe("audit_evidence_sweep");
    // goal_audit is one of the contributors — should appear in scores
    // map at 1 and likely in top_contributing_axes.
    expect(decision.contribution_scores.goal_audit).toBe(1);
  });

  test("owner_gate_count > 0 → owner_gated_decision_tree (highest priority bucket)", () => {
    const decision = categorizeShapeWithContributors(5, 2, 6, {
      goal_class: "audit",
      owner_gate_count: 1,
    });
    // Owner gate overrides goal_class=audit per the categorize cascade.
    expect(decision.shape_category).toBe("owner_gated_decision_tree");
  });

  test("recovery_signal > 0 → operational_recovery", () => {
    const decision = categorizeShapeWithContributors(2, 2, 4, {
      recovery_signal: 1,
    });
    expect(decision.shape_category).toBe("operational_recovery");
  });

  test("goal_class=synthesize → synthesize_adjudication", () => {
    const decision = categorizeShapeWithContributors(2, 2, 4, {
      goal_class: "synthesize",
    });
    expect(decision.shape_category).toBe("synthesize_adjudication");
  });
});

describe("SHOULD_DECOMPOSE_PREDICATE_ARTIFACT (exported constant shape)", () => {
  test("kind is should_decompose_predicate", () => {
    expect(SHOULD_DECOMPOSE_PREDICATE_ARTIFACT.kind).toBe("should_decompose_predicate");
  });

  test("score_inputs is a non-empty array with expected leverage + overhead axes", () => {
    expect(Array.isArray(SHOULD_DECOMPOSE_PREDICATE_ARTIFACT.score_inputs)).toBe(true);
    expect(SHOULD_DECOMPOSE_PREDICATE_ARTIFACT.score_inputs.length).toBeGreaterThan(0);
    // Specific axes that the brain S1 redesign pinned.
    expect(SHOULD_DECOMPOSE_PREDICATE_ARTIFACT.score_inputs).toContain(
      "expected_residual_reduction",
    );
    expect(SHOULD_DECOMPOSE_PREDICATE_ARTIFACT.score_inputs).toContain("coordination_overhead");
  });

  test("decision_rule is leverage_score_minus_overhead_score_gt_0", () => {
    expect(SHOULD_DECOMPOSE_PREDICATE_ARTIFACT.decision_rule).toBe(
      "leverage_score_minus_overhead_score_gt_0",
    );
  });

  test("posterior_seed has uniform Beta(1, 1) prior, score 0.5, confidence in [0, 1]", () => {
    const seed = SHOULD_DECOMPOSE_PREDICATE_ARTIFACT.posterior_seed;
    expect(typeof seed.alpha).toBe("number");
    expect(typeof seed.beta).toBe("number");
    expect(typeof seed.score).toBe("number");
    expect(typeof seed.confidence).toBe("number");
    expect(seed.alpha).toBe(1);
    expect(seed.beta).toBe(1);
    expect(seed.score).toBe(0.5);
    expect(seed.confidence).toBeGreaterThanOrEqual(0);
    expect(seed.confidence).toBeLessThanOrEqual(1);
  });
});

describe("extractDecompositionStrategy", () => {
  test("five audit-sweep directives admit one predicate row with the correct metrics", async () => {
    const db = openDb(":memory:");
    // Five directives, each with the same DAG shape (fan_out=5, depth=1,
    // total_nodes=5) and varying closure residuals.
    const residuals = [0.1, 0.2, 0.15, 0.25, 0.3];
    for (let i = 0; i < residuals.length; i += 1) {
      seedAuditSweepDirective(db, `d_audit_${i}`, residuals[i]);
    }

    const summary = await extractDecompositionStrategy(db);
    expect(summary.directives_scanned).toBe(5);
    expect(summary.shapes_seen).toBe(1);
    expect(summary.rows_admitted).toBe(1);
    expect(summary.rows_updated).toBe(0);
    expect(summary.skipped_below_threshold).toBe(0);

    expect(countPredicateRows(db)).toBe(1);
    const row = readPredicateRow(db, "audit_evidence_sweep");
    expect(row).not.toBeNull();
    const body = JSON.parse(row!.body) as Record<string, unknown>;
    expect(body.shape_category).toBe("audit_evidence_sweep");
    expect(body.sample_count).toBe(5);
    const meanResidual = residuals.reduce((s, r) => s + r, 0) / residuals.length;
    expect(body.mean_residual as number).toBeCloseTo(meanResidual, 8);
    // effective_score = (1 - mean) * (1 - normalized_std). Pin its range:
    // residuals stay below 1 so it must be positive and < 1.
    expect(body.effective_score as number).toBeGreaterThan(0);
    expect(body.effective_score as number).toBeLessThan(1);
    // avg_fan_out = 5 (each directive has 5 root-level siblings).
    expect(body.avg_fan_out as number).toBeCloseTo(5, 6);
  });

  test("four directives → below 5-sample threshold, no row admitted", async () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 4; i += 1) {
      seedAuditSweepDirective(db, `d_thin_${i}`, 0.2);
    }
    const summary = await extractDecompositionStrategy(db);
    expect(summary.directives_scanned).toBe(4);
    expect(summary.shapes_seen).toBe(1);
    expect(summary.rows_admitted).toBe(0);
    expect(summary.skipped_below_threshold).toBe(1);
    expect(countPredicateRows(db)).toBe(0);
  });

  test("re-running on the same events is idempotent (UPDATE existing row, preserve created_at)", async () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 5; i += 1) {
      seedAuditSweepDirective(db, `d_idem_${i}`, 0.2);
    }
    const first = await extractDecompositionStrategy(db);
    expect(first.rows_admitted).toBe(1);
    expect(countPredicateRows(db)).toBe(1);

    const originalRow = readPredicateRow(db, "audit_evidence_sweep");
    expect(originalRow).not.toBeNull();
    const originalCreatedAt = originalRow!.created_at;
    const originalId = originalRow!.id;

    // Re-run with the same events — must UPDATE not INSERT a duplicate.
    const second = await extractDecompositionStrategy(db);
    expect(second.rows_admitted).toBe(0);
    expect(second.rows_updated).toBe(1);
    expect(countPredicateRows(db)).toBe(1);

    const updatedRow = readPredicateRow(db, "audit_evidence_sweep");
    expect(updatedRow).not.toBeNull();
    expect(updatedRow!.id).toBe(originalId);
    expect(updatedRow!.created_at).toBe(originalCreatedAt);
  });

  test("processes more than YIELD_EVERY_N (25) directives without early exit", async () => {
    const db = openDb(":memory:");
    // Seed 30 audit-sweep directives — exceeds the 25-row yield boundary.
    // The extractor must scan ALL 30 and admit one predicate row.
    for (let i = 0; i < 30; i += 1) {
      seedAuditSweepDirective(db, `d_yield_${i}`, 0.15 + (i % 5) * 0.05);
    }
    const summary = await extractDecompositionStrategy(db);
    expect(summary.directives_scanned).toBe(30);
    expect(summary.rows_admitted).toBe(1);

    const row = readPredicateRow(db, "audit_evidence_sweep");
    expect(row).not.toBeNull();
    const body = JSON.parse(row!.body) as Record<string, unknown>;
    expect(body.sample_count).toBe(30);
  });

  test("directives without task_node_opened events are skipped (no fingerprint)", async () => {
    const db = openDb(":memory:");
    // Closure-audited but no task_node rows → total_nodes=0 → skipped.
    insertEvent(db, {
      kind: "task_closure_audited",
      directive_id: "d_empty",
      payload: { closure_residual: 0.2 },
    });
    const summary = await extractDecompositionStrategy(db);
    expect(summary.directives_scanned).toBe(0);
    expect(summary.rows_admitted).toBe(0);
    expect(countPredicateRows(db)).toBe(0);
  });

  test("emits one decomposition_strategy_observed event per admitted shape", async () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 5; i += 1) {
      seedAuditSweepDirective(db, `d_obs_${i}`, 0.2);
    }
    await extractDecompositionStrategy(db);
    const observations = (db
      .query(
        `SELECT COUNT(*) AS n FROM events
         WHERE kind = 'decomposition_strategy_observed'`,
      )
      .get() as { n: number }).n;
    expect(observations).toBeGreaterThanOrEqual(1);
  });
});
