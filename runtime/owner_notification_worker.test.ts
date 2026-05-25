import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { runOwnerNotificationWorker, type OwnerChannelPushInput } from "./owner_notification_worker";

const BASE = new Date();

afterAll(() => closeDb());
beforeEach(() => closeDb());

type TestDb = ReturnType<typeof openDb>;

const ts = (offsetMs: number): string => new Date(BASE.getTime() + offsetMs).toISOString();

const insertEvent = (
  db: TestDb,
  opts: {
    id: string;
    kind: string;
    directive_id?: string | null;
    task_id?: string | null;
    parent_task_id?: string | null;
    ts?: string;
    payload?: Record<string, unknown>;
  },
): void => {
  db.run(
    `INSERT INTO events (
       id, ts, directive_id, task_id, parent_task_id, loop_id,
       substrate_origin, kind, payload, context_refs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      opts.id,
      opts.ts ?? ts(0),
      opts.directive_id ?? "d_test",
      opts.task_id ?? "t_test",
      opts.parent_task_id ?? null,
      "loop_root",
      "substrate_auto",
      opts.kind,
      JSON.stringify(opts.payload ?? {}),
      JSON.stringify([]),
    ],
  );
};

const seedLiveDispatch = (db: TestDb, directiveId = "d_notify", taskId = "t_root"): void => {
  insertEvent(db, { id: `${directiveId}_open`, kind: "directive_opened", directive_id: directiveId, task_id: taskId, ts: ts(0) });
  insertEvent(db, { id: `${taskId}_open`, kind: "task_node_opened", directive_id: directiveId, task_id: taskId, ts: ts(1) });
  insertEvent(db, {
    id: `${taskId}_dispatch`,
    kind: "brain_dispatched",
    directive_id: directiveId,
    task_id: taskId,
    ts: ts(2),
    payload: { dispatch_id: `${taskId}_dispatch_id` },
  });
};

const pushedRows = (db: TestDb): Array<{ payload: string }> =>
  db.query("SELECT payload FROM events WHERE kind = 'owner_notification_pushed' ORDER BY ts ASC").all() as Array<{ payload: string }>;

describe("owner_notification_worker", () => {
  test("pushes owner text with dispatch status included", async () => {
    const db = openDb(":memory:");
    const messages: OwnerChannelPushInput[] = [];
    seedLiveDispatch(db);

    const summary = await runOwnerNotificationWorker(db, {
      now: BASE,
      maxRows: 1,
      channel: { push: (input) => { messages.push(input); return { channel: "test-owner-channel" }; } },
    });

    expect(summary.scanned).toBe(1);
    expect(summary.rendered_count).toBe(1);
    expect(summary.pushed_count).toBe(1);
    expect(messages.length).toBe(1);
    expect(messages[0]!.text).toContain("Current status: in progress.");
    expect(pushedRows(db).length).toBe(1);
  });

  test("dedupes by notification key and source event inside the window", async () => {
    const db = openDb(":memory:");
    const messages: OwnerChannelPushInput[] = [];
    seedLiveDispatch(db);

    const channel = { push: (input: OwnerChannelPushInput) => { messages.push(input); return { channel: "test-owner-channel" }; } };
    const first = await runOwnerNotificationWorker(db, { now: BASE, maxRows: 1, channel });
    const second = await runOwnerNotificationWorker(db, { now: BASE, maxRows: 1, channel });

    expect(first.pushed_count).toBe(1);
    expect(second.pushed_count).toBe(0);
    expect(second.skipped_duplicate).toBe(1);
    expect(messages.length).toBe(1);
  });

  test("notifies failures and stall-like health triggers", async () => {
    const db = openDb(":memory:");
    const messages: OwnerChannelPushInput[] = [];
    seedLiveDispatch(db, "d_fail", "t_fail");
    insertEvent(db, { id: "t_fail_failed", kind: "task_failed", directive_id: "d_fail", task_id: "t_fail", ts: ts(3) });
    seedLiveDispatch(db, "d_stall", "t_stall");
    insertEvent(db, {
      id: "d_stall_gate",
      kind: "constitutional_gate_decision",
      directive_id: "d_stall",
      task_id: "t_stall",
      ts: ts(4),
      payload: { gate: "scheduler_global_concurrency_cap" },
    });

    const summary = await runOwnerNotificationWorker(db, {
      now: BASE,
      maxRows: 20,
      channel: { push: (input) => { messages.push(input); return { channel: "test-owner-channel" }; } },
    });

    expect(summary.pushed_count).toBeGreaterThanOrEqual(2);
    expect(messages.some((m) => m.trigger === "failure" && m.text.includes("Work hit a problem."))).toBe(true);
    expect(messages.some((m) => m.trigger === "stall" && m.text.includes("Work appears stalled."))).toBe(true);
  });

  test("renders policy-compliant primary owner text", async () => {
    const db = openDb(":memory:");
    const messages: OwnerChannelPushInput[] = [];
    seedLiveDispatch(db, "DABC1234567890", "TABC1234567890");

    await runOwnerNotificationWorker(db, {
      now: BASE,
      maxRows: 1,
      channel: { push: (input) => { messages.push(input); return { channel: "test-owner-channel" }; } },
    });

    const text = messages[0]!.text;
    expect(text).not.toContain("DABC1234567890");
    expect(text).not.toContain("TABC1234567890");
    expect(text).not.toMatch(/dispatch_resolved_view|residual|substrate|event_id|task_id|directive_id/i);
    expect(text).toContain("Current status:");
  });
});
