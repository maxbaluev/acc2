// acc2 ALIAS_CHAI (directive 3XETJCYT) — alias-chain resolution across
// credit, artifact retrieval, and routing/selection.
//
// When a release renames an artifact handle, the migration emits
// act_artifact_aliased{old_id,new_id}. Every read/credit/routing path that
// looks an artifact up BY ID must resolve OLD → CURRENT so accumulated
// posterior credit survives the rename across many version gaps. These
// tests pin that resolution at each fixed site (getArtifact,
// applyResidualOutcome, maybeQuarantine, classifyTarget via the universal
// projector) AND that posterior credit cited against an OLD id lands on the
// CURRENT artifact's row — never a phantom.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import {
  emitEvent,
  resetPostCommitProjectionsForTest,
} from "./events";
import {
  getArtifact,
  insertArtifact,
  applyResidualOutcome,
  maybeQuarantine,
} from "./artifact_store";
import { resolveArtifactId } from "../substrate/migration_runner";
import { projectActionScoredToCredit } from "./credit";
import type { Database } from "bun:sqlite";

afterAll(() => closeDb());
beforeEach(() => {
  resetPostCommitProjectionsForTest();
  closeDb();
});

const insertArt = (db: Database, id: string, body: string) =>
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

const alias = (db: Database, oldId: string, newId: string, reason: string) =>
  emitEvent(db, {
    kind: "act_artifact_aliased",
    substrate_origin: "substrate_auto",
    payload: { old_id: oldId, new_id: newId, reason },
  });

const rawRow = (db: Database, id: string) =>
  db.query("SELECT posterior_alpha, posterior_beta FROM act_artifact WHERE id = ?").get(id) as
    | { posterior_alpha: number; posterior_beta: number }
    | null;

describe("ALIAS_CHAI resolveArtifactId", () => {
  test("un-aliased id resolves to itself (identity)", () => {
    const db = openDb(":memory:");
    expect(resolveArtifactId(db, "art_no_alias")).toBe("art_no_alias");
  });

  test("3-hop chain resolves to terminal id from any starting id", () => {
    const db = openDb(":memory:");
    alias(db, "v1", "v2", "release_2");
    alias(db, "v2", "v3", "release_3");
    alias(db, "v3", "v4", "release_4");
    expect(resolveArtifactId(db, "v1")).toBe("v4");
    expect(resolveArtifactId(db, "v2")).toBe("v4");
    expect(resolveArtifactId(db, "v3")).toBe("v4");
    expect(resolveArtifactId(db, "v4")).toBe("v4");
  });

  test("cycle terminates without infinite loop", () => {
    const db = openDb(":memory:");
    alias(db, "C1", "C2", "step");
    alias(db, "C2", "C1", "cycle");
    const r = resolveArtifactId(db, "C1");
    expect(["C1", "C2"]).toContain(r);
  });

  test("memoized cache invalidates when a new alias edge lands", () => {
    const db = openDb(":memory:");
    expect(resolveArtifactId(db, "M1")).toBe("M1"); // cached identity
    alias(db, "M1", "M2", "renamed_after_first_resolve");
    // The emit-side invalidateAliasCache hook must have cleared the memo.
    expect(resolveArtifactId(db, "M1")).toBe("M2");
  });
});

describe("ALIAS_CHAI getArtifact resolution", () => {
  test("getArtifact(old_id) returns the CURRENT artifact row", () => {
    const db = openDb(":memory:");
    insertArt(db, "current_v3", "// current body");
    alias(db, "old_v1", "old_v2", "r2");
    alias(db, "old_v2", "current_v3", "r3");
    const row = getArtifact(db, "old_v1");
    expect(row).not.toBeNull();
    expect(row!.id).toBe("current_v3");
  });
});

describe("ALIAS_CHAI credit survives rename across many version gaps", () => {
  test("applyResidualOutcome on an OLD id lands on the CURRENT row, no phantom", () => {
    const db = openDb(":memory:");
    insertArt(db, "cur", "// current");
    alias(db, "g1", "g2", "r2");
    alias(db, "g2", "g3", "r3");
    alias(db, "g3", "cur", "r4");

    const before = rawRow(db, "cur")!;
    // Strong success residual (0.0) → alpha grows.
    const updated = applyResidualOutcome(db, "g1", 0.0, new Date().toISOString());
    // The returned row is the CURRENT artifact.
    expect(updated.id).toBe("cur");

    const after = rawRow(db, "cur")!;
    expect(after.posterior_alpha).toBeGreaterThan(before.posterior_alpha);

    // No phantom row was created for any of the old ids.
    for (const phantom of ["g1", "g2", "g3"]) {
      expect(rawRow(db, phantom)).toBeNull();
    }
    // Exactly one act_artifact row exists.
    const count = db.query("SELECT COUNT(*) AS c FROM act_artifact").get() as { c: number };
    expect(count.c).toBe(1);
  });

  test("maybeQuarantine on an OLD id transitions the CURRENT row", () => {
    const db = openDb(":memory:");
    // High EMA + enough invocations so the residual breach fires.
    const art = insertArtifact(db, {
      runtime: "bun",
      body: "// quarantine target",
      declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
      stateRoot: null,
      posteriorAlpha: 1,
      posteriorBeta: 10,
      score: 0.1,
      confidence: 0.8,
      recentResidualMean: 0.9,
      recentKillCount: 0,
      status: "admitted",
      name: null,
      fixtureInput: null,
      fixtureExpectedResidual: 0.2,
      id: "q_cur",
    });
    expect(art.recentResidualMean).toBeGreaterThan(0.7);
    alias(db, "q_old", "q_cur", "renamed");
    const transitioned = maybeQuarantine(db, "q_old", (e) => emitEvent(db, e));
    expect(transitioned).toBe(true);
    const row = getArtifact(db, "q_cur");
    expect(row!.status).toBe("quarantined");
  });
});

describe("ALIAS_CHAI routing/credit projector classifies a renamed cited id", () => {
  test("universal projector credits an OLD cited id onto the CURRENT artifact", () => {
    const db = openDb(":memory:");
    insertArt(db, "actcur", "// action artifact current");
    insertArt(db, "vercur", "// verifier artifact current");
    alias(db, "act_old", "actcur", "renamed_action");

    // action_predicted cites the OLD action id + a registered verifier.
    const predicted = emitEvent(db, {
      kind: "action_predicted",
      substrate_origin: "opencode",
      directive_id: "d_alias",
      task_id: "t_alias",
      action_artifact_id: "act_old",
      verifier_artifact_id: "vercur",
      predicted_residual: 0.2,
      payload: { cited_artifact_ids: ["act_old"] },
    });

    const before = rawRow(db, "actcur")!;

    const scored = emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "substrate_auto",
      directive_id: "d_alias",
      task_id: "t_alias",
      action_artifact_id: "act_old",
      verifier_artifact_id: "vercur",
      residual: 0.0,
      context_refs: [predicted.id],
      payload: {
        residual: 0.0,
        action_predicted_event_id: predicted.id,
        cited_artifact_ids: ["act_old"],
      },
    });

    projectActionScoredToCredit(db, {
      id: scored.id,
      payload: JSON.stringify({
        residual: 0.0,
        action_predicted_event_id: predicted.id,
        cited_artifact_ids: ["act_old"],
      }),
      context_refs: JSON.stringify([predicted.id]),
      directive_id: "d_alias",
      task_id: "t_alias",
      residual: 0.0,
      action_artifact_id: "act_old",
      verifier_artifact_id: "vercur",
    });

    const after = rawRow(db, "actcur")!;
    // Credit cited against the OLD action id moved the CURRENT row's posterior.
    expect(after.posterior_alpha).toBeGreaterThan(before.posterior_alpha);
    // No phantom row for the old id.
    expect(rawRow(db, "act_old")).toBeNull();
  });
});
