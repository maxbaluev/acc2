// acc2 dark-gate observability — pins the dark event kinds emitted by the
// documented-but-dark structural / verifier gates (contract
// TJGFQC72BX24NE7R8G1JYJPSR8). The intent_classified ingress emit was
// removed (RLM-first: no regex intent pre-classification); the remaining
// gates are structural (predicate gate, strategy-first gate) and emit
// lane_routing_refused / refinement_depth_exceeded / verifier_residual_high.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { admitArtifact } from "../runtime/artifact_admission";
import { emitEvent, type EmitEventInput } from "../runtime/events";
import type { Database } from "bun:sqlite";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const captureEmit = (sink: EmitEventInput[], db: Database) => (event: EmitEventInput) => {
  sink.push(event);
  emitEvent(db, event);
};

describe("dark-gate observability — kind registration", () => {
  // intent_classified was removed (RLM-first: no regex intent
  // pre-classification at ingress), so it is no longer a registered kind.
  // The remaining three dark kinds below are structural / verifier gates,
  // not intent-based, and stay registered.
  test("emitEvent accepts lane_routing_refused, refinement_depth_exceeded, verifier_residual_high", () => {
    const db = openDb(":memory:");
    expect(() =>
      emitEvent(db, {
        kind: "lane_routing_refused",
        substrate_origin: "substrate_auto",
        directive_id: "d_dark_intent",
        payload: {
          reason: "test_seed",
          refused_kind: "atms_report_v_supersedes",
          directive_id: "d_dark_intent",
          observed_intent_class: null,
        },
      }),
    ).not.toThrow();
    expect(() =>
      emitEvent(db, {
        kind: "refinement_depth_exceeded",
        substrate_origin: "substrate_auto",
        directive_id: "d_dark_intent",
        payload: { depth: 6, cap: 5 },
      }),
    ).not.toThrow();
    expect(() =>
      emitEvent(db, {
        kind: "verifier_residual_high",
        substrate_origin: "substrate_auto",
        directive_id: "d_dark_intent",
        payload: { residual: 0.92, verifier_kind: "peer_llm_claude" },
      }),
    ).not.toThrow();

    const counts = db
      .query<{ kind: string; n: number }, []>(
        `SELECT kind, COUNT(*) AS n FROM events
          WHERE kind IN ('lane_routing_refused','refinement_depth_exceeded','verifier_residual_high')
          GROUP BY kind`,
      )
      .all();
    const lookup = new Map(counts.map((r) => [r.kind, r.n]));
    expect(lookup.get("lane_routing_refused")).toBe(1);
    expect(lookup.get("refinement_depth_exceeded")).toBe(1);
    expect(lookup.get("verifier_residual_high")).toBe(1);
  });
});

describe("dark-gate observability — live emission paths", () => {
  test("predicate gate emits predicate_gate_rejected when its body predicate fails", async () => {
    const db = openDb(":memory:");
    const events: EmitEventInput[] = [];
    const result = await admitArtifact(
      db,
      {
        runtime: "bun",
        body: `console.log('@@RESULT@@ ' + JSON.stringify({ headline: "Friction-free onboarding", ok: true }));`,
        declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
        fixtureInput: null,
        fixtureExpectedResidualBelow: 0.2,
        audience: "ceo_buyer",
      },
      captureEmit(events, db),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("predicate_gate_failed");
    const rejections = events.filter((e) => e.kind === "predicate_gate_rejected");
    expect(rejections.length).toBe(1);
  });

  test("strategy gate emits atms_strategy_first_violation when report strategy evidence is missing", async () => {
    const db = openDb(":memory:");
    const events: EmitEventInput[] = [];
    const result = await admitArtifact(
      db,
      {
        runtime: "bun",
        body: `console.log('@@RESULT@@ ' + JSON.stringify({ ok: true, report: 'missing_strategy' }));`,
        declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
        fixtureInput: null,
        fixtureExpectedResidualBelow: 0.2,
        // F4c (2026-05-18): the strategy-first gate now keys on the
        // `artifact_kind_metadata` table. Use `name: "atms_report_v11"` —
        // a seeded grounding-required kind — so the gate fires under
        // the new posterior-scored abstraction.
        name: "atms_report_v11",
        citedKnowledgeIds: [],
      },
      captureEmit(events, db),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("strategy_first_violation_missing_strategic_direction_chosen");
    const violations = events.filter((e) => e.kind === "atms_strategy_first_violation");
    expect(violations.length).toBe(1);
  });
});
