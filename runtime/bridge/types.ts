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
  /** Optional checkout isolation context: when set, the opencode subprocess
   *  is spawned with `cwd: root` and exported `ACC2_CHECKOUT_*` env vars so
   *  the brain operates against an isolated source checkout (worktree or
   *  main). The dispatcher decides isolation per dispatch; callers pass it
   *  through verbatim. Optional — when absent the subprocess inherits the
   *  daemon's cwd. */
  checkoutIsolation?: { root: string; reason?: string; mergeBackStrategy?: string };
  /** F8 dispatch correlation key. The task_dispatcher mints this id when
   *  it emits the upstream `brain_dispatched` audit row; the bridge
   *  stamps it on the spawn-time `brain_dispatched` + matching
   *  `brain_dispatch_closed` it emits so the substrate can join the
   *  upstream audit row to the actual subprocess lifecycle by the same
   *  `dispatch_id`. Optional — legacy callers (tests) may omit it; the
   *  bridge then mints its own per-spawn id. */
  dispatchId?: string;
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
  /** Override the first-frame budget (ms). Window the subprocess gets
   *  between spawn and its FIRST `bridge_frame_received`. Default 300s;
   *  env override `ACC2_BRIDGE_FIRST_FRAME_THRESHOLD_MS`. Allows slow
   *  first-cycle brain reasoning without false-positive wedge kills. */
  firstFrameThresholdMs?: number;
  /** Inject the opencode-auth pre-flight probe. Returns
   *  `{ credentialCount, envProviderCount }`. When both are zero, the
   *  bridge emits `hidl_action_required { reason: "auth_missing" }` and
   *  skips the subprocess spawn entirely — a known-failed dispatch is not
   *  worth the subprocess cost. Tests inject deterministic values;
   *  production calls `parseOpencodeAuth(spawnSync("opencode auth list"))`.
   *  Returns null when the probe couldn't run (binary missing, etc) — the
   *  bridge treats that as "unknown, proceed" so a transient probe failure
   *  doesn't block legitimate dispatches. */
  authProbe?: () => { credentialCount: number; envProviderCount: number } | null;
};
