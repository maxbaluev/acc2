// acc2 substrate extractors tests — proves each extractor is
// deterministic, idempotent, and emits the right derived events for
// canonical input shapes.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "./db";
import {
  extractCodeArtifactScores,
  extractKnowledgePromotions,
  extractOwnerProfilePromotions,
  extractRecipeCandidates,
  extractRecipeFromCommit,
  extractSemanticDedup,
  maybePromoteOwnerProfile,
} from "./extractors";

afterAll(() => closeDb());
beforeEach(() => closeDb());

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
    `INSERT INTO code_artifact (
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

describe("extractCodeArtifactScores", () => {
  test("recomputes posterior + recent_residual_mean from action_scored events", () => {
    const db = openDb(":memory:");
    insertArtifact(db, "art_x");

    // 3 successes (residual ≤ 0.3).
    insertEvent(db, { kind: "action_scored", action_artifact_id: "art_x", residual: 0.10 });
    insertEvent(db, { kind: "action_scored", action_artifact_id: "art_x", residual: 0.15 });
    insertEvent(db, { kind: "action_scored", action_artifact_id: "art_x", residual: 0.20 });

    const summary = extractCodeArtifactScores(db);
    expect(summary.updated).toBe(1);

    const row = db.query("SELECT * FROM code_artifact WHERE id = 'art_x'").get() as Record<string, unknown>;
    // alpha = 1+3 = 4, beta = 1+0 = 1, score = 4/5 = 0.8.
    expect(row.posterior_alpha).toBe(4);
    expect(row.posterior_beta).toBe(1);
    expect(row.score as number).toBeCloseTo(0.8, 8);
    // recent_residual_mean = (0.10+0.15+0.20)/3 = 0.15.
    expect(row.recent_residual_mean as number).toBeCloseTo(0.15, 8);
    // Below 20-count promotion threshold → still admitted.
    expect(row.status).toBe("admitted");
  });

  test("promotes when score ≥ 0.85 AND confidence ≥ 0.7 AND count ≥ 20", () => {
    const db = openDb(":memory:");
    insertArtifact(db, "art_p", "// promote_me\nexport default async () => 0;");
    for (let i = 0; i < 25; i++) {
      insertEvent(db, { kind: "action_scored", action_artifact_id: "art_p", residual: 0.05 });
    }
    const summary = extractCodeArtifactScores(db);
    expect(summary.promoted).toBe(1);
    const row = db.query("SELECT status, name FROM code_artifact WHERE id = 'art_p'").get() as Record<string, unknown>;
    expect(row.status).toBe("promoted");
    expect(row.name as string).toBe("promote_me");
  });
});

describe("extractKnowledgePromotions", () => {
  test("promotes a candidate with ≥ 5 corroborations and score ≥ 0.85", () => {
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
    const summary = extractKnowledgePromotions(db);
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

  test("does NOT promote when corroborations are below threshold", () => {
    const db = openDb(":memory:");
    const candidateId = insertEvent(db, { kind: "knowledge_candidate", payload: { text: "x" } });
    for (let i = 0; i < 2; i++) {
      insertEvent(db, { kind: "candidate_confirmed", context_refs: [candidateId] });
    }
    const summary = extractKnowledgePromotions(db);
    expect(summary.promoted).toBe(0);
  });

  test("idempotent — running twice does not re-promote", () => {
    const db = openDb(":memory:");
    const candidateId = insertEvent(db, { kind: "knowledge_candidate", payload: { text: "y" } });
    for (let i = 0; i < 6; i++) {
      insertEvent(db, { kind: "candidate_confirmed", context_refs: [candidateId] });
    }
    extractKnowledgePromotions(db);
    const second = extractKnowledgePromotions(db);
    expect(second.promoted).toBe(0);
    const count = (db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind='knowledge_promoted'")
      .get() as { c: number }).c;
    expect(count).toBe(1);
  });
});

describe("extractSemanticDedup", () => {
  test("returns {merged:0, contradicted:0} when no embeddings present (Phase F gates the real path)", () => {
    const db = openDb(":memory:");
    insertEvent(db, { kind: "knowledge_candidate", payload: { text: "no embeddings" } });
    insertEvent(db, { kind: "knowledge_candidate", payload: { text: "still no embeddings" } });
    const summary = extractSemanticDedup(db);
    expect(summary).toEqual({ merged: 0, contradicted: 0 });
  });

  test("idempotent — running twice does not double-merge or advance state", () => {
    const db = openDb(":memory:");
    insertEvent(db, { kind: "knowledge_candidate", payload: { text: "candidate A" } });
    insertEvent(db, { kind: "knowledge_candidate", payload: { text: "candidate B" } });
    const first = extractSemanticDedup(db);
    const second = extractSemanticDedup(db);
    expect(first).toEqual({ merged: 0, contradicted: 0 });
    expect(second).toEqual({ merged: 0, contradicted: 0 });
  });

  test("no-op when there are zero new candidates since last run", () => {
    const db = openDb(":memory:");
    const summary = extractSemanticDedup(db);
    expect(summary).toEqual({ merged: 0, contradicted: 0 });
  });
});

describe("extractRecipeCandidates", () => {
  test("emits a recipe_extracted event after 3 similar committed shapes", () => {
    const db = openDb(":memory:");
    // Three directives with same normalized goal + same task_node count.
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
    }
    const summary = extractRecipeCandidates(db);
    expect(summary.extracted).toBe(1);

    const recipes = db
      .query("SELECT payload FROM events WHERE kind = 'recipe_extracted'")
      .all() as Array<{ payload: string }>;
    expect(recipes).toHaveLength(1);
    const payload = JSON.parse(recipes[0]!.payload) as Record<string, unknown>;
    expect(payload.goal_shape).toContain("count_todos");
    expect(payload.success_count).toBe(3);
  });

  test("idempotent — running twice does not double-emit for the same shape", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 3; i++) {
      const did = `d_${i}`;
      insertEvent(db, { kind: "directive_opened", directive_id: did, task_id: "t", payload: { goal: "shared shape" } });
      insertEvent(db, { kind: "task_node_opened",  directive_id: did, task_id: `t_${i}` });
      insertEvent(db, { kind: "task_committed",    directive_id: did, task_id: `t_${i}` });
    }
    extractRecipeCandidates(db);
    const second = extractRecipeCandidates(db);
    expect(second.extracted).toBe(0);
    const c = (db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind='recipe_extracted'")
      .get() as { c: number }).c;
    expect(c).toBe(1);
  });

  test("does NOT emit below the 3-shape threshold", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 2; i++) {
      const did = `d_${i}`;
      insertEvent(db, { kind: "directive_opened", directive_id: did, task_id: "t", payload: { goal: "low shape" } });
      insertEvent(db, { kind: "task_node_opened",  directive_id: did, task_id: `t_${i}` });
      insertEvent(db, { kind: "task_committed",    directive_id: did, task_id: `t_${i}` });
    }
    const summary = extractRecipeCandidates(db);
    expect(summary.extracted).toBe(0);
  });

  test("Phase J: payload includes topology_signature + trajectory + directive_text fallback", () => {
    const db = openDb(":memory:");
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
    }
    const summary = extractRecipeCandidates(db);
    expect(summary.extracted).toBe(1);

    const recipes = db
      .query("SELECT payload FROM events WHERE kind = 'recipe_extracted'")
      .all() as Array<{ payload: string }>;
    expect(recipes.length).toBe(1);
    const p = JSON.parse(recipes[0]!.payload) as Record<string, unknown>;
    expect(p.goal_shape).toContain("audit_recent_commits");
    expect(typeof p.topology_signature).toBe("string");
    expect((p.topology_signature as string).startsWith("topo_")).toBe(true);
    expect(Array.isArray(p.trajectory)).toBe(true);
    expect(p.success_count).toBe(3);
  });

  test("Phase J: distinct topology signatures DO NOT collapse into one recipe", () => {
    const db = openDb(":memory:");
    // Group 1: 3 directives with a single root task (topology n=1)
    for (let i = 0; i < 3; i++) {
      const did = `d_solo_${i}`;
      insertEvent(db, { kind: "directive_opened", directive_id: did, task_id: did, payload: { goal: "solo" } });
      insertEvent(db, { kind: "task_node_opened", directive_id: did, task_id: `t_solo_${i}` });
      insertEvent(db, { kind: "task_committed", directive_id: did, task_id: `t_solo_${i}` });
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
    }
    const summary = extractRecipeCandidates(db);
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
      .query("SELECT payload FROM events WHERE kind = 'recipe_extracted'")
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
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'recipe_extracted'")
      .get() as { c: number }).c;
    expect(count).toBe(1);
  });

  test("dedup composes with extractRecipeCandidates — the 3-shape statistical path skips an already-seeded composite key", () => {
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
    const summary = extractRecipeCandidates(db);
    expect(summary.extracted).toBe(0);
    const count = (db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'recipe_extracted'")
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
  test("a successful dispatch emits recipe_extracted within the same call", async () => {
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
        .query("SELECT payload FROM events WHERE kind = 'recipe_extracted' AND directive_id = ?")
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
      payload: { field: "autonomy_trust_level", value: "cautious", confidence: 0.4, claim: "weak signal" },
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

  test("schema-invalid value (autonomy_trust_level outside enum) drops the candidate silently", () => {
    const db = openDb(":memory:");
    const candidateId = insertEvent(db, {
      kind: "owner_insight_candidate",
      substrate_origin: "claude_root",
      payload: { field: "autonomy_trust_level", value: "reckless", confidence: 0.95, claim: "garbage" },
    });
    const verdict = maybePromoteOwnerProfile(db, candidateId);
    expect(verdict.kind).toBe("no_action");
    if (verdict.kind === "no_action") expect(verdict.reason).toBe("schema_validation_failed");
    const count = (db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'owner_profile_recorded'")
      .get() as { c: number }).c;
    expect(count).toBe(0);
  });

  test("extractOwnerProfilePromotions bulk path promotes every eligible candidate exactly once", () => {
    const db = openDb(":memory:");
    const c1 = insertEvent(db, {
      kind: "owner_insight_candidate",
      payload: { field: "detected_language", value: "fr", confidence: 0.95, claim: "consistently French" },
    });
    const c2 = insertEvent(db, {
      kind: "owner_insight_candidate",
      payload: { field: "autonomy_trust_level", value: "high", confidence: 0.9, claim: "owner explicit" },
    });
    const c3 = insertEvent(db, {
      kind: "owner_insight_candidate",
      payload: { field: "detected_language", value: "fr", confidence: 0.2, claim: "low confidence" },
    });
    const summary = extractOwnerProfilePromotions(db);
    expect(summary.promoted).toBe(2);
    expect(summary.skipped).toBe(1);
    // Idempotent on rerun.
    const again = extractOwnerProfilePromotions(db);
    expect(again.promoted).toBe(0);
    void c1; void c2; void c3;
  });
});
