// acc directive — operator commands for directive lifecycle management.
//
// Today only `resume` is wired; subcommands grow alongside the supervisor
// + lesson-implementer surfaces. Owner directive 2026-05-15: "system never
// should loose tasks if task explosion" — `resume` is the canonical
// undo for supervisor-quarantined directives.

import { openDb } from "../substrate/db";
import { resolveDbPath } from "../runtime/state_paths";
import { emitEvent } from "../runtime/events";

export const runDirective = async (argv: string[]): Promise<number> => {
  const sub = argv[0];
  if (!sub || sub === "help" || sub === "--help") {
    console.log(
      [
        "acc directive — directive lifecycle operator commands",
        "",
        "Usage:",
        "  acc directive resume <directive_id>",
        "    Lift a supervisor-quarantine (dag_explosion / dispatch_budget_exceeded /",
        "    operator archive). The directive's tasks become eligible for dispatch",
        "    again. Append-only: emits a `directive_resumed` event that flips the",
        "    closedDirectiveIds filter result, no rows are mutated or deleted.",
      ].join("\n"),
    );
    return 0;
  }
  if (sub === "resume") {
    const directiveId = argv[1];
    if (!directiveId) {
      console.error("acc directive resume: missing <directive_id>");
      return 1;
    }
    const dbPath = process.env.ACC2_STATE_DB ?? resolveDbPath();
    let db;
    try { db = openDb(dbPath); } catch (err) {
      console.error(`could not open substrate DB at ${dbPath}: ${(err as Error).message}`);
      return 1;
    }
    // Verify the directive exists AND was previously archived/closed.
    const row = db
      .query(
        `SELECT kind FROM events
         WHERE directive_id = ?
           AND kind IN ('directive_closed', 'directive_archived_by_operator', 'directive_archived_missed_reviews')
         ORDER BY ts DESC LIMIT 1`,
      )
      .get(directiveId) as { kind: string } | null;
    if (!row) {
      console.error(`directive ${directiveId} is not currently archived/closed; nothing to resume.`);
      return 1;
    }
    emitEvent(db, {
      kind: "directive_resumed",
      substrate_origin: "owner",
      directive_id: directiveId,
      payload: {
        prior_state: row.kind,
        resumed_at: new Date().toISOString(),
      },
    });
    console.log(`directive ${directiveId} resumed (prior state: ${row.kind}).`);
    console.log("its tasks are now eligible for dispatch on the next scheduler tick.");
    return 0;
  }
  console.error(`acc directive: unknown subcommand '${sub}'. expected: resume`);
  return 1;
};
