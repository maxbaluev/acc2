// Pure rendering-signal classifier for the conversation-as-learning-surface
// pipeline (brain dispatch DSGSAZGMF1, 2026-05-15; universalized
// 2026-05-15 per owner feedback: "people not 3 types, all of them
// different").
//
// Owners are NOT bucketed into a fixed persona enum. Every owner is a
// unique continuous vector of learned rendering signals. This classifier
// extracts independent signal values from an owner's chat text — each
// signal can light up or stay dark independently. A directive that
// shows code AND asks a natural-language question raises BOTH
// `code_density` AND `explanation_appetite`; the renderer adapts on
// each dimension.
//
// The output is a Record<string, number> (signal name → strength ∈
// [0, 1]). It flows through the existing Layer-2 path:
//
//   classifyOwnerRenderingSignals(text) → owner_insight_candidate
//     { field: "rendering_signals", value: { code_density: 0.7, ... } }
//     → substrate/extractors.ts maybePromoteOwnerProfile
//     → owner_profile_recorded.rendering_signals merged
//     → runtime/prompt_composer.ts buildOwnerProfileSection
//
// Pure: no I/O, no DB read, no LLM call. Fast (sub-millisecond).
// Idempotent: same text → same signal vector.

export type OwnerRenderingSignals = Record<string, number>;

export type OwnerRenderingClassification = {
  /** Map of signal name → strength ∈ [0, 1]. Only includes signals that
   *  fired above zero — absent keys mean "no evidence this owner
   *  prefers this dimension yet". The renderer reads what it knows;
   *  ignores unknown keys (so future signals are purely additive). */
  signals: OwnerRenderingSignals;
  /** Aggregate confidence in the signal vector as a whole, ∈ [0.5, 0.95].
   *  Used by the Layer-2 extractor to decide whether to auto-promote
   *  this single observation into owner_profile_recorded.
   *  Never 1.0 — heuristics aren't certainty. */
  confidence: number;
  /** Which raw features fired. Cited in the candidate payload so the
   *  extractor can later score the classifier itself by outcome
   *  (k_555 four-link credit chain). */
  evidence: string[];
};

// Heuristic vocabularies. Each list is short — strong signals only.
// The classifier never claims certainty; multiple turns + multi-origin
// corroboration are what move a signal toward 1.0.

const CODE_TOKENS = [
  ".ts", ".tsx", ".js", ".py", ".rs", ".go", ".rb", ".sql", ".json", ".yaml", ".yml",
  ".env", "tsconfig", "package.json", "node_modules", "Cargo.toml", "pyproject",
  "function ", "const ", "let ", "import ", "export ", "class ", "interface ", "async ",
  "=>", "() {", "() =>", "fn ", "def ", "return ", "throw ",
  "git ", "npm ", "bun ", "yarn ", "pnpm ", "cargo ", "uv ", "pip ", "brew ",
  "rebase", "merge conflict", "pull request", "PR ", "commit", "branch", "remote",
  "stack trace", "exception", "stacktrace", "traceback", "SIGSEGV", "ENOENT",
  "docker", "kubernetes", "k8s", "ci/cd", "github action",
];

const OPS_TOKENS = [
  "deploy", "deployment", "rollout", "rollback", "uptime", "downtime",
  "incident", "outage", "post-mortem", "postmortem", "runbook",
  "audit", "verify", "blocked", "stuck", "root cause",
  "metric", "dashboard", "alert", "monitoring", "observability",
  "kpi", "sla", "slo", "p95", "p99", "latency", "throughput",
  "milestone", "sprint", "backlog", "ticket", "jira", "linear",
  "estimate", "scope", "blocker", "dependency",
  "stakeholder", "customer", "vendor", "contract", "renewal",
  "compliance", "security review", "approval", "sign-off", "signoff",
];

const lowerCase = (s: string): string => s.toLowerCase();

const countMatches = (text: string, tokens: readonly string[]): number => {
  const lower = lowerCase(text);
  let n = 0;
  for (const t of tokens) {
    if (lower.includes(lowerCase(t))) n++;
  }
  return n;
};

const hasCodeIdentifiers = (text: string): boolean => {
  if (/\b[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/.test(text)) return true;
  if (/\b[a-z][a-z0-9]*(_[a-z0-9]+){2,}\b/.test(text)) return true;
  if (/\b[A-Z][A-Z0-9]*(_[A-Z0-9]+){1,}\b/.test(text)) return true;
  return false;
};

const hasFilePaths = (text: string): boolean => {
  if (/\.\.?\/[A-Za-z0-9_./-]+/.test(text)) return true;
  if (/\/[A-Za-z0-9_-]+\/[A-Za-z0-9_./-]+/.test(text)) return true;
  return false;
};

const hasNaturalQuestion = (text: string): boolean => {
  const lower = lowerCase(text);
  const startsWith = [
    "how do i ", "how can i ", "what is ", "what's ", "why is ", "why does ",
    "can you ", "could you ", "should i ", "would you ",
    "help me ", "i want to ", "i need ", "i'd like ",
  ];
  return startsWith.some((s) => lower.startsWith(s)) || /\?\s*$/.test(text.trim());
};

/** Map a feature presence/count to a continuous signal strength ∈ [0, 1].
 *  Saturates at `saturate` — beyond that, additional matches don't
 *  raise the signal further. The shape is `min(1, n / saturate)`. */
const continuousFromCount = (n: number, saturate: number): number => {
  if (n <= 0) return 0;
  return Math.min(1, n / saturate);
};

/** Pure classifier — takes the owner's directive text (and optional
 *  prior owner_input_received texts) and returns a continuous signal
 *  vector. Each signal in the output is independent: high `code_density`
 *  does not imply low `explanation_appetite`. Universal: every owner
 *  is a unique vector. */
export const classifyOwnerRenderingSignals = (
  primaryText: string,
  priorTexts: readonly string[] = [],
): OwnerRenderingClassification => {
  const allText = [primaryText, ...priorTexts].join("\n");
  const signals: OwnerRenderingSignals = {};
  const evidence: string[] = [];

  // code_density: lights up on file paths, code identifiers, code-related
  // vocabulary. Continuous: more signals → higher value, saturates at 4.
  let codeFeatures = 0;
  const codeTokenCount = countMatches(allText, CODE_TOKENS);
  if (codeTokenCount > 0) {
    codeFeatures += codeTokenCount;
    evidence.push(`code_tokens:${codeTokenCount}`);
  }
  if (hasCodeIdentifiers(allText)) {
    codeFeatures += 2;
    evidence.push("code_identifiers");
  }
  if (hasFilePaths(allText)) {
    codeFeatures += 2;
    evidence.push("file_paths");
  }
  if (codeFeatures > 0) {
    signals.code_density = continuousFromCount(codeFeatures, 4);
  }

  // ops_vocabulary: lights up on operational/deployment/audit language.
  const opsTokenCount = countMatches(allText, OPS_TOKENS);
  if (opsTokenCount > 0) {
    signals.ops_vocabulary = continuousFromCount(opsTokenCount, 3);
    evidence.push(`ops_tokens:${opsTokenCount}`);
  }

  // explanation_appetite: lights up on natural-language question forms
  // (the owner is asking for explanation, not commanding). Also raised
  // when the text is short + has no code/ops signal (suggests an owner
  // who wants conversational guidance, not raw output).
  let explanationFeatures = 0;
  if (hasNaturalQuestion(primaryText)) {
    explanationFeatures += 2;
    evidence.push("natural_question");
  }
  if (allText.length < 200 && codeFeatures === 0 && opsTokenCount === 0) {
    explanationFeatures += 1;
    evidence.push("short_conversational_baseline");
  }
  if (explanationFeatures > 0) {
    signals.explanation_appetite = continuousFromCount(explanationFeatures, 3);
  }

  // Confidence: how many DIFFERENT signal dimensions fired? More
  // dimensions → more evidence that the classifier saw a real owner
  // (not a void / noise input). Saturates at 3 dimensions = 0.95.
  const dimensions = Object.keys(signals).length;
  const confidence = Math.min(0.95, Math.max(0.5, 0.5 + dimensions * 0.15));

  return { signals, confidence, evidence };
};
