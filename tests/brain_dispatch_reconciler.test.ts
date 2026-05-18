// F8 boot reconciler tests. Three cases:
//   (a) every brain_dispatched has a matching brain_dispatch_closed → no
//       reconciliation needed (the open set is empty).
//   (b) two stale brain_dispatched rows with no matching close → both
//       receive a synthetic brain_dispatch_closed with
//       closure_reason=restart_reconciled.
//   (c) running reconcile twice produces the same result; no duplicate
//       close rows land because the second call sees zero open rows.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "../runtime/events";
import {
  getOpenBrainDispatches,
  reconcileBrainDispatchesAtBoot,
  _resetBootSessionTokenForTests,
} from "../runtime/brain_dispatch_reconciler";

const dbPath = ":memory:";
let db: ReturnType<typeof openDb>;

beforeEach(() => {
  _resetBootSessionTokenForTests();
  db = openDb(dbPath);
});

afterEach(() => {
  closeDb(dbPath);
});

const seedDispatch = (dispatchId: string, sessionToken: string, taskId: string): void => {
  emitEvent(db, {
    kind: "brain_dispatched",
    substrate_origin: "opencode",
    directive_id: "d1",
    task_id: taskId,
    payload: {
      dispatch_id: dispatchId,
      session_token: sessionToken,
      started_at_ms: Date.now(),
      subprocess_pid: 12345,
      directive_id: "d1",
    },
  });
};

const seedClose = (dispatchId: string): void => {
  emitEvent(db, {
    kind: "brain_dispatch_closed",
    substrate_origin: "opencode",
    directive_id: "d1",
    payload: {
      dispatch_id: dispatchId,
      closure_reason: "brain_returned_normally",
      closed_at_ms: Date.now(),
    },
  });
};

describe("F8 brain_dispatch_reconciler", () => {
  test("(a) every dispatch is matched → no reconciliation", () => {
    seedDispatch("d-1", "old-session", "t1");
    seedClose("d-1");
    seedDispatch("d-2", "old-session", "t2");
    seedClose("d-2");

    expect(getOpenBrainDispatches(db).length).toBe(0);
    const summary = reconcileBrainDispatchesAtBoot(db, "new-session");
    expect(summary.reconciled_count).toBe(0);
    expect(summary.reconciled_dispatch_ids).toEqual([]);
    expect(summary.boot_session_token).toBe("new-session");
  });

  test("(b) two unclosed dispatches both receive restart_reconciled closes", () => {
    seedDispatch("d-3", "old-session", "t3");
    seedDispatch("d-4", "old-session", "t4");
    expect(getOpenBrainDispatches(db).length).toBe(2);

    const summary = reconcileBrainDispatchesAtBoot(db, "boot-token-b");
    expect(summary.reconciled_count).toBe(2);
    expect(summary.reconciled_dispatch_ids.sort()).toEqual(["d-3", "d-4"]);
    expect(summary.boot_session_token).toBe("boot-token-b");

    // Verify the synthetic close rows actually landed with the expected
    // closure_reason + boot_session_token.
    const closes = db
      .query(
        `SELECT payload FROM events
         WHERE kind = 'brain_dispatch_closed'
         AND json_extract(payload, '$.closure_reason') = 'restart_reconciled'
         ORDER BY ts ASC`,
      )
      .all() as Array<{ payload: string }>;
    expect(closes.length).toBe(2);
    for (const row of closes) {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      expect(payload.closure_reason).toBe("restart_reconciled");
      expect(payload.boot_session_token).toBe("boot-token-b");
      expect(typeof payload.dispatch_id).toBe("string");
    }
    expect(getOpenBrainDispatches(db).length).toBe(0);
  });

  test("(c) idempotent — second reconcile is a no-op (no duplicate closes)", () => {
    seedDispatch("d-5", "old-session", "t5");
    expect(getOpenBrainDispatches(db).length).toBe(1);

    const first = reconcileBrainDispatchesAtBoot(db, "boot-token-c");
    expect(first.reconciled_count).toBe(1);

    const closesBefore = db
      .query(
        `SELECT COUNT(*) AS n FROM events
         WHERE kind = 'brain_dispatch_closed'
         AND json_extract(payload, '$.dispatch_id') = ?`,
      )
      .get("d-5") as { n: number };
    expect(closesBefore.n).toBe(1);

    const second = reconcileBrainDispatchesAtBoot(db, "boot-token-c");
    expect(second.reconciled_count).toBe(0);

    const closesAfter = db
      .query(
        `SELECT COUNT(*) AS n FROM events
         WHERE kind = 'brain_dispatch_closed'
         AND json_extract(payload, '$.dispatch_id') = ?`,
      )
      .get("d-5") as { n: number };
    expect(closesAfter.n).toBe(1);
  });
});
