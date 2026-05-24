// acc2 credit pipeline tests — Shapley distribution + per-entity posterior
// updates + event emission (Architecture.md Rule 3, §17 Phase H).

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import { insertArtifact, getArtifact } from "./artifact_store";
import {
  distributeCredit,
  distributeOwnerObservedOutcomeCredit,
  shapleyWeightsByCorroboration,
  projectActionScoredToCredit,
  __extractBodyCitationsForTest,
  __collectCitationsForTest,
  __residualToBetaDeltasForTest,
  __brainAccuracyArtifactIdForTest,
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
  // Fabricated-residual honesty (directive BGXWQF2TH97973H5VJ17HF9KSC):
  // a withheld/unmeasured residual is NOT an outcome observation. It must
  // map to zero evidence — distinguishable from residual=0 (max success)
  // and residual=1 (max failure). No posterior movement, no div-by-zero.
  test("withheld (null/undefined/NaN): zero evidence — distinct from residual=0", () => {
    for (const v of [null, undefined, NaN, Number.POSITIVE_INFINITY]) {
      const d = __residualToBetaDeltasForTest(v as unknown as number);
      expect(d.alphaDelta).toBe(0);
      expect(d.betaDelta).toBe(0);
    }
    // residual=0 (measured perfect) must still be max alpha — proving the
    // withheld branch is NOT collapsing a measured zero into no-evidence.
    const measuredZero = __residualToBetaDeltasForTest(0);
    expect(measuredZero.alphaDelta).toBeCloseTo(1, 6);
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
    // T0.3 citation binding enforcement (2026-05-20): the act_tuple
    // projection also emits a retrieval_binding which fires the
    // bind_citation hook, producing a second candidate_confirmed row
    // stamped projected_from="bind_citation". Filter those out to
    // verify distributeCredit's projection-keyed idempotency still
    // produces exactly one act-driven confirmation.
    const confirmations = db.query("SELECT payload FROM events WHERE kind = 'candidate_confirmed' AND json_extract(payload, '$.knowledge_id') = ? AND (json_extract(payload, '$.projected_from') IS NULL OR json_extract(payload, '$.projected_from') != 'bind_citation')").all(knowledge.id) as Array<{ payload: string }>;
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

  // Fabricated-residual honesty (directive BGXWQF2TH97973H5VJ17HF9KSC):
  // when the source act withheld its residual (apply --record with no
  // explicit --residual), the universal projector must NOT move artifact
  // posteriors to max-success. Real credit binds later via closure.
  test("withheld source act: zero posterior movement (no fabricated max-success credit)", async () => {
    const db = openDb(":memory:");
    insertSampleArtifact(db, "withheld_cited", "// cited");
    // Source act_tuple_recorded carrying residual_withheld=true in payload —
    // this is what an apply --record with no --residual emits.
    const ap = emitEvent(db, {
      kind: "action_predicted",
      substrate_origin: "substrate_auto",
      directive_id: "d_withheld",
      task_id: "t_withheld",
      action_artifact_id: "wh_handle_v1",
      verifier_artifact_id: "wh_verifier_v1",
      predicted_residual: 0.2,
      payload: {
        source_act_event_id: "synthetic_withheld",
        cited_artifact_ids: ["withheld_cited"],
        residual_withheld: true,
        residual_provenance: "withheld_until_closure",
      },
    });
    const before = getArtifact(db, "withheld_cited")!;
    // action_scored points source_act_event_id at the withheld source act.
    emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate_auto",
      directive_id: "d_withheld",
      task_id: "t_withheld",
      action_artifact_id: "wh_handle_v1",
      verifier_artifact_id: "wh_verifier_v1",
      // residual placeholder 0.5 (the apply.ts neutral) — NOT 0. The
      // projected action_scored row does NOT carry residual_withheld
      // (it is not in NormalizedActTuple), so the load-bearing guard is
      // the dense-pass sourceAct lookup on source_act_event_id.
      residual: 0.5,
      payload: {
        source_act_event_id: ap.id,
        verifier_kind: "claude_apply_record",
      },
    });
    const after = getArtifact(db, "withheld_cited")!;
    // Withheld → NO posterior movement at all (neither alpha nor beta).
    expect(after.posteriorAlpha).toBe(before.posteriorAlpha);
    expect(after.posteriorBeta).toBe(before.posteriorBeta);
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

  test("action_scored with NO source_act_event_id still credits primary action + verifier artifacts", () => {
    const db = openDb(":memory:");
    insertSampleArtifact(db, "noop_handle", "// handle");
    insertSampleArtifact(db, "noop_verifier", "// verifier");
    const actionBefore = getArtifact(db, "noop_handle")!;
    const verifierBefore = getArtifact(db, "noop_verifier")!;
    emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate_auto",
      directive_id: "d_noop",
      task_id: "t_noop",
      action_artifact_id: "noop_handle",
      verifier_artifact_id: "noop_verifier",
      residual: 0.0,
      payload: { verifier_kind: "deterministic_code" }, // no source_act_event_id
    });
    const updates = db
      .query<{ payload: string }, []>(
        "SELECT payload FROM events WHERE kind = 'act_artifact_score_updated' AND json_extract(payload, '$.projected_from') = 'action_scored_universal_projector'",
      )
      .all()
      .map((r) => JSON.parse(r.payload).artifact_id as string);
    expect(updates).toContain("noop_handle");
    expect(updates).toContain("noop_verifier");
    expect(getArtifact(db, "noop_handle")!.posteriorAlpha).toBeGreaterThan(actionBefore.posteriorAlpha);
    expect(getArtifact(db, "noop_verifier")!.posteriorAlpha).toBeGreaterThan(verifierBefore.posteriorAlpha);
  });

  test("action_scored with source_act_event_id pointing at non-existent event emits projection_error AND still credits primary artifacts", () => {
    const db = openDb(":memory:");
    insertSampleArtifact(db, "err_handle", "// handle");
    insertSampleArtifact(db, "err_verifier", "// verifier");
    const actionBefore = getArtifact(db, "err_handle")!;
    const verifierBefore = getArtifact(db, "err_verifier")!;
    emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate_auto",
      directive_id: "d_err",
      task_id: "t_err",
      action_artifact_id: "err_handle",
      verifier_artifact_id: "err_verifier",
      residual: 0.0,
      payload: {
        source_act_event_id: "does_not_exist_eventid",
        verifier_kind: "deterministic_code",
      },
    });
    // The dangling source reference is still surfaced as an audit signal.
    const err = db
      .query<{ payload: string }, []>(
        "SELECT payload FROM events WHERE kind = 'projection_error' AND json_extract(payload, '$.where') = 'projectActionScoredToCredit'",
      )
      .get();
    expect(err).not.toBeNull();
    const errPayload = JSON.parse(err!.payload) as Record<string, unknown>;
    expect(errPayload.reason).toBe("source_act_event_id_unresolvable");
    // BUT primary credit must NOT be gated by source lineage: both the action
    // and verifier artifacts' posteriors move, and projector credit rows land.
    const updates = db
      .query<{ payload: string }, []>(
        "SELECT payload FROM events WHERE kind = 'act_artifact_score_updated' AND json_extract(payload, '$.projected_from') = 'action_scored_universal_projector'",
      )
      .all()
      .map((r) => JSON.parse(r.payload).artifact_id as string);
    expect(updates).toContain("err_handle");
    expect(updates).toContain("err_verifier");
    expect(getArtifact(db, "err_handle")!.posteriorAlpha).toBeGreaterThan(actionBefore.posteriorAlpha);
    expect(getArtifact(db, "err_verifier")!.posteriorAlpha).toBeGreaterThan(verifierBefore.posteriorAlpha);
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

// T0.3 — citation binding enforcement at emitEvent boundary. Symmetric
// to T0.2: every retrieval_binding emit immediately credits the cited
// knowledge row via candidate_confirmed{projected_from=bind_citation,
// weight=BINDING_WEIGHT}. Decorative citations land as retrieval_rejected.
// Idempotent via projection_key retrieval_binding_credit:{event_id}.
describe("bindCitation — citation binding enforcement at emitEvent boundary (T0.3)", () => {
  test("emits candidate_confirmed with weight=BINDING_WEIGHT when retrieval_binding cites a knowledge_candidate", () => {
    const db = openDb(":memory:");
    // Seed a knowledge_candidate to be cited.
    const kc = emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "claude_root",
      payload: { text: "seed candidate for binding credit" },
    });
    // Emit a retrieval_binding citing it via source_event_id (the
    // canonical payload shape in production — see 7158/7186 live rows).
    const binding = emitEvent(db, {
      kind: "retrieval_binding",
      substrate_origin: "substrate_auto",
      directive_id: "d_bind_1",
      task_id: "t_bind_1",
      context_refs: [kc.id],
      payload: {
        query: "test",
        source_event_id: kc.id,
        binding_surface: "search",
      },
    });
    // The post-write hook should have emitted a candidate_confirmed
    // stamped projected_from="bind_citation" carrying weight=0.1.
    const confirmed = db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM events WHERE kind = 'candidate_confirmed' AND json_extract(payload, '$.retrieval_binding_event_id') = ? LIMIT 1",
      )
      .get(binding.id);
    expect(confirmed).not.toBeNull();
    const payload = JSON.parse(confirmed!.payload) as Record<string, unknown>;
    expect(payload.knowledge_id).toBe(kc.id);
    expect(payload.weight).toBe(0.1);
    expect(payload.projected_from).toBe("bind_citation");
    expect(payload.projection_key).toBe("retrieval_binding_credit:" + binding.id);
  });

  test("posterior moves: maybePromoteKnowledge sees fractional wins from binding credit", async () => {
    const { maybePromoteKnowledge } = await import("../substrate/extractors");
    const db = openDb(":memory:");
    const kc = emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "claude_root",
      payload: { text: "candidate posterior probe" },
    });
    const beforeVerdict = maybePromoteKnowledge(db, kc.id);
    expect(beforeVerdict.kind).toBe("no_action");
    expect(beforeVerdict.score).toBe(0.5); // alpha=1, beta=1 → 0.5

    // Emit ONE retrieval_binding — should add 0.1 wins.
    emitEvent(db, {
      kind: "retrieval_binding",
      substrate_origin: "substrate_auto",
      directive_id: "d_post",
      task_id: "t_post",
      context_refs: [kc.id],
      payload: { query: "q", source_event_id: kc.id, binding_surface: "prompt" },
    });
    const afterOne = maybePromoteKnowledge(db, kc.id);
    // Posterior moved: alpha = 1 + 0.1 = 1.1, beta = 1 → score ≈ 0.524
    expect(afterOne.score).toBeGreaterThan(beforeVerdict.score);
    expect(afterOne.score).toBeLessThan(0.6); // still well under promote threshold
    expect(afterOne.kind).toBe("no_action"); // 0.1 wins << 5 threshold
  });

  test("four-link: binding that cites a knowledge_promoted id credits the underlying candidate posterior", async () => {
    // Production retrieval cites whatever the index returned. For promoted
    // knowledge that is the knowledge_promoted EVENT id, not the candidate
    // id. The bulk Beta-posterior recompute keys wins by candidate id, so a
    // candidate_confirmed citing only the promoted id would never move the
    // posterior (decorative memory, k_554). bindCitation must resolve
    // promoted -> candidate_id and cite the candidate.
    const { extractKnowledgePromotions } = await import("../substrate/extractors");
    const db = openDb(":memory:");
    const kc = emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "claude_root",
      payload: { text: "promoted-id binding probe" },
    });
    // A knowledge_promoted row whose payload.candidate_id points at kc.
    const promoted = emitEvent(db, {
      kind: "knowledge_promoted",
      substrate_origin: "substrate_auto",
      payload: { candidate_id: kc.id, score: 0.9, wins: 5, losses: 0 },
    });
    // Retrieval binds the PROMOTED id (what the index returns).
    const binding = emitEvent(db, {
      kind: "retrieval_binding",
      substrate_origin: "substrate_auto",
      directive_id: "d_pid",
      task_id: "t_pid",
      context_refs: [promoted.id],
      payload: { source_event_id: promoted.id, binding_surface: "prompt" },
    });
    // The candidate_confirmed must cite the candidate id so the recompute
    // lands on it.
    const confirmed = db
      .query<{ payload: string; context_refs: string }, [string]>(
        "SELECT payload, context_refs FROM events WHERE kind = 'candidate_confirmed' AND json_extract(payload, '$.retrieval_binding_event_id') = ? LIMIT 1",
      )
      .get(binding.id);
    expect(confirmed).not.toBeNull();
    const payload = JSON.parse(confirmed!.payload) as Record<string, unknown>;
    expect(payload.knowledge_id).toBe(kc.id);
    expect(payload.candidate_id).toBe(kc.id);
    expect(payload.cited_event_id).toBe(promoted.id);
    const refs = JSON.parse(confirmed!.context_refs) as string[];
    expect(refs).toContain(kc.id);
    // The bulk extractor's candidate-keyed recompute now actually credits kc.
    const before = (db.query<{ a: number }, []>("SELECT IFNULL(MAX(rowid),0) AS a FROM events").get() as { a: number }).a;
    void before;
    extractKnowledgePromotions(db);
    // Posterior recompute: kc accumulated 0.1 fractional wins -> the
    // candidate_confirmed contributed to winsByCandidate keyed by kc.id.
    // We assert the win landed by checking the candidate is creditable: a
    // second identical binding (new id) crosses no threshold but the
    // recompute must see >0 wins. Probe via maybePromoteKnowledge which
    // shares the same candidate-keyed scan.
    const { maybePromoteKnowledge } = await import("../substrate/extractors");
    const verdict = maybePromoteKnowledge(db, kc.id);
    expect(verdict.score).toBeGreaterThan(0.5); // alpha=1+0.1 -> >0.5
  });

  test("idempotent: re-emitting the same retrieval_binding does NOT double-credit", () => {
    const db = openDb(":memory:");
    const kc = emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "claude_root",
      payload: { text: "idempotency probe" },
    });
    const binding = emitEvent(db, {
      kind: "retrieval_binding",
      substrate_origin: "substrate_auto",
      directive_id: "d_idem",
      task_id: "t_idem",
      context_refs: [kc.id],
      payload: { source_event_id: kc.id, binding_surface: "search" },
    });
    const firstCount = (db
      .query<{ c: number }, [string]>(
        "SELECT COUNT(*) AS c FROM events WHERE kind = 'candidate_confirmed' AND json_extract(payload, '$.retrieval_binding_event_id') = ?",
      )
      .get(binding.id) as { c: number }).c;
    expect(firstCount).toBe(1);
    // Directly invoke bindCitation again on the same row — should be a no-op.
    // (Re-emitting a retrieval_binding through emitEvent would mint a new
    // event_id and credit it independently; the idempotency guard is on
    // projection_key = retrieval_binding_credit:{event_id}, which only
    // fires for the SAME binding_event_id.)
    const { bindCitation } = require("./credit") as typeof import("./credit");
    bindCitation(db, {
      id: binding.id,
      payload: JSON.stringify({ source_event_id: kc.id, binding_surface: "search" }),
      directive_id: "d_idem",
      task_id: "t_idem",
    });
    const secondCount = (db
      .query<{ c: number }, [string]>(
        "SELECT COUNT(*) AS c FROM events WHERE kind = 'candidate_confirmed' AND json_extract(payload, '$.retrieval_binding_event_id') = ?",
      )
      .get(binding.id) as { c: number }).c;
    expect(secondCount).toBe(1); // no double-emit
  });

  test("decorative citation (unresolvable cited id) emits retrieval_rejected, no candidate_confirmed", () => {
    const db = openDb(":memory:");
    const binding = emitEvent(db, {
      kind: "retrieval_binding",
      substrate_origin: "substrate_auto",
      directive_id: "d_dec",
      task_id: "t_dec",
      payload: {
        source_event_id: "does_not_exist_eventid",
        binding_surface: "search",
      },
    });
    // No candidate_confirmed should have landed for this binding.
    const confirmedRows = db
      .query<{ c: number }, [string]>(
        "SELECT COUNT(*) AS c FROM events WHERE kind = 'candidate_confirmed' AND json_extract(payload, '$.retrieval_binding_event_id') = ?",
      )
      .get(binding.id) as { c: number };
    expect(confirmedRows.c).toBe(0);
    // A retrieval_rejected row should have landed instead, citing the
    // binding event and stamping the projection_key for idempotency.
    const rejected = db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM events WHERE kind = 'retrieval_rejected' AND json_extract(payload, '$.retrieval_binding_event_id') = ? LIMIT 1",
      )
      .get(binding.id);
    expect(rejected).not.toBeNull();
    const rejPayload = JSON.parse(rejected!.payload) as Record<string, unknown>;
    expect(rejPayload.reason).toBe("cited_knowledge_id_unresolvable");
    expect(rejPayload.rejected_by).toBe("bind_citation_hook");
    expect(rejPayload.projected_from).toBe("bind_citation");
    expect(rejPayload.projection_key).toBe("retrieval_binding_credit:" + binding.id);
  });

  test("recursion guard: retrieval_binding stamped projected_from='bind_citation' does NOT re-credit", () => {
    const db = openDb(":memory:");
    const kc = emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "claude_root",
      payload: { text: "recursion probe" },
    });
    // Emit a retrieval_binding pre-stamped with the recursion guard.
    const binding = emitEvent(db, {
      kind: "retrieval_binding",
      substrate_origin: "substrate_auto",
      directive_id: "d_rec",
      task_id: "t_rec",
      context_refs: [kc.id],
      payload: {
        source_event_id: kc.id,
        binding_surface: "search",
        projected_from: "bind_citation",
      },
    });
    // The hook should skip — no candidate_confirmed row for this binding.
    const rows = db
      .query<{ c: number }, [string]>(
        "SELECT COUNT(*) AS c FROM events WHERE kind = 'candidate_confirmed' AND json_extract(payload, '$.retrieval_binding_event_id') = ?",
      )
      .get(binding.id) as { c: number };
    expect(rows.c).toBe(0);
  });

  test("forward-compat: payload.cited_knowledge_id is preferred over source_event_id when both present", () => {
    const db = openDb(":memory:");
    const kcPreferred = emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "claude_root",
      payload: { text: "preferred via cited_knowledge_id" },
    });
    const kcFallback = emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "claude_root",
      payload: { text: "fallback via source_event_id" },
    });
    const binding = emitEvent(db, {
      kind: "retrieval_binding",
      substrate_origin: "substrate_auto",
      directive_id: "d_fwd",
      task_id: "t_fwd",
      payload: {
        cited_knowledge_id: kcPreferred.id,
        source_event_id: kcFallback.id,
        binding_surface: "search",
      },
    });
    const confirmed = db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM events WHERE kind = 'candidate_confirmed' AND json_extract(payload, '$.retrieval_binding_event_id') = ? LIMIT 1",
      )
      .get(binding.id);
    expect(confirmed).not.toBeNull();
    const payload = JSON.parse(confirmed!.payload) as Record<string, unknown>;
    expect(payload.knowledge_id).toBe(kcPreferred.id); // not kcFallback
  });
});

// T4.2 meta-credit (roadmap.md §T4.2) — when distributeCredit projects an
// outcome, the COMPOSER policy bundle (artifact selected at compose time
// by prompt_policy_section_selected) accrues posterior. The selector
// behind the selection is now first-class.
describe("T4.2 meta-credit — composer policy bundle gets credit", () => {
  test("prompt_policy_section_selected on the same task moves the bundle's posterior on action_scored", async () => {
    const db = openDb(":memory:");
    insertSampleArtifact(db, "art_action", "// action body");
    insertSampleArtifact(db, "art_verifier", "// verifier body");
    // Seed the policy bundle act_artifact that the composer "selected".
    const bundleBefore = insertSampleArtifact(db, "art_policy_bundle_alpha", "// policy bundle alpha");
    expect(bundleBefore.posteriorAlpha).toBe(1);
    expect(bundleBefore.posteriorBeta).toBe(1);

    // Emit a prompt_policy_section_selected pointing at the bundle on the
    // same task that the action_predicted/scored will land under.
    emitEvent(db, {
      kind: "prompt_policy_section_selected",
      substrate_origin: "substrate_auto",
      directive_id: "d_meta",
      task_id: "t_meta",
      payload: {
        section_name: "owner_rendering_policy",
        source: "policy_bundle",
        artifact_id: "art_policy_bundle_alpha",
        score: 0.7,
        fallback_reason: null,
        variant_score_observed: null,
        competitor_score_observed: null,
      },
    });

    const ap = emitEvent(db, {
      kind: "action_predicted",
      substrate_origin: "opencode",
      directive_id: "d_meta",
      task_id: "t_meta",
      action_artifact_id: "art_action",
      verifier_artifact_id: "art_verifier",
      predicted_residual: 0.0,
      payload: {},
    });
    const obs = emitEvent(db, {
      kind: "artifact_observed",
      substrate_origin: "substrate_auto",
      directive_id: "d_meta",
      task_id: "t_meta",
      action_artifact_id: "art_action",
      payload: {},
    });
    const scored = emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate_auto",
      directive_id: "d_meta",
      task_id: "t_meta",
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

    // Bundle posterior moved (alpha > 1 from a successful residual=0 outcome).
    const bundleAfter = getArtifact(db, "art_policy_bundle_alpha")!;
    expect(bundleAfter.posteriorAlpha).toBeGreaterThan(1);

    // A meta_credit_projected audit row fired for the bundle.
    const metaRow = db
      .query<{ payload: string }, []>(
        "SELECT payload FROM events WHERE kind = 'meta_credit_projected' LIMIT 1",
      )
      .get();
    expect(metaRow).not.toBeNull();
    const metaPayload = JSON.parse(metaRow!.payload) as Record<string, unknown>;
    expect(metaPayload.bundle_artifact_id).toBe("art_policy_bundle_alpha");
    expect(metaPayload.section_name).toBe("owner_rendering_policy");
    expect(metaPayload.scored_event_id).toBe(scored.id);
    expect(metaPayload.bundle_registered).toBe(true);
    expect(metaPayload.projection_key).toBe("meta_credit:" + scored.id + ":art_policy_bundle_alpha");

    // act_artifact_score_updated with role=composer_policy fired alongside.
    const compRow = db
      .query<{ payload: string }, []>(
        "SELECT payload FROM events WHERE kind = 'act_artifact_score_updated' AND json_extract(payload, '$.role') = 'composer_policy' LIMIT 1",
      )
      .get();
    expect(compRow).not.toBeNull();
    const compPayload = JSON.parse(compRow!.payload) as Record<string, unknown>;
    expect(compPayload.artifact_id).toBe("art_policy_bundle_alpha");
    expect(compPayload.projected_from).toBe("meta_credit");
  });

  test("idempotent: re-running distributeCredit on the same scored event does NOT re-credit the bundle", async () => {
    const db = openDb(":memory:");
    insertSampleArtifact(db, "art_action", "// action body");
    insertSampleArtifact(db, "art_verifier", "// verifier body");
    insertSampleArtifact(db, "art_policy_bundle_beta", "// policy beta");

    emitEvent(db, {
      kind: "prompt_policy_section_selected",
      substrate_origin: "substrate_auto",
      directive_id: "d_idem",
      task_id: "t_idem",
      payload: {
        section_name: "top_laws",
        source: "policy_bundle",
        artifact_id: "art_policy_bundle_beta",
      },
    });

    const ap = emitEvent(db, {
      kind: "action_predicted",
      substrate_origin: "opencode",
      directive_id: "d_idem",
      task_id: "t_idem",
      action_artifact_id: "art_action",
      verifier_artifact_id: "art_verifier",
      predicted_residual: 0.2,
      payload: {},
    });
    const obs = emitEvent(db, {
      kind: "artifact_observed",
      substrate_origin: "substrate_auto",
      directive_id: "d_idem",
      task_id: "t_idem",
      action_artifact_id: "art_action",
      payload: {},
    });
    const scored = emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate_auto",
      directive_id: "d_idem",
      task_id: "t_idem",
      action_artifact_id: "art_action",
      verifier_artifact_id: "art_verifier",
      residual: 0,
      payload: {},
    });

    await distributeCredit(db, {
      action_event_id: ap.id,
      observation_event_id: obs.id,
      scored_event_id: scored.id,
      predicted_residual: 0.2,
      observed_residual: 0,
    });
    await distributeCredit(db, {
      action_event_id: ap.id,
      observation_event_id: obs.id,
      scored_event_id: scored.id,
      predicted_residual: 0.2,
      observed_residual: 0,
    });

    const rows = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'meta_credit_projected'")
      .get() as { c: number };
    expect(rows.c).toBe(1);
  });
});

// T4.3 brain prediction-accuracy posterior (roadmap.md §T4.3) — for every
// brain action_predicted/scored pair, emit brain_accuracy_observation
// with prediction_error = |predicted − observed| and update the per-
// goal_shape brain_accuracy_predicate posterior.
describe("T4.3 brain accuracy — predicted vs observed residual posterior", () => {
  test("brain_accuracy_observation fires with prediction_error = |predicted − observed|", async () => {
    const db = openDb(":memory:");
    insertSampleArtifact(db, "art_action", "// action body");
    insertSampleArtifact(db, "art_verifier", "// verifier body");

    const ap = emitEvent(db, {
      kind: "action_predicted",
      substrate_origin: "opencode", // brain
      directive_id: "d_bacc",
      task_id: "t_bacc",
      action_artifact_id: "art_action",
      verifier_artifact_id: "art_verifier",
      predicted_residual: 0.2,
      payload: {},
    });
    const obs = emitEvent(db, {
      kind: "artifact_observed",
      substrate_origin: "substrate_auto",
      directive_id: "d_bacc",
      task_id: "t_bacc",
      action_artifact_id: "art_action",
      payload: {},
    });
    const scored = emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate_auto",
      directive_id: "d_bacc",
      task_id: "t_bacc",
      action_artifact_id: "art_action",
      verifier_artifact_id: "art_verifier",
      residual: 0.4,
      payload: {},
    });

    await distributeCredit(db, {
      action_event_id: ap.id,
      observation_event_id: obs.id,
      scored_event_id: scored.id,
      predicted_residual: 0.2,
      observed_residual: 0.4,
    });

    const obsRow = db
      .query<{ payload: string }, []>(
        "SELECT payload FROM events WHERE kind = 'brain_accuracy_observation' LIMIT 1",
      )
      .get();
    expect(obsRow).not.toBeNull();
    const payload = JSON.parse(obsRow!.payload) as Record<string, unknown>;
    expect(payload.predicted_residual).toBeCloseTo(0.2, 6);
    expect(payload.observed_residual).toBeCloseTo(0.4, 6);
    expect(payload.prediction_error).toBeCloseTo(0.2, 6);
    expect(payload.action_predicted_event_id).toBe(ap.id);
    expect(payload.action_scored_event_id).toBe(scored.id);

    // The per-goal_shape brain_accuracy_predicate artifact was created and
    // its posterior moved.
    const accId = __brainAccuracyArtifactIdForTest("");
    const accArt = getArtifact(db, accId)!;
    expect(accArt).not.toBeNull();
    // prediction_error = 0.2 — well within the success band (≤0.3) so alpha > 1.
    expect(accArt.posteriorAlpha).toBeGreaterThan(1);
  });

  test("does NOT fire when action_predicted.substrate_origin is not the brain (opencode)", async () => {
    const db = openDb(":memory:");
    insertSampleArtifact(db, "art_action", "// action body");
    insertSampleArtifact(db, "art_verifier", "// verifier body");
    const ap = emitEvent(db, {
      kind: "action_predicted",
      substrate_origin: "substrate_auto", // NOT the brain
      directive_id: "d_nob",
      task_id: "t_nob",
      action_artifact_id: "art_action",
      verifier_artifact_id: "art_verifier",
      predicted_residual: 0.4,
      payload: {},
    });
    const obs = emitEvent(db, {
      kind: "artifact_observed",
      substrate_origin: "substrate_auto",
      directive_id: "d_nob",
      task_id: "t_nob",
      action_artifact_id: "art_action",
      payload: {},
    });
    const scored = emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate_auto",
      directive_id: "d_nob",
      task_id: "t_nob",
      action_artifact_id: "art_action",
      verifier_artifact_id: "art_verifier",
      residual: 0.4,
      payload: { verifier_kind: "peer_llm_claude" },
    });
    await distributeCredit(db, {
      action_event_id: ap.id,
      observation_event_id: obs.id,
      scored_event_id: scored.id,
      predicted_residual: 0.4,
      observed_residual: 0.4,
    });
    const rows = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'brain_accuracy_observation'")
      .get() as { c: number };
    expect(rows.c).toBe(0);
  });

  test("brain_accuracy_observation fires for peer-origin action_predicted", async () => {
    const db = openDb(":memory:");
    insertSampleArtifact(db, "art_action", "// action body");
    insertSampleArtifact(db, "art_verifier", "// verifier body");
    const ap = emitEvent(db, {
      kind: "action_predicted",
      substrate_origin: "peer_llm_claude",
      directive_id: "d_peer_bacc",
      task_id: "t_peer_bacc",
      action_artifact_id: "art_action",
      verifier_artifact_id: "art_verifier",
      predicted_residual: 0.25,
      payload: {},
    });
    const obs = emitEvent(db, {
      kind: "artifact_observed",
      substrate_origin: "substrate_auto",
      directive_id: "d_peer_bacc",
      task_id: "t_peer_bacc",
      action_artifact_id: "art_action",
      payload: {},
    });
    const scored = emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate_auto",
      directive_id: "d_peer_bacc",
      task_id: "t_peer_bacc",
      action_artifact_id: "art_action",
      verifier_artifact_id: "art_verifier",
      residual: 0.3,
      payload: {},
    });
    await distributeCredit(db, {
      action_event_id: ap.id,
      observation_event_id: obs.id,
      scored_event_id: scored.id,
      predicted_residual: 0.25,
      observed_residual: 0.3,
    });
    const rows = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'brain_accuracy_observation'")
      .get() as { c: number };
    expect(rows.c).toBe(1);
  });

  test("idempotent: re-running distributeCredit on the same pair does NOT emit a second observation", async () => {
    const db = openDb(":memory:");
    insertSampleArtifact(db, "art_action", "// action body");
    insertSampleArtifact(db, "art_verifier", "// verifier body");
    const ap = emitEvent(db, {
      kind: "action_predicted",
      substrate_origin: "opencode",
      directive_id: "d_bidem",
      task_id: "t_bidem",
      action_artifact_id: "art_action",
      verifier_artifact_id: "art_verifier",
      predicted_residual: 0.1,
      payload: {},
    });
    const obs = emitEvent(db, {
      kind: "artifact_observed",
      substrate_origin: "substrate_auto",
      directive_id: "d_bidem",
      task_id: "t_bidem",
      action_artifact_id: "art_action",
      payload: {},
    });
    const scored = emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate_auto",
      directive_id: "d_bidem",
      task_id: "t_bidem",
      action_artifact_id: "art_action",
      verifier_artifact_id: "art_verifier",
      residual: 0.1,
      payload: {},
    });
    await distributeCredit(db, {
      action_event_id: ap.id,
      observation_event_id: obs.id,
      scored_event_id: scored.id,
      predicted_residual: 0.1,
      observed_residual: 0.1,
    });
    await distributeCredit(db, {
      action_event_id: ap.id,
      observation_event_id: obs.id,
      scored_event_id: scored.id,
      predicted_residual: 0.1,
      observed_residual: 0.1,
    });
    const rows = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'brain_accuracy_observation'")
      .get() as { c: number };
    expect(rows.c).toBe(1);
  });
});

// T4.4 coalition / joint-citation posterior (roadmap.md §T4.4) — when
// the brain's action_predicted cited N>1 cooperating artifacts, emit a
// coalition_credit_distributed audit row carrying the sorted-member
// coalition id + per-member shapley shares + observed residual.
describe("T4.4 coalition credit — multi-artifact joint citation posterior", () => {
  test("N=3 cited artifacts emit coalition_credit_distributed with shapley shares matching shapleyWeightsByCorroboration(3)", async () => {
    const db = openDb(":memory:");
    insertSampleArtifact(db, "art_action", "// action body");
    insertSampleArtifact(db, "art_verifier", "// verifier body");
    insertSampleArtifact(db, "art_co_a", "// co a");
    insertSampleArtifact(db, "art_co_b", "// co b");
    insertSampleArtifact(db, "art_co_c", "// co c");

    const ap = emitEvent(db, {
      kind: "action_predicted",
      substrate_origin: "opencode",
      directive_id: "d_coal",
      task_id: "t_coal",
      action_artifact_id: "art_action",
      verifier_artifact_id: "art_verifier",
      predicted_residual: 0,
      payload: { cited_artifact_ids: ["art_co_a", "art_co_b", "art_co_c"] },
    });
    const obs = emitEvent(db, {
      kind: "artifact_observed",
      substrate_origin: "substrate_auto",
      directive_id: "d_coal",
      task_id: "t_coal",
      action_artifact_id: "art_action",
      payload: {},
    });
    const scored = emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate_auto",
      directive_id: "d_coal",
      task_id: "t_coal",
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

    const coalRow = db
      .query<{ payload: string }, []>(
        "SELECT payload FROM events WHERE kind = 'coalition_credit_distributed' LIMIT 1",
      )
      .get();
    expect(coalRow).not.toBeNull();
    const payload = JSON.parse(coalRow!.payload) as {
      coalition_id: string;
      sorted_member_ids: string[];
      ordered_member_ids: string[];
      member_count: number;
      residual: number;
      member_shares: Array<{ artifact_id: string; shapley_share: number }>;
    };
    expect(payload.member_count).toBe(3);
    expect(payload.coalition_id).toBe("coalition:art_co_a+art_co_b+art_co_c");
    expect(payload.sorted_member_ids).toEqual(["art_co_a", "art_co_b", "art_co_c"]);
    expect(payload.ordered_member_ids).toEqual(["art_co_a", "art_co_b", "art_co_c"]);
    expect(payload.residual).toBeCloseTo(0, 6);
    // Shares match shapleyWeightsByCorroboration(3) = [4/7, 2/7, 1/7].
    const expected = shapleyWeightsByCorroboration(3);
    expect(payload.member_shares.length).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(payload.member_shares[i]!.artifact_id).toBe(["art_co_a", "art_co_b", "art_co_c"][i]);
      expect(payload.member_shares[i]!.shapley_share).toBeCloseTo(expected[i]!, 6);
    }
    // Shares sum to 1.0.
    const sum = payload.member_shares.reduce((a, m) => a + m.shapley_share, 0);
    expect(sum).toBeCloseTo(1.0, 6);
  });

  test("N=1 cited artifact emits NO coalition row (no coalition — single node)", async () => {
    const db = openDb(":memory:");
    insertSampleArtifact(db, "art_action", "// action");
    insertSampleArtifact(db, "art_verifier", "// verifier");
    insertSampleArtifact(db, "art_solo", "// solo");
    const ap = emitEvent(db, {
      kind: "action_predicted",
      substrate_origin: "opencode",
      directive_id: "d_solo",
      task_id: "t_solo",
      action_artifact_id: "art_action",
      verifier_artifact_id: "art_verifier",
      predicted_residual: 0,
      payload: { cited_artifact_ids: ["art_solo"] },
    });
    const obs = emitEvent(db, {
      kind: "artifact_observed",
      substrate_origin: "substrate_auto",
      directive_id: "d_solo",
      task_id: "t_solo",
      action_artifact_id: "art_action",
      payload: {},
    });
    const scored = emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate_auto",
      directive_id: "d_solo",
      task_id: "t_solo",
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
    const rows = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'coalition_credit_distributed'")
      .get() as { c: number };
    expect(rows.c).toBe(0);
  });

  test("action_scored write-boundary emits Tier-4 meta and coalition rows idempotently", async () => {
    const db = openDb(":memory:");
    insertSampleArtifact(db, "art_action", "// action");
    insertSampleArtifact(db, "art_verifier", "// verifier");
    insertSampleArtifact(db, "art_policy_bundle_gamma", "// policy bundle gamma");
    insertSampleArtifact(db, "art_co_a", "// co a");
    insertSampleArtifact(db, "art_co_b", "// co b");

    emitEvent(db, {
      kind: "task_node_opened",
      substrate_origin: "opencode",
      directive_id: "d_universal_t4",
      task_id: "t_universal_parent",
      payload: { goal: "compose policy" },
    });
    emitEvent(db, {
      kind: "task_node_opened",
      substrate_origin: "opencode",
      directive_id: "d_universal_t4",
      task_id: "t_universal_t4",
      parent_task_id: "t_universal_parent",
      payload: { goal: "score child action" },
    });
    emitEvent(db, {
      kind: "task_edge_recorded",
      substrate_origin: "opencode",
      directive_id: "d_universal_t4",
      task_id: "t_universal_t4",
      payload: { kind: "refines", from_task: "t_universal_parent", to_task: "t_universal_t4" },
    });
    emitEvent(db, {
      kind: "prompt_policy_section_selected",
      substrate_origin: "substrate_auto",
      directive_id: "d_universal_t4",
      task_id: "t_universal_parent",
      payload: {
        section_name: "workflow",
        source: "policy_bundle",
        artifact_id: "art_policy_bundle_gamma",
      },
    });
    const ap = emitEvent(db, {
      kind: "action_predicted",
      substrate_origin: "opencode",
      directive_id: "d_universal_t4",
      task_id: "t_universal_t4",
      action_artifact_id: "art_action",
      verifier_artifact_id: "art_verifier",
      predicted_residual: 0.1,
      payload: { cited_artifact_ids: ["art_co_a", "art_co_b"] },
    });
    const scored = emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate_auto",
      directive_id: "d_universal_t4",
      task_id: "t_universal_t4",
      action_artifact_id: "art_action",
      verifier_artifact_id: "art_verifier",
      residual: 0,
      payload: { action_predicted_event_id: ap.id, residual: 0 },
    });

    const scoredRow = db
      .query<{ payload: string; context_refs: string; residual: number | null; action_artifact_id: string | null; verifier_artifact_id: string | null }, [string]>(
        "SELECT payload, context_refs, residual, action_artifact_id, verifier_artifact_id FROM events WHERE id = ?",
      )
      .get(scored.id)!;
    projectActionScoredToCredit(db, {
      id: scored.id,
      payload: scoredRow.payload,
      context_refs: scoredRow.context_refs,
      directive_id: "d_universal_t4",
      task_id: "t_universal_t4",
      residual: scoredRow.residual,
      action_artifact_id: scoredRow.action_artifact_id,
      verifier_artifact_id: scoredRow.verifier_artifact_id,
    });

    const metaRows = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'meta_credit_projected'")
      .get() as { c: number };
    const coalitionRows = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'coalition_credit_distributed'")
      .get() as { c: number };
    expect(metaRows.c).toBe(1);
    expect(coalitionRows.c).toBe(1);
    expect(getArtifact(db, "art_policy_bundle_gamma")!.posteriorAlpha).toBeGreaterThan(1);

    const metaPayload = JSON.parse((db
      .query("SELECT payload FROM events WHERE kind = 'meta_credit_projected' LIMIT 1")
      .get() as { payload: string }).payload) as Record<string, unknown>;
    const coalitionPayload = JSON.parse((db
      .query("SELECT payload FROM events WHERE kind = 'coalition_credit_distributed' LIMIT 1")
      .get() as { payload: string }).payload) as Record<string, unknown>;
    expect(metaPayload.projection_key).toBe("meta_credit:" + scored.id + ":art_policy_bundle_gamma");
    expect(coalitionPayload.projection_key).toBe("coalition_credit:" + scored.id + ":coalition:art_co_a+art_co_b");
  });

  test("repeated supplemental joint-citation sets emit one coalition row per scored action", async () => {
    const db = openDb(":memory:");
    insertSampleArtifact(db, "art_action", "// action");
    insertSampleArtifact(db, "art_verifier", "// verifier");
    insertSampleArtifact(db, "art_co_a", "// co a");
    insertSampleArtifact(db, "art_co_b", "// co b");

    for (const suffix of ["one", "two"]) {
      const ap = emitEvent(db, {
        kind: "action_predicted",
        substrate_origin: "opencode",
        directive_id: "d_coal_repeat",
        task_id: "t_coal_repeat_" + suffix,
        action_artifact_id: "art_action",
        verifier_artifact_id: "art_verifier",
        predicted_residual: 0.1,
        payload: { cited_artifact_ids: ["art_co_a", "art_co_b"] },
      });
      emitEvent(db, {
        kind: "action_scored",
        substrate_origin: "substrate_auto",
        directive_id: "d_coal_repeat",
        task_id: "t_coal_repeat_" + suffix,
        action_artifact_id: "art_action",
        verifier_artifact_id: "art_verifier",
        residual: 0,
        payload: { action_predicted_event_id: ap.id, residual: 0 },
      });
    }

    const rows = db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM events WHERE kind = 'coalition_credit_distributed'")
      .get()!;
    expect(rows.c).toBe(2);
    const coalitionIds = db
      .query<{ coalition_id: string }, []>("SELECT json_extract(payload, '$.coalition_id') AS coalition_id FROM events WHERE kind = 'coalition_credit_distributed'")
      .all();
    expect(coalitionIds.map((r) => r.coalition_id)).toEqual([
      "coalition:art_co_a+art_co_b",
      "coalition:art_co_a+art_co_b",
    ]);
  });

  test("repeated act-tuple action/verifier joint-citation sets emit coalition rows via action_scored", async () => {
    const db = openDb(":memory:");
    insertSampleArtifact(db, "dispatch_decider_v1", "// dispatch decider");
    insertSampleArtifact(db, "lane_outcome_residual", "// lane verifier");

    for (const suffix of ["one", "two"]) {
      const ap = emitEvent(db, {
        kind: "action_predicted",
        substrate_origin: "substrate_auto",
        directive_id: "d_coal_live_shape",
        task_id: "t_coal_live_shape_" + suffix,
        action_artifact_id: "dispatch_decider_v1",
        verifier_artifact_id: "lane_outcome_residual",
        predicted_residual: 0.4,
        payload: {
          projected_from: "act_tuple_recorded",
          cited_artifact_ids: ["dispatch_decider_v1", "lane_outcome_residual"],
        },
      });
      emitEvent(db, {
        kind: "action_scored",
        substrate_origin: "substrate_auto",
        directive_id: "d_coal_live_shape",
        task_id: "t_coal_live_shape_" + suffix,
        action_artifact_id: "dispatch_decider_v1",
        verifier_artifact_id: "lane_outcome_residual",
        predicted_residual: 0.4,
        residual: 0.2,
        payload: { action_predicted_event_id: ap.id, residual: 0.2 },
      });
    }

    const rows = db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM events WHERE kind = 'coalition_credit_distributed'")
      .get()!;
    expect(rows.c).toBe(2);
    const coalitionIds = db
      .query<{ coalition_id: string }, []>("SELECT json_extract(payload, '$.coalition_id') AS coalition_id FROM events WHERE kind = 'coalition_credit_distributed'")
      .all();
    expect(coalitionIds.map((r) => r.coalition_id)).toEqual([
      "coalition:dispatch_decider_v1+lane_outcome_residual",
      "coalition:dispatch_decider_v1+lane_outcome_residual",
    ]);
  });
});

