// acc2 prompt minimization verifier — primitive #2 from SZG5PQ01.
// REUSE-FIRST: verifier artifact module only; no new substrate event kinds.

export type PromptClause = { id: string; source: string; text?: string; token_estimate?: number };
export type HeldOutTaskRun = { task_id: string; full_residual: number; ablated_residuals: Record<string, number>; reliability?: number };
export type PromptMinimizationPolicy = { demote_clause_ids?: string[]; keep_clause_ids?: string[] };
export type PromptMinimizationInput = { clauses: PromptClause[]; held_out_tasks: HeldOutTaskRun[]; policy?: PromptMinimizationPolicy; no_benefit_delta?: number; min_tasks_per_clause?: number };
export type ClauseAblationScore = { clause_id: string; source: string; task_count: number; mean_delta: number; max_delta: number; min_delta: number; recommendation: "demote_to_knowledge" | "keep_always_loaded"; reason: "no_measurable_benefit" | "negative_transfer" | "measurable_benefit" | "insufficient_evidence" };
export type PromptMinimizationVerifierResult = { residual: number; breakdown: Record<string, number>; reliability_profile: Record<string, number>; clause_scores: ClauseAblationScore[]; demote_clause_ids: string[]; knowledge_candidates: Array<{ claim: string; evidence: string[]; implications: string[]; applies_to: string[]; confidence_estimate: number; source_files: string[]; rlm_mechanism: "closure_learning" }>; budget_observed: Record<string, number> };

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const finiteResidual = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? clamp01(value) : null;
const mean = (values: number[]): number => values.length === 0 ? 0 : values.reduce((acc, value) => acc + value, 0) / values.length;
const percentileResidual = (values: number[], threshold: number): number => values.length === 0 ? 1 : clamp01(values.filter((value) => value >= threshold).length / values.length);

export const evaluatePromptMinimization = (input: PromptMinimizationInput): PromptMinimizationVerifierResult => {
  const clauses = Array.isArray(input.clauses) ? input.clauses : [];
  const tasks = Array.isArray(input.held_out_tasks) ? input.held_out_tasks : [];
  const noBenefitDelta = typeof input.no_benefit_delta === "number" ? Math.max(0, input.no_benefit_delta) : 0.02;
  const minTasksPerClause = Math.max(1, Math.floor(input.min_tasks_per_clause ?? 2));
  const demotePolicy = new Set(input.policy?.demote_clause_ids ?? []);
  const keepPolicy = new Set(input.policy?.keep_clause_ids ?? []);

  const clause_scores: ClauseAblationScore[] = clauses.map((clause) => {
    const deltas: number[] = [];
    for (const task of tasks) {
      const full = finiteResidual(task.full_residual);
      const ablated = finiteResidual(task.ablated_residuals?.[clause.id]);
      if (full !== null && ablated !== null) deltas.push(ablated - full);
    }
    const score = { clause_id: clause.id, source: clause.source, task_count: deltas.length, mean_delta: mean(deltas), max_delta: deltas.length ? Math.max(...deltas) : 0, min_delta: deltas.length ? Math.min(...deltas) : 0 };
    if (deltas.length < minTasksPerClause) return { ...score, recommendation: "keep_always_loaded", reason: "insufficient_evidence" };
    if (score.mean_delta < 0) return { ...score, recommendation: "demote_to_knowledge", reason: "negative_transfer" };
    if (score.mean_delta <= noBenefitDelta && score.max_delta <= noBenefitDelta * 2) return { ...score, recommendation: "demote_to_knowledge", reason: "no_measurable_benefit" };
    return { ...score, recommendation: "keep_always_loaded", reason: "measurable_benefit" };
  });

  const recommendedDemotions = new Set(clause_scores.filter((score) => score.recommendation === "demote_to_knowledge").map((score) => score.clause_id));
  const recommendedKeeps = new Set(clause_scores.filter((score) => score.recommendation === "keep_always_loaded").map((score) => score.clause_id));
  const beneficialDemoted = [...demotePolicy].filter((id) => recommendedKeeps.has(id)).length;
  const uselessRetained = [...keepPolicy].filter((id) => recommendedDemotions.has(id)).length;
  const missingDemotions = [...recommendedDemotions].filter((id) => !demotePolicy.has(id) && keepPolicy.size + demotePolicy.size > 0).length;
  const insufficientEvidence = clause_scores.filter((score) => score.reason === "insufficient_evidence").length;
  const baselineResiduals = tasks.map((task) => finiteResidual(task.full_residual)).filter((value): value is number => value !== null);
  const reliabilityValues = tasks.map((task) => finiteResidual(task.reliability)).filter((value): value is number => value !== null);

  const coverageResidual = clauses.length === 0 ? 1 : clamp01(insufficientEvidence / clauses.length);
  const policyResidual = clauses.length === 0 ? 1 : clamp01((beneficialDemoted * 2 + uselessRetained + missingDemotions) / Math.max(1, clauses.length));
  const baselineQualityResidual = percentileResidual(baselineResiduals, 0.3);
  const residual = clamp01(Math.max(coverageResidual, policyResidual, baselineQualityResidual * 0.5));
  const demote_clause_ids = [...recommendedDemotions];
  const tokenEstimate = clauses.reduce((acc, clause) => acc + (typeof clause.token_estimate === "number" ? Math.max(0, clause.token_estimate) : Math.ceil((clause.text?.length ?? 0) / 4)), 0);

  return {
    residual,
    breakdown: { held_out_coverage: coverageResidual, policy_alignment: policyResidual, baseline_task_quality: baselineQualityResidual, beneficial_clause_demoted: clamp01(beneficialDemoted / Math.max(1, clauses.length)), useless_clause_retained: clamp01(uselessRetained / Math.max(1, clauses.length)), recommended_demotion_missing_from_policy: clamp01(missingDemotions / Math.max(1, clauses.length)) },
    reliability_profile: { task_count: tasks.length, clause_count: clauses.length, min_tasks_per_clause: minTasksPerClause, mean_task_reliability: reliabilityValues.length ? mean(reliabilityValues) : 0.5, evidence_completeness: clauses.length === 0 ? 0 : 1 - coverageResidual },
    clause_scores,
    demote_clause_ids,
    knowledge_candidates: clause_scores.filter((score) => score.recommendation === "demote_to_knowledge").map((score) => ({ claim: `Always-loaded prompt clause ${score.clause_id} from ${score.source} can move to retrievable knowledge without worsening held-out residuals.`, evidence: [`mean ablation delta=${score.mean_delta.toFixed(4)} across ${score.task_count} held-out tasks`, `recommendation reason=${score.reason}`], implications: ["Demote this clause from always-loaded prompt text to knowledge_candidate/retrievable knowledge.", "Keep the universal verifier residual packet as the scoring mechanism."], applies_to: ["prompt_minimization", "always_loaded_contract_slimming", score.source], confidence_estimate: clamp01(0.5 + Math.min(score.task_count, 10) / 20 - Math.max(0, score.mean_delta) * 2), source_files: [score.source], rlm_mechanism: "closure_learning" })),
    budget_observed: { held_out_tasks: tasks.length, clauses_evaluated: clauses.length, prompt_token_estimate: tokenEstimate, artifact_invocations: tasks.length * Math.max(1, clauses.length + 1) },
  };
};

export const PROMPT_MINIMIZATION_VERIFIER_ARTIFACT_BODY = `
const clamp01 = (value) => Math.max(0, Math.min(1, value));
const finiteResidual = (value) => typeof value === "number" && Number.isFinite(value) ? clamp01(value) : null;
const mean = (values) => values.length === 0 ? 0 : values.reduce((acc, value) => acc + value, 0) / values.length;
const percentileResidual = (values, threshold) => values.length === 0 ? 1 : clamp01(values.filter((value) => value >= threshold).length / values.length);
const input = JSON.parse(process.env.ACC2_INPUTS ?? "{}");
const clauses = Array.isArray(input.clauses) ? input.clauses : [];
const tasks = Array.isArray(input.held_out_tasks) ? input.held_out_tasks : [];
const noBenefitDelta = typeof input.no_benefit_delta === "number" ? Math.max(0, input.no_benefit_delta) : 0.02;
const minTasksPerClause = Math.max(1, Math.floor(input.min_tasks_per_clause ?? 2));
const demotePolicy = new Set(input.policy?.demote_clause_ids ?? []);
const keepPolicy = new Set(input.policy?.keep_clause_ids ?? []);
const clause_scores = clauses.map((clause) => {
  const deltas = [];
  for (const task of tasks) {
    const full = finiteResidual(task.full_residual);
    const ablated = finiteResidual(task.ablated_residuals?.[clause.id]);
    if (full !== null && ablated !== null) deltas.push(ablated - full);
  }
  const score = { clause_id: clause.id, source: clause.source, task_count: deltas.length, mean_delta: mean(deltas), max_delta: deltas.length ? Math.max(...deltas) : 0, min_delta: deltas.length ? Math.min(...deltas) : 0 };
  if (deltas.length < minTasksPerClause) return { ...score, recommendation: "keep_always_loaded", reason: "insufficient_evidence" };
  if (score.mean_delta < 0) return { ...score, recommendation: "demote_to_knowledge", reason: "negative_transfer" };
  if (score.mean_delta <= noBenefitDelta && score.max_delta <= noBenefitDelta * 2) return { ...score, recommendation: "demote_to_knowledge", reason: "no_measurable_benefit" };
  return { ...score, recommendation: "keep_always_loaded", reason: "measurable_benefit" };
});
const recommendedDemotions = new Set(clause_scores.filter((score) => score.recommendation === "demote_to_knowledge").map((score) => score.clause_id));
const recommendedKeeps = new Set(clause_scores.filter((score) => score.recommendation === "keep_always_loaded").map((score) => score.clause_id));
const beneficialDemoted = [...demotePolicy].filter((id) => recommendedKeeps.has(id)).length;
const uselessRetained = [...keepPolicy].filter((id) => recommendedDemotions.has(id)).length;
const missingDemotions = [...recommendedDemotions].filter((id) => !demotePolicy.has(id) && keepPolicy.size + demotePolicy.size > 0).length;
const insufficientEvidence = clause_scores.filter((score) => score.reason === "insufficient_evidence").length;
const baselineResiduals = tasks.map((task) => finiteResidual(task.full_residual)).filter((value) => value !== null);
const reliabilityValues = tasks.map((task) => finiteResidual(task.reliability)).filter((value) => value !== null);
const coverageResidual = clauses.length === 0 ? 1 : clamp01(insufficientEvidence / clauses.length);
const policyResidual = clauses.length === 0 ? 1 : clamp01((beneficialDemoted * 2 + uselessRetained + missingDemotions) / Math.max(1, clauses.length));
const baselineQualityResidual = percentileResidual(baselineResiduals, 0.3);
const residual = clamp01(Math.max(coverageResidual, policyResidual, baselineQualityResidual * 0.5));
const tokenEstimate = clauses.reduce((acc, clause) => acc + (typeof clause.token_estimate === "number" ? Math.max(0, clause.token_estimate) : Math.ceil((clause.text?.length ?? 0) / 4)), 0);
console.log("@@RESULT@@ " + JSON.stringify({ residual, breakdown: { held_out_coverage: coverageResidual, policy_alignment: policyResidual, baseline_task_quality: baselineQualityResidual, beneficial_clause_demoted: clamp01(beneficialDemoted / Math.max(1, clauses.length)), useless_clause_retained: clamp01(uselessRetained / Math.max(1, clauses.length)), recommended_demotion_missing_from_policy: clamp01(missingDemotions / Math.max(1, clauses.length)) }, reliability_profile: { task_count: tasks.length, clause_count: clauses.length, min_tasks_per_clause: minTasksPerClause, mean_task_reliability: reliabilityValues.length ? mean(reliabilityValues) : 0.5, evidence_completeness: clauses.length === 0 ? 0 : 1 - coverageResidual }, clause_scores, demote_clause_ids: [...recommendedDemotions], knowledge_candidates: clause_scores.filter((score) => score.recommendation === "demote_to_knowledge").map((score) => ({ claim: ` + "`Always-loaded prompt clause ${score.clause_id} from ${score.source} can move to retrievable knowledge without worsening held-out residuals.`" + `, evidence: [` + "`mean ablation delta=${score.mean_delta.toFixed(4)} across ${score.task_count} held-out tasks`" + `, ` + "`recommendation reason=${score.reason}`" + `], implications: ["Demote this clause from always-loaded prompt text to knowledge_candidate/retrievable knowledge.", "Keep the universal verifier residual packet as the scoring mechanism."], applies_to: ["prompt_minimization", "always_loaded_contract_slimming", score.source], confidence_estimate: clamp01(0.5 + Math.min(score.task_count, 10) / 20 - Math.max(0, score.mean_delta) * 2), source_files: [score.source], rlm_mechanism: "closure_learning" })), budget_observed: { held_out_tasks: tasks.length, clauses_evaluated: clauses.length, prompt_token_estimate: tokenEstimate, artifact_invocations: tasks.length * Math.max(1, clauses.length + 1) } }));
`;
