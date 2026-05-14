// Phase Align — Principle 9: posterior-update consistency.
//
// v2-design.md §3.6.1, §7.2, §11.5: code_artifact and knowledge_candidate
// share the SAME Beta posterior + EMA constants. Recipe confidence uses a
// DIFFERENT (coarser, qualitative) formula on purpose — recipes do not
// have a residual-driven posterior; they have a single trajectory whose
// "did the replay succeed" is binary.
//
// This test pins the shared constants and documents the deliberate
// divergence so a future refactor can't silently re-unify recipes onto a
// Beta posterior without an explicit design decision.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("alignment / posterior_consistency (Principle 9)", () => {
  test("artifact_store and extractors share success/failure bands", () => {
    const artifactStore = readFileSync(
      join(import.meta.dir, "..", "artifact_store.ts"),
      "utf-8",
    );
    const extractors = readFileSync(
      join(import.meta.dir, "..", "..", "substrate", "extractors.ts"),
      "utf-8",
    );

    // Artifact store: residual ≤ 0.3 → success, ≥ 0.7 → failure.
    expect(artifactStore).toContain("const SUCCESS_BAND = 0.3");
    expect(artifactStore).toContain("const FAILURE_BAND = 0.7");
    // EMA half-life is 20 events.
    expect(artifactStore).toContain("EMA_HALF_LIFE_EVENTS = 20");

    // Extractors: identical 0.3 success threshold for knowledge corroboration.
    expect(extractors).toContain("RESIDUAL_SUCCESS_THRESHOLD = 0.3");
    expect(extractors).toContain("RECENT_WINDOW = 20");
  });

  test("knowledge extractor uses the same Beta posterior shape as artifacts", () => {
    const extractors = readFileSync(
      join(import.meta.dir, "..", "..", "substrate", "extractors.ts"),
      "utf-8",
    );
    // Promote threshold 0.85, demote 0.30 (the score bands match the
    // artifact promotion threshold in artifact_store.ts).
    expect(extractors).toContain("promoteScore: 0.85");
    expect(extractors).toContain("demoteScore: 0.30");
    // betaMean = alpha / (alpha + beta).
    expect(extractors).toContain("betaMean");
    // betaConfidence = 1 - 1/sqrt(n+1).
    expect(extractors).toContain("betaConfidence");
  });

  test("credit.ts shares the same band constants used elsewhere", () => {
    const credit = readFileSync(
      join(import.meta.dir, "..", "credit.ts"),
      "utf-8",
    );
    expect(credit).toContain("const SUCCESS_BAND = 0.3");
    expect(credit).toContain("const FAILURE_BAND = 0.7");
    // EMA half-life inside the weighted-delta path: same 20 events.
    expect(credit).toContain("Math.pow(0.5, 1 / 20)");
  });

  test("recipe confidence uses a DIFFERENT coarse formula and documents why", () => {
    const recipeReplay = readFileSync(
      join(import.meta.dir, "..", "recipe_replay.ts"),
      "utf-8",
    );
    // Recipe success → +0.05; failure → −0.10.
    expect(recipeReplay).toContain("0.05");
    expect(recipeReplay).toContain("-0.10");
    // The cap is 0.95 and the auto-archive floor is 0.2 — these constants
    // are exported so the dispatcher and replay engine share them.
    expect(recipeReplay).toContain("RECIPE_MAX_CONFIDENCE = 0.95");
    expect(recipeReplay).toContain("RECIPE_AUTO_ARCHIVE_FLOOR = 0.2");
    // The divergence-rationale comment must be present so a future
    // refactor cannot silently unify recipes onto Beta without an explicit
    // design decision. The header comment block documents the coarse model.
    expect(recipeReplay).toContain("Confidence model");
    expect(recipeReplay).toContain("Successful replay");
    expect(recipeReplay).toContain("Failed replay");
  });
});
