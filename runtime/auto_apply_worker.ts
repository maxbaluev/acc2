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
import type { JsonValue, OwnerProfile } from "../substrate/types";
import { OWNER_PROFILE_DEFAULTS } from "../substrate/types";
import { emitEvent } from "./events";
import { logger } from "./logger";
import { readOwnerProfile } from "./prompt_composer";
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

// ── Layer-2 OwnerProfile gate (brain dispatch ZMJQQ963Z124V7VS, 2026-05-15) ──
//
// Stage-2 already enforces structural safety (Layer 1: cli/runtime scope,
// cooldown, test-pass-revert). The OwnerProfile adds owner-driven autonomy
// preferences ON TOP. Layer 2 RESTRICTS within Layer 1 — never widens.
//
// Refusals: emit `auto_apply_signaled` with `payload.reason: "owner_profile_blocked"`
// + the matching field so an operator can see exactly which owner preference
// gated the run. Does NOT proceed to mechanical apply.

/** Very small glob → predicate: supports `*` as "match any characters
 *  (including slashes)" — enough for the common patterns operators write
 *  in `manual_review_patterns` (e.g. `runtime/*.test.ts`, `cli/*`, etc).
 *  Returns true when target matches pattern. */
const matchesGlob = (target: string, pattern: string): boolean => {
  if (!pattern) return false;
  if (!pattern.includes("*")) {
    // No glob metacharacters → substring match (the brief says "substring or glob").
    return target.includes(pattern);
  }
  // Escape regex special chars, then replace `*` with `.*`.
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(target);
};

/** Returns true when "now" falls outside the owner's working hours window.
 *  When no window is configured, returns false (never out-of-window). */
const outsideTimeWindow = (window: OwnerProfile["time_window"], nowMs: number): boolean => {
  if (!window || typeof window !== "object") return false;
  const start = window.start_hour;
  const end = window.end_hour;
  if (typeof start !== "number" || typeof end !== "number") return false;
  // Use UTC hours; tz-aware checks would need a tzdb. Operators can
  // include the tz tag for audit, but the substrate runs UTC.
  const hour = new Date(nowMs).getUTCHours();
  if (start <= end) {
    return hour < start || hour >= end;
  }
  // Window wraps midnight (e.g. 22:00-06:00).
  return hour < start && hour >= end;
};

/** Count file-distinct touches in a proposed anchored_replace_v1. The
 *  current shape is single-file — count is 1 when parse succeeds, 0
 *  otherwise. The hook exists so multi-file shapes (when introduced)
 *  inherit the cautious gate automatically. */
const countTouchedFiles = (payload: Record<string, unknown>): number => {
  // Multi-file shapes the gate must count:
  //   - payload.target_files: ["a.ts", "b.ts"]      (canonical list)
  //   - payload.targets:      ["a.ts", "b.ts"]      (legacy synonym)
  //   - payload.diff:         anchored_replace_v1[] (future array form)
  // Falls back to extractAnchoredReplaceV1 for the canonical single-file
  // diff shape (counted as 1).
  if (Array.isArray(payload.target_files)) {
    return (payload.target_files as unknown[]).filter((x) => typeof x === "string" && x.length > 0).length;
  }
  if (Array.isArray(payload.targets)) {
    return (payload.targets as unknown[]).filter((x) => typeof x === "string" && x.length > 0).length;
  }
  if (Array.isArray(payload.diff)) {
    return (payload.diff as unknown[]).length;
  }
  const parsed = extractAnchoredReplaceV1(payload);
  return parsed ? 1 : 0;
};

export type OwnerProfileGateResult =
  | { gated: false }
  | { gated: true; field: string; matched_pattern?: string; reason: string };

/** Evaluate the Layer-2 OwnerProfile gate against a stage-2 candidate.
 *  Returns `gated: true` when an owner preference refuses the apply;
 *  otherwise `gated: false`. Pure / side-effect-free — the caller emits
 *  any blocking signal. */
export const evaluateOwnerProfileGate = (
  profile: OwnerProfile,
  targetPath: string,
  sourcePayload: Record<string, unknown>,
  nowMs: number,
): OwnerProfileGateResult => {
  // 1. Hard blocks — glob match (unified with manual_review_patterns
  // below). Same matcher means owners only need to learn ONE pattern
  // language, and bare strings like "docs/" still work because
  // matchesGlob falls through to substring when no `*` is present.
  if (Array.isArray(profile.things_to_never_do)) {
    for (const block of profile.things_to_never_do) {
      if (typeof block !== "string" || block.length === 0) continue;
      if (matchesGlob(targetPath, block)) {
        return {
          gated: true,
          field: "things_to_never_do",
          matched_pattern: block,
          reason: `target_matches_things_to_never_do:${block}`,
        };
      }
    }
  }
  // 2. Manual-review patterns — substring or simple glob.
  if (Array.isArray(profile.manual_review_patterns)) {
    for (const pat of profile.manual_review_patterns) {
      if (typeof pat !== "string" || pat.length === 0) continue;
      if (matchesGlob(targetPath, pat)) {
        return {
          gated: true,
          field: "manual_review_patterns",
          matched_pattern: pat,
          reason: `target_matches_manual_review_pattern:${pat}`,
        };
      }
    }
  }
  // 3. Working hours window — outside the window, stage-2 pauses.
  if (outsideTimeWindow(profile.time_window, nowMs)) {
    return {
      gated: true,
      field: "time_window",
      reason: "outside_owner_time_window",
    };
  }
  // 4. Continuous autonomy_score — refuse multi-file diffs when the
  // owner's accumulated trust score is below the multi-file threshold.
  // Universal — no fixed "cautious/normal/high" tiers; the score is
  // owner-specific and substrate-adjusted from outcomes. The effective
  // score honors an optional owner-declared floor.
  const rawScore = typeof profile.autonomy_score === "number"
    ? profile.autonomy_score
    : (OWNER_PROFILE_DEFAULTS.autonomy_score as number);
  const floor = typeof profile.autonomy_score_floor === "number"
    ? profile.autonomy_score_floor
    : 0;
  const effectiveScore = Math.max(rawScore, floor);
  if (effectiveScore < AUTONOMY_MULTI_FILE_THRESHOLD) {
    const touched = countTouchedFiles(sourcePayload);
    if (touched > 1) {
      return {
        gated: true,
        field: "autonomy_score",
        reason: `autonomy_score_below_multi_file_threshold:${effectiveScore.toFixed(2)}<${AUTONOMY_MULTI_FILE_THRESHOLD}:${touched}_files`,
      };
    }
  }
  return { gated: false };
};

/** Multi-file diff threshold. Owners with autonomy_score < 0.4 (the
 *  prior "cautious" tier on the old enum) have multi-file diffs
 *  blocked. Higher-stakes dimensions (irreversible, cross-runtime,
 *  permission-sensitive paths) can use their own thresholds — see
 *  evaluateOwnerProfileGate for the per-dimension gate logic. */
export const AUTONOMY_MULTI_FILE_THRESHOLD = 0.4;

/** Emit one `auto_apply_signaled` event marking a stage-2 candidate as
 *  owner_profile_blocked so an operator sees exactly why the apply did
 *  not proceed. The structural marker (`reason: owner_profile_blocked`)
 *  lets observers filter the queue without re-evaluating the gate. */
const emitOwnerProfileBlock = (
  db: Database,
  row: QueueRow,
  gate: Extract<OwnerProfileGateResult, { gated: true }>,
  nowMs: number,
): void => {
  const payload: Record<string, JsonValue> = {
    source_event_id: row.source_event_id,
    source_kind: row.source_kind,
    target: row.target ?? "(none)",
    anchor: row.anchor ?? "",
    structured: row.structured_change === 1,
    scanned_at: new Date(nowMs).toISOString(),
    apply_gate_status: row.apply_gate_status,
    stage: "stage_2_owner_profile_block",
    reason: "owner_profile_blocked",
    owner_profile_field: gate.field,
    matched_pattern: gate.matched_pattern ?? null,
    detail: gate.reason,
    mirror_inline: true,
  };
  try {
    emitEvent(db, {
      kind: "auto_apply_signaled",
      substrate_origin: "substrate_auto",
      directive_id: row.directive_id ?? undefined,
      task_id: row.task_id ?? undefined,
      context_refs: [row.source_event_id],
      payload: payload as JsonValue,
    });
  } catch (err) {
    logger.warn(
      { where: "auto_apply.owner_profile_block", source_event_id: row.source_event_id, err: (err as Error).message },
      "could not emit owner_profile_blocked signal",
    );
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
  const target = p.target_resource ?? p.resource_uri ?? p.target ?? p.file_path;
  if (typeof target !== "string" || target.length === 0) return null;
  const filePath = target.startsWith("repo:") ? target.slice("repo:".length) : target;
  if (filePath.startsWith("/") || filePath.includes("..")) return null;
  const diff = p.diff;
  if (typeof diff === "string" && diff.length > 0) {
    // Legacy string diff form: treat current_behavior as `before` and diff as `after`.
    const current = payload.current_behavior;
    if (typeof current !== "string" || current.length === 0) return null;
    return { filePath, before: current, after: diff };
  }
  if (diff && typeof diff === "object") {
    const d = diff as Record<string, unknown>;
    const before = d.before;
    const after = d.after;
    if (d.kind !== "anchored_replace_v1") return null;
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
  // Full four-link spine (k_555) on success: action_predicted →
  // action_scored → applied_change_committed → *_applied. Adding the
  // action_predicted/scored pair makes the apply visible to the
  // universal act-loop telemetry: the residual is on file, the
  // verifier ran (the bun test --bail gate IS the verifier), and
  // substrate.credit can later score the source proposal's posterior
  // against this row chain. Without these two events the chain
  // started at applied_change_committed and the substrate had no
  // place to attach action-level posterior signal.
  const action = emitEvent(db, {
    kind: "action_predicted",
    substrate_origin: "substrate_auto",
    directive_id: row.directive_id ?? undefined,
    task_id: row.task_id ?? undefined,
    context_refs: [row.source_event_id],
    action_artifact_id: "auto_apply_worker_stage2_action",
    verifier_artifact_id: "auto_apply_worker_stage2_verifier",
    predicted_residual: 0.1,
    payload: {
      source_event_id: row.source_event_id,
      target: row.target,
      stage: "stage_2_mechanical_apply",
    } as JsonValue,
  });
  const scored = emitEvent(db, {
    kind: "action_scored",
    substrate_origin: "substrate_auto",
    directive_id: row.directive_id ?? undefined,
    task_id: row.task_id ?? undefined,
    context_refs: [row.source_event_id, action.id],
    action_artifact_id: "auto_apply_worker_stage2_action",
    verifier_artifact_id: "auto_apply_worker_stage2_verifier",
    outcome: "succeeded",
    residual: 0,
    payload: {
      source_event_id: row.source_event_id,
      target: row.target,
      commit_sha: result.commitSha,
    } as JsonValue,
  });
  // Distribute credit citing the source proposal. The synthetic-actuator
  // path in runtime/credit.ts skips the primary artifact posterior
  // (auto_apply_worker_stage2_action isn't a registered code_artifact)
  // but DOES walk collectCitations, so the source proposal's posterior
  // (knowledge_candidate / contract_amendment_proposed) updates with
  // candidate_confirmed evidence — closing the k_555 four-link spine.
  void import("./credit").then(({ distributeCredit }) => distributeCredit(db, {
    action_event_id: action.id,
    observation_event_id: scored.id,
    scored_event_id: scored.id,
    predicted_residual: 0.1,
    observed_residual: 0,
  })).catch((err) => {
    logger.warn(
      { where: "auto_apply.credit", err: (err as Error).message },
      "auto-apply credit distribution failed",
    );
  });
  const committed = emitEvent(db, {
    kind: "applied_change_committed",
    substrate_origin: "substrate_auto",
    directive_id: row.directive_id ?? undefined,
    task_id: row.task_id ?? undefined,
    context_refs: [row.source_event_id, action.id, scored.id],
    action_artifact_id: "auto_apply_worker_stage2_action",
    verifier_artifact_id: "auto_apply_worker_stage2_verifier",
    residual: 0,
    payload: {
      source_event_id: row.source_event_id,
      source_kind: row.source_kind,
      target: row.target,
      commit_sha: result.commitSha,
      summary: result.summary,
      stage: "stage_2_mechanical_apply",
      applied_by: "auto_apply_worker",
      action_event_id: action.id,
      scored_event_id: scored.id,
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
): { signaled: string[]; skipped: number; stage2_candidates: number; stage2_applied?: string; stage2_failed?: string; stage2_blocked?: string } => {
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
  //   3. Layer-2 OwnerProfile gate: refuse when an owner preference
  //      (things_to_never_do / manual_review_patterns / time_window /
  //      autonomy_score below AUTONOMY_MULTI_FILE_THRESHOLD + multi-file diff) blocks the
  //      candidate. Emits a structural auto_apply_signaled with
  //      reason=owner_profile_blocked instead of running mechanical apply.
  //   4. one-at-a-time: take the oldest candidate, apply, return. A flood
  //      of bad proposals can't cascade because the next tick is 60s away
  //      and any failure triggers cooldown.
  if (
    stage2Candidates.length > 0 &&
    stage2RuntimeAllowed() &&
    !inStage2Cooldown(db, nowMs)
  ) {
    const candidate = stage2Candidates[0]!;
    const repoRoot = opts?.repoRoot ?? process.env.ACC2_PROJECT_ROOT ?? process.cwd();

    // Layer-2 OwnerProfile gate. Read latest profile (defaults when none
    // recorded), evaluate against the candidate's target + source payload.
    const profile = readOwnerProfile(db);
    let sourcePayload: Record<string, unknown> = {};
    const srcRow = db
      .query("SELECT payload FROM events WHERE id = ?")
      .get(candidate.source_event_id) as { payload: string } | null;
    if (srcRow) {
      try { sourcePayload = JSON.parse(srcRow.payload ?? "{}") as Record<string, unknown>; }
      catch { /* leave empty — gate evaluates against target path alone */ }
    }
    const targetPath = candidate.target ?? "";
    const gate = evaluateOwnerProfileGate(profile, targetPath, sourcePayload, nowMs);
    if (gate.gated) {
      emitOwnerProfileBlock(db, candidate, gate, nowMs);
      logger.info(
        {
          source_event_id: candidate.source_event_id,
          field: gate.field,
          matched_pattern: gate.matched_pattern,
          target: candidate.target,
        },
        "auto_apply_worker stage-2 blocked by owner profile",
      );
      return {
        signaled,
        skipped: eligible.length - signaled.length,
        stage2_candidates: stage2Candidates.length,
        stage2_blocked: candidate.source_event_id,
      };
    }

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
