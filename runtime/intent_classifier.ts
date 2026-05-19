// acc2 intent classifier — deterministic open-string classifier for
// directive ingress (contract TJGFQC72BX24NE7R8G1JYJPSR8; F4c posterior-
// keyed under contract 897XTN2GF11XB9D4N45N2R9W58).
//
// Returns one classification per directive_text. The class strings are
// observed vocabulary, not a closed enum — the substrate self-extends
// through use. New classes appear by adding patterns here OR by reading
// fresh evidence keywords; the gate downstream stays open-string.
//
// F4c (2026-05-18): the atms_report_composition pattern now sources
// kind-marker regexes from the `artifact_kind_metadata` table when a
// Database is supplied. Every kind whose `needs_strategic_grounding`
// posterior exceeds the threshold contributes a token-boundary regex —
// so new strategic kinds get classified the moment owner-rejection (or
// any other posterior path) raises their metadata. The DB-less overload
// still ships the seed-equivalent regex so historical callers keep working.

import type { Database } from "bun:sqlite";
import { listStrategicallyGroundedKinds } from "../substrate/artifact_kind_metadata";

export type IntentClassification = {
  intent_class: string;
  confidence: number;
  evidence: string[];
};

export const INTENT_CLASSIFIER_VERSION = "v1.2026-05-18";

type Pattern = {
  intent_class: string;
  // Each pattern names markers a directive must contain. Strong markers
  // alone push confidence high; soft markers reinforce. Matching is
  // case-insensitive substring + word-boundary regex for the strong set.
  strong: RegExp[];
  soft: string[];
};

// Escape a kind string into a regex source. Kinds are open strings so
// they can in principle contain regex meta-characters; escape defensively.
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Build a regex that matches any of the supplied grounding-required
// kind tokens at a word boundary. Used to extend the atms_report pattern's
// strong-marker set so new kinds enter the classifier without hand-edits
// when their metadata posterior rises above the threshold.
const buildGroundingKindRegex = (kinds: readonly string[]): RegExp | null => {
  if (kinds.length === 0) return null;
  const escaped = kinds.map(escapeRegex);
  return new RegExp(`\\b(?:${escaped.join("|")})\\b`, "i");
};

// Retrieval-grounded pattern loader. The classifier no longer carries a
// hardcoded `PATTERNS` array — every intent class is sourced from promoted
// knowledge rows whose payload carries a `classifier.strong_markers` +
// `classifier.soft_markers` shape. The substrate self-extends through use:
// new intent vocabulary arrives as new promoted rows, not by editing this
// file. DB-less callers (tests + historical paths) get an empty pattern
// set and fall through to `ad_hoc` — that is the universality test.

type RetrievedPatternRow = {
  intent_class: string;
  strong_markers: unknown;
  soft_markers: unknown;
  confidence?: number;
};

const parseStringArray = (value: unknown): string[] => {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
};

const patternFromEvidence = (row: RetrievedPatternRow): Pattern | null => {
  const strong = parseStringArray(row.strong_markers).map((marker) => new RegExp(marker, "i"));
  const soft = parseStringArray(row.soft_markers);
  if (strong.length === 0 && soft.length === 0) return null;
  return { intent_class: row.intent_class, strong, soft };
};

const loadRetrievedPatterns = (db: Database): Pattern[] => {
  const rows = db.query<RetrievedPatternRow, []>(`
    SELECT
      json_extract(c.payload, '$.intent_class') AS intent_class,
      json_extract(c.payload, '$.classifier.strong_markers') AS strong_markers,
      json_extract(c.payload, '$.classifier.soft_markers') AS soft_markers,
      COALESCE(json_extract(p.payload, '$.confidence'), json_extract(c.payload, '$.confidence_estimate'), 0) AS confidence
    FROM events p
    JOIN events c ON c.id = json_extract(p.payload, '$.candidate_id')
    WHERE p.kind = 'knowledge_promoted'
      AND c.kind = 'knowledge_candidate'
      AND json_extract(c.payload, '$.classifier.intent_classifier_version') IS NOT NULL
    ORDER BY confidence DESC, p.ts DESC
  `).all();
  return rows
    .filter((row) => typeof row.intent_class === "string" && row.intent_class.length > 0)
    .map(patternFromEvidence)
    .filter((row): row is Pattern => row !== null);
};

const matchPattern = (text: string, pattern: Pattern): { strongHits: string[]; softHits: string[] } => {
  const strongHits: string[] = [];
  for (const re of pattern.strong) {
    const m = text.match(re);
    if (m) strongHits.push(m[0]);
  }
  const softHits: string[] = [];
  const lower = text.toLowerCase();
  for (const soft of pattern.soft) {
    if (lower.includes(soft.toLowerCase())) softHits.push(soft);
  }
  return { strongHits, softHits };
};

// Confidence scoring: two-or-more strong matches → 0.85; one strong
// plus one or more soft → 0.7; one strong only → 0.55; only soft → 0.4;
// nothing → 0.3 (fallback).
const scoreHits = (strongHits: number, softHits: number): number => {
  if (strongHits >= 2) return 0.85;
  if (strongHits === 1 && softHits >= 1) return 0.7;
  if (strongHits === 1) return 0.55;
  if (softHits >= 2) return 0.45;
  if (softHits === 1) return 0.4;
  return 0.3;
};

// Compose the active pattern set from substrate evidence. No fixed intent
// classes live in code; DB-less callers get the universal fallback only.
const composePatterns = (db?: Database): Pattern[] => {
  if (!db) return [];
  const retrieved = loadRetrievedPatterns(db);
  const groundingKinds = listStrategicallyGroundedKinds(db);
  const dynamic = buildGroundingKindRegex(groundingKinds);
  if (!dynamic) return retrieved;
  return [
    ...retrieved,
    {
      intent_class: "artifact_needs_strategic_grounding",
      strong: [dynamic],
      soft: groundingKinds,
    },
  ];
};

export const classifyIntent = (
  directive_text: string,
  db?: Database,
): IntentClassification => {
  if (typeof directive_text !== "string" || directive_text.length === 0) {
    return { intent_class: "ad_hoc", confidence: 0.3, evidence: [] };
  }
  let best: { intent_class: string; confidence: number; evidence: string[] } = {
    intent_class: "ad_hoc",
    confidence: 0.3,
    evidence: [],
  };
  const patterns = composePatterns(db);
  for (const pattern of patterns) {
    const { strongHits, softHits } = matchPattern(directive_text, pattern);
    if (strongHits.length === 0 && softHits.length === 0) continue;
    const confidence = scoreHits(strongHits.length, softHits.length);
    if (confidence > best.confidence) {
      best = {
        intent_class: pattern.intent_class,
        confidence,
        evidence: [...strongHits, ...softHits],
      };
    }
  }
  if (best.confidence < 0.5) {
    return { intent_class: "ad_hoc", confidence: best.confidence, evidence: best.evidence };
  }
  return best;
};
