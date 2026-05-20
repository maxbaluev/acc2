// acc2 brain_invocation_worker tests
// Validates the substrate-side brain dispatch primitive per brain
// HCWM88JN0H6NDB8V amendment GMZ08ASMTD7W.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import { runBrainInvocationTick } from "./brain_invocation_worker";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const seedRequest = (
  db: ReturnType<typeof openDb>,
  payload: Record<string, unknown>,
): string => {
  const ev = emitEvent(db, {
    kind: "brain_invocation_request",
    substrate_origin: "runtime",
    payload,
  });
  return ev.id;
};

describe("brain_invocation_worker", () => {
  test("dispatches a brain_invocation_request and emits brain_invocation_dispatched", async () => {
    const db = openDb(":memory:");
    seedRequest(db, {
      request_reason: "design_ambiguity",
      topic_keywords: ["composer_policy_bundles", "selection"],
      triggering_event_ids: ["TRIGGER_EVENT_1"],
      cited_artifact_ids: [],
      cited_knowledge_ids: [],
      emitter_identity: "test_emitter_one",
      urgency: "normal",
    });

    const calls: { directive: string; evidence: string[] }[] = [];
    const summary = await runBrainInvocationTick(db, {
      dispatchFn: async (directive, evidence) => {
        calls.push({ directive, evidence });
        return { task_id: "stub_task_1" };
      },
    });

    expect(summary.scanned).toBe(1);
    expect(summary.dispatched).toBe(1);
    expect(summary.throttled).toBe(0);
    expect(calls.length).toBe(1);
    expect(calls[0]!.directive).toContain("test_emitter_one");
    expect(calls[0]!.evidence).toContain("TRIGGER_EVENT_1");

    const dispatched = db
      .query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM events WHERE kind='brain_invocation_dispatched'`)
      .get();
    expect(dispatched?.c).toBe(1);
  });

  test("loop prevention: 4 requests from same emitter in window → 4th is throttled", async () => {
    const db = openDb(":memory:");
    const emitter = "burst_emitter";
    for (let i = 0; i < 4; i++) {
      seedRequest(db, {
        request_reason: "structural_fault",
        topic_keywords: [`topic_${i}`],
        triggering_event_ids: [`TRIG_${i}`],
        emitter_identity: emitter,
        urgency: "normal",
      });
    }

    const summary = await runBrainInvocationTick(db, {
      throttleLimit: 3,
      dispatchFn: async () => ({ task_id: "stub" }),
    });

    expect(summary.scanned).toBe(4);
    expect(summary.dispatched).toBeGreaterThanOrEqual(3);
    expect(summary.throttled).toBeGreaterThanOrEqual(1);
    const throttled = db
      .query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM events WHERE kind='brain_invocation_throttled'`)
      .get();
    expect(throttled?.c).toBeGreaterThanOrEqual(1);
  });

  test("dedup: same (topic_keywords, triggering_event_ids) within window → second skipped", async () => {
    const db = openDb(":memory:");
    seedRequest(db, {
      request_reason: "insufficient_synthesis",
      topic_keywords: ["dup_topic"],
      triggering_event_ids: ["DUP_TRIG"],
      emitter_identity: "dedup_emitter_a",
    });

    await runBrainInvocationTick(db, {
      dispatchFn: async () => ({ task_id: "first" }),
    });

    // Second request — same topic + triggers, different emitter
    seedRequest(db, {
      request_reason: "insufficient_synthesis",
      topic_keywords: ["dup_topic"],
      triggering_event_ids: ["DUP_TRIG"],
      emitter_identity: "dedup_emitter_b",
    });

    const summary = await runBrainInvocationTick(db, {
      dispatchFn: async () => ({ task_id: "second" }),
    });

    expect(summary.deduped).toBeGreaterThanOrEqual(1);
  });

  test("dispatch failure emits brain_invocation_failed", async () => {
    const db = openDb(":memory:");
    seedRequest(db, {
      request_reason: "repeated_silent_exit",
      topic_keywords: ["fail_topic"],
      triggering_event_ids: ["FAIL_TRIG"],
      emitter_identity: "fail_emitter",
    });

    const summary = await runBrainInvocationTick(db, {
      dispatchFn: async () => null,
    });

    expect(summary.failed).toBe(1);
    const failed = db
      .query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM events WHERE kind='brain_invocation_failed'`)
      .get();
    expect(failed?.c).toBe(1);
  });

  test("empty queue → zero scanned, zero emitted", async () => {
    const db = openDb(":memory:");
    const summary = await runBrainInvocationTick(db, {
      dispatchFn: async () => ({ task_id: "n/a" }),
    });
    expect(summary.scanned).toBe(0);
    expect(summary.dispatched).toBe(0);
    expect(summary.throttled).toBe(0);
  });
});
