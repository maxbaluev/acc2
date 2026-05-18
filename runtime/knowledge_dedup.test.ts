// Tests for runtime/knowledge_dedup.ts — the emit-time dedup helper
// for knowledge_candidate (δ-mem follow-up, 2026-05-17).

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import {
  containment,
  findSimilarRecentCandidate,
  jaccard,
  tokenize,
} from "./knowledge_dedup";

afterAll(() => closeDb());
beforeEach(() => closeDb());

describe("tokenize", () => {
  test("lowercases, drops short tokens + stop words, dedupes", () => {
    const set = tokenize("The brain emits knowledge candidate events for the substrate");
    // 'the' (stop), 'for' (stop) are dropped; remaining tokens deduped.
    expect(set.has("brain")).toBe(true);
    expect(set.has("emits")).toBe(true);
    expect(set.has("knowledge")).toBe(true);
    expect(set.has("candidate")).toBe(true);
    expect(set.has("events")).toBe(true);
    expect(set.has("substrate")).toBe(true);
    expect(set.has("the")).toBe(false);
    expect(set.has("for")).toBe(false);
  });
  test("empty input returns empty set", () => {
    expect(tokenize("").size).toBe(0);
    expect(tokenize(undefined as unknown as string).size).toBe(0);
  });
});

describe("jaccard", () => {
  test("identical sets return 1", () => {
    const a = new Set(["a", "b", "c"]);
    const b = new Set(["a", "b", "c"]);
    expect(jaccard(a, b)).toBe(1);
  });
  test("disjoint sets return 0", () => {
    const a = new Set(["a", "b"]);
    const b = new Set(["c", "d"]);
    expect(jaccard(a, b)).toBe(0);
  });
  test("partial overlap returns intersection / union", () => {
    const a = new Set(["a", "b", "c"]);
    const b = new Set(["b", "c", "d"]);
    expect(jaccard(a, b)).toBeCloseTo(2 / 4, 5);
  });
});

describe("containment", () => {
  test("subset of larger returns 1.0", () => {
    const shorter = new Set(["a", "b", "c"]);
    const longer = new Set(["a", "b", "c", "d", "e", "f"]);
    expect(containment(shorter, longer)).toBeCloseTo(1.0, 5);
  });
  test("argument order doesn't matter (symmetric on shorter)", () => {
    const a = new Set(["a", "b", "c", "d"]);
    const b = new Set(["a", "b"]);
    expect(containment(a, b)).toBeCloseTo(1.0, 5);
    expect(containment(b, a)).toBeCloseTo(1.0, 5);
  });
  test("empty shorter returns 0", () => {
    expect(containment(new Set(), new Set(["a", "b"]))).toBe(0);
  });
  test("partial overlap returns intersect / shorter", () => {
    const a = new Set(["a", "b", "c"]);
    const b = new Set(["b", "x"]);
    // shorter is b (size 2); intersect with a is {b} = 1; 1/2 = 0.5
    expect(containment(a, b)).toBeCloseTo(0.5, 5);
  });
});

describe("findSimilarRecentCandidate — containment_prefix path", () => {
  test("catches truncated brain re-emission that jaccard would miss (CP3QH88V repro)", () => {
    // Pre-fix repro: brain emitted
    //   claim 1: "cofounder_review_predicate_scan_result: C2 is blocked
    //             because the predicate gate refused admission"
    //   claim 2 (2s later): "cofounder_review_predicate_scan_result"
    // Jaccard ~ 0.27 (well below 0.85 threshold) so dedup missed it.
    // Containment-prefix path: shorter (claim 2 = 4 tokens) ⊂ longer
    // (claim 1) → 1.0 → caught.
    const db = openDb(":memory:");
    const directiveId = "dir_dedup_containment";
    emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "opencode",
      directive_id: directiveId,
      task_id: "t_cont1",
      payload: {
        claim:
          "cofounder_review_predicate_scan_result: C2 is blocked because the predicate gate refused admission",
      },
    });
    const match = findSimilarRecentCandidate(db, {
      claim: "cofounder_review_predicate_scan_result",
      directive_id: directiveId,
      substrate_origin: "opencode",
    });
    expect(match).not.toBeNull();
    expect(match!.method).toBe("containment_prefix");
    expect(match!.similarity).toBeCloseTo(1.0, 5);
  });

  test("does NOT containment-match on trivial 1-2 token fragments", () => {
    // Containment with shorter < 3 tokens would false-positive on
    // single shared words. Floor at 3 tokens.
    const db = openDb(":memory:");
    const directiveId = "dir_dedup_short";
    emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "opencode",
      directive_id: directiveId,
      task_id: "t_short1",
      payload: {
        claim: "Predicate gate rejected the candidate body content",
      },
    });
    const match = findSimilarRecentCandidate(db, {
      claim: "predicate gate", // only 2 meaningful tokens after stop-word drop
      directive_id: directiveId,
      substrate_origin: "opencode",
    });
    expect(match).toBeNull();
  });
});

describe("findSimilarRecentCandidate", () => {
  test("returns null when no candidates exist", () => {
    const db = openDb(":memory:");
    const match = findSimilarRecentCandidate(db, {
      claim: "Brain self-audit shows promotion_rate near zero",
      directive_id: "dir_dedup",
      substrate_origin: "opencode",
    });
    expect(match).toBeNull();
  });

  test("finds an exact-text duplicate above threshold", () => {
    const db = openDb(":memory:");
    const dir = "dir_dedup_same";
    const claim = "Brain self-audit shows promotion_rate near zero over 24 hours";
    emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "opencode",
      directive_id: dir,
      task_id: "t1",
      payload: { claim },
    });
    const match = findSimilarRecentCandidate(db, {
      claim,
      directive_id: dir,
      substrate_origin: "opencode",
    });
    expect(match).not.toBeNull();
    expect(match!.similarity).toBe(1);
    expect(match!.method).toBe("jaccard");
  });

  test("does NOT match when a distinct claim is emitted (low similarity)", () => {
    const db = openDb(":memory:");
    const dir = "dir_dedup_distinct";
    emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "opencode",
      directive_id: dir,
      task_id: "t1",
      payload: { claim: "The bridge handshake watchdog stops at 30 seconds" },
    });
    const match = findSimilarRecentCandidate(db, {
      claim: "Owner profile autonomy floor defaults to 0.4 in fresh substrates",
      directive_id: dir,
      substrate_origin: "opencode",
    });
    expect(match).toBeNull();
  });

  test("does NOT match across different directives (scope discipline)", () => {
    const db = openDb(":memory:");
    const claim = "Brain self-audit shows promotion_rate near zero over 24 hours";
    emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "opencode",
      directive_id: "dir_A",
      task_id: "t1",
      payload: { claim },
    });
    const match = findSimilarRecentCandidate(db, {
      claim,
      directive_id: "dir_B",
      substrate_origin: "opencode",
    });
    expect(match).toBeNull();
  });

  test("does NOT match across different substrate_origins (cross-author evidence stands)", () => {
    const db = openDb(":memory:");
    const dir = "dir_cross_author";
    const claim = "Brain self-audit shows promotion_rate near zero over 24 hours";
    emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "opencode",
      directive_id: dir,
      task_id: "t1",
      payload: { claim },
    });
    const match = findSimilarRecentCandidate(db, {
      claim,
      directive_id: dir,
      substrate_origin: "claude",
    });
    expect(match).toBeNull();
  });

  test("does NOT match candidates older than the window", () => {
    const db = openDb(":memory:");
    const dir = "dir_old_window";
    const claim = "Brain self-audit shows promotion_rate near zero over 24 hours";
    const evt = emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "opencode",
      directive_id: dir,
      task_id: "t1",
      payload: { claim },
    });
    // Backdate the existing event to 2 hours ago.
    db.run("UPDATE events SET ts = ? WHERE id = ?", [
      new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      evt.id,
    ]);
    // Default window is 1 hour, so the backdated row should be invisible.
    const match = findSimilarRecentCandidate(db, {
      claim,
      directive_id: dir,
      substrate_origin: "opencode",
    });
    expect(match).toBeNull();
  });

  test("finds the highest-similarity match across multiple candidates", () => {
    const db = openDb(":memory:");
    const dir = "dir_multi";
    emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "opencode",
      directive_id: dir,
      task_id: "t1",
      payload: { claim: "Bridge handshake watchdog timeout is too short for cold starts" },
    });
    const winnerClaim = "Brain self-audit promotion_rate near zero indicates redundant emissions on this directive";
    const winner = emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "opencode",
      directive_id: dir,
      task_id: "t1",
      payload: { claim: winnerClaim },
    });
    emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "opencode",
      directive_id: dir,
      task_id: "t1",
      payload: { claim: "Owner profile autonomy floor defaults to 0.4 in fresh substrates" },
    });
    const match = findSimilarRecentCandidate(db, {
      claim: winnerClaim,
      directive_id: dir,
      substrate_origin: "opencode",
    });
    expect(match).not.toBeNull();
    expect(match!.matched_event_id).toBe(winner.id);
    expect(match!.similarity).toBe(1);
  });
});
