// Tests for runtime/events.ts emit-boundary gates.
//
// Two structural invariants enforced at emit-time:
//   (1) unknown_event_kind: refuse kinds not in EVENT_KINDS (covered by
//       existing substrate/event_kinds tests via the wire boundary).
//   (2) terminal_event_conflict: a task may have AT MOST ONE terminal
//       event (task_committed OR task_failed). Pre-fix the dispatcher's
//       refinement-depth-cap path emitted task_failed even when the
//       brain had already emitted task_committed via MCP — two
//       conflicting terminals for the same task corrupted classification
//       (dispatch_resolved_view), closure scoring, and credit
//       distribution. Foundational fix 2026-05-17.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import { newId } from "./ids";

afterAll(() => closeDb());
beforeEach(() => closeDb());

describe("emitEvent task_failed classification", () => {
  test("accepts open-ended failure_kind strings without editing a taxonomy", () => {
    const db = openDb(":memory:");
    const event = emitEvent(db, {
      kind: "task_failed",
      substrate_origin: "substrate_auto",
      directive_id: newId(),
      task_id: newId(),
      failure_kind: "new_runtime_failure_shape_from_live_evidence",
      payload: { reason: "custom classifier" },
    });

    const row = db
      .query<{ failure_kind: string | null }, [string]>("SELECT failure_kind FROM events WHERE id = ?")
      .get(event.id);
    expect(row?.failure_kind).toBe("new_runtime_failure_shape_from_live_evidence");
  });

  test("adds structured classification_source when task_failed lacks failure_kind", () => {
    const db = openDb(":memory:");
    const event = emitEvent(db, {
      kind: "task_failed",
      substrate_origin: "substrate_auto",
      directive_id: newId(),
      task_id: newId(),
      payload: { reason: "legacy emitter" },
    });

    const row = db
      .query<{ payload: string; failure_kind: string | null }, [string]>("SELECT payload, failure_kind FROM events WHERE id = ?")
      .get(event.id);
    const payload = JSON.parse(row!.payload);
    expect(row?.failure_kind).toBeNull();
    expect(payload.classification_source).toEqual({
      source: "runtime.emitEvent",
      basis: "task_failed_without_emitter_failure_kind",
      note: "Emitter did not provide a failure_kind; classification remains open-ended and should be refined by the producing runtime.",
    });
  });

  test("preserves caller-provided structured classification_source", () => {
    const db = openDb(":memory:");
    const classification_source = { source: "worker", signal: "bridge stderr" };
    const event = emitEvent(db, {
      kind: "task_failed",
      substrate_origin: "substrate_auto",
      directive_id: newId(),
      task_id: newId(),
      payload: { classification_source },
    });

    const row = db
      .query<{ payload: string; failure_kind: string | null }, [string]>("SELECT payload, failure_kind FROM events WHERE id = ?")
      .get(event.id);
    expect(row?.failure_kind).toBeNull();
    expect(JSON.parse(row!.payload).classification_source).toEqual(classification_source);
  });
});

describe("emitEvent terminal-conflict gate", () => {
  test("idempotent re-emit of same terminal kind returns the existing event (first-wins)", () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const taskId = newId();
    emitEvent(db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: directiveId,
      payload: { directive_text: "terminal-gate idempotent test" },
    });
    emitEvent(db, {
      kind: "task_node_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: taskId,
      payload: { goal: "first" },
    });
    const first = emitEvent(db, {
      kind: "task_committed",
      substrate_origin: "opencode",
      directive_id: directiveId,
      task_id: taskId,
      payload: { summary: "brain commit" },
    });
    // Second emit of SAME kind — should return the existing event's id.
    const second = emitEvent(db, {
      kind: "task_committed",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      task_id: taskId,
      payload: { summary: "duplicate commit" },
    });
    expect(second.id).toBe(first.id);
    // Substrate has exactly ONE task_committed row for the task.
    const count = db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = 'task_committed'",
      )
      .get(taskId)!.n;
    expect(count).toBe(1);
  });

  test("conflicting terminal (committed → failed) is refused in production mode; allowed under test bypass", () => {
    // In test mode the gate is permissive (so existing fixtures that test
    // edge-case classifiers still work). To verify the production REFUSAL
    // shape we temporarily clear the test markers and assert the throw.
    const db = openDb(":memory:");
    const directiveId = newId();
    const taskId = newId();
    emitEvent(db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: directiveId,
      payload: { directive_text: "terminal-conflict test" },
    });
    emitEvent(db, {
      kind: "task_node_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: taskId,
      payload: { goal: "first" },
    });
    emitEvent(db, {
      kind: "task_committed",
      substrate_origin: "opencode",
      directive_id: directiveId,
      task_id: taskId,
      payload: { summary: "brain commit" },
    });

    // Switch to production-like env to validate the strict gate fires.
    const prevBridge = process.env.ACC2_BRIDGE_MODE;
    const prevNode = process.env.NODE_ENV;
    delete process.env.ACC2_BRIDGE_MODE;
    delete process.env.NODE_ENV;
    try {
      expect(() => {
        emitEvent(db, {
          kind: "task_failed",
          substrate_origin: "substrate_auto",
          directive_id: directiveId,
          task_id: taskId,
          failure_kind: "refinement_depth_exceeded",
          payload: { reason: "depth cap hit" },
        });
      }).toThrow(/terminal_event_conflict/);
    } finally {
      if (prevBridge !== undefined) process.env.ACC2_BRIDGE_MODE = prevBridge;
      if (prevNode !== undefined) process.env.NODE_ENV = prevNode;
    }

    // Substrate has the original task_committed and NO task_failed for
    // this task — first-wins held.
    const counts = db
      .query<{ kind: string; n: number }, [string]>(
        "SELECT kind, COUNT(*) AS n FROM events WHERE task_id = ? GROUP BY kind",
      )
      .all(taskId);
    const byKind = Object.fromEntries(counts.map((r) => [r.kind, r.n]));
    expect(byKind.task_committed).toBe(1);
    expect(byKind.task_failed ?? 0).toBe(0);
  });

  test("test-mode bypass allows conflicting terminal so existing fixtures still work", () => {
    // Test fixtures legitimately emit conflicting terminals to exercise
    // edge classifiers. The bypass keeps them green while production
    // still gets the strict invariant.
    const db = openDb(":memory:");
    const directiveId = newId();
    const taskId = newId();
    emitEvent(db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: directiveId,
      payload: { directive_text: "test bypass" },
    });
    emitEvent(db, {
      kind: "task_node_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: taskId,
      payload: { goal: "first" },
    });
    emitEvent(db, {
      kind: "task_committed",
      substrate_origin: "opencode",
      directive_id: directiveId,
      task_id: taskId,
      payload: {},
    });
    // bun:test sets NODE_ENV=test by default → bypass active → no throw.
    expect(() => {
      emitEvent(db, {
        kind: "task_failed",
        substrate_origin: "substrate_auto",
        directive_id: directiveId,
        task_id: taskId,
        failure_kind: "refinement_depth_exceeded",
        payload: { reason: "depth cap hit" },
      });
    }).not.toThrow();
  });
});

describe("emitEvent act_tuple_recorded projector", () => {
  test("validates the source act and projects lifecycle rows exactly once", () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const taskId = newId();
    const act = emitEvent(db, {
      kind: "act_tuple_recorded",
      substrate_origin: "claude_root",
      directive_id: directiveId,
      task_id: taskId,
      action_artifact_id: "action_artifact_1",
      verifier_artifact_id: "verifier_artifact_1",
      predicted_residual: 0.2,
      residual: 0.1,
      payload: {
        intent: "record one coherent act",
        reasoning_summary: "single envelope preserves reasoning without per-mutation spam",
        effect_summary: "patched one source seam",
        verifier_kind: "deterministic_code",
        cited_knowledge_ids: ["k_200"],
        cited_artifact_ids: ["artifact_1"],
        affected_resources: ["repo:runtime/events.ts"],
      },
    });

    const rows = db
      .query<{ kind: string; payload: string; context_refs: string }, [string]>(
        "SELECT kind, payload, context_refs FROM events WHERE task_id = ? ORDER BY ts ASC",
      )
      .all(taskId);
    // Order-insensitive structural assertion: the projection emits exactly
    // the right multiset of derived rows. Exact emission ORDER is
    // non-deterministic when multiple rows share a millisecond timestamp
    // (SQLite ORDER BY ts is unstable on ties), so pinning the sequence
    // makes the test flake under concurrent load. We pin the multiset and
    // the structural invariants that matter:
    //   (a) act_tuple_recorded comes first
    //   (b) every derived row carries source_act_id = the act event's id
    //   (c) every derived row's context_refs includes the act id
    const kinds = rows.map((r) => r.kind);
    // 2026-05-20: ORDER BY ts is unstable on millisecond ties — the
    // emit-boundary projections may land in the same ms as the source
    // act_tuple_recorded row. Assert that act_tuple_recorded is present
    // and was the FIRST emit (its id appears in every derived row's
    // context_refs / source_act_id), not that it sorts first.
    expect(kinds).toContain("act_tuple_recorded");
    // 2026-05-19 (brain EH5A37DPHX0GSCJKBSRNZDX700): action_scored
    // projection now auto-admits unseen verifier_kinds and emits
    // verifier_kind_auto_admitted for operator audit. The audit row's
    // context_refs reference the source action_scored, not the
    // act_tuple_recorded; it sits at task scope as a sibling to the
    // projection set.
    // 2026-05-20 (T0.2 universal projector): act_artifact_score_updated
    // rows fire for the action_artifact_id, verifier_artifact_id, and each
    // cited_artifact_id on the projected action_scored row. The projector
    // closes the parity gap between action_scored and credit emission
    // structurally — every action_scored produces one credit row per
    // referenced artifact.
    // 2026-05-20 (T0.3 citation binding enforcement): the bind_citation
    // hook fires on every retrieval_binding. The knowledge-role binding
    // cites k_200 which doesn't resolve to a knowledge_candidate row in
    // this synthetic test, so the hook emits retrieval_rejected (decorative
    // citation) instead of candidate_confirmed. The artifact-role binding
    // carries source_artifact_id (not source_event_id), so bindCitation
    // returns early — no extra emit.
    expect(kinds.filter((k) => k !== "act_tuple_recorded").sort()).toEqual([
      "act_artifact_score_updated",
      "act_artifact_score_updated",
      "act_artifact_score_updated",
      "action_predicted",
      "action_scored",
      "applied_change_committed",
      "candidate_confirmed",
      "retrieval_binding",
      "retrieval_binding",
      "retrieval_rejected",
      "verifier_kind_auto_admitted",
    ]);
    for (const row of rows.filter((r) => r.kind !== "act_tuple_recorded")) {
      // The auto-admit row is a sibling — source_act_id is the
      // action_scored event id, NOT the act_tuple_recorded id. ONE event
      // per logical first-observation; payload.admissions lists every
      // act_artifact row created (category + handle, when distinct).
      if (row.kind === "verifier_kind_auto_admitted") {
        const audit = JSON.parse(row.payload);
        expect(audit.verifier_kind).toBe("deterministic_code");
        expect(Array.isArray(audit.admissions)).toBe(true);
        continue;
      }
      // 2026-05-20 (T0.3 citation binding enforcement): the bind_citation
      // hook emits retrieval_rejected for unresolvable cited ids (k_200
      // in this synthetic test). The rejection is anchored to the
      // retrieval_binding event, not the act_tuple, so it carries no
      // source_act_id. Verify it cites the binding instead via
      // projected_from + projection_key.
      if (row.kind === "retrieval_rejected") {
        const rej = JSON.parse(row.payload);
        expect(rej.projected_from).toBe("bind_citation");
        expect(typeof rej.projection_key).toBe("string");
        continue;
      }
      expect(JSON.parse(row.payload).source_act_id).toBe(act.id);
      expect(JSON.parse(row.context_refs)).toContain(act.id);
    }
  });

  test("applied_change_committed status is decoupled from residual midband", () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const taskId = newId();
    emitEvent(db, {
      kind: "act_tuple_recorded",
      substrate_origin: "claude_root",
      directive_id: directiveId,
      task_id: taskId,
      action_artifact_id: "action_artifact_1",
      verifier_artifact_id: "verifier_artifact_1",
      predicted_residual: 0.4,
      residual: 0.4,
      payload: {
        intent: "record a landed substrate mutation with midband residual",
        reasoning_summary: "residual measures uncertainty, not whether the emit landed",
        effect_summary: "dispatch_decided emitted dispatch_id=example",
        verifier_kind: "deterministic_code",
      },
    });
    const row = db
      .query<{ payload: string; residual: number | null; outcome: string | null }, []>("SELECT payload, residual, outcome FROM events WHERE kind = 'applied_change_committed' LIMIT 1")
      .get()!;
    const payload = JSON.parse(row.payload);
    expect(payload.status).toBe("applied");
    expect(row.residual).toBe(0.4);
    expect(row.outcome).toBe("failed");
  });

  test("correlated failure evidence keeps applied_change_committed status failed", () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const taskId = newId();
    emitEvent(db, {
      kind: "dispatcher_violation",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      task_id: taskId,
      context_refs: ["logical-failed-act"],
      payload: { reason: "correlated failure before projection" },
    });
    emitEvent(db, {
      kind: "act_tuple_recorded",
      substrate_origin: "claude_root",
      directive_id: directiveId,
      task_id: taskId,
      action_artifact_id: "action_artifact_1",
      verifier_artifact_id: "verifier_artifact_1",
      predicted_residual: 0.1,
      residual: 0.1,
      payload: {
        source_act_id: "logical-failed-act",
        intent: "record a failed coherent act",
        reasoning_summary: "dispatcher violation is correlated to the source act",
        effect_summary: "mutation did not land cleanly",
        verifier_kind: "deterministic_code",
      },
    });
    const row = db
      .query<{ payload: string }, []>("SELECT payload FROM events WHERE kind = 'applied_change_committed' LIMIT 1")
      .get()!;
    expect(JSON.parse(row.payload).status).toBe("failed");
  });

  test("bridge-exit act_tuple does NOT project applied_change_committed (phantom-apply gate)", () => {
    // Pre-fix: every opencode brain cycle ended with an
    // act_tuple_recorded carrying (opencode_brain_exit_action,
    // opencode_bridge_exit_verifier) — the substrate projected an
    // applied_change_committed row with summary="bridge_completed
    // final_response_chars=N" and affected_resources=[]. Operator
    // dashboards rendered "Δ✓ applied" on every brain cycle even
    // though nothing on disk moved. Cite KC H3PXSDV32X47.
    const db = openDb(":memory:");
    const directiveId = newId();
    const taskId = newId();
    emitEvent(db, {
      kind: "act_tuple_recorded",
      substrate_origin: "opencode",
      directive_id: directiveId,
      task_id: taskId,
      action_artifact_id: "opencode_brain_exit_action",
      verifier_artifact_id: "opencode_bridge_exit_verifier",
      predicted_residual: 0.2,
      residual: 0,
      payload: {
        intent: "Record one coherent opencode brain dispatch exit boundary.",
        reasoning_summary: "bridge_completed",
        effect_summary: "bridge_completed final_response_chars=884",
        verifier_kind: "opencode_bridge_exit",
      },
    });
    const rows = db
      .query<{ kind: string }, [string]>(
        "SELECT kind FROM events WHERE task_id = ? ORDER BY ts ASC",
      )
      .all(taskId);
    const kinds = rows.map((r) => r.kind);
    // Lifecycle projections still fire (predicted/scored). Bridge
    // exit is a real scored act — just not an applied change.
    expect(kinds).toContain("action_predicted");
    expect(kinds).toContain("action_scored");
    // The phantom event is GONE.
    expect(kinds).not.toContain("applied_change_committed");
  });

  test("task_closure_audited without numeric residual gets a classification_source marker", () => {
    // Pre-fix: brain emitting task_closure_audited without a numeric
    // closure_residual rendered as "closure_residual=undefined" in
    // observe.ts and coerced to NaN in downstream credit. Now the
    // substrate emit boundary injects a classification_source so
    // operators/consumers can detect <unset> vs <measured zero>.
    const db = openDb(":memory:");
    const event = emitEvent(db, {
      kind: "task_closure_audited",
      substrate_origin: "opencode",
      directive_id: newId(),
      task_id: newId(),
      payload: { covered_sub_tasks: [], uncovered_aspects: [] },
    });
    const row = db
      .query<{ payload: string }, [string]>("SELECT payload FROM events WHERE id = ?")
      .get(event.id);
    const payload = JSON.parse(row!.payload);
    expect(payload.classification_source).toEqual({
      source: "runtime.emitEvent",
      basis: "task_closure_audited_without_numeric_residual",
      note: "Emitter did not provide a numeric closure_residual; the closure verifier should refine this. Renderers should treat residual as <unset>.",
    });
  });

  test("task_closure_audited WITH numeric residual preserves it and skips the marker", () => {
    const db = openDb(":memory:");
    const event = emitEvent(db, {
      kind: "task_closure_audited",
      substrate_origin: "opencode",
      directive_id: newId(),
      task_id: newId(),
      payload: { closure_residual: 0.12, covered_sub_tasks: [], uncovered_aspects: [] },
    });
    const row = db
      .query<{ payload: string }, [string]>("SELECT payload FROM events WHERE id = ?")
      .get(event.id);
    const payload = JSON.parse(row!.payload);
    expect(payload.closure_residual).toBe(0.12);
    expect(payload.classification_source).toBeUndefined();
  });

  // T0.1 substrate-truth gate — wired at the emit boundary so every
  // task_closure_audited row with a declared predicate is independently
  // verified BEFORE landing on the ledger. Commit 177b4e7 landed
  // verifyClosureAudit as a callable gate; this wave wires it into
  // emitEvent's normalization chain.
  describe("T0.1 substrate-truth gate (emit-boundary wiring)", () => {
    test("target_files declared, residual<0.3, no matching amendments → residual=1.0 + closure_blocked_no_amendments sibling", () => {
      const db = openDb(":memory:");
      const directiveId = newId();
      const taskId = newId();
      const event = emitEvent(db, {
        kind: "task_closure_audited",
        substrate_origin: "opencode",
        directive_id: directiveId,
        task_id: taskId,
        payload: {
          closure_residual: 0.1,
          closure_predicate: { target_files: ["runtime/foo.ts"] },
          checks: { all_tests_pass: true },
          verdict: "audited",
        },
      });
      const row = db
        .query<{ payload: string }, [string]>("SELECT payload FROM events WHERE id = ?")
        .get(event.id);
      const payload = JSON.parse(row!.payload) as Record<string, unknown>;
      // Substrate-derived residual overrode the brain's 0.1.
      expect(payload.closure_residual).toBe(1.0);
      expect(payload.asserted_residual).toBe(0.1);
      const verifications = payload.substrate_verifications as Record<string, { verified: boolean }>;
      expect(verifications.target_files_have_amendments.verified).toBe(false);
      // Sibling closure_blocked_no_amendments landed.
      const sibling = db
        .query<{ payload: string; id: string }, [string]>(
          "SELECT id, payload FROM events WHERE kind = 'closure_blocked_no_amendments' AND directive_id = ?",
        )
        .get(directiveId);
      expect(sibling).toBeTruthy();
      const siblingPayload = JSON.parse(sibling!.payload) as Record<string, unknown>;
      expect(siblingPayload.reason).toBe("no_contract_amendment_for_declared_target_files");
      expect(siblingPayload.target_files).toEqual(["repo:runtime/foo.ts"]);
      // Legacy fields preserved on the augmented payload (k_204).
      expect(payload.verdict).toBe("audited");
      // brain_claims + discrepancies stamped.
      expect(payload.brain_claims).toEqual({ all_tests_pass: true });
      expect(payload.discrepancies).toContain("all_tests_pass");
      // checks mirror preserved for legacy readers.
      expect(payload.checks).toEqual({ all_tests_pass: true });
    });

    test("target_files declared with matching amendment → augmented payload, no sibling", () => {
      const db = openDb(":memory:");
      const directiveId = newId();
      const taskId = newId();
      // Seed a contract_amendment_proposed for the declared target file.
      emitEvent(db, {
        kind: "contract_amendment_proposed",
        substrate_origin: "brain",
        directive_id: directiveId,
        task_id: taskId,
        payload: {
          target_resource: "repo:runtime/bar.ts",
          proposed_behavior: "wire something",
        },
      });
      const event = emitEvent(db, {
        kind: "task_closure_audited",
        substrate_origin: "opencode",
        directive_id: directiveId,
        task_id: taskId,
        payload: {
          closure_residual: 0.05,
          closure_predicate: { target_files: ["runtime/bar.ts"] },
        },
      });
      const row = db
        .query<{ payload: string }, [string]>("SELECT payload FROM events WHERE id = ?")
        .get(event.id);
      const payload = JSON.parse(row!.payload) as Record<string, unknown>;
      const verifications = payload.substrate_verifications as Record<string, { verified: boolean; evidence_event_ids: string[] }>;
      expect(verifications.target_files_have_amendments.verified).toBe(true);
      expect(verifications.target_files_have_amendments.evidence_event_ids).toHaveLength(1);
      // No sibling refusal was emitted.
      const siblingCount = db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM events WHERE kind = 'closure_blocked_no_amendments' AND directive_id = ?",
        )
        .get(directiveId);
      expect(siblingCount?.n).toBe(0);
      // The closure_residual is substrate-derived: only the
      // target_files_have_amendments check ran and it passed, so
      // residual drops to 0.
      expect(payload.closure_residual).toBe(0);
      expect(payload.asserted_residual).toBe(0.05);
    });

    test("legacy payload (no closure_predicate, no checks) preserves the pre-T0.1 emit path", () => {
      const db = openDb(":memory:");
      const event = emitEvent(db, {
        kind: "task_closure_audited",
        substrate_origin: "opencode",
        directive_id: newId(),
        task_id: newId(),
        // Pre-T0.1 brain emit shape: closure_residual + verdict, no
        // predicate, no checks. The gate must skip and let the legacy
        // normalizer pass the payload through unchanged.
        payload: { closure_residual: 0.18, verdict: "audited", covered_sub_tasks: ["s1"] },
      });
      const row = db
        .query<{ payload: string }, [string]>("SELECT payload FROM events WHERE id = ?")
        .get(event.id);
      const payload = JSON.parse(row!.payload) as Record<string, unknown>;
      expect(payload.closure_residual).toBe(0.18);
      expect(payload.verdict).toBe("audited");
      expect(payload.covered_sub_tasks).toEqual(["s1"]);
      // No T0.1-shape fields stamped on a legacy payload.
      expect(payload.substrate_verifications).toBeUndefined();
      expect(payload.brain_claims).toBeUndefined();
      expect(payload.discrepancies).toBeUndefined();
      expect(payload.asserted_residual).toBeUndefined();
    });
  });

  test("lesson_extracted without lesson_kind gets a classification_source marker", () => {
    // Same pattern as task_failed/task_closure_audited — emitter
    // omitted the open-ended classifier. Substrate retains the
    // provenance instead of leaking "?" through the tail renderer.
    const db = openDb(":memory:");
    const event = emitEvent(db, {
      kind: "lesson_extracted",
      substrate_origin: "opencode",
      directive_id: newId(),
      task_id: newId(),
      payload: { summary: "when rewriting cofounder docs ..." },
    });
    const row = db
      .query<{ payload: string }, [string]>("SELECT payload FROM events WHERE id = ?")
      .get(event.id);
    const payload = JSON.parse(row!.payload);
    expect(payload.classification_source).toEqual({
      source: "runtime.emitEvent",
      basis: "lesson_extracted_without_lesson_kind",
      note: "Emitter did not provide a lesson_kind; defaulted to unclassified and should be refined by the producing runtime.",
    });
    // Summary is preserved alongside the marker and the row stores a classifier.
    expect(payload.summary).toBe("when rewriting cofounder docs ...");
    expect(payload.lesson_kind).toBe("unclassified");
    const uncertainty = db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM events WHERE kind = 'knowledge_uncertainty_observed' AND json_extract(payload, '$.lesson_event_id') = ?")
      .get(event.id);
    expect(uncertainty?.n).toBe(1);
  });


  test("projection_key makes derived rows idempotent", () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const taskId = newId();
    const first = emitEvent(db, {
      kind: "action_predicted",
      directive_id: directiveId,
      task_id: taskId,
      action_artifact_id: "action_artifact_1",
      verifier_artifact_id: "verifier_artifact_1",
      predicted_residual: 0.2,
      payload: { projection_key: "act_1:action_predicted:primary", source_act_id: "act_1" },
    });
    const second = emitEvent(db, {
      kind: "action_predicted",
      directive_id: directiveId,
      task_id: taskId,
      action_artifact_id: "action_artifact_1",
      verifier_artifact_id: "verifier_artifact_1",
      predicted_residual: 0.2,
      payload: { projection_key: "act_1:action_predicted:primary", source_act_id: "act_1" },
    });
    expect(second.id).toBe(first.id);
    const count = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'action_predicted'")
      .get()!.n;
    expect(count).toBe(1);
  });

  test("logical source_act_id makes replayed source acts project only once", () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const taskId = newId();
    const emitLogicalAct = () => emitEvent(db, {
      kind: "act_tuple_recorded",
      substrate_origin: "claude_root",
      directive_id: directiveId,
      task_id: taskId,
      action_artifact_id: "action_artifact_1",
      verifier_artifact_id: "verifier_artifact_1",
      predicted_residual: 0.2,
      residual: 0.1,
      payload: {
        source_act_id: "logical-act-1",
        intent: "retry one coherent act",
        reasoning_summary: "same logical source act retried after transport uncertainty",
        effect_summary: "same effect should not duplicate projections",
        verifier_kind: "deterministic_code",
        cited_knowledge_ids: ["k_200"],
        cited_artifact_ids: ["artifact_1"],
      },
    });
    const first = emitLogicalAct();
    const second = emitLogicalAct();
    expect(second.id).not.toBe(first.id);
    const projected = db
      .query<{ kind: string; n: number }, []>(
        "SELECT kind, COUNT(*) AS n FROM events WHERE kind != 'act_tuple_recorded' GROUP BY kind ORDER BY kind",
      )
      .all();
    // 2026-05-19 (brain EH5A37DPHX0GSCJKBSRNZDX700): action_scored
    // projection auto-admits unseen verifier_kinds once. The replayed
    // logical act fires the same auto-admit path twice but the SELECT-
    // before-INSERT idempotency keeps the registry row count at 1 —
    // and the audit event fires only on the FIRST observation because
    // the helper short-circuits when the row already exists.
    // 2026-05-20 (T0.2 universal projector): act_artifact_score_updated
    // rows fire per referenced artifact (action + verifier + cited) on
    // the projected action_scored. The replayed act collapses to the
    // same projection_key on every projector emit, so the multiset
    // stays at 3 (action + verifier + cited).
    // 2026-05-20 (T0.3 citation binding enforcement): the bind_citation
    // hook fires on the knowledge-role retrieval_binding citing k_200,
    // which doesn't resolve to a knowledge_candidate row in this synthetic
    // test → emits 1 retrieval_rejected. The artifact-role binding carries
    // source_artifact_id (not source_event_id), so bindCitation returns
    // early. The replay is idempotent: the retrieval_binding's
    // emit-boundary projection_key collapses the second call, so the
    // hook only fires once.
    expect(Object.fromEntries(projected.map((row) => [row.kind, row.n]))).toEqual({
      act_artifact_score_updated: 3,
      action_predicted: 1,
      action_scored: 1,
      applied_change_committed: 1,
      candidate_confirmed: 1,
      retrieval_binding: 2,
      retrieval_rejected: 1,
      verifier_kind_auto_admitted: 1,
    });
    const predicted = db
      .query<{ payload: string }, []>("SELECT payload FROM events WHERE kind = 'action_predicted'")
      .get()!;
    const payload = JSON.parse(predicted.payload) as { projection_key: string; source_act_id: string; source_act_event_id: string };
    expect(payload.source_act_id).toBe("logical-act-1");
    expect(payload.source_act_event_id).toBe(first.id);
    expect(payload.projection_key).toBe("logical-act-1:action_predicted:primary");
  });

  test("event projector kicks credit distribution through projected source citations", async () => {
    const db = openDb(":memory:");
    const knowledge = emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "opencode",
      payload: { claim: "projected source citations receive credit", confidence_estimate: 1 },
    });
    const act = emitEvent(db, {
      kind: "act_tuple_recorded",
      substrate_origin: "claude_root",
      action_artifact_id: "synthetic_action",
      verifier_artifact_id: "synthetic_verifier",
      predicted_residual: 0.1,
      residual: 0,
      payload: {
        intent: "record and credit one coherent act",
        reasoning_summary: "act tuple cites knowledge",
        effect_summary: "projector emits lifecycle rows",
        verifier_kind: "deterministic_code",
        cited_knowledge_ids: [knowledge.id],
      },
    });

    // 2026-05-20 (T0.3 citation binding enforcement): the bind_citation
    // hook also emits candidate_confirmed for the cited knowledge with
    // payload.knowledge_id set but no source_act_id (the binding is not
    // anchored to a specific act). Filter to the distributeCredit-driven
    // row (carries source_act_id) so this test still verifies the
    // async credit chain through the projected source citations.
    let confirmed: { payload: string } | null = null;
    for (let i = 0; i < 20; i++) {
      confirmed = db.query("SELECT payload FROM events WHERE kind = 'candidate_confirmed' AND json_extract(payload, '$.knowledge_id') = ? AND json_extract(payload, '$.source_act_id') IS NOT NULL").get(knowledge.id) as { payload: string } | null;
      if (confirmed) break;
      await Bun.sleep(10);
    }
    expect(confirmed).not.toBeNull();
    const payload = JSON.parse(confirmed!.payload) as Record<string, unknown>;
    expect(payload.source_act_id).toBe(act.id);
  });

  test("invalid act_tuple_recorded is refused before any source row lands", () => {
    const db = openDb(":memory:");
    expect(() => {
      emitEvent(db, {
        kind: "act_tuple_recorded",
        substrate_origin: "claude_root",
        payload: { intent: "missing verifier fields" },
      });
    }).toThrow(/invalid_act_tuple_recorded/);
    const count = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()!.n;
    expect(count).toBe(0);
  });
});

describe("emitEvent action_scored null-id lift gate (brain lesson TA4X4Q36XH38789BWQMV2AYB3W)", () => {
  // Pre-fix: 102 historical action_scored events had action_artifact_id IS NULL —
  // dominantly peer-LLM reviews emitted by the brain to score other actors'
  // work without a registered action handle. These bypass artifact-credit
  // because the canonical column is null. The substrate-truth fix at the
  // projection boundary: lift verifier_kind as the action_artifact_id when
  // present; refuse when neither is set.

  test("null action_artifact_id + verifier_kind set -> row created with lifted id + dispatcher_violation emitted", () => {
    const db = openDb(":memory:");
    const scored = emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "opencode",
      directive_id: newId(),
      task_id: newId(),
      verifier_artifact_id: "peer_llm_opencode_verifier",
      residual: 0.15,
      payload: {
        verifier_kind: "peer_llm_opencode_diagnostic",
        target_event_id: "some_other_actor_event",
      },
    });
    // The scored row exists with action_artifact_id lifted from verifier_kind.
    const scoredRow = db
      .query<{ action_artifact_id: string | null; payload: string }, [string]>("SELECT action_artifact_id, payload FROM events WHERE id = ?")
      .get(scored.id);
    expect(scoredRow?.action_artifact_id).toBe("peer_llm_opencode_diagnostic");
    const scoredPayload = JSON.parse(scoredRow!.payload);
    expect(scoredPayload.action_artifact_id).toBe("peer_llm_opencode_diagnostic");
    expect(scoredPayload.action_artifact_id_lifted_from_verifier_kind).toBe(true);
    expect(scoredPayload.verifier_kind).toBe("peer_llm_opencode_diagnostic");
    // Exactly one dispatcher_violation with failure_kind=null_action_artifact_id_lifted
    // referencing the scored event id.
    const violations = db
      .query<{ id: string; payload: string; failure_kind: string | null; context_refs: string }, []>(
        "SELECT id, payload, failure_kind, context_refs FROM events WHERE kind = 'dispatcher_violation' AND failure_kind = 'null_action_artifact_id_lifted'",
      )
      .all();
    expect(violations.length).toBe(1);
    const violationPayload = JSON.parse(violations[0]!.payload);
    expect(violationPayload.source_kind).toBe("action_scored");
    expect(violationPayload.source_event_id).toBe(scored.id);
    expect(violationPayload.original_action_artifact_id).toBeNull();
    expect(violationPayload.lifted_to).toBe("peer_llm_opencode_diagnostic");
    expect(violationPayload.verifier_kind).toBe("peer_llm_opencode_diagnostic");
    expect(violationPayload.substrate_origin).toBe("opencode");
    expect(JSON.parse(violations[0]!.context_refs)).toContain(scored.id);
  });

  test("null action_artifact_id + null verifier_kind -> NO action_scored row + unresolvable dispatcher_violation emitted", () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const taskId = newId();
    const result = emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "claude_inline",
      directive_id: directiveId,
      task_id: taskId,
      residual: 0.4,
      payload: { note: "emitter forgot both handles" },
    });
    // No action_scored row landed.
    const scoredCount = db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM events WHERE kind = 'action_scored' AND task_id = ?")
      .get(taskId)!.n;
    expect(scoredCount).toBe(0);
    // The returned EmittedEvent points at the dispatcher_violation row.
    const violationRow = db
      .query<{ id: string; kind: string; payload: string; failure_kind: string | null }, [string]>(
        "SELECT id, kind, payload, failure_kind FROM events WHERE id = ?",
      )
      .get(result.id);
    expect(violationRow?.kind).toBe("dispatcher_violation");
    expect(violationRow?.failure_kind).toBe("null_action_artifact_id_unresolvable");
    const payload = JSON.parse(violationRow!.payload);
    expect(payload.source_kind).toBe("action_scored");
    expect(payload.original_action_artifact_id).toBeNull();
    expect(payload.verifier_kind).toBeNull();
    expect(payload.substrate_origin).toBe("claude_inline");
  });

  test("non-null action_artifact_id -> existing behavior preserved (no lift, no violation)", () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const taskId = newId();
    const scored = emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "claude_root",
      directive_id: directiveId,
      task_id: taskId,
      action_artifact_id: "registered_handle_v1",
      verifier_artifact_id: "registered_verifier_v1",
      residual: 0.1,
      payload: { verifier_kind: "deterministic_code", note: "well-formed emit" },
    });
    const row = db
      .query<{ action_artifact_id: string | null; payload: string }, [string]>("SELECT action_artifact_id, payload FROM events WHERE id = ?")
      .get(scored.id);
    // Column preserves the caller's handle; the lift marker is NOT
    // present on the payload because no lift happened.
    expect(row?.action_artifact_id).toBe("registered_handle_v1");
    const payload = JSON.parse(row!.payload);
    expect(payload.action_artifact_id_lifted_from_verifier_kind).toBeUndefined();
    // No dispatcher_violation fired for this emit.
    const violations = db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM events WHERE kind = 'dispatcher_violation' AND failure_kind IN ('null_action_artifact_id_lifted', 'null_action_artifact_id_unresolvable')",
      )
      .get()!.n;
    expect(violations).toBe(0);
  });

  test("lift is idempotent: re-emit with the lifted id as action_artifact_id does NOT fire a second violation", () => {
    // The act-tuple projection path already passes a concrete
    // action_artifact_id; only the buggy direct-emit path needs the lift.
    // Confirm that once the upstream emitter is fixed to pass the lifted
    // handle directly, no violation fires (the gate is structural, not
    // hysterical).
    const db = openDb(":memory:");
    emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "opencode",
      directive_id: newId(),
      task_id: newId(),
      action_artifact_id: "peer_llm_opencode_diagnostic",
      verifier_artifact_id: "peer_llm_opencode_verifier",
      residual: 0.2,
      payload: { verifier_kind: "peer_llm_opencode_diagnostic" },
    });
    const violations = db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM events WHERE kind = 'dispatcher_violation' AND failure_kind IN ('null_action_artifact_id_lifted', 'null_action_artifact_id_unresolvable')",
      )
      .get()!.n;
    expect(violations).toBe(0);
  });
});

describe("emitEvent action_scored verifier_kind auto-admit gate (brain EH5A37DPHX0GSCJKBSRNZDX700)", () => {
  // Companion to the lift gate above. When an action_scored carries a
  // verifier_kind whose canonical name has no matching act_artifact row,
  // the substrate auto-creates a kind="verifier" row with neutral
  // Beta(1,1) prior so credit accrues on every subsequent action_scored.
  // Emits verifier_kind_auto_admitted for operator audit. Idempotent:
  // second observation of the same verifier_kind is a no-op.

  test("first observation of a new verifier_kind -> act_artifact row auto-admitted + verifier_kind_auto_admitted event emitted", () => {
    const db = openDb(":memory:");
    const before = db
      .query<{ id: string }, [string]>("SELECT id FROM act_artifact WHERE id = ? LIMIT 1")
      .get("brand_new_verifier_kind_xyz");
    expect(before).toBeNull();
    const scored = emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "opencode",
      directive_id: newId(),
      task_id: newId(),
      action_artifact_id: "brand_new_verifier_kind_xyz",
      verifier_artifact_id: "brand_new_verifier_kind_xyz",
      residual: 0.4,
      payload: { verifier_kind: "brand_new_verifier_kind_xyz" },
    });
    // act_artifact row landed with kind="verifier" + neutral prior.
    const row = db
      .query<{
        id: string;
        kind: string;
        status: string;
        runtime: string;
        posterior_alpha: number;
        posterior_beta: number;
        score: number;
        confidence: number;
        fixture_input: string;
        body: string;
      }, [string]>(
        "SELECT id, kind, status, runtime, posterior_alpha, posterior_beta, score, confidence, fixture_input, body FROM act_artifact WHERE id = ? LIMIT 1",
      )
      .get("brand_new_verifier_kind_xyz");
    expect(row).not.toBeNull();
    expect(row!.kind).toBe("verifier");
    expect(row!.status).toBe("admitted");
    expect(row!.runtime).toBe("bun");
    expect(row!.posterior_alpha).toBe(1.0);
    expect(row!.posterior_beta).toBe(1.0);
    expect(row!.score).toBe(0.5);
    expect(row!.confidence).toBe(0.5);
    const fixture = JSON.parse(row!.fixture_input);
    expect(fixture.admission_source).toBe("action_scored_projection");
    expect(fixture.first_observed_action_scored_event_id).toBe(scored.id);
    expect(fixture.parent_kind).toBeNull();
    expect(fixture.variant_tag).toBeNull();
    expect(fixture.rollup).toBe(false);
    expect(row!.body).toContain("Auto-admitted verifier");
    // verifier_kind_auto_admitted audit event fired.
    const audits = db
      .query<{ id: string; payload: string; context_refs: string }, [string]>(
        "SELECT id, payload, context_refs FROM events WHERE kind = 'verifier_kind_auto_admitted' AND json_extract(payload, '$.verifier_kind') = ?",
      )
      .all("brand_new_verifier_kind_xyz");
    expect(audits.length).toBe(1);
    const auditPayload = JSON.parse(audits[0]!.payload);
    expect(auditPayload.verifier_kind).toBe("brand_new_verifier_kind_xyz");
    expect(auditPayload.act_artifact_id).toBe("brand_new_verifier_kind_xyz");
    expect(auditPayload.source_action_scored_event_id).toBe(scored.id);
    expect(auditPayload.parent_kind).toBeNull();
    expect(auditPayload.variant_tag).toBeNull();
    expect(auditPayload.rollup).toBe(false);
    expect(auditPayload.promotion_criteria.min_observations).toBe(3);
    expect(auditPayload.promotion_criteria.min_directives).toBe(2);
    expect(auditPayload.promotion_criteria.residual_delta_from_parent).toBe(0.20);
    expect(JSON.parse(audits[0]!.context_refs)).toContain(scored.id);
  });

  test("second observation of the same verifier_kind -> no re-admit (idempotent), no second audit event", () => {
    const db = openDb(":memory:");
    // First observation.
    emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "opencode",
      directive_id: newId(),
      task_id: newId(),
      action_artifact_id: "idempotent_verifier_zzz",
      verifier_artifact_id: "idempotent_verifier_zzz",
      residual: 0.3,
      payload: { verifier_kind: "idempotent_verifier_zzz" },
    });
    // Capture the row's created_at so we can confirm it doesn't change.
    const first = db
      .query<{ id: string; created_at: string }, [string]>(
        "SELECT id, created_at FROM act_artifact WHERE id = ? LIMIT 1",
      )
      .get("idempotent_verifier_zzz");
    expect(first).not.toBeNull();
    // Second observation — same verifier_kind, different directive/task.
    emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "opencode",
      directive_id: newId(),
      task_id: newId(),
      action_artifact_id: "idempotent_verifier_zzz",
      verifier_artifact_id: "idempotent_verifier_zzz",
      residual: 0.2,
      payload: { verifier_kind: "idempotent_verifier_zzz" },
    });
    // Still exactly one act_artifact row, with unchanged created_at.
    const rows = db
      .query<{ id: string; created_at: string }, [string]>(
        "SELECT id, created_at FROM act_artifact WHERE id = ?",
      )
      .all("idempotent_verifier_zzz");
    expect(rows.length).toBe(1);
    expect(rows[0]!.created_at).toBe(first!.created_at);
    // Only ONE verifier_kind_auto_admitted event fired (the first).
    const audits = db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM events WHERE kind = 'verifier_kind_auto_admitted' AND json_extract(payload, '$.verifier_kind') = ?",
      )
      .get("idempotent_verifier_zzz");
    expect(audits!.n).toBe(1);
  });

  test("peer_llm_opencode_<variant> observation -> row created with parent_kind=peer_llm_opencode, variant_tag, rollup=true", () => {
    const db = openDb(":memory:");
    const scored = emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "opencode",
      directive_id: newId(),
      task_id: newId(),
      action_artifact_id: "peer_llm_opencode_diagnostic",
      verifier_artifact_id: "peer_llm_opencode_diagnostic",
      residual: 0.25,
      payload: { verifier_kind: "peer_llm_opencode_diagnostic" },
    });
    const row = db
      .query<{ id: string; kind: string; fixture_input: string; body: string }, [string]>(
        "SELECT id, kind, fixture_input, body FROM act_artifact WHERE id = ? LIMIT 1",
      )
      .get("peer_llm_opencode_diagnostic");
    expect(row).not.toBeNull();
    expect(row!.kind).toBe("verifier");
    const fixture = JSON.parse(row!.fixture_input);
    expect(fixture.parent_kind).toBe("peer_llm_opencode");
    expect(fixture.variant_tag).toBe("diagnostic");
    expect(fixture.rollup).toBe(true);
    expect(row!.body).toContain("parent_kind=peer_llm_opencode");
    expect(row!.body).toContain("variant_tag=diagnostic");
    // Audit event payload carries the same collapse metadata.
    const audits = db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM events WHERE kind = 'verifier_kind_auto_admitted' AND json_extract(payload, '$.verifier_kind') = ?",
      )
      .all("peer_llm_opencode_diagnostic");
    expect(audits.length).toBe(1);
    const auditPayload = JSON.parse(audits[0]!.payload);
    expect(auditPayload.parent_kind).toBe("peer_llm_opencode");
    expect(auditPayload.variant_tag).toBe("diagnostic");
    expect(auditPayload.rollup).toBe(true);
    expect(auditPayload.source_action_scored_event_id).toBe(scored.id);
  });

  test("peer_llm_<hemisphere>_<variant> observations preserve symmetric hemisphere parent metadata", () => {
    const db = openDb(":memory:");
    const cases = [
      { verifierKind: "peer_llm_claude_diagnostic", parentKind: "peer_llm_claude", variantTag: "diagnostic" },
      { verifierKind: "peer_llm_opencode_diagnostic", parentKind: "peer_llm_opencode", variantTag: "diagnostic" },
    ];

    for (const item of cases) {
      const scored = emitEvent(db, {
        kind: "action_scored",
        substrate_origin: "opencode",
        directive_id: newId(),
        task_id: newId(),
        action_artifact_id: item.verifierKind,
        verifier_artifact_id: item.verifierKind,
        residual: 0.25,
        payload: { verifier_kind: item.verifierKind },
      });
      const row = db
        .query<{ fixture_input: string; body: string }, [string]>(
          "SELECT fixture_input, body FROM act_artifact WHERE id = ? LIMIT 1",
        )
        .get(item.verifierKind);
      expect(row).not.toBeNull();
      const fixture = JSON.parse(row!.fixture_input);
      expect(fixture.parent_kind).toBe(item.parentKind);
      expect(fixture.variant_tag).toBe(item.variantTag);
      expect(fixture.rollup).toBe(true);
      expect(row!.body).toContain(`parent_kind=${item.parentKind}`);
      expect(row!.body).toContain(`variant_tag=${item.variantTag}`);

      const audit = db
        .query<{ payload: string }, [string]>(
          "SELECT payload FROM events WHERE kind = 'verifier_kind_auto_admitted' AND json_extract(payload, '$.verifier_kind') = ? LIMIT 1",
        )
        .get(item.verifierKind);
      expect(audit).not.toBeNull();
      const auditPayload = JSON.parse(audit!.payload);
      expect(auditPayload.parent_kind).toBe(item.parentKind);
      expect(auditPayload.variant_tag).toBe(item.variantTag);
      expect(auditPayload.rollup).toBe(true);
      expect(auditPayload.source_action_scored_event_id).toBe(scored.id);
    }
  });
});

describe("emitEvent dispatcher_violation classification gate (Hole 6 — 2026-05-19)", () => {
  // Pre-fix evidence: 21 production dispatcher_violation rows had
  // failure_kind=NULL — silent failures the substrate could not classify
  // (operator audits joining by failure_kind lost ~4% of failures). The
  // emit-boundary gate defaults missing classifications to
  // "unclassified_emit_bug" and stamps payload.classification_source =
  // "default_unclassified" so audits surface the gap rather than silently
  // accepting NULL.

  test("dispatcher_violation without failure_kind defaults to unclassified_emit_bug + classification_source marker", () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const taskId = newId();
    const event = emitEvent(db, {
      kind: "dispatcher_violation",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      task_id: taskId,
      payload: { reason: "emitter forgot to classify" },
    });
    const row = db
      .query<{ failure_kind: string | null; payload: string }, [string]>(
        "SELECT failure_kind, payload FROM events WHERE id = ?",
      )
      .get(event.id);
    expect(row?.failure_kind).toBe("unclassified_emit_bug");
    const payload = JSON.parse(row!.payload);
    expect(payload.classification_source).toBe("default_unclassified");
    expect(typeof payload.classification_default_note).toBe("string");
    // Original payload fields are preserved.
    expect(payload.reason).toBe("emitter forgot to classify");
  });

  test("dispatcher_violation with explicit failure_kind preserves emitter classification (no default override)", () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const taskId = newId();
    const event = emitEvent(db, {
      kind: "dispatcher_violation",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      task_id: taskId,
      failure_kind: "floor_section_missing",
      payload: { kind: "floor_section_missing", missing_floor_sections: ["task_goal"] },
    });
    const row = db
      .query<{ failure_kind: string | null; payload: string }, [string]>(
        "SELECT failure_kind, payload FROM events WHERE id = ?",
      )
      .get(event.id);
    expect(row?.failure_kind).toBe("floor_section_missing");
    const payload = JSON.parse(row!.payload);
    // No default marker because emitter classified explicitly.
    expect(payload.classification_source).toBeUndefined();
    expect(payload.classification_default_note).toBeUndefined();
    expect(payload.kind).toBe("floor_section_missing");
  });

  test("dispatcher_violation with failure_kind nested in payload only is honoured (no default override)", () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const taskId = newId();
    const event = emitEvent(db, {
      kind: "dispatcher_violation",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      task_id: taskId,
      payload: { failure_kind: "out_of_scope_target", file: "runtime/foo.ts" },
    });
    const row = db
      .query<{ failure_kind: string | null; payload: string }, [string]>(
        "SELECT failure_kind, payload FROM events WHERE id = ?",
      )
      .get(event.id);
    expect(row?.failure_kind).toBe("out_of_scope_target");
    const payload = JSON.parse(row!.payload);
    expect(payload.classification_source).toBeUndefined();
    expect(payload.failure_kind).toBe("out_of_scope_target");
  });
});
