// acc2 USS Phase-4 (extractor unification, cut 1/5) — the ONE declarative
// scored-entity extractor skeleton.
//
// acc2 grew FIVE copy-pasted extractor modules (trajectory_motif_extractor,
// decomposition_strategy_extractor, causal_edge_extractor,
// goal_shape_predicate_extractor, dispatch_strategy_ranker) that each repeat
// the SAME shape:
//
//   1. run a BOUNDED window scan over `events` (cursor + LIMIT, never an
//      unbounded `FROM events`),
//   2. build candidates from those rows,
//   3. score each candidate via a Beta posterior (applyResidualOutcome /
//      applyScoredOutcome / a bespoke helper),
//   4. emit a bespoke `*_observed` event per admitted/milestone candidate.
//
// This module collapses (1) and (4) — the bounded scan and the per-candidate
// emit loop — into ONE generic, declarative function. The PER-EXTRACTOR logic
// (candidate construction, outcome linking, scoring math, which event to emit,
// when to emit it) is injected via config callbacks, so each extractor keeps
// its EXACT existing behavior while sharing the bounded-scan + iterate spine.
//
// Behavior-preservation contract: a migrated extractor's emitted events,
// payloads, and scoring MUST be byte-identical to its pre-migration output.
// The skeleton owns only the loop structure; all domain logic stays in the
// caller's config callbacks. This is a refactor, not a behavior change.

import type { Database } from "bun:sqlite";
import { poolQuery } from "./sql_pool_singleton";

/**
 * The yield cadence shared by every extractor's candidate-processing loop.
 * Mirrors the per-extractor YIELD_EVERY_N so migrated extractors keep their
 * exact event-loop-yield behavior.
 */
const yieldToEventLoop = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0));

/**
 * A bounded source-query spec. `sql` MUST carry a `LIMIT ?` (or equivalent
 * row cap) and `params` MUST supply it — the skeleton runs it verbatim
 * through the SQL worker-thread pool. The bound is the caller's responsibility
 * (each extractor reuses its EXTRACTOR_SCAN_LIMIT / window-cursor pattern);
 * this skeleton refuses to invent an unbounded scan. The `boundedRowCap`
 * field is the numeric cap the caller passed as the LIMIT bind, recorded so
 * the skeleton can assert the scan can never run unbounded.
 */
export type BoundedSourceQuery = {
  sql: string;
  params: ReadonlyArray<unknown>;
  /** The numeric LIMIT this query was bound with. Must be a finite positive
   *  integer — the skeleton hard-fails otherwise so an unbounded scan can
   *  never slip through. */
  boundedRowCap: number;
};

/**
 * Generic config for a scored-entity extractor.
 *
 * Type params:
 *   TRow        — shape of a source_query result row.
 *   TCandidate  — shape of a built candidate (whatever the extractor needs to
 *                 ensure its row, link outcomes, and emit).
 *   TSummary    — the extractor's bespoke summary accumulator.
 */
export type ScoredEntityExtractorConfig<TRow, TCandidate, TSummary> = {
  /** Free-string entity kind, e.g. "trajectory_motif". Observational. */
  kind: string;

  /** Bounded window scan. The skeleton runs this via poolQuery. */
  source_query: BoundedSourceQuery;

  /**
   * Build the candidate set from the bounded source rows. Returns the
   * candidates plus the extractor's seeded summary object (so per-extractor
   * counters like directives_scanned / unique_motifs_seen are owned by the
   * caller, keeping the summary shape byte-identical). May be async so it can
   * yield to the event loop during heavy aggregation.
   */
  candidate_builder: (
    db: Database,
    rows: ReadonlyArray<TRow>,
  ) => Promise<{ candidates: ReadonlyArray<TCandidate>; summary: TSummary }>;

  /**
   * Per-candidate: ensure the scored row exists, link it to its outcome
   * evidence, apply the scoring math (applyResidualOutcome / applyScoredOutcome
   * / bespoke), and emit the extractor's bespoke `*_observed` event when its
   * own emit gate fires. Mutates `summary` in place to record admission /
   * calibration counters. This is where ALL domain-specific behavior lives, so
   * migration is byte-identical.
   */
  outcome_linker: (
    db: Database,
    candidate: TCandidate,
    summary: TSummary,
  ) => void | Promise<void>;

  /** Optional embedding text builder (USS config slot — unused by cut 1). */
  embedding_text?: (candidate: TCandidate) => string | null;

  /** The scored_entity kind this extractor writes (provenance metadata). */
  scorer_entity_kind?: string;

  /** Optional promotion-rule key (USS config slot — unused by cut 1). */
  promotion_rule_key?: string;

  /** Optional contradiction policy (USS config slot — unused by cut 1). */
  contradiction_policy?: string;

  /** Optional verification fixture handle (USS config slot — unused by cut 1). */
  verification_fixture?: string;

  /**
   * How often (in candidates processed) to yield to the event loop. Defaults
   * to 25 — the cadence every existing extractor uses.
   */
  yield_every_n?: number;
};

/**
 * Run a scored-entity extraction declaratively.
 *
 * The skeleton owns the LOOP STRUCTURE only:
 *   - assert the source query is bounded (finite positive LIMIT),
 *   - run the bounded scan through the SQL pool,
 *   - hand the rows to candidate_builder,
 *   - iterate candidates, yielding to the event loop every `yield_every_n`,
 *   - invoke outcome_linker per candidate (which scores + emits).
 *
 * It returns the extractor's own summary object, untouched, so the migrated
 * extractor's public summary shape is byte-identical to before.
 */
export const extractScoredEntities = async <TRow, TCandidate, TSummary>(
  db: Database,
  config: ScoredEntityExtractorConfig<TRow, TCandidate, TSummary>,
): Promise<TSummary> => {
  const cap = config.source_query.boundedRowCap;
  if (!Number.isFinite(cap) || cap <= 0 || !Number.isInteger(cap)) {
    // Fail-closed: a scored-entity scan MUST be bounded. There is no
    // unbounded-scan lane in the USS skeleton.
    throw new Error(
      `scored_entity_extractor:unbounded_scan_refused kind=${config.kind} boundedRowCap=${String(cap)}`,
    );
  }

  const rows = await poolQuery<TRow>(
    db,
    config.source_query.sql,
    config.source_query.params as never[],
  );

  const { candidates, summary } = await config.candidate_builder(db, rows);

  const yieldEvery = Math.max(1, config.yield_every_n ?? 25);
  let processedSinceYield = 0;
  for (const candidate of candidates) {
    if (processedSinceYield >= yieldEvery) {
      await yieldToEventLoop();
      processedSinceYield = 0;
    }
    processedSinceYield++;
    await config.outcome_linker(db, candidate, summary);
  }

  return summary;
};
