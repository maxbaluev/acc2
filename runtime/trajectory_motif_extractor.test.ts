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

  test("closure correlation: avg_closure_residual averages across directives whose tail matches the motif", async () => {
    const db = openDb(":memory:");
    const seq = ["directive_opened", "task_node_opened", "task_committed"];
    insertSequence(db, "d_low", seq);
    insertSequence(db, "d_mid", seq);
    insertSequence(db, "d_high", seq);

    // Closure-audited events for each directive (different residuals).
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
    // task_closure_audited was inserted AFTER the seq, so the directive's
    // last 3 kinds are still (task_node_opened, task_committed,
    // task_closure_audited) — the motif's TAIL does NOT match that.
    // But task_closure_audited residuals are NOT what we check here —
    // we check that residuals are joined across the three directives.
    // Tail-match requires the motif kinds to be the LAST n kinds of the
    // directive's sequence. After inserting closure_audited the tail is
    // not the motif, so we expect avg_closure_residual === null. This
    // pins the contract: only directives whose tail actually matches
    // contribute residuals.
    expect(body.avg_closure_residual).toBeNull();

    // Now exercise the positive path: a separate motif whose tail IS
    // task_closure_audited across three directives.
    const seq2 = ["task_node_opened", "task_committed", "task_closure_audited"];
    // d_low, d_mid, d_high already have this exact tail.
    await extractTrajectoryMotifs(db);
    const row2 = db
      .query(
        `SELECT body FROM act_artifact
          WHERE kind = 'trajectory_motif_predicate'
            AND name = 'task_node_opened>task_committed>task_closure_audited'`,
      )
      .get() as { body: string };
    expect(row2).toBeTruthy();
    const body2 = JSON.parse(row2.body) as Record<string, unknown>;
    expect(typeof body2.avg_closure_residual).toBe("number");
    expect(body2.avg_closure_residual).toBeCloseTo(0.5, 6);
  });

  test("score calibration: a motif with matching low-residual closures gets score>0.5 (not stuck at 0.5)", async () => {
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
        `SELECT score, recent_residual_mean, body FROM act_artifact
          WHERE kind = 'trajectory_motif_predicate'
            AND name = 'task_node_opened>task_committed>task_closure_audited'`,
      )
      .get() as { score: number; recent_residual_mean: number; body: string };
    expect(row).toBeTruthy();
    const body = JSON.parse(row.body) as Record<string, unknown>;
    expect(body.avg_closure_residual).toBeCloseTo(0.1, 6);
    // score = clamp(1 - 0.1) = 0.9 → no longer stuck at the 0.5 cold-start.
    expect(row.score).toBeGreaterThan(0.5);
    expect(row.score).toBeCloseTo(0.9, 6);
    expect(row.recent_residual_mean).toBeCloseTo(0.1, 6);
  });

  test("score calibration: a motif with no closure evidence stays at the cold-start 0.5", async () => {
    const db = openDb(":memory:");
    const seq = ["directive_opened", "task_node_opened", "task_committed"];
    insertSequence(db, "d_p", seq);
    insertSequence(db, "d_q", seq);
    insertSequence(db, "d_r", seq);

    const summary = await extractTrajectoryMotifs(db);
    expect(summary.motifs_score_calibrated).toBe(0);
    const row = db
      .query(
        `SELECT score FROM act_artifact
          WHERE kind = 'trajectory_motif_predicate'
            AND name = 'directive_opened>task_node_opened>task_committed'`,
      )
      .get() as { score: number };
    expect(row.score).toBeCloseTo(0.5, 8);
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
