// acc2 empty-body refusal test (dark-gate sweep 2026-05-18). The
// structural claim: when a code_artifact_candidate event is emitted
// with payload.body shorter than the kind-specific threshold, the
// emit-side screen fires lane_routing_refused with
// reason="empty_body_below_threshold". The threshold is 500 chars for
// atms_report_* candidates, 200 chars for everything else, and 0 for
// the placeholder kinds the render pipeline uses (rendered_docx,
// published_drive_doc, markdown_body) which intentionally carry
// short synthetic bodies.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "../runtime/events";

afterAll(() => closeDb());
beforeEach(() => closeDb());

// Filters lane_routing_refused rows whose reason matches the empty-body
// floor predicate; F1 introduced sibling reasons
// (artifact_citation_underrooted / decorative_citation) so a bare
// kind-filter would catch unrelated F1 events.
const refusalsFor = (db: ReturnType<typeof openDb>, eventId: string) => {
  const all = db
    .query<{ payload: string }, [string]>(
      `SELECT payload FROM events WHERE kind = 'lane_routing_refused' AND context_refs LIKE ?`,
    )
    .all(`%${eventId}%`);
  return all.filter((r) => {
    try {
      const p = JSON.parse(r.payload) as Record<string, unknown>;
      return p.reason === "empty_body_below_threshold";
    } catch { return false; }
  });
};

describe("empty_body_refusal — emit-side screen on code_artifact_candidate", () => {
  test("refuses an atms_report_v* candidate with body below the 500-char floor", () => {
    const db = openDb(":memory:");
    const candidate = emitEvent(db, {
      kind: "code_artifact_candidate",
      substrate_origin: "opencode",
      payload: {
        kind: "atms_report_v9",
        name: "atms_report_v9_short_body",
        body: "tiny stub",
        cited_knowledge_ids: [],
      },
    });
    const refusals = refusalsFor(db, candidate.id);
    expect(refusals.length).toBe(1);
    const payload = JSON.parse(refusals[0]!.payload) as Record<string, unknown>;
    expect(payload.reason).toBe("empty_body_below_threshold");
    expect(payload.body_length).toBe("tiny stub".length);
    expect(payload.threshold).toBe(500);
    expect(payload.classification).toBe("atms_report");
  });

  test("refuses a generic-kind candidate with body below the 200-char floor", () => {
    const db = openDb(":memory:");
    const candidate = emitEvent(db, {
      kind: "code_artifact_candidate",
      substrate_origin: "opencode",
      payload: {
        kind: "research_note",
        name: "research_note_short",
        body: "short body well under two hundred chars",
      },
    });
    const refusals = refusalsFor(db, candidate.id);
    expect(refusals.length).toBe(1);
    const payload = JSON.parse(refusals[0]!.payload) as Record<string, unknown>;
    expect(payload.reason).toBe("empty_body_below_threshold");
    expect(payload.threshold).toBe(200);
    expect(payload.classification).toBe("default");
  });

  test("admits a published_drive_doc candidate with a synthetic short body (placeholder exemption)", () => {
    const db = openDb(":memory:");
    const candidate = emitEvent(db, {
      kind: "code_artifact_candidate",
      substrate_origin: "opencode",
      payload: {
        kind: "published_drive_doc",
        name: "lakeland_drive_v9",
        body: "Drive doc placeholder body — short on purpose.",
        target_resources: ["drive://document/abc123"],
      },
    });
    const refusals = refusalsFor(db, candidate.id);
    expect(refusals.length).toBe(0);
  });

  test("admits a generic candidate whose body crosses the 200-char floor", () => {
    const db = openDb(":memory:");
    const body = "padding ".repeat(40);
    expect(body.length).toBeGreaterThanOrEqual(200);
    const candidate = emitEvent(db, {
      kind: "code_artifact_candidate",
      substrate_origin: "opencode",
      payload: {
        kind: "research_note",
        name: "research_note_long_enough",
        body,
      },
    });
    const refusals = refusalsFor(db, candidate.id);
    expect(refusals.length).toBe(0);
  });

  test("does NOT fire when payload.body is absent (legacy worker stubs are exempt)", () => {
    const db = openDb(":memory:");
    const candidate = emitEvent(db, {
      kind: "code_artifact_candidate",
      substrate_origin: "opencode",
      payload: {
        runtime: "bun",
        purpose: "fixture_d_count_todos_action",
      },
    });
    const refusals = refusalsFor(db, candidate.id);
    expect(refusals.length).toBe(0);
  });
});
