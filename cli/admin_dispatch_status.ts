// `acc admin dispatch-status [<directive_id>] [<root_task_id>]` —
// authoritative dispatch lifecycle read.
//
// Implements the operator + orchestrator-facing surface for the
// dispatch_resolved_view (substrate/views.ts) that the new
// .claude/rules/orchestrator-runtime.md "Dispatch Observation Protocol"
// mandates as the ONLY authoritative source for "is this dispatch done?".
//
// Replaces the ad-hoc `bun -e "...dispatchResolved..."` invocations the
// orchestrator used to write. One-liner CLI; pure read.
//
// Usage:
//   acc admin dispatch-status                       # last 20 rows, all dirs
//   acc admin dispatch-status <directive_id>        # all roots in this directive
//   acc admin dispatch-status <directive_id> <root_task_id>  # one row
//   acc admin dispatch-status --json                # JSON output (machine-readable)

import type { Database } from "bun:sqlite";
import { openDb } from "../substrate/db";
import { dispatchResolved, runViews, type DispatchResolvedRow } from "../substrate/views";
import { resolveDbPath } from "../runtime/state_paths";

type DispatchStatusEnv = {
  out: (s: string) => void;
  err: (s: string) => void;
  stateDbPath?: string;
  openSubstrate?: (path?: string) => Database;
};

const defaultEnv = (): DispatchStatusEnv => ({
  out: (s) => console.log(s),
  err: (s) => console.error(s),
});

const defaultStateDbPath = (): string => resolveDbPath();

const STATUS_GLYPH: Record<string, string> = {
  completed: "✓",
  failed: "✗",
  zombie: "?",
  live: "→",
  queued_at_cap: "⏸",
  unknown: " ",
};

const renderHuman = (rows: DispatchResolvedRow[], out: (s: string) => void): void => {
  if (rows.length === 0) {
    out("dispatch_resolved_view: no rows match (substrate has no matching dispatches)");
    return;
  }
  out("acc admin dispatch-status — authoritative substrate truth per .claude/rules/orchestrator-runtime.md");
  out("");
  out("  status        directive             root                  terminal              latest_signal");
  out("  ───────────── ───────────────────── ───────────────────── ───────────────────── ───────────────────────");
  for (const r of rows) {
    const status = r.lifecycle_status ?? "unknown";
    const glyph = STATUS_GLYPH[status] ?? " ";
    const dir = (r.directive_id ?? "").slice(0, 21).padEnd(21);
    const root = (r.root_task_id ?? "").slice(0, 21).padEnd(21);
    const term = (r.terminal_kind ?? "-").slice(0, 21).padEnd(21);
    const ts = (r.latest_signal_at ?? r.latest_dispatched_at ?? "-").slice(0, 23).padEnd(23);
    out(`  ${glyph} ${status.padEnd(11)} ${dir} ${root} ${term} ${ts}`);
  }
  out("");
  out(`Bash background-task panel may lag. Substrate is authoritative (${rows.length} row${rows.length === 1 ? "" : "s"}).`);
};

export const runDispatchStatus = async (
  argv: string[],
  envOverride?: DispatchStatusEnv,
): Promise<number> => {
  const env: DispatchStatusEnv = { ...defaultEnv(), ...(envOverride ?? {}) };
  const wantJson = argv.includes("--json");
  const positional = argv.filter((a) => !a.startsWith("--"));
  const directiveId = positional[0];
  const rootTaskId = positional[1];

  let db: Database;
  const path = env.stateDbPath ?? defaultStateDbPath();
  try {
    db = (env.openSubstrate ?? ((p?: string) => openDb(p ?? defaultStateDbPath())))(path);
  } catch (err) {
    env.err(`acc admin dispatch-status: failed to open substrate: ${(err as Error).message}`);
    return 1;
  }

  // Idempotent: ensures the view exists even when the caller opens a
  // pre-view DB (the same pattern admin_substrate_status uses).
  runViews(db);

  const rows = dispatchResolved(db, {
    directiveId,
    rootTaskId,
    limit: directiveId || rootTaskId ? undefined : 20,
  });

  if (wantJson) {
    env.out(JSON.stringify(rows, null, 2));
  } else {
    renderHuman(rows, env.out);
  }
  return 0;
};

if (import.meta.main) {
  void runDispatchStatus(process.argv.slice(2)).then((code) => process.exit(code));
}
