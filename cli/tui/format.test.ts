// Tests for the substrate-content-first TUI's render helpers.
//
// Brain design D9TBCHADS97DHAMNBC686HE3P0 pins the contract: every
// row in the new TUI is CONTENT, never a hex id. These tests lock
// the per-importance icon/colour mapping, the relative-timestamp
// truncation, and the payload-drilldown formatter.

import { describe, expect, test } from "bun:test";
import {
  formatRelativeTs,
  formatNarrativeLine,
  formatPayloadLines,
  importanceColor,
  importanceIcon,
} from "./format";
import type { SubstrateNarrativeRow } from "../../substrate/views";

const baseNow = Date.parse("2026-05-17T17:00:00Z");

const row = (overrides: Partial<SubstrateNarrativeRow>): SubstrateNarrativeRow => ({
  event_id: "EVT0000000000000000000000A",
  ts: "2026-05-17T16:59:55Z",
  kind: "knowledge_candidate",
  directive_id: "DIR00000000000000000000000",
  task_id: "TSK00000000000000000000000",
  substrate_origin: "claude_inline",
  importance: "medium",
  human_summary: "Hot-reload fix verified live.",
  residual: null,
  route: null,
  cited_refs: [],
  payload: {},
  ...overrides,
});

describe("formatRelativeTs", () => {
  test("seconds when < 60s old", () => {
    expect(formatRelativeTs("2026-05-17T16:59:55Z", baseNow)).toBe("5s");
  });
  test("minutes when < 60m old", () => {
    expect(formatRelativeTs("2026-05-17T16:30:00Z", baseNow)).toBe("30m");
  });
  test("hours when < 24h old", () => {
    expect(formatRelativeTs("2026-05-17T13:00:00Z", baseNow)).toBe("4h");
  });
  test("YYYY-MM-DD fallback for rows older than 24h", () => {
    expect(formatRelativeTs("2026-05-15T16:00:00Z", baseNow)).toBe("2026-05-15");
  });
  test("non-parseable input returns input unchanged", () => {
    expect(formatRelativeTs("not-a-date", baseNow)).toBe("not-a-date");
  });
});

describe("importance icon + colour", () => {
  test("critical → red and !", () => {
    expect(importanceIcon("critical")).toBe("!");
    expect(importanceColor("critical")).toBe("red");
  });
  test("high → yellow and *", () => {
    expect(importanceIcon("high")).toBe("*");
    expect(importanceColor("high")).toBe("yellow");
  });
  test("medium → cyan and ·", () => {
    expect(importanceIcon("medium")).toBe("·");
    expect(importanceColor("medium")).toBe("cyan");
  });
  test("low → gray and space", () => {
    expect(importanceIcon("low")).toBe(" ");
    expect(importanceColor("low")).toBe("gray");
  });
});

describe("formatNarrativeLine", () => {
  test("leads with content and trails metadata", () => {
    const line = formatNarrativeLine(row({ human_summary: "Designed the migration." }), 100, baseNow);
    expect(line.startsWith("Designed the migration.")).toBe(true);
    expect(line).toContain("5s");
    expect(line).toContain("·");
    expect(line).toContain("knowledge_candidate");
  });

  test("first token is human-readable content, not an event kind", () => {
    const line = formatNarrativeLine(row({ human_summary: "Designed the migration." }), 100, baseNow);
    expect(line.split(/\s+/)[0]).toBe("Designed");
    expect(line.split(/\s+/)[0]).not.toBe("knowledge_candidate");
  });

  test("truncates summary to width, never IDs", () => {
    const longSummary = "X".repeat(500);
    const line = formatNarrativeLine(row({ human_summary: longSummary }), 80, baseNow);
    expect(line.length).toBeLessThanOrEqual(80);
    expect(line).not.toContain("EVT0000000000000000000000A"); // id never shown
  });

  test("falls back to payload-keys preview when human_summary is null", () => {
    const line = formatNarrativeLine(
      row({ human_summary: null, payload: { unknown_key: 1, another_key: 2 } }),
      100,
      baseNow,
    );
    expect(line).toContain("unknown_key");
  });

  test("collapses whitespace so multi-line claims fit a single row", () => {
    const claim = "first line\nsecond line\n\nthird";
    const line = formatNarrativeLine(row({ human_summary: claim }), 100, baseNow);
    expect(line).toContain("first line second line third");
    expect(line.includes("\n")).toBe(false);
  });
});

describe("formatPayloadLines", () => {
  test("emits one column per key with right-aligned name", () => {
    const lines = formatPayloadLines({ claim: "short", confidence: 0.7 }, 80);
    expect(lines[0]).toContain("claim:");
    expect(lines[0]).toContain("short");
    expect(lines[1]).toContain("confidence:");
    expect(lines[1]).toContain("0.7");
  });

  test("wraps long values with continuation indent", () => {
    const long = "Y".repeat(120);
    const lines = formatPayloadLines({ note: long }, 60);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).toContain("note:");
    // Continuation lines start with spaces (no key column).
    expect(lines[1]?.startsWith(" ")).toBe(true);
  });

  test("renders nested objects as JSON", () => {
    const lines = formatPayloadLines({ act: { intent: "x", verifier_kind: "deterministic_code" } }, 200);
    expect(lines[0]).toContain("act:");
    expect(lines[0]).toContain("intent");
    expect(lines[0]).toContain("deterministic_code");
  });

  test("renders null as (null) — never empty string", () => {
    const lines = formatPayloadLines({ optional: null }, 80);
    expect(lines[0]).toContain("(null)");
  });
});
