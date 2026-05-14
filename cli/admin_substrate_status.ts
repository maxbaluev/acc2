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
//   - ALIVE     — events > 0 AND code_artifact > 0 AND vec_events > 0
//                 (foundational seed + artifact seed + embedder ran)
//   - DEGRADED  — events > 0 but at least one of (code_artifact, vec_events) == 0
//                 (something seeded; embedder didn't run, or artifacts not seeded)
//   - DEAD      — events == 0 (fresh install, or substrate dropped)
//
// Read-only. Idempotent. Hermetic against the daemon (we open SQLite
// directly with `mode=ro`) so calling this while the daemon is up
// won't race writes.

import type { Database } from "bun:sqlite";
import { openDb } from "../substrate/db";
import { runViews } from "../substrate/views";
import { resolveDbPath } from "../runtime/state_paths";
import { join } from "node:path";

export type SubstrateStatusEnv = {
  openSubstrate?: (path?: string) => Database;
  stateDbPath?: string;
  out: (line: string) => void;
  err: (line: string) => void;
};

const defaultStateDbPath = (): string => {
  const repoRoot = join(import.meta.dirname ?? ".", "..");
  return resolveDbPath(repoRoot);
};

const defaultEnv = (): SubstrateStatusEnv => ({
  openSubstrate: (path?: string) => openDb(path ?? defaultStateDbPath()),
  stateDbPath: defaultStateDbPath(),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});

const EMBEDDABLE_KINDS = [
  "directive_opened",
  "directive_amended",
  "task_node_opened",
  "knowledge_candidate",
  "knowledge_promoted",
  "code_artifact_candidate",
  "code_artifact_admitted",
  "owner_input_received",
  "owner_decision_recorded",
  "external_event_received",
  "action_predicted",
  "action_scored",
];

const safeCount = (db: Database, sql: string, params: unknown[] = []): number => {
  try {
    return (db.query(sql).get(...params) as { c: number } | null)?.c ?? 0;
  } catch {
    return 0;
  }
};

const safeScalar = <T = unknown>(db: Database, sql: string, params: unknown[] = []): T | null => {
  try {
    return (db.query(sql).get(...params) as T | null) ?? null;
  } catch {
    return null;
  }
};

export type SubstrateStatusReport = {
  dbPath: string;
  events: number;
  codeArtifacts: number;
  codeArtifactsSeed: number;
  codeArtifactsBrain: number;
  vecEvents: number;
  embeddableTotal: number;
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
  const codeArtifacts = safeCount(db, "SELECT COUNT(*) AS c FROM code_artifact");
  const codeArtifactsSeed = safeCount(
    db,
    "SELECT COUNT(*) AS c FROM code_artifact WHERE id LIKE 'seed_%'",
  );
  const codeArtifactsBrain = Math.max(0, codeArtifacts - codeArtifactsSeed);
  const vecEvents = safeCount(db, "SELECT COUNT(*) AS c FROM vec_events");

  const placeholders = EMBEDDABLE_KINDS.map(() => "?").join(", ");
  const embeddableTotal = safeCount(
    db,
    `SELECT COUNT(*) AS c FROM events WHERE kind IN (${placeholders})`,
    EMBEDDABLE_KINDS,
  );

  const recipeRows = safeCount(
    db,
    "SELECT COUNT(*) AS c FROM events WHERE kind = 'recipe_extracted'",
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
  const dispatcherViolations = safeCount(
    db,
    "SELECT COUNT(*) AS c FROM events WHERE kind = 'dispatcher_violation'",
  );
  const irreversibleEffects = safeCount(
    db,
    "SELECT COUNT(*) AS c FROM events WHERE kind = 'irreversible_effect_recorded'",
  );
  const workerTickOverruns = safeCount(
    db,
    "SELECT COUNT(*) AS c FROM events WHERE kind = 'worker_tick_overrun'",
  );

  const latestEvent = safeScalar<{ ts: string }>(
    db,
    "SELECT ts FROM events ORDER BY ts DESC LIMIT 1",
  );
  const latestArtifact = safeScalar<{ ts: string }>(
    db,
    "SELECT updated_at AS ts FROM code_artifact ORDER BY updated_at DESC LIMIT 1",
  );
  const oldestUnembedded = safeScalar<{ ts: string }>(
    db,
    `SELECT ts FROM events
     WHERE embedding IS NULL AND kind IN (${placeholders})
     ORDER BY ts ASC LIMIT 1`,
    EMBEDDABLE_KINDS,
  );

  let verdict: SubstrateStatusReport["verdict"] = "ALIVE";
  if (events === 0) verdict = "DEAD";
  else if (codeArtifacts === 0 || vecEvents === 0) verdict = "DEGRADED";

  return {
    dbPath,
    events,
    codeArtifacts,
    codeArtifactsSeed,
    codeArtifactsBrain,
    vecEvents,
    embeddableTotal,
    recipeRows,
    knowledgePromoted,
    stakeholderState,
    directiveInterference,
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
    `code_artifact:              ${fmt(report.codeArtifacts)}   ` +
      `(${report.codeArtifactsSeed} seed, ${report.codeArtifactsBrain} brain-authored)`,
  );
  out(
    `vec_events:                 ${fmt(report.vecEvents)}   ` +
      `(embedded / ${report.embeddableTotal} total embeddable)`,
  );
  out(`recipe_extracted (events):  ${fmt(report.recipeRows)}`);
  out(`knowledge_promoted:         ${fmt(report.knowledgePromoted)}`);
  out(`stakeholder_state:          ${fmt(report.stakeholderState)}`);
  out(`directive_interference:     ${fmt(report.directiveInterference)}`);
  out("─".repeat(50));
  out("health metrics:");
  out(`  dispatcher_violation:     ${fmt(report.dispatcherViolations)}`);
  out(`  irreversible_effect:      ${fmt(report.irreversibleEffects)}`);
  out(`  worker_tick_overrun:      ${fmt(report.workerTickOverruns)}`);
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
