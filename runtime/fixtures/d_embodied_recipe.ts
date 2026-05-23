// acc2 Batch 5 universal-goal pilot — fixture_d_embodied_recipe (Architecture.md).
//
// Goal shape: turn an unordered ingredients list into an ordered, non-empty
// step list where every step references at least one ingredient. Mirrors
// §10.7's "diagnose → acquire → repair" embodied DAG, collapsed to the
// list-construction leaf under the mock bridge.

import type { Database } from "bun:sqlite";
import { emitEvent } from "./../events";
import { newId } from "./../ids";
import { FIXTURE_EMBODIED_RECIPE_MARKER } from "./../bridge";
import type { JsonValue } from "./../../substrate/types";

export type OpenFixtureEmbodiedRecipeResult = {
  directiveId: string;
  taskId: string;
};

export const FIXTURE_EMBODIED_RECIPE_DIRECTIVE_TEXT =
  `Convert an ingredients list into an ordered recipe step list. Every step `
  + `must be non-empty AND reference at least one ingredient by name. `
  + `${FIXTURE_EMBODIED_RECIPE_MARKER}`;

/** Open the fixture_d_embodied_recipe directive plus its root task node. */
export const openFixtureEmbodiedRecipe = async (
  db: Database,
): Promise<OpenFixtureEmbodiedRecipeResult> => {
  const directiveId = newId();
  const taskId = newId();

  emitEvent(db, {
    kind: "directive_opened",
    substrate_origin: "owner",
    directive_id: directiveId,
    task_id: directiveId,
    payload: {
      directive_text: FIXTURE_EMBODIED_RECIPE_DIRECTIVE_TEXT,
      fixture: "fixture_d_embodied_recipe",
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
      goal: FIXTURE_EMBODIED_RECIPE_DIRECTIVE_TEXT,
      lifecycle: "finite",
      urgency: "normal",
    } as JsonValue,
  });

  return { directiveId, taskId };
};
