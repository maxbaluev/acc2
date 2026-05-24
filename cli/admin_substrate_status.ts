// `acc admin substrate-status` — single-screen liveness verdict.
//
// The substrate has many tables and views; `acc doctor` checks ports
// and lock files, but it doesn't tell the operator whether the
// retrieval substrate has CONTENT. A freshly-initialised install with
// the daemon up still has a dead substrate if no embeddings exist —
// `substrate.search` returns empty and the brain's first dispatch
// pulls nothing useful. This command surfaces that gap directly.
//
// Verdict semantics:
//   - ALIVE     — events > 0 AND act_artifact > 0 AND vec_events > 0
//                 (foundational seed + artifact seed + embedder ran)
//   - DEGRADED  — events > 0 but at least one of (act_artifact, vec_events) == 0
//                 (something seeded; embedder didn't run, or artifacts not seeded)
//   - DEAD      — events == 0 (fresh install, or substrate dropped)
//
// Read-only. Idempotent. Hermetic against the daemon (we open SQLite
// directly with `mode=ro`) so calling this while the daemon is up
// won't race writes.

import type { Database, SQLQueryBindings } from "bun:sqlite";
import { openDb } from "../substrate/db";
import { runViews } from "../substrate/views";
import { resolveDbPath } from "../runtime/state_paths";
import { computeLivenessReport } from "../substrate/liveness";
import {
  EMBEDDABLE_KINDS,
  HEALTH_METRIC_KINDS,
} from "../substrate/event_kinds";
import { retainedEvictedCount } from "../runtime/archival_worker";

export type SubstrateStatusEnv = {
  openSubstrate?: (path?: string) => Database;
  stateDbPath?: string;
  out: (line: string) => void;
  err: (line: string) => void;
};

const defaultStateDbPath = (): string => {
  return resolveDbPath();
};

const defaultEnv = (): SubstrateStatusEnv => ({
  openSubstrate: (path?: string) => openDb(path ?? defaultStateDbPath()),
  stateDbPath: defaultStateDbPath(),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});

const safeCount = (db: Database, sql: string, params: SQLQueryBindings[] = []): number => {
  try {
    return (db.query(sql).get(...params) as { c: number } | null)?.c ?? 0;
  } catch (err) {
    console.error(`substrate-status count failed: ${(err as Error).message}`);
    return Number.NaN;
  }
};

const safeScalar = <T = unknown>(db: Database, sql: string, params: SQLQueryBindings[] = []): T | null => {
  try {
    return (db.query(sql).get(...params) as T | null) ?? null;
  } catch {
    return null;
  }
};

export type SubstrateStatusReport = {
  dbPath: string;
  events: number;
  actArtifacts: number;
  actArtifactsSeed: number;
  actArtifactsBrain: number;
  vecEvents: number;
  embeddableTotal: number;
  embeddablePending: number;
  nonEmbeddableSkipped: number;
  recipeRows: number;
  knowledgePromoted: number;
  stakeholderState: number;
  directiveInterference: number;
  // Health-metric counts (final substrate-wide unification pass). These
  // are emitted by the substrate's own workers; surfacing their counts
  // here gives the operator a one-screen view of whether the substrate
  // is silently degrading (dispatcher violations) or producing real-
  // world side effects (irreversible_effect_recorded) without having to
  // grep the ledger.
  //
  // The set is the registry's `HEALTH_METRIC_KINDS` derivation
  // (`substrate/event_kinds.ts`). The named fields below are convenience
  // accessors backed by `healthMetricCounts` — adding a new health-
  // metric kind to the registry surfaces its count automatically through
  // the generic map without needing a new named field.
  healthMetricCounts: Record<string, number>;
  dispatcherViolations: number;
  irreversibleEffects: number;
  workerTickOverruns: number;
  latestEventTs: string | null;
  latestArtifactTs: string | null;
  oldestUnembeddedTs: string | null;
  verdict: "ALIVE" | "DEGRADED" | "DEAD";
};

export const computeSubstrateStatus = (
  db: Database,
  dbPath: string,
): SubstrateStatusReport => {
  // Best-effort: ensure views exist so the count queries don't fail on
  // a partially-bootstrapped DB. runViews is idempotent.
  try { runViews(db); } catch { /* tolerable for read-only diagnostics */ }

  const events = safeCount(db, "SELECT COUNT(*) AS c FROM events");
  const actArtifacts = safeCount(db, "SELECT COUNT(*) AS c FROM act_artifact");
  // 2026-05-19 (brain 198YWW39K94KH2ZQ1A7XHP2T8R): substrate-primitive
  // rows live under state_root LIKE 'substrate/primitive/%' and register
  // at their canonical action_artifact_id (NOT the legacy seed_ prefix)
  // so the credit pipeline can update their Beta posterior. They are
  // substrate-seeded, not brain-authored, and must count toward the
  // 'seed' bucket.
  // 2026-05-20: threshold-registry seeds (commit ae6d869) and 2026-research
  // integration predicates (commit a750bbb) admit under state_root LIKE
  // 'substrate/threshold/%' (canonical threshold id form
  // `threshold_<name>`). They are substrate-seeded too — same rationale.
  const actArtifactsSeed = safeCount(
    db,
    "SELECT COUNT(*) AS c FROM act_artifact WHERE id LIKE 'seed_%' OR name LIKE 'seed_%' OR state_root LIKE 'substrate/primitive/%' OR state_root LIKE 'substrate/threshold/%'",
  );
  const actArtifactsBrain = Math.max(0, actArtifacts - actArtifactsSeed);

  const placeholders = EMBEDDABLE_KINDS.map(() => "?").join(", ");
  const vecEvents = safeCount(db, "SELECT COUNT(*) AS c FROM vec_events");
  const embeddablePending = safeCount(
    db,
    `SELECT COUNT(*) AS c FROM events WHERE kind IN (${placeholders}) AND embedding IS NULL`,
    [...EMBEDDABLE_KINDS] as SQLQueryBindings[],
  );
  const embeddableTotal = vecEvents + embeddablePending;
  const nonEmbeddableSkipped = safeCount(
    db,
    "SELECT COUNT(*) AS c FROM events WHERE embedding IS NOT NULL AND length(embedding) = 0",
  );

  const recipeRows = safeCount(
    db,
    `SELECT COUNT(*) AS c FROM events
     WHERE kind IN ('knowledge_candidate', 'knowledge_promoted')
       AND COALESCE(
         json_extract(payload, '$.recipe_shape.enabled'),
         json_extract(payload, '$.recipe.enabled'),
         json_extract(payload, '$.is_recipe'),
         0
       ) IN (1, 'true')`,
  );
  const knowledgePromoted = safeCount(
    db,
    "SELECT COUNT(*) AS c FROM events WHERE kind = 'knowledge_promoted'",
  );
  const stakeholderState = safeCount(
    db,
    "SELECT COUNT(*) AS c FROM events WHERE kind = 'stakeholder_state_recorded'",
  );
  const directiveInterference = safeCount(
    db,
    "SELECT COUNT(*) AS c FROM events WHERE kind = 'directive_interference_edge'",
  );

  // Health-metric counters — one safeCount per registry-declared
  // health-metric kind. Adding a kind with `health_metric: true` in
  // `substrate/event_kinds.ts` extends this map automatically; the
  // renderer iterates the same set so no second list to keep in sync.
  const healthMetricCounts: Record<string, number> = {};
  for (const kind of HEALTH_METRIC_KINDS) {
    // 2026-05-23 event-class tiering: live rows + RETAINED evicted count.
    // EPHEMERAL_TELEMETRY_KINDS rows are purged from the hot ledger after a
    // short TTL, but their lifetime count is preserved in meta so this
    // health metric still reports the true cumulative total rather than
    // silently shrinking after each eviction sweep. retainedEvictedCount is
    // 0 for non-evicted kinds, so the addition is a no-op for them.
    healthMetricCounts[kind] =
      safeCount(db, "SELECT COUNT(*) AS c FROM events WHERE kind = ?", [kind]) +
      retainedEvictedCount(db, kind);
  }
  const dispatcherViolations = healthMetricCounts.dispatcher_violation ?? 0;
  const irreversibleEffects = healthMetricCounts.irreversible_effect_recorded ?? 0;
  const workerTickOverruns = healthMetricCounts.worker_tick_overrun ?? 0;

  const latestEvent = safeScalar<{ ts: string }>(
    db,
    "SELECT ts FROM events ORDER BY ts DESC LIMIT 1",
  );
  const latestArtifact = safeScalar<{ ts: string }>(
    db,
    "SELECT updated_at AS ts FROM act_artifact ORDER BY updated_at DESC LIMIT 1",
  );
  const oldestUnembedded = safeScalar<{ ts: string }>(
    db,
    `SELECT ts FROM events
     WHERE embedding IS NULL AND kind IN (${placeholders})
     ORDER BY ts ASC LIMIT 1`,
    [...EMBEDDABLE_KINDS] as SQLQueryBindings[],
  );

  // Verdict computation is centralised in `substrate/liveness.ts` so
  // `acc doctor` and `acc admin substrate-status` cannot drift apart on
  // what counts as ALIVE / DEGRADED / DEAD. The count fields above stay
  // local to substrate-status' renderer (operator-facing format), but
  // the verdict numeric thresholds live in the liveness contract.
  const verdict = computeLivenessReport(db).verdict;

  return {
    dbPath,
    events,
    actArtifacts,
    actArtifactsSeed,
    actArtifactsBrain,
    vecEvents,
    embeddableTotal,
    embeddablePending,
    nonEmbeddableSkipped,
    recipeRows,
    knowledgePromoted,
    stakeholderState,
    directiveInterference,
    healthMetricCounts,
    dispatcherViolations,
    irreversibleEffects,
    workerTickOverruns,
    latestEventTs: latestEvent?.ts ?? null,
    latestArtifactTs: latestArtifact?.ts ?? null,
    oldestUnembeddedTs: oldestUnembedded?.ts ?? null,
    verdict,
  };
};

const fmt = (n: number, width = 0): string => {
  const s = String(n);
  return width > 0 ? s.padStart(width) : s;
};

export const renderSubstrateStatus = (
  report: SubstrateStatusReport,
  out: (line: string) => void,
): void => {
  out(`acc2 substrate status — ${report.dbPath}`);
  out("─".repeat(50));
  out(`events:                     ${fmt(report.events)}`);
  out(
    `act_artifact:               ${fmt(report.actArtifacts)}   ` +
      `(${report.actArtifactsSeed} seed, ${report.actArtifactsBrain} brain-authored)`,
  );
  out(
    `retrieval index:            ${fmt(report.vecEvents)} embedded, ` +
      `${fmt(report.embeddablePending)} pending, ` +
      `${fmt(report.nonEmbeddableSkipped)} non-embeddable (skipped)`,
  );
  out(
    `vec_events:                 ${fmt(report.vecEvents)}   ` +
      `(embedded / ${report.embeddableTotal} genuinely embeddable)`,
  );
  out(`recipe-shape knowledge:     ${fmt(report.recipeRows)}`);
  out(`knowledge_promoted:         ${fmt(report.knowledgePromoted)}`);
  out(`stakeholder_state:          ${fmt(report.stakeholderState)}`);
  out(`directive_interference:     ${fmt(report.directiveInterference)}`);
  out("─".repeat(50));
  out("health metrics:");
  // Iterate the report's healthMetricCounts so adding a new
  // `health_metric: true` kind to the registry surfaces here
  // automatically. Width pads to the longest registry kind so the
  // column stays aligned as the set grows.
  const labelWidth = Math.max(
    ...Object.keys(report.healthMetricCounts).map((k) => k.length),
    1,
  );
  for (const [kind, count] of Object.entries(report.healthMetricCounts)) {
    out(`  ${(kind + ":").padEnd(labelWidth + 2)} ${fmt(count)}`);
  }
  out("─".repeat(50));
  out("freshness:");
  out(`  latest_event_ts:          ${report.latestEventTs ?? "(none)"}`);
  out(`  latest_artifact_ts:       ${report.latestArtifactTs ?? "(none)"}`);
  out(
    `  oldest_unembedded_event:  ${report.oldestUnembeddedTs ?? "all embedded"}`,
  );
  out("─".repeat(50));
  out(`verdict: ${report.verdict}`);
};

export const runSubstrateStatus = async (
  _argv: string[],
  envOverride?: SubstrateStatusEnv,
): Promise<number> => {
  const env: SubstrateStatusEnv = { ...defaultEnv(), ...(envOverride ?? {}) };
  let db: Database;
  const path = env.stateDbPath ?? defaultStateDbPath();
  try {
    db = (env.openSubstrate ?? ((p?: string) => openDb(p ?? defaultStateDbPath())))(path);
  } catch (err) {
    env.err(
      `acc admin substrate-status: failed to open substrate: ${(err as Error).message}`,
    );
    return 1;
  }
  const report = computeSubstrateStatus(db, path);
  renderSubstrateStatus(report, env.out);
  return 0;
};

if (import.meta.main) {
  void runSubstrateStatus(process.argv.slice(2)).then((code) => process.exit(code));
}
