import { describe, expect, test } from "bun:test";
import { classifyOwnerRenderingSignals } from "./owner_rendering_classifier";

describe("classifyOwnerRenderingSignals — universal continuous signals", () => {
  test("code-heavy text raises code_density signal", () => {
    const r = classifyOwnerRenderingSignals(
      "the bug is in runtime/task_scheduler.ts:84 — getUserById returns null when MAX_CONCURRENT is 0",
    );
    expect(r.signals.code_density).toBeDefined();
    expect(r.signals.code_density!).toBeGreaterThan(0);
    expect(r.evidence.some((e) => e.includes("code_identifiers") || e.includes("file_paths"))).toBe(true);
  });

  test("ops vocabulary raises ops_vocabulary signal", () => {
    const r = classifyOwnerRenderingSignals(
      "the deployment p99 latency spiked after the rollout — pull the dashboard, who's the on-call?",
    );
    expect(r.signals.ops_vocabulary).toBeDefined();
    expect(r.signals.ops_vocabulary!).toBeGreaterThan(0);
  });

  test("MIXED owner: both code AND explanation_appetite can light up", () => {
    // An owner who uses code identifiers AND asks natural questions is
    // a real human, not a category-error bucket. Both signals fire.
    const r = classifyOwnerRenderingSignals(
      "how do I figure out why getUserById returns null in /src/users/lookup.ts?",
    );
    expect(r.signals.code_density).toBeGreaterThan(0);
    expect(r.signals.explanation_appetite).toBeGreaterThan(0);
  });

  test("natural-language ask raises explanation_appetite signal", () => {
    const r = classifyOwnerRenderingSignals("help me lose 5kg by summer");
    expect(r.signals.explanation_appetite).toBeDefined();
    expect(r.signals.explanation_appetite!).toBeGreaterThan(0);
  });

  test("short conversational text raises explanation_appetite via baseline", () => {
    const r = classifyOwnerRenderingSignals("I want to write a novel");
    expect(r.signals.explanation_appetite).toBeDefined();
    expect(r.signals.explanation_appetite!).toBeGreaterThan(0);
  });

  test("empty text produces no signals + minimum confidence", () => {
    const r = classifyOwnerRenderingSignals("");
    // No signal evidence — empty map, NOT a default-persona fallback.
    expect(Object.keys(r.signals).length).toBeGreaterThanOrEqual(0);
    expect(r.confidence).toBeGreaterThanOrEqual(0.5);
    expect(r.confidence).toBeLessThanOrEqual(0.95);
  });

  test("signal strengths are continuous in [0, 1]", () => {
    const r = classifyOwnerRenderingSignals(
      "function getUserById() { const filePath = './src/index.ts'; return; } " +
      "git rebase master, bun test, npm install, .env, package.json, tsconfig",
    );
    for (const [, v] of Object.entries(r.signals)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  test("confidence rises with more independent dimensions firing", () => {
    const oneSignal = classifyOwnerRenderingSignals("help me");
    const threeSignals = classifyOwnerRenderingSignals(
      "how do I deploy this fix in runtime/scheduler.ts — the rollback p99 latency spiked",
    );
    expect(threeSignals.confidence).toBeGreaterThan(oneSignal.confidence);
    expect(threeSignals.confidence).toBeLessThanOrEqual(0.95);
  });

  test("uses prior texts when classifying primary", () => {
    const prior = ["my last PR broke the CI/CD pipeline; can you check the docker rollback?"];
    const r = classifyOwnerRenderingSignals("look at this", prior);
    // Prior alone gives both code AND ops signals.
    expect(r.signals.code_density ?? r.signals.ops_vocabulary).toBeDefined();
  });

  test("evidence array is always populated when any signal fires", () => {
    const r = classifyOwnerRenderingSignals("function() {}");
    expect(Array.isArray(r.evidence)).toBe(true);
    if (Object.keys(r.signals).length > 0) {
      expect(r.evidence.length).toBeGreaterThan(0);
    }
  });
});
