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
    expect(rows.map((row) => row.kind)).toEqual([
      "act_tuple_recorded",
      "retrieval_binding",
      "retrieval_binding",
      "action_predicted",
      "action_scored",
      "candidate_confirmed",
      "applied_change_committed",
    ]);
    for (const row of rows.slice(1)) {
      expect(JSON.parse(row.payload).source_act_id).toBe(act.id);
      expect(JSON.parse(row.context_refs)).toContain(act.id);
    }
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
    expect(Object.fromEntries(projected.map((row) => [row.kind, row.n]))).toEqual({
      action_predicted: 1,
      action_scored: 1,
      applied_change_committed: 1,
      candidate_confirmed: 1,
      retrieval_binding: 2,
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

    let confirmed: { payload: string } | null = null;
    for (let i = 0; i < 20; i++) {
      confirmed = db.query("SELECT payload FROM events WHERE kind = 'candidate_confirmed' AND json_extract(payload, '$.knowledge_id') = ?").get(knowledge.id) as { payload: string } | null;
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
