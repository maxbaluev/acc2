// acc2 artifact interface-metadata tests — UNIVERSAL_ (2026-05-24,
// directive 3XETJCYT, kc BD86CJ6HQS).
//
// First-class, domain-NEUTRAL interface metadata so the substrate (and the
// brain) can UNDERSTAND what an artifact does, WHEN to use it, and HOW to
// call it — for ANY human goal, not just code. These tests pin:
//   1. admission accepts + persists + returns the new metadata (code row).
//   2. missing-metadata artifacts still admit (backward-compat), with
//      interfaceMetadata === null.
//   3. the metadata is queryable via the registry view (the selector +
//      brain retrieval surface).
//   4. a domain-DIVERSE example (a non-code Telegram action carried as a
//      data-class row) validates + persists the SAME interface shape as a
//      code artifact — proving domain-neutrality.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { admitArtifact } from "./artifact_admission";
import { emitEvent, type EmitEventInput } from "./events";
import { getArtifact } from "./artifact_store";
import type { ArtifactInterfaceMetadata } from "../substrate/types";
import type { Database } from "bun:sqlite";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const captureEmit = (sink: EmitEventInput[], db: Database) => (event: EmitEventInput) => {
  sink.push(event);
  emitEvent(db, event);
};

// A CODE artifact's interface descriptor. Note: nothing here is
// code-specific — purpose/preconditions/effects read like prose; the same
// fields describe a non-code artifact below.
const CODE_INTERFACE: ArtifactInterfaceMetadata = {
  purpose: "apply a repo change and run its tests, returning a residual",
  goal_shapes: ["a1b2c3d4e5f60718"],
  usage_examples: [
    {
      description: "rename a symbol across two files",
      input: { from: "oldName", to: "newName", files: ["a.ts", "b.ts"] },
      output: { applied: true, tests_passed: true, residual: 0.05 },
    },
  ],
  preconditions: ["target files exist on the branch", "tests are runnable"],
  effects: ["files in target_files are modified", "a commit is produced"],
  cost_profile: { latency_ms: 4000, irreversible: false },
  reliability_profile: { known_flakes: ["network test timeout"], confidence: 0.8 },
  inputs_schema: { from: "string", to: "string", files: "string[]" },
  outputs_schema: { applied: "boolean", residual: "number in [0,1]" },
};

// A NON-CODE artifact's interface descriptor — a Telegram outreach action.
// Same SHAPE, zero code-specific fields. This is the domain-neutrality
// proof: purpose/preconditions/effects/usage_examples describe an outreach
// action just as naturally as a script.
const TELEGRAM_INTERFACE: ArtifactInterfaceMetadata = {
  purpose: "send a one-off Telegram message to a known contact",
  goal_shapes: ["f0e1d2c3b4a59687"],
  usage_examples: [
    {
      description: "remind a contact about a meeting",
      input: { chat_id: 12345, text: "Reminder: our call is at 3pm." },
      output: { delivered: true, message_id: 987, residual: 0.0 },
    },
  ],
  preconditions: ["telegram account authorized", "owner consent for outreach to this contact"],
  effects: ["a message is delivered to the contact's chat"],
  cost_profile: { latency_ms: 800, money: 0, irreversible: true },
  reliability_profile: { known_flakes: ["rate limit on burst sends"], confidence: 0.9 },
  inputs_schema: { chat_id: "number", text: "string" },
  outputs_schema: { delivered: "boolean", message_id: "number" },
};

describe("artifact interface metadata — code artifact (executable)", () => {
  test("admission accepts + persists + returns interface_metadata", async () => {
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
        kind: "code_change_runner",
        name: "apply_and_test",
        interfaceMetadata: CODE_INTERFACE,
        // RUNTIME_AD (2026-05-24, directive 3XETJCYT): a code artifact that
        // declares interface_metadata must also declare HOW it is verified.
        verifierArtifactId: "verifier_apply_and_test",
      },
      captureEmit(events, db),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = getArtifact(db, result.artifactId);
    expect(row).not.toBeNull();
    // Round-trips through the column → mapRow.
    expect(row!.interfaceMetadata).toEqual(CODE_INTERFACE);
    expect(row!.interfaceMetadata!.purpose).toContain("repo change");
    expect(row!.interfaceMetadata!.usage_examples!.length).toBe(1);
    expect(row!.interfaceMetadata!.preconditions).toContain("tests are runnable");
  });
});

describe("artifact interface metadata — backward compatibility", () => {
  test("missing-metadata artifact still admits; interfaceMetadata is null", async () => {
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
        // interfaceMetadata intentionally omitted.
      },
      captureEmit(events, db),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = getArtifact(db, result.artifactId);
    expect(row).not.toBeNull();
    expect(row!.interfaceMetadata).toBeNull();
    // The artifact is fully usable — admission did not gate on the metadata.
    expect(row!.status).toBe("admitted");
  });
});

describe("artifact interface metadata — queryable via registry view", () => {
  test("registry view exposes interface_metadata for an admitted artifact", async () => {
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
        kind: "code_change_runner",
        name: "apply_and_test_view",
        interfaceMetadata: CODE_INTERFACE,
        // RUNTIME_AD (2026-05-24, directive 3XETJCYT): verifier required
        // when a code artifact declares interface_metadata.
        verifierArtifactId: "verifier_apply_and_test_view",
      },
      captureEmit(events, db),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The selector (ARTIFACT_S) + brain read the registry view. Confirm the
    // column flows through it and round-trips back to the descriptor.
    const viewRow = db
      .query("SELECT id, interface_metadata FROM act_artifact_registry_view WHERE id = ?")
      .get(result.artifactId) as { id: string; interface_metadata: string | null } | null;
    expect(viewRow).not.toBeNull();
    expect(viewRow!.interface_metadata).not.toBeNull();
    const parsed = JSON.parse(viewRow!.interface_metadata as string) as ArtifactInterfaceMetadata;
    expect(parsed).toEqual(CODE_INTERFACE);
    expect(parsed.purpose).toContain("residual");
  });
});

describe("artifact interface metadata — domain neutrality (non-code)", () => {
  test("a non-code Telegram action (data-class row) carries the SAME interface shape as a code artifact", async () => {
    const db = openDb(":memory:");
    const events: EmitEventInput[] = [];
    // A non-code artifact admitted as a data-class row (runtime=null). It
    // describes a Telegram outreach handle — no sandbox, no fixture, no
    // code body semantics — yet carries the identical interface descriptor.
    const result = await admitArtifact(
      db,
      {
        runtime: null,
        body: JSON.stringify({ action: "telegram.send_message", binding: "mcp__telegram__send_message" }),
        declaredSandbox: null,
        fixtureInput: null,
        fixtureExpectedResidualBelow: 0.2,
        kind: "telegram_action_v1",
        name: "telegram_send_message",
        summary: "Send a Telegram message to a contact",
        interfaceMetadata: TELEGRAM_INTERFACE,
      },
      captureEmit(events, db),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = getArtifact(db, result.artifactId);
    expect(row).not.toBeNull();
    expect(row!.runtime).toBeNull();
    // The metadata persisted + round-tripped identically to the code case.
    expect(row!.interfaceMetadata).toEqual(TELEGRAM_INTERFACE);
    // Domain-neutral proof: the SAME field names carry outreach semantics.
    expect(row!.interfaceMetadata!.purpose).toContain("Telegram");
    expect(row!.interfaceMetadata!.effects).toContain("a message is delivered to the contact's chat");
    expect(row!.interfaceMetadata!.preconditions).toContain("telegram account authorized");
    // And it is queryable via the registry view exactly like the code row.
    const viewRow = db
      .query("SELECT interface_metadata FROM act_artifact_registry_view WHERE id = ?")
      .get(result.artifactId) as { interface_metadata: string | null } | null;
    expect(viewRow).not.toBeNull();
    const parsed = JSON.parse(viewRow!.interface_metadata as string) as ArtifactInterfaceMetadata;
    expect(parsed.usage_examples![0]!.input).toEqual({ chat_id: 12345, text: "Reminder: our call is at 3pm." });
  });
});
