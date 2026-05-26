// Amendment KN78GX0J — owner-control hard gate tests.
//
// owner_state_belief is calibration only; it can never authorize a
// protected action. The gate refuses on things_to_never_do match and on
// irreversible effects without verified owner consent.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import { evaluateOwnerControlGate } from "./owner_state_transition_verifier";
import type { OwnerProfile } from "../substrate/types";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const recordConsent = (db: ReturnType<typeof openDb>, directiveId: string): string =>
  emitEvent(db, {
    kind: "owner_decision_recorded",
    substrate_origin: "owner",
    directive_id: directiveId,
    payload: { decision: "approved" },
  }).id;

describe("evaluateOwnerControlGate (amendment KN78GX0J)", () => {
  test("high-uncertainty owner_state_belief alone does NOT authorize an irreversible action without consent", () => {
    const db = openDb(":memory:");
    const decision = evaluateOwnerControlGate(db, {
      directive_id: "dir_1",
      action_summary: "send outbound email to client list",
      target_resources: ["smtp:clients"],
      irreversible_effects: [{ kind: "external_send", description: "emails clients" }],
      owner_state_belief: { uncertainty: 0.9, latent_state: { autonomy: "high" } },
      owner_profile: null,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.gate_kind).toBe("hidl_action_required");
    expect(decision.reason).toBe("irreversible_effect_requires_consent");
  });

  test("HIGH-CONFIDENCE (low-uncertainty) belief suggesting autonomy still does NOT authorize an irreversible action", () => {
    const db = openDb(":memory:");
    const decision = evaluateOwnerControlGate(db, {
      directive_id: "dir_2",
      action_summary: "delete remote branch",
      target_resources: ["git:origin/main"],
      irreversible_effects: [{ kind: "remote_delete", description: "force-deletes a branch" }],
      owner_state_belief: { uncertainty: 0.05, confidence: 0.95, latent_state: { autonomy: "high", trust: "full" } },
      owner_profile: null,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.gate_kind).toBe("hidl_action_required");
  });

  test("things_to_never_do match refuses with owner_input_required even when belief suggests high readiness", () => {
    const db = openDb(":memory:");
    const profile: OwnerProfile = { things_to_never_do: ["touch production database"] };
    const decision = evaluateOwnerControlGate(db, {
      directive_id: "dir_3",
      action_summary: "run migration that will touch production database",
      target_resources: ["db:prod"],
      owner_state_belief: { uncertainty: 0.0, confidence: 1.0, latent_state: { autonomy: "high" } },
      owner_profile: profile,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.gate_kind).toBe("owner_input_required");
    expect(decision.reason).toBe("owner_hard_boundary");
    expect(decision.matched_boundaries).toContain("touch production database");
  });

  test("irreversible effects WITH a valid same-directive owner_decision_recorded consent are allowed", () => {
    const db = openDb(":memory:");
    const consentId = recordConsent(db, "dir_4");
    const decision = evaluateOwnerControlGate(db, {
      directive_id: "dir_4",
      action_summary: "publish release",
      target_resources: ["npm:pkg"],
      irreversible_effects: [{ kind: "publish", description: "publishes to a public registry" }],
      cited_owner_consent_event_ids: [consentId],
      owner_profile: null,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.evidence_event_ids).toContain(consentId);
  });

  test("consent from a DIFFERENT directive does NOT authorize the irreversible action", () => {
    const db = openDb(":memory:");
    const otherConsent = recordConsent(db, "dir_other");
    const decision = evaluateOwnerControlGate(db, {
      directive_id: "dir_5",
      action_summary: "publish release",
      target_resources: ["npm:pkg"],
      irreversible_effects: [{ kind: "publish", description: "publishes" }],
      cited_owner_consent_event_ids: [otherConsent],
      owner_profile: null,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.gate_kind).toBe("hidl_action_required");
  });

  test("a non-sensitive, non-irreversible action with no boundary match is allowed", () => {
    const db = openDb(":memory:");
    const decision = evaluateOwnerControlGate(db, {
      directive_id: "dir_6",
      action_summary: "read a local file and summarize it",
      target_resources: ["repo:notes.md"],
      owner_state_belief: { uncertainty: 0.8 },
      owner_profile: { things_to_never_do: ["delete production data"] },
    });
    expect(decision.allowed).toBe(true);
  });
});
