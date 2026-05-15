// Pure persona classifier for the conversation-as-learning-surface
// pipeline (brain dispatch DSGSAZGMF1, 2026-05-15).
//
// Classifies an owner's first messages into one of three personas
// (developer / operator / casual) using cheap heuristics. The result
// flows through the existing Layer-2 path:
//
//   classifyOwnerPersona(text) → owner_insight_candidate event
//     → substrate/extractors.ts maybePromoteOwnerProfile
//     → owner_profile_recorded { persona, ... }
//     → runtime/prompt_composer.ts buildOwnerProfileSection
//
// The classifier is intentionally NOT brain-backed. A persistent
// rolling-active job to refine the persona over many turns IS brain
// work (cheap inline heuristic + brain-side refinement = compounding),
// but the first-encounter classification has to be instant — the
// brain's prompt for cycle 1 already reads the OWNER PROFILE section,
// so the persona must be on file before the first dispatch resolves.
// One scalar call, no I/O, no LLM.

import type { OwnerPersona } from "./types";

export type OwnerPersonaClassification = {
  persona: OwnerPersona;
  /** ∈ [0, 1]. ≥ 0.85 → auto-promote via Layer-2 extractor. Below that
   *  threshold, the candidate sits in the ledger as evidence for the
   *  Model D deduper to corroborate from sibling candidates. */
  confidence: number;
  /** Which heuristic features fired. Cited in the candidate payload so
   *  the extractor can later score the classifier itself by outcome
   *  (k_555 four-link credit chain — the classifier earns posterior
   *  when its calls turn out to be the right depth for the owner). */
  signals: string[];
};

// Heuristic vocabularies. Each list is intentionally short — these are
// strong signals, not exhaustive. The classifier never returns
// confidence > 0.95 from heuristics alone; certainty comes from
// corroboration over multiple turns.

const DEVELOPER_TOKENS = [
  // Programming languages / file extensions / dotfiles
  ".ts", ".tsx", ".js", ".py", ".rs", ".go", ".rb", ".sql", ".json", ".yaml", ".yml", ".md",
  ".env", "tsconfig", "package.json", "node_modules", "Cargo.toml", "pyproject",
  // Common code constructs
  "function ", "const ", "let ", "import ", "export ", "class ", "interface ", "async ",
  "=>", "() {", "() =>", "fn ", "def ", "return ", "throw ",
  // Git / shell / package manager
  "git ", "npm ", "bun ", "yarn ", "pnpm ", "cargo ", "uv ", "pip ", "brew ",
  "rebase", "merge conflict", "pull request", "PR ", "commit", "branch", "remote",
  // Stack traces / errors
  "stack trace", "exception", "stacktrace", "traceback", "SIGSEGV", "ENOENT",
  // CI / infra
  "docker", "kubernetes", "k8s", "ci/cd", "github action", "deploy", "rollback",
];

const OPERATOR_TOKENS = [
  // Operational vocabulary
  "deploy", "deployment", "rollout", "rollback", "uptime", "downtime",
  "incident", "outage", "post-mortem", "postmortem", "runbook",
  "audit", "review", "verify", "blocked", "stuck", "root cause",
  "metric", "dashboard", "alert", "monitoring", "observability",
  "kpi", "sla", "slo", "p95", "p99", "latency", "throughput",
  // Project management
  "milestone", "sprint", "backlog", "ticket", "jira", "linear",
  "estimate", "scope", "blocker", "dependency",
  // Customer / business ops
  "stakeholder", "customer", "vendor", "contract", "renewal",
  "compliance", "security review", "approval", "sign-off", "signoff",
];

// `casual` is the default when neither developer nor operator dominates.

const lowerCase = (s: string): string => s.toLowerCase();

const containsAny = (text: string, tokens: readonly string[]): string[] => {
  const lower = lowerCase(text);
  return tokens.filter((t) => lower.includes(lowerCase(t)));
};

/** Detect explicit code-identifier patterns (camelCase, snake_case_long,
 *  CONSTANT_CASE) that aren't natural English. Strong developer signal. */
const hasCodeIdentifiers = (text: string): boolean => {
  // camelCase with > 1 hump (e.g. `getUserById`, NOT `JavaScript` or `iPhone`)
  if (/\b[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/.test(text)) return true;
  // snake_case_long (≥ 2 underscores)
  if (/\b[a-z][a-z0-9]*(_[a-z0-9]+){2,}\b/.test(text)) return true;
  // CONSTANT_CASE (all-caps with underscore)
  if (/\b[A-Z][A-Z0-9]*(_[A-Z0-9]+){1,}\b/.test(text)) return true;
  return false;
};

/** Detect file-path-like fragments. Strong developer signal. */
const hasFilePaths = (text: string): boolean => {
  // ./foo, ../foo, /abs/path, foo/bar/baz, foo.bar (with two dots), foo.ext
  if (/\.\.?\/[A-Za-z0-9_./-]+/.test(text)) return true;
  if (/\/[A-Za-z0-9_-]+\/[A-Za-z0-9_./-]+/.test(text)) return true;
  return false;
};

/** Detect natural-language question phrasing — casual signal. The
 *  owner is having a conversation, not writing a command. */
const hasNaturalQuestion = (text: string): boolean => {
  const lower = lowerCase(text);
  const startsWith = [
    "how do i ", "how can i ", "what is ", "what's ", "why is ", "why does ",
    "can you ", "could you ", "should i ", "would you ",
    "help me ", "i want to ", "i need ", "i'd like ",
  ];
  return startsWith.some((s) => lower.startsWith(s)) || /\?\s*$/.test(text.trim());
};

/** Pure classifier — takes the owner's directive text (and optionally
 *  prior owner_input_received texts) and returns one of three personas
 *  with a confidence score. Pure: no I/O, no DB read, no LLM call. */
export const classifyOwnerPersona = (
  primaryText: string,
  priorTexts: readonly string[] = [],
): OwnerPersonaClassification => {
  const allText = [primaryText, ...priorTexts].join("\n");

  const devTokens = containsAny(allText, DEVELOPER_TOKENS);
  const opTokens = containsAny(allText, OPERATOR_TOKENS);
  const codeIdents = hasCodeIdentifiers(allText);
  const filePaths = hasFilePaths(allText);
  const naturalQ = hasNaturalQuestion(primaryText);

  const signals: string[] = [];
  let devScore = 0;
  let opScore = 0;
  let casualScore = 0;

  if (devTokens.length > 0) {
    devScore += Math.min(0.5, devTokens.length * 0.1);
    signals.push(`developer_tokens:${devTokens.slice(0, 5).join(",")}`);
  }
  if (codeIdents) {
    devScore += 0.35;
    signals.push("code_identifiers");
  }
  if (filePaths) {
    devScore += 0.25;
    signals.push("file_paths");
  }
  if (opTokens.length > 0) {
    opScore += Math.min(0.5, opTokens.length * 0.1);
    signals.push(`operator_tokens:${opTokens.slice(0, 5).join(",")}`);
  }
  if (naturalQ) {
    casualScore += 0.4;
    signals.push("natural_question");
  }
  // Casual baseline: when the text is short and has no code/op signal,
  // it's almost certainly casual. Owners onboarding by chat tend to
  // say "I want to lose weight" or "help me find X" — pure casual.
  if (devScore === 0 && opScore === 0 && allText.length < 200) {
    casualScore += 0.4;
    signals.push("short_casual_baseline");
  }

  // Pick the dominant persona. Confidence = winning score capped at
  // 0.95 (never claim certainty from heuristics alone).
  let persona: OwnerPersona = "casual";
  let topScore = casualScore;
  if (devScore > topScore) { persona = "developer"; topScore = devScore; }
  if (opScore > topScore) { persona = "operator"; topScore = opScore; }
  const confidence = Math.min(0.95, Math.max(0.5, topScore));

  return { persona, confidence, signals };
};
