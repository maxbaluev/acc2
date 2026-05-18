// acc2 predicate_gate verifier — structural admission gate for
// code_artifact_candidate bodies destined for high-stakes audiences
// (ceo_buyer, external_executive). Closes the advisory-vs-structural
// failure mode (k_252) demonstrated 2026-05-18 by brain w2 self-scan:
// the scan emitted "lake_v7_predicate_scan_zero_hits" while the body
// still contained "friction" (banned by alex_predicate XKC5N4A66S13),
// "modest" (banned by 9Z4JFRS3M5), and inconsistent "Hi Vis" vs
// "Hi-Vis" — all of which had to be scrubbed manually before delivery.
//
// Design: substrate-side regex/structural check. For each
// alex_predicate_* knowledge_candidate that applies to the audience,
// match the candidate's predicate_pattern (when stored in the KC
// payload) against the body. Fall back to an inline canonical catalog
// for the live predicates whose patterns are NOT stored in payload.
//
// residual = 1.0 if any predicate matches; 0.0 otherwise. v1 is
// binary — a future revision can introduce a gray-band (0.3-0.7) for
// ambiguous contexts (e.g. "modest" inside a quoted source) by
// inspecting the matched_text's surrounding_context.

import type { Database } from "bun:sqlite";

/** Audiences for which the gate is structurally active. Other
 *  audiences (or undefined) skip the gate entirely. */
const GATED_AUDIENCES: ReadonlySet<string> = new Set([
  "ceo_buyer",
  "external_executive",
]);

export type PredicateMatch = {
  kc_id: string;
  predicate_claim: string;
  matched_text: string;
  offset: number;
  surrounding_context: string;
};

export type PredicateGateResult = {
  residual: number;
  rejected: boolean;
  matches: PredicateMatch[];
  citedKnowledgeIds: string[];
};

/** Canonical fallback catalog of predicate patterns. These are the
 *  patterns active 2026-05-18 whose KC payload does NOT carry a
 *  `predicate_pattern` field. When a future KC declares
 *  predicate_pattern in payload, the DB-loaded entry supersedes the
 *  matching catalog entry by kc_id. */
type CatalogEntry = {
  kc_id: string;
  predicate_claim: string;
  pattern: RegExp;
};

const CATALOG: CatalogEntry[] = [
  {
    kc_id: "alex_predicate_xkc5n4a66s13_no_friction",
    predicate_claim: "alex_predicate_no_friction",
    pattern: /\bfriction\b/gi,
  },
  {
    kc_id: "alex_predicate_9z4jfrs3m5_no_vague_magnitude",
    predicate_claim: "alex_predicate_no_vague_magnitude",
    pattern: /\b(modest|significant|substantial|several|small set|small number)\b/gi,
  },
  {
    kc_id: "alex_predicate_system_meta_v2_no_internal_substrate_language",
    predicate_claim: "alex_predicate_no_internal_substrate_language",
    // "the system" added 2026-05-18 (dark-gate sweep): the v9 Lakeland
    // body NA9XCQ41YH1013MSTK1DVE9H9W carried 7 hits of "the system"
    // that the manual scan flagged and the operator scrubbed before
    // delivery. The pre-existing pattern matched "the substrate" /
    // "the brain" but not "the system" — an oversight rather than a
    // deliberate carve-out. Adding it closes the gap.
    pattern:
      /\b(first cycle|next cycle|the substrate|the system|the brain|learning advantage|the moat|Why This Order|honesty signal)\b/gi,
  },
  {
    kc_id: "alex_predicate_no_hyphen_jargon",
    predicate_claim: "alex_predicate_no_hyphen_jargon",
    pattern:
      /\b(China-plus-one|cut-and-sew|tender-driven|AI-heavy|data spine|design sprint)\b/gi,
  },
  {
    kc_id: "alex_predicate_no_version_markers_in_title",
    predicate_claim: "alex_predicate_no_version_markers_in_title",
    pattern: /\bv[1-9][0-9]*\b/g,
  },
];

/** Load alex_predicate_* knowledge_candidates from the events ledger
 *  whose payload declares `predicate_pattern` (and optionally an
 *  `audience` filter). KCs without predicate_pattern stay implicit and
 *  are matched via the inline CATALOG. */
const loadPredicatesFromKnowledge = (
  db: Database,
  audience: string,
): CatalogEntry[] => {
  let rows: Array<{ id: string; payload: string }>;
  try {
    rows = db
      .query(
        `SELECT id, payload FROM events
         WHERE kind = 'knowledge_candidate'
           AND (payload LIKE '%alex_predicate_%')`,
      )
      .all() as Array<{ id: string; payload: string }>;
  } catch {
    return [];
  }
  const entries: CatalogEntry[] = [];
  for (const row of rows) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    const claim =
      (parsed.claim as string | undefined) ??
      (parsed.text as string | undefined) ??
      "";
    if (!claim.includes("alex_predicate_")) continue;
    // Audience filter: if the KC declares an audience scope, honor it.
    // Otherwise the predicate applies universally to GATED_AUDIENCES.
    const audienceTags = parsed.audience_tags;
    if (Array.isArray(audienceTags) && audienceTags.length > 0) {
      const matchAudience = audienceTags.some(
        (t) => typeof t === "string" && t === audience,
      );
      if (!matchAudience) continue;
    }
    const patternSrc = parsed.predicate_pattern;
    if (typeof patternSrc !== "string" || patternSrc.length === 0) continue;
    let regex: RegExp;
    try {
      const flags =
        typeof parsed.predicate_pattern_flags === "string"
          ? (parsed.predicate_pattern_flags as string)
          : "gi";
      regex = new RegExp(patternSrc, flags);
    } catch {
      continue;
    }
    entries.push({
      kc_id: row.id,
      predicate_claim: claim,
      pattern: regex,
    });
  }
  return entries;
};

/** Build the surrounding-context window for a match: 40 chars before +
 *  the matched text + 40 chars after, with newlines collapsed. */
const buildContext = (body: string, matchOffset: number, matchLen: number): string => {
  const start = Math.max(0, matchOffset - 40);
  const end = Math.min(body.length, matchOffset + matchLen + 40);
  return body.slice(start, end).replace(/\s+/g, " ").trim();
};

export const runPredicateGate = (
  db: Database,
  args: { audience?: string; body: string; sourceCandidateId?: string },
): PredicateGateResult => {
  const audience = args.audience;
  // Skip when audience is unset or not in the gated set.
  if (!audience || !GATED_AUDIENCES.has(audience)) {
    return { residual: 0, rejected: false, matches: [], citedKnowledgeIds: [] };
  }

  const body = args.body ?? "";
  if (body.length === 0) {
    return { residual: 0, rejected: false, matches: [], citedKnowledgeIds: [] };
  }

  // Merge: DB-declared predicates (when present) supersede catalog
  // entries with the same kc_id; remaining catalog entries fill in
  // the implicit predicates.
  const dbEntries = loadPredicatesFromKnowledge(db, audience);
  const dbKcIds = new Set(dbEntries.map((e) => e.kc_id));
  const effective: CatalogEntry[] = [
    ...dbEntries,
    ...CATALOG.filter((c) => !dbKcIds.has(c.kc_id)),
  ];

  const matches: PredicateMatch[] = [];
  const cited = new Set<string>();
  for (const entry of effective) {
    // Reset regex lastIndex defensively when the regex is /g.
    const re = new RegExp(
      entry.pattern.source,
      entry.pattern.flags.includes("g") ? entry.pattern.flags : `${entry.pattern.flags}g`,
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const matchedText = m[0];
      const offset = m.index;
      matches.push({
        kc_id: entry.kc_id,
        predicate_claim: entry.predicate_claim,
        matched_text: matchedText,
        offset,
        surrounding_context: buildContext(body, offset, matchedText.length),
      });
      cited.add(entry.kc_id);
      // Defensive bail to avoid pathological regexes that match empty
      // strings — advance lastIndex if the match is zero-length.
      if (matchedText.length === 0) re.lastIndex++;
    }
  }

  const rejected = matches.length > 0;
  return {
    residual: rejected ? 1.0 : 0.0,
    rejected,
    matches,
    citedKnowledgeIds: [...cited],
  };
};
