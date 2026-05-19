// acc2 predicate_gate verifier — structural admission gate for
// act_artifact_candidate bodies destined for high-stakes audiences
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

/** F2 (2026-05-18): the gate previously skipped EVERYTHING outside
 *  {ceo_buyer, external_executive}. Letter v3 shipped through with
 *  audience="cofounder_technical_reviewer" → zero predicate matches
 *  even though "the system" appeared three times. The gate now runs
 *  by default for every audience (and for audience=null/undefined);
 *  per-predicate `audience_allowlist` / `audience_denylist` provides
 *  the fine-grained carve-out so the substrate signing its own
 *  cofounder letters with "the system" is not refused while CEO-buyer
 *  documents stay strict. EXEMPT_AUDIENCES is the explicit skip set
 *  for known-internal contexts where no gate should fire. */
const EXEMPT_AUDIENCES: ReadonlySet<string> = new Set([
  "internal_diagnostic",
]);

/** Returns true when a predicate's audience filter says the predicate
 *  applies to the given audience. Default (no allowlist + no denylist)
 *  → applies. Allowlist hit → SKIP (audience exempt). Denylist set →
 *  applies ONLY if audience is in denylist. */
const predicateAppliesToAudience = (
  entry: { audience_allowlist?: readonly string[]; audience_denylist?: readonly string[] },
  audience: string | null,
): boolean => {
  if (entry.audience_allowlist && entry.audience_allowlist.length > 0) {
    if (audience !== null && entry.audience_allowlist.includes(audience)) return false;
  }
  if (entry.audience_denylist && entry.audience_denylist.length > 0) {
    if (audience === null) return false;
    return entry.audience_denylist.includes(audience);
  }
  return true;
};

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
 *  matching catalog entry by kc_id.
 *
 *  F2 audience-conditional (2026-05-18): each entry MAY declare
 *  `audience_allowlist` and/or `audience_denylist` so a predicate can
 *  carve out audiences where the pattern is appropriate self-reference
 *  (substrate signing its own cofounder letters) without disabling the
 *  pattern for the rest of the gated set. When BOTH lists are absent
 *  the predicate applies universally. */
type CatalogEntry = {
  kc_id: string;
  predicate_claim: string;
  pattern: RegExp;
  audience_allowlist?: readonly string[];
  audience_denylist?: readonly string[];
};

// F2 (2026-05-18): the audiences for which content-quality predicates
// fire by default. The buyer-class predicates use denylist scoping so
// the gate runs ONLY for these audiences; audience=null falls through.
// The system_meta predicate behaves differently — it uses an explicit
// allowlist (only the substrate-self-identification audiences are
// exempt) AND a buyer-class denylist so internal code bodies with
// comments like "the brain decides" don't trip the gate.
const BUYER_FACING_AUDIENCES = [
  "ceo_buyer",
  "external_executive",
  "cofounder_technical_reviewer",
  "cofounder_technical_reviewer_unfamiliar_with_implementation",
] as const;

const CATALOG: CatalogEntry[] = [
  {
    kc_id: "alex_predicate_xkc5n4a66s13_no_friction",
    predicate_claim: "alex_predicate_no_friction",
    pattern: /\bfriction\b/gi,
    audience_denylist: [...BUYER_FACING_AUDIENCES],
  },
  {
    kc_id: "alex_predicate_9z4jfrs3m5_no_vague_magnitude",
    predicate_claim: "alex_predicate_no_vague_magnitude",
    pattern: /\b(modest|significant|substantial|several|small set|small number)\b/gi,
    audience_denylist: [...BUYER_FACING_AUDIENCES],
  },
  {
    kc_id: "alex_predicate_system_meta_v2_no_internal_substrate_language",
    predicate_claim: "alex_predicate_no_internal_substrate_language",
    // F2 (2026-05-18): "the system" is appropriate self-reference when
    // the substrate signs its own cofounder letters or technical
    // postmortems. The audience_allowlist below exempts the three
    // self-identification audiences. NO denylist — the predicate
    // applies to every audience EXCEPT the allowlisted ones, including
    // audience=null (F2 spec: default applies). Internal code-artifact
    // admissions (no audience declared) skip this entire gate via
    // artifact_admission.ts:195 (admission only runs predicates when
    // input.audience is explicitly set). Letter v3 (artifact
    // XZ5WPBJ9AH3EQ684EWHF0MJJB4) shipped to the cofounder reviewer
    // audience with 3 "the system" hits and zero predicate_gate_rejected
    // events — the gate had no audience discrimination. This allowlist
    // closes that gap without enabling the phrase for buyer-facing copy.
    pattern:
      /\b(first cycle|next cycle|the substrate|the system|the brain|learning advantage|the moat|Why This Order|honesty signal)\b/gi,
    audience_allowlist: [
      "cofounder_technical_reviewer_unfamiliar_with_implementation",
      "cofounder_technical_reviewer",
      "substrate_self_identification",
    ],
  },
  {
    kc_id: "alex_predicate_no_hyphen_jargon",
    predicate_claim: "alex_predicate_no_hyphen_jargon",
    pattern:
      /\b(China-plus-one|cut-and-sew|tender-driven|AI-heavy|data spine|design sprint)\b/gi,
    audience_denylist: [...BUYER_FACING_AUDIENCES],
  },
  {
    kc_id: "alex_predicate_no_version_markers_in_title",
    predicate_claim: "alex_predicate_no_version_markers_in_title",
    // F2 (2026-05-18): version markers like "v6" / "v9" are noise to
    // buyer-facing copy but appear constantly inside test fixtures and
    // internal artifact bodies (e.g. a JSON envelope `{report: 'v6'}`).
    // Scope this predicate to the buyer-facing audiences via denylist;
    // the gate skips it for every other audience (including undefined).
    pattern: /\bv[1-9][0-9]*\b/g,
    audience_denylist: ["ceo_buyer", "external_executive"],
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
  args: { audience?: string | null; body: string; sourceCandidateId?: string },
): PredicateGateResult => {
  // F2 (2026-05-18): treat null/undefined identically — "default
  // applies" — and only short-circuit when the audience is explicitly
  // exempt (internal_diagnostic). All other audiences (including null)
  // run the gate; per-predicate allowlist/denylist decides which
  // predicates actually match.
  const audience: string | null = typeof args.audience === "string" && args.audience.length > 0
    ? args.audience
    : null;
  if (audience !== null && EXEMPT_AUDIENCES.has(audience)) {
    return { residual: 0, rejected: false, matches: [], citedKnowledgeIds: [] };
  }

  const body = args.body ?? "";
  if (body.length === 0) {
    return { residual: 0, rejected: false, matches: [], citedKnowledgeIds: [] };
  }

  // Merge: DB-declared predicates (when present) supersede catalog
  // entries with the same kc_id; remaining catalog entries fill in
  // the implicit predicates. The DB loader still uses `audience` for
  // its KC-level audience_tags filter; pass empty string when null so
  // the existing audience_tags filter is a no-op (which is the right
  // semantics — a KC that scopes itself by audience_tags should not
  // fire on audience=null until its tags explicitly include it).
  const dbEntries = loadPredicatesFromKnowledge(db, audience ?? "");
  const dbKcIds = new Set(dbEntries.map((e) => e.kc_id));
  const effective: CatalogEntry[] = [
    ...dbEntries,
    ...CATALOG.filter((c) => !dbKcIds.has(c.kc_id)),
  ];

  const matches: PredicateMatch[] = [];
  const cited = new Set<string>();
  for (const entry of effective) {
    // F2: per-predicate audience filter decides whether this predicate
    // applies to the current audience. Skip predicates whose allowlist
    // exempts the audience (substrate signing its own letters) or whose
    // denylist excludes it.
    if (!predicateAppliesToAudience(entry, audience)) continue;
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
