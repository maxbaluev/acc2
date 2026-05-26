import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { runViews } from "../substrate/views";
import { emitEvent } from "./events";
import { newId } from "./ids";
import {
  cascadeUpwardWhenChildrenTerminal,
  descendantTaskIds,
  rootCommitReadiness,
  closedDirectiveIds,
  directiveCloseReason,
  directiveCoverage,
  maybeCloseFinishedDirective,
} from "./directive_closure";
import { openFrontier } from "./task_descendants";
import { readyTasks } from "./task_topology";

afterAll(() => closeDb());
beforeEach(() => closeDb());

// lesson_coverage_hard_gate: every terminal-COMMITTED node must attempt a
// lesson. The cheapest VALID attempt for fixtures that aren't exercising the
// lesson dimension is the explicit no_new_lesson marker (a lesson_extracted
// payload flag carrying reason + evidence). Helper keeps the prior fully-covered
// graphs valid without weakening the gate.
const markNoNewLesson = (
  db: ReturnType<typeof openDb>,
  directiveId: string,
  taskId: string,
) =>
  emitEvent(db, {
    kind: "lesson_extracted",
    substrate_origin: "brain",
    directive_id: directiveId,
    task_id: taskId,
    payload: { no_new_lesson: true, reason: "fixture: nothing new to learn", evidence: "fixture" },
  });

const openFiniteDirective = (db: ReturnType<typeof openDb>) => {
  const directiveId = newId();
  const taskId = newId();
  emitEvent(db, {
    kind: "directive_opened",
    substrate_origin: "owner",
    directive_id: directiveId,
    task_id: directiveId,
    payload: { directive_text: "fixture", lifecycle: "finite" },
  });
  emitEvent(db, {
    kind: "task_node_opened",
    substrate_origin: "owner",
    directive_id: directiveId,
    task_id: taskId,
    parent_task_id: null,
    payload: { goal: "fixture goal" },
  });
  return { directiveId, taskId };
};

describe("directive_closure", () => {
  test("directiveCloseReason returns null while a task is still live", () => {
    const db = openDb(":memory:");
    const { directiveId } = openFiniteDirective(db);
    expect(directiveCloseReason(db, directiveId)).toBeNull();
  });

  test("directiveCloseReason returns reason once every task is terminal", () => {
    const db = openDb(":memory:");
    const { directiveId, taskId } = openFiniteDirective(db);
    emitEvent(db, {
      kind: "task_committed",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      task_id: taskId,
      payload: {},
    });
    markNoNewLesson(db, directiveId, taskId);
    expect(directiveCloseReason(db, directiveId)).toBe("all_tasks_terminal");
  });

  test("rolling_active directives never auto-close", () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const taskId = newId();
    emitEvent(db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: directiveId,
      payload: { directive_text: "rolling", lifecycle: "rolling_active" },
    });
    emitEvent(db, {
      kind: "task_node_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: taskId,
      parent_task_id: null,
      payload: { goal: "rolling root" },
    });
    emitEvent(db, {
      kind: "task_committed",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      task_id: taskId,
      payload: {},
    });
    expect(directiveCloseReason(db, directiveId)).toBeNull();
    expect(maybeCloseFinishedDirective(db, directiveId)).toBeNull();
  });

  test("maybeCloseFinishedDirective is idempotent — emits at most one directive_closed", () => {
    const db = openDb(":memory:");
    const { directiveId, taskId } = openFiniteDirective(db);
    emitEvent(db, {
      kind: "task_committed",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      task_id: taskId,
      payload: {},
    });
    markNoNewLesson(db, directiveId, taskId);

    expect(maybeCloseFinishedDirective(db, directiveId)).toBe("all_tasks_terminal");
    expect(maybeCloseFinishedDirective(db, directiveId)).toBeNull();

    const closedRows = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'directive_closed' AND directive_id = ?")
      .get(directiveId) as { c: number };
    expect(closedRows.c).toBe(1);
  });

  test("closedDirectiveIds includes directives closed by either auto-close or operator archive", () => {
    const db = openDb(":memory:");
    const auto = openFiniteDirective(db);
    emitEvent(db, {
      kind: "task_committed",
      substrate_origin: "substrate_auto",
      directive_id: auto.directiveId,
      task_id: auto.taskId,
      payload: {},
    });
    markNoNewLesson(db, auto.directiveId, auto.taskId);
    maybeCloseFinishedDirective(db, auto.directiveId);

    const archived = openFiniteDirective(db);
    emitEvent(db, {
      kind: "directive_archived_by_operator",
      substrate_origin: "owner",
      directive_id: archived.directiveId,
      payload: { reason: "owner_cleanup" },
    });

    const live = openFiniteDirective(db);

    const closed = closedDirectiveIds(db);
    expect(closed.has(auto.directiveId)).toBe(true);
    expect(closed.has(archived.directiveId)).toBe(true);
    expect(closed.has(live.directiveId)).toBe(false);
  });

  test("readyTasks() skips tasks under closed directives — structural zombie-loop fix", () => {
    const db = openDb(":memory:");
    runViews(db);

    // Live directive — its task should appear in readyTasks.
    const live = openFiniteDirective(db);

    // Closed directive — committed task, then maybeClose fires.
    const done = openFiniteDirective(db);
    emitEvent(db, {
      kind: "task_committed",
      substrate_origin: "substrate_auto",
      directive_id: done.directiveId,
      task_id: done.taskId,
      payload: {},
    });
    markNoNewLesson(db, done.directiveId, done.taskId);
    maybeCloseFinishedDirective(db, done.directiveId);

    // Directive whose root is committed but no directive_closed event was
    // emitted (worker hasn't run yet). The pre-Batch-2 contract was that
    // committed tasks alone keep readyTasks() honest — we don't break that.
    const finishedButNotClosed = openFiniteDirective(db);
    emitEvent(db, {
      kind: "task_committed",
      substrate_origin: "substrate_auto",
      directive_id: finishedButNotClosed.directiveId,
      task_id: finishedButNotClosed.taskId,
      payload: {},
    });
    // (intentionally NOT calling maybeCloseFinishedDirective here)

    const ready = readyTasks(db);
    const readyIds = new Set(ready.map((n) => n.id));
    expect(readyIds.has(live.taskId)).toBe(true);
    expect(readyIds.has(done.taskId)).toBe(false);
    expect(readyIds.has(finishedButNotClosed.taskId)).toBe(false);
  });

  test("directive_resumed unblocks a previously-archived directive", () => {
    const db = openDb(":memory:");
    runViews(db);
    const { directiveId, taskId } = openFiniteDirective(db);
    // Archive it
    emitEvent(db, {
      kind: "directive_archived_by_operator",
      substrate_origin: "owner",
      directive_id: directiveId,
      payload: { reason: "test" },
    });
    expect(closedDirectiveIds(db).has(directiveId)).toBe(true);
    // Now resume it
    emitEvent(db, {
      kind: "directive_resumed",
      substrate_origin: "owner",
      directive_id: directiveId,
      payload: { prior_state: "directive_archived_by_operator" },
    });
    expect(closedDirectiveIds(db).has(directiveId)).toBe(false);
    // readyTasks should once again include the task
    const ready = readyTasks(db);
    const ids = new Set(ready.map((n) => n.id));
    expect(ids.has(taskId)).toBe(true);
  });

  test("rootCommitReadiness blocks root success while descendants are non-terminal", () => {
    const db = openDb(":memory:"); runViews(db);
    const directiveId = newId(); const rootTaskId = newId(); const childA = newId(); const childB = newId();
    emitEvent(db, { kind: "directive_opened", substrate_origin: "owner", directive_id: directiveId, task_id: directiveId, payload: { directive_text: "readiness fixture", lifecycle: "finite" } });
    emitEvent(db, { kind: "task_node_opened", substrate_origin: "owner", directive_id: directiveId, task_id: rootTaskId, parent_task_id: null, payload: { goal: "root goal" } });
    for (const id of [childA, childB]) { emitEvent(db, { kind: "task_node_opened", substrate_origin: "owner", directive_id: directiveId, task_id: id, parent_task_id: rootTaskId, payload: { goal: `child ${id}` } }); emitEvent(db, { kind: "task_edge_recorded", substrate_origin: "owner", directive_id: directiveId, task_id: rootTaskId, payload: { kind: "refines", from_task: rootTaskId, to_task: id } }); }
    expect(descendantTaskIds(db, rootTaskId).sort()).toEqual([childA, childB].sort());
    expect(rootCommitReadiness(db, rootTaskId)).toMatchObject({ ok: false, reason: "missing_clean_closure_audit" });
    emitEvent(db, { kind: "task_closure_audited", substrate_origin: "brain", directive_id: directiveId, task_id: rootTaskId, residual: 0.12, payload: { closure_residual: 0.12, residual_provenance: "substrate_verified", reliability_profile: { verified: true } } });
    expect(rootCommitReadiness(db, rootTaskId)).toMatchObject({ ok: false, reason: "nonterminal_descendants", nonterminal_descendant_task_ids: expect.arrayContaining([childA, childB]) });
    for (const id of [childA, childB]) emitEvent(db, { kind: "task_committed", substrate_origin: "brain", directive_id: directiveId, task_id: id, payload: { summary: "child done" } });
    expect(rootCommitReadiness(db, rootTaskId)).toMatchObject({ ok: true, closure_residual: 0.12 });
  });

  test("openFrontier counts open decomposition descendants and drains to commit-eligible (frontier_drainer)", () => {
    const db = openDb(":memory:"); runViews(db);
    const directiveId = newId(); const rootTaskId = newId(); const childA = newId(); const childB = newId();
    emitEvent(db, { kind: "directive_opened", substrate_origin: "owner", directive_id: directiveId, task_id: directiveId, payload: { directive_text: "frontier fixture", lifecycle: "finite" } });
    emitEvent(db, { kind: "task_node_opened", substrate_origin: "owner", directive_id: directiveId, task_id: rootTaskId, parent_task_id: null, payload: { goal: "root goal" } });
    for (const id of [childA, childB]) emitEvent(db, { kind: "task_node_opened", substrate_origin: "owner", directive_id: directiveId, task_id: id, parent_task_id: rootTaskId, payload: { goal: `child ${id}` } });

    // Two open descendants → frontier count 2, root NOT terminal-eligible.
    let f = openFrontier(db, rootTaskId);
    expect(f.open_count).toBe(2);
    expect(f.total_descendant_count).toBe(2);
    expect(f.open_descendant_task_ids.sort()).toEqual([childA, childB].sort());

    // Clean closure but open frontier → wait_on_frontier, root NOT ok.
    emitEvent(db, { kind: "task_closure_audited", substrate_origin: "brain", directive_id: directiveId, task_id: rootTaskId, residual: 0.1, payload: { closure_residual: 0.1, residual_provenance: "substrate_verified", reliability_profile: { verified: true } } });
    expect(rootCommitReadiness(db, rootTaskId)).toMatchObject({ ok: false, reason: "nonterminal_descendants", status_reason: "wait_on_frontier", open_frontier_count: 2 });

    // Drain one descendant → frontier shrinks, root still parked.
    emitEvent(db, { kind: "task_committed", substrate_origin: "brain", directive_id: directiveId, task_id: childA, payload: { summary: "A done" } });
    f = openFrontier(db, rootTaskId);
    expect(f.open_count).toBe(1);
    expect(f.open_descendant_task_ids).toEqual([childB]);
    expect(rootCommitReadiness(db, rootTaskId)).toMatchObject({ ok: false, status_reason: "wait_on_frontier", open_frontier_count: 1 });

    // Drain the last descendant → frontier empty, root becomes commit-eligible.
    emitEvent(db, { kind: "task_committed", substrate_origin: "brain", directive_id: directiveId, task_id: childB, payload: { summary: "B done" } });
    expect(openFrontier(db, rootTaskId).open_count).toBe(0);
    expect(rootCommitReadiness(db, rootTaskId)).toMatchObject({ ok: true, open_frontier_count: 0 });
  });

  test("cascadeUpwardWhenChildrenTerminal seals the parent once every refines-child is terminal", () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const rootId = newId();
    const childA = newId();
    const childB = newId();
    emitEvent(db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: directiveId,
      payload: { directive_text: "upward", lifecycle: "finite" },
    });
    emitEvent(db, {
      kind: "task_node_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: rootId,
      parent_task_id: null,
      payload: { goal: "root" },
    });
    for (const id of [childA, childB]) {
      emitEvent(db, {
        kind: "task_node_opened",
        substrate_origin: "owner",
        directive_id: directiveId,
        task_id: id,
        parent_task_id: rootId,
        payload: { goal: `child ${id}` },
      });
      emitEvent(db, {
        kind: "task_edge_recorded",
        substrate_origin: "owner",
        directive_id: directiveId,
        task_id: rootId,
        payload: { kind: "refines", from_task: rootId, to_task: id },
      });
    }
    // Commit childA only — parent should NOT yet cascade.
    emitEvent(db, {
      kind: "task_committed",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: childA,
      payload: { summary: "did A" },
    });
    expect(cascadeUpwardWhenChildrenTerminal(db, childA)).toBe(0);
    // Confirm root still uncommitted.
    const rootBefore = db
      .query(`SELECT COUNT(*) AS c FROM events WHERE kind='task_committed' AND task_id=?`)
      .get(rootId) as { c: number };
    expect(rootBefore.c).toBe(0);

    emitEvent(db, {
      kind: "task_closure_audited",
      substrate_origin: "brain",
      directive_id: directiveId,
      task_id: rootId,
      residual: 0.1,
      payload: { closure_residual: 0.1, residual_provenance: "substrate_verified", reliability_profile: { verified: true } },
    });

    // Commit childB — parent should now cascade because closure audit is clean.
    emitEvent(db, {
      kind: "task_committed",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: childB,
      payload: { summary: "did B" },
    });
    expect(cascadeUpwardWhenChildrenTerminal(db, childB)).toBe(1);
    const rootAfter = db
      .query(`SELECT payload FROM events WHERE kind='task_committed' AND task_id=? ORDER BY ts ASC LIMIT 1`)
      .get(rootId) as { payload: string } | null;
    expect(rootAfter).not.toBeNull();
    const p = JSON.parse(rootAfter!.payload) as Record<string, unknown>;
    expect(p.reason).toBe("cascaded_upward_from_all_children_terminal");
    expect(p.child_task_id).toBe(childB);
  });

  test("cascadeUpwardWhenChildrenTerminal is idempotent and stops at terminal ancestors", () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const rootId = newId();
    const childId = newId();
    emitEvent(db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: directiveId,
      payload: { directive_text: "idem", lifecycle: "finite" },
    });
    emitEvent(db, {
      kind: "task_node_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: rootId,
      parent_task_id: null,
      payload: { goal: "root" },
    });
    emitEvent(db, {
      kind: "task_node_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: childId,
      parent_task_id: rootId,
      payload: { goal: "child" },
    });
    emitEvent(db, {
      kind: "task_edge_recorded",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: rootId,
      payload: { kind: "refines", from_task: rootId, to_task: childId },
    });
    emitEvent(db, {
      kind: "task_closure_audited",
      substrate_origin: "brain",
      directive_id: directiveId,
      task_id: rootId,
      residual: 0.1,
      payload: { closure_residual: 0.1, residual_provenance: "substrate_verified", reliability_profile: { verified: true } },
    });
    emitEvent(db, {
      kind: "task_committed",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: childId,
      payload: {},
    });
    expect(cascadeUpwardWhenChildrenTerminal(db, childId)).toBe(1);
    // Re-call — root is now terminal, no further cascade.
    expect(cascadeUpwardWhenChildrenTerminal(db, childId)).toBe(0);
    // Only one task_committed for root.
    const cnt = db
      .query(`SELECT COUNT(*) AS c FROM events WHERE kind='task_committed' AND task_id=?`)
      .get(rootId) as { c: number };
    expect(cnt.c).toBe(1);
  });

  test("ready_tasks_view (SQL) also filters closed directives", () => {
    const db = openDb(":memory:");
    runViews(db);

    const live = openFiniteDirective(db);
    const done = openFiniteDirective(db);
    emitEvent(db, {
      kind: "task_committed",
      substrate_origin: "substrate_auto",
      directive_id: done.directiveId,
      task_id: done.taskId,
      payload: {},
    });
    markNoNewLesson(db, done.directiveId, done.taskId);
    maybeCloseFinishedDirective(db, done.directiveId);

    const rows = db
      .query("SELECT task_id FROM ready_tasks_view")
      .all() as Array<{ task_id: string }>;
    const ids = new Set(rows.map((r) => r.task_id));
    expect(ids.has(live.taskId)).toBe(true);
    expect(ids.has(done.taskId)).toBe(false);
  });
});

describe("coverage_invariant_hard_gate", () => {
  const mkDirective = (db: ReturnType<typeof openDb>) => {
    const directiveId = newId();
    const rootTaskId = newId();
    emitEvent(db, { kind: "directive_opened", substrate_origin: "owner", directive_id: directiveId, task_id: directiveId, payload: { directive_text: "cov fixture", lifecycle: "finite" } });
    emitEvent(db, { kind: "task_node_opened", substrate_origin: "owner", directive_id: directiveId, task_id: rootTaskId, parent_task_id: null, payload: { goal: "root" } });
    return { directiveId, rootTaskId };
  };
  const addChild = (db: ReturnType<typeof openDb>, directiveId: string, rootTaskId: string, childId: string, extra: Record<string, unknown> = {}) => {
    emitEvent(db, { kind: "task_node_opened", substrate_origin: "owner", directive_id: directiveId, task_id: childId, parent_task_id: rootTaskId, payload: { goal: "child", ...extra } });
    emitEvent(db, { kind: "task_edge_recorded", substrate_origin: "owner", directive_id: directiveId, task_id: rootTaskId, payload: { kind: "refines", from_task: rootTaskId, to_task: childId } });
  };
  // term() commits/fails a node. For committed nodes it also emits the
  // no_new_lesson marker (lesson_coverage_hard_gate) so the node satisfies the
  // lesson-coverage dimension by default; failed/abandoned nodes are exempt.
  const term = (db: ReturnType<typeof openDb>, directiveId: string, taskId: string, kind: "task_committed" | "task_failed" | "task_abandoned" = "task_committed") => {
    emitEvent(db, { kind, substrate_origin: "brain", directive_id: directiveId, task_id: taskId, payload: {} });
    if (kind === "task_committed") markNoNewLesson(db, directiveId, taskId);
  };
  // A root with descendants may only commit after a clean closure audit (the
  // existing events.ts root-commit gate), so realistic fixtures audit then commit.
  const commitRoot = (db: ReturnType<typeof openDb>, directiveId: string, rootTaskId: string) => {
    emitEvent(db, { kind: "task_closure_audited", substrate_origin: "brain", directive_id: directiveId, task_id: rootTaskId, residual: 0.12, payload: { closure_residual: 0.12, residual_provenance: "substrate_verified", reliability_profile: { verified: true } } });
    emitEvent(db, { kind: "task_committed", substrate_origin: "brain", directive_id: directiveId, task_id: rootTaskId, payload: {} });
    markNoNewLesson(db, directiveId, rootTaskId);
  };

  test("deliverable-declared leaf with no committed deliverable blocks closure until emitted", () => {
    const db = openDb(":memory:");
    const { directiveId, rootTaskId } = mkDirective(db);
    const child = newId();
    addChild(db, directiveId, rootTaskId, child, { requires_deliverable: true });
    term(db, directiveId, child);
    commitRoot(db, directiveId, rootTaskId);
    // all terminal, but the child declared a deliverable and emitted none
    expect(directiveCloseReason(db, directiveId)).toBeNull();
    expect(directiveCoverage(db, directiveId)?.missing_deliverables).toContain(child);
    // now emit the deliverable artifact → fully covered
    emitEvent(db, { kind: "act_artifact_candidate", substrate_origin: "brain", directive_id: directiveId, task_id: child, payload: { body: "real body" } });
    expect(directiveCoverage(db, directiveId)?.missing_deliverables).toEqual([]);
    expect(directiveCloseReason(db, directiveId)).toBe("all_tasks_terminal");
  });

  test("orphan-open node (terminal but unreachable from root) blocks closure", () => {
    const db = openDb(":memory:");
    const { directiveId, rootTaskId } = mkDirective(db);
    const orphan = newId();
    // opened under a parent that does NOT chain to the root → not a descendant
    emitEvent(db, { kind: "task_node_opened", substrate_origin: "owner", directive_id: directiveId, task_id: orphan, parent_task_id: newId(), payload: { goal: "orphan" } });
    term(db, directiveId, orphan);
    commitRoot(db, directiveId, rootTaskId);
    expect(directiveCoverage(db, directiveId)?.orphans).toContain(orphan);
    expect(directiveCloseReason(db, directiveId)).toBeNull();
  });

  test("failed leaf is covered by a committed sibling under the same parent", () => {
    const db = openDb(":memory:");
    const { directiveId, rootTaskId } = mkDirective(db);
    const failed = newId();
    const ok = newId();
    addChild(db, directiveId, rootTaskId, failed);
    addChild(db, directiveId, rootTaskId, ok);
    term(db, directiveId, failed, "task_failed");
    term(db, directiveId, ok);
    commitRoot(db, directiveId, rootTaskId);
    expect(directiveCoverage(db, directiveId)?.failed_unsuperseded).toEqual([]);
    expect(directiveCloseReason(db, directiveId)).toBe("all_tasks_terminal");
  });

  test("failed leaf with no committed sibling is failed_unsuperseded and blocks closure", () => {
    const db = openDb(":memory:");
    const { directiveId, rootTaskId } = mkDirective(db);
    const failed = newId();
    addChild(db, directiveId, rootTaskId, failed);
    term(db, directiveId, failed, "task_failed");
    commitRoot(db, directiveId, rootTaskId);
    expect(directiveCoverage(db, directiveId)?.failed_unsuperseded).toContain(failed);
    expect(directiveCloseReason(db, directiveId)).toBeNull();
  });

  test("fully-covered graph with no declared deliverables closes", () => {
    const db = openDb(":memory:");
    const { directiveId, rootTaskId } = mkDirective(db);
    const child = newId();
    addChild(db, directiveId, rootTaskId, child);
    term(db, directiveId, child);
    commitRoot(db, directiveId, rootTaskId);
    expect(directiveCoverage(db, directiveId)?.covered).toBe(true);
    expect(directiveCloseReason(db, directiveId)).toBe("all_tasks_terminal");
  });
});

describe("lesson_coverage_hard_gate", () => {
  const mkDirective = (db: ReturnType<typeof openDb>) => {
    const directiveId = newId();
    const rootTaskId = newId();
    emitEvent(db, { kind: "directive_opened", substrate_origin: "owner", directive_id: directiveId, task_id: directiveId, payload: { directive_text: "lesson fixture", lifecycle: "finite" } });
    emitEvent(db, { kind: "task_node_opened", substrate_origin: "owner", directive_id: directiveId, task_id: rootTaskId, parent_task_id: null, payload: { goal: "root" } });
    return { directiveId, rootTaskId };
  };
  const addChild = (db: ReturnType<typeof openDb>, directiveId: string, rootTaskId: string, childId: string) => {
    emitEvent(db, { kind: "task_node_opened", substrate_origin: "owner", directive_id: directiveId, task_id: childId, parent_task_id: rootTaskId, payload: { goal: "child" } });
    emitEvent(db, { kind: "task_edge_recorded", substrate_origin: "owner", directive_id: directiveId, task_id: rootTaskId, payload: { kind: "refines", from_task: rootTaskId, to_task: childId } });
  };
  const commitBare = (db: ReturnType<typeof openDb>, directiveId: string, taskId: string) =>
    emitEvent(db, { kind: "task_committed", substrate_origin: "brain", directive_id: directiveId, task_id: taskId, payload: {} });
  const commitRootBare = (db: ReturnType<typeof openDb>, directiveId: string, rootTaskId: string) => {
    emitEvent(db, { kind: "task_closure_audited", substrate_origin: "brain", directive_id: directiveId, task_id: rootTaskId, residual: 0.12, payload: { closure_residual: 0.12, residual_provenance: "substrate_verified", reliability_profile: { verified: true } } });
    emitEvent(db, { kind: "task_committed", substrate_origin: "brain", directive_id: directiveId, task_id: rootTaskId, payload: {} });
  };

  // (a) terminal-covered (committed) node with NO lesson and NO marker is a
  // missing_lesson_node and blocks closure.
  test("committed node with no lesson and no marker blocks closure", () => {
    const db = openDb(":memory:");
    const { directiveId, rootTaskId } = mkDirective(db);
    const child = newId();
    addChild(db, directiveId, rootTaskId, child);
    commitBare(db, directiveId, child);
    // root needs a lesson too, but give it one so the FAILURE is isolated to child
    commitRootBare(db, directiveId, rootTaskId);
    emitEvent(db, { kind: "lesson_extracted", substrate_origin: "brain", directive_id: directiveId, task_id: rootTaskId, payload: { proposed_action: "x" } });
    emitEvent(db, { kind: "knowledge_candidate", substrate_origin: "brain", directive_id: directiveId, task_id: rootTaskId, payload: { claim: "k" } });
    const cov = directiveCoverage(db, directiveId)!;
    expect(cov.missing_lesson_nodes).toContain(child);
    expect(cov.covered).toBe(false);
    expect(directiveCloseReason(db, directiveId)).toBeNull();
  });

  // (b) emitting lesson_extracted + knowledge_candidate clears the node.
  test("lesson_extracted + knowledge_candidate clears the missing-lesson gap", () => {
    const db = openDb(":memory:");
    const { directiveId, rootTaskId } = mkDirective(db);
    const child = newId();
    addChild(db, directiveId, rootTaskId, child);
    commitBare(db, directiveId, child);
    commitRootBare(db, directiveId, rootTaskId);
    // Positive attempts for BOTH covered nodes.
    for (const t of [rootTaskId, child]) {
      emitEvent(db, { kind: "lesson_extracted", substrate_origin: "brain", directive_id: directiveId, task_id: t, payload: { proposed_action: "do x" } });
      emitEvent(db, { kind: "knowledge_candidate", substrate_origin: "brain", directive_id: directiveId, task_id: t, payload: { claim: "k" } });
    }
    const cov = directiveCoverage(db, directiveId)!;
    expect(cov.missing_lesson_nodes).toEqual([]);
    expect(cov.covered).toBe(true);
    expect(directiveCloseReason(db, directiveId)).toBe("all_tasks_terminal");
  });

  // (c) explicit no_new_lesson marker also clears the node.
  test("explicit no_new_lesson marker clears the missing-lesson gap", () => {
    const db = openDb(":memory:");
    const { directiveId, rootTaskId } = mkDirective(db);
    const child = newId();
    addChild(db, directiveId, rootTaskId, child);
    commitBare(db, directiveId, child);
    commitRootBare(db, directiveId, rootTaskId);
    for (const t of [rootTaskId, child]) {
      markNoNewLesson(db, directiveId, t);
    }
    const cov = directiveCoverage(db, directiveId)!;
    expect(cov.missing_lesson_nodes).toEqual([]);
    expect(cov.skipped_with_reason_count).toBe(2);
    expect(cov.covered).toBe(true);
    expect(directiveCloseReason(db, directiveId)).toBe("all_tasks_terminal");
  });

  // A lesson_extracted carrying the no_new_lesson flag is NOT counted as a real
  // lesson attempt, and the positive path still requires a knowledge_candidate.
  test("no_new_lesson marker is not a real lesson; positive path needs knowledge_candidate", () => {
    const db = openDb(":memory:");
    const { directiveId, rootTaskId } = mkDirective(db);
    const child = newId();
    addChild(db, directiveId, rootTaskId, child);
    commitBare(db, directiveId, child);
    commitRootBare(db, directiveId, rootTaskId);
    // root: real lesson but NO knowledge_candidate → positive path incomplete,
    // and no marker → still missing.
    emitEvent(db, { kind: "lesson_extracted", substrate_origin: "brain", directive_id: directiveId, task_id: rootTaskId, payload: { proposed_action: "x" } });
    // child: marker → cleared.
    markNoNewLesson(db, directiveId, child);
    const cov = directiveCoverage(db, directiveId)!;
    expect(cov.missing_lesson_nodes).toContain(rootTaskId);
    expect(cov.missing_lesson_nodes).not.toContain(child);
    expect(cov.lesson_attempted_count).toBe(1); // root's real lesson
    expect(cov.knowledge_attempted_count).toBe(0);
    expect(cov.skipped_with_reason_count).toBe(1); // child's marker
    expect(cov.covered).toBe(false);
  });

  // (d) metrics counts are correct across mixed attempt shapes.
  test("metrics counts are correct (positive + negative + promoted)", () => {
    const db = openDb(":memory:");
    const { directiveId, rootTaskId } = mkDirective(db);
    const a = newId();
    const b = newId();
    addChild(db, directiveId, rootTaskId, a);
    addChild(db, directiveId, rootTaskId, b);
    commitBare(db, directiveId, a);
    commitBare(db, directiveId, b);
    commitRootBare(db, directiveId, rootTaskId);
    // a: positive attempt + promotion
    emitEvent(db, { kind: "lesson_extracted", substrate_origin: "brain", directive_id: directiveId, task_id: a, payload: { proposed_action: "x" } });
    emitEvent(db, { kind: "knowledge_candidate", substrate_origin: "brain", directive_id: directiveId, task_id: a, payload: { claim: "k" } });
    emitEvent(db, { kind: "knowledge_promoted", substrate_origin: "substrate_auto", directive_id: directiveId, task_id: a, payload: {} });
    // b: negative marker
    markNoNewLesson(db, directiveId, b);
    // root: positive attempt (no promotion, but knowledge candidate → promoted_or_pending)
    emitEvent(db, { kind: "lesson_extracted", substrate_origin: "brain", directive_id: directiveId, task_id: rootTaskId, payload: { proposed_action: "y" } });
    emitEvent(db, { kind: "knowledge_candidate", substrate_origin: "brain", directive_id: directiveId, task_id: rootTaskId, payload: { claim: "k2" } });

    const cov = directiveCoverage(db, directiveId)!;
    expect(cov.missing_lesson_nodes).toEqual([]);
    expect(cov.covered).toBe(true);
    expect(cov.lesson_attempted_count).toBe(2); // a + root
    expect(cov.knowledge_attempted_count).toBe(2); // a + root
    expect(cov.skipped_with_reason_count).toBe(1); // b
    // a (promoted) + a/root (knowledge candidate) → a, root counted; b has no knowledge candidate/promotion
    expect(cov.promoted_or_pending_count).toBe(2);
  });
});
