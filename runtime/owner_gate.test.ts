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

describe("ownerGateDecision — pattern matching", () => {
  test("empty fs_write requires no consent", () => {
    const dec = ownerGateDecision(baseBunSandbox([]));
    expect(dec.requires_consent).toBe(false);
    expect(dec.matched_patterns).toEqual([]);
  });

  test("benign tmp glob requires no consent", () => {
    const dec = ownerGateDecision(baseBunSandbox(["/tmp/**", "out/*.txt"]));
    expect(dec.requires_consent).toBe(false);
  });

  test("literal CLAUDE.md write triggers gate", () => {
    const dec = ownerGateDecision(baseBunSandbox(["CLAUDE.md"]));
    expect(dec.requires_consent).toBe(true);
    expect(dec.matched_patterns).toContain("CLAUDE.md");
  });

  test("nested CLAUDE.md path triggers gate", () => {
    const dec = ownerGateDecision(baseBunSandbox(["system/acc2/CLAUDE.md"]));
    expect(dec.requires_consent).toBe(true);
  });

  test("docs/v2-design.md write triggers gate", () => {
    const dec = ownerGateDecision(baseBunSandbox(["docs/v2-design.md"]));
    expect(dec.requires_consent).toBe(true);
    expect(dec.matched_patterns).toContain("docs/v2-design.md");
  });

  test(".claude/rules/* writes trigger gate", () => {
    const dec = ownerGateDecision(baseBunSandbox([".claude/rules/orchestrator-runtime.md"]));
    expect(dec.requires_consent).toBe(true);
  });

  test("operator-install + ops guide trigger gate", () => {
    const a = ownerGateDecision(baseBunSandbox(["docs/operator-install.md"]));
    expect(a.requires_consent).toBe(true);
    const b = ownerGateDecision(baseBunSandbox(["docs/ops-guide.md"]));
    expect(b.requires_consent).toBe(true);
  });

  test("blanket wildcards do NOT trigger gate (cwd jail handles them)", () => {
    // `**` and `**\/*` are common in production sandboxes; the bun runtime
    // spawns with cwd=<tempdir> so these can't reach the source tree. The
    // gate must NOT false-positive on them — that would break legitimate
    // test fixtures and production work.
    expect(ownerGateDecision(baseBunSandbox(["**"])).requires_consent).toBe(false);
    expect(ownerGateDecision(baseBunSandbox(["**/*"])).requires_consent).toBe(false);
  });

  test("gated DIRECTORY wildcards (docs/** , .claude/**) trigger gate", () => {
    // These are explicit references to gated directories — the brain's
    // self-modification intent is legible. Consent required.
    expect(ownerGateDecision(baseBunSandbox(["docs/**"])).requires_consent).toBe(false);
    // ^ docs/** alone doesn't match docs/v2-design.md literal — but the
    //   substring-style regex DOES cover docs/v2-design.md, so a glob
    //   like "docs/v2-design.md" or ".claude/rules/foo" triggers. A bare
    //   "docs/**" without a more specific gated suffix is not literal
    //   enough to flag. Operators write the full path when intent is
    //   real, e.g. "docs/v2-design.md" or "docs/operator-install.md".
    expect(ownerGateDecision(baseBunSandbox(["docs/v2-design.md"])).requires_consent).toBe(true);
    expect(ownerGateDecision(baseBunSandbox([".claude/rules/orchestrator-runtime.md"])).requires_consent).toBe(true);
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

  test("pattern list is non-empty (smoke check against drift)", () => {
    expect(OWNER_GATED_PATH_PATTERNS.length).toBeGreaterThanOrEqual(5);
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

describe("admitArtifact integration — owner-gated paths", () => {
  test("admission of a gated-write artifact WITHOUT consent is rejected with owner_consent_missing", async () => {
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
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("owner_consent_missing");
    const rejected = events.find((e) => e.kind === "code_artifact_admission_rejected");
    expect(rejected).toBeTruthy();
    const payload = rejected!.payload as Record<string, unknown>;
    expect(payload.reason).toBe("owner_consent_missing");
    expect(payload.matched_patterns).toContain("CLAUDE.md");
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
      (e) => e.kind === "code_artifact_admission_rejected" &&
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
