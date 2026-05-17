export type OwnerProfileCard = {
  detected_language?: string | null;
  autonomy_score?: number | null;
  autonomy_score_floor?: number | null;
  rendering_signals?: Record<string, number>;
  preferred_terms?: string[];
  avoided_terms?: string[];
  things_to_never_do?: string[];
  hot_topics?: string[];
  time_window?: unknown;
  exposed_concepts?: string[];
  declined_concepts?: string[];
};

export type OwnerRenderProfile = Pick<OwnerProfileCard, "detected_language" | "preferred_terms" | "avoided_terms">;

const CANONICAL_WORDS = new Set([
  "live", "queued_at_cap", "completed", "failed", "zombie",
  "event_ids", "event_id", "task_ids", "task_id", "directive_id", "commit_sha",
]);

const canonicalToken = /\b(?:live|queued_at_cap|completed|failed|zombie|event_ids|event_id|task_ids|task_id|directive_id|commit_sha|[a-z]+_[a-z0-9_]+|[A-Z0-9]{10,}|[0-9a-f]{7,40})\b/g;

const escapeRe = (value: string): string => value.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&");

const chooseReplacement = (profile: OwnerRenderProfile, index: number, avoided: string): string | null => {
  const preferred = (profile.preferred_terms ?? []).filter((term) => term.trim().length > 0);
  const candidate = preferred[index] ?? preferred[0];
  if (!candidate || candidate.toLowerCase() === avoided.toLowerCase()) return null;
  return candidate;
};

export const renderOwnerString = (input: string, profile: OwnerRenderProfile = {}): string => {
  const avoided = (profile.avoided_terms ?? []).filter((term) => term.trim().length > 0);
  if (avoided.length === 0) return input;

  const protectedTokens: string[] = [];
  const masked = input.replace(canonicalToken, (token) => {
    if (!CANONICAL_WORDS.has(token) && !/[A-Z0-9]{10,}/.test(token) && !/[0-9a-f]{7,40}/.test(token)) return token;
    const marker = "@@ACC2_CANONICAL_" + protectedTokens.length + "@@";
    protectedTokens.push(token);
    return marker;
  });

  const rendered = avoided.reduce((text, term, index) => {
    const replacement = chooseReplacement(profile, index, term);
    if (!replacement) return text;
    return text.replace(new RegExp("\\b" + escapeRe(term) + "\\b", "gi"), replacement);
  }, masked);

  return protectedTokens.reduce((text, token, index) => text.replace("@@ACC2_CANONICAL_" + index + "@@", token), rendered);
};
