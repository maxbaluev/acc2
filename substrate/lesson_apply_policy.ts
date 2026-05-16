export type LessonApplyPolicyEffect = "owner_consent_required" | "safe_auto_apply_candidate";
export type LessonApplyPolicyMatch = "exact" | "prefix";

export type LessonApplyPolicyRule = {
  effect: LessonApplyPolicyEffect;
  match: LessonApplyPolicyMatch;
  pattern: string;
};

// Declarative target policy for the lesson-implementer flywheel. The same
// proposal shape can be a lesson_extracted, recipe_candidate lesson, verifier
// gap, or contract_amendment_proposed; only target policy + verifier evidence
// decide whether owner consent or safe auto-apply is available.
export const LESSON_APPLY_TARGET_POLICY: readonly LessonApplyPolicyRule[] = [
  { effect: "owner_consent_required", match: "exact", pattern: "CLAUDE.md" },
  { effect: "owner_consent_required", match: "exact", pattern: "docs/v2-design.md" },
  { effect: "owner_consent_required", match: "exact", pattern: "docs/operator-install.md" },
  { effect: "owner_consent_required", match: "exact", pattern: "docs/ops-guide.md" },
  { effect: "owner_consent_required", match: "prefix", pattern: ".claude/rules/" },
  { effect: "safe_auto_apply_candidate", match: "prefix", pattern: "cli/" },
  { effect: "safe_auto_apply_candidate", match: "prefix", pattern: "runtime/" },
] as const;

export type LessonApplyTargetPolicy = {
  ownerGateRequired: boolean;
  autoApplyTarget: boolean;
};

const normalizeTarget = (target: string): string => {
  const trimmed = target.trim();
  const repoRelative = trimmed.startsWith("repo:") ? trimmed.slice("repo:".length) : trimmed;
  return repoRelative.replace(/^\.\//, "");
};

const policyRuleMatches = (rule: LessonApplyPolicyRule, target: string): boolean => {
  if (rule.match === "exact") return target === rule.pattern;
  return target.startsWith(rule.pattern);
};

export const lessonApplyTargetPolicy = (target: string): LessonApplyTargetPolicy => {
  const normalized = normalizeTarget(target);
  return {
    ownerGateRequired: LESSON_APPLY_TARGET_POLICY.some(
      (rule) => rule.effect === "owner_consent_required" && policyRuleMatches(rule, normalized),
    ),
    autoApplyTarget: LESSON_APPLY_TARGET_POLICY.some(
      (rule) => rule.effect === "safe_auto_apply_candidate" && policyRuleMatches(rule, normalized),
    ),
  };
};

export const lessonApplyTargetsPolicy = (targets: readonly string[]): LessonApplyTargetPolicy => {
  const normalizedTargets = [...new Set(targets.map(normalizeTarget).filter(Boolean))];
  const perTarget = normalizedTargets.map(lessonApplyTargetPolicy);
  return {
    ownerGateRequired: perTarget.some((p) => p.ownerGateRequired),
    autoApplyTarget: normalizedTargets.length > 0
      && perTarget.every((p) => p.autoApplyTarget)
      && !perTarget.some((p) => p.ownerGateRequired),
  };
};

const sqlQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

export const lessonApplyTargetPolicyValuesSql = (): string => LESSON_APPLY_TARGET_POLICY
  .map((rule) => `SELECT ${sqlQuote(rule.effect)} AS effect, ${sqlQuote(rule.match)} AS match, ${sqlQuote(rule.pattern)} AS pattern`)
  .join("\n    UNION ALL\n    ");
