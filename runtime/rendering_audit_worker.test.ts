import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import { runViews } from "../substrate/views";
import {
  renderingAuditWorkerTick,
  DEFAULT_RENDERING_AUDIT_WINDOW_MS,
} from "./rendering_audit_worker";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const seedRender = (
  db: ReturnType<typeof openDb>,
  text: string,
  audience: "primary" | "detail_drawer" = "primary",
): string => {
  const ev = emitEvent(db, {
    kind: "rendered_owner_message_recorded",
    substrate_origin: "claude_inline",
    payload: { rendered_text: text, audience, surface: "test" },
  });
  return ev.id;
};

const countFeedback = (db: ReturnType<typeof openDb>, sourceId: string): number => {
  return (db
    .query(
      `SELECT count(*) as n FROM events
        WHERE kind = 'owner_rendering_feedback_recorded'
          AND json_extract(payload, '$.source_rendered_event_id') = ?`,
    )
    .get(sourceId) as { n: number }).n;
};

describe("renderingAuditWorkerTick", () => {
  test("no rendered rows → zero work", async () => {
    const db = openDb(":memory:");
    runViews(db);
    const r = await renderingAuditWorkerTick(db);
    expect(r).toEqual({ scanned: 0, audited: 0, flagged: 0, cleaned: 0, skipped_existing_feedback: 0 });
  });

  test("clean primary render → auto_verifier_clean feedback emitted with residual 0", async () => {
    const db = openDb(":memory:");
    runViews(db);
    const renderId = seedRender(db, "Working on it now.");
    const r = await renderingAuditWorkerTick(db);
    expect(r.audited).toBe(1);
    expect(r.cleaned).toBe(1);
    expect(r.flagged).toBe(0);
    expect(countFeedback(db, renderId)).toBe(1);
    const fb = db
      .query(
        `SELECT payload, residual FROM events
          WHERE kind = 'owner_rendering_feedback_recorded'
            AND json_extract(payload, '$.source_rendered_event_id') = ?`,
      )
      .get(renderId) as { payload: string; residual: number };
    const fbPayload = JSON.parse(fb.payload);
    expect(fbPayload.feedback_kind).toBe("auto_verifier_clean");
    expect(fbPayload.feedback_residual).toBe(0);
    expect(fb.residual).toBe(0);
  });

  test("primary render with an ID and substrate jargon → auto_verifier feedback with residual > threshold", async () => {
    const db = openDb(":memory:");
    runViews(db);
    // 26-char ULID (the acc2 event_id shape). dispatch_decided also leaks
    // substrate vocabulary → combined residual ≥ threshold.
    const renderId = seedRender(db, "After dispatch_decided we hit 4FYERR1YQ5H6MZ5YKYA60AEC43.");
    const r = await renderingAuditWorkerTick(db);
    expect(r.audited).toBe(1);
    expect(r.flagged).toBe(1);
    const fb = db
      .query(
        `SELECT payload, residual FROM events
          WHERE kind = 'owner_rendering_feedback_recorded'
            AND json_extract(payload, '$.source_rendered_event_id') = ?`,
      )
      .get(renderId) as { payload: string; residual: number };
    const fbPayload = JSON.parse(fb.payload);
    expect(fbPayload.feedback_kind).toBe("auto_verifier");
    expect(fb.residual).toBeGreaterThanOrEqual(0.3);
    expect(JSON.parse(fbPayload.evidence).breakdown.id_leak).toBeGreaterThan(0);
  });

  test("idempotency: re-running the tick on the same render does NOT double-emit feedback", async () => {
    const db = openDb(":memory:");
    runViews(db);
    const renderId = seedRender(db, "Plain text.");
    await renderingAuditWorkerTick(db);
    await renderingAuditWorkerTick(db);
    await renderingAuditWorkerTick(db);
    expect(countFeedback(db, renderId)).toBe(1);
  });

  test("rendered_text missing or non-string → auto_verifier_skipped feedback, not a verifier score", async () => {
    const db = openDb(":memory:");
    runViews(db);
    const ev = emitEvent(db, {
      kind: "rendered_owner_message_recorded",
      substrate_origin: "claude_inline",
      payload: { audience: "primary" /* no rendered_text */ },
    });
    const r = await renderingAuditWorkerTick(db);
    expect(r.scanned).toBe(1);
    expect(r.audited).toBe(0);
    expect(r.skipped_existing_feedback).toBe(1);
    const fb = db
      .query(
        `SELECT payload FROM events
          WHERE kind = 'owner_rendering_feedback_recorded'
            AND json_extract(payload, '$.source_rendered_event_id') = ?`,
      )
      .get(ev.id) as { payload: string };
    expect(JSON.parse(fb.payload).feedback_kind).toBe("auto_verifier_skipped");
  });

  test("detail_drawer audience relaxes ID leak — clean band even when text contains ULIDs", async () => {
    const db = openDb(":memory:");
    runViews(db);
    const renderId = seedRender(db, "raw event_id 4FYERR1YQ5H6MZ5YKYA60AEC43 for drilldown", "detail_drawer");
    const r = await renderingAuditWorkerTick(db);
    expect(r.audited).toBe(1);
    // ID leak weight is 0.10 in drawer + no substrate-jargon hits → below threshold.
    expect(r.flagged).toBe(0);
    expect(r.cleaned).toBe(1);
  });

  test("uses DEFAULT_RENDERING_AUDIT_WINDOW_MS for the lookback window", () => {
    expect(DEFAULT_RENDERING_AUDIT_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });
});
