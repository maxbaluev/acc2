import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import { attributeRetrievalCredit } from "./retrieval_credit";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const seedBinding = (db: ReturnType<typeof openDb>, sourceId?: string): string => {
  const ev = emitEvent(db, {
    kind: "retrieval_binding",
    substrate_origin: "substrate_auto",
    payload: { query: "test", source_event_id: sourceId ?? "SRC1", binding_surface: "prompt", rank: 1 },
  });
  return ev.id;
};

const countCredit = (db: ReturnType<typeof openDb>, bindingId: string): number => {
  return (db
    .query(
      `SELECT count(*) as n FROM events
        WHERE kind = 'retrieval_credit_attributed'
          AND json_extract(payload, '$.retrieval_binding_event_id') = ?`,
    )
    .get(bindingId) as { n: number }).n;
};

describe("attributeRetrievalCredit", () => {
  test("no bindings cited → returns 0 and emits nothing", () => {
    const db = openDb(":memory:");
    const scored = emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "claude_inline",
      payload: { gate_kind: "test" },
      context_refs: [],
      residual: 0.1,
    });
    const n = attributeRetrievalCredit(db, {
      scored_event_id: scored.id,
      context_refs: [],
      residual: 0.1,
    });
    expect(n).toBe(0);
  });

  test("one binding cited with low residual → emits one credit row with polarity=credit", () => {
    const db = openDb(":memory:");
    const binding = seedBinding(db);
    const scored = emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "claude_inline",
      payload: { gate_kind: "test" },
      context_refs: [binding],
      residual: 0.05,
    });
    const n = attributeRetrievalCredit(db, {
      scored_event_id: scored.id,
      context_refs: [binding],
      residual: 0.05,
    });
    expect(n).toBe(1);
    expect(countCredit(db, binding)).toBe(1);
    const row = db
      .query(
        `SELECT payload FROM events
          WHERE kind = 'retrieval_credit_attributed'
            AND json_extract(payload, '$.retrieval_binding_event_id') = ?`,
      )
      .get(binding) as { payload: string };
    const p = JSON.parse(row.payload);
    expect(p.polarity).toBe("credit");
    expect(p.contribution_score).toBeCloseTo(1.0, 5);
    expect(p.residual_at_score).toBeCloseTo(0.05, 5);
    expect(p.projection_key).toBe(`${binding}:credit:${scored.id}`);
  });

  test("one binding cited with HIGH residual → polarity=debit", () => {
    const db = openDb(":memory:");
    const binding = seedBinding(db);
    const scored = emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "claude_inline",
      payload: {},
      context_refs: [binding],
      residual: 0.8,
    });
    attributeRetrievalCredit(db, { scored_event_id: scored.id, context_refs: [binding], residual: 0.8 });
    const row = db
      .query(
        `SELECT payload FROM events
          WHERE kind = 'retrieval_credit_attributed'
            AND json_extract(payload, '$.retrieval_binding_event_id') = ?`,
      )
      .get(binding) as { payload: string };
    expect(JSON.parse(row.payload).polarity).toBe("debit");
  });

  test("N bindings cited → contribution_score = 1/N per binding", () => {
    const db = openDb(":memory:");
    const b1 = seedBinding(db, "SRC_A");
    const b2 = seedBinding(db, "SRC_B");
    const b3 = seedBinding(db, "SRC_C");
    const scored = emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "claude_inline",
      payload: {},
      context_refs: [b1, b2, b3],
      residual: 0.1,
    });
    const n = attributeRetrievalCredit(db, { scored_event_id: scored.id, context_refs: [b1, b2, b3], residual: 0.1 });
    expect(n).toBe(3);
    for (const b of [b1, b2, b3]) {
      const row = db
        .query(
          `SELECT payload FROM events
            WHERE kind = 'retrieval_credit_attributed'
              AND json_extract(payload, '$.retrieval_binding_event_id') = ?`,
        )
        .get(b) as { payload: string };
      const p = JSON.parse(row.payload);
      expect(p.contribution_score).toBeCloseTo(1 / 3, 5);
    }
  });

  test("idempotency: re-running attribution on the same (binding, scored) does NOT double-emit", () => {
    const db = openDb(":memory:");
    const binding = seedBinding(db);
    const scored = emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "claude_inline",
      payload: {},
      context_refs: [binding],
      residual: 0.05,
    });
    attributeRetrievalCredit(db, { scored_event_id: scored.id, context_refs: [binding], residual: 0.05 });
    attributeRetrievalCredit(db, { scored_event_id: scored.id, context_refs: [binding], residual: 0.05 });
    attributeRetrievalCredit(db, { scored_event_id: scored.id, context_refs: [binding], residual: 0.05 });
    expect(countCredit(db, binding)).toBe(1);
  });

  test("context_refs containing non-binding ids are ignored gracefully", () => {
    const db = openDb(":memory:");
    const binding = seedBinding(db);
    const someKnowledgeRef = "SRC_FAKE_KNOWLEDGE";
    const scored = emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "claude_inline",
      payload: {},
      context_refs: [someKnowledgeRef, binding, "another_fake_id"],
      residual: 0.1,
    });
    const n = attributeRetrievalCredit(db, {
      scored_event_id: scored.id,
      context_refs: [someKnowledgeRef, binding, "another_fake_id"],
      residual: 0.1,
    });
    // Only the real binding is found; non-binding refs filtered out.
    expect(n).toBe(1);
    // Since only 1 binding was found, contribution_score is 1.0 (1/1).
    const row = db
      .query(
        `SELECT payload FROM events
          WHERE kind = 'retrieval_credit_attributed'
            AND json_extract(payload, '$.retrieval_binding_event_id') = ?`,
      )
      .get(binding) as { payload: string };
    expect(JSON.parse(row.payload).contribution_score).toBeCloseTo(1.0, 5);
  });
});
