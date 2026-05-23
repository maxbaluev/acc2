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

// ── Universal three-way goal route ────────────────────────────────────────
//
// The 2-way `verifiable | ambiguous` split above answers "does this need a
// deterministic verifier or generate-and-select?" — it is consumed by
// solve_loop, which spends a candidate budget on everything that is not
// strictly verifiable. But the daemon dispatch hook needs a FINER question:
// can the generate-and-select organism produce the WHOLE answer in one shot,
// or does the goal need the brain to decompose it into steps first?
//
//   verifiable        — objectively checkable answer (code/math/data/
//                        arithmetic). One ground truth; deterministic verifier.
//   single_deliverable — produce ONE artifact/answer where generate-and-select
//                        fits (write/answer/draft/summarize/name/recommend a
//                        SINGLE thing). No ground truth; diversity + provenance
//                        filter + sparse owner preference.
//   complex           — multi-step / strategic / decomposable goal that needs
//                        planning (design a system, run a multi-phase project,
//                        "figure out and do X" across steps). The brain
//                        decomposes; generate-and-select applies at the leaves.
//
// This is additive: `classifyTask` (the 2-way API) is unchanged, so every
// existing caller keeps working. `classifyGoal` layers the complex/single
// distinction on top of the same keyword evidence.

export type GoalRoute = "verifiable" | "single_deliverable" | "complex";

export type GoalRouteResult = {
  route: GoalRoute;
  /** [0,1] confidence in the dominant route. */
  confidence: number;
  /** Matched keyword signals, prefixed with their class, for auditability. */
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

// Multi-step / strategic / decomposable: the goal is not a single artifact
// but a project or system that must be PLANNED and built across steps. These
// signal that the brain should decompose before generate-and-select can apply
// at any leaf. "design THE/A system", "build THE/A platform", "run a
// multi-phase project", "figure out and do X", "architect", "end-to-end".
const COMPLEX_KEYWORDS: string[] = [
  "design the", "design a", "design and implement", "implement the",
  "build the", "build a", "build an", "architect", "architecture",
  "end to end", "end-to-end", "multi-step", "multi step", "multi-phase",
  "multi phase", "multiple phases", "step by step", "step-by-step",
  "figure out and", "research and", "plan and execute", "plan and build",
  "roll out", "rollout", "migrate the", "migration", "overhaul",
  "from scratch", "across steps", "orchestrate", "coordinate the",
  "pipeline", "system for", "platform for", "framework for", "set up the",
  "stand up the", "launch the", "run a campaign", "run a project",
  "strategy and execution", "and then",
];

// Single-deliverable verbs/nouns: produce ONE artifact or answer. These are
// the goals generate-and-select serves directly without decomposition.
const SINGLE_DELIVERABLE_KEYWORDS: string[] = [
  "write a", "write an", "write me", "draft a", "draft an", "compose a",
  "answer", "summarize", "summary of", "summarise", "name a", "name some",
  "names for", "suggest", "recommend a", "recommend the", "give me a",
  "explain", "describe", "list a", "list the", "list some", "haiku",
  "poem", "tagline", "headline", "slogan", "caption", "title for",
  "subject line", "one-liner", "tweet", "paragraph about", "short",
  "a single", "one ", "respond to", "reply to",
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

/**
 * Universal three-way goal classifier used by the daemon dispatch hook.
 *
 * Layers the complex/single distinction on top of the same keyword evidence
 * `classifyTask` uses, so the organism can serve ANY single-shot goal while
 * complex (decomposable) goals still fall through to the brain.
 *
 * Decision order:
 *   1. COMPLEX — multi-step / strategic / decomposable. When complex signals
 *      are present AND outweigh single-deliverable signals, the brain must
 *      decompose first; do NOT hand the whole goal to the organism. This is
 *      checked FIRST: a goal like "design and implement the architecture"
 *      reads `implement` as a verifiable keyword, but it is genuinely a
 *      multi-step build — the complex framing dominates a stray verifiable
 *      token. (A clean, dominant verifiable signal with NO complex framing
 *      still routes verifiable in step 2.)
 *   2. VERIFIABLE — objectively checkable answer (code/math/data/arithmetic),
 *      as decided by `classifyTask`, when no dominant complex framing is
 *      present. There is a ground truth, so generate-and-select runs its
 *      deterministic single-candidate path.
 *   3. SINGLE_DELIVERABLE — everything else (including the safe default).
 *      Produce ONE artifact/answer; generate-and-select fits directly. This
 *      is the safe default because the organism is non-destructive: it
 *      proposes a candidate and the owner/verifier judges it. Spending the
 *      organism on a goal that should have decomposed wastes a candidate
 *      budget but ships nothing; only a confident complex signal opts out.
 */
export function classifyGoal(task: string): GoalRouteResult {
  const text = task.toLowerCase();

  const base = classifyTask(task);
  const complexHits = matchKeywords(text, COMPLEX_KEYWORDS);
  const singleHits = matchKeywords(text, SINGLE_DELIVERABLE_KEYWORDS);
  const signals: string[] = [
    ...base.signals,
    ...complexHits.map((k) => `complex:${k}`),
    ...singleHits.map((k) => `single:${k}`),
  ];
  const c = complexHits.length;
  const s = singleHits.length;

  // 1. COMPLEX — present and not outweighed by an explicit single-deliverable
  //    framing. Checked before verifiable so a multi-step build phrased with a
  //    stray verifiable token ("implement") still decomposes. A goal that says
  //    both "design the system" AND "write a haiku" is contradictory; the
  //    complex framing dominates because decomposition is the conservative
  //    choice (the brain can still emit a single leaf).
  if (c > 0 && c >= s) {
    const total = c + s;
    return { route: "complex", confidence: total > 0 ? c / total : 1, signals };
  }

  // 2. VERIFIABLE — clean checkable answer with no dominant complex framing.
  if (base.route === "verifiable") {
    return { route: "verifiable", confidence: base.confidence, signals };
  }

  // 3. SINGLE_DELIVERABLE — the safe, non-destructive default.
  const total = c + s;
  return {
    route: "single_deliverable",
    confidence: total > 0 ? s / total : 0,
    signals,
  };
}
