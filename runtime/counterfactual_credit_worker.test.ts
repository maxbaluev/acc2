// T4.1 counterfactual credit scorer worker tests.
//
// Wires the docs/roadmap.md Tier 6 counterfactual_comparison_predicate:
// at every selection boundary the chosen path lands as a regular
// action; the rejected alternatives are persisted via
// counterfactual_alternative_recorded with a window_seconds. After the
// window, this worker scores each rejected candidate against the
// chosen's actual action_scored residual.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { newId } from "./ids";
import { runCounterfactualCreditWorker } from "./counterfactual_credit_worker";

const FIXED_NOW = new Date("2026-05-20T12:00:00.000Z");

afterAll(() => closeDb());
beforeEach(() => closeDb());

const oldTs = (ageMs: number): string =>
  new Date(FIXED_NOW.getTime() - ageMs).toISOString();

type InsertCounterfactualOpts = {
  id?: string;
  ts: string;
  selection_kind?: string;
  selection_event_id?: string | null;
  chosen_id?: string;
  rejected: Array<{ id: string; score: number; reason?: string; artifact_kind?: string }>;
  window_seconds?: number;
};

const insertCounterfactual = (
  db: ReturnType<typeof openDb>,
  opts: InsertCounterfactualOpts,
): string => {
  const id = opts.id ?? newId();
  db.run(
    `INSERT INTO events (
       id, ts, directive_id, task_id, parent_task_id, loop_id,
       substrate_origin, kind, payload, context_refs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      opts.ts,
      "directive_test",
      "task_test",
      null,
      "loop_root",
      "substrate_auto",
      "counterfactual_alternative_recorded",
      JSON.stringify({
        selection_kind: opts.selection_kind ?? "artifact_selection",
        selection_event_id: opts.selection_event_id === undefined ? "selection_evt_x" : opts.selection_event_id,
        chosen_id: opts.chosen_id ?? "chosen_x",
        rejected_candidates: opts.rejected,
        window_seconds: opts.window_seconds ?? 600,
      }),
      JSON.stringify([]),
    ],
  );
  return id;
};

const insertActionScored = (
  db: ReturnType<typeof openDb>,
  opts: { selection_event_id: string; residual: number; ts?: string },
): string => {
  const id = newId();
  db.run(
    `INSERT INTO events (
       id, ts, directive_id, task_id, parent_task_id, loop_id,
       substrate_origin, kind, payload, context_refs, residual
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      opts.ts ?? FIXED_NOW.toISOString(),
      "directive_test",
      "task_test",
      null,
      "loop_root",
      "substrate_auto",
      "action_scored",
      JSON.stringify({
        source_event_id: opts.selection_event_id,
        residual: opts.residual,
      }),
      JSON.stringify([opts.selection_event_id]),
      opts.residual,
    ],
  );
  return id;
};

const countScoreUpdatedForCounterfactual = (
  db: ReturnType<typeof openDb>,
  counterfactualEventId: string,
): number =>
  (db
    .query(
      `SELECT COUNT(*) AS c FROM events
        WHERE kind = 'act_artifact_score_updated'
          AND json_extract(payload, '$.projection_key') LIKE ?`,
    )
    .get(`counterfactual_credit:${counterfactualEventId}:%`) as { c: number }).c;

const readScoreUpdateForRejected = (
  db: ReturnType<typeof openDb>,
  counterfactualEventId: string,
  rejectedId: string,
): { residual: number | null; role: string | null; projection_key: string } | null => {
  const row = db
    .query(
      `SELECT payload FROM events
        WHERE kind = 'act_artifact_score_updated'
          AND json_extract(payload, '$.projection_key') = ?`,
    )
    .get(`counterfactual_credit:${counterfactualEventId}:${rejectedId}`) as { payload: string } | null;
  if (!row) return null;
  const parsed = JSON.parse(row.payload);
  return {
    residual: typeof parsed.residual === "number" ? parsed.residual : null,
    role: typeof parsed.role === "string" ? parsed.role : null,
    projection_key: parsed.projection_key,
  };
};

describe("counterfactual_credit_worker", () => {
  test("scores rejected candidates with penalty when chosen succeeded", async () => {
    const db = openDb(":memory:");
    const cfId = insertCounterfactual(db, {
      ts: oldTs(601_000),
      selection_event_id: "sel_evt_1",
      chosen_id: "chosen_1",
      rejected: [
        { id: "rejected_a", score: 0.55, reason: "lost_topk" },
        { id: "rejected_b", score: 0.50, reason: "lost_topk" },
      ],
      window_seconds: 600,
    });
    insertActionScored(db, { selection_event_id: "sel_evt_1", residual: 0.1 });

    const summary = await runCounterfactualCreditWorker(db, { now: FIXED_NOW });
    expect(summary.scanned).toBe(1);
    expect(summary.scored_count).toBe(2);
    expect(summary.skipped_recent).toBe(0);
    expect(summary.skipped_already_scored).toBe(0);
    expect(summary.skipped_no_chosen_residual).toBe(0);

    // Chosen succeeded (residual 0.1 < 0.3) → rejected get small negative
    // posterior bump: counterfactual_residual = 0.1 + 0.05 = 0.15.
    const a = readScoreUpdateForRejected(db, cfId, "rejected_a");
    expect(a).not.toBeNull();
    expect(a!.residual).toBeCloseTo(0.15, 5);
    expect(a!.role).toBe("counterfactual_rejected");

    const b = readScoreUpdateForRejected(db, cfId, "rejected_b");
    expect(b).not.toBeNull();
    expect(b!.residual).toBeCloseTo(0.15, 5);

    // Closure audit emitted summarising the sweep.
    expect(summary.closure_event_id).not.toBeNull();
  });

  test("scores rejected candidates with bonus when chosen failed", async () => {
    const db = openDb(":memory:");
    const cfId = insertCounterfactual(db, {
      ts: oldTs(601_000),
      selection_event_id: "sel_evt_2",
      chosen_id: "chosen_2",
      rejected: [
        { id: "rejected_x", score: 0.40, reason: "lost_topk" },
      ],
      window_seconds: 600,
    });
    // Chosen failed: residual=0.8 >= FAILURE_BAND(0.7).
    insertActionScored(db, { selection_event_id: "sel_evt_2", residual: 0.8 });

    const summary = await runCounterfactualCreditWorker(db, { now: FIXED_NOW });
    expect(summary.scored_count).toBe(1);

    // Counterfactual residual = max(0, 0.8 - 0.05) = 0.75 (still a
    // "failure" band but slightly lower — rejected might have done better).
    const r = readScoreUpdateForRejected(db, cfId, "rejected_x");
    expect(r).not.toBeNull();
    expect(r!.residual).toBeCloseTo(0.75, 5);
  });

  test("idempotent re-run produces no new score rows", async () => {
    const db = openDb(":memory:");
    const cfId = insertCounterfactual(db, {
      ts: oldTs(601_000),
      selection_event_id: "sel_evt_3",
      chosen_id: "chosen_3",
      rejected: [
        { id: "rejected_p", score: 0.45 },
        { id: "rejected_q", score: 0.40 },
      ],
      window_seconds: 600,
    });
    insertActionScored(db, { selection_event_id: "sel_evt_3", residual: 0.2 });

    const first = await runCounterfactualCreditWorker(db, { now: FIXED_NOW });
    expect(first.scored_count).toBe(2);
    expect(countScoreUpdatedForCounterfactual(db, cfId)).toBe(2);

    // Re-run: counterfactual_already_closed should short-circuit; no
    // new score rows emitted.
    const second = await runCounterfactualCreditWorker(db, { now: FIXED_NOW });
    expect(second.scored_count).toBe(0);
    expect(second.skipped_already_scored).toBe(1);
    expect(countScoreUpdatedForCounterfactual(db, cfId)).toBe(2);
  });

  test("skips counterfactuals still inside their window", async () => {
    const db = openDb(":memory:");
    insertCounterfactual(db, {
      ts: oldTs(60_000), // 60s old, well within the 600s window
      selection_event_id: "sel_evt_4",
      rejected: [{ id: "rejected_y", score: 0.30 }],
      window_seconds: 600,
    });
    insertActionScored(db, { selection_event_id: "sel_evt_4", residual: 0.15 });

    const summary = await runCounterfactualCreditWorker(db, { now: FIXED_NOW });
    expect(summary.scanned).toBe(1);
    expect(summary.skipped_recent).toBe(1);
    expect(summary.scored_count).toBe(0);
  });

  test("scores composer counterfactuals without selection_event_id from same task action_scored", async () => {
    const db = openDb(":memory:");
    const cfId = insertCounterfactual(db, {
      ts: oldTs(601_000),
      selection_event_id: null,
      chosen_id: "chosen_from_prompt",
      rejected: [{ id: "rejected_from_prompt", score: 0.35 }],
      window_seconds: 600,
    });
    insertActionScored(db, { selection_event_id: "unrelated_scored_event", residual: 0.2 });

    const summary = await runCounterfactualCreditWorker(db, { now: FIXED_NOW });
    expect(summary.scored_count).toBe(1);
    expect(summary.closure_event_id).not.toBeNull();
    const r = readScoreUpdateForRejected(db, cfId, "rejected_from_prompt");
    expect(r).not.toBeNull();
    expect(r!.residual).toBeCloseTo(0.25, 5);
  });

  test("skips counterfactuals where chosen has no action_scored residual", async () => {
    const db = openDb(":memory:");
    insertCounterfactual(db, {
      ts: oldTs(601_000),
      selection_event_id: "sel_evt_5",
      rejected: [{ id: "rejected_z", score: 0.30 }],
      window_seconds: 600,
    });
    // NOTE: no insertActionScored call — chosen path produced no residual.

    const summary = await runCounterfactualCreditWorker(db, { now: FIXED_NOW });
    expect(summary.scanned).toBe(1);
    expect(summary.skipped_no_chosen_residual).toBe(1);
    expect(summary.scored_count).toBe(0);
    expect(summary.closure_event_id).toBeNull();
  });

  test("counterfactual_closure_audited reports closure proxy across sweep", async () => {
    const db = openDb(":memory:");
    // Counterfactual 1: rejected_alpha lost a selection.
    insertCounterfactual(db, {
      ts: oldTs(601_000),
      selection_event_id: "sel_evt_6",
      chosen_id: "chosen_6",
      rejected: [{ id: "rejected_alpha", score: 0.40 }],
      window_seconds: 600,
    });
    insertActionScored(db, { selection_event_id: "sel_evt_6", residual: 0.1 });
    // Counterfactual 2 (later in the lookback window): rejected_alpha
    // becomes the CHOSEN, demonstrating that the counterfactual
    // posteriors moved routing — closure-predicate proxy hit.
    insertCounterfactual(db, {
      ts: oldTs(300_000),
      selection_event_id: "sel_evt_7",
      chosen_id: "rejected_alpha", // <-- previously-rejected now wins
      rejected: [{ id: "other", score: 0.20 }],
      window_seconds: 60, // small window so this row still scores
    });
    insertActionScored(db, { selection_event_id: "sel_evt_7", residual: 0.2 });

    const summary = await runCounterfactualCreditWorker(db, { now: FIXED_NOW });
    // Both counterfactuals should be scored.
    expect(summary.scored_count).toBe(2);
    expect(summary.closure_event_id).not.toBeNull();

    const closureRow = db
      .query(
        `SELECT payload FROM events
          WHERE kind = 'counterfactual_closure_audited'
            AND id = ?`,
      )
      .get(summary.closure_event_id) as { payload: string } | null;
    expect(closureRow).not.toBeNull();
    const parsed = JSON.parse(closureRow!.payload);
    expect(typeof parsed.closure_residual).toBe("number");
    // closure_residual = 1 - (wins/unique_rejected); rejected_alpha
    // counted once as unique_rejected, and counts as 1 win (it later
    // became a chosen_id in the same sweep window). So closure_residual
    // should reflect that.
    expect(parsed.rejected_unique_count).toBeGreaterThan(0);
    expect(parsed.rejected_subsequent_wins).toBeGreaterThanOrEqual(1);
    expect(parsed.closure_residual).toBeLessThanOrEqual(1);
  });
});
