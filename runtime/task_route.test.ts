import { describe, expect, it } from "bun:test";
import { classifyTask } from "./task_route";

describe("classifyTask", () => {
  it("code/arithmetic task -> verifiable", () => {
    const out = classifyTask(
      "implement a parse function so the unit tests pass and compute the sum",
    );
    expect(out.route).toBe("verifiable");
    expect(out.confidence).toBeGreaterThan(0);
    expect(out.signals.some((s) => s.startsWith("verifiable:"))).toBe(true);
  });

  it("pure arithmetic task -> verifiable", () => {
    const out = classifyTask("calculate the average and count the rows in the csv");
    expect(out.route).toBe("verifiable");
  });

  it("'write a persuasive CEO report' -> ambiguous", () => {
    const out = classifyTask("write a persuasive CEO report");
    expect(out.route).toBe("ambiguous");
    expect(out.signals.some((s) => s.startsWith("ambiguous:"))).toBe(true);
  });

  it("unclear / no-signal task -> ambiguous (safe default)", () => {
    const out = classifyTask("do the thing with the stuff");
    expect(out.route).toBe("ambiguous");
    expect(out.confidence).toBe(0);
    expect(out.signals).toHaveLength(0);
  });

  it("balanced signal -> ambiguous (safe error)", () => {
    // one verifiable (test) + one ambiguous (persuasive) => tie => ambiguous
    const out = classifyTask("write a persuasive pitch then test it");
    expect(out.route).toBe("ambiguous");
  });

  it("single stray verifiable keyword does not flip a subjective task", () => {
    const out = classifyTask(
      "draft an engaging investor memo with a compelling narrative and a schema diagram",
    );
    expect(out.route).toBe("ambiguous");
  });
});
