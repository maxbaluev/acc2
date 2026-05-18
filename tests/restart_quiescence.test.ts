// F8 restart quiescence tests. Three cases:
//   (a) zero open dispatches → returns "quiescent" immediately.
//   (b) one open dispatch → polls; once the dispatch_closed lands the
//       function returns "quiescent".
//   (c) the dispatch never closes → returns "timeout" with the still_open
//       set populated.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "../runtime/events";
import { waitForBrainQuiescence } from "../runtime/restart_quiescence";

const dbPath = ":memory:";
let db: ReturnType<typeof openDb>;

beforeEach(() => {
  db = openDb(dbPath);
});

afterEach(() => {
  closeDb(dbPath);
});

const seedDispatch = (dispatchId: string): void => {
  emitEvent(db, {
    kind: "brain_dispatched",
    substrate_origin: "opencode",
    directive_id: "d1",
    task_id: "t1",
    payload: {
      dispatch_id: dispatchId,
      session_token: "test-session",
      started_at_ms: Date.now(),
      subprocess_pid: 99,
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

describe("F8 waitForBrainQuiescence", () => {
  test("(a) zero open dispatches → quiescent immediately", async () => {
    const result = await waitForBrainQuiescence(db, { budgetMs: 1_000 });
    expect(result.status).toBe("quiescent");
    if (result.status === "quiescent") {
      expect(result.waited_ms).toBe(0);
      expect(result.open_count_initial).toBe(0);
      expect(result.open_count_final).toBe(0);
    }
  });

  test("(b) one open dispatch → becomes quiescent when close lands", async () => {
    seedDispatch("d-q-1");
    // Background close after 50ms simulates the brain subprocess
    // returning while quiescence is polling.
    setTimeout(() => { seedClose("d-q-1"); }, 50);
    const result = await waitForBrainQuiescence(db, { budgetMs: 5_000, pollIntervalMs: 25 });
    expect(result.status).toBe("quiescent");
    if (result.status === "quiescent") {
      expect(result.open_count_initial).toBe(1);
      expect(result.open_count_final).toBe(0);
      expect(result.waited_ms).toBeGreaterThanOrEqual(25);
    }
  }, 10_000);

  test("(c) timeout — open dispatches never close within budget", async () => {
    seedDispatch("d-q-2");
    const result = await waitForBrainQuiescence(db, { budgetMs: 200, pollIntervalMs: 50 });
    expect(result.status).toBe("timeout");
    if (result.status === "timeout") {
      expect(result.open_count_initial).toBe(1);
      expect(result.open_count_final).toBe(1);
      expect(result.still_open.length).toBe(1);
      expect(result.still_open[0].dispatch_id).toBe("d-q-2");
      expect(result.waited_ms).toBeGreaterThanOrEqual(200);
    }
  });
});
