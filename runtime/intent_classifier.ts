// acc2 intent classifier — deterministic open-string classifier for
// directive ingress (contract TJGFQC72BX24NE7R8G1JYJPSR8).
//
// Returns one classification per directive_text. The class strings are
// observed vocabulary, not a closed enum — the substrate self-extends
// through use. New classes appear by adding patterns here OR by reading
// fresh evidence keywords; the gate downstream stays open-string.

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

const PATTERNS: Pattern[] = [
  {
    intent_class: "atms_report_composition",
    strong: [
      /\batms[_ ]?report\b/i,
      /\bAI\s+Transformation\s+Roadmap\b/i,
      /\bcode[_ ]?artifact[_ ]?candidate\s+kind\s*=\s*atms[_ ]?report\b/i,
      /\bLakeland\s+AI\s+Transformation\b/i,
      /\batms[_ ]?report[_ ]?v\d+/i,
    ],
    soft: ["roadmap", "lakeland", "transformation"],
  },
  {
    intent_class: "system_internals_doc",
    strong: [
      /\bhow\s+the\s+system\s+works\b/i,
      /\bshow\s+how\s+DAG\s+dataflow\b/i,
      /\bDAG\s+dataflow\b/i,
      /\bcofounder\s+report\b/i,
      /\binternal\s+review\b/i,
      /\bexplanation\s+of\s+how\s+the\s+system\b/i,
      /\bhow\s+does\s+the\s+system\s+work\b/i,
    ],
    soft: ["substrate", "dataflow", "internals", "explain"],
  },
  {
    intent_class: "cofounder_review",
    strong: [
      /\bcofounder\b/i,
      /\b(Alex|Tony|Scott)\b.*\breview\b/i,
      /\breview\b.*\b(Alex|Tony|Scott)\b/i,
      /\b(Alex|Tony|Scott)\s+(reviewer|review\s+context)\b/i,
    ],
    soft: ["reviewer", "alex", "tony", "scott"],
  },
  {
    intent_class: "contract_implementation",
    strong: [
      /\bIMPLEMENT\b.*\bcontract\b/i,
      /\bcontract\b.*\btarget_files\b/i,
      /\bcontract_amendment_proposed\b\s+\w+/i,
    ],
    soft: ["implement", "target_files", "contract"],
  },
  {
    intent_class: "research_dispatch",
    strong: [
      /\bDEEP[-_ ]RESEARCH\b/i,
      /\bRESEARCH\b.*\b(live|web|multi[-_ ]?source)\b/i,
      /\bresearch\s+dispatch\b/i,
      /\bmulti[-_ ]?source\s+live\s+data\b/i,
    ],
    soft: ["research", "sources", "web", "investigate"],
  },
];

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

export const classifyIntent = (directive_text: string): IntentClassification => {
  if (typeof directive_text !== "string" || directive_text.length === 0) {
    return { intent_class: "ad_hoc", confidence: 0.3, evidence: [] };
  }
  let best: { intent_class: string; confidence: number; evidence: string[] } = {
    intent_class: "ad_hoc",
    confidence: 0.3,
    evidence: [],
  };
  for (const pattern of PATTERNS) {
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

// Maps an intent_class to the artifact kinds the substrate will allow
// downstream gates to admit. Open-ended: ad_hoc errs toward letting
// historical paths through so existing automations are not broken.
export const allowedArtifactKindsFor = (intent_class: string): string[] => {
  switch (intent_class) {
    case "atms_report_composition":
      return ["atms_report_v_any"];
    case "system_internals_doc":
      return ["system_internals_doc", "markdown_body"];
    case "cofounder_review":
      return ["cofounder_review_note", "markdown_body"];
    case "contract_implementation":
      return ["code_artifact_candidate"];
    case "research_dispatch":
      return ["research_note", "markdown_body"];
    default:
      return [];
  }
};
