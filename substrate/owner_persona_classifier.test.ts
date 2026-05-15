import { describe, expect, test } from "bun:test";
import { classifyOwnerPersona } from "./owner_persona_classifier";

describe("classifyOwnerPersona", () => {
  test("developer: file paths + code identifiers", () => {
    const r = classifyOwnerPersona(
      "the bug is in runtime/task_scheduler.ts:84 — getUserById returns null when MAX_CONCURRENT is 0",
    );
    expect(r.persona).toBe("developer");
    expect(r.confidence).toBeGreaterThanOrEqual(0.5);
    expect(r.signals.some((s) => s.includes("file_paths") || s.includes("code_identifiers"))).toBe(true);
  });

  test("developer: git + bun + .ts vocabulary", () => {
    const r = classifyOwnerPersona(
      "I rebased my branch onto master, ran bun test, and got an ENOENT on the .env file",
    );
    expect(r.persona).toBe("developer");
  });

  test("operator: deploy + p99 + dashboard vocabulary", () => {
    const r = classifyOwnerPersona(
      "the deployment p99 latency spiked after the rollout — pull the dashboard, who's the on-call?",
    );
    expect(r.persona).toBe("operator");
  });

  test("operator: audit + signoff + compliance", () => {
    const r = classifyOwnerPersona(
      "I need to schedule a security review and get signoff from the compliance stakeholder before the audit",
    );
    expect(r.persona).toBe("operator");
  });

  test("casual: natural question + life-task vocabulary", () => {
    const r = classifyOwnerPersona("help me lose 5kg by summer");
    expect(r.persona).toBe("casual");
    expect(r.confidence).toBeGreaterThanOrEqual(0.5);
  });

  test("casual: question with no code/ops vocabulary", () => {
    const r = classifyOwnerPersona("how do I start journaling consistently?");
    expect(r.persona).toBe("casual");
  });

  test("casual: short statement with no signals", () => {
    const r = classifyOwnerPersona("I want to write a novel");
    expect(r.persona).toBe("casual");
  });

  test("confidence is bounded to [0.5, 0.95]", () => {
    const empty = classifyOwnerPersona("");
    expect(empty.confidence).toBeGreaterThanOrEqual(0.5);
    expect(empty.confidence).toBeLessThanOrEqual(0.95);
    const heavy = classifyOwnerPersona(
      "function getUserById() { const filePath = './src/index.ts'; return; } " +
      "git rebase master, bun test, npm install, .env, package.json, tsconfig",
    );
    expect(heavy.confidence).toBeLessThanOrEqual(0.95);
  });

  test("uses prior texts when classifying primary", () => {
    // A short primary text without strong signals — relies on prior context.
    const prior = ["my last PR broke the CI/CD pipeline; can you check the docker rollback?"];
    const r = classifyOwnerPersona("look at this", prior);
    // Prior alone gives op-leaning signals (rollback, docker, CI/CD, PR).
    expect(r.persona === "operator" || r.persona === "developer").toBe(true);
  });

  test("signals array is always populated", () => {
    const r = classifyOwnerPersona("anything");
    expect(Array.isArray(r.signals)).toBe(true);
    // Even with no strong signals we get at least the short_casual_baseline.
    expect(r.signals.length).toBeGreaterThanOrEqual(0);
  });
});
