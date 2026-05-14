// acc2 brain-bridge real opencode subprocess (Phase E §12). Pulled out
// of the monolithic runtime/bridge.ts so the mock dispatcher and the
// MCP-config materializer can be imported independently.
//
// Spawns the `opencode run` CLI as a subprocess and streams its JSON
// event output. The subprocess is configured to use the daemon's MCP
// server via a per-dispatch `OPENCODE_CONFIG` file (see ./config.ts for
// materialization). Cycle-1-only is honored by SIGTERM-ing the
// subprocess if it ever emits a `brain_cycle_2_started` or
// `continue_cycle_requested` event — defense-in-depth alongside the
// dispatcher's event-stream scan.
//
// Watchdog: SIGTERM at req.timeout_ms (default 60s), SIGKILL at
// timeout × 1.5. Two further watchdogs run alongside:
//   - MCP handshake watchdog (30s): SIGTERM if no substrate.* /
//     runtime.* tool call lands; surfaces `mcp_handshake_failed`.
//   - No-progress watchdog (90s): SIGTERM if zero
//     `bridge_frame_received` frames have been observed; emits
//     `bridge_stuck` and surfaces `subprocess_stuck`.

import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import type { JsonValue } from "../../substrate/types";
import { emitEvent } from "../events";
import { isCycleViolation } from "../cycle_one_gate";
import type { BridgeFailureReason, BridgeRequest, BridgeResult, SpawnOpts } from "./types";
import {
  DEFAULT_BRIDGE_STUCK_THRESHOLD_MS,
  DEFAULT_MCP_HANDSHAKE_WINDOW_MS,
  DEFAULT_OPENCODE_MODEL,
  DEFAULT_TIMEOUT_MS,
  V2_OPENCODE_MCP_SERVER_NAME,
  isV2McpToolName,
  materializeOpencodeMcpConfig,
} from "./config";

export const spawnRealOpencode = async (
  req: BridgeRequest,
  db: Database,
  spawnOpts: SpawnOpts = {},
): Promise<BridgeResult> => {
  const model = spawnOpts.model ?? process.env.ACC2_OPENCODE_MODEL ?? DEFAULT_OPENCODE_MODEL;
  // Real opencode dispatches for non-trivial directives routinely exceed 60s
  // (model boot + reasoning + tool calls). Allow env override via
  // ACC2_OPENCODE_TIMEOUT_MS so operators don't have to recompile to bump
  // the watchdog. Defaults stay at 60s for hermetic test runs.
  const envTimeout = Number(process.env.ACC2_OPENCODE_TIMEOUT_MS ?? "");
  const timeoutMs = spawnOpts.timeoutMs
    ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_MS);
  const spawn = spawnOpts.spawnFn ?? Bun.spawn;
  // Handshake-window env override: operators bumping ACC2_OPENCODE_TIMEOUT_MS
  // for slow models / cold caches typically also need to widen the handshake
  // window (the brain may spend tens of seconds reasoning before its first
  // tool call). Defaults stay at 30s for hermetic tests.
  const envHandshake = Number(process.env.ACC2_OPENCODE_MCP_HANDSHAKE_MS ?? "");
  const handshakeWindowMs = spawnOpts.mcpHandshakeWindowMs
    ?? (Number.isFinite(envHandshake) && envHandshake > 0 ? envHandshake : DEFAULT_MCP_HANDSHAKE_WINDOW_MS);
  // No-progress watchdog: orthogonal to the overall timeout. Fires when the
  // subprocess goes silent (zero bridge_frame_received emissions) for
  // stuckThresholdMs.
  const envStuck = Number(process.env.ACC2_BRIDGE_STUCK_THRESHOLD_MS ?? "");
  const stuckThresholdMs = spawnOpts.stuckThresholdMs
    ?? (Number.isFinite(envStuck) && envStuck > 0 ? envStuck : DEFAULT_BRIDGE_STUCK_THRESHOLD_MS);

  emitEvent(db, {
    kind: "bridge_invoked",
    substrate_origin: "opencode",
    directive_id: req.directiveId,
    task_id: req.taskId,
    payload: { prompt_chars: req.prompt.length, model, real: true } as JsonValue,
    invoker: "opencode",
  });

  // ── Batch 2.β: materialize the per-dispatch opencode MCP config ──
  // The config declares v2's daemon MCP server (type=remote, HTTP) so
  // opencode, on `opencode run` boot, registers v2's `substrate.*` /
  // `runtime.*` tool surface as available and calls them instead of
  // producing a natural-language reply. Without this wiring, opencode
  // emits text only — the `no_action_predicted` failure mode documented in
  // docs/real-brain-runbook.md (Batch 2.α).
  const mcpServerUrl = spawnOpts.mcpServerUrl
    ?? process.env.V2_MCP_SERVER_URL
    ?? "";
  let materializedConfig: { configPath: string; tempDir: string } | null = null;
  if (mcpServerUrl.length === 0) {
    // No MCP URL → opencode will reason without v2's tool surface (the
    // pre-Batch-2.β behavior). Fail fast so operators see the gap.
    emitEvent(db, {
      kind: "bridge_failed",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: {
        reason: "mcp_server_url_missing",
        hint: "V2_MCP_SERVER_URL must point at the daemon's /mcp endpoint",
      } as JsonValue,
      invoker: "opencode",
    });
    return {
      ok: false,
      reason: { kind: "parse_error", raw: "V2_MCP_SERVER_URL not set; opencode would have no MCP tools" },
    };
  }
  try {
    materializedConfig = materializeOpencodeMcpConfig({
      mcpServerUrl,
      configDir: spawnOpts.configDir,
    });
  } catch (err) {
    emitEvent(db, {
      kind: "bridge_failed",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: {
        reason: `mcp_config_materialize_failed:${(err as Error).message}`,
      } as JsonValue,
      invoker: "opencode",
    });
    return { ok: false, reason: { kind: "parse_error", raw: (err as Error).message } };
  }

  // `opencode run` expects the message as positional args; piping via stdin
  // is not the documented path. We pass --format=json so opencode emits one
  // JSON event per stdout line.
  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn([
      "opencode", "run",
      "--format=json",
      "--model", model,
      "--dangerously-skip-permissions",
      req.prompt,
    ], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        // OPENCODE_CONFIG points at the per-dispatch config that declares
        // v2's MCP server. Verified: opencode 1.4.3 reads this env var and
        // merges its `mcp` block atop the operator's global config.
        OPENCODE_CONFIG: materializedConfig.configPath,
        // MCP_SERVER_URL is kept for backward-compat with any consumer in
        // the opencode env that reads it (the official wiring path is the
        // OPENCODE_CONFIG file above).
        MCP_SERVER_URL: mcpServerUrl,
        V2_MCP_SERVER_URL: mcpServerUrl,
      },
    });
  } catch (err) {
    // Spawn failed — cleanup the materialized config tempdir.
    try { rmSync(materializedConfig.tempDir, { recursive: true, force: true }); } catch { /* swallow */ }
    const reason: BridgeFailureReason = { kind: "auth_missing" };
    emitEvent(db, {
      kind: "bridge_failed",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: { reason: `spawn_failed:${(err as Error).message}` } as JsonValue,
      invoker: "opencode",
    });
    return { ok: false, reason };
  }

  // Watchdog: SIGTERM at timeoutMs, SIGKILL at timeoutMs * 1.5.
  let killed = false;
  const sigTerm = setTimeout(() => {
    killed = true;
    try { proc.kill("SIGTERM"); } catch { /* swallow */ }
  }, timeoutMs);
  const sigKill = setTimeout(() => {
    try { proc.kill("SIGKILL"); } catch { /* swallow */ }
  }, Math.floor(timeoutMs * 1.5));

  // ── MCP handshake watchdog (Batch 2.β) ──
  // Fires after handshakeWindowMs if opencode never invokes a substrate.*
  // or runtime.* tool. The bridge SIGTERMs the subprocess and surfaces
  // `mcp_handshake_failed` so operators see the wiring gap immediately
  // rather than waiting out the full dispatch watchdog. Cleared the moment
  // the first v2-tool call lands (bridge_mcp_connected event emission).
  let mcpHandshakeOk = false;
  let mcpHandshakeTimedOut = false;
  const mcpHandshakeWatchdog = setTimeout(() => {
    if (mcpHandshakeOk) return;
    mcpHandshakeTimedOut = true;
    try { proc.kill("SIGTERM"); } catch (err) {
      // already exited — log at debug only
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      void err;
    }
  }, handshakeWindowMs);

  // ── No-progress watchdog (robustness, fail-fast) ──
  // Mirrors the harness's --task validation finding: an opencode subprocess
  // that wedges produces no further frames; the operator waits out the full
  // 600s before learning anything is wrong. This watchdog fires when zero
  // bridge_frame_received events have been observed for stuckThresholdMs
  // (default 90s, env ACC2_BRIDGE_STUCK_THRESHOLD_MS). On fire we SIGTERM
  // the subprocess and emit `bridge_stuck` so operators see the wedge
  // immediately. `lastFrameMs` advances inside consumeLine() below every
  // time a tool_use / tool_call / tool_result is parsed.
  const stuckStartMs = Date.now();
  let lastFrameMs = stuckStartMs;
  let bridgeStuckFired = false;
  const stuckInterval = setInterval(() => {
    if (bridgeStuckFired) return;
    const now = Date.now();
    const sinceLastFrame = now - lastFrameMs;
    if (sinceLastFrame < stuckThresholdMs) return;
    bridgeStuckFired = true;
    const elapsedMs = now - stuckStartMs;
    try {
      emitEvent(db, {
        kind: "bridge_stuck",
        substrate_origin: "opencode",
        directive_id: req.directiveId,
        task_id: req.taskId,
        payload: {
          reason: "no_frames_received",
          elapsed_ms: elapsedMs,
          last_frame_ms_ago: sinceLastFrame,
          threshold_ms: stuckThresholdMs,
        } as JsonValue,
        invoker: "opencode",
      });
    } catch (err) {
      // db may have been closed mid-flight; the SIGTERM below is the
      // load-bearing reaction. Continue without throwing.
      void err;
    }
    try { proc.kill("SIGTERM"); } catch (err) { void err; }
  }, Math.min(5_000, Math.max(500, Math.floor(stuckThresholdMs / 4))));

  let stdoutBuf = "";
  let stderrBuf = "";
  let cycleViolation: string | null = null;
  let finalResponse = "";
  // Diagnostic mirror: when ACC2_OPENCODE_STDOUT_LOG points at a writable
  // path, every raw stdout line opencode emits is appended there. Operators
  // use this to inspect the exact JSON event sequence after an
  // `mcp_handshake_failed` so they can see whether opencode reasoned without
  // calling any tool, called a non-v2 tool, or errored out.
  const stdoutLogPath = process.env.ACC2_OPENCODE_STDOUT_LOG;
  const stdoutLogFh = stdoutLogPath ? Bun.file(stdoutLogPath).writer() : null;
  // opencode 1.4+ emits a top-level `{type:"error", error:{...}}` event when a
  // model id is invalid / auth fails / a provider call errors. opencode then
  // exits 0 anyway (the operator only gets the JSON), so the bridge must
  // surface the error explicitly rather than treating exit_code==0 as
  // success. The Batch 2.α smoke confirmed this against opencode 1.4.3 with
  // an invalid model id.
  let opencodeErrorEvent: { name?: string; message?: string } | null = null;

  // Stream stdout line-by-line.
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  const consumeLine = (line: string): void => {
    // Tolerate trailing whitespace and bare \r\n (Windows-spawned shells).
    const trimmed = line.replace(/\r$/, "").trim();
    if (!trimmed) return;
    if (stdoutLogFh) {
      try { stdoutLogFh.write(trimmed + "\n"); } catch { /* swallow */ }
    }
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Non-JSON line — append to final-response buffer (opencode's default
      // text mode would do this; --format=json should never hit here, but
      // we tolerate stray text).
      finalResponse += trimmed + "\n";
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const kind = parsed.type as string | undefined;
    // opencode 1.4+ structured error — capture and surface on completion.
    if (kind === "error") {
      const errObj = parsed.error as Record<string, unknown> | undefined;
      const data = (errObj?.data as Record<string, unknown> | undefined) ?? {};
      opencodeErrorEvent = {
        name: (errObj?.name as string) ?? "UnknownError",
        message: (data.message as string) ?? JSON.stringify(errObj ?? {}),
      };
    }
    // opencode 1.4+ final-answer text is delivered as one or more
    // `{type:"text", part:{text:"..."}}` events. Concatenate the part text
    // into finalResponse so callers see the brain's natural-language reply.
    if (kind === "text") {
      const part = parsed.part as Record<string, unknown> | undefined;
      const text = (part?.text as string) ?? "";
      if (text.length > 0) finalResponse += text;
    }
    // Mirror opencode tool events into the substrate for audit and detect
    // the MCP handshake. opencode 1.4.3 emits a tool invocation as
    //   {type:"tool_use", part:{type:"tool", tool:"<name>", ...}}
    // Earlier revs of the docs used `tool_call` / `tool_result`; we accept
    // both shapes plus a few plausible name locations to be resilient to
    // future opencode version drift.
    const isToolEvent =
      kind === "tool_use" || kind === "tool_call" || kind === "tool_result";
    if (isToolEvent) {
      // Bump the no-progress watchdog clock on every frame received so the
      // bridge_stuck path only fires when the subprocess goes truly silent.
      lastFrameMs = Date.now();
      emitEvent(db, {
        kind: "bridge_frame_received",
        substrate_origin: "opencode",
        directive_id: req.directiveId,
        task_id: req.taskId,
        payload: parsed as JsonValue,
        invoker: "opencode",
      });
      if (!mcpHandshakeOk && (kind === "tool_use" || kind === "tool_call")) {
        // Inspect every plausible tool-name location across opencode revs.
        const part = parsed.part as Record<string, unknown> | undefined;
        const candidates: Array<string | undefined> = [
          parsed.tool as string | undefined,
          parsed.name as string | undefined,
          part?.tool as string | undefined,
          part?.name as string | undefined,
        ];
        const hit = candidates.find((c) => isV2McpToolName(c));
        if (hit) {
          mcpHandshakeOk = true;
          clearTimeout(mcpHandshakeWatchdog);
          emitEvent(db, {
            kind: "bridge_mcp_connected",
            substrate_origin: "opencode",
            directive_id: req.directiveId,
            task_id: req.taskId,
            payload: {
              first_tool: hit,
              mcp_server_url: mcpServerUrl,
              server_name: V2_OPENCODE_MCP_SERVER_NAME,
            } as JsonValue,
            invoker: "opencode",
          });
        }
      }
    }
    // Cycle-1-only self-iteration signals — kill the process. Predicate
    // sourced from `cycle_one_gate.ts` so the mock-bridge dispatcher scan
    // and this real-bridge stdout scan can never drift on what counts as
    // a violation (v2-design.md §3.7).
    if (isCycleViolation(kind)) {
      cycleViolation = kind ?? null;
      try { proc.kill("SIGTERM"); } catch { /* swallow */ }
    }
    // Legacy final-response marker (opencode pre-1.4 emitted these). Kept for
    // forward-compat with future format revisions.
    if (kind === "final_response" || kind === "completed") {
      finalResponse = (parsed.text as string) ?? (parsed.final_response as string) ?? finalResponse;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      stdoutBuf += decoder.decode(value, { stream: true });
      let nl = stdoutBuf.indexOf("\n");
      while (nl !== -1) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        consumeLine(line);
        nl = stdoutBuf.indexOf("\n");
      }
    }
    if (stdoutBuf.length > 0) consumeLine(stdoutBuf);
  } catch (err) {
    stderrBuf += `\nreader_error:${(err as Error).message}`;
  }

  // Capture any remaining stderr for diagnostics.
  try {
    const stderrReader = proc.stderr.getReader();
    while (true) {
      const { done, value } = await stderrReader.read();
      if (done) break;
      stderrBuf += decoder.decode(value, { stream: true });
    }
  } catch (err) {
    // stderr draining is best-effort — never throw. Keep the diagnostic so
    // operators auditing JSONL output can see the read died vs ended.
    stderrBuf += `\nstderr_drain_error:${(err as Error).message}`;
  }

  const exitCode = await proc.exited;
  clearTimeout(sigTerm);
  clearTimeout(sigKill);
  clearTimeout(mcpHandshakeWatchdog);
  clearInterval(stuckInterval);
  if (stdoutLogFh) {
    try { await stdoutLogFh.end(); } catch { /* swallow */ }
  }

  // Always best-effort cleanup the materialized config tempdir, regardless
  // of how this run ends. Operators don't want orphan dirs piling up under
  // os.tmpdir() across long-running daemons.
  const cleanupConfig = (): void => {
    try {
      if (materializedConfig) {
        rmSync(materializedConfig.tempDir, { recursive: true, force: true });
      }
    } catch { /* swallow */ }
  };

  // Handshake check: failure means we observed no v2 tool call within the
  // handshake window OR the subprocess exited without ever calling one.
  // Either is a `no_action_predicted`-style gap and the bridge must surface
  // it explicitly rather than returning a misleading success. Note: cycle
  // violations and explicit error events have their own surfacing branches
  // below and are not bucketed here.
  const handshakeFailed =
    !mcpHandshakeOk
    && !cycleViolation
    && !opencodeErrorEvent
    && (mcpHandshakeTimedOut || exitCode === 0);
  if (handshakeFailed) {
    cleanupConfig();
    emitEvent(db, {
      kind: "bridge_failed",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: {
        reason: "mcp_handshake_failed",
        window_ms: handshakeWindowMs,
        mcp_server_url: mcpServerUrl,
        timed_out: mcpHandshakeTimedOut,
        exit_code: exitCode,
        hint:
          "opencode did not invoke any substrate.*/runtime.* tool before exit; "
          + "verify the daemon's /mcp endpoint is reachable, that opencode 1.4.3+ is on PATH, "
          + "and that the materialized OPENCODE_CONFIG declares v2's MCP server",
        stderr_tail: stderrBuf.slice(-512),
      } as JsonValue,
      invoker: "opencode",
    });
    return {
      ok: false,
      reason: {
        kind: "subprocess_crash",
        stderr_tail: `mcp_handshake_failed:no substrate.* tool call in ${handshakeWindowMs}ms`,
      },
    };
  }

  // No-progress watchdog fired during this run — surface the wedge as a
  // bridge_failed row whose reason is `subprocess_stuck`. The bridge_stuck
  // event was already emitted at fire time; the bridge_failed row is the
  // taxonomy entry callers consume. This is additive to the existing
  // bridge failure taxonomy — no reshaping (per brief).
  if (bridgeStuckFired) {
    cleanupConfig();
    emitEvent(db, {
      kind: "bridge_failed",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: {
        reason: "subprocess_stuck",
        no_frames_received: true,
        threshold_ms: stuckThresholdMs,
        exit_code: exitCode,
      } as JsonValue,
      invoker: "opencode",
    });
    return {
      ok: false,
      reason: {
        kind: "subprocess_crash",
        stderr_tail: `subprocess_stuck:no_frames_received in ${stuckThresholdMs}ms`,
      },
    };
  }

  if (cycleViolation) {
    cleanupConfig();
    emitEvent(db, {
      kind: "bridge_failed",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: { reason: `cycle_violation:${cycleViolation}` } as JsonValue,
      invoker: "opencode",
    });
    return { ok: false, reason: { kind: "subprocess_crash", stderr_tail: `cycle_violation:${cycleViolation}` } };
  }

  if (killed) {
    cleanupConfig();
    emitEvent(db, {
      kind: "bridge_failed",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: { reason: "timeout", ms_elapsed: timeoutMs } as JsonValue,
      invoker: "opencode",
    });
    return { ok: false, reason: { kind: "timeout", ms_elapsed: timeoutMs } };
  }

  if (exitCode !== 0) {
    cleanupConfig();
    emitEvent(db, {
      kind: "bridge_failed",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: { reason: "subprocess_crash", exit_code: exitCode, stderr_tail: stderrBuf.slice(-512) } as JsonValue,
      invoker: "opencode",
    });
    return { ok: false, reason: { kind: "subprocess_crash", stderr_tail: stderrBuf.slice(-512) } };
  }

  // Exit-code 0 + a structured opencode error event = parse_error / auth /
  // provider failure. opencode 1.4+ exits 0 even on `Model not found` so the
  // bridge must inspect the JSON event stream rather than trust the exit
  // code alone (Batch 2.α hardening).
  if (opencodeErrorEvent) {
    cleanupConfig();
    const msg = opencodeErrorEvent.message ?? "unknown opencode error";
    const reason: BridgeFailureReason = msg.toLowerCase().includes("auth")
      ? { kind: "auth_missing" }
      : { kind: "parse_error", raw: msg.slice(0, 512) };
    emitEvent(db, {
      kind: "bridge_failed",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: {
        reason: `opencode_error_event:${opencodeErrorEvent.name ?? "UnknownError"}`,
        message: msg,
      } as JsonValue,
      invoker: "opencode",
    });
    return { ok: false, reason };
  }

  cleanupConfig();
  emitEvent(db, {
    kind: "bridge_completed",
    substrate_origin: "opencode",
    directive_id: req.directiveId,
    task_id: req.taskId,
    payload: {
      final_response_chars: finalResponse.length,
      model,
      real: true,
      mcp_handshake_ok: mcpHandshakeOk,
    } as JsonValue,
    invoker: "opencode",
  });

  return {
    ok: true,
    final_response: finalResponse,
    usage: { tokens: 0 }, // opencode does not surface usage on stdout reliably
    emitted_event_ids: [],
  };
};
