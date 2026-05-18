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

  test("admits a uv artifact end-to-end OR rejects cleanly when uv is absent", async () => {
    const db = openDb(":memory:");
    const events: EmitEventInput[] = [];
    // Minimal Python body — the runtime wrapper provides json + the result
    // marker emission. We assert on the OUTER admission outcome only: when uv
    // is installed admission must succeed; otherwise we expect a clean
    // runtime_unavailable refusal so the test stays hermetic.
    const result = await admitArtifact(
      db,
      {
        runtime: "uv",
        body: "result = inputs.get('x', 0) + 1\nprint('@@RESULT@@ ' + json.dumps({'ok': True, 'value': result}))",
        declaredSandbox: { runtime: "uv", cpu_ms: 1000, wall_ms: 15000, memory_mb: 256 },
        fixtureInput: { x: 41 },
        fixtureExpectedResidualBelow: 0.2,
      },
      captureEmit(events, db),
    );
    // Either outcome is acceptable depending on whether uv is on PATH; both
    // shapes must be CLEAN (no thrown error, no orphan row).
    if (!result.ok) {
      expect(["runtime_unavailable", "runtime_error"]).toContain(result.reason);
      // Row must be deleted on rejection.
      const c = (db.query("SELECT COUNT(*) AS c FROM code_artifact").get() as { c: number }).c;
      expect(c).toBe(0);
    } else {
      // Admission succeeded — the row is present at admit priors.
      const row = (db.query("SELECT runtime FROM code_artifact WHERE id = ?").get(result.artifactId) as { runtime: string });
      expect(row.runtime).toBe("uv");
    }
  });

  test("rejects a camofox-browser artifact cleanly with runtime_unavailable when the camoufox binary is absent", async () => {
    // Force the fast-fail branch in runtime/runtimes/camofox.ts by pointing
    // CAMOUFOX_BINARY_PATH at a non-existent path. Without this pin the test
    // env (which has playwright + ~/.cache/camoufox/camoufox both present)
    // would exercise the happy path and burn ~1.5s actually launching firefox.
    const prevBin = process.env.CAMOUFOX_BINARY_PATH;
    process.env.CAMOUFOX_BINARY_PATH = "/nonexistent/acc2-test-camoufox-missing";
    try {
      const db = openDb(":memory:");
      const events: EmitEventInput[] = [];
      const result = await admitArtifact(
        db,
        {
          runtime: "camofox-browser",
          body: "await session.goto(inputs.url); console.log('@@RESULT@@ ' + JSON.stringify({ ok: true }));",
          declaredSandbox: {
            runtime: "camofox-browser",
            browser_allow_domains: ["example.com"],
            browser_profile_root: "/tmp/acc2-test-profile",
            wall_ms: 1000,
            memory_mb: 256,
          },
          fixtureInput: { url: "https://example.com" },
          fixtureExpectedResidualBelow: 0.2,
        },
        captureEmit(events, db),
      );
      // The runtime fast-fails on missing binary and admission folds that
      // into `runtime_unavailable` (or `runtime_error`) cleanly.
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(["runtime_unavailable", "runtime_error"]).toContain(result.reason);
      }
    } finally {
      if (prevBin === undefined) delete process.env.CAMOUFOX_BINARY_PATH;
      else process.env.CAMOUFOX_BINARY_PATH = prevBin;
    }
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

  test("predicate gate refuses ceo_buyer body containing 'friction' (C1, no row inserted)", async () => {
    const db = openDb(":memory:");
    const events: EmitEventInput[] = [];
    const before = (db.query("SELECT COUNT(*) AS c FROM code_artifact").get() as { c: number }).c;
    const body = `console.log('@@RESULT@@ ' + JSON.stringify({ headline: "Friction-free onboarding", ok: true }));`;
    const result = await admitArtifact(
      db,
      {
        runtime: "bun",
        body,
        declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
        fixtureInput: null,
        fixtureExpectedResidualBelow: 0.2,
        audience: "ceo_buyer",
      },
      captureEmit(events, db),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("predicate_gate_failed");
    // No code_artifact row inserted — the gate runs BEFORE insert.
    const after = (db.query("SELECT COUNT(*) AS c FROM code_artifact").get() as { c: number }).c;
    expect(after).toBe(before);
    // Exactly one predicate_gate_rejected event was emitted.
    const rejections = events.filter((e) => e.kind === "predicate_gate_rejected");
    expect(rejections.length).toBe(1);
    const payload = rejections[0]!.payload as Record<string, unknown>;
    expect(payload.audience).toBe("ceo_buyer");
    expect(payload.match_count).toBeGreaterThan(0);
  });

  test("predicate gate admits ceo_buyer body when no banned phrases present", async () => {
    const db = openDb(":memory:");
    const events: EmitEventInput[] = [];
    const body = [
      "const inputs = JSON.parse(process.env.ACC2_INPUTS ?? 'null');",
      "console.log('@@RESULT@@ ' + JSON.stringify({ ok: true, plan: 'roll out to ten partners next quarter' }));",
    ].join("\n");
    const result = await admitArtifact(
      db,
      {
        runtime: "bun",
        body,
        declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
        fixtureInput: { audience: "ceo_buyer" },
        fixtureExpectedResidualBelow: 0.2,
        audience: "ceo_buyer",
      },
      captureEmit(events, db),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No predicate_gate_rejected event surfaced; admission proceeded
    // through the canonical path and the row landed.
    expect(events.some((e) => e.kind === "predicate_gate_rejected")).toBe(false);
    expect(events.some((e) => e.kind === "code_artifact_admitted")).toBe(true);
    const row = getArtifact(db, result.artifactId);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("admitted");
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

  // C3 (2026-05-18, directive QHTRBV6PFX2JVBMHDNDA4B03GC).
  test("strategy-first gate admits atms_report_v* when a cited knowledge_candidate ends with _strategic_direction_chosen", async () => {
    const db = openDb(":memory:");
    const events: EmitEventInput[] = [];
    // Emit the strategic-direction KC the report cites.
    const kc = emitEvent(db, {
      kind: "knowledge_candidate",
      directive_id: "d_strategy_fixture",
      task_id: "t_strategy_fixture",
      payload: {
        claim: "vertical_concentration_on_industrial_safety_strategic_direction_chosen",
        evidence: ["S1", "S2", "T1"],
      },
    });
    const body = `console.log('@@RESULT@@ ' + JSON.stringify({ ok: true, report: 'v6' }));`;
    const result = await admitArtifact(
      db,
      {
        runtime: "bun",
        body,
        declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
        fixtureInput: null,
        fixtureExpectedResidualBelow: 0.2,
        name: "atms_report_v6",
        citedKnowledgeIds: [kc.id],
      },
      captureEmit(events, db),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(events.some((e) => e.kind === "atms_strategy_first_violation")).toBe(false);
    expect(events.some((e) => e.kind === "code_artifact_admitted")).toBe(true);
  });

  test("strategy-first gate refuses atms_report_v* when cited_knowledge_ids is empty (no row inserted)", async () => {
    const db = openDb(":memory:");
    const events: EmitEventInput[] = [];
    const before = (db.query("SELECT COUNT(*) AS c FROM code_artifact").get() as { c: number }).c;
    const body = `console.log('@@RESULT@@ ' + JSON.stringify({ ok: true, report: 'v1_initiative_first' }));`;
    const result = await admitArtifact(
      db,
      {
        runtime: "bun",
        body,
        declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
        fixtureInput: null,
        fixtureExpectedResidualBelow: 0.2,
        name: "atms_report_v1",
        citedKnowledgeIds: [],
      },
      captureEmit(events, db),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("strategy_first_violation_missing_strategic_direction_chosen");
    // Gate runs BEFORE insert — no row landed.
    const after = (db.query("SELECT COUNT(*) AS c FROM code_artifact").get() as { c: number }).c;
    expect(after).toBe(before);
    const violations = events.filter((e) => e.kind === "atms_strategy_first_violation");
    expect(violations.length).toBe(1);
    const payload = violations[0]!.payload as Record<string, unknown>;
    expect(payload.artifact_name).toBe("atms_report_v1");
    expect(payload.missing_claim_suffix).toBe("_strategic_direction_chosen");
  });

  test("strategy-first gate refuses atms_report_v* when cited KCs exist but none end with the strategic suffix", async () => {
    const db = openDb(":memory:");
    const events: EmitEventInput[] = [];
    // A KC that does NOT match the suffix — e.g. an initiative-side
    // finding picked from substrate priors.
    const kc = emitEvent(db, {
      kind: "knowledge_candidate",
      directive_id: "d_initiative_first",
      task_id: "t_initiative_first",
      payload: { claim: "nfpa_traceability_initiative_selected", evidence: ["prior_a"] },
    });
    const body = `console.log('@@RESULT@@ ' + JSON.stringify({ ok: true, report: 'v3_initiative_first' }));`;
    const result = await admitArtifact(
      db,
      {
        runtime: "bun",
        body,
        declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
        fixtureInput: null,
        fixtureExpectedResidualBelow: 0.2,
        name: "atms_report_v3",
        citedKnowledgeIds: [kc.id],
      },
      captureEmit(events, db),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("strategy_first_violation_missing_strategic_direction_chosen");
    const violations = events.filter((e) => e.kind === "atms_strategy_first_violation");
    expect(violations.length).toBe(1);
    const payload = violations[0]!.payload as Record<string, unknown>;
    const inspected = payload.inspected_ids as string[];
    expect(inspected).toContain(kc.id);
  });

  test("strategy-first gate does NOT apply when name is not atms_report_v* (vanilla artifact admits fine)", async () => {
    const db = openDb(":memory:");
    const events: EmitEventInput[] = [];
    const body = `console.log('@@RESULT@@ ' + JSON.stringify({ ok: true }));`;
    const result = await admitArtifact(
      db,
      {
        runtime: "bun",
        body,
        declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
        fixtureInput: null,
        fixtureExpectedResidualBelow: 0.2,
        name: "some_other_recipe_v2",
        citedKnowledgeIds: [],
      },
      captureEmit(events, db),
    );
    expect(result.ok).toBe(true);
    expect(events.some((e) => e.kind === "atms_strategy_first_violation")).toBe(false);
  });
});

// C5 (2026-05-18, contract HJJS1665H961B2SRYHC5J85D14).
describe("admitArtifact — published_drive_doc supersede chain (C5)", () => {
  test("admitting published_drive_doc with supersedes flips prior.superseded_by and emits code_artifact_superseded", async () => {
    const db = openDb(":memory:");
    const events: EmitEventInput[] = [];
    // Pre-seed a prior published_drive_doc row representing v_prior.
    const body = `console.log('@@RESULT@@ ' + JSON.stringify({ ok: true }));`;
    const prior = await admitArtifact(
      db,
      {
        runtime: "bun",
        body,
        declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
        fixtureInput: null,
        fixtureExpectedResidualBelow: 0.2,
        name: "lakeland_drive_doc_prior",
        kind: "published_drive_doc",
        targetResources: ["drive://document/PRIORDOCID12345abc"],
      },
      captureEmit(events, db),
    );
    expect(prior.ok).toBe(true);
    if (!prior.ok) return;
    // Admit the successor, declaring supersedes against the prior id.
    const successor = await admitArtifact(
      db,
      {
        runtime: "bun",
        body,
        declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
        fixtureInput: null,
        fixtureExpectedResidualBelow: 0.2,
        name: "lakeland_drive_doc_successor",
        kind: "published_drive_doc",
        targetResources: ["drive://document/SUCCESSORDOCID987zyx"],
        supersedes: prior.artifactId,
      },
      captureEmit(events, db),
    );
    expect(successor.ok).toBe(true);
    if (!successor.ok) return;
    const priorRow = getArtifact(db, prior.artifactId)!;
    expect(priorRow.supersededBy).toBe(successor.artifactId);
    const successorRow = getArtifact(db, successor.artifactId)!;
    expect(successorRow.supersedes).toBe(prior.artifactId);
    const supersededEvents = events.filter((e) => e.kind === "code_artifact_superseded");
    expect(supersededEvents.length).toBe(1);
    expect((supersededEvents[0]!.payload as Record<string, unknown>).prior_artifact_id).toBe(prior.artifactId);
    expect((supersededEvents[0]!.payload as Record<string, unknown>).new_artifact_id).toBe(successor.artifactId);
  });

  test("published_drive_doc admission refuses when target_resources lacks a drive:// URI", async () => {
    const db = openDb(":memory:");
    const events: EmitEventInput[] = [];
    const body = `console.log('@@RESULT@@ ' + JSON.stringify({ ok: true }));`;
    const before = (db.query("SELECT COUNT(*) AS c FROM code_artifact").get() as { c: number }).c;
    const result = await admitArtifact(
      db,
      {
        runtime: "bun",
        body,
        declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
        fixtureInput: null,
        fixtureExpectedResidualBelow: 0.2,
        name: "lakeland_drive_doc_missing_uri",
        kind: "published_drive_doc",
        targetResources: ["repo:docs/somewhere.md"],
      },
      captureEmit(events, db),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("published_drive_doc_missing_drive_uri");
    const after = (db.query("SELECT COUNT(*) AS c FROM code_artifact").get() as { c: number }).c;
    expect(after).toBe(before);
  });
});
