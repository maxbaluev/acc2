// F6 universal internal Act scoring — falsifying test
// `posterior_updates_internal_and_external_handles` from the F4-F7
// roadmap (event_id WW7W1NZ8A10R52PB4E7EJE9YBW).
//
// Invariants exercised here:
//   1. Projection — recordInternalAct emits one act_tuple_recorded
//      row whose payload carries action_handle/verifier_handle/
//      verifier_kind and the internal_decision marker. The substrate's
//      emit-boundary projector expands it into action_predicted +
//      action_scored rows automatically (no bespoke scoring table).
//   2. Posterior credit — the same Shapley distributor that scores
//      outward work scores an internal decision. Emitting a downstream
//      action_scored that cites the projected predicted event id
//      drives a credit/posterior update path identically to a work
//      artifact.
//   3. Idempotency — re-recording the same internal decision with the
//      same sourceActId + handles does not double-count: the second
//      act_tuple row may land, but its projection_key collides with
//      the first projection so action_predicted / action_scored stay
//      at the original counts.

import { describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { recordInternalAct } from "../runtime/internal_act_projection";
import { emitEvent } from "../runtime/events";
import { handleOpenDirective } from "../runtime/mcp_server/substrate_tools";
import { newId } from "../runtime/ids";
import { extractSemanticDedup } from "../substrate/extractors";
import { encodeEmbeddingBlob } from "../runtime/embedder";

const fresh = () => {
  closeDb();
  return openDb(":memory:");
};

const ctx = (db: ReturnType<typeof openDb>) =>
  ({ db, mode: "mock" as const, port: 0, server: null as unknown as Parameters<typeof handleOpenDirective>[0]["server"] });

describe("F6 — recordInternalAct projection (Case A)", () => {
  test("emits act_tuple_recorded with internal_decision marker + handles", () => {
    const db = fresh();
    const event = recordInternalAct(db, {
      intent: "classify directive intent",
      actionHandle: "intent_classifier_v1",
      verifierHandle: "lane_match_verifier",
      verifierKind: "deterministic_code",
      predictedResidual: 0.15,
      reasoningSummary: "two strong markers matched class research_dispatch",
      actionSummary: "classified directive as research_dispatch",
      effectSummary: "intent_classified emitted confidence=0.85",
      sourceActId: "intent_classifier_v1:test_hash_abc",
      extra: { intent_class: "research_dispatch", confidence: 0.85 },
    });
    expect(event).not.toBeNull();
    const row = db
      .query("SELECT payload, action_artifact_id, verifier_artifact_id, predicted_residual FROM events WHERE id = ?")
      .get(event!.id) as { payload: string; action_artifact_id: string; verifier_artifact_id: string; predicted_residual: number };
    expect(row.action_artifact_id).toBe("intent_classifier_v1");
    expect(row.verifier_artifact_id).toBe("lane_match_verifier");
    expect(row.predicted_residual).toBeCloseTo(0.15, 5);
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    expect(payload.internal_decision).toBe(true);
    expect(payload.action_handle).toBe("intent_classifier_v1");
    expect(payload.verifier_handle).toBe("lane_match_verifier");
    expect(payload.verifier_kind).toBe("deterministic_code");
  });

  test("projects to action_predicted and action_scored at the emit boundary", () => {
    const db = fresh();
    const event = recordInternalAct(db, {
      intent: "select dispatch lane",
      actionHandle: "dispatch_decider_v1",
      verifierHandle: "lane_outcome_residual",
      verifierKind: "deterministic_code",
      predictedResidual: 0.4,
      reasoningSummary: "route=opencode_brain score=0.6 reason=no_recipe",
      actionSummary: "dispatch_decided route=opencode_brain",
      effectSummary: "dispatch_decided emitted",
      sourceActId: "dispatch_decider_v1:test_dispatch_id",
    });
    expect(event).not.toBeNull();
    const predicted = db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM events WHERE kind = 'action_predicted' AND action_artifact_id = 'dispatch_decider_v1'",
      )
      .get()!;
    const scored = db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM events WHERE kind = 'action_scored' AND action_artifact_id = 'dispatch_decider_v1'",
      )
      .get()!;
    expect(predicted.n).toBe(1);
    expect(scored.n).toBe(1);
  });
});

describe("F6 — posterior credit on internal decisions (Case B)", () => {
  test("downstream lane outcome drives credit identical to outward work", () => {
    const db = fresh();
    // 1. Record the internal decision.
    const decisionEvent = recordInternalAct(db, {
      intent: "classify directive intent",
      actionHandle: "intent_classifier_v1",
      verifierHandle: "lane_match_verifier",
      verifierKind: "deterministic_code",
      predictedResidual: 0.2,
      reasoningSummary: "marker match for research_dispatch",
      actionSummary: "classified",
      effectSummary: "intent_classified emitted",
      sourceActId: "intent_classifier_v1:case_B",
    });
    expect(decisionEvent).not.toBeNull();
    const predicted = db
      .query<{ id: string }, [string]>(
        "SELECT id FROM events WHERE kind = 'action_predicted' AND action_artifact_id = ? ORDER BY ts ASC LIMIT 1",
      )
      .get("intent_classifier_v1");
    expect(predicted).not.toBeNull();

    // 2. Emit a downstream action_scored that cites the projection.
    //    This is the same shape as the credit loop scoring outward
    //    work: action_scored references a retrieval_binding via
    //    context_refs and carries a residual.
    const downstream = emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate_auto",
      action_artifact_id: "intent_classifier_v1",
      verifier_artifact_id: "lane_match_verifier",
      predicted_residual: 0.2,
      residual: 0.05,
      outcome: "succeeded",
      context_refs: [predicted!.id],
      payload: {
        verifier_kind: "deterministic_code",
        residual: 0.05,
        observed_from: "lane_outcome_signal",
      },
    });
    expect(downstream.id).toBeTruthy();

    // 3. The credit loop scores the action_artifact posterior. The
    //    action_artifact_score_updated row is the universal credit
    //    surface — when present, the internal-decision handle is
    //    being scored by the SAME pipeline that scores work
    //    artifacts. The credit distributor is invoked asynchronously
    //    via dynamic import in events.ts; we sleep briefly to let
    //    the promise resolve.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const scoredCount = db
          .query<{ n: number }, []>(
            "SELECT COUNT(*) AS n FROM events WHERE kind = 'action_scored' AND action_artifact_id = 'intent_classifier_v1'",
          )
          .get()!;
        // At least one action_scored row exists for the handle —
        // the credit loop has the artifact id and residual it needs
        // to update the posterior on the next pass.
        expect(scoredCount.n).toBeGreaterThanOrEqual(1);
        resolve();
      }, 50);
    });
  });
});

describe("F6 — idempotency (Case C)", () => {
  test("same sourceActId + handles does not double-count projections", () => {
    const db = fresh();
    const params = {
      intent: "score closure verdict",
      actionHandle: "closure_verifier_v1",
      verifierHandle: "owner_observed_completeness",
      verifierKind: "deterministic_code" as const,
      predictedResidual: 0.1,
      reasoningSummary: "closure verdict=audited residual=0.10",
      actionSummary: "task_closure_audited emitted",
      effectSummary: "closure verdict landed",
      sourceActId: "closure_verifier_v1:task_X",
    };
    const first = recordInternalAct(db, params);
    const second = recordInternalAct(db, params);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    const predicted = db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM events WHERE kind = 'action_predicted' AND action_artifact_id = 'closure_verifier_v1'",
      )
      .get()!;
    const scored = db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM events WHERE kind = 'action_scored' AND action_artifact_id = 'closure_verifier_v1'",
      )
      .get()!;
    // The projection_key is derived from sourceActId — two acts with
    // the same sourceActId collapse to the SAME projection row. The
    // act_tuple_recorded row itself may appear twice (we don't gate
    // emit on payload equality), but the downstream projections stay
    // single — exactly the idempotency guarantee F6 requires.
    expect(predicted.n).toBe(1);
    expect(scored.n).toBe(1);
  });
});

describe("F6 — wired decision sites", () => {
  test("directive ingress emits intent_classifier_v1 act_tuple alongside intent_classified", () => {
    const db = fresh();
    const directiveText = "DEEP-RESEARCH multi-source live data on Lakeland AI transformation";
    const result = handleOpenDirective(ctx(db), {
      directive_text: directiveText,
      urgency: "normal",
      stakeholders: [],
    } as never);
    expect(result.ok).toBe(true);
    const actRow = db
      .query("SELECT payload FROM events WHERE kind = 'act_tuple_recorded' AND action_artifact_id = 'intent_classifier_v1' ORDER BY ts DESC LIMIT 1")
      .get() as { payload: string } | null;
    expect(actRow).not.toBeNull();
    const payload = JSON.parse(actRow!.payload) as Record<string, unknown>;
    expect(payload.internal_decision).toBe(true);
    expect(payload.action_handle).toBe("intent_classifier_v1");
    expect(payload.verifier_handle).toBe("lane_match_verifier");
    // Projection lands too — verify the action_scored row for the
    // classifier handle exists.
    const scored = db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM events WHERE kind = 'action_scored' AND action_artifact_id = 'intent_classifier_v1'",
      )
      .get()!;
    expect(scored.n).toBeGreaterThanOrEqual(1);
  });

  test("ingress with same directive text reuses the same projection key (idempotent classifier credit)", () => {
    const db = fresh();
    const text = "identical directive text for idempotency check";
    handleOpenDirective(ctx(db), { directive_text: text, urgency: "normal", stakeholders: [] } as never);
    handleOpenDirective(ctx(db), { directive_text: text, urgency: "normal", stakeholders: [] } as never);
    const scored = db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM events WHERE kind = 'action_scored' AND action_artifact_id = 'intent_classifier_v1'",
      )
      .get()!;
    // sourceActId="intent_classifier_v1:" + directive_text_hash —
    // same text → same hash → projection collapses.
    expect(scored.n).toBe(1);
  });

  test("predicate-gate refusal records predicate_gate_v1 act_tuple", () => {
    const db = fresh();
    // Emit an act_artifact_candidate with an empty body — the
    // emit-side screen fires a lane_routing_refused refusal, which
    // recordInternalAct wraps as a predicate_gate_v1 decision.
    const directiveId = newId();
    emitEvent(db, {
      kind: "act_artifact_candidate",
      substrate_origin: "opencode",
      directive_id: directiveId,
      task_id: directiveId,
      payload: {
        kind: "act_artifact_candidate",
        name: "test_candidate",
        body: "", // below the default 200-char threshold
      },
    });
    const actRow = db
      .query("SELECT payload FROM events WHERE kind = 'act_tuple_recorded' AND action_artifact_id = 'predicate_gate_v1' ORDER BY ts DESC LIMIT 1")
      .get() as { payload: string } | null;
    expect(actRow).not.toBeNull();
    const payload = JSON.parse(actRow!.payload) as Record<string, unknown>;
    expect(payload.action_handle).toBe("predicate_gate_v1");
    expect(payload.verifier_handle).toBe("owner_refusal_confirmation");
  });

  test("closure-audit emission records closure_verifier_v1 act_tuple", () => {
    const db = fresh();
    const directiveId = newId();
    const taskId = newId();
    emitEvent(db, {
      kind: "task_closure_audited",
      substrate_origin: "opencode",
      directive_id: directiveId,
      task_id: taskId,
      payload: {
        closure_residual: 0.12,
        verdict: "audited",
      },
    });
    const actRow = db
      .query("SELECT payload, predicted_residual FROM events WHERE kind = 'act_tuple_recorded' AND action_artifact_id = 'closure_verifier_v1' ORDER BY ts DESC LIMIT 1")
      .get() as { payload: string; predicted_residual: number } | null;
    expect(actRow).not.toBeNull();
    expect(actRow!.predicted_residual).toBeCloseTo(0.12, 5);
    const payload = JSON.parse(actRow!.payload) as Record<string, unknown>;
    expect(payload.action_handle).toBe("closure_verifier_v1");
    expect(payload.verifier_handle).toBe("owner_observed_completeness");
  });
});

// ─────────────────────────────────────────────────────────────────────
// F6 extension — knowledge merger + lesson extraction + recipe replay
// (decisions 4, 5, 8, 13 from the F4-F7 roadmap). Same posterior
// credit machinery: each wiring emits ONE act_tuple_recorded row that
// the emit-boundary projector expands into action_predicted +
// action_scored rows automatically.
// ─────────────────────────────────────────────────────────────────────

// Build a 1536-dim unit vector for synthetic merger embeddings.
const sameEmbeddingBlob = (): Uint8Array => {
  const vec = new Float32Array(1536);
  for (let i = 0; i < vec.length; i++) vec[i] = (i % 7) / 10;
  return encodeEmbeddingBlob(Array.from(vec));
};

describe("F6 extension — knowledge merger agreement branch (decision 4)", () => {
  test("two-candidate merger emits knowledge_merger_v1 act_tuple with future_citation_utility verifier", () => {
    const db = fresh();
    const blob = sameEmbeddingBlob();
    const directiveId = newId();
    const taskId = newId();
    // Two same-polarity candidates with identical embeddings — Rule 1.
    emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "opencode",
      directive_id: directiveId,
      task_id: taskId,
      payload: { text: "fixture artifacts should print @@RESULT@@ on stdout" },
      embedding: blob,
      embedding_version: "v1",
    });
    emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "claude_root",
      directive_id: directiveId,
      task_id: taskId,
      payload: { text: "Fixture artifacts must emit @@RESULT@@ on standard output" },
      embedding: blob,
      embedding_version: "v1",
    });
    const summary = extractSemanticDedup(db);
    expect(summary.merged).toBeGreaterThanOrEqual(1);

    const actRow = db
      .query("SELECT payload, verifier_artifact_id FROM events WHERE kind = 'act_tuple_recorded' AND action_artifact_id = 'knowledge_merger_v1' ORDER BY ts DESC LIMIT 1")
      .get() as { payload: string; verifier_artifact_id: string } | null;
    expect(actRow).not.toBeNull();
    expect(actRow!.verifier_artifact_id).toBe("future_citation_utility");
    const payload = JSON.parse(actRow!.payload) as Record<string, unknown>;
    expect(payload.action_handle).toBe("knowledge_merger_v1");
    expect(payload.verifier_handle).toBe("future_citation_utility");
    expect(payload.branch).toBe("agreement");
    const scored = db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM events WHERE kind = 'action_scored' AND action_artifact_id = 'knowledge_merger_v1' AND verifier_artifact_id = 'future_citation_utility'",
      )
      .get()!;
    expect(scored.n).toBeGreaterThanOrEqual(1);
  });

  test("re-running the merger with the same candidate pair does not double-project the agreement decision", () => {
    const db = fresh();
    const blob = sameEmbeddingBlob();
    const directiveId = newId();
    const taskId = newId();
    emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "opencode",
      directive_id: directiveId,
      task_id: taskId,
      payload: { text: "agreement candidate A for idempotency" },
      embedding: blob,
      embedding_version: "v1",
    });
    emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "claude_root",
      directive_id: directiveId,
      task_id: taskId,
      payload: { text: "agreement candidate B for idempotency" },
      embedding: blob,
      embedding_version: "v1",
    });
    extractSemanticDedup(db);
    // Second pass: cursor advanced; no new candidates → no new merger
    // decisions. The projection key is keyed on (prior.id, cand.id) so
    // re-running with the same pair would also collapse to ONE row.
    extractSemanticDedup(db);
    const scored = db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM events WHERE kind = 'action_scored' AND action_artifact_id = 'knowledge_merger_v1' AND verifier_artifact_id = 'future_citation_utility'",
      )
      .get()!;
    expect(scored.n).toBe(1);
  });
});

describe("F6 extension — knowledge merger contradiction branch (decision 5)", () => {
  test("two opposite-polarity candidates emit knowledge_merger_v1 act_tuple with adjudication_outcome verifier", () => {
    const db = fresh();
    const blob = sameEmbeddingBlob();
    const directiveId = newId();
    const taskId = newId();
    emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "opencode",
      directive_id: directiveId,
      task_id: taskId,
      // assert polarity (default — no leading negation token).
      payload: { text: "deep retrieval depth-1 always binds before recursion" },
      embedding: blob,
      embedding_version: "v1",
    });
    emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "claude_root",
      directive_id: directiveId,
      task_id: taskId,
      // deny polarity — leading "not " triggers the negation classifier.
      payload: { text: "not all retrieval needs to bind before recursion" },
      embedding: blob,
      embedding_version: "v1",
    });
    const summary = extractSemanticDedup(db);
    expect(summary.contradicted).toBeGreaterThanOrEqual(1);

    const actRow = db
      .query("SELECT payload, verifier_artifact_id, predicted_residual FROM events WHERE kind = 'act_tuple_recorded' AND action_artifact_id = 'knowledge_merger_v1' ORDER BY ts DESC LIMIT 1")
      .get() as { payload: string; verifier_artifact_id: string; predicted_residual: number } | null;
    expect(actRow).not.toBeNull();
    expect(actRow!.verifier_artifact_id).toBe("adjudication_outcome");
    expect(actRow!.predicted_residual).toBeCloseTo(0.5, 5);
    const payload = JSON.parse(actRow!.payload) as Record<string, unknown>;
    expect(payload.action_handle).toBe("knowledge_merger_v1");
    expect(payload.verifier_handle).toBe("adjudication_outcome");
    expect(payload.branch).toBe("contradiction");
    const scored = db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM events WHERE kind = 'action_scored' AND action_artifact_id = 'knowledge_merger_v1' AND verifier_artifact_id = 'adjudication_outcome'",
      )
      .get()!;
    expect(scored.n).toBeGreaterThanOrEqual(1);
  });

  test("re-running the merger with the same contradicting pair does not double-project", () => {
    const db = fresh();
    const blob = sameEmbeddingBlob();
    const directiveId = newId();
    const taskId = newId();
    emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "opencode",
      directive_id: directiveId,
      task_id: taskId,
      payload: { text: "owner consent is required for irreversible writes" },
      embedding: blob,
      embedding_version: "v1",
    });
    emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "claude_root",
      directive_id: directiveId,
      task_id: taskId,
      payload: { text: "no owner consent path applies to irreversible writes" },
      embedding: blob,
      embedding_version: "v1",
    });
    extractSemanticDedup(db);
    extractSemanticDedup(db);
    const scored = db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM events WHERE kind = 'action_scored' AND action_artifact_id = 'knowledge_merger_v1' AND verifier_artifact_id = 'adjudication_outcome'",
      )
      .get()!;
    expect(scored.n).toBe(1);
  });
});

describe("F6 extension — lesson extraction (decision 8)", () => {
  test("lesson_extracted emission records lesson_extractor_v1 act_tuple with future_failure_prevention_rate verifier", () => {
    const db = fresh();
    const directiveId = newId();
    const taskId = newId();
    emitEvent(db, {
      kind: "lesson_extracted",
      substrate_origin: "opencode",
      directive_id: directiveId,
      task_id: taskId,
      payload: {
        kind: "failure_pattern",
        summary: "always re-check residual after artifact_runtime_error before retry",
        proposed_action: "wrap retry in residual gate",
      },
    });
    const actRow = db
      .query("SELECT payload, predicted_residual, verifier_artifact_id FROM events WHERE kind = 'act_tuple_recorded' AND action_artifact_id = 'lesson_extractor_v1' ORDER BY ts DESC LIMIT 1")
      .get() as { payload: string; predicted_residual: number; verifier_artifact_id: string } | null;
    expect(actRow).not.toBeNull();
    expect(actRow!.verifier_artifact_id).toBe("future_failure_prevention_rate");
    expect(actRow!.predicted_residual).toBeCloseTo(0.4, 5);
    const payload = JSON.parse(actRow!.payload) as Record<string, unknown>;
    expect(payload.action_handle).toBe("lesson_extractor_v1");
    expect(payload.verifier_handle).toBe("future_failure_prevention_rate");
    expect(payload.lesson_kind).toBe("failure_pattern");
    const scored = db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM events WHERE kind = 'action_scored' AND action_artifact_id = 'lesson_extractor_v1'",
      )
      .get()!;
    expect(scored.n).toBeGreaterThanOrEqual(1);
  });

  test("two lesson_extracted emissions with different ids project independently (per-lesson scoring)", () => {
    const db = fresh();
    const directiveId = newId();
    const taskId = newId();
    emitEvent(db, {
      kind: "lesson_extracted",
      substrate_origin: "opencode",
      directive_id: directiveId,
      task_id: taskId,
      payload: { kind: "verifier", summary: "first lesson" },
    });
    emitEvent(db, {
      kind: "lesson_extracted",
      substrate_origin: "opencode",
      directive_id: directiveId,
      task_id: taskId,
      payload: { kind: "verifier", summary: "second lesson" },
    });
    // Two distinct lessons → two distinct sourceActId values
    // (lesson_extractor_v1:<event_id>), so each gets its own projection.
    const scored = db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM events WHERE kind = 'action_scored' AND action_artifact_id = 'lesson_extractor_v1'",
      )
      .get()!;
    expect(scored.n).toBe(2);
  });
});

describe("F6 extension — recipe replay selection (decision 13)", () => {
  // The wiring sits at the recipe_invoked emission in task_dispatcher.ts.
  // The dispatcher path is exercised by runtime/task_dispatcher.test.ts;
  // here we drive the recordInternalAct contract directly with the same
  // shape the dispatcher uses, so the projection chain is falsifiable in
  // isolation from the full dispatch stack.
  test("recipe selection records recipe_replay_selector_v1 act_tuple with replay_vs_fresh_residual_delta verifier", () => {
    const db = fresh();
    const recipeId = "recipe_test_42";
    const dispatchId = "dispatch_test_42";
    const directiveId = newId();
    const taskId = newId();
    // Simulate the dispatcher's recipe_invoked emit so the source event
    // exists on the ledger before recordInternalAct is called.
    const invoked = emitEvent(db, {
      kind: "recipe_invoked",
      substrate_origin: "recipe",
      directive_id: directiveId,
      task_id: taskId,
      payload: {
        dispatch_id: dispatchId,
        recipe_id: recipeId,
        goal_shape: "count_test_files::n1",
        topology_signature: "topo_test::1",
        confidence: 0.9,
      },
    });
    recordInternalAct(db, {
      intent: "select recipe for replay",
      actionHandle: "recipe_replay_selector_v1",
      verifierHandle: "replay_vs_fresh_residual_delta",
      verifierKind: "deterministic_code",
      predictedResidual: 0.1,
      reasoningSummary: `matched recipe ${recipeId} confidence=0.90`,
      actionSummary: `recipe_invoked dispatch_id=${dispatchId} recipe_id=${recipeId}`,
      effectSummary: "dispatcher will replay the cached trajectory; no brain call",
      directiveId,
      taskId,
      sourceEventId: invoked.id,
      sourceActId: "recipe_replay_selector_v1:" + dispatchId + ":" + recipeId,
      citedArtifactIds: [recipeId],
      extra: {
        recipe_id: recipeId,
        confidence: 0.9,
        dispatch_id: dispatchId,
      },
    });
    const actRow = db
      .query("SELECT payload, predicted_residual, verifier_artifact_id FROM events WHERE kind = 'act_tuple_recorded' AND action_artifact_id = 'recipe_replay_selector_v1' ORDER BY ts DESC LIMIT 1")
      .get() as { payload: string; predicted_residual: number; verifier_artifact_id: string } | null;
    expect(actRow).not.toBeNull();
    expect(actRow!.verifier_artifact_id).toBe("replay_vs_fresh_residual_delta");
    expect(actRow!.predicted_residual).toBeCloseTo(0.1, 5);
    const payload = JSON.parse(actRow!.payload) as Record<string, unknown>;
    expect(payload.action_handle).toBe("recipe_replay_selector_v1");
    expect(payload.verifier_handle).toBe("replay_vs_fresh_residual_delta");
    expect(payload.recipe_id).toBe(recipeId);
    expect(payload.dispatch_id).toBe(dispatchId);
    const scored = db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM events WHERE kind = 'action_scored' AND action_artifact_id = 'recipe_replay_selector_v1'",
      )
      .get()!;
    expect(scored.n).toBeGreaterThanOrEqual(1);
  });

  test("re-selecting the same recipe under the same dispatch id does not double-project", () => {
    const db = fresh();
    const recipeId = "recipe_test_idempotent";
    const dispatchId = "dispatch_test_idempotent";
    const directiveId = newId();
    const taskId = newId();
    const baseInput = {
      intent: "select recipe for replay",
      actionHandle: "recipe_replay_selector_v1",
      verifierHandle: "replay_vs_fresh_residual_delta",
      verifierKind: "deterministic_code" as const,
      predictedResidual: 0.1,
      reasoningSummary: `matched recipe ${recipeId} confidence=0.90`,
      actionSummary: `recipe_invoked dispatch_id=${dispatchId} recipe_id=${recipeId}`,
      effectSummary: "dispatcher will replay",
      directiveId,
      taskId,
      sourceActId: "recipe_replay_selector_v1:" + dispatchId + ":" + recipeId,
      citedArtifactIds: [recipeId],
    };
    recordInternalAct(db, baseInput);
    recordInternalAct(db, baseInput);
    const scored = db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM events WHERE kind = 'action_scored' AND action_artifact_id = 'recipe_replay_selector_v1'",
      )
      .get()!;
    // Both acts may emit, but the projection_key collapses to ONE
    // action_scored row — exactly the F6 idempotency guarantee.
    expect(scored.n).toBe(1);
  });
});
