// `acc admin pending-decisions [--json]` — owner-decision inbox.
//
// The orchestrator-runtime contract says: "Surface pending owner decisions
// last. When unresolved … owner-gated contract_amendment_proposed … remain,
// end the turn with a concise decision card." Until this CLI existed there
// was no canonical query — the orchestrator's stub readPendingDecisions in
// cli/watch.ts returned []. This is the structural surface that closes the
// gap.
//
// Source: lesson_implementer_queue_view (substrate/views.ts:861). One row
// per pending lesson_extracted / contract_amendment_proposed with computed
// owner_gate_verdict and apply_status. We filter to rows that:
//   - have owner_gate_verdict = 'owner_consent_required' (gate is real)
//   - are not yet applied (apply_status != 'applied' / 'committed')
//
// Usage:
//   acc admin pending-decisions             # human table
//   acc admin pending-decisions --json      # JSON for orchestrator polling

import type { Database } from "bun:sqlite";
import { openDb } from "../substrate/db";
import { lessonImplementerQueue, runViews, type LessonImplementerQueueRow } from "../substrate/views";
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

const renderHuman = (
  rows: LessonImplementerQueueRow[],
  out: (s: string) => void,
): void => {
  if (rows.length === 0) {
    out("pending owner decisions: none (substrate has no owner-gated, unapplied proposals)");
    return;
  }
  out("acc admin pending-decisions — owner-gated proposals from substrate (lesson_implementer_queue_view)");
  out("");
  out("  age   source                          target                                                anchor");
  out("  ───── ─────────────────────────────── ───────────────────────────────────────────────────── ───────────────────────────────");
  for (const r of rows) {
    const age = formatAge(ageMs(r.ts)).padEnd(5);
    const src = (r.source_event_id ?? "").slice(0, 31).padEnd(31);
    const target = (r.target ?? "?").slice(0, 53).padEnd(53);
    const anchor = (r.anchor ?? "-").slice(0, 31);
    out(`  ${age} ${src} ${target} ${anchor}`);
  }
  out("");
  out(`${rows.length} pending owner decision${rows.length === 1 ? "" : "s"}. Each is a contract_amendment_proposed or lesson_extracted that touches a protected target.`);
};

export const runPendingDecisions = async (
  argv: string[],
  envOverride?: PendingDecisionsEnv,
): Promise<number> => {
  const env: PendingDecisionsEnv = { ...defaultEnv(), ...(envOverride ?? {}) };
  const wantJson = argv.includes("--json");

  let db: Database;
  const path = env.stateDbPath ?? defaultStateDbPath();
  try {
    db = (env.openSubstrate ?? ((p?: string) => openDb(p ?? defaultStateDbPath())))(path);
  } catch (err) {
    env.err(`acc admin pending-decisions: failed to open substrate: ${(err as Error).message}`);
    return 1;
  }

  runViews(db);
  const rows = selectPendingDecisions(lessonImplementerQueue(db));

  if (wantJson) {
    env.out(
      JSON.stringify(
        rows.map((r) => ({
          source_event_id: r.source_event_id,
          ts: r.ts,
          source_kind: r.source_kind,
          target: r.target,
          anchor: r.anchor,
          owner_gate_verdict: r.owner_gate_verdict,
          apply_status: r.apply_status,
          auto_apply_eligible: r.auto_apply_eligible,
          directive_id: r.directive_id,
          task_id: r.task_id,
        })),
        null,
        2,
      ),
    );
  } else {
    renderHuman(rows, env.out);
  }
  return 0;
};

if (import.meta.main) {
  void runPendingDecisions(process.argv.slice(2)).then((code) => process.exit(code));
}
