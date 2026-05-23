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
    // Emitted exactly one act_artifact_admitted event at the end.
    const admitted = events.filter((e) => e.kind === "act_artifact_admitted");
    expect(admitted.length).toBe(1);
  });

  test("executable tool (>200-char body, no citations) is EXEMPT from artifact_citation_underrooted", async () => {
    // Regression for the 2026-05-21 T0.2 blocker: the brain admits
    // executable tooling (diagnostic/test/patch runners) with substantial
    // bodies and no knowledge citations. A tool is rooted by its sandbox +
    // verifier, not knowledge — it must NOT be refused as underrooted.
    const db = openDb(":memory:");
    const events: EmitEventInput[] = [];
    const body = [
      "// t02_anchor_diagnostic — long executable tool body, no citations.",
      "const inputs = JSON.parse(process.env.ACC2_INPUTS ?? 'null');",
      "// padding to exceed the 200-char substantive threshold ".repeat(4),
      "console.log('@@RESULT@@ ' + JSON.stringify({ ok: true, echoed: inputs }));",
    ].join("\n");
    expect(body.length).toBeGreaterThan(200);
    const result = await admitArtifact(
      db,
      {
        runtime: "bun",
        body,
        declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
        fixtureInput: { ping: "pong" },
        fixtureExpectedResidualBelow: 0.2,
        kind: "diagnostic_runner",
        name: "t02_anchor_diagnostic",
        // citedKnowledgeIds intentionally omitted (a tool cites nothing).
      },
      captureEmit(events, db),
    );
    expect(result.ok).toBe(true);
    // The underrooted refusal must NOT fire for an executable artifact.
    const underrooted = events.filter(
      (e) => e.kind === "lane_routing_refused" &&
        (e.payload as { reason?: string })?.reason === "artifact_citation_underrooted",
    );
    expect(underrooted.length).toBe(0);
  });

  test("data class (runtime=null): admits a raw corpus dump without fixture execution", async () => {
    const db = openDb(":memory:");
    const events: EmitEventInput[] = [];
    const body = JSON.stringify({
      chat_id: 571292618,
      messages: [{ id: 1, text: "owner-private corpus payload" }],
    });
    const result = await admitArtifact(
      db,
      {
        runtime: null,
        body,
        declaredSandbox: null,
        fixtureInput: null,
        fixtureExpectedResidualBelow: 0,
        kind: "telegram_chat_dump",
        name: "tony-direct-test",
        intent: "private corpus admission",
        summary: "Telegram corpus dump (1500 messages, owner-private)",
      },
      captureEmit(events, db),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = getArtifact(db, result.artifactId);
    expect(row).not.toBeNull();
    expect(row!.runtime).toBeNull();
    expect(row!.status).toBe("admitted");
    expect(row!.body).toBe(body);
    const admitted = events.filter((e) => e.kind === "act_artifact_admitted");
    expect(admitted.length).toBe(1);
    // No fixture-execution side effects.
    expect(events.filter((e) => e.kind === "artifact_invoked").length).toBe(0);
    expect(events.filter((e) => e.kind === "artifact_observed").length).toBe(0);
    // Admission mode flag visible on the emit for downstream observers.
    const payload = admitted[0]!.payload as { admission_mode?: string };
    expect(payload.admission_mode).toBe("data_class_nullable");
  });

  test("data class (runtime=null): refuses when summary missing", async () => {
    const db = openDb(":memory:");
    const events: EmitEventInput[] = [];
    const result = await admitArtifact(
      db,
      {
        runtime: null,
        body: "raw bytes",
        declaredSandbox: null,
        fixtureInput: null,
        fixtureExpectedResidualBelow: 0,
        name: "missing-summary-test",
        // intentionally omit summary
      },
      captureEmit(events, db),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("runtime_error");
    expect(result.detail).toContain("summary");
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
    const before = (db.query("SELECT COUNT(*) AS c FROM act_artifact").get() as { c: number }).c;
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
    const after = (db.query("SELECT COUNT(*) AS c FROM act_artifact").get() as { c: number }).c;
    expect(after).toBe(before);
    expect(events.some((e) => e.kind === "act_artifact_admission_rejected")).toBe(true);
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
      const c = (db.query("SELECT COUNT(*) AS c FROM act_artifact").get() as { c: number }).c;
      expect(c).toBe(0);
    } else {
      // Admission succeeded — the row is present at admit priors.
      const row = (db.query("SELECT runtime FROM act_artifact WHERE id = ?").get(result.artifactId) as { runtime: string });
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
    expect(events.some((e) => e.kind === "act_artifact_admission_rejected")).toBe(true);
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
    const before = (db.query("SELECT COUNT(*) AS c FROM act_artifact").get() as { c: number }).c;
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
    const after = (db.query("SELECT COUNT(*) AS c FROM act_artifact").get() as { c: number }).c;
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
    expect(events.some((e) => e.kind === "act_artifact_admitted")).toBe(true);
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

  // RESIDUAL-INTEGRITY GATE (2026-05-23): a fixture reporting a NEGATIVE
  // residual is a BROKEN signal, not a pass. Pre-fix the gate was a bare
  // `observedResidual >= threshold` comparison, and `-5 >= 0.2` evaluates
  // to FALSE, so a fixture emitting `{residual: -5}` slipped through and
  // was ADMITTED — faking a pass with a residual that violates the
  // truth-bearing [0,1] contract (CLAUDE.md "Residual in [0,1] ... is the
  // truth-bearing signal"). Only valid-JSON numbers reach this check;
  // NaN/Infinity fail JSON.parse upstream and reject as runtime_error.
  test("rejects when the fixture residual is negative (out of [0,1])", async () => {
    const db = openDb(":memory:");
    const events: EmitEventInput[] = [];
    const body = `console.log('@@RESULT@@ ' + JSON.stringify({ residual: -5 }));`;
    const result = await admitArtifact(
      db,
      {
        runtime: "bun",
        body,
        declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
        fixtureInput: null,
        fixtureExpectedResidualBelow: 0.2,
      },
      (e) => { events.push(e); },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("fixture_residual_too_high");
    // The row must have been rolled back — a broken-residual fixture
    // never leaves an admitted artifact behind.
    const rejected = events.find((e) => e.kind === "act_artifact_admission_rejected");
    expect(rejected).toBeDefined();
    expect((rejected!.payload as Record<string, unknown>).residual_out_of_range).toBe(true);
    expect(events.some((e) => e.kind === "act_artifact_admitted")).toBe(false);
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
    expect(events.some((e) => e.kind === "act_artifact_admitted")).toBe(true);
  });

  test("strategy-first gate refuses atms_report_v* when cited_knowledge_ids is empty (no row inserted)", async () => {
    const db = openDb(":memory:");
    const events: EmitEventInput[] = [];
    const before = (db.query("SELECT COUNT(*) AS c FROM act_artifact").get() as { c: number }).c;
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
    const after = (db.query("SELECT COUNT(*) AS c FROM act_artifact").get() as { c: number }).c;
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

  test("F1: strategy-first gate fires on input.kind atms_report_v* even when name does not match (name-OR-kind)", async () => {
    // Pre-F1 the admission gate only checked input.name; the v9
    // Lakeland candidates set name="lakeland_industries_ai_..."
    // while kind="atms_report_v9", so the name-only check missed them
    // and the gate never fired. The name-OR-kind closure refuses the
    // admission when the kind matches even though the name does not.
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
        kind: "atms_report_v9",
        name: "lakeland_industries_ai_transformation_report_v9",
        citedKnowledgeIds: [],
      },
      captureEmit(events, db),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("strategy_first_violation_missing_strategic_direction_chosen");
    const violations = events.filter((e) => e.kind === "atms_strategy_first_violation");
    expect(violations.length).toBe(1);
    const payload = violations[0]!.payload as Record<string, unknown>;
    expect(payload.artifact_kind).toBe("atms_report_v9");
    expect(payload.artifact_name).toBe("lakeland_industries_ai_transformation_report_v9");
  });
});

// C5 (2026-05-18, contract HJJS1665H961B2SRYHC5J85D14).
describe("admitArtifact — published_drive_doc supersede chain (C5)", () => {
  test("admitting published_drive_doc with supersedes flips prior.superseded_by and emits act_artifact_superseded", async () => {
    const db = openDb(":memory:");
    const events: EmitEventInput[] = [];
    const body = `console.log('@@RESULT@@ ' + JSON.stringify({ ok: true }));`;
    // C2 preview-first prerequisite: every published_drive_doc admission
    // must name a rendered_docx ancestor. Seed the lineage chain
    // (markdown_body → docx_reference_style → rendered_docx) so the
    // supersede-chain test can satisfy the C2 gate.
    const md = await admitArtifact(db, {
      runtime: "bun", body,
      declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
      fixtureInput: null, fixtureExpectedResidualBelow: 0.2,
      name: "md_for_c5_test", kind: "markdown_body",
    }, captureEmit(events, db));
    expect(md.ok).toBe(true); if (!md.ok) return;
    const ref = await admitArtifact(db, {
      runtime: "bun", body,
      declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
      fixtureInput: null, fixtureExpectedResidualBelow: 0.2,
      name: "ref_for_c5_test", kind: "docx_reference_style",
    }, captureEmit(events, db));
    expect(ref.ok).toBe(true); if (!ref.ok) return;
    const rd = await admitArtifact(db, {
      runtime: "bun", body,
      declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
      fixtureInput: null, fixtureExpectedResidualBelow: 0.2,
      name: "rd_for_c5_test", kind: "rendered_docx",
      markdownBodyId: md.artifactId, referenceDocxArtifactId: ref.artifactId,
    }, captureEmit(events, db));
    expect(rd.ok).toBe(true); if (!rd.ok) return;
    // Pre-seed a prior published_drive_doc row representing v_prior.
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
        renderedDocxId: rd.artifactId,
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
        renderedDocxId: rd.artifactId,
      },
      captureEmit(events, db),
    );
    expect(successor.ok).toBe(true);
    if (!successor.ok) return;
    const priorRow = getArtifact(db, prior.artifactId)!;
    expect(priorRow.supersededBy).toBe(successor.artifactId);
    const successorRow = getArtifact(db, successor.artifactId)!;
    expect(successorRow.supersedes).toBe(prior.artifactId);
    const supersededEvents = events.filter((e) => e.kind === "act_artifact_superseded");
    expect(supersededEvents.length).toBe(1);
    expect((supersededEvents[0]!.payload as Record<string, unknown>).prior_artifact_id).toBe(prior.artifactId);
    expect((supersededEvents[0]!.payload as Record<string, unknown>).new_artifact_id).toBe(successor.artifactId);
  });

  // C2 (2026-05-18, contract V32YTK7HKN6MS38KWJY1SKTXAW): render
  // pipeline admission gates — rendered_docx requires markdown_body_id
  // + reference_docx_artifact_id that resolve to admitted artifacts
  // of the correct kinds; published_drive_doc requires renderedDocxId
  // (preview-first rule) and refuses PDF target_resources.
  test("rendered_docx admission refuses when markdown_body_id is missing", async () => {
    const db = openDb(":memory:");
    const events: EmitEventInput[] = [];
    const before = (db.query("SELECT COUNT(*) AS c FROM act_artifact").get() as { c: number }).c;
    const body = `console.log('@@RESULT@@ ' + JSON.stringify({ ok: true }));`;
    const result = await admitArtifact(
      db,
      {
        runtime: "bun",
        body,
        declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
        fixtureInput: null,
        fixtureExpectedResidualBelow: 0.2,
        name: "rendered_docx_orphan",
        kind: "rendered_docx",
        referenceDocxArtifactId: "ghost_ref",
      },
      captureEmit(events, db),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("rendered_docx_invalid_inputs");
    expect(result.detail).toMatch(/rendered_docx_missing_markdown_body_id|rendered_docx_unknown_markdown_body_id|rendered_docx_unknown_reference_docx_id/);
    const after = (db.query("SELECT COUNT(*) AS c FROM act_artifact").get() as { c: number }).c;
    expect(after).toBe(before);
    expect(events.some((e) => e.kind === "rendered_docx_invalid_inputs")).toBe(true);
  });

  test("rendered_docx admission admits when both inputs resolve to correct kinds", async () => {
    const db = openDb(":memory:");
    const events: EmitEventInput[] = [];
    const stubBody = `console.log('@@RESULT@@ ' + JSON.stringify({ ok: true }));`;
    // Seed an admitted markdown_body + docx_reference_style.
    const md = await admitArtifact(db, {
      runtime: "bun",
      body: stubBody,
      declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
      fixtureInput: null,
      fixtureExpectedResidualBelow: 0.2,
      name: "md_for_rendered",
      kind: "markdown_body",
    }, captureEmit(events, db));
    expect(md.ok).toBe(true);
    if (!md.ok) return;
    const ref = await admitArtifact(db, {
      runtime: "bun",
      body: stubBody,
      declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
      fixtureInput: null,
      fixtureExpectedResidualBelow: 0.2,
      name: "ref_for_rendered",
      kind: "docx_reference_style",
    }, captureEmit(events, db));
    expect(ref.ok).toBe(true);
    if (!ref.ok) return;
    const result = await admitArtifact(db, {
      runtime: "bun",
      body: stubBody,
      declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
      fixtureInput: null,
      fixtureExpectedResidualBelow: 0.2,
      name: "rendered_docx_admit",
      kind: "rendered_docx",
      markdownBodyId: md.artifactId,
      referenceDocxArtifactId: ref.artifactId,
    }, captureEmit(events, db));
    expect(result.ok).toBe(true);
  });

  test("published_drive_doc admission refuses without renderedDocxId (preview-first rule)", async () => {
    const db = openDb(":memory:");
    const events: EmitEventInput[] = [];
    const before = (db.query("SELECT COUNT(*) AS c FROM act_artifact").get() as { c: number }).c;
    const body = `console.log('@@RESULT@@ ' + JSON.stringify({ ok: true }));`;
    const result = await admitArtifact(
      db,
      {
        runtime: "bun",
        body,
        declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
        fixtureInput: null,
        fixtureExpectedResidualBelow: 0.2,
        name: "published_no_preview",
        kind: "published_drive_doc",
        targetResources: ["drive://document/SOMEDOCID"],
        // renderedDocxId intentionally omitted.
      },
      captureEmit(events, db),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("published_drive_doc_invalid_inputs");
    expect(result.detail).toContain("published_drive_doc_missing_rendered_docx_id");
    const after = (db.query("SELECT COUNT(*) AS c FROM act_artifact").get() as { c: number }).c;
    expect(after).toBe(before);
    expect(events.some((e) => e.kind === "published_drive_doc_invalid_inputs")).toBe(true);
  });

  test("published_drive_doc admission refuses application/pdf target_resources", async () => {
    const db = openDb(":memory:");
    const events: EmitEventInput[] = [];
    const stubBody = `console.log('@@RESULT@@ ' + JSON.stringify({ ok: true }));`;
    // Seed an admitted rendered_docx so the preview-first check passes.
    // First seed its markdown_body + reference inputs.
    const md = await admitArtifact(db, {
      runtime: "bun", body: stubBody,
      declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
      fixtureInput: null, fixtureExpectedResidualBelow: 0.2,
      name: "md_for_pdf_test", kind: "markdown_body",
    }, captureEmit(events, db));
    expect(md.ok).toBe(true); if (!md.ok) return;
    const ref = await admitArtifact(db, {
      runtime: "bun", body: stubBody,
      declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
      fixtureInput: null, fixtureExpectedResidualBelow: 0.2,
      name: "ref_for_pdf_test", kind: "docx_reference_style",
    }, captureEmit(events, db));
    expect(ref.ok).toBe(true); if (!ref.ok) return;
    const rd = await admitArtifact(db, {
      runtime: "bun", body: stubBody,
      declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
      fixtureInput: null, fixtureExpectedResidualBelow: 0.2,
      name: "rd_for_pdf_test", kind: "rendered_docx",
      markdownBodyId: md.artifactId, referenceDocxArtifactId: ref.artifactId,
    }, captureEmit(events, db));
    expect(rd.ok).toBe(true); if (!rd.ok) return;
    // Now attempt published_drive_doc admission with a PDF target_resource.
    const result = await admitArtifact(db, {
      runtime: "bun", body: stubBody,
      declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
      fixtureInput: null, fixtureExpectedResidualBelow: 0.2,
      name: "published_pdf_attempt", kind: "published_drive_doc",
      targetResources: ["drive://document/OKDOCID", "drive://file/badpdf?mime=application/pdf"],
      renderedDocxId: rd.artifactId,
    }, captureEmit(events, db));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("published_drive_doc_invalid_inputs");
    expect(result.detail).toContain("published_drive_doc_pdf_forbidden_in_alex_path");
  });

  test("published_drive_doc admission refuses when target_resources lacks a drive:// URI", async () => {
    const db = openDb(":memory:");
    const events: EmitEventInput[] = [];
    const body = `console.log('@@RESULT@@ ' + JSON.stringify({ ok: true }));`;
    const before = (db.query("SELECT COUNT(*) AS c FROM act_artifact").get() as { c: number }).c;
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
    const after = (db.query("SELECT COUNT(*) AS c FROM act_artifact").get() as { c: number }).c;
    expect(after).toBe(before);
  });
});
