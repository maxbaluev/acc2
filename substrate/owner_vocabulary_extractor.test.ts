// Tests for substrate/owner_vocabulary_extractor.ts.
//
// Covers the pure extractor (extractOwnerVocabulary) and the DB driver
// (runOwnerVocabularyExtractorTick). The pure path exercises the n-gram
// repetition rule, the explicit-rejection patterns, stopword + jargon
// filtering, and empty-history fallback. The driver path exercises
// event emission shape, idempotency, and the field/value/context_refs
// contract.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "./db";
import {
  extractOwnerVocabulary,
  runOwnerVocabularyExtractorTick,
} from "./owner_vocabulary_extractor";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const newId = (): string =>
  crypto.randomUUID().replace(/-/g, "").slice(0, 26).toUpperCase();

const _baseTs = Date.now();
let _tsCounter = 0;
const tickTs = (): string => {
  _tsCounter += 1;
  return new Date(_baseTs + _tsCounter * 1000).toISOString();
};

const insertOwnerInput = (
  db: ReturnType<typeof openDb>,
  text: string,
  opts: { directive_id?: string; task_id?: string; loop_id?: string; source?: string } = {},
): string => {
  const id = newId();
  const payload: Record<string, unknown> = { text };
  if (opts.source !== undefined) payload.source = opts.source;
  db.run(
    `INSERT INTO events (
       id, ts, directive_id, task_id, loop_id,
       substrate_origin, kind, payload, context_refs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      tickTs(),
      opts.directive_id ?? "d_vocab_test",
      opts.task_id ?? "t_vocab_test",
      opts.loop_id ?? "l_vocab_test",
      "claude_root",
      "owner_input_received",
      JSON.stringify(payload),
      JSON.stringify([]),
    ],
  );
  return id;
};

// ──────────────────────────────────────────────────────────────────────
// Pure path — extractOwnerVocabulary.
// ──────────────────────────────────────────────────────────────────────

describe("extractOwnerVocabulary — pure path", () => {
  test("repeated phrase across 3+ events lands in preferred_terms", () => {
    const r = extractOwnerVocabulary([
      { id: "e1", text: "Monday is for the weekly grind, nothing fancy." },
      { id: "e2", text: "Started the weekly grind early today. Push hard." },
      { id: "e3", text: "Weekly grind report: shipped two things." },
    ]);
    // "weekly grind" should be in preferred_terms (3 distinct events).
    expect(r.preferred_terms).toContain("weekly grind");
    // Subsumption: unigrams "weekly" and "grind" should be dropped in
    // favor of the bigram. (Spot-check; the spec says shorter n-grams
    // get subsumed by qualifying longer ones with comparable support.)
    expect(r.preferred_terms).not.toContain("weekly");
    expect(r.preferred_terms).not.toContain("grind");
    expect(r.evidence_event_ids).toEqual(expect.arrayContaining(["e1", "e2", "e3"]));
    expect(r.confidence).toBeGreaterThanOrEqual(0.5);
    expect(r.confidence).toBeLessThanOrEqual(0.95);
  });

  test("explicit 'don't call it X' lands X in avoided_terms", () => {
    const r = extractOwnerVocabulary([
      { id: "e1", text: "Don't call it recipe — it's a workflow." },
    ]);
    expect(r.avoided_terms).toContain("recipe");
    expect(r.evidence_event_ids).toContain("e1");
  });

  test("'not X, call it Y' puts X in avoided_terms AND Y in preferred_terms", () => {
    const r = extractOwnerVocabulary([
      { id: "e1", text: "not 'goal', call it 'project'" },
    ]);
    expect(r.avoided_terms).toContain("goal");
    expect(r.preferred_terms).toContain("project");
    expect(r.evidence_event_ids).toContain("e1");
  });

  test("empty input history returns empty extraction", () => {
    const r = extractOwnerVocabulary([]);
    expect(r.preferred_terms).toEqual([]);
    expect(r.avoided_terms).toEqual([]);
    expect(r.evidence_event_ids).toEqual([]);
    // Confidence still in the documented range (floor 0.5).
    expect(r.confidence).toBeGreaterThanOrEqual(0.5);
    expect(r.confidence).toBeLessThanOrEqual(0.95);
  });

  test("stopwords + substrate jargon are filtered out of preferred_terms", () => {
    // The owner repeats "the task" and "is the" — stopwords + jargon.
    // Neither should land in preferred_terms even though they hit the
    // repetition threshold.
    const r = extractOwnerVocabulary([
      { id: "e1", text: "the task is the thing the brain needs" },
      { id: "e2", text: "the task is the thing the brain needs" },
      { id: "e3", text: "the task is the thing the brain needs" },
    ]);
    // No leaked stopwords / jargon.
    for (const term of r.preferred_terms) {
      const tokens = term.split(" ");
      for (const t of tokens) {
        expect(["the", "is", "a", "to", "in", "of", "i", "me", "my"]).not.toContain(t);
        expect(["substrate", "directive", "task", "knowledge", "artifact", "recipe", "claude", "brain", "owner"])
          .not.toContain(t);
      }
    }
  });

  test("single occurrence of a distinctive phrase does NOT qualify as preferred", () => {
    const r = extractOwnerVocabulary([
      { id: "e1", text: "I love the morning hustle so much" },
    ]);
    // Only one event — "morning hustle" doesn't hit the 3-event floor.
    expect(r.preferred_terms).not.toContain("morning hustle");
  });

  test("multiple rejection patterns in different messages all surface in avoided_terms", () => {
    const r = extractOwnerVocabulary([
      { id: "e1", text: "Stop saying synergy please." },
      { id: "e2", text: "I hate the word leverage." },
      { id: "e3", text: "Never call it a deliverable." },
    ]);
    expect(r.avoided_terms).toEqual(expect.arrayContaining(["synergy", "leverage", "deliverable"]));
  });

  test("confidence rises with more evidence events", () => {
    const small = extractOwnerVocabulary([
      { id: "e1", text: "weekly grind weekly grind" },
      { id: "e2", text: "weekly grind" },
      { id: "e3", text: "weekly grind" },
    ]);
    const large = extractOwnerVocabulary([
      { id: "e1", text: "weekly grind" },
      { id: "e2", text: "weekly grind" },
      { id: "e3", text: "weekly grind" },
      { id: "e4", text: "weekly grind" },
      { id: "e5", text: "weekly grind" },
      { id: "e6", text: "weekly grind" },
    ]);
    expect(large.confidence).toBeGreaterThanOrEqual(small.confidence);
    expect(large.confidence).toBeLessThanOrEqual(0.95);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Driver path — runOwnerVocabularyExtractorTick.
// ──────────────────────────────────────────────────────────────────────

describe("runOwnerVocabularyExtractorTick — DB driver", () => {
  test("EXCLUDES operator-dispatch (acc_task_directive) source — never mines engineering jargon as owner vocabulary", () => {
    const db = openDb(":memory:");
    // Operator engineering directives repeated across events — exactly the
    // pollution the owner caught (technical n-grams scraped into preferred_terms).
    for (let i = 0; i < 5; i++) {
      insertOwnerInput(db, "Run the full bun test and fix the anchored replace closure budget meta-credit.", { source: "acc_task_directive" });
    }
    const summary = runOwnerVocabularyExtractorTick(db);
    // Zero genuine-owner input → zero scanned → zero candidates. The 5
    // operator dispatches must NOT produce any preferred_terms.
    expect(summary.scanned_events).toBe(0);
    const rows = db.query("SELECT payload FROM events WHERE kind = 'owner_insight_candidate'").all() as Array<{ payload: string }>;
    const polluted = rows.some((r) => {
      const p = JSON.parse(r.payload) as { field?: string; value?: unknown };
      return p.field === "preferred_terms";
    });
    expect(polluted).toBe(false);
  });

  test("writes owner_insight_candidate rows with correct field/value/context_refs shape", () => {
    const db = openDb(":memory:");
    const ids = [
      insertOwnerInput(db, "Time for the weekly grind. Coffee first."),
      insertOwnerInput(db, "Still on the weekly grind, shipped two."),
      insertOwnerInput(db, "Weekly grind report — three things done."),
      insertOwnerInput(db, "Don't call it recipe — it's a workflow."),
    ];
    const summary = runOwnerVocabularyExtractorTick(db);
    expect(summary.scanned_events).toBe(4);
    expect(summary.candidate_ids.length).toBeGreaterThan(0);

    const rows = db
      .query("SELECT payload, context_refs FROM events WHERE kind = 'owner_insight_candidate' ORDER BY ts ASC")
      .all() as Array<{ payload: string; context_refs: string }>;
    expect(rows.length).toBe(summary.candidate_ids.length);

    // Inspect each emitted row.
    let sawPreferred = false;
    let sawAvoided = false;
    for (const r of rows) {
      const payload = JSON.parse(r.payload) as Record<string, unknown>;
      const refs = JSON.parse(r.context_refs) as string[];
      expect(typeof payload.field).toBe("string");
      expect(Array.isArray(payload.value)).toBe(true);
      expect(typeof payload.confidence).toBe("number");
      expect(typeof payload.claim).toBe("string");
      expect(Array.isArray(refs)).toBe(true);
      // Every cited ref must be one of the owner_input_received ids
      // we just inserted.
      for (const ref of refs) expect(ids).toContain(ref);
      if (payload.field === "preferred_terms") {
        sawPreferred = true;
        expect((payload.value as string[])).toContain("weekly grind");
      }
      if (payload.field === "avoided_terms") {
        sawAvoided = true;
        expect((payload.value as string[])).toContain("recipe");
      }
    }
    expect(sawPreferred).toBe(true);
    expect(sawAvoided).toBe(true);
  });

  test("idempotent: rerun on the same input window emits no new candidates", () => {
    const db = openDb(":memory:");
    insertOwnerInput(db, "On the weekly grind today.");
    insertOwnerInput(db, "Weekly grind continues.");
    insertOwnerInput(db, "Weekly grind shipped two.");
    insertOwnerInput(db, "Don't call it recipe.");

    const first = runOwnerVocabularyExtractorTick(db);
    expect(first.candidate_ids.length).toBeGreaterThan(0);

    const before = (db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'owner_insight_candidate'")
      .get() as { c: number }).c;
    expect(before).toBe(first.candidate_ids.length);

    const second = runOwnerVocabularyExtractorTick(db);
    expect(second.candidate_ids.length).toBe(0);

    const after = (db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'owner_insight_candidate'")
      .get() as { c: number }).c;
    expect(after).toBe(before);
  });

  test("empty event log: tick emits nothing and returns a safe summary", () => {
    const db = openDb(":memory:");
    const summary = runOwnerVocabularyExtractorTick(db);
    expect(summary.scanned_events).toBe(0);
    expect(summary.preferred_terms_emitted).toBe(0);
    expect(summary.avoided_terms_emitted).toBe(0);
    expect(summary.candidate_ids).toEqual([]);
    const count = (db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'owner_insight_candidate'")
      .get() as { c: number }).c;
    expect(count).toBe(0);
  });

  test("driver only emits when an extraction has at least one term", () => {
    const db = openDb(":memory:");
    // A single short message — no repetition, no rejection pattern.
    insertOwnerInput(db, "hello there friend");
    const summary = runOwnerVocabularyExtractorTick(db);
    expect(summary.preferred_terms_emitted).toBe(0);
    expect(summary.avoided_terms_emitted).toBe(0);
    expect(summary.candidate_ids).toEqual([]);
  });
});
