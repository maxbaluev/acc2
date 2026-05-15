import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { newId } from "./ids";
import {
  PATHOLOGY_BUDGET_THRESHOLD,
  PATHOLOGY_BUDGET_WINDOW_MS,
  debit,
  maybeExhaustPathologyBudget,
  summarizeBudget,
} from "./pathology_budget";

afterAll(() => closeDb());
beforeEach(() => closeDb());

describe("pathology_budget", () => {
  test("debit emits a pathology_budget_debited row with weight + pathology_kind", () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const result = debit(db, {
      directive_id: directiveId,
      pathology_kind: "ready_starvation",
      source_worker: "supervisor.ready_starvation",
    });
    expect(result.id).toBeTruthy();
    const row = db
      .query("SELECT payload FROM events WHERE id = ?")
      .get(result.id) as { payload: string };
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    expect(payload.pathology_kind).toBe("ready_starvation");
    expect(typeof payload.weight).toBe("number");
    expect(payload.source_worker).toBe("supervisor.ready_starvation");
  });

  test("summarizeBudget sums recent debits and reports per-pathology breakdown", () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    debit(db, { directive_id: directiveId, pathology_kind: "ready_starvation" });
    debit(db, { directive_id: directiveId, pathology_kind: "ready_starvation" });
    debit(db, { directive_id: directiveId, pathology_kind: "redispatch_storm" });
    const s = summarizeBudget(db, directiveId);
    expect(s.total_weight).toBeGreaterThan(0);
    expect(s.pathologies.ready_starvation.count).toBe(2);
    expect(s.pathologies.redispatch_storm.count).toBe(1);
    expect(s.already_exhausted).toBe(false);
  });

  test("maybeExhaustPathologyBudget fires when total weight crosses threshold", () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    // Force the threshold by piling on heavy debits. Each
    // dispatch_budget_exceeded carries weight 5; 3 of them → 15 > 10.
    debit(db, { directive_id: directiveId, pathology_kind: "dispatch_budget_exceeded" });
    debit(db, { directive_id: directiveId, pathology_kind: "dispatch_budget_exceeded" });
    debit(db, { directive_id: directiveId, pathology_kind: "dispatch_budget_exceeded" });
    const emittedId = maybeExhaustPathologyBudget(db, directiveId);
    expect(emittedId).not.toBeNull();
    const row = db
      .query("SELECT payload FROM events WHERE id = ?")
      .get(emittedId!) as { payload: string };
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    expect(payload.threshold).toBe(PATHOLOGY_BUDGET_THRESHOLD);
    expect((payload.pathologies as Record<string, unknown>).dispatch_budget_exceeded).toBeDefined();
  });

  test("maybeExhaustPathologyBudget is idempotent — does not fire twice in the same window", () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    for (let i = 0; i < 5; i++) {
      debit(db, { directive_id: directiveId, pathology_kind: "dispatch_budget_exceeded" });
    }
    expect(maybeExhaustPathologyBudget(db, directiveId)).not.toBeNull();
    expect(maybeExhaustPathologyBudget(db, directiveId)).toBeNull();
    const rows = db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'pathology_budget_exhausted' AND directive_id = ?")
      .get(directiveId) as { c: number };
    expect(rows.c).toBe(1);
  });

  test("debits outside the window do not count toward exhaustion", () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    // Seed old debit OUTSIDE the window by writing directly to events with
    // an older ts. summarizeBudget filters by ts >= cutoff so this should
    // be ignored.
    const oldTs = new Date(Date.now() - PATHOLOGY_BUDGET_WINDOW_MS - 60_000).toISOString();
    db.query(
      `INSERT INTO events (id, ts, kind, substrate_origin, directive_id, task_id, loop_id, payload)
       VALUES (?, ?, 'pathology_budget_debited', 'substrate_auto', ?, '', '', ?)`,
    ).run(
      newId(),
      oldTs,
      directiveId,
      JSON.stringify({ pathology_kind: "dispatch_budget_exceeded", weight: 5 }),
    );
    const s = summarizeBudget(db, directiveId);
    expect(s.total_weight).toBe(0);
    expect(maybeExhaustPathologyBudget(db, directiveId)).toBeNull();
  });

  test("debit accepts evidence_event_id and records it as context_refs", () => {
    const db = openDb(":memory:");
    const directiveId = newId();
    const evidenceId = newId();
    const result = debit(db, {
      directive_id: directiveId,
      pathology_kind: "redispatch_storm",
      evidence_event_id: evidenceId,
    });
    const row = db
      .query("SELECT context_refs FROM events WHERE id = ?")
      .get(result.id) as { context_refs: string };
    const refs = JSON.parse(row.context_refs) as string[];
    expect(refs).toContain(evidenceId);
  });
});
