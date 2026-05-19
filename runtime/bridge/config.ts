// acc2 brain-bridge MCP-config materializer + canonical tool-surface
// constants. Pulled out of the monolithic runtime/bridge.ts (Batch 2.β
// per-dispatch opencode wiring) so the opencode subprocess module can
// import just the config helper without dragging the mock dispatch
// table or fixture bodies along for the ride.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Import from the leaf types module, not the mcp_server barrel, to avoid
// the runtime cycle: bridge/config → mcp_server/index → substrate_tools →
// (fixtures/bun runtime) → bridge → bridge/config. The barrel re-exports
// McpMethods anyway; types.ts is the canonical leaf source.
import { McpMethods } from "../mcp_server/types";

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
 *  The brain prompt workflow policy now includes step-7 closure audit + step-8
 *  lesson extraction (added in the closure+learning batch). These add real
 *  cycle time. 300s was internally inconsistent — the closure verifier
 *  COULD finish but task_committed/refinement-edge couldn't be emitted
 *  before the watchdog fired. 600s gave a comfortable margin for SINGLE-
 *  cycle dispatches but was too tight for multi-branch DAG dispatches
 *  (8+ axes, refinement cycles, 100+ frames). Live ledger evidence
 *  (2026-05-18T22:07): a legitimate 10-axis universality+legacy
 *  directive took 718s (12 minutes) of real work — 5 brain cycles,
 *  4 complete act_tuple projections, 19 messages, 53 reasoning steps,
 *  130 bridge frames — and got SIGTERMed at the 600s overall budget.
 *  900s (15min) matches the existing STALE_DISPATCH_THRESHOLD_MS so the
 *  bridge timeout and stale-detection align. Override via
 *  `ACC2_OPENCODE_TIMEOUT_MS` or `SpawnOpts.timeoutMs`. */
export const DEFAULT_TIMEOUT_MS = 900_000;
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

/** First-frame budget — the budget the subprocess gets between SPAWN
 *  and its FIRST `bridge_frame_received` event. The brain's strategic
 *  synthesis on a fresh dispatch often spends 2-4 minutes reasoning
 *  before its first MCP tool call (substrate.search / substrate.read
 *  during depth-1 retrieval; large prompts; cold model caches). The
 *  old 90s inter-frame default was killing legitimate first-cycle
 *  thinking as a false-positive wedge. 300s (5 min) is generous enough
 *  for slow first cycles; the 600s overall timeout still bounds the
 *  worst case. Override via `ACC2_BRIDGE_FIRST_FRAME_THRESHOLD_MS`.
 *
 *  Live ledger evidence (2026-05-15 10:09-10:13): four consecutive
 *  bridge_failed events across distinct tasks, every one with
 *  no_frames_received elapsed_ms ∈ [110, 205] — opencode subprocesses
 *  reasoning past the 90s inter-frame cap on slow first cycles. The
 *  fix splits the watchdog into TWO tiers and stops killing strategic
 *  thinking. */
export const DEFAULT_BRIDGE_FIRST_FRAME_THRESHOLD_MS = 300_000;

/** Canonical name for v2's MCP server in the materialized opencode
 *  config. Stable across dispatches so the brain's prompts can reference
 *  it by name if needed (`@acc2-substrate substrate.admit_artifact`-style
 *  mentions). */
export const V2_OPENCODE_MCP_SERVER_NAME = "acc2-substrate";

/**
 * Canonical opencode agent name for the brain subprocess. opencode 1.14.50
 * exposes `--agent <name>`, which constrains the subprocess to the named
 * agent block declared in OPENCODE_CONFIG. The agent block carries a
 * positive `tools` enumeration (no wildcards) so the brain can ONLY invoke
 * the tools we name. Built-in filesystem mutators (edit/write/bash/
 * apply_patch) are NOT listed and therefore NOT registered with the
 * subprocess at all — there is no deny pattern to bypass.
 */
export const BRAIN_OPENCODE_AGENT_NAME = "acc2-brain";

/**
 * Positive enumeration of the tool surface the brain subprocess is allowed
 * to invoke. opencode 1.14.50 has no positive CLI tool-list flag, but the
 * agent block in OPENCODE_CONFIG accepts a `tools` array — only the names
 * listed here are registered with the subprocess.
 *
 * Members:
 *   - read / glob / grep / list — read-only filesystem inspection
 *   - lsp — language-server queries (read-only)
 *   - substrate.* — every method in McpMethods that starts with `substrate.`
 *   - runtime.*   — every method in McpMethods that starts with `runtime.`
 *
 * Built-in filesystem mutators (edit/write/bash/apply_patch/task/
 * external_directory/repo_clone/repo_overview) are deliberately absent so
 * the brain CANNOT write to the source checkout directly. Source edits
 * flow brain -> event -> Claude orchestrator.
 */
export const BRAIN_OPENCODE_TOOL_SURFACE: readonly string[] = Object.freeze([
  "read",
  "glob",
  "grep",
  "list",
  "lsp",
  ...McpMethods,
]);

/**
 * Set form of BRAIN_OPENCODE_TOOL_SURFACE for O(1) positive-enumeration
 * lookup. Built once at module load.
 */
const BRAIN_OPENCODE_TOOL_SURFACE_SET = new Set<string>(BRAIN_OPENCODE_TOOL_SURFACE);

/**
 * Built-in tool names opencode 1.14.50 ships that can mutate the source
 * checkout (file writes, shell commands, patches, task spawning, repo
 * operations). The positive enumeration via `tools` was insufficient in
 * production: opencode treated `tools: {<name>: true, …}` as ADDITIVE to
 * its default set, leaving `bash` / `apply_patch` / `edit` / `write`
 * implicitly available. Brain dispatch QTD1PX04 (2026-05-19) was caught
 * using bash (18×) + apply_patch (1×) inside the source checkout.
 *
 * Fix: explicit `deny` for every known filesystem-write tool. Belt and
 * braces: even if `tools` whitelist behavior changes in a future rev,
 * `permission` deny takes precedence over allow.
 */
const BRAIN_FORBIDDEN_TOOLS: readonly string[] = Object.freeze([
  "bash",
  "edit",
  "write",
  "apply_patch",
  "task",
  "external_directory",
  "repo_clone",
  "repo_overview",
  "patch",
  "multiedit",
  "shell",
]);

/**
 * Permission object derived from BRAIN_OPENCODE_TOOL_SURFACE for the
 * top-level `permission` key in OPENCODE_CONFIG. Positive enumeration
 * for the read-only surface PLUS explicit `deny` for every built-in
 * filesystem-write tool. The deny set is the load-bearing gate against
 * brain_native_filesystem_bypass when opencode treats `tools` as
 * additive instead of whitelist.
 */
export const BRAIN_READONLY_PERMISSION: Readonly<Record<string, "allow" | "deny">> = Object.freeze({
  ...Object.fromEntries(BRAIN_OPENCODE_TOOL_SURFACE.map((tool) => [tool, "allow" as const])),
  ...Object.fromEntries(BRAIN_FORBIDDEN_TOOLS.map((tool) => [tool, "deny" as const])),
});

/**
 * Mangled-name prefixes for the same tool surface. opencode 1.4+ rewrites
 * MCP tool names by joining the server name and the `.` separator with
 * underscores: `substrate.admit_artifact` becomes
 * `acc2-substrate_substrate_admit_artifact`. Positive enumeration must
 * accept both shapes so a future opencode rev that drops the mangling
 * still works.
 */
const BRAIN_OPENCODE_MANGLED_PREFIXES = [
  `${V2_OPENCODE_MCP_SERVER_NAME}_substrate_`,
  `${V2_OPENCODE_MCP_SERVER_NAME}_runtime_`,
] as const;

/**
 * Test/verifier helper that mirrors the structural decision the opencode
 * agent registration makes: a tool is allowed iff it is positively
 * enumerated in BRAIN_OPENCODE_TOOL_SURFACE (native shape) OR matches the
 * canonical mangled prefix (opencode 1.4+ MCP-name mangling). There is no
 * wildcard, no deny pattern, no fallthrough — unknown tools are denied by
 * positive enumeration alone.
 */
export const isBrainReadonlyToolAllowed = (toolName: string): boolean => {
  if (!toolName) return false;
  if (BRAIN_OPENCODE_TOOL_SURFACE_SET.has(toolName)) return true;
  return BRAIN_OPENCODE_MANGLED_PREFIXES.some((prefix) => toolName.startsWith(prefix));
};

/** v2's full MCP tool surface, derived from the MCP server whitelist.
 *  The server-facing source of truth is runtime/mcp_server/types.ts
 *  (McpMethods); the bridge exports this as a discovery hint only. */
export const V2_MCP_TOOL_SURFACE = McpMethods;

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
  // Positive enumeration at the agent boundary. opencode 1.14.50 exposes
  // `--agent <name>` which constrains the subprocess to the named agent
  // block. Listing tools positively in `agent.<name>.tools` means built-in
  // filesystem mutators (edit/write/bash/apply_patch) are NEVER registered
  // with the subprocess — there is no deny pattern to bypass.
  //
  // `default_agent` is a belt-and-braces declaration in case the spawn
  // omits `--agent`. `tools` at the top level is defense-in-depth for
  // opencode revs that honor a top-level tool restriction.
  const positiveTools: Record<string, boolean> = Object.fromEntries(
    BRAIN_OPENCODE_TOOL_SURFACE.map((tool) => [tool, true]),
  );
  const cfg = {
    $schema: "https://opencode.ai/config.json",
    permission: BRAIN_READONLY_PERMISSION,
    default_agent: BRAIN_OPENCODE_AGENT_NAME,
    tools: positiveTools,
    agent: {
      [BRAIN_OPENCODE_AGENT_NAME]: {
        description:
          "acc2 brain (read-only): substrate.*/runtime.* MCP tools plus "
          + "read/glob/grep/list/lsp. No filesystem-write tools registered.",
        tools: positiveTools,
        permission: BRAIN_READONLY_PERMISSION,
      },
    },
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
