import { describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { runViews } from "../substrate/views";
import { inspectDirective, runDirective } from "./directive";

const insertEvent = (
  db: ReturnType<typeof openDb>,
  fields: { id: string; ts?: string; directive_id?: string; task_id?: string; parent_task_id?: string | null; kind: string; payload?: Record<string, unknown>; residual?: number | null },
): void => {
  db.run(
    `INSERT INTO events (id, ts, directive_id, task_id, parent_task_id, loop_id, substrate_origin, kind, payload, context_refs, residual)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fields.id,
      fields.ts ?? `2026-05-16T00:00:${fields.id.slice(-2)}.000Z`,
      fields.directive_id ?? "D1",
      fields.task_id ?? "T1",
      fields.parent_task_id ?? null,
      "L1",
      "brain",
      fields.kind,
      JSON.stringify(fields.payload ?? {}),
      JSON.stringify([]),
      fields.residual ?? null,
    ],
  );
};

describe("acc directive", () => {
  test("inspectDirective assembles the single-directive surface", () => {
    closeDb(":memory:");
    const db = openDb(":memory:");
    runViews(db);
    insertEvent(db, { id: "E01", kind: "directive_opened", payload: { directive_text: "inspect this directive", lifecycle: "finite" } });
    insertEvent(db, { id: "E02", kind: "task_node_opened", task_id: "T1", payload: { goal: "root" } });
    insertEvent(db, { id: "E03", kind: "task_node_opened", task_id: "T2", parent_task_id: "T1", payload: { goal: "child" } });
    insertEvent(db, { id: "E04", kind: "task_edge_recorded", task_id: "T2", parent_task_id: "T1", payload: { kind: "refines", from_task: "T1", to_task: "T2" } });
    insertEvent(db, { id: "E05", kind: "brain_dispatched", task_id: "T1", payload: { dispatch_id: "B1" } });
    insertEvent(db, { id: "E06", kind: "task_closure_audited", task_id: "T1", payload: { closure_residual: 0.12 } });
    insertEvent(db, { id: "E07", kind: "task_committed", task_id: "T1", payload: {} });
    insertEvent(db, { id: "E08", kind: "applied_change_committed", task_id: "T1", payload: { summary: "changed cli" } });
    insertEvent(db, { id: "E09", kind: "irreversible_effect_recorded", task_id: "T1", payload: { summary: "sent email" } });

    const inspection = inspectDirective(db, "D1");
    expect(inspection.dispatch[0]?.lifecycle_status).toBe("completed");
    expect(inspection.task_graph.refinement_edges).toHaveLength(1);
    expect(inspection.closure_audits[0]?.payload.closure_residual).toBe(0.12);
    expect(inspection.applied_changes).toHaveLength(1);
    expect(inspection.irreversible_effects.summary?.effect_count).toBe(1);
  });

  test("runDirective renders human and json output", async () => {
    closeDb(":memory:");
    const db = openDb(":memory:");
    runViews(db);
    insertEvent(db, { id: "H01", kind: "directive_opened", payload: { directive_text: "owner-facing directive" } });
    insertEvent(db, { id: "H02", kind: "task_node_opened", task_id: "T1", payload: { goal: "root" } });

    const lines: string[] = [];
    const code = await runDirective(["D1"], { out: (s) => lines.push(s), err: () => {}, openSubstrate: () => db });
    expect(code).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("dispatch status (dispatch_resolved_view)");
    expect(text).toContain("task graph / refinement edges");
    expect(text).toContain("recent narrative events");

    const json: string[] = [];
    const jsonCode = await runDirective(["--json", "D1"], { out: (s) => json.push(s), err: () => {}, openSubstrate: () => db });
    expect(jsonCode).toBe(0);
    const parsed = JSON.parse(json.join("\n")) as { directive_id: string; task_graph: { nodes: unknown[] } };
    expect(parsed.directive_id).toBe("D1");
    expect(parsed.task_graph.nodes).toHaveLength(1);
  });
});
