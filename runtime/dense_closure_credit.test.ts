// acc2 dense post-closure credit tests — DAG-backprop of closure_residual.
//
// Verifies the ADDITIVE dense pass (HCAPO arXiv:2603.08754 / Mem-T
// arXiv:2601.23014): on a ROOT task_closure_audited, the directive's
// intermediate contributors (acts/artifacts/knowledge under the DAG) receive
// closure-derived credit weighted by closure_residual, idempotently and
// bounded to the directive's own DAG. Low residual → positive (alpha) credit;
// high residual → negative (beta) credit; running twice does not double-credit;
// the root act is excluded so existing terminal credit is unchanged.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent, flushPostCommitProjectionsForTest, resetPostCommitProjectionsForTest } from "./events";
import { insertArtifact, getArtifact } from "./artifact_store";
import { _resetTaskTopologyCacheForTests } from "./task_topology";
import {
  distributeDenseClosureCredit,
  resolveDirectiveRootTaskId,
  __depthByTaskForTest,
} from "./dense_closure_credit";
import type { Database } from "bun:sqlite";

afterAll(() => closeDb());
beforeEach(() => {
  // Non-blocking post-commit cascade (directive NHY908W0EX5Q72KGWXMASPFEY0):
  // the ROOT task_closure_audited dense-credit pass is deferred onto the
  // bounded queue. Reset between cases; drain after the triggering emit.
  resetPostCommitProjectionsForTest();
  closeDb();
  _resetTaskTopologyCacheForTests();
});

const makeArtifact = (db: Database, id: string) =>
  insertArtifact(db, {
    id,
    runtime: "bun",
    body: "// dense credit fixture " + id,
    declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
    stateRoot: null,
    posteriorAlpha: 1,
    posteriorBeta: 1,
    score: 0.5,
    confidence: 0.0,
    recentResidualMean: 0,
    recentKillCount: 0,
    status: "admitted",
    name: null,
    fixtureInput: null,
    fixtureExpectedResidual: 0.2,
  });

/** Build a 3-node directive DAG:
 *    root  --refines-->  child_a  (cites art_a)
 *    root  --refines-->  child_b  (cites art_b + knowledge candidate)
 *  Returns the ids needed by assertions. The closure audit is NOT emitted
 *  here — the test emits it (or calls the pass directly) so the trigger path
 *  is explicit per case. */
const seedDirective = (db: Database, directiveId: string) => {
  const root = directiveId + "_root";
  const childA = directiveId + "_child_a";
  const childB = directiveId + "_child_b";

  emitEvent(db, { kind: "directive_opened", substrate_origin: "claude", directive_id: directiveId, task_id: root, payload: { directive_text: "dense credit fixture directive" } });
  emitEvent(db, { kind: "task_node_opened", substrate_origin: "substrate_auto", directive_id: directiveId, task_id: root, parent_task_id: null, payload: { goal: "root" } });
  emitEvent(db, { kind: "task_node_opened", substrate_origin: "substrate_auto", directive_id: directiveId, task_id: childA, parent_task_id: root, payload: { goal: "child a" } });
  emitEvent(db, { kind: "task_node_opened", substrate_origin: "substrate_auto", directive_id: directiveId, task_id: childB, parent_task_id: root, payload: { goal: "child b" } });
  emitEvent(db, { kind: "task_edge_recorded", substrate_origin: "substrate_auto", directive_id: directiveId, task_id: childA, payload: { from_task: root, to_task: childA, kind: "refines" } });
  emitEvent(db, { kind: "task_edge_recorded", substrate_origin: "substrate_auto", directive_id: directiveId, task_id: childB, payload: { from_task: root, to_task: childB, kind: "refines" } });

  return { root, childA, childB };
};

/** Emit a knowledge_candidate and return its event id (the knowledge target). */
const seedKnowledge = (db: Database, directiveId: string, taskId: string): string => {
  const ev = emitEvent(db, {
    kind: "knowledge_candidate",
    substrate_origin: "opencode",
    directive_id: directiveId,
    task_id: taskId,
    payload: { claim: "dense credit knowledge fixture", confidence_estimate: 1.0 },
  });
  return ev.id;
};

/** Attach an act (action_predicted) to a task citing the given artifact/knowledge. */
const seedActCiting = (
  db: Database,
  directiveId: string,
  taskId: string,
  citedArtifactIds: string[],
  citedKnowledgeIds: string[],
) => {
  emitEvent(db, {
    kind: "action_predicted",
    substrate_origin: "opencode",
    directive_id: directiveId,
    task_id: taskId,
    payload: { cited_artifact_ids: citedArtifactIds, cited_knowledge_ids: citedKnowledgeIds },
  });
};

const denseRows = (db: Database, kind: string): Array<Record<string, unknown>> =>
  (db
    .query(`SELECT payload FROM events WHERE kind = ? AND json_extract(payload, '$.projected_from') = 'dense_closure_credit'`)
    .all(kind) as Array<{ payload: string }>)
    .map((r) => JSON.parse(r.payload) as Record<string, unknown>);

describe("resolveDirectiveRootTaskId", () => {
  test("resolves the null-parent task_node_opened as the directive root", () => {
    const db = openDb(":memory:");
    const { root } = seedDirective(db, "dir_root_resolve");
    expect(resolveDirectiveRootTaskId(db, "dir_root_resolve")).toBe(root);
  });
});

describe("depthByTask", () => {
  test("root is depth 0, refines children are depth 1", () => {
    const depth = __depthByTaskForTest(
      "r",
      [
        { from_task: "r", to_task: "a", kind: "refines" },
        { from_task: "r", to_task: "b", kind: "refines" },
        { from_task: "a", to_task: "c", kind: "refines" },
      ],
      new Set(["r", "a", "b", "c"]),
    );
    expect(depth.get("r")).toBe(0);
    expect(depth.get("a")).toBe(1);
    expect(depth.get("b")).toBe(1);
    expect(depth.get("c")).toBe(2);
  });
});

describe("distributeDenseClosureCredit — low residual (success) → positive credit", () => {
  test("intermediate contributors' alpha posterior rises; root excluded", () => {
    const db = openDb(":memory:");
    const dir = "dir_dense_success";
    const { root, childA, childB } = seedDirective(db, dir);
    makeArtifact(db, "art_a");
    makeArtifact(db, "art_b");
    makeArtifact(db, "art_root");
    const k = seedKnowledge(db, dir, childB);
    // Acts: childA cites art_a; childB cites art_b + knowledge; the ROOT
    // cites art_root (which must NOT receive dense credit).
    seedActCiting(db, dir, childA, ["art_a"], []);
    seedActCiting(db, dir, childB, ["art_b"], [k]);
    seedActCiting(db, dir, root, ["art_root"], []);

    const beforeA = getArtifact(db, "art_a")!;
    const beforeRoot = getArtifact(db, "art_root")!;

    const res = distributeDenseClosureCredit(db, {
      closure_audit_event_id: "audit_success_1",
      directive_id: dir,
      root_task_id: root,
      closure_residual: 0.05, // success
    });

    expect(res.ran).toBe(true);
    expect(res.contributors_credited).toBeGreaterThanOrEqual(2); // art_a, art_b (+ knowledge)

    // Intermediate artifacts gained alpha evidence (positive credit).
    const afterA = getArtifact(db, "art_a")!;
    expect(afterA.posteriorAlpha).toBeGreaterThan(beforeA.posteriorAlpha);
    expect(getArtifact(db, "art_b")!.posteriorAlpha).toBeGreaterThan(1);

    // ROOT artifact is excluded — terminal credit is left to the existing path.
    const afterRoot = getArtifact(db, "art_root")!;
    expect(afterRoot.posteriorAlpha).toBe(beforeRoot.posteriorAlpha);
    expect(afterRoot.posteriorBeta).toBe(beforeRoot.posteriorBeta);

    // Knowledge candidate got a candidate_confirmed (assert polarity).
    const kRows = denseRows(db, "candidate_confirmed");
    expect(kRows.some((p) => p.knowledge_id === k && p.polarity === "assert")).toBe(true);

    // A single bounded summary row was emitted.
    const summary = denseRows(db, "dense_closure_credit_distributed");
    expect(summary.length).toBe(1);
    expect(summary[0]!.closure_residual).toBeCloseTo(0.05, 6);
  });
});

describe("distributeDenseClosureCredit — high residual (failure) → negative credit", () => {
  test("intermediate artifact beta posterior rises; knowledge contradicted", () => {
    const db = openDb(":memory:");
    const dir = "dir_dense_failure";
    const { root, childA, childB } = seedDirective(db, dir);
    makeArtifact(db, "art_a");
    makeArtifact(db, "art_b");
    const k = seedKnowledge(db, dir, childB);
    seedActCiting(db, dir, childA, ["art_a"], []);
    seedActCiting(db, dir, childB, ["art_b"], [k]);

    const beforeA = getArtifact(db, "art_a")!;

    const res = distributeDenseClosureCredit(db, {
      closure_audit_event_id: "audit_fail_1",
      directive_id: dir,
      root_task_id: root,
      closure_residual: 0.95, // failure
    });
    expect(res.ran).toBe(true);

    // High residual → beta evidence rises (negative credit).
    const afterA = getArtifact(db, "art_a")!;
    expect(afterA.posteriorBeta).toBeGreaterThan(beforeA.posteriorBeta);

    // Knowledge gets candidate_contradicted (deny polarity).
    const kRows = denseRows(db, "candidate_contradicted");
    expect(kRows.some((p) => p.knowledge_id === k && p.polarity === "deny")).toBe(true);
  });
});

// TRAJECTORY MOTIF four-link credit leg: a trajectory_motif_predicate row is a
// first-class SCORED act_artifact. When prompt_composer surfaces it, it emits a
// retrieval_binding scoped to the directive's task citing the motif id via
// payload.source_artifact_id. collectContributors reads that binding and the
// dense pass credits the motif's posterior against the directive's closure
// residual — closing create → retrieve → mutate → credit on the SAME posterior
// machinery (applyResidualOutcome), no parallel structure.
describe("distributeDenseClosureCredit — trajectory motif posterior is credited via its retrieval_binding (four-link)", () => {
  test("a surfaced motif's posterior_alpha rises on a low-residual (success) closure", () => {
    const db = openDb(":memory:");
    const dir = "dir_dense_motif";
    const { root, childA } = seedDirective(db, dir);
    // The motif act_artifact (what the trajectory_motif_extractor admits).
    makeArtifact(db, "motif_3_credit");
    // prompt_composer surfaced the motif on an INTERMEDIATE task → emitted a
    // retrieval_binding citing the motif id via source_artifact_id.
    emitEvent(db, {
      kind: "retrieval_binding",
      substrate_origin: "substrate_auto",
      directive_id: dir,
      task_id: childA,
      context_refs: ["motif_3_credit"],
      payload: {
        source_artifact_id: "motif_3_credit",
        binding_surface: "proven_trajectory_motif",
        section_name: "proven_trajectory_motif",
        rerank_score: 0.84,
      },
    });

    const before = getArtifact(db, "motif_3_credit")!;
    const res = distributeDenseClosureCredit(db, {
      closure_audit_event_id: "audit_motif_success",
      directive_id: dir,
      root_task_id: root,
      closure_residual: 0.05, // success
    });
    expect(res.ran).toBe(true);

    // The motif's Beta posterior moved: alpha rose (good outcome credited it).
    const after = getArtifact(db, "motif_3_credit")!;
    expect(after.posteriorAlpha).toBeGreaterThan(before.posteriorAlpha);

    // An act_artifact_score_updated row attributes the credit to the motif as a
    // dense_closure_contributor.
    const updates = denseRows(db, "act_artifact_score_updated");
    expect(updates.some((p) => p.artifact_id === "motif_3_credit" && p.role === "dense_closure_contributor")).toBe(true);
  });

  test("a surfaced motif's posterior_beta rises on a high-residual (failure) closure", () => {
    const db = openDb(":memory:");
    const dir = "dir_dense_motif_fail";
    const { root, childA } = seedDirective(db, dir);
    makeArtifact(db, "motif_3_credit_fail");
    emitEvent(db, {
      kind: "retrieval_binding",
      substrate_origin: "substrate_auto",
      directive_id: dir,
      task_id: childA,
      context_refs: ["motif_3_credit_fail"],
      payload: {
        source_artifact_id: "motif_3_credit_fail",
        binding_surface: "proven_trajectory_motif",
        section_name: "proven_trajectory_motif",
      },
    });

    const before = getArtifact(db, "motif_3_credit_fail")!;
    const res = distributeDenseClosureCredit(db, {
      closure_audit_event_id: "audit_motif_fail",
      directive_id: dir,
      root_task_id: root,
      closure_residual: 0.95, // failure
    });
    expect(res.ran).toBe(true);
    const after = getArtifact(db, "motif_3_credit_fail")!;
    expect(after.posteriorBeta).toBeGreaterThan(before.posteriorBeta);
  });
});

// GOAL-SUFFICIENCY (amendment goal_sufficiency_root_commit + ungrounded_provenance_weight):
// ungrounded / self-reported closure provenance MARKS the dense credit (halves its
// distributed weight via UNGROUNDED_PROVENANCE_WEIGHT_MULTIPLIER=0.5) but NEVER blocks
// the pass — the goal-satisfied root still committed, the dense signal is just lighter.
describe("distributeDenseClosureCredit — ungrounded provenance halves weight, never blocks", () => {
  test("ungrounded provenance distributes exactly half the weight of grounded; both still run and credit", () => {
    const db = openDb(":memory:");

    // Grounded directive: substrate-verified closure provenance → full weight.
    const groundedDir = "dir_prov_grounded";
    const grounded = seedDirective(db, groundedDir);
    makeArtifact(db, "art_grounded");
    seedActCiting(db, groundedDir, grounded.childA, ["art_grounded"], []);
    const groundedRes = distributeDenseClosureCredit(db, {
      closure_audit_event_id: "audit_grounded",
      directive_id: groundedDir,
      root_task_id: grounded.root,
      closure_residual: 0.05,
      // ungrounded_provenance omitted → grounded (full weight).
    });

    // Ungrounded directive: self-reported provenance → half weight, still runs.
    const ungroundedDir = "dir_prov_ungrounded";
    const ungrounded = seedDirective(db, ungroundedDir);
    makeArtifact(db, "art_ungrounded");
    seedActCiting(db, ungroundedDir, ungrounded.childA, ["art_ungrounded"], []);
    const ungroundedRes = distributeDenseClosureCredit(db, {
      closure_audit_event_id: "audit_ungrounded",
      directive_id: ungroundedDir,
      root_task_id: ungrounded.root,
      closure_residual: 0.05,
      ungrounded_provenance: true, // MARK: half weight, never block.
    });

    // Both passes RAN and credited — ungrounded provenance never blocks the pass.
    expect(groundedRes.ran).toBe(true);
    expect(ungroundedRes.ran).toBe(true);
    expect(groundedRes.contributors_credited).toBe(1);
    expect(ungroundedRes.contributors_credited).toBe(1);

    // The distributed weight on the ungrounded contributor is exactly half the
    // grounded one (same depth, same residual) — the 0.5 provenance multiplier.
    const weightFor = (artifactId: string): number => {
      const rows = denseRows(db, "act_artifact_score_updated").filter((p) => p.artifact_id === artifactId);
      expect(rows.length).toBe(1);
      return rows[0]!.weight as number;
    };
    const groundedWeight = weightFor("art_grounded");
    const ungroundedWeight = weightFor("art_ungrounded");
    expect(ungroundedWeight).toBeCloseTo(groundedWeight * 0.5, 9);
    expect(ungroundedWeight).toBeLessThan(groundedWeight);

    // The ungrounded contributor STILL gained alpha posterior evidence (lighter,
    // not zero) — the credit is damped, the root's commit is unaffected.
    expect(getArtifact(db, "art_ungrounded")!.posteriorAlpha).toBeGreaterThan(1);
  });
});

describe("distributeDenseClosureCredit — idempotent", () => {
  test("running twice does not double-credit any contributor", () => {
    const db = openDb(":memory:");
    const dir = "dir_dense_idem";
    const { root, childA } = seedDirective(db, dir);
    makeArtifact(db, "art_a");
    seedActCiting(db, dir, childA, ["art_a"], []);

    const first = distributeDenseClosureCredit(db, {
      closure_audit_event_id: "audit_idem_1",
      directive_id: dir,
      root_task_id: root,
      closure_residual: 0.1,
    });
    expect(first.contributors_credited).toBe(1);
    const afterFirst = getArtifact(db, "art_a")!;

    const second = distributeDenseClosureCredit(db, {
      closure_audit_event_id: "audit_idem_1",
      directive_id: dir,
      root_task_id: root,
      closure_residual: 0.1,
    });
    // Second pass credits nobody — the projection key already exists.
    expect(second.contributors_credited).toBe(0);
    const afterSecond = getArtifact(db, "art_a")!;
    expect(afterSecond.posteriorAlpha).toBe(afterFirst.posteriorAlpha);
    expect(afterSecond.posteriorBeta).toBe(afterFirst.posteriorBeta);

    // Exactly one dense score-update row exists for art_a.
    const rows = denseRows(db, "act_artifact_score_updated").filter((p) => p.artifact_id === "art_a");
    expect(rows.length).toBe(1);
  });
});

describe("distributeDenseClosureCredit — bounded + additive trigger", () => {
  test("emitting a ROOT task_closure_audited fires the dense pass via the hook", async () => {
    const db = openDb(":memory:");
    const dir = "dir_dense_hook";
    const { root, childA } = seedDirective(db, dir);
    makeArtifact(db, "art_a");
    seedActCiting(db, dir, childA, ["art_a"], []);

    const before = getArtifact(db, "art_a")!;
    // Emit the closure audit on the ROOT — the events.ts post-write hook
    // enqueues the dense pass onto the bounded post-commit queue; drain it.
    emitEvent(db, {
      kind: "task_closure_audited",
      substrate_origin: "substrate_auto",
      directive_id: dir,
      task_id: root,
      payload: { closure_residual: 0.1, verdict: "audited" },
    });
    await flushPostCommitProjectionsForTest();

    const after = getArtifact(db, "art_a")!;
    expect(after.posteriorAlpha).toBeGreaterThan(before.posteriorAlpha);

    const summary = denseRows(db, "dense_closure_credit_distributed");
    expect(summary.length).toBe(1);
    expect(summary[0]!.root_task_id).toBe(root);
  });

  test("a NON-root child closure audit does NOT fire the dense pass", async () => {
    const db = openDb(":memory:");
    const dir = "dir_dense_nonroot";
    const { childA } = seedDirective(db, dir);
    makeArtifact(db, "art_a");
    seedActCiting(db, dir, childA, ["art_a"], []);

    const before = getArtifact(db, "art_a")!;
    // Closure audit on a CHILD task, not the root.
    emitEvent(db, {
      kind: "task_closure_audited",
      substrate_origin: "substrate_auto",
      directive_id: dir,
      task_id: childA,
      payload: { closure_residual: 0.1, verdict: "audited" },
    });
    await flushPostCommitProjectionsForTest();

    // No dense credit applied — child audits are skipped.
    const after = getArtifact(db, "art_a")!;
    expect(after.posteriorAlpha).toBe(before.posteriorAlpha);
    expect(denseRows(db, "dense_closure_credit_distributed").length).toBe(0);
  });

  test("root structural decomposition strategy citation receives closure credit", async () => {
    const db = openDb(":memory:");
    const dir = "dir_dense_decomp_strategy";
    const { root } = seedDirective(db, dir);
    makeArtifact(db, "decomp_audit_evidence_sweep");
    db.run(
      "UPDATE act_artifact SET kind = 'decomposition_strategy_predicate' WHERE id = ?",
      ["decomp_audit_evidence_sweep"],
    );
    const before = getArtifact(db, "decomp_audit_evidence_sweep")!;

    emitEvent(db, {
      kind: "task_node_opened",
      substrate_origin: "opencode",
      directive_id: dir,
      task_id: root,
      context_refs: ["decomp_audit_evidence_sweep"],
      payload: { goal: "root decomposition used proven audit evidence sweep" },
    });

    emitEvent(db, {
      kind: "task_closure_audited",
      substrate_origin: "substrate_auto",
      directive_id: dir,
      task_id: root,
      payload: { closure_residual: 0.05, verdict: "audited" },
    });
    await flushPostCommitProjectionsForTest();

    const after = getArtifact(db, "decomp_audit_evidence_sweep")!;
    expect(after.posteriorAlpha).toBeGreaterThan(before.posteriorAlpha);
    const rows = denseRows(db, "act_artifact_score_updated").filter(
      (p) => p.artifact_id === "decomp_audit_evidence_sweep",
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.role).toBe("dense_closure_contributor");
  });
});
