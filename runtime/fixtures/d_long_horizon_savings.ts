// acc2 Batch 5 universal-goal pilot — fixture_d_long_horizon_savings (v2-design.md §10.8).
//
// Goal shape: given a savings target, a horizon in months, and an optional
// annual rate, compute the monthly contribution required to reach the target.
// The verifier accepts plans whose monthly × months total covers the target
// within +5% tolerance. Mirrors §10.8's "monthly_review → six_month_assessment"
// long-horizon shape under the mock bridge.

import type { Database } from "bun:sqlite";
import { emitEvent } from "./../events";
import { newId } from "./../ids";
import { FIXTURE_LONG_HORIZON_SAVINGS_MARKER } from "./../bridge";
import type { JsonValue } from "./../../substrate/types";

export type OpenFixtureLongHorizonSavingsResult = {
  directiveId: string;
  taskId: string;
};

export const FIXTURE_LONG_HORIZON_SAVINGS_DIRECTIVE_TEXT =
  `Compute a monthly savings plan that reaches a numeric target within a `
  + `declared number of months. The verifier accepts plans whose total `
  + `(monthly × months) covers the target without overshooting more than 5%. `
  + `${FIXTURE_LONG_HORIZON_SAVINGS_MARKER}`;

/** Open the fixture_d_long_horizon_savings directive plus its root task node. */
export const openFixtureLongHorizonSavings = async (
  db: Database,
): Promise<OpenFixtureLongHorizonSavingsResult> => {
  const directiveId = newId();
  const taskId = newId();

  emitEvent(db, {
    kind: "directive_opened",
    substrate_origin: "owner",
    directive_id: directiveId,
    task_id: directiveId,
    payload: {
      directive_text: FIXTURE_LONG_HORIZON_SAVINGS_DIRECTIVE_TEXT,
      fixture: "fixture_d_long_horizon_savings",
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
      goal: FIXTURE_LONG_HORIZON_SAVINGS_DIRECTIVE_TEXT,
      lifecycle: "finite",
      urgency: "normal",
    } as JsonValue,
  });

  return { directiveId, taskId };
};
