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

describe("classifyIntent — six observed classes", () => {
  test("atms_report_composition", () => {
    const r = classifyIntent(
      "Compose the Lakeland AI Transformation Roadmap atms_report_v7 with strategic direction first",
    );
    expect(r.intent_class).toBe("atms_report_composition");
    expect(r.confidence).toBeGreaterThanOrEqual(0.5);
    expect(r.evidence.length).toBeGreaterThan(0);
  });

  test("system_internals_doc", () => {
    const r = classifyIntent(
      "Explanation of how the system works — show how DAG dataflow moves through the substrate",
    );
    expect(r.intent_class).toBe("system_internals_doc");
    expect(r.confidence).toBeGreaterThanOrEqual(0.5);
    expect(r.evidence.length).toBeGreaterThan(0);
  });

  test("cofounder_review", () => {
    const r = classifyIntent(
      "Need Alex cofounder review of the proposed plan and Tony reviewer notes",
    );
    expect(r.intent_class).toBe("cofounder_review");
    expect(r.confidence).toBeGreaterThanOrEqual(0.5);
  });

  test("contract_implementation", () => {
    const r = classifyIntent(
      "IMPLEMENT contract amendment whose target_files list runtime/intent_classifier.ts",
    );
    expect(r.intent_class).toBe("contract_implementation");
    expect(r.confidence).toBeGreaterThanOrEqual(0.5);
  });

  test("research_dispatch", () => {
    const r = classifyIntent(
      "DEEP-RESEARCH the Acme Corp deal with multi-source live data from web and SEC filings",
    );
    expect(r.intent_class).toBe("research_dispatch");
    expect(r.confidence).toBeGreaterThanOrEqual(0.5);
  });

  test("ad_hoc — fallback for unmatched directives", () => {
    const r = classifyIntent("count files in /tmp containing the word foo");
    expect(r.intent_class).toBe("ad_hoc");
    // ad_hoc confidence may be < 0.5 by design (it is the fallback).
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
    expect(Array.isArray(payload.allowed_artifact_kinds)).toBe(true);
  });
});
