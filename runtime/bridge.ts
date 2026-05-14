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

import type { Database } from "bun:sqlite";
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
  | { kind: "parse_error"; raw: string };

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
 *  references both. Unknown prompts return auth_missing so future fixtures
 *  can compose against this stub. */
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
    emitEvent(db, {
      kind: "bridge_failed",
      substrate_origin: "opencode",
      directive_id: req.directiveId,
      task_id: req.taskId,
      payload: { reason: "phase_e_real_bridge_not_wired" } as JsonValue,
      invoker: "opencode",
    });
    return { ok: false, reason: { kind: "auth_missing" } };
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
};

// NOTE: opencode 1.4+ renamed the provider model ids; `openai/gpt-5-mini` no
// longer resolves. The default below points at the current canonical id; the
// Batch 2.α smoke confirmed `openai/gpt-5.4-mini` works against opencode 1.4.3.
// Override via ACC2_OPENCODE_MODEL or SpawnOpts.model.
const DEFAULT_OPENCODE_MODEL = "openai/gpt-5.4-mini";
const DEFAULT_TIMEOUT_MS = 60_000;

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

  emitEvent(db, {
    kind: "bridge_invoked",
    substrate_origin: "opencode",
    directive_id: req.directiveId,
    task_id: req.taskId,
    payload: { prompt_chars: req.prompt.length, model, real: true } as JsonValue,
    invoker: "opencode",
  });

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
        MCP_SERVER_URL: process.env.V2_MCP_SERVER_URL ?? "",
      },
    });
  } catch (err) {
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

  let stdoutBuf = "";
  let stderrBuf = "";
  let cycleViolation: string | null = null;
  let finalResponse = "";
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
    // Mirror opencode's tool_call events into the substrate for audit.
    if (kind === "tool_call" || kind === "tool_result") {
      emitEvent(db, {
        kind: "bridge_frame_received",
        substrate_origin: "opencode",
        directive_id: req.directiveId,
        task_id: req.taskId,
        payload: parsed as JsonValue,
        invoker: "opencode",
      });
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

  if (cycleViolation) {
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

  emitEvent(db, {
    kind: "bridge_completed",
    substrate_origin: "opencode",
    directive_id: req.directiveId,
    task_id: req.taskId,
    payload: { final_response_chars: finalResponse.length, model, real: true } as JsonValue,
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
