// acc2 goal-shape hashing tests — stability, set-equivalence, distinctness.

import { describe, expect, test } from "bun:test";
import { goalShape, __canonicalizeForTest } from "./goal_shape";

describe("goalShape", () => {
  test("stable: same input → same output across many calls", () => {
    const text = "Count files in scripts/cli/ whose contents contain TODO";
    const first = goalShape(text);
    for (let i = 0; i < 10; i++) {
      expect(goalShape(text)).toBe(first);
    }
  });

  test("hash is a 16-char hex string", () => {
    const h = goalShape("hello world");
    expect(h.length).toBe(16);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  test("set-equivalent over word reorderings", () => {
    const a = goalShape("Count files in scripts containing TODO");
    const b = goalShape("TODO containing scripts in files Count");
    expect(a).toBe(b);
  });

  test("punctuation insensitive", () => {
    const a = goalShape("Count files in scripts/cli/ containing TODO!");
    const b = goalShape("Count files in scripts cli containing TODO");
    expect(a).toBe(b);
  });

  test("case insensitive", () => {
    const a = goalShape("AUDIT The Substrate Events");
    const b = goalShape("audit the substrate events");
    expect(a).toBe(b);
  });

  test("distinct goals produce distinct hashes", () => {
    const a = goalShape("Count TODO markers in scripts");
    const b = goalShape("Audit substrate events for failures");
    expect(a).not.toBe(b);
  });

  test("empty-safe: empty string yields a stable non-empty hash", () => {
    const h = goalShape("");
    expect(h.length).toBe(16);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  test("very short tokens (length < 2) are dropped from the canonical form", () => {
    const canon = __canonicalizeForTest("a counting of the items in a list");
    expect(canon.split(" ")).not.toContain("a");
    // longer-word tokens survive
    expect(canon.split(" ")).toContain("counting");
  });
});
