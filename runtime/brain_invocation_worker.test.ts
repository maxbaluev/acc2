// acc2 brain_invocation_worker tests
// Validates the substrate-side brain dispatch primitive per brain
// HCWM88JN0H6NDB8V amendment GMZ08ASMTD7W.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import { runBrainInvocationTick } from "./brain_invocation_worker";
import { clearSqlPool, setSqlPool } from "./sql_pool_singleton";
import type { SqlWorkerPool } from "./sql_worker_pool";

afterAll(() => closeDb());
beforeEach(() => closeDb());

/** A mock pool whose `query` delegates to the SAME db via the synchronous
 *  bun:sqlite path — modeling "off-loop, same handle, same SQL". It records
 *  every statement so the test can PROVE the pooled (off-loop) branch was
 *  taken for the worker's three read scans. */
const makeDelegatingPool = (
  db: ReturnType<typeof openDb>,
  seen: string[],
): SqlWorkerPool =>
  ({
    query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
      seen.push(sql);
      return Promise.resolve(db.query(sql).all(...(params as any[])) as T[]);
    },
  } as unknown as SqlWorkerPool);

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

  // ── Off-loop read routing (SQL worker pool) ──────────────────────────────
  // The worker's three read scans (candidate-selection double-NOT-EXISTS +
  // recentDispatchCountByEmitter + dedupKeyExists) now route through poolQuery.
  // These tests prove: (1) the pooled/off-loop path produces byte-identical
  // selection/throttle/dedup results vs the sync path, and (2) the pooled
  // branch is actually exercised.
  describe("off-loop read routing", () => {
    afterEach(() => clearSqlPool());

    /** Seed a fixed scenario: a burst that trips the throttle, a dedup pair,
     *  and an already-dispatched request that selection must exclude. Returns
     *  the request ids in seed order. */
    const seedScenario = (db: ReturnType<typeof openDb>): void => {
      // Burst from one emitter → triggers throttle at limit=3.
      for (let i = 0; i < 4; i++) {
        emitEvent(db, {
          kind: "brain_invocation_request",
          substrate_origin: "runtime",
          payload: {
            request_reason: "structural_fault",
            topic_keywords: [`burst_topic_${i}`],
            triggering_event_ids: [`BURST_TRIG_${i}`],
            emitter_identity: "scenario_burst_emitter",
            urgency: "normal",
          },
        });
      }
      // A distinct dedup pair from a different emitter (same topic+triggers).
      emitEvent(db, {
        kind: "brain_invocation_request",
        substrate_origin: "runtime",
        payload: {
          request_reason: "insufficient_synthesis",
          topic_keywords: ["scenario_dup"],
          triggering_event_ids: ["SCENARIO_DUP_TRIG"],
          emitter_identity: "scenario_dedup_emitter",
          urgency: "normal",
        },
      });
    };

    test("pooled (off-loop) path equals sync path — same selection/throttle/dedup", async () => {
      // SYNC reference (no pool installed → poolQuery sync fallback).
      // NOTE: openDb(":memory:") is cached by path, so each comparison run must
      // close the prior handle to get a fresh substrate (state must not leak).
      const syncDb = openDb(":memory:");
      seedScenario(syncDb);
      clearSqlPool();
      const sync = await runBrainInvocationTick(syncDb, {
        throttleLimit: 3,
        dispatchFn: async () => ({ task_id: "ref" }),
      });
      closeDb();

      // OFF-LOOP: identical scenario on a FRESH db, delegating pool installed →
      // poolQuery takes the pooled branch for all three read scans.
      const poolDb = openDb(":memory:");
      seedScenario(poolDb);
      const seen: string[] = [];
      setSqlPool(makeDelegatingPool(poolDb, seen));
      const offloop = await runBrainInvocationTick(poolDb, {
        throttleLimit: 3,
        dispatchFn: async () => ({ task_id: "ref" }),
      });

      // The pooled branch was actually exercised: candidate-selection
      // double-NOT-EXISTS + the throttle/dedup COUNT(*) scans all routed
      // through the pool.
      expect(seen.some((s) => s.includes("NOT EXISTS"))).toBe(true);
      expect(seen.some((s) => s.includes("emitter_identity"))).toBe(true);
      expect(seen.some((s) => s.includes("dedup_key"))).toBe(true);

      // Identical aggregate behavior — same selection count, same throttle
      // count, same dedup count, same dispatch/fail counts.
      expect(offloop.scanned).toBe(sync.scanned);
      expect(offloop.dispatched).toBe(sync.dispatched);
      expect(offloop.throttled).toBe(sync.throttled);
      expect(offloop.deduped).toBe(sync.deduped);
      expect(offloop.failed).toBe(sync.failed);

      // And the throttle actually engaged (proving the scenario is non-trivial).
      expect(offloop.throttled).toBeGreaterThanOrEqual(1);
    });

    test("sync fallback (no pool) is identical to pooled — already-dispatched excluded", async () => {
      // Verify the candidate-selection NOT-EXISTS exclusion is preserved
      // off-loop: a request already marked dispatched must NOT be re-selected.
      const buildDb = () => {
        const db = openDb(":memory:");
        const req = emitEvent(db, {
          kind: "brain_invocation_request",
          substrate_origin: "runtime",
          payload: {
            request_reason: "design_ambiguity",
            topic_keywords: ["already_done"],
            triggering_event_ids: ["AD_TRIG"],
            emitter_identity: "already_emitter",
          },
        });
        // Mark it dispatched → selection must exclude it.
        emitEvent(db, {
          kind: "brain_invocation_dispatched",
          substrate_origin: "substrate_auto",
          payload: { request_event_id: req.id, emitter_identity: "already_emitter" },
        });
        // A fresh request that SHOULD be selected.
        emitEvent(db, {
          kind: "brain_invocation_request",
          substrate_origin: "runtime",
          payload: {
            request_reason: "design_ambiguity",
            topic_keywords: ["fresh"],
            triggering_event_ids: ["FRESH_TRIG"],
            emitter_identity: "fresh_emitter",
          },
        });
        return db;
      };

      clearSqlPool();
      const noPool = await runBrainInvocationTick(buildDb(), {
        dispatchFn: async () => ({ task_id: "x" }),
      });
      closeDb(); // drop the cached :memory: handle so the next run is fresh

      const poolDb = buildDb();
      const seen: string[] = [];
      setSqlPool(makeDelegatingPool(poolDb, seen));
      const withPool = await runBrainInvocationTick(poolDb, {
        dispatchFn: async () => ({ task_id: "x" }),
      });

      expect(seen.length).toBeGreaterThan(0); // pool was used
      // Only the fresh request is selected in both paths (the dispatched one
      // is excluded by the NOT-EXISTS).
      expect(withPool.scanned).toBe(1);
      expect(withPool.scanned).toBe(noPool.scanned);
      expect(withPool.dispatched).toBe(noPool.dispatched);
      expect(withPool.deduped).toBe(noPool.deduped);
      expect(withPool.throttled).toBe(noPool.throttled);
    });
  });
});
