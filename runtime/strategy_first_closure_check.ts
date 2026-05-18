// acc2 strategy-first closure predicate (C3, 2026-05-18, directive
// QHTRBV6PFX2JVBMHDNDA4B03GC).
//
// Substrate-side helper that mirrors the artifact-admission strategy-first
// gate at closure-audit time. When a directive emits any
// `code_artifact_candidate` whose payload.name (or payload.purpose)
// starts with `atms_report_v`, the closure verifier MUST observe:
//
//   1. ≥ 15 `task_node_opened` events under the directive — proxy for a
//      multi-layer S/T/U/V DAG (situation deep-dives → strategy
//      synthesis → initiative selection → report composition). Reports
//      v1-v3 emitted ~3-5 nodes total; v6 emitted ≥ 15.
//   2. EVERY atms_report_v* candidate's cited_knowledge_ids includes at
//      least one knowledge_candidate whose payload.claim ends with
//      `_strategic_direction_chosen` — same anchor as admission.
//
// Either failure forces `closure_residual = max(current, 0.3)` and surfaces
// a diagnostic. Callers integrate this on the closure-audit emit path
// (mirrors how `closure_deliverable_check.ts` is composed by the
// closure verifier wrapper).
//
// Cites lesson 4JGQAN7NFH1XH9M4VARB4RNJ8M
// `strategic_first_then_initiatives_lesson` — admitted but advisory
// before this commit.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { STRATEGIC_DIRECTION_CHOSEN_SUFFIX, findStrategicDirectionCitation } from "./artifact_admission";

const MIN_TASK_NODE_OPENED_FOR_ATMS_REPORT = 15;
const FLOOR_CLOSURE_RESIDUAL_ON_VIOLATION = 0.3;

export type StrategyFirstClosureDiagnostic =
  | { reason: "task_node_opened_below_minimum"; observed: number; required: number }
  | {
      reason: "atms_report_missing_strategic_direction_chosen_citation";
      artifact_event_id: string;
      artifact_name: string;
      cited_knowledge_ids: string[];
    };

export interface StrategyFirstClosureResult {
  ok: boolean;
  enforced_residual: number;
  diagnostics: StrategyFirstClosureDiagnostic[];
  atms_report_event_ids: string[];
  task_node_opened_count: number;
}

const parsePayload = (raw: string | null | undefined): Record<string, JsonValue> => {
  try { return JSON.parse(raw ?? "{}") as Record<string, JsonValue>; }
  catch { return {}; }
};

const stringArray = (v: JsonValue | undefined): string[] => {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) if (typeof item === "string" && item.length > 0) out.push(item);
  return out;
};

/** Inspect a directive's event stream against the strategy-first closure
 *  predicate. `currentResidual` is the closure verifier's existing
 *  scalar; the helper raises it to the violation floor when either rule
 *  fails. */
export const checkStrategyFirstClosure = (
  db: Database,
  directiveId: string,
  currentResidual: number,
): StrategyFirstClosureResult => {
  // 1. Collect every atms_report_v* code_artifact_candidate under the
  //    directive. The artifact "kind" lives in payload.name OR
  //    payload.purpose — both are how the bridge tags the candidate
  //    today; we accept either to stay schema-tolerant.
  const candidateRows = db
    .query<{ id: string; payload: string }, [string]>(
      "SELECT id, payload FROM events WHERE directive_id = ? AND kind = 'code_artifact_candidate'",
    )
    .all(directiveId);
  const atmsReportCandidates: Array<{
    id: string;
    name: string;
    cited_knowledge_ids: string[];
  }> = [];
  for (const row of candidateRows) {
    const payload = parsePayload(row.payload);
    const name = typeof payload.name === "string"
      ? payload.name
      : (typeof payload.purpose === "string" ? payload.purpose : null);
    if (!name || !name.startsWith("atms_report_v")) continue;
    atmsReportCandidates.push({
      id: row.id,
      name,
      cited_knowledge_ids: stringArray(payload.cited_knowledge_ids),
    });
  }

  // If no atms_report_v* candidate appears, the predicate is N/A and
  // the helper is a no-op pass-through. Callers can pre-filter by
  // checking `atms_report_event_ids.length === 0` before consulting the
  // diagnostics array.
  const nodeOpenedCount = (
    db
      .query<{ c: number }, [string]>(
        "SELECT COUNT(*) AS c FROM events WHERE directive_id = ? AND kind = 'task_node_opened'",
      )
      .get(directiveId) ?? { c: 0 }
  ).c;

  if (atmsReportCandidates.length === 0) {
    return {
      ok: true,
      enforced_residual: currentResidual,
      diagnostics: [],
      atms_report_event_ids: [],
      task_node_opened_count: nodeOpenedCount,
    };
  }

  const diagnostics: StrategyFirstClosureDiagnostic[] = [];

  // 2. Task-node-opened minimum. A report directive that produced only
  //    3-5 nodes did not run the S/T/U/V DAG shape and is structurally
  //    a "initiative-first" cycle, regardless of citation.
  if (nodeOpenedCount < MIN_TASK_NODE_OPENED_FOR_ATMS_REPORT) {
    diagnostics.push({
      reason: "task_node_opened_below_minimum",
      observed: nodeOpenedCount,
      required: MIN_TASK_NODE_OPENED_FOR_ATMS_REPORT,
    });
  }

  // 3. Every atms_report_v* candidate must cite a strategic-direction-
  //    chosen knowledge_candidate. We re-use the admission lookup so
  //    admission and closure agree (no English regex on claim text;
  //    structural suffix match against payload.claim).
  for (const cand of atmsReportCandidates) {
    const citation = findStrategicDirectionCitation(db, cand.cited_knowledge_ids);
    if (!citation.ok) {
      diagnostics.push({
        reason: "atms_report_missing_strategic_direction_chosen_citation",
        artifact_event_id: cand.id,
        artifact_name: cand.name,
        cited_knowledge_ids: cand.cited_knowledge_ids,
      });
    }
  }

  const ok = diagnostics.length === 0;
  const enforcedResidual = ok
    ? currentResidual
    : Math.max(currentResidual, FLOOR_CLOSURE_RESIDUAL_ON_VIOLATION);

  return {
    ok,
    enforced_residual: enforcedResidual,
    diagnostics,
    atms_report_event_ids: atmsReportCandidates.map((c) => c.id),
    task_node_opened_count: nodeOpenedCount,
  };
};

export {
  MIN_TASK_NODE_OPENED_FOR_ATMS_REPORT,
  FLOOR_CLOSURE_RESIDUAL_ON_VIOLATION,
  STRATEGIC_DIRECTION_CHOSEN_SUFFIX,
};
