// Phase Align — Principle 2: Model D merger
//
// Architecture.md: every knowledge candidate flows through the
// substrate's extractor merger. No fast path should bypass `extractors.ts`
// and emit `knowledge_promoted` directly from runtime/cli code. The only
// allowed direct emissions are:
//   - `substrate/extractors.ts` (the canonical merger)
//   - `substrate/seed.ts` (curated foundational seed; explicitly owner-approved)
//   - tests/fixtures
//
// This test pair (a) asserts the source-text invariant (no runtime/cli file
// emits `kind: "knowledge_promoted"`) and (b) exercises the merger: emit two
// semantically-equivalent candidates from different substrate_origins, run
// the extractor, observe that the second event is treated as corroborating
// evidence rather than as a parallel canonical row.

import { afterAll, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../../substrate/db";
import { emitEvent } from "../events";
import { newId } from "../ids";
import { extractSemanticDedup } from "../../substrate/extractors";
import { encodeEmbeddingBlob } from "../embedder";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

afterAll(() => closeDb());

// Walk a directory and return every .ts file path (excluding tests).
const collectTsFiles = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (p: string): void => {
    let entries: string[] = [];
    try { entries = readdirSync(p); } catch { return; }
    for (const name of entries) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      if (name === "alignment") continue; // skip Phase Align tests themselves
      const full = join(p, name);
      let s;
      try { s = statSync(full); } catch { continue; }
      if (s.isDirectory()) { walk(full); continue; }
      if (!s.isFile()) continue;
      if (!name.endsWith(".ts")) continue;
      if (name.endsWith(".test.ts")) continue;
      out.push(full);
    }
  };
  walk(dir);
  return out;
};

describe("alignment / merger (Principle 2)", () => {
  test("no runtime/cli file emits kind:'knowledge_promoted' directly", () => {
    // The merger is structurally the extractor. The only legitimate
    // non-extractor emitter is the curated seed (skip_corroboration: true).
    const roots = [
      join(import.meta.dir, "..", "..", "runtime"),
      join(import.meta.dir, "..", "..", "cli"),
    ];
    const offenders: string[] = [];
    for (const root of roots) {
      const files = collectTsFiles(root);
      for (const f of files) {
        // Skip the gate module and the events helper itself.
        if (f.endsWith("/events.ts")) continue;
        const text = readFileSync(f, "utf-8");
        // Look for direct emission patterns:
        //   emitEvent(..., { kind: "knowledge_promoted", ...
        //   kind: "knowledge_promoted"
        // We allow strings appearing in comments or in SELECT/WHERE clauses
        // (those are READS not emissions). The signature we ban is the
        // emit shape: a property literal `kind: "knowledge_promoted"`.
        const banned = /kind:\s*"knowledge_promoted"/g;
        if (banned.test(text)) offenders.push(f);
      }
    }
    if (offenders.length > 0) {
      // Surface the offenders so the test failure is actionable.
      // (No fixup is performed automatically — this is an invariant.)
      console.error("[alignment/merger] direct knowledge_promoted emitters:", offenders);
    }
    expect(offenders).toEqual([]);
  });

  test("extractor merges two semantically-equivalent candidates into ONE merged row", async () => {
    closeDb();
    const db = openDb(":memory:");

    // Two candidates with identical embeddings → cosine = 1.0 > 0.92 threshold.
    // Same polarity → Rule 1 (dedup as corroborating evidence).
    const vec = new Float32Array(1536);
    for (let i = 0; i < vec.length; i++) vec[i] = (i % 7) / 10;
    const blob = encodeEmbeddingBlob(Array.from(vec));

    const directiveId = newId();
    const taskId = newId();
    const candA = emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "opencode",
      directive_id: directiveId,
      task_id: taskId,
      payload: { text: "fixture artifacts should print @@RESULT@@ on stdout." },
      embedding: blob,
      embedding_version: "v1",
    });
    // Brief gap so the cursor sees both in order.
    const candB = emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "claude_root",
      directive_id: directiveId,
      task_id: taskId,
      payload: { text: "Fixture artifacts must emit @@RESULT@@ on standard output." },
      embedding: blob,
      embedding_version: "v1",
    });

    const summary = await extractSemanticDedup(db);
    expect(summary.merged).toBeGreaterThanOrEqual(1);
    expect(summary.contradicted).toBe(0);

    // The merger emits a candidate_confirmed citing the prior candidate;
    // candidate B is now corroborating evidence on candidate A, not a
    // parallel canonical row.
    const confirms = db
      .query(
        `SELECT id, substrate_origin, context_refs, payload FROM events
         WHERE kind = 'candidate_confirmed'`,
      )
      .all() as Array<{ id: string; substrate_origin: string; context_refs: string; payload: string }>;
    expect(confirms.length).toBeGreaterThanOrEqual(1);

    const corroboratingOrigins = new Set<string>();
    for (const row of confirms) {
      const refs = JSON.parse(row.context_refs) as string[];
      if (!refs.includes(candA.id)) continue;
      const p = JSON.parse(row.payload) as { corroborated_origin?: string };
      if (p.corroborated_origin) corroboratingOrigins.add(p.corroborated_origin);
    }
    // The corroborator came from claude_root; the merger preserved the
    // origin so multi-origin synthesis (Rule 3) has the evidence it needs.
    expect(corroboratingOrigins.has("claude_root")).toBe(true);

    // Critically: NO knowledge_promoted row was emitted by the merger here
    // (corroboration alone is not enough; promotion requires posterior
    // crossing the band). The point is that the second emission was NOT
    // treated as a fresh canonical claim.
    const promoted = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'knowledge_promoted'")
      .get() as { c: number };
    expect(promoted.c).toBe(0);

    // Reference candB so the unused-binding lint doesn't fire — the second
    // candidate's id is what we proved is now corroborating evidence.
    expect(candB.id.length).toBeGreaterThan(0);
  });
});
