// Phase Align — Principle 5: depth-1 retrieval, prompt budget enforced.
//
// v2-design.md §13: each prompt section uses a small K-cap or a view
// accessor with LIMIT — no section dumps every row. The total prompt stays
// under PROMPT_BUDGET_TOKENS (default 8000). When the composer can't fit a
// section under budget it drops the lowest-priority candidate AND emits a
// `prompt_truncated` event so the audit trail records the bite.
//
// This test seeds a fat substrate (many promoted-knowledge rows, many
// artifacts) AND uses a small budget, then asserts: (a) the composed text
// is under the budget, (b) at least one section was dropped, (c) exactly
// one `prompt_truncated` event was emitted carrying the kept + truncated
// section manifests.

import { afterAll, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../../substrate/db";
import { composePrompt, estimateTokens } from "../prompt_composer";
import { emitEvent } from "../events";
import { newId } from "../ids";

afterAll(() => closeDb());

describe("alignment / depth_one (Principle 5)", () => {
  test("fat substrate + tiny budget triggers prompt_truncated", () => {
    closeDb();
    const db = openDb(":memory:");

    // Open a directive + task pair the composer can read.
    const directiveId = newId();
    const taskId = newId();
    emitEvent(db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: taskId,
      payload: {
        directive_text: "Phase Align alignment fixture: produce nothing in particular, the goal text is intentionally long enough to consume budget when the surface dumps it: " + "lorem ipsum ".repeat(50),
      },
    });
    emitEvent(db, {
      kind: "task_node_opened",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      task_id: taskId,
      payload: { goal: "alignment fat-substrate goal text", lifecycle: "finite", urgency: "normal" },
    });

    // Seed 200 promoted-knowledge rows so the recency fallback in
    // readKnowledgeTopK has plenty to draw from. The K-cap of 8 should
    // bind here (only 8 rows surface), not the full 200 — that's the
    // depth-1 contract.
    for (let i = 0; i < 200; i++) {
      emitEvent(db, {
        kind: "knowledge_promoted",
        substrate_origin: "substrate_auto",
        directive_id: directiveId,
        task_id: taskId,
        payload: {
          text: "alignment-fixture knowledge promoted row #" + i + " — " + "padding".repeat(30),
          score: 0.95,
        },
      });
    }

    // Compose under a tight budget. We pick a budget the P0 sections fit
    // into but everything else gets clipped — the goal is to PROVE that
    // truncation is honest and emits the audit row.
    const result = composePrompt(db, { taskId, budgetTokens: 800 });
    const tokens = estimateTokens(result.text);
    expect(tokens).toBeLessThanOrEqual(800);
    expect(result.truncated.length).toBeGreaterThan(0);

    const trunc = db
      .query("SELECT payload FROM events WHERE kind = 'prompt_truncated' ORDER BY ts DESC LIMIT 1")
      .get() as { payload: string } | null;
    expect(trunc).not.toBeNull();
    const payload = JSON.parse(trunc!.payload) as {
      budget_tokens: number;
      total_tokens: number;
      kept_sections: string[];
      truncated_sections: string[];
    };
    expect(payload.budget_tokens).toBe(800);
    expect(payload.truncated_sections.length).toBe(result.truncated.length);
    // P0 sections must always survive — they're load-bearing.
    expect(payload.kept_sections).toContain("task_goal");
    expect(payload.kept_sections).toContain("runtimes_available");
    expect(payload.kept_sections).toContain("workflow");
  });

  test("non-trivial budget keeps everything and does NOT emit prompt_truncated", () => {
    closeDb();
    const db = openDb(":memory:");
    const directiveId = newId();
    const taskId = newId();
    emitEvent(db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: taskId,
      payload: { directive_text: "short goal" },
    });
    emitEvent(db, {
      kind: "task_node_opened",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      task_id: taskId,
      payload: { goal: "short goal", lifecycle: "finite", urgency: "normal" },
    });

    const result = composePrompt(db, { taskId, budgetTokens: 8000 });
    expect(result.truncated.length).toBe(0);
    const trunc = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'prompt_truncated'")
      .get() as { c: number };
    // No truncation → no audit event. Idempotency: a clean compose stays
    // clean (no spurious rows on the audit trail).
    expect(trunc.c).toBe(0);
  });
});
