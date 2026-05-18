import { describe, expect, test } from "bun:test";
import {
  scoreOwnerStateTransition,
  OWNER_STATE_TRANSITION_RESIDUAL_THRESHOLD,
} from "./owner_state_transition_verifier";
import type { OwnerStateBeliefRow } from "../substrate/views";

const belief = (overrides: Partial<OwnerStateBeliefRow["latent_state"]> = {}, confidence: Record<string, number> = {}): OwnerStateBeliefRow => ({
  hypothesis_event_id: "HYPO_1",
  hypothesis_ts: "2026-05-18T00:00:00Z",
  hypothesis_origin: "claude_inline",
  latent_state: { ...overrides },
  confidence: { attention_budget: 0.7, emotional_register: 0.7, ...confidence },
  observation_refs: [],
  decay_after_iso: null,
  uncertainty: 0.4,
  recent_prediction_error_count: 0,
  recent_avg_prediction_error: null,
  belief_age_ms: 60_000,
  is_stale: false,
});

describe("scoreOwnerStateTransition — null belief defaults", () => {
  test("ask_clarification + null belief → residual 0 (safe default)", () => {
    const r = scoreOwnerStateTransition({
      belief: null,
      action: { action_kind: "ask_clarification" },
    });
    expect(r.residual).toBe(0);
  });

  test("render_technical + null belief → state_action_fit raised", () => {
    const r = scoreOwnerStateTransition({
      belief: null,
      action: { action_kind: "render_technical" },
    });
    expect(r.prediction_error.state_action_fit).toBeGreaterThan(0);
    expect(r.violations.some((v) => v.axis === "state_action_fit")).toBe(true);
  });
});

describe("scoreOwnerStateTransition — attention_budget axis", () => {
  test("render_technical while attention_budget=low → attention_budget_fit raised", () => {
    const r = scoreOwnerStateTransition({
      belief: belief({ attention_budget: "low" }),
      action: { action_kind: "render_technical" },
    });
    expect(r.prediction_error.attention_budget_fit).toBeGreaterThan(0);
    expect(r.violations.some((v) => v.axis === "attention_budget_fit")).toBe(true);
  });

  test("render_plain while attention_budget=high + high conf → small penalty", () => {
    const r = scoreOwnerStateTransition({
      belief: belief({ attention_budget: "high" }, { attention_budget: 0.85 }),
      action: { action_kind: "render_plain" },
    });
    expect(r.prediction_error.attention_budget_fit).toBeGreaterThan(0);
    expect(r.prediction_error.attention_budget_fit).toBeLessThan(0.1);
  });

  test("render_plain while attention_budget=low → no penalty (correct fit)", () => {
    const r = scoreOwnerStateTransition({
      belief: belief({ attention_budget: "low" }),
      action: { action_kind: "render_plain" },
    });
    expect(r.prediction_error.attention_budget_fit).toBe(0);
  });
});

describe("scoreOwnerStateTransition — emotional_register axis", () => {
  test("surface_evidence while emotional_register=frustrated → emotional_register_fit raised", () => {
    const r = scoreOwnerStateTransition({
      belief: belief({ emotional_register: "frustrated" }),
      action: { action_kind: "surface_evidence" },
    });
    expect(r.prediction_error.emotional_register_fit).toBeGreaterThan(0);
  });
});

describe("scoreOwnerStateTransition — decision_burden axis", () => {
  test("options_first while decision_style=direct_confirm → decision_burden_fit raised", () => {
    const r = scoreOwnerStateTransition({
      belief: belief({ decision_style: "direct_confirm" }),
      action: { action_kind: "options_first" },
    });
    expect(r.prediction_error.decision_burden_fit).toBeGreaterThan(0);
  });
});

describe("scoreOwnerStateTransition — skill_calibration axis", () => {
  test("render_technical while skill_calibration=novice → skill_calibration_fit raised", () => {
    const r = scoreOwnerStateTransition({
      belief: belief({ skill_calibration: { domain: "rust", estimated_skill: "novice", confidence: 0.7 } }),
      action: { action_kind: "render_technical" },
    });
    expect(r.prediction_error.skill_calibration_fit).toBeGreaterThan(0);
  });
});

describe("scoreOwnerStateTransition — outcome signal folding", () => {
  test("owner_corrected outcome → outcome_residual raised independently of axis fit", () => {
    const r = scoreOwnerStateTransition({
      belief: belief({ attention_budget: "low" }),
      action: { action_kind: "render_plain" }, // clean fit
      outcome: { observed_outcome: "owner_corrected_terms" },
    });
    expect(r.prediction_error.outcome_residual).toBeGreaterThanOrEqual(0.3);
    expect(r.residual).toBeGreaterThanOrEqual(OWNER_STATE_TRANSITION_RESIDUAL_THRESHOLD);
  });

  test("owner_approved outcome subtracts credit", () => {
    const r = scoreOwnerStateTransition({
      belief: belief({ attention_budget: "low" }),
      action: { action_kind: "render_plain" },
      outcome: { observed_outcome: "owner_approved" },
    });
    expect(r.residual).toBe(0);
  });

  test("observed_residual ∈ [0,1] folds into the aggregate", () => {
    const r = scoreOwnerStateTransition({
      belief: belief(),
      action: { action_kind: "ask_clarification" },
      outcome: { observed_residual: 0.6 },
    });
    expect(r.prediction_error.outcome_residual).toBeCloseTo(0.3, 5);
  });
});

describe("scoreOwnerStateTransition — residual clamp + multi-axis aggregation", () => {
  test("multi-axis violations clamp at 1", () => {
    const r = scoreOwnerStateTransition({
      belief: belief({
        attention_budget: "low",
        emotional_register: "frustrated",
        decision_style: "direct_confirm",
        skill_calibration: { domain: "rust", estimated_skill: "novice", confidence: 0.7 },
        latent_larger_goal: "ship the demo",
      }),
      action: { action_kind: "render_technical" },
      outcome: { observed_outcome: "owner_overrode" },
    });
    expect(r.residual).toBeLessThanOrEqual(1);
    expect(r.residual).toBeGreaterThan(0.5);
    expect(r.violations.length).toBeGreaterThan(1);
  });
});

describe("threshold export", () => {
  test("threshold matches closure / rendering family", () => {
    expect(OWNER_STATE_TRANSITION_RESIDUAL_THRESHOLD).toBe(0.3);
  });
});
