// acc2 substrate extractors tests — proves each extractor is
// deterministic, idempotent, and emits the right derived events for
// canonical input shapes.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "./db";
import {
  extractCodeArtifactScores,
  extractKnowledgePromotions,
  extractRecipeCandidates,
  extractSemanticDedup,
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
});
