// acc2 Batch 5 universal-goal pilot — fixture_d_research_summary (Architecture.md).
//
// Goal shape: produce a short summary of a small text corpus, then verify the
// summary length lives in a reasonable window AND every required keyword
// appears. Mirrors §10.3's "synthesize_claim" leaf under the mock bridge.

import type { Database } from "bun:sqlite";
import { emitEvent } from "./../events";
import { newId } from "./../ids";
import { FIXTURE_RESEARCH_SUMMARY_MARKER } from "./../bridge";
import type { JsonValue } from "./../../substrate/types";

export type OpenFixtureResearchSummaryResult = {
  directiveId: string;
  taskId: string;
};

export const FIXTURE_RESEARCH_SUMMARY_DIRECTIVE_TEXT =
  `Read a short text corpus and produce a concise extractive summary that `
  + `references every required keyword. The verifier accepts a summary between `
  + `40 and 1200 characters that contains each keyword. ${FIXTURE_RESEARCH_SUMMARY_MARKER}`;

/** Open the fixture_d_research_summary directive plus its root task node. */
export const openFixtureResearchSummary = async (
  db: Database,
): Promise<OpenFixtureResearchSummaryResult> => {
  const directiveId = newId();
  const taskId = newId();

  emitEvent(db, {
    kind: "directive_opened",
    substrate_origin: "owner",
    directive_id: directiveId,
    task_id: directiveId,
    payload: {
      directive_text: FIXTURE_RESEARCH_SUMMARY_DIRECTIVE_TEXT,
      fixture: "fixture_d_research_summary",
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
      goal: FIXTURE_RESEARCH_SUMMARY_DIRECTIVE_TEXT,
      lifecycle: "finite",
      urgency: "normal",
    } as JsonValue,
  });

  return { directiveId, taskId };
};
