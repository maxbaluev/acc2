// acc2 credit pipeline tests — Shapley distribution + per-entity posterior
// updates + event emission (v2-design.md §3.6.1 Rule 3, §17 Phase H).

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import { insertArtifact, getArtifact } from "./artifact_store";
import {
  distributeCredit,
  distributeOwnerObservedOutcomeCredit,
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
  test("primary action + verifier posteriors move; act_artifact_score_updated emitted", async () => {
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

    // act_artifact_score_updated events fired for action + verifier.
    const updated = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'act_artifact_score_updated'")
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

    const cited = result.contributions.filter((c) => c.target_kind === "act_artifact");
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

  test("midband knowledge outcomes emit knowledge_uncertainty_observed with calibration evidence", async () => {
    const db = openDb(":memory:");
    insertSampleArtifact(db, "art_action", "// action");
    insertSampleArtifact(db, "art_verifier", "// verifier");
    const kc = emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "opencode",
      payload: { text: "candidate gamma", confidence_estimate: 0.8 },
    });
    const ap = emitEvent(db, {
      kind: "action_predicted",
      substrate_origin: "opencode",
      action_artifact_id: "art_action",
      verifier_artifact_id: "art_verifier",
      context_refs: [kc.id],
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
      residual: 0.5,
      payload: {},
    });

    const result = await distributeCredit(db, {
      action_event_id: ap.id,
      observation_event_id: obs.id,
      scored_event_id: scored.id,
      predicted_residual: 0.2,
      observed_residual: 0.5,
    });

    const uncertainty = db
      .query("SELECT context_refs, payload FROM events WHERE kind = 'knowledge_uncertainty_observed'")
      .get() as { context_refs: string; payload: string } | null;
    expect(uncertainty).not.toBeNull();
    expect(result.emitted_events.length).toBeGreaterThan(0);
    const refs = JSON.parse(uncertainty!.context_refs) as string[];
    expect(refs).toEqual([kc.id, scored.id]);
    const payload = JSON.parse(uncertainty!.payload) as {
      knowledge_id: string;
      residual: number;
      residual_band: string;
      calibration_evidence_event_id: string;
      origin_calibration: { origin: string; predicted_confidence: number; observed_success_probability: number; calibration_error: number };
      merger_quality_axes: Record<string, number>;
    };
    expect(payload.knowledge_id).toBe(kc.id);
    expect(payload.residual).toBeCloseTo(0.5, 6);
    expect(payload.residual_band).toBe("midband");
    expect(payload.calibration_evidence_event_id).toBe(scored.id);
    expect(payload.origin_calibration.origin).toBe("opencode");
    expect(payload.origin_calibration.predicted_confidence).toBeCloseTo(0.8, 6);
    expect(payload.origin_calibration.observed_success_probability).toBeCloseTo(0.5, 6);
    expect(payload.merger_quality_axes.uncertainty).toBeCloseTo(1, 6);
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

describe("LATM novelty bonus (§11.5)", () => {
  /** Open a directive_opened row carrying `directive_text` so the credit
   *  pipeline can resolve goalShape() on the directive id. */
  const openDirective = (db: Database, directiveId: string, text: string): void => {
    db.run(
      `INSERT INTO events (
         id, ts, directive_id, task_id, parent_task_id, loop_id,
         substrate_origin, kind, payload, context_refs,
         predicted_residual, action_artifact_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `${directiveId}_opened`,
        new Date().toISOString(),
        directiveId,
        directiveId,
        null,
        "loop_root",
        "claude_root",
        "directive_opened",
        JSON.stringify({ directive_text: text }),
        JSON.stringify([]),
        null,
        null,
      ],
    );
  };

  test("first credit on a novel goal_shape emits latm_novelty_bonus_applied for action + verifier", async () => {
    const db = openDb(":memory:");
    insertSampleArtifact(db, "art_action", "// action body");
    insertSampleArtifact(db, "art_verifier", "// verifier body");
    openDirective(db, "d_novel", "audit the rolling reviewer cadence");

    const ap = emitEvent(db, {
      kind: "action_predicted",
      substrate_origin: "opencode",
      directive_id: "d_novel",
      task_id: "t_novel",
      action_artifact_id: "art_action",
      verifier_artifact_id: "art_verifier",
      payload: {},
    });
    const obs = emitEvent(db, {
      kind: "artifact_observed",
      substrate_origin: "substrate_auto",
      directive_id: "d_novel",
      task_id: "t_novel",
      action_artifact_id: "art_action",
      payload: {},
    });
    const scored = emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate_auto",
      directive_id: "d_novel",
      task_id: "t_novel",
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

    const novelty = db
      .query("SELECT action_artifact_id, payload FROM events WHERE kind = 'latm_novelty_bonus_applied' ORDER BY ts ASC")
      .all() as Array<{ action_artifact_id: string; payload: string }>;
    expect(novelty.length).toBe(2);
    const ids = novelty.map((r) => r.action_artifact_id).sort();
    expect(ids).toEqual(["art_action", "art_verifier"]);
    const firstPayload = JSON.parse(novelty[0]!.payload) as { base_weight: number; bonus_weight: number; multiplier: number; goal_shape: string };
    expect(firstPayload.base_weight).toBeCloseTo(1.0, 6);
    expect(firstPayload.bonus_weight).toBeCloseTo(1.5, 6);
    expect(firstPayload.multiplier).toBeCloseTo(1.5, 6);
    expect(firstPayload.goal_shape).toBeTruthy();
  });

  test("second credit on the SAME goal_shape does NOT emit the bonus again", async () => {
    const db = openDb(":memory:");
    insertSampleArtifact(db, "art_action", "// action body");
    insertSampleArtifact(db, "art_verifier", "// verifier body");
    openDirective(db, "d_repeat", "audit the rolling reviewer cadence");

    const runOnce = async (): Promise<void> => {
      const ap = emitEvent(db, {
        kind: "action_predicted",
        substrate_origin: "opencode",
        directive_id: "d_repeat",
        task_id: "t_repeat",
        action_artifact_id: "art_action",
        verifier_artifact_id: "art_verifier",
        payload: {},
      });
      const obs = emitEvent(db, {
        kind: "artifact_observed",
        substrate_origin: "substrate_auto",
        directive_id: "d_repeat",
        task_id: "t_repeat",
        action_artifact_id: "art_action",
        payload: {},
      });
      const scored = emitEvent(db, {
        kind: "action_scored",
        substrate_origin: "substrate_auto",
        directive_id: "d_repeat",
        task_id: "t_repeat",
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
    };
    await runOnce();
    await runOnce();
    const novelty = db
      .query("SELECT action_artifact_id FROM events WHERE kind = 'latm_novelty_bonus_applied'")
      .all() as Array<{ action_artifact_id: string }>;
    // Two artifacts (action + verifier) × ONE bonus each = 2 total, NOT 4.
    expect(novelty.length).toBe(2);
  });

  test("novelty bonus boosts the action artifact's posterior alpha by the multiplier", async () => {
    const dbA = openDb(":memory:");
    insertSampleArtifact(dbA, "art_action", "// a");
    insertSampleArtifact(dbA, "art_verifier", "// v");
    openDirective(dbA, "d_boost", "novel directive goal A");
    const apA = emitEvent(dbA, { kind: "action_predicted", substrate_origin: "opencode", directive_id: "d_boost", task_id: "t_boost", action_artifact_id: "art_action", verifier_artifact_id: "art_verifier", payload: {} });
    const obsA = emitEvent(dbA, { kind: "artifact_observed", substrate_origin: "substrate_auto", directive_id: "d_boost", task_id: "t_boost", action_artifact_id: "art_action", payload: {} });
    const scoredA = emitEvent(dbA, { kind: "action_scored", substrate_origin: "substrate_auto", directive_id: "d_boost", task_id: "t_boost", action_artifact_id: "art_action", verifier_artifact_id: "art_verifier", residual: 0, payload: {} });
    await distributeCredit(dbA, { action_event_id: apA.id, observation_event_id: obsA.id, scored_event_id: scoredA.id, predicted_residual: 0, observed_residual: 0 });
    const bonusedAlpha = getArtifact(dbA, "art_action")!.posteriorAlpha;
    closeDb();

    // Same residual, but pre-seed the score-update history so novelty is OFF.
    const dbB = openDb(":memory:");
    insertSampleArtifact(dbB, "art_action", "// a");
    insertSampleArtifact(dbB, "art_verifier", "// v");
    openDirective(dbB, "d_boost", "novel directive goal A");
    // Manually plant a prior score_update for art_action under the SAME goal_shape
    // so the novelty check returns "already seen" → no bonus is applied.
    const { goalShape } = require("./goal_shape") as typeof import("./goal_shape");
    const gs = goalShape("novel directive goal A");
    emitEvent(dbB, {
      kind: "act_artifact_score_updated",
      substrate_origin: "substrate_auto",
      directive_id: "d_prior",
      task_id: "t_prior",
      action_artifact_id: "art_action",
      payload: { artifact_id: "art_action", role: "action", goal_shape: gs },
    });
    emitEvent(dbB, {
      kind: "act_artifact_score_updated",
      substrate_origin: "substrate_auto",
      directive_id: "d_prior",
      task_id: "t_prior",
      action_artifact_id: "art_verifier",
      payload: { artifact_id: "art_verifier", role: "verifier", goal_shape: gs },
    });
    const apB = emitEvent(dbB, { kind: "action_predicted", substrate_origin: "opencode", directive_id: "d_boost", task_id: "t_boost2", action_artifact_id: "art_action", verifier_artifact_id: "art_verifier", payload: {} });
    const obsB = emitEvent(dbB, { kind: "artifact_observed", substrate_origin: "substrate_auto", directive_id: "d_boost", task_id: "t_boost2", action_artifact_id: "art_action", payload: {} });
    const scoredB = emitEvent(dbB, { kind: "action_scored", substrate_origin: "substrate_auto", directive_id: "d_boost", task_id: "t_boost2", action_artifact_id: "art_action", verifier_artifact_id: "art_verifier", residual: 0, payload: {} });
    await distributeCredit(dbB, { action_event_id: apB.id, observation_event_id: obsB.id, scored_event_id: scoredB.id, predicted_residual: 0, observed_residual: 0 });
    const noBonusAlpha = getArtifact(dbB, "art_action")!.posteriorAlpha;
    // The bonused-credit alpha should be larger than the unboosted one. With
    // multiplier=1.5 and residual=0, the bonused αΔ is 1.5 vs 1.0 → strict.
    expect(bonusedAlpha).toBeGreaterThan(noBonusAlpha);
  });

  // Test "ACC2_LATM_NOVELTY_BONUS env overrides the default multiplier"
  // deleted — env override removed in the universality cleanup (the
  // 1.5× multiplier is the universal value pending f13 adaptive scoring).

  test("novelty bonus is a no-op when the directive has no directive_opened row", async () => {
    const db = openDb(":memory:");
    insertSampleArtifact(db, "art_action", "// a");
    insertSampleArtifact(db, "art_verifier", "// v");
    // No openDirective() call → resolveGoalShape returns "".
    const ap = emitEvent(db, { kind: "action_predicted", substrate_origin: "opencode", action_artifact_id: "art_action", verifier_artifact_id: "art_verifier", payload: {} });
    const obs = emitEvent(db, { kind: "artifact_observed", substrate_origin: "substrate_auto", action_artifact_id: "art_action", payload: {} });
    const scored = emitEvent(db, { kind: "action_scored", substrate_origin: "substrate_auto", action_artifact_id: "art_action", verifier_artifact_id: "art_verifier", residual: 0, payload: {} });
    await distributeCredit(db, { action_event_id: ap.id, observation_event_id: obs.id, scored_event_id: scored.id, predicted_residual: 0, observed_residual: 0 });
    const novelty = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'latm_novelty_bonus_applied'")
      .get() as { c: number };
    expect(novelty.c).toBe(0);
  });
});

describe("collectCitations dedup + ordering (internal helper)", () => {
  test("knowledge_propagated raises implicit cross-directive transfer above plain exposure", () => {
    const db = openDb(":memory:");
    const source = emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "opencode",
      directive_id: "d_source",
      task_id: "t_source",
      payload: { text: "source-domain insight", confidence_estimate: 1 },
    });
    const ap = emitEvent(db, {
      kind: "action_predicted",
      substrate_origin: "opencode",
      directive_id: "d_target",
      task_id: "t_target",
      action_artifact_id: "AA",
      verifier_artifact_id: "VV",
      payload: {},
    });
    const binding = emitEvent(db, {
      kind: "retrieval_binding",
      substrate_origin: "substrate_auto",
      directive_id: "d_target",
      task_id: "t_target",
      payload: { source_event_id: source.id, binding_surface: "prompt" },
    });
    emitEvent(db, {
      kind: "knowledge_propagated",
      substrate_origin: "substrate_auto",
      directive_id: "d_target",
      task_id: "t_target",
      context_refs: [source.id, binding.id],
      payload: {
        source_event_id: source.id,
        source_directive_id: "d_source",
        target_directive_id: "d_target",
        retrieval_binding_id: binding.id,
      },
    });
    const obs = emitEvent(db, {
      kind: "artifact_observed",
      substrate_origin: "substrate_auto",
      directive_id: "d_target",
      task_id: "t_target",
      action_artifact_id: "AA",
      payload: {},
    });
    const scored = emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate_auto",
      directive_id: "d_target",
      task_id: "t_target",
      action_artifact_id: "AA",
      verifier_artifact_id: "VV",
      residual: 0,
      payload: {},
    });

    const cited = __collectCitationsForTest(
      db,
      {
        action_event_id: ap.id,
        observation_event_id: obs.id,
        scored_event_id: scored.id,
        predicted_residual: 0,
        observed_residual: 0,
      },
      [],
      [],
      "AA",
      "VV",
    );

    expect(cited).toEqual([{ id: source.id, weightFactor: 0.35 }]);
  });

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
    const cited = __collectCitationsForTest(
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
    // collectCitations now returns CitationEntry[] (id + weightFactor)
    // for differential weighting of explicit-cite vs exposure-only.
    // Every entry in this test was cited via context_refs / body @cite,
    // so weightFactor should be 1.0 for all.
    expect(cited.map((c) => c.id)).toEqual(["k_001", "k_002", "k_003", "k_004", "k_005"]);
    expect(cited.every((c) => c.weightFactor === 1.0)).toBe(true);
  });
});


describe("act_tuple_recorded projected credit", () => {
  test("resolves retrieval_binding and source_act_id citations and stamps idempotency metadata", async () => {
    const db = openDb(":memory:");
    const knowledge = emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "opencode",
      directive_id: "d_act_credit",
      task_id: "t_knowledge",
      payload: { claim: "projected act citations receive credit", confidence_estimate: 1 },
    });
    const act = emitEvent(db, {
      kind: "act_tuple_recorded",
      substrate_origin: "claude_root",
      directive_id: "d_act_credit",
      task_id: "t_act_credit",
      action_artifact_id: "synthetic_action",
      verifier_artifact_id: "synthetic_verifier",
      predicted_residual: 0.1,
      residual: 0,
      payload: {
        intent: "credit projected act",
        reasoning_summary: "source act cites knowledge",
        effect_summary: "projection rows created",
        verifier_kind: "deterministic_code",
        cited_knowledge_ids: [knowledge.id],
      },
    });
    const predicted = db.query("SELECT id FROM events WHERE kind = 'action_predicted' AND json_extract(payload, '$.source_act_id') = ?").get(act.id) as { id: string };
    const scored = db.query("SELECT id FROM events WHERE kind = 'action_scored' AND json_extract(payload, '$.source_act_id') = ?").get(act.id) as { id: string };

    const first = await distributeCredit(db, {
      action_event_id: predicted.id,
      observation_event_id: scored.id,
      scored_event_id: scored.id,
      predicted_residual: 0.1,
      observed_residual: 0,
    });
    const second = await distributeCredit(db, {
      action_event_id: predicted.id,
      observation_event_id: scored.id,
      scored_event_id: scored.id,
      predicted_residual: 0.1,
      observed_residual: 0,
    });

    expect(first.action_artifact_id).toBe("synthetic_action");
    expect(second.emitted_events).toContain(first.emitted_events.find((id) => {
      const row = db.query("SELECT kind FROM events WHERE id = ?").get(id) as { kind: string } | null;
      return row?.kind === "candidate_confirmed";
    })!);
    const confirmations = db.query("SELECT payload FROM events WHERE kind = 'candidate_confirmed' AND json_extract(payload, '$.knowledge_id') = ?").all(knowledge.id) as Array<{ payload: string }>;
    expect(confirmations).toHaveLength(1);
    const payload = JSON.parse(confirmations[0]!.payload) as Record<string, unknown>;
    expect(payload.source_act_id).toBe(act.id);
    expect(String(payload.projection_key)).toContain(act.id + ":candidate_confirmed:");
  });

  test("late owner observed outcome reuses projected action and stamps owner evidence", async () => {
    const db = openDb(":memory:");
    const knowledge = emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "opencode",
      directive_id: "d_owner_late",
      task_id: "t_knowledge",
      payload: { claim: "late owner evidence should update act credit", confidence_estimate: 1 },
    });
    const act = emitEvent(db, {
      kind: "act_tuple_recorded",
      substrate_origin: "claude_root",
      directive_id: "d_owner_late",
      task_id: "t_owner_late",
      action_artifact_id: "synthetic_action",
      verifier_artifact_id: "synthetic_verifier",
      predicted_residual: 0.1,
      residual: 0.1,
      payload: {
        intent: "record initial act",
        reasoning_summary: "owner outcome arrives later",
        effect_summary: "projection rows created",
        verifier_kind: "peer_llm_claude",
        cited_knowledge_ids: [knowledge.id],
      },
    });
    const owner = emitEvent(db, {
      kind: "owner_observed_outcome_recorded",
      substrate_origin: "owner",
      directive_id: "d_owner_late",
      task_id: "t_owner_late",
      residual: 1,
      context_refs: [act.id],
      payload: { source_act_id: act.id, observation: "still does not work" },
    });

    await distributeOwnerObservedOutcomeCredit(db, owner.id);

    const contradiction = db.query("SELECT payload FROM events WHERE kind = 'candidate_contradicted' AND json_extract(payload, '$.knowledge_id') = ?").get(knowledge.id) as { payload: string } | null;
    expect(contradiction).not.toBeNull();
    const payload = JSON.parse(contradiction!.payload) as Record<string, unknown>;
    expect(payload.source_act_id).toBe(act.id);
    expect(payload.owner_observed_outcome_event_id).toBe(owner.id);
  });

  test("owner negative verdict on applied change demotes cited artifact automatically", async () => {
    const db = openDb(":memory:");
    insertSampleArtifact(db, "owner_action", "// action");
    insertSampleArtifact(db, "owner_verifier", "// verifier");
    insertSampleArtifact(db, "owner_cited", "// cited", { initialAlpha: 1, initialBeta: 1 });
    const act = emitEvent(db, {
      kind: "act_tuple_recorded",
      substrate_origin: "claude_root",
      directive_id: "d_owner_auto",
      task_id: "t_owner_auto",
      action_artifact_id: "owner_action",
      verifier_artifact_id: "owner_verifier",
      predicted_residual: 0.1,
      residual: 0,
      payload: {
        intent: "record applied change with cited artifact",
        reasoning_summary: "owner may later correct the verifier outcome",
        effect_summary: "projection rows created",
        verifier_kind: "deterministic_code",
        cited_artifact_ids: ["owner_cited"],
      },
    });
    let applied: { id: string } | null = null;
    for (let i = 0; i < 20; i++) {
      applied = db.query("SELECT id FROM events WHERE kind = 'applied_change_committed' AND json_extract(payload, '$.source_act_id') = ?").get(act.id) as { id: string } | null;
      if (applied) break;
      await Bun.sleep(10);
    }
    expect(applied).not.toBeNull();

    const before = getArtifact(db, "owner_cited")!;
    const owner = emitEvent(db, {
      kind: "owner_observed_outcome_recorded",
      substrate_origin: "owner",
      directive_id: "d_owner_auto",
      task_id: "t_owner_auto",
      context_refs: [applied!.id],
      payload: { verdict: "negative", source_event_id: applied!.id, observation: "still broken" },
    });

    let after = getArtifact(db, "owner_cited")!;
    for (let i = 0; i < 20; i++) {
      after = getArtifact(db, "owner_cited")!;
      if (after.posteriorBeta > before.posteriorBeta) break;
      await Bun.sleep(10);
    }
    expect(after.posteriorBeta).toBeGreaterThan(before.posteriorBeta);
    const update = db.query("SELECT payload FROM events WHERE kind = 'act_artifact_score_updated' AND json_extract(payload, '$.artifact_id') = ? AND json_extract(payload, '$.owner_observed_outcome_event_id') = ?").get("owner_cited", owner.id) as { payload: string } | null;
    expect(update).not.toBeNull();
    expect(JSON.parse(update!.payload).residual).toBe(1);
  });
});

// T0.2 — universal emit-boundary projector tests. The projector at the
// runtime/events.ts post-write hook walks action_scored.source_act_event_id
// back to action_predicted, pulls cited_artifact_ids, and emits
// act_artifact_score_updated per cited artifact. Idempotent via
// projection_key act_artifact_score_updated:{source_act_event_id}:{artifact_id}.
describe("projectActionScoredToCredit — universal emit-boundary projector", () => {
  test("emits act_artifact_score_updated per cited_artifact_id with correct residual + posterior delta", async () => {
    const db = openDb(":memory:");
    insertSampleArtifact(db, "proj_cited_a", "// cited a");
    insertSampleArtifact(db, "proj_cited_b", "// cited b");
    // Emit action_predicted that lists two cited artifacts in payload.
    const ap = emitEvent(db, {
      kind: "action_predicted",
      substrate_origin: "substrate_auto",
      directive_id: "d_proj_1",
      task_id: "t_proj_1",
      action_artifact_id: "synthetic_handle_v1",
      verifier_artifact_id: "synthetic_verifier_v1",
      predicted_residual: 0.2,
      payload: {
        source_act_event_id: "synthetic_source",
        cited_artifact_ids: ["proj_cited_a", "proj_cited_b"],
      },
    });
    const aBefore = getArtifact(db, "proj_cited_a")!;
    const bBefore = getArtifact(db, "proj_cited_b")!;
    // Emit action_scored that references the action_predicted via
    // payload.source_act_event_id. The projector should fire and credit
    // both cited artifacts.
    emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate_auto",
      directive_id: "d_proj_1",
      task_id: "t_proj_1",
      action_artifact_id: "synthetic_handle_v1",
      verifier_artifact_id: "synthetic_verifier_v1",
      residual: 0.2,
      payload: {
        source_act_event_id: ap.id,
        verifier_kind: "deterministic_code",
      },
    });
    // Expect one act_artifact_score_updated per cited artifact AND for
    // the primary action_artifact_id + verifier_artifact_id.
    const updates = db
      .query<{ payload: string }, []>(
        "SELECT payload FROM events WHERE kind = 'act_artifact_score_updated' AND json_extract(payload, '$.projected_from') = 'action_scored_universal_projector'",
      )
      .all();
    const artifactIds = updates.map((r) => JSON.parse(r.payload).artifact_id as string);
    expect(artifactIds).toContain("proj_cited_a");
    expect(artifactIds).toContain("proj_cited_b");
    expect(artifactIds).toContain("synthetic_handle_v1"); // primary action
    expect(artifactIds).toContain("synthetic_verifier_v1"); // primary verifier
    // Cited artifacts' posteriors moved (registered rows).
    const aAfter = getArtifact(db, "proj_cited_a")!;
    const bAfter = getArtifact(db, "proj_cited_b")!;
    expect(aAfter.posteriorAlpha).toBeGreaterThan(aBefore.posteriorAlpha);
    expect(bAfter.posteriorAlpha).toBeGreaterThan(bBefore.posteriorAlpha);
  });

  test("idempotent: re-emitting an action_scored with the same source_act_event_id does not double-emit", async () => {
    const db = openDb(":memory:");
    insertSampleArtifact(db, "idem_cited", "// cited");
    const ap = emitEvent(db, {
      kind: "action_predicted",
      substrate_origin: "substrate_auto",
      directive_id: "d_idem",
      task_id: "t_idem",
      action_artifact_id: "handle_v1",
      verifier_artifact_id: "verifier_v1",
      predicted_residual: 0.2,
      payload: {
        source_act_event_id: "synthetic",
        cited_artifact_ids: ["idem_cited"],
      },
    });
    // First emission.
    emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate_auto",
      directive_id: "d_idem",
      task_id: "t_idem",
      action_artifact_id: "handle_v1",
      verifier_artifact_id: "verifier_v1",
      residual: 0.2,
      payload: { source_act_event_id: ap.id, verifier_kind: "deterministic_code" },
    });
    const firstCount = (db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'act_artifact_score_updated' AND json_extract(payload, '$.artifact_id') = 'idem_cited'")
      .get() as { c: number }).c;
    expect(firstCount).toBe(1);
    // Second emission with the SAME source_act_event_id — the projector
    // must skip via the projection_key idempotency check.
    emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate_auto",
      directive_id: "d_idem",
      task_id: "t_idem",
      action_artifact_id: "handle_v1",
      verifier_artifact_id: "verifier_v1",
      residual: 0.2,
      payload: { source_act_event_id: ap.id, verifier_kind: "deterministic_code" },
    });
    const secondCount = (db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'act_artifact_score_updated' AND json_extract(payload, '$.artifact_id') = 'idem_cited'")
      .get() as { c: number }).c;
    expect(secondCount).toBe(1); // no new row
  });

  test("action_scored with NO source_act_event_id is a safe no-op (no projector emit)", () => {
    const db = openDb(":memory:");
    insertSampleArtifact(db, "noop_handle", "// handle");
    const beforeCount = (db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'act_artifact_score_updated' AND json_extract(payload, '$.projected_from') = 'action_scored_universal_projector'")
      .get() as { c: number }).c;
    emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate_auto",
      directive_id: "d_noop",
      task_id: "t_noop",
      action_artifact_id: "noop_handle",
      verifier_artifact_id: "noop_verifier",
      residual: 0.5,
      payload: { verifier_kind: "deterministic_code" }, // no source_act_event_id
    });
    const afterCount = (db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'act_artifact_score_updated' AND json_extract(payload, '$.projected_from') = 'action_scored_universal_projector'")
      .get() as { c: number }).c;
    expect(afterCount).toBe(beforeCount); // no new universal-projector rows
  });

  test("action_scored with source_act_event_id pointing at non-existent event emits projection_error and no credit", () => {
    const db = openDb(":memory:");
    insertSampleArtifact(db, "err_handle", "// handle");
    emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate_auto",
      directive_id: "d_err",
      task_id: "t_err",
      action_artifact_id: "err_handle",
      verifier_artifact_id: "err_verifier",
      residual: 0.5,
      payload: {
        source_act_event_id: "does_not_exist_eventid",
        verifier_kind: "deterministic_code",
      },
    });
    const err = db
      .query<{ payload: string }, []>(
        "SELECT payload FROM events WHERE kind = 'projection_error' AND json_extract(payload, '$.where') = 'projectActionScoredToCredit'",
      )
      .get();
    expect(err).not.toBeNull();
    const errPayload = JSON.parse(err!.payload) as Record<string, unknown>;
    expect(errPayload.reason).toBe("source_act_event_id_unresolvable");
    // No projector-credit rows landed.
    const creditRows = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'act_artifact_score_updated' AND json_extract(payload, '$.projected_from') = 'action_scored_universal_projector'")
      .get() as { c: number };
    expect(creditRows.c).toBe(0);
  });

  test("recursion guard: action_scored stamped with projected_from='distribute_credit' is skipped", () => {
    const db = openDb(":memory:");
    insertSampleArtifact(db, "rec_cited", "// cited");
    const ap = emitEvent(db, {
      kind: "action_predicted",
      substrate_origin: "substrate_auto",
      directive_id: "d_rec",
      task_id: "t_rec",
      action_artifact_id: "rec_handle",
      verifier_artifact_id: "rec_verifier",
      predicted_residual: 0.2,
      payload: { cited_artifact_ids: ["rec_cited"] },
    });
    emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate_auto",
      directive_id: "d_rec",
      task_id: "t_rec",
      action_artifact_id: "rec_handle",
      verifier_artifact_id: "rec_verifier",
      residual: 0.2,
      payload: {
        source_act_event_id: ap.id,
        projected_from: "distribute_credit", // recursion guard
      },
    });
    const projectorRows = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'act_artifact_score_updated' AND json_extract(payload, '$.projected_from') = 'action_scored_universal_projector'")
      .get() as { c: number };
    expect(projectorRows.c).toBe(0); // projector did NOT fire
  });
});
