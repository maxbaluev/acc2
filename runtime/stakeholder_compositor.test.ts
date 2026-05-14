// acc2 stakeholder compositor tests — Phase I (v2-design.md §3.3).

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { runViews } from "../substrate/views";
import { emitEvent } from "./events";
import { newId } from "./ids";
import {
  stakeholderStateView,
  detectStakeholderConflicts,
  renderStakeholderBlock,
  recordStakeholderState,
} from "./stakeholder_compositor";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const seedDirective = (db: ReturnType<typeof openDb>): string => {
  const directiveId = newId();
  emitEvent(db, {
    kind: "directive_opened",
    substrate_origin: "owner",
    directive_id: directiveId,
    task_id: directiveId,
    payload: { directive_text: "negotiate salary", lifecycle: "finite" },
  });
  return directiveId;
};

describe("stakeholder_compositor", () => {
  test("state view folds events to one row per stakeholder (latest wins)", () => {
    const db = openDb(":memory:");
    const directiveId = seedDirective(db);

    recordStakeholderState(db, {
      directive_id: directiveId,
      stakeholder_id: "self",
      declared_utility: { target_salary: 200000, min_salary: 180000 },
      inferred_constraints: ["close by EOQ"],
      information_visibility: "full",
    });
    // Update — should supersede.
    recordStakeholderState(db, {
      directive_id: directiveId,
      stakeholder_id: "self",
      declared_utility: { target_salary: 250000, min_salary: 220000 },
      information_visibility: "full",
    });
    recordStakeholderState(db, {
      directive_id: directiveId,
      stakeholder_id: "counterpart",
      declared_utility: { max_salary: 270000 },
      information_visibility: "limited",
    });

    const view = stakeholderStateView(db, directiveId);
    expect(view.length).toBe(2);
    const self = view.find((v) => v.stakeholder_id === "self");
    expect(self).toBeTruthy();
    expect((self!.declared_utility as Record<string, number>).target_salary).toBe(250000);
    expect((self!.declared_utility as Record<string, number>).min_salary).toBe(220000);
  });

  test("renderStakeholderBlock returns empty for single-stakeholder directive", () => {
    const db = openDb(":memory:");
    const directiveId = seedDirective(db);
    recordStakeholderState(db, {
      directive_id: directiveId,
      stakeholder_id: "self",
      declared_utility: { target_salary: 200000 },
    });
    expect(renderStakeholderBlock(db, directiveId)).toBe("");
  });

  test("renderStakeholderBlock formats both stakeholders with utility + visibility", () => {
    const db = openDb(":memory:");
    const directiveId = seedDirective(db);
    recordStakeholderState(db, {
      directive_id: directiveId,
      stakeholder_id: "self",
      declared_utility: { target_salary: 200000 },
      information_visibility: "full",
    });
    recordStakeholderState(db, {
      directive_id: directiveId,
      stakeholder_id: "counterpart",
      declared_utility: { max_salary: 300000 },
      information_visibility: "limited",
    });
    const rendered = renderStakeholderBlock(db, directiveId);
    expect(rendered).toContain("STAKEHOLDER STATE");
    expect(rendered).toContain("self");
    expect(rendered).toContain("counterpart");
    expect(rendered).toContain("full");
    expect(rendered).toContain("limited");
  });

  test("detectStakeholderConflicts: min exceeds counterparty's max", () => {
    const db = openDb(":memory:");
    const directiveId = seedDirective(db);
    recordStakeholderState(db, {
      directive_id: directiveId,
      stakeholder_id: "self",
      declared_utility: { min_salary: 250000 },
    });
    recordStakeholderState(db, {
      directive_id: directiveId,
      stakeholder_id: "counterpart",
      declared_utility: { max_salary: 220000 },
    });
    const conflicts = detectStakeholderConflicts(db, directiveId);
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts[0]!.conflicting_field).toBe("min_salary");
    expect(conflicts[0]!.detail).toContain("250000");
  });

  test("detectStakeholderConflicts: target diverges by >20%", () => {
    const db = openDb(":memory:");
    const directiveId = seedDirective(db);
    recordStakeholderState(db, {
      directive_id: directiveId,
      stakeholder_id: "alpha",
      declared_utility: { target_price: 100 },
    });
    recordStakeholderState(db, {
      directive_id: directiveId,
      stakeholder_id: "beta",
      declared_utility: { target_price: 200 },
    });
    const conflicts = detectStakeholderConflicts(db, directiveId);
    expect(conflicts.some((c) => c.conflicting_field === "target_price")).toBe(true);
  });

  test("recordStakeholderState auto-emits stakeholder_conflict on disagreement", () => {
    const db = openDb(":memory:");
    const directiveId = seedDirective(db);
    recordStakeholderState(db, {
      directive_id: directiveId,
      stakeholder_id: "self",
      declared_utility: { min_salary: 280000 },
    });
    const result = recordStakeholderState(db, {
      directive_id: directiveId,
      stakeholder_id: "counterpart",
      declared_utility: { max_salary: 200000 },
    });
    expect(result.conflicts.length).toBeGreaterThan(0);
    const rows = db
      .query("SELECT kind, failure_kind FROM events WHERE kind = 'stakeholder_conflict'")
      .all() as Array<{ kind: string; failure_kind: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.failure_kind).toBe("stakeholder_conflict");

    const ownerNeeds = db
      .query("SELECT COUNT(*) as c FROM events WHERE kind = 'owner_input_required'")
      .get() as { c: number };
    expect(ownerNeeds.c).toBeGreaterThan(0);
  });

  test("stakeholder_state_view (SQL) projects latest row per (directive, stakeholder)", () => {
    const db = openDb(":memory:");
    runViews(db);
    const directiveId = seedDirective(db);
    recordStakeholderState(db, {
      directive_id: directiveId,
      stakeholder_id: "self",
      declared_utility: { v: 1 },
    });
    recordStakeholderState(db, {
      directive_id: directiveId,
      stakeholder_id: "self",
      declared_utility: { v: 2 },
    });
    const rows = db
      .query("SELECT * FROM stakeholder_state_view WHERE directive_id = ?")
      .all(directiveId) as Array<{ stakeholder_id: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.stakeholder_id).toBe("self");
  });

  test("no conflict when stakeholders' utilities are reconcilable", () => {
    const db = openDb(":memory:");
    const directiveId = seedDirective(db);
    recordStakeholderState(db, {
      directive_id: directiveId,
      stakeholder_id: "self",
      declared_utility: { min_salary: 200000 },
    });
    recordStakeholderState(db, {
      directive_id: directiveId,
      stakeholder_id: "counterpart",
      declared_utility: { max_salary: 280000 },
    });
    const conflicts = detectStakeholderConflicts(db, directiveId);
    expect(conflicts.length).toBe(0);
  });
});
