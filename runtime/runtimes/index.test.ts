// runtime/runtimes/index.test.ts — Candidate B (brain dispatch
// SW94JRKNFD36Q7G9, 2026-05-19): the open Runtime + runtime_runner
// registry fallback path. Validates that:
//
//   1. Existing three runtimes still narrow + invoke their hardcoded
//      runners (fast-paths preserved per KC S2SRK0NES127H503M0).
//   2. An unknown runtime with a `runtime_runner` registry row gets
//      resolved through the registry lookup and returns a declarative
//      observation envelope (the runner protocol is declarative in
//      this commit; runner execution is the brain's next cycle).
//   3. An unknown runtime WITHOUT a registry row fails closed with a
//      structured `unknown_runtime:<name>` observation (ok:false) so the
//      dispatcher caller can emit a deterministic refusal (admission
//      rejection / replay defer / mcp error / daemon skip — per Stage 4)
//      WITHOUT an exception path. Capability-aware resolveRuntime returns
//      a resolution rather than throwing (E4JWEQHT9N1JZ0P6CE89F78HG0).
//   4. The sandbox validator accepts the catch-all variant when
//      `fields` is present and rejects when omitted.
//   5. resolveRuntime probes capability BEFORE selecting a runner, emits
//      one runtime_self_diagnostic_recorded per resolution, and threads
//      the install hint into the fail-closed observation's sandboxWarnings.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../../substrate/db";
import type { EmitEventInput } from "../events";
import type { SandboxDecl } from "../../substrate/types";
import { validateSandboxDecl } from "../sandbox";
import {
  clearRuntimeResolutionCachesForTest,
  lookupRunnerInRegistry,
  resolveRuntime,
  runArtifactForRuntime,
} from "./index";
import { probeCamofoxAvailability } from "./camofox";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const insertRunnerRow = (
  db: ReturnType<typeof openDb>,
  args: { id?: string; runtime: string; payload: unknown; status?: "admitted" | "promoted" | "quarantined"; score?: number },
): string => {
  const id = args.id ?? `art_runner_${Math.random().toString(36).slice(2, 10)}`;
  db.run(
    `INSERT INTO act_artifact (
       id, runtime, kind, body, declared_sandbox, state_root,
       posterior_alpha, posterior_beta, score, confidence,
       recent_residual_mean, recent_kill_count, status, name,
       fixture_input, fixture_expected_residual,
       intent, summary, target_files, target_resources, source_candidate_id, owner_gate_verdict,
       supersedes, superseded_by, lost_version_count,
       created_at, updated_at
     ) VALUES (?, ?, 'runtime_runner', ?, ?, '', 1, 1, ?, 0.3, 0, 0, ?, ?, 'null', 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, ?, ?)`,
    [
      id,
      "bun", // the runner's OWN sandbox runtime — irrelevant for lookup
      JSON.stringify(args.payload),
      JSON.stringify({ runtime: "bun", cpu_ms: 1000, wall_ms: 1000, memory_mb: 64 }),
      args.score ?? 0.5,
      args.status ?? "admitted",
      args.runtime, // `name` column is the runtime string the registry matches against
      new Date().toISOString(),
      new Date().toISOString(),
    ],
  );
  return id;
};

describe("validateSandboxDecl — unknown-runtime catch-all variant", () => {
  test("accepts a catch-all decl that declares `fields`", () => {
    const decl: SandboxDecl = {
      runtime: "wasm-runtime-1",
      fields: { module: "hello.wasm" },
      wall_ms: 1000,
      memory_mb: 64,
    };
    const v = validateSandboxDecl(decl);
    expect(v.ok).toBe(true);
  });

  test("rejects a catch-all decl that omits `fields`", () => {
    const decl = { runtime: "wasm-runtime-2", wall_ms: 1000 } as unknown as SandboxDecl;
    const v = validateSandboxDecl(decl);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe("unknown_runtime_missing_fields");
    }
  });

  test("rejects a catch-all decl with malformed wall_ms", () => {
    const decl: SandboxDecl = {
      runtime: "wasm-runtime-3",
      fields: { module: "hi.wasm" },
      wall_ms: -5,
    };
    const v = validateSandboxDecl(decl);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe("bad_wall_ms");
    }
  });

  test("rejects a runtime that is the empty string", () => {
    const decl = { runtime: "", fields: {} } as unknown as SandboxDecl;
    const v = validateSandboxDecl(decl);
    expect(v.ok).toBe(false);
  });

  test("still narrows concrete bun decls cleanly", () => {
    const decl: SandboxDecl = {
      runtime: "bun",
      cpu_ms: 1000,
      wall_ms: 5000,
      memory_mb: 64,
    };
    const v = validateSandboxDecl(decl);
    expect(v.ok).toBe(true);
  });
});

describe("lookupRunnerInRegistry — runtime_runner row resolution", () => {
  test("returns null when no row matches the runtime string", () => {
    const db = openDb(":memory:");
    const row = lookupRunnerInRegistry(db, "no-such-runtime");
    expect(row).toBeNull();
  });

  test("returns the registry row when one exists", () => {
    const db = openDb(":memory:");
    const id = insertRunnerRow(db, {
      runtime: "wasm-runtime",
      payload: { module_path: "hello.wasm" },
    });
    const row = lookupRunnerInRegistry(db, "wasm-runtime");
    expect(row).not.toBeNull();
    if (row) {
      expect(row.id).toBe(id);
      expect(row.runtime).toBe("wasm-runtime");
      expect(row.status).toBe("admitted");
      expect(row.payload).toEqual({ module_path: "hello.wasm" });
    }
  });

  test("ignores quarantined rows and finds only admitted/promoted ones", () => {
    const db = openDb(":memory:");
    insertRunnerRow(db, { runtime: "qruntime", payload: { x: 1 }, status: "quarantined" });
    const row = lookupRunnerInRegistry(db, "qruntime");
    expect(row).toBeNull();
  });

  test("picks the highest-scored row when multiple match", () => {
    const db = openDb(":memory:");
    insertRunnerRow(db, { runtime: "ranked", payload: { score: "low" }, score: 0.2 });
    const winnerId = insertRunnerRow(db, { runtime: "ranked", payload: { score: "high" }, score: 0.9 });
    const row = lookupRunnerInRegistry(db, "ranked");
    expect(row).not.toBeNull();
    if (row) {
      expect(row.id).toBe(winnerId);
      expect(row.payload).toEqual({ score: "high" });
    }
  });
});

describe("runArtifactForRuntime — registry fallback path", () => {
  test("unknown runtime WITH a registered runner fails closed — declarative-only runner cannot fabricate a residual", async () => {
    const db = openDb(":memory:");
    insertRunnerRow(db, {
      runtime: "demo-runtime",
      payload: { entrypoint: "main.demo" },
    });
    const obs = await runArtifactForRuntime({
      artifactId: "art_demo_consumer",
      body: "// declarative — not executed in this commit",
      declaredSandbox: {
        runtime: "demo-runtime",
        fields: { input_shape: "json" },
        wall_ms: 5000,
        memory_mb: 64,
      },
      inputs: null,
      db,
    });
    // A registry runner is resolved but has no execution protocol wired.
    // Returning ok:true here would let a verifier_artifact bound to a
    // registry runtime report success (a scored residual) WITHOUT ever
    // executing — a fabricated truth signal. It must fail closed: the
    // four dispatcher sites read obs.ok===false + obs.error to refuse.
    expect(obs.ok).toBe(false);
    expect(obs.error).toBe("registry_runner_not_executable:demo-runtime");
    expect(obs.exitCode).toBe(-1);
    expect(obs.durationMs).toBe(0);
    // Still surfaces the declarative-only audit breadcrumb.
    expect(obs.sandboxWarnings).toContain("registry_runner_declarative_only:demo-runtime");
  });

  test("unknown runtime WITHOUT a registered runner fails closed with unknown_runtime observation", async () => {
    // Capability-aware resolution (resolveRuntime) returns a STRUCTURED
    // fail-closed observation instead of throwing — the four dispatcher
    // sites read obs.ok===false + obs.error to surface a deterministic
    // refusal (admission rejection / replay defer / mcp error / daemon
    // skip) rather than catching an exception. Fail-closed safety is
    // preserved: ok is false and the error names the unknown runtime.
    const db = openDb(":memory:");
    const obs = await runArtifactForRuntime({
      artifactId: "art_no_runner",
      body: "// no runner registered",
      declaredSandbox: {
        runtime: "phantom-runtime",
        fields: {},
        wall_ms: 5000,
        memory_mb: 64,
      },
      inputs: null,
      db,
    });
    expect(obs.ok).toBe(false);
    expect(obs.error).toBe("unknown_runtime:phantom-runtime");
    expect(obs.exitCode).toBe(-1);
  });

  test("unknown runtime without a db handle also fails closed with unknown_runtime observation", async () => {
    // Without a db, there is no registry to consult — the only available
    // outcome is the fail-closed observation. This is the contract that
    // lets the four dispatcher sites surface a deterministic refusal
    // without an exception path.
    const obs = await runArtifactForRuntime({
      artifactId: "art_no_db",
      body: "// no db handle",
      declaredSandbox: {
        runtime: "no-db-runtime",
        fields: {},
        wall_ms: 5000,
        memory_mb: 64,
      },
      inputs: null,
    });
    expect(obs.ok).toBe(false);
    expect(obs.error).toBe("unknown_runtime:no-db-runtime");
    expect(obs.exitCode).toBe(-1);
  });

  test("bun fast-path still invokes the hardcoded runner (no registry hit needed)", async () => {
    const db = openDb(":memory:");
    const obs = await runArtifactForRuntime({
      artifactId: "art_fastpath_bun",
      body: `console.log('@@RESULT@@ ' + JSON.stringify({ pong: true }));`,
      declaredSandbox: {
        runtime: "bun",
        cpu_ms: 1000,
        wall_ms: 5000,
        memory_mb: 64,
      },
      inputs: null,
      db,
    });
    expect(obs.ok).toBe(true);
    expect(obs.result).toEqual({ pong: true });
  });
});

describe("resolveRuntime — capability-aware probe + diagnostic emission", () => {
  test("emits runtime_self_diagnostic_recorded and resolves the bun fast-path", () => {
    clearRuntimeResolutionCachesForTest();
    const events: EmitEventInput[] = [];
    const resolution = resolveRuntime({
      artifactId: "art_probe_bun",
      declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
      emit: (e) => events.push(e),
    });
    // bun is always available under the test runner — fast-path resolves.
    expect(resolution.ok).toBe(true);
    expect(resolution.runtime).toBe("bun");
    // Exactly one diagnostic row per resolution, reporting availability.
    const diag = events.filter((e) => e.kind === "runtime_self_diagnostic_recorded");
    expect(diag.length).toBe(1);
    const payload = diag[0]!.payload as Record<string, unknown>;
    expect(payload.runtime).toBe("bun");
    expect(payload.fault_kind).toBe("runtime_available");
    expect(typeof payload.executable === "string" || payload.executable === null).toBe(true);
  });

  test("unknown runtime resolution is fail-closed (ok:false) and still emits a diagnostic", () => {
    clearRuntimeResolutionCachesForTest();
    const db = openDb(":memory:");
    const events: EmitEventInput[] = [];
    const resolution = resolveRuntime({
      artifactId: "art_probe_unknown",
      declaredSandbox: { runtime: "ghost-runtime", fields: {}, wall_ms: 5000, memory_mb: 64 },
      db,
      emit: (e) => events.push(e),
    });
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.error).toBe("unknown_runtime:ghost-runtime");
    }
    expect(events.filter((e) => e.kind === "runtime_self_diagnostic_recorded").length).toBe(1);
  });

  test("an unavailable runtime fails closed BEFORE spawn, threading its install hint into sandboxWarnings + runtime_unavailable error", async () => {
    // Deterministic regardless of environment: drive the camofox-browser
    // runtime and branch on the probe's own verdict. When the binary is
    // ABSENT, the capability gate must short-circuit BEFORE any spawn — the
    // fail-closed observation carries the probe's install hint as a sandbox
    // warning and a runtime_unavailable:<rt> error. When the binary is
    // PRESENT we skip the (slow, real-browser) spawn entirely and only
    // assert that the diagnostic + resolution path is wired (resolveRuntime
    // resolves ok without throwing). Either branch exercises the gate
    // without depending on a flaky browser launch.
    clearRuntimeResolutionCachesForTest();
    const probe = probeCamofoxAvailability();
    const decl = { runtime: "camofox-browser", browser_allow_domains: [], wall_ms: 5000, memory_mb: 64 } as unknown as SandboxDecl;
    if (!probe.ok) {
      const obs = await runArtifactForRuntime({
        artifactId: "art_probe_camofox",
        body: "// not spawned when unavailable",
        declaredSandbox: decl,
        inputs: null,
      });
      expect(obs.ok).toBe(false);
      expect(obs.error).toBe("runtime_unavailable:camofox-browser");
      expect(obs.exitCode).toBe(-1);
      // The probe's install hint is forwarded so the operator sees how to
      // repair the missing capability without reading the runtime source.
      expect(obs.sandboxWarnings.some((w) => w.length > 0)).toBe(true);
      if (probe.install_hint) {
        expect(obs.sandboxWarnings).toContain(probe.install_hint);
      }
    } else {
      // camofox is installed — assert the resolver path (no spawn) resolves
      // the fast-path without throwing and emits exactly one diagnostic.
      const events: EmitEventInput[] = [];
      const resolution = resolveRuntime({
        artifactId: "art_probe_camofox",
        declaredSandbox: decl,
        emit: (e) => events.push(e),
      });
      expect(resolution.ok).toBe(true);
      expect(resolution.runtime).toBe("camofox-browser");
      expect(events.filter((e) => e.kind === "runtime_self_diagnostic_recorded").length).toBe(1);
    }
  });
});
