// Tests for the pending_decision_retire_worker. Semantic apply leaves the
// pending-owner-decision surface as genuine consent only; the worker retires
// stale unresolved consent rows without classifying amendment structure.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { pendingOwnerDecisionQueueLive, runViews } from "../substrate/views";
import { newId } from "./ids";
import { classifyRetire, runPendingDecisionRetireWorker, STALE_PENDING_DECISION_AGE_MS } from "./pending_decision_retire_worker";

const FIXED_NOW = new Date("2026-05-19T12:00:00.000Z");
afterAll(() => closeDb());
beforeEach(() => closeDb());

type AmendmentOptions = { id?: string; ts: string; target: string; ownerGateRequired?: boolean };
const insertAmendment = (db: ReturnType<typeof openDb>, opts: AmendmentOptions): string => {
  const id = opts.id ?? newId();
  const payload = { lesson_kind: "doc_update", target_resource: opts.target, owner_consent_required: opts.ownerGateRequired ?? true, proposed_behavior: "apply semantic update" };
  db.run(
    `INSERT INTO events (id, ts, directive_id, task_id, parent_task_id, loop_id, substrate_origin, kind, payload, context_refs)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, opts.ts, "directive_test", "task_test", null, "loop_root", "opencode", "contract_amendment_proposed", JSON.stringify(payload), JSON.stringify([])],
  );
  return id;
};
const recentTs = (offsetMs = 0): string => new Date(FIXED_NOW.getTime() + offsetMs).toISOString();
const oldTs = (ageMs: number): string => new Date(FIXED_NOW.getTime() - ageMs).toISOString();


describe("classifyRetire", () => {
  const nowMs = FIXED_NOW.getTime();
  test("non-consent amendment rows are outside the consent surface", () => {
    expect(classifyRetire({ source_event_id: "e2", ts: recentTs(), target: "docs/a.md", owner_gate_required: 0 }, nowMs, STALE_PENDING_DECISION_AGE_MS)).toBeNull();
  });
  test("old genuine owner-consent rows retire as stale", () => {
    expect(classifyRetire({ source_event_id: "e3", ts: oldTs(STALE_PENDING_DECISION_AGE_MS + 1000), target: "docs/a.md", owner_gate_required: 1 }, nowMs, STALE_PENDING_DECISION_AGE_MS)).toBe("stale");
  });
  test("recent genuine owner-consent rows stay live", () => {
    expect(classifyRetire({ source_event_id: "e4", ts: recentTs(), target: "docs/a.md", owner_gate_required: 1 }, nowMs, STALE_PENDING_DECISION_AGE_MS)).toBeNull();
  });
});

describe("runPendingDecisionRetireWorker", () => {
  test("stale genuine owner-consent row is retired", () => {
    const db = openDb(); runViews(db);
    const id = insertAmendment(db, { ts: oldTs(STALE_PENDING_DECISION_AGE_MS + 60_000), target: "docs/operator-install.md" });
    const summary = runPendingDecisionRetireWorker(db, { now: FIXED_NOW });
    expect(summary.retired).toBe(1);
    expect(summary.by_reason.stale).toBe(1);
    const ret = db.query("SELECT payload FROM events WHERE kind = 'pending_decision_retired' AND json_extract(payload, '$.amendment_event_id') = ?").get(id) as { payload: string } | null;
    expect(JSON.parse(ret!.payload).reason).toBe("stale");
  });
  test("normal recent owner-consent row is not retired", () => {
    const db = openDb(); runViews(db);
    const id = insertAmendment(db, { ts: recentTs(), target: "docs/operator-install.md" });
    const summary = runPendingDecisionRetireWorker(db, { now: FIXED_NOW });
    expect(summary.retired).toBe(0);
    expect(pendingOwnerDecisionQueueLive(db).find((r) => r.representative_event_id === id)).toBeDefined();
  });
  test("mixed batch scans only owner-consent rows and retires stale ones", () => {
    const db = openDb(); runViews(db);
    insertAmendment(db, { ts: recentTs(-1000), target: "tests/a.test.ts" });
    insertAmendment(db, { ts: recentTs(-2000), target: "src/internal_helper.ts", ownerGateRequired: false });
    insertAmendment(db, { ts: oldTs(STALE_PENDING_DECISION_AGE_MS + 5000), target: "docs/c.md" });
    insertAmendment(db, { ts: recentTs(-3000), target: "docs/d.md" });
    const summary = runPendingDecisionRetireWorker(db, { now: FIXED_NOW });
    expect(summary.scanned).toBe(3);
    expect(summary.retired).toBe(1);
    expect(summary.by_reason.stale).toBe(1);
  });
});
