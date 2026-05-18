// retrieval_credit.ts — substrate-side auto-attribution for the RLM
// credit loop (Phase I1+I1a, brain knowledge_candidate KZE8EXYFWH7C,
// task FX9PZDQ3W932 RLM_RETRIEVAL_ACTS_MIN_LEAP, 2026-05-18).
//
// Closes the always-on consumer gap (k_88ESCTN8XN6J): retrieval_binding
// events accumulate, action_scored events cite them via context_refs,
// but until something WALKS that join and emits
// retrieval_credit_attributed, the credit ledger stays empty and
// retrieval_credit_view.credit_attributed_count is 0 forever.
//
// Pattern mirrors the rendering_audit_worker (commit 8460d56) but
// fires at write boundary (synchronous from emitEvent) rather than on
// a 5-min timer — credit attribution is deterministic given the
// inputs, so there's no reason to defer it.
//
// Attribution rule (Shapley-style equal weight, polarity from residual):
//   - For each retrieval_binding cited in action_scored.context_refs:
//       contribution_score = 1.0 / N (N = number of cited bindings)
//       polarity           = 'credit' if residual <= 0.3 else 'debit'
//   - Emit retrieval_credit_attributed once per (binding, scored) pair
//     with projection_key = binding_event_id + ':credit:' + scored_event_id
//   - Idempotent: a duplicate emission with the same projection_key is
//     filtered by the deduplicator below (cheap NOT EXISTS check).

import type { Database } from "bun:sqlite";
import { emitEvent } from "./events";

const CREDIT_RESIDUAL_THRESHOLD = 0.3;

export type RetrievalCreditAttribution = {
  retrieval_binding_event_id: string;
  action_scored_event_id: string;
  contribution_score: number;
  polarity: "credit" | "debit";
  residual_at_score: number;
  knowledge_source_event_id: string | null;
  projection_key: string;
};

/** Find retrieval_binding events cited in the given context_refs.
 *  Returns an empty array when no refs or no matching bindings. */
const findCitedRetrievalBindings = (
  db: Database,
  contextRefs: string[],
): Array<{ binding_event_id: string; source_event_id: string | null }> => {
  if (contextRefs.length === 0) return [];
  const placeholders = contextRefs.map(() => "?").join(",");
  const rows = db
    .query(
      `SELECT id, json_extract(payload, '$.source_event_id') AS source_event_id
       FROM events
       WHERE kind = 'retrieval_binding'
         AND id IN (${placeholders})`,
    )
    .all(...contextRefs) as Array<{ id: string; source_event_id: string | null }>;
  return rows.map((r) => ({ binding_event_id: r.id, source_event_id: r.source_event_id ?? null }));
};

/** Check whether a credit attribution row has already been emitted for
 *  this (binding, scored) pair. Idempotency via projection_key. */
const creditAlreadyAttributed = (db: Database, projectionKey: string): boolean => {
  const row = db
    .query(
      `SELECT 1 FROM events
        WHERE kind = 'retrieval_credit_attributed'
          AND json_extract(payload, '$.projection_key') = ?
        LIMIT 1`,
    )
    .get(projectionKey);
  return row !== null;
};

/** Walk action_scored.context_refs for retrieval_bindings and emit one
 *  retrieval_credit_attributed row per binding. Returns the number of
 *  new attributions emitted (0 when no bindings cited or all already
 *  attributed). */
export const attributeRetrievalCredit = (
  db: Database,
  args: {
    scored_event_id: string;
    context_refs: string[];
    residual: number | null | undefined;
    directive_id?: string | null;
    task_id?: string | null;
  },
): number => {
  const bindings = findCitedRetrievalBindings(db, args.context_refs);
  if (bindings.length === 0) return 0;
  const residual = typeof args.residual === "number" ? args.residual : 1.0;
  const polarity: "credit" | "debit" = residual <= CREDIT_RESIDUAL_THRESHOLD ? "credit" : "debit";
  const contributionScore = 1.0 / bindings.length;
  let emitted = 0;
  for (const b of bindings) {
    const projectionKey = `${b.binding_event_id}:credit:${args.scored_event_id}`;
    if (creditAlreadyAttributed(db, projectionKey)) continue;
    try {
      emitEvent(db, {
        kind: "retrieval_credit_attributed",
        substrate_origin: "substrate_auto",
        directive_id: args.directive_id ?? undefined,
        task_id: args.task_id ?? undefined,
        payload: {
          retrieval_binding_event_id: b.binding_event_id,
          action_scored_event_id: args.scored_event_id,
          contribution_score: contributionScore,
          polarity,
          residual_at_score: residual,
          knowledge_source_event_id: b.source_event_id,
          projection_key: projectionKey,
        },
        context_refs: [b.binding_event_id, args.scored_event_id, ...(b.source_event_id ? [b.source_event_id] : [])],
      });
      emitted += 1;
    } catch { /* swallow per-binding error; the others continue */ }
  }
  return emitted;
};
