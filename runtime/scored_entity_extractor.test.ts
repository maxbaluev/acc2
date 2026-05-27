// USS Phase-4 (extractor unification, cut 1/5) — proves the generic
// `extractScoredEntities` skeleton:
//   1. runs a BOUNDED source scan (and hard-refuses an unbounded one),
//   2. builds candidates from the scanned rows via candidate_builder,
//   3. lets the outcome_linker score each candidate into a `scored_entity`
//      row (via the canonical `applyScoredOutcome` primitive) AND emit its
//      observation event (`entity_score_updated`),
//   4. returns the caller's own summary object untouched.
//
// This is the shared spine that runtime/trajectory_motif_extractor.ts (and,
// in later cuts, the other four extractors) delegate to. Keeping a generic
// test here means the skeleton's contract is pinned independently of any one
// extractor's domain logic.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { applyScoredOutcome } from "./posterior";
import {
  extractScoredEntities,
  type ScoredEntityExtractorConfig,
} from "./scored_entity_extractor";

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
  fields: { kind: string; directive_id?: string; payload?: unknown; ts?: string },
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
      "t_test",
      "l_test",
      "substrate_auto",
      fields.kind,
      JSON.stringify(fields.payload ?? {}),
      JSON.stringify([]),
    ],
  );
  return id;
};

type EventRow = { id: string; kind: string; directive_id: string | null };
type Candidate = { entity_id: string; kind: string; count: number };
type Summary = { rows_scanned: number; candidates_built: number; scored: number };

const countScoredEntities = (db: ReturnType<typeof openDb>): number =>
  (db.query(`SELECT COUNT(*) AS n FROM scored_entity`).get() as { n: number }).n;

const countScoreEvents = (db: ReturnType<typeof openDb>): number =>
  (db
    .query(`SELECT COUNT(*) AS n FROM events WHERE kind = 'entity_score_updated'`)
    .get() as { n: number }).n;

const latestScorePayload = (db: ReturnType<typeof openDb>, entityId: string): Record<string, unknown> => {
  const row = db
    .query(`SELECT payload FROM events WHERE kind = 'entity_score_updated' AND json_extract(payload, '$.entity_id') = ? ORDER BY ts DESC, rowid DESC LIMIT 1`)
    .get(entityId) as { payload: string } | null;
  return row ? (JSON.parse(row.payload) as Record<string, unknown>) : {};
};

/** A generic config: scan recent events, count by kind, score one entity per
 *  distinct kind via applyScoredOutcome (which writes the scored_entity row
 *  AND emits the entity_score_updated observation event). */
const makeConfig = (cap: number): ScoredEntityExtractorConfig<EventRow, Candidate, Summary> => ({
  source_query: {
    sql: `SELECT id, kind, directive_id FROM events
            WHERE directive_id IS NOT NULL
            ORDER BY ts ASC, rowid ASC
            LIMIT ?`,
    params: [cap],
    boundedRowCap: cap,
  },
  candidate_builder: async (_db, rows) => {
    const summary: Summary = { rows_scanned: rows.length, candidates_built: 0, scored: 0 };
    const byKind = new Map<string, number>();
    for (const r of rows) byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
    const candidates = Array.from(byKind.entries()).map(([kind, count]) => ({
      candidate: { entity_id: `tk_${kind}`, kind, count },
      entity_id: `tk_${kind}`,
      entity_kind: "test_kind_count",
      capability_properties: { measurement: 1, trajectory: 1, observed_kind: kind },
    }));
    summary.candidates_built = candidates.length;
    return { candidates, summary };
  },
  outcome_linker: (db, output, summary) => {
    const candidate = output.candidate;
    // Score the entity via the canonical primitive. Residual derived from the
    // count so we have a deterministic posterior.
    applyScoredOutcome(db, {
      entity_id: output.entity_id ?? candidate.entity_id,
      entity_kind: output.entity_kind ?? "test_kind_count",
      residual: candidate.count >= 3 ? 0.1 : 0.9,
      ts: tickTs(),
      payload: { capability_properties: output.capability_properties },
    });
    summary.scored++;
  },
});

describe("extractScoredEntities", () => {
  test("generic config: bounded scan → candidates → scored_entity rows + observation events", async () => {
    const db = openDb(":memory:");
    // Three "good" kind-A events and one "poor" kind-B event.
    for (let i = 0; i < 3; i++) insertEvent(db, { kind: "alpha_event", directive_id: "d1" });
    insertEvent(db, { kind: "beta_event", directive_id: "d2" });

    const summary = await extractScoredEntities(db, makeConfig(1000));

    expect(summary.rows_scanned).toBe(4);
    expect(summary.candidates_built).toBe(2); // alpha_event, beta_event
    expect(summary.scored).toBe(2);

    // Both scored_entity rows landed.
    expect(countScoredEntities(db)).toBe(2);
    // And both observation (entity_score_updated) events were emitted.
    expect(countScoreEvents(db)).toBe(2);

    // The high-frequency entity (residual 0.1) outscores the low-frequency one.
    const alpha = db
      .query(`SELECT score FROM scored_entity WHERE entity_id = 'tk_alpha_event'`)
      .get() as { score: number };
    const beta = db
      .query(`SELECT score FROM scored_entity WHERE entity_id = 'tk_beta_event'`)
      .get() as { score: number };
    expect(alpha.score).toBeGreaterThan(0.5);
    expect(beta.score).toBeLessThan(0.5);

    const alphaPayload = latestScorePayload(db, "tk_alpha_event");
    expect(alphaPayload.capability_properties).toEqual({
      measurement: 1,
      trajectory: 1,
      observed_kind: "alpha_event",
    });
  });

  test("bounded scan: the LIMIT cap is honored — rows beyond the cap are not scanned", async () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 10; i++) insertEvent(db, { kind: "alpha_event", directive_id: "d1" });

    // Cap the scan at 4 rows.
    const summary = await extractScoredEntities(db, makeConfig(4));
    expect(summary.rows_scanned).toBe(4);
  });

  test("fail-closed: an unbounded source query (non-finite / non-positive cap) is refused", async () => {
    const db = openDb(":memory:");
    insertEvent(db, { kind: "alpha_event", directive_id: "d1" });

    const badConfigs = [0, -1, Number.NaN, 1.5, Number.POSITIVE_INFINITY];
    for (const bad of badConfigs) {
      const cfg = makeConfig(1000);
      // Force an invalid bound — simulating a caller that tried to skip the LIMIT.
      (cfg.source_query as { boundedRowCap: number }).boundedRowCap = bad;
      await expect(extractScoredEntities(db, cfg)).rejects.toThrow(
        /unbounded_scan_refused/,
      );
    }
    // Nothing was scored because the skeleton refused before scanning.
    expect(countScoredEntities(db)).toBe(0);
  });

  test("returns the caller's own summary object untouched (shape preserved)", async () => {
    const db = openDb(":memory:");
    insertEvent(db, { kind: "alpha_event", directive_id: "d1" });
    const summary = await extractScoredEntities(db, makeConfig(1000));
    // The summary keys are exactly the caller's, not the skeleton's.
    expect(Object.keys(summary).sort()).toEqual(
      ["candidates_built", "rows_scanned", "scored"].sort(),
    );
  });
});
