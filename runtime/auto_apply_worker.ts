// acc2 auto-apply worker — daemon-side scanner that signals
// lesson_implementer_queue_view rows whose auto_apply_eligible=1.
//
// Background (brain proposal DGT1MKXY390PNDVM6XHR6HQ15M, directive
// YBKCXGJ75159N32Y9DK7ESR3QM): the brain proposes lesson_extracted /
// contract_amendment_proposed events; cli/apply.ts gates them by target
// policy + structured-proposal shape + trajectory hazards. Today an
// orchestrator (Claude) must MANUALLY run `acc apply <id>` to render the
// subagent prompt + paste into Agent. The auto-apply worker closes that
// loop without orchestrator-side polling.
//
// Stage-1 (this commit): the worker SCANS the queue and emits
// `auto_apply_signaled` for each newly-eligible row. The orchestrator's
// `acc watch` / event stream surfaces the signal so a free terminal can
// pick it up. No file mutation, no test run, no git commit.
//
// Stage-2 (future): the worker performs the mechanical anchored_replace_v1
// edit (find `current_behavior` in target, replace with `proposed_behavior.diff`),
// runs `bun test --bail`, commits, calls recordApplyOutcome to close the
// four-link credit chain. On test failure: revert + emit a contradicted-
// style event citing the source proposal so the brain's posterior demotes.
//
// Idempotence: an eligible row that's already been signaled (any
// auto_apply_signaled row exists citing the same source_event_id) is
// skipped. The signal IS the once-per-eligible-event marker.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { emitEvent } from "./events";
import { logger } from "./logger";

export const AUTO_APPLY_WORKER_DEFAULT_INTERVAL_MS = 60 * 1000;

type QueueRow = {
  source_event_id: string;
  source_kind: string;
  ts: string;
  directive_id: string | null;
  task_id: string | null;
  target: string | null;
  anchor: string | null;
  auto_apply_eligible: number;
  apply_gate_status: string;
  structured_change: number;
};

/** Scan the queue for newly-eligible rows. Returns rows that have NOT yet
 *  been signaled this session (no auto_apply_signaled event exists citing
 *  their source_event_id). Caller-side filter keeps the worker side-effect-
 *  free for tests + introspection. */
export const collectAutoApplyEligible = (db: Database): QueueRow[] => {
  return db
    .query(
      `SELECT q.source_event_id, q.source_kind, q.ts, q.directive_id, q.task_id,
              q.target, q.anchor, q.auto_apply_eligible, q.apply_gate_status,
              q.structured_change
       FROM lesson_implementer_queue_view q
       WHERE q.auto_apply_eligible = 1
         AND NOT EXISTS (
           SELECT 1 FROM events s
           WHERE s.kind = 'auto_apply_signaled'
             AND json_extract(s.payload, '$.source_event_id') = q.source_event_id
         )
       ORDER BY q.ts ASC`,
    )
    .all() as QueueRow[];
};

/** Emit one auto_apply_signaled event for the given queue row. The
 *  orchestrator's poll/watch surface mirrors it inline (event_kinds.ts
 *  mirror_inline: true on the kind itself) so a free terminal sees the
 *  signal without manual polling. */
export const emitAutoApplySignal = (db: Database, row: QueueRow, nowMs: number): string | null => {
  const payload: Record<string, JsonValue> = {
    source_event_id: row.source_event_id,
    source_kind: row.source_kind,
    target: row.target ?? "(none)",
    anchor: row.anchor ?? "",
    structured: row.structured_change === 1,
    scanned_at: new Date(nowMs).toISOString(),
    apply_gate_status: row.apply_gate_status,
    stage: "stage_1_signal_only",
    next_action: "orchestrator should run `acc apply " + row.source_event_id + "` and spawn a subagent",
    // The kind registry stamps mirror_inline on the routing path; carrying
    // the same flag in payload makes payload-only inspection unambiguous
    // for ad-hoc consumers (e.g. acc events --kind auto_apply_signaled).
    mirror_inline: true,
  };
  try {
    const emitted = emitEvent(db, {
      kind: "auto_apply_signaled",
      substrate_origin: "substrate_auto",
      directive_id: row.directive_id ?? undefined,
      task_id: row.task_id ?? undefined,
      context_refs: [row.source_event_id],
      payload: payload as JsonValue,
    });
    return emitted.id;
  } catch (err) {
    logger.warn(
      { where: "auto_apply.signal", source_event_id: row.source_event_id, err: (err as Error).message },
      "could not emit auto_apply_signaled",
    );
    return null;
  }
};

/** One tick of the auto-apply worker. Returns the list of source event ids
 *  signaled this tick. Side-effect: one auto_apply_signaled per eligible row. */
export const runAutoApplyWorkerTick = (
  db: Database,
  opts?: { nowMs?: number },
): { signaled: string[]; skipped: number } => {
  const nowMs = opts?.nowMs ?? Date.now();
  const eligible = collectAutoApplyEligible(db);
  const signaled: string[] = [];
  for (const row of eligible) {
    const eventId = emitAutoApplySignal(db, row, nowMs);
    if (eventId) signaled.push(row.source_event_id);
  }
  if (signaled.length > 0) {
    logger.info(
      { count: signaled.length, sample: signaled.slice(0, 3) },
      "auto_apply_worker signaled eligible rows",
    );
  }
  return { signaled, skipped: eligible.length - signaled.length };
};
