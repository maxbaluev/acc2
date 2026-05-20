// Runtime dispatcher — selects the runner for an artifact's declared
// sandbox.runtime. Same observation shape across bun / uv / camofox-browser
// so the dispatcher can call once and consume the result uniformly.
//
// Candidate B (brain dispatch SW94JRKNFD36Q7G9, 2026-05-19): `Runtime` is
// an open string. The three concrete runtimes remain hardcoded fast-paths;
// every other runtime string is resolved through the `runtime_runner`
// registry — act_artifact rows whose `kind = 'runtime_runner'` and whose
// `name` equals the runtime string. The registry row's payload declares
// either a module ref or an inline runner body. No matching row → throw
// `unknown_runtime:<name>` so the call site emits a deterministic
// fail-closed event (admission rejection / replay defer / mcp error /
// daemon skip — per Stage 4).

import type { Database } from "bun:sqlite";
import type { BunSandboxDecl, CamofoxSandboxDecl, JsonValue, SandboxDecl, UvSandboxDecl } from "../../substrate/types";
import type { EmitEventInput } from "../events";
import { runBunArtifact, type BunRuntimeObservation } from "./bun";
import { runUvArtifact, type UvRuntimeObservation } from "./uv";
import { runCamofoxArtifact, type CamofoxRuntimeObservation } from "./camofox";

export type UnifiedRuntimeInvocation = {
  artifactId: string;
  body: string;
  declaredSandbox: SandboxDecl;
  inputs: JsonValue;
  budget?: { wallMs?: number; memoryMb?: number };
  emit?: (event: EmitEventInput) => void;
  /** Optional substrate handle for resolving runtime_runner rows. When
   *  omitted, only the three concrete fast-paths are available — an
   *  unknown runtime throws `unknown_runtime:<name>` because there is no
   *  registry to consult. */
  db?: Database;
};

// Open-shape observation envelope — the three concrete runtimes return
// strongly-typed variants, and registry-resolved runners return a
// structurally identical envelope (ok/result/error/durationMs/etc).
// Callers consume the shared fields uniformly.
export type RegistryRunnerObservation = {
  ok: boolean;
  result?: JsonValue;
  error?: string;
  durationMs: number;
  exitCode: number;
  stderrTail: string;
  sandboxWarnings: string[];
  irreversibleEffects: Array<{ kind: string; description: string }>;
};

export type UnifiedRuntimeObservation =
  | BunRuntimeObservation
  | UvRuntimeObservation
  | CamofoxRuntimeObservation
  | RegistryRunnerObservation;

/** runtime_runner registry row (declarative-only — Stage 2 wires the
 *  lookup; runner execution itself is not implemented in this commit
 *  because the runner protocol is the brain's next design cycle). The
 *  payload shape lives in the registry, not in code. */
export type RuntimeRunnerRow = {
  id: string;
  runtime: string;
  payload: JsonValue;
  status: string;
};

/** Look up a runtime_runner registry entry for the given runtime string.
 *  Selects the highest-scored admitted/promoted row whose `kind =
 *  'runtime_runner'` and `name = runtime`. Returns `null` when no
 *  matching row exists — the caller decides how to fail closed. */
export const lookupRunnerInRegistry = (
  db: Database,
  runtime: string,
): RuntimeRunnerRow | null => {
  const row = db
    .query(
      `SELECT id, name AS runtime, body, status
         FROM act_artifact
        WHERE kind = 'runtime_runner'
          AND name = ?
          AND status IN ('admitted', 'promoted')
        ORDER BY score DESC, updated_at DESC
        LIMIT 1`,
    )
    .get(runtime) as { id: string; runtime: string; body: string; status: string } | null;
  if (!row) return null;
  let payload: JsonValue;
  try {
    payload = JSON.parse(row.body) as JsonValue;
  } catch {
    payload = row.body as JsonValue;
  }
  return { id: row.id, runtime: row.runtime, payload, status: row.status };
};

/** Dispatch an artifact invocation to the runner declared by its sandbox.
 *  Returns the matching observation type; callers read `ok`, `result`,
 *  `irreversibleEffects`, etc. which are present on every variant.
 *
 *  Order of resolution:
 *    1. Fast-path: bun / uv / camofox-browser → hardcoded runners.
 *    2. Registry: any other runtime string → `runtime_runner` lookup.
 *    3. Fail-closed: no registry match → throw `unknown_runtime:<name>`.
 *
 *  The fast-paths stay hardcoded by design (KC S2SRK0NES127H503M0):
 *  they're the high-volume paths and we want zero indirection on every
 *  artifact invocation. */
export const runArtifactForRuntime = async (
  inv: UnifiedRuntimeInvocation,
): Promise<UnifiedRuntimeObservation> => {
  const runtime = inv.declaredSandbox.runtime;
  if (runtime === "bun") {
    return runBunArtifact({
      ...inv,
      declaredSandbox: inv.declaredSandbox as BunSandboxDecl,
    });
  }
  if (runtime === "uv") {
    return runUvArtifact({
      ...inv,
      declaredSandbox: inv.declaredSandbox as UvSandboxDecl,
    });
  }
  if (runtime === "camofox-browser") {
    return runCamofoxArtifact({
      ...inv,
      declaredSandbox: inv.declaredSandbox as CamofoxSandboxDecl,
    });
  }
  // Open registry lookup. Without a db handle there is no registry to
  // consult, so the only available outcome is the fail-closed throw.
  if (inv.db) {
    const runner = lookupRunnerInRegistry(inv.db, runtime);
    if (runner) {
      return invokeRegisteredRunner(runner, inv);
    }
  }
  throw new Error(
    `unknown_runtime:${runtime}; no registered runner found in runtime_runner registry`,
  );
};

/** Invoke a runtime_runner registry row. The runner protocol is
 *  declarative-only in this commit — the row's payload is returned as
 *  the observation result so callers can observe registry resolution
 *  without spawning anything. A subsequent brain dispatch wires actual
 *  runner execution (module load vs inline body); the dispatcher
 *  surface stays the same. */
const invokeRegisteredRunner = async (
  runner: RuntimeRunnerRow,
  _inv: UnifiedRuntimeInvocation,
): Promise<RegistryRunnerObservation> => {
  // Declarative no-op: the runner row was resolved successfully. Real
  // runner execution lands in the brain's follow-up design cycle. We
  // mark the result clearly so call-site logs identify these
  // invocations as registry-resolved-but-not-yet-executed.
  return {
    ok: true,
    result: {
      runner_id: runner.id,
      runtime: runner.runtime,
      status: "registered_runner_declarative_only",
      payload: runner.payload,
    } as JsonValue,
    durationMs: 0,
    exitCode: 0,
    stderrTail: "",
    sandboxWarnings: [
      `registry_runner_declarative_only:${runner.runtime}`,
    ],
    irreversibleEffects: [],
  };
};
