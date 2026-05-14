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

/** Phase D mock: react to the fixture_d_count_todos prompt by admitting the
 *  canonical action + verifier artifacts and emitting action_predicted that
 *  references both. For prompts that don't carry the fixture marker we return
 *  auth_missing so future fixtures can compose against this stub. */
export const opencodeQuery = async (
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

  if (!req.prompt.includes(FIXTURE_D_MARKER)) {
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

// ── Adversarial mock (cycle-1 enforcement test) ────────────────────
//
// Phase D wires a SECOND mock entry point used only by the dispatcher's
// adversarial test fixture — it emits a `brain_cycle_2_started` event the
// dispatcher MUST reject. Real opencode never has access to this surface.

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
