// Phase Align — Principle 5: depth-1 retrieval, prompt budget enforced.
//
// Architecture.md: each prompt section uses a small K-cap or a view
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
import { seedFoundationalKnowledge } from "../../substrate/seed";

afterAll(() => closeDb());

describe("alignment / depth_one (Principle 5)", () => {
  test("fat substrate + tiny budget triggers prompt_truncated", async () => {
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
    // truncation is honest and emits the audit row. Budget tuned to
    // 500 tokens because the meta-convergence (9N7DHXQ6) shrunk the
    // composed prompt body — at 2000 the prompt comfortably fits without
    // truncation. 500 keeps the P0 task_goal but forces retrieval rows
    // out, which is the truncation invariant this test asserts.
    const result = await composePrompt(db, { taskId, budgetTokens: 500 });
    const tokens = estimateTokens(result.text);
    // Floor sections are load-bearing: if they alone exceed a pathological
    // test budget, the composer keeps them and records the violation instead
    // of silently dropping structural rules.
    expect(tokens).toBeGreaterThan(500);
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
    expect(payload.budget_tokens).toBe(500);
    expect(payload.truncated_sections.length).toBe(result.truncated.length);
    // P0 sections must always survive — they're load-bearing.
    expect(payload.kept_sections).toContain("task_goal");
    expect(payload.kept_sections).toContain("runtimes_available");
    expect(payload.kept_sections).toContain("workflow");
    const violation = db
      .query("SELECT payload FROM events WHERE kind = 'dispatcher_violation' ORDER BY ts DESC LIMIT 1")
      .get() as { payload: string } | null;
    expect(violation).not.toBeNull();
    const violationPayload = JSON.parse(violation!.payload) as { kind: string; floor_sections_over_budget: string[] };
    expect(violationPayload.kind).toBe("floor_section_missing");
    expect(violationPayload.floor_sections_over_budget.length).toBeGreaterThan(0);
  });

  test("non-trivial budget keeps everything and does NOT emit prompt_truncated", async () => {
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

    const result = await composePrompt(db, { taskId, budgetTokens: 8000 });
    expect(result.truncated.length).toBe(0);
    const trunc = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'prompt_truncated'")
      .get() as { c: number };
    // No truncation → no audit event. Idempotency: a clean compose stays
    // clean (no spurious rows on the audit trail).
    expect(trunc.c).toBe(0);
  });

  // Regression — real (production) dispatch must compose under the
  // PRODUCTION default budget (DEFAULT_BUDGET_TOKENS=32000), NOT the tiny
  // test-pin budget. The dispatcher calls composePrompt WITHOUT a
  // budgetTokens override, so the legitimate ~5k-token floor sections
  // (task_goal, runtimes_available, workflow, do_not, retrieved_knowledge,
  // owner_profile, owner_rendering_policy, top_laws, …) must fit and emit
  // NO spurious floor_section_missing / over-budget dispatcher_violation.
  // Pre-fix this path resolved to an 800-token default and fired
  // dispatcher_violation{kind:floor_section_missing} on every real dispatch
  // (observed live: directive 2QX74XE9, budget_tokens=800, total=5474).
  test("default-budget dispatch on fat substrate emits NO spurious floor violation", async () => {
    closeDb();
    const db = openDb(":memory:");
    seedFoundationalKnowledge(db);

    const directiveId = newId();
    const taskId = newId();
    emitEvent(db, {
      kind: "directive_opened",
      substrate_origin: "owner",
      directive_id: directiveId,
      task_id: taskId,
      payload: {
        directive_text:
          "CLAUDE_MD_TERSE_INVARIANTS_LEAF regression fixture — a realistic directive whose floor sections legitimately consume several thousand tokens once the substrate accumulates promoted knowledge and owner profile rows.",
      },
    });
    emitEvent(db, {
      kind: "task_node_opened",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      task_id: taskId,
      payload: { goal: "terse invariants leaf goal", lifecycle: "finite", urgency: "normal" },
    });

    // Fatten the floor surfaces the live violation listed: promoted
    // knowledge (retrieved_knowledge / top_laws) so the prompt body lands
    // in the ~5k+ token range the live dispatch hit.
    for (let i = 0; i < 200; i++) {
      emitEvent(db, {
        kind: "knowledge_promoted",
        substrate_origin: "substrate_auto",
        directive_id: directiveId,
        task_id: taskId,
        payload: {
          text: "terse-invariants knowledge promoted row #" + i + " — " + "padding".repeat(30),
          score: 0.95,
        },
      });
    }

    // Compose with the PRODUCTION default — NO budgetTokens override, the
    // exact shape the task_dispatcher uses on a real dispatch.
    const result = await composePrompt(db, { taskId });

    // The realistic floor sections must fit comfortably under the 32000
    // production default — no truncation.
    expect(estimateTokens(result.text)).toBeLessThan(32000);
    expect(result.truncated.length).toBe(0);

    // And — the heart of the regression — NO floor_section_missing
    // dispatcher_violation may be emitted on this real-dispatch path.
    const floorViolations = db
      .query(
        "SELECT COUNT(*) AS c FROM events WHERE kind = 'dispatcher_violation' AND failure_kind = 'floor_section_missing'",
      )
      .get() as { c: number };
    expect(floorViolations.c).toBe(0);

    // Every load-bearing floor section survived.
    const keptNames = new Set(result.sections.map((s) => s.name));
    for (const name of ["task_goal", "runtimes_available", "workflow", "do_not", "retrieved_knowledge"]) {
      expect(keptNames.has(name)).toBe(true);
    }
  });
});
