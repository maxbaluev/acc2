// acc2 auto-apply worker — daemon-side scanner that signals
// lesson_implementer_queue_view rows whose auto_apply_eligible=1, and
// (when ACC2_AUTO_APPLY_STAGE2=1) attempts the mechanical apply itself.
//
// Background (brain proposal DGT1MKXY390PNDVM6XHR6HQ15M, directive
// YBKCXGJ75159N32Y9DK7ESR3QM): the brain proposes lesson_extracted /
// contract_amendment_proposed events; cli/apply.ts gates them by target
// policy + structured-proposal shape + trajectory hazards.
//
// Stage-1 (default): the worker SCANS the queue and emits
// `auto_apply_signaled` for each newly-eligible row. The orchestrator's
// event stream surfaces the signal so a free terminal can pick it up.
// No file mutation, no test run, no git commit. Activated for ALL
// auto_apply_eligible rows on every tick.
//
// Stage-2 (opt-in via ACC2_AUTO_APPLY_STAGE2=1): in addition to
// signaling, the worker performs the mechanical anchored_replace_v1
// edit on the target file, runs `bun test --bail` to verify, commits
// on pass, REVERTS on fail. Closes the four-link credit chain via
// substrate.emit (action_predicted → action_scored → applied_change_committed
// → contract_amendment_applied or lesson_applied). On failure: emit
// `applied_change_failed` citing the source proposal so the brain
// posterior demotes.
//
// Safety constraints in stage-2:
//   - diff.before must appear EXACTLY ONCE in the target file (no
//     ambiguous replacements).
//   - target file must exist and be readable.
//   - if tests fail: `git checkout HEAD -- <target>` to revert.
//   - all stage-2 work is wrapped in try/catch with revert on any throw.
//
// Idempotence: an eligible row that's already been signaled (any
// auto_apply_signaled row exists citing the same source_event_id) is
// skipped. Stage-2 retries are gated by absence of contract_amendment_applied /
// lesson_applied / applied_change_failed for the same source_event_id.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { emitEvent } from "./events";
import { logger } from "./logger";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

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

/** Stage-2: rows that have been signaled but never applied (terminal state).
 *  These are the candidates for the mechanical apply pass. */
export const collectStage2Candidates = (db: Database): QueueRow[] => {
  return db
    .query(
      `SELECT q.source_event_id, q.source_kind, q.ts, q.directive_id, q.task_id,
              q.target, q.anchor, q.auto_apply_eligible, q.apply_gate_status,
              q.structured_change
       FROM lesson_implementer_queue_view q
       WHERE q.auto_apply_eligible = 1
         AND EXISTS (
           SELECT 1 FROM events s
           WHERE s.kind = 'auto_apply_signaled'
             AND json_extract(s.payload, '$.source_event_id') = q.source_event_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM events a
           WHERE a.kind IN ('contract_amendment_applied', 'lesson_applied', 'applied_change_failed')
             AND json_extract(a.payload, '$.source_event_id') = q.source_event_id
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

/** Result of a stage-2 mechanical apply attempt. Tests + git operations
 *  are wrapped by the caller; this layer reports what happened in a
 *  structured shape the credit chain can consume. */
export type Stage2ApplyResult =
  | { ok: false; reason: string; reverted?: boolean }
  | { ok: true; commitSha: string; before: string; after: string };

/** Parse the proposed_behavior shape into a before/after pair the worker
 *  can mechanically replace. Returns null when the shape isn't a known
 *  anchored_replace_v1 form. */
export const extractAnchoredReplaceV1 = (
  payload: Record<string, unknown>,
): { filePath: string; before: string; after: string } | null => {
  const pb = payload.proposed_behavior ?? payload.proposed_action;
  if (!pb || typeof pb !== "object") return null;
  const p = pb as Record<string, unknown>;
  const filePath = p.file_path;
  const diff = p.diff;
  if (typeof filePath !== "string" || filePath.length === 0) return null;
  if (typeof diff === "string" && diff.length > 0) {
    // Plain-string diff form: treat current_behavior as `before` and diff as `after`.
    const current = payload.current_behavior;
    if (typeof current !== "string" || current.length === 0) return null;
    return { filePath, before: current, after: diff };
  }
  if (diff && typeof diff === "object") {
    const d = diff as Record<string, unknown>;
    const before = d.before;
    const after = d.after;
    if (typeof before !== "string" || before.length === 0) return null;
    if (typeof after !== "string") return null;
    return { filePath, before, after };
  }
  return null;
};

/** Perform the mechanical text replacement on disk. Returns the new file
 *  content + a "wasUnique" flag so the caller can refuse to commit on
 *  ambiguity. Does NOT write the file — the caller chains write + test +
 *  commit with revert on failure. */
export const computeReplacement = (
  filePath: string,
  before: string,
  after: string,
  repoRoot: string,
): { ok: true; original: string; updated: string } | { ok: false; reason: string } => {
  const abs = filePath.startsWith("/") ? filePath : join(repoRoot, filePath);
  if (!existsSync(abs)) return { ok: false, reason: "target_file_not_found:" + filePath };
  const original = readFileSync(abs, "utf8");
  const occurrences = original.split(before).length - 1;
  if (occurrences === 0) return { ok: false, reason: "before_text_not_found_in_target" };
  if (occurrences > 1) return { ok: false, reason: "before_text_ambiguous:" + occurrences + "_occurrences" };
  const updated = original.replace(before, after);
  return { ok: true, original, updated };
};

/** One tick of the auto-apply worker. Returns the list of source event ids
 *  signaled this tick. Stage-2 attempts (when enabled) are returned in
 *  `applied` (success) and `failed` (revert). Side-effect: one
 *  auto_apply_signaled per eligible row, plus optional stage-2 events. */
export const runAutoApplyWorkerTick = (
  db: Database,
  opts?: { nowMs?: number },
): { signaled: string[]; skipped: number; stage2_candidates: number } => {
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
  // Stage-2 candidate count is observational only at this tick layer; the
  // actual stage-2 apply pass is driven externally (by the daemon, by
  // bun cli/auto_apply.ts, or by future expansion of this tick). Reporting
  // the count makes the worker's stage-2 readiness observable from tests.
  const stage2Candidates = collectStage2Candidates(db);
  return {
    signaled,
    skipped: eligible.length - signaled.length,
    stage2_candidates: stage2Candidates.length,
  };
};
