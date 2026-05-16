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
});
