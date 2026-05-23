// acc2 Batch 5 universal-goal pilot — fixture_d_multi_stakeholder (Architecture.md).
//
// Goal shape: pick a single value (the "decision") that lies inside every
// stakeholder's declared utility window [low, high]. Verifier checks the
// chosen value is inside EVERY window. Mirrors §10.5's "synthesize with
// conflict check" leaf under the mock bridge.

import type { Database } from "bun:sqlite";
import { emitEvent } from "./../events";
import { newId } from "./../ids";
import { FIXTURE_MULTI_STAKEHOLDER_MARKER } from "./../bridge";
import type { JsonValue } from "./../../substrate/types";

export type OpenFixtureMultiStakeholderResult = {
  directiveId: string;
  taskId: string;
};

export const FIXTURE_MULTI_STAKEHOLDER_DIRECTIVE_TEXT =
  `Propose a single numeric value that lives inside every named stakeholder's `
  + `[low, high] utility window. The verifier accepts the proposal only when the `
  + `value sits inside EVERY stakeholder's window. ${FIXTURE_MULTI_STAKEHOLDER_MARKER}`;

/** Open the fixture_d_multi_stakeholder directive plus its root task node. */
export const openFixtureMultiStakeholder = async (
  db: Database,
): Promise<OpenFixtureMultiStakeholderResult> => {
  const directiveId = newId();
  const taskId = newId();

  emitEvent(db, {
    kind: "directive_opened",
    substrate_origin: "owner",
    directive_id: directiveId,
    task_id: directiveId,
    payload: {
      directive_text: FIXTURE_MULTI_STAKEHOLDER_DIRECTIVE_TEXT,
      fixture: "fixture_d_multi_stakeholder",
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
      goal: FIXTURE_MULTI_STAKEHOLDER_DIRECTIVE_TEXT,
      lifecycle: "finite",
      urgency: "normal",
    } as JsonValue,
  });

  return { directiveId, taskId };
};
