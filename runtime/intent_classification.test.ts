// acc2 intent classifier tests — covers the six observed intent classes
// plus the handleOpenDirective integration that emits intent_classified
// at directive ingress (contract TJGFQC72BX24NE7R8G1JYJPSR8).

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { classifyIntent } from "./intent_classifier";
import { handleOpenDirective } from "./mcp_server/substrate_tools";
import type { McpContext } from "./mcp_server/types";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const ctx = (db: ReturnType<typeof openDb>): McpContext =>
  ({ db, invoker: "claude_root" } as McpContext);

describe("classifyIntent — retrieval-scored patterns", () => {
  const seedClassifierKnowledge = (db: ReturnType<typeof openDb>) => {
    db.run(
      `INSERT INTO events (id, ts, directive_id, task_id, loop_id, substrate_origin, kind, payload, context_refs) VALUES ('kc_intent_atms', datetime('now'), 'dir_seed_classifier', 'task_seed_classifier', 'loop_seed_classifier', 'substrate_auto', 'knowledge_candidate', ?, '[]')`,
      JSON.stringify({
        claim: "ATMS report composition classifier prior",
        intent_class: "atms_report_composition",
        classifier: { intent_classifier_version: "test", strong_markers: ["\\batms[_ ]?report\\b", "\\bAI\\s+Transformation\\s+Roadmap\\b"], soft_markers: ["roadmap", "transformation"] },
        confidence_estimate: 0.9,
      }),
    );
    db.run(
      `INSERT INTO events (id, ts, directive_id, task_id, loop_id, substrate_origin, kind, payload, context_refs) VALUES ('kp_intent_atms', datetime('now'), 'dir_seed_classifier', 'task_seed_classifier', 'loop_seed_classifier', 'substrate_auto', 'knowledge_promoted', ?, '["kc_intent_atms"]')`,
      JSON.stringify({ candidate_id: "kc_intent_atms", confidence: 0.9 }),
    );
  };

  test("retrieved classifier prior", () => {
    const db = openDb(":memory:");
    seedClassifierKnowledge(db);
    const r = classifyIntent(
      "Compose the Lakeland AI Transformation Roadmap atms_report_v7 with strategic direction first",
      db,
    );
    expect(r.intent_class).toBe("atms_report_composition");
    expect(r.confidence).toBeGreaterThanOrEqual(0.5);
    expect(r.evidence.length).toBeGreaterThan(0);
  });

  test("DB-less classifier uses universal fallback instead of hardcoded classes", () => {
    const r = classifyIntent("Compose the Lakeland AI Transformation Roadmap atms_report_v7");
    expect(r.intent_class).toBe("ad_hoc");
  });

  test("ad_hoc — fallback for unmatched directives", () => {
    const db = openDb(":memory:");
    seedClassifierKnowledge(db);
    const r = classifyIntent("count files in /tmp containing the word foo", db);
    expect(r.intent_class).toBe("ad_hoc");
  });
});

describe("handleOpenDirective — emits intent_classified at ingress", () => {
  test("opens a synthetic directive and emits intent_classified with non-null intent_class", () => {
    const db = openDb(":memory:");
    const opened = handleOpenDirective(ctx(db), {
      directive_text: "Compose atms_report_v8 — Lakeland AI Transformation Roadmap",
    } as never);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const directiveId = (opened.result as Record<string, unknown>).directive_id as string;

    const rows = db
      .query<
        { payload: string },
        [string]
      >(
        `SELECT payload FROM events WHERE kind = 'intent_classified' AND directive_id = ? ORDER BY ts ASC`,
      )
      .all(directiveId);
    expect(rows.length).toBe(1);
    const payload = JSON.parse(rows[0]!.payload ?? "{}") as Record<string, unknown>;
    expect(typeof payload.intent_class).toBe("string");
    expect((payload.intent_class as string).length).toBeGreaterThan(0);
    expect(typeof payload.confidence).toBe("number");
    expect(Array.isArray(payload.evidence)).toBe(true);
    expect(typeof payload.classifier_version).toBe("string");
    expect(typeof payload.directive_text_hash).toBe("string");
  });
});
