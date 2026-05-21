import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { closeDb, openDb } from "../substrate/db";
import { maybePromoteKnowledge } from "../substrate/extractors";
import { insertArtifact } from "./artifact_store";
import { distributeCredit } from "./credit";
import { emitEvent } from "./events";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const insertSampleArtifact = (db: Database, id: string, body: string) =>
  insertArtifact(db, {
    runtime: "bun",
    body,
    declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
    stateRoot: null,
    posteriorAlpha: 1,
    posteriorBeta: 1,
    score: 0.5,
    confidence: 0.3,
    recentResidualMean: 0,
    recentKillCount: 0,
    status: "admitted",
    name: null,
    fixtureInput: null,
    fixtureExpectedResidual: 0.2,
    id,
  });

describe("citation binding honesty", () => {
  test("payload-only decorative cited_knowledge_ids earns no Shapley credit and records beta evidence", async () => {
    const db = openDb(":memory:");
    insertSampleArtifact(db, "honesty_action", "console.log('@@RESULT@@ ok');");
    insertSampleArtifact(db, "honesty_verifier", "console.log('@@RESULT@@ {\"residual\":0}');");
    const kc = emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "opencode",
      directive_id: "d_honesty",
      task_id: "t_honesty_k",
      payload: { claim: "decorative citation probe", confidence_estimate: 1 },
    });
    const before = maybePromoteKnowledge(db, kc.id);
    expect(before.score).toBeCloseTo(0.5, 6);

    const ap = emitEvent(db, {
      kind: "action_predicted",
      substrate_origin: "opencode",
      directive_id: "d_honesty",
      task_id: "t_honesty",
      action_artifact_id: "honesty_action",
      verifier_artifact_id: "honesty_verifier",
      payload: { cited_knowledge_ids: [kc.id] },
    });
    const obs = emitEvent(db, {
      kind: "artifact_observed",
      substrate_origin: "substrate_auto",
      directive_id: "d_honesty",
      task_id: "t_honesty",
      action_artifact_id: "honesty_action",
      payload: {},
    });
    const scored = emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate_auto",
      directive_id: "d_honesty",
      task_id: "t_honesty",
      action_artifact_id: "honesty_action",
      verifier_artifact_id: "honesty_verifier",
      residual: 0,
      payload: {},
    });

    const result = await distributeCredit(db, {
      action_event_id: ap.id,
      observation_event_id: obs.id,
      scored_event_id: scored.id,
      predicted_residual: 0,
      observed_residual: 0,
    });

    expect(result.contributions.map((c) => c.target_id)).not.toContain(kc.id);
    const rejected = db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM events WHERE kind = 'retrieval_rejected' AND json_extract(payload, '$.reason') = 'decorative_citation_not_bound' AND context_refs LIKE '%' || ? || '%' LIMIT 1",
      )
      .get(kc.id);
    expect(rejected).not.toBeNull();
    const after = maybePromoteKnowledge(db, kc.id);
    expect(after.score).toBeLessThan(before.score);
  });

  test("context_refs and body @cite markers remain legitimate bindings without retrieval_binding rows", async () => {
    const db = openDb(":memory:");
    insertSampleArtifact(db, "bound_action", "// @cite k_body\nconsole.log('@@RESULT@@ ok');");
    insertSampleArtifact(db, "bound_verifier", "console.log('@@RESULT@@ {\"residual\":0}');");
    const kc = emitEvent(db, {
      kind: "knowledge_candidate",
      substrate_origin: "opencode",
      directive_id: "d_bound",
      task_id: "t_bound_k",
      payload: { claim: "context refs are binding", confidence_estimate: 1 },
    });
    const ap = emitEvent(db, {
      kind: "action_predicted",
      substrate_origin: "opencode",
      directive_id: "d_bound",
      task_id: "t_bound",
      action_artifact_id: "bound_action",
      verifier_artifact_id: "bound_verifier",
      context_refs: [kc.id],
      payload: { cited_knowledge_ids: [kc.id] },
    });
    const obs = emitEvent(db, {
      kind: "artifact_observed",
      substrate_origin: "substrate_auto",
      directive_id: "d_bound",
      task_id: "t_bound",
      action_artifact_id: "bound_action",
      payload: {},
    });
    const scored = emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate_auto",
      directive_id: "d_bound",
      task_id: "t_bound",
      action_artifact_id: "bound_action",
      verifier_artifact_id: "bound_verifier",
      residual: 0,
      payload: {},
    });

    const result = await distributeCredit(db, {
      action_event_id: ap.id,
      observation_event_id: obs.id,
      scored_event_id: scored.id,
      predicted_residual: 0,
      observed_residual: 0,
    });

    const ids = result.contributions.map((c) => c.target_id);
    expect(ids).toContain(kc.id);
    expect(ids).toContain("k_body");
    const rejected = db.query("SELECT id FROM events WHERE kind = 'retrieval_rejected'").get();
    expect(rejected).toBeNull();
  });
});
