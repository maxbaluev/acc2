// Tier-S2 causal-edge extractor — proves the bounded extractor admits
// one act_artifact{kind:causal_edge_predicate} row per (edge_class,
// node_a, node_b) tuple with canonical ordering, emits one
// causal_edge_observed event per observation, is idempotent across
// reruns, and respects the recency window.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { extractCausalEdges } from "./causal_edge_extractor";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const newId = (): string =>
  crypto.randomUUID().replace(/-/g, "").slice(0, 26).toUpperCase();

const _baseTs = Date.now();
let _tsCounter = 0;
const tickTs = (): string => {
  _tsCounter += 1;
  return new Date(_baseTs + _tsCounter * 1000).toISOString();
};

const insertEvent = (
  db: ReturnType<typeof openDb>,
  fields: {
    kind: string;
    directive_id?: string;
    task_id?: string;
    loop_id?: string;
    substrate_origin?: string;
    payload?: unknown;
    context_refs?: string[];
    ts?: string;
  },
): string => {
  const id = newId();
  db.run(
    `INSERT INTO events (
       id, ts, directive_id, task_id, loop_id, substrate_origin, kind,
       payload, context_refs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      fields.ts ?? tickTs(),
      fields.directive_id ?? "d_test",
      fields.task_id ?? "t_test",
      fields.loop_id ?? "l_test",
      fields.substrate_origin ?? "substrate_auto",
      fields.kind,
      JSON.stringify(fields.payload ?? {}),
      JSON.stringify(fields.context_refs ?? []),
    ],
  );
  return id;
};

const countEdges = (
  db: ReturnType<typeof openDb>,
  edgeClass?: string,
): number => {
  if (edgeClass) {
    const row = db
      .query(
        `SELECT COUNT(*) AS n FROM act_artifact
         WHERE kind = 'causal_edge_predicate' AND name LIKE ?`,
      )
      .get(`${edgeClass}:%`) as { n: number };
    return row.n;
  }
  const row = db
    .query(`SELECT COUNT(*) AS n FROM act_artifact WHERE kind = 'causal_edge_predicate'`)
    .get() as { n: number };
  return row.n;
};

const countObservations = (db: ReturnType<typeof openDb>): number =>
  (db.query(`SELECT COUNT(*) AS n FROM events WHERE kind = 'causal_edge_observed'`).get() as { n: number }).n;

describe("extractCausalEdges", () => {
  test("act_tuple_recorded with two cited_knowledge_ids admits one cocitation edge + one observation", async () => {
    const db = openDb(":memory:");
    insertEvent(db, {
      kind: "act_tuple_recorded",
      payload: { cited_knowledge_ids: ["k_alpha", "k_beta"] },
    });

    const summary = await extractCausalEdges(db);
    expect(summary.scanned).toBe(1);
    expect(summary.cocitations_recorded).toBe(1);
    expect(summary.artifact_edges_recorded).toBe(0);
    expect(summary.refinement_edges_recorded).toBe(0);
    expect(summary.edges_admitted).toBe(1);

    expect(countEdges(db, "citation_cocitation")).toBe(1);
    expect(countObservations(db)).toBe(1);

    // Canonical ordering: alphabetical min first.
    const row = db
      .query(
        `SELECT id, name, body FROM act_artifact WHERE kind = 'causal_edge_predicate'`,
      )
      .get() as { id: string; name: string; body: string };
    expect(row.id).toBe("edge_citation_cocitation__k_alpha__k_beta");
    expect(row.name).toBe("citation_cocitation:k_alpha:k_beta");
    const body = JSON.parse(row.body) as Record<string, unknown>;
    expect(body.node_a).toBe("k_alpha");
    expect(body.node_b).toBe("k_beta");
  });

  test("three cited_artifact_ids yield C(3,2)=3 distinct artifact-pair edges", async () => {
    const db = openDb(":memory:");
    insertEvent(db, {
      kind: "act_tuple_recorded",
      payload: { cited_artifact_ids: ["a_one", "a_two", "a_three"] },
    });

    const summary = await extractCausalEdges(db);
    expect(summary.artifact_edges_recorded).toBe(3);
    expect(summary.edges_admitted).toBe(3);
    expect(countEdges(db, "citation_artifact")).toBe(3);
    expect(countObservations(db)).toBe(3);
  });

  test("task_edge_recorded with parent + child admits one refinement edge", async () => {
    const db = openDb(":memory:");
    insertEvent(db, {
      kind: "task_edge_recorded",
      payload: { parent_task_id: "t_parent", child_task_id: "t_child" },
    });

    const summary = await extractCausalEdges(db);
    expect(summary.refinement_edges_recorded).toBe(1);
    expect(summary.edges_admitted).toBe(1);
    expect(countEdges(db, "refinement_parent_child")).toBe(1);

    const row = db
      .query(
        `SELECT id FROM act_artifact
         WHERE kind = 'causal_edge_predicate' AND name LIKE 'refinement_parent_child:%'`,
      )
      .get() as { id: string };
    // Canonical ordering: alphabetical min first. "t_child" < "t_parent".
    expect(row.id).toBe("edge_refinement_parent_child__t_child__t_parent");
  });

  test("re-running on the same acts is idempotent (no duplicate rows)", async () => {
    const db = openDb(":memory:");
    insertEvent(db, {
      kind: "act_tuple_recorded",
      payload: { cited_knowledge_ids: ["k_x", "k_y"] },
    });
    insertEvent(db, {
      kind: "task_edge_recorded",
      payload: { parent_task_id: "t_p", child_task_id: "t_c" },
    });

    await extractCausalEdges(db);
    const edgeCountFirst = countEdges(db);
    expect(edgeCountFirst).toBe(2);

    // Second run sees the same source events and the existing edge rows.
    await extractCausalEdges(db);
    const edgeCountSecond = countEdges(db);
    expect(edgeCountSecond).toBe(edgeCountFirst);
  });

  test("ordering is canonical regardless of input order", async () => {
    const db = openDb(":memory:");
    // Insert ids in reverse alphabetical order — extractor must still
    // canonicalize to (min, max).
    insertEvent(db, {
      kind: "act_tuple_recorded",
      payload: { cited_knowledge_ids: ["k_zebra", "k_apple"] },
    });
    await extractCausalEdges(db);
    const row = db
      .query(`SELECT id FROM act_artifact WHERE kind = 'causal_edge_predicate'`)
      .get() as { id: string };
    expect(row.id).toBe("edge_citation_cocitation__k_apple__k_zebra");
  });

  test("acts older than windowDays are not picked up", async () => {
    const db = openDb(":memory:");
    // 30 days ago — outside the default 14-day window.
    const oldTs = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    insertEvent(db, {
      kind: "act_tuple_recorded",
      payload: { cited_knowledge_ids: ["k_old1", "k_old2"] },
      ts: oldTs,
    });
    // And a recent one — must be picked up.
    insertEvent(db, {
      kind: "act_tuple_recorded",
      payload: { cited_knowledge_ids: ["k_new1", "k_new2"] },
    });

    const summary = await extractCausalEdges(db);
    expect(summary.scanned).toBe(1);
    expect(summary.cocitations_recorded).toBe(1);
    expect(countEdges(db, "citation_cocitation")).toBe(1);
  });

  test("admitted edge row carries neutral Beta(1,1) prior", async () => {
    const db = openDb(":memory:");
    insertEvent(db, {
      kind: "act_tuple_recorded",
      payload: { cited_knowledge_ids: ["k_a", "k_b"] },
    });
    await extractCausalEdges(db);
    const row = db
      .query(
        `SELECT posterior_alpha, posterior_beta, score, status
         FROM act_artifact WHERE kind = 'causal_edge_predicate'`,
      )
      .get() as {
        posterior_alpha: number;
        posterior_beta: number;
        score: number;
        status: string;
      };
    expect(row.posterior_alpha).toBe(1);
    expect(row.posterior_beta).toBe(1);
    expect(row.score).toBeCloseTo(0.5, 8);
    expect(row.status).toBe("admitted");
  });

  test("credit half: edge co-cited in a low-residual ACT (predicted_residual) gets posterior_alpha>1 + score>0.5, and a second tick does NOT double-credit", async () => {
    const db = openDb(":memory:");
    // An act co-cites k_a + k_b AND carries its OWN low predicted_residual
    // (good outcome). The act is the outcome unit — no separate closure.
    insertEvent(db, {
      kind: "act_tuple_recorded",
      directive_id: "d_good",
      payload: { cited_knowledge_ids: ["k_a", "k_b"], predicted_residual: 0.1 },
    });

    const first = await extractCausalEdges(db);
    // Edge admitted by the creation half, then credited by the credit half.
    expect(first.edges_credited).toBe(1);
    expect(first.credit_acts_scanned).toBe(1);
    expect(first.credit_acts_with_residual).toBe(1);

    const edgeIdStr = "edge_citation_cocitation__k_a__k_b";
    const row1 = db
      .query(
        `SELECT posterior_alpha, posterior_beta, score FROM act_artifact WHERE id = ?`,
      )
      .get(edgeIdStr) as { posterior_alpha: number; posterior_beta: number; score: number };
    // Low residual → +alpha. From Beta(1,1) → Beta(2,1).
    expect(row1.posterior_alpha).toBe(2);
    expect(row1.posterior_beta).toBe(1);
    expect(row1.score).toBeGreaterThan(0.5);
    expect(row1.score).toBeCloseTo(2 / 3, 6);

    // Exactly one credit event for this (edge, act) pair.
    const creditCount1 = (db
      .query(`SELECT COUNT(*) AS n FROM events WHERE kind = 'causal_edge_credited'`)
      .get() as { n: number }).n;
    expect(creditCount1).toBe(1);

    // Second tick: same act, same edge — must NOT double-credit.
    const second = await extractCausalEdges(db);
    expect(second.edges_credited).toBe(0);
    expect(second.credit_pairs_skipped_dup).toBe(1);

    const row2 = db
      .query(`SELECT posterior_alpha, posterior_beta FROM act_artifact WHERE id = ?`)
      .get(edgeIdStr) as { posterior_alpha: number; posterior_beta: number };
    // Posterior unchanged across the idempotent re-run.
    expect(row2.posterior_alpha).toBe(2);
    expect(row2.posterior_beta).toBe(1);
    const creditCount2 = (db
      .query(`SELECT COUNT(*) AS n FROM events WHERE kind = 'causal_edge_credited'`)
      .get() as { n: number }).n;
    expect(creditCount2).toBe(1);
  });

  test("credit half: high-residual ACT applies +beta (bad outcome) → score<0.5", async () => {
    const db = openDb(":memory:");
    insertEvent(db, {
      kind: "act_tuple_recorded",
      directive_id: "d_bad",
      payload: { cited_knowledge_ids: ["k_p", "k_q"], predicted_residual: 0.8 },
    });

    await extractCausalEdges(db);
    const row = db
      .query(
        `SELECT posterior_alpha, posterior_beta, score FROM act_artifact WHERE id = ?`,
      )
      .get("edge_citation_cocitation__k_p__k_q") as {
        posterior_alpha: number;
        posterior_beta: number;
        score: number;
      };
    // High residual → +beta. From Beta(1,1) → Beta(1,2).
    expect(row.posterior_alpha).toBe(1);
    expect(row.posterior_beta).toBe(2);
    expect(row.score).toBeLessThan(0.5);
  });

  test("credit half: act with no predicted_residual falls back to its projected action_scored residual", async () => {
    const db = openDb(":memory:");
    const actId = insertEvent(db, {
      kind: "act_tuple_recorded",
      directive_id: "d_scored",
      payload: { cited_knowledge_ids: ["k_s1", "k_s2"], source_act_id: "src_act_1" },
    });
    // The projected action_scored row carries the realized residual, keyed
    // by source_act_id. Low residual → good outcome.
    insertEvent(db, {
      kind: "action_scored",
      directive_id: "d_scored",
      payload: { source_act_id: "src_act_1", residual: 0.05, observation: "ok" },
    });
    void actId;

    const summary = await extractCausalEdges(db);
    expect(summary.credit_acts_with_residual).toBe(1);
    expect(summary.edges_credited).toBe(1);
    const row = db
      .query(`SELECT posterior_alpha, posterior_beta FROM act_artifact WHERE id = ?`)
      .get("edge_citation_cocitation__k_s1__k_s2") as {
        posterior_alpha: number;
        posterior_beta: number;
      };
    expect(row.posterior_alpha).toBe(2);
    expect(row.posterior_beta).toBe(1);
  });

  test("credit half: act with no residual signal at all is skipped (not credited)", async () => {
    const db = openDb(":memory:");
    insertEvent(db, {
      kind: "act_tuple_recorded",
      directive_id: "d_none",
      payload: { cited_knowledge_ids: ["k_n1", "k_n2"] },
    });
    const summary = await extractCausalEdges(db);
    // Edge admitted by creation half, but no residual → no credit.
    expect(summary.credit_acts_scanned).toBe(1);
    expect(summary.credit_acts_with_residual).toBe(0);
    expect(summary.edges_credited).toBe(0);
    const row = db
      .query(`SELECT posterior_alpha, posterior_beta FROM act_artifact WHERE id = ?`)
      .get("edge_citation_cocitation__k_n1__k_n2") as {
        posterior_alpha: number;
        posterior_beta: number;
      };
    // Still at neutral cold-start prior.
    expect(row.posterior_alpha).toBe(1);
    expect(row.posterior_beta).toBe(1);
  });

  test("task_edge_recorded without both endpoints is skipped", async () => {
    const db = openDb(":memory:");
    insertEvent(db, {
      kind: "task_edge_recorded",
      payload: { parent_task_id: "t_parent" }, // child missing
    });
    insertEvent(db, {
      kind: "task_edge_recorded",
      payload: { child_task_id: "t_child" }, // parent missing
    });
    const summary = await extractCausalEdges(db);
    expect(summary.refinement_edges_recorded).toBe(0);
    expect(countEdges(db, "refinement_parent_child")).toBe(0);
  });

  // Scale fix: the creation half persists a high-watermark (max processed
  // act_tuple_recorded ts) in the meta table so each tick scans only NEWER
  // acts. This test proves both legs of the contract:
  //   (a) NEW acts emitted after a tick ARE processed on the next tick;
  //   (b) OLD acts already processed are NOT re-scanned (no redundant
  //       creation work / re-observation), while still producing identical
  //       cumulative edge rows.
  test("creation watermark: second tick processes only NEW acts, does not reprocess old ones", async () => {
    const db = openDb(":memory:");

    // Tick 1: one cocitation act → one edge + one observation.
    insertEvent(db, {
      kind: "act_tuple_recorded",
      payload: { cited_knowledge_ids: ["k_old_a", "k_old_b"] },
    });
    const first = await extractCausalEdges(db);
    expect(first.scanned).toBe(1);
    expect(first.cocitations_recorded).toBe(1);
    expect(countEdges(db, "citation_cocitation")).toBe(1);
    expect(countObservations(db)).toBe(1);

    // Watermark was persisted.
    const wm = db
      .query("SELECT value FROM meta WHERE key = 'causal_edge:creation_watermark_ts'")
      .get() as { value: string } | null;
    expect(wm?.value).toBeTruthy();

    // Tick 2: add a NEW act. The creation half must scan ONLY the new act
    // (scanned=1, not 2 — the old act is behind the watermark), admit the new
    // edge, and emit exactly one new observation (total 2). The old edge row
    // is untouched and not duplicated.
    insertEvent(db, {
      kind: "act_tuple_recorded",
      payload: { cited_knowledge_ids: ["k_new_a", "k_new_b"] },
    });
    const second = await extractCausalEdges(db);
    expect(second.scanned).toBe(1); // ONLY the new act — old one is behind the watermark
    expect(second.cocitations_recorded).toBe(1);
    expect(countEdges(db, "citation_cocitation")).toBe(2); // cumulative: old + new, no dupes
    expect(countObservations(db)).toBe(2); // one observation per first-seen edge, no re-observation of the old

    // Tick 3 with no new acts: nothing scanned, no new observations.
    const third = await extractCausalEdges(db);
    expect(third.scanned).toBe(0);
    expect(countObservations(db)).toBe(2);
    expect(countEdges(db, "citation_cocitation")).toBe(2);
  });
});
