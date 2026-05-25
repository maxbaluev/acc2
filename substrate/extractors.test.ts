// acc2 substrate extractors tests — proves each extractor is
// deterministic, idempotent, and emits the right derived events for
// canonical input shapes.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "./db";
import {
  extractActArtifactScores,
  extractArtifactConsolidation,
  extractClaudeProjectConversations,
  extractCrossCandidateCorroboration,
  extractKnowledgePromotions,
  extractOwnerProfilePromotions,
  extractRecipeCandidates,
  extractRecipeFromCommit,
  extractSemanticDedup,
  maybePromoteOwnerProfile,
} from "./extractors";
import { resolveArtifactId } from "./migration_runner";
import { encodeEmbeddingBlob, EMBEDDING_VERSION, EMBEDDING_DIMS, upsertVecEventRow } from "../runtime/embedder";
import { invalidateThresholdCache, seedThresholdPredicate } from "../runtime/threshold_registry";
import { clearSqlPool, setSqlPool } from "../runtime/sql_pool_singleton";

afterAll(() => closeDb());
beforeEach(() => {
  closeDb();
  // Tier-S4: extractors now read merger thresholds through the universal
  // registry (cached per-process). Invalidate between tests so a seed
  // from a prior test cannot bleed into a fresh in-memory db.
  invalidateThresholdCache();
  // Off-loop read routing: ensure no SQL pool installed by one test bleeds
  // into the next. Tests that want the off-loop path install their own spy
  // pool explicitly and clear it in a finally.
  clearSqlPool();
});

const newId = (): string =>
  crypto.randomUUID().replace(/-/g, "").slice(0, 26).toUpperCase();
const nowIso = (): string => new Date().toISOString();

// tickTs is monotonic anchored to wall-clock now so timestamps stay
// inside extractRecipeCandidates's 30-day window. Each call advances
// by one second from the previous one, guaranteeing strict ordering
// without crossing the cutoff.
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
    loop_id?: string;
    substrate_origin?: string;
    payload?: unknown;
    context_refs?: string[];
    action_artifact_id?: string;
    residual?: number;
    ts?: string;
  },
): string => {
  const id = newId();
  db.run(
    `INSERT INTO events (
       id, ts, directive_id, task_id, loop_id, substrate_origin, kind,
       payload, context_refs, action_artifact_id, residual
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      fields.ts ?? tickTs(),
      fields.directive_id ?? "d_test",
      fields.task_id ?? "t_test",
      fields.loop_id ?? "l_test",
      fields.substrate_origin ?? "claude_root",
      fields.kind,
      JSON.stringify(fields.payload ?? {}),
      JSON.stringify(fields.context_refs ?? []),
      fields.action_artifact_id ?? null,
      fields.residual ?? null,
    ],
  );
  return id;
};

const insertArtifact = (
  db: ReturnType<typeof openDb>,
  id: string,
  body = "// hello world\nexport default async () => 0;",
): void => {
  const ts = nowIso();
  db.run(
    `INSERT INTO act_artifact (
       id, runtime, body, declared_sandbox, state_root,
       posterior_alpha, posterior_beta, score, confidence,
       recent_residual_mean, recent_kill_count, status, name,
       fixture_input, fixture_expected_residual,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, "bun", body,
      JSON.stringify({ runtime: "bun", cpu_ms: 1000, wall_ms: 1000, memory_mb: 64 }),
      "state/x", 1, 1, 0.5, 0.3, 0, 0, "admitted", null,
      "{}", 0, ts, ts,
    ],
  );
};

describe("extractActArtifactScores", () => {
  test("recomputes posterior + recent_residual_mean from action_scored events", async () => {
    const db = openDb(":memory:");
    insertArtifact(db, "art_x");

    // 3 successes (residual ≤ 0.3).
    insertEvent(db, { kind: "action_scored", action_artifact_id: "art_x", residual: 0.10 });
    insertEvent(db, { kind: "action_scored", action_artifact_id: "art_x", residual: 0.15 });
    insertEvent(db, { kind: "action_scored", action_artifact_id: "art_x", residual: 0.20 });

    const summary = await extractActArtifactScores(db);
    expect(summary.updated).toBe(1);

    const row = db.query("SELECT * FROM act_artifact WHERE id = 'art_x'").get() as Record<string, unknown>;
    // alpha = 1+3 = 4, beta = 1+0 = 1, score = 4/5 = 0.8.
    expect(row.posterior_alpha).toBe(4);
    expect(row.posterior_beta).toBe(1);
    expect(row.score as number).toBeCloseTo(0.8, 8);
    // recent_residual_mean = (0.10+0.15+0.20)/3 = 0.15.
    expect(row.recent_residual_mean as number).toBeCloseTo(0.15, 8);
    // Below 20-count promotion threshold → still admitted.
    expect(row.status).toBe("admitted");
  });

  test("promotes when score ≥ 0.85 AND confidence ≥ 0.7 AND count ≥ 20", async () => {
    const db = openDb(":memory:");
    insertArtifact(db, "art_p", "// promote_me\nexport default async () => 0;");
    for (let i = 0; i < 25; i++) {
      insertEvent(db, { kind: "action_scored", action_artifact_id: "art_p", residual: 0.05 });
    }
    const summary = await extractActArtifactScores(db);
    expect(summary.promoted).toBe(1);
    const row = db.query("SELECT status, name FROM act_artifact WHERE id = 'art_p'").get() as Record<string, unknown>;
    expect(row.status).toBe("promoted");
    expect(row.name as string).toBe("promote_me");
  });
});

describe("extractKnowledgePromotions", () => {
  test("promotes a candidate with ≥ 5 corroborations and score ≥ 0.85", async () => {
    const db = openDb(":memory:");
    const candidateId = insertEvent(db, {
      kind: "knowledge_candidate",
      payload: { text: "promote me" },
    });
    for (let i = 0; i < 6; i++) {
      insertEvent(db, {
        kind: "candidate_confirmed",
        context_refs: [candidateId],
        payload: { idx: i },
      });
    }
    const summary = await extractKnowledgePromotions(db);
    expect(summary.promoted).toBe(1);
    expect(summary.demoted).toBe(0);

    // The promoted event references the candidate via context_refs.
    const promoted = db
      .query("SELECT context_refs, payload FROM events WHERE kind = 'knowledge_promoted'")
      .all() as Array<{ context_refs: string; payload: string }>;
    expect(promoted).toHaveLength(1);
    const refs = JSON.parse(promoted[0]!.context_refs) as string[];
    expect(refs).toContain(candidateId);
  });

  test("does NOT promote when corroborations are below threshold", async () => {
    const db = openDb(":memory:");
    const candidateId = insertEvent(db, { kind: "knowledge_candidate", payload: { text: "x" } });
    for (let i = 0; i < 2; i++) {
      insertEvent(db, { kind: "candidate_confirmed", context_refs: [candidateId] });
    }
    const summary = await extractKnowledgePromotions(db);
    expect(summary.promoted).toBe(0);
  });

  test("idempotent — running twice does not re-promote", async () => {
    const db = openDb(":memory:");
    const candidateId = insertEvent(db, { kind: "knowledge_candidate", payload: { text: "y" } });
    for (let i = 0; i < 6; i++) {
      insertEvent(db, { kind: "candidate_confirmed", context_refs: [candidateId] });
    }
    await extractKnowledgePromotions(db);
    const second = await extractKnowledgePromotions(db);
    expect(second.promoted).toBe(0);
    const count = (db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind='knowledge_promoted'")
      .get() as { c: number }).c;
    expect(count).toBe(1);
  });

  test("cursor-advance idempotency hole: a candidate scanned while UNRESOLVED still promotes after its confirmations arrive on a later tick (cursor must not skip open candidates)", async () => {
    const db = openDb(":memory:");
    // Tick 1: candidate exists with NO confirmations yet. The extractor scans
    // it, finds it unresolved, and (pre-fix) advanced the cursor past its ts.
    const candidateId = insertEvent(db, {
      kind: "knowledge_candidate",
      payload: { text: "confirmations arrive later" },
      ts: tickTs(),
    });
    const tick1 = await extractKnowledgePromotions(db);
    expect(tick1.promoted).toBe(0);

    // Confirmations land AFTER the first extractor tick (real flow: the brain /
    // retrieval bindings corroborate the entry over subsequent cycles). Their
    // ts is later than the candidate's ts and later than the pre-fix cursor.
    for (let i = 0; i < 6; i++) {
      insertEvent(db, {
        kind: "candidate_confirmed",
        context_refs: [candidateId],
        payload: { idx: i },
        ts: tickTs(),
      });
    }

    // Tick 2: the candidate (ts < cursor pre-fix) must still be re-scanned and
    // now promoted. Pre-fix the cursor had advanced past candidate.ts, the
    // `ts > cursor` filter excluded it, and it could NEVER promote.
    const tick2 = await extractKnowledgePromotions(db);
    expect(tick2.promoted).toBe(1);
    const count = (db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind='knowledge_promoted'")
      .get() as { c: number }).c;
    expect(count).toBe(1);
  });
});

describe("extractSemanticDedup", () => {
  test("returns {merged:0, contradicted:0} when no embeddings present (Phase F gates the real path)", async () => {
    const db = openDb(":memory:");
    insertEvent(db, { kind: "knowledge_candidate", payload: { text: "no embeddings" } });
    insertEvent(db, { kind: "knowledge_candidate", payload: { text: "still no embeddings" } });
    const summary = await extractSemanticDedup(db);
    expect(summary).toEqual({ merged: 0, contradicted: 0 });
  });

  test("idempotent — running twice does not double-merge or advance state", async () => {
    const db = openDb(":memory:");
    insertEvent(db, { kind: "knowledge_candidate", payload: { text: "candidate A" } });
    insertEvent(db, { kind: "knowledge_candidate", payload: { text: "candidate B" } });
    const first = await extractSemanticDedup(db);
    const second = await extractSemanticDedup(db);
    expect(first).toEqual({ merged: 0, contradicted: 0 });
    expect(second).toEqual({ merged: 0, contradicted: 0 });
  });

  test("no-op when there are zero new candidates since last run", async () => {
    const db = openDb(":memory:");
    const summary = await extractSemanticDedup(db);
    expect(summary).toEqual({ merged: 0, contradicted: 0 });
  });
});

describe("extractRecipeCandidates (posterior-driven promotion, F5)", () => {
  // Seed a high-autonomy owner profile so the threshold = HIGH_AUTONOMY_THRESHOLD
  // (0.4) — letting a modest evidence accumulation cross the gate. Without
  // this seed, the default profile (autonomy_score=0.5) yields the MID
  // threshold (0.6) and most synthetic clusters defer.
  const seedHighAutonomyOwner = (db: ReturnType<typeof openDb>) => {
    insertEvent(db, {
      kind: "owner_profile_recorded",
      directive_id: "d_owner_seed",
      task_id: "t_owner_seed",
      payload: { autonomy_score: 0.9 },
    });
  };

  test("3 committed shapes + positive owner outcomes → promoted recipe-shape knowledge + recipe-shape knowledge", async () => {
    const db = openDb(":memory:");
    seedHighAutonomyOwner(db);
    for (let i = 0; i < 3; i++) {
      const did = `d_${i}`;
      insertEvent(db, {
        kind: "directive_opened",
        directive_id: did,
        task_id: `t_${i}_root`,
        payload: { goal: "count todos in repo" },
      });
      insertEvent(db, {
        kind: "task_node_opened",
        directive_id: did,
        task_id: `t_${i}_root`,
      });
      insertEvent(db, {
        kind: "task_committed",
        directive_id: did,
        task_id: `t_${i}_root`,
      });
      // Strong positive owner outcome on each directive — pushes the Beta
      // posterior above the high-autonomy threshold.
      insertEvent(db, {
        kind: "owner_observed_outcome_recorded",
        directive_id: did,
        task_id: `t_${i}_root`,
        payload: { signal_class: "positive_strong" },
      });
    }
    const summary = await extractRecipeCandidates(db);
    expect(summary.extracted).toBe(1);

    // Recipe-shape cache row (formerly recipe-shape knowledge) is now a
    // knowledge_candidate carrying recipe_shape.enabled.
    const recipes = db
      .query("SELECT payload FROM events WHERE kind = 'knowledge_candidate' AND COALESCE(json_extract(payload, '$.recipe_shape.enabled'), 0) IN (1, 'true')")
      .all() as Array<{ payload: string }>;
    expect(recipes).toHaveLength(1);
    const payload = JSON.parse(recipes[0]!.payload) as Record<string, unknown>;
    expect(payload.goal_shape).toContain("count_todos");
    expect(payload.success_count).toBe(3);

    // Paired promoted row (formerly promoted recipe-shape knowledge) carries the posterior evidence.
    const promoted = db
      .query("SELECT payload FROM events WHERE kind = 'knowledge_promoted' AND COALESCE(json_extract(payload, '$.recipe_shape.enabled'), 0) IN (1, 'true')")
      .all() as Array<{ payload: string }>;
    expect(promoted.length).toBe(1);
    const promotedPayload = JSON.parse(promoted[0]!.payload) as Record<string, unknown>;
    expect(typeof promotedPayload.confidence).toBe("number");
    expect(typeof promotedPayload.threshold).toBe("number");
    expect(promotedPayload.confidence as number).toBeGreaterThanOrEqual(promotedPayload.threshold as number);
  });

  test("3 commits with NO owner outcomes → deferred recipe-shape knowledge (not promoted)", async () => {
    const db = openDb(":memory:");
    // Default owner profile (autonomy_score=0.5 → MID threshold 0.6).
    // Three plain commits give alpha=2.5, beta=1 → mean=0.71, lower≈0.50.
    // Below 0.6 → defer.
    for (let i = 0; i < 3; i++) {
      const did = `d_${i}`;
      insertEvent(db, {
        kind: "directive_opened",
        directive_id: did,
        task_id: `t_${i}`,
        payload: { goal: "shape with no owner signal" },
      });
      insertEvent(db, { kind: "task_node_opened", directive_id: did, task_id: `t_${i}` });
      insertEvent(db, { kind: "task_committed", directive_id: did, task_id: `t_${i}` });
    }
    const summary = await extractRecipeCandidates(db);
    expect(summary.extracted).toBe(0);
    expect(summary.deferred).toBe(1);
    const deferredRows = db
      .query("SELECT payload FROM events WHERE kind = 'knowledge_candidate' AND json_extract(payload, '$.recipe_shape.promotion_state') = 'deferred'")
      .all() as Array<{ payload: string }>;
    expect(deferredRows.length).toBe(1);
    const d = JSON.parse(deferredRows[0]!.payload) as Record<string, unknown>;
    expect(typeof d.confidence).toBe("number");
    expect(typeof d.threshold).toBe("number");
    expect(d.reason).toBe("confidence_below_threshold");
  });

  test("idempotent — running twice does not double-emit for the same shape", async () => {
    const db = openDb(":memory:");
    seedHighAutonomyOwner(db);
    for (let i = 0; i < 3; i++) {
      const did = `d_${i}`;
      insertEvent(db, { kind: "directive_opened", directive_id: did, task_id: "t", payload: { goal: "shared shape" } });
      insertEvent(db, { kind: "task_node_opened",  directive_id: did, task_id: `t_${i}` });
      insertEvent(db, { kind: "task_committed",    directive_id: did, task_id: `t_${i}` });
      insertEvent(db, { kind: "owner_observed_outcome_recorded", directive_id: did, task_id: `t_${i}`, payload: { signal_class: "positive_strong" } });
    }
    await extractRecipeCandidates(db);
    const second = await extractRecipeCandidates(db);
    expect(second.extracted).toBe(0);
    const c = (db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'knowledge_candidate' AND COALESCE(json_extract(payload, '$.recipe_shape.enabled'), 0) IN (1, 'true')")
      .get() as { c: number }).c;
    expect(c).toBe(1);
  });

  test("Phase J: payload includes topology_signature + trajectory + directive_text fallback", async () => {
    const db = openDb(":memory:");
    seedHighAutonomyOwner(db);
    for (let i = 0; i < 3; i++) {
      const did = `d_${i}`;
      // Use directive_text (production shape) — Phase J extractor falls back
      // to it when neither goal nor intent is present.
      insertEvent(db, {
        kind: "directive_opened",
        directive_id: did,
        task_id: did,
        payload: { directive_text: "audit recent commits" },
      });
      insertEvent(db, { kind: "task_node_opened", directive_id: did, task_id: `t_${i}` });
      insertEvent(db, { kind: "task_committed", directive_id: did, task_id: `t_${i}` });
      insertEvent(db, { kind: "owner_observed_outcome_recorded", directive_id: did, task_id: `t_${i}`, payload: { signal_class: "positive_strong" } });
    }
    const summary = await extractRecipeCandidates(db);
    expect(summary.extracted).toBe(1);

    const recipes = db
      .query("SELECT payload FROM events WHERE kind = 'knowledge_candidate' AND COALESCE(json_extract(payload, '$.recipe_shape.enabled'), 0) IN (1, 'true')")
      .all() as Array<{ payload: string }>;
    expect(recipes.length).toBe(1);
    const p = JSON.parse(recipes[0]!.payload) as Record<string, unknown>;
    expect(p.goal_shape).toContain("audit_recent_commits");
    expect(typeof p.topology_signature).toBe("string");
    expect((p.topology_signature as string).startsWith("topo_")).toBe(true);
    expect(Array.isArray(p.trajectory)).toBe(true);
    expect(p.success_count).toBe(3);
  });

  test("Phase J: distinct topology signatures DO NOT collapse into one recipe", async () => {
    const db = openDb(":memory:");
    seedHighAutonomyOwner(db);
    // Group 1: 3 directives with a single root task (topology n=1)
    for (let i = 0; i < 3; i++) {
      const did = `d_solo_${i}`;
      insertEvent(db, { kind: "directive_opened", directive_id: did, task_id: did, payload: { goal: "solo" } });
      insertEvent(db, { kind: "task_node_opened", directive_id: did, task_id: `t_solo_${i}` });
      insertEvent(db, { kind: "task_committed", directive_id: did, task_id: `t_solo_${i}` });
      insertEvent(db, { kind: "owner_observed_outcome_recorded", directive_id: did, task_id: `t_solo_${i}`, payload: { signal_class: "positive_strong" } });
    }
    // Group 2: 3 directives with a two-task DAG (topology n=2)
    for (let i = 0; i < 3; i++) {
      const did = `d_pair_${i}`;
      insertEvent(db, { kind: "directive_opened", directive_id: did, task_id: did, payload: { goal: "solo" } });
      const root = `t_pair_root_${i}`;
      const child = `t_pair_child_${i}`;
      insertEvent(db, { kind: "task_node_opened", directive_id: did, task_id: root });
      insertEvent(db, { kind: "task_node_opened", directive_id: did, task_id: child });
      insertEvent(db, { kind: "task_committed", directive_id: did, task_id: child });
      insertEvent(db, { kind: "owner_observed_outcome_recorded", directive_id: did, task_id: child, payload: { signal_class: "positive_strong" } });
    }
    const summary = await extractRecipeCandidates(db);
    // The goal_shape token is the same ("solo") but the topology differs
    // (n1 vs n2), so two recipes should emit.
    expect(summary.extracted).toBe(2);
  });
});

describe("extractRecipeFromCommit (inline post-commit path)", () => {
  test("seeds a confidence=1.0 recipe on the first commit for a new (goal_shape, topology)", () => {
    const db = openDb(":memory:");
    const did = "d_inline_1";
    const taskId = "t_inline_1";
    insertEvent(db, { kind: "directive_opened", directive_id: did, task_id: taskId, payload: { goal: "fetch title from page" } });
    insertEvent(db, { kind: "task_node_opened", directive_id: did, task_id: taskId });
    insertEvent(db, { kind: "task_committed", directive_id: did, task_id: taskId });

    const summary = extractRecipeFromCommit(db, taskId);
    expect(summary.extracted).toBe(1);
    expect(summary.recipe_id).not.toBeNull();

    const recipes = db
      .query("SELECT payload FROM events WHERE kind = 'knowledge_candidate' AND COALESCE(json_extract(payload, '$.recipe_shape.enabled'), 0) IN (1, 'true')")
      .all() as Array<{ payload: string }>;
    expect(recipes.length).toBe(1);
    const p = JSON.parse(recipes[0]!.payload) as Record<string, unknown>;
    // Inline first-commit seed lands at the canonical 0.5 prior — same as
    // the statistical 3-shape extractor — so the two paths converge on the
    // same posterior trajectory through updateRecipeConfidence.
    expect(p.confidence).toBe(0.5);
    expect(p.success_count).toBe(1);
    expect(p.seeded_by).toBe("inline_post_commit");
    expect(typeof p.goal_shape).toBe("string");
    expect((p.goal_shape as string).startsWith("fetch_title_from_page")).toBe(true);
    expect(typeof p.topology_signature).toBe("string");
    expect((p.topology_signature as string).startsWith("topo_")).toBe(true);
  });

  test("idempotent — calling twice on the same task produces no duplicate seed row", () => {
    const db = openDb(":memory:");
    const did = "d_inline_2";
    const taskId = "t_inline_2";
    insertEvent(db, { kind: "directive_opened", directive_id: did, task_id: taskId, payload: { goal: "shared shape" } });
    insertEvent(db, { kind: "task_node_opened", directive_id: did, task_id: taskId });
    insertEvent(db, { kind: "task_committed", directive_id: did, task_id: taskId });

    const first = extractRecipeFromCommit(db, taskId);
    expect(first.extracted).toBe(1);
    const second = extractRecipeFromCommit(db, taskId);
    // The seed is idempotent — second call returns extracted=0 with the
    // SAME recipe_id. The bump-row check (context_refs LIKE %committed_id%)
    // ALSO short-circuits the second call so no duplicate bump emits.
    expect(second.extracted).toBe(0);
    expect(second.recipe_id).toBe(first.recipe_id);
    // Pre-Batch-10: this asserted exactly 1 row. Post-Batch-10 (recipe
    // auto-promotion via brain-replay bump) the second call to
    // extractRecipeFromCommit ALSO finds the existing seed; the per-task
    // idempotency guard suppresses any further bump, so we end up with
    // exactly 1 row in this 2-call scenario (seed + zero bumps because
    // the test sets up one task that doesn't trigger bump path).
    const count = (db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'knowledge_candidate' AND COALESCE(json_extract(payload, '$.recipe_shape.enabled'), 0) IN (1, 'true')")
      .get() as { c: number }).c;
    expect(count).toBe(1);
  });

  test("dedup composes with extractRecipeCandidates — the 3-shape statistical path skips an already-seeded composite key", async () => {
    const db = openDb(":memory:");
    // Three directives with the same (goal_shape, topology). Seed the recipe
    // inline from the FIRST commit, then run the 3-shape extractor and
    // assert it doesn't double-emit.
    for (let i = 0; i < 3; i++) {
      const did = `d_compose_${i}`;
      const t = `t_compose_${i}`;
      insertEvent(db, { kind: "directive_opened", directive_id: did, task_id: t, payload: { goal: "compose shape" } });
      insertEvent(db, { kind: "task_node_opened", directive_id: did, task_id: t });
      insertEvent(db, { kind: "task_committed", directive_id: did, task_id: t });
      if (i === 0) extractRecipeFromCommit(db, t);
    }
    const summary = await extractRecipeCandidates(db);
    expect(summary.extracted).toBe(0);
    const count = (db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'knowledge_candidate' AND COALESCE(json_extract(payload, '$.recipe_shape.enabled'), 0) IN (1, 'true')")
      .get() as { c: number }).c;
    expect(count).toBe(1);
  });

  test("no-op when the task has no task_committed row", () => {
    const db = openDb(":memory:");
    const summary = extractRecipeFromCommit(db, "t_missing");
    expect(summary).toEqual({ extracted: 0, recipe_id: null });
  });
});

describe("task_dispatcher inline recipe seeding (Task 5)", () => {
  test("a successful dispatch emits recipe-shape knowledge within the same call", async () => {
    // End-to-end check that the dispatcher wires extractRecipeFromCommit on
    // the task_committed branch (k_555: create → retrieve → mutate → credit).
    // Uses the canonical d_count_todos fixture under the mock bridge so the
    // run is hermetic.
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { dispatchReadyTask } = await import("../runtime/task_dispatcher");
    const { readyTasks } = await import("../runtime/task_topology");
    const { openFixtureDCountTodos } = await import("../runtime/fixtures/d_count_todos");

    const db = openDb(":memory:");
    const tempDir = mkdtempSync(join(tmpdir(), "acc2-recipe-inline-"));
    writeFileSync(join(tempDir, "a.txt"), "// TODO one", "utf-8");
    writeFileSync(join(tempDir, "b.txt"), "// TODO two", "utf-8");
    try {
      const { directiveId, taskId } = await openFixtureDCountTodos(db, tempDir);
      const ready = readyTasks(db, directiveId);
      expect(ready.length).toBeGreaterThan(0);
      await dispatchReadyTask(db, ready[0]!, { fixtureTargetPath: tempDir });

      const committed = db
        .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'task_committed' AND task_id = ?")
        .get(taskId) as { c: number };
      expect(committed.c).toBe(1);

      const recipeRows = db
        .query("SELECT payload FROM events WHERE kind = 'knowledge_candidate' AND COALESCE(json_extract(payload, '$.recipe_shape.enabled'), 0) IN (1, 'true') AND directive_id = ?")
        .all(directiveId) as Array<{ payload: string }>;
      expect(recipeRows.length).toBe(1);
      const p = JSON.parse(recipeRows[0]!.payload) as Record<string, unknown>;
      expect(p.seeded_by).toBe("inline_post_commit");
      expect(p.confidence).toBe(0.5);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("maybePromoteOwnerProfile (Layer-2 owner autonomy)", () => {
  test("promotes a high-confidence single-origin candidate via the confidence route, merging the field into a fresh owner_profile_recorded row, and is idempotent on a second call", () => {
    const db = openDb(":memory:");
    const candidateId = insertEvent(db, {
      kind: "owner_insight_candidate",
      substrate_origin: "claude_root",
      payload: {
        field: "detected_language",
        value: "es",
        confidence: 0.95,
        claim: "Owner consistently writes in Spanish across the last 10 chat turns.",
      },
    });
    const verdict = maybePromoteOwnerProfile(db, candidateId);
    expect(verdict.kind).toBe("promoted");
    if (verdict.kind === "promoted") {
      expect(verdict.field).toBe("detected_language");
      expect(verdict.route).toBe("confidence");
    }
    // Exactly one owner_profile_recorded row landed, with the new field.
    const recorded = db
      .query("SELECT payload, context_refs FROM events WHERE kind = 'owner_profile_recorded'")
      .all() as Array<{ payload: string; context_refs: string }>;
    expect(recorded.length).toBe(1);
    const payload = JSON.parse(recorded[0]!.payload) as Record<string, unknown>;
    expect(payload.detected_language).toBe("es");
    expect(payload.promotion_route).toBe("confidence");
    expect(JSON.parse(recorded[0]!.context_refs)).toContain(candidateId);

    // Idempotent — second call must NOT emit a duplicate row.
    const second = maybePromoteOwnerProfile(db, candidateId);
    expect(second.kind).toBe("no_action");
    if (second.kind === "no_action") expect(second.reason).toBe("already_promoted");
    const count2 = (db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'owner_profile_recorded'")
      .get() as { c: number }).c;
    expect(count2).toBe(1);
  });

  test("low-confidence single-origin candidate without sibling or owner approval is rejected (no_action)", () => {
    const db = openDb(":memory:");
    const candidateId = insertEvent(db, {
      kind: "owner_insight_candidate",
      substrate_origin: "claude_root",
      payload: { field: "autonomy_score", value: 0.3, confidence: 0.4, claim: "weak signal" },
    });
    const verdict = maybePromoteOwnerProfile(db, candidateId);
    expect(verdict.kind).toBe("no_action");
    if (verdict.kind === "no_action") expect(verdict.reason).toBe("no_promotion_route");
    const count = (db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'owner_profile_recorded'")
      .get() as { c: number }).c;
    expect(count).toBe(0);
  });

  test("owner_decision_recorded approval bypass promotes a low-confidence candidate via the owner_approval route", () => {
    const db = openDb(":memory:");
    const candidateId = insertEvent(db, {
      kind: "owner_insight_candidate",
      substrate_origin: "claude_root",
      payload: { field: "hot_topics", value: ["recipes"], confidence: 0.3, claim: "owner mentioned recipes once" },
    });
    insertEvent(db, {
      kind: "owner_decision_recorded",
      substrate_origin: "owner",
      context_refs: [candidateId],
      payload: { decision: "approve", note: "yes, recipes matter" },
    });
    const verdict = maybePromoteOwnerProfile(db, candidateId);
    expect(verdict.kind).toBe("promoted");
    if (verdict.kind === "promoted") expect(verdict.route).toBe("owner_approval");
  });

  test("schema-invalid value (autonomy_score outside [0,1]) drops the candidate silently", () => {
    const db = openDb(":memory:");
    const candidateId = insertEvent(db, {
      kind: "owner_insight_candidate",
      substrate_origin: "claude_root",
      payload: { field: "autonomy_score", value: 99, confidence: 0.95, claim: "garbage" },
    });
    const verdict = maybePromoteOwnerProfile(db, candidateId);
    expect(verdict.kind).toBe("no_action");
    if (verdict.kind === "no_action") expect(verdict.reason).toBe("schema_validation_failed");
    const count = (db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'owner_profile_recorded'")
      .get() as { c: number }).c;
    expect(count).toBe(0);
  });

  test("k_555 four-link spine: each promotion emits action_predicted + action_scored before owner_profile_recorded", () => {
    const db = openDb(":memory:");
    const candidateId = insertEvent(db, {
      kind: "owner_insight_candidate",
      payload: { field: "detected_language", value: "es", confidence: 0.95, claim: "Spanish-first owner" },
    });
    const verdict = maybePromoteOwnerProfile(db, candidateId);
    expect(verdict.kind).toBe("promoted");

    // All three spine events must exist with the right context chain.
    const action = db
      .query("SELECT id, context_refs FROM events WHERE kind='action_predicted' AND action_artifact_id='owner_profile_promoter_action'")
      .get() as { id: string; context_refs: string };
    expect(action).not.toBeNull();
    expect(JSON.parse(action.context_refs)).toEqual([candidateId]);

    const scored = db
      .query("SELECT id, context_refs, outcome, residual FROM events WHERE kind='action_scored' AND action_artifact_id='owner_profile_promoter_action'")
      .get() as { id: string; context_refs: string; outcome: string; residual: number };
    expect(scored).not.toBeNull();
    expect(scored.outcome).toBe("succeeded");
    expect(scored.residual).toBe(0);
    expect(JSON.parse(scored.context_refs)).toEqual([candidateId, action.id]);

    const recorded = db
      .query("SELECT context_refs, payload FROM events WHERE kind='owner_profile_recorded'")
      .get() as { context_refs: string; payload: string };
    expect(recorded).not.toBeNull();
    const refs = JSON.parse(recorded.context_refs) as string[];
    expect(refs).toEqual([candidateId, action.id, scored.id]);
    const payload = JSON.parse(recorded.payload) as Record<string, unknown>;
    expect(payload.action_event_id).toBe(action.id);
    expect(payload.scored_event_id).toBe(scored.id);
  });

  test("additive merge: rendering_signals accumulates keys across promotions instead of replacing", () => {
    const db = openDb(":memory:");
    const c1 = insertEvent(db, {
      kind: "owner_insight_candidate",
      payload: {
        field: "rendering_signals",
        value: { code_density: 0.7 },
        confidence: 0.9,
        claim: "first signal classification",
      },
    });
    const v1 = maybePromoteOwnerProfile(db, c1);
    expect(v1.kind).toBe("promoted");

    const c2 = insertEvent(db, {
      kind: "owner_insight_candidate",
      payload: {
        field: "rendering_signals",
        value: { ops_vocabulary: 0.5 },
        confidence: 0.9,
        claim: "second classification, different signal",
      },
    });
    const v2 = maybePromoteOwnerProfile(db, c2);
    expect(v2.kind).toBe("promoted");

    const profile = db
      .query("SELECT payload FROM events WHERE kind='owner_profile_recorded' ORDER BY ts DESC, rowid DESC LIMIT 1")
      .get() as { payload: string };
    const p = JSON.parse(profile.payload) as Record<string, unknown>;
    const signals = p.rendering_signals as Record<string, number>;
    // Both signals must coexist; second emit did NOT wipe code_density.
    expect(signals.code_density).toBe(0.7);
    expect(signals.ops_vocabulary).toBe(0.5);
  });

  test("additive merge: generalized owner signal maps accumulate keys", () => {
    const db = openDb(":memory:");
    const c1 = insertEvent(db, { kind: "owner_insight_candidate", payload: { field: "risk_signals", value: { multi_file_diff_caution: 0.8 }, confidence: 0.9, claim: "risk signal classification" } });
    expect(maybePromoteOwnerProfile(db, c1).kind).toBe("promoted");
    const c2 = insertEvent(db, { kind: "owner_insight_candidate", payload: { field: "risk_signals", value: { protected_target_caution: 0.6 }, confidence: 0.9, claim: "second risk signal classification" } });
    expect(maybePromoteOwnerProfile(db, c2).kind).toBe("promoted");
    const profile = db.query("SELECT payload FROM events WHERE kind='owner_profile_recorded' ORDER BY ts DESC, rowid DESC LIMIT 1").get() as { payload: string };
    const p = JSON.parse(profile.payload) as Record<string, unknown>;
    const signals = p.risk_signals as Record<string, number>;
    expect(signals.multi_file_diff_caution).toBe(0.8);
    expect(signals.protected_target_caution).toBe(0.6);
  });

  test("additive merge: exposed_concepts accumulates per-concept records across promotions", () => {
    const db = openDb(":memory:");
    const c1 = insertEvent(db, {
      kind: "owner_insight_candidate",
      payload: {
        field: "exposed_concepts",
        value: { rolling_active: { first_event_id: "ev_one", exposure_count: 1 } },
        confidence: 0.9,
        claim: "first concept exposure",
      },
    });
    expect(maybePromoteOwnerProfile(db, c1).kind).toBe("promoted");

    const c2 = insertEvent(db, {
      kind: "owner_insight_candidate",
      payload: {
        field: "exposed_concepts",
        value: { knowledge_compounds: { first_event_id: "ev_two", exposure_count: 1 } },
        confidence: 0.9,
        claim: "second concept exposure",
      },
    });
    expect(maybePromoteOwnerProfile(db, c2).kind).toBe("promoted");

    const profile = db
      .query("SELECT payload FROM events WHERE kind='owner_profile_recorded' ORDER BY ts DESC, rowid DESC LIMIT 1")
      .get() as { payload: string };
    const p = JSON.parse(profile.payload) as Record<string, unknown>;
    const exposed = p.exposed_concepts as Record<string, { first_event_id: string; exposure_count: number }>;
    expect(exposed.rolling_active!.first_event_id).toBe("ev_one");
    expect(exposed.knowledge_compounds!.first_event_id).toBe("ev_two");
  });

  test("pure-replace fields (preferred_terms array) still overwrite cleanly", () => {
    const db = openDb(":memory:");
    const c1 = insertEvent(db, {
      kind: "owner_insight_candidate",
      payload: { field: "preferred_terms", value: ["weekly grind"], confidence: 0.9, claim: "first set" },
    });
    expect(maybePromoteOwnerProfile(db, c1).kind).toBe("promoted");
    const c2 = insertEvent(db, {
      kind: "owner_insight_candidate",
      payload: { field: "preferred_terms", value: ["weekly grind", "my report"], confidence: 0.9, claim: "vocab extractor re-emitted full list" },
    });
    expect(maybePromoteOwnerProfile(db, c2).kind).toBe("promoted");
    const profile = db
      .query("SELECT payload FROM events WHERE kind='owner_profile_recorded' ORDER BY ts DESC, rowid DESC LIMIT 1")
      .get() as { payload: string };
    const p = JSON.parse(profile.payload) as Record<string, unknown>;
    expect(p.preferred_terms).toEqual(["weekly grind", "my report"]);
  });

  test("credit chain closes: distributeCredit emits candidate_confirmed citing the source candidate", async () => {
    // End-to-end proof: a promotion triggers the spine, the spine triggers
    // distributeCredit, distributeCredit emits candidate_confirmed citing
    // the source candidate id. Without this, the source candidate's Beta
    // posterior never updates — the loop was structurally open.
    const db = openDb(":memory:");
    const candidateId = insertEvent(db, {
      kind: "owner_insight_candidate",
      payload: { field: "detected_language", value: "fr", confidence: 0.95, claim: "owner spoke French" },
    });
    const verdict = maybePromoteOwnerProfile(db, candidateId);
    expect(verdict.kind).toBe("promoted");

    // distributeCredit runs async via dynamic import — give it time
    // for the import + DB writes. 300ms is generous; production paths
    // don't await this, but the test needs it to complete.
    await new Promise((r) => setTimeout(r, 300));

    // distributeCredit may emit MULTIPLE candidate_confirmed rows (one per
    // cited target). Find the one that cites our source candidate.
    const confirmedRows = db
      .query(
        `SELECT context_refs, payload FROM events
         WHERE kind = 'candidate_confirmed'`,
      )
      .all() as Array<{ context_refs: string; payload: string }>;
    const matching = confirmedRows.find((r) => {
      try {
        const p = JSON.parse(r.payload) as Record<string, unknown>;
        return p.knowledge_id === candidateId;
      } catch { return false; }
    });
    expect(matching).toBeDefined();
    const payload = JSON.parse(matching!.payload) as Record<string, unknown>;
    expect(payload.knowledge_id).toBe(candidateId);
    expect(payload.polarity).toBe("assert");  // residual=0 → success-band
  });

  test("extractOwnerProfilePromotions bulk path promotes every eligible candidate exactly once", async () => {
    const db = openDb(":memory:");
    const c1 = insertEvent(db, {
      kind: "owner_insight_candidate",
      payload: { field: "detected_language", value: "fr", confidence: 0.95, claim: "consistently French" },
    });
    const c2 = insertEvent(db, {
      kind: "owner_insight_candidate",
      payload: { field: "autonomy_score", value: 0.9, confidence: 0.9, claim: "owner explicit" },
    });
    const c3 = insertEvent(db, {
      kind: "owner_insight_candidate",
      payload: { field: "detected_language", value: "fr", confidence: 0.2, claim: "low confidence" },
    });
    const summary = await extractOwnerProfilePromotions(db);
    expect(summary.promoted).toBe(2);
    expect(summary.skipped).toBe(1);
    // Idempotent on rerun.
    const again = await extractOwnerProfilePromotions(db);
    expect(again.promoted).toBe(0);
    void c1; void c2; void c3;
  });
});

describe("extractCrossCandidateCorroboration (T1.3 promotion-rate spine)", () => {
  // Helpers — write an embedding BLOB on the events row AND upsert into
  // vec_events so the extractor's MATCH query can find the row.
  const makeUnitVec = (dims: number, axis: number): number[] => {
    const v = new Array<number>(dims).fill(0);
    v[axis] = 1;
    return v;
  };
  const attachEmbedding = (
    db: ReturnType<typeof openDb>,
    eventId: string,
    axis: number,
  ): void => {
    const vec = makeUnitVec(EMBEDDING_DIMS, axis);
    db.run(
      "UPDATE events SET embedding = ?, embedding_version = ? WHERE id = ?",
      [encodeEmbeddingBlob(vec), EMBEDDING_VERSION, eventId],
    );
    try { upsertVecEventRow(db, eventId, vec, EMBEDDING_VERSION); } catch { /* vec0 not loaded → fall through */ }
  };
  // Build a unit vector aligned with axis-0 that picks up `bleed` on
  // axis-1 so cosine(query, near) = 1/√(1+bleed²) lands at a known value.
  const makeNearAxis0 = (bleed: number): number[] => {
    const v = makeUnitVec(EMBEDDING_DIMS, 0);
    v[1] = bleed;
    // Re-normalise so the L2 distance ↔ cosine math from
    // runtime/embedding_index matches the extractor's read.
    const n = Math.sqrt(1 + bleed * bleed);
    for (let i = 0; i < v.length; i++) v[i] = v[i] / n;
    return v;
  };
  const attachExplicit = (
    db: ReturnType<typeof openDb>,
    eventId: string,
    vec: number[],
  ): void => {
    db.run(
      "UPDATE events SET embedding = ?, embedding_version = ? WHERE id = ?",
      [encodeEmbeddingBlob(vec), EMBEDDING_VERSION, eventId],
    );
    try { upsertVecEventRow(db, eventId, vec, EMBEDDING_VERSION); } catch { /* vec0 not loaded */ }
  };

  test("cosine 0.92 + goal_shape overlap + score 0.91 → emits semantic_corroboration confirm", async () => {
    const db = openDb(":memory:");

    // Promoted neighbor on axis-0 with score 0.91 + matching goal_shape tag.
    const promotedId = insertEvent(db, {
      kind: "knowledge_promoted",
      payload: { score: 0.91, goal_shape_tags: ["dispatch_strategy"], claim: "promoted claim" },
    });
    attachEmbedding(db, promotedId, 0);

    // Unverified candidate near axis-0 (bleed=0.1) → cosine ≈ 0.995/√1.01
    // ≈ 0.995; well above the 0.88 floor. Same goal_shape tag.
    const candidateId = insertEvent(db, {
      kind: "knowledge_candidate",
      payload: { claim: "candidate near promoted", goal_shape_tags: ["dispatch_strategy"] },
    });
    attachExplicit(db, candidateId, makeNearAxis0(0.1));

    const summary = await extractCrossCandidateCorroboration(db);
    expect(summary.scanned).toBe(1);
    expect(summary.corroborated).toBe(1);

    const confirms = db
      .query(
        `SELECT context_refs, payload FROM events
         WHERE kind = 'candidate_confirmed'
           AND payload LIKE '%"confirmation_source":"semantic_corroboration"%'`,
      )
      .all() as Array<{ context_refs: string; payload: string }>;
    expect(confirms.length).toBe(1);
    const refs = JSON.parse(confirms[0]!.context_refs) as string[];
    expect(refs).toContain(candidateId);
    expect(refs).toContain(promotedId);
    const p = JSON.parse(confirms[0]!.payload) as Record<string, unknown>;
    expect(p.confirmation_source).toBe("semantic_corroboration");
    expect(p.weight).toBe(0.3);
    expect(p.matched_promoted_id).toBe(promotedId);
    expect(p.candidate_id).toBe(candidateId);
    expect(typeof p.cosine_similarity).toBe("number");
  });

  test("cosine below threshold (0.85) → no corroboration", async () => {
    const db = openDb(":memory:");

    const promotedId = insertEvent(db, {
      kind: "knowledge_promoted",
      payload: { score: 0.91, goal_shape_tags: ["dispatch_strategy"], claim: "promoted claim" },
    });
    attachEmbedding(db, promotedId, 0);

    // Candidate at bleed ≈ 0.62 → cosine ≈ 1/√(1+0.62²) ≈ 0.85 (just below
    // the 0.88 floor).
    const candidateId = insertEvent(db, {
      kind: "knowledge_candidate",
      payload: { claim: "candidate borderline", goal_shape_tags: ["dispatch_strategy"] },
    });
    attachExplicit(db, candidateId, makeNearAxis0(0.62));

    const summary = await extractCrossCandidateCorroboration(db);
    expect(summary.scanned).toBe(1);
    expect(summary.corroborated).toBe(0);
    expect(summary.skipped_recent).toBe(1);
    void candidateId;
  });

  test("promoted neighbor with score 0.7 (below polarity bar) → no corroboration", async () => {
    const db = openDb(":memory:");

    const promotedId = insertEvent(db, {
      kind: "knowledge_promoted",
      payload: { score: 0.7, goal_shape_tags: ["dispatch_strategy"], claim: "weakly promoted" },
    });
    attachEmbedding(db, promotedId, 0);

    const candidateId = insertEvent(db, {
      kind: "knowledge_candidate",
      payload: { claim: "candidate near weak promoted", goal_shape_tags: ["dispatch_strategy"] },
    });
    attachExplicit(db, candidateId, makeNearAxis0(0.1));

    const summary = await extractCrossCandidateCorroboration(db);
    expect(summary.corroborated).toBe(0);
    void candidateId;
  });

  test("prior semantic_corroboration confirm already exists → skipped_existing", async () => {
    const db = openDb(":memory:");

    const promotedId = insertEvent(db, {
      kind: "knowledge_promoted",
      payload: { score: 0.91, goal_shape_tags: ["dispatch_strategy"], claim: "promoted" },
    });
    attachEmbedding(db, promotedId, 0);

    const candidateId = insertEvent(db, {
      kind: "knowledge_candidate",
      payload: { claim: "candidate", goal_shape_tags: ["dispatch_strategy"] },
    });
    attachExplicit(db, candidateId, makeNearAxis0(0.1));

    // Seed a prior semantic_corroboration confirm on this candidate.
    insertEvent(db, {
      kind: "candidate_confirmed",
      context_refs: [candidateId, promotedId],
      payload: {
        candidate_id: candidateId,
        confirmation_source: "semantic_corroboration",
        weight: 0.3,
      },
    });

    const summary = await extractCrossCandidateCorroboration(db);
    // Because the prior confirm makes the candidate non-"unverified" (the
    // NOT-EXISTS guard hides it), the candidate doesn't even reach the
    // semantic_corroboration scan. Either path is correct — the canonical
    // outcome is that NO additional corroboration row is emitted.
    expect(summary.corroborated).toBe(0);
    const count = (db
      .query(
        `SELECT COUNT(*) AS c FROM events
         WHERE kind = 'candidate_confirmed'
           AND payload LIKE '%"confirmation_source":"semantic_corroboration"%'`,
      )
      .get() as { c: number }).c;
    expect(count).toBe(1);
  });

  test("candidate without embedding → skipped silently (counted under skipped_existing)", async () => {
    const db = openDb(":memory:");

    // Promoted neighbor exists with an embedding, but the candidate has
    // no embedding row yet — the extractor must skip without throwing.
    const promotedId = insertEvent(db, {
      kind: "knowledge_promoted",
      payload: { score: 0.91, goal_shape_tags: ["dispatch_strategy"], claim: "promoted" },
    });
    attachEmbedding(db, promotedId, 0);

    insertEvent(db, {
      kind: "knowledge_candidate",
      payload: { claim: "candidate with no embedding", goal_shape_tags: ["dispatch_strategy"] },
    });

    const summary = await extractCrossCandidateCorroboration(db);
    expect(summary.corroborated).toBe(0);
    expect(summary.skipped_existing).toBeGreaterThanOrEqual(1);
  });
});

// ── Tier-S4: merger-rule thresholds via T2.1 registry ─────────────
//
// Every hardcoded constant in extractSemanticDedup + extractCrossCandidateCorroboration
// now routes through getThreshold(db, "<name>", default). The cold-start
// default is the original literal; an admitted threshold_predicate row
// overrides it. These five tests prove the override path works for each
// migrated threshold.
describe("Tier-S4 — merger thresholds via threshold registry", () => {
  // Helpers — local copies of the cross-corroboration test fixtures so
  // we can build embeddings + vec_events rows for the corroboration tests.
  const makeUnitVec = (dims: number, axis: number): number[] => {
    const v = new Array<number>(dims).fill(0);
    v[axis] = 1;
    return v;
  };
  const makeNearAxis0 = (bleed: number): number[] => {
    const v = makeUnitVec(EMBEDDING_DIMS, 0);
    v[1] = bleed;
    const n = Math.sqrt(1 + bleed * bleed);
    for (let i = 0; i < v.length; i++) v[i] = v[i] / n;
    return v;
  };
  const attachEmbedding = (
    db: ReturnType<typeof openDb>,
    eventId: string,
    axis: number,
  ): void => {
    const vec = makeUnitVec(EMBEDDING_DIMS, axis);
    db.run(
      "UPDATE events SET embedding = ?, embedding_version = ? WHERE id = ?",
      [encodeEmbeddingBlob(vec), EMBEDDING_VERSION, eventId],
    );
    try { upsertVecEventRow(db, eventId, vec, EMBEDDING_VERSION); } catch { /* vec0 not loaded */ }
  };
  const attachExplicit = (
    db: ReturnType<typeof openDb>,
    eventId: string,
    vec: number[],
  ): void => {
    db.run(
      "UPDATE events SET embedding = ?, embedding_version = ? WHERE id = ?",
      [encodeEmbeddingBlob(vec), EMBEDDING_VERSION, eventId],
    );
    try { upsertVecEventRow(db, eventId, vec, EMBEDDING_VERSION); } catch { /* vec0 not loaded */ }
  };

  test("merger_dedup_cosine_threshold override raises the bar — near-duplicates at cosine ≈ 0.93 no longer collapse", async () => {
    const db = openDb(":memory:");
    // Seed the override BEFORE any extractor read so the cache lands on
    // the registry value, not the default. 0.95 > 0.93 so the prior
    // candidate fails the new cosine bar even though it passes the
    // default 0.92.
    seedThresholdPredicate(db, "merger_dedup_cosine_threshold", 0.95);

    const priorId = insertEvent(db, {
      kind: "knowledge_candidate",
      payload: { text: "claim under test" },
    });
    attachEmbedding(db, priorId, 0);

    // bleed=0.4 → cosine = 1/√(1+0.16) ≈ 0.928 — above default 0.92 but
    // below the registry-seeded 0.95. With the override active, the
    // pair must NOT merge.
    const candId = insertEvent(db, {
      kind: "knowledge_candidate",
      payload: { text: "claim under test (near-dup)" },
    });
    attachExplicit(db, candId, makeNearAxis0(0.4));

    const summary = await extractSemanticDedup(db);
    expect(summary.merged).toBe(0);
    expect(summary.contradicted).toBe(0);
  });

  test("merger_synthesis_eligibility_count override raises the bar — 2 corroborations no longer synthesize", async () => {
    const db = openDb(":memory:");
    // Default is 2 — seed 5 so the dedup loop's synthesis branch fails
    // even when a second corroborator lands. The merged row still
    // emits (cosine + polarity dedup), but the synthesised row does NOT.
    seedThresholdPredicate(db, "merger_synthesis_eligibility_count", 5);

    // Anchor candidate (axis-0) + two near-duplicates (also axis-0) from
    // two DIFFERENT origins so the synthesis branch's distinctOrigins
    // gate would normally pass (>=2 origins) at count=2. With the
    // override at 5, the count gate fails and no synthesis lands.
    const anchorId = insertEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "claude_root",
      payload: { text: "anchor claim about retrieval" },
    });
    attachEmbedding(db, anchorId, 0);

    const corrA = insertEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "opencode_brain",
      payload: { text: "anchor claim about retrieval (rephrased A)" },
    });
    attachEmbedding(db, corrA, 0);

    const corrB = insertEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "substrate_auto",
      payload: { text: "anchor claim about retrieval (rephrased B)" },
    });
    attachEmbedding(db, corrB, 0);

    await extractSemanticDedup(db);

    const synthRows = db
      .query("SELECT id FROM events WHERE kind = 'knowledge_synthesized'")
      .all() as Array<{ id: string }>;
    expect(synthRows.length).toBe(0);
  });

  test("merger_corroboration_cosine_threshold override raises the bar — cosine 0.95 no longer corroborates", async () => {
    const db = openDb(":memory:");
    // Default is 0.88. Seed 0.99 so even very-near matches fail.
    seedThresholdPredicate(db, "merger_corroboration_cosine_threshold", 0.99);

    const promotedId = insertEvent(db, {
      kind: "knowledge_promoted",
      payload: { score: 0.91, goal_shape_tags: ["dispatch_strategy"], claim: "promoted" },
    });
    attachEmbedding(db, promotedId, 0);

    // bleed=0.1 → cosine ≈ 0.995 — well above default 0.88, but barely
    // above the seeded 0.99. Use bleed=0.2 → cosine ≈ 0.981 to land
    // BELOW the new 0.99 floor while still being a strong neighbor.
    const candidateId = insertEvent(db, {
      kind: "knowledge_candidate",
      payload: { claim: "candidate near promoted", goal_shape_tags: ["dispatch_strategy"] },
    });
    attachExplicit(db, candidateId, makeNearAxis0(0.2));

    const summary = await extractCrossCandidateCorroboration(db);
    expect(summary.corroborated).toBe(0);
    // skipped_recent counts candidates that scanned but failed cosine /
    // polarity / goal-shape gates. The override pushes this candidate
    // into skipped_recent.
    expect(summary.skipped_recent + summary.skipped_existing).toBeGreaterThanOrEqual(1);
  });

  test("merger_corroboration_polarity_floor override raises the bar — promoted score 0.90 no longer counts as polarity-positive", async () => {
    const db = openDb(":memory:");
    // Default polarity floor is 0.85. Seed 0.95 so a 0.91-scored
    // promoted neighbor no longer qualifies as a corroboration source.
    seedThresholdPredicate(db, "merger_corroboration_polarity_floor", 0.95);

    const promotedId = insertEvent(db, {
      kind: "knowledge_promoted",
      payload: { score: 0.91, goal_shape_tags: ["dispatch_strategy"], claim: "promoted" },
    });
    attachEmbedding(db, promotedId, 0);

    const candidateId = insertEvent(db, {
      kind: "knowledge_candidate",
      payload: { claim: "candidate near promoted", goal_shape_tags: ["dispatch_strategy"] },
    });
    attachExplicit(db, candidateId, makeNearAxis0(0.1));

    const summary = await extractCrossCandidateCorroboration(db);
    expect(summary.corroborated).toBe(0);
    void candidateId;
  });

  test("merger_corroboration_credit_weight override changes the emitted weight payload", async () => {
    const db = openDb(":memory:");
    // Default credit weight is 0.3. Seed 0.7 — the emitted
    // candidate_confirmed row must carry weight=0.7, not 0.3.
    seedThresholdPredicate(db, "merger_corroboration_credit_weight", 0.7);

    const promotedId = insertEvent(db, {
      kind: "knowledge_promoted",
      payload: { score: 0.91, goal_shape_tags: ["dispatch_strategy"], claim: "promoted" },
    });
    attachEmbedding(db, promotedId, 0);

    const candidateId = insertEvent(db, {
      kind: "knowledge_candidate",
      payload: { claim: "candidate near promoted", goal_shape_tags: ["dispatch_strategy"] },
    });
    attachExplicit(db, candidateId, makeNearAxis0(0.1));

    const summary = await extractCrossCandidateCorroboration(db);
    expect(summary.corroborated).toBe(1);

    const confirms = db
      .query(
        `SELECT payload FROM events
         WHERE kind = 'candidate_confirmed'
           AND payload LIKE '%"confirmation_source":"semantic_corroboration"%'`,
      )
      .all() as Array<{ payload: string }>;
    expect(confirms.length).toBe(1);
    const p = JSON.parse(confirms[0]!.payload) as Record<string, unknown>;
    expect(p.weight).toBe(0.7);
  });
});

describe("extractClaudeProjectConversations", () => {
  test("imports unread owner messages from Claude project conversation JSONL and skips non-owner rows", async () => {
    const db = openDb(":memory:");
    const root = mkdtempSync(join(tmpdir(), "acc2-claude-projects-"));
    try {
      const projectDir = join(root, "sample-project");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, "conversation.jsonl"), [
        JSON.stringify({ uuid: "u1", type: "user", message: { role: "user", content: [{ type: "text", text: "please fix this" }] } }),
        JSON.stringify({ uuid: "a1", type: "assistant", message: { role: "assistant", content: "working" } }),
      ].join("\n"));

      const first = await extractClaudeProjectConversations(db, root);
      expect(first).toMatchObject({ files_scanned: 1, messages_seen: 2, emitted: 1, skipped_non_owner: 1 });

      const rows = db.query("SELECT payload FROM events WHERE kind = 'owner_input_received'").all() as Array<{ payload: string }>;
      expect(rows).toHaveLength(1);
      const payload = JSON.parse(rows[0]!.payload) as Record<string, unknown>;
      expect(payload.text).toBe("please fix this");
      expect(payload.source).toBe("claude_project_conversation");
      expect(typeof payload.source_dedup_key).toBe("string");

      const second = await extractClaudeProjectConversations(db, root);
      expect(second.emitted).toBe(0);
      expect(second.skipped_duplicate).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("dedups fallback-offset owner messages with the same transcript path, role, and text", async () => {
    const db = openDb(":memory:");
    const root = mkdtempSync(join(tmpdir(), "acc2-claude-projects-"));
    try {
      const projectDir = join(root, "sample-project");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, "conversation.jsonl"), JSON.stringify({ role: "owner", content: "same owner text" }));

      expect((await extractClaudeProjectConversations(db, root)).emitted).toBe(1);
      expect((await extractClaudeProjectConversations(db, root)).skipped_duplicate).toBe(1);
      const count = (db.query("SELECT COUNT(*) AS c FROM events WHERE kind = 'owner_input_received'").get() as { c: number }).c;
      expect(count).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── Off-loop read routing (poolQuery) correctness ──────────────────
//
// The heavy read scans are routed through poolQuery, which off-loads the
// scan to the SQL worker-thread pool when the daemon installed one and
// fail-closes to the synchronous db.query path otherwise. These tests
// prove (a) the off-loop path is actually wired (the spy pool sees the
// extractor's SELECTs) and (b) the off-loop path produces IDENTICAL
// promotions/scores to the sync path (the change moves WHERE the read
// runs, never WHAT it computes).

/** Spy pool delegating to the same db synchronously — stands in for the
 *  real SQL worker-thread pool. Records every SQL string it is asked to
 *  run so a test can assert the extractor routed its heavy scan through
 *  poolQuery rather than the inline sync path. Same db handle ⇒ identical
 *  rows / ordering, so the extractor's computed output is unchanged. */
const makeSpyPool = (db: ReturnType<typeof openDb>) => {
  const seen: string[] = [];
  const pool = {
    seen,
    query: async <T,>(sql: string, params: unknown[] = []): Promise<T[]> => {
      seen.push(sql);
      return db.query(sql).all(...(params as Parameters<ReturnType<typeof db.query>["all"]>)) as T[];
    },
  };
  return pool;
};

describe("extractors — off-loop read routing (poolQuery)", () => {
  test("extractKnowledgePromotions routes its heavy scans through the pool and promotes identically", async () => {
    const db = openDb(":memory:");
    const candidateId = insertEvent(db, { kind: "knowledge_candidate", payload: { text: "off-loop promote" } });
    for (let i = 0; i < 6; i++) {
      insertEvent(db, { kind: "candidate_confirmed", context_refs: [candidateId], payload: { idx: i } });
    }
    const spy = makeSpyPool(db);
    setSqlPool(spy as never);
    try {
      const summary = await extractKnowledgePromotions(db);
      expect(summary.promoted).toBe(1);
      // The candidate scan, promoted-id scan, and verdict scan all routed.
      expect(spy.seen.some((s) => s.includes("kind = 'knowledge_candidate'"))).toBe(true);
      expect(spy.seen.some((s) => s.includes("knowledge_promoted") && s.includes("knowledge_demoted"))).toBe(true);
      expect(spy.seen.some((s) => s.includes("candidate_confirmed") && s.includes("candidate_contradicted"))).toBe(true);
    } finally {
      clearSqlPool();
    }
    const promoted = db.query("SELECT context_refs FROM events WHERE kind = 'knowledge_promoted'").all() as Array<{ context_refs: string }>;
    expect(promoted).toHaveLength(1);
    expect((JSON.parse(promoted[0]!.context_refs) as string[])).toContain(candidateId);
  });

  test("pool path and sync path produce byte-identical promotion payloads", async () => {
    // Build two identical in-memory dbs; run the extractor on one with a
    // spy pool installed and on the other with none. The promotion payloads
    // (wins/losses/score/confidence/alpha/beta) must match exactly.
    const seedDb = (db: ReturnType<typeof openDb>): void => {
      const cid = insertEvent(db, { kind: "knowledge_candidate", payload: { text: "parity" }, ts: new Date(_baseTs).toISOString() });
      for (let i = 0; i < 6; i++) {
        insertEvent(db, { kind: "candidate_confirmed", context_refs: [cid], payload: { idx: i }, ts: new Date(_baseTs).toISOString() });
      }
    };
    const promotionPayload = (db: ReturnType<typeof openDb>): Record<string, unknown> => {
      const row = db.query("SELECT payload FROM events WHERE kind = 'knowledge_promoted'").get() as { payload: string } | null;
      const p = JSON.parse(row!.payload) as Record<string, unknown>;
      // action/scored event ids differ run-to-run; compare only the math.
      const { action_event_id, scored_event_id, candidate_id, ...math } = p;
      void action_event_id; void scored_event_id; void candidate_id;
      return math;
    };

    const dbSync = openDb(":memory:");
    seedDb(dbSync);
    await extractKnowledgePromotions(dbSync);
    const syncMath = promotionPayload(dbSync);

    const dbPool = openDb(":memory:");
    seedDb(dbPool);
    const spy = makeSpyPool(dbPool);
    setSqlPool(spy as never);
    try {
      await extractKnowledgePromotions(dbPool);
    } finally {
      clearSqlPool();
    }
    const poolMath = promotionPayload(dbPool);
    expect(poolMath).toEqual(syncMath);
  });

  test("extractActArtifactScores + extractRecipeCandidates route their heavy scans through the pool", async () => {
    const db = openDb(":memory:");
    insertArtifact(db, "art_offloop");
    insertEvent(db, { kind: "task_committed", directive_id: "d_recipe", payload: {} });
    const spy = makeSpyPool(db);
    setSqlPool(spy as never);
    try {
      await extractActArtifactScores(db);
      await extractRecipeCandidates(db);
      expect(spy.seen.some((s) => s.includes("FROM act_artifact"))).toBe(true);
      expect(spy.seen.some((s) => s.includes("kind = 'task_committed'"))).toBe(true);
    } finally {
      clearSqlPool();
    }
  });
});

describe("extractors — inter-extractor fairness yield", () => {
  test("each routed extractor yields the loop before doing its write work (dispatcher fairness)", async () => {
    // The daemon dispatcher awaits each extractor sequentially. A leading
    // `await extractorFairnessYield()` (setTimeout(0) macrotask) at the top
    // of every extractor body guarantees a macrotask boundary BETWEEN
    // consecutive extractors so one can't chain into uninterrupted loop
    // occupation. Deterministic proof: the extractor cannot have produced its
    // promotion event by the time control returns to us at the FIRST await
    // boundary — because its leading statement surrenders the loop before any
    // read/compute/write runs. (A synchronous extractor would have already
    // written knowledge_promoted before this microtask resumes.)
    const db = openDb(":memory:");
    const candidateId = insertEvent(db, { kind: "knowledge_candidate", payload: { text: "fairness" } });
    for (let i = 0; i < 6; i++) insertEvent(db, { kind: "candidate_confirmed", context_refs: [candidateId] });

    const p = extractKnowledgePromotions(db);
    // Resume on the microtask queue (Promise.resolve) which drains BEFORE any
    // setTimeout(0) macrotask the extractor scheduled at its leading yield.
    await Promise.resolve();
    const midFlight = (db.query("SELECT COUNT(*) AS c FROM events WHERE kind='knowledge_promoted'").get() as { c: number }).c;
    expect(midFlight).toBe(0); // extractor yielded before writing — fairness boundary held

    await p;
    const afterDone = (db.query("SELECT COUNT(*) AS c FROM events WHERE kind='knowledge_promoted'").get() as { c: number }).c;
    expect(afterDone).toBe(1); // and it still completes its promotion
  });

  test("extractActArtifactScores also yields before its write transaction", async () => {
    const db = openDb(":memory:");
    insertArtifact(db, "art_fairness");
    for (let i = 0; i < 25; i++) {
      insertEvent(db, { kind: "action_scored", action_artifact_id: "art_fairness", residual: 0.1 });
    }
    const p = extractActArtifactScores(db);
    await Promise.resolve();
    const midUpdated = (db.query("SELECT score FROM act_artifact WHERE id='art_fairness'").get() as { score: number }).score;
    // Leading fairness yield ⇒ the recompute UPDATE has not run yet (still 0.5 seed).
    expect(midUpdated).toBe(0.5);
    await p;
  });
});

// ── extractArtifactConsolidation (CONSOLIDAT, directive 3XETJCYT) ────
//
// Two equivalent artifacts (same kind + goal_shape + high-similarity
// purpose) → the lower-posterior one is aliased to the higher; citations
// of the loser then resolve to the winner; NON-equivalent pairs (different
// goal_shape / low similarity / incompatible schema / cross-runtime) are
// NOT merged; idempotent (second pass no-ops); no cycle; quarantined
// excluded.
describe("extractArtifactConsolidation", () => {
  // Full-featured artifact insert: posterior + interface_metadata so the
  // consolidation detector can group, judge equivalence, and pick a winner.
  const insertArt = (
    db: ReturnType<typeof openDb>,
    opts: {
      id: string;
      runtime?: string;
      kind?: string;
      sandbox?: unknown;
      status?: string;
      alpha?: number; // observations behind the posterior
      beta?: number;
      score?: number;
      confidence?: number;
      goalShapes?: string[];
      purpose?: string;
      inputsSchema?: unknown;
      outputsSchema?: unknown;
    },
  ): void => {
    const ts = nowIso();
    const meta = {
      purpose: opts.purpose ?? "send a one-off notification to a contact",
      goal_shapes: opts.goalShapes ?? ["notify_contact"],
      ...(opts.inputsSchema !== undefined ? { inputs_schema: opts.inputsSchema } : {}),
      ...(opts.outputsSchema !== undefined ? { outputs_schema: opts.outputsSchema } : {}),
    };
    db.run(
      `INSERT INTO act_artifact (
         id, runtime, kind, body, declared_sandbox, state_root,
         posterior_alpha, posterior_beta, score, confidence,
         recent_residual_mean, recent_kill_count, status, name,
         fixture_input, fixture_expected_residual, interface_metadata,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        opts.id,
        opts.runtime ?? "bun",
        opts.kind ?? "runtime_action",
        "// body " + opts.id + "\nexport default async () => 0;",
        JSON.stringify(opts.sandbox ?? { runtime: opts.runtime ?? "bun", cpu_ms: 1000, wall_ms: 1000, memory_mb: 64 }),
        "state/x",
        opts.alpha ?? 1,
        opts.beta ?? 1,
        opts.score ?? 0.5,
        opts.confidence ?? 0.3,
        0, 0,
        opts.status ?? "admitted",
        null, "{}", 0,
        JSON.stringify(meta),
        ts, ts,
      ],
    );
  };

  // Deterministic embed stub keyed by purpose text: near-identical purposes
  // get near-identical vectors (high cosine); different purposes get
  // orthogonal-ish vectors. No network / API key needed.
  const stubEmbed = (text: string): Promise<Float32Array | null> => {
    const v = new Float32Array(8);
    // "notify"-shaped text → axis 0; "scrape"-shaped → axis 1; else axis 2.
    const lower = text.toLowerCase();
    if (lower.includes("notif") || lower.includes("message") || lower.includes("contact")) {
      v[0] = 1; v[2] = text.length % 7 === 0 ? 0.02 : 0.01; // tiny jitter, stays ~parallel
    } else if (lower.includes("scrape") || lower.includes("page") || lower.includes("record")) {
      v[1] = 1;
    } else {
      v[3] = 1;
    }
    return Promise.resolve(v);
  };

  test("two equivalent artifacts → lower-posterior aliased to higher; citations resolve to winner", async () => {
    const db = openDb(":memory:");
    // Winner: strong posterior, enough observations.
    insertArt(db, { id: "art_win", score: 0.9, confidence: 0.8, alpha: 9, beta: 2 });
    // Loser: weaker posterior, same kind + goal_shape + purpose.
    insertArt(db, { id: "art_lose", score: 0.6, confidence: 0.5, alpha: 3, beta: 4 });

    const summary = await extractArtifactConsolidation(db, stubEmbed);
    expect(summary.consolidated).toBe(1);

    // Loser is aliased to winner → citation resolution redirects.
    expect(resolveArtifactId(db, "art_lose")).toBe("art_win");
    // Winner is untouched (resolves to itself).
    expect(resolveArtifactId(db, "art_win")).toBe("art_win");
    // Loser row is RETIRED (not deleted — append-only, one-way).
    const loserStatus = (db.query("SELECT status FROM act_artifact WHERE id='art_lose'").get() as { status: string }).status;
    expect(loserStatus).toBe("retired");
    expect(db.query("SELECT 1 FROM act_artifact WHERE id='art_lose'").get()).not.toBeNull();
    // Evidence row emitted with winner/loser.
    const ev = db.query("SELECT payload FROM events WHERE kind='act_artifact_consolidated'").get() as { payload: string } | null;
    expect(ev).not.toBeNull();
    const payload = JSON.parse(ev!.payload);
    expect(payload.winner_id).toBe("art_win");
    expect(payload.loser_id).toBe("art_lose");
  });

  test("NON-equivalent: different goal_shape → NOT merged", async () => {
    const db = openDb(":memory:");
    insertArt(db, { id: "art_a", score: 0.9, confidence: 0.8, alpha: 9, beta: 2, goalShapes: ["notify_contact"], purpose: "send a notification" });
    insertArt(db, { id: "art_b", score: 0.6, confidence: 0.5, alpha: 3, beta: 4, goalShapes: ["scrape_page"], purpose: "scrape a web page record" });
    const summary = await extractArtifactConsolidation(db, stubEmbed);
    expect(summary.consolidated).toBe(0);
    expect(resolveArtifactId(db, "art_b")).toBe("art_b");
  });

  test("NON-equivalent: low similarity (same goal_shape, divergent purpose) → NOT merged", async () => {
    const db = openDb(":memory:");
    // Same goal_shape tag but the purpose text embeds onto different axes
    // (one notify-shaped, one scrape-shaped) → cosine below threshold.
    insertArt(db, { id: "art_p", score: 0.9, confidence: 0.8, alpha: 9, beta: 2, goalShapes: ["shared"], purpose: "send a message to a contact" });
    insertArt(db, { id: "art_q", score: 0.6, confidence: 0.5, alpha: 3, beta: 4, goalShapes: ["shared"], purpose: "scrape a product page record" });
    const summary = await extractArtifactConsolidation(db, stubEmbed);
    expect(summary.consolidated).toBe(0);
    expect(resolveArtifactId(db, "art_q")).toBe("art_q");
  });

  test("NON-equivalent: incompatible inputs_schema → NOT merged", async () => {
    const db = openDb(":memory:");
    insertArt(db, { id: "art_s1", score: 0.9, confidence: 0.8, alpha: 9, beta: 2, inputsSchema: { fields: ["chat_id", "text"] } });
    insertArt(db, { id: "art_s2", score: 0.6, confidence: 0.5, alpha: 3, beta: 4, inputsSchema: { fields: ["email", "subject", "body"] } });
    const summary = await extractArtifactConsolidation(db, stubEmbed);
    expect(summary.consolidated).toBe(0);
    expect(resolveArtifactId(db, "art_s2")).toBe("art_s2");
  });

  test("NON-equivalent: different runtime → NOT merged (would break execution)", async () => {
    const db = openDb(":memory:");
    insertArt(db, { id: "art_r1", runtime: "bun", score: 0.9, confidence: 0.8, alpha: 9, beta: 2 });
    insertArt(db, { id: "art_r2", runtime: "python", score: 0.6, confidence: 0.5, alpha: 3, beta: 4 });
    const summary = await extractArtifactConsolidation(db, stubEmbed);
    expect(summary.consolidated).toBe(0);
    expect(resolveArtifactId(db, "art_r2")).toBe("art_r2");
  });

  test("idempotent: second pass no-ops (does not re-alias the same pair)", async () => {
    const db = openDb(":memory:");
    insertArt(db, { id: "art_w2", score: 0.9, confidence: 0.8, alpha: 9, beta: 2 });
    insertArt(db, { id: "art_l2", score: 0.6, confidence: 0.5, alpha: 3, beta: 4 });
    const first = await extractArtifactConsolidation(db, stubEmbed);
    const second = await extractArtifactConsolidation(db, stubEmbed);
    expect(first.consolidated).toBe(1);
    expect(second.consolidated).toBe(0);
    // Exactly ONE alias edge + ONE evidence row.
    const aliasCount = (db.query("SELECT COUNT(*) AS c FROM events WHERE kind='act_artifact_aliased'").get() as { c: number }).c;
    const evCount = (db.query("SELECT COUNT(*) AS c FROM events WHERE kind='act_artifact_consolidated'").get() as { c: number }).c;
    expect(aliasCount).toBe(1);
    expect(evCount).toBe(1);
  });

  test("no cycle: a retired loser is never used as a later winner", async () => {
    const db = openDb(":memory:");
    // Three equivalent artifacts; the strongest wins both pairings, the
    // weakest two are retired INTO it — none aliases back.
    insertArt(db, { id: "art_strong", score: 0.95, confidence: 0.9, alpha: 18, beta: 1 });
    insertArt(db, { id: "art_mid", score: 0.7, confidence: 0.6, alpha: 6, beta: 3 });
    insertArt(db, { id: "art_weak", score: 0.55, confidence: 0.4, alpha: 3, beta: 5 });
    await extractArtifactConsolidation(db, stubEmbed);
    // Every retired loser resolves to the strongest; the winner resolves to
    // itself (no back-edge → no cycle).
    expect(resolveArtifactId(db, "art_strong")).toBe("art_strong");
    expect(resolveArtifactId(db, "art_mid")).toBe("art_strong");
    expect(resolveArtifactId(db, "art_weak")).toBe("art_strong");
    // The winner is never an alias source.
    const winnerAsOld = db.query("SELECT 1 FROM events WHERE kind='act_artifact_aliased' AND json_extract(payload,'$.old_id')='art_strong'").get();
    expect(winnerAsOld).toBeNull();
  });

  test("quarantined artifacts excluded from consolidation", async () => {
    const db = openDb(":memory:");
    // Both quarantined → neither participates (scan filters status).
    insertArt(db, { id: "art_q1", status: "quarantined", score: 0.9, confidence: 0.8, alpha: 9, beta: 2 });
    insertArt(db, { id: "art_q2", status: "quarantined", score: 0.6, confidence: 0.5, alpha: 3, beta: 4 });
    const summary = await extractArtifactConsolidation(db, stubEmbed);
    expect(summary.consolidated).toBe(0);
    // An admitted winner is never allowed to retire INTO a quarantined row:
    // here the would-be winner is quarantined, so the live admitted row is
    // NOT retired against it.
    const db2 = openDb(":memory:");
    insertArt(db2, { id: "art_qwin", status: "quarantined", score: 0.95, confidence: 0.9, alpha: 18, beta: 1 });
    insertArt(db2, { id: "art_alive", status: "admitted", score: 0.6, confidence: 0.5, alpha: 6, beta: 4 });
    const s2 = await extractArtifactConsolidation(db2, stubEmbed);
    expect(s2.consolidated).toBe(0);
    expect(resolveArtifactId(db2, "art_alive")).toBe("art_alive");
  });

  test("winner with too few observations does NOT retire a competitor", async () => {
    const db = openDb(":memory:");
    // Higher score but only 2 observations (below MIN_WINNER_OBS=5).
    insertArt(db, { id: "art_thin", score: 0.95, confidence: 0.9, alpha: 3, beta: 1 });
    insertArt(db, { id: "art_other", score: 0.6, confidence: 0.5, alpha: 1, beta: 1 });
    const summary = await extractArtifactConsolidation(db, stubEmbed);
    expect(summary.consolidated).toBe(0);
  });

  test("bounded scan: pairwise only WITHIN (kind, goal_shape) groups, never cross-group", async () => {
    const db = openDb(":memory:");
    // Two independent equivalence groups; pairs_examined must reflect
    // intra-group comparisons only (1 pair per 2-member group = 2), never
    // the cross-group product (which would be 6 for 4 artifacts).
    insertArt(db, { id: "g1_a", score: 0.9, confidence: 0.8, alpha: 9, beta: 2, goalShapes: ["notify_contact"], purpose: "send a notification message" });
    insertArt(db, { id: "g1_b", score: 0.6, confidence: 0.5, alpha: 3, beta: 4, goalShapes: ["notify_contact"], purpose: "send a notification message" });
    insertArt(db, { id: "g2_a", score: 0.9, confidence: 0.8, alpha: 9, beta: 2, goalShapes: ["scrape_page"], purpose: "scrape a web page record" });
    insertArt(db, { id: "g2_b", score: 0.6, confidence: 0.5, alpha: 3, beta: 4, goalShapes: ["scrape_page"], purpose: "scrape a web page record" });
    const summary = await extractArtifactConsolidation(db, stubEmbed);
    expect(summary.groups_scanned).toBe(2);
    expect(summary.pairs_examined).toBe(2); // 1 per group, NOT 6 cross-group
    expect(summary.consolidated).toBe(2);   // both groups converge
  });
});
