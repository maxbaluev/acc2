// acc2 brain-bridge shared types (split out of the monolithic
// runtime/bridge.ts so the opencode subprocess module, the mock
// dispatcher, and the per-dispatch MCP config materializer can all
// consume one definition each).
//
// The shapes mirror v2-design.md §12 (BridgeResult / BridgeFailureReason).
// Keep this file pure-type — anything importing here must remain
// dependency-light so the index module's public surface stays cheap to
// load.

export type BridgeRequest = {
  prompt: string;
  taskId: string;
  directiveId: string;
  /** Optional context: target path for the fixture_d_count_todos brain to
   *  scan. Real brain would derive this from the prompt; the mock reads it
   *  here so tests can point at a deterministic fixture directory. */
  fixtureTargetPath?: string;
};

export type BridgeFailureReason =
  | { kind: "auth_missing" }
  | { kind: "rate_limit"; retry_after_ms: number }
  | { kind: "timeout"; ms_elapsed: number }
  | { kind: "subprocess_crash"; stderr_tail: string }
  | { kind: "parse_error"; raw: string }
  | { kind: "mock_bridge_prompt_unrecognized"; supported_markers: string[] };

export type BridgeResult =
  | { ok: true; final_response: string; usage: { tokens: number }; emitted_event_ids: string[] }
  | { ok: false; reason: BridgeFailureReason };

/** Options accepted by `spawnRealOpencode` for the real opencode subprocess
 *  path. Tests inject Bun.spawn + override the watchdog/handshake windows
 *  here; production callers leave everything default. */
export type SpawnOpts = {
  timeoutMs?: number;
  model?: string;
  /** Inject Bun.spawn for tests. Defaults to Bun.spawn. */
  spawnFn?: typeof Bun.spawn;
  /** Override the MCP server URL embedded in the materialized config.
   *  Defaults to V2_MCP_SERVER_URL env. Set explicitly in tests. */
  mcpServerUrl?: string;
  /** Override the tempdir where the per-dispatch opencode-config.json is
   *  materialized. Defaults to an mkdtemp under os.tmpdir(). */
  configDir?: string;
  /** Override the watchdog window (ms) within which a substrate.* / runtime.*
   *  tool call must land for the MCP handshake to be considered successful.
   *  Default 30s. */
  mcpHandshakeWindowMs?: number;
  /** Override the no-progress watchdog window (ms). If zero `bridge_frame_received`
   *  frames arrive within this window the bridge SIGTERMs the subprocess and
   *  emits a `bridge_stuck` event. Default 90s; env override
   *  `ACC2_BRIDGE_STUCK_THRESHOLD_MS`. */
  stuckThresholdMs?: number;
};
