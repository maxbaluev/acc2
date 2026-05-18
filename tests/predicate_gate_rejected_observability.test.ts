// acc2 predicate-gate emit-side observability test (dark-gate sweep
// 2026-05-18). The structural claim: when a code_artifact_candidate
// event is emitted directly via emitEvent (no admitArtifact in the
// path) with audience=ceo_buyer and a body that contains banned
// phrases, the emit-side screen fires predicate_gate_rejected against
// the candidate's id. Pre-sweep the gate was only wired into
// admitArtifact, so candidates routed through the brain's
// substrate.emit path slipped through unchallenged.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "../runtime/events";

afterAll(() => closeDb());
beforeEach(() => closeDb());

describe("predicate_gate_rejected — emit-side screen on code_artifact_candidate", () => {
  test("fires when a ceo_buyer candidate body contains banned 'the system' and 'modest' phrases", () => {
    const db = openDb(":memory:");
    // Body deliberately includes two CATALOG predicates: 'the system'
    // (system_meta_v2_no_internal_substrate_language) and 'modest'
    // (no_vague_magnitude). Padding keeps the body above the
    // atms_report_* 500-char floor so the empty-body refusal does NOT
    // also fire (we want to assert just the predicate rejection here).
    const padding = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(15);
    const body = `Headline: Industrial safety partner playbook.\n${padding}\nThe system enables a modest pilot for the first cycle.\n${padding}`;
    expect(body.length).toBeGreaterThan(500);
    const candidate = emitEvent(db, {
      kind: "code_artifact_candidate",
      substrate_origin: "opencode",
      directive_id: "d_predicate_emit_test",
      task_id: "d_predicate_emit_test",
      payload: {
        kind: "atms_report_v9",
        name: "atms_report_v9_test_emit_path",
        audience: "ceo_buyer",
        body,
        cited_knowledge_ids: ["fake_strategic_direction_chosen_kc"],
      },
    });
    const rejections = db
      .query<{ payload: string }, [string]>(
        `SELECT payload FROM events WHERE kind = 'predicate_gate_rejected' AND context_refs LIKE ?`,
      )
      .all(`%${candidate.id}%`);
    expect(rejections.length).toBe(1);
    const payload = JSON.parse(rejections[0]!.payload) as Record<string, unknown>;
    expect(payload.reason).toBe("predicate_gate_failed");
    expect(payload.audience).toBe("ceo_buyer");
    expect(typeof payload.match_count).toBe("number");
    expect((payload.match_count as number) >= 2).toBe(true);
  });

  test("does NOT fire when audience is unset (gate scopes itself to high-stakes audiences)", () => {
    const db = openDb(":memory:");
    const padding = "x ".repeat(200);
    const candidate = emitEvent(db, {
      kind: "code_artifact_candidate",
      substrate_origin: "opencode",
      payload: {
        kind: "research_note",
        name: "internal_research_v1",
        body: `Banned phrase test: the system finds a modest improvement. ${padding}`,
      },
    });
    const rejections = db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM events WHERE kind = 'predicate_gate_rejected' AND context_refs LIKE ?`,
      )
      .get(`%${candidate.id}%`);
    expect(rejections?.n ?? 0).toBe(0);
  });
});
