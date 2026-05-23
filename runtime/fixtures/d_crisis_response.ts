// acc2 Batch 5 universal-goal pilot — fixture_d_crisis_response (Architecture.md).
//
// Goal shape: emit an emergency-mode directive (urgency="crisis") whose
// initial task produces a triage step list. The fixture exercises crisis-mode
// engagement (raised scheduler concurrency, suspended LATM authoring, halved
// timeouts) by emitting `crisis_mode_engaged` at directive open time. The
// verifier checks the triage list is non-empty AND that the urgency field
// stamped on the result envelope is "crisis".

import type { Database } from "bun:sqlite";
import { emitEvent } from "./../events";
import { newId } from "./../ids";
import { FIXTURE_CRISIS_RESPONSE_MARKER } from "./../bridge";
import type { JsonValue } from "./../../substrate/types";

export type OpenFixtureCrisisResponseResult = {
  directiveId: string;
  taskId: string;
};

export const FIXTURE_CRISIS_RESPONSE_DIRECTIVE_TEXT =
  `Crisis: a production login service is unreachable for customers. Emit a `
  + `triage plan (at least three concrete steps) so the incident can be `
  + `diagnosed and recovered. ${FIXTURE_CRISIS_RESPONSE_MARKER}`;

/** Open the fixture_d_crisis_response directive plus its root task node.
 *  Emits `crisis_mode_engaged` alongside `directive_opened` so observers
 *  (scheduler, dispatch decider, Father) can subscribe to the transition. */
export const openFixtureCrisisResponse = async (
  db: Database,
): Promise<OpenFixtureCrisisResponseResult> => {
  const directiveId = newId();
  const taskId = newId();

  emitEvent(db, {
    kind: "directive_opened",
    substrate_origin: "owner",
    directive_id: directiveId,
    task_id: directiveId,
    payload: {
      directive_text: FIXTURE_CRISIS_RESPONSE_DIRECTIVE_TEXT,
      fixture: "fixture_d_crisis_response",
      lifecycle: "finite",
      urgency: "crisis",
    } as JsonValue,
  });

  // The crisis-mode marker — runtime/crisis_mode.ts reads urgency="crisis"
  // from directive_opened; this companion event makes the transition
  // observable to subscribers that watch the kind index rather than parse
  // every directive_opened payload.
  emitEvent(db, {
    kind: "crisis_mode_engaged",
    substrate_origin: "substrate_auto",
    directive_id: directiveId,
    payload: {
      reason: "directive_urgency_crisis",
      fixture: "fixture_d_crisis_response",
    } as JsonValue,
  });

  emitEvent(db, {
    kind: "task_node_opened",
    substrate_origin: "owner",
    directive_id: directiveId,
    task_id: taskId,
    parent_task_id: null,
    payload: {
      goal: FIXTURE_CRISIS_RESPONSE_DIRECTIVE_TEXT,
      lifecycle: "finite",
      urgency: "crisis",
    } as JsonValue,
  });

  return { directiveId, taskId };
};
