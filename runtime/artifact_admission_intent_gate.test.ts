// acc2 artifact admission intent gate — verifies the supersedes pointer
// is dropped when the source directive's intent_class does not match
// atms_report_composition (contract TJGFQC72BX24NE7R8G1JYJPSR8).

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { admitArtifact } from "./artifact_admission";
import { emitEvent, type EmitEventInput } from "./events";
import { getArtifact, insertArtifact } from "./artifact_store";
import type { Database } from "bun:sqlite";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const captureEmit = (sink: EmitEventInput[], db: Database) => (event: EmitEventInput) => {
  sink.push(event);
  emitEvent(db, event);
};

// Insert a stub atms_report_v* row to act as the prior in the chain.
const insertPriorReport = (db: Database, id: string) =>
  insertArtifact(db, {
    id,
    runtime: "bun",
    kind: "atms_report",
    body: "// prior report stub",
    declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
    stateRoot: "test",
    posteriorAlpha: 1, posteriorBeta: 1, score: 0.5, confidence: 0.3,
    recentResidualMean: 0, recentKillCount: 0,
    status: "admitted",
    name: id,
    fixtureInput: null,
    fixtureExpectedResidual: 0.2,
    intent: null, summary: null,
    targetFiles: null, targetResources: null,
    sourceCandidateId: null,
    ownerGateVerdict: "auto",
  });

// Seed a strategic-direction KC so the strategy-first gate (separate from
// the intent gate under test) passes when admitting atms_report_v*.
const seedStrategicKC = (db: Database, directiveId: string): string => {
  const kc = emitEvent(db, {
    kind: "knowledge_candidate",
    directive_id: directiveId,
    task_id: directiveId,
    payload: {
      claim: "vertical_concentration_on_industrial_safety_strategic_direction_chosen",
      evidence: ["S1", "T1"],
    },
  });
  return kc.id;
};

const seedIntentClassified = (
  db: Database,
  directiveId: string,
  intentClass: string,
): void => {
  emitEvent(db, {
    kind: "intent_classified",
    substrate_origin: "substrate_auto",
    directive_id: directiveId,
    task_id: directiveId,
    payload: {
      intent_class: intentClass,
      confidence: 0.85,
      evidence: ["fixture_seed"],
      classifier_version: "test",
      directive_text_hash: "deadbeef",
    },
  });
};

describe("artifact admission intent gate — supersedes routing by intent_class", () => {
  test("admits supersedes when intent_class === atms_report_composition", async () => {
    const db = openDb(":memory:");
    const directiveId = "d_intent_match";
    seedIntentClassified(db, directiveId, "atms_report_composition");
    insertPriorReport(db, "art_prior_match");
    const kcId = seedStrategicKC(db, directiveId);
    const events: EmitEventInput[] = [];

    const result = await admitArtifact(
      db,
      {
        runtime: "bun",
        body: `console.log('@@RESULT@@ ' + JSON.stringify({ ok: true }));`,
        declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
        fixtureInput: null,
        fixtureExpectedResidualBelow: 0.2,
        name: "atms_report_v8",
        citedKnowledgeIds: [kcId],
        supersedes: "art_prior_match",
        governance: { directiveId },
      },
      captureEmit(events, db),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result as { supersedes_dropped?: boolean }).supersedes_dropped).toBeUndefined();
    const row = getArtifact(db, result.artifactId);
    expect(row?.supersedes).toBe("art_prior_match");
    expect(events.some((e) => e.kind === "lane_routing_refused")).toBe(false);
  });

  test("drops supersedes + emits lane_routing_refused when intent_class === system_internals_doc", async () => {
    const db = openDb(":memory:");
    const directiveId = "d_intent_mismatch";
    seedIntentClassified(db, directiveId, "system_internals_doc");
    insertPriorReport(db, "art_prior_mismatch");
    const kcId = seedStrategicKC(db, directiveId);
    const events: EmitEventInput[] = [];

    const result = await admitArtifact(
      db,
      {
        runtime: "bun",
        body: `console.log('@@RESULT@@ ' + JSON.stringify({ ok: true }));`,
        declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
        fixtureInput: null,
        fixtureExpectedResidualBelow: 0.2,
        name: "atms_report_v9",
        citedKnowledgeIds: [kcId],
        supersedes: "art_prior_mismatch",
        governance: { directiveId },
      },
      captureEmit(events, db),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result as { supersedes_dropped?: boolean }).supersedes_dropped).toBe(true);
    const row = getArtifact(db, result.artifactId);
    expect(row?.supersedes).toBeNull();
    const refusals = events.filter((e) => e.kind === "lane_routing_refused");
    expect(refusals.length).toBe(1);
    const payload = refusals[0]!.payload as Record<string, unknown>;
    expect(payload.reason).toBe("intent_class_mismatch");
    expect(payload.refused_kind).toBe("atms_report_v_supersedes");
    expect(payload.observed_intent_class).toBe("system_internals_doc");
    expect(payload.directive_id).toBe(directiveId);
  });

  test("admits supersedes when no intent_classified row exists (back-population exempt)", async () => {
    const db = openDb(":memory:");
    const directiveId = "d_intent_backfill";
    // Intentionally no intent_classified emit.
    insertPriorReport(db, "art_prior_backfill");
    const kcId = seedStrategicKC(db, directiveId);
    const events: EmitEventInput[] = [];

    const result = await admitArtifact(
      db,
      {
        runtime: "bun",
        body: `console.log('@@RESULT@@ ' + JSON.stringify({ ok: true }));`,
        declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
        fixtureInput: null,
        fixtureExpectedResidualBelow: 0.2,
        name: "atms_report_v10",
        citedKnowledgeIds: [kcId],
        supersedes: "art_prior_backfill",
        governance: { directiveId },
      },
      captureEmit(events, db),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result as { supersedes_dropped?: boolean }).supersedes_dropped).toBeUndefined();
    const row = getArtifact(db, result.artifactId);
    expect(row?.supersedes).toBe("art_prior_backfill");
    expect(events.some((e) => e.kind === "lane_routing_refused")).toBe(false);
  });
});
