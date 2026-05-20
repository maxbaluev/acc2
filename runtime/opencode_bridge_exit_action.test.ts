import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import {
  classifyBridgeExit,
  readLedgerTerminalEvidence,
  emitPartialEmitDispatchClosed,
  PARTIAL_SUCCESS_RESIDUAL_CEILING,
} from "./opencode_bridge_exit_action";
import { newId } from "./ids";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const baseObs = (overrides: Partial<{
  taskId: string;
  dispatchWindowStartIso: string;
  exitCode: number | null;
  firstFrameSeen: boolean;
  brainObsEmitCount: number;
  framesReceivedCount: number;
  killedByOverallTimeout: boolean;
  mcpHandshakeTimedOut: boolean;
}> = {}) => ({
  taskId: overrides.taskId ?? newId(),
  dispatchWindowStartIso: overrides.dispatchWindowStartIso ?? new Date(Date.now() - 60_000).toISOString(),
  exitCode: overrides.exitCode ?? 0,
  firstFrameSeen: overrides.firstFrameSeen ?? false,
  brainObsEmitCount: overrides.brainObsEmitCount ?? 0,
  framesReceivedCount: overrides.framesReceivedCount ?? 0,
  killedByOverallTimeout: overrides.killedByOverallTimeout ?? false,
  mcpHandshakeTimedOut: overrides.mcpHandshakeTimedOut ?? false,
});

describe("classifyBridgeExit — substrate-truth-first ordering", () => {
  test("terminal-success: task_committed exists → verdict=success, NOT bridge_failed", () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const taskId = newId();
    const windowStart = new Date(Date.now() - 60_000).toISOString();

    const ev = emitEvent(db, {
      kind: "task_committed",
      substrate_origin: "opencode",
      directive_id: directiveId,
      task_id: taskId,
      payload: { result: "ok" },
      invoker: "claude_root",
    });

    // Even with all positive frame signals false (would look "silent" to old
    // classifier), terminal evidence overrides.
    const result = classifyBridgeExit(db, baseObs({
      taskId,
      dispatchWindowStartIso: windowStart,
      exitCode: 0,
      firstFrameSeen: false,
      brainObsEmitCount: 0,
      framesReceivedCount: 0,
    }));

    expect(result.verdict).toBe("success");
    expect(result.terminal_evidence).not.toBeNull();
    expect(result.terminal_evidence!.kind).toBe("task_committed");
    expect(result.terminal_evidence!.event_id).toBe(ev.id);
  });

  test("terminal-failure: task_failed exists → verdict=failed with failure_kind propagated", () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const taskId = newId();
    const windowStart = new Date(Date.now() - 60_000).toISOString();

    emitEvent(db, {
      kind: "task_failed",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      task_id: taskId,
      payload: { failure_kind: "verifier_refused", reason: "residual too high" },
      invoker: "claude_root",
    });

    const result = classifyBridgeExit(db, baseObs({
      taskId,
      dispatchWindowStartIso: windowStart,
    }));

    expect(result.verdict).toBe("failed");
    expect(result.terminal_evidence!.kind).toBe("task_failed");
    expect(result.terminal_evidence!.failure_kind).toBe("verifier_refused");
  });

  test("terminal partial-success: action_scored residual < 0.3 → verdict=partial_success", () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const taskId = newId();
    const windowStart = new Date(Date.now() - 60_000).toISOString();

    emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      task_id: taskId,
      payload: { residual: 0.15, verifier_kind: "deterministic_code" },
      invoker: "claude_root",
    });

    const result = classifyBridgeExit(db, baseObs({
      taskId,
      dispatchWindowStartIso: windowStart,
    }));

    expect(result.verdict).toBe("partial_success");
    expect(result.terminal_evidence!.kind).toBe("action_scored");
    expect(result.terminal_evidence!.residual).toBe(0.15);
  });

  test("action_scored with residual >= 0.3 does NOT decide as partial_success", () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const taskId = newId();
    const windowStart = new Date(Date.now() - 60_000).toISOString();

    emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      task_id: taskId,
      payload: { residual: 0.8 },
      invoker: "claude_root",
    });

    // No terminal evidence above threshold; should fall through to hard-silent
    // since all positive signals absent.
    const result = classifyBridgeExit(db, baseObs({
      taskId,
      dispatchWindowStartIso: windowStart,
    }));

    expect(result.verdict).toBe("brain_silent_exit");
  });

  test("partial_emit: emit_count=8, exit_code=0, first_frame=true, NO terminal → verdict=partial_emit, closure_reason set", () => {
    const db = openDb(":memory:");
    const taskId = newId();
    const windowStart = new Date(Date.now() - 60_000).toISOString();

    // No terminal events emitted at all — just observations would have landed.

    const result = classifyBridgeExit(db, baseObs({
      taskId,
      dispatchWindowStartIso: windowStart,
      exitCode: 0,
      firstFrameSeen: true,
      brainObsEmitCount: 8,
      framesReceivedCount: 12,
    }));

    expect(result.verdict).toBe("partial_emit");
    expect(result.closure_reason).toBe("partial_emit_no_terminal");
    expect(result.terminal_evidence).toBeNull();
  });

  test("emitPartialEmitDispatchClosed writes brain_dispatch_closed with closure_reason payload", () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const taskId = newId();

    const evId = emitPartialEmitDispatchClosed(db, {
      directiveId,
      taskId,
      brainObsEmitCount: 8,
      framesReceivedCount: 12,
      exitCode: 0,
      rationale: "frames: emit_count=8 first_frame_seen=true exit_code=0 — partial-but-real",
    });

    const row = db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM events WHERE id = ?",
      )
      .get(evId);
    expect(row).not.toBeNull();
    const payload = JSON.parse(row!.payload) as Record<string, unknown>;
    expect(payload.closure_reason).toBe("partial_emit_no_terminal");
    expect(payload.reason).toBe("partial_emit_no_terminal");
    expect(payload.brain_obs_emit_count).toBe(8);
    expect(payload.frames_received_count).toBe(12);
    expect(payload.exit_code).toBe(0);
  });

  test("hard-silent: ALL positive signals zero → verdict=brain_silent_exit (preserved current behavior)", () => {
    const db = openDb(":memory:");
    const taskId = newId();
    const windowStart = new Date(Date.now() - 60_000).toISOString();

    const result = classifyBridgeExit(db, baseObs({
      taskId,
      dispatchWindowStartIso: windowStart,
      exitCode: 0,
      firstFrameSeen: false,
      brainObsEmitCount: 0,
      framesReceivedCount: 0,
      killedByOverallTimeout: false,
      mcpHandshakeTimedOut: false,
    }));

    expect(result.verdict).toBe("brain_silent_exit");
    expect(result.terminal_evidence).toBeNull();
    expect(result.closure_reason).toBeNull();
  });

  test("HYNQ regression guard: emit_count=8, exit_code=0, first_frame=true, NO terminal → NOT silent_exit (this is the foundational bug)", () => {
    const db = openDb(":memory:");
    const taskId = newId();
    const windowStart = new Date(Date.now() - 60_000).toISOString();

    // Reproduce the exact HYNQ88NKYD2WD758ZP9BNVJDA4 payload shape:
    //   brain_obs_emit_count: 8 — brain emitted 8 observations
    //   exit_code: 0          — clean exit
    //   first_frame_seen: true — bridge saw real frames
    //   timed_out: false       — no watchdog kill
    // Pre-fix this was misclassified as brain_silent_exit; post-fix it MUST
    // land as partial_emit instead.
    const result = classifyBridgeExit(db, baseObs({
      taskId,
      dispatchWindowStartIso: windowStart,
      exitCode: 0,
      firstFrameSeen: true,
      brainObsEmitCount: 8,
      framesReceivedCount: 8,
      killedByOverallTimeout: false,
      mcpHandshakeTimedOut: false,
    }));

    expect(result.verdict).not.toBe("brain_silent_exit");
    expect(result.verdict).toBe("partial_emit");
    expect(result.closure_reason).toBe("partial_emit_no_terminal");
  });

  test("pass_through: timeout fired → driver decides (verdict=pass_through)", () => {
    const db = openDb(":memory:");
    const taskId = newId();
    const windowStart = new Date(Date.now() - 60_000).toISOString();

    const result = classifyBridgeExit(db, baseObs({
      taskId,
      dispatchWindowStartIso: windowStart,
      exitCode: null,
      firstFrameSeen: true,
      brainObsEmitCount: 3,
      framesReceivedCount: 5,
      killedByOverallTimeout: true,
    }));

    expect(result.verdict).toBe("pass_through");
  });

  test("pass_through: mcp_handshake_timed_out with emissions → not partial_emit, driver decides", () => {
    const db = openDb(":memory:");
    const taskId = newId();
    const windowStart = new Date(Date.now() - 60_000).toISOString();

    const result = classifyBridgeExit(db, baseObs({
      taskId,
      dispatchWindowStartIso: windowStart,
      exitCode: 0,
      firstFrameSeen: true,
      brainObsEmitCount: 2,
      framesReceivedCount: 3,
      mcpHandshakeTimedOut: true,
    }));

    expect(result.verdict).toBe("pass_through");
  });

  test("pass_through: nonzero exit code → driver decides", () => {
    const db = openDb(":memory:");
    const taskId = newId();
    const windowStart = new Date(Date.now() - 60_000).toISOString();

    const result = classifyBridgeExit(db, baseObs({
      taskId,
      dispatchWindowStartIso: windowStart,
      exitCode: 1,
      firstFrameSeen: false,
      brainObsEmitCount: 0,
      framesReceivedCount: 0,
    }));

    expect(result.verdict).toBe("pass_through");
  });

  test("ledger window lower bound: terminal row BEFORE window does NOT decide", () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const taskId = newId();

    // Pre-existing task_committed row (from a stale prior dispatch).
    emitEvent(db, {
      kind: "task_committed",
      substrate_origin: "opencode",
      directive_id: directiveId,
      task_id: taskId,
      payload: { result: "stale" },
      invoker: "claude_root",
    });

    // Sleep a tiny bit so timestamps differ
    const futureWindowStart = new Date(Date.now() + 10_000).toISOString();

    const result = classifyBridgeExit(db, baseObs({
      taskId,
      dispatchWindowStartIso: futureWindowStart,
      exitCode: 0,
      firstFrameSeen: false,
      brainObsEmitCount: 0,
      framesReceivedCount: 0,
    }));

    // The stale row predates the window — should not decide; falls through to
    // hard-silent since every other signal is absent.
    expect(result.verdict).toBe("brain_silent_exit");
  });

  test("task_committed beats task_failed when both exist in window", () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const taskId = newId();
    const windowStart = new Date(Date.now() - 60_000).toISOString();

    emitEvent(db, {
      kind: "task_failed",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      task_id: taskId,
      payload: { failure_kind: "verifier_refused" },
      invoker: "claude_root",
    });
    emitEvent(db, {
      kind: "task_committed",
      substrate_origin: "opencode",
      directive_id: directiveId,
      task_id: taskId,
      payload: { result: "ok" },
      invoker: "claude_root",
    });

    const result = classifyBridgeExit(db, baseObs({
      taskId,
      dispatchWindowStartIso: windowStart,
    }));

    expect(result.verdict).toBe("success");
  });

  test("readLedgerTerminalEvidence returns null when no terminal events exist", () => {
    const db = openDb(":memory:");
    const taskId = newId();
    const windowStart = new Date(Date.now() - 60_000).toISOString();
    expect(readLedgerTerminalEvidence(db, taskId, windowStart)).toBeNull();
  });

  test("PARTIAL_SUCCESS_RESIDUAL_CEILING matches the documented threshold of 0.3", () => {
    expect(PARTIAL_SUCCESS_RESIDUAL_CEILING).toBe(0.3);
  });
});
