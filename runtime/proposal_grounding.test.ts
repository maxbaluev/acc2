// acc2 proposal grounding tests — gate every contract_amendment_proposed
// against event-kind grounding, anchor freshness, CLI command grounding,
// and deliverable closure.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import { validateProposalGrounding } from "./proposal_grounding";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const D = "d_test", ROOT = "t_root";
const seedRoot = (db: ReturnType<typeof openDb>, goal = "audit the substrate") =>
  emitEvent(db, { kind: "task_node_opened", directive_id: D, task_id: ROOT, payload: { goal } });

describe("validateProposalGrounding", () => {
  test("empty subtree (no amendments) → ok", () => {
    const db = openDb(":memory:");
    seedRoot(db);
    expect(validateProposalGrounding(db, ROOT)).toEqual({ ok: true, failed_checks: [] });
  });

  test("happy path — well-grounded amendment", () => {
    const db = openDb(":memory:");
    seedRoot(db);
    emitEvent(db, { kind: "contract_amendment_proposed", directive_id: D, task_id: ROOT, payload: {
      proposed_behavior: 'gate task_committed via validator',
      current_behavior: 'prose in WORKFLOW_TEXT references "task_node_opened"',
      diff: { after: 'cite "knowledge_candidate" and "lesson_extracted"' },
    } });
    expect(validateProposalGrounding(db, ROOT)).toEqual({ ok: true, failed_checks: [] });
  });

  test("unknown event kind referenced", () => {
    const db = openDb(":memory:");
    seedRoot(db);
    emitEvent(db, { kind: "contract_amendment_proposed", directive_id: D, task_id: ROOT, payload: {
      proposed_behavior: 'emit "totally_fictional_kind" on commit',
    } });
    const r = validateProposalGrounding(db, ROOT);
    expect(r.ok).toBe(false);
    expect(r.failed_checks.some((s) => s.startsWith("unknown_event_kind:totally_fictional_kind"))).toBe(true);
  });

  test("anchor not in file → anchor_not_in_source", () => {
    const db = openDb(":memory:");
    seedRoot(db);
    emitEvent(db, { kind: "contract_amendment_proposed", directive_id: D, task_id: ROOT, payload: {
      file_path: "runtime/proposal_grounding.ts",
      anchor: "THIS_STRING_DOES_NOT_EXIST_IN_THE_FILE_xyz123",
      proposed_behavior: "patch the anchor",
    } });
    const r = validateProposalGrounding(db, ROOT);
    expect(r.ok).toBe(false);
    expect(r.failed_checks.some((s) => s.startsWith("anchor_not_in_source:runtime/proposal_grounding.ts"))).toBe(true);
  });

  test("vapor CLI command", () => {
    const db = openDb(":memory:");
    seedRoot(db);
    emitEvent(db, { kind: "contract_amendment_proposed", directive_id: D, task_id: ROOT, payload: {
      proposed_behavior: "operator runs acc nonexistent to fix this",
    } });
    const r = validateProposalGrounding(db, ROOT);
    expect(r.ok).toBe(false);
    expect(r.failed_checks).toContain("vapor_cli_command:acc nonexistent");
  });

  test("deliverable-shaped leaf with no artifacts", () => {
    const db = openDb(":memory:");
    seedRoot(db);
    const leaf = "t_leaf";
    emitEvent(db, { kind: "task_node_opened", directive_id: D, task_id: leaf, payload: { goal: "implement the validator function" } });
    emitEvent(db, { kind: "task_edge_recorded", directive_id: D, task_id: leaf, payload: { from_task: ROOT, to_task: leaf, kind: "refines" } });
    const r = validateProposalGrounding(db, ROOT);
    expect(r.ok).toBe(false);
    expect(r.failed_checks).toContain(`deliverable_missing:${leaf}`);
  });

  test("deliverable satisfied by code_artifact_candidate", () => {
    const db = openDb(":memory:");
    seedRoot(db);
    const leaf = "t_leaf2";
    emitEvent(db, { kind: "task_node_opened", directive_id: D, task_id: leaf, payload: { goal: "build the parser" } });
    emitEvent(db, { kind: "task_edge_recorded", directive_id: D, task_id: leaf, payload: { from_task: ROOT, to_task: leaf, kind: "refines" } });
    emitEvent(db, { kind: "code_artifact_candidate", directive_id: D, task_id: leaf, payload: { runtime: "bun", body: "/* x */" } });
    expect(validateProposalGrounding(db, ROOT).failed_checks).not.toContain(`deliverable_missing:${leaf}`);
  });

  test("directive scope isolates cross-directive task_ids — deliverable in A is NOT satisfied by artifact in B", () => {
    // FAST-axis isolation: a deliverable_missing in directive A must NOT
    // count an artifact emitted under directive B as satisfying it, even
    // if both share the same imperative-verb goal and the same leaf task_id.
    const db = openDb(":memory:");
    const D_A = "d_alpha", D_B = "d_beta";
    const rootA = "t_root_a", leafA = "t_leaf_a";
    const rootB = "t_root_b", leafB = "t_leaf_b";

    // Directive A: root + deliverable-shaped leaf with NO satisfying artifact.
    emitEvent(db, { kind: "task_node_opened", directive_id: D_A, task_id: rootA, payload: { goal: "audit alpha" } });
    emitEvent(db, { kind: "task_node_opened", directive_id: D_A, task_id: leafA, payload: { goal: "implement the alpha validator" } });
    emitEvent(db, { kind: "task_edge_recorded", directive_id: D_A, task_id: leafA, payload: { from_task: rootA, to_task: leafA, kind: "refines" } });

    // Directive B: root + deliverable-shaped leaf WITH a satisfying artifact.
    emitEvent(db, { kind: "task_node_opened", directive_id: D_B, task_id: rootB, payload: { goal: "audit beta" } });
    emitEvent(db, { kind: "task_node_opened", directive_id: D_B, task_id: leafB, payload: { goal: "implement the beta validator" } });
    emitEvent(db, { kind: "task_edge_recorded", directive_id: D_B, task_id: leafB, payload: { from_task: rootB, to_task: leafB, kind: "refines" } });
    emitEvent(db, { kind: "code_artifact_candidate", directive_id: D_B, task_id: leafB, payload: { runtime: "bun", body: "/* b */" } });

    // Scoped to directive A: leafA appears, but its artifact (which lives
    // under D_B against a DIFFERENT task_id) cannot satisfy it. We further
    // verify isolation by also planting an artifact in D_B against leafA's
    // task_id — the directive filter must still reject it.
    emitEvent(db, { kind: "code_artifact_candidate", directive_id: D_B, task_id: leafA, payload: { runtime: "bun", body: "/* cross */" } });

    const rA = validateProposalGrounding(db, rootA, D_A);
    expect(rA.failed_checks).toContain(`deliverable_missing:${leafA}`);

    // Sanity: directive B's audit still passes — its artifact under D_B
    // satisfies its own deliverable.
    const rB = validateProposalGrounding(db, rootB, D_B);
    expect(rB.failed_checks).not.toContain(`deliverable_missing:${leafB}`);

    // Cross-pollution control: A's refines edge does NOT walk into B's
    // graph. Confirm A's subtree did not include leafB by checking that
    // a deliverable_missing for leafB is absent from A's report.
    expect(rA.failed_checks).not.toContain(`deliverable_missing:${leafB}`);
  });

  test("backward compatibility — calling without directiveId scans full ledger", () => {
    // The optional directiveId parameter is additive; callers (e.g. test
    // fixtures or older code paths) that omit it must continue to receive
    // the pre-amendment full-ledger scan semantics.
    const db = openDb(":memory:");
    seedRoot(db);
    const leaf = "t_leaf_bc";
    emitEvent(db, { kind: "task_node_opened", directive_id: D, task_id: leaf, payload: { goal: "implement the back-compat validator" } });
    emitEvent(db, { kind: "task_edge_recorded", directive_id: D, task_id: leaf, payload: { from_task: ROOT, to_task: leaf, kind: "refines" } });
    emitEvent(db, { kind: "code_artifact_candidate", directive_id: D, task_id: leaf, payload: { runtime: "bun", body: "/* y */" } });

    // No directiveId arg — should match scoped behavior because the only
    // events in the in-memory ledger ARE this directive's events.
    const unscoped = validateProposalGrounding(db, ROOT);
    expect(unscoped.ok).toBe(true);
    expect(unscoped.failed_checks).not.toContain(`deliverable_missing:${leaf}`);

    // Scoped call must agree on this single-directive ledger.
    const scoped = validateProposalGrounding(db, ROOT, D);
    expect(scoped).toEqual(unscoped);
  });
});
