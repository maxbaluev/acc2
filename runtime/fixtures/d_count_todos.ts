// acc2 Phase D canonical fixture — fixture_d_count_todos.
//
// Per Architecture.md Phase D, the fixture directive says:
//   "Count files in <dir> whose contents contain the substring TODO,
//    return the integer count."
//
// `openFixtureDCountTodos` emits the directive + the root task node so the
// scheduler can pick it up and the dispatcher can run the (mocked) brain
// against it. The bridge mock in runtime/bridge.ts admits the action +
// verifier artifacts and emits action_predicted; the dispatcher runs both
// and emits action_scored + task_committed.
//
// Default target path is `./` from the test's cwd — tests pass an explicit
// tempdir with deterministic TODO fixtures.

import type { Database } from "bun:sqlite";
import { emitEvent } from "./../events";
import { newId } from "./../ids";
import type { JsonValue } from "./../../substrate/types";

export type OpenFixtureDResult = {
  directiveId: string;
  taskId: string;
};

export const FIXTURE_D_DIRECTIVE_TEXT =
  "Count files in the target directory whose contents contain the substring TODO, return the integer count.";

/** Open the fixture_d_count_todos directive plus its root task node.
 *  The scheduler picks the ready task up on its next tick; the dispatcher
 *  then drives the (mocked) brain through admission + action + verifier. */
export const openFixtureDCountTodos = async (
  db: Database,
  targetPath?: string,
): Promise<OpenFixtureDResult> => {
  const directiveId = newId();
  const taskId = newId();

  emitEvent(db, {
    kind: "directive_opened",
    substrate_origin: "owner",
    directive_id: directiveId,
    task_id: directiveId, // root self-references; the task row is separate.
    payload: {
      directive_text: FIXTURE_D_DIRECTIVE_TEXT,
      fixture: "fixture_d_count_todos",
      target_path: targetPath ?? ".",
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
      goal: FIXTURE_D_DIRECTIVE_TEXT,
      lifecycle: "finite",
      urgency: "normal",
      target_path: targetPath ?? ".",
    } as JsonValue,
  });

  return { directiveId, taskId };
};
