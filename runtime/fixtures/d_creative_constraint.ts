// acc2 Batch 5 universal-goal pilot — fixture_d_creative_constraint (Architecture.md).
//
// Goal shape: produce a haiku (three lines of 5-7-5 syllables) on the supplied
// subject. The verifier counts syllables per line via a deterministic
// vowel-group heuristic. Mirrors §10.4's "draft → revise → finalize" leaf
// under the mock bridge, collapsed to one cycle.

import type { Database } from "bun:sqlite";
import { emitEvent } from "./../events";
import { newId } from "./../ids";
import { FIXTURE_CREATIVE_CONSTRAINT_MARKER } from "./../bridge";
import type { JsonValue } from "./../../substrate/types";

export type OpenFixtureCreativeConstraintResult = {
  directiveId: string;
  taskId: string;
};

export const FIXTURE_CREATIVE_CONSTRAINT_DIRECTIVE_TEXT =
  `Compose a three-line haiku in the classical 5-7-5 syllable structure on the `
  + `supplied subject. The verifier counts syllables per line — five for line one, `
  + `seven for line two, five for line three. ${FIXTURE_CREATIVE_CONSTRAINT_MARKER}`;

/** Open the fixture_d_creative_constraint directive plus its root task node. */
export const openFixtureCreativeConstraint = async (
  db: Database,
): Promise<OpenFixtureCreativeConstraintResult> => {
  const directiveId = newId();
  const taskId = newId();

  emitEvent(db, {
    kind: "directive_opened",
    substrate_origin: "owner",
    directive_id: directiveId,
    task_id: directiveId,
    payload: {
      directive_text: FIXTURE_CREATIVE_CONSTRAINT_DIRECTIVE_TEXT,
      fixture: "fixture_d_creative_constraint",
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
      goal: FIXTURE_CREATIVE_CONSTRAINT_DIRECTIVE_TEXT,
      lifecycle: "finite",
      urgency: "normal",
    } as JsonValue,
  });

  return { directiveId, taskId };
};
