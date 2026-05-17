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
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "../../substrate/types";
import { emitEvent } from "../events";
import { isCycleViolation } from "../cycle_one_gate";
import { parseOpencodeAuth } from "../../cli/doctor";
import type { BridgeFailureReason, BridgeRequest, BridgeResult, SpawnOpts } from "./types";
import {
  DEFAULT_BRIDGE_FIRST_FRAME_THRESHOLD_MS,
  DEFAULT_BRIDGE_STUCK_THRESHOLD_MS,
  DEFAULT_MCP_HANDSHAKE_WINDOW_MS,
  DEFAULT_OPENCODE_MODEL,
  DEFAULT_TIMEOUT_MS,
  V2_OPENCODE_MCP_SERVER_NAME,
  isV2McpToolName,
  materializeOpencodeMcpConfig,
} from "./config";

/** Module-level registry of live opencode subprocesses. The daemon's
 *  stop() handler calls killAllLiveOpencodeProcs() to SIGTERM-then-SIGKILL
 *  every still-running brain dispatch so they cannot survive past daemon
 *  shutdown (orphan-to-init pattern that produced stale MCP handshake
 *  failures against a dead daemon URL on the next boot). Each spawn
 *  registers its proc here and de-registers on exit. */
type LiveProc = { pid: number; kill: (sig: NodeJS.Signals) => boolean };
const LIVE_OPENCODE_PROCS: Set<LiveProc> = new Set();

/** Default opencode auth probe — runs `opencode auth list` and parses the
 *  output into a credential / env-provider snapshot. Returns null when the
 *  probe could not run (binary missing, exit non-zero). The bridge treats
 *  a null result as "unknown — proceed and let the spawn-time error path
 *  surface the failure" so a transient probe glitch doesn't block real
 *  dispatches. Tests inject deterministic values via SpawnOpts.authProbe. */
const defaultAuthProbe = (): { credentialCount: number; envProviderCount: number } | null => {
  const out = spawnSync("opencode", ["auth", "list"], { encoding: "utf8" });
  if (out.status !== 0) return null;
  const raw = (out.stdout ?? out.stderr ?? "").trim();
  if (raw.length === 0) return null;
  const state = parseOpencodeAuth(raw);
  return { credentialCount: state.credentialCount, envProviderCount: state.envProviderCount };
};

/** Idempotency window for `hidl_action_required` emission. Two failures of
 *  the same reason within this window collapse to one HIDL row so the
 *  owner sees the gap once, not on every retry. */
const HIDL_AUTH_IDEMPOTENCY_WINDOW = "-1 hour";

/** Returns true when a `hidl_action_required` row with the matching reason
 *  was emitted within the last hour. Used by both the pre-flight
 *  ("auth_missing") and post-flight ("auth_expired") paths so a stuck-auth
 *  scenario doesn't flood the ledger with duplicate HIDL cards. */
const hasRecentAuthHidl = (db: Database, reason: "auth_missing" | "auth_expired"): boolean => {
  const row = db
    .query(
      `SELECT 1 FROM events
       WHERE kind = 'hidl_action_required'
         AND json_extract(payload, '$.reason') = ?
         AND ts > datetime('now', ?)
       LIMIT 1`,
    )
    .get(reason, HIDL_AUTH_IDEMPOTENCY_WINDOW);
  return row !== null;
};

/** Emit `hidl_action_required` carrying the owner-facing summary +
 *  suggested action so the gap shows up inline (mirror_inline=true on the
 *  kind registry, see substrate/event_kinds.ts:205). Idempotent — caller
 *  must check `hasRecentAuthHidl` first. */
const emitAuthHidl = (
  db: Database,
  req: BridgeRequest,
  reason: "auth_missing" | "auth_expired",
  detail: string,
): void => {
  emitEvent(db, {
    kind: "hidl_action_required",
    substrate_origin: "substrate_auto",
    directive_id: req.directiveId,
    task_id: req.taskId,
    payload: {
      summary:
        reason === "auth_missing"
          ? "Brain dispatch blocked — opencode has no auth providers configured"
          : "Brain dispatch failed — opencode auth appears expired or rejected",
      reason,
      blocked_task_id: req.taskId,
      suggested_action:
        "Run: opencode auth login   (pick OpenAI for the brain; OpenAI Max subscription is the canonical path)",
      detail,
      evidence_event_ids: [],
    } as JsonValue,
    invoker: "opencode",
  });
};

/** Stderr substrings that signal an auth-shaped post-flight failure. Match
 *  is case-insensitive; any hit promotes a non-zero opencode exit into an
 *  `auth_expired` HIDL emission so the owner sees the gap inline rather
 *  than buried in a `subprocess_crash` row. */
const AUTH_STDERR_MARKERS = [
  "no provider",
  "no providers",
  "authentication failed",
  "authentication error",
  "401",
  "unauthorized",
  "invalid api key",
  "invalid_api_key",
  "missing api key",
  "auth token expired",
  "expired token",
];

const stderrIndicatesAuthFailure = (stderr: string): boolean => {
  if (!stderr) return false;
  const lower = stderr.toLowerCase();
  return AUTH_STDERR_MARKERS.some((m) => lower.includes(m));
};

/** Kill every live opencode subprocess. SIGTERM first; SIGKILL after 1.5s
 *  per process. Called from daemon.stop() so children never outlive the
 *  parent. Returns the number of procs that were signalled. */
export const killAllLiveOpencodeProcs = (): number => {
  const snapshot = Array.from(LIVE_OPENCODE_PROCS);
  for (const p of snapshot) {
    try { p.kill("SIGTERM"); } catch { /* swallow */ }
    setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* swallow */ } }, 1_500).unref();
  }
  LIVE_OPENCODE_PROCS.clear();
  return snapshot.length;
};

export const spawnRealOpencode = async (
  req: BridgeRequest,
  db: Database,
  spawnOpts: SpawnOpts = {},
): Promise<BridgeResult> => {
  const bridgeStartedAtMs = Date.now();
  const model = spawnOpts.model ?? process.env.ACC2_OPENCODE_MODEL ?? DEFAULT_OPENCODE_MODEL;
  const timeoutMs = spawnOpts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawn = spawnOpts.spawnFn ?? Bun.spawn;
  const handshakeWindowMs = spawnOpts.mcpHandshakeWindowMs ?? DEFAULT_MCP_HANDSHAKE_WINDOW_MS;
  const stuckThresholdMs = spawnOpts.stuckThresholdMs ?? DEFAULT_BRIDGE_STUCK_THRESHOLD_MS;
  const firstFrameThresholdMs = spawnOpts.firstFrameThresholdMs ?? DEFAULT_BRIDGE_FIRST_FRAME_THRESHOLD_MS;

  emitEvent(db, {
    kind: "bridge_invoked",
    substrate_origin: "opencode",
    directive_id: req.directiveId,
    task_id: req.taskId,
    payload: {
      prompt_chars: req.prompt.length,
      model,
      real: true,
      budget_estimate: {
        wall_ms: timeoutMs,
        mcp_handshake_window_ms: handshakeWindowMs,
        first_frame_threshold_ms: firstFrameThresholdMs,
        stuck_threshold_ms: stuckThresholdMs,
      },
    } as JsonValue,
    invoker: "opencode",
  });

  // ── Auth pre-flight (2026-05-15) ──
  // Run `opencode auth list` BEFORE materializing config or spawning the
  // subprocess. If the probe reports 0 credentials AND 0 env providers,
  // the dispatch is known-failed — surface the gap as a HIDL action card
  // (mirror_inline=true via the event-kind registry) and return immediately
  // so the scheduler doesn't burn a subprocess on a guaranteed auth failure.
  // Idempotent: at most one HIDL row per reason per hour. A null probe
  // result (binary missing, transient error) is treated as "unknown,
  // proceed" — the existing spawn-time / exit-code paths surface the gap
  // if it materializes there. Matches the structural pattern from
  // runtime/embedder.ts (env_missing / OPENAI_API_KEY) so the owner sees
  // both brain and embedder auth gaps through the same HIDL surface.
  // Test-mode coupling: when `spawnFn` is injected but `authProbe` is not,
  // we default to "probe unknown" (return null) rather than running the
  // real `opencode auth list` subprocess. Tests that stub spawn already
  // own the dispatch surface; the auth probe would otherwise leak host
  // state (developer machine auth) into deterministic test fixtures. Tests
  // exercising the pre-flight path inject `authProbe` explicitly.
  const probeDefault = spawnOpts.spawnFn ? ((): null => null) : defaultAuthProbe;
  const authProbe = spawnOpts.authProbe ?? probeDefault;
  const authState = authProbe();
  if (authState !== null && authState.credentialCount === 0 && authState.envProviderCount === 0) {
    if (!hasRecentAuthHidl(db, "auth_missing")) {
      emitAuthHidl(
        db,
        req,
        "auth_missing",
        "opencode auth list reported 0 credentials and 0 env providers",
      );
    }
    emitEvent(db, {
      kind: "bridge_failed",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: {
        reason: "auth_missing",
        mcp_handshake_ok: false,
        hint: "opencode has no auth providers configured — run `opencode auth login`",
      } as JsonValue,
      invoker: "opencode",
    });
    return { ok: false, reason: { kind: "auth_missing" } };
  }

  // Brain audit b0kheqg3g hole D (2026-05-15): persist the composed prompt
  // so auditors can inspect what the brain saw. The depth-1-retrieval claim
  // (v2-design §13) is falsifiable only when the prompt is in the ledger.
  // Capped at PROMPT_FULL_CAP_CHARS to keep SQLite bounded; sha256 +
  // chars_original give exact provenance.
  const PROMPT_FULL_CAP_CHARS = 32_768;
  try {
    const promptHasher = new Bun.CryptoHasher("sha256");
    promptHasher.update(req.prompt);
    const promptSha256 = promptHasher.digest("hex");
    const truncated = req.prompt.length > PROMPT_FULL_CAP_CHARS;
    emitEvent(db, {
      kind: "brain_prompt_composed",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: {
        sha256: promptSha256,
        chars_original: req.prompt.length,
        truncated,
        text: truncated ? req.prompt.slice(0, PROMPT_FULL_CAP_CHARS) : req.prompt,
        cap_chars: PROMPT_FULL_CAP_CHARS,
        model,
      } as JsonValue,
      invoker: "opencode",
    });
  } catch (err) {
    // Observability is best-effort — never break the dispatch.
    void err;
  }

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
        // Round-2 audit (2026-05-15): every bridge_failed carries
        // mcp_handshake_ok so the depth-1 retrieval health metric is a
        // single SQL scan. Pre-spawn failures hard-code false (no MCP
        // call is structurally possible).
        mcp_handshake_ok: false,
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
        mcp_handshake_ok: false,
      } as JsonValue,
      invoker: "opencode",
    });
    return { ok: false, reason: { kind: "parse_error", raw: (err as Error).message } };
  }

  // `opencode run` expects the message as positional args; piping via stdin
  // is not the documented path. We pass --format=json so opencode emits one
  // JSON event per stdout line. Do NOT pass
  // --dangerously-skip-permissions: the per-dispatch config explicitly keeps
  // the brain read-only and denies direct source mutation tools.
  // Sandbox the brain's CWD AND env. When `checkoutIsolation` is explicit,
  // honor it (workflow-isolated dispatches, tests). Otherwise spawn the
  // brain in a per-dispatch empty tempdir so its built-in filesystem tools
  // (edit / write / bash) cannot reach the source checkout even if the
  // BRAIN_READONLY_PERMISSION policy fails to apply (induced by a newer
  // opencode rev, a config-merge edge case, or a tool name not covered by
  // the deny patterns). This is defense-in-depth A behind the permission
  // policy. The env var ACC2_CHECKOUT_ISOLATION_ROOT used to default to
  // sourceCheckoutRoot which LEAKED the source path — observed 2026-05-16
  // (Q2NTPKM + K8YKPXDZXX): brain dispatches wrote files like
  // cli/lineage.ts, cli/whoami.ts, runtime/experience_compression_worker.ts
  // DIRECTLY to the source checkout, bypassing applied_change_committed
  // entirely. The fix below routes the env var to brainWorkspace by
  // default. If the brain legitimately needs to reason about source code,
  // it MUST go through substrate.read / substrate.search (which honors the
  // event ledger and credit chains), not raw filesystem ops.
  const sourceCheckoutRoot = process.cwd();
  void sourceCheckoutRoot; // retained for future reuse; intentionally unused
  const brainWorkspace = req.checkoutIsolation?.root
    ?? mkdtempSync(join(tmpdir(), "acc2-brain-ws-"));
  const brainWorkspaceIsEphemeral = req.checkoutIsolation === undefined;
  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn([
      "opencode", "run",
      "--format=json",
      "--model", model,
      req.prompt,
    ], {
      cwd: brainWorkspace,
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
        ACC2_CHECKOUT_ISOLATION_ROOT: req.checkoutIsolation?.root ?? brainWorkspace,
        ACC2_CHECKOUT_ISOLATION_REASON: req.checkoutIsolation?.reason ?? "main_checkout_selected",
        ACC2_CHECKOUT_MERGE_BACK_STRATEGY: req.checkoutIsolation?.mergeBackStrategy ?? "main_checkout",
        ACC2_BRAIN_WORKSPACE: brainWorkspace,
      },
    });
  } catch (err) {
    // Spawn failed — cleanup the materialized config tempdir + brain workspace.
    try { rmSync(materializedConfig.tempDir, { recursive: true, force: true }); } catch { /* swallow */ }
    if (brainWorkspaceIsEphemeral) {
      try { rmSync(brainWorkspace, { recursive: true, force: true }); } catch { /* swallow */ }
    }
    const reason: BridgeFailureReason = { kind: "auth_missing" };
    emitEvent(db, {
      kind: "bridge_failed",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: {
        reason: `spawn_failed:${(err as Error).message}`,
        mcp_handshake_ok: false,
      } as JsonValue,
      invoker: "opencode",
    });
    return { ok: false, reason };
  }

  // Register the live proc so daemon shutdown can kill it (prevents
  // orphan-to-init zombies that fail MCP handshake against a dead URL
  // on the next daemon boot).
  const liveEntry: LiveProc = {
    pid: proc.pid ?? 0,
    kill: (sig) => { try { proc.kill(sig); return true; } catch { return false; } },
  };
  LIVE_OPENCODE_PROCS.add(liveEntry);
  proc.exited.finally(() => { LIVE_OPENCODE_PROCS.delete(liveEntry); });

  // Watchdog: SIGTERM at timeoutMs, SIGKILL at timeoutMs * 1.5.
  let killed = false;
  const sigTerm = setTimeout(() => {
    killed = true;
    try { proc.kill("SIGTERM"); } catch { /* swallow */ }
  }, timeoutMs);
  const sigKill = setTimeout(() => {
    try { proc.kill("SIGKILL"); } catch { /* swallow */ }
  }, Math.floor(timeoutMs * 1.5));

  // ── MCP handshake watchdog (Batch 2.β, sliding window 2026-05-15) ──
  // Tracks whether opencode invoked any v2-tool (substrate.* / runtime.*).
  // Cleared the moment the first v2-tool call lands (bridge_mcp_connected
  // event emission).
  //
  // Pre-fix: a setTimeout at handshakeWindowMs (120s) SIGTERMed the
  // subprocess if no MCP tool had been called. This false-positive-killed
  // brain runs that legitimately used opencode built-in tools (`bash`,
  // `read`, `grep`) for the first 120s before invoking MCP — exactly the
  // pattern the user surfaced in the live ledger (bridge_frame_received
  // tool_use at 01:41:39 was a non-MCP tool, the bridge killed the brain
  // 4s later at 01:41:43 even though the subprocess was actively working).
  //
  // Post-fix: handshake failure surfaces ONLY when the subprocess exits
  // having never invoked an MCP tool. The no-progress watchdog (90s
  // silence) handles wedged subprocesses; the overall timeout (600s)
  // bounds runaway ones. The handshake is a result classification, not a
  // kill trigger.
  let mcpHandshakeOk = false;
  let mcpHandshakeTimedOut = false;
  const mcpHandshakeDeadlineMs = Date.now() + handshakeWindowMs;
  const mcpHandshakeWatchdog = setInterval(() => {
    if (mcpHandshakeOk) {
      clearInterval(mcpHandshakeWatchdog);
      return;
    }
    if (Date.now() >= mcpHandshakeDeadlineMs && !mcpHandshakeTimedOut) {
      mcpHandshakeTimedOut = true;
      // Diagnostic only — do NOT kill. Brain may legitimately use built-in
      // tools before invoking MCP. The exit-time handshake check will
      // surface mcp_handshake_failed if the subprocess ends without an
      // MCP call; before that, give the full overall-timeout budget.
    }
  }, Math.min(5_000, Math.max(500, Math.floor(handshakeWindowMs / 10))));

  // ── No-progress watchdog (robustness, fail-fast) ──
  // The watchdog only fires BEFORE the first MCP frame lands. Once
  // `firstFrameSeen` flips true (the subprocess proved it can drive
  // MCP), the watchdog disables itself — the overall `timeoutMs`
  // budget (default 600s) becomes the sole inter-frame cap. Live
  // ledger evidence proved an inter-frame watchdog at any sub-overall
  // threshold (90s, 240s) kills the brain mid-strategic-synthesis;
  // the brain legitimately reasons silently for minutes between MCP
  // tool calls.
  // Surfaced as `bridge_stuck` with `tier=first_frame` when it fires,
  // and `tier=disabled` would only appear in the (impossible-by-
  // construction) case where firstFrameSeen flipped and then somehow
  // the watchdog fired anyway — we never emit it in practice.
  const stuckStartMs = Date.now();
  let lastFrameMs = stuckStartMs;
  let firstFrameSeen = false;
  let framesReceivedCount = 0;
  let bridgeStuckFired = false;
  const pollCadenceMs = Math.min(5_000, Math.max(500, Math.floor(firstFrameThresholdMs / 8)));
  // Substrate-side progress reconciliation (FOUNDATIONAL FIX 2026-05-16):
  // opencode 1.4.3 routes MCP via internal HTTP, so stdout `firstFrameSeen`
  // stays false forever even when the brain is actively making progress via
  // dozens of MCP tool calls. Pre-fix the watchdog killed the brain at
  // firstFrameThresholdMs (5min default) right in the middle of legitimate
  // strategic synthesis — every successful opencode 1.4 dispatch that took
  // longer than the threshold was mis-killed. Cite ledger evidence:
  // bridge_stuck task=Q4HMCH30BS5030E5 reason=no_frames_received
  // elapsed_ms=303312 fired AFTER the brain had already emitted multiple
  // substrate events via HTTP — the watchdog just couldn't see them.
  // The reconciliation: flip firstFrameSeen=true if substrate has any
  // events with task_id=req.taskId AND invoker='claude_root' since dispatch
  // start. Same canonical truth source as the exit-time handshake check.
  const checkSubstrateProgress = (): boolean => {
    try {
      const sinceIso = new Date(stuckStartMs).toISOString();
      const hit = db
        .query<{ n: number }, [string, string]>(
          `SELECT COUNT(*) AS n FROM events
           WHERE task_id = ?
             AND ts >= ?
             AND invoker = 'claude_root'`,
        )
        .get(req.taskId, sinceIso);
      return !!hit && hit.n > 0;
    } catch { return false; }
  };

  const stuckInterval = setInterval(() => {
    if (bridgeStuckFired) return;
    // Once we've seen a frame, the subprocess is alive — trust the
    // overall timeout (600s default) as the cap. This is the
    // load-bearing fix: pre-fix inter-frame watchdog killed slow
    // legitimate brain reasoning between MCP calls.
    if (firstFrameSeen) return;
    // Substrate-side progress check: if the brain has been emitting
    // events via the v2 MCP server (invoker='claude_root'), that proves
    // the subprocess is alive and making progress even though stdout is
    // silent. Flip firstFrameSeen so the watchdog disables itself for
    // the remainder of the dispatch (the overall timeout takes over).
    if (checkSubstrateProgress()) {
      firstFrameSeen = true;
      lastFrameMs = Date.now();
      // Also flip the handshake flag — substrate progress IS the handshake
      // (per CLAUDE.md: substrate is the canonical truth). This keeps the
      // exit-time reconciliation from having to re-detect the same evidence
      // and removes any window where the overall-timeout path could race
      // into a misleading bridge_failed{reason=timeout} after the watchdog
      // already proved the brain was alive.
      if (!mcpHandshakeOk) {
        mcpHandshakeOk = true;
        clearInterval(mcpHandshakeWatchdog);
      }
      try {
        emitEvent(db, {
          kind: "bridge_mcp_connected",
          substrate_origin: "opencode",
          directive_id: req.directiveId,
          task_id: req.taskId,
          payload: {
            detection_path: "substrate_progress_watchdog",
            mcp_server_url: mcpServerUrl,
            server_name: V2_OPENCODE_MCP_SERVER_NAME,
            note: "opencode 1.4 routes MCP via HTTP; watchdog detected brain progress via substrate poll, not stdout. Disabling no-frames watchdog for the remainder of the dispatch.",
          } as JsonValue,
          invoker: "opencode",
        });
      } catch (err) { void err; }
      return;
    }
    const now = Date.now();
    const sinceLastFrame = now - lastFrameMs;
    if (sinceLastFrame < firstFrameThresholdMs) return;
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
          threshold_ms: firstFrameThresholdMs,
          first_frame_seen: false,
          tier: "first_frame",
          substrate_progress_observed: false,
        } as JsonValue,
        invoker: "opencode",
      });
    } catch (err) {
      // db may have been closed mid-flight; the SIGTERM below is the
      // load-bearing reaction. Continue without throwing.
      void err;
    }
    try { proc.kill("SIGTERM"); } catch (err) { void err; }
  }, pollCadenceMs);

  let stdoutBuf = "";
  let stderrBuf = "";
  let cycleViolation: string | null = null;
  let finalResponse = "";
  // Brain audit b0kheqg3g (2026-05-15): persist a CAPPED slice of the
  // brain's message + reasoning frames so auditors can see what the
  // model actually said between tool calls. Hard caps keep the ledger
  // bounded:
  //   - 4096 chars per emitted brain_message_emitted / brain_reasoning_recorded
  //   - 20 emits per task in total; further frames are summarised by a
  //     single brain_message_emitted with payload.suppressed=true so
  //     auditors see the drop without flooding rows.
  const BRAIN_OBS_MAX_CHARS = 4096;
  const BRAIN_OBS_MAX_EMITS = 20;
  let brainObsEmitCount = 0;
  let brainObsSuppressionFired = false;
  const emitBrainObs = (eventKind: "brain_message_emitted" | "brain_reasoning_recorded", frameType: string, text: string, extra?: Record<string, unknown>) => {
    if (brainObsEmitCount >= BRAIN_OBS_MAX_EMITS) {
      if (!brainObsSuppressionFired) {
        brainObsSuppressionFired = true;
        try {
          emitEvent(db, {
            kind: "brain_message_emitted",
            substrate_origin: "opencode",
            directive_id: req.directiveId,
            task_id: req.taskId,
            payload: {
              suppressed: true,
              reason: "brain_obs_cap_reached",
              cap: BRAIN_OBS_MAX_EMITS,
              note: "further model messages/reasoning omitted from the ledger to keep payload bounded",
            } as JsonValue,
            invoker: "opencode",
          });
        } catch (err) { void err; }
      }
      return;
    }
    const truncated = text.length > BRAIN_OBS_MAX_CHARS;
    const capped = truncated ? text.slice(0, BRAIN_OBS_MAX_CHARS) : text;
    try {
      emitEvent(db, {
        kind: eventKind,
        substrate_origin: "opencode",
        directive_id: req.directiveId,
        task_id: req.taskId,
        payload: {
          frame_type: frameType,
          text: capped,
          chars_original: text.length,
          truncated,
          cap_chars: BRAIN_OBS_MAX_CHARS,
          ...(extra ?? {}),
        } as JsonValue,
        invoker: "opencode",
      });
      brainObsEmitCount++;
    } catch (err) { void err; }
  };
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
    framesReceivedCount += 1;
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
      if (text.length > 0) {
        finalResponse += text;
        // Brain audit b0kheqg3g: mirror the model's final-answer text to
        // the substrate (capped + rate-limited) so auditors can review the
        // brain's natural-language reply without scraping the bridge stdout.
        emitBrainObs("brain_message_emitted", "text", text);
      }
    }
    // Brain audit b0kheqg3g (2026-05-15): persist the model's MESSAGE
    // and STEP frames so the brain's mid-cycle reasoning is observable.
    // These were previously dropped silently into finalResponse.
    if (kind === "message") {
      const text = (parsed.text as string) ?? ((parsed.content as Record<string, unknown> | undefined)?.text as string) ?? "";
      if (text.length > 0) emitBrainObs("brain_message_emitted", "message", text);
    }
    if (kind === "step_start" || kind === "step_complete") {
      const label = (parsed.label as string) ?? (parsed.step as string) ?? "";
      const text = label.length > 0 ? label : JSON.stringify(parsed).slice(0, 1024);
      emitBrainObs("brain_reasoning_recorded", kind, text);
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
      // Flip the first-frame bit so the watchdog switches from the
      // generous first-frame budget to the tight inter-frame threshold.
      lastFrameMs = Date.now();
      firstFrameSeen = true;
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
          clearInterval(mcpHandshakeWatchdog);
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
  clearInterval(mcpHandshakeWatchdog);
  clearInterval(stuckInterval);
  if (stdoutLogFh) {
    try { await stdoutLogFh.end(); } catch { /* swallow */ }
  }

  // Always best-effort cleanup the materialized config tempdir + the
  // ephemeral brain-workspace cwd, regardless of how this run ends.
  // Operators don't want orphan dirs piling up under os.tmpdir() across
  // long-running daemons. Skip the workspace cleanup when caller passed an
  // explicit checkoutIsolation root (they own its lifecycle).
  const cleanupConfig = (): void => {
    try {
      if (materializedConfig) {
        rmSync(materializedConfig.tempDir, { recursive: true, force: true });
      }
    } catch { /* swallow */ }
    if (brainWorkspaceIsEphemeral) {
      try { rmSync(brainWorkspace, { recursive: true, force: true }); } catch { /* swallow */ }
    }
  };

  const bridgeElapsedMs = (): number => Math.max(0, Date.now() - bridgeStartedAtMs);
  const budgetObserved = (terminalReason: string): Record<string, unknown> => ({
    terminal_reason: terminalReason,
    wall_ms: bridgeElapsedMs(),
    timeout_ms: timeoutMs,
    mcp_handshake_window_ms: handshakeWindowMs,
    mcp_handshake_timed_out: mcpHandshakeTimedOut,
    mcp_handshake_ok: mcpHandshakeOk,
    first_frame_threshold_ms: firstFrameThresholdMs,
    first_frame_seen: firstFrameSeen,
    bridge_stuck_fired: bridgeStuckFired,
  });

  // ── Substrate-side handshake reconciliation (foundational fix 2026-05-16) ──
  // The stdout-only handshake gate (mcpHandshakeOk above) was designed for an
  // older opencode rev that emitted MCP tool calls as `{type:"tool_use",...}`
  // frames on stdout. opencode 1.4.3 (the current rev) handles MCP via the
  // internal HTTP transport and ONLY emits final `{type:"text",part:{...}}`
  // frames on stdout — tool calls never appear there. The stdout gate
  // therefore reports `mcpHandshakeOk=false` even for dispatches where the
  // brain successfully invoked dozens of MCP tools.
  //
  // The canonical truth is the SUBSTRATE (per CLAUDE.md: "Substrate is the
  // operator"). If ANY event landed during this bridge invocation whose
  // task_id matches AND whose invoker/origin proves it came through the v2
  // MCP server (origin='opencode' or invoker='claude_root' — the default
  // invoker the MCP server stamps on unattributed calls per
  // runtime/mcp_server/index.ts:87), the brain DID use MCP. Treat that as
  // a successful handshake even if no stdout frame was parsed.
  //
  // This converts the previous false-positive brain_silent_exit (~100% on
  // opencode 1.4 dispatches) into honest classification: only dispatches
  // that produced NEITHER stdout frames NOR substrate events are real
  // prompt-compliance failures.
  if (!mcpHandshakeOk) {
    try {
      const bridgeStartIso = new Date(bridgeStartedAtMs).toISOString();
      // Filter on invoker='claude_root' SPECIFICALLY because that's the
      // marker the v2 MCP server stamps on every call from opencode that
      // doesn't carry an explicit invoker (runtime/mcp_server/index.ts:87
      // `invoker: opts.invoker ?? "claude_root"`). The bridge's OWN emits
      // (bridge_invoked, brain_prompt_composed, retrieval_binding, etc.)
      // use invoker='opencode' — they must NOT count toward the handshake
      // or the gate becomes a tautology that always passes.
      const hit = db
        .query<{ n: number }, [string, string]>(
          `SELECT COUNT(*) AS n FROM events
           WHERE task_id = ?
             AND ts >= ?
             AND invoker = 'claude_root'`,
        )
        .get(req.taskId, bridgeStartIso);
      if (hit && hit.n > 0) {
        mcpHandshakeOk = true;
        clearInterval(mcpHandshakeWatchdog);
        emitEvent(db, {
          kind: "bridge_mcp_connected",
          substrate_origin: "opencode",
          directive_id: req.directiveId,
          task_id: req.taskId,
          payload: {
            detection_path: "substrate_reconciliation",
            substrate_events_observed: hit.n,
            mcp_server_url: mcpServerUrl,
            server_name: V2_OPENCODE_MCP_SERVER_NAME,
            note: "opencode 1.4 routes MCP via internal HTTP; stdout frame gate is blind to those calls. Substrate reconciliation is the canonical truth.",
          } as JsonValue,
          invoker: "opencode",
        });
      }
    } catch { /* db may be transient — fall through to stdout-based classification */ }
  }

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
    // Audit-2026-05-16 (87% of bridge_failed events were mcp_handshake_failed
    // with exit_code:0 + stderr empty + zero JSON frames). Pre-fix the bridge
    // collapsed two distinct failures into one reason which made operator
    // diagnostics actionably wrong:
    //   (A) brain_silent_exit — opencode ran cleanly to completion but never
    //       called a substrate.* / runtime.* tool. This is a prompt-compliance
    //       failure: GPT-5.5 chose conversational/reasoning-only output and
    //       skipped tools entirely. Fix: tighten the prompt's tool-use
    //       enforcement (brain_prompt workflow policy bundle). Reducing
    //       brain concurrency does NOT help; restarting the daemon does NOT
    //       help; verifying /mcp reachability does NOT help.
    //   (B) mcp_handshake_timed_out — bridge gave up waiting before opencode
    //       produced its first frame. Hot-path startup contention (model
    //       loading, config materialization, MCP negotiation). Fix: raise
    //       handshakeWindowMs, reduce concurrent brain dispatches, or
    //       investigate /mcp endpoint reachability (the only branch where
    //       the old hint was actually correct).
    // The event kind stays `bridge_failed` (REUSE-first); the new classifier
    // lives in the `reason` payload field so health-metric counts split
    // cleanly. Adds frames_received_count so closure verifiers can see at
    // a glance whether the subprocess produced ANY output at all.
    const brainSilentExit = !mcpHandshakeTimedOut && exitCode === 0;
    const classifierReason = brainSilentExit ? "brain_silent_exit" : "mcp_handshake_timed_out";
    const classifierHint = brainSilentExit
      ? "opencode ran cleanly (exit_code:0) for the full handshake window but invoked ZERO substrate.*/runtime.* tools. "
        + "This is a prompt-compliance failure, NOT a transport issue. The brain (GPT-5.5) chose conversational/text-only output "
        + "and skipped the substrate emission entirely. Fix: tighten the brain_prompt workflow policy bundle to demand at "
        + "least one substrate.emit before exit. Restarting the daemon or verifying /mcp reachability will NOT help — the "
        + "daemon is fine, the brain just refused to use tools."
      : "opencode produced no substrate.*/runtime.* tool calls within the handshake observation window AND the window timed out. "
        + "This is a transport/startup-latency issue (model loading, config materialization, MCP negotiation under contention). "
        + "Fix: raise ACC2_BRIDGE_HANDSHAKE_WINDOW_MS or reduce concurrent brain dispatches; verify /mcp endpoint reachability.";
    emitEvent(db, {
      kind: "bridge_failed",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: {
        reason: classifierReason,
        classifier_class: brainSilentExit ? "prompt_compliance" : "transport",
        mcp_handshake_ok: false,
        window_ms: handshakeWindowMs,
        mcp_server_url: mcpServerUrl,
        timed_out: mcpHandshakeTimedOut,
        timeout_mode: "mcp_handshake_observation_window",
        budget_observed: budgetObserved(classifierReason),
        exit_code: exitCode,
        frames_received_count: framesReceivedCount,
        first_frame_seen: firstFrameSeen,
        hint: classifierHint,
        stderr_tail: stderrBuf.slice(-512),
      } as JsonValue,
      invoker: "opencode",
    });
    return {
      ok: false,
      reason: {
        kind: "subprocess_crash",
        stderr_tail: brainSilentExit
          ? `brain_silent_exit:opencode exited cleanly with zero substrate tool calls in ${handshakeWindowMs}ms`
          : `mcp_handshake_timed_out:no substrate.* tool call in ${handshakeWindowMs}ms`,
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
    // The watchdog now only fires on first_frame_seen=false (subprocess
    // never proved it can drive MCP). The inter-frame tier is structurally
    // unreachable — kept in the type for diagnostic clarity if a future
    // change re-introduces it.
    emitEvent(db, {
      kind: "bridge_failed",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: {
        reason: "subprocess_stuck",
        // Brain audit E (2026-05-15): normalize mcp_handshake_ok on
        // every bridge terminal event for single-query handshake health.
        mcp_handshake_ok: mcpHandshakeOk,
        no_frames_received: true,
        threshold_ms: firstFrameThresholdMs,
        first_frame_seen: false,
        tier: "first_frame",
        exit_code: exitCode,
        budget_observed: budgetObserved("subprocess_stuck"),
      } as JsonValue,
      invoker: "opencode",
    });
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
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: {
        reason: `cycle_violation:${cycleViolation}`,
        // Round-2 audit (2026-05-15): every post-spawn bridge_failed
        // carries mcp_handshake_ok so handshake health is queryable
        // across the entire failure taxonomy in one SQL scan.
        mcp_handshake_ok: mcpHandshakeOk,
      } as JsonValue,
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
      payload: {
        reason: "timeout",
        timeout_mode: "overall_wall_clock",
        ms_elapsed: bridgeElapsedMs(),
        timeout_ms: timeoutMs,
        killed_by: "overall_timeout_sigterm",
        mcp_handshake_ok: mcpHandshakeOk,
        mcp_handshake_timed_out: mcpHandshakeTimedOut,
        budget_observed: budgetObserved("timeout"),
      } as JsonValue,
      invoker: "opencode",
    });
    return { ok: false, reason: { kind: "timeout", ms_elapsed: timeoutMs } };
  }

  if (exitCode !== 0) {
    cleanupConfig();
    // Auth-shaped post-flight: opencode exited non-zero AND stderr matches an
    // auth marker (401 / unauthorized / authentication failed / etc). Surface
    // the gap as a HIDL action card with reason="auth_expired" so the owner
    // sees the gap inline. Distinct reason from the pre-flight `auth_missing`
    // path so the ledger preserves WHEN the auth went bad (never configured
    // vs. configured-but-rejected). Idempotent: at most one HIDL row per
    // reason per hour.
    const authStderrHit = stderrIndicatesAuthFailure(stderrBuf);
    if (authStderrHit && !hasRecentAuthHidl(db, "auth_expired")) {
      emitAuthHidl(
        db,
        req,
        "auth_expired",
        `opencode exit ${exitCode}; stderr matched auth marker (tail: ${stderrBuf.slice(-256)})`,
      );
    }
    emitEvent(db, {
      kind: "bridge_failed",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: {
        reason: authStderrHit ? "auth_expired" : "subprocess_crash",
        exit_code: exitCode,
        stderr_tail: stderrBuf.slice(-512),
        mcp_handshake_ok: mcpHandshakeOk,
      } as JsonValue,
      invoker: "opencode",
    });
    if (authStderrHit) {
      return { ok: false, reason: { kind: "auth_missing" } };
    }
    return { ok: false, reason: { kind: "subprocess_crash", stderr_tail: stderrBuf.slice(-512) } };
  }

  // Exit-code 0 + a structured opencode error event = parse_error / auth /
  // provider failure. opencode 1.4+ exits 0 even on `Model not found` so the
  // bridge must inspect the JSON event stream rather than trust the exit
  // code alone (Batch 2.α hardening).
  if (opencodeErrorEvent) {
    cleanupConfig();
    const msg = opencodeErrorEvent.message ?? "unknown opencode error";
    const isAuth = stderrIndicatesAuthFailure(msg) || msg.toLowerCase().includes("auth");
    const reason: BridgeFailureReason = isAuth
      ? { kind: "auth_missing" }
      : { kind: "parse_error", raw: msg.slice(0, 512) };
    // Structured opencode error matched an auth pattern — surface the HIDL
    // card the same way the non-zero-exit branch does. The two paths bucket
    // the same operator-visible gap; the ledger's bridge_failed reason field
    // preserves which subprocess shape produced it.
    if (isAuth && !hasRecentAuthHidl(db, "auth_expired")) {
      emitAuthHidl(
        db,
        req,
        "auth_expired",
        `opencode structured error event ${opencodeErrorEvent.name ?? "UnknownError"}: ${msg.slice(0, 256)}`,
      );
    }
    emitEvent(db, {
      kind: "bridge_failed",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: {
        reason: `opencode_error_event:${opencodeErrorEvent.name ?? "UnknownError"}`,
        message: msg,
        mcp_handshake_ok: mcpHandshakeOk,
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
      budget_observed: budgetObserved("completed"),
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
