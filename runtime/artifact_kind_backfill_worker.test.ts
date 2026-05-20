// Tests for the artifact_kind_backfill_worker. Pins the per-strand
// inference (name suffix / body signature / declared_sandbox.runtime /
// state_root prefix), the high-confidence backfill path, the
// low-confidence uncertain path, and the idempotency guard.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { closeDb, openDb } from "../substrate/db";
import { insertArtifact } from "./artifact_store";
import {
  composeVerdict,
  inferKindFromBody,
  inferKindFromName,
  inferKindFromSandbox,
  inferKindFromStateRoot,
  runArtifactKindBackfill,
} from "./artifact_kind_backfill_worker";

afterAll(() => closeDb());
beforeEach(() => closeDb());

const insertRow = (
  db: Database,
  id: string,
  overrides: {
    body?: string;
    name?: string | null;
    runtime?: "bun" | "uv" | "camofox-browser";
    stateRoot?: string;
    kind?: string;
    sourceCandidateId?: string | null;
  } = {},
): void => {
  insertArtifact(db, {
    id,
    runtime: overrides.runtime ?? "bun",
    kind: overrides.kind ?? "code_artifact",
    body: overrides.body ?? "noop",
    declaredSandbox: { runtime: overrides.runtime ?? "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
    stateRoot: overrides.stateRoot ?? "test/legacy_default",
    posteriorAlpha: 1,
    posteriorBeta: 1,
    score: 0.5,
    confidence: 0.3,
    recentResidualMean: 0,
    recentKillCount: 0,
    status: "admitted",
    name: overrides.name ?? null,
    fixtureInput: null,
    fixtureExpectedResidual: 0.2,
    intent: null,
    summary: null,
    targetFiles: null,
    targetResources: null,
    sourceCandidateId: overrides.sourceCandidateId ?? null,
    ownerGateVerdict: null,
  });
};

const readKind = (db: Database, id: string): string | null => {
  const row = db
    .query<{ kind: string | null }, [string]>("SELECT kind FROM act_artifact WHERE id = ?")
    .get(id);
  return row?.kind ?? null;
};

const countEvents = (db: Database, kind: string, artifactId: string): number => {
  const row = db
    .query<{ c: number }, [string, string]>(
      `SELECT COUNT(*) AS c FROM events
        WHERE kind = ?
          AND json_extract(payload, '$.artifact_id') = ?`,
    )
    .get(kind, artifactId);
  return row?.c ?? 0;
};

describe("inferKindFromName", () => {
  test("recognizes _action suffix as action", async () => {
    expect(inferKindFromName("lesson_apply_gate_action").kind).toBe("action");
    expect(inferKindFromName("claude_agent_apply_change_action").kind).toBe("action");
  });
  test("parses verifier_v1 → verifier", async () => {
    expect(inferKindFromName("closure_verifier_v1").kind).toBe("verifier");
  });
  test("parses decider_v1 → decider", async () => {
    expect(inferKindFromName("dispatch_decider_v1").kind).toBe("decider");
  });
  test("parses predicate_gate_v1 → predicate", async () => {
    expect(inferKindFromName("predicate_gate_v1").kind).toBe("predicate");
  });
  test("returns null for unparseable names", async () => {
    expect(inferKindFromName(null).kind).toBeNull();
    expect(inferKindFromName("").kind).toBeNull();
    expect(inferKindFromName("random_thing").kind).toBeNull();
  });
});

describe("inferKindFromBody", () => {
  test("detects verifier keyword at body head", async () => {
    expect(inferKindFromBody("// verifier — measures residual against expected").kind).toBe("verifier");
    expect(inferKindFromBody("verifier scoring closure_residual").kind).toBe("verifier");
  });
  test("detects merger keyword", async () => {
    expect(inferKindFromBody("// merger — dedup + posterior promotion").kind).toBe("merger");
  });
  test("detects extractor keyword", async () => {
    expect(inferKindFromBody("// extractor — trajectory compression").kind).toBe("extractor");
  });
  test("returns null when no role keyword appears", async () => {
    expect(inferKindFromBody("export default function () { return 1; }").kind).toBeNull();
  });
});

describe("inferKindFromSandbox", () => {
  test("bun → action", async () => {
    expect(inferKindFromSandbox(JSON.stringify({ runtime: "bun" })).kind).toBe("action");
  });
  test("camofox-browser → browser_action", async () => {
    expect(inferKindFromSandbox(JSON.stringify({ runtime: "camofox-browser" })).kind).toBe("browser_action");
  });
  test("malformed json → null", async () => {
    expect(inferKindFromSandbox("not json").kind).toBeNull();
    expect(inferKindFromSandbox(null).kind).toBeNull();
  });
});

describe("inferKindFromStateRoot", () => {
  test("substrate/auto_admit/verifier/* → verifier", async () => {
    expect(inferKindFromStateRoot("substrate/auto_admit/verifier/foo").kind).toBe("verifier");
    expect(inferKindFromStateRoot("substrate/auto_admit/verifier_handle/bar").kind).toBe("verifier");
  });
  test("dispatch/strategy → dispatch_strategy_v1", async () => {
    expect(inferKindFromStateRoot("dispatch/strategy").kind).toBe("dispatch_strategy_v1");
  });
  test("substrate/primitive/* → action", async () => {
    expect(inferKindFromStateRoot("substrate/primitive/foo").kind).toBe("action");
  });
  test("unknown prefix → null", async () => {
    expect(inferKindFromStateRoot("test/something").kind).toBeNull();
  });
});

describe("composeVerdict — weighted strands", () => {
  test("name + body agree → high confidence", async () => {
    const verdict = composeVerdict({
      id: "x",
      body: "// verifier — checks residual",
      declared_sandbox: JSON.stringify({ runtime: "bun" }),
      state_root: "test/anywhere",
      name: "closure_verifier_v1",
      target_resources: null,
      source_candidate_id: null,
    });
    expect(verdict.kind).toBe("verifier");
    expect(verdict.confidence).toBeGreaterThanOrEqual(0.75);
    expect(verdict.evidence.name_pattern).not.toBeNull();
    expect(verdict.evidence.body_signature).not.toBeNull();
  });

  test("only weak sandbox evidence → low confidence", async () => {
    const verdict = composeVerdict({
      id: "y",
      body: "noop",
      declared_sandbox: JSON.stringify({ runtime: "bun" }),
      state_root: "test/legacy",
      name: null,
      target_resources: null,
      source_candidate_id: null,
    });
    // Only the 0.10 sandbox strand fires → action with confidence 0.10.
    expect(verdict.kind).toBe("action");
    expect(verdict.confidence).toBeLessThan(0.75);
  });

  test("no evidence → null verdict", async () => {
    const verdict = composeVerdict({
      id: "z",
      body: "noop",
      declared_sandbox: "",
      state_root: "test/x",
      name: null,
      target_resources: null,
      source_candidate_id: null,
    });
    expect(verdict.kind).toBeNull();
    expect(verdict.confidence).toBe(0);
  });
});

describe("runArtifactKindBackfill — end-to-end", () => {
  test("action row inference: name=_action with bun sandbox is high-confidence action", async () => {
    const db = openDb(":memory:");
    insertRow(db, "a1", {
      name: "lesson_apply_gate_action",
      body: "Substrate primitive — runtime/lesson_apply_gate.ts",
      runtime: "bun",
    });
    const summary = await runArtifactKindBackfill(db, { sweepId: "test_sweep_1" });
    expect(summary.scanned).toBe(1);
    expect(summary.backfilled).toBe(1);
    expect(summary.uncertain).toBe(0);
    expect(summary.by_kind.action).toBe(1);
    expect(readKind(db, "a1")).toBe("action");
    expect(countEvents(db, "artifact_kind_backfilled", "a1")).toBe(1);
    expect(countEvents(db, "artifact_kind_inferred", "a1")).toBe(1);
  });

  test("verifier row inference: name=_verifier_v1 with body verifier keyword", async () => {
    const db = openDb(":memory:");
    insertRow(db, "v1", {
      name: "closure_verifier_v1",
      body: "// verifier — audits the directive against trajectory",
      runtime: "bun",
    });
    const summary = await runArtifactKindBackfill(db, { sweepId: "test_sweep_v" });
    expect(summary.backfilled).toBe(1);
    expect(summary.by_kind.verifier).toBe(1);
    expect(readKind(db, "v1")).toBe("verifier");
  });

  test("predicate row inference: name=_gate_v1 with body predicate keyword", async () => {
    const db = openDb(":memory:");
    insertRow(db, "p1", {
      name: "predicate_gate_v1",
      body: "Substrate primitive — predicate structural admission scorer",
      runtime: "bun",
    });
    const summary = await runArtifactKindBackfill(db, { sweepId: "test_sweep_p" });
    expect(summary.backfilled).toBe(1);
    expect(summary.by_kind.predicate).toBe(1);
    expect(readKind(db, "p1")).toBe("predicate");
  });

  test("low-confidence row → uncertain, no kind update", async () => {
    const db = openDb(":memory:");
    insertRow(db, "u1", {
      // No name, opaque body, no sandbox runtime hint beyond bun.
      name: null,
      body: "noop",
      runtime: "bun",
      stateRoot: "test/legacy_default",
    });
    const summary = await runArtifactKindBackfill(db, { sweepId: "test_sweep_u" });
    expect(summary.scanned).toBe(1);
    expect(summary.uncertain).toBe(1);
    expect(summary.backfilled).toBe(0);
    expect(readKind(db, "u1")).toBe("code_artifact");
    expect(countEvents(db, "artifact_kind_inference_uncertain", "u1")).toBe(1);
    expect(countEvents(db, "artifact_kind_backfilled", "u1")).toBe(0);
    expect(countEvents(db, "artifact_kind_inferred", "u1")).toBe(1);
  });

  test("idempotency: rerunning the sweep on a backfilled row is a no-op", async () => {
    const db = openDb(":memory:");
    insertRow(db, "i1", {
      name: "closure_verifier_v1",
      body: "// verifier — audits closure",
      runtime: "bun",
    });
    const first = await runArtifactKindBackfill(db, { sweepId: "test_sweep_i1" });
    expect(first.backfilled).toBe(1);
    expect(first.skipped_idempotent).toBe(0);

    // Second sweep: row's kind is no longer code_artifact, so it's NOT
    // even in the scan set. scanned should be 0.
    const second = await runArtifactKindBackfill(db, { sweepId: "test_sweep_i2" });
    expect(second.scanned).toBe(0);
    expect(second.backfilled).toBe(0);

    // Reset kind back to code_artifact to exercise the idempotency probe
    // (simulates a hypothetical scenario where the row was rolled back).
    db.run("UPDATE act_artifact SET kind='code_artifact' WHERE id=?", ["i1"]);
    const third = await runArtifactKindBackfill(db, { sweepId: "test_sweep_i3" });
    expect(third.scanned).toBe(1);
    expect(third.backfilled).toBe(0);
    expect(third.skipped_idempotent).toBe(1);
    // No new audit events.
    expect(countEvents(db, "artifact_kind_backfilled", "i1")).toBe(1);
  });

  test("idempotency: rerunning the sweep on an uncertain row skips re-emit", async () => {
    // Regression test for live incident: 9536 emissions in 10 minutes
    // (~16/sec) from the worker re-processing the same ~2K uncertain
    // rows on every sweep. The uncertain path does NOT mutate
    // act_artifact.kind, so without an event-based idempotency probe
    // the rows stay in `WHERE kind='code_artifact'` and the worker
    // re-emits artifact_kind_inferred + artifact_kind_inference_uncertain
    // forever, saturating the event loop and starving the MCP server.
    const db = openDb(":memory:");
    insertRow(db, "uidem1", {
      // No name, opaque body → low-confidence → uncertain path.
      name: null,
      body: "noop",
      runtime: "bun",
      stateRoot: "test/legacy_default",
    });
    const first = await runArtifactKindBackfill(db, { sweepId: "uidem_sweep_1" });
    expect(first.scanned).toBe(1);
    expect(first.uncertain).toBe(1);
    expect(first.skipped_idempotent).toBe(0);
    expect(readKind(db, "uidem1")).toBe("code_artifact");
    expect(countEvents(db, "artifact_kind_inferred", "uidem1")).toBe(1);
    expect(countEvents(db, "artifact_kind_inference_uncertain", "uidem1")).toBe(1);

    // Second sweep: row.kind is still 'code_artifact' so it IS in the
    // scan set, but hasExistingInference must skip it before any emit.
    const second = await runArtifactKindBackfill(db, { sweepId: "uidem_sweep_2" });
    expect(second.scanned).toBe(1);
    expect(second.skipped_idempotent).toBe(1);
    expect(second.uncertain).toBe(0);
    expect(second.backfilled).toBe(0);
    // Crucially, NO new audit events on the second sweep.
    expect(countEvents(db, "artifact_kind_inferred", "uidem1")).toBe(1);
    expect(countEvents(db, "artifact_kind_inference_uncertain", "uidem1")).toBe(1);
  });

  test("dry-run mode does not mutate or emit", async () => {
    const db = openDb(":memory:");
    insertRow(db, "d1", {
      name: "dispatch_decider_v1",
      body: "// decider — picks a route",
      runtime: "bun",
    });
    const summary = await runArtifactKindBackfill(db, { dryRun: true, sweepId: "dry_sweep" });
    expect(summary.scanned).toBe(1);
    expect(summary.backfilled).toBe(1);
    expect(readKind(db, "d1")).toBe("code_artifact");
    expect(countEvents(db, "artifact_kind_backfilled", "d1")).toBe(0);
    expect(countEvents(db, "artifact_kind_inferred", "d1")).toBe(0);
  });
});
