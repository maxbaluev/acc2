// acc2 brain bridge — typed transport for opencode subprocess (v2-design.md §12).
//
// PHASE D MOCK. The real bridge spawns `opencode run …` as a subprocess and
// streams typed BridgeFrames. That is Phase E work (real subprocess, real
// frame protocol, real auth/retry). Phase D ships a deterministic mock that
// emits exactly the events the brain WOULD have emitted for the
// fixture_d_count_todos directive — admits the action + verifier artifacts,
// emits action_predicted referencing them, returns success.
//
// The mock matches the v2-design §12 BridgeResult / BridgeFailureReason shape
// so Phase E can light up the real subprocess without rewiring callers.
//
// Decision: events the brain emits flow through the SAME emitEvent path the
// real opencode session would use. We do NOT short-circuit through the
// dispatcher's bookkeeping — the dispatcher captures these events by reading
// the event stream the same way it would read frames from a real subprocess.
//
// ── opencode MCP-client wiring (Batch 2.β) ────────────────────────
//
// Investigation findings (opencode 1.4.3):
//   - `opencode run` has NO `--mcp-server` / `--mcp` / `--config` flag.
//     `opencode mcp add` exists but only edits the user's global config
//     interactively; it is unusable as a per-dispatch wiring path.
//   - MCP servers are declared in `opencode.json` (JSON or JSONC) under the
//     `mcp` key. Each entry has a unique server name and either
//     `{type:"local", command:[...], environment:{...}}` for stdio or
//     `{type:"remote", url:"…", headers:{...}, enabled:true}` for HTTP.
//     v2's daemon stands up a fastmcp `httpStream` transport at
//     `http://127.0.0.1:<V2_DAEMON_PORT>/mcp`, so we use `type:"remote"`.
//   - Config precedence (later overrides earlier):
//       1. Remote `.well-known/opencode` (org defaults)
//       2. Global `~/.config/opencode/opencode.json` (user prefs/auth)
//       3. Custom `$OPENCODE_CONFIG` env var (verified to override above)
//       4. Project-local `opencode.json` in CWD
//     Configs are MERGED, not replaced — global auth/provider entries stay
//     active, we layer our `mcp` declaration on top.
//   - `OPENCODE_CONFIG=/path/to/file.json` is the cleanest per-dispatch path:
//     no CLI flag plumbing, no global-config mutation, no CWD pollution.
//     `opencode mcp list` under this env var confirms our declaration loads.
//
// Chosen approach: **(A) per-dispatch ephemeral config file**
//   - `materializeOpencodeMcpConfig` writes `<tempdir>/opencode-config.json`
//     declaring v2's MCP server (URL = `http://127.0.0.1:<port>/mcp`,
//     type=remote, enabled=true).
//   - `spawnRealOpencode` sets `OPENCODE_CONFIG=<tempdir>/opencode-config.json`
//     in the spawned subprocess env. The bridge does NOT clobber the
//     operator's global config — only this dispatch sees the v2 MCP server.
//   - Cleanup: the tempdir is removed after the subprocess exits (best-effort).
//
// Connection verification: opencode emits structured JSON events on stdout
// when `--format=json` is set. We watch for evidence of MCP handshake:
//   - A `tool_call` event whose name starts with `substrate.` or `runtime.`
//     proves opencode discovered v2's tools and is invoking them.
//   - We emit a `bridge_mcp_connected` substrate event on first such call so
//     the smoke can assert the connection happened. If 30s pass with no
//     substrate.* / runtime.* tool call, the bridge fails with
//     `mcp_handshake_failed` so operators see the gap immediately rather
//     than waiting for the watchdog timeout.

import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue, SandboxDecl } from "../substrate/types";
import { emitEvent } from "./events";
import { admitArtifact } from "./artifact_admission";
import { isCycleViolation } from "./cycle_one_gate";

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

const FIXTURE_D_MARKER = "FIXTURE: fixture_d_count_todos";
const EXAMPLE_COM_MARKER = "Fetch the URL https://example.com via Bun.fetch (the bun runtime).";

// ── Fixture D — TODO counter ──────────────────────────────────────
//
// The action artifact is a bun script that recursively scans a directory for
// files containing "TODO" and prints `@@RESULT@@ {"result":{"count":N}}`.
// Inputs come through ACC2_INPUTS (a JSON string). We read the target path
// from the inputs envelope.
//
// The artifact deliberately uses only Bun.file / readdirSync — no shell out —
// because bun runtime's sandbox doesn't permit subprocess spawning.

const FIXTURE_D_ACTION_BODY = `// fixture_d_count_todos — recursively grep TODOs
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const inputs = JSON.parse(process.env.ACC2_INPUTS ?? "null") ?? {};
const root: string = inputs.target_path ?? "./";

let count = 0;
const walk = (dir: string): void => {
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    if (name === "node_modules") continue;
    const full = join(dir, name);
    let stats;
    try { stats = statSync(full); } catch { continue; }
    if (stats.isDirectory()) { walk(full); continue; }
    if (!stats.isFile()) continue;
    try {
      const text = readFileSync(full, "utf-8");
      if (text.includes("TODO")) count++;
    } catch { /* skip unreadable */ }
  }
};
walk(root);

process.stdout.write("@@RESULT@@ " + JSON.stringify({ result: { count } }) + "\\n");
`;

// Verifier artifact — checks that the observation carries an integer
// `result.count` ≥ 0. Returns residual=0 (perfect) on match, residual=1
// otherwise. The action artifact must use the same envelope shape.

const FIXTURE_D_VERIFIER_BODY = `// fixture_d_count_todos verifier
// Reads the action observation from ACC2_INPUTS and emits residual.
const observation = JSON.parse(process.env.ACC2_INPUTS ?? "null") ?? {};
let residual = 1;
if (observation && typeof observation === "object" &&
    observation.result && typeof observation.result === "object" &&
    typeof observation.result.count === "number" &&
    Number.isInteger(observation.result.count) &&
    observation.result.count >= 0) {
  residual = 0;
}
process.stdout.write("@@RESULT@@ " + JSON.stringify({ residual }) + "\\n");
`;

// NOTE: the body below is interpolated through a template literal, so any
// `\X` escape must be written `\\X` to survive into the rendered artifact.
// In particular `[\\s\\S]` keeps the literal `\s\S` in the regex char-class.
const EXAMPLE_COM_ACTION_BODY = `// fetch example.com title
const resp = await Bun.fetch("https://example.com");
const html = await resp.text();
const match = html.match(/<title[^>]*>([\\s\\S]*?)<\\/title>/i);
const title = (match?.[1] ?? "").trim();
console.log("@@RESULT@@ " + JSON.stringify({ result: { title } }));
`;

const EXAMPLE_COM_VERIFIER_BODY = `// verify example.com title observation
const observation = JSON.parse(process.env.ACC2_INPUTS ?? "null") ?? {};
const title = observation && typeof observation === "object" && observation.result && typeof observation.result === "object"
  ? observation.result.title
  : "";
const residual = typeof title === "string" && title.trim().length > 0 ? 0 : 1;
console.log("@@RESULT@@ " + JSON.stringify({ residual }));
`;

const BUN_DEFAULT_SANDBOX = (): SandboxDecl => ({
  runtime: "bun",
  fs_read: ["**/*"],
  fs_write: [],
  net_allow: [],
  proc_allow: [],
  substrate_access: "none",
  cpu_ms: 5000,
  wall_ms: 5000,
  memory_mb: 128,
});

/** Phase D mock: react to known prompt markers by admitting canonical
 *  bun action + verifier artifacts and emitting action_predicted that
 *  references both. Unknown prompts return `mock_bridge_prompt_unrecognized`
 *  with the list of supported markers so operators understand why the
 *  dispatch declined (Batch 3.CLEANUP: audit flagged the prior
 *  `auth_missing` shape as misleading — auth is not the real cause). */
export const opencodeQueryMock = async (
  req: BridgeRequest,
  db: Database,
): Promise<BridgeResult> => {
  // Audit: every dispatch records a bridge_invoked event before any work.
  emitEvent(db, {
    kind: "bridge_invoked",
    substrate_origin: "opencode",
    directive_id: req.directiveId,
    task_id: req.taskId,
    payload: { prompt_chars: req.prompt.length } as JsonValue,
    invoker: "opencode",
  });

  if (!req.prompt.includes(FIXTURE_D_MARKER) && !req.prompt.includes(EXAMPLE_COM_MARKER)) {
    const supportedMarkers = [FIXTURE_D_MARKER, EXAMPLE_COM_MARKER];
    emitEvent(db, {
      kind: "bridge_failed",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: {
        reason: "mock_bridge_prompt_unrecognized",
        supported_markers: supportedMarkers,
        prompt_chars: req.prompt.length,
        hint: "set ACC2_BRIDGE_MODE=real to dispatch arbitrary prompts via opencode; "
          + "the mock bridge only recognizes the two fixture markers listed in supported_markers",
      } as JsonValue,
      invoker: "opencode",
    });
    return {
      ok: false,
      reason: { kind: "mock_bridge_prompt_unrecognized", supported_markers: supportedMarkers },
    };
  }

  if (req.prompt.includes(EXAMPLE_COM_MARKER)) {
    const emittedEventIds: string[] = [];

    emitEvent(db, {
      kind: "code_artifact_candidate",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: {
        runtime: "bun",
        purpose: "example_com_title_fetch_action",
      } as JsonValue,
      invoker: "opencode",
    });

    const actionAdmission = await admitArtifact(
      db,
      {
        runtime: "bun",
        body: EXAMPLE_COM_ACTION_BODY,
        declaredSandbox: {
          runtime: "bun",
          fs_read: [],
          fs_write: [],
          net_allow: ["example.com"],
          proc_allow: [],
          substrate_access: "none",
          cpu_ms: 5000,
          wall_ms: 5000,
          memory_mb: 128,
        },
        fixtureInput: null,
        fixtureExpectedResidualBelow: 0.2,
        name: "example_com_title_fetch_action",
      },
      (ev) => {
        const out = emitEvent(db, {
          ...ev,
          directive_id: ev.directive_id ?? req.directiveId,
          task_id: ev.task_id ?? req.taskId,
          invoker: ev.invoker ?? "opencode",
        });
        emittedEventIds.push(out.id);
      },
    );

    if (!actionAdmission.ok) {
      emitEvent(db, {
        kind: "bridge_failed",
        substrate_origin: "opencode",
        directive_id: req.directiveId,
        task_id: req.taskId,
        payload: { reason: `action_admission_failed:${actionAdmission.reason}` } as JsonValue,
        invoker: "opencode",
      });
      return {
        ok: false,
        reason: { kind: "subprocess_crash", stderr_tail: actionAdmission.reason },
      };
    }

    emitEvent(db, {
      kind: "code_artifact_candidate",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: {
        runtime: "bun",
        purpose: "example_com_title_fetch_verifier",
      } as JsonValue,
      invoker: "opencode",
    });

    const verifierAdmission = await admitArtifact(
      db,
      {
        runtime: "bun",
        body: EXAMPLE_COM_VERIFIER_BODY,
        declaredSandbox: {
          runtime: "bun",
          fs_read: [],
          fs_write: [],
          net_allow: [],
          proc_allow: [],
          substrate_access: "none",
          cpu_ms: 5000,
          wall_ms: 5000,
          memory_mb: 128,
        },
        fixtureInput: { result: { title: "Example Domain" } } as JsonValue,
        fixtureExpectedResidualBelow: 0.2,
        name: "example_com_title_fetch_verifier",
      },
      (ev) => {
        const out = emitEvent(db, {
          ...ev,
          directive_id: ev.directive_id ?? req.directiveId,
          task_id: ev.task_id ?? req.taskId,
          invoker: ev.invoker ?? "opencode",
        });
        emittedEventIds.push(out.id);
      },
    );

    if (!verifierAdmission.ok) {
      emitEvent(db, {
        kind: "bridge_failed",
        substrate_origin: "opencode",
        directive_id: req.directiveId,
        task_id: req.taskId,
        payload: { reason: `verifier_admission_failed:${verifierAdmission.reason}` } as JsonValue,
        invoker: "opencode",
      });
      return {
        ok: false,
        reason: { kind: "subprocess_crash", stderr_tail: verifierAdmission.reason },
      };
    }

    const predicted = emitEvent(db, {
      kind: "action_predicted",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      action_artifact_id: actionAdmission.artifactId,
      verifier_artifact_id: verifierAdmission.artifactId,
      predicted_residual: 0.05,
      payload: {
        intent: "fetch example.com and extract the title",
        url: "https://example.com",
      } as JsonValue,
      invoker: "opencode",
    });
    emittedEventIds.push(predicted.id);

    emitEvent(db, {
      kind: "bridge_completed",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: {
        action_artifact_id: actionAdmission.artifactId,
        verifier_artifact_id: verifierAdmission.artifactId,
        predicted_residual: 0.05,
      } as JsonValue,
      invoker: "opencode",
    });

    return {
      ok: true,
      final_response: "example_com_title_fetch action_predicted emitted",
      usage: { tokens: 0 },
      emitted_event_ids: emittedEventIds,
    };
  }

  const emittedEventIds: string[] = [];

  // 1. Admit the action artifact via the admission pipeline (so the audit
  //    trail matches real brain flow: code_artifact_candidate → admission
  //    → admitted/rejected).
  emitEvent(db, {
    kind: "code_artifact_candidate",
    substrate_origin: "opencode",
    directive_id: req.directiveId,
    task_id: req.taskId,
    payload: {
      runtime: "bun",
      purpose: "fixture_d_count_todos_action",
    } as JsonValue,
    invoker: "opencode",
  });

  const actionAdmission = await admitArtifact(
    db,
    {
      runtime: "bun",
      body: FIXTURE_D_ACTION_BODY,
      declaredSandbox: BUN_DEFAULT_SANDBOX(),
      // Admission scans a deliberately nonexistent path so the smoke test
      // returns in milliseconds (walker exits cleanly with count=0). The
      // dispatcher runs the artifact against req.fixtureTargetPath at action
      // time, not at admission.
      fixtureInput: { target_path: "/nonexistent-admission-probe" } as JsonValue,
      fixtureExpectedResidualBelow: 0.2,
      name: "fixture_d_count_todos_action",
    },
    (ev) => {
      const out = emitEvent(db, {
        ...ev,
        directive_id: ev.directive_id ?? req.directiveId,
        task_id: ev.task_id ?? req.taskId,
        invoker: ev.invoker ?? "opencode",
      });
      emittedEventIds.push(out.id);
    },
  );

  if (!actionAdmission.ok) {
    emitEvent(db, {
      kind: "bridge_failed",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: { reason: `action_admission_failed:${actionAdmission.reason}` } as JsonValue,
      invoker: "opencode",
    });
    return {
      ok: false,
      reason: { kind: "subprocess_crash", stderr_tail: actionAdmission.reason },
    };
  }

  // 2. Admit the verifier artifact — same pipeline.
  emitEvent(db, {
    kind: "code_artifact_candidate",
    substrate_origin: "opencode",
    directive_id: req.directiveId,
    task_id: req.taskId,
    payload: {
      runtime: "bun",
      purpose: "fixture_d_count_todos_verifier",
    } as JsonValue,
    invoker: "opencode",
  });

  const verifierAdmission = await admitArtifact(
    db,
    {
      runtime: "bun",
      body: FIXTURE_D_VERIFIER_BODY,
      declaredSandbox: BUN_DEFAULT_SANDBOX(),
      // The verifier's admission fixture provides a known-good observation so
      // the run prints residual=0 and admission passes cleanly.
      fixtureInput: { result: { count: 0 } } as JsonValue,
      fixtureExpectedResidualBelow: 0.2,
      name: "fixture_d_count_todos_verifier",
    },
    (ev) => {
      const out = emitEvent(db, {
        ...ev,
        directive_id: ev.directive_id ?? req.directiveId,
        task_id: ev.task_id ?? req.taskId,
        invoker: ev.invoker ?? "opencode",
      });
      emittedEventIds.push(out.id);
    },
  );

  if (!verifierAdmission.ok) {
    emitEvent(db, {
      kind: "bridge_failed",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: { reason: `verifier_admission_failed:${verifierAdmission.reason}` } as JsonValue,
      invoker: "opencode",
    });
    return {
      ok: false,
      reason: { kind: "subprocess_crash", stderr_tail: verifierAdmission.reason },
    };
  }

  // 3. Emit action_predicted referencing both artifacts. The dispatcher
  //    detects this event and runs both artifacts post-bridge.
  const predicted = emitEvent(db, {
    kind: "action_predicted",
    substrate_origin: "opencode",
    directive_id: req.directiveId,
    task_id: req.taskId,
    action_artifact_id: actionAdmission.artifactId,
    verifier_artifact_id: verifierAdmission.artifactId,
    predicted_residual: 0.05,
    payload: {
      intent: "count files containing TODO in target directory",
      target_path: req.fixtureTargetPath ?? ".",
    } as JsonValue,
    invoker: "opencode",
  });
  emittedEventIds.push(predicted.id);

  // 4. bridge_completed seals the audit trail.
  emitEvent(db, {
    kind: "bridge_completed",
    substrate_origin: "opencode",
    directive_id: req.directiveId,
    task_id: req.taskId,
    payload: {
      action_artifact_id: actionAdmission.artifactId,
      verifier_artifact_id: verifierAdmission.artifactId,
      predicted_residual: 0.05,
    } as JsonValue,
    invoker: "opencode",
  });

  return {
    ok: true,
    final_response: "fixture_d_count_todos action_predicted emitted",
    usage: { tokens: 0 },
    emitted_event_ids: emittedEventIds,
  };
};

// ── Real opencode subprocess (Phase E §12) ────────────────────────
//
// Spawns the `opencode run` CLI as a subprocess and streams its JSON event
// output. The subprocess is configured to use the daemon's MCP server (via
// MCP_SERVER_URL env, set by the dispatcher caller). Cycle-1-only is honored
// by SIGTERM-ing the subprocess if it ever emits a `brain_cycle_2_started`
// or `continue_cycle_requested` event — though that enforcement is also done
// downstream by task_dispatcher's event-stream scan, so this is defense in
// depth.
//
// Watchdog: SIGTERM at req.timeout_ms (default 60s), SIGKILL at timeout × 1.5.
//
// Mock vs real selection lives in `opencodeQuery` below — env
// ACC2_BRIDGE_MODE=mock (default for tests) routes to opencodeQueryMock;
// ACC2_BRIDGE_MODE=real routes here.

type SpawnOpts = {
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
};

// `openai/gpt-5.5` is the v2 canonical reasoner per owner directive (post Batch 3).
// Batch 2.α smoke originally proved opencode 1.4.x against `openai/gpt-5.4-mini`;
// the upgrade subagent (commit 54d0921) verified opencode 1.14.50 keeps the gpt-5.x
// family resolvable, including gpt-5.5. Override via ACC2_OPENCODE_MODEL or
// SpawnOpts.model when the brain needs a different reasoner.
const DEFAULT_OPENCODE_MODEL = "openai/gpt-5.5";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MCP_HANDSHAKE_WINDOW_MS = 30_000;

/** Canonical name for v2's MCP server in the materialized opencode config.
 *  Stable across dispatches so the brain's prompts can reference it by name
 *  if needed (`@acc2-substrate substrate.admit_artifact`-style mentions). */
export const V2_OPENCODE_MCP_SERVER_NAME = "acc2-substrate";

/** v2's full MCP tool surface — kept here as a discovery hint for the brain
 *  prompt composer and so future contributors can see at a glance which tools
 *  the daemon advertises. The actual list is owned by `runtime/mcp_server.ts`
 *  (`server.addTool({ name: "substrate.…" })` calls). When new tools land
 *  there, append them here for prompt-compose visibility. */
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

/** Tool-name prefixes that prove an opencode tool_use hit the v2 MCP wire.
 *  opencode 1.4+ mangles MCP tool names by replacing the server-name and the
 *  `.` separator with underscores: the daemon advertises
 *  `substrate.admit_artifact` and opencode emits a tool_use with
 *  `tool: "acc2-substrate_substrate_admit_artifact"`. We accept BOTH shapes
 *  so a future opencode rev that drops the mangling still works:
 *    - Native shape: `substrate.*` / `runtime.*`
 *    - Mangled shape: `<server>_substrate_*` / `<server>_runtime_*`
 *  Any other prefix is either a built-in opencode tool (e.g. `bash`, `read`,
 *  `grep`) or a different MCP server's tool — neither counts as a v2
 *  handshake. */
const V2_MCP_NATIVE_PREFIXES = ["substrate.", "runtime."] as const;
const isV2McpToolName = (name: string | undefined): boolean => {
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
 *  spawned with `OPENCODE_CONFIG=<returned-path>`, will list v2's full tool
 *  surface (`substrate.*` + `runtime.*`) under `opencode mcp list` and
 *  expose those tools to the brain at run time.
 *
 *  Returns the absolute path to the written config file and the tempdir it
 *  lives in (so the caller can `rmSync(tempDir, { recursive: true })` after
 *  the subprocess exits).
 */
export const materializeOpencodeMcpConfig = (opts: {
  mcpServerUrl: string;
  configDir?: string;
  serverName?: string;
}): { configPath: string; tempDir: string } => {
  const serverName = opts.serverName ?? V2_OPENCODE_MCP_SERVER_NAME;
  const tempDir = opts.configDir ?? mkdtempSync(join(tmpdir(), "acc2-opencode-cfg-"));
  const configPath = join(tempDir, "opencode-config.json");
  // We deliberately only declare the `mcp` key — opencode MERGES configs, so
  // the operator's global model / provider / auth settings remain active.
  // type=remote → opencode connects as an HTTP client to fastmcp's
  // Streamable-HTTP transport at `/mcp` (the daemon's primary port).
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

const spawnRealOpencode = async (
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
    try { proc.kill("SIGTERM"); } catch { /* swallow */ }
  }, handshakeWindowMs);

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
  } catch { /* swallow */ }

  const exitCode = await proc.exited;
  clearTimeout(sigTerm);
  clearTimeout(sigKill);
  clearTimeout(mcpHandshakeWatchdog);
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

/** Mode-aware entrypoint. ACC2_BRIDGE_MODE=mock (default in tests, also the
 *  Phase E daemon default per CLAUDE.md) routes to opencodeQueryMock so the
 *  test suite stays hermetic. ACC2_BRIDGE_MODE=real spawns the real
 *  `opencode run` subprocess. */
export const opencodeQuery = async (
  req: BridgeRequest,
  db: Database,
): Promise<BridgeResult> => {
  const mode = process.env.ACC2_BRIDGE_MODE ?? "mock";
  if (mode === "real") {
    return spawnRealOpencode(req, db);
  }
  return opencodeQueryMock(req, db);
};

export { spawnRealOpencode };

// ── Adversarial mock (cycle-1 enforcement test) ────────────────────
//
// Phase D wires a SECOND mock entry point used only by the dispatcher's
// adversarial test fixture — it emits a `brain_cycle_2_started` event the
// dispatcher MUST reject. Real opencode never has access to this surface.

// ── High-residual mock (refinement-edge test) ─────────────────────
//
// Phase E: a third mock that admits a verifier returning residual=1 so the
// dispatcher's refinement-edge path is exercised. The action artifact runs
// successfully (so the verifier even gets called) — the verifier is the one
// declaring "this isn't good enough yet."

const FIXTURE_HIGH_RESIDUAL_ACTION = `// fixture high residual — action returns trivial observation
process.stdout.write("@@RESULT@@ " + JSON.stringify({ result: { value: 1 } }) + "\\n");
`;

const FIXTURE_HIGH_RESIDUAL_VERIFIER = `// fixture high residual — verifier always returns residual=1
process.stdout.write("@@RESULT@@ " + JSON.stringify({ residual: 1 }) + "\\n");
`;

export const opencodeQueryHighResidual = async (
  req: BridgeRequest,
  db: Database,
): Promise<BridgeResult> => {
  emitEvent(db, {
    kind: "bridge_invoked",
    substrate_origin: "opencode",
    directive_id: req.directiveId,
    task_id: req.taskId,
    payload: { fixture: "high_residual" } as JsonValue,
    invoker: "opencode",
  });

  const actionAdmission = await admitArtifact(
    db,
    {
      runtime: "bun",
      body: FIXTURE_HIGH_RESIDUAL_ACTION,
      declaredSandbox: BUN_DEFAULT_SANDBOX(),
      fixtureInput: {} as JsonValue,
      fixtureExpectedResidualBelow: 1.1, // accept anything — fixture-admission has its OWN verifier shape
      name: "fixture_high_residual_action",
    },
    (ev) => {
      emitEvent(db, {
        ...ev,
        directive_id: ev.directive_id ?? req.directiveId,
        task_id: ev.task_id ?? req.taskId,
        invoker: ev.invoker ?? "opencode",
      });
    },
  );
  if (!actionAdmission.ok) {
    return { ok: false, reason: { kind: "subprocess_crash", stderr_tail: actionAdmission.reason } };
  }

  // The verifier's admission fixture sees an arbitrary input; the verifier
  // returns residual=1 always, so admission's expected-below threshold must
  // be 1.1 (so admission accepts residual=1 cleanly).
  const verifierAdmission = await admitArtifact(
    db,
    {
      runtime: "bun",
      body: FIXTURE_HIGH_RESIDUAL_VERIFIER,
      declaredSandbox: BUN_DEFAULT_SANDBOX(),
      fixtureInput: {} as JsonValue,
      fixtureExpectedResidualBelow: 1.1,
      name: "fixture_high_residual_verifier",
    },
    (ev) => {
      emitEvent(db, {
        ...ev,
        directive_id: ev.directive_id ?? req.directiveId,
        task_id: ev.task_id ?? req.taskId,
        invoker: ev.invoker ?? "opencode",
      });
    },
  );
  if (!verifierAdmission.ok) {
    return { ok: false, reason: { kind: "subprocess_crash", stderr_tail: verifierAdmission.reason } };
  }

  emitEvent(db, {
    kind: "action_predicted",
    substrate_origin: "opencode",
    directive_id: req.directiveId,
    task_id: req.taskId,
    action_artifact_id: actionAdmission.artifactId,
    verifier_artifact_id: verifierAdmission.artifactId,
    predicted_residual: 0.95,
    payload: { intent: "intentionally-high-residual fixture" } as JsonValue,
    invoker: "opencode",
  });
  return { ok: true, final_response: "high-residual mock", usage: { tokens: 0 }, emitted_event_ids: [] };
};

export const opencodeQueryAdversarialCycle2 = async (
  req: BridgeRequest,
  db: Database,
): Promise<BridgeResult> => {
  emitEvent(db, {
    kind: "bridge_invoked",
    substrate_origin: "opencode",
    directive_id: req.directiveId,
    task_id: req.taskId,
    payload: { adversarial: true } as JsonValue,
    invoker: "opencode",
  });
  emitEvent(db, {
    kind: "brain_cycle_2_started",
    substrate_origin: "opencode",
    directive_id: req.directiveId,
    task_id: req.taskId,
    payload: { reason: "adversarial_self_iteration_attempt" } as JsonValue,
    invoker: "opencode",
  });
  return {
    ok: true,
    final_response: "adversarial mock",
    usage: { tokens: 0 },
    emitted_event_ids: [],
  };
};
