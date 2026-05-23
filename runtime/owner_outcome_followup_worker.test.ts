// Tests for the owner_outcome_followup worker. Per brain amendment
// 1Z3PMEYE7X44343E7K8ARCDY20 (T1.1): worker scans applied_change_committed
// events older than the feedback window with affected_resources and emits
// one hidl_action_required per eligible change so the owner can register
// outcome truth (becomes owner_observed_outcome_recorded via the existing
// CLI path).

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { newId } from "./ids";
import { runOwnerOutcomeFollowupWorker } from "./owner_outcome_followup_worker";

const FIXED_NOW = new Date("2026-05-19T12:00:00.000Z");
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

afterAll(() => closeDb());
beforeEach(() => closeDb());

type AppliedChangeOpts = {
  id?: string;
  ts: string;
  status?: string;
  affected_resources?: unknown[];
  context_refs?: string[];
  payload_extra?: Record<string, unknown>;
};

const insertAppliedChange = (
  db: ReturnType<typeof openDb>,
  opts: AppliedChangeOpts,
): string => {
  const id = opts.id ?? newId();
  const payload = {
    status: opts.status ?? "applied",
    affected_resources: opts.affected_resources ?? ["docs/operator-install.md"],
    ...(opts.payload_extra ?? {}),
  };
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
      "claude",
      "applied_change_committed",
      JSON.stringify(payload),
      JSON.stringify(opts.context_refs ?? []),
    ],
  );
  return id;
};

const insertPriorHidl = (
  db: ReturnType<typeof openDb>,
  sourceId: string,
): void => {
  db.run(
    `INSERT INTO events (
       id, ts, directive_id, task_id, parent_task_id, loop_id,
       substrate_origin, kind, payload, context_refs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId(),
      FIXED_NOW.toISOString(),
      "directive_test",
      "task_test",
      null,
      "loop_root",
      "substrate_auto",
      "hidl_action_required",
      JSON.stringify({
        reason: "owner_outcome_followup",
        source_applied_change_event_id: sourceId,
      }),
      JSON.stringify([sourceId]),
    ],
  );
};

const oldTs = (ageMs: number): string =>
  new Date(FIXED_NOW.getTime() - ageMs).toISOString();

const findHidlForSource = (
  db: ReturnType<typeof openDb>,
  sourceId: string,
): { payload: string } | null =>
  db
    .query(
      `SELECT payload FROM events
        WHERE kind = 'hidl_action_required'
          AND json_extract(payload, '$.source_applied_change_event_id') = ?`,
    )
    .get(sourceId) as { payload: string } | null;

describe("owner_outcome_followup_worker", () => {
  test("emits hidl_action_required for eligible applied change past the window", async () => {
    const db = openDb();
    const id = insertAppliedChange(db, {
      ts: oldTs(ONE_DAY_MS + 60_000),
      status: "applied",
      affected_resources: ["docs/operator-install.md", "runtime/foo.ts"],
    });
    const summary = await runOwnerOutcomeFollowupWorker(db, { now: FIXED_NOW });
    expect(summary.scanned).toBe(1);
    expect(summary.emitted_count).toBe(1);
    expect(summary.emitted_event_ids.length).toBe(1);
    expect(summary.skipped_recent).toBe(0);
    expect(summary.skipped_ineligible).toBe(0);
    expect(summary.skipped_existing_followup).toBe(0);

    const hidl = findHidlForSource(db, id);
    expect(hidl).not.toBeNull();
    const parsed = JSON.parse(hidl!.payload);
    expect(parsed.reason).toBe("owner_outcome_followup");
    expect(parsed.source_applied_change_event_id).toBe(id);
    expect(Array.isArray(parsed.affected_resources)).toBe(true);
    expect(parsed.affected_resources.length).toBe(2);
    expect(Array.isArray(parsed.evidence_event_ids)).toBe(true);
    expect(parsed.evidence_event_ids).toContain(id);
  });

  test("skips recent applied changes (within window)", async () => {
    const db = openDb();
    insertAppliedChange(db, {
      ts: oldTs(60_000), // 1 minute old, well within the 24h window
      status: "applied",
      affected_resources: ["docs/operator-install.md"],
    });
    const summary = await runOwnerOutcomeFollowupWorker(db, { now: FIXED_NOW });
    // STARVATION FIX (2026-05-23): the feedback-window cutoff is now pushed
    // into SQL (`ts <= now - window`), so within-window rows are filtered
    // BEFORE the scan loop rather than skipped inside it. scanned=0 here.
    expect(summary.scanned).toBe(0);
    expect(summary.emitted_count).toBe(0);
  });

  test("skips applied changes with prior followup (idempotent)", async () => {
    const db = openDb();
    const id = insertAppliedChange(db, {
      ts: oldTs(ONE_DAY_MS + 60_000),
      status: "applied",
      affected_resources: ["docs/operator-install.md"],
    });
    insertPriorHidl(db, id);
    const summary = await runOwnerOutcomeFollowupWorker(db, { now: FIXED_NOW });
    // STARVATION FIX (2026-05-23): already-followed-up rows are now excluded
    // by a SQL NOT EXISTS so they never consume the LIMIT (the prior bug
    // starved newly-aged changes once >maxRows older rows accumulated).
    // The row is filtered pre-scan, so scanned=0 and nothing is re-emitted.
    expect(summary.scanned).toBe(0);
    expect(summary.emitted_count).toBe(0);
  });

  test("newly-aged change is reachable even behind maxRows already-followed older changes (starvation regression)", async () => {
    const db = openDb();
    // Seed maxRows older applied changes that ALL already have a follow-up.
    // Pre-fix, these consumed the entire `ORDER BY ts ASC LIMIT maxRows`
    // window and the newly-aged change below was never reached.
    const maxRows = 5;
    for (let i = 0; i < maxRows; i++) {
      const olderId = insertAppliedChange(db, {
        ts: oldTs(ONE_DAY_MS + 10 * ONE_DAY_MS + i * 1000),
        status: "applied",
        affected_resources: ["docs/operator-install.md"],
      });
      insertPriorHidl(db, olderId);
    }
    // A newer (but still aged-out) change with NO follow-up yet.
    const freshId = insertAppliedChange(db, {
      ts: oldTs(ONE_DAY_MS + 60_000),
      status: "applied",
      affected_resources: ["runtime/foo.ts"],
    });
    const summary = await runOwnerOutcomeFollowupWorker(db, { now: FIXED_NOW, maxRows });
    // The fresh change must be reached and emitted despite the maxRows older
    // already-followed rows that previously consumed the limit.
    expect(summary.emitted_count).toBe(1);
    expect(findHidlForSource(db, freshId)).not.toBeNull();
  });

  test("skips applied changes whose status is not 'applied'", async () => {
    const db = openDb();
    insertAppliedChange(db, {
      ts: oldTs(ONE_DAY_MS + 60_000),
      status: "failed",
      affected_resources: ["docs/operator-install.md"],
    });
    insertAppliedChange(db, {
      ts: oldTs(ONE_DAY_MS + 60_000),
      status: "refused",
      affected_resources: ["docs/operator-install.md"],
    });
    insertAppliedChange(db, {
      ts: oldTs(ONE_DAY_MS + 60_000),
      status: "applied",
      affected_resources: [], // empty affected_resources is ineligible too
    });
    const summary = await runOwnerOutcomeFollowupWorker(db, { now: FIXED_NOW });
    expect(summary.scanned).toBe(3);
    expect(summary.skipped_ineligible).toBe(3);
    expect(summary.emitted_count).toBe(0);
  });

  test("dryRun mode: counts eligibility but does not emit", async () => {
    const db = openDb();
    const id = insertAppliedChange(db, {
      ts: oldTs(ONE_DAY_MS + 60_000),
      status: "applied",
      affected_resources: ["docs/operator-install.md"],
    });
    const summary = await runOwnerOutcomeFollowupWorker(db, {
      now: FIXED_NOW,
      dryRun: true,
    });
    expect(summary.scanned).toBe(1);
    expect(summary.emitted_count).toBe(0);
    expect(summary.emitted_event_ids.length).toBe(0);
    // No hidl_action_required row was actually written.
    const hidl = findHidlForSource(db, id);
    expect(hidl).toBeNull();
  });
});
