// `acc admin pending-decisions` — thin owner-consent inbox.
//
// Semantic amendment apply removed amendment-structure churn from this surface.
// The command shows only proposals with explicit owner consent required and no
// recorded owner decision.

import type { Database } from "bun:sqlite";
import { openDb } from "../substrate/db";
import {
  lessonImplementerQueue,
  pendingOwnerDecisionQueueLive,
  runViews,
  type LessonImplementerQueueRow,
  type PendingOwnerDecisionRow,
} from "../substrate/views";
import { resolveDbPath } from "../runtime/state_paths";

type PendingDecisionsEnv = {
  out: (s: string) => void;
  err: (s: string) => void;
  stateDbPath?: string;
  openSubstrate?: (path?: string) => Database;
};

const defaultEnv = (): PendingDecisionsEnv => ({
  out: (s) => console.log(s),
  err: (s) => console.error(s),
});

const defaultStateDbPath = (): string => resolveDbPath();

export const selectPendingDecisions = (
  rows: LessonImplementerQueueRow[],
): LessonImplementerQueueRow[] =>
  rows.filter(
    (r) =>
      r.owner_gate_verdict === "owner_consent_required" &&
      r.apply_status !== "applied" &&
      r.apply_status !== "committed",
  );

const ageMs = (tsIso: string): number => Date.now() - Date.parse(tsIso);

const formatAge = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h${rem}m`;
};

const pad = (s: string | null, n: number): string =>
  (s ?? "").slice(0, n).padEnd(n);

const renderRanked = (
  rows: PendingOwnerDecisionRow[],
  out: (s: string) => void,
  viewLabel: string = "pending_owner_decision_queue_live_view",
): void => {
  if (rows.length === 0) {
    out(`pending owner decisions: none (${viewLabel} is empty)`);
    return;
  }
  out(`acc admin pending-decisions — ranked groups from ${viewLabel}`);
  out("");
  out("  rank  age    dup risk shape target                                          representative");
  out("  ──── ────── ─── ──── ───── ─────────────────────────────────────────────── ──────────────────────────");
  for (const r of rows) {
    const rank = r.decision_rank.toFixed(2).padStart(4);
    const age = formatAge(ageMs(r.newest_ts)).padEnd(6);
    const dup = String(r.duplicate_count).padStart(3);
    const risk = r.target_risk_score.toFixed(2).padStart(4);
    const shape = r.shape_quality_score.toFixed(2).padStart(5);
    const target = pad(r.target, 47);
    const rep = (r.representative_event_id ?? "").slice(0, 26);
    out(`  ${rank} ${age} ${dup} ${risk} ${shape} ${target} ${rep}`);
  }
  out("");
  out(`${rows.length} pending group${rows.length === 1 ? "" : "s"}.`);
};

const renderAll = (
  rows: LessonImplementerQueueRow[],
  out: (s: string) => void,
): void => {
  if (rows.length === 0) {
    out("pending owner decisions: none (substrate has no owner-gated, unapplied proposals)");
    return;
  }
  out("acc admin pending-decisions --all — raw ungrouped lesson_implementer_queue_view rows");
  out("");
  out("  age   source                          target");
  out("  ───── ─────────────────────────────── ─────────────────────────────────────────────────────");
  for (const r of rows) {
    const age = formatAge(ageMs(r.ts)).padEnd(5);
    const src = pad(r.source_event_id, 31);
    const target = pad(r.target, 53);
    out(`  ${age} ${src} ${target}`);
  }
  out("");
  out(`${rows.length} pending owner decision${rows.length === 1 ? "" : "s"}.`);
};

const parseLimitArg = (argv: string[]): number => {
  const idx = argv.indexOf("--limit");
  if (idx === -1) return 10;
  const v = parseInt(argv[idx + 1] ?? "10", 10);
  return Number.isFinite(v) && v > 0 ? v : 10;
};

const parseTargetArg = (argv: string[]): string | null => {
  const idx = argv.indexOf("--target");
  if (idx === -1) return null;
  return argv[idx + 1] ?? null;
};

export const runPendingDecisions = async (
  argv: string[],
  envOverride?: PendingDecisionsEnv,
): Promise<number> => {
  const env: PendingDecisionsEnv = { ...defaultEnv(), ...(envOverride ?? {}) };
  const wantJson = argv.includes("--json");
  const wantAll = argv.includes("--all");
  const limit = parseLimitArg(argv);
  const targetFilter = parseTargetArg(argv);

  let db: Database;
  const path = env.stateDbPath ?? defaultStateDbPath();
  try {
    db = (env.openSubstrate ?? ((p?: string) => openDb(p ?? defaultStateDbPath())))(path);
  } catch (err) {
    env.err(`acc admin pending-decisions: failed to open substrate: ${(err as Error).message}`);
    return 1;
  }

  runViews(db);

  if (wantAll) {
    const all = selectPendingDecisions(lessonImplementerQueue(db));
    const filtered = targetFilter
      ? all.filter((r) => (r.target ?? "").includes(targetFilter))
      : all;
    if (wantJson) {
      env.out(JSON.stringify(filtered, null, 2));
    } else {
      renderAll(filtered, env.out);
    }
    return 0;
  }

  const ranked = pendingOwnerDecisionQueueLive(db);

  const filtered = targetFilter
    ? ranked.filter((r) => (r.target ?? "").includes(targetFilter))
    : ranked;
  const limited = filtered.slice(0, limit);

  if (wantJson) {
    env.out(JSON.stringify(limited, null, 2));
  } else {
    renderRanked(
      limited,
      env.out,
      "pending_owner_decision_queue_live_view",
    );
    if (filtered.length > limit) {
      env.out("");
      env.out(`(${filtered.length - limit} more rows hidden; pass --limit ${filtered.length} to show all.)`);
    }
  }
  return 0;
};

if (import.meta.main) {
  void runPendingDecisions(process.argv.slice(2)).then((code) => process.exit(code));
}
