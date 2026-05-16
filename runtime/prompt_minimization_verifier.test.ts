import { describe, expect, test } from "bun:test";
import { runBunArtifact } from "./runtimes/bun";
import { evaluatePromptMinimization, PROMPT_MINIMIZATION_VERIFIER_ARTIFACT_BODY, type PromptMinimizationInput } from "./prompt_minimization_verifier";

const fixtureInput: PromptMinimizationInput = {
  clauses: [
    { id: "structural_invariant", source: "CLAUDE.md", token_estimate: 120 },
    { id: "long_example", source: "docs/v2-design.md#example", token_estimate: 500 },
    { id: "stale_runtime_note", source: ".claude/rules/orchestrator-runtime.md", token_estimate: 180 },
  ],
  held_out_tasks: [
    { task_id: "task_a", full_residual: 0.1, reliability: 0.9, ablated_residuals: { structural_invariant: 0.24, long_example: 0.105, stale_runtime_note: 0.08 } },
    { task_id: "task_b", full_residual: 0.12, reliability: 0.8, ablated_residuals: { structural_invariant: 0.26, long_example: 0.13, stale_runtime_note: 0.1 } },
  ],
  policy: { demote_clause_ids: ["long_example", "stale_runtime_note"], keep_clause_ids: ["structural_invariant"] },
};

describe("prompt_minimization_verifier", () => {
  test("scores an aligned ablation policy with low residual and demotion candidates", () => {
    const result = evaluatePromptMinimization(fixtureInput);
    expect(result.residual).toBeLessThan(0.3);
    expect(result.demote_clause_ids.sort()).toEqual(["long_example", "stale_runtime_note"]);
    expect(result.clause_scores.find((score) => score.clause_id === "structural_invariant")?.recommendation).toBe("keep_always_loaded");
    expect(result.knowledge_candidates).toHaveLength(2);
    expect(result.breakdown.policy_alignment).toBe(0);
    expect(result.reliability_profile.evidence_completeness).toBe(1);
  });

  test("penalizes a policy that demotes a beneficial clause", () => {
    const result = evaluatePromptMinimization({ ...fixtureInput, policy: { demote_clause_ids: ["structural_invariant"], keep_clause_ids: ["long_example", "stale_runtime_note"] } });
    expect(result.residual).toBeGreaterThanOrEqual(0.3);
    expect(result.breakdown.beneficial_clause_demoted).toBeGreaterThan(0);
    expect(result.breakdown.useless_clause_retained).toBeGreaterThan(0);
  });

  test("is executable as a bun verifier artifact body", async () => {
    const observation = await runBunArtifact({ artifactId: "prompt_minimization_verifier_test", body: PROMPT_MINIMIZATION_VERIFIER_ARTIFACT_BODY, declaredSandbox: { runtime: "bun", fs_read: [], fs_write: [], net_allow: [], proc_allow: [], env_requires: [], cpu_ms: 1000, wall_ms: 5000, memory_mb: 128 }, inputs: fixtureInput });
    expect(observation.ok).toBe(true);
    expect(observation.result).toBeTruthy();
    const rawResult = observation.result as { residual?: number; result?: unknown };
    const result = (typeof rawResult.residual === "number" ? rawResult : rawResult.result) as { residual: number; breakdown: Record<string, number>; demote_clause_ids: string[] };
    if (typeof result.residual !== "number") throw new Error(JSON.stringify({ observation, result }));
    expect(result.residual).toBeLessThan(0.3);
    expect(result.breakdown.policy_alignment).toBe(0);
    expect(result.demote_clause_ids.sort()).toEqual(["long_example", "stale_runtime_note"]);
  });
});
