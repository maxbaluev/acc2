// Tier-S3 trajectory-motif extractor — proves the bounded extractor
// admits one act_artifact{kind:trajectory_motif_predicate} row per
// frequent n-gram (length ∈ {3,4}, frequency ≥ 3 in 30-day window),
// is idempotent across reruns, computes closure-residual correlation
// for matching tails, and respects the recency window.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { extractTrajectoryMotifs } from "./trajectory_motif_extractor";

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

const insertSequence = (
  db: ReturnType<typeof openDb>,
  directiveId: string,
  kinds: string[],
): void => {
  for (const k of kinds) {
    insertEvent(db, { kind: k, directive_id: directiveId });
  }
};

const countMotifs = (db: ReturnType<typeof openDb>): number =>
  (db
    .query(`SELECT COUNT(*) AS n FROM act_artifact WHERE kind = 'trajectory_motif_predicate'`)
    .get() as { n: number }).n;

const countObservations = (db: ReturnType<typeof openDb>): number =>
  (db
    .query(`SELECT COUNT(*) AS n FROM events WHERE kind = 'trajectory_motif_observed'`)
    .get() as { n: number }).n;

describe("extractTrajectoryMotifs", () => {
  test("three directives producing the same 3-gram admit one motif with frequency=3", async () => {
    const db = openDb(":memory:");
    const seq = ["directive_opened", "task_node_opened", "task_committed"];
    insertSequence(db, "d_one", seq);
    insertSequence(db, "d_two", seq);
    insertSequence(db, "d_three", seq);

    const summary = await extractTrajectoryMotifs(db);
    expect(summary.directives_scanned).toBe(3);
    expect(summary.motifs_admitted).toBeGreaterThanOrEqual(1);
    expect(countMotifs(db)).toBeGreaterThanOrEqual(1);

    const row = db
      .query(
        `SELECT id, name, body FROM act_artifact
          WHERE kind = 'trajectory_motif_predicate'
            AND name = 'directive_opened>task_node_opened>task_committed'`,
      )
      .get() as { id: string; name: string; body: string };
    expect(row).toBeTruthy();
    const body = JSON.parse(row.body) as Record<string, unknown>;
    expect(body.kinds).toEqual(seq);
    expect(body.length).toBe(3);
    expect(body.frequency).toBe(3);
  });

  test("a 3-gram appearing only once is not admitted (below frequency threshold)", async () => {
    const db = openDb(":memory:");
    insertSequence(db, "d_solo", ["directive_opened", "owner_input_received", "task_failed"]);

    const summary = await extractTrajectoryMotifs(db);
    expect(summary.directives_scanned).toBe(1);
    expect(summary.motifs_admitted).toBe(0);
    expect(countMotifs(db)).toBe(0);
  });

  test("re-running on the same events is idempotent (no duplicate motif rows)", async () => {
    const db = openDb(":memory:");
    const seq = ["directive_opened", "bridge_failed", "task_committed"];
    insertSequence(db, "d_a", seq);
    insertSequence(db, "d_b", seq);
    insertSequence(db, "d_c", seq);

    await extractTrajectoryMotifs(db);
    const first = countMotifs(db);
    expect(first).toBeGreaterThanOrEqual(1);

    const second = await extractTrajectoryMotifs(db);
    expect(countMotifs(db)).toBe(first);
    // Second run admits nothing new.
    expect(second.motifs_admitted).toBe(0);
    expect(second.motifs_already_present).toBeGreaterThanOrEqual(1);
  });

  test("closure correlation: avg_closure_residual averages over EVERY directive the motif occurred in (not literal-suffix tail-match)", async () => {
    const db = openDb(":memory:");
    const seq = ["directive_opened", "task_node_opened", "task_committed"];
    insertSequence(db, "d_low", seq);
    insertSequence(db, "d_mid", seq);
    insertSequence(db, "d_high", seq);

    // Closure-audited events for each directive (different residuals).
    // Inserted AFTER the seq, so they are the directive's TRAILING events —
    // exactly the real-data shape where background events follow the
    // closure and the motif is never the literal suffix. The corrected
    // extractor correlates over directives the motif OCCURRED IN, so all
    // three contribute their residual regardless of suffix position.
    insertEvent(db, {
      kind: "task_closure_audited",
      directive_id: "d_low",
      payload: { closure_residual: 0.1 },
    });
    insertEvent(db, {
      kind: "task_closure_audited",
      directive_id: "d_mid",
      payload: { closure_residual: 0.5 },
    });
    insertEvent(db, {
      kind: "task_closure_audited",
      directive_id: "d_high",
      payload: { closure_residual: 0.9 },
    });

    await extractTrajectoryMotifs(db);
    const row = db
      .query(
        `SELECT body FROM act_artifact
          WHERE kind = 'trajectory_motif_predicate'
            AND name = 'directive_opened>task_node_opened>task_committed'`,
      )
      .get() as { body: string };
    expect(row).toBeTruthy();
    const body = JSON.parse(row.body) as Record<string, unknown>;
    // The motif occurred in d_low, d_mid, d_high — each with a closure.
    // avg = (0.1 + 0.5 + 0.9) / 3 = 0.5. The old literal-suffix logic
    // would have returned null here (closure is not the tail) — that was
    // the runtime-inert bug.
    expect(typeof body.avg_closure_residual).toBe("number");
    expect(body.avg_closure_residual).toBeCloseTo(0.5, 6);
  });

  test("outcome posterior seed: a motif with matching low-residual closures gets a posterior (alpha up, score>0.5) — not stuck at the flat Beta(1,1)", async () => {
    const db = openDb(":memory:");
    // A motif whose TAIL is task_closure_audited across three directives,
    // each closing with a LOW residual (good recipe). The closure event is
    // the LAST event of the sequence so the motif tail matches it.
    for (const directiveId of ["d_x", "d_y", "d_z"]) {
      insertEvent(db, { kind: "task_node_opened", directive_id: directiveId });
      insertEvent(db, { kind: "task_committed", directive_id: directiveId });
      insertEvent(db, {
        kind: "task_closure_audited",
        directive_id: directiveId,
        payload: { closure_residual: 0.1 },
      });
    }

    const summary = await extractTrajectoryMotifs(db);
    expect(summary.motifs_score_calibrated).toBeGreaterThanOrEqual(1);

    const row = db
      .query(
        `SELECT score, posterior_alpha, posterior_beta, body FROM act_artifact
          WHERE kind = 'trajectory_motif_predicate'
            AND name = 'task_node_opened>task_committed>task_closure_audited'`,
      )
      .get() as { score: number; posterior_alpha: number; posterior_beta: number; body: string };
    expect(row).toBeTruthy();
    const body = JSON.parse(row.body) as Record<string, unknown>;
    expect(body.avg_closure_residual).toBeCloseTo(0.1, 6);
    // The score is now the Beta posterior MEAN (alpha/(alpha+beta)), seeded by
    // applyResidualOutcome — NOT a direct 1-avg_residual overwrite. A low
    // residual (0.1) pushes alpha above the flat cold-start so the posterior
    // mean clears 0.5: the motif is a SCORED-by-outcome object now.
    expect(row.posterior_alpha).toBeGreaterThan(1); // evidence accrued to alpha
    expect(row.posterior_beta).toBeCloseTo(1, 6); // low residual ⇒ no beta
    expect(row.score).toBeGreaterThan(0.5);
    // Posterior mean of Beta(1+0.6667, 1) = 1.6667/2.6667 ≈ 0.625, not 0.9.
    expect(row.score).toBeCloseTo(0.625, 2);
  });

  test("outcome posterior: a HIGH-residual motif accrues beta (score<0.5), proving the posterior is updated BY OUTCOME (not frequency)", async () => {
    const db = openDb(":memory:");
    // Same recurring motif, but the directives all CLOSED POORLY (high
    // residual). A frequency-only score would still be 0.5; an outcome
    // posterior must drop below 0.5 because beta accrues.
    for (const directiveId of ["d_bad1", "d_bad2", "d_bad3"]) {
      insertEvent(db, { kind: "task_node_opened", directive_id: directiveId });
      insertEvent(db, { kind: "task_committed", directive_id: directiveId });
      insertEvent(db, {
        kind: "task_closure_audited",
        directive_id: directiveId,
        payload: { closure_residual: 0.95 },
      });
    }

    await extractTrajectoryMotifs(db);
    const row = db
      .query(
        `SELECT score, posterior_alpha, posterior_beta FROM act_artifact
          WHERE kind = 'trajectory_motif_predicate'
            AND name = 'task_node_opened>task_committed>task_closure_audited'`,
      )
      .get() as { score: number; posterior_alpha: number; posterior_beta: number };
    expect(row).toBeTruthy();
    expect(row.posterior_beta).toBeGreaterThan(1); // failure evidence → beta up
    expect(row.score).toBeLessThan(0.5); // posterior mean below cold-start
  });

  test("posterior seed is ONE-SHOT at admission: re-running the extractor does NOT double-count evidence", async () => {
    const db = openDb(":memory:");
    for (const directiveId of ["d_o1", "d_o2", "d_o3"]) {
      insertEvent(db, { kind: "task_node_opened", directive_id: directiveId });
      insertEvent(db, { kind: "task_committed", directive_id: directiveId });
      insertEvent(db, {
        kind: "task_closure_audited",
        directive_id: directiveId,
        payload: { closure_residual: 0.1 },
      });
    }
    await extractTrajectoryMotifs(db);
    const after1 = db
      .query(
        `SELECT posterior_alpha, score FROM act_artifact
          WHERE kind = 'trajectory_motif_predicate'
            AND name = 'task_node_opened>task_committed>task_closure_audited'`,
      )
      .get() as { posterior_alpha: number; score: number };
    // Second tick re-observes the same motif (already_present) — must NOT
    // re-seed the posterior (would double-count the closure evidence).
    const second = await extractTrajectoryMotifs(db);
    expect(second.motifs_admitted).toBe(0);
    expect(second.motifs_score_calibrated).toBe(0);
    const after2 = db
      .query(
        `SELECT posterior_alpha, score FROM act_artifact
          WHERE kind = 'trajectory_motif_predicate'
            AND name = 'task_node_opened>task_committed>task_closure_audited'`,
      )
      .get() as { posterior_alpha: number; score: number };
    expect(after2.posterior_alpha).toBeCloseTo(after1.posterior_alpha, 6);
    expect(after2.score).toBeCloseTo(after1.score, 6);
  });

  test("a motif with no closure evidence stays at the flat cold-start posterior (score 0.5)", async () => {
    const db = openDb(":memory:");
    const seq = ["directive_opened", "task_node_opened", "task_committed"];
    insertSequence(db, "d_p", seq);
    insertSequence(db, "d_q", seq);
    insertSequence(db, "d_r", seq);

    const summary = await extractTrajectoryMotifs(db);
    expect(summary.motifs_score_calibrated).toBe(0);
    const row = db
      .query(
        `SELECT score, posterior_alpha, posterior_beta FROM act_artifact
          WHERE kind = 'trajectory_motif_predicate'
            AND name = 'directive_opened>task_node_opened>task_committed'`,
      )
      .get() as { score: number; posterior_alpha: number; posterior_beta: number };
    expect(row.score).toBeCloseTo(0.5, 8);
    expect(row.posterior_alpha).toBeCloseTo(1, 8);
    expect(row.posterior_beta).toBeCloseTo(1, 8);
  });

  test("bounded window: events older than windowDays are not picked up", async () => {
    const db = openDb(":memory:");
    // 60 days ago — outside the default 30-day window.
    const oldTs = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    for (const directiveId of ["d_old1", "d_old2", "d_old3"]) {
      for (const k of ["directive_opened", "task_node_opened", "task_committed"]) {
        insertEvent(db, { kind: k, directive_id: directiveId, ts: oldTs });
      }
    }
    // And one recent directive with the same kinds — only one occurrence,
    // below the frequency=3 threshold, so nothing should be admitted.
    insertSequence(db, "d_recent", [
      "directive_opened",
      "task_node_opened",
      "task_committed",
    ]);

    const summary = await extractTrajectoryMotifs(db);
    // Only the recent directive contributes events.
    expect(summary.directives_scanned).toBe(1);
    expect(summary.motifs_admitted).toBe(0);
    expect(countMotifs(db)).toBe(0);
    // Observations are only emitted for admitted motifs.
    expect(countObservations(db)).toBe(0);
  });
});
