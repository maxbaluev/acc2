import { describe, expect, it } from "bun:test";
import { classifyTask, classifyGoal } from "./task_route";

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

describe("classifyGoal — universal three-way route", () => {
  it("verifiable goal -> verifiable (deterministic)", () => {
    const out = classifyGoal(
      "implement a parse function so the unit tests pass and compute the sum",
    );
    expect(out.route).toBe("verifiable");
  });

  it("single deliverable: 'write a haiku about the sea' -> single_deliverable", () => {
    const out = classifyGoal("write a haiku about the sea");
    expect(out.route).toBe("single_deliverable");
  });

  it("single deliverable: 'suggest 3 names for a coffee app' -> single_deliverable", () => {
    const out = classifyGoal("suggest 3 names for a coffee app");
    expect(out.route).toBe("single_deliverable");
  });

  it("single deliverable: a non-report deliverable still routes single", () => {
    const out = classifyGoal("write a persuasive CEO report");
    expect(out.route).toBe("single_deliverable");
  });

  it("complex goal: 'design and implement the dispatch architecture' -> complex", () => {
    const out = classifyGoal("design and implement the dispatch architecture");
    expect(out.route).toBe("complex");
    expect(out.signals.some((s) => s.startsWith("complex:"))).toBe(true);
  });

  it("complex goal: multi-phase project -> complex (brain decomposes)", () => {
    const out = classifyGoal(
      "set up the data pipeline and roll out the platform across multiple phases",
    );
    expect(out.route).toBe("complex");
  });

  it("no signal -> single_deliverable (safe non-destructive default)", () => {
    const out = classifyGoal("do the thing with the stuff");
    expect(out.route).toBe("single_deliverable");
  });
});
