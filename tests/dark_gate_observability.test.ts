// acc2 dark-gate observability — pins the four newly-registered event
// kinds emitted by the documented-but-dark gates (contract
// TJGFQC72BX24NE7R8G1JYJPSR8). Two live-path tests verify the
// intent_classified emit at directive ingress and the lane_routing_refused
// emit when the supersedes gate trips.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { admitArtifact } from "../runtime/artifact_admission";
import { emitEvent, type EmitEventInput } from "../runtime/events";
import { insertArtifact } from "../runtime/artifact_store";
import { handleOpenDirective } from "../runtime/mcp_server/substrate_tools";
import type { McpContext } from "../runtime/mcp_server/types";
import type { Database } from "bun:sqlite";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const captureEmit = (sink: EmitEventInput[], db: Database) => (event: EmitEventInput) => {
  sink.push(event);
  emitEvent(db, event);
};

const ctx = (db: ReturnType<typeof openDb>): McpContext =>
  ({ db, invoker: "claude_root" } as McpContext);

describe("dark-gate observability — kind registration", () => {
  test("emitEvent accepts intent_classified, lane_routing_refused, refinement_depth_exceeded, verifier_residual_high", () => {
    const db = openDb(":memory:");
    expect(() =>
      emitEvent(db, {
        kind: "intent_classified",
        substrate_origin: "substrate_auto",
        directive_id: "d_dark_intent",
        task_id: "d_dark_intent",
        payload: {
          intent_class: "ad_hoc",
          confidence: 0.3,
          evidence: [],
          classifier_version: "test",
          directive_text_hash: "abc",
          allowed_artifact_kinds: [],
        },
      }),
    ).not.toThrow();
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
          WHERE kind IN ('intent_classified','lane_routing_refused','refinement_depth_exceeded','verifier_residual_high')
          GROUP BY kind`,
      )
      .all();
    const lookup = new Map(counts.map((r) => [r.kind, r.n]));
    expect(lookup.get("intent_classified")).toBe(1);
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
        name: "atms_report_v_missing_strategy",
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

  test("opening a directive fires intent_classified for the new directive_id", () => {
    const db = openDb(":memory:");
    const opened = handleOpenDirective(ctx(db), {
      directive_text: "Compose atms_report_v11 — Lakeland AI Transformation Roadmap",
    } as never);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const directiveId = (opened.result as Record<string, unknown>).directive_id as string;
    const rows = db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM events WHERE kind = 'intent_classified' AND directive_id = ?",
      )
      .all(directiveId);
    expect(rows.length).toBe(1);
    const payload = JSON.parse(rows[0]!.payload ?? "{}") as Record<string, unknown>;
    expect(payload.intent_class).toBe("atms_report_composition");
  });

  test("admitting an atms_report_v* with mismatched intent_class trips the supersedes gate and emits lane_routing_refused", async () => {
    const db = openDb(":memory:");
    const directiveId = "d_dark_gate_live";
    // Seed an intent_classified row whose class is NOT atms_report_composition.
    emitEvent(db, {
      kind: "intent_classified",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      task_id: directiveId,
      payload: {
        intent_class: "system_internals_doc",
        confidence: 0.85,
        evidence: ["how_the_system_works"],
        classifier_version: "test",
        directive_text_hash: "feedface",
        allowed_artifact_kinds: ["system_internals_doc"],
      },
    });
    // Prior artifact_id the new admission would chain into.
    insertArtifact(db, {
      id: "art_prior_dark",
      runtime: "bun",
      kind: "atms_report",
      body: "// prior",
      declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
      stateRoot: "test",
      posteriorAlpha: 1, posteriorBeta: 1, score: 0.5, confidence: 0.3,
      recentResidualMean: 0, recentKillCount: 0,
      status: "admitted",
      name: "art_prior_dark",
      fixtureInput: null,
      fixtureExpectedResidual: 0.2,
      intent: null, summary: null,
      targetFiles: null, targetResources: null,
      sourceCandidateId: null,
      ownerGateVerdict: "auto",
    });
    // Strategic-direction KC so the strategy-first gate passes.
    const kc = emitEvent(db, {
      kind: "knowledge_candidate",
      directive_id: directiveId,
      task_id: directiveId,
      payload: {
        claim: "vertical_concentration_on_industrial_safety_strategic_direction_chosen",
        evidence: ["S1"],
      },
    });
    const events: EmitEventInput[] = [];
    const result = await admitArtifact(
      db,
      {
        runtime: "bun",
        body: `console.log('@@RESULT@@ ' + JSON.stringify({ ok: true }));`,
        declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
        fixtureInput: null,
        fixtureExpectedResidualBelow: 0.2,
        name: "atms_report_v12",
        citedKnowledgeIds: [kc.id],
        supersedes: "art_prior_dark",
        governance: { directiveId },
      },
      captureEmit(events, db),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const refusals = events.filter((e) => e.kind === "lane_routing_refused");
    expect(refusals.length).toBe(1);
    expect((refusals[0]!.payload as Record<string, unknown>).refused_kind).toBe(
      "atms_report_v_supersedes",
    );
  });
});
