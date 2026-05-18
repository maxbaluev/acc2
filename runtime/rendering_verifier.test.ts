import { describe, expect, test } from "bun:test";
import { verifyRendering, RENDERING_RESIDUAL_THRESHOLD } from "./rendering_verifier";
import type { OwnerRenderingPolicyRow } from "../substrate/views";

const emptyPolicy = (): OwnerRenderingPolicyRow => ({
  profile_event_id: "PROF1",
  profile_ts: "2026-05-17T00:00:00Z",
  profile_payload: {},
  preferred_terms: [],
  avoided_terms: [],
  declined_concepts: [],
  understood_concepts: [],
  exposed_concepts: [],
  things_to_never_do: [],
  manual_review_patterns: [],
  autonomy_score: 1.0,
  autonomy_scope: [],
  detected_language: "en",
  recent_correction_count: 0,
  recent_decline_count: 0,
  recent_ignored_count: 0,
  recent_satisfaction_count: 0,
  recent_clarification_count: 0,
  recent_override_count: 0,
  policy_health: 1.0,
});

describe("verifyRendering — clean strings", () => {
  test("plain English status text → residual 0", () => {
    const r = verifyRendering({
      rendered_text: "Working on it now.",
      audience: "primary",
      policy: emptyPolicy(),
    });
    expect(r.residual).toBe(0);
    expect(r.violations).toHaveLength(0);
  });

  test("policy=null (cold install) is treated as no constraint, only ID/jargon checks apply", () => {
    const r = verifyRendering({
      rendered_text: "Done.",
      audience: "primary",
      policy: null,
    });
    expect(r.residual).toBe(0);
  });
});

describe("verifyRendering — ID leakage", () => {
  test("primary surface with a 26-char ULID raises residual to 0.40", () => {
    const r = verifyRendering({
      rendered_text: "Dispatched as 4FYERR1YQ5H6MZ5YKYA60AEC43.",
      audience: "primary",
      policy: emptyPolicy(),
    });
    // 0.40 (id_leak) + ~0.15 (substrate jargon "dispatch") ≈ 0.55.
    expect(r.breakdown.id_leak).toBeCloseTo(0.40, 5);
    expect(r.violations.find((v) => v.axis === "id_leak")).toBeDefined();
    expect(r.residual).toBeGreaterThan(RENDERING_RESIDUAL_THRESHOLD);
  });

  test("detail_drawer surface relaxes ID weight to 1/4", () => {
    const r = verifyRendering({
      rendered_text: "raw id: 4FYERR1YQ5H6MZ5YKYA60AEC43",
      audience: "detail_drawer",
      policy: emptyPolicy(),
    });
    expect(r.breakdown.id_leak).toBeCloseTo(0.10, 5);
  });
});

describe("verifyRendering — substrate jargon", () => {
  test("primary surface using 'dispatch_decided' + 'task_committed' raises substrate-jargon axis", () => {
    const r = verifyRendering({
      rendered_text: "After dispatch_decided we hit task_committed and called it done.",
      audience: "primary",
      policy: emptyPolicy(),
    });
    expect(r.breakdown.jargon_substrate).toBeGreaterThan(0.2);
    expect(r.violations.some((v) => v.axis === "jargon_substrate")).toBe(true);
  });
});

describe("verifyRendering — owner-profile-derived axes", () => {
  test("avoided_terms hit raises residual by 0.20", () => {
    const policy = emptyPolicy();
    policy.avoided_terms = ["telemetry"];
    const r = verifyRendering({
      rendered_text: "Some telemetry was logged.",
      audience: "primary",
      policy,
    });
    expect(r.breakdown.avoided_term).toBeCloseTo(0.20, 5);
    expect(r.violations.some((v) => v.axis === "avoided_term" && v.sample.toLowerCase() === "telemetry")).toBe(true);
  });

  test("things_to_never_do hit raises residual to ≥0.5 — hard constraint", () => {
    const policy = emptyPolicy();
    policy.things_to_never_do = ["force-push"];
    const r = verifyRendering({
      rendered_text: "We can force-push the changes.",
      audience: "primary",
      policy,
    });
    expect(r.breakdown.things_to_never_do).toBeCloseTo(0.50, 5);
    expect(r.residual).toBeGreaterThanOrEqual(0.5);
  });

  test("declined_concepts hit raises residual by 0.20 per term, capped", () => {
    const policy = emptyPolicy();
    policy.declined_concepts = ["graphs", "metrics"];
    const r = verifyRendering({
      rendered_text: "Here are some graphs about your metrics.",
      audience: "primary",
      policy,
    });
    // Two declined hits: 0.20 + 0.20 = 0.40 (capped exactly at cap).
    expect(r.breakdown.declined_concept).toBeCloseTo(0.40, 5);
  });
});

describe("verifyRendering — ask clarity", () => {
  test("primary surface mentioning an action without an explicit ask gets a small penalty", () => {
    const r = verifyRendering({
      rendered_text: "We need to verify before the gate closes.",
      audience: "primary",
      policy: emptyPolicy(),
    });
    expect(r.breakdown.ask_clarity).toBeCloseTo(0.10, 5);
  });

  test("primary surface with an explicit ask phrase does NOT trigger ask_clarity penalty", () => {
    const r = verifyRendering({
      rendered_text: "We need to verify before the gate closes. Please reply when ready.",
      audience: "primary",
      policy: emptyPolicy(),
    });
    expect(r.breakdown.ask_clarity).toBe(0);
  });

  test("detail_drawer audience does not get the ask_clarity penalty", () => {
    const r = verifyRendering({
      rendered_text: "verify before gate closes",
      audience: "detail_drawer",
      policy: emptyPolicy(),
    });
    expect(r.breakdown.ask_clarity).toBe(0);
  });
});

describe("verifyRendering — residual aggregation + clamp", () => {
  test("residual is clamped to [0,1]", () => {
    const policy = emptyPolicy();
    policy.avoided_terms = ["a", "b"];
    policy.declined_concepts = ["c", "d"];
    policy.things_to_never_do = ["e"];
    const r = verifyRendering({
      rendered_text: "a b c d e 4FYERR1YQ5H6MZ5YKYA60AEC43 dispatch_decided task_committed",
      audience: "primary",
      policy,
    });
    expect(r.residual).toBeLessThanOrEqual(1.0);
    expect(r.residual).toBeGreaterThan(0.5);
  });
});
