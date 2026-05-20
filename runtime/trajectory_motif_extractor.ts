// acc2 Tier-S3 — trajectory-motif posterior extractor.
// Per roadmap Tier-S3 (brain KC G3PR7X6TCD4T57D7T6GXCDY9AW): multi-event
// sequences across a directive (e.g.
// directive_opened → task_node_opened → bridge_failed → retry →
// task_committed) recur in the substrate but no extractor mines them.
// This extractor walks recent events grouped by directive_id, produces
// 3-gram and 4-gram ordered tuples of event KINDS, counts frequency
// across directives, and admits the top-K most-frequent motifs as
// act_artifact{kind:"trajectory_motif_predicate"} rows so the substrate
// can rank recipe shapes by Beta posterior.
//
// Each motif row id is deterministic from the n-gram hash so re-runs
// don't duplicate. Closure correlation: for motifs whose tail matches
// a directive's trajectory, the extractor averages the closure_residual
// reported by task_closure_audited events on those directives and
// stores that on the row body. Cold-start posterior is Beta(1,1); the
// closure-residual average calibrates the score field.
//
// Bounded: 30-day window, LIMIT 5000 events per tick, top 50 motifs,
// async + yield every 25 directives.
//
// Same shape as runtime/causal_edge_extractor.ts (Tier-S2, commit
// 695c698): ensureRow helper, emit audit event per admission, idempotent
// via SELECT-before-INSERT on deterministic ids.

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { emitEvent } from "./events";

const YIELD_EVERY_N = 25;
const yieldToEventLoop = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0));

const MOTIF_KIND = "trajectory_motif_predicate";
const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_MAX_EVENTS = 5000;
const DEFAULT_TOP_K = 50;
const DEFAULT_MIN_FREQUENCY = 3;
const DEFAULT_N_GRAM_LENGTHS = [3, 4] as const;

type EventRow = {
  id: string;
  ts: string;
  directive_id: string | null;
  kind: string;
  payload: string | null;
};

const motifHash = (kinds: ReadonlyArray<string>): string =>
  createHash("sha1").update(kinds.join("|")).digest("hex").slice(0, 16);

const motifId = (kinds: ReadonlyArray<string>): string =>
  `motif_${kinds.length}_${motifHash(kinds)}`;

const motifName = (kinds: ReadonlyArray<string>): string => kinds.join(">");

const ensureMotifRow = (
  db: Database,
  kinds: ReadonlyArray<string>,
  body: {
    kinds: ReadonlyArray<string>;
    length: number;
    frequency: number;
    avg_closure_residual: number | null;
  },
): { id: string; created: boolean } => {
  const id = motifId(kinds);
  const existing = db.query("SELECT id FROM act_artifact WHERE id = ? LIMIT 1").get(id);
  if (existing) return { id, created: false };
  const ts = new Date().toISOString();
  const bodyJson = JSON.stringify(body);
  const declaredSandbox = JSON.stringify({
    runtime: "bun",
    substrate_access: "ro",
    cpu_ms: 100,
    wall_ms: 1000,
    memory_mb: 8,
    fs_read: [],
    fs_write: [],
    net_allow: [],
    proc_allow: [],
  });
  db.run(
    `INSERT INTO act_artifact (
       id, runtime, body, declared_sandbox, state_root, kind,
       posterior_alpha, posterior_beta, score, confidence,
       recent_residual_mean, recent_kill_count, status, name,
       fixture_input, fixture_expected_residual,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      "bun",
      bodyJson,
      declaredSandbox,
      `substrate/trajectory_motif/${kinds.length}/${motifHash(kinds)}`,
      MOTIF_KIND,
      1.0,
      1.0,
      0.5,
      0.5,
      0.0,
      0,
      "admitted",
      motifName(kinds),
      bodyJson,
      0.5,
      ts,
      ts,
    ],
  );
  return { id, created: true };
};

export type TrajectoryMotifSummary = {
  directives_scanned: number;
  events_scanned: number;
  unique_motifs_seen: number;
  motifs_admitted: number;
  motifs_already_present: number;
};

type MotifAggregate = {
  kinds: ReadonlyArray<string>;
  frequency: number;
  directives: Set<string>;
};

/**
 * Scan recent events grouped by directive_id, produce n-gram (length
 * 3 and 4) ordered tuples of event KINDS, count frequency across
 * directives, and admit the top-K most-frequent motifs (frequency
 * ≥ minFrequency) as act_artifact{kind:trajectory_motif_predicate}
 * rows. The row id is deterministic from the n-gram hash so re-runs
 * are idempotent. Closure correlation: averages closure_residual of
 * directives whose tail matches the motif onto body.avg_closure_residual.
 */
export const extractTrajectoryMotifs = async (
  db: Database,
  opts?: {
    maxEvents?: number;
    windowDays?: number;
    topK?: number;
    minFrequency?: number;
    nGramLengths?: ReadonlyArray<number>;
  },
): Promise<TrajectoryMotifSummary> => {
  const maxEvents = Math.max(1, opts?.maxEvents ?? DEFAULT_MAX_EVENTS);
  const windowDays = Math.max(1, opts?.windowDays ?? DEFAULT_WINDOW_DAYS);
  const topK = Math.max(1, opts?.topK ?? DEFAULT_TOP_K);
  const minFrequency = Math.max(1, opts?.minFrequency ?? DEFAULT_MIN_FREQUENCY);
  const nGramLengths =
    opts?.nGramLengths && opts.nGramLengths.length > 0
      ? opts.nGramLengths.map((n) => Math.max(2, Math.trunc(n)))
      : DEFAULT_N_GRAM_LENGTHS;
  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const summary: TrajectoryMotifSummary = {
    directives_scanned: 0,
    events_scanned: 0,
    unique_motifs_seen: 0,
    motifs_admitted: 0,
    motifs_already_present: 0,
  };

  // Pull recent events with a non-null directive_id, ordered by
  // (directive_id, ts) so the sliding-window walk per directive is
  // a single linear scan.
  const events = db
    .query(
      `SELECT id, ts, directive_id, kind, payload FROM events
        WHERE ts > ? AND directive_id IS NOT NULL
        ORDER BY directive_id ASC, ts ASC, rowid ASC
        LIMIT ?`,
    )
    .all(cutoff, maxEvents) as EventRow[];

  // Group event kinds by directive.
  const perDirective = new Map<string, string[]>();
  for (const ev of events) {
    if (!ev.directive_id) continue;
    let list = perDirective.get(ev.directive_id);
    if (!list) {
      list = [];
      perDirective.set(ev.directive_id, list);
    }
    list.push(ev.kind);
  }
  summary.events_scanned = events.length;

  // Aggregate n-grams across directives.
  const motifs = new Map<string, MotifAggregate>();
  let processedSinceYield = 0;
  for (const [directiveId, kinds] of perDirective) {
    if (processedSinceYield >= YIELD_EVERY_N) {
      await yieldToEventLoop();
      processedSinceYield = 0;
    }
    processedSinceYield++;
    summary.directives_scanned++;

    for (const n of nGramLengths) {
      if (kinds.length < n) continue;
      for (let i = 0; i + n <= kinds.length; i++) {
        const slice = kinds.slice(i, i + n);
        const key = motifHash(slice);
        let agg = motifs.get(key);
        if (!agg) {
          agg = { kinds: slice, frequency: 0, directives: new Set<string>() };
          motifs.set(key, agg);
        }
        agg.frequency++;
        agg.directives.add(directiveId);
      }
    }
  }
  summary.unique_motifs_seen = motifs.size;

  // Filter to frequent motifs, sort by frequency desc, take topK.
  const frequent = Array.from(motifs.values())
    .filter((m) => m.frequency >= minFrequency)
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, topK);

  // For each frequent motif compute closure correlation over the set of
  // directives whose tail matches the motif. "Tail matches" = the motif
  // appears as the LAST n-gram in the directive's event sequence.
  for (const motif of frequent) {
    const tailLength = motif.kinds.length;
    const matchingDirectives: string[] = [];
    for (const directiveId of motif.directives) {
      const kinds = perDirective.get(directiveId);
      if (!kinds || kinds.length < tailLength) continue;
      const tail = kinds.slice(kinds.length - tailLength);
      let matches = true;
      for (let i = 0; i < tailLength; i++) {
        if (tail[i] !== motif.kinds[i]) {
          matches = false;
          break;
        }
      }
      if (matches) matchingDirectives.push(directiveId);
    }

    let residualSum = 0;
    let residualCount = 0;
    if (matchingDirectives.length > 0) {
      // Pull task_closure_audited residuals for these directives.
      const placeholders = matchingDirectives.map(() => "?").join(",");
      const rows = db
        .query(
          `SELECT payload FROM events
            WHERE kind = 'task_closure_audited'
              AND directive_id IN (${placeholders})`,
        )
        .all(...matchingDirectives) as Array<{ payload: string | null }>;
      for (const row of rows) {
        if (!row.payload) continue;
        try {
          const p = JSON.parse(row.payload) as Record<string, unknown>;
          if (typeof p.closure_residual === "number") {
            residualSum += p.closure_residual;
            residualCount++;
          }
        } catch {
          // malformed payload — skip
        }
      }
    }
    const avgResidual = residualCount > 0 ? residualSum / residualCount : null;

    const { id, created } = ensureMotifRow(db, motif.kinds, {
      kinds: motif.kinds,
      length: motif.kinds.length,
      frequency: motif.frequency,
      avg_closure_residual: avgResidual,
    });
    if (created) {
      summary.motifs_admitted++;
    } else {
      summary.motifs_already_present++;
    }
    // Emit one audit event per observation (created or not) so
    // downstream credit can attribute closure outcomes later. Matches
    // the causal_edge_observed pattern in causal_edge_extractor.ts.
    emitEvent(db, {
      kind: "trajectory_motif_observed",
      substrate_origin: "substrate_auto",
      context_refs: [id, ...motif.kinds],
      payload: {
        motif_act_artifact_id: id,
        kinds: motif.kinds,
        length: motif.kinds.length,
        frequency: motif.frequency,
        directive_count: motif.directives.size,
        avg_closure_residual: avgResidual,
        admitted_this_tick: created,
      },
    });
  }

  return summary;
};
