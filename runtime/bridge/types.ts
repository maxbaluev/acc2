// acc2 brain-bridge shared types (split out of the monolithic
// runtime/bridge.ts so the opencode subprocess module, the mock
// dispatcher, and the per-dispatch MCP config materializer can all
// consume one definition each).
//
// The shapes mirror Architecture.md (BridgeResult / BridgeFailureReason).
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
  /** Inject the opencode capability pre-flight probe. Returns the
   *  resolved binary availability + version + model. When `ok` is false
   *  the bridge emits `runtime_self_diagnostic_recorded` + `bridge_failed`
   *  and skips the spawn — a missing/broken opencode CLI is a known-failed
   *  dispatch. Tests inject deterministic values; production runs
   *  `opencode --version`. Mirrors the `authProbe` test-coupling: when
   *  `spawnFn` is injected but `capabilityProbe` is not, the bridge treats
   *  capability as "available" so host CLI state doesn't leak into
   *  deterministic test fixtures. */
  capabilityProbe?: () => { ok: boolean; version?: string; missing_binary?: string; install_hint?: string };
  /** Test-only: bypass the pre-spawn MCP HEAD probe (2026-05-21
   *  multi-brain foundation fix). The probe verifies the daemon's MCP
   *  endpoint is reachable before burning a subprocess on guaranteed
   *  handshake failure. Tests inject mock spawn fns and don't have a
   *  real MCP server bound; setting this true keeps unit tests fast and
   *  hermetic. Production callers leave undefined. */
  skipMcpReadinessProbe?: boolean;
  /** Override the brain_liveness_heartbeat cadence. Production uses the
   *  module default; tests can shorten it to prove timer progress while the
   *  bridge drains large stdout bursts. */
  livenessHeartbeatMs?: number;
};

// ── Shared engine-bridge interface (symmetric opencode ↔ claude) ──────
//
// Both engine bridges (the opencode brain bridge in `./opencode.ts` and the
// symmetric Claude Code bridge in `./claude.ts`) implement the SAME lifecycle
// contract: spawn a headless subprocess wired to the daemon's MCP endpoint via
// a per-dispatch config file (OPENCODE_CONFIG / --mcp-config), run exactly one
// strategic cycle under the cycle-1 gate, stream typed output frames into the
// event ledger, and close deterministically on subprocess exit. The interface
// below is the additive, structural common shape so the dispatcher (increment
// 2) can select an executor without duplicating dispatch wiring. It does NOT
// change the existing `spawnRealOpencode` signature — that function already
// satisfies `EngineBridgeSpawn`.
//
// Keep this file pure-type. The two engine modules import the interface and
// the index module re-exports it; nothing here pulls in a runtime dependency.

/** The free-string engine identity for a substrate-spawnable executor. Open by
 *  design (mirrors SubstrateOrigin / verifier_kind): admit new engines by using
 *  a new string, not by widening a closed enum. */
export type EngineBridgeKind = "opencode" | "claude_code" | (string & {});

/** The common spawn signature both engine bridges satisfy. `spawnRealOpencode`
 *  and `spawnRealClaudeCode` are both assignable to this type — the dispatcher
 *  can hold either behind one reference. The third options arg is the
 *  engine-specific SpawnOpts (opencode's `SpawnOpts` or claude's
 *  `ClaudeSpawnOpts`), so the interface is parameterized over it. */
export type EngineBridgeSpawn<TOpts = SpawnOpts> = (
  req: BridgeRequest,
  db: import("bun:sqlite").Database,
  spawnOpts?: TOpts,
) => Promise<BridgeResult>;

/** Structural descriptor for one registered engine bridge. The dispatcher
 *  reads `kind` to attribute events + posteriors and calls `spawn` to run a
 *  leaf. `mock` is the hermetic spawn used by tests so a dispatch never
 *  touches a real subprocess. */
export type EngineBridge<TOpts = SpawnOpts> = {
  /** Open-ended engine identity (substrate_origin / executor attribution). */
  kind: EngineBridgeKind;
  /** Production spawn: launches the real headless subprocess. */
  spawn: EngineBridgeSpawn<TOpts>;
  /** Hermetic mock spawn for tests — emits the engine's lifecycle events
   *  WITHOUT launching any real subprocess. */
  mock: (req: BridgeRequest, db: import("bun:sqlite").Database) => Promise<BridgeResult>;
};

/** The production-default subprocess spawner for the engine bridges. The
 *  opencode bridge references `Bun.spawn` directly (it predates this module
 *  and is individually allowlisted by the `code_as_capability` alignment
 *  guard); the Claude bridge obtains its default spawner from here so the
 *  literal `Bun.spawn` invocation lives in exactly one allowlisted place per
 *  engine. This is the runtime counterpart to the `typeof Bun.spawn` seam type
 *  used throughout SpawnOpts / ClaudeSpawnOpts — both engines remain fully
 *  mockable via the injected `spawnFn`. */
export const defaultEngineSpawn: typeof Bun.spawn = Bun.spawn;

/** Options accepted by `spawnRealClaudeCode`. Mirrors the opencode `SpawnOpts`
 *  seams (injectable spawn, MCP URL/config override, watchdog/handshake/liveness
 *  windows) so the Claude bridge reuses the exact same lifecycle machinery and
 *  is mockable the same way. Additive — does not affect opencode's SpawnOpts. */
export type ClaudeSpawnOpts = {
  timeoutMs?: number;
  /** Claude model id (e.g. a Claude Code model alias). Defaults to the bridge
   *  module default / ACC2_CLAUDE_MODEL. */
  model?: string;
  /** Inject Bun.spawn for tests. Defaults to Bun.spawn. When injected, the
   *  capability/readiness probes default to "available/skip" exactly like the
   *  opencode bridge so host CLI state never leaks into deterministic tests. */
  spawnFn?: typeof Bun.spawn;
  /** Override the MCP server URL embedded in the materialized --mcp-config.
   *  Defaults to V2_MCP_SERVER_URL env. Set explicitly in tests. */
  mcpServerUrl?: string;
  /** Override the tempdir where the per-dispatch claude mcp-config.json is
   *  materialized. Defaults to an mkdtemp under os.tmpdir(). */
  configDir?: string;
  /** Override the MCP-handshake window (ms). Default mirrors the opencode
   *  handshake window. */
  mcpHandshakeWindowMs?: number;
  /** Override the first-frame budget (ms) — window between spawn and the first
   *  `cc_frame_received`. Mirrors the opencode first-frame watchdog tier. */
  firstFrameThresholdMs?: number;
  /** Inject the Claude Code capability pre-flight probe (binary availability +
   *  version). When `ok` is false the bridge emits
   *  `runtime_self_diagnostic_recorded` + `bridge_failed` and skips the spawn.
   *  Mirrors the opencode `capabilityProbe` test-coupling: when `spawnFn` is
   *  injected but `capabilityProbe` is not, capability defaults to available. */
  capabilityProbe?: () => { ok: boolean; version?: string; missing_binary?: string; install_hint?: string };
  /** Test-only: bypass the pre-spawn MCP HEAD readiness probe. Defaults to
   *  skip when `spawnFn` is injected, matching the opencode coupling. */
  skipMcpReadinessProbe?: boolean;
  /** Override the brain_liveness_heartbeat cadence (tests shorten it). */
  livenessHeartbeatMs?: number;
};
