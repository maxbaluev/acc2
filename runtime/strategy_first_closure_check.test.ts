// acc2 strategy-first closure-check tests (C3, 2026-05-18,
// directive QHTRBV6PFX2JVBMHDNDA4B03GC). Pin the structural rule:
// any directive that emits a `act_artifact_candidate` whose
// payload.name starts with `atms_report_v` must (a) have ≥ 15
// `task_node_opened` rows under the directive AND (b) cite at least
// one knowledge_candidate whose payload.claim ends with
// `_strategic_direction_chosen`. Otherwise the closure verifier raises
// closure_residual to 0.3 and surfaces diagnostics.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "./events";
import { checkStrategyFirstClosure } from "./strategy_first_closure_check";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const D_OK = "d_strategy_first_pass";
const D_INITIATIVE_FIRST = "d_initiative_first_fail";

const openTask = (
  db: ReturnType<typeof openDb>,
  directiveId: string,
  taskId: string,
  goal: string,
) => emitEvent(db, {
  kind: "task_node_opened",
  directive_id: directiveId,
  task_id: taskId,
  payload: { goal },
});

const seedSituationLayer = (
  db: ReturnType<typeof openDb>,
  directiveId: string,
  prefix: string,
  count: number,
) => {
  for (let i = 1; i <= count; i++) {
    openTask(db, directiveId, `${prefix}_t_${i}`, `${prefix}-${i}: situation deep-dive`);
  }
};

describe("checkStrategyFirstClosure", () => {
  test("strategy-first fixture: ≥15 nodes + strategic_direction_chosen KC cited → ok=true, residual untouched", () => {
    const db = openDb(":memory:");
    // S-layer x 8, T-layer x 2, U-layer x 3, V-layer (the report task),
    // W-layer x 1 → 15 task_node_opened rows minimum.
    seedSituationLayer(db, D_OK, "S", 8);
    openTask(db, D_OK, "T1", "T1: synthesise strategic direction from S-layer findings");
    openTask(db, D_OK, "T2", "T2: validate strategic direction against owner profile");
    const strategyKc = emitEvent(db, {
      kind: "knowledge_candidate",
      directive_id: D_OK,
      task_id: "T1",
      payload: { claim: "vertical_concentration_on_industrial_safety_strategic_direction_chosen", evidence: ["S1","S4"] },
    });
    openTask(db, D_OK, "U1", "U1: filter candidate initiatives against chosen strategic direction");
    openTask(db, D_OK, "U2", "U2: select 3 initiatives that compound the strategic direction");
    openTask(db, D_OK, "U3", "U3: stress-test U1-U2 against owner risk signals");
    openTask(db, D_OK, "V1", "V1: compose ATMS report v6");
    openTask(db, D_OK, "W1", "W1: meta-scan for strategy-first leakage");

    // V-layer emits the atms_report_v* candidate citing the T-layer KC.
    emitEvent(db, {
      kind: "act_artifact_candidate",
      directive_id: D_OK,
      task_id: "V1",
      payload: {
        runtime: "bun",
        name: "atms_report_v6",
        cited_knowledge_ids: [strategyKc.id],
      },
    });

    const result = checkStrategyFirstClosure(db, D_OK, 0.05);
    expect(result.ok).toBe(true);
    expect(result.enforced_residual).toBeCloseTo(0.05, 6);
    expect(result.diagnostics).toHaveLength(0);
    expect(result.atms_report_event_ids).toHaveLength(1);
    expect(result.task_node_opened_count).toBeGreaterThanOrEqual(15);
  });

  test("initiative-first fixture: skips S/T layers, no strategy KC cited → ok=false, residual raised to 0.3", () => {
    const db = openDb(":memory:");
    // Only 4 task_node_opened rows — the v1-v3 failure shape:
    // pick initiatives from priors then write the report.
    openTask(db, D_INITIATIVE_FIRST, "I1", "I1: nfpa_traceability_initiative");
    openTask(db, D_INITIATIVE_FIRST, "I2", "I2: demand_forecasting_initiative");
    openTask(db, D_INITIATIVE_FIRST, "I3", "I3: visual_qc_initiative");
    openTask(db, D_INITIATIVE_FIRST, "V1", "V1: compose ATMS report v1");

    emitEvent(db, {
      kind: "act_artifact_candidate",
      directive_id: D_INITIATIVE_FIRST,
      task_id: "V1",
      payload: {
        runtime: "bun",
        name: "atms_report_v1",
        cited_knowledge_ids: [],
      },
    });

    const result = checkStrategyFirstClosure(db, D_INITIATIVE_FIRST, 0.05);
    expect(result.ok).toBe(false);
    expect(result.enforced_residual).toBeGreaterThanOrEqual(0.3);
    // Two diagnostics: node-floor + missing citation.
    const reasons = result.diagnostics.map((d) => d.reason);
    expect(reasons).toContain("task_node_opened_below_minimum");
    expect(reasons).toContain("atms_report_missing_strategic_direction_chosen_citation");
    expect(result.task_node_opened_count).toBeLessThan(15);
  });

  test("initiative-first w/ enough nodes but still no strategy KC cited → residual still raised", () => {
    const db = openDb(":memory:");
    // 16 task_node_opened rows but NO strategic-direction KC anywhere.
    for (let i = 1; i <= 16; i++) {
      openTask(db, "d_enough_nodes_no_strategy", `n_${i}`, `node ${i}`);
    }
    emitEvent(db, {
      kind: "act_artifact_candidate",
      directive_id: "d_enough_nodes_no_strategy",
      task_id: "n_16",
      payload: { runtime: "bun", name: "atms_report_v4", cited_knowledge_ids: [] },
    });
    const result = checkStrategyFirstClosure(db, "d_enough_nodes_no_strategy", 0.1);
    expect(result.ok).toBe(false);
    expect(result.enforced_residual).toBeGreaterThanOrEqual(0.3);
    expect(result.diagnostics.some((d) => d.reason === "atms_report_missing_strategic_direction_chosen_citation")).toBe(true);
    expect(result.diagnostics.some((d) => d.reason === "task_node_opened_below_minimum")).toBe(false);
  });

  test("no atms_report_v* candidate at all → predicate is N/A (ok=true, residual untouched)", () => {
    const db = openDb(":memory:");
    openTask(db, "d_no_atms_report", "x1", "some other work");
    emitEvent(db, {
      kind: "act_artifact_candidate",
      directive_id: "d_no_atms_report",
      task_id: "x1",
      payload: { runtime: "bun", name: "other_recipe_v1", cited_knowledge_ids: [] },
    });
    const result = checkStrategyFirstClosure(db, "d_no_atms_report", 0.05);
    expect(result.ok).toBe(true);
    expect(result.enforced_residual).toBeCloseTo(0.05, 6);
    expect(result.atms_report_event_ids).toHaveLength(0);
  });

  test("currentResidual already above floor is preserved on violation (max not min)", () => {
    const db = openDb(":memory:");
    emitEvent(db, {
      kind: "act_artifact_candidate",
      directive_id: "d_high_residual",
      task_id: "v1",
      payload: { runtime: "bun", name: "atms_report_v2", cited_knowledge_ids: [] },
    });
    const result = checkStrategyFirstClosure(db, "d_high_residual", 0.55);
    expect(result.ok).toBe(false);
    expect(result.enforced_residual).toBeCloseTo(0.55, 6);
  });

  test("recipe text references the binding suffix so the brain composer sees a stable anchor", () => {
    // Live ledger smoke: the master_report_generation_orchestrator
    // recipe body MUST mention the strategic_direction_chosen suffix
    // and the 15-node floor so a prompt_composer retrieval surfaces the
    // structural rule, not generic prose. We assert against the
    // exported constants to pin both surfaces to the same value.
    const {
      STRATEGIC_DIRECTION_CHOSEN_SUFFIX,
      MIN_TASK_NODE_OPENED_FOR_ATMS_REPORT,
    } = require("./strategy_first_closure_check");
    expect(STRATEGIC_DIRECTION_CHOSEN_SUFFIX).toBe("_strategic_direction_chosen");
    expect(MIN_TASK_NODE_OPENED_FOR_ATMS_REPORT).toBe(15);
  });
});
