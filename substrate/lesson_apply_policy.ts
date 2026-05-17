export type LessonApplyPolicyEffect = "owner_consent_required" | "safe_auto_apply_candidate";
export type LessonApplyPolicyMatch = "exact" | "prefix";

export type LessonApplyPolicyRule = {
  effect: LessonApplyPolicyEffect;
  match: LessonApplyPolicyMatch;
  pattern: string;
};

// Declarative target policy for the lesson-implementer flywheel. Target paths
// only identify surfaces eligible for unattended auto-apply; owner consent is
// driven by owner_profile.things_to_never_do, not a hard-coded path list.
export const LESSON_APPLY_TARGET_POLICY: readonly LessonApplyPolicyRule[] = [
  { effect: "safe_auto_apply_candidate", match: "prefix", pattern: "cli/" },
  { effect: "safe_auto_apply_candidate", match: "prefix", pattern: "runtime/" },
  { effect: "safe_auto_apply_candidate", match: "prefix", pattern: "substrate/" },
  { effect: "safe_auto_apply_candidate", match: "prefix", pattern: "docs/" },
  { effect: "safe_auto_apply_candidate", match: "prefix", pattern: ".claude/rules/" },
  { effect: "safe_auto_apply_candidate", match: "exact", pattern: "CLAUDE.md" },
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
    ownerGateRequired: false,
    autoApplyTarget: LESSON_APPLY_TARGET_POLICY.some(
      (rule) => rule.effect === "safe_auto_apply_candidate" && policyRuleMatches(rule, normalized),
    ),
  };
};

export const lessonApplyTargetsPolicy = (targets: readonly string[]): LessonApplyTargetPolicy => {
  const normalizedTargets = [...new Set(targets.map(normalizeTarget).filter(Boolean))];
  const perTarget = normalizedTargets.map(lessonApplyTargetPolicy);
  return {
    ownerGateRequired: false,
    autoApplyTarget: normalizedTargets.length > 0 && perTarget.every((p) => p.autoApplyTarget),
  };
};

const sqlQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

export const lessonApplyTargetPolicyValuesSql = (): string => LESSON_APPLY_TARGET_POLICY
  .map((rule) => `SELECT ${sqlQuote(rule.effect)} AS effect, ${sqlQuote(rule.match)} AS match, ${sqlQuote(rule.pattern)} AS pattern`)
  .join("\n    UNION ALL\n    ");
