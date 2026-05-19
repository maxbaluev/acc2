// Tests for the pending_decision_retire_worker. Per brain validation
// dispatch (2026-05-19): worker auto-retires test-file-target,
// anchor-missing, and age > 7d candidates while preserving the
// operator-visibility surface via the historical view. The LIVE view
// filters out retired rows; the historical view stays for audit.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import {
  pendingOwnerDecisionQueue,
  pendingOwnerDecisionQueueLive,
  runViews,
} from "../substrate/views";
import { newId } from "./ids";
import {
  classifyRetire,
  isTestFileTarget,
  runPendingDecisionRetireWorker,
  STALE_PENDING_DECISION_AGE_MS,
} from "./pending_decision_retire_worker";

const FIXED_NOW = new Date("2026-05-19T12:00:00.000Z");

afterAll(() => closeDb());
beforeEach(() => closeDb());

type AmendmentOptions = {
  id?: string;
  ts: string;
  target: string;
  anchor?: string | null;
  diff?: Record<string, unknown> | null;
  ownerGateRequired?: boolean;
  applyGateStatus?: string | null;
};

const insertAmendment = (
  db: ReturnType<typeof openDb>,
  opts: AmendmentOptions,
): string => {
  const id = opts.id ?? newId();
  // owner_gate_required is derived inside lesson_implementer_queue_view
  // from $.owner_consent_required on the payload (substrate/views.ts).
  // Setting it explicitly on the payload makes the row owner-gated so
  // the queue view's WHERE clause accepts it.
  const payload: Record<string, unknown> = {
    lesson_kind: "doc_update",
    target_resource: opts.target,
    owner_consent_required: opts.ownerGateRequired ?? true,
  };
  if (opts.anchor !== undefined) payload.anchor = opts.anchor;
  if (opts.diff !== undefined && opts.diff !== null) {
    payload.proposed_behavior = { diff: opts.diff, target_resource: opts.target };
  }
  db.run(
    `INSERT INTO events (
       id, ts, directive_id, task_id, parent_task_id, loop_id,
       substrate_origin, kind, payload, context_refs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      opts.ts,
      "directive_test",
      "task_test",
      null,
      "loop_root",
      "opencode",
      "contract_amendment_proposed",
      JSON.stringify(payload),
      JSON.stringify([]),
    ],
  );
  return id;
};

const goodDiff = {
  kind: "anchored_replace_v1",
  before: "old line",
  after: "new line",
};

const recentTs = (offsetMs: number = 0): string =>
  new Date(FIXED_NOW.getTime() + offsetMs).toISOString();

const oldTs = (ageMs: number): string =>
  new Date(FIXED_NOW.getTime() - ageMs).toISOString();

describe("isTestFileTarget", () => {
  test("recognizes tests/** paths", () => {
    expect(isTestFileTarget("tests/runtime/foo.test.ts")).toBe(true);
    expect(isTestFileTarget("system/acc2/tests/integration/x.ts")).toBe(true);
  });

  test("recognizes *.test.ts and *.spec.ts suffixes", () => {
    expect(isTestFileTarget("runtime/foo.test.ts")).toBe(true);
    expect(isTestFileTarget("runtime/foo.spec.ts")).toBe(true);
    expect(isTestFileTarget("runtime/foo.test.tsx")).toBe(true);
    expect(isTestFileTarget("runtime/foo.spec.tsx")).toBe(true);
    expect(isTestFileTarget("cli/foo.test.js")).toBe(true);
  });

  test("rejects non-test paths", () => {
    expect(isTestFileTarget("runtime/foo.ts")).toBe(false);
    expect(isTestFileTarget("docs/operator-install.md")).toBe(false);
    expect(isTestFileTarget("CLAUDE.md")).toBe(false);
    expect(isTestFileTarget(null)).toBe(false);
    expect(isTestFileTarget("")).toBe(false);
  });

  test("strips repo: prefix before classifying", () => {
    expect(isTestFileTarget("repo:tests/runtime/foo.test.ts")).toBe(true);
    expect(isTestFileTarget("repo:runtime/foo.ts")).toBe(false);
  });
});

describe("classifyRetire precedence", () => {
  const nowMs = FIXED_NOW.getTime();
  test("anchor_missing wins over test_file_target and stale", () => {
    const r = classifyRetire(
      {
        source_event_id: "e1",
        ts: oldTs(30 * 24 * 60 * 60 * 1000),
        target: "tests/foo.test.ts",
        anchor: null,
        candidate_diff: null,
        decline_candidate_reason: "anchor_missing",
      },
      nowMs,
      STALE_PENDING_DECISION_AGE_MS,
    );
    expect(r).toBe("anchor_missing");
  });

  test("test_file_target picked when shape is clean but target is a test", () => {
    const r = classifyRetire(
      {
        source_event_id: "e2",
        ts: recentTs(),
        target: "tests/runtime/foo.test.ts",
        anchor: "old line",
        candidate_diff: JSON.stringify(goodDiff),
        decline_candidate_reason: null,
      },
      nowMs,
      STALE_PENDING_DECISION_AGE_MS,
    );
    expect(r).toBe("test_file_target");
  });

  test("stale picked when row is otherwise eligible but old", () => {
    const r = classifyRetire(
      {
        source_event_id: "e3",
        ts: oldTs(STALE_PENDING_DECISION_AGE_MS + 1000),
        target: "docs/operator-install.md",
        anchor: "old line",
        candidate_diff: JSON.stringify(goodDiff),
        decline_candidate_reason: null,
      },
      nowMs,
      STALE_PENDING_DECISION_AGE_MS,
    );
    expect(r).toBe("stale");
  });

  test("null when row is recent, clean, non-test", () => {
    const r = classifyRetire(
      {
        source_event_id: "e4",
        ts: recentTs(),
        target: "docs/operator-install.md",
        anchor: "old line",
        candidate_diff: JSON.stringify(goodDiff),
        decline_candidate_reason: null,
      },
      nowMs,
      STALE_PENDING_DECISION_AGE_MS,
    );
    expect(r).toBeNull();
  });
});

describe("runPendingDecisionRetireWorker — end-to-end", () => {
  test("test-file target → retired with reason=test_file_target", () => {
    const db = openDb();
    runViews(db);
    const id = insertAmendment(db, {
      ts: recentTs(),
      target: "tests/runtime/foo.test.ts",
      anchor: "old",
      diff: goodDiff,
    });
    // Sanity: row IS on the historical view before retire.
    const before = pendingOwnerDecisionQueue(db);
    expect(before.find((r) => r.representative_event_id === id)).toBeDefined();

    const summary = runPendingDecisionRetireWorker(db, { now: FIXED_NOW });
    expect(summary.retired).toBe(1);
    expect(summary.by_reason.test_file_target).toBe(1);
    expect(summary.by_reason.stale).toBe(0);
    expect(summary.by_reason.anchor_missing).toBe(0);

    // After retire: historical view still has it; LIVE view filters it out.
    const histAfter = pendingOwnerDecisionQueue(db);
    expect(histAfter.find((r) => r.representative_event_id === id)).toBeDefined();
    const liveAfter = pendingOwnerDecisionQueueLive(db);
    expect(liveAfter.find((r) => r.representative_event_id === id)).toBeUndefined();

    // Retire event exists with the expected payload.
    const ret = db
      .query(
        "SELECT payload FROM events WHERE kind = 'pending_decision_retired' AND json_extract(payload, '$.amendment_event_id') = ?",
      )
      .get(id) as { payload: string } | null;
    expect(ret).not.toBeNull();
    const parsed = JSON.parse(ret!.payload);
    expect(parsed.reason).toBe("test_file_target");
    expect(parsed.amendment_event_id).toBe(id);
    expect(parsed.retired_at).toBeDefined();
  });

  test("anchor_missing (null anchor) → retired with reason=anchor_missing", () => {
    const db = openDb();
    runViews(db);
    const id = insertAmendment(db, {
      ts: recentTs(),
      target: "docs/operator-install.md",
      anchor: null,
      diff: goodDiff,
    });
    const summary = runPendingDecisionRetireWorker(db, { now: FIXED_NOW });
    expect(summary.retired).toBe(1);
    expect(summary.by_reason.anchor_missing).toBe(1);

    const liveAfter = pendingOwnerDecisionQueueLive(db);
    expect(liveAfter.find((r) => r.representative_event_id === id)).toBeUndefined();
  });

  test("empty-after diff → retired with reason=anchor_missing (covers malformed shape)", () => {
    const db = openDb();
    runViews(db);
    const id = insertAmendment(db, {
      ts: recentTs(),
      target: "docs/operator-install.md",
      anchor: "before line",
      diff: { kind: "anchored_replace_v1", before: "before line", after: "" },
    });
    const summary = runPendingDecisionRetireWorker(db, { now: FIXED_NOW });
    expect(summary.retired).toBe(1);
    expect(summary.by_reason.anchor_missing).toBe(1);
    // source_decline_candidate_reason preserves the underlying shape
    const ret = db
      .query(
        "SELECT payload FROM events WHERE kind = 'pending_decision_retired' AND json_extract(payload, '$.amendment_event_id') = ?",
      )
      .get(id) as { payload: string } | null;
    expect(ret).not.toBeNull();
    const parsed = JSON.parse(ret!.payload);
    expect(parsed.source_decline_candidate_reason).toBe("empty_after");
  });

  test("age > 7 days → retired with reason=stale", () => {
    const db = openDb();
    runViews(db);
    const id = insertAmendment(db, {
      ts: oldTs(STALE_PENDING_DECISION_AGE_MS + 60_000),
      target: "docs/operator-install.md",
      anchor: "before line",
      diff: goodDiff,
    });
    const summary = runPendingDecisionRetireWorker(db, { now: FIXED_NOW });
    expect(summary.retired).toBe(1);
    expect(summary.by_reason.stale).toBe(1);
    const ret = db
      .query(
        "SELECT payload FROM events WHERE kind = 'pending_decision_retired' AND json_extract(payload, '$.amendment_event_id') = ?",
      )
      .get(id) as { payload: string } | null;
    expect(ret).not.toBeNull();
    const parsed = JSON.parse(ret!.payload);
    expect(parsed.reason).toBe("stale");
  });

  test("normal recent owner-decision → NOT retired", () => {
    const db = openDb();
    runViews(db);
    const id = insertAmendment(db, {
      ts: recentTs(),
      target: "docs/operator-install.md",
      anchor: "before line",
      diff: goodDiff,
    });
    const summary = runPendingDecisionRetireWorker(db, { now: FIXED_NOW });
    expect(summary.retired).toBe(0);
    expect(summary.skipped_not_eligible).toBeGreaterThanOrEqual(1);

    // Row stays on BOTH views.
    const hist = pendingOwnerDecisionQueue(db);
    const live = pendingOwnerDecisionQueueLive(db);
    expect(hist.find((r) => r.representative_event_id === id)).toBeDefined();
    expect(live.find((r) => r.representative_event_id === id)).toBeDefined();
  });

  test("idempotency: second run on the same row produces no new retire event", () => {
    const db = openDb();
    runViews(db);
    const id = insertAmendment(db, {
      ts: oldTs(STALE_PENDING_DECISION_AGE_MS + 60_000),
      target: "docs/operator-install.md",
      anchor: "before line",
      diff: goodDiff,
    });
    const first = runPendingDecisionRetireWorker(db, { now: FIXED_NOW });
    expect(first.retired).toBe(1);

    const second = runPendingDecisionRetireWorker(db, { now: FIXED_NOW });
    expect(second.retired).toBe(0);
    expect(second.skipped_already_retired).toBe(1);

    // Only ONE pending_decision_retired row in the ledger.
    const count = db
      .query(
        "SELECT COUNT(*) AS c FROM events WHERE kind = 'pending_decision_retired' AND json_extract(payload, '$.amendment_event_id') = ?",
      )
      .get(id) as { c: number };
    expect(count.c).toBe(1);
  });

  test("mixed batch: each row classified independently and counted by reason", () => {
    const db = openDb();
    runViews(db);
    insertAmendment(db, { ts: recentTs(-1000), target: "tests/a.test.ts", anchor: "x", diff: goodDiff });
    insertAmendment(db, { ts: recentTs(-2000), target: "docs/b.md", anchor: null, diff: goodDiff });
    insertAmendment(db, { ts: oldTs(STALE_PENDING_DECISION_AGE_MS + 5000), target: "docs/c.md", anchor: "y", diff: goodDiff });
    insertAmendment(db, { ts: recentTs(-3000), target: "docs/d.md", anchor: "z", diff: goodDiff });

    const summary = runPendingDecisionRetireWorker(db, { now: FIXED_NOW });
    expect(summary.scanned).toBe(4);
    expect(summary.retired).toBe(3);
    expect(summary.by_reason.test_file_target).toBe(1);
    expect(summary.by_reason.anchor_missing).toBe(1);
    expect(summary.by_reason.stale).toBe(1);
    expect(summary.skipped_not_eligible).toBe(1);
  });
});
