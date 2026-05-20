// acc2 F7 — non-technical goal extensions (2026-05-18).
//
// Falsifying tests for the F7 roadmap row (event id
// WW7W1NZ8A10R52PB4E7EJE9YBW). F7 ships three structural extensions
// that let the substrate handle non-technical human goals (eulogy,
// job decision, relationship reconciliation, growth, meaning):
//
//   (1) verifier_kind seed expansion — 10 example verifier_kind
//       strings land as knowledge_candidate rows with
//       lesson_class=substrate_verifier_seed. verifier_kind stays
//       an open string; operators discover their own.
//
//   (2) predicted_residual.feedback_window field — encodes typical
//       observation window (immediate / short / medium / long /
//       very_long). Lifecycle closure sweep respects feedback_window:
//       long-window lifecycles stay open for months rather than
//       being closed as obsolete.
//
//   (3) N=1 promotion math — F5 (commit df2811e) already implemented
//       Beta lower-bound confidence. F7's job is to verify the path
//       works for non-technical owner signals such as
//       owner_emotional_signal.
//
// Two falsifying tests live here:
//   - n1_promotion_via_owner_emotional_signal: one-time goal (eulogy)
//     with strong positive owner outcome + high autonomy promotes
//     at N=1.
//   - slow_feedback_not_prematurely_closed: a task_node_opened row
//     whose payload declares feedback_window.classification=long
//     survives the sweep even at 30 days old.

import { describe, expect, test, beforeEach } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "../runtime/events";
import { runLifecycleClosureSweep } from "../runtime/lifecycle_closure_sweep";
import {
  evaluatePromotion,
  HIGH_AUTONOMY_THRESHOLD,
} from "../runtime/posterior_promotion";
import {
  seedVerifierKindExamples,
  VERIFIER_KIND_EXAMPLE_NAMES,
} from "../substrate/seed";
import type { OwnerProfile } from "../substrate/types";

beforeEach(() => closeDb());

describe("F7 verifier_kind seed expansion", () => {
  test("seedVerifierKindExamples installs exactly 10 knowledge_candidate rows", () => {
    const db = openDb(":memory:");
    const summary = seedVerifierKindExamples(db);
    expect(summary.imported).toBe(10);

    const rows = db
      .query(
        "SELECT payload FROM events WHERE kind = 'knowledge_candidate' " +
        "AND json_extract(payload, '$.lesson_class') = 'substrate_verifier_seed' " +
        "ORDER BY ts ASC",
      )
      .all() as Array<{ payload: string }>;
    expect(rows.length).toBe(10);

    const names = rows.map((r) => {
      const p = JSON.parse(r.payload) as { verifier_kind_example_name?: string };
      return p.verifier_kind_example_name ?? "";
    });
    expect(new Set(names)).toEqual(new Set(VERIFIER_KIND_EXAMPLE_NAMES));
  });

  test("the 10 canonical verifier_kind names cover the non-technical signal set", () => {
    expect(VERIFIER_KIND_EXAMPLE_NAMES).toEqual([
      "owner_emotional_signal",
      "owner_clarity_signal",
      "owner_relationship_signal",
      "owner_life_outcome_signal",
      "owner_health_signal",
      "owner_growth_signal",
      "owner_meaning_signal",
      "owner_relationship_with_self_signal",
      "owner_creative_signal",
      "owner_spiritual_signal",
    ]);
  });

  test("seedVerifierKindExamples is idempotent — a second pass imports 0", () => {
    const db = openDb(":memory:");
    const first = seedVerifierKindExamples(db);
    const second = seedVerifierKindExamples(db);
    expect(first.imported).toBe(10);
    expect(second.imported).toBe(0);
    const total = (
      db
        .query(
          "SELECT COUNT(*) AS n FROM events WHERE kind = 'knowledge_candidate' " +
          "AND json_extract(payload, '$.lesson_class') = 'substrate_verifier_seed'",
        )
        .get() as { n: number }
    ).n;
    expect(total).toBe(10);
  });

  test("every seeded row carries claim=verifier_kind_example and a feedback_window_hint", () => {
    const db = openDb(":memory:");
    seedVerifierKindExamples(db);
    const rows = db
      .query(
        "SELECT payload FROM events WHERE kind = 'knowledge_candidate' " +
        "AND json_extract(payload, '$.lesson_class') = 'substrate_verifier_seed'",
      )
      .all() as Array<{ payload: string }>;
    const allowedHints = new Set([
      "immediate",
      "short",
      "medium",
      "long",
      "very_long",
    ]);
    for (const r of rows) {
      const p = JSON.parse(r.payload) as {
        claim?: string;
        feedback_window_hint?: string;
      };
      expect(p.claim).toBe("verifier_kind_example");
      expect(allowedHints.has(p.feedback_window_hint ?? "")).toBe(true);
    }
  });
});

describe("F7 n1_promotion_via_owner_emotional_signal", () => {
  test("one-time eulogy with strong positive owner_emotional_signal promotes at N=1", () => {
    // Owner profile: high autonomy on emotional_work means the
    // substrate trusts strong owner signal to drive recipe promotion
    // without demanding multiple replays. Autonomy lookup prefers
    // autonomy_signals[goalClass] over the scalar autonomy_score.
    const ownerProfile: OwnerProfile = {
      autonomy_score: 0.6,
      autonomy_signals: { emotional_work: 0.9 },
    };

    // Single strong-positive owner outcome translates to alpha=2 beta=1
    // in the recipe Beta posterior (the +1 lift comes from the prior;
    // the strong-positive observation contributes the additional unit).
    const evaluation = evaluatePromotion(
      { posterior_alpha: 2, posterior_beta: 1 },
      ownerProfile,
      "emotional_work",
    );

    expect(evaluation.threshold).toBe(HIGH_AUTONOMY_THRESHOLD);
    expect(evaluation.promote).toBe(true);
    expect(evaluation.confidence).toBeGreaterThan(HIGH_AUTONOMY_THRESHOLD);
    expect(evaluation.reason).toBe("confidence_above_threshold");
    expect(evaluation.sample_size).toBe(3);
    // The mean (≈0.667) and lower bound (≈0.46) bracket the threshold.
    expect(evaluation.mean).toBeCloseTo(0.667, 2);
  });

  test("the same N=1 evidence fails for a low-autonomy owner on the same domain", () => {
    const cautiousOwner: OwnerProfile = {
      autonomy_signals: { emotional_work: 0.3 },
    };
    const evaluation = evaluatePromotion(
      { posterior_alpha: 2, posterior_beta: 1 },
      cautiousOwner,
      "emotional_work",
    );
    expect(evaluation.promote).toBe(false);
    expect(evaluation.reason).toBe("confidence_below_threshold");
  });
});

describe("F7 slow_feedback_not_prematurely_closed", () => {
  const NOW = new Date("2026-05-18T12:00:00.000Z");
  const daysAgo = (n: number) =>
    new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

  test("long-window task_node_opened survives the sweep past 30 days", async () => {
    const db = openDb(":memory:");
    const row = emitEvent(db, {
      kind: "task_node_opened",
      substrate_origin: "opencode",
      directive_id: "dir_eulogy",
      task_id: "task_eulogy_draft",
      payload: {
        intent: "help me write my mother's eulogy",
        feedback_window: {
          duration_ms: 30 * 24 * 60 * 60 * 1000,
          classification: "long",
        },
      },
    });
    db.run("UPDATE events SET ts = ? WHERE id = ?", [
      daysAgo(30).toISOString(),
      row.id,
    ]);

    const summary = await runLifecycleClosureSweep(db, { now: NOW });
    expect(summary.feedback_window_respected_count).toBeGreaterThanOrEqual(1);

    // No terminator was emitted for the long-window task.
    const terminators = db
      .query<{ c: number }, [string]>(
        "SELECT COUNT(*) AS c FROM events WHERE kind IN " +
        "('closure_complete','closure_obsolete','closure_owner_required') " +
        "AND context_refs LIKE ?",
      )
      .get(`%${row.id}%`);
    expect(terminators?.c).toBe(0);
  });

  test("a stale owner_input_required with classification=very_long is exempt", async () => {
    const db = openDb(":memory:");
    const row = emitEvent(db, {
      kind: "owner_input_required",
      substrate_origin: "opencode",
      directive_id: "dir_life_decision",
      task_id: "task_life_decision_ponder",
      payload: {
        reason: "owner_decision_pending",
        summary: "should I take this job offer",
        feedback_window: {
          duration_ms: 180 * 24 * 60 * 60 * 1000,
          classification: "very_long",
        },
      },
    });
    db.run("UPDATE events SET ts = ? WHERE id = ?", [
      daysAgo(60).toISOString(),
      row.id,
    ]);

    const summary = await runLifecycleClosureSweep(db, { now: NOW });
    expect(summary.feedback_window_respected_count).toBeGreaterThanOrEqual(1);
    const terminators = db
      .query<{ c: number }, [string]>(
        "SELECT COUNT(*) AS c FROM events WHERE kind IN " +
        "('closure_complete','closure_obsolete','closure_owner_required') " +
        "AND context_refs LIKE ?",
      )
      .get(`%${row.id}%`);
    expect(terminators?.c).toBe(0);
  });

  test("a stale row WITHOUT feedback_window still closes (control case)", async () => {
    const db = openDb(":memory:");
    const row = emitEvent(db, {
      kind: "owner_input_required",
      substrate_origin: "opencode",
      directive_id: "dir_short",
      task_id: "task_short",
      payload: { reason: "auth_expired" },
    });
    db.run("UPDATE events SET ts = ? WHERE id = ?", [
      daysAgo(8).toISOString(),
      row.id,
    ]);

    const summary = await runLifecycleClosureSweep(db, { now: NOW });
    expect(summary.closure_owner_required_count).toBeGreaterThanOrEqual(1);
    expect(summary.feedback_window_respected_count).toBe(0);
  });

  test("the short-window classification does NOT exempt the lifecycle", async () => {
    // Only long / very_long are exempt. short / medium / immediate
    // lifecycles still close at the standard age.
    const db = openDb(":memory:");
    const row = emitEvent(db, {
      kind: "owner_input_required",
      substrate_origin: "opencode",
      directive_id: "dir_medium",
      task_id: "task_medium",
      payload: {
        reason: "owner_review_pending",
        feedback_window: {
          duration_ms: 6 * 60 * 60 * 1000,
          classification: "medium",
        },
      },
    });
    db.run("UPDATE events SET ts = ? WHERE id = ?", [
      daysAgo(8).toISOString(),
      row.id,
    ]);

    const summary = await runLifecycleClosureSweep(db, { now: NOW });
    expect(summary.closure_owner_required_count).toBeGreaterThanOrEqual(1);
    expect(summary.feedback_window_respected_count).toBe(0);
  });
});
