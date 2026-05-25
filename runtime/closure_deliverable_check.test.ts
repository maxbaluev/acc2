// acc2 closure deliverable check tests — closes the verifier_gap lesson
// (brain audit QQEHAW97GS0AX7TEQ717Y3P174). The closure-side helper flags
// deliverable-shaped LEAVES (no refines children) whose subtree emitted
// no concrete artifact (act_artifact_candidate / contract_amendment_proposed
// / lesson_extracted{proposed_action}).

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import { checkClosureDeliverables, hasRealDocumentBody } from "./closure_deliverable_check";

// A body that comfortably clears the document hard-gate thresholds
// (DOC_MIN_BODY_CHARS=400, DOC_MIN_BODY_WORDS=60, DOC_MIN_SECTIONS=2).
const REAL_DOC_BODY = [
  "# Growth Report — Q2",
  "",
  "The operator pipeline grew 18% quarter over quarter, driven by two factors that compounded across the funnel. New inbound from the partner channel doubled while retention on the core cohort held flat at ninety-one percent throughout the measured window.",
  "",
  "## Methodology",
  "",
  "We sampled every committed directive over the trailing ninety days and joined the residual ledger against the owner-observed outcomes table to separate real wins from optimistic self-scores recorded by the verifier at admission time.",
  "",
  "## Recommendations",
  "",
  "Double down on the partner channel, instrument the drop-off between first contact and qualified reply, and stand up a weekly review so regressions surface inside one cycle instead of one quarter as they currently do today.",
].join("\n");

afterAll(() => closeDb());
beforeEach(() => closeDb());

const D = "d_test", ROOT = "t_root";
const seedRoot = (db: ReturnType<typeof openDb>, goal = "audit the substrate") =>
  emitEvent(db, { kind: "task_node_opened", directive_id: D, task_id: ROOT, payload: { goal } });

// Universal-workflow signal (brain amendment WDENAD6W, 2026-05-16): the
// closure verifier now reads `requires_deliverable` from the payload
// instead of guessing from English verb tokens in `goal`. Tests pass
// requiresDeliverable=true to signal a deliverable-shaped leaf.
const seedLeaf = (
  db: ReturnType<typeof openDb>,
  taskId: string,
  goal: string,
  parent: string = ROOT,
  requiresDeliverable = false,
  extra: Record<string, unknown> = {},
) => {
  emitEvent(db, {
    kind: "task_node_opened",
    directive_id: D,
    task_id: taskId,
    payload: { goal, ...(requiresDeliverable ? { requires_deliverable: true } : {}), ...extra },
  });
  emitEvent(db, { kind: "task_edge_recorded", directive_id: D, task_id: taskId, payload: { from_task: parent, to_task: taskId, kind: "refines" } });
};

describe("checkClosureDeliverables", () => {
  test("empty subtree (root only, non-deliverable goal) → ok=true, no uncovered", () => {
    const db = openDb(":memory:");
    seedRoot(db, "research the substrate"); // non-deliverable verb (audit is now deliverable)
    expect(checkClosureDeliverables(db, ROOT)).toEqual({ ok: true, uncovered_leaves: [] });
  });

  test("deliverable-declared leaf AND act_artifact_candidate emitted → ok=true", () => {
    const db = openDb(":memory:");
    seedRoot(db);
    const leaf = "t_leaf_ok";
    seedLeaf(db, leaf, "implement the growth-report renderer", ROOT, true);
    emitEvent(db, { kind: "act_artifact_candidate", directive_id: D, task_id: leaf, payload: { runtime: "bun", body: "/* x */" } });
    expect(checkClosureDeliverables(db, ROOT)).toEqual({ ok: true, uncovered_leaves: [] });
  });

  test("deliverable-declared leaf but NOTHING emitted → ok=false, uncovered=[leaf]", () => {
    const db = openDb(":memory:");
    seedRoot(db);
    const leaf = "t_leaf_empty";
    seedLeaf(db, leaf, "expose a concise growth report for the operator", ROOT, true);
    const r = checkClosureDeliverables(db, ROOT);
    expect(r.ok).toBe(false);
    expect(r.uncovered_leaves).toContain(leaf);
  });

  test("leaf WITHOUT requires_deliverable → ok=true (not checked)", () => {
    const db = openDb(":memory:");
    seedRoot(db);
    const leaf = "t_leaf_research";
    seedLeaf(db, leaf, "research the failure modes in the embedder backlog");
    // No artifact emitted; payload doesn't declare requires_deliverable → ignored.
    expect(checkClosureDeliverables(db, ROOT)).toEqual({ ok: true, uncovered_leaves: [] });
  });

  test("structural (non-leaf) task with children is exempt — children cover it", () => {
    const db = openDb(":memory:");
    seedRoot(db);
    const parent = "t_parent_struct";
    seedLeaf(db, parent, "implement the closure verifier surface", ROOT, true);
    const child = "t_child_leaf";
    seedLeaf(db, child, "implement the residual-blend function", parent, true);
    emitEvent(db, { kind: "act_artifact_candidate", directive_id: D, task_id: child, payload: { runtime: "bun", body: "/* y */" } });
    // Parent unchecked (has child); child has artifact → ok.
    expect(checkClosureDeliverables(db, ROOT)).toEqual({ ok: true, uncovered_leaves: [] });
  });

  test("deliverable leaf covered by contract_amendment_proposed → ok=true", () => {
    const db = openDb(":memory:");
    seedRoot(db);
    const leaf = "t_leaf_amend";
    seedLeaf(db, leaf, "propose a contract drift fix for closure auditing", ROOT, true);
    emitEvent(db, { kind: "contract_amendment_proposed", directive_id: D, task_id: leaf, payload: { proposed_behavior: "x" } });
    expect(checkClosureDeliverables(db, ROOT).ok).toBe(true);
  });

  test("deliverable leaf covered by lesson_extracted with proposed_action → ok=true", () => {
    const db = openDb(":memory:");
    seedRoot(db);
    const leaf = "t_leaf_lesson";
    seedLeaf(db, leaf, "emit a sandbox-gap lesson for the worker queue", ROOT, true);
    emitEvent(db, { kind: "lesson_extracted", directive_id: D, task_id: leaf, payload: { lesson_kind: "sandbox_gap", proposed_action: "loosen pypi allow_packages" } });
    expect(checkClosureDeliverables(db, ROOT).ok).toBe(true);
  });

  test("lesson_extracted WITHOUT proposed_action does NOT cover the leaf", () => {
    const db = openDb(":memory:");
    seedRoot(db);
    const leaf = "t_leaf_lesson_empty";
    seedLeaf(db, leaf, "emit a finding about the planner", ROOT, true);
    emitEvent(db, { kind: "lesson_extracted", directive_id: D, task_id: leaf, payload: { lesson_kind: "retrieval_gap" } }); // no proposed_action
    const r = checkClosureDeliverables(db, ROOT);
    expect(r.ok).toBe(false);
    expect(r.uncovered_leaves).toContain(leaf);
  });
});

// amendment #5 deliverable_body_verifier_hard_gate — DOCUMENT leaves require a
// real multi-section body, not the presence of a summary/plan/outline stub.
describe("checkClosureDeliverables — document body hard gate", () => {
  test("(a) document leaf whose only artifact is a summary/stub body is UNCOVERED → blocks closure", () => {
    const db = openDb(":memory:");
    seedRoot(db);
    const leaf = "t_doc_stub";
    seedLeaf(db, leaf, "produce the growth report", ROOT, true, { deliverable_kind: "document" });
    // A plan/summary substitute, not a finished document.
    emitEvent(db, {
      kind: "act_artifact_candidate",
      directive_id: D,
      task_id: leaf,
      payload: { body: "Summary: I will write the report next cycle. Outline:\n- intro\n- TODO body" },
    });
    const r = checkClosureDeliverables(db, ROOT);
    expect(r.ok).toBe(false);
    expect(r.uncovered_leaves).toContain(leaf);
  });

  test("(b) same document leaf with a real multi-section body is COVERED", () => {
    const db = openDb(":memory:");
    seedRoot(db);
    const leaf = "t_doc_real";
    seedLeaf(db, leaf, "produce the growth report", ROOT, true, { deliverable_kind: "document" });
    emitEvent(db, {
      kind: "act_artifact_candidate",
      directive_id: D,
      task_id: leaf,
      payload: { body: REAL_DOC_BODY },
    });
    expect(checkClosureDeliverables(db, ROOT)).toEqual({ ok: true, uncovered_leaves: [] });
  });

  test("(c) non-document deliverable leaf is unaffected — presence still suffices (thin body OK)", () => {
    const db = openDb(":memory:");
    seedRoot(db);
    const leaf = "t_nondoc";
    // requires_deliverable but NOT a document leaf → existing presence check.
    seedLeaf(db, leaf, "implement the renderer", ROOT, true);
    emitEvent(db, { kind: "act_artifact_candidate", directive_id: D, task_id: leaf, payload: { runtime: "bun", body: "/* x */" } });
    expect(checkClosureDeliverables(db, ROOT)).toEqual({ ok: true, uncovered_leaves: [] });
  });

  test("(d) expected_outputs named sections must be present in the body", () => {
    const db = openDb(":memory:");
    seedRoot(db);
    const leaf = "t_doc_sections";
    // expected_outputs both flags this as a document leaf (the "report" entry)
    // AND names required sections.
    seedLeaf(db, leaf, "produce the operator report", ROOT, false, {
      expected_outputs: ["report", "Methodology", "Recommendations", "Risks"],
    });
    // REAL_DOC_BODY has Methodology + Recommendations but NOT a Risks section.
    emitEvent(db, { kind: "act_artifact_candidate", directive_id: D, task_id: leaf, payload: { body: REAL_DOC_BODY } });
    const missing = checkClosureDeliverables(db, ROOT);
    expect(missing.ok).toBe(false);
    expect(missing.uncovered_leaves).toContain(leaf);
  });

  test("(d2) named sections all present in the body → covered", () => {
    const db = openDb(":memory:");
    seedRoot(db);
    const leaf = "t_doc_sections_ok";
    seedLeaf(db, leaf, "produce the operator report", ROOT, false, {
      expected_outputs: ["report", "Methodology", "Recommendations", "Risks"],
    });
    emitEvent(db, {
      kind: "act_artifact_candidate",
      directive_id: D,
      task_id: leaf,
      payload: { body: REAL_DOC_BODY + "\n\n## Risks\n\nKey risks include partner-channel concentration and verifier optimism on self-scored residuals, both of which we mitigate with the weekly review and the owner-observed outcome join described above in this report." },
    });
    expect(checkClosureDeliverables(db, ROOT)).toEqual({ ok: true, uncovered_leaves: [] });
  });

  test("expected_outputs naming a 'report' classifies the leaf as document (detection via expected_outputs)", () => {
    const db = openDb(":memory:");
    seedRoot(db);
    const leaf = "t_doc_via_expected";
    seedLeaf(db, leaf, "ship it", ROOT, false, { expected_outputs: ["growth report doc"] });
    // Stub body → document gate rejects.
    emitEvent(db, { kind: "act_artifact_candidate", directive_id: D, task_id: leaf, payload: { body: "Plan: TBD" } });
    expect(checkClosureDeliverables(db, ROOT).uncovered_leaves).toContain(leaf);
  });

  test("hasRealDocumentBody unit: stub rejected, real multi-section accepted, missing section rejected", () => {
    expect(hasRealDocumentBody("Summary: TODO")).toBe(false);
    expect(hasRealDocumentBody(null)).toBe(false);
    expect(hasRealDocumentBody(REAL_DOC_BODY)).toBe(true);
    expect(hasRealDocumentBody(REAL_DOC_BODY, ["Methodology", "Recommendations"])).toBe(true);
    expect(hasRealDocumentBody(REAL_DOC_BODY, ["Appendix"])).toBe(false);
  });
});
