// Candidate-generation PROMPT + PARSER for the "generate-and-select" organism.
//
// OWNER RULING: candidate generation is an ACT performed by the intellect (the
// opencode brain, or Claude Code), NOT a hardcoded OpenAI chat call. The
// OPENAI_API_KEY is provisioned for EMBEDDINGS ONLY (text-embedding-3-small via
// runtime/embedder.ts); the brain's reasoning auth comes from opencode. So this
// module contains NO /chat/completions call and NO use of OPENAI_API_KEY — it
// is a pure VERBALIZED-SAMPLING prompt builder + response parser the intellect
// can run as an act. The substrate wires an intellect-backed generator into the
// dispatch; when none is wired the organism falls through to the brain.
//
// UNIVERSAL, not report-specialized: a "candidate solution" is whatever the
// goal asks for — an answer, a plan, code, a message, a research synthesis, a
// report, three coffee-app names. The provenance filter only bites WHERE a
// candidate makes FACTUAL/NUMERIC assertions; goals with no factual content
// produce empty claims arrays and selection then relies on comparison /
// owner preference alone. The prompt never mentions "report".

import type { Candidate } from "./generate_select";
import type { ClaimInput, NumericClaim } from "./claim_provenance_verifier";

export const LLM_GENERATOR_TAG = "llm_vs";

/** Build the verbalized-sampling chat prompt. Exported so the brain/intellect
 *  can run it as an act and tests can inspect the contract. The model must
 *  return STRICT JSON with a top-level `candidates` array of length n; each
 *  entry carries the candidate `solution` text plus a `claims` array whose
 *  every FACTUAL/NUMERIC assertion declares provenance so the deterministic
 *  verifier can score it. The prompt is GOAL-AGNOSTIC: it never assumes the
 *  goal is a report, and a candidate that makes no factual/numeric assertions
 *  uses an empty claims array. */
export const buildGeneratePrompt = (
  task: string,
  n: number,
): { system: string; user: string } => {
  const system = [
    "You are a verbalized-sampling generator. In ONE response you produce",
    `${n} DIVERSE, mutually distinct candidate SOLUTIONS to the goal — different`,
    "angles, framings, and emphases, not paraphrases of one answer. A solution",
    "is whatever the goal asks for: an answer, a plan, code, a message, a name,",
    "a research synthesis, a report — produce the actual artifact the goal wants.",
    "",
    "For EACH candidate, list any FACTUAL or NUMERIC claims its solution makes",
    "as structured claims with sources. Every numeric figure (dollar amounts,",
    "percentages, multipliers, counts) and every checkable factual assertion",
    "MUST be declared as a structured claim with explicit provenance. A claim",
    "input is grounded ONLY if it carries a real source_uri, OR a derived_from",
    "chain that bottoms out in source_uri'd inputs. If you do NOT have a real",
    "source for a value, you MUST mark that input { \"unsourced\": true } —",
    "never fabricate a source_uri. Honesty about provenance is the point.",
    "",
    "If the solution makes NO factual or numeric assertions (e.g. a name, a",
    "poem, a subjective recommendation), give it an EMPTY claims array [].",
    "",
    "Return STRICT JSON only (no markdown fence), shape:",
    "{ \"candidates\": [ {",
    "  \"solution\": string,   // the solution text / artifact the goal asks for",
    "  \"claims\": [ {",
    "    \"id\": string,",
    "    \"expression\": string,   // e.g. \"revenue * margin\" or \"\" if none",
    "    \"result\": number,",
    "    \"inputs\": [ {",
    "      \"label\": string,",
    "      \"value\": number,",
    "      \"source_uri\": string,   // OR",
    "      \"derived_from\": string[], // OR",
    "      \"unsourced\": true",
    "    } ]",
    "  } ]",
    "} ] }",
    "",
    "A candidate that makes no factual/numeric claims uses claims: [].",
  ].join("\n");
  const user = `Goal:\n${task}\n\nReturn exactly ${n} diverse candidate solutions as JSON.`;
  return { system, user };
};

type RawInput = {
  label?: unknown;
  value?: unknown;
  source_uri?: unknown;
  derived_from?: unknown;
  unsourced?: unknown;
};
type RawClaim = {
  id?: unknown;
  expression?: unknown;
  result?: unknown;
  inputs?: unknown;
};
type RawCandidate = { solution?: unknown; body?: unknown; claims?: unknown };

const coerceInput = (raw: RawInput): ClaimInput | null => {
  const label = typeof raw.label === "string" ? raw.label : null;
  const value = typeof raw.value === "number" && Number.isFinite(raw.value) ? raw.value : null;
  if (label === null || value === null) return null;
  if (typeof raw.source_uri === "string" && raw.source_uri.length > 0) {
    return { label, value, source_uri: raw.source_uri };
  }
  if (Array.isArray(raw.derived_from)) {
    return { label, value, derived_from: raw.derived_from.filter((x): x is string => typeof x === "string") };
  }
  // Anything not explicitly grounded round-trips as unsourced so the
  // provenance verifier can catch it (this is the honest default).
  return { label, value, unsourced: true };
};

const coerceClaim = (raw: RawClaim, idx: number): NumericClaim => {
  const inputs: ClaimInput[] = Array.isArray(raw.inputs)
    ? (raw.inputs as RawInput[]).map(coerceInput).filter((x): x is ClaimInput => x !== null)
    : [];
  return {
    id: typeof raw.id === "string" && raw.id.length > 0 ? raw.id : `claim_${idx}`,
    expression: typeof raw.expression === "string" ? raw.expression : "",
    result: typeof raw.result === "number" && Number.isFinite(raw.result) ? raw.result : 0,
    inputs,
  };
};

/** Parse the intellect's JSON response into Candidate<string>[]. Tolerant of an
 *  accidental markdown fence and of a bare top-level array. Each candidate's
 *  artifact is its `solution` text (legacy `body` accepted for tolerance);
 *  claims are coerced into NumericClaim[]. This is the parser the brain/intellect
 *  pairs with buildGeneratePrompt when it runs candidate generation as an act. */
export const parseCandidates = (rawJson: string, n: number): Candidate<string>[] => {
  let text = rawJson.trim();
  // Strip an accidental ```json … ``` fence.
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) text = fence[1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const arr: unknown = Array.isArray(parsed)
    ? parsed
    : (parsed as { candidates?: unknown })?.candidates;
  if (!Array.isArray(arr)) return [];
  const stamp = Date.now().toString(36);
  return arr.slice(0, n).map((c, i): Candidate<string> => {
    const raw = (c ?? {}) as RawCandidate;
    const sol =
      typeof raw.solution === "string"
        ? raw.solution
        : typeof raw.body === "string"
          ? raw.body
          : String(raw.solution ?? raw.body ?? "");
    const claims = Array.isArray(raw.claims)
      ? (raw.claims as RawClaim[]).map((cl, j) => coerceClaim(cl, j))
      : [];
    return {
      id: `${LLM_GENERATOR_TAG}_${stamp}_${i}`,
      artifact: sol,
      claims,
      generator: LLM_GENERATOR_TAG,
    };
  });
};
