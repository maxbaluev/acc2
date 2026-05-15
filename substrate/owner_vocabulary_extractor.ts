// Owner-vocabulary extractor — mines the owner's own
// `owner_input_received` event history to learn the words and phrases
// THIS owner uses (preferred_terms) and the ones THIS owner explicitly
// rejected (avoided_terms). Universal: no fixed enum of owner types, no
// pre-baked vocabulary list. Each owner accumulates their own dictionary
// turn by turn.
//
// Pipeline:
//
//   substrate.read most-recent owner_input_received rows
//     → extractOwnerVocabulary (pure, no I/O)
//     → emit ONE owner_insight_candidate per surfaced field
//       (preferred_terms / avoided_terms), each citing the evidence ids
//     → substrate/extractors.ts maybePromoteOwnerProfile takes it from here
//       (high-confidence single-origin OR sibling cosine OR owner approval)
//     → owner_profile_recorded.preferred_terms / avoided_terms merged
//     → runtime/prompt_composer.ts buildOwnerProfileSection mirrors the
//       vocabulary back into every brain dispatch.
//
// Pure on the data path. The driver `runOwnerVocabularyExtractorTick`
// adds the only DB touch: reading recent rows and emitting candidate
// events. Idempotent — re-running on the same input emits no duplicates
// (it skips when an open candidate already cites the same evidence ids).

import type { Database } from "bun:sqlite";
import { withImmediateTransaction } from "./db";
import type { EventKind, SubstrateOrigin } from "./types";

// ── Configuration ─────────────────────────────────────────────────────

/** Max owner_input_received rows scanned per tick. Picks the most recent
 *  (DESC by ts) — the owner's vocabulary drifts over time and we want
 *  the live window, not the entire history. */
export const OWNER_VOCABULARY_INPUT_WINDOW = 50;

/** A 1..N-gram must appear in at least this many DISTINCT owner_input
 *  events to qualify as a preferred term. "Repeatedly used across
 *  different messages" is the signal — not "occurred N times in one
 *  message." */
export const PREFERRED_TERM_MIN_DISTINCT_EVENTS = 3;

/** Max n-gram length the extractor considers. 1..3 covers single words
 *  ("hustle"), bigrams ("weekly grind"), and trigrams ("the big push").
 *  Longer phrases rarely repeat verbatim and are better captured by
 *  the brain itself in `claim` text. */
export const OWNER_VOCABULARY_MAX_NGRAM = 3;

/** Minimum alphabetic chars per token — filters numbers, single letters,
 *  most stopwords-by-shape. "in", "of", "a" are caught here AND in the
 *  stopword list below. */
const MIN_TOKEN_ALPHA_CHARS = 3;

// ── Stopwords + substrate-canonical jargon ────────────────────────────
//
// The extractor surfaces only DISTINCTIVE owner vocabulary. English
// stopwords get filtered out (they're frequent but uninformative), and
// substrate-canonical jargon ("substrate", "directive", "task",
// "knowledge", "artifact", "recipe", "claude", "brain", "owner") is
// filtered because mirroring the system's own words back to the owner
// is the opposite of "use their language."

const ENGLISH_STOPWORDS: ReadonlySet<string> = new Set([
  // articles + determiners
  "the", "a", "an", "this", "that", "these", "those", "some", "any", "all",
  "each", "every", "another", "such",
  // pronouns
  "i", "me", "my", "mine", "myself", "you", "your", "yours", "yourself",
  "he", "him", "his", "she", "her", "hers", "it", "its", "we", "us", "our",
  "ours", "they", "them", "their", "theirs", "who", "whom", "whose", "which",
  "what", "whatever", "whoever", "whomever",
  // verbs / auxiliaries
  "is", "am", "are", "was", "were", "be", "been", "being",
  "do", "does", "did", "done", "doing",
  "have", "has", "had", "having",
  "can", "could", "may", "might", "must", "shall", "should", "will", "would",
  "get", "got", "gets", "getting",
  "go", "goes", "going", "went", "gone",
  "make", "makes", "made", "making",
  // prepositions + conjunctions
  "to", "of", "in", "on", "at", "by", "for", "with", "from", "as", "into",
  "onto", "over", "under", "between", "through", "during", "before", "after",
  "until", "while", "and", "but", "or", "nor", "so", "yet", "if", "then",
  "than", "because", "since", "though", "although", "where", "when", "how",
  "why",
  // common discourse / chat fillers
  "yes", "no", "not", "ok", "okay", "yeah", "yep", "nope", "nah", "well",
  "just", "really", "very", "much", "more", "less", "most", "least", "only",
  "even", "still", "also", "too", "again", "back", "now", "here", "there",
  "out", "off", "up", "down", "away", "about", "around", "ago", "ever",
  "never", "always", "sometimes", "often",
  // misc super-frequent
  "thing", "things", "stuff", "way", "ways", "time", "times", "day", "today",
  "tomorrow", "yesterday", "good", "bad", "new", "old", "big", "small",
  "let", "lets", "like", "want", "need", "see", "say", "said", "saying",
  "tell", "told", "ask", "asked", "find", "found", "thought", "think",
  "know", "knew", "feel", "felt", "look", "looked", "looking",
]);

const SUBSTRATE_JARGON: ReadonlySet<string> = new Set([
  // Core architectural nouns the substrate owns; mirroring these back
  // to the owner defeats the point of vocabulary learning.
  "substrate", "directive", "task", "tasks", "knowledge", "artifact",
  "artifacts", "recipe", "recipes", "claude", "brain", "owner", "father",
  // Frequent substrate-side verbs we don't want to surface as "owner
  // preferred terms" even if the owner happened to use them.
  "dispatch", "dispatched", "dispatching", "emit", "emitted",
  "candidate", "candidates", "promotion", "promoted",
  "verifier", "verified", "residual", "embedding", "embedded",
  "posterior", "cycle", "cycles",
]);

const STOPWORDS_AND_JARGON: ReadonlySet<string> = new Set([
  ...ENGLISH_STOPWORDS,
  ...SUBSTRATE_JARGON,
]);

// ── Tokenization ──────────────────────────────────────────────────────

/** Lowercase + split on whitespace + punctuation. Returns the raw token
 *  stream WITHOUT stopword filtering (callers see every token; the
 *  filter applies at n-gram qualification time). */
export const tokenizeOwnerText = (text: string): string[] => {
  if (!text) return [];
  // Replace any non-letter / non-digit / non-apostrophe with a space,
  // then split. Apostrophe is preserved so "don't" stays one token
  // (the rejection patterns operate on the raw text, not tokens).
  return text
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
};

const tokenIsDistinctive = (tok: string): boolean => {
  if (STOPWORDS_AND_JARGON.has(tok)) return false;
  // Strip apostrophes for the alpha-count check (so "don't" → "dont" → 4).
  const alpha = tok.replace(/[^a-z]/g, "");
  if (alpha.length < MIN_TOKEN_ALPHA_CHARS) return false;
  return true;
};

/** Build all n-grams of length 1..N from a token list. Drops any n-gram
 *  where ANY component token is a stopword/jargon/too-short — distinctive
 *  vocabulary only. */
export const ngramsFromTokens = (tokens: string[], maxN: number): string[] => {
  const out: string[] = [];
  for (let n = 1; n <= maxN; n++) {
    for (let i = 0; i + n <= tokens.length; i++) {
      const slice = tokens.slice(i, i + n);
      let allDistinctive = true;
      for (const t of slice) {
        if (!tokenIsDistinctive(t)) { allDistinctive = false; break; }
      }
      if (!allDistinctive) continue;
      out.push(slice.join(" "));
    }
  }
  return out;
};

// ── Explicit-rejection patterns ───────────────────────────────────────
//
// Phrases that signal "the owner explicitly told us not to use this
// word." We extract the rejected term (and, when present, the preferred
// replacement on the right-hand side of `not X, call it Y`).
//
// The patterns operate on the raw lowercased text (NOT tokenized) so
// quoted phrases and multi-word terms are captured verbatim.
//
// Capture group conventions:
//   (1) the rejected term (always present)
//   (2) the preferred replacement (optional — present for "not X, call it Y")

type RejectionPattern = {
  re: RegExp;
  preferredGroup?: number;
  label: string;
};

// Frame-words that often cling to the front or tail of a rejection
// capture but aren't part of the term itself. Stripped greedily from
// both ends. Note: we deliberately DON'T strip substrate jargon here
// — when an owner says "don't call it task" the rejected term IS
// "task" and that's the signal we want to preserve.
const REJECTION_FRAME_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "this", "that", "these", "those",
  "any", "some", "every", "all", "another",
  "please", "anymore", "again", "ever", "now",
  "today", "tomorrow", "yesterday", "really", "just",
  "still", "always", "never",
  "thing", "things", "stuff", "word", "term",
]);

const stripQuotesAndTrailing = (s: string): string => {
  let out = s.trim();
  // Strip wrapping quotes (single, double, smart).
  out = out.replace(/^['"‘’“”]+/, "");
  out = out.replace(/['"‘’“”]+$/, "");
  // Strip trailing punctuation that often clings to the captured term.
  out = out.replace(/[.,!?;:]+$/, "");
  out = out.trim().toLowerCase();
  if (out.length === 0) return out;

  // Trim leading + trailing frame-words. The captured run from a bare
  // TERM_BODY may have grabbed "a deliverable" or "synergy please" —
  // those framers are noise. Keep stripping until both ends settle.
  let toks = out.split(/\s+/);
  while (toks.length > 1 && REJECTION_FRAME_WORDS.has(toks[0]!)) toks = toks.slice(1);
  while (toks.length > 1 && REJECTION_FRAME_WORDS.has(toks[toks.length - 1]!)) toks = toks.slice(0, -1);
  return toks.join(" ");
};

// Regex source notes:
//   - We allow quoted or unquoted terms; quotes are stripped by
//     stripQuotesAndTrailing afterwards.
//   - Term body: a quoted run (anything inside the quote chars) OR a
//     greedy run of letters / digits / inner spaces / hyphens. We
//     terminate at sentence punctuation so a phrase can be multi-word.
//   - We anchor the rejection cue with a leading word-boundary so we
//     don't false-match "don't" inside another word.

// Quoted: anything between matching quote characters (lazy).
// One capture group: the quoted inner text.
const QUOTED_TERM = `["'‘’“”]([^"'‘’“”]+?)["'‘’“”]`;
// Bare: a word + optionally a chain of (space + word) up to ~5 tokens.
// One capture group: the full phrase.
const BARE_TERM = `([a-z][a-z0-9'\\-]*(?:\\s+[a-z][a-z0-9'\\-]*){0,4})`;
// Combined term group — matches either flavor. NON-capturing outer so
// the total capture-group count is exactly TWO per TERM_BODY use.
const TERM_BODY = `(?:${QUOTED_TERM}|${BARE_TERM})`;

// Helper to pluck the actual captured value out of a TERM_BODY match.
// Each TERM_BODY contributes exactly 2 numbered capture groups (the
// quoted-flavor inner, then the bare-flavor inner). `base` is the
// index of the first of those two slots.
const pluckTermAt = (m: RegExpExecArray, base: number): string => {
  const quoted = m[base];
  const bare = m[base + 1];
  return stripQuotesAndTrailing(quoted ?? bare ?? "");
};

const REJECTION_PATTERNS: RejectionPattern[] = [
  // "not X, call it Y" / "not 'X', call it 'Y'" (em-dash & en-dash variants).
  // Two TERM_BODY uses → 4 capture groups total:
  //   1=X_quoted, 2=X_bare, 3=Y_quoted, 4=Y_bare.
  {
    re: new RegExp(
      `\\bnot\\s+${TERM_BODY}\\s*[,\\-–—]\\s*(?:call(?:\\s+it)?|say|use)\\s+${TERM_BODY}`,
      "i",
    ),
    preferredGroup: 3,  // start of second TERM_BODY's quoted slot
    label: "not_X_call_it_Y",
  },
  // "don't call it X" / "do not call it X" / "don't say X"
  // One TERM_BODY → 2 capture groups: 1=quoted, 2=bare.
  {
    re: new RegExp(
      `\\b(?:do\\s*not|don't|dont)\\s+(?:call\\s+(?:it|that|this)|say|use|use\\s+the\\s+word|use\\s+the\\s+term)\\s+${TERM_BODY}`,
      "i",
    ),
    label: "dont_call_it_X",
  },
  // "stop calling it X" / "stop saying X" / "quit saying X"
  {
    re: new RegExp(
      `\\b(?:stop|quit)\\s+(?:calling\\s+(?:it|that|this)|saying|using)\\s+${TERM_BODY}`,
      "i",
    ),
    label: "stop_saying_X",
  },
  // "i hate the word X" / "i hate the term X" / "i hate calling it X"
  {
    re: new RegExp(
      `\\bi\\s+hate\\s+(?:the\\s+(?:word|term)|calling\\s+(?:it|that|this))\\s+${TERM_BODY}`,
      "i",
    ),
    label: "hate_word_X",
  },
  // "never say X" / "never call it X"
  {
    re: new RegExp(
      `\\bnever\\s+(?:say|call\\s+(?:it|that|this))\\s+${TERM_BODY}`,
      "i",
    ),
    label: "never_say_X",
  },
];

type RejectionHit = {
  avoided: string;
  preferred?: string;
  pattern: string;
};

const extractRejectionsFromText = (text: string): RejectionHit[] => {
  if (!text) return [];
  const hits: RejectionHit[] = [];
  for (const p of REJECTION_PATTERNS) {
    // Run a global scan via repeated exec so a single message saying
    // multiple "don't call it X" pairs is fully captured.
    const globalRe = new RegExp(p.re.source, p.re.flags.includes("g") ? p.re.flags : p.re.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = globalRe.exec(text)) !== null) {
      // TERM_BODY contributes 2 numbered slots (quoted, bare). The
      // first TERM_BODY use in each pattern owns groups 1+2; a second
      // use (only in not_X_call_it_Y) owns 3+4. `preferredGroup`
      // points at the quoted-slot index of the second TERM_BODY.
      const avoided = pluckTermAt(m, 1);
      if (!avoided) continue;
      // Drop trivially-short captures (single letters slipped through
      // a malformed match). The token-shape filter elsewhere would
      // also reject these later, but bailing here keeps the surface
      // clean.
      if (avoided.length < 2) continue;
      const hit: RejectionHit = { avoided, pattern: p.label };
      if (p.preferredGroup) {
        const preferred = pluckTermAt(m, p.preferredGroup);
        if (preferred && preferred.length >= 2) hit.preferred = preferred;
      }
      hits.push(hit);
      // Prevent infinite loop on zero-width matches.
      if (m.index === globalRe.lastIndex) globalRe.lastIndex++;
    }
  }
  return hits;
};

// ── Main extraction function ──────────────────────────────────────────

export type VocabularyExtraction = {
  preferred_terms: string[];
  avoided_terms: string[];
  /** Event ids that supported the inference (a UNION across both fields).
   *  Cited in the candidate payload's context_refs so the substrate's
   *  Model D extractor can score the inspiring rows on outcome. */
  evidence_event_ids: string[];
  /** Aggregate confidence ∈ [0.5, 0.95]. Scales with the number of
   *  distinct events that contributed evidence — more turns supporting
   *  the same vocabulary → higher confidence. */
  confidence: number;
};

/** Pure extractor: takes a list of owner_input_received events and
 *  surfaces the owner's preferred / avoided vocabulary.
 *
 *  Rules:
 *   - A 1..3-gram is a preferred_term when it appears in ≥
 *     PREFERRED_TERM_MIN_DISTINCT_EVENTS distinct events.
 *   - A term is also a preferred_term when it appears on the
 *     right-hand side of "not X, call it Y" — even from a single event.
 *   - A term is an avoided_term when ANY rejection pattern matches it.
 *   - Higher-order n-grams subsume lower-order ones: if "weekly grind"
 *     qualifies, we drop the "weekly" / "grind" unigrams from the
 *     preferred list (the longer phrase is the more specific signal).
 *   - Stopwords + substrate jargon are filtered FROM the n-gram pass,
 *     but NOT from the rejection pass (the owner explicitly saying
 *     "don't call it task" is exactly the signal we want to record).
 */
export const extractOwnerVocabulary = (
  ownerInputs: ReadonlyArray<{ id: string; text: string }>,
): VocabularyExtraction => {
  // Per-ngram bookkeeping.
  // - distinctEvents tracks the set of event IDs that contained it; the
  //   set size IS the "distinct events" signal.
  const ngramEvents = new Map<string, Set<string>>();
  // Track rejection-explicit preferred terms separately (single-event
  // entries that should still qualify because they were named).
  const rejectionPreferred = new Map<string, Set<string>>();
  const avoidedEvents = new Map<string, Set<string>>();

  for (const inp of ownerInputs) {
    if (!inp || typeof inp.text !== "string" || inp.text.length === 0) continue;

    // N-gram pass.
    const tokens = tokenizeOwnerText(inp.text);
    const seenInThisEvent = new Set<string>();
    for (const ng of ngramsFromTokens(tokens, OWNER_VOCABULARY_MAX_NGRAM)) {
      if (seenInThisEvent.has(ng)) continue;  // count each n-gram once per event
      seenInThisEvent.add(ng);
      let set = ngramEvents.get(ng);
      if (!set) { set = new Set<string>(); ngramEvents.set(ng, set); }
      set.add(inp.id);
    }

    // Rejection pass.
    for (const hit of extractRejectionsFromText(inp.text)) {
      let av = avoidedEvents.get(hit.avoided);
      if (!av) { av = new Set<string>(); avoidedEvents.set(hit.avoided, av); }
      av.add(inp.id);
      if (hit.preferred) {
        let pr = rejectionPreferred.get(hit.preferred);
        if (!pr) { pr = new Set<string>(); rejectionPreferred.set(hit.preferred, pr); }
        pr.add(inp.id);
      }
    }
  }

  // ── Build the preferred_terms list ──
  // Qualifier 1: appears in ≥ MIN_DISTINCT_EVENTS distinct events.
  const repetitionQualifiers = new Map<string, Set<string>>();
  for (const [ng, evSet] of ngramEvents) {
    if (evSet.size >= PREFERRED_TERM_MIN_DISTINCT_EVENTS) {
      repetitionQualifiers.set(ng, evSet);
    }
  }

  // Subsumption pass: drop a shorter n-gram when a longer one that
  // contains it qualifies with comparable support. This keeps "weekly
  // grind" while removing "weekly" + "grind" from the surfaced list.
  const repetitionFiltered = new Map<string, Set<string>>();
  const qualifierKeys = Array.from(repetitionQualifiers.keys());
  for (const [ng, evSet] of repetitionQualifiers) {
    const ngTokens = ng.split(" ");
    let subsumed = false;
    for (const other of qualifierKeys) {
      if (other === ng) continue;
      const otherTokens = other.split(" ");
      if (otherTokens.length <= ngTokens.length) continue;
      // Does `ng` appear as a contiguous substring of `other`?
      const otherJoined = " " + other + " ";
      const ngJoined = " " + ng + " ";
      if (!otherJoined.includes(ngJoined)) continue;
      const otherSet = repetitionQualifiers.get(other)!;
      if (otherSet.size + 1 >= evSet.size) {
        subsumed = true;
        break;
      }
    }
    if (!subsumed) repetitionFiltered.set(ng, evSet);
  }

  // Qualifier 2: explicit "call it X" replacement (from rejection
  // patterns) qualifies even on single-event evidence.
  // Merge both sources; rejection-named terms always win inclusion.
  const preferredOut = new Map<string, Set<string>>();
  for (const [ng, evSet] of repetitionFiltered) preferredOut.set(ng, evSet);
  for (const [term, evSet] of rejectionPreferred) {
    const existing = preferredOut.get(term);
    if (existing) for (const id of evSet) existing.add(id);
    else preferredOut.set(term, new Set(evSet));
  }

  // ── Sort + materialize the output lists ──
  // preferred: by descending evidence count, ties alphabetical.
  const preferredSorted = Array.from(preferredOut.entries())
    .sort((a, b) => (b[1].size - a[1].size) || a[0].localeCompare(b[0]))
    .map(([term]) => term);
  // avoided: same shape.
  const avoidedSorted = Array.from(avoidedEvents.entries())
    .sort((a, b) => (b[1].size - a[1].size) || a[0].localeCompare(b[0]))
    .map(([term]) => term);

  // Evidence: union of every event id that contributed to ANY surfaced
  // term — that's the citation set for the Model D credit chain.
  const evidence = new Set<string>();
  for (const [, set] of preferredOut) for (const id of set) evidence.add(id);
  for (const [, set] of avoidedEvents) for (const id of set) evidence.add(id);
  const evidence_event_ids = Array.from(evidence).sort();

  // Confidence: scales with how many distinct events supplied evidence.
  // Floor 0.5 (low signal but non-empty), ceiling 0.95 (heuristics are
  // never certainty).
  const confidence = evidence_event_ids.length === 0
    ? 0.5
    : Math.min(0.95, Math.max(0.5, 0.5 + 0.1 * evidence_event_ids.length));

  return {
    preferred_terms: preferredSorted,
    avoided_terms: avoidedSorted,
    evidence_event_ids,
    confidence,
  };
};

// ── Driver: read recent owner_input_received → emit candidate(s) ──────

const newCandidateId = (): string =>
  crypto.randomUUID().replace(/-/g, "").slice(0, 26).toUpperCase();

const nowIso = (): string => new Date().toISOString();

type InsertCandidateInput = {
  field: "preferred_terms" | "avoided_terms";
  value: string[];
  confidence: number;
  claim: string;
  evidence_event_ids: string[];
  directive_id: string;
  task_id: string;
  loop_id: string;
  substrate_origin: SubstrateOrigin;
};

const insertCandidate = (db: Database, ev: InsertCandidateInput): string => {
  const id = newCandidateId();
  const kind: EventKind = "owner_insight_candidate";
  db.run(
    `INSERT INTO events (
       id, ts, directive_id, task_id, loop_id,
       substrate_origin, kind, payload, context_refs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      nowIso(),
      ev.directive_id,
      ev.task_id,
      ev.loop_id,
      ev.substrate_origin,
      kind,
      JSON.stringify({
        field: ev.field,
        value: ev.value,
        confidence: ev.confidence,
        claim: ev.claim,
      }),
      JSON.stringify(ev.evidence_event_ids),
    ],
  );
  return id;
};

/** Has this exact (field, evidence-set) candidate already been written?
 *  Idempotency check — re-running on the same input window must not
 *  emit a duplicate row. We match on field + a STRICT-superset compare
 *  of the evidence set: if an existing candidate's context_refs covers
 *  every id we'd cite, we treat the inference as already on record. */
const candidateAlreadyRecorded = (
  db: Database,
  field: "preferred_terms" | "avoided_terms",
  evidenceIds: string[],
): boolean => {
  if (evidenceIds.length === 0) return false;
  const rows = db
    .query(
      `SELECT payload, context_refs FROM events
       WHERE kind = 'owner_insight_candidate'
       ORDER BY ts DESC
       LIMIT 200`,
    )
    .all() as Array<{ payload: string; context_refs: string }>;
  for (const r of rows) {
    let payload: Record<string, unknown> = {};
    let refs: string[] = [];
    try { payload = JSON.parse(r.payload ?? "{}"); } catch { continue; }
    try { refs = JSON.parse(r.context_refs ?? "[]"); } catch { continue; }
    if (payload.field !== field) continue;
    const refSet = new Set(refs);
    let covers = true;
    for (const id of evidenceIds) {
      if (!refSet.has(id)) { covers = false; break; }
    }
    if (covers) return true;
  }
  return false;
};

export type OwnerVocabularyTickSummary = {
  scanned_events: number;
  preferred_terms_emitted: number;
  avoided_terms_emitted: number;
  candidate_ids: string[];
  confidence: number;
};

/** Driver: read the most recent owner_input_received rows from the
 *  substrate, run the pure extractor, and emit owner_insight_candidate
 *  events for any surfaced preferred / avoided vocabulary.
 *
 *  Idempotent: an existing candidate whose context_refs already covers
 *  the evidence set blocks re-emission for that field.
 *
 *  This driver is intentionally minimal: zero LLM calls, zero embedding
 *  generation (the substrate's embedder picks up the new row on its
 *  next tick), and zero post-processing of the surfaced vocabulary —
 *  Model D + maybePromoteOwnerProfile handle the corroboration /
 *  promotion downstream. */
export const runOwnerVocabularyExtractorTick = (
  db: Database,
): OwnerVocabularyTickSummary => {
  const rows = db
    .query(
      `SELECT id, payload FROM events
       WHERE kind = 'owner_input_received'
       ORDER BY ts DESC
       LIMIT ?`,
    )
    .all(OWNER_VOCABULARY_INPUT_WINDOW) as Array<{ id: string; payload: string }>;

  const ownerInputs: Array<{ id: string; text: string }> = [];
  for (const r of rows) {
    let p: Record<string, unknown> = {};
    try { p = JSON.parse(r.payload ?? "{}"); } catch { continue; }
    const text = typeof p.text === "string"
      ? p.text
      : typeof p.directive_text === "string"
        ? p.directive_text
        : "";
    if (text.length === 0) continue;
    ownerInputs.push({ id: r.id, text });
  }

  const extraction = extractOwnerVocabulary(ownerInputs);
  const candidateIds: string[] = [];

  let preferredEmitted = 0;
  let avoidedEmitted = 0;

  // Pull a sane directive/task/loop scope from the most recent
  // owner_input_received row so the candidate can live under the
  // matching slice — fall back to the "owner_profile" pseudo-scope
  // (same convention maybePromoteOwnerProfile uses).
  const scope = (db
    .query(
      `SELECT directive_id, task_id, loop_id
       FROM events
       WHERE kind = 'owner_input_received'
       ORDER BY ts DESC LIMIT 1`,
    )
    .get() as { directive_id?: string; task_id?: string; loop_id?: string } | null) ?? null;
  const directive_id = scope?.directive_id ?? "owner_profile";
  const task_id = scope?.task_id ?? "owner_profile";
  const loop_id = scope?.loop_id ?? "loop_root";

  withImmediateTransaction(db, () => {
    if (
      extraction.preferred_terms.length > 0 &&
      !candidateAlreadyRecorded(db, "preferred_terms", extraction.evidence_event_ids)
    ) {
      const id = insertCandidate(db, {
        field: "preferred_terms",
        value: extraction.preferred_terms,
        confidence: extraction.confidence,
        claim:
          `Owner repeatedly uses these terms across ${extraction.evidence_event_ids.length} recent ` +
          `chat turns: ${extraction.preferred_terms.slice(0, 6).join(", ")}` +
          (extraction.preferred_terms.length > 6 ? ` (+${extraction.preferred_terms.length - 6} more)` : "") +
          `. The renderer should mirror these instead of substrate jargon.`,
        evidence_event_ids: extraction.evidence_event_ids,
        directive_id,
        task_id,
        loop_id,
        substrate_origin: "substrate_auto",
      });
      candidateIds.push(id);
      preferredEmitted = extraction.preferred_terms.length;
    }
    if (
      extraction.avoided_terms.length > 0 &&
      !candidateAlreadyRecorded(db, "avoided_terms", extraction.evidence_event_ids)
    ) {
      const id = insertCandidate(db, {
        field: "avoided_terms",
        value: extraction.avoided_terms,
        confidence: extraction.confidence,
        claim:
          `Owner explicitly rejected these terms in ${extraction.evidence_event_ids.length} recent ` +
          `chat turns: ${extraction.avoided_terms.slice(0, 6).join(", ")}` +
          (extraction.avoided_terms.length > 6 ? ` (+${extraction.avoided_terms.length - 6} more)` : "") +
          `. The renderer MUST never use these in chat output to this owner.`,
        evidence_event_ids: extraction.evidence_event_ids,
        directive_id,
        task_id,
        loop_id,
        substrate_origin: "substrate_auto",
      });
      candidateIds.push(id);
      avoidedEmitted = extraction.avoided_terms.length;
    }
  });

  return {
    scanned_events: ownerInputs.length,
    preferred_terms_emitted: preferredEmitted,
    avoided_terms_emitted: avoidedEmitted,
    candidate_ids: candidateIds,
    confidence: extraction.confidence,
  };
};
