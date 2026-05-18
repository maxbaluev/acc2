#!/usr/bin/env bun
// acc2 rerun: feed the original v9 substrate body from event
// NA9XCQ41YH1013MSTK1DVE9H9W back through the predicate gate so the
// substrate has a fresh predicate_gate_rejected row proving the gate
// fires on real historical data — not just synthetic test fixtures.
//
// The brain emitted the v9 candidate at 2026-05-18T20:00:28Z under
// audience=ceo_buyer with 19887 chars of body. Manual scan during
// the same session caught 7 "the system" hits + several other banned
// phrases; the gate logged nothing. After today's emit-side wiring
// the same body fed back through emitEvent should land both the
// candidate (under a synthetic rerun directive) and one or more
// predicate_gate_rejected events alongside it.

import { Database } from "bun:sqlite";
import { resolveDbPath } from "../runtime/state_paths";
import { emitEvent } from "../runtime/events";
import { runPredicateGate } from "../runtime/verifiers/predicate_gate";

const SOURCE_EVENT_ID = "NA9XCQ41YH1013MSTK1DVE9H9W";

const dbPath = process.env.ACC2_DB_PATH ?? resolveDbPath();
const db = new Database(dbPath);

const source = db
  .query<{ payload: string }, [string]>("SELECT payload FROM events WHERE id = ?")
  .get(SOURCE_EVENT_ID);

if (!source) {
  process.stderr.write(`rerun_v9_predicate_gate: source event ${SOURCE_EVENT_ID} not found in ${dbPath}\n`);
  process.exit(2);
}

let payload: Record<string, unknown>;
try {
  payload = JSON.parse(source.payload) as Record<string, unknown>;
} catch (err) {
  process.stderr.write(`rerun_v9_predicate_gate: source payload malformed: ${String(err)}\n`);
  process.exit(2);
}

if (typeof payload.body !== "string" || payload.body.length === 0) {
  process.stderr.write("rerun_v9_predicate_gate: source payload has no body\n");
  process.exit(2);
}

const body = payload.body as string;
const audience = typeof payload.audience === "string" ? payload.audience : "ceo_buyer";
const name = typeof payload.name === "string" ? payload.name : "lakeland_industries_ai_transformation_report_v9";
const kind = typeof payload.kind === "string" ? payload.kind : "atms_report_v9";
const citedKnowledgeIds = Array.isArray(payload.cited_knowledge_ids)
  ? (payload.cited_knowledge_ids as unknown[]).filter((v): v is string => typeof v === "string")
  : [];

// Dry-scan first so the operator sees the structural hit count without
// requiring a downstream subscriber to read the new event row.
const gateResult = runPredicateGate(db, { audience, body });
process.stdout.write(
  `rerun_v9_predicate_gate: dry-scan audience=${audience} hits=${gateResult.matches.length} rejected=${gateResult.rejected}\n`,
);
for (const m of gateResult.matches.slice(0, 12)) {
  process.stdout.write(
    `  hit kc_id=${m.kc_id} matched=${JSON.stringify(m.matched_text)} ctx=${JSON.stringify(m.surrounding_context.slice(0, 60))}\n`,
  );
}

// Now feed the body back through emitEvent so the new screen on the
// code_artifact_candidate emit path actually emits a fresh
// predicate_gate_rejected row referencing the new candidate's id.
// The rerun directive isolates the new event from any live directive.
const directiveId = "d_rerun_v9_predicate_" + Date.now();
const emitted = emitEvent(db, {
  kind: "code_artifact_candidate",
  substrate_origin: "substrate_auto",
  directive_id: directiveId,
  task_id: directiveId,
  payload: {
    kind,
    name,
    audience,
    body,
    cited_knowledge_ids: citedKnowledgeIds,
    source_event_id: SOURCE_EVENT_ID,
    rerun: true,
    rerun_reason: "validate_predicate_gate_emission_on_historical_body",
  },
});
process.stdout.write(`rerun_v9_predicate_gate: candidate event emitted id=${emitted.id} directive=${directiveId}\n`);

const refusalRows = db
  .query<{ id: string; kind: string }, [string]>(
    `SELECT id, kind FROM events
      WHERE context_refs LIKE ?
        AND kind IN ('predicate_gate_rejected','atms_strategy_first_violation','lane_routing_refused')
      ORDER BY ts ASC`,
  )
  .all(`%${emitted.id}%`);

process.stdout.write(`rerun_v9_predicate_gate: ${refusalRows.length} refusal event(s) emitted alongside the candidate\n`);
for (const r of refusalRows) {
  process.stdout.write(`  refusal id=${r.id} kind=${r.kind}\n`);
}

db.close();
