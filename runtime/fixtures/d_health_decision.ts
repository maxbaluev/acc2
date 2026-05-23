// acc2 Batch 5 universal-goal pilot — fixture_d_health_decision (Architecture.md).
//
// Goal shape: given a symptom list, recommend an over-the-counter remedy
// citing a knowledge entry AND including the canonical "consult a clinician"
// safety disclaimer. Mirrors §10.6's "summarize options for owner" leaf;
// the verifier enforces that a knowledge citation + safety note are both
// present so the recommendation cannot regress to unanchored claims.

import type { Database } from "bun:sqlite";
import { emitEvent } from "./../events";
import { newId } from "./../ids";
import { FIXTURE_HEALTH_DECISION_MARKER } from "./../bridge";
import type { JsonValue } from "./../../substrate/types";

export type OpenFixtureHealthDecisionResult = {
  directiveId: string;
  taskId: string;
};

export const FIXTURE_HEALTH_DECISION_DIRECTIVE_TEXT =
  `Given a short symptom list, recommend one suitable over-the-counter remedy. `
  + `The recommendation MUST cite the knowledge entry that informed it (via a `
  + `non-empty citation_knowledge_id field) AND include the safety disclaimer `
  + `"consult a clinician" if symptoms persist or worsen. ${FIXTURE_HEALTH_DECISION_MARKER}`;

/** Open the fixture_d_health_decision directive plus its root task node. */
export const openFixtureHealthDecision = async (
  db: Database,
): Promise<OpenFixtureHealthDecisionResult> => {
  const directiveId = newId();
  const taskId = newId();

  emitEvent(db, {
    kind: "directive_opened",
    substrate_origin: "owner",
    directive_id: directiveId,
    task_id: directiveId,
    payload: {
      directive_text: FIXTURE_HEALTH_DECISION_DIRECTIVE_TEXT,
      fixture: "fixture_d_health_decision",
      lifecycle: "finite",
    } as JsonValue,
  });

  emitEvent(db, {
    kind: "task_node_opened",
    substrate_origin: "owner",
    directive_id: directiveId,
    task_id: taskId,
    parent_task_id: null,
    payload: {
      goal: FIXTURE_HEALTH_DECISION_DIRECTIVE_TEXT,
      lifecycle: "finite",
      urgency: "normal",
    } as JsonValue,
  });

  return { directiveId, taskId };
};
