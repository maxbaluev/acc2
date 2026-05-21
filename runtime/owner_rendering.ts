// Tier S0: owner rendering evaluator.
// Scores a rendered owner-visible draft against the owner profile before the
// text reaches the owner.

export type OwnerRenderingVerdict = "clean" | "violates_avoided_term" | "wrong_language" | "exposes_declined_concept";

export type OwnerRenderingDraft = {
  text?: string;
  body?: string;
  content?: string;
  language?: string;
  detected_language?: unknown;
  surface?: string;
  audience?: string;
  [key: string]: unknown;
};

export type OwnerRenderingProfile = {
  preferred_terms?: unknown;
  avoided_terms?: unknown;
  declined_concepts?: unknown;
  exposed_concepts?: unknown;
  detected_language?: unknown;
  rendering_signals?: Record<string, unknown>;
  [key: string]: unknown;
};

export type OwnerRenderingInput = {
  rendered_message?: string | OwnerRenderingDraft;
  owner_profile?: OwnerRenderingProfile;
  candidate_language?: string;
};

export type OwnerRenderingResult = {
  residual: number;
  verdict: OwnerRenderingVerdict;
  breakdown: Record<string, number>;
  reasons: string[];
};

const clamp01 = (n: number): number => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));

const numberSignal = (value: unknown): number => {
  if (typeof value === "number") return clamp01(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (["high", "strong", "required", "strict", "yes"].includes(lower)) return 1;
    if (["medium", "moderate", "some", "watch"].includes(lower)) return 0.5;
    if (["low", "none", "clear", "safe", "no"].includes(lower)) return 0;
    return clamp01(Number(value));
  }
  return 0;
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const stringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  if (typeof value === "string" && value.trim().length > 0) return [value];
  if (value && typeof value === "object") return Object.keys(value as Record<string, unknown>).filter((key) => key.trim().length > 0);
  return [];
};

const textOf = (value: unknown): string => {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
};

const draftText = (draft: string | OwnerRenderingDraft | undefined): string => {
  if (typeof draft === "string") return draft;
  if (!draft) return "";
  return [draft.text, draft.body, draft.content].map(textOf).find((text) => text.trim().length > 0) ?? "";
};

const detectedLanguage = (value: unknown): { language: string; confidence: number } | null => {
  if (typeof value === "string" && value.trim().length > 0) return { language: value.toLowerCase(), confidence: 1 };
  const source = record(value);
  const language = typeof source.language === "string" ? source.language : typeof source.lang === "string" ? source.lang : undefined;
  if (!language) return null;
  const confidence = numberSignal(source.confidence ?? source.probability ?? 1);
  return { language: language.toLowerCase(), confidence };
};

const normalizeLanguage = (language: string): string => language.toLowerCase().split(/[-_]/)[0] ?? language.toLowerCase();

const containsTerm = (text: string, term: string): boolean => {
  const needle = term.trim().toLowerCase();
  return needle.length > 0 && text.toLowerCase().includes(needle);
};

const termPressure = (text: string, terms: readonly string[]): number =>
  terms.some((term) => containsTerm(text, term)) ? 1 : 0;

const preferredTermGap = (text: string, terms: readonly string[], renderingSignals: Record<string, unknown>): number => {
  if (terms.length === 0) return 0;
  const required = Math.max(numberSignal(renderingSignals.mirror_preferred_terms), numberSignal(renderingSignals.preferred_terms_required));
  if (required < 0.5) return 0;
  return terms.some((term) => containsTerm(text, term)) ? 0 : required;
};

const languageMismatch = (input: OwnerRenderingInput, draft: OwnerRenderingDraft | undefined, profile: OwnerRenderingProfile): number => {
  const expected = detectedLanguage(profile.detected_language);
  if (!expected || expected.confidence < 0.7) return 0;
  const actual = input.candidate_language ?? draft?.language ?? textOf(draft?.detected_language);
  if (!actual.trim()) return 0;
  return normalizeLanguage(actual) === normalizeLanguage(expected.language) ? 0 : 1;
};

const lengthPressure = (text: string, renderingSignals: Record<string, unknown>): number => {
  const lowAttention = numberSignal(renderingSignals.low_attention_budget);
  if (lowAttention < 0.5) return 0;
  return text.length > 1200 ? Math.min(0.5, lowAttention) : 0;
};

const substrateLeakPressure = (text: string, renderingSignals: Record<string, unknown>): number => {
  const strict = Math.max(numberSignal(renderingSignals.no_substrate_ids), numberSignal(renderingSignals.primary_surface_plain_words));
  if (strict < 0.5) return 0;
  return /\b[A-Z0-9]{12,}\b|\b(task_id|directive_id|event_id|residual|substrate\.)\b/.test(text) ? Math.min(0.5, strict) : 0;
};

export const evaluateOwnerRendering = (input: OwnerRenderingInput): OwnerRenderingResult => {
  const draft = typeof input.rendered_message === "object" && input.rendered_message !== null ? input.rendered_message : undefined;
  const text = draftText(input.rendered_message);
  const profile = input.owner_profile ?? {};
  const renderingSignals = record(profile.rendering_signals);
  const preferredTerms = stringArray(profile.preferred_terms);
  const avoidedTerms = stringArray(profile.avoided_terms);
  const declinedConcepts = stringArray(profile.declined_concepts);
  const exposedConcepts = stringArray(profile.exposed_concepts);

  if (!text.trim()) {
    return {
      residual: 0,
      verdict: "clean",
      breakdown: { empty_draft: 0 },
      reasons: ["no_owner_visible_draft_supplied"],
    };
  }

  const avoidedTerm = termPressure(text, avoidedTerms);
  const declinedConcept = termPressure(text, declinedConcepts);
  const wrongLanguage = languageMismatch(input, draft, profile);
  const preferredGap = preferredTermGap(text, preferredTerms, renderingSignals);
  const unexposedConceptPressure = exposedConcepts.length === 0 && numberSignal(renderingSignals.explain_unexposed_concepts) >= 0.5 ? 0.2 : 0;
  const longForLowAttention = lengthPressure(text, renderingSignals);
  const substrateLeak = substrateLeakPressure(text, renderingSignals);
  const residual = clamp01(Math.max(avoidedTerm, declinedConcept, wrongLanguage, preferredGap * 0.4, unexposedConceptPressure, longForLowAttention, substrateLeak));

  let verdict: OwnerRenderingVerdict = "clean";
  if (avoidedTerm >= 1) verdict = "violates_avoided_term";
  else if (wrongLanguage >= 1) verdict = "wrong_language";
  else if (declinedConcept >= 1) verdict = "exposes_declined_concept";

  const reasons = [
    `preferred_terms=${preferredTerms.length}`,
    `avoided_terms=${avoidedTerms.length}`,
    `declined_concepts=${declinedConcepts.length}`,
    `exposed_concepts=${exposedConcepts.length}`,
    `avoided_term=${avoidedTerm.toFixed(3)}`,
    `wrong_language=${wrongLanguage.toFixed(3)}`,
    `declined_concept=${declinedConcept.toFixed(3)}`,
    `preferred_term_gap=${preferredGap.toFixed(3)}`,
    `low_attention_length=${longForLowAttention.toFixed(3)}`,
    `substrate_leak=${substrateLeak.toFixed(3)}`,
  ];

  return {
    residual,
    verdict,
    breakdown: {
      avoided_term: avoidedTerm,
      wrong_language: wrongLanguage,
      declined_concept: declinedConcept,
      preferred_term_gap: preferredGap,
      unexposed_concept_pressure: unexposedConceptPressure,
      low_attention_length: longForLowAttention,
      substrate_leak: substrateLeak,
    },
    reasons,
  };
};
