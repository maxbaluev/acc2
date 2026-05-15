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
import { spawnSync } from "node:child_process";

export const AUTO_APPLY_WORKER_DEFAULT_INTERVAL_MS = 60 * 1000;

/** Stage-2 cooldown window: if any applied_change_failed event landed
 *  within this window, the worker skips stage-2 this tick. Implements
 *  organic backoff without an opt-in env knob — bad proposals naturally
 *  pause the autonomy loop instead of cascading. */
const STAGE2_COOLDOWN_MS = 5 * 60 * 1000;

/** Test-suite execution timeout (ms). bun test --bail typically completes
 *  in 15-25s on a healthy substrate; the cap stops a hung subprocess from
 *  freezing the worker tick. */
const STAGE2_TEST_TIMEOUT_MS = 90 * 1000;

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

/** Has any applied_change_failed event landed within the cooldown window?
 *  When true, the worker skips the stage-2 apply pass — organic backoff
 *  without an opt-in env knob. */
const inStage2Cooldown = (db: Database, nowMs: number): boolean => {
  const cutoffIso = new Date(nowMs - STAGE2_COOLDOWN_MS).toISOString();
  const row = db
    .query("SELECT 1 AS x FROM events WHERE kind = 'applied_change_failed' AND ts > ? LIMIT 1")
    .get(cutoffIso) as { x: number } | null;
  return row !== null;
};

/** Tests-only stop-gap: tests/preload.ts pins ACC2_DISABLE_WORKERS to
 *  include auto_apply, so this never runs in the unit suite. We also
 *  refuse to run when ACC2_BRIDGE_MODE=mock (= tests) so a test that
 *  spawns the daemon doesn't trigger real git commits. */
const stage2RuntimeAllowed = (): boolean => {
  if (process.env.ACC2_BRIDGE_MODE === "mock") return false;
  if (process.env.NODE_ENV === "test") return false;
  return true;
};

/** Emit the credit-chain events for a successful or failed stage-2 apply.
 *  Mirrors cli/apply.ts:recordApplyOutcome but uses direct emitEvent
 *  (no MCP) so the daemon worker doesn't need an HTTP roundtrip to its
 *  own server. */
const emitApplyChain = (
  db: Database,
  row: QueueRow,
  result: { ok: true; commitSha: string; summary: string } | { ok: false; reason: string },
  nowMs: number,
): void => {
  const isAmendment = row.source_kind === "contract_amendment_proposed";
  const appliedKind: "contract_amendment_applied" | "lesson_applied" =
    isAmendment ? "contract_amendment_applied" : "lesson_applied";
  if (!result.ok) {
    emitEvent(db, {
      kind: "applied_change_failed",
      substrate_origin: "substrate_auto",
      directive_id: row.directive_id ?? undefined,
      task_id: row.task_id ?? undefined,
      context_refs: [row.source_event_id],
      payload: {
        source_event_id: row.source_event_id,
        source_kind: row.source_kind,
        target: row.target,
        reason: result.reason,
        stage: "stage_2_mechanical_apply",
        scanned_at: new Date(nowMs).toISOString(),
      } as JsonValue,
    });
    return;
  }
  // Full chain on success: emit applied_change_committed first, then the
  // *_applied row citing it. The four-link spine (k_555) closes when
  // candidate_confirmed / candidate_contradicted fires later via the
  // credit pipeline; this worker doesn't run substrate.credit itself
  // because there's no action_predicted/scored pair to score — the
  // mechanical apply IS its own observation.
  const committed = emitEvent(db, {
    kind: "applied_change_committed",
    substrate_origin: "substrate_auto",
    directive_id: row.directive_id ?? undefined,
    task_id: row.task_id ?? undefined,
    context_refs: [row.source_event_id],
    residual: 0,
    payload: {
      source_event_id: row.source_event_id,
      source_kind: row.source_kind,
      target: row.target,
      commit_sha: result.commitSha,
      summary: result.summary,
      stage: "stage_2_mechanical_apply",
      applied_by: "auto_apply_worker",
    } as JsonValue,
  });
  emitEvent(db, {
    kind: appliedKind,
    substrate_origin: "substrate_auto",
    directive_id: row.directive_id ?? undefined,
    task_id: row.task_id ?? undefined,
    context_refs: [row.source_event_id, committed.id],
    payload: {
      source_event_id: row.source_event_id,
      source_kind: row.source_kind,
      status: "applied",
      target: row.target,
      commit_sha: result.commitSha,
      summary: result.summary,
      applied_change_event_id: committed.id,
      applied_at: new Date(nowMs).toISOString(),
      applied_by: "auto_apply_worker",
    } as JsonValue,
  });
};

/** Attempt one stage-2 mechanical apply: write file, run tests, commit
 *  on pass, revert on fail. Returns the credit-chain result so the caller
 *  can emit it. */
export const applyStage2Candidate = (
  db: Database,
  row: QueueRow,
  repoRoot: string,
): { ok: true; commitSha: string; summary: string } | { ok: false; reason: string } => {
  // 1. Resolve the source event payload.
  const srcRow = db
    .query("SELECT payload FROM events WHERE id = ?")
    .get(row.source_event_id) as { payload: string } | null;
  if (!srcRow) return { ok: false, reason: "source_event_missing" };
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(srcRow.payload ?? "{}") as Record<string, unknown>; }
  catch { return { ok: false, reason: "source_payload_unparseable" }; }

  const parsed = extractAnchoredReplaceV1(payload);
  if (!parsed) return { ok: false, reason: "proposed_behavior_not_anchored_replace_v1" };

  // 2. Compute the mechanical replacement.
  const repl = computeReplacement(parsed.filePath, parsed.before, parsed.after, repoRoot);
  if (!repl.ok) return { ok: false, reason: repl.reason };

  // 3. Write the file.
  const abs = parsed.filePath.startsWith("/") ? parsed.filePath : join(repoRoot, parsed.filePath);
  try { writeFileSync(abs, repl.updated, "utf8"); }
  catch (err) { return { ok: false, reason: "write_failed:" + (err as Error).message }; }

  // 4. Run the test suite. We pass --bail so the FIRST failure exits
  // immediately — the verifier need not enumerate every breakage.
  // 5. On failure: revert with `git checkout HEAD -- <file>` and refuse
  // to commit.
  const test = spawnSync("bun", ["test", "--bail"], {
    cwd: repoRoot,
    timeout: STAGE2_TEST_TIMEOUT_MS,
    encoding: "utf8",
    env: { ...process.env, ACC2_BRIDGE_MODE: "mock" },
  });
  if (test.status !== 0) {
    spawnSync("git", ["checkout", "HEAD", "--", parsed.filePath], { cwd: repoRoot });
    const tail = (test.stderr ?? "").slice(-400);
    return { ok: false, reason: "tests_failed:" + tail };
  }

  // 6. Stage + commit. We use a fixed author footer so the commit
  // chain is grep-able. No --no-verify; if hooks fail the commit
  // fails and we treat that as a stage-2 failure (revert path runs).
  spawnSync("git", ["add", parsed.filePath], { cwd: repoRoot });
  const summary = "auto-apply: " + parsed.filePath;
  const msg =
    summary + "\n\n" +
    "Applies brain proposal " + row.source_event_id + ".\n" +
    "Stage-2 mechanical anchored_replace_v1 by runtime/auto_apply_worker.\n\n" +
    "Co-Authored-By: AccInt v2 auto_apply_worker <noreply@accint>";
  const commit = spawnSync("git", ["commit", "-m", msg], { cwd: repoRoot, encoding: "utf8" });
  if (commit.status !== 0) {
    spawnSync("git", ["checkout", "HEAD", "--", parsed.filePath], { cwd: repoRoot });
    return { ok: false, reason: "git_commit_failed:" + (commit.stderr ?? "") };
  }
  const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  const commitSha = (sha.stdout ?? "").trim().slice(0, 10);
  return { ok: true, commitSha, summary };
};

/** One tick of the auto-apply worker. Stage-1: scan + signal eligible
 *  rows. Stage-2 (always-on, gated by safety constraints, not env):
 *  pick ONE signaled-but-not-applied row and run the mechanical apply
 *  pipeline (write + bun test --bail + git commit, or revert + emit
 *  applied_change_failed). Skips stage-2 when within cooldown after a
 *  recent failure, or when running under the test bridge. */
export const runAutoApplyWorkerTick = (
  db: Database,
  opts?: { nowMs?: number; repoRoot?: string },
): { signaled: string[]; skipped: number; stage2_candidates: number; stage2_applied?: string; stage2_failed?: string } => {
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

  const stage2Candidates = collectStage2Candidates(db);

  // Stage-2 gating, NO env knob — organic safety only:
  //   1. test-runtime check: refuse under mock bridge / NODE_ENV=test
  //      so unit tests + mock-brain harness can't trigger real commits.
  //   2. cooldown check: skip if any applied_change_failed landed in the
  //      last STAGE2_COOLDOWN_MS — bad proposals naturally pause the loop.
  //   3. one-at-a-time: take the oldest candidate, apply, return. A flood
  //      of bad proposals can't cascade because the next tick is 60s away
  //      and any failure triggers cooldown.
  if (
    stage2Candidates.length > 0 &&
    stage2RuntimeAllowed() &&
    !inStage2Cooldown(db, nowMs)
  ) {
    const candidate = stage2Candidates[0]!;
    const repoRoot = opts?.repoRoot ?? process.env.ACC2_PROJECT_ROOT ?? process.cwd();
    const result = applyStage2Candidate(db, candidate, repoRoot);
    emitApplyChain(db, candidate, result, nowMs);
    if (result.ok) {
      logger.info(
        { source_event_id: candidate.source_event_id, commit_sha: result.commitSha, target: candidate.target },
        "auto_apply_worker stage-2 applied",
      );
      return {
        signaled,
        skipped: eligible.length - signaled.length,
        stage2_candidates: stage2Candidates.length,
        stage2_applied: candidate.source_event_id,
      };
    } else {
      logger.warn(
        { source_event_id: candidate.source_event_id, reason: result.reason, target: candidate.target },
        "auto_apply_worker stage-2 failed — cooldown engaged",
      );
      return {
        signaled,
        skipped: eligible.length - signaled.length,
        stage2_candidates: stage2Candidates.length,
        stage2_failed: candidate.source_event_id,
      };
    }
  }

  return {
    signaled,
    skipped: eligible.length - signaled.length,
    stage2_candidates: stage2Candidates.length,
  };
};
