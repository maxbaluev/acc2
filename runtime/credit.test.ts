// acc2 credit pipeline tests — Shapley distribution + per-entity posterior
// updates + event emission (v2-design.md §3.6.1 Rule 3, §17 Phase H).

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import { insertArtifact, getArtifact } from "./artifact_store";
import {
  distributeCredit,
  shapleyWeightsByCorroboration,
  __extractBodyCitationsForTest,
  __collectCitationsForTest,
  __residualToBetaDeltasForTest,
} from "./credit";
import type { Database } from "bun:sqlite";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const insertSampleArtifact = (
  db: Database,
  id: string,
  body: string,
  opts?: { initialAlpha?: number; initialBeta?: number; score?: number; confidence?: number; status?: "admitted" | "promoted" | "quarantined" },
) => {
  return insertArtifact(db, {
    runtime: "bun",
    body,
    declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
    stateRoot: null,
    posteriorAlpha: opts?.initialAlpha ?? 1,
    posteriorBeta: opts?.initialBeta ?? 1,
    score: opts?.score ?? 0.5,
    confidence: opts?.confidence ?? 0.3,
    recentResidualMean: 0,
    recentKillCount: 0,
    status: opts?.status ?? "admitted",
    name: null,
    fixtureInput: null,
    fixtureExpectedResidual: 0.2,
    id,
  });
};

describe("shapleyWeightsByCorroboration", () => {
  test("returns empty for n=0", () => {
    expect(shapleyWeightsByCorroboration(0)).toEqual([]);
  });

  test("returns [1.0] for n=1", () => {
    const w = shapleyWeightsByCorroboration(1);
    expect(w.length).toBe(1);
    expect(w[0]).toBeCloseTo(1.0, 6);
  });

  test("first-discoverer receives the largest share", () => {
    const w = shapleyWeightsByCorroboration(3);
    expect(w.length).toBe(3);
    expect(w[0]).toBeGreaterThan(w[1]!);
    expect(w[1]).toBeGreaterThan(w[2]!);
  });

  test("weights sum to 1.0 within float epsilon for many sizes", () => {
    for (const n of [1, 2, 3, 4, 5, 10, 20]) {
      const w = shapleyWeightsByCorroboration(n);
      const sum = w.reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1.0, 10);
    }
  });

  test("monotonically decreasing weights", () => {
    const w = shapleyWeightsByCorroboration(7);
    for (let i = 1; i < w.length; i++) {
      expect(w[i]).toBeLessThanOrEqual(w[i - 1]!);
    }
  });
});

describe("body citation extraction", () => {
  test("extracts @cite k_NNN markers from a JS body", () => {
    const body = "// @cite k_201\nconsole.log('hello'); // also @cite k_174";
    const ids = __extractBodyCitationsForTest(body);
    expect(ids).toEqual(["k_201", "k_174"]);
  });

  test("deduplicates while preserving first-seen order", () => {
    const body = "@cite k_201 \n@cite k_174 \n@cite k_201 \n@cite k_555";
    const ids = __extractBodyCitationsForTest(body);
    expect(ids).toEqual(["k_201", "k_174", "k_555"]);
  });

  test("extracts art_ ids as well", () => {
    const body = "/* @cite art_alpha and @cite k_beta */";
    const ids = __extractBodyCitationsForTest(body);
    expect(ids).toContain("art_alpha");
    expect(ids).toContain("k_beta");
  });
});

describe("residual → beta deltas", () => {
  test("success band: pure alpha", () => {
    const d = __residualToBetaDeltasForTest(0);
    expect(d.alphaDelta).toBeCloseTo(1, 6);
    expect(d.betaDelta).toBeCloseTo(0, 6);
  });
  test("failure band: pure beta", () => {
    const d = __residualToBetaDeltasForTest(1);
    expect(d.alphaDelta).toBeCloseTo(0, 6);
    expect(d.betaDelta).toBeCloseTo(1, 6);
  });
  test("mid-band 0.5: roughly equal split", () => {
    const d = __residualToBetaDeltasForTest(0.5);
    expect(d.alphaDelta).toBeCloseTo(0.25, 6);
    expect(d.betaDelta).toBeCloseTo(0.25, 6);
  });
});

describe("distributeCredit — primary + cited entities", () => {
  test("primary action + verifier posteriors move; code_artifact_score_updated emitted", async () => {
    const db = openDb(":memory:");
    insertSampleArtifact(db, "art_action", "// action body\nconsole.log('@@RESULT@@ 1');");
    insertSampleArtifact(db, "art_verifier", "// verifier body\nconsole.log('@@RESULT@@ {\"residual\":0}');");

    // Emit action_predicted, artifact_observed, action_scored as a normal flow.
    const ap = emitEvent(db, {
      kind: "action_predicted",
      substrate_origin: "opencode",
      action_artifact_id: "art_action",
      verifier_artifact_id: "art_verifier",
      predicted_residual: 0.0,
      payload: {},
    });
    const obs = emitEvent(db, {
      kind: "artifact_observed",
      substrate_origin: "substrate_auto",
      action_artifact_id: "art_action",
      payload: { phase: "completed" },
    });
    const scored = emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate_auto",
      action_artifact_id: "art_action",
      verifier_artifact_id: "art_verifier",
      residual: 0,
      payload: {},
    });

    const result = await distributeCredit(db, {
      action_event_id: ap.id,
      observation_event_id: obs.id,
      scored_event_id: scored.id,
      predicted_residual: 0.0,
      observed_residual: 0.0,
    });

    expect(result.action_artifact_id).toBe("art_action");
    expect(result.verifier_artifact_id).toBe("art_verifier");
    expect(result.delta).toBeCloseTo(0, 6);

    const action = getArtifact(db, "art_action")!;
    const verifier = getArtifact(db, "art_verifier")!;
    expect(action.posteriorAlpha).toBeGreaterThan(1);
    expect(verifier.posteriorAlpha).toBeGreaterThan(1);

    // code_artifact_score_updated events fired for action + verifier.
    const updated = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'code_artifact_score_updated'")
      .get() as { c: number };
    expect(updated.c).toBeGreaterThanOrEqual(2);
  });

  test("first-discoverer gets larger Shapley share than later corroborators", async () => {
    const db = openDb(":memory:");
    insertSampleArtifact(db, "art_action", "// action body");
    insertSampleArtifact(db, "art_verifier", "// verifier body");
    // Three cited code artifacts.
    insertSampleArtifact(db, "art_cited_a", "// cited a");
    insertSampleArtifact(db, "art_cited_b", "// cited b");
    insertSampleArtifact(db, "art_cited_c", "// cited c");

    const ap = emitEvent(db, {
      kind: "action_predicted",
      substrate_origin: "opencode",
      action_artifact_id: "art_action",
      verifier_artifact_id: "art_verifier",
      context_refs: ["art_cited_a", "art_cited_b", "art_cited_c"],
      payload: {},
    });
    const obs = emitEvent(db, {
      kind: "artifact_observed",
      substrate_origin: "substrate_auto",
      action_artifact_id: "art_action",
      payload: {},
    });
    const scored = emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate_auto",
      action_artifact_id: "art_action",
      verifier_artifact_id: "art_verifier",
      residual: 0,
      payload: {},
    });

    const result = await distributeCredit(db, {
      action_event_id: ap.id,
      observation_event_id: obs.id,
      scored_event_id: scored.id,
      predicted_residual: 0,
      observed_residual: 0,
    });

    const cited = result.contributions.filter((c) => c.target_kind === "code_artifact");
    expect(cited.length).toBe(3);
    // Ordering follows context_refs order — first-discoverer has largest weight.
    expect(cited[0]!.target_id).toBe("art_cited_a");
    expect(cited[0]!.weight).toBeGreaterThan(cited[1]!.weight);
    expect(cited[1]!.weight).toBeGreaterThan(cited[2]!.weight);

    // Sum-to-one over cited contributions.
    const sum = cited.reduce((a, c) => a + c.weight, 0);
    expect(sum).toBeCloseTo(1.0, 6);

    // Each cited artifact's posterior moved by its weighted share.
    const aRow = getArtifact(db, "art_cited_a")!;
    const cRow = getArtifact(db, "art_cited_c")!;
    expect(aRow.posteriorAlpha - 1).toBeGreaterThan(cRow.posteriorAlpha - 1);
  });

  test("knowledge citations emit candidate_confirmed (success) or candidate_contradicted (failure)", async () => {
    const db = openDb(":memory:");
    insertSampleArtifact(db, "art_action", "// action");
    insertSampleArtifact(db, "art_verifier", "// verifier");
    // Seed two knowledge_candidate events.
    const kc1 = emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "claude_root",
      payload: { text: "candidate alpha" },
    });
    const kc2 = emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "opencode",
      payload: { text: "candidate beta" },
    });

    const ap = emitEvent(db, {
      kind: "action_predicted",
      substrate_origin: "opencode",
      action_artifact_id: "art_action",
      verifier_artifact_id: "art_verifier",
      context_refs: [kc1.id, kc2.id],
      payload: {},
    });
    const obs = emitEvent(db, {
      kind: "artifact_observed",
      substrate_origin: "substrate_auto",
      action_artifact_id: "art_action",
      payload: {},
    });
    const scored = emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate_auto",
      action_artifact_id: "art_action",
      verifier_artifact_id: "art_verifier",
      residual: 0,
      payload: {},
    });

    await distributeCredit(db, {
      action_event_id: ap.id,
      observation_event_id: obs.id,
      scored_event_id: scored.id,
      predicted_residual: 0,
      observed_residual: 0,
    });

    const confirmed = db
      .query("SELECT context_refs FROM events WHERE kind = 'candidate_confirmed'")
      .all() as Array<{ context_refs: string }>;
    expect(confirmed.length).toBeGreaterThanOrEqual(2);
    const allRefs = confirmed.flatMap((r) => JSON.parse(r.context_refs) as string[]);
    expect(allRefs).toContain(kc1.id);
    expect(allRefs).toContain(kc2.id);

    // Now run a high-residual case → candidate_contradicted should fire.
    const ap2 = emitEvent(db, {
      kind: "action_predicted",
      substrate_origin: "opencode",
      action_artifact_id: "art_action",
      verifier_artifact_id: "art_verifier",
      context_refs: [kc1.id],
      payload: {},
    });
    const obs2 = emitEvent(db, {
      kind: "artifact_observed",
      substrate_origin: "substrate_auto",
      action_artifact_id: "art_action",
      payload: {},
    });
    const scored2 = emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate_auto",
      action_artifact_id: "art_action",
      verifier_artifact_id: "art_verifier",
      residual: 0.95,
      payload: {},
    });
    await distributeCredit(db, {
      action_event_id: ap2.id,
      observation_event_id: obs2.id,
      scored_event_id: scored2.id,
      predicted_residual: 0.1,
      observed_residual: 0.95,
    });

    const contradicted = db
      .query("SELECT context_refs FROM events WHERE kind = 'candidate_contradicted'")
      .all() as Array<{ context_refs: string }>;
    expect(contradicted.length).toBeGreaterThan(0);
  });

  test("citation from artifact bodies via @cite markers is honored", async () => {
    const db = openDb(":memory:");
    insertSampleArtifact(
      db,
      "art_action",
      "// @cite k_555\nconsole.log('@@RESULT@@ 1');",
    );
    insertSampleArtifact(
      db,
      "art_verifier",
      "// @cite k_201\nconsole.log('@@RESULT@@ {\"residual\":0}');",
    );
    // Pre-create the knowledge_candidate events so classification works.
    emitEvent(db, { kind: "knowledge_candidate", substrate_origin: "claude_root", payload: { text: "k555" } });
    // Note: classify falls back to "unknown" → treated as knowledge anyway; but
    // here we don't bother with a matching id since classify will resolve them
    // as unknown → knowledge events emit either way.

    const ap = emitEvent(db, {
      kind: "action_predicted",
      substrate_origin: "opencode",
      action_artifact_id: "art_action",
      verifier_artifact_id: "art_verifier",
      payload: {},
    });
    const obs = emitEvent(db, {
      kind: "artifact_observed",
      substrate_origin: "substrate_auto",
      action_artifact_id: "art_action",
      payload: {},
    });
    const scored = emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate_auto",
      action_artifact_id: "art_action",
      verifier_artifact_id: "art_verifier",
      residual: 0,
      payload: {},
    });

    const result = await distributeCredit(db, {
      action_event_id: ap.id,
      observation_event_id: obs.id,
      scored_event_id: scored.id,
      predicted_residual: 0,
      observed_residual: 0,
    });
    // Two body citations resolved → two contributions.
    const cited = result.contributions;
    const ids = cited.map((c) => c.target_id);
    expect(ids).toContain("k_555");
    expect(ids).toContain("k_201");
  });

  test("self-references (action + verifier artifact ids) are not counted as citations", async () => {
    const db = openDb(":memory:");
    insertSampleArtifact(db, "art_a", "// a");
    insertSampleArtifact(db, "art_v", "// v");
    const ap = emitEvent(db, {
      kind: "action_predicted",
      substrate_origin: "opencode",
      action_artifact_id: "art_a",
      verifier_artifact_id: "art_v",
      // include the action + verifier ids in context_refs deliberately
      context_refs: ["art_a", "art_v"],
      payload: {},
    });
    const obs = emitEvent(db, {
      kind: "artifact_observed",
      substrate_origin: "substrate_auto",
      action_artifact_id: "art_a",
      payload: {},
    });
    const scored = emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate_auto",
      action_artifact_id: "art_a",
      verifier_artifact_id: "art_v",
      residual: 0,
      payload: {},
    });
    const result = await distributeCredit(db, {
      action_event_id: ap.id,
      observation_event_id: obs.id,
      scored_event_id: scored.id,
      predicted_residual: 0,
      observed_residual: 0,
    });
    // Cited contributions list MUST exclude art_a + art_v (they get primary credit).
    const ids = result.contributions.map((c) => c.target_id);
    expect(ids).not.toContain("art_a");
    expect(ids).not.toContain("art_v");
  });
});

describe("collectCitations dedup + ordering (internal helper)", () => {
  test("preserves first-seen order across event sources + body sources", () => {
    const db = openDb(":memory:");
    const ap = emitEvent(db, {
      kind: "action_predicted",
      substrate_origin: "opencode",
      action_artifact_id: "AA",
      verifier_artifact_id: "VV",
      context_refs: ["k_001", "k_002"],
      payload: {},
    });
    const obs = emitEvent(db, {
      kind: "artifact_observed",
      substrate_origin: "substrate_auto",
      action_artifact_id: "AA",
      context_refs: ["k_002", "k_003"], // k_002 already seen
      payload: {},
    });
    const scored = emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate_auto",
      action_artifact_id: "AA",
      verifier_artifact_id: "VV",
      context_refs: ["k_004"],
      residual: 0,
      payload: {},
    });
    const ids = __collectCitationsForTest(
      db,
      {
        action_event_id: ap.id,
        observation_event_id: obs.id,
        scored_event_id: scored.id,
        predicted_residual: 0,
        observed_residual: 0,
      },
      ["k_005"], // action body
      ["k_001"], // verifier body — already in event refs, must dedupe
      "AA",
      "VV",
    );
    expect(ids).toEqual(["k_001", "k_002", "k_003", "k_004", "k_005"]);
  });
});
