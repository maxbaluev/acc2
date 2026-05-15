// acc2 brain-bridge MCP-config materializer + canonical tool-surface
// constants. Pulled out of the monolithic runtime/bridge.ts (Batch 2.β
// per-dispatch opencode wiring) so the opencode subprocess module can
// import just the config helper without dragging the mock dispatch
// table or fixture bodies along for the ride.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Real opencode subprocess defaults (Phase E §12) ───────────────

/** `openai/gpt-5.5` is the v2 canonical reasoner per owner directive
 *  (post Batch 3). Batch 2.α smoke originally proved opencode 1.4.x
 *  against `openai/gpt-5.4-mini`; the upgrade subagent (commit 54d0921)
 *  verified opencode 1.14.50 keeps the gpt-5.x family resolvable,
 *  including gpt-5.5. Override via ACC2_OPENCODE_MODEL or
 *  SpawnOpts.model when the brain needs a different reasoner. */
export const DEFAULT_OPENCODE_MODEL = "openai/gpt-5.5";
/** Default per-dispatch wall-clock cap on the opencode subprocess.
 *  Bumped from 300s → 600s after live ledger inspection (2026-05-15)
 *  showed real brain cycles exceeding 5 minutes:
 *    01:08:48 brain_dispatched
 *    01:12:46 action_predicted    (4 min into cycle)
 *    01:13:23 action_scored
 *    01:13:39 task_closure_audited (5 min step-7 closure verifier)
 *    01:13:48 bridge_failed:timeout (cut off BEFORE task_committed)
 *    01:13:49 re-dispatched, brain restarts from scratch
 *  The brain's WORKFLOW_TEXT now includes step-7 closure audit + step-8
 *  lesson extraction (added in the closure+learning batch). These add real
 *  cycle time. 300s was internally inconsistent — the closure verifier
 *  COULD finish but task_committed/refinement-edge couldn't be emitted
 *  before the watchdog fired. 600s gives the brain a comfortable margin
 *  AFTER closure-audit lands to decide commit-vs-refine. The Batch-3
 *  STALE_DISPATCH_THRESHOLD_MS (15min) still catches genuinely hung
 *  dispatches above this. Override via `ACC2_OPENCODE_TIMEOUT_MS` or
 *  `SpawnOpts.timeoutMs`. */
export const DEFAULT_TIMEOUT_MS = 600_000;
/** Default MCP-handshake window — the time opencode has between connecting
 *  to v2's MCP server and invoking its first `substrate.*` / `runtime.*`
 *  tool. The pre-gpt-5 default was 30s, which was tight even for the 5.4-mini
 *  family. gpt-5.5 (the v2 canonical reasoner, see DEFAULT_OPENCODE_MODEL
 *  above) routinely reads the substrate via `substrate.search` / `substrate.read`
 *  before authoring its first artifact and 30s was killing it mid-thought —
 *  every dispatch failed with `mcp_handshake_failed`, the scheduler hot-looped,
 *  and operators saw the substrate as broken. The integration scenarios in
 *  `tests/integration/scenarios.ts` already bump this to 120s manually for
 *  real-brain runs; promote that to the default so production matches.
 *  Override via `ACC2_OPENCODE_MCP_HANDSHAKE_MS` or `SpawnOpts.mcpHandshakeWindowMs`. */
export const DEFAULT_MCP_HANDSHAKE_WINDOW_MS = 120_000;

/** No-progress watchdog — when the opencode subprocess emits zero
 *  `bridge_frame_received`-class events for this long, the bridge kills
 *  it without waiting for the overall timeout. The default (90s) is
 *  roomy enough for slow models / cold caches while still catching
 *  genuine wedges long before the 600s harness timeout. Override via
 *  `ACC2_BRIDGE_STUCK_THRESHOLD_MS`. */
export const DEFAULT_BRIDGE_STUCK_THRESHOLD_MS = 90_000;

/** Canonical name for v2's MCP server in the materialized opencode
 *  config. Stable across dispatches so the brain's prompts can reference
 *  it by name if needed (`@acc2-substrate substrate.admit_artifact`-style
 *  mentions). */
export const V2_OPENCODE_MCP_SERVER_NAME = "acc2-substrate";

/** v2's full MCP tool surface — kept here as a discovery hint for the
 *  brain prompt composer and so future contributors can see at a glance
 *  which tools the daemon advertises. The actual list is owned by
 *  `runtime/mcp_server.ts` (`server.addTool({ name: "substrate.…" })`
 *  calls). When new tools land there, append them here for
 *  prompt-compose visibility. */
export const V2_MCP_TOOL_SURFACE = [
  "substrate.emit",
  "substrate.read",
  "substrate.get_event",
  "substrate.get_artifact",
  "substrate.search",
  "substrate.embed_text",
  "substrate.run_artifact",
  "substrate.run_verifier",
  "substrate.credit",
  "substrate.admit_artifact",
  "substrate.open_fixture",
  "substrate.amend_directive",
  "substrate.record_stakeholder_state",
  "substrate.record_interference_edge",
  "substrate.open_directive",
  "substrate.find_recipe",
  "substrate.register_external_source",
  "runtime.dispatch_ready_task",
  "runtime.scheduler_tick",
  "runtime.process_rolling_reviews",
  "runtime.father_iterate",
  "runtime.detect_father_drift",
  "runtime.replay_recipe",
  "runtime.recent_events",
] as const;

/** Tool-name prefixes that prove an opencode tool_use hit the v2 MCP
 *  wire. opencode 1.4+ mangles MCP tool names by replacing the
 *  server-name and the `.` separator with underscores: the daemon
 *  advertises `substrate.admit_artifact` and opencode emits a tool_use
 *  with `tool: "acc2-substrate_substrate_admit_artifact"`. We accept
 *  BOTH shapes so a future opencode rev that drops the mangling still
 *  works:
 *    - Native shape: `substrate.*` / `runtime.*`
 *    - Mangled shape: `<server>_substrate_*` / `<server>_runtime_*`
 *  Any other prefix is either a built-in opencode tool (e.g. `bash`,
 *  `read`, `grep`) or a different MCP server's tool — neither counts as
 *  a v2 handshake. */
const V2_MCP_NATIVE_PREFIXES = ["substrate.", "runtime."] as const;

export const isV2McpToolName = (name: string | undefined): boolean => {
  if (!name) return false;
  if (V2_MCP_NATIVE_PREFIXES.some((p) => name.startsWith(p))) return true;
  // Mangled form: <server>_<substrate|runtime>_<tool>. We anchor on the
  // canonical server name's underscore-mangled form so an unrelated MCP
  // server can't accidentally satisfy the predicate.
  const mangledServerToken = V2_OPENCODE_MCP_SERVER_NAME.replace(/\./g, "_");
  return (
    name.startsWith(`${mangledServerToken}_substrate_`)
    || name.startsWith(`${mangledServerToken}_runtime_`)
  );
};

/** Per-dispatch opencode-config materializer.
 *
 *  Writes a JSON file declaring v2's MCP server such that opencode, when
 *  spawned with `OPENCODE_CONFIG=<returned-path>`, will list v2's full
 *  tool surface (`substrate.*` + `runtime.*`) under `opencode mcp list`
 *  and expose those tools to the brain at run time.
 *
 *  Returns the absolute path to the written config file and the tempdir
 *  it lives in (so the caller can `rmSync(tempDir, { recursive: true })`
 *  after the subprocess exits). */
export const materializeOpencodeMcpConfig = (opts: {
  mcpServerUrl: string;
  configDir?: string;
  serverName?: string;
}): { configPath: string; tempDir: string } => {
  const serverName = opts.serverName ?? V2_OPENCODE_MCP_SERVER_NAME;
  const tempDir = opts.configDir ?? mkdtempSync(join(tmpdir(), "acc2-opencode-cfg-"));
  const configPath = join(tempDir, "opencode-config.json");
  // We deliberately only declare the `mcp` key — opencode MERGES configs,
  // so the operator's global model / provider / auth settings remain
  // active. type=remote → opencode connects as an HTTP client to
  // fastmcp's Streamable-HTTP transport at `/mcp` (the daemon's primary
  // port).
  const cfg = {
    $schema: "https://opencode.ai/config.json",
    mcp: {
      [serverName]: {
        type: "remote",
        url: opts.mcpServerUrl,
        enabled: true,
      },
    },
  };
  writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf-8");
  return { configPath, tempDir };
};
