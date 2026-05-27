// U1 — universal_knowledge_projection. Seeds one row of each of the five
// entity families (artifact / knowledge / lesson / amendment / trajectory) plus
// a scored_entity row for one of them, then asserts:
//   * all five source_kinds project,
//   * capability_properties are populated open arrays,
//   * the scored entity carries a non-null score while an unscored one is null.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "./db";
import { universalKnowledgeProjection } from "./universal_knowledge_projection";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const newId = (): string =>
  crypto.randomUUID().replace(/-/g, "").slice(0, 26).toUpperCase();

const insertEvent = (
  db: ReturnType<typeof openDb>,
  fields: { id: string; kind: string; payload?: unknown; ts: string },
): void => {
  db.run(
    `INSERT INTO events (
       id, ts, directive_id, task_id, loop_id, substrate_origin, kind,
       payload, context_refs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fields.id,
      fields.ts,
      "d_test",
      "t_test",
      "l_test",
      "substrate_auto",
      fields.kind,
      JSON.stringify(fields.payload ?? {}),
      JSON.stringify([]),
    ],
  );
};

const insertArtifact = (
  db: ReturnType<typeof openDb>,
  fields: { id: string; runtime?: string | null; body?: string; ts: string },
): void => {
  db.run(
    `INSERT INTO act_artifact (id, runtime, body, kind, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    [fields.id, fields.runtime ?? null, fields.body ?? "{}", "runtime_action", fields.ts, fields.ts],
  );
};

const insertScoredEntity = (
  db: ReturnType<typeof openDb>,
  fields: { entity_id: string; entity_kind: string; score: number; confidence: number; ts: string },
): void => {
  db.run(
    `INSERT INTO scored_entity (entity_id, entity_kind, posterior_alpha, posterior_beta, score, confidence, updated_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [fields.entity_id, fields.entity_kind, 2.0, 1.0, fields.score, fields.confidence, fields.ts],
  );
};

describe("universalKnowledgeProjection", () => {
  test("projects all five entity families with open capabilities + scored_entity lineage", () => {
    const db = openDb(":memory:");
    const ts = new Date().toISOString();

    // One representative per family.
    const artifactId = "ART_" + newId();
    const knowledgeId = "KN_" + newId();
    const lessonId = "LE_" + newId();
    const amendmentId = "AM_" + newId();
    const trajectoryId = "TR_" + newId();

    // Artifact carries a runtime (→ "executable") and replay linkage in body
    // (→ "replayable") so capability derivation is exercised on the open path.
    insertArtifact(db, {
      id: artifactId,
      runtime: "node",
      body: JSON.stringify({ note: "recipe replay handle" }),
      ts,
    });
    insertEvent(db, { id: knowledgeId, kind: "knowledge_promoted", payload: { claim: "x" }, ts });
    insertEvent(db, { id: lessonId, kind: "lesson_extracted", payload: { lesson: "y" }, ts });
    insertEvent(db, { id: amendmentId, kind: "contract_amendment_proposed", payload: { z: 1 }, ts });
    insertEvent(db, { id: trajectoryId, kind: "trajectory_motif_observed", payload: { motif: [] }, ts });

    // Score ONLY the artifact via the scored_entity lineage; everything else
    // is unscored.
    insertScoredEntity(db, {
      entity_id: artifactId,
      entity_kind: "act_artifact",
      score: 0.82,
      confidence: 0.66,
      ts,
    });

    const projection = universalKnowledgeProjection(db, { limit: 100 });

    // All five source_kinds appear.
    const sourceKinds = new Set(projection.map((r) => r.source_kind));
    for (const expected of ["act_artifact", "knowledge", "lesson", "amendment", "trajectory"]) {
      expect(sourceKinds.has(expected)).toBe(true);
    }

    // capability_properties are populated open arrays for every row.
    for (const row of projection) {
      expect(Array.isArray(row.capability_properties)).toBe(true);
      expect(row.capability_properties.length).toBeGreaterThan(0);
    }

    const byId = new Map(projection.map((r) => [r.entity_id, r]));

    // Artifact: open capability set includes "artifact" + derived "executable" + "replayable".
    const art = byId.get(artifactId)!;
    expect(art.capability_properties).toContain("artifact");
    expect(art.capability_properties).toContain("executable");
    expect(art.capability_properties).toContain("replayable");

    // Family-specific capability tags.
    expect(byId.get(knowledgeId)!.capability_properties).toContain("knowledge");
    expect(byId.get(lessonId)!.capability_properties).toContain("correction");
    expect(byId.get(amendmentId)!.capability_properties).toEqual(
      expect.arrayContaining(["correction", "proposed"]),
    );
    expect(byId.get(trajectoryId)!.capability_properties).toContain("trajectory");

    // Score lineage: the scored artifact carries a non-null score; an unscored
    // entity (the lesson) carries null.
    expect(art.score).toBe(0.82);
    expect(art.score_confidence).toBe(0.66);
    expect(byId.get(lessonId)!.score).toBeNull();
    expect(byId.get(lessonId)!.score_confidence).toBeNull();
  });

  test("respects the per-family limit (bounded query)", () => {
    const db = openDb(":memory:");
    const base = Date.now();
    for (let i = 0; i < 5; i++) {
      insertEvent(db, {
        id: "KN_" + newId(),
        kind: "knowledge_promoted",
        ts: new Date(base + i * 1000).toISOString(),
      });
    }
    const projection = universalKnowledgeProjection(db, { limit: 2 });
    const knowledge = projection.filter((r) => r.source_kind === "knowledge");
    expect(knowledge.length).toBe(2);
  });
});
