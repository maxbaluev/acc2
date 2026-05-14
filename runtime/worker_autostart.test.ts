// Tests for the canonical worker autostart resolver (`ACC2_DISABLE_WORKERS`).
// Covers: empty env enables all; single-name disables only that worker;
// comma+whitespace tolerated; unknown names in the list don't crash anything.
//
// tests/preload.ts pins ACC2_DISABLE_WORKERS to the FULL set for hermetic
// unit-suite runs (so workers don't auto-start during tests). These tests
// override `process.env.ACC2_DISABLE_WORKERS` per-case via beforeEach /
// afterEach so they assert the resolver semantics independently.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ALL_WORKER_NAMES, isWorkerEnabled } from "./worker_autostart";

describe("runtime/worker_autostart — ACC2_DISABLE_WORKERS resolver", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.ACC2_DISABLE_WORKERS;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ACC2_DISABLE_WORKERS;
    } else {
      process.env.ACC2_DISABLE_WORKERS = originalEnv;
    }
  });

  test("empty / unset env enables every canonical worker", () => {
    delete process.env.ACC2_DISABLE_WORKERS;
    for (const w of ALL_WORKER_NAMES) {
      expect(isWorkerEnabled(w)).toBe(true);
    }
    // Empty string is treated the same as unset.
    process.env.ACC2_DISABLE_WORKERS = "";
    for (const w of ALL_WORKER_NAMES) {
      expect(isWorkerEnabled(w)).toBe(true);
    }
  });

  test('single name "embedder" disables only embedder', () => {
    process.env.ACC2_DISABLE_WORKERS = "embedder";
    expect(isWorkerEnabled("embedder")).toBe(false);
    // Every other canonical worker stays on.
    for (const w of ALL_WORKER_NAMES) {
      if (w === "embedder") continue;
      expect(isWorkerEnabled(w)).toBe(true);
    }
  });

  test('"embedder, father" with whitespace disables both', () => {
    process.env.ACC2_DISABLE_WORKERS = "embedder, father";
    expect(isWorkerEnabled("embedder")).toBe(false);
    expect(isWorkerEnabled("father")).toBe(false);
    expect(isWorkerEnabled("scheduler")).toBe(true);
    expect(isWorkerEnabled("rolling_reviewer")).toBe(true);
    expect(isWorkerEnabled("rehabilitation")).toBe(true);
    expect(isWorkerEnabled("integrity")).toBe(true);
  });

  test("leading / trailing whitespace and stray commas tolerated", () => {
    process.env.ACC2_DISABLE_WORKERS = "  , embedder ,  , scheduler , ";
    expect(isWorkerEnabled("embedder")).toBe(false);
    expect(isWorkerEnabled("scheduler")).toBe(false);
    expect(isWorkerEnabled("father")).toBe(true);
  });

  test("unknown worker names in the list do not crash", () => {
    process.env.ACC2_DISABLE_WORKERS =
      "embedder,not_a_worker,definitely-fake,123";
    // Helper does not throw …
    expect(() => isWorkerEnabled("embedder")).not.toThrow();
    expect(() => isWorkerEnabled("father")).not.toThrow();
    // … embedder is still recognized as disabled, and every other canonical
    // worker stays enabled because unknown tokens are no-ops.
    expect(isWorkerEnabled("embedder")).toBe(false);
    expect(isWorkerEnabled("scheduler")).toBe(true);
    expect(isWorkerEnabled("father")).toBe(true);
    expect(isWorkerEnabled("rolling_reviewer")).toBe(true);
    expect(isWorkerEnabled("rehabilitation")).toBe(true);
    expect(isWorkerEnabled("integrity")).toBe(true);
  });

  test("the full canonical set disables every worker (preload.ts shape)", () => {
    process.env.ACC2_DISABLE_WORKERS = ALL_WORKER_NAMES.join(",");
    for (const w of ALL_WORKER_NAMES) {
      expect(isWorkerEnabled(w)).toBe(false);
    }
  });
});
