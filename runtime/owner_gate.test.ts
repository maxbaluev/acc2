import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import type { SandboxDecl } from "../substrate/types";
import { emitEvent } from "./events";
import { newId } from "./ids";
import { ownerGateDecision, verifyOwnerConsent, OWNER_GATED_PATH_PATTERNS } from "./owner_gate";
import { admitArtifact } from "./artifact_admission";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const baseBunSandbox = (fsWrite: string[]): SandboxDecl => ({
  runtime: "bun",
  fs_read: ["**/*"],
  fs_write: fsWrite,
  net_allow: [],
  proc_allow: [],
  substrate_access: "none",
  cpu_ms: 1000,
  wall_ms: 1000,
  memory_mb: 64,
});

describe("ownerGateDecision — structural-only (no path-pattern enumeration)", () => {
  // The 94N61BVVV9 convergence removed the static path
  // enumeration. The gate is structural: well-formed
  // diff + verifier residual + clean trajectory + owner_profile
  // .things_to_never_do at apply time. ownerGateDecision now always
  // returns no-consent-required from sandbox alone, regardless of the
  // declared fs_write globs. Dynamic owner-stated boundaries enforce
  // policy at apply time, not via static path matching here.

  test("empty fs_write requires no consent", () => {
    const dec = ownerGateDecision(baseBunSandbox([]));
    expect(dec.requires_consent).toBe(false);
    expect(dec.matched_patterns).toEqual([]);
  });

  test("benign tmp globs require no consent", () => {
    const dec = ownerGateDecision(baseBunSandbox(["/tmp/**", "out/*.txt"]));
    expect(dec.requires_consent).toBe(false);
  });

  test("formerly-protected literal paths NO LONGER trigger the gate", () => {
    for (const probe of [
      "CLAUDE.md",
      "system/acc2/CLAUDE.md",
      "docs/Architecture.md",
      ".claude/rules/orchestrator-runtime.md",
      "docs/operator-install.md",
      "docs/ops-guide.md",
    ]) {
      const dec = ownerGateDecision(baseBunSandbox([probe]));
      expect(dec.requires_consent).toBe(false);
      expect(dec.matched_patterns).toEqual([]);
    }
  });

  test("blanket wildcards do NOT trigger gate (cwd jail handles them)", () => {
    expect(ownerGateDecision(baseBunSandbox(["**"])).requires_consent).toBe(false);
    expect(ownerGateDecision(baseBunSandbox(["**/*"])).requires_consent).toBe(false);
  });

  test("camofox-browser has no fs_write — always exempt", () => {
    const dec = ownerGateDecision({
      runtime: "camofox-browser",
      browser_allow_domains: ["example.com"],
      browser_profile_root: "/tmp/cf",
      wall_ms: 1000,
      memory_mb: 64,
    });
    expect(dec.requires_consent).toBe(false);
  });

  test("OWNER_GATED_PATH_PATTERNS is empty by design (structural gate, no enumeration)", () => {
    expect(OWNER_GATED_PATH_PATTERNS.length).toBe(0);
  });
});

describe("verifyOwnerConsent — event lookup", () => {
  test("blank consent id is rejected", () => {
    const db = openDb(":memory:");
    expect(verifyOwnerConsent(db, "")).toEqual({ ok: false, reason: "consent_event_id_blank" });
    expect(verifyOwnerConsent(db, "   ")).toEqual({ ok: false, reason: "consent_event_id_blank" });
  });

  test("unknown consent id is rejected", () => {
    const db = openDb(":memory:");
    expect(verifyOwnerConsent(db, "no_such_event")).toEqual({ ok: false, reason: "consent_event_id_not_found" });
  });

  test("wrong-kind event is rejected", () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const event = emitEvent(db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      payload: { directive_text: "x" },
    });
    const verdict = verifyOwnerConsent(db, event.id);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("consent_event_kind_mismatch");
  });

  test("valid owner_decision_recorded is accepted", () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const event = emitEvent(db, {
      kind: "owner_decision_recorded",
      substrate_origin: "owner",
      directive_id: directiveId,
      payload: { decision: "approve_contract_change" },
    });
    const verdict = verifyOwnerConsent(db, event.id);
    expect(verdict).toEqual({ ok: true, directive_id: directiveId });
  });

  test("directive scope mismatch is rejected", () => {
    const db = openDb(":memory:");
    const consentDirective = newId();
    const otherDirective = newId();
    const event = emitEvent(db, {
      kind: "owner_decision_recorded",
      substrate_origin: "owner",
      directive_id: consentDirective,
      payload: { decision: "approve" },
    });
    const verdict = verifyOwnerConsent(db, event.id, otherDirective);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("consent_directive_mismatch");
  });
});

describe("admitArtifact integration — owner-gated paths (structural-only)", () => {
  test("admission of a formerly-gated literal path NO LONGER requires consent (structural gate, no enumeration)", async () => {
    const db = openDb(":memory:");
    const events: Array<{ kind: string; payload: unknown }> = [];
    const result = await admitArtifact(
      db,
      {
        runtime: "bun",
        body: "process.stdout.write('@@RESULT@@ {\"residual\":0}');",
        declaredSandbox: baseBunSandbox(["CLAUDE.md"]),
        fixtureInput: null,
        fixtureExpectedResidualBelow: 0.2,
      },
      (e) => events.push({ kind: e.kind, payload: e.payload }),
    );
    expect(result.ok).toBe(true);
    const ownerReject = events.find(
      (e) => e.kind === "act_artifact_admission_rejected" &&
        (e.payload as Record<string, unknown>).reason === "owner_consent_missing",
    );
    expect(ownerReject).toBeUndefined();
  });

  test("admission of a gated-write artifact WITH a valid consent event passes the gate", async () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const consent = emitEvent(db, {
      kind: "owner_decision_recorded",
      substrate_origin: "owner",
      directive_id: directiveId,
      payload: { decision: "approve_contract_change" },
    });
    const events: Array<{ kind: string; payload: unknown }> = [];
    const result = await admitArtifact(
      db,
      {
        runtime: "bun",
        body: "process.stdout.write('@@RESULT@@ {\"residual\":0}');",
        declaredSandbox: baseBunSandbox(["CLAUDE.md"]),
        fixtureInput: null,
        fixtureExpectedResidualBelow: 0.2,
        governance: {
          directiveId,
          ownerConsentEventId: consent.id,
        },
      },
      (e) => events.push({ kind: e.kind, payload: e.payload }),
    );
    // Admission may still fail on fixture residual etc., but it MUST clear the
    // owner-gate stage — verified by the absence of an owner_consent_missing
    // rejection event.
    const ownerReject = events.find(
      (e) => e.kind === "act_artifact_admission_rejected" &&
        (e.payload as Record<string, unknown>).reason === "owner_consent_missing",
    );
    expect(ownerReject).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  test("admission of a benign artifact (no gated globs) needs no consent", async () => {
    const db = openDb(":memory:");
    const events: Array<{ kind: string; payload: unknown }> = [];
    const result = await admitArtifact(
      db,
      {
        runtime: "bun",
        body: "process.stdout.write('@@RESULT@@ {\"residual\":0}');",
        declaredSandbox: baseBunSandbox(["/tmp/scratch/**"]),
        fixtureInput: null,
        fixtureExpectedResidualBelow: 0.2,
      },
      (e) => events.push({ kind: e.kind, payload: e.payload }),
    );
    expect(result.ok).toBe(true);
  });
});
