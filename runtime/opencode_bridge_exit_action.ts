// acc2 brain-bridge exit classifier (foundational fix per dispatch
// 81DJZCEJXS5H9E64, KC V3CED593BH5M conf=0.82, amendment
// RX14FT7CFX3X51CMD8FH1V1ZXR — 2026-05-20).
//
// Root cause (live evidence: bridge_failed HYNQ88NKYD2WD758ZP9BNVJDA4):
//   brain_obs_emit_count = 8     ← brain emitted 8 substrate observations
//   exit_code            = 0     ← clean opencode exit
//   first_frame_seen     = true  ← bridge saw real JSON frames
//   timed_out            = false ← no watchdog kill
//   reason               = "brain_silent_exit"  ← MISCLASSIFIED
//
// Pre-fix, the bridge driver decided "silent" from subprocess heuristics
// (the watchdog handshake gate combined with exit_code=0). The handshake
// gate is a stdout-only signal that's blind to opencode-1.4's
// HTTP-routed MCP traffic, and the substrate-reconciliation pass that
// retrofitted "look at ledger events with invoker=claude_root" only
// helps when frames are absent — for dispatches that DID emit observable
// frames but never reached a TERMINAL emit (task_committed / task_failed
// / action_scored), the classifier still fell through to the silent-exit
// bucket. Result: every partial-emit cycle (the common case while the
// brain is still settling on a verdict) was buried as a prompt-compliance
// failure, the survival gate (commit 2915d2d) kept firing on missing
// brain_dispatch_closed rows, and orphan-recovery churned ~28 events per
// five-minute window.
//
// The fix here is a substrate-truth-first ordering:
//
//   1. Terminal-evidence priority — query the ledger for terminal events
//      on this dispatch's task_id (task_committed / task_failed /
//      action_scored residual < 0.3). If ANY exist, the verdict is
//      decided. Subprocess heuristics do NOT override substrate truth.
//
//   2. Frame-evidence priority — when NO terminal exists but the brain
//      DID emit observable frames (brain_obs_emit_count > 0,
//      first_frame_seen, exit_code = 0), classify as `partial_emit`. This
//      is partial-but-real work: the brain made progress, just didn't
//      reach commit. Emit `brain_dispatch_closed` with
//      closure_reason="partial_emit_no_terminal" so the survival gate
//      stops accruing orphan rows.
//
//   3. Hard-silent — only when EVERY positive signal is absent
//      (exit_code=0 AND first_frame_seen=false AND brain_obs_emit_count=0
//      AND frames_received_count=0) is the dispatch a true silent exit.
//
//   4. Existing subprocess-failure paths (watchdog timeout, mcp handshake
//      timeout, opencode error event, nonzero exit) are left to the
//      driver — this module only owns the classification slot the driver
//      used to compute inline at runtime/bridge/opencode.ts:1041.
//
// The driver consumes ClassifyBridgeExitOutcome by reading `.verdict` to
// decide which bridge_failed / brain_dispatch_closed rows to emit; the
// substrate (not this module) is the surface that records the final
// chain.

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { emitEvent } from "./events";

/** Terminal-evidence shape returned by the ledger probe. The driver uses
 *  it both for verdict selection and for surfacing the evidence id in
 *  any subsequent brain_dispatch_closed row so credit chains can be
 *  joined back to the originating commit/fail row. */
export interface LedgerTerminalEvidence {
  /** Canonical terminal event kind that decided the verdict. */
  kind: "task_committed" | "task_failed" | "action_scored";
  /** Event id of the row that decided the verdict. */
  event_id: string;
  /** Numeric residual when kind=action_scored. */
  residual?: number;
  /** Free-string failure_kind copied from task_failed.payload when present. */
  failure_kind?: string;
}

/** Inputs the classifier needs from the driver. Kept narrow on purpose —
 *  every field is something the driver already computed for the
 *  bridge_failed payload, so this struct is just a typed re-bundle. */
export interface BridgeExitObservations {
  /** Task id the bridge ran for; used to scope the ledger probe. */
  taskId: string;
  /** Bridge invocation start (epoch ms) — the lower bound on the ledger probe
   *  window so we don't pick up a previous dispatch's terminal row. */
  dispatchWindowStartIso: string;
  /** Exit code the opencode subprocess returned. */
  exitCode: number | null;
  /** True if the bridge saw at least one JSON frame on stdout. */
  firstFrameSeen: boolean;
  /** Count of frames the bridge tagged as observation-bearing (text /
   *  tool_use / step_complete with payload, etc — driver-defined). */
  brainObsEmitCount: number;
  /** Total JSON frames received on stdout, regardless of shape. */
  framesReceivedCount: number;
  /** True if the overall-wall watchdog fired (driver SIGTERM). */
  killedByOverallTimeout: boolean;
  /** True if the MCP handshake watchdog fired. */
  mcpHandshakeTimedOut: boolean;
}

/** Verdict the driver uses to decide which event chain to emit. The
 *  set is intentionally narrow: substrate-deciding verdicts come first,
 *  the partial-emit branch is new, hard-silent is preserved, and
 *  pass_through tells the driver "no substrate evidence overrides the
 *  subprocess heuristics, fall through to your existing taxonomy." */
export type BridgeExitVerdict =
  | "success"               // task_committed observed on this dispatch
  | "failed"                // task_failed observed (failure_kind propagated)
  | "partial_success"       // action_scored with residual < 0.3
  | "partial_emit"          // frames + obs emits but no terminal
  | "brain_silent_exit"     // ALL positive signals zero
  | "pass_through";         // no substrate evidence — driver decides

export interface ClassifyBridgeExitOutcome {
  verdict: BridgeExitVerdict;
  /** Populated when verdict ∈ {success, failed, partial_success}. */
  terminal_evidence: LedgerTerminalEvidence | null;
  /** Populated when verdict = partial_emit — driver should emit
   *  brain_dispatch_closed with this string as closure_reason. */
  closure_reason: string | null;
  /** Short human-readable reason the verdict landed where it did.
   *  Surfaced into the bridge_failed / brain_dispatch_closed payload so
   *  operators can read the classifier's reasoning without re-running
   *  the probe. */
  rationale: string;
}

/** Threshold below which action_scored counts as a partial-success
 *  terminal. Kept in lock-step with the partial-success convention in
 *  the rest of the runtime; if other modules adjust this threshold, it
 *  should be threaded through here rather than duplicated. */
export const PARTIAL_SUCCESS_RESIDUAL_CEILING = 0.3;

/**
 * Probe the ledger for terminal evidence on this dispatch's task. The
 * window lower bound is `dispatchWindowStartIso` so a stale prior-dispatch
 * commit/fail doesn't masquerade as the current verdict. Returns the
 * highest-priority row found in this order:
 *   task_committed  →  task_failed  →  action_scored (low residual)
 * Returns null if none exist.
 */
export function readLedgerTerminalEvidence(
  db: Database,
  taskId: string,
  dispatchWindowStartIso: string,
): LedgerTerminalEvidence | null {
  // task_committed wins outright — once the brain committed, no later
  // subprocess hiccup can re-classify the dispatch.
  const committed = db
    .query<{ id: string }, [string, string]>(
      `SELECT id FROM events
       WHERE task_id = ?
         AND ts >= ?
         AND kind = 'task_committed'
       ORDER BY ts ASC
       LIMIT 1`,
    )
    .get(taskId, dispatchWindowStartIso);
  if (committed) {
    return { kind: "task_committed", event_id: committed.id };
  }

  // task_failed loses to commit but beats every other signal — if the
  // brain explicitly failed, the failure_kind is the verdict.
  const failed = db
    .query<{ id: string; payload: string }, [string, string]>(
      `SELECT id, payload FROM events
       WHERE task_id = ?
         AND ts >= ?
         AND kind = 'task_failed'
       ORDER BY ts ASC
       LIMIT 1`,
    )
    .get(taskId, dispatchWindowStartIso);
  if (failed) {
    let failureKind: string | undefined;
    try {
      const parsed = JSON.parse(failed.payload) as Record<string, unknown>;
      const fk = parsed.failure_kind ?? parsed.reason;
      if (typeof fk === "string" && fk.length > 0) failureKind = fk;
    } catch { /* malformed payload — verdict still stands, failure_kind unknown */ }
    return { kind: "task_failed", event_id: failed.id, failure_kind: failureKind };
  }

  // action_scored only counts as partial_success when residual is low.
  // We pull the lowest-residual row for the task; if it clears the
  // ceiling, the dispatch produced a substantive scored action.
  const scored = db
    .query<{ id: string; payload: string }, [string, string]>(
      `SELECT id, payload FROM events
       WHERE task_id = ?
         AND ts >= ?
         AND kind = 'action_scored'
       ORDER BY ts ASC`,
    )
    .all(taskId, dispatchWindowStartIso);
  for (const row of scored) {
    try {
      const parsed = JSON.parse(row.payload) as Record<string, unknown>;
      const residualRaw = parsed.residual;
      if (typeof residualRaw === "number" && residualRaw < PARTIAL_SUCCESS_RESIDUAL_CEILING) {
        return { kind: "action_scored", event_id: row.id, residual: residualRaw };
      }
    } catch { /* malformed payload — skip this row */ }
  }

  return null;
}

/**
 * Classify a bridge exit using substrate-visible facts first.
 *
 * Ordering (canonical):
 *   1. Terminal evidence (task_committed / task_failed / action_scored).
 *   2. Frame evidence (partial_emit when brain emitted but didn't commit).
 *   3. Hard-silent (every positive signal absent).
 *   4. pass_through — driver applies its existing subprocess-failure
 *      taxonomy (timeout, handshake-timeout, opencode_error_event,
 *      nonzero-exit) unchanged.
 *
 * This function does NOT emit events. The driver owns event emission so
 * the classifier stays pure / testable and so each verdict's emission
 * shape can carry whatever extra payload the driver already prepared.
 */
export function classifyBridgeExit(
  db: Database,
  obs: BridgeExitObservations,
): ClassifyBridgeExitOutcome {
  // ── Step 1: substrate-truth-first. Ledger evidence overrides every
  // subprocess heuristic. The HYNQ-shape bug only existed because this
  // step used to be a non-existent step.
  const terminal = readLedgerTerminalEvidence(db, obs.taskId, obs.dispatchWindowStartIso);
  if (terminal) {
    if (terminal.kind === "task_committed") {
      return {
        verdict: "success",
        terminal_evidence: terminal,
        closure_reason: null,
        rationale: `ledger: task_committed ${terminal.event_id} bound to task ${obs.taskId}`,
      };
    }
    if (terminal.kind === "task_failed") {
      return {
        verdict: "failed",
        terminal_evidence: terminal,
        closure_reason: null,
        rationale: `ledger: task_failed ${terminal.event_id} failure_kind=${terminal.failure_kind ?? "unknown"}`,
      };
    }
    // action_scored with residual < threshold
    return {
      verdict: "partial_success",
      terminal_evidence: terminal,
      closure_reason: null,
      rationale: `ledger: action_scored ${terminal.event_id} residual=${terminal.residual}`,
    };
  }

  // ── Step 2: frame-evidence priority. The brain emitted real
  // observations but never reached a terminal commit. This is the
  // HYNQ-shape: emit_count > 0, first_frame_seen, clean exit. Treat as
  // partial-but-real work; emit brain_dispatch_closed with closure_reason
  // so the survival gate doesn't keep firing.
  if (
    obs.brainObsEmitCount > 0
    && obs.firstFrameSeen === true
    && obs.exitCode === 0
    && !obs.killedByOverallTimeout
    && !obs.mcpHandshakeTimedOut
  ) {
    return {
      verdict: "partial_emit",
      terminal_evidence: null,
      closure_reason: "partial_emit_no_terminal",
      rationale: `frames: emit_count=${obs.brainObsEmitCount} first_frame_seen=true exit_code=0 — partial-but-real`,
    };
  }

  // ── Step 3: hard-silent. Reserved for the case where EVERY positive
  // signal is absent. Anything weaker than this falls through to the
  // driver's existing failure taxonomy.
  if (
    obs.exitCode === 0
    && obs.firstFrameSeen === false
    && obs.brainObsEmitCount === 0
    && obs.framesReceivedCount === 0
    && !obs.killedByOverallTimeout
  ) {
    return {
      verdict: "brain_silent_exit",
      terminal_evidence: null,
      closure_reason: null,
      rationale: "all positive signals absent: exit_code=0, no frames, no observations",
    };
  }

  // ── Step 4: pass_through. The substrate has nothing dispositive and
  // the dispatch isn't hard-silent — the driver's existing classification
  // (timeout / handshake-timeout / opencode_error_event / nonzero-exit /
  // subprocess_stuck / cycle_violation / killed) decides from here.
  return {
    verdict: "pass_through",
    terminal_evidence: null,
    closure_reason: null,
    rationale: "no substrate-deciding evidence; driver subprocess heuristics apply",
  };
}

/**
 * Helper for the driver's partial_emit branch — emits the
 * brain_dispatch_closed row with the canonical closure_reason so the
 * survival gate (commit 2915d2d) stops accruing orphan rows for
 * partial-but-real dispatches.
 *
 * Returns the emitted event id so the caller can thread it into any
 * act_tuple_recorded envelope it constructs for the dispatch boundary.
 */
export function emitPartialEmitDispatchClosed(
  db: Database,
  args: {
    directiveId: string;
    taskId: string;
    dispatchId?: string;
    brainObsEmitCount: number;
    framesReceivedCount: number;
    exitCode: number | null;
    rationale: string;
  },
): string {
  const ev = emitEvent(db, {
    kind: "brain_dispatch_closed",
    substrate_origin: "opencode",
    directive_id: args.directiveId,
    task_id: args.taskId,
    payload: {
      dispatch_id: args.dispatchId ?? null,
      reason: "partial_emit_no_terminal",
      closure_reason: "partial_emit_no_terminal",
      brain_obs_emit_count: args.brainObsEmitCount,
      frames_received_count: args.framesReceivedCount,
      exit_code: args.exitCode,
      classifier_rationale: args.rationale,
    } as JsonValue,
    invoker: "opencode",
  });
  return ev.id;
}
