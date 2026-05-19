// acc2 strategy-first emit-side observability test (dark-gate sweep
// 2026-05-18). The structural claim: when a act_artifact_candidate
// whose name starts with `atms_report_v` is emitted without a cited
// knowledge_candidate whose payload.claim ends with
// `_strategic_direction_chosen`, the emit-side screen fires
// atms_strategy_first_violation against the candidate's id. Pre-sweep
// the gate was only wired into admitArtifact and the brain's
// substrate.emit candidates skipped it.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "../runtime/events";

afterAll(() => closeDb());
beforeEach(() => closeDb());

describe("atms_strategy_first_violation — emit-side screen on act_artifact_candidate", () => {
  test("fires when an atms_report_v* candidate has no strategic-direction citation", () => {
    const db = openDb(":memory:");
    const body = "# Lakeland AI Transformation Roadmap v12\n\n".padEnd(800, "a");
    const candidate = emitEvent(db, {
      kind: "act_artifact_candidate",
      substrate_origin: "opencode",
      directive_id: "d_strategy_emit_test",
      task_id: "d_strategy_emit_test",
      payload: {
        kind: "atms_report_v12",
        name: "atms_report_v12_test_no_strategy",
        body,
        cited_knowledge_ids: [],
      },
    });
    const violations = db
      .query<{ payload: string }, [string]>(
        `SELECT payload FROM events WHERE kind = 'atms_strategy_first_violation' AND context_refs LIKE ?`,
      )
      .all(`%${candidate.id}%`);
    expect(violations.length).toBe(1);
    const payload = JSON.parse(violations[0]!.payload) as Record<string, unknown>;
    expect(payload.reason).toBe("strategy_first_violation_missing_strategic_direction_chosen");
    expect(payload.artifact_name).toBe("atms_report_v12_test_no_strategy");
    expect(payload.missing_claim_suffix).toBe("_strategic_direction_chosen");
  });

  test("does NOT fire when the candidate cites a knowledge_candidate whose claim ends _strategic_direction_chosen", () => {
    const db = openDb(":memory:");
    const kc = emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "opencode",
      payload: {
        claim: "vertical_concentration_industrial_safety_strategic_direction_chosen",
        evidence: ["sources_s1_s2"],
      },
    });
    const body = "# Lakeland AI Transformation Roadmap v13\n\n".padEnd(800, "a");
    const candidate = emitEvent(db, {
      kind: "act_artifact_candidate",
      substrate_origin: "opencode",
      payload: {
        kind: "atms_report_v13",
        name: "atms_report_v13_with_strategy",
        body,
        cited_knowledge_ids: [kc.id],
      },
    });
    const violations = db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM events WHERE kind = 'atms_strategy_first_violation' AND context_refs LIKE ?`,
      )
      .get(`%${candidate.id}%`);
    expect(violations?.n ?? 0).toBe(0);
  });

  test("does NOT fire when the candidate's name and kind are not atms_report_v*", () => {
    const db = openDb(":memory:");
    const body = "# Some other report\n\n".padEnd(800, "z");
    const candidate = emitEvent(db, {
      kind: "act_artifact_candidate",
      substrate_origin: "opencode",
      payload: {
        kind: "system_internals_doc",
        name: "system_internals_doc_v1",
        body,
        cited_knowledge_ids: [],
      },
    });
    const violations = db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM events WHERE kind = 'atms_strategy_first_violation' AND context_refs LIKE ?`,
      )
      .get(`%${candidate.id}%`);
    expect(violations?.n ?? 0).toBe(0);
  });

  test("fires when payload.kind starts with atms_report_v but payload.name does NOT (v9 historical shape)", () => {
    const db = openDb(":memory:");
    // The 2026-05-18 v9 Lakeland candidates set name to a domain label
    // (lakeland_industries_ai_transformation_report_v9) while kind
    // carried the atms_report_v9 marker. The pre-sweep admission gate
    // only checked name and missed these entirely.
    const body = "# Lakeland AI Transformation v9\n\n".padEnd(900, "b");
    const candidate = emitEvent(db, {
      kind: "act_artifact_candidate",
      substrate_origin: "opencode",
      payload: {
        kind: "atms_report_v9",
        name: "lakeland_industries_ai_transformation_report_v9",
        body,
        cited_knowledge_ids: ["unresolved_label_kc"],
      },
    });
    const violations = db
      .query<{ payload: string }, [string]>(
        `SELECT payload FROM events WHERE kind = 'atms_strategy_first_violation' AND context_refs LIKE ?`,
      )
      .all(`%${candidate.id}%`);
    expect(violations.length).toBe(1);
    const payload = JSON.parse(violations[0]!.payload) as Record<string, unknown>;
    expect(payload.artifact_kind).toBe("atms_report_v9");
    expect(payload.artifact_name).toBe("lakeland_industries_ai_transformation_report_v9");
  });
});
