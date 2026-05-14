// acc2 Father tests — Phase K (v2-design.md §14).

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { runViews } from "../substrate/views";
import { emitEvent } from "./events";
import { newId, nowIso } from "./ids";
import {
  fatherIterate,
  fatherLoop,
  detectFatherDrift,
  DIRECTIVE_TEMPLATES,
  FATHER_ACTION_EVENT_KINDS,
  selectByPriorityAndFreshnessAndConflicts,
} from "./father";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const openOwnerDirective = (
  db: ReturnType<typeof openDb>,
  opts: { urgency?: "normal" | "elevated" | "crisis"; text?: string } = {},
): string => {
  const id = newId();
  emitEvent(db, {
    kind: "directive_opened",
    substrate_origin: "owner",
    directive_id: id,
    task_id: id,
    payload: {
      directive_text: opts.text ?? "an owner objective",
      lifecycle: "finite",
      urgency: opts.urgency ?? "normal",
    },
  });
  return id;
};

describe("fatherIterate", () => {
  test("emits father_cycle_recorded with compile_directive_from_template when no work is queued", async () => {
    const db = openDb(":memory:");
    runViews(db);

    const result = await fatherIterate(db, { now: "2026-05-13T12:00:00.000Z" });
    expect(result.action).toBe("compile_directive_from_template");

    const cycleRows = db
      .query("SELECT payload FROM events WHERE kind = 'father_cycle_recorded'")
      .all() as Array<{ payload: string }>;
    expect(cycleRows.length).toBe(1);
    const payload = JSON.parse(cycleRows[0]!.payload);
    expect(payload.action).toBe("compile_directive_from_template");
    expect(payload.template_id).toBeTruthy();

    // Father opened a directive AND its root task via the template.
    const tplDirective = db
      .query(
        "SELECT COUNT(*) AS c FROM events WHERE kind = 'directive_opened' AND substrate_origin = 'father'",
      )
      .get() as { c: number };
    expect(tplDirective.c).toBe(1);
  });

  test("yields without opening a directive when the owner is active", async () => {
    const db = openDb(":memory:");
    runViews(db);

    // Owner just spoke.
    emitEvent(db, {
      kind: "owner_input_received",
      substrate_origin: "owner",
      payload: { text: "I'm here, hold on" },
    });

    const result = await fatherIterate(db, {
      now: nowIso(),
      ownerActiveWindowMs: 60_000,
    });
    expect(result.action).toBe("yield");

    // NO directive opened during the yield.
    const opened = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'directive_opened' AND substrate_origin = 'father'")
      .get() as { c: number };
    expect(opened.c).toBe(0);

    // father_yielded recorded.
    const yielded = db
      .query("SELECT payload FROM events WHERE kind = 'father_yielded'")
      .get() as { payload: string };
    expect(yielded).toBeTruthy();
    const p = JSON.parse(yielded.payload);
    expect(p.reason).toBe("owner_active");
  });

  test("rolling reviews due take priority over normal objectives", async () => {
    const db = openDb(":memory:");
    runViews(db);

    // 1) Normal active objective.
    openOwnerDirective(db, { text: "ship the q3 launch" });

    // 2) Rolling-active directive whose next_review_due is in the past.
    const rollingId = newId();
    emitEvent(db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: rollingId,
      task_id: rollingId,
      payload: {
        directive_text: "long-horizon: maintain physical health",
        lifecycle: "rolling_active",
        review_cadence: "weekly",
        next_review_due: "2020-01-01T00:00:00.000Z",
        partial_commit_checkpoints: [],
      },
    });

    const result = await fatherIterate(db, { now: "2026-05-13T12:00:00.000Z" });
    expect(result.action).toBe("open_review_directive");

    const reviewDue = db
      .query("SELECT directive_id FROM events WHERE kind = 'directive_review_due'")
      .get() as { directive_id: string } | null;
    expect(reviewDue).not.toBeNull();
    expect(reviewDue!.directive_id).toBe(rollingId);
  });

  test("skips directives that are blocked by an unresolved blocks edge", async () => {
    const db = openDb(":memory:");
    runViews(db);

    const blockerId = openOwnerDirective(db, { text: "complete migration" });
    const blockedId = openOwnerDirective(db, { text: "start follow-up work" });

    // Record blocks edge: blocker → blocked.
    emitEvent(db, {
      kind: "directive_interference_edge",
      substrate_origin: "owner",
      directive_id: blockerId,
      payload: {
        from_directive: blockerId,
        to_directive: blockedId,
        kind: "blocks",
        reason: "migration must finish first",
      },
    });

    const objectivesActive = db
      .query("SELECT directive_id FROM active_objectives_view")
      .all() as Array<{ directive_id: string }>;
    expect(objectivesActive.map((r) => r.directive_id)).toContain(blockerId);

    const result = await fatherIterate(db, { now: "2026-05-13T12:00:00.000Z" });
    // The selector should pick the blocker (not the blocked one). Since the
    // blocker IS a normal_objective, action becomes journal_cycle.
    expect(result.action).toBe("journal_cycle");
    const detail = result.detail as { directive_id: string };
    expect(detail.directive_id).toBe(blockerId);
  });

  test("LLM-call refusal: fatherIterate never invokes opencodeQuery", async () => {
    const db = openDb(":memory:");
    runViews(db);

    // The runtime path: fatherIterate completes without throwing AND emits no
    // bridge_invoked events — the only path to the bridge subprocess. The
    // §14 "zero LLM-call capability" rule is enforced structurally because
    // fatherIterate has no code path that calls bridge.opencodeQuery (the
    // module is not imported by runtime/father.ts).
    const bridgeBefore = (db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'bridge_invoked'")
      .get() as { c: number }).c;
    await fatherIterate(db, { now: "2026-05-13T12:00:00.000Z" });
    const bridgeAfter = (db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'bridge_invoked'")
      .get() as { c: number }).c;
    expect(bridgeAfter).toBe(bridgeBefore);
  });

  test("static guarantee: runtime/father.ts does NOT import the bridge module", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const fatherSrc = fs.readFileSync(
      path.join(import.meta.dirname ?? ".", "father.ts"),
      "utf-8",
    );
    expect(fatherSrc).not.toMatch(/from\s+["']\.\/bridge["']/);
    expect(fatherSrc).not.toMatch(/opencodeQuery/);
  });
});

describe("detectFatherDrift", () => {
  test("clean substrate: no drift detected", () => {
    const db = openDb(":memory:");
    runViews(db);
    const report = detectFatherDrift(db);
    expect(report.drift_count).toBe(0);
  });

  test("adversarial: a non-FatherAction event from substrate_origin='father' triggers father_drift_detected", () => {
    const db = openDb(":memory:");
    runViews(db);

    // Synthetically emit a non-FatherAction event from father origin.
    // Use `knowledge_candidate` — it's a real event kind but outside the
    // Father action set, simulating a drift / mis-tagged event.
    const offender = emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "father",
      payload: { text: "father shouldn't be emitting this" },
    });

    const report = detectFatherDrift(db);
    expect(report.drift_count).toBe(1);
    expect(report.offending_event_ids).toContain(offender.id);

    const drift = db
      .query("SELECT payload FROM events WHERE kind = 'father_drift_detected'")
      .get() as { payload: string };
    expect(drift).toBeTruthy();
    const p = JSON.parse(drift.payload);
    expect(p.offender_event_id).toBe(offender.id);
  });

  test("idempotent: rerunning detect doesn't re-emit for the same offender", () => {
    const db = openDb(":memory:");
    runViews(db);

    emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "father",
      payload: {},
    });

    detectFatherDrift(db);
    detectFatherDrift(db);

    const driftCount = (db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'father_drift_detected'")
      .get() as { c: number }).c;
    expect(driftCount).toBe(1);
  });

  test("FATHER_ACTION_EVENT_KINDS taxonomy is non-empty and covers Father's own emit set", () => {
    expect(FATHER_ACTION_EVENT_KINDS.size).toBeGreaterThan(0);
    expect(FATHER_ACTION_EVENT_KINDS.has("father_cycle_recorded")).toBe(true);
    expect(FATHER_ACTION_EVENT_KINDS.has("father_yielded")).toBe(true);
    expect(FATHER_ACTION_EVENT_KINDS.has("directive_opened")).toBe(true);
  });
});

describe("fatherLoop", () => {
  test("loop runs at least one tick and exits cleanly on signal abort", async () => {
    const db = openDb(":memory:");
    runViews(db);
    const controller = new AbortController();

    const loopPromise = fatherLoop(db, {
      signal: controller.signal,
      intervalMs: 50,
    });

    // Wait a moment for at least one tick to fire.
    await new Promise((r) => setTimeout(r, 60));
    controller.abort();
    await loopPromise;

    const ticks = (db
      .query(
        "SELECT COUNT(*) AS c FROM events WHERE substrate_origin = 'father' AND kind IN ('father_cycle_recorded', 'father_yielded')",
      )
      .get() as { c: number }).c;
    expect(ticks).toBeGreaterThanOrEqual(1);
  });

  test("loop swallows per-tick errors and keeps iterating", async () => {
    const db = openDb(":memory:");
    runViews(db);
    const controller = new AbortController();

    // Drop the events table to make fatherIterate throw — the loop should
    // catch the error and keep ticking (we'll restore the table mid-flight).
    db.run("ALTER TABLE events RENAME TO events_orig");
    const loopPromise = fatherLoop(db, {
      signal: controller.signal,
      intervalMs: 30,
    });
    await new Promise((r) => setTimeout(r, 50));
    db.run("ALTER TABLE events_orig RENAME TO events");
    await new Promise((r) => setTimeout(r, 80));
    controller.abort();
    await loopPromise;
    // Should have completed at least one successful tick after recovery.
    const ticks = (db
      .query(
        "SELECT COUNT(*) AS c FROM events WHERE substrate_origin = 'father'",
      )
      .get() as { c: number }).c;
    expect(ticks).toBeGreaterThanOrEqual(1);
  });
});

describe("fatherIterate multi-tick", () => {
  test("first tick opens a templated directive (no work in queue → template fallback)", async () => {
    const db = openDb(":memory:");
    runViews(db);

    const r1 = await fatherIterate(db, { now: "2026-05-13T12:00:00.000Z" });
    expect(r1.action).toBe("compile_directive_from_template");
    const t1 = (r1.detail as { template_id: string }).template_id;
    expect(typeof t1).toBe("string");

    // Father's own templated directive now appears in active_objectives_view.
    // On a second tick Father picks IT as a normal_objective and journals
    // the cycle (it does NOT decompose owner-authored objectives, including
    // its own templated ones — the dispatcher / scheduler handle them).
    const r2 = await fatherIterate(db, { now: "2026-05-13T12:01:00.000Z" });
    expect(r2.action).toBe("journal_cycle");
  });
});

describe("selectByPriorityAndFreshnessAndConflicts", () => {
  test("prefers crisis directives over normal directives by urgency order", () => {
    const objectives = [
      {
        directive_id: "d_normal",
        opened_ts: "2026-05-13T10:00:00.000Z",
        payload: { directive_text: "normal", urgency: "normal" },
      },
      {
        directive_id: "d_crisis",
        opened_ts: "2026-05-13T11:00:00.000Z",
        payload: { directive_text: "crisis", urgency: "crisis" },
      },
    ];
    const choice = selectByPriorityAndFreshnessAndConflicts(
      objectives,
      [],
      [],
      DIRECTIVE_TEMPLATES,
      new Map(),
      "2026-05-13T12:00:00.000Z",
    );
    expect(choice.kind).toBe("normal_objective");
    if (choice.kind === "normal_objective") {
      expect(choice.directive_id).toBe("d_crisis");
    }
  });

  test("tie-breaks by freshness (oldest opened_ts wins)", () => {
    const objectives = [
      {
        directive_id: "d_newer",
        opened_ts: "2026-05-13T11:00:00.000Z",
        payload: { directive_text: "newer", urgency: "normal" },
      },
      {
        directive_id: "d_older",
        opened_ts: "2026-05-13T09:00:00.000Z",
        payload: { directive_text: "older", urgency: "normal" },
      },
    ];
    const choice = selectByPriorityAndFreshnessAndConflicts(
      objectives,
      [],
      [],
      DIRECTIVE_TEMPLATES,
      new Map(),
      "2026-05-13T12:00:00.000Z",
    );
    expect(choice.kind).toBe("normal_objective");
    if (choice.kind === "normal_objective") {
      expect(choice.directive_id).toBe("d_older");
    }
  });

  test("returns yield_template when no objectives + no due reviews", () => {
    const choice = selectByPriorityAndFreshnessAndConflicts(
      [],
      [],
      [],
      DIRECTIVE_TEMPLATES,
      new Map(),
      "2026-05-13T12:00:00.000Z",
    );
    expect(choice.kind).toBe("yield_template");
  });
});
