#!/usr/bin/env bun
// acc2 audit: pending contract_amendment_proposed events that have
// sat for ≥ 24h without an `applied_change_committed` event citing
// the proposal as source. Output is one row per stuck proposal so an
// operator can sweep them manually (decline / re-route / mark stale).
//
// Detection: an applied_change_committed counts as "citing" the
// proposal when its payload.source_event_id or any context_ref
// matches the proposal's id. Both surfaces are inspected because the
// historical event stream uses each interchangeably.

import { Database } from "bun:sqlite";
import { resolveDbPath } from "../runtime/state_paths";

type ProposalRow = {
  id: string;
  ts: string;
  directive_id: string | null;
  task_id: string | null;
  payload: string;
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const dbPath = process.env.ACC2_DB_PATH ?? resolveDbPath();
const db = new Database(dbPath, { readonly: true });

const proposalRows = db
  .query<ProposalRow, []>(
    `SELECT id, ts, directive_id, task_id, payload
       FROM events
      WHERE kind = 'contract_amendment_proposed'
      ORDER BY ts ASC`,
  )
  .all();

const now = Date.now();
const stuck: Array<{
  id: string;
  ageHours: number;
  targetResource: string | null;
  summary: string | null;
  hasTargetFiles: boolean;
  hasPredicate: boolean;
}> = [];

for (const row of proposalRows) {
  const ageMs = now - Date.parse(row.ts);
  if (ageMs < ONE_DAY_MS) continue;

  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(row.payload ?? "{}") as Record<string, unknown>; }
  catch { /* malformed payload still counts as stuck */ }

  const targetFiles = payload.target_files;
  const hasTargetFiles = Array.isArray(targetFiles) && targetFiles.length > 0;
  const hasPredicate = typeof payload.predicate === "string" && payload.predicate.length > 0;

  // Look for any applied_change_committed event that names this
  // proposal id either as source_event_id, source_amendment_id, or
  // anywhere inside context_refs. The third surface is a JSON-encoded
  // array stored in events.context_refs, so we LIKE-match the id.
  const applied = db
    .query<{ n: number }, [string, string, string, string]>(
      `SELECT COUNT(*) AS n FROM events
        WHERE kind = 'applied_change_committed'
          AND (json_extract(payload, '$.source_event_id') = ?
            OR json_extract(payload, '$.source_amendment_id') = ?
            OR json_extract(payload, '$.amendment_event_id') = ?
            OR context_refs LIKE ?)`,
    )
    .get(row.id, row.id, row.id, `%${row.id}%`);
  if ((applied?.n ?? 0) > 0) continue;

  const targetResource =
    typeof payload.target_resource === "string"
      ? payload.target_resource
      : typeof payload.resource_uri === "string"
        ? payload.resource_uri
        : null;
  const summary =
    typeof payload.title === "string"
      ? payload.title
      : typeof payload.summary === "string"
        ? payload.summary
        : typeof payload.current_behavior === "string"
          ? (payload.current_behavior as string).slice(0, 80)
          : null;

  stuck.push({
    id: row.id,
    ageHours: Math.round(ageMs / (60 * 60 * 1000)),
    targetResource,
    summary,
    hasTargetFiles,
    hasPredicate,
  });
}

if (stuck.length === 0) {
  process.stdout.write("audit_pending_contracts: no stuck proposals (none older than 24h without an applied_change_committed citing the id)\n");
  process.exit(0);
}

process.stdout.write(`audit_pending_contracts: ${stuck.length} stuck proposal(s) ≥ 24h without applied_change_committed citing source\n\n`);
for (const s of stuck) {
  const flags = [
    s.hasTargetFiles ? "target_files=yes" : "target_files=no",
    s.hasPredicate ? "predicate=yes" : "predicate=no",
  ].join(" ");
  process.stdout.write(
    `  id=${s.id}  age=${s.ageHours}h  ${flags}  target=${s.targetResource ?? "(none)"}  summary=${s.summary ?? "(none)"}\n`,
  );
}
process.stdout.write("\n");

db.close();
