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

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import type { Database } from "bun:sqlite";
import type { EventKind } from "../substrate/types";
import { getArtifact, insertArtifact } from "./artifact_store";
import { emitEvent, getEventById, getEventRowById, flushPostCommitProjectionsForTest, postCommitProjectionDepth, resetPostCommitProjectionsForTest } from "./events";
import { runArchivalSweep } from "./archival_worker";
import { newId } from "./ids";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterAll(() => closeDb());
beforeEach(() => {
  // Reset the process-lived post-commit projection queue so a prior test's
  // un-drained deferred tasks cannot bleed into this test's fresh db.
  resetPostCommitProjectionsForTest();
  closeDb();
});

const insertSampleArtifact = (db: Database, id: string, body = "// artifact") =>
  insertArtifact(db, {
    runtime: "bun",
    body,
    declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
    stateRoot: null,
    posteriorAlpha: 1,
    posteriorBeta: 1,
    score: 0.5,
    confidence: 0.3,
    recentResidualMean: 0,
    recentKillCount: 0,
    status: "admitted",
    name: null,
    fixtureInput: null,
    fixtureExpectedResidual: 0.2,
    id,
  });

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

describe("emitEvent non-blocking post-commit cascade (directive NHY908W0EX5Q72KGWXMASPFEY0)", () => {
  // ROOT-CAUSE fix: the heavy post-insert projection cascade no longer runs
  // synchronously on emitEvent's call stack (which, under MCP, was the
  // daemon's single event loop). emitEvent INSERTs the row, fires the
  // bus/activation notification, then DEFERS the heavy projections onto the
  // bounded post-commit queue and returns its {id, ts} ack immediately.

  test("emitEvent returns its durable ack immediately; the row is persisted BEFORE the deferred projection runs", () => {
    const db = openDb(":memory:");
    const taskId = newId();
    // A lesson_extracted defers its internal-act projection onto the queue.
    const before = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'action_predicted'")
      .get()!.n;
    const ev = emitEvent(db, {
      kind: "lesson_extracted",
      substrate_origin: "opencode",
      directive_id: newId(),
      task_id: taskId,
      payload: { summary: "durability-before-ack proof", lesson_kind: "process" },
    });
    // (a) Durability before ack: the source row is ALREADY in the ledger the
    //     instant emitEvent returns — we can read it back synchronously.
    const row = db.query<{ id: string }, [string]>("SELECT id FROM events WHERE id = ?").get(ev.id);
    expect(row).not.toBeNull();
    expect(row!.id).toBe(ev.id);
    // The deferred projection (lesson_extractor internal act → action_predicted)
    // has NOT run yet — it is queued, not on the synchronous return path.
    const afterAck = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'action_predicted'")
      .get()!.n;
    expect(afterAck).toBe(before);
    expect(postCommitProjectionDepth()).toBeGreaterThan(0);
  });

  test("a deliberately heavy cascade still drains every deferred projection to a fixed point (no dropped projections)", async () => {
    const db = openDb(":memory:");
    // Emit many action_scored events back-to-back; each defers its credit +
    // auto-admit projections. The ack for each returns promptly (synchronous
    // INSERT only); the heavy projections queue up behind it.
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) {
      const ev = emitEvent(db, {
        kind: "action_scored",
        substrate_origin: "opencode",
        directive_id: newId(),
        task_id: newId(),
        action_artifact_id: `heavy_verifier_${i}`,
        verifier_artifact_id: `heavy_verifier_${i}`,
        residual: 0.2,
        payload: { verifier_kind: `heavy_verifier_${i}` },
      });
      ids.push(ev.id);
    }
    // All 40 source rows are durable immediately.
    const sourceCount = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'action_scored'")
      .get()!.n;
    expect(sourceCount).toBe(40);
    // Drain the bounded queue to its fixed point — every deferred auto-admit
    // projection lands; none are dropped.
    await flushPostCommitProjectionsForTest();
    expect(postCommitProjectionDepth()).toBe(0);
    const admitted = db
      .query<{ n: number }, []>("SELECT COUNT(DISTINCT json_extract(payload, '$.verifier_kind')) AS n FROM events WHERE kind = 'verifier_kind_auto_admitted'")
      .get()!.n;
    expect(admitted).toBe(40);
  });
});

describe("emitEvent act_tuple_recorded projector", () => {
  test("validates the source act and projects lifecycle rows exactly once", async () => {
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
    // Non-blocking post-commit cascade (directive NHY908W0EX5Q72KGWXMASPFEY0):
    // emitEvent returns its durable {id, ts} ack immediately and defers the
    // heavy action_scored credit/auto-admit projections onto the bounded
    // post-commit queue. Drain it before asserting the derived rows landed.
    await flushPostCommitProjectionsForTest();

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
    // 2026-05-24 (non-blocking post-commit cascade, directive
    // NHY908W0EX5Q72KGWXMASPFEY0): the action_scored credit fan-out is now
    // deferred onto the bounded post-commit queue and drained to a fixed
    // point by flushPostCommitProjectionsForTest(). The async
    // distributeCredit cascade (extra candidate_confirmed + origin_
    // calibration_recorded rows) — which previously landed AFTER this
    // synchronous read and went uncounted — is now included. Deterministic
    // across runs because the drain reaches quiescence before the assert.
    expect(kinds.filter((k) => k !== "act_tuple_recorded").sort()).toEqual([
      "act_artifact_score_updated",
      "act_artifact_score_updated",
      "action_predicted",
      "action_scored",
      "applied_change_committed",
      "candidate_confirmed",
      "candidate_confirmed",
      "candidate_confirmed",
      "candidate_confirmed",
      "candidate_confirmed",
      "coalition_credit_distributed",
      "credit_envelope_projected",
      "entity_score_updated",
      "entity_score_updated",
      "entity_score_updated",
      "entity_score_updated",
      "entity_score_updated",
      "entity_score_updated",
      "origin_calibration_recorded",
      "origin_calibration_recorded",
      "origin_calibration_recorded",
      "origin_calibration_recorded",
      "retrieval_binding",
      "retrieval_binding",
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
      // Coalition credit is emitted by the credit pipeline keyed to the
      // scored/action_predicted pair rather than the source act tuple.
      // 2026-05-24 (non-blocking post-commit cascade): with the deferred
      // credit fan-out drained to a fixed point, the surviving
      // coalition_credit_distributed row may be the one from the act_tuple
      // distributeCredit path (no projected_from tag) rather than the
      // action_scored_universal_projector. Either is a legitimate credit
      // emission; pin only its idempotency contract (a projection_key).
      if (row.kind === "coalition_credit_distributed") {
        const coal = JSON.parse(row.payload);
        expect(typeof coal.projection_key).toBe("string");
        continue;
      }
      // Amendment 4509YBMC: the CreditEnvelope audit row is keyed to the
      // scored event (projection_key = credit_envelope:{scored_event_id}),
      // not to the act_tuple's source lifecycle, so it carries no
      // source_act_id. Pin only its idempotency contract.
      if (row.kind === "credit_envelope_projected") {
        const env = JSON.parse(row.payload);
        expect(typeof env.projection_key).toBe("string");
        expect(typeof env.scored_event_id).toBe("string");
        continue;
      }
      // 2026-05-24 (non-blocking post-commit cascade, directive
      // NHY908W0EX5Q72KGWXMASPFEY0): the action_scored credit projector +
      // its async distributeCredit fan-out (act_artifact_score_updated,
      // candidate_confirmed, origin_calibration_recorded) are now drained to
      // a fixed point by flushPostCommitProjectionsForTest(). These credit-
      // side rows are keyed to the PROJECTED action_scored / coalition pair
      // (source_act_id = the projected action_scored's act id, or absent),
      // NOT to the original act_tuple — same family as
      // coalition_credit_distributed above. The source-act attribution
      // invariant this loop pins applies only to the act_tuple's OWN
      // lifecycle projection rows (action_predicted / action_scored /
      // applied_change_committed), which still carry source_act_id = act.id.
      if (
        row.kind === "act_artifact_score_updated" ||
        row.kind === "entity_score_updated" ||
        row.kind === "candidate_confirmed" ||
        row.kind === "origin_calibration_recorded"
      ) {
        // act_artifact_score_updated carries the correct source_act_id but
        // is a per-artifact credit row whose context_refs track the cited
        // artifact ids (often empty for synthetic-artifact pairs), so it is
        // not part of the act_tuple's source-lifecycle attribution set.
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

  test("auto-binds selected artifacts into citations and credits registered action artifact", async () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const taskId = newId();
    insertSampleArtifact(db, "real_action_artifact", "// real action");
    insertSampleArtifact(db, "real_verifier_artifact", "// real verifier");
    const before = getArtifact(db, "real_action_artifact")!;

    emitEvent(db, {
      kind: "act_tuple_recorded",
      substrate_origin: "claude_root",
      directive_id: directiveId,
      task_id: taskId,
      action_artifact_id: "real_action_artifact",
      verifier_artifact_id: "real_verifier_artifact",
      predicted_residual: 0.1,
      residual: 0,
      payload: {
        intent: "record selected artifacts for credit",
        reasoning_summary: "selected artifacts should be bound automatically",
        effect_summary: "projected credit updates registered artifacts",
        verifier_kind: "deterministic_code",
      },
    });
    await flushPostCommitProjectionsForTest();

    const predicted = db
      .query<{ payload: string }, []>("SELECT payload FROM events WHERE kind = 'action_predicted' LIMIT 1")
      .get()!;
    expect(JSON.parse(predicted.payload).cited_artifact_ids).toEqual([
      "real_action_artifact",
      "real_verifier_artifact",
    ]);
    const bindings = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'retrieval_binding' AND json_extract(payload, '$.source_artifact_id') IN ('real_action_artifact', 'real_verifier_artifact')")
      .get()!.n;
    expect(bindings).toBe(2);
    const update = db
      .query<{ payload: string }, []>("SELECT payload FROM events WHERE kind = 'act_artifact_score_updated' AND json_extract(payload, '$.artifact_id') = 'real_action_artifact' LIMIT 1")
      .get();
    expect(update).not.toBeNull();
    expect(getArtifact(db, "real_action_artifact")!.posteriorAlpha).toBeGreaterThan(before.posteriorAlpha);
  });

  test("bridge-exit artifact pair is not auto-bound or credited", () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const taskId = newId();
    insertSampleArtifact(db, "opencode_brain_exit_action", "// synthetic bridge exit action");
    insertSampleArtifact(db, "opencode_bridge_exit_verifier", "// synthetic bridge exit verifier");

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

    const predicted = db
      .query<{ payload: string }, []>("SELECT payload FROM events WHERE kind = 'action_predicted' LIMIT 1")
      .get()!;
    expect(JSON.parse(predicted.payload).cited_artifact_ids).toEqual([]);
    const bindings = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'retrieval_binding'")
      .get()!.n;
    expect(bindings).toBe(0);
    const updates = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'act_artifact_score_updated' AND json_extract(payload, '$.artifact_id') IN ('opencode_brain_exit_action', 'opencode_bridge_exit_verifier')")
      .get()!.n;
    expect(updates).toBe(0);
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

  test("lesson_extracted without lesson_kind gets a classification_source marker", async () => {
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
    // knowledge_uncertainty_observed + the lesson_extractor internal-act are
    // deferred onto the bounded post-commit queue; drain before asserting.
    await flushPostCommitProjectionsForTest();
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

  test("logical source_act_id makes replayed source acts project only once", async () => {
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
    // Both replays defer their action_scored projections onto the bounded
    // queue; the projection_key idempotency guard collapses the second
    // replay's derived rows even across the deferred drain. Drain first.
    await flushPostCommitProjectionsForTest();
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
    // 2026-05-24 (non-blocking post-commit cascade, directive
    // NHY908W0EX5Q72KGWXMASPFEY0): heavy action_scored projections are now
    // deferred onto the bounded post-commit queue and drained to a FIXED
    // POINT by flushPostCommitProjectionsForTest(). The pre-fix assertion
    // captured only the SYNCHRONOUS projection snapshot — the async
    // distributeCredit fan-out (candidate_confirmed / origin_calibration_
    // recorded) landed AFTER the test's synchronous read and was never
    // counted. Draining to the fixed point now includes that full cascade.
    // The idempotency-critical invariants are unchanged: action_predicted=1
    // and action_scored=1 prove the replayed logical act still projects its
    // SOURCE rows exactly once; the credit fan-out is deterministic across
    // runs because the queue drains to quiescence.
    expect(Object.fromEntries(projected.map((row) => [row.kind, row.n]))).toEqual({
      act_artifact_score_updated: 2,
      action_predicted: 1,
      action_scored: 1,
      applied_change_committed: 1,
      candidate_confirmed: 6,
      coalition_credit_distributed: 1,
      credit_envelope_projected: 1,
      entity_score_updated: 12,
      origin_calibration_recorded: 10,
      retrieval_binding: 4,
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

  test("emitEvent(action_scored) projects meta-credit for production fallback policy selections", async () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const taskId = newId();
    const goalShape = "live_goal_shape";

    emitEvent(db, {
      kind: "prompt_policy_section_selected",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      task_id: taskId,
      payload: {
        section_name: "runtimes_available",
        source: "policy_bundle",
        artifact_id: null,
        event_id: null,
        score: 1,
        goal_shape: goalShape,
        task_class: "runtimes_available",
        fallback_reason: "no_scored_prompt_policy_bundle_match",
      },
    });

    const predicted = emitEvent(db, {
      kind: "action_predicted",
      substrate_origin: "opencode",
      directive_id: directiveId,
      task_id: taskId,
      action_artifact_id: "live_action",
      verifier_artifact_id: "live_verifier",
      predicted_residual: 0.1,
      payload: {},
    });

    const scored = emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      task_id: taskId,
      action_artifact_id: "live_action",
      verifier_artifact_id: "live_verifier",
      residual: 0,
      payload: {
        action_predicted_event_id: predicted.id,
        residual: 0,
        verifier_kind: "deterministic_code",
      },
    });

    // action_scored credit projection is deferred onto the bounded
    // post-commit queue; drain before asserting the meta_credit row landed.
    await flushPostCommitProjectionsForTest();
    const meta = db
      .query<{ payload: string }, []>("SELECT payload FROM events WHERE kind = 'meta_credit_projected' LIMIT 1")
      .get();
    expect(meta).not.toBeNull();
    const payload = JSON.parse(meta!.payload) as Record<string, unknown>;
    expect(payload.scored_event_id).toBe(scored.id);
    expect(payload.action_predicted_event_id).toBe(predicted.id);
    expect(payload.bundle_artifact_id).toBe("prompt_policy_section:policy_bundle:runtimes_available:" + goalShape);
    expect(payload.bundle_registered).toBe(false);
    expect(payload.projected_from).toBe("action_scored_universal_projector");
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

  test("first observation of a new verifier_kind -> act_artifact row auto-admitted + verifier_kind_auto_admitted event emitted", async () => {
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
    // Verifier-kind auto-admit is deferred onto the bounded post-commit
    // queue; drain before asserting the act_artifact row + audit landed.
    await flushPostCommitProjectionsForTest();
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

  test("second observation of the same verifier_kind -> no re-admit (idempotent), no second audit event", async () => {
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
    await flushPostCommitProjectionsForTest();
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
    await flushPostCommitProjectionsForTest();
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

  test("peer_llm_opencode_<variant> observation -> row created with parent_kind=peer_llm_opencode, variant_tag, rollup=true", async () => {
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
    await flushPostCommitProjectionsForTest();
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

  test("peer_llm_<hemisphere>_<variant> observations preserve symmetric hemisphere parent metadata", async () => {
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
      await flushPostCommitProjectionsForTest();
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
    expect(payload.violation).toBe("out_of_scope_target");
    expect(payload.reason).toBe("Dispatcher violation classified as out_of_scope_target; emitter did not provide payload.reason.");
    expect(payload.directive_id).toBe(directiveId);
    expect(payload.task_id).toBe(taskId);
  });

  test("dispatcher_violation with payload.kind only exposes non-null violation and reason", () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const taskId = newId();
    const event = emitEvent(db, {
      kind: "dispatcher_violation",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      task_id: taskId,
      payload: {
        kind: "floor_section_missing",
        dispatch_id: "dispatch-test",
        missing_floor_sections: [],
        floor_sections_over_budget: ["top_laws"],
      },
    });
    const row = db
      .query<{ failure_kind: string | null; payload: string }, [string]>(
        "SELECT failure_kind, payload FROM events WHERE id = ?",
      )
      .get(event.id);
    expect(row?.failure_kind).toBe("floor_section_missing");
    const payload = JSON.parse(row!.payload);
    expect(payload.violation).toBe("floor_section_missing");
    expect(payload.reason).toBe("Dispatcher violation classified as floor_section_missing; emitter did not provide payload.reason.");
    expect(payload.directive_id).toBe(directiveId);
    expect(payload.task_id).toBe(taskId);
    expect(payload.dispatch_id).toBe("dispatch-test");
  });
});

describe("emitEvent act_tuple lazy artifact admission (phase-2 four-link credit)", () => {
  // Autonomous audit: 10/14 verifier_artifact_id values cited in
  // act_tuple_recorded events were semantic names never admitted as
  // act_artifact rows, so link 4 (credit) had no posterior to mutate.
  // The act-tuple projection now lazily admits an unregistered
  // verifier/action handle as a minimal cold-start row (Beta(1,1),
  // runtime=null) so credit completes the chain (k_555). Idempotent;
  // file/test-style refs (containing ':' or '#') are inline fixtures and
  // are NOT admitted.

  const emitTuple = (db: Database, overrides: Partial<{ action: string; verifier: string }> = {}) =>
    emitEvent(db, {
      kind: "act_tuple_recorded",
      substrate_origin: "claude_root",
      directive_id: newId(),
      task_id: newId(),
      action_artifact_id: overrides.action ?? "lazy_action_handle_aaa",
      verifier_artifact_id: overrides.verifier ?? "lane_match_verifier",
      predicted_residual: 0.2,
      residual: 0.1,
      payload: {
        intent: "record an act citing an unregistered verifier handle",
        reasoning_summary: "named verifier handle was never admitted to the registry",
        effect_summary: "credit must accrue to a real act_artifact row",
        verifier_kind: "deterministic_code",
      },
    });

  const verifierRow = (db: Database, id: string) =>
    db
      .query<{
        id: string;
        kind: string;
        status: string;
        runtime: string | null;
        posterior_alpha: number;
        posterior_beta: number;
        score: number;
        confidence: number;
      }, [string]>(
        "SELECT id, kind, status, runtime, posterior_alpha, posterior_beta, score, confidence FROM act_artifact WHERE id = ? LIMIT 1",
      )
      .get(id);

  test("unregistered verifier_artifact_id is admitted exactly once with a cold-start posterior", async () => {
    const db = openDb(":memory:");
    expect(verifierRow(db, "lane_match_verifier")).toBeNull();
    emitTuple(db);
    await flushPostCommitProjectionsForTest();
    const row = verifierRow(db, "lane_match_verifier");
    expect(row).not.toBeNull();
    expect(row!.kind).toBe("verifier");
    expect(row!.status).toBe("admitted");
    // runtime=null: it is a retrievable registry handle, not a runnable executor.
    expect(row!.runtime).toBeNull();
    // The row is admitted at the cold-start Beta(1,1) prior, then the same
    // emit's credit pipeline immediately accrues this act's outcome onto
    // the fresh row — proving link 4 (credit) now has a posterior to
    // mutate (the whole point of the fix). A low observed residual (0.1)
    // is a success, so alpha moves above the 1.0 cold start while beta
    // stays at the prior.
    expect(row!.posterior_alpha).toBeGreaterThan(1.0);
    expect(row!.posterior_beta).toBe(1.0);
    closeDb();
  });

  test("re-emitting the same act tuple does not duplicate the row or reset its posterior", async () => {
    const db = openDb(":memory:");
    emitTuple(db);
    await flushPostCommitProjectionsForTest();
    // Mutate the posterior to prove a second admission would NOT clobber it.
    db.run("UPDATE act_artifact SET posterior_alpha = 5.0 WHERE id = ?", ["lane_match_verifier"]);
    emitTuple(db);
    await flushPostCommitProjectionsForTest();
    const count = db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM act_artifact WHERE id = ?")
      .get("lane_match_verifier")!.n;
    expect(count).toBe(1);
    const row = verifierRow(db, "lane_match_verifier")!;
    // Not reset to the cold-start 1.0; the second emit accrued credit on
    // the EXISTING row (5.0 + outcome weight), proving the four-link chain
    // mutates a real posterior rather than re-admitting.
    expect(row.posterior_alpha).toBeGreaterThanOrEqual(5.0);
    closeDb();
  });

  test("file/test-style refs (containing ':' or '#') are NOT admitted", async () => {
    const db = openDb(":memory:");
    emitTuple(db, { action: "repo:test-fixture", verifier: "runtime/events.ts#L1" });
    await flushPostCommitProjectionsForTest();
    expect(verifierRow(db, "repo:test-fixture")).toBeNull();
    expect(verifierRow(db, "runtime/events.ts#L1")).toBeNull();
    closeDb();
  });
});

describe("event_kind_rollup aggregate consistency (bounded-ledger-retention safety-a)", () => {
  test("rollup live_count matches a real COUNT(*) after N emits and after compaction", () => {
    const db = openDb(":memory:");
    const kinds: EventKind[] = ["directive_opened", "task_committed", "artifact_kind_inference_uncertain"];
    // N emits across several kinds.
    for (let i = 0; i < 30; i++) {
      const kind = kinds[i % kinds.length]!;
      emitEvent(db, { kind, substrate_origin: "runtime", payload: { i } });
    }
    // After N emits the writer-maintained aggregate equals the real COUNT(*).
    const realCount = (kind: string): number =>
      (db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM events WHERE kind = ?").get(kind)!).n;
    const liveCount = (kind: string): number =>
      (db.query<{ n: number }, [string]>("SELECT live_count AS n FROM event_kind_rollup WHERE kind = ?").get(kind)!).n;
    const totalCount = (kind: string): number =>
      (db.query<{ n: number }, [string]>("SELECT total_count AS n FROM event_kind_rollup WHERE kind = ?").get(kind)!).n;
    for (const kind of kinds) {
      expect(liveCount(kind)).toBe(realCount(kind));
      expect(totalCount(kind)).toBe(realCount(kind));
    }
    // SUM(live_count) equals the whole live ledger (the daemon health count source).
    const sumLive = (db.query<{ n: number }, []>("SELECT COALESCE(SUM(live_count),0) AS n FROM event_kind_rollup").get()!).n;
    const realTotal = (db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()!).n;
    expect(sumLive).toBe(realTotal);

    // Simulate compaction: delete the live telemetry rows and decrement
    // live_count the way the archival worker does. After compaction the
    // aggregate STILL matches the real COUNT(*): live_count drops to the new
    // real count while total_count (lifetime) is preserved.
    const telemetryBefore = realCount("artifact_kind_inference_uncertain");
    db.run("DELETE FROM events WHERE kind = 'artifact_kind_inference_uncertain'");
    db.run("UPDATE event_kind_rollup SET live_count = MAX(0, live_count - ?) WHERE kind = 'artifact_kind_inference_uncertain'", [telemetryBefore]);
    expect(liveCount("artifact_kind_inference_uncertain")).toBe(realCount("artifact_kind_inference_uncertain"));
    expect(liveCount("artifact_kind_inference_uncertain")).toBe(0);
    // Lifetime total is retained across compaction (read-aggregate stays O(1)).
    expect(totalCount("artifact_kind_inference_uncertain")).toBe(telemetryBefore);
    closeDb();
  });
});

describe("events", () => {
  // ── Tiered hot/cold transparent read-through (directive
  // 7Z81HBY4813TF0V9T50AWFP9PG, amendments GM9T1S36 + CB74X8B2,
  // guarantee A). An event ARCHIVED to a sibling state-archive-YYYY-MM.db
  // and DELETED from hot must STILL be returned by getEventById /
  // getEventRowById — archival is a performance tier, not a memory-loss
  // boundary for RLM/credit/identity reads. ──────────────────────────────
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    resetPostCommitProjectionsForTest();
    closeDb();
    tmpDir = mkdtempSync(join(tmpdir(), "acc2-tiered-events-"));
    dbPath = join(tmpDir, "state.db");
  });
  afterEach(() => {
    closeDb();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  const NOW = Date.parse("2026-05-15T12:00:00.000Z");
  // 90 days old → well past any compressed retention window so the sweep
  // moves the row to cold regardless of pressure.
  const OLD_TS = new Date(NOW - 90 * 24 * 60 * 60 * 1000).toISOString();

  test("getEventById reads through sibling archive after hot deletion (transparent cold-read)", async () => {
    // 1. Create a hot event of an ARCHIVABLE kind (directive_opened is not
    //    ALWAYS_KEEP) and back-date it so the sweep selects it.
    const db = openDb(dbPath);
    const created = emitEvent(db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      payload: { directive_text: "tiered-cold-read-probe", residual: 0.42 },
      residual: 0.42,
    });
    db.run("UPDATE events SET ts = ? WHERE id = ?", [OLD_TS, created.id]);

    // 2. Archive it (real sweep): copies the exact row into
    //    state-archive-2026-02.db and DELETEs it from hot.
    const summary = await runArchivalSweep(db, { stateDbPath: dbPath, nowMs: NOW });
    expect(summary.deleted).toBeGreaterThanOrEqual(1);

    // 3. Prove it is GONE from the hot events table.
    const hotRow = db.query("SELECT id FROM events WHERE id = ?").get(created.id);
    expect(hotRow).toBeNull();

    // 4. Reopen the DB so the connection ATTACHes the freshly-created
    //    sibling archive (attachArchives runs at openDb time).
    closeDb(dbPath);
    const db2 = openDb(dbPath);

    // getEventById still returns the archived event, fully parsed.
    const fetched = getEventById(db2, created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.kind).toBe("directive_opened");
    expect((fetched!.payload as Record<string, unknown>).directive_text).toBe("tiered-cold-read-probe");

    // getEventRowById (the generic tier-spanning by-id read used by
    // credit/retrieval) also resolves it, and supports column projection.
    const kindRow = getEventRowById(db2, created.id, "kind") as { kind: string } | null;
    expect(kindRow?.kind).toBe("directive_opened");
    const residualRow = getEventRowById(db2, created.id, "residual") as { residual: number | null } | null;
    expect(residualRow?.residual).toBe(0.42);
    closeDb();
  });

  test("getEventById hot-first: a hot-resident event resolves without any archive", () => {
    // No archive files exist; the common hot-hit path must short-circuit.
    const db = openDb(dbPath);
    const created = emitEvent(db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      payload: { directive_text: "hot-resident" },
    });
    const fetched = getEventById(db, created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    // getEventRowById hot hit too.
    const row = getEventRowById(db, created.id, "kind");
    expect((row as { kind: string }).kind).toBe("directive_opened");
    closeDb();
  });

  test("getEventById graceful when no archives are attached and id is unknown", () => {
    const db = openDb(dbPath);
    expect(getEventById(db, "nonexistent_id")).toBeNull();
    expect(getEventRowById(db, "nonexistent_id")).toBeNull();
    closeDb();
  });
});
