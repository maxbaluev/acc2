// acc2 code-artifact admission hardening tests (RUNTIME_AD, directive
// 3XETJCYT). Proves the admission validators ACCEPT well-formed code and
// REJECT malformed code for each of the three code runtimes, that the gate
// fires ONLY on code runtimes (non-code artifacts unaffected), and that it
// composes with the wave-1 capability-gap author loop (a malformed authored
// replacement is caught fail-closed at admission). Driven by the canonical
// admission fixtures in tests/fixtures/code_artifact_admission.ts.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { admitArtifact } from "../runtime/artifact_admission";
import { emitEvent, type EmitEventInput } from "../runtime/events";
import { getArtifact } from "../runtime/artifact_store";
import {
  isCodeRuntime,
  validateCodeArtifactAdmission,
} from "../runtime/code_artifact_validation";
import {
  ALL_INVALID,
  ALL_VALID,
  BUN_VALID,
  BUN_INVALID,
  UV_INVALID,
  CAMOFOX_INVALID,
  BUN_LEGACY_NO_METADATA,
} from "./fixtures/code_artifact_admission";
import type { Database } from "bun:sqlite";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const captureEmit = (sink: EmitEventInput[], db: Database) => (event: EmitEventInput) => {
  sink.push(event);
  emitEvent(db, event);
};

// ── Pure validator: fixtures accept / reject with the specific reason ──

describe("validateCodeArtifactAdmission — fixtures", () => {
  for (const fx of ALL_VALID) {
    test(`ACCEPTS — ${fx.label}`, () => {
      const r = validateCodeArtifactAdmission(fx.input);
      expect(r.ok).toBe(true);
    });
  }

  for (const fx of ALL_INVALID) {
    test(`REJECTS (${fx.expectReason}) — ${fx.label}`, () => {
      const r = validateCodeArtifactAdmission(fx.input);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe(fx.expectReason);
      expect(r.detail.length).toBeGreaterThan(0);
    });
  }

  test("each code runtime has at least one valid + invalid fixture", () => {
    expect(BUN_INVALID.length).toBeGreaterThan(0);
    expect(UV_INVALID.length).toBeGreaterThan(0);
    expect(CAMOFOX_INVALID.length).toBeGreaterThan(0);
  });
});

// ── isCodeRuntime gates only the three code runtimes ──────────────────

describe("isCodeRuntime — gate boundary", () => {
  test("the three code runtimes are gated", () => {
    expect(isCodeRuntime("bun")).toBe(true);
    expect(isCodeRuntime("uv")).toBe(true);
    expect(isCodeRuntime("camofox-browser")).toBe(true);
  });
  test("non-code runtimes + null are NOT gated", () => {
    expect(isCodeRuntime(null)).toBe(false);
    expect(isCodeRuntime(undefined)).toBe(false);
    expect(isCodeRuntime("telegram")).toBe(false);
    expect(isCodeRuntime("some_registry_runner")).toBe(false);
  });
});

// ── Full admitArtifact path: malformed authored code rejected ─────────

describe("admitArtifact — code-artifact hardening (fail-closed)", () => {
  // One representative malformed fixture per runtime, exercised through the
  // real admission path. The gate runs BEFORE row insert + fixture run, so
  // no row is left behind and the typed reason surfaces.
  const reps = [
    BUN_INVALID.find((f) => f.expectReason === "code_artifact_interface_incomplete")!,
    UV_INVALID.find((f) => f.expectReason === "code_artifact_schema_invalid")!,
    CAMOFOX_INVALID.find((f) => f.expectReason === "code_artifact_body_invalid")!,
  ];
  for (const fx of reps) {
    test(`REJECTS through admitArtifact — ${fx.label}`, async () => {
      const db = openDb(":memory:");
      const events: EmitEventInput[] = [];
      const before = (db.query("SELECT COUNT(*) AS c FROM act_artifact").get() as { c: number }).c;
      const result = await admitArtifact(
        db,
        {
          runtime: fx.input.runtime,
          body: fx.input.body,
          declaredSandbox: fx.input.declaredSandbox,
          fixtureInput: null,
          fixtureExpectedResidualBelow: 0.2,
          interfaceMetadata: fx.input.interfaceMetadata,
          verifierArtifactId: fx.input.verifierArtifactId,
          name: "malformed_authored_replacement",
        },
        captureEmit(events, db),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe(fx.expectReason);
      // No row inserted — the gate runs BEFORE insert.
      const after = (db.query("SELECT COUNT(*) AS c FROM act_artifact").get() as { c: number }).c;
      expect(after).toBe(before);
      const rejected = events.filter((e) => e.kind === "act_artifact_admission_rejected");
      expect(rejected.length).toBeGreaterThan(0);
      expect((rejected[0]!.payload as Record<string, unknown>).reason).toBe(fx.expectReason);
    });
  }

  test("valid bun authored artifact (complete interface) ADMITS through admitArtifact", async () => {
    const db = openDb(":memory:");
    const events: EmitEventInput[] = [];
    const result = await admitArtifact(
      db,
      {
        runtime: "bun",
        body: BUN_VALID.input.body,
        declaredSandbox: BUN_VALID.input.declaredSandbox,
        fixtureInput: { x: 41 },
        fixtureExpectedResidualBelow: 0.2,
        interfaceMetadata: BUN_VALID.input.interfaceMetadata,
        verifierArtifactId: BUN_VALID.input.verifierArtifactId,
        name: "well_formed_authored_replacement",
      },
      captureEmit(events, db),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = getArtifact(db, result.artifactId);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("admitted");
  });

  // Backward-compat: legacy executable tool (no interface_metadata) admits.
  test("legacy executable tool (no interface_metadata) still ADMITS", async () => {
    const db = openDb(":memory:");
    const events: EmitEventInput[] = [];
    const result = await admitArtifact(
      db,
      {
        runtime: "bun",
        body: BUN_LEGACY_NO_METADATA.input.body,
        declaredSandbox: BUN_LEGACY_NO_METADATA.input.declaredSandbox,
        fixtureInput: { ping: "pong" },
        fixtureExpectedResidualBelow: 0.2,
        // No interfaceMetadata, no verifier — legacy path.
        name: "t02_legacy_diagnostic_runner",
      },
      captureEmit(events, db),
    );
    expect(result.ok).toBe(true);
    // The interface-completeness rejection must NOT fire.
    const incomplete = events.filter(
      (e) => e.kind === "act_artifact_admission_rejected" &&
        (e.payload as { reason?: string })?.reason === "code_artifact_interface_incomplete",
    );
    expect(incomplete.length).toBe(0);
  });

  // Gate fires ONLY on code runtimes — a data-class (runtime=null) row with
  // NO schemas/verifier admits unaffected (the code gate never runs).
  test("non-code data-class artifact is UNAFFECTED by the code gate", async () => {
    const db = openDb(":memory:");
    const events: EmitEventInput[] = [];
    const result = await admitArtifact(
      db,
      {
        runtime: null,
        body: JSON.stringify({ messages: [{ id: 1, text: "corpus" }] }),
        declaredSandbox: null,
        fixtureInput: null,
        fixtureExpectedResidualBelow: 0,
        kind: "telegram_chat_dump",
        name: "tony-corpus",
        intent: "private corpus admission",
        summary: "Telegram corpus dump",
        // No inputs_schema / outputs_schema / verifier — must still admit.
      },
      captureEmit(events, db),
    );
    expect(result.ok).toBe(true);
    const codeRejections = events.filter(
      (e) => e.kind === "act_artifact_admission_rejected" &&
        typeof (e.payload as { reason?: string })?.reason === "string" &&
        (e.payload as { reason: string }).reason.startsWith("code_artifact_"),
    );
    expect(codeRejections.length).toBe(0);
  });
});
