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
