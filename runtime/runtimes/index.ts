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
import { probeBunAvailability, runBunArtifact, type BunRuntimeObservation } from "./bun";
import { probeUvAvailability, runUvArtifact, type UvRuntimeObservation } from "./uv";
import { probeCamofoxAvailability, runCamofoxArtifact, type CamofoxRuntimeObservation } from "./camofox";

export type UnifiedRuntimeInvocation = {
  artifactId: string;
  body: string;
  /** Path A (2026-05-20, contract A0DQT211JH): runArtifactForRuntime is
   *  executable-only. Callers MUST NOT invoke it on data-class rows
   *  (runtime=null, declaredSandbox=null) — the dispatcher reads
   *  declaredSandbox.runtime to route and would throw. */
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

/** Resolved capability snapshot for one runtime string. Carries the
 *  executable that would be spawned, its version when cheaply knowable,
 *  the missing binary + install hint when unavailable, and the sandbox
 *  enforcement posture. This is the structural unit the capability-aware
 *  resolver produces and the `runtime_self_diagnostic_recorded` ledger
 *  row mirrors. */
export type RuntimeAvailability = {
  runtime: string;
  ok: boolean;
  executable?: string;
  version?: string;
  missing_binary?: string;
  install_hint?: string;
  sandbox?: { enforced: boolean; mechanism?: string; degraded_reason?: string };
};

/** Outcome of resolving a runtime to a concrete runner. Either a usable
 *  runtime (`ok:true`, optionally carrying a registry runner row) or a
 *  fail-closed result (`ok:false`) whose `availability` explains WHY —
 *  unavailable binary or unknown runtime — without throwing. */
export type RuntimeResolution =
  | { ok: true; runtime: string; availability: RuntimeAvailability; runner?: RuntimeRunnerRow }
  | { ok: false; runtime: string; availability: RuntimeAvailability; error: string };

// Per-process resolution caches (KC: runtime selection is a single
// capability-aware path). The registry-runner lookup and the capability
// probe are both stable within a process; caching them keeps every
// artifact invocation zero-indirection after the first probe. Cleared
// only by the test hook below.
const registryRunnerCache = new Map<string, RuntimeRunnerRow | null>();
const runtimeProbeCache = new Map<string, RuntimeAvailability>();

/** Test surface: drop both resolution caches so a test can re-probe a
 *  runtime after mutating PATH / env / registry rows. Production callers
 *  MUST NOT invoke this — the caches are correct for the process lifetime. */
export const clearRuntimeResolutionCachesForTest = (): void => {
  registryRunnerCache.clear();
  runtimeProbeCache.clear();
};

const safeJson = (body: string): JsonValue => {
  try {
    return JSON.parse(body) as JsonValue;
  } catch {
    return body as JsonValue;
  }
};

/** Capability-probe a runtime string WITHOUT spawning the artifact. The
 *  three concrete runtimes delegate to their module's pure probe; any
 *  other runtime string is treated as registry-resolved (the registry
 *  lookup in `resolveRuntime` decides availability) and reported
 *  available here so the diagnostic row reflects "probe deferred to
 *  registry". Fail-closed details (missing_binary / install_hint) flow
 *  straight from the per-runtime probe. */
const probeRuntime = (
  runtime: string,
  _sandbox: SandboxDecl,
  _db?: Database,
): RuntimeAvailability => {
  if (runtime === "bun") {
    const p = probeBunAvailability();
    return { runtime, ok: p.ok, executable: p.executable, version: p.version };
  }
  if (runtime === "uv") {
    const p = probeUvAvailability();
    return {
      runtime,
      ok: p.ok,
      executable: p.executable,
      missing_binary: p.missing_binary,
      install_hint: p.install_hint,
      sandbox: p.sandbox,
    };
  }
  if (runtime === "camofox-browser") {
    const p = probeCamofoxAvailability();
    return {
      runtime,
      ok: p.ok,
      executable: p.executable,
      missing_binary: p.missing_binary,
      install_hint: p.install_hint,
    };
  }
  // Open registry runtime: the binary/availability is the registry
  // runner's concern. Report available here; resolveRuntime's registry
  // lookup decides whether a runner row actually exists.
  return { runtime, ok: true };
};

/** Build the fail-closed observation returned when a runtime is
 *  unavailable or unknown — instead of throwing. Mirrors the
 *  observation envelope every caller already consumes (ok/result/error/
 *  durationMs/etc), threading the install hint into `sandboxWarnings`
 *  and the structured error string so admission / replay / mcp surfaces
 *  fail closed deterministically. */
const unavailableObservation = (
  resolution: Extract<RuntimeResolution, { ok: false }>,
): RegistryRunnerObservation => {
  const { availability, error, runtime } = resolution;
  const warnings: string[] = [];
  if (availability.install_hint) warnings.push(availability.install_hint);
  if (availability.missing_binary) warnings.push(`missing_binary:${availability.missing_binary}`);
  return {
    ok: false,
    error: error === "runtime_unavailable" ? `runtime_unavailable:${runtime}` : error,
    durationMs: 0,
    exitCode: -1,
    stderrTail: "",
    sandboxWarnings: warnings,
    irreversibleEffects: [],
  };
};

/** Look up a runtime_runner registry entry for the given runtime string.
 *  Selects the highest-scored admitted/promoted row whose `kind =
 *  'runtime_runner'` and `name = runtime`. Returns `null` when no
 *  matching row exists — the caller decides how to fail closed. Cached
 *  per-process keyed by runtime string. */
export const lookupRunnerInRegistry = (
  db: Database,
  runtime: string,
): RuntimeRunnerRow | null => {
  const cached = registryRunnerCache.get(runtime);
  if (cached !== undefined) return cached;
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
  const resolved = row
    ? { id: row.id, runtime: row.runtime, payload: safeJson(row.body), status: row.status }
    : null;
  registryRunnerCache.set(runtime, resolved);
  return resolved;
};

/** Capability-aware runtime resolution — the single selection path for
 *  every artifact invocation. Probes runtime availability (cached) BEFORE
 *  selecting a runner, emits one `runtime_self_diagnostic_recorded` row
 *  per resolution so availability/version/missing-binary is ledger-visible
 *  across ALL runtimes (closing the gap where only bun preflighted), and
 *  returns a structured resolution instead of throwing.
 *
 *  Order of resolution:
 *    1. Probe capability — unavailable → `ok:false` (no spawn attempted).
 *    2. Fast-path: bun / uv / camofox-browser → hardcoded runners.
 *    3. Registry: any other runtime string → `runtime_runner` lookup.
 *    4. Fail-closed: no registry match → `ok:false, error:unknown_runtime`.
 *
 *  The fast-paths stay hardcoded by design (KC S2SRK0NES127H503M0):
 *  they're the high-volume paths and we want zero indirection on every
 *  artifact invocation. */
export const resolveRuntime = (
  inv: Pick<UnifiedRuntimeInvocation, "declaredSandbox" | "db" | "emit" | "artifactId">,
): RuntimeResolution => {
  // Path A (2026-05-20, contract A0DQT211JH): refuse resolution when the
  // caller passed a null declaredSandbox (data-class row). Callers must
  // gate on row.runtime !== null before reaching this resolver.
  if (!inv.declaredSandbox) {
    throw new Error(
      "runArtifactForRuntime called with null declaredSandbox; data-class rows have no executable semantics",
    );
  }
  const runtime = inv.declaredSandbox.runtime;
  const cached = runtimeProbeCache.get(runtime) ?? probeRuntime(runtime, inv.declaredSandbox, inv.db);
  runtimeProbeCache.set(runtime, cached);
  inv.emit?.({
    kind: "runtime_self_diagnostic_recorded",
    substrate_origin: "substrate_auto",
    action_artifact_id: inv.artifactId,
    payload: {
      runtime,
      fault_kind: cached.ok ? "runtime_available" : "runtime_unavailable",
      executable: cached.executable ?? null,
      version: cached.version ?? null,
      missing_binary: cached.missing_binary ?? null,
      install_hint: cached.install_hint ?? null,
      repair_hint: cached.install_hint ?? undefined,
      sandbox: cached.sandbox ?? null,
    } as JsonValue,
  });
  if (!cached.ok) return { ok: false, runtime, availability: cached, error: "runtime_unavailable" };
  if (runtime === "bun" || runtime === "uv" || runtime === "camofox-browser") {
    return { ok: true, runtime, availability: cached };
  }
  if (!inv.db) {
    return { ok: false, runtime, availability: cached, error: `unknown_runtime:${runtime}` };
  }
  const runner = lookupRunnerInRegistry(inv.db, runtime);
  return runner
    ? { ok: true, runtime, availability: cached, runner }
    : { ok: false, runtime, availability: cached, error: `unknown_runtime:${runtime}` };
};

/** Dispatch an artifact invocation to the runner declared by its sandbox,
 *  through the centralized capability-aware resolver. Returns the matching
 *  observation type; callers read `ok`, `result`, `irreversibleEffects`,
 *  etc. which are present on every variant. An unavailable/unknown runtime
 *  yields a fail-closed observation (not a throw). */
export const runArtifactForRuntime = async (
  inv: UnifiedRuntimeInvocation,
): Promise<UnifiedRuntimeObservation> => {
  const resolution = resolveRuntime(inv);
  if (!resolution.ok) return unavailableObservation(resolution);
  if (resolution.runtime === "bun") {
    return runBunArtifact({
      ...inv,
      declaredSandbox: inv.declaredSandbox as BunSandboxDecl,
    });
  }
  if (resolution.runtime === "uv") {
    return runUvArtifact({
      ...inv,
      declaredSandbox: inv.declaredSandbox as UvSandboxDecl,
    });
  }
  if (resolution.runtime === "camofox-browser") {
    return runCamofoxArtifact({
      ...inv,
      declaredSandbox: inv.declaredSandbox as CamofoxSandboxDecl,
    });
  }
  return invokeRegisteredRunner(resolution.runner!, inv);
};

/** Invoke a runtime_runner registry row. Registry rows are currently
 *  declarative capability records only; there is no execution protocol
 *  that can prove the action/verifier artifact actually ran. Until that
 *  protocol exists, registry runners fail closed so residuals cannot be
 *  fabricated from a declarative-only no-op. */
const invokeRegisteredRunner = async (
  runner: RuntimeRunnerRow,
  _inv: UnifiedRuntimeInvocation,
): Promise<RegistryRunnerObservation> => {
  return {
    ok: false,
    error: `registry_runner_not_executable:${runner.runtime}`,
    durationMs: 0,
    exitCode: -1,
    stderrTail: `runtime_runner ${runner.id} is declarative-only; no execution protocol is wired`,
    sandboxWarnings: [
      `registry_runner_declarative_only:${runner.runtime}`,
    ],
    irreversibleEffects: [],
  };
};
