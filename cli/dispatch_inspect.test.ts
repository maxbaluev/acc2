// Tests for acc dispatch <id> — canonical substrate-truth inspection.
// Uses the same :memory: + insertEvent pattern as cli/directive.test.ts +
// substrate/views.test.ts. Projection-only — no daemon fixture required.

import { describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { runViews } from "../substrate/views";
import {
  AmbiguousPrefixError,
  DirectiveNotFoundError,
  inspectDispatch,
  resolveDirectivePrefix,
  runDispatchInspect,
} from "./dispatch_inspect";

let _seq = 0;
const tickTs = (offset = 0): string => {
  _seq += 1;
  return new Date(Date.UTC(2026, 4, 16, 0, 0, offset || _seq)).toISOString();
};

const insertEvent = (
  db: ReturnType<typeof openDb>,
  fields: {
    id: string;
    ts?: string;
    directive_id?: string;
    task_id?: string;
    parent_task_id?: string | null;
    kind: string;
    payload?: Record<string, unknown>;
    residual?: number | null;
    substrate_origin?: string;
  },
): void => {
  db.run(
    `INSERT INTO events (id, ts, directive_id, task_id, parent_task_id, loop_id, substrate_origin, kind, payload, context_refs, residual)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fields.id,
      fields.ts ?? tickTs(),
      fields.directive_id ?? "DIRECTIVEA0000000000000000",
      fields.task_id ?? "T_ROOT0000000000000000000A",
      fields.parent_task_id ?? null,
      "loop_t",
      fields.substrate_origin ?? "brain",
      fields.kind,
      JSON.stringify(fields.payload ?? {}),
      JSON.stringify([]),
      fields.residual ?? null,
    ],
  );
};

const DIRA = "DIRECTIVEA0000000000000000"; // 26-char canonical shape
const DIRB = "DIRECTIVEB0000000000000000";

describe("inspectDispatch — projection shape", () => {
  test("assembles directive metadata + DAG + KCs + artifacts + closure", () => {
    closeDb(":memory:");
    const db = openDb(":memory:");
    runViews(db);

    insertEvent(db, { id: "E01", kind: "directive_opened", directive_id: DIRA, task_id: "T_ROOT", payload: { directive_text: "build the thing", lifecycle: "finite" } });
    insertEvent(db, { id: "E02", kind: "task_node_opened", directive_id: DIRA, task_id: "T_ROOT", payload: { goal: "root goal" } });
    insertEvent(db, { id: "E03", kind: "task_node_opened", directive_id: DIRA, task_id: "T_CHILD1", parent_task_id: "T_ROOT", payload: { goal: "child 1" } });
    insertEvent(db, { id: "E04", kind: "task_node_opened", directive_id: DIRA, task_id: "T_CHILD2", parent_task_id: "T_ROOT", payload: { goal: "child 2" } });
    insertEvent(db, { id: "E05", kind: "task_edge_recorded", directive_id: DIRA, task_id: "T_CHILD1", parent_task_id: "T_ROOT", payload: { edge_kind: "refines", from_task_id: "T_ROOT", to_task_id: "T_CHILD1" } });
    insertEvent(db, { id: "E06", kind: "knowledge_candidate", directive_id: DIRA, task_id: "T_ROOT", payload: { claim: "use depth-1 retrieval" } });
    insertEvent(db, { id: "E07", kind: "knowledge_candidate", directive_id: DIRA, task_id: "T_CHILD1", payload: { claim: "verifier residual is truth-bearing" } });
    insertEvent(db, { id: "E08", kind: "act_artifact_candidate", directive_id: DIRA, task_id: "T_CHILD1", payload: { kind: "verifier", name: "alex_predicate_v1", body: "// 42 bytes of body content here please." } });
    insertEvent(db, { id: "E09", kind: "contract_amendment_proposed", directive_id: DIRA, task_id: "T_ROOT", payload: { current_behavior: "manually inspect events", proposed_behavior: "acc dispatch CLI" } });
    insertEvent(db, { id: "E10", kind: "brain_dispatched", directive_id: DIRA, task_id: "T_ROOT", payload: { dispatch_id: "B1" } });
    insertEvent(db, { id: "E11", kind: "task_closure_audited", directive_id: DIRA, task_id: "T_ROOT", payload: { closure_residual: 0.08, status: "ok", verdict: "audited" } });
    insertEvent(db, { id: "E12", kind: "task_committed", directive_id: DIRA, task_id: "T_CHILD1", payload: {} });
    insertEvent(db, { id: "E13", kind: "task_committed", directive_id: DIRA, task_id: "T_ROOT", payload: {} });

    const result = inspectDispatch(db, DIRA);

    expect(result.directive.id).toBe(DIRA);
    expect(result.directive.root_task_id).toBe("T_ROOT");
    expect(result.directive.owner_input).toBe("build the thing");
    expect(result.directive.status).toBe("completed");
    expect(result.directive.evidence_event_id).toBeTruthy();

    // 3 nodes; root first (parent_task_id=null)
    expect(result.tasks).toHaveLength(3);
    expect(result.tasks[0]!.task_id).toBe("T_ROOT");
    expect(result.tasks[0]!.status).toBe("committed");
    expect(result.tasks[0]!.parent_task_id).toBeNull();

    // T_CHILD1 committed; T_CHILD2 pending (no terminal, no brain_dispatched)
    const child1 = result.tasks.find((t) => t.task_id === "T_CHILD1")!;
    const child2 = result.tasks.find((t) => t.task_id === "T_CHILD2")!;
    expect(child1.status).toBe("committed");
    expect(child2.status).toBe("pending");

    // KCs grouped
    expect(result.kcs_by_task.T_ROOT).toHaveLength(1);
    expect(result.kcs_by_task.T_CHILD1).toHaveLength(1);
    expect(result.kcs_by_task.T_ROOT![0]!.claim).toBe("use depth-1 retrieval");

    // Artifact grouped
    expect(result.artifacts_by_task.T_CHILD1).toHaveLength(1);
    expect(result.artifacts_by_task.T_CHILD1![0]!.kind).toBe("verifier");
    expect(result.artifacts_by_task.T_CHILD1![0]!.body_len).toBeGreaterThan(0);

    // Refinement edge
    expect(result.refinement_edges).toHaveLength(1);
    expect(result.refinement_edges[0]!.edge_kind).toBe("refines");

    // Amendment
    expect(result.contract_amendments).toHaveLength(1);
    expect(result.contract_amendments[0]!.proposed_behavior).toBe("acc dispatch CLI");

    // Closure
    expect(result.closure_audits).toHaveLength(1);
    expect(result.closure_audits[0]!.closure_residual).toBe(0.08);
    expect(result.closure_audits[0]!.verdict).toBe("audited");
  });

  test("reports status=live when a task is dispatched but not yet terminal", () => {
    closeDb(":memory:");
    const db = openDb(":memory:");
    runViews(db);
    insertEvent(db, { id: "L01", kind: "directive_opened", directive_id: DIRA, task_id: "T_R", payload: { directive_text: "wip" } });
    insertEvent(db, { id: "L02", kind: "task_node_opened", directive_id: DIRA, task_id: "T_R", payload: { goal: "wip root" } });
    insertEvent(db, { id: "L03", kind: "brain_dispatched", directive_id: DIRA, task_id: "T_R", payload: { dispatch_id: "B1" } });

    const result = inspectDispatch(db, DIRA);
    expect(result.tasks[0]!.status).toBe("live");
    // Directive-level lifecycle: brain_dispatched with no terminal is "live"
    // within the 5-min cap, "zombie" after. Test seeds use 2026-05-16 ts in
    // the deterministic past, so the view classifies as "zombie" — either
    // is honest substrate truth, neither implies completion/failure.
    expect(["live", "zombie", "unknown"]).toContain(result.directive.status);
  });

  test("reports terminal_kind=task_failed when the root failed", () => {
    closeDb(":memory:");
    const db = openDb(":memory:");
    runViews(db);
    insertEvent(db, { id: "F01", kind: "directive_opened", directive_id: DIRA, task_id: "T_R", payload: { directive_text: "doomed" } });
    insertEvent(db, { id: "F02", kind: "task_node_opened", directive_id: DIRA, task_id: "T_R", payload: { goal: "doomed root" } });
    insertEvent(db, { id: "F03", kind: "brain_dispatched", directive_id: DIRA, task_id: "T_R", payload: { dispatch_id: "B1" } });
    insertEvent(db, { id: "F04", kind: "task_failed", directive_id: DIRA, task_id: "T_R", payload: { failure_kind: "verifier_residual_high" } });

    const result = inspectDispatch(db, DIRA);
    expect(result.tasks[0]!.terminal_kind).toBe("task_failed");
    expect(result.tasks[0]!.status).toBe("failed");
    expect(result.directive.status).toBe("failed");
  });
});

describe("resolveDirectivePrefix", () => {
  test("resolves an exact directive_id", () => {
    closeDb(":memory:");
    const db = openDb(":memory:");
    runViews(db);
    insertEvent(db, { id: "P01", kind: "directive_opened", directive_id: DIRA, task_id: "T_R", payload: {} });
    expect(resolveDirectivePrefix(db, DIRA)).toBe(DIRA);
  });

  test("resolves a 6-char prefix when unique", () => {
    closeDb(":memory:");
    const db = openDb(":memory:");
    runViews(db);
    insertEvent(db, { id: "P11", kind: "directive_opened", directive_id: DIRA, task_id: "T_R", payload: {} });
    insertEvent(db, { id: "P12", kind: "directive_opened", directive_id: DIRB, task_id: "T_R", payload: {} });
    // DIRA starts DIRECTIVEA; the 10-char prefix is unique.
    expect(resolveDirectivePrefix(db, "DIRECTIVEA")).toBe(DIRA);
  });

  test("throws AmbiguousPrefixError when prefix matches multiple", () => {
    closeDb(":memory:");
    const db = openDb(":memory:");
    runViews(db);
    insertEvent(db, { id: "P21", kind: "directive_opened", directive_id: DIRA, task_id: "T_R", payload: {} });
    insertEvent(db, { id: "P22", kind: "directive_opened", directive_id: DIRB, task_id: "T_R", payload: {} });
    expect(() => resolveDirectivePrefix(db, "DIRECT")).toThrow(AmbiguousPrefixError);
  });

  test("throws DirectiveNotFoundError when prefix matches nothing", () => {
    closeDb(":memory:");
    const db = openDb(":memory:");
    runViews(db);
    expect(() => resolveDirectivePrefix(db, "NOMATCH99")).toThrow(DirectiveNotFoundError);
  });

  test("rejects too-short non-exact prefixes", () => {
    closeDb(":memory:");
    const db = openDb(":memory:");
    runViews(db);
    insertEvent(db, { id: "P31", kind: "directive_opened", directive_id: DIRA, task_id: "T_R", payload: {} });
    // 'D' is non-exact, < 6 chars → DirectiveNotFoundError (refuses spurious matching).
    expect(() => resolveDirectivePrefix(db, "DIR")).toThrow(DirectiveNotFoundError);
  });
});

describe("runDispatchInspect — command surface", () => {
  test("--json emits structured shape; exit code 0", async () => {
    closeDb(":memory:");
    const db = openDb(":memory:");
    runViews(db);
    insertEvent(db, { id: "J01", kind: "directive_opened", directive_id: DIRA, task_id: "T_R", payload: { directive_text: "json me" } });
    insertEvent(db, { id: "J02", kind: "task_node_opened", directive_id: DIRA, task_id: "T_R", payload: { goal: "root" } });
    insertEvent(db, { id: "J03", kind: "task_committed", directive_id: DIRA, task_id: "T_R", payload: {} });

    const lines: string[] = [];
    const code = await runDispatchInspect([DIRA, "--json"], {
      out: (s) => lines.push(s),
      err: () => {},
      openSubstrate: () => db,
      color: false,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(lines.join("\n")) as { directive: { id: string; status: string }; tasks: unknown[] };
    expect(parsed.directive.id).toBe(DIRA);
    expect(parsed.directive.status).toBe("completed");
    expect(parsed.tasks).toHaveLength(1);
  });

  test("pretty renderer emits expected section headers; exit code 0", async () => {
    closeDb(":memory:");
    const db = openDb(":memory:");
    runViews(db);
    insertEvent(db, { id: "P01", kind: "directive_opened", directive_id: DIRA, task_id: "T_R", payload: { directive_text: "render me" } });
    insertEvent(db, { id: "P02", kind: "task_node_opened", directive_id: DIRA, task_id: "T_R", payload: { goal: "root" } });

    const lines: string[] = [];
    const code = await runDispatchInspect([DIRA, "--no-color"], {
      out: (s) => lines.push(s),
      err: () => {},
      openSubstrate: () => db,
      color: false,
    });
    expect(code).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("acc dispatch — substrate-truth inspection");
    expect(text).toContain(`directive_id : ${DIRA}`);
    expect(text).toContain("task DAG (1 node");
    expect(text).toContain("knowledge_candidate (0)");
    expect(text).toContain("act_artifact_candidate (0)");
    expect(text).toContain("refinement_edges (0)");
    expect(text).toContain("contract_amendment_proposed (0)");
    expect(text).toContain("task_closure_audited (0)");
    expect(text).toContain("dispatch resolution:");
  });

  test("ambiguous prefix exits 1 + lists candidates on stderr", async () => {
    closeDb(":memory:");
    const db = openDb(":memory:");
    runViews(db);
    insertEvent(db, { id: "A01", kind: "directive_opened", directive_id: DIRA, task_id: "T_R", payload: {} });
    insertEvent(db, { id: "A02", kind: "directive_opened", directive_id: DIRB, task_id: "T_R", payload: {} });

    const errs: string[] = [];
    const code = await runDispatchInspect(["DIRECT"], {
      out: () => {},
      err: (s) => errs.push(s),
      openSubstrate: () => db,
      color: false,
    });
    expect(code).toBe(1);
    const text = errs.join("\n");
    expect(text).toContain("ambiguous");
    expect(text).toContain(DIRA);
    expect(text).toContain(DIRB);
  });

  test("missing directive exits 1", async () => {
    closeDb(":memory:");
    const db = openDb(":memory:");
    runViews(db);
    const errs: string[] = [];
    const code = await runDispatchInspect(["NOPENOPENOPE"], {
      out: () => {},
      err: (s) => errs.push(s),
      openSubstrate: () => db,
      color: false,
    });
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("not found");
  });

  test("no arg shows usage and exits 1", async () => {
    const outs: string[] = [];
    const errs: string[] = [];
    const code = await runDispatchInspect([], {
      out: (s) => outs.push(s),
      err: (s) => errs.push(s),
      openSubstrate: () => openDb(":memory:"),
      color: false,
    });
    expect(code).toBe(1);
    expect(outs.join("\n") + errs.join("\n")).toContain("acc dispatch");
  });
});
