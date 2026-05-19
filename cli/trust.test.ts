// acc trust tests — empty DB, seeded ledger, --json and --help paths.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../substrate/db";
import { gatherTrustMetrics, runTrust } from "./trust";

const captureStdout = (): { out: string[]; restore: () => void } => {
  const out: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  return { out, restore: () => { process.stdout.write = orig; } };
};

let dir = "";
let dbPath = "";
let prevDbPath: string | undefined;

const insertEvent = (db: import("bun:sqlite").Database, kind: string, payload: Record<string, unknown>): void => {
  db.run(
    `INSERT INTO events (id, ts, directive_id, task_id, loop_id, substrate_origin, kind, payload, context_refs)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [`evt_${kind}_${Math.random().toString(36).slice(2, 10)}`, new Date().toISOString(),
      "d_test", "t_test", "loop_test", "test", kind, JSON.stringify(payload), "[]"],
  );
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "acc2-trust-"));
  dbPath = join(dir, "trust.db");
  prevDbPath = process.env.ACC2_DB_PATH;
  process.env.ACC2_DB_PATH = dbPath;
});

afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  if (prevDbPath === undefined) delete process.env.ACC2_DB_PATH;
  else process.env.ACC2_DB_PATH = prevDbPath;
});

describe("acc trust", () => {
  test("empty DB yields all-zero metrics and returns 0", async () => {
    const cap = captureStdout();
    const code = await runTrust([]);
    cap.restore();
    expect(code).toBe(0);
    const text = cap.out.join("");
    expect(text).toContain("autonomy_score: 0.00");
    expect(text).toContain("extracted:        0");
    expect(text).toContain("replayed_success: 0");
    expect(text).toContain("(none)");
    expect(text).toContain("avg: 0.000");
    expect(text).toContain("applied: 0  failed: 0  refused: 0");
    expect(text).toContain("recommendation:");
  });

  test("seeded recipe + closure data yields non-zero counts", async () => {
    const db = openDb(dbPath);
    insertEvent(db, "owner_profile_recorded", { autonomy_score: 0.35 });
    // Recipe-shape knowledge rows replace the recipe-shape knowledge event family
    // (universality proposal A12CR1QCDN0SS51CM95K39T45M); recipe_shape.enabled
    // makes them visible to the recipe-shape filter the trust metric counts.
    insertEvent(db, "knowledge_candidate", { goal_shape: "g1", recipe_shape: { enabled: true } });
    insertEvent(db, "knowledge_candidate", { goal_shape: "g2", recipe_shape: { enabled: true } });
    insertEvent(db, "task_committed", { recipe_id: "r1", recipe_replayed: true });
    insertEvent(db, "action_scored", { recipe_id: "r2", replay_aborted: true });
    insertEvent(db, "knowledge_promoted", { knowledge_id: "k1" });
    insertEvent(db, "knowledge_demoted", { knowledge_id: "k2" });
    insertEvent(db, "act_artifact_promoted", { artifact_id: "art_xyz", summary: "useful" });
    insertEvent(db, "task_closure_audited", { closure_residual: 0.4 });
    insertEvent(db, "task_closure_audited", { closure_residual: 0.6 });

    const m = gatherTrustMetrics(db);
    expect(m.autonomy_score).toBe(0.35);
    expect(m.recipes_extracted).toBe(2);
    expect(m.recipes_replayed_success).toBe(1);
    expect(m.recipes_replayed_aborted).toBe(1);
    expect(m.knowledge_promoted_7d).toBe(1);
    expect(m.knowledge_demoted_7d).toBe(1);
    expect(m.artifacts_promoted_recent[0]?.artifact_id).toBe("art_xyz");
    expect(m.closure_residual_7d.count).toBe(2);
    expect(m.closure_residual_7d.avg).toBeCloseTo(0.5, 5);
    expect(m.closure_residual_7d.min).toBe(0.4);
    expect(m.closure_residual_7d.max).toBe(0.6);

    const cap = captureStdout();
    const code = await runTrust([]);
    cap.restore();
    expect(code).toBe(0);
    expect(cap.out.join("")).toContain("autonomy_score: 0.35");
    expect(cap.out.join("")).toContain("art_xyz");
  });

  test("--json prints parseable JSON with expected keys", async () => {
    const db = openDb(dbPath);
    insertEvent(db, "owner_profile_recorded", { autonomy_score: 0.5 });
    insertEvent(db, "knowledge_candidate", { recipe_shape: { enabled: true } });

    const cap = captureStdout();
    const code = await runTrust(["--json"]);
    cap.restore();
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.out.join("").trim()) as Record<string, unknown>;
    for (const key of [
      "autonomy_score", "recipes_extracted", "recipes_replayed_success",
      "recipes_replayed_aborted", "knowledge_promoted_7d", "knowledge_demoted_7d",
      "artifacts_promoted_recent", "closure_residual_7d", "amendments_7d", "recommendation",
    ]) expect(parsed[key]).toBeDefined();
    expect(parsed.autonomy_score).toBe(0.5);
    expect(parsed.recipes_extracted).toBe(1);
  });

  test("--help returns 0 and prints usage", async () => {
    const cap = captureStdout();
    const code = await runTrust(["--help"]);
    cap.restore();
    expect(code).toBe(0);
    const text = cap.out.join("");
    expect(text).toContain("acc trust");
    expect(text).toContain("--json");
  });

  test("high-trust seed yields healthy recommendation", async () => {
    const db = openDb(dbPath);
    insertEvent(db, "owner_profile_recorded", { autonomy_score: 0.8 });
    insertEvent(db, "task_closure_audited", { closure_residual: 0.1 });
    insertEvent(db, "task_closure_audited", { closure_residual: 0.1 });
    insertEvent(db, "contract_amendment_applied", { status: "applied" });
    insertEvent(db, "contract_amendment_applied", { status: "applied" });
    insertEvent(db, "contract_amendment_applied", { status: "applied" });
    insertEvent(db, "contract_amendment_applied", { status: "failed" });
    const m = gatherTrustMetrics(db);
    expect(m.amendments_7d.applied).toBe(3);
    expect(m.amendments_7d.failed).toBe(1);
    expect(m.recommendation).toContain("trust looks healthy");
    expect(m.recommendation).toContain("father --max-cycles");
  });

  test("mixed-signal seed yields cautionary recommendation", async () => {
    const db = openDb(dbPath);
    insertEvent(db, "owner_profile_recorded", { autonomy_score: 0.4 });
    insertEvent(db, "task_closure_audited", { closure_residual: 0.5 });
    insertEvent(db, "contract_amendment_applied", { status: "failed" });
    insertEvent(db, "contract_amendment_applied", { status: "failed" });
    expect(gatherTrustMetrics(db).recommendation).toContain("trust mixed");
  });
});
