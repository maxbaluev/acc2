// Phase 4 of the "generate-and-select" architecture: the verifiable /
// ambiguous router.
//
// Not every task needs the expensive generate-and-select machinery. Tasks
// dominated by OBJECTIVELY-CHECKABLE outcomes — code that compiles, tests
// that pass, arithmetic that resolves, data extracted from a named source —
// should route to a deterministic verifier ONLY: there is a ground truth,
// so spending a candidate budget + pairwise comparison + an owner
// preference is waste. Tasks dominated by SUBJECTIVE quality — persuasion,
// strategy, writing, taste — have no single ground truth; those route to
// generate-and-select, where diversity + provenance-filtering + sparse
// owner preference is exactly the right spend.
//
// This is a small, transparent heuristic predictor. It is intentionally
// learnable later (the same posterior machinery that ranks act_artifacts
// can rank a routing predictate row) — but the bootstrap rule is honest
// keyword evidence with a safe default: when the signal is weak or
// balanced, route to `ambiguous`. Over-verifying a verifiable task wastes
// budget; under-verifying an ambiguous one ships slop. Spending MORE
// verification is the safe error, so unsure -> ambiguous.

export type TaskRoute = "verifiable" | "ambiguous";

export type TaskRouteResult = {
  route: TaskRoute;
  /** [0,1] — how strongly the dominant signal class outweighs the other.
   *  Low confidence means the classes were close (or no signal at all),
   *  in which case the route defaults to `ambiguous`. */
  confidence: number;
  /** The matched keyword signals, prefixed with their class, in match
   *  order. Transparent so the routing decision is auditable. */
  signals: string[];
};

// Objectively-checkable: a deterministic verifier can return a residual
// without taste. Code/tests/math/data-extraction/arithmetic/source
// resolution.
const VERIFIABLE_KEYWORDS: string[] = [
  "compile", "compiles", "build", "test", "tests", "unit test", "passes",
  "function", "implement", "bug", "fix the", "stack trace", "type error",
  "lint", "refactor", "regex", "parse", "calculate", "compute", "arithmetic",
  "sum", "average", "count", "math", "equation", "solve for", "derive",
  "extract", "extraction", "scrape", "query", "sql", "json", "csv",
  "look up", "resolve", "fetch the", "api", "endpoint", "schema", "validate",
  "checksum", "hash", "convert", "deduplicate", "sort", "filter rows",
];

// Subjective: persuasion / strategy / writing / quality / taste. No single
// ground truth; diversity + provenance filter + sparse owner preference.
const AMBIGUOUS_KEYWORDS: string[] = [
  "persuasive", "persuade", "convince", "compelling", "pitch", "narrative",
  "story", "tone", "voice", "style", "elegant", "beautiful", "creative",
  "brainstorm", "ideas", "strategy", "strategic", "vision", "positioning",
  "messaging", "marketing", "copy", "headline", "tagline", "write",
  "draft", "essay", "report", "memo", "letter", "email to", "summary",
  "summarize", "explain to", "recommend", "advice", "opinion", "best way",
  "improve", "polish", "rewrite", "engaging", "audience", "ceo", "executive",
  "investor", "customer", "tradeoff", "prioritize", "should we", "design the",
];

const matchKeywords = (haystack: string, keywords: string[]): string[] => {
  const found: string[] = [];
  for (const kw of keywords) {
    if (haystack.includes(kw)) found.push(kw);
  }
  return found;
};

export function classifyTask(task: string): TaskRouteResult {
  const text = task.toLowerCase();
  const verifiableHits = matchKeywords(text, VERIFIABLE_KEYWORDS);
  const ambiguousHits = matchKeywords(text, AMBIGUOUS_KEYWORDS);

  const signals: string[] = [
    ...verifiableHits.map((k) => `verifiable:${k}`),
    ...ambiguousHits.map((k) => `ambiguous:${k}`),
  ];

  const v = verifiableHits.length;
  const a = ambiguousHits.length;
  const total = v + a;

  // No signal at all -> safe default. Spending more verification is the
  // safe error, so route to generate-and-select.
  if (total === 0) {
    return { route: "ambiguous", confidence: 0, signals };
  }

  // Confidence is the margin of the dominant class over the total signal.
  // A clean 3-0 split is high confidence; a 2-2 split is zero confidence.
  const margin = Math.abs(v - a) / total;

  // Verifiable only wins when it STRICTLY dominates. Ties and ambiguous-
  // dominant both route to ambiguous (the safe error). We also require a
  // minimum margin so a single stray verifiable keyword inside an
  // otherwise-subjective task does not flip the route.
  const VERIFIABLE_MARGIN = 0.34; // > a single 1-of-3 lean
  if (v > a && margin >= VERIFIABLE_MARGIN) {
    return { route: "verifiable", confidence: margin, signals };
  }

  return { route: "ambiguous", confidence: a >= v ? margin : 0, signals };
}
