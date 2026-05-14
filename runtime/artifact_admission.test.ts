// acc2 artifact admission tests — covers the sandbox-decl validation, the
// fixture-run smoke test, and the Phase G stub paths.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { admitArtifact } from "./artifact_admission";
import { emitEvent, type EmitEventInput } from "./events";
import { getArtifact } from "./artifact_store";
import type { Database } from "bun:sqlite";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const captureEmit = (sink: EmitEventInput[], db: Database) => (event: EmitEventInput) => {
  sink.push(event);
  emitEvent(db, event);
};

describe("admitArtifact — happy path", () => {
  test("admits a valid bun artifact whose fixture run completes ok", async () => {
    const db = openDb(":memory:");
    const events: EmitEventInput[] = [];
    const body = [
      "const inputs = JSON.parse(process.env.ACC2_INPUTS ?? 'null');",
      "console.log('@@RESULT@@ ' + JSON.stringify({ ok: true, echoed: inputs }));",
    ].join("\n");
    const result = await admitArtifact(
      db,
      {
        runtime: "bun",
        body,
        declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
        fixtureInput: { ping: "pong" },
        fixtureExpectedResidualBelow: 0.2,
      },
      captureEmit(events, db),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = getArtifact(db, result.artifactId);
    expect(row).not.toBeNull();
    expect(row!.runtime).toBe("bun");
    expect(row!.status).toBe("admitted");
    expect(row!.score).toBeCloseTo(0.5, 6);
    expect(row!.confidence).toBeCloseTo(0.3, 6);
    // Emitted exactly one code_artifact_admitted event at the end.
    const admitted = events.filter((e) => e.kind === "code_artifact_admitted");
    expect(admitted.length).toBe(1);
  });

  test("admits a bun artifact whose fixture result includes a low residual field", async () => {
    const db = openDb(":memory:");
    const body = `console.log('@@RESULT@@ ' + JSON.stringify({ residual: 0.05 }));`;
    const result = await admitArtifact(
      db,
      {
        runtime: "bun",
        body,
        declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
        fixtureInput: null,
        fixtureExpectedResidualBelow: 0.2,
      },
      () => undefined,
    );
    expect(result.ok).toBe(true);
  });
});

describe("admitArtifact — rejections", () => {
  test("rejects when the artifact body throws — emits runtime_error and rolls back", async () => {
    const db = openDb(":memory:");
    const events: EmitEventInput[] = [];
    const body = `throw new Error("admission boom");`;
    const before = (db.query("SELECT COUNT(*) AS c FROM code_artifact").get() as { c: number }).c;
    const result = await admitArtifact(
      db,
      {
        runtime: "bun",
        body,
        declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
        fixtureInput: null,
        fixtureExpectedResidualBelow: 0.2,
      },
      captureEmit(events, db),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("runtime_error");
    const after = (db.query("SELECT COUNT(*) AS c FROM code_artifact").get() as { c: number }).c;
    expect(after).toBe(before);
    expect(events.some((e) => e.kind === "code_artifact_admission_rejected")).toBe(true);
  });

  test("rejects a uv artifact with phase_g_runtime_unsupported", async () => {
    const db = openDb(":memory:");
    const events: EmitEventInput[] = [];
    const result = await admitArtifact(
      db,
      {
        runtime: "uv",
        body: "# uv stub",
        declaredSandbox: { runtime: "uv", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
        fixtureInput: null,
        fixtureExpectedResidualBelow: 0.2,
      },
      captureEmit(events, db),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("phase_g_runtime_unsupported");
    expect(events.some((e) => e.kind === "code_artifact_admission_rejected")).toBe(true);
  });

  test("rejects a camofox-browser artifact with phase_g_runtime_unsupported", async () => {
    const db = openDb(":memory:");
    const result = await admitArtifact(
      db,
      {
        runtime: "camofox-browser",
        body: "// browser stub",
        declaredSandbox: {
          runtime: "camofox-browser",
          browser_allow_domains: ["example.com"],
          browser_profile_root: "/tmp/p",
          wall_ms: 1000,
          memory_mb: 256,
        },
        fixtureInput: { url: "https://example.com" },
        fixtureExpectedResidualBelow: 0.2,
      },
      () => undefined,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("phase_g_runtime_unsupported");
  });

  test("rejects when sandbox decl is malformed (missing wall_ms)", async () => {
    const db = openDb(":memory:");
    const events: EmitEventInput[] = [];
    const result = await admitArtifact(
      db,
      {
        runtime: "bun",
        body: "console.log('@@RESULT@@ {}');",
        declaredSandbox: { runtime: "bun", cpu_ms: 1000, memory_mb: 64 } as unknown as {
          runtime: "bun"; cpu_ms: number; wall_ms: number; memory_mb: number;
        },
        fixtureInput: null,
        fixtureExpectedResidualBelow: 0.2,
      },
      captureEmit(events, db),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("sandbox_decl_invalid");
    expect(events.some((e) => e.kind === "code_artifact_admission_rejected")).toBe(true);
  });

  test("rejects when runtime field disagrees with declared_sandbox.runtime", async () => {
    const db = openDb(":memory:");
    const result = await admitArtifact(
      db,
      {
        runtime: "bun",
        body: "console.log('@@RESULT@@ {}');",
        // Pass a uv sandbox decl with a bun runtime — admission must catch.
        declaredSandbox: {
          runtime: "uv", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64,
        },
        fixtureInput: null,
        fixtureExpectedResidualBelow: 0.2,
      },
      () => undefined,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("sandbox_decl_invalid");
    expect(result.detail ?? "").toContain("runtime_mismatch");
  });

  test("rejects when the body returns an explicit residual >= threshold", async () => {
    const db = openDb(":memory:");
    const body = `console.log('@@RESULT@@ ' + JSON.stringify({ residual: 0.95 }));`;
    const result = await admitArtifact(
      db,
      {
        runtime: "bun",
        body,
        declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
        fixtureInput: null,
        fixtureExpectedResidualBelow: 0.2,
      },
      () => undefined,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("fixture_residual_too_high");
  });
});
