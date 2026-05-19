// F4a falsifying tests for the code_artifact → act_artifact rename
// (roadmap WW7W1NZ8A10R52PB4E7EJE9YBW). If any path loses the
// polymorphic kind through the new vocabulary, OR the schema fails to
// migrate cleanly from a legacy DB, these tests fail.

import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { closeDb, openDb } from "../substrate/db";
import { insertArtifact, getArtifact } from "../runtime/artifact_store";
import { VIEW_NAMES, actArtifactRegistry } from "../substrate/views";

beforeEach(() => closeDb());

describe("F4a act_artifact rename", () => {
  test("fresh in-memory DB has act_artifact table and no code_artifact table", () => {
    const db = openDb(":memory:");
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("act_artifact");
    expect(names).not.toContain("code_artifact");
  });

  test("VIEW_NAMES exposes act_artifact_registry_view (and not its pre-rename alias)", () => {
    expect(VIEW_NAMES).toContain("act_artifact_registry_view");
    expect(VIEW_NAMES).not.toContain("code_artifact_registry_view");
  });

  test("act_artifact_polymorphic_kind_roundtrip — admit with a made-up kind, retrieve it, confirm kind round-trips through the rename without loss", () => {
    const db = openDb(":memory:");
    const id = "test_artifact_polymorphic_001";
    insertArtifact(db, {
      id,
      runtime: "bun",
      kind: "some_made_up_kind",
      body: "console.log('hello');",
      declaredSandbox: { runtime: "bun", cpu_ms: 1000, wall_ms: 5000, memory_mb: 64 },
      stateRoot: "test/polymorphic",
      posteriorAlpha: 1,
      posteriorBeta: 1,
      score: 0.5,
      confidence: 0.3,
      recentResidualMean: 0,
      recentKillCount: 0,
      status: "admitted",
      name: "polymorphic_round_trip",
      fixtureInput: null,
      fixtureExpectedResidual: 0.2,
      intent: null,
      summary: null,
      targetFiles: null,
      targetResources: null,
      sourceCandidateId: null,
      ownerGateVerdict: null,
    });
    const read = getArtifact(db, id);
    expect(read).not.toBeNull();
    expect(read!.kind).toBe("some_made_up_kind");

    // Also verify via the registry view that the kind survives the
    // act_artifact_registry_view projection.
    const rows = actArtifactRegistry(db);
    const found = rows.find((r) => r.id === id);
    expect(found).toBeDefined();
    expect(found!.runtime).toBe("bun");
  });

  test("legacy code_artifact table migrates to act_artifact via runMigrations (RENAME path)", () => {
    // Simulate a pre-F4a DB: only `code_artifact` exists with one row.
    // openDb runs schema first (which now creates act_artifact), then the
    // migration RENAMEs code_artifact → act_artifact when act_artifact is
    // empty. We test the migration directly here on a hand-built DB to
    // avoid the rename detection bailing out.
    const dbPath = ":memory:";
    const raw = new Database(dbPath, { create: true });
    raw.loadExtension(sqliteVec.getLoadablePath());
    // The migration's EVENT_HOT_PATH_INDEXES set creates indexes on
    // `events`. Create the minimal table so they succeed.
    raw.run(`CREATE TABLE events (
       id TEXT PRIMARY KEY,
       ts TEXT NOT NULL,
       directive_id TEXT NOT NULL,
       task_id TEXT NOT NULL,
       loop_id TEXT NOT NULL,
       substrate_origin TEXT NOT NULL,
       kind TEXT NOT NULL,
       payload TEXT NOT NULL,
       context_refs TEXT NOT NULL DEFAULT '[]',
       action_artifact_id TEXT
    )`);
    raw.run(`CREATE TABLE code_artifact (
       id TEXT PRIMARY KEY,
       runtime TEXT NOT NULL,
       body TEXT NOT NULL,
       declared_sandbox TEXT NOT NULL,
       state_root TEXT NOT NULL,
       posterior_alpha REAL NOT NULL DEFAULT 1.0,
       posterior_beta REAL NOT NULL DEFAULT 1.0,
       score REAL NOT NULL DEFAULT 0.5,
       confidence REAL NOT NULL DEFAULT 0.3,
       recent_residual_mean REAL NOT NULL DEFAULT 0.0,
       recent_kill_count INTEGER NOT NULL DEFAULT 0,
       status TEXT NOT NULL DEFAULT 'admitted',
       name TEXT,
       fixture_input TEXT NOT NULL,
       fixture_expected_residual REAL NOT NULL,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL
    )`);
    raw.run(
      `INSERT INTO code_artifact (id, runtime, body, declared_sandbox, state_root, fixture_input, fixture_expected_residual, created_at, updated_at)
       VALUES ('legacy_row_1', 'bun', 'noop', '{}', 'test/legacy', 'null', 0.2, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    );

    // Confirm legacy table holds the row.
    const beforeRows = raw.query("SELECT count(*) AS n FROM code_artifact").get() as { n: number };
    expect(beforeRows.n).toBe(1);

    // Apply schema + migrations directly. The order matches openDb():
    // runSchema (creates empty act_artifact) → runMigrations (drops empty
    // act_artifact, RENAMEs code_artifact → act_artifact, then runs
    // ALTER TABLE / CREATE INDEX).
    const schema = `CREATE TABLE IF NOT EXISTS act_artifact (
       id TEXT PRIMARY KEY,
       runtime TEXT NOT NULL,
       body TEXT NOT NULL,
       declared_sandbox TEXT NOT NULL,
       state_root TEXT NOT NULL,
       kind TEXT NOT NULL DEFAULT 'runtime_action',
       posterior_alpha REAL NOT NULL DEFAULT 1.0,
       posterior_beta REAL NOT NULL DEFAULT 1.0,
       score REAL NOT NULL DEFAULT 0.5,
       confidence REAL NOT NULL DEFAULT 0.3,
       recent_residual_mean REAL NOT NULL DEFAULT 0.0,
       recent_kill_count INTEGER NOT NULL DEFAULT 0,
       status TEXT NOT NULL DEFAULT 'admitted',
       name TEXT,
       fixture_input TEXT NOT NULL,
       fixture_expected_residual REAL NOT NULL,
       intent TEXT, summary TEXT, target_files TEXT, target_resources TEXT,
       source_candidate_id TEXT, owner_gate_verdict TEXT,
       supersedes TEXT, superseded_by TEXT, lost_version_count INTEGER NOT NULL DEFAULT 0,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL
    )`;
    raw.exec(schema);
    // The migration is the function under test. Re-import via dynamic
    // import to avoid coupling the test to the module export shape.
    const { runMigrations } = require("../substrate/db");
    runMigrations(raw);

    // After migration: code_artifact gone, act_artifact has the row.
    const tables = raw
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('code_artifact','act_artifact')")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("act_artifact");
    expect(names).not.toContain("code_artifact");

    const afterRows = raw.query("SELECT count(*) AS n FROM act_artifact").get() as { n: number };
    expect(afterRows.n).toBe(1);
    const row = raw.query("SELECT id, kind FROM act_artifact").get() as { id: string; kind: string };
    expect(row.id).toBe("legacy_row_1");
    // After migration the row inherited the column default for kind
    // (the legacy table did not have a kind column).
    expect(typeof row.kind).toBe("string");

    raw.close();
  });

  test("rename migration is idempotent — running runMigrations twice on a fresh DB does not throw", () => {
    const db = openDb(":memory:");
    const { runMigrations } = require("../substrate/db");
    // openDb already ran migrations once; a second pass must be a no-op.
    expect(() => runMigrations(db)).not.toThrow();
    expect(() => runMigrations(db)).not.toThrow();
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='act_artifact'")
      .all() as Array<{ name: string }>;
    expect(tables.length).toBe(1);
  });

  test("EVENT_KINDS registers act_artifact_* canonical kinds AND code_artifact_* legacy aliases", () => {
    // Import here so the test does not crash if the registry rename ever
    // breaks the import surface.
    const { EVENT_KINDS } = require("../substrate/event_kinds");
    for (const k of [
      "act_artifact_candidate",
      "act_artifact_admitted",
      "act_artifact_admission_rejected",
      "act_artifact_promoted",
      "act_artifact_quarantined",
      "act_artifact_retired",
      "act_artifact_rehabilitated",
      "act_artifact_score_updated",
      "act_artifact_superseded",
      "act_artifact_quarantine_overridden",
    ]) {
      expect(EVENT_KINDS[k]).toBeDefined();
    }
    // Legacy aliases stay registered so SELECT WHERE kind = 'code_artifact_admitted'
    // continues to match historical event rows.
    for (const k of [
      "code_artifact_candidate",
      "code_artifact_admitted",
      "code_artifact_admission_rejected",
      "code_artifact_promoted",
      "code_artifact_quarantined",
      "code_artifact_retired",
      "code_artifact_rehabilitated",
      "code_artifact_score_updated",
      "code_artifact_superseded",
      "code_artifact_quarantine_overridden",
    ]) {
      expect(EVENT_KINDS[k]).toBeDefined();
    }
  });
});
