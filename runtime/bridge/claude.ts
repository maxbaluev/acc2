// acc2 symmetric Claude-Code engine bridge — substrate-spawned, headless.
//
// This module is the structural mirror of `./opencode.ts`: it lets the
// substrate spawn Claude Code as an implementation/apply/forensic engine the
// SAME way it spawns opencode for strategic synthesis. The two engines satisfy
// the shared `EngineBridge` lifecycle contract in `./types.ts` (spawn → MCP
// handshake → cycle-1 → output frames → deterministic close).
//
// SCAFFOLD STATUS (increment 1/2): this bridge is DORMANT. Nothing in the live
// dispatch path (runtime/task_dispatcher.ts, runtime/dispatch_decider.ts, …)
// calls `spawnRealClaudeCode` or `claudeCodeQuery` yet — that executor-selection
// wiring is increment 2 (amendments ZKGY2ZZ69N65 + E509TV4J2N1K). The module
// compiles, is unit-tested via the hermetic mock, and reuses the opencode
// machinery so wiring it later is a small, separately-verified change.
//
// SPAWN MECHANISM (mockable seam): production spawns the Claude Code CLI
// headlessly via `claude -p <prompt> --output-format stream-json` with the
// daemon's MCP endpoint injected through a per-dispatch `--mcp-config <file>`
// (the symmetric analogue of opencode's OPENCODE_CONFIG injection). The actual
// `Bun.spawn` is behind the `spawnFn` seam in `ClaudeSpawnOpts`, so tests inject
// a fake that streams canned `stream-json` frames and never launches a real
// `claude` binary. Capability + MCP-readiness probes default to
// "available/skip" whenever `spawnFn` is injected, mirroring the opencode
// bridge so host CLI state never leaks into deterministic test fixtures.
//
// Cycle-1 + watchdog parity: the cycle-1 self-iteration gate is sourced from
// the SHARED `isCycleViolation` predicate (runtime/cycle_one_gate.ts) — the
// exact predicate the opencode bridge uses — so the two engines can never drift
// on what counts as a violation. The first-frame watchdog, overall timeout
// SIGTERM/SIGKILL escalation, and brain_liveness_heartbeat cadence mirror the
// opencode tiers.

import type { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "../../substrate/types";
import { emitEvent } from "../events";
import { isCycleViolation } from "../cycle_one_gate";
import { getBootSessionToken } from "../brain_dispatch_reconciler";
import { newId } from "../ids";
import type {
  BridgeRequest,
  BridgeResult,
  ClaudeSpawnOpts,
  EngineBridge,
} from "./types";
import { defaultEngineSpawn } from "./types";
import { V2_OPENCODE_MCP_SERVER_NAME } from "./config";

// ── Substrate origin / attribution for the Claude engine ─────────────
// SubstrateOrigin is a free string (substrate/types.ts) so the Claude engine
// attributes its events under "claude_code" — symmetric to opencode's
// "opencode" origin without widening any closed enum.
const CLAUDE_ENGINE_ORIGIN = "claude_code" as const;

/** Default Claude Code model alias. Override via ACC2_CLAUDE_MODEL or
 *  ClaudeSpawnOpts.model. Kept as a stable string; the substrate admits new
 *  models by passing a different value, not by editing an enum. */
export const DEFAULT_CLAUDE_MODEL = "claude-opus-4-7";

/** Per-dispatch wall-clock cap on the Claude Code subprocess. Mirrors the
 *  opencode overall-timeout budget so a runaway implementation leaf is bounded
 *  the same way a runaway brain cycle is. Override via ACC2_CLAUDE_TIMEOUT_MS
 *  or ClaudeSpawnOpts.timeoutMs. */
export const DEFAULT_CLAUDE_TIMEOUT_MS = 1500_000;

/** MCP-handshake window — time Claude Code has between connecting to v2's MCP
 *  server and invoking its first substrate / runtime tool. Mirrors the
 *  opencode handshake window. */
export const DEFAULT_CLAUDE_MCP_HANDSHAKE_WINDOW_MS = 120_000;

/** First-frame budget — window between spawn and the FIRST cc_frame_received.
 *  Mirrors the opencode first-frame watchdog tier so slow first-cycle reasoning
 *  is not false-positive killed. */
export const DEFAULT_CLAUDE_FIRST_FRAME_THRESHOLD_MS = 300_000;

/** brain_liveness_heartbeat cadence while a Claude dispatch is alive. */
export const DEFAULT_CLAUDE_LIVENESS_HEARTBEAT_MS = 60_000;

/** Per-dispatch Claude Code MCP-config materializer (symmetric to
 *  `materializeOpencodeMcpConfig`). Claude Code reads `--mcp-config <file>`
 *  with the canonical `mcpServers` schema; we declare v2's daemon MCP endpoint
 *  as an HTTP server so the spawned Claude Code registers v2's substrate.* /
 *  runtime.* tool surface. Returns the absolute config path + its tempdir so
 *  the caller can clean it up after exit. */
export const materializeClaudeMcpConfig = (opts: {
  mcpServerUrl: string;
  configDir?: string;
  serverName?: string;
}): { configPath: string; tempDir: string } => {
  const serverName = opts.serverName ?? V2_OPENCODE_MCP_SERVER_NAME;
  const tempDir = opts.configDir ?? mkdtempSync(join(tmpdir(), "acc2-claude-cfg-"));
  const configPath = join(tempDir, "claude-mcp-config.json");
  // Claude Code's --mcp-config canonical shape: { mcpServers: { <name>: {…} } }.
  // type=http → Claude Code connects as an HTTP client to the daemon's /mcp
  // Streamable-HTTP transport (the same endpoint opencode connects to).
  const cfg = {
    mcpServers: {
      [serverName]: {
        type: "http",
        url: opts.mcpServerUrl,
      },
    },
  };
  writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf-8");
  return { configPath, tempDir };
};

/** Spawn Claude Code headlessly as a substrate-dispatched engine leaf.
 *
 *  Structural mirror of `spawnRealOpencode`: preflight → MCP-config
 *  materialize → spawn (behind the `spawnFn` seam) → cc_dispatched → stream
 *  cc_frame_received frames → cycle-1 gate via the shared predicate → watchdog
 *  + liveness heartbeat → deterministic cc_dispatch_closed on exit → exit
 *  classification. Returns the same BridgeResult shape opencode returns so the
 *  dispatcher (increment 2) can treat the two engines uniformly. */
export const spawnRealClaudeCode = async (
  req: BridgeRequest,
  db: Database,
  spawnOpts: ClaudeSpawnOpts = {},
): Promise<BridgeResult> => {
  const bridgeStartedAtMs = Date.now();
  const model = spawnOpts.model ?? process.env.ACC2_CLAUDE_MODEL ?? DEFAULT_CLAUDE_MODEL;
  const timeoutMs = spawnOpts.timeoutMs ?? DEFAULT_CLAUDE_TIMEOUT_MS;
  const spawn = spawnOpts.spawnFn ?? defaultEngineSpawn;
  const firstFrameThresholdMs =
    spawnOpts.firstFrameThresholdMs ?? DEFAULT_CLAUDE_FIRST_FRAME_THRESHOLD_MS;
  const livenessHeartbeatMs =
    spawnOpts.livenessHeartbeatMs ?? DEFAULT_CLAUDE_LIVENESS_HEARTBEAT_MS;
  const elapsedMs = (): number => Date.now() - bridgeStartedAtMs;

  emitEvent(db, {
    kind: "bridge_invoked",
    substrate_origin: CLAUDE_ENGINE_ORIGIN,
    directive_id: req.directiveId,
    task_id: req.taskId,
    payload: {
      prompt_chars: req.prompt.length,
      model,
      engine: "claude_code",
      real: true,
      budget_estimate: { wall_ms: timeoutMs, first_frame_threshold_ms: firstFrameThresholdMs },
    } as JsonValue,
    invoker: CLAUDE_ENGINE_ORIGIN,
  });

  // ── Capability pre-flight (Claude Code CLI availability) ──
  // Mirror the opencode coupling: when `spawnFn` is injected but no
  // capabilityProbe is given, assume the CLI is available so host state does
  // not leak into deterministic fixtures.
  const capabilityDefault: () => { ok: boolean; version?: string; missing_binary?: string; install_hint?: string } =
    spawnOpts.spawnFn ? (() => ({ ok: true })) : (() => ({ ok: true })); // increment-1 scaffold: real probe wired in increment 2
  const capabilityProbe = spawnOpts.capabilityProbe ?? capabilityDefault;
  const capability = capabilityProbe();
  if (!capability.ok) {
    const installHint =
      capability.install_hint ??
      "Install Claude Code and verify `claude --version` works before dispatch.";
    emitEvent(db, {
      kind: "runtime_self_diagnostic_recorded",
      substrate_origin: CLAUDE_ENGINE_ORIGIN,
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: {
        runtime: "claude_code_bridge",
        fault_kind: "runtime_unavailable",
        missing_binary: capability.missing_binary ?? "claude",
        repair_hint: installHint,
        evidence_event_ids: [],
      } as JsonValue,
      invoker: CLAUDE_ENGINE_ORIGIN,
    });
    emitEvent(db, {
      kind: "bridge_failed",
      substrate_origin: CLAUDE_ENGINE_ORIGIN,
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: { reason: "runtime_unavailable", mcp_handshake_ok: false, hint: installHint } as JsonValue,
      invoker: CLAUDE_ENGINE_ORIGIN,
    });
    return {
      ok: false,
      reason: { kind: "subprocess_crash", stderr_tail: `claude_runtime_unavailable: ${installHint}` },
    };
  }

  // ── MCP config materialize (daemon endpoint injection) ──
  const mcpServerUrl = spawnOpts.mcpServerUrl ?? process.env.V2_MCP_SERVER_URL ?? "";
  if (mcpServerUrl.length === 0) {
    emitEvent(db, {
      kind: "bridge_failed",
      substrate_origin: CLAUDE_ENGINE_ORIGIN,
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: {
        reason: "mcp_server_url_missing",
        mcp_handshake_ok: false,
        hint: "V2_MCP_SERVER_URL must point at the daemon's /mcp endpoint",
      } as JsonValue,
      invoker: CLAUDE_ENGINE_ORIGIN,
    });
    return {
      ok: false,
      reason: { kind: "parse_error", raw: "V2_MCP_SERVER_URL not set; claude would have no MCP tools" },
    };
  }

  let materializedConfig: { configPath: string; tempDir: string } | null = null;
  try {
    materializedConfig = materializeClaudeMcpConfig({ mcpServerUrl, configDir: spawnOpts.configDir });
  } catch (err) {
    emitEvent(db, {
      kind: "bridge_failed",
      substrate_origin: CLAUDE_ENGINE_ORIGIN,
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: { reason: `mcp_config_materialize_failed:${(err as Error).message}`, mcp_handshake_ok: false } as JsonValue,
      invoker: CLAUDE_ENGINE_ORIGIN,
    });
    return { ok: false, reason: { kind: "parse_error", raw: (err as Error).message } };
  }
  const cleanupConfig = (): void => {
    if (materializedConfig) {
      try { rmSync(materializedConfig.tempDir, { recursive: true, force: true }); } catch { /* swallow */ }
      materializedConfig = null;
    }
  };

  // ── Spawn the headless Claude Code subprocess (behind the seam) ──
  // `claude -p <prompt>` runs headless print mode; --output-format stream-json
  // emits one JSON event per stdout line (the symmetric analogue of opencode's
  // --format=json). --mcp-config injects v2's MCP endpoint. The brain
  // workspace is a per-dispatch tempdir unless checkout isolation is set.
  const brainWorkspace = req.checkoutIsolation?.root ?? mkdtempSync(join(tmpdir(), "acc2-claude-ws-"));
  const brainWorkspaceIsEphemeral = req.checkoutIsolation === undefined;
  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn([
      "claude", "-p", req.prompt,
      "--output-format", "stream-json",
      "--model", model,
      "--mcp-config", materializedConfig.configPath,
    ], {
      cwd: brainWorkspace,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        V2_MCP_SERVER_URL: mcpServerUrl,
        ACC2_CHECKOUT_ISOLATION_ROOT: req.checkoutIsolation?.root ?? brainWorkspace,
        ACC2_CHECKOUT_ISOLATION_REASON: req.checkoutIsolation?.reason ?? "main_checkout_selected",
        ACC2_CHECKOUT_MERGE_BACK_STRATEGY: req.checkoutIsolation?.mergeBackStrategy ?? "main_checkout",
        ACC2_BRAIN_WORKSPACE: brainWorkspace,
      },
    });
  } catch (err) {
    cleanupConfig();
    if (brainWorkspaceIsEphemeral) {
      try { rmSync(brainWorkspace, { recursive: true, force: true }); } catch { /* swallow */ }
    }
    emitEvent(db, {
      kind: "bridge_failed",
      substrate_origin: CLAUDE_ENGINE_ORIGIN,
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: { reason: `spawn_failed:${(err as Error).message}`, mcp_handshake_ok: false } as JsonValue,
      invoker: CLAUDE_ENGINE_ORIGIN,
    });
    return { ok: false, reason: { kind: "auth_missing" } };
  }

  // ── cc_dispatched: spawn-time lifecycle row (symmetric to brain_dispatched) ──
  const dispatchId = req.dispatchId ?? newId();
  const spawnSessionToken = getBootSessionToken();
  const spawnedAtMs = Date.now();
  const spawnSubprocessPid = proc.pid ?? null;
  emitEvent(db, {
    kind: "cc_dispatched",
    substrate_origin: CLAUDE_ENGINE_ORIGIN,
    directive_id: req.directiveId,
    task_id: req.taskId,
    payload: {
      dispatch_id: dispatchId,
      session_token: spawnSessionToken,
      started_at_ms: spawnedAtMs,
      subprocess_pid: spawnSubprocessPid,
      directive_id: req.directiveId,
      engine: "claude_code",
      emission_origin: "cc_bridge_spawn",
    } as JsonValue,
    invoker: CLAUDE_ENGINE_ORIGIN,
  });

  // ── Liveness heartbeat (decouple liveness from frame timing) ──
  let livenessSeq = 0;
  let livenessTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
    livenessSeq += 1;
    try {
      emitEvent(db, {
        kind: "brain_liveness_heartbeat",
        substrate_origin: CLAUDE_ENGINE_ORIGIN,
        directive_id: req.directiveId,
        task_id: req.taskId,
        payload: {
          dispatch_id: dispatchId,
          directive_id: req.directiveId,
          task_id: req.taskId,
          heartbeat_seq: livenessSeq,
          subprocess_pid: spawnSubprocessPid,
          engine: "claude_code",
          emitted_at_ms: Date.now(),
        } as JsonValue,
        invoker: CLAUDE_ENGINE_ORIGIN,
      });
    } catch { /* db may be closing mid-flight; heartbeat is best-effort */ }
  }, livenessHeartbeatMs);
  livenessTimer.unref();
  const clearLivenessHeartbeat = (): void => {
    if (livenessTimer !== null) { clearInterval(livenessTimer); livenessTimer = null; }
  };

  // ── cc_dispatch_closed: deterministic close on exit (symmetric) ──
  let dispatchClosureEmitted = false;
  const closeDispatch = (closureReason: string): void => {
    if (dispatchClosureEmitted) return;
    dispatchClosureEmitted = true;
    clearLivenessHeartbeat();
    try {
      emitEvent(db, {
        kind: "cc_dispatch_closed",
        substrate_origin: CLAUDE_ENGINE_ORIGIN,
        directive_id: req.directiveId,
        task_id: req.taskId,
        payload: {
          dispatch_id: dispatchId,
          closure_reason: closureReason,
          closed_at_ms: Date.now(),
          session_token: spawnSessionToken,
          subprocess_pid: spawnSubprocessPid,
          original_started_at_ms: spawnedAtMs,
          engine: "claude_code",
          emission_origin: "cc_bridge_spawn",
        } as JsonValue,
        invoker: CLAUDE_ENGINE_ORIGIN,
      });
    } catch { /* best-effort */ }
  };
  proc.exited.finally(() => { clearLivenessHeartbeat(); closeDispatch("cc_subprocess_exited"); });

  // ── Watchdog tiers: overall SIGTERM/SIGKILL + first-frame ──
  let killed = false;
  const sigTerm = setTimeout(() => {
    killed = true;
    try { proc.kill("SIGTERM"); } catch { /* swallow */ }
  }, timeoutMs);
  sigTerm.unref();
  const sigKill = setTimeout(() => {
    try { proc.kill("SIGKILL"); } catch { /* swallow */ }
  }, Math.floor(timeoutMs * 1.5));
  sigKill.unref();

  let firstFrameSeen = false;
  let framesReceivedCount = 0;
  let bridgeStuckFired = false;
  const stuckStartMs = Date.now();
  let lastFrameMs = stuckStartMs;
  const pollCadenceMs = Math.min(5_000, Math.max(500, Math.floor(firstFrameThresholdMs / 8)));
  const stuckInterval = setInterval(() => {
    if (bridgeStuckFired || firstFrameSeen) return;
    const sinceLastFrame = Date.now() - lastFrameMs;
    if (sinceLastFrame < firstFrameThresholdMs) return;
    bridgeStuckFired = true;
    try {
      emitEvent(db, {
        kind: "bridge_stuck",
        substrate_origin: CLAUDE_ENGINE_ORIGIN,
        directive_id: req.directiveId,
        task_id: req.taskId,
        payload: {
          reason: "no_frames_received",
          elapsed_ms: Date.now() - stuckStartMs,
          last_frame_ms_ago: sinceLastFrame,
          threshold_ms: firstFrameThresholdMs,
          first_frame_seen: false,
          tier: "first_frame",
          engine: "claude_code",
        } as JsonValue,
        invoker: CLAUDE_ENGINE_ORIGIN,
      });
    } catch { /* db closing */ }
    try { proc.kill("SIGTERM"); } catch { /* swallow */ }
  }, pollCadenceMs);
  stuckInterval.unref();

  // ── Stream stdout/stderr; parse stream-json frames into cc_frame_received ──
  let stdoutBuf = "";
  let stderrBuf = "";
  let cycleViolation: string | null = null;
  let finalResponse = "";
  let mcpHandshakeOk = false;

  const procStdout = proc.stdout as ReadableStream<Uint8Array>;
  const procStderr = proc.stderr as ReadableStream<Uint8Array>;
  const stdoutReader = procStdout.getReader();
  const stderrReader = procStderr.getReader();
  const stdoutDecoder = new TextDecoder();
  const stderrDecoder = new TextDecoder();
  const DRAIN_YIELD_EVERY_LINES = 25;
  const yieldToEventLoop = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

  const consumeLine = (line: string): void => {
    const trimmed = line.replace(/\r$/, "").trim();
    if (!trimmed) return;
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      finalResponse += trimmed + "\n";
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    framesReceivedCount += 1;
    if (!firstFrameSeen) firstFrameSeen = true;
    lastFrameMs = Date.now();
    const frameType = (parsed.type as string | undefined) ?? "other";

    // Every parsed frame is mirrored as cc_frame_received (symmetric to
    // bridge_frame_received) so the lifecycle is observable in the ledger.
    try {
      emitEvent(db, {
        kind: "cc_frame_received",
        substrate_origin: CLAUDE_ENGINE_ORIGIN,
        directive_id: req.directiveId,
        task_id: req.taskId,
        payload: {
          dispatch_id: dispatchId,
          frame_type: frameType,
          frame_index: framesReceivedCount,
          engine: "claude_code",
        } as JsonValue,
        invoker: CLAUDE_ENGINE_ORIGIN,
      });
    } catch { /* db closing */ }

    // Claude Code stream-json `result`/`text` frames carry the final answer.
    if (frameType === "result" || frameType === "text") {
      const text =
        (typeof parsed.result === "string" ? parsed.result : undefined)
        ?? (typeof parsed.text === "string" ? parsed.text : undefined)
        ?? "";
      if (text.length > 0) {
        finalResponse += text;
        try {
          emitEvent(db, {
            kind: "brain_message_emitted",
            substrate_origin: CLAUDE_ENGINE_ORIGIN,
            directive_id: req.directiveId,
            task_id: req.taskId,
            payload: { frame_type: frameType, text: text.slice(0, 4096), engine: "claude_code" } as JsonValue,
            invoker: CLAUDE_ENGINE_ORIGIN,
          });
        } catch { /* db closing */ }
      }
    }

    // MCP-handshake detection: any v2 substrate.*/runtime.* tool name proves
    // the engine connected to the daemon's MCP endpoint.
    if (!mcpHandshakeOk) {
      const toolName =
        (typeof parsed.tool === "string" ? parsed.tool : undefined)
        ?? (typeof parsed.name === "string" ? parsed.name : undefined);
      if (toolName && (toolName.startsWith("substrate") || toolName.startsWith("runtime") || toolName.includes("mcp__"))) {
        mcpHandshakeOk = true;
        try {
          emitEvent(db, {
            kind: "bridge_mcp_connected",
            substrate_origin: CLAUDE_ENGINE_ORIGIN,
            directive_id: req.directiveId,
            task_id: req.taskId,
            payload: { first_tool: toolName, mcp_server_url: mcpServerUrl, engine: "claude_code" } as JsonValue,
            invoker: CLAUDE_ENGINE_ORIGIN,
          });
        } catch { /* db closing */ }
      }
    }

    // Cycle-1-only gate — SHARED predicate with the opencode bridge so the two
    // engines can never drift on what counts as a self-iteration violation.
    if (isCycleViolation(frameType)) {
      cycleViolation = frameType;
      try { proc.kill("SIGTERM"); } catch { /* swallow */ }
    }
  };

  const drainStdout = async (): Promise<void> => {
    let linesSinceYield = 0;
    try {
      while (true) {
        const { done, value } = await stdoutReader.read();
        if (done) break;
        stdoutBuf += stdoutDecoder.decode(value, { stream: true });
        let nl = stdoutBuf.indexOf("\n");
        while (nl !== -1) {
          const line = stdoutBuf.slice(0, nl);
          stdoutBuf = stdoutBuf.slice(nl + 1);
          consumeLine(line);
          linesSinceYield += 1;
          if (linesSinceYield >= DRAIN_YIELD_EVERY_LINES) {
            linesSinceYield = 0;
            await yieldToEventLoop();
          }
          nl = stdoutBuf.indexOf("\n");
        }
      }
      const tail = stdoutDecoder.decode();
      if (tail.length > 0) stdoutBuf += tail;
      if (stdoutBuf.length > 0) consumeLine(stdoutBuf);
    } catch (err) {
      stderrBuf += `\nreader_error:${(err as Error).message}`;
    }
  };
  const drainStderr = async (): Promise<void> => {
    try {
      while (true) {
        const { done, value } = await stderrReader.read();
        if (done) break;
        stderrBuf += stderrDecoder.decode(value, { stream: true });
      }
      const tail = stderrDecoder.decode();
      if (tail.length > 0) stderrBuf += tail;
    } catch { /* swallow */ }
  };

  await Promise.all([drainStdout(), drainStderr()]);
  const exitCode = await proc.exited;
  clearTimeout(sigTerm);
  clearTimeout(sigKill);
  clearInterval(stuckInterval);
  clearLivenessHeartbeat();
  closeDispatch("cc_dispatch_drained");

  // ── Exit classification (symmetric to the opencode tail) ──
  if (bridgeStuckFired) {
    cleanupConfig();
    return {
      ok: false,
      reason: {
        kind: "subprocess_crash",
        stderr_tail: `subprocess_stuck:no_frames_received in ${firstFrameThresholdMs}ms tier=first_frame`,
      },
    };
  }
  if (cycleViolation) {
    cleanupConfig();
    emitEvent(db, {
      kind: "bridge_failed",
      substrate_origin: CLAUDE_ENGINE_ORIGIN,
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: { reason: `cycle_violation:${cycleViolation}`, mcp_handshake_ok: mcpHandshakeOk } as JsonValue,
      invoker: CLAUDE_ENGINE_ORIGIN,
    });
    return { ok: false, reason: { kind: "subprocess_crash", stderr_tail: `cycle_violation:${cycleViolation}` } };
  }
  if (killed) {
    cleanupConfig();
    emitEvent(db, {
      kind: "bridge_failed",
      substrate_origin: CLAUDE_ENGINE_ORIGIN,
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: {
        reason: "timeout",
        timeout_mode: "overall_wall_clock",
        ms_elapsed: elapsedMs(),
        timeout_ms: timeoutMs,
        mcp_handshake_ok: mcpHandshakeOk,
        frames_received_count: framesReceivedCount,
        engine: "claude_code",
      } as JsonValue,
      invoker: CLAUDE_ENGINE_ORIGIN,
    });
    return { ok: false, reason: { kind: "timeout", ms_elapsed: timeoutMs } };
  }
  if (exitCode !== 0) {
    cleanupConfig();
    emitEvent(db, {
      kind: "bridge_failed",
      substrate_origin: CLAUDE_ENGINE_ORIGIN,
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: {
        reason: "subprocess_crash",
        exit_code: exitCode,
        stderr_tail: stderrBuf.slice(-512),
        mcp_handshake_ok: mcpHandshakeOk,
        frames_received_count: framesReceivedCount,
        engine: "claude_code",
      } as JsonValue,
      invoker: CLAUDE_ENGINE_ORIGIN,
    });
    return { ok: false, reason: { kind: "subprocess_crash", stderr_tail: stderrBuf.slice(-512) } };
  }

  // ── Success: bridge_completed seals the audit trail ──
  cleanupConfig();
  const completed = emitEvent(db, {
    kind: "bridge_completed",
    substrate_origin: CLAUDE_ENGINE_ORIGIN,
    directive_id: req.directiveId,
    task_id: req.taskId,
    payload: {
      dispatch_id: dispatchId,
      final_response_chars: finalResponse.length,
      model,
      engine: "claude_code",
      real: true,
      mcp_handshake_ok: mcpHandshakeOk,
      frames_received_count: framesReceivedCount,
    } as JsonValue,
    invoker: CLAUDE_ENGINE_ORIGIN,
  });

  return {
    ok: true,
    final_response: finalResponse,
    usage: { tokens: 0 },
    emitted_event_ids: [completed.id],
  };
};

/** Mode-aware Claude Code dispatch entrypoint, symmetric to `opencodeQuery`.
 *  Reads `ACC2_BRIDGE_MODE`: `mock` runs the hermetic mock (no subprocess),
 *  anything else (default `real`) runs `spawnRealClaudeCode`. The dispatcher
 *  (increment 2) calls this so the test harness's mock pin keeps Claude
 *  dispatches hermetic the same way it does for opencode. */
export const claudeCodeQuery = async (
  req: BridgeRequest,
  db: Database,
): Promise<BridgeResult> => {
  const mode = process.env.ACC2_BRIDGE_MODE ?? "real";
  if (mode === "mock") {
    const { claudeCodeQueryMock } = await import("./mock");
    return claudeCodeQueryMock(req, db);
  }
  return spawnRealClaudeCode(req, db);
};

/** Structural descriptor for the Claude engine bridge — satisfies the shared
 *  `EngineBridge` contract so increment-2 executor selection can hold the
 *  opencode and claude engines behind one uniform reference. */
export const claudeEngineBridge: EngineBridge<ClaudeSpawnOpts> = {
  kind: CLAUDE_ENGINE_ORIGIN,
  spawn: spawnRealClaudeCode,
  mock: async (req, db) => {
    const { claudeCodeQueryMock } = await import("./mock");
    return claudeCodeQueryMock(req, db);
  },
};

// Re-export so callers that already mkdir the bridge log dir can mirror the
// opencode helper without re-implementing it. Kept here (not used internally
// in the scaffold path) so increment 2 can wire a stdout audit log symmetric
// to the opencode bridge's.
export const ensureClaudeBridgeLogDir = (stateDir: string): string => {
  const dir = `${stateDir}/logs/cc-bridge`;
  try { mkdirSync(dir, { recursive: true }); } catch { /* swallow */ }
  return dir;
};

export type { ClaudeSpawnOpts } from "./types";
