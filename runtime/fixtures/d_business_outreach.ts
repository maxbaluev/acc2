// acc2 Batch 5 universal-goal pilot — fixture_d_business_outreach (Architecture.md).
//
// Goal shape: compose a personalized outreach email to a single recipient and
// write the body to a tempfile. The verifier checks file existence + body
// content + subject non-empty. Mirrors the §10.2 DAG's "compose_emails →
// send_emails" leaf shape, scaled down to one recipient under the mock bridge.

import type { Database } from "bun:sqlite";
import { emitEvent } from "./../events";
import { newId } from "./../ids";
import { FIXTURE_BUSINESS_OUTREACH_MARKER } from "./../bridge";
import type { JsonValue } from "./../../substrate/types";

export type OpenFixtureBusinessOutreachResult = {
  directiveId: string;
  taskId: string;
};

export const FIXTURE_BUSINESS_OUTREACH_DIRECTIVE_TEXT =
  `Compose a personalized outreach email to a single named recipient with a clear `
  + `subject line and a short opener; write the email body to a tempfile so a `
  + `downstream send step can pick it up. ${FIXTURE_BUSINESS_OUTREACH_MARKER}`;

/** Open the fixture_d_business_outreach directive plus its root task node. */
export const openFixtureBusinessOutreach = async (
  db: Database,
): Promise<OpenFixtureBusinessOutreachResult> => {
  const directiveId = newId();
  const taskId = newId();

  emitEvent(db, {
    kind: "directive_opened",
    substrate_origin: "owner",
    directive_id: directiveId,
    task_id: directiveId,
    payload: {
      directive_text: FIXTURE_BUSINESS_OUTREACH_DIRECTIVE_TEXT,
      fixture: "fixture_d_business_outreach",
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
      goal: FIXTURE_BUSINESS_OUTREACH_DIRECTIVE_TEXT,
      lifecycle: "finite",
      urgency: "normal",
    } as JsonValue,
  });

  return { directiveId, taskId };
};
