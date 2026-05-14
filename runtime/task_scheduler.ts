// acc2 task scheduler — picks ready tasks and dispatches them
// (v2-design.md §9.1).
//
// Phase D scope:
//   - Sequential, max 1 concurrent dispatch.
//   - Read readyTasks; dispatch the first; return the tick summary.
//
// Phase E adds:
//   - Real concurrency (multiple ready tasks dispatched in parallel up to a
//     configurable cap).
//   - Recipe-replay short-circuit before bridge call.
//   - Inline-lane short-circuit when the dispatch decider routes to claude.

import type { Database } from "bun:sqlite";
import { readyTasks } from "./task_topology";
import { dispatchReadyTask } from "./task_dispatcher";
import { decideDispatch } from "./dispatch_decider";

export type SchedulerTick = {
  dispatched: string[];
  skipped_recipe: string[];
  skipped_inline: string[];
};

export type SchedulerTickOptions = {
  maxConcurrent?: number;
  directiveId?: string;
  /** Optional fixture path threaded into the dispatcher — only used by the
   *  Phase D fixture test to point the bun grep at a deterministic dir. */
  fixtureTargetPath?: string;
};

/** Single tick: pick up to `maxConcurrent` ready tasks and dispatch them.
 *  Phase D runs sequentially with max=1 so the audit trail is linear. */
export const schedulerTick = async (
  db: Database,
  opts: SchedulerTickOptions = {},
): Promise<SchedulerTick> => {
  const max = Math.max(1, opts.maxConcurrent ?? 1);
  const ready = readyTasks(db, opts.directiveId);

  const dispatched: string[] = [];
  const skippedRecipe: string[] = [];
  const skippedInline: string[] = [];

  for (const task of ready.slice(0, max)) {
    // Phase D: scheduler does NOT short-circuit recipe / inline routes itself.
    // The dispatcher reads decideDispatch and emits a route audit; that
    // matches §9.1's design (scheduler picks readiness, dispatcher picks lane).
    // We DO expose what would-be-skipped lanes look like in the tick summary
    // so Phase E can light them up without rewiring the surface.
    const peekDecision = decideDispatch(db, task);
    if (peekDecision.route === "substrate_replay") {
      skippedRecipe.push(task.id);
    } else if (peekDecision.route === "claude_inline") {
      skippedInline.push(task.id);
    }
    await dispatchReadyTask(db, task, { fixtureTargetPath: opts.fixtureTargetPath });
    dispatched.push(task.id);
  }

  return { dispatched, skipped_recipe: skippedRecipe, skipped_inline: skippedInline };
};
