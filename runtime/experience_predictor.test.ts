import { describe, expect, test } from "bun:test";
import {
  predictOutcome,
  shouldSpendFullLoop,
  type PastOutcome,
  type PredictDeps,
} from "./experience_predictor";

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function deps(outcomes: PastOutcome[], k = 8): PredictDeps {
  return {
    retrieveSimilar: async () => outcomes,
    nowMs: () => NOW,
    k,
  };
}

function outcome(p: Partial<PastOutcome>): PastOutcome {
  return {
    task: "do the thing",
    residual: 0.1,
    ts_ms: NOW - DAY,
    similarity: 0.9,
    was_real_contact: true,
    ...p,
  };
}

describe("predictOutcome / shouldSpendFullLoop", () => {
  test("1. SUFFICIENT CONFIDENT GOOD → fast path", async () => {
    const outcomes = Array.from({ length: 6 }, () =>
      outcome({ residual: 0.08, similarity: 0.95, ts_ms: NOW - DAY, was_real_contact: true }),
    );
    const p = await predictOutcome("do the thing", deps(outcomes));
    expect(p.basis).toBe("sufficient");
    expect(p.confidence).toBeGreaterThan(0.6);
    expect(p.predicted_residual).toBeLessThan(0.3);
    const gate = shouldSpendFullLoop(p);
    expect(gate.spend).toBe(false);
    expect(gate.reason).toContain("fast_path");
  });

  test("2. SPARSE/NOVEL → low confidence, must spend the full loop", async () => {
    // zero evidence
    const none = await predictOutcome("novel task", deps([]));
    expect(none.basis).toBe("none");
    expect(none.confidence).toBe(0);
    expect(none.n_evidence).toBe(0);
    expect(shouldSpendFullLoop(none).spend).toBe(true);

    // one weak-similarity outcome
    const weak = await predictOutcome(
      "novel task",
      deps([outcome({ similarity: 0.15, residual: 0.1, was_real_contact: false })]),
    );
    expect(weak.basis).not.toBe("sufficient");
    expect(weak.confidence).toBeLessThan(0.6);
    expect(shouldSpendFullLoop(weak).spend).toBe(true);
  });

  test("3. CONFIDENT-BUT-BAD → spend (never fast-path a predicted-bad outcome)", async () => {
    const outcomes = Array.from({ length: 6 }, () =>
      outcome({ residual: 0.7, similarity: 0.95, ts_ms: NOW - DAY, was_real_contact: true }),
    );
    const p = await predictOutcome("do the thing", deps(outcomes));
    expect(p.basis).toBe("sufficient");
    expect(p.confidence).toBeGreaterThan(0.6);
    expect(p.predicted_residual).toBeGreaterThan(0.3);
    const gate = shouldSpendFullLoop(p);
    expect(gate.spend).toBe(true);
    expect(gate.reason).toContain("predicted_bad");
  });

  test("4. STALENESS DECAY → old evidence yields strictly lower confidence", async () => {
    const fresh = Array.from({ length: 6 }, () =>
      outcome({ ts_ms: NOW - DAY, similarity: 0.95, residual: 0.08 }),
    );
    const stale = Array.from({ length: 6 }, () =>
      outcome({ ts_ms: NOW - 120 * DAY, similarity: 0.95, residual: 0.08 }),
    );
    const pf = await predictOutcome("do the thing", deps(fresh));
    const ps = await predictOutcome("do the thing", deps(stale));
    expect(ps.confidence).toBeLessThan(pf.confidence);
    expect(ps.staleness_ms).toBeGreaterThan(pf.staleness_ms);
  });

  test("5. REAL-CONTACT UPWEIGHT → prediction moves toward real-contact outcomes", async () => {
    // Real-contact outcomes are good (0.1); predicted-only are bad (0.9).
    // The weighted mean must sit below the naive 0.5 midpoint because
    // real contact is upweighted.
    const outcomes: PastOutcome[] = [
      outcome({ residual: 0.1, was_real_contact: true, similarity: 0.9, ts_ms: NOW - DAY }),
      outcome({ residual: 0.1, was_real_contact: true, similarity: 0.9, ts_ms: NOW - DAY }),
      outcome({ residual: 0.9, was_real_contact: false, similarity: 0.9, ts_ms: NOW - DAY }),
      outcome({ residual: 0.9, was_real_contact: false, similarity: 0.9, ts_ms: NOW - DAY }),
    ];
    const p = await predictOutcome("do the thing", deps(outcomes));
    expect(p.predicted_residual).toBeLessThan(0.5);
    expect(p.predicted_residual).toBeGreaterThan(0.1);

    // Symmetric control: equal weights (all predicted-only) → ~0.5.
    const equal: PastOutcome[] = outcomes.map((o) => ({ ...o, was_real_contact: false }));
    const pe = await predictOutcome("do the thing", deps(equal));
    expect(pe.predicted_residual).toBeCloseTo(0.5, 5);
    expect(p.predicted_residual).toBeLessThan(pe.predicted_residual);
  });
});
