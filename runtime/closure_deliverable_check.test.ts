// acc2 closure deliverable check tests — closes the verifier_gap lesson
// (brain audit QQEHAW97GS0AX7TEQ717Y3P174). The closure-side helper flags
// deliverable-shaped LEAVES (no refines children) whose subtree emitted
// no concrete artifact (code_artifact_candidate / contract_amendment_proposed
// / lesson_extracted{proposed_action}).

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import { checkClosureDeliverables } from "./closure_deliverable_check";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const D = "d_test", ROOT = "t_root";
const seedRoot = (db: ReturnType<typeof openDb>, goal = "audit the substrate") =>
  emitEvent(db, { kind: "task_node_opened", directive_id: D, task_id: ROOT, payload: { goal } });

const seedLeaf = (db: ReturnType<typeof openDb>, taskId: string, goal: string, parent: string = ROOT) => {
  emitEvent(db, { kind: "task_node_opened", directive_id: D, task_id: taskId, payload: { goal } });
  emitEvent(db, { kind: "task_edge_recorded", directive_id: D, task_id: taskId, payload: { from_task: parent, to_task: taskId, kind: "refines" } });
};

describe("checkClosureDeliverables", () => {
  test("empty subtree (root only, non-deliverable goal) → ok=true, no uncovered", () => {
    const db = openDb(":memory:");
    seedRoot(db, "research the substrate"); // non-deliverable verb (audit is now deliverable)
    expect(checkClosureDeliverables(db, ROOT)).toEqual({ ok: true, uncovered_leaves: [] });
  });

  test("leaf with deliverable verb AND code_artifact_candidate emitted → ok=true", () => {
    const db = openDb(":memory:");
    seedRoot(db);
    const leaf = "t_leaf_ok";
    seedLeaf(db, leaf, "implement the growth-report renderer");
    emitEvent(db, { kind: "code_artifact_candidate", directive_id: D, task_id: leaf, payload: { runtime: "bun", body: "/* x */" } });
    expect(checkClosureDeliverables(db, ROOT)).toEqual({ ok: true, uncovered_leaves: [] });
  });

  test("leaf with deliverable verb but NOTHING emitted → ok=false, uncovered=[leaf]", () => {
    const db = openDb(":memory:");
    seedRoot(db);
    const leaf = "t_leaf_empty";
    // Mirrors the B3 symptom from dispatch CBKDWYRN: "expose a concise growth report..."
    seedLeaf(db, leaf, "expose a concise growth report for the operator");
    const r = checkClosureDeliverables(db, ROOT);
    expect(r.ok).toBe(false);
    expect(r.uncovered_leaves).toContain(leaf);
  });

  test("leaf with NON-deliverable verb (research) → ok=true (not checked)", () => {
    const db = openDb(":memory:");
    seedRoot(db);
    const leaf = "t_leaf_research";
    seedLeaf(db, leaf, "research the failure modes in the embedder backlog");
    // No artifact emitted, but the verb is non-imperative — closure ignores it.
    expect(checkClosureDeliverables(db, ROOT)).toEqual({ ok: true, uncovered_leaves: [] });
  });

  test("structural (non-leaf) deliverable task is exempt — children cover it", () => {
    const db = openDb(":memory:");
    seedRoot(db);
    // Parent has deliverable verb but children exist — children are the deliverable.
    const parent = "t_parent_struct";
    seedLeaf(db, parent, "implement the closure verifier surface");
    const child = "t_child_leaf";
    seedLeaf(db, child, "implement the residual-blend function", parent);
    emitEvent(db, { kind: "code_artifact_candidate", directive_id: D, task_id: child, payload: { runtime: "bun", body: "/* y */" } });
    // Parent unchecked (has child); child has artifact → ok.
    expect(checkClosureDeliverables(db, ROOT)).toEqual({ ok: true, uncovered_leaves: [] });
  });

  test("deliverable leaf covered by contract_amendment_proposed → ok=true", () => {
    const db = openDb(":memory:");
    seedRoot(db);
    const leaf = "t_leaf_amend";
    seedLeaf(db, leaf, "propose a contract drift fix for closure auditing");
    emitEvent(db, { kind: "contract_amendment_proposed", directive_id: D, task_id: leaf, payload: { proposed_behavior: "x" } });
    expect(checkClosureDeliverables(db, ROOT).ok).toBe(true);
  });

  test("deliverable leaf covered by lesson_extracted with proposed_action → ok=true", () => {
    const db = openDb(":memory:");
    seedRoot(db);
    const leaf = "t_leaf_lesson";
    seedLeaf(db, leaf, "emit a sandbox-gap lesson for the worker queue");
    emitEvent(db, { kind: "lesson_extracted", directive_id: D, task_id: leaf, payload: { lesson_kind: "sandbox_gap", proposed_action: "loosen pypi allow_packages" } });
    expect(checkClosureDeliverables(db, ROOT).ok).toBe(true);
  });

  test("lesson_extracted WITHOUT proposed_action does NOT cover the leaf", () => {
    const db = openDb(":memory:");
    seedRoot(db);
    const leaf = "t_leaf_lesson_empty";
    seedLeaf(db, leaf, "emit a finding about the planner");
    emitEvent(db, { kind: "lesson_extracted", directive_id: D, task_id: leaf, payload: { lesson_kind: "retrieval_gap" } }); // no proposed_action
    const r = checkClosureDeliverables(db, ROOT);
    expect(r.ok).toBe(false);
    expect(r.uncovered_leaves).toContain(leaf);
  });
});
