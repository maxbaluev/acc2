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
  /** ISO 639-1 code for the highest-confidence language candidate.
   *  Absent only when the text has no alphabetic evidence. */
  detected_language?: string;
  /** Confidence-weighted language candidates. Script evidence keeps non-Latin
   *  paths broad; lightweight stopword evidence disambiguates common Latin-
   *  script languages. The substrate can accumulate these observations over
   *  multiple turns instead of treating one turn as certainty. */
  language_distribution?: Array<{ lang: string; confidence: number; evidence: string }>;
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

type LanguageCandidate = { lang: string; confidence: number; evidence: string };

type ScriptBucket = { key: string; lang: string; label: string; count: number };

const LATIN_STOPWORDS: Record<string, readonly string[]> = {
  en: ["the", "and", "with", "help", "please", "what", "should", "work"],
  es: ["el", "la", "los", "las", "que", "con", "para", "por", "ayuda", "sistema"],
  fr: ["le", "la", "les", "des", "que", "avec", "pour", "aide", "système"],
  de: ["der", "die", "das", "und", "mit", "für", "hilfe", "system"],
  pt: ["o", "a", "os", "as", "que", "com", "para", "ajuda", "sistema"],
  it: ["il", "lo", "la", "gli", "che", "con", "per", "aiuta", "sistema"],
  vi: ["tôi", "và", "với", "cho", "giúp", "hệ", "thống"],
  id: ["dan", "yang", "dengan", "untuk", "bantu", "sistem"],
  tr: ["ve", "ile", "için", "yardım", "sistem", "bana"],
  sw: ["na", "kwa", "ya", "msaada", "mfumo"],
  tl: ["ang", "ng", "sa", "para", "tulong", "sistema"],
};

const latinLanguageCandidates = (text: string, latinPct: number): LanguageCandidate[] => {
  const words = lowerCase(text).match(/[\p{L}]+/gu) ?? [];
  const scores = Object.entries(LATIN_STOPWORDS)
    .map(([lang, stops]) => ({ lang, hits: words.filter((w) => stops.includes(w)).length }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits);
  if (scores.length === 0) return [{ lang: "en", confidence: Math.min(0.8, latinPct), evidence: `Latin script ${Math.round(latinPct * 100)}%` }];
  const maxHits = scores[0]!.hits;
  return scores.slice(0, 3).map((s) => ({
    lang: s.lang,
    confidence: Math.min(0.95, latinPct * (0.55 + 0.1 * Math.min(s.hits, 4)) * (s.hits / maxHits)),
    evidence: `Latin script ${Math.round(latinPct * 100)}% + stopwords:${s.hits}`,
  }));
};

const detectLanguageDistribution = (text: string): LanguageCandidate[] => {
  const buckets: ScriptBucket[] = [
    { key: "cyr", lang: "ru", label: "Cyrillic block", count: 0 },
    { key: "cjk", lang: "zh", label: "CJK Unified", count: 0 },
    { key: "hir", lang: "ja", label: "Hiragana", count: 0 },
    { key: "kat", lang: "ja", label: "Katakana", count: 0 },
    { key: "han", lang: "ko", label: "Hangul Syllables", count: 0 },
    { key: "ara", lang: "ar", label: "Arabic block", count: 0 },
    { key: "heb", lang: "he", label: "Hebrew block", count: 0 },
    { key: "dev", lang: "hi", label: "Devanagari block", count: 0 },
    { key: "tam", lang: "ta", label: "Tamil block", count: 0 },
    { key: "tel", lang: "te", label: "Telugu block", count: 0 },
    { key: "kan", lang: "kn", label: "Kannada block", count: 0 },
    { key: "ben", lang: "bn", label: "Bengali block", count: 0 },
    { key: "tha", lang: "th", label: "Thai block", count: 0 },
    { key: "lao", lang: "lo", label: "Lao block", count: 0 },
    { key: "khm", lang: "km", label: "Khmer block", count: 0 },
    { key: "mya", lang: "my", label: "Burmese block", count: 0 },
    { key: "geo", lang: "ka", label: "Georgian block", count: 0 },
    { key: "arm", lang: "hy", label: "Armenian block", count: 0 },
    { key: "eth", lang: "am", label: "Ethiopic block", count: 0 },
    { key: "tib", lang: "bo", label: "Tibetan block", count: 0 },
    { key: "lat", lang: "en", label: "Latin block", count: 0 },
  ];
  const byKey = new Map(buckets.map((b) => [b.key, b]));
  let alpha = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    let key: string | undefined;
    if (cp >= 0x0400 && cp <= 0x052f) key = "cyr";
    else if (cp >= 0x4e00 && cp <= 0x9fff) key = "cjk";
    else if (cp >= 0x3040 && cp <= 0x309f) key = "hir";
    else if (cp >= 0x30a0 && cp <= 0x30ff) key = "kat";
    else if (cp >= 0xac00 && cp <= 0xd7af) key = "han";
    else if (cp >= 0x0600 && cp <= 0x06ff) key = "ara";
    else if (cp >= 0x0590 && cp <= 0x05ff) key = "heb";
    else if (cp >= 0x0900 && cp <= 0x097f) key = "dev";
    else if (cp >= 0x0b80 && cp <= 0x0bff) key = "tam";
    else if (cp >= 0x0c00 && cp <= 0x0c7f) key = "tel";
    else if (cp >= 0x0c80 && cp <= 0x0cff) key = "kan";
    else if (cp >= 0x0980 && cp <= 0x09ff) key = "ben";
    else if (cp >= 0x0e00 && cp <= 0x0e7f) key = "tha";
    else if (cp >= 0x0e80 && cp <= 0x0eff) key = "lao";
    else if (cp >= 0x1780 && cp <= 0x17ff) key = "khm";
    else if (cp >= 0x1000 && cp <= 0x109f) key = "mya";
    else if (cp >= 0x10a0 && cp <= 0x10ff) key = "geo";
    else if (cp >= 0x0530 && cp <= 0x058f) key = "arm";
    else if (cp >= 0x1200 && cp <= 0x137f) key = "eth";
    else if (cp >= 0x0f00 && cp <= 0x0fff) key = "tib";
    else if ((cp >= 0x0041 && cp <= 0x005a) || (cp >= 0x0061 && cp <= 0x007a) || (cp >= 0x00c0 && cp <= 0x024f)) key = "lat";
    if (!key) continue;
    byKey.get(key)!.count++;
    alpha++;
  }
  if (alpha === 0) return [];
  const jp = (byKey.get("hir")!.count + byKey.get("kat")!.count) / alpha;
  const merged = new Map<string, LanguageCandidate>();
  for (const b of buckets) {
    if (b.count === 0) continue;
    if (b.lang === "zh" && jp > 0) continue;
    const confidence = b.count / alpha;
    const cand = { lang: b.lang, confidence, evidence: `${b.label} ${Math.round(confidence * 100)}%` };
    const prev = merged.get(cand.lang);
    merged.set(cand.lang, prev ? { lang: cand.lang, confidence: prev.confidence + cand.confidence, evidence: `${prev.evidence}; ${cand.evidence}` } : cand);
  }
  const latin = merged.get("en");
  if (latin) {
    merged.delete("en");
    for (const cand of latinLanguageCandidates(text, latin.confidence)) merged.set(cand.lang, cand);
  }
  return Array.from(merged.values()).filter((c) => c.confidence >= 0.3).sort((a, b) => b.confidence - a.confidence);
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

  // detected_language: confidence-weighted distribution from script dominance
  // plus Latin stopwords. Runs BEFORE the signal-extraction logic so the
  // renderer can pick a language even when no other signal fires.
  const languageDistribution = detectLanguageDistribution(allText);
  const detectedLanguage = languageDistribution[0]?.lang;
  if (languageDistribution.length > 0) {
    const top = languageDistribution[0]!;
    evidence.push(`detected_language=${top.lang} (${top.evidence}; confidence=${top.confidence.toFixed(2)})`);
  }

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

  return detectedLanguage !== undefined
    ? { signals, confidence, evidence, detected_language: detectedLanguage, language_distribution: languageDistribution }
    : { signals, confidence, evidence };
};
