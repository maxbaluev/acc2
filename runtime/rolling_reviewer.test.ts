// acc2 rolling-reviewer tests — Phase I (v2-design.md §3.1).

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { runViews } from "../substrate/views";
import { emitEvent } from "./events";
import { newId } from "./ids";
import {
  readRollingReviewsDue,
  processRollingReviews,
  archiveStaleRollingDirectives,
  rollingReviewerWorkerTick,
} from "./rolling_reviewer";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const openRollingDirective = (
  db: ReturnType<typeof openDb>,
  opts: { reviewCadence?: "daily" | "weekly" | "monthly"; nextReviewDue?: string; text?: string } = {},
): string => {
  const id = newId();
  emitEvent(db, {
    kind: "directive_opened",
    substrate_origin: "owner",
    directive_id: id,
    task_id: id,
    payload: {
      directive_text: opts.text ?? "long-horizon goal",
      lifecycle: "rolling_active",
      review_cadence: opts.reviewCadence ?? "weekly",
      next_review_due: opts.nextReviewDue ?? "2020-01-01T00:00:00.000Z",
      partial_commit_checkpoints: [],
    },
  });
  return id;
};

describe("rolling_reviewer", () => {
  test("readRollingReviewsDue surfaces past-due rolling directives", () => {
    const db = openDb(":memory:");
    runViews(db);
    openRollingDirective(db, { nextReviewDue: "2020-01-01T00:00:00.000Z" });
    const due = readRollingReviewsDue(db, "2026-05-13T12:00:00.000Z");
    expect(due.length).toBe(1);
    expect(due[0]!.lifecycle.kind).toBe("rolling_active");
    expect(due[0]!.lifecycle.review_cadence).toBe("weekly");
  });

  test("readRollingReviewsDue ignores future-due directives", () => {
    const db = openDb(":memory:");
    runViews(db);
    openRollingDirective(db, { nextReviewDue: "2099-01-01T00:00:00.000Z" });
    const due = readRollingReviewsDue(db, "2026-05-13T12:00:00.000Z");
    expect(due.length).toBe(0);
  });

  test("processRollingReviews opens a review task and advances next_review_due", async () => {
    const db = openDb(":memory:");
    runViews(db);
    const id = openRollingDirective(db, { nextReviewDue: "2020-01-01T00:00:00.000Z" });

    const summary = await processRollingReviews(db, "2026-05-13T12:00:00.000Z");
    expect(summary.reviews_opened).toBe(1);

    // directive_review_due emitted
    const dueRows = db
      .query("SELECT COUNT(*) as c FROM events WHERE kind = 'directive_review_due' AND directive_id = ?")
      .get(id) as { c: number };
    expect(dueRows.c).toBe(1);

    // review task_node_opened emitted
    const taskRows = db
      .query(
        "SELECT payload FROM events WHERE kind = 'task_node_opened' AND directive_id = ? AND parent_task_id IS NULL",
      )
      .all(id) as Array<{ payload: string }>;
    const reviewTask = taskRows.find((r) => {
      try {
        const p = JSON.parse(r.payload);
        return typeof p.goal === "string" && p.goal.startsWith("review progress");
      } catch {
        return false;
      }
    });
    expect(reviewTask).toBeTruthy();

    // directive_amended emitted to advance next_review_due
    const amendRows = db
      .query(
        "SELECT payload FROM events WHERE kind = 'directive_amended' AND directive_id = ? ORDER BY ts DESC LIMIT 1",
      )
      .get(id) as { payload: string };
    const amendPayload = JSON.parse(amendRows.payload);
    expect(amendPayload.next_review_due > "2026-05-13T12:00:00.000Z").toBe(true);
  });

  test("processRollingReviews is idempotent for the same due date", async () => {
    const db = openDb(":memory:");
    runViews(db);
    openRollingDirective(db, { nextReviewDue: "2020-01-01T00:00:00.000Z" });
    await processRollingReviews(db, "2026-05-13T12:00:00.000Z");
    const second = await processRollingReviews(db, "2026-05-13T12:00:00.000Z");
    // The amended next_review_due has rolled the cadence forward; a second
    // pass shouldn't re-fire the SAME review.
    expect(second.reviews_opened).toBe(0);
  });

  test("archiveStaleRollingDirectives archives after N missed reviews", async () => {
    const db = openDb(":memory:");
    runViews(db);
    const id = openRollingDirective(db, { nextReviewDue: "2020-01-01T00:00:00.000Z" });

    // Simulate 3 unresolved directive_review_due events (none marked completed).
    for (let i = 0; i < 3; i++) {
      emitEvent(db, {
        kind: "directive_review_due",
        substrate_origin: "substrate_auto",
        directive_id: id,
        payload: { cadence: "weekly", attempt: i },
      });
    }

    const archived = await archiveStaleRollingDirectives(db, { maxMissedReviews: 3 });
    expect(archived.archived).toContain(id);

    const archivedRows = db
      .query(
        "SELECT failure_kind FROM events WHERE kind = 'directive_archived_missed_reviews' AND directive_id = ?",
      )
      .all(id) as Array<{ failure_kind: string }>;
    expect(archivedRows.length).toBe(1);
    expect(archivedRows[0]!.failure_kind).toBe("rolling_directive_archived");

    // active_objectives_view excludes archived directives.
    const active = db
      .query("SELECT directive_id FROM active_objectives_view WHERE directive_id = ?")
      .get(id) as { directive_id: string } | null;
    expect(active).toBeNull();
  });

  test("archiveStaleRollingDirectives does NOT archive when under cap", async () => {
    const db = openDb(":memory:");
    runViews(db);
    const id = openRollingDirective(db, { nextReviewDue: "2020-01-01T00:00:00.000Z" });
    emitEvent(db, {
      kind: "directive_review_due",
      substrate_origin: "substrate_auto",
      directive_id: id,
      payload: {},
    });
    const archived = await archiveStaleRollingDirectives(db, { maxMissedReviews: 3 });
    expect(archived.archived.length).toBe(0);
  });

  test("rollingReviewerWorkerTick combines process + archive", async () => {
    const db = openDb(":memory:");
    runViews(db);
    openRollingDirective(db, { nextReviewDue: "2020-01-01T00:00:00.000Z" });
    const tick = await rollingReviewerWorkerTick(db, { now: "2026-05-13T12:00:00.000Z" });
    expect(tick.reviews_opened).toBe(1);
    expect(Array.isArray(tick.archived)).toBe(true);
  });

  test("a completed review (milestone_recorded review_completed) doesn't count as missed", async () => {
    const db = openDb(":memory:");
    runViews(db);
    const id = openRollingDirective(db, { nextReviewDue: "2020-01-01T00:00:00.000Z" });
    emitEvent(db, {
      kind: "directive_review_due",
      substrate_origin: "substrate_auto",
      directive_id: id,
      payload: {},
    });
    emitEvent(db, {
      kind: "directive_milestone_recorded",
      substrate_origin: "substrate_auto",
      directive_id: id,
      payload: { milestone: "review_completed" },
    });
    emitEvent(db, {
      kind: "directive_review_due",
      substrate_origin: "substrate_auto",
      directive_id: id,
      payload: {},
    });
    const archived = await archiveStaleRollingDirectives(db, { maxMissedReviews: 2 });
    // Only 1 unresolved due event after the completion marker; cap=2, no archive.
    expect(archived.archived).not.toContain(id);
  });
});
