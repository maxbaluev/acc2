// F4c — knowledge-scored strategy-first gate tests
// Contract 897XTN2GF11XB9D4N45N2R9W58; design KCs Q5JBEYJ9GS5D35J7EF3YWQ7NS4
// (strategic_artifact_detection_property_v1) and P2EBADX3JD7A3EQ5ZDK8VGS5JR
// (strategy_first_kind_posterior_design).
//
// The strategy-first grounding rule is now keyed by a posterior-scored
// `artifact_kind_metadata` row, not by a hard-coded `atms_report_v*`
// prefix. These tests cover:
//   A. legacy high-prior kind + missing strategy citation → admission refused
//   B. kind with needs_strategic_grounding below threshold → admission allowed
//   C. brand-new kind with no metadata row → admission allowed (zero domain leakage)
//   D. owner-confirmation of decorative-citation refusal bumps posterior_alpha
//
// Falsifying test name: `strategy_first_property_learned_from_owner_rejection`.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { admitArtifact } from "../runtime/artifact_admission";
import { emitEvent, type EmitEventInput } from "../runtime/events";
import {
  getArtifactKindMetadata,
  recordOwnerConfirmedRefusal,
  requiresStrategicGrounding,
  upsertArtifactKindMetadata,
} from "../substrate/artifact_kind_metadata";
import type { Database } from "bun:sqlite";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const captureEmit = (sink: EmitEventInput[], db: Database) => (event: EmitEventInput) => {
  sink.push(event);
  emitEvent(db, event);
};

describe("F4c — knowledge-scored strategy-first gate", () => {
  test("A: legacy seeded kind (needs_strategic_grounding=1.0) + missing citation → admission refused", async () => {
    const db = openDb(":memory:");
    const meta = getArtifactKindMetadata(db, "atms_report_v9");
    expect(meta).not.toBeNull();
    expect(meta!.needs_strategic_grounding).toBe(1.0);

    const events: EmitEventInput[] = [];
    const body = `console.log('@@RESULT@@ ' + JSON.stringify({ ok: true }));`;
    const result = await admitArtifact(
      db,
      {
        runtime: "bun",
        body,
        declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
        fixtureInput: null,
        fixtureExpectedResidualBelow: 0.2,
        kind: "atms_report_v9",
        name: "lakeland_industries_ai_transformation_report_v9",
        citedKnowledgeIds: [],
      },
      captureEmit(events, db),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("strategy_first_violation_missing_strategic_direction_chosen");
    const violations = events.filter((e) => e.kind === "atms_strategy_first_violation");
    expect(violations.length).toBe(1);
    const payload = violations[0]!.payload as Record<string, unknown>;
    expect(payload.matched_kind).toBe("atms_report_v9");
  });

  test("B: kind with needs_strategic_grounding=0.3 (below threshold) → admission allowed without citation", async () => {
    const db = openDb(":memory:");
    upsertArtifactKindMetadata(db, {
      artifact_kind: "exploratory_synthesis_v1",
      needs_strategic_grounding: 0.3,
      posterior_alpha: 1.5,
      posterior_beta: 3.5,
    });
    const hit = requiresStrategicGrounding(db, {
      kind: "exploratory_synthesis_v1",
      name: null,
    });
    expect(hit.required).toBe(false);

    const events: EmitEventInput[] = [];
    const body = `console.log('@@RESULT@@ ' + JSON.stringify({ ok: true }));`;
    const result = await admitArtifact(
      db,
      {
        runtime: "bun",
        body,
        declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
        fixtureInput: null,
        fixtureExpectedResidualBelow: 0.2,
        kind: "exploratory_synthesis_v1",
        name: "exploratory_synthesis_v1_pilot",
        citedKnowledgeIds: [],
      },
      captureEmit(events, db),
    );
    expect(result.ok).toBe(true);
    expect(events.some((e) => e.kind === "atms_strategy_first_violation")).toBe(false);
  });

  test("C: new artifact_kind with no metadata row → admission allowed (zero domain leakage)", async () => {
    const db = openDb(":memory:");
    const hit = requiresStrategicGrounding(db, {
      kind: "never_before_seen_kind",
      name: "totally_novel_artifact_v1",
    });
    expect(hit.required).toBe(false);
    expect(getArtifactKindMetadata(db, "never_before_seen_kind")).toBeNull();

    const events: EmitEventInput[] = [];
    const body = `console.log('@@RESULT@@ ' + JSON.stringify({ ok: true }));`;
    const result = await admitArtifact(
      db,
      {
        runtime: "bun",
        body,
        declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
        fixtureInput: null,
        fixtureExpectedResidualBelow: 0.2,
        kind: "never_before_seen_kind",
        name: "totally_novel_artifact_v1",
        citedKnowledgeIds: [],
      },
      captureEmit(events, db),
    );
    expect(result.ok).toBe(true);
    expect(events.some((e) => e.kind === "atms_strategy_first_violation")).toBe(false);
  });

  test("D — strategy_first_property_learned_from_owner_rejection: owner-confirmed decorative_citation refusal bumps posterior_alpha on the kind", () => {
    const db = openDb(":memory:");
    const kindUnderTest = "owner_taught_strategic_kind_v1";
    expect(getArtifactKindMetadata(db, kindUnderTest)).toBeNull();

    // First owner confirmation — creates the row with α=2, β=1 from priors.
    const first = recordOwnerConfirmedRefusal(db, {
      artifact_kind: kindUnderTest,
      refused_event_id: "refused_evt_1",
      owner_observation_event_id: "owner_obs_evt_1",
    });
    expect(first.posterior_alpha).toBeCloseTo(2.0, 6);
    expect(first.posterior_beta).toBeCloseTo(1.0, 6);
    // Beta mean 2/(2+1) ≈ 0.667 — already above the 0.5 threshold.
    expect(first.needs_strategic_grounding).toBeGreaterThan(0.5);

    // Second confirmation — further bumps.
    const second = recordOwnerConfirmedRefusal(db, {
      artifact_kind: kindUnderTest,
      refused_event_id: "refused_evt_2",
      owner_observation_event_id: "owner_obs_evt_2",
    });
    expect(second.posterior_alpha).toBeCloseTo(3.0, 6);
    expect(second.needs_strategic_grounding).toBeCloseTo(3 / 4, 6);

    // The strategic-grounding gate now refuses this kind without citations.
    const hit = requiresStrategicGrounding(db, { kind: kindUnderTest, name: null });
    expect(hit.required).toBe(true);
    expect(hit.matched_kind).toBe(kindUnderTest);

    // Two artifact_kind_strategic_grounding_updated events should be on the ledger.
    const updates = db
      .query<{ c: number }, []>(
        "SELECT COUNT(*) AS c FROM events WHERE kind = 'artifact_kind_strategic_grounding_updated'",
      )
      .get();
    expect(updates!.c).toBe(2);
  });
});
