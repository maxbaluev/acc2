// Tests for runtime/llm_generate.ts — the live LLM candidate generator.
//
// No real network: globalThis.fetch is mocked exactly like embedder.test.ts.
// We assert (1) n candidates parse with their NumericClaims, and (2) a
// candidate carrying an `unsourced: true` input round-trips so the
// deterministic provenance verifier can later catch it.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateCandidates, parseCandidates, buildGeneratePrompt } from "./llm_generate";
import { verifyClaimProvenance } from "./claim_provenance_verifier";

const originalFetch = globalThis.fetch;
const originalKey = process.env.OPENAI_API_KEY;

const mockCompletion = (content: unknown): Response =>
  new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

beforeEach(() => {
  process.env.OPENAI_API_KEY = "sk-test-mock";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalKey;
});

describe("generateCandidates (mocked fetch)", () => {
  test("returns n candidates with parsed claims", async () => {
    const payload = {
      candidates: [
        {
          body: "Thesis A: cite the McKinsey figure.",
          claims: [
            {
              id: "c1",
              expression: "base * uplift",
              result: 200,
              inputs: [
                { label: "base", value: 100, source_uri: "https://example.com/10k" },
                { label: "uplift", value: 2, source_uri: "https://example.com/study" },
              ],
            },
          ],
        },
        {
          body: "Thesis B: no numbers, pure qualitative pitch.",
          claims: [],
        },
      ],
    };
    globalThis.fetch = (async () => mockCompletion(payload)) as typeof fetch;

    const candidates = await generateCandidates("write a value thesis", 2);
    expect(candidates).toHaveLength(2);
    expect(candidates[0].artifact).toContain("Thesis A");
    expect(candidates[0].generator).toBe("llm_vs");
    expect(candidates[0].claims[0].inputs).toHaveLength(2);
    // Distinct ids.
    expect(candidates[0].id).not.toBe(candidates[1].id);
    // The fully-sourced candidate passes the provenance filter.
    expect(verifyClaimProvenance(candidates[0].claims).residual).toBeLessThan(0.3);
  });

  test("a candidate carrying unsourced:true round-trips so the verifier catches it", async () => {
    const payload = {
      candidates: [
        {
          body: "Thesis with an invented multiplier.",
          claims: [
            {
              id: "bad",
              expression: "revenue * recovery",
              result: 600,
              inputs: [
                { label: "revenue", value: 100, source_uri: "https://example.com/10k" },
                { label: "recovery", value: 6, unsourced: true },
              ],
            },
          ],
        },
      ],
    };
    globalThis.fetch = (async () => mockCompletion(payload)) as typeof fetch;

    const [candidate] = await generateCandidates("value thesis", 1);
    expect(candidate).toBeDefined();
    const unsourced = candidate.claims[0].inputs.find(
      (i) => (i as { unsourced?: boolean }).unsourced === true,
    );
    expect(unsourced).toBeDefined();
    // Provenance verifier flags it above the 0.3 closure bar.
    const { residual, breakdown } = verifyClaimProvenance(candidate.claims);
    expect(residual).toBeGreaterThanOrEqual(0.3);
    expect(breakdown.unsourced_inputs.length).toBeGreaterThan(0);
  });

  test("returns [] without an API key (no network)", async () => {
    delete process.env.OPENAI_API_KEY;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return mockCompletion({ candidates: [] });
    }) as typeof fetch;
    const candidates = await generateCandidates("x", 2);
    expect(candidates).toEqual([]);
    expect(called).toBe(false);
  });
});

describe("parseCandidates", () => {
  test("tolerates a markdown-fenced bare array", () => {
    const fenced = "```json\n[{\"body\":\"hi\",\"claims\":[]}]\n```";
    const out = parseCandidates(fenced, 5);
    expect(out).toHaveLength(1);
    expect(out[0].artifact).toBe("hi");
  });

  test("returns [] on unparseable content", () => {
    expect(parseCandidates("not json at all", 3)).toEqual([]);
  });
});

describe("buildGeneratePrompt", () => {
  test("instructs n diverse candidates and unsourced honesty", () => {
    const { system, user } = buildGeneratePrompt("my task", 4);
    expect(user).toContain("my task");
    expect(user).toContain("4");
    expect(system).toContain("unsourced");
    expect(system).toContain("candidates");
  });
});
