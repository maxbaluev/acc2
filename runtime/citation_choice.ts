// acc2 F6 completion — citation choice wrap (decision 12).
//
// The substrate's citation selection is itself a scored decision: each
// composePrompt picks WHICH retrieval hits land in the RETRIEVED
// KNOWLEDGE section, and that choice gates the brain's ability to
// cite-as-mutation (k_554). Until this wrap landed, only the
// downstream retrieval_binding projection rewarded citation outcomes —
// the SELECTOR's reliability was invisible to credit. This file
// records one act per selection batch so the selector earns or loses
// posterior independently of any one cited entry's outcome.
//
// Verifier handle = retrieval_binding_credit_closure: the credit chain
// closes when the brain emits a downstream action that cites at least
// one of the selected entries AND the action scores succeed. The
// retrieval_binding rows already produce those signals; the meta-act
// here just gives them a target action_handle to credit.
//
// Predicted residual 0.2 — citation selection is generally low-risk
// (the reranker is itself a scored substrate). The wrap follows the
// F6 convention of higher confidence on low-risk decisions.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { recordInternalAct } from "./internal_act_projection";
import type { EmittedEvent } from "./events";

const stableHash = (input: string): string => {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
};

export type CitationChoiceActParams = {
  /** The event ids the composer chose to cite this cycle. Used both
   *  for projection-key derivation (deterministic per selection) and
   *  to seed citedKnowledgeIds on the act so the retrieval_binding
   *  projection chains directly to this meta-act. */
  candidateEventIds: string[];
  /** The directive/task whose prompt this selection feeds. Substrate-
   *  level emission still — directive/task land on payload extras
   *  (associated_*), not as the act_tuple's own directive/task fields. */
  directiveId?: string;
  taskId?: string;
  /** Where in the composer this fired — e.g. "retrieved_knowledge",
   *  "code_artifact_registry". Open-string; used in the projection
   *  key so different selection points credit independently. */
  selectionPoint?: string;
  /** How many candidates the reranker considered before this slice. */
  candidatePoolSize?: number;
  /** Source event id when the selection traces back to a single
   *  trigger (e.g. compose call event). */
  sourceEventId?: string;
  extra?: { [k: string]: JsonValue };
};

/** Record one act_tuple_recorded row crediting the citation selector
 *  for this batch of citations. Returns null when the envelope is
 *  refused (caller's composePrompt continues regardless — citation
 *  selection failure must never block prompt assembly). */
export const recordCitationChoiceAct = (
  db: Database,
  params: CitationChoiceActParams,
): EmittedEvent | null => {
  const point = params.selectionPoint ?? "retrieved_knowledge";
  const idsKey = [...params.candidateEventIds].sort().join(",");
  const contextHash = stableHash(point + "::" + idsKey);
  const count = params.candidateEventIds.length;
  return recordInternalAct(db, {
    intent: "select citations for prompt",
    actionHandle: "citation_chooser_v1",
    verifierHandle: "retrieval_binding_credit_closure",
    verifierKind: "deterministic_code",
    predictedResidual: 0.2,
    reasoningSummary: `selected ${count} citation(s) at point=${point}`,
    actionSummary: `composer cited ${count} entries in ${point}`,
    effectSummary: `cited ids seed retrieval_binding rows for credit closure`,
    directiveId: params.directiveId,
    taskId: params.taskId,
    sourceEventId: params.sourceEventId,
    sourceActId: "citation_chooser_v1:" + contextHash,
    citedKnowledgeIds: params.candidateEventIds,
    extra: {
      ...(params.extra ?? {}),
      selection_point: point,
      cited_count: count,
      ...(typeof params.candidatePoolSize === "number"
        ? { candidate_pool_size: params.candidatePoolSize }
        : {}),
    },
  });
};
