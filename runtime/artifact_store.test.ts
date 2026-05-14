// acc2 artifact store unit tests — CRUD round-trip, residual-driven posterior
// update (Beta α/β + EMA), and the LATM promotion / quarantine transitions.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent, type EmitEventInput } from "./events";
import {
  applyResidualOutcome,
  getArtifact,
  insertArtifact,
  listArtifactsByRuntime,
  maybePromote,
  maybeQuarantine,
} from "./artifact_store";
import { nowIso } from "./ids";
import type { Database } from "bun:sqlite";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const insertSampleBunArtifact = (db: Database, id: string, opts?: { initialAlpha?: number; initialBeta?: number; score?: number; confidence?: number }) => {
  return insertArtifact(db, {
    runtime: "bun",
    body: "// sample artifact\nconsole.log('@@RESULT@@ {}');",
    declaredSandbox: {
      runtime: "bun",
      cpu_ms: 1000,
      wall_ms: 5000,
      memory_mb: 64,
    },
    stateRoot: null,
    posteriorAlpha: opts?.initialAlpha ?? 1,
    posteriorBeta: opts?.initialBeta ?? 1,
    score: opts?.score ?? 0.5,
    confidence: opts?.confidence ?? 0.3,
    recentResidualMean: 0,
    recentKillCount: 0,
    status: "admitted",
    name: null,
    fixtureInput: null,
    fixtureExpectedResidual: 0.2,
    id,
  });
};

describe("artifact_store CRUD", () => {
  test("insert + get round-trip preserves every column", () => {
    const db = openDb(":memory:");
    const row = insertSampleBunArtifact(db, "art_round_trip");
    const got = getArtifact(db, "art_round_trip");
    expect(got).not.toBeNull();
    expect(got!.id).toBe("art_round_trip");
    expect(got!.runtime).toBe("bun");
    expect(got!.declaredSandbox.runtime).toBe("bun");
    expect(got!.score).toBeCloseTo(0.5, 6);
    expect(got!.status).toBe("admitted");
    expect(got!.createdAt).toBe(row.createdAt);
  });

  test("listArtifactsByRuntime returns only the requested runtime sorted by score desc", () => {
    const db = openDb(":memory:");
    insertSampleBunArtifact(db, "art_lo", { score: 0.4 });
    insertSampleBunArtifact(db, "art_hi", { score: 0.9 });
    insertArtifact(db, {
      runtime: "uv",
      body: "# uv stub",
      declaredSandbox: { runtime: "uv", cpu_ms: 1, wall_ms: 1, memory_mb: 1 },
      stateRoot: null,
      posteriorAlpha: 1, posteriorBeta: 1, score: 0.5, confidence: 0.3,
      recentResidualMean: 0, recentKillCount: 0,
      status: "admitted", name: null, fixtureInput: null, fixtureExpectedResidual: 0.2,
      id: "art_uv",
    });
    const rows = listArtifactsByRuntime(db, "bun");
    expect(rows.map((r) => r.id)).toEqual(["art_hi", "art_lo"]);
    const uvRows = listArtifactsByRuntime(db, "uv");
    expect(uvRows.map((r) => r.id)).toEqual(["art_uv"]);
  });

  test("getArtifact returns null for an unknown id", () => {
    const db = openDb(":memory:");
    expect(getArtifact(db, "does-not-exist")).toBeNull();
  });
});

describe("applyResidualOutcome", () => {
  test("residual=0.1 increases alpha and lowers EMA below 0.1", () => {
    const db = openDb(":memory:");
    insertSampleBunArtifact(db, "art_succ");
    const updated = applyResidualOutcome(db, "art_succ", 0.1, nowIso());
    expect(updated.posteriorAlpha).toBeGreaterThan(1);
    expect(updated.posteriorBeta).toBeCloseTo(1, 6);
    expect(updated.score).toBeGreaterThan(0.5);
    // EMA after one event with decay = 0.5^(1/20) ≈ 0.9659
    // recentResidualMean = decay*0 + (1-decay)*0.1 ≈ 0.0034
    expect(updated.recentResidualMean).toBeGreaterThan(0);
    expect(updated.recentResidualMean).toBeLessThan(0.1);
  });

  test("residual=0.9 increases beta and raises EMA above 0", () => {
    const db = openDb(":memory:");
    insertSampleBunArtifact(db, "art_fail");
    const updated = applyResidualOutcome(db, "art_fail", 0.9, nowIso());
    expect(updated.posteriorAlpha).toBeCloseTo(1, 6);
    expect(updated.posteriorBeta).toBeGreaterThan(1);
    expect(updated.score).toBeLessThan(0.5);
    expect(updated.recentResidualMean).toBeGreaterThan(0);
  });

  test("repeated events drive the EMA toward the steady-state residual", () => {
    const db = openDb(":memory:");
    insertSampleBunArtifact(db, "art_drift");
    let row = getArtifact(db, "art_drift")!;
    for (let i = 0; i < 60; i++) {
      row = applyResidualOutcome(db, "art_drift", 0.8, nowIso());
    }
    // After ~3 half-lives at residual=0.8 the EMA should be well above 0.6.
    expect(row.recentResidualMean).toBeGreaterThan(0.6);
  });

  test("residual is clamped to [0,1] defensively", () => {
    const db = openDb(":memory:");
    insertSampleBunArtifact(db, "art_clamp");
    const r1 = applyResidualOutcome(db, "art_clamp", -5, nowIso());
    expect(r1.posteriorAlpha).toBeGreaterThan(1);
    const r2 = applyResidualOutcome(db, "art_clamp", 5, nowIso());
    expect(r2.posteriorBeta).toBeGreaterThan(1);
  });

  test("throws on unknown artifact id", () => {
    const db = openDb(":memory:");
    expect(() => applyResidualOutcome(db, "missing", 0.5, nowIso())).toThrow(/code_artifact_not_found/);
  });
});

describe("maybePromote", () => {
  test("promotes once thresholds are met and emits exactly one promotion event", () => {
    const db = openDb(":memory:");
    // Engineered priors that already sit at score≥0.85, confidence≥0.7, n≥20.
    insertSampleBunArtifact(db, "art_promo", {
      initialAlpha: 25, initialBeta: 3, score: 25 / 28, confidence: 0.85,
    });
    const events: EmitEventInput[] = [];
    const transitioned = maybePromote(db, "art_promo", (e) => events.push(e));
    expect(transitioned).toBe(true);
    const row = getArtifact(db, "art_promo")!;
    expect(row.status).toBe("promoted");
    expect(events.length).toBe(1);
    expect(events[0]!.kind).toBe("code_artifact_promoted");
    // Idempotent: calling again is a no-op.
    const again = maybePromote(db, "art_promo", (e) => events.push(e));
    expect(again).toBe(false);
    expect(events.length).toBe(1);
  });

  test("does NOT promote when invocation count is below threshold", () => {
    const db = openDb(":memory:");
    insertSampleBunArtifact(db, "art_thin", {
      initialAlpha: 5, initialBeta: 1, score: 5 / 6, confidence: 0.8,
    });
    const events: EmitEventInput[] = [];
    const transitioned = maybePromote(db, "art_thin", (e) => events.push(e));
    expect(transitioned).toBe(false);
    expect(events.length).toBe(0);
  });

  test("synthesizes a name from the first comment in the body when none is set", () => {
    const db = openDb(":memory:");
    insertArtifact(db, {
      runtime: "bun",
      body: "// promoted_check — synthesized name candidate\nconsole.log('@@RESULT@@ {}');",
      declaredSandbox: { runtime: "bun", cpu_ms: 1, wall_ms: 1, memory_mb: 1 },
      stateRoot: null,
      posteriorAlpha: 25, posteriorBeta: 3, score: 25 / 28, confidence: 0.85,
      recentResidualMean: 0, recentKillCount: 0,
      status: "admitted", name: null, fixtureInput: null, fixtureExpectedResidual: 0.2,
      id: "art_name",
    });
    maybePromote(db, "art_name", () => undefined);
    const row = getArtifact(db, "art_name")!;
    expect(row.name).toContain("promoted_check");
  });
});

describe("maybeQuarantine", () => {
  test("quarantines once recent_residual_mean exceeds threshold with enough invocations", () => {
    const db = openDb(":memory:");
    insertSampleBunArtifact(db, "art_q");
    // Drive enough events to exceed both the invocation floor (≥10) and the
    // EMA threshold (>0.6) by sending repeated near-1 residuals.
    let row = getArtifact(db, "art_q")!;
    for (let i = 0; i < 30; i++) {
      row = applyResidualOutcome(db, "art_q", 0.95, nowIso());
    }
    expect(row.recentResidualMean).toBeGreaterThan(0.6);
    const events: EmitEventInput[] = [];
    const transitioned = maybeQuarantine(db, "art_q", (e) => events.push(e));
    expect(transitioned).toBe(true);
    expect(getArtifact(db, "art_q")!.status).toBe("quarantined");
    expect(events.length).toBe(1);
    expect(events[0]!.kind).toBe("code_artifact_quarantined");
    // Idempotent.
    const again = maybeQuarantine(db, "art_q", (e) => events.push(e));
    expect(again).toBe(false);
    expect(events.length).toBe(1);
  });

  test("quarantines on 5 consecutive sandbox_violation events", () => {
    const db = openDb(":memory:");
    insertSampleBunArtifact(db, "art_v");
    for (let i = 0; i < 5; i++) {
      emitEvent(db, {
        kind: "sandbox_violation",
        substrate_origin: "substrate_auto",
        action_artifact_id: "art_v",
        payload: { i },
      });
    }
    const events: EmitEventInput[] = [];
    const transitioned = maybeQuarantine(db, "art_v", (e) => events.push(e));
    expect(transitioned).toBe(true);
    expect(getArtifact(db, "art_v")!.status).toBe("quarantined");
  });

  test("does not quarantine when only the residual is high but invocations are too few", () => {
    const db = openDb(":memory:");
    insertSampleBunArtifact(db, "art_calm");
    // Synthetically poke the EMA high without enough invocations.
    const db2 = db;
    db2.run(
      "UPDATE code_artifact SET recent_residual_mean = ?, posterior_alpha = ?, posterior_beta = ? WHERE id = ?",
      [0.9, 2, 1, "art_calm"],
    );
    const events: EmitEventInput[] = [];
    const transitioned = maybeQuarantine(db, "art_calm", (e) => events.push(e));
    expect(transitioned).toBe(false);
    expect(events.length).toBe(0);
  });
});
