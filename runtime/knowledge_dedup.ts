// Emit-time dedup gate for knowledge_candidate (δ-mem follow-up,
// 2026-05-17). Pre-fix the brain freely emitted near-identical claims —
// live ledger evidence over 24h: 770 knowledge_candidate emissions
// produced 8807 candidate_confirmed rows (~11x duplication). The
// extractor-side cosine merger cleaned these up post-hoc but δ-mem's
// failure-mode framing (independently reached by the brain in directive
// Z8JQJB2S, knowledge_candidate KDX9K3NG) is that duplicate clusters
// produce ARTIFICIAL CONFIDENCE in the merged knowledge — the brain
// re-stating the same claim 10 times shouldn't promote it 10x faster
// than a genuinely-novel claim. The structural fix is to refuse the
// duplicate at the emit boundary and return the existing event's id so
// the brain sees first-wins semantics and gets explicit "you already
// said this" feedback.
//
// Stage 1 (this module): cheap token-set Jaccard similarity against the
// last N candidates on the same (directive, substrate_origin) within
// the recency window. Fast — no embedding API calls. Refuses on
// Jaccard ≥ threshold. Most candidates fall through immediately.
//
// Stage 2 (future): when Stage 1 says "near-duplicate", optionally
// confirm with cosine similarity against precomputed embeddings. Not
// implemented yet — Jaccard alone catches the structural duplication
// the brain produces and the embedding worker still runs separately for
// the canonical merger. Iterate based on evidence.

import type { Database } from "bun:sqlite";

/** Recency window for the dedup scan. Candidates older than this are
 *  not considered as "you already said this" matches. Brain emissions
 *  on the SAME directive within an hour are the dominant duplication
 *  pattern in the live ledger. */
export const KNOWLEDGE_DEDUP_WINDOW_MS = Number(
  process.env.ACC2_KNOWLEDGE_DEDUP_WINDOW_MS ?? 60 * 60 * 1000,
);

/** Token-set Jaccard threshold above which a new claim is refused.
 *  0.85 is intentionally strict — Jaccard tends to be more sensitive
 *  than cosine over short text, so the threshold needs to be high to
 *  avoid false positives on legitimately-distinct claims that share
 *  vocabulary (e.g. two claims about the same subsystem). */
export const KNOWLEDGE_DEDUP_JACCARD_THRESHOLD = Number(
  process.env.ACC2_KNOWLEDGE_DEDUP_JACCARD_THRESHOLD ?? 0.85,
);

/** Cap on the number of recent candidates we scan per emit. Bounded so
 *  a directive with hundreds of prior candidates doesn't stall the
 *  emit hot path. The dominant case (brain restating in the same
 *  cycle) is caught with N=20. */
export const KNOWLEDGE_DEDUP_SCAN_LIMIT = Number(
  process.env.ACC2_KNOWLEDGE_DEDUP_SCAN_LIMIT ?? 20,
);

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "than",
  "then", "have", "has", "had", "was", "were", "are", "is", "be",
  "been", "being", "but", "not", "any", "all", "can", "could",
  "should", "would", "will", "shall", "may", "might", "must", "of",
  "in", "to", "a", "an", "or", "on", "at", "by", "as", "it", "its",
  "we", "our", "ours", "you", "your", "they", "their", "i", "me",
  "my", "do", "does", "did", "if", "when", "where", "what", "which",
  "who", "whom", "how", "why",
]);

/** Extract a token-set from a claim string: lowercase, split on
 *  non-alphanumerics, drop stop words and short tokens, dedupe via Set. */
export const tokenize = (text: string): Set<string> => {
  const out = new Set<string>();
  if (typeof text !== "string" || text.length === 0) return out;
  const lower = text.toLowerCase();
  for (const raw of lower.split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    if (STOP_WORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
};

/** Jaccard similarity = |A ∩ B| / |A ∪ B|. Returns 0 when both empty
 *  (so empty text never registers as a dedup match). */
export const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 && b.size === 0) return 0;
  let intersect = 0;
  for (const t of a) if (b.has(t)) intersect++;
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
};

export type DedupMatch = {
  matched_event_id: string;
  matched_ts: string;
  similarity: number;
  method: "jaccard";
  scanned_count: number;
};

export type DedupOpts = {
  /** Window cutoff override (ms ago). Default: KNOWLEDGE_DEDUP_WINDOW_MS. */
  windowMs?: number;
  /** Jaccard threshold override. Default: KNOWLEDGE_DEDUP_JACCARD_THRESHOLD. */
  threshold?: number;
  /** Scan limit override. Default: KNOWLEDGE_DEDUP_SCAN_LIMIT. */
  scanLimit?: number;
};

/** Find the nearest recent knowledge_candidate to the supplied claim
 *  text, scoped to the same (directive_id, substrate_origin). Returns
 *  null when no candidate within the window meets the threshold.
 *
 *  Scope rules:
 *    - SAME author (substrate_origin) — brain self-duplication is the
 *      target. We do NOT cross-author dedup: a brain candidate and a
 *      claude candidate making the same claim are independent
 *      evidence and should both stand.
 *    - SAME directive_id — different directives are independent
 *      contexts.
 *    - WITHIN windowMs of now — old candidates may legitimately be
 *      re-stated as the situation changes; we only refuse "same cycle
 *      restating".
 *
 *  Pure read; no mutation. The caller decides whether to refuse +
 *  emit knowledge_candidate_redundant. */
export const findSimilarRecentCandidate = (
  db: Database,
  args: {
    claim: string;
    directive_id: string;
    substrate_origin: string;
  },
  opts: DedupOpts = {},
): DedupMatch | null => {
  const newTokens = tokenize(args.claim);
  if (newTokens.size < 2) return null; // too thin to dedup meaningfully

  const windowMs = opts.windowMs ?? KNOWLEDGE_DEDUP_WINDOW_MS;
  const threshold = opts.threshold ?? KNOWLEDGE_DEDUP_JACCARD_THRESHOLD;
  const scanLimit = opts.scanLimit ?? KNOWLEDGE_DEDUP_SCAN_LIMIT;
  const cutoffIso = new Date(Date.now() - windowMs).toISOString();

  const rows = db
    .query(
      `SELECT id, ts, payload FROM events
       WHERE kind = 'knowledge_candidate'
         AND directive_id = ?
         AND substrate_origin = ?
         AND ts >= ?
       ORDER BY ts DESC LIMIT ?`,
    )
    .all(args.directive_id, args.substrate_origin, cutoffIso, scanLimit) as Array<{
      id: string;
      ts: string;
      payload: string;
    }>;

  let bestId: string | null = null;
  let bestTs: string | null = null;
  let bestSim = 0;
  for (const row of rows) {
    let claim: string | undefined;
    try {
      const p = JSON.parse(row.payload ?? "{}") as Record<string, unknown>;
      claim = typeof p.claim === "string" ? p.claim : undefined;
    } catch { continue; }
    if (!claim) continue;
    const tokens = tokenize(claim);
    const sim = jaccard(newTokens, tokens);
    if (sim > bestSim) {
      bestSim = sim;
      bestId = row.id;
      bestTs = row.ts;
    }
  }

  if (bestSim < threshold || bestId === null || bestTs === null) return null;
  return {
    matched_event_id: bestId,
    matched_ts: bestTs,
    similarity: bestSim,
    method: "jaccard",
    scanned_count: rows.length,
  };
};
