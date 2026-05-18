// Restart quiescence: refuse new brain dispatches while existing ones
// are still in flight, then wait for them to close cleanly. Used at
// daemon shutdown so a restart does NOT kill working brain subprocesses.
//
// Cites:
//   - 19CE0N2RT11D (smallest reload design — git-HEAD-triggered restart
//     quiescence: stop new brain lanes, wait for token-keyed
//     brain_dispatched to close, then swap).
//   - XA3ABKERHD4H (session-token-stable reload — refuse or delay code
//     reload while brain_dispatched events lack matching
//     brain_dispatch_closed).
//
// The poll is a simple loop over `getOpenBrainDispatches(db)` with a
// bounded budget. Production daemon calls this from `stop()` before the
// MCP server tears down — once the loop returns `quiescent`, the
// shutdown is safe to proceed without orphaning brain work.

import type { Database } from "bun:sqlite";
import { getOpenBrainDispatches, type OpenBrainDispatch } from "./brain_dispatch_reconciler";

export type QuiescenceOptions = {
  /** Total budget (ms) before the loop gives up and returns `timeout`.
   *  Default 5 minutes — generous margin above the default opencode
   *  per-dispatch timeout so a single dispatch can drain cleanly. */
  budgetMs?: number;
  /** Poll interval (ms). Default 500ms — small enough that operator-felt
   *  shutdown latency is bounded by the budget, large enough that the
   *  DB read pressure is negligible. */
  pollIntervalMs?: number;
  /** Override Date.now() for tests. */
  nowMs?: () => number;
  /** Override sleep for tests (defaults to setTimeout). */
  sleep?: (ms: number) => Promise<void>;
};

export type QuiescenceResult =
  | {
      status: "quiescent";
      waited_ms: number;
      open_count_initial: number;
      open_count_final: 0;
    }
  | {
      status: "timeout";
      waited_ms: number;
      open_count_initial: number;
      open_count_final: number;
      still_open: OpenBrainDispatch[];
    };

const DEFAULT_BUDGET_MS = 5 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 500;

const sleepImpl = (ms: number): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, ms); });

/** Poll `getOpenBrainDispatches(db)` until the open set is empty or the
 *  budget is exhausted. Returns `quiescent` when the open count reaches
 *  zero (a new dispatch is safe to spawn), `timeout` when the budget
 *  runs out (the shutdown should proceed but the remaining dispatches
 *  will be reconciled at the next boot via
 *  `reconcileBrainDispatchesAtBoot`).
 *
 *  The function does NOT enforce the "refuse new dispatches" half of
 *  the contract — that lives in the scheduler's `setSchedulerDraining`
 *  surface. This helper only owns the WAIT half so it can be reused by
 *  any code path that needs to observe quiescence (shutdown, hot
 *  reload, integrity sweep). */
export const waitForBrainQuiescence = async (
  db: Database,
  opts: QuiescenceOptions = {},
): Promise<QuiescenceResult> => {
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const now = opts.nowMs ?? (() => Date.now());
  const sleep = opts.sleep ?? sleepImpl;
  const startedAtMs = now();
  const initial = getOpenBrainDispatches(db);
  const initialCount = initial.length;
  if (initialCount === 0) {
    return {
      status: "quiescent",
      waited_ms: 0,
      open_count_initial: 0,
      open_count_final: 0,
    };
  }
  while (true) {
    const elapsed = now() - startedAtMs;
    if (elapsed >= budgetMs) {
      const stillOpen = getOpenBrainDispatches(db);
      return {
        status: "timeout",
        waited_ms: elapsed,
        open_count_initial: initialCount,
        open_count_final: stillOpen.length,
        still_open: stillOpen,
      };
    }
    const remaining = budgetMs - elapsed;
    await sleep(Math.min(pollIntervalMs, remaining));
    const current = getOpenBrainDispatches(db);
    if (current.length === 0) {
      return {
        status: "quiescent",
        waited_ms: now() - startedAtMs,
        open_count_initial: initialCount,
        open_count_final: 0,
      };
    }
  }
};
