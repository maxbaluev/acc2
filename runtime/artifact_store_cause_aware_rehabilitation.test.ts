import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { getArtifact, insertArtifact, listRehabilitationCandidates, rehabilitationWorkerTick } from "./artifact_store";
import type { EmitEventInput } from "./events";
import type { Database } from "bun:sqlite";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const BASE_NOW_MS = Date.UTC(2026, 4, 21, 12, 0, 0);
const TWENTY_MINUTES_AGO = new Date(BASE_NOW_MS - 20 * 60 * 1000).toISOString();

const insertQuarantinedArtifact = (db: Database, id: string, reason: string): void => {
  insertArtifact(db, {
    runtime: "bun",
    body: "// sample artifact\nconsole.log('@@RESULT@@ {}');",
    declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
    stateRoot: null,
    posteriorAlpha: 1,
    posteriorBeta: 1,
    score: 0.5,
    confidence: 0.3,
    recentResidualMean: 0,
    recentKillCount: 0,
    status: "quarantined",
    name: null,
    fixtureInput: null,
    fixtureExpectedResidual: 0.2,
    id,
  });
  db.run(
    `INSERT INTO events (
       id, ts, directive_id, task_id, parent_task_id, loop_id,
       substrate_origin, kind, payload, context_refs,
       predicted_residual, action_artifact_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `q_${id}`,
      TWENTY_MINUTES_AGO,
      "d_test",
      "t_test",
      null,
      "loop_root",
      "substrate_auto",
      "act_artifact_quarantined",
      JSON.stringify({ reason }),
      JSON.stringify([]),
      null,
      id,
    ],
  );
};

describe("cause-aware artifact rehabilitation cooldown", () => {
  test("kernel_sandbox_enforcement_missing quarantine is eligible after the short cooldown and is re-probed", async () => {
    const db = openDb(":memory:");
    insertQuarantinedArtifact(db, "infra_gap", "kernel_sandbox_enforcement_missing");

    expect(listRehabilitationCandidates(db, BASE_NOW_MS).map((row) => row.id)).toContain("infra_gap");

    let runCount = 0;
    const events: EmitEventInput[] = [];
    const results = await rehabilitationWorkerTick(
      db,
      async () => {
        runCount++;
        return { ok: true, residual: 0.05 };
      },
      (event) => events.push(event),
      { nowMs: BASE_NOW_MS },
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.result.rehabilitated).toBe(true);
    expect(runCount).toBeGreaterThan(0);
    expect(events.some((event) => event.kind === "act_artifact_rehabilitated")).toBe(true);
    expect(getArtifact(db, "infra_gap")!.status).toBe("admitted");
  });

  test("behavioral-fault quarantine remains ineligible until the 14-day cooldown", () => {
    const db = openDb(":memory:");
    insertQuarantinedArtifact(db, "behavioral_fault", "residual_mean_exceeded");

    expect(listRehabilitationCandidates(db, BASE_NOW_MS).map((row) => row.id)).not.toContain("behavioral_fault");
  });

  test("short-cooldown re-probe still gates on fixture residual and does not blind re-admit", async () => {
    const db = openDb(":memory:");
    insertQuarantinedArtifact(db, "infra_gap_bad_fixture", "kernel_sandbox_enforcement_missing");

    let runCount = 0;
    const results = await rehabilitationWorkerTick(
      db,
      async () => {
        runCount++;
        return { ok: true, residual: 0.9 };
      },
      () => undefined,
      { nowMs: BASE_NOW_MS },
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.result.rehabilitated).toBe(false);
    if (!results[0]!.result.rehabilitated) {
      expect(results[0]!.result.reason).toBe("fixture_residual_too_high");
    }
    expect(runCount).toBe(1);
    expect(getArtifact(db, "infra_gap_bad_fixture")!.status).toBe("quarantined");
  });
});
