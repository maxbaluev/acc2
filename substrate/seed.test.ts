// acc2 substrate seed tests — proves the seed entrypoints are
// idempotent and respect the owner-approval gate for foundational
// knowledge.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "./db";
import {
  seedArtifactIds,
  seedCodeArtifacts,
  seedFoundationalKnowledge,
  seedRecipeGoalTexts,
  seedRecipes,
} from "./seed";
import { goalShape } from "../runtime/goal_shape";

afterAll(() => closeDb());
beforeEach(() => closeDb());

describe("seedCodeArtifacts", () => {
  test("inserts every seed artifact on first run", () => {
    const db = openDb(":memory:");
    const summary = seedCodeArtifacts(db);
    expect(summary.inserted).toBeGreaterThanOrEqual(8);
    expect(summary.skipped).toBe(0);

    const rows = db.query("SELECT id, runtime, status, name FROM code_artifact ORDER BY id").all() as Array<{
      id: string;
      runtime: string;
      status: string;
      name: string | null;
    }>;
    const ids = rows.map((r) => r.id);
    for (const expectedId of seedArtifactIds()) {
      expect(ids).toContain(expectedId);
    }
    // Every seed starts at status 'admitted'.
    for (const r of rows) expect(r.status).toBe("admitted");
  });

  test("idempotent — running twice does not duplicate", () => {
    const db = openDb(":memory:");
    const first = seedCodeArtifacts(db);
    const second = seedCodeArtifacts(db);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(first.inserted);
    const count = (db.query("SELECT COUNT(*) AS c FROM code_artifact").get() as { c: number }).c;
    expect(count).toBe(first.inserted);
  });

  test("seed ids use the stable seed_<name> prefix", () => {
    const db = openDb(":memory:");
    seedCodeArtifacts(db);
    const ids = (db.query("SELECT id FROM code_artifact").all() as Array<{ id: string }>).map((r) => r.id);
    for (const id of ids) {
      expect(id.startsWith("seed_")).toBe(true);
    }
  });

  test("every admitted seed artifact has a non-stub body (Batch 3.CLEANUP)", () => {
    // The audit flagged three seed artifacts (substrate_embed, substrate_search,
    // agent_invoke) whose bodies were literally "// stub Phase B+: …" — they
    // admitted at install time but would emit `result_marker_missing` if the
    // brain ever picked them. Batch 3.CLEANUP resolves by giving substrate_embed
    // a real OpenAI embedding fetch body and removing the two seeds that
    // overlap with v2's MCP tool surface (substrate.search) / opencode-only
    // dispatch model (no sub-agent invocation).
    const db = openDb(":memory:");
    seedCodeArtifacts(db);
    const rows = db.query("SELECT id, body FROM code_artifact").all() as Array<{
      id: string;
      body: string;
    }>;
    for (const r of rows) {
      expect(r.body.includes("stub Phase B+")).toBe(false);
      expect(r.body.includes("will be authored per LATM")).toBe(false);
      // Real-body invariant: the script either invokes Bun/fetch/process or
      // wraps the camofox session facade. A body that is ONLY a comment block
      // would fail this — every seed must do something observable.
      expect(r.body.length).toBeGreaterThan(40);
    }
  });

  test("L8 (2026-05-17) kind column: dispatch_strategy seeds carry kind='dispatch_strategy_v1', legacy seeds default to 'code_artifact'", () => {
    const db = openDb(":memory:");
    seedCodeArtifacts(db);
    const strategyRows = db
      .query("SELECT id, kind FROM code_artifact WHERE state_root = 'dispatch/strategy'")
      .all() as Array<{ id: string; kind: string }>;
    expect(strategyRows.length).toBe(6);
    for (const r of strategyRows) expect(r.kind).toBe("dispatch_strategy_v1");
    // Legacy seeds: every other admitted row should have kind='code_artifact'.
    const legacyRows = db
      .query("SELECT kind FROM code_artifact WHERE state_root != 'dispatch/strategy'")
      .all() as Array<{ kind: string }>;
    expect(legacyRows.length).toBeGreaterThan(0);
    for (const r of legacyRows) expect(r.kind).toBe("code_artifact");
  });

  test("includes every runtime named in §11.4", () => {
    const db = openDb(":memory:");
    seedCodeArtifacts(db);
    const runtimes = new Set(
      (db.query("SELECT DISTINCT runtime FROM code_artifact").all() as Array<{ runtime: string }>).map((r) => r.runtime),
    );
    expect(runtimes.has("bun")).toBe(true);
    expect(runtimes.has("uv")).toBe(true);
    expect(runtimes.has("camofox-browser")).toBe(true);
  });

  test("seed_web_fetch_and_parse body carries the missing-url fast-fail guard", () => {
    // Repro for the historical brittleness: when the brain admits a refinement
    // step that drops `url` from inputs, the seed used to call Bun.fetch(undefined)
    // and surface `ERR_INVALID_URL: blank string` as the artifact error. The
    // canonical shape is a structured @@RESULT@@ payload with
    // `{ ok: false, error: "missing_input_url" }` so the verifier (and the
    // operator-facing event stream) sees a clean failure mode, not a stack
    // trace. We check the body source rather than spawn a subprocess here so
    // the unit suite stays parallel-safe — the spawn-side execution path is
    // already covered by runBunArtifact tests.
    const db = openDb(":memory:");
    seedCodeArtifacts(db);
    const row = db
      .query("SELECT body FROM code_artifact WHERE id = ?")
      .get("seed_web_fetch_and_parse") as { body: string } | null;
    expect(row).not.toBeNull();
    if (!row) return;
    const body = row.body;
    // The body declares the fast-fail before any fetch call so a missing url
    // exits at the guard with a canonical structured error, never reaching
    // Bun.fetch(undefined).
    expect(body).toContain("missing_input_url");
    expect(body).toContain("typeof inputs.url === 'string'");
    expect(body).toContain("url.length === 0");
    // Guard precedes the fetch — defensive ordering.
    const guardIdx = body.indexOf("missing_input_url");
    const fetchIdx = body.indexOf("await fetch(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(fetchIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(fetchIdx);
  });

  test("seed_browser_session_act drives the new session.* facade (Batch 1.α)", () => {
    const db = openDb(":memory:");
    seedCodeArtifacts(db);
    const row = db
      .query("SELECT body, declared_sandbox FROM code_artifact WHERE id = ?")
      .get("seed_browser_session_act") as { body: string; declared_sandbox: string } | null;
    expect(row).not.toBeNull();
    if (!row) return;
    // Body uses the wrapper's session facade (goto / text / url), not raw
    // playwright / chromium identifiers — the body is wrapper-agnostic.
    expect(row.body).toContain("session.goto");
    expect(row.body).toContain("session.text");
    expect(row.body).toContain("session.url");
    expect(row.body).not.toContain("chromium");
    expect(row.body).not.toContain("playwright");
    // Declared sandbox carries the Batch 1.α fingerprint hints.
    const decl = JSON.parse(row.declared_sandbox) as Record<string, unknown>;
    expect(decl.fingerprint_os).toBe("linux");
    expect(decl.fingerprint_locale).toBe("en-US");
    expect(decl.headless).toBe(true);
  });
});

describe("seedFoundationalKnowledge", () => {
  test("no-ops when ownerApproved is false (default)", () => {
    const db = openDb(":memory:");
    const summary = seedFoundationalKnowledge(db, { ownerApproved: false });
    expect(summary.imported).toBe(0);
    const count = (db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind='knowledge_candidate'")
      .get() as { c: number }).c;
    expect(count).toBe(0);
  });

  test("no-ops when options is undefined", () => {
    const db = openDb(":memory:");
    const summary = seedFoundationalKnowledge(db);
    expect(summary.imported).toBe(0);
  });

  test("inserts on first run when ownerApproved is true; no-ops on second", () => {
    const db = openDb(":memory:");
    const first = seedFoundationalKnowledge(db, { ownerApproved: true });
    expect(first.imported).toBeGreaterThan(0);

    const candidateCount = (db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind='knowledge_candidate'")
      .get() as { c: number }).c;
    const promoteCount = (db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind='knowledge_promoted'")
      .get() as { c: number }).c;
    expect(candidateCount).toBe(first.imported);
    expect(promoteCount).toBe(first.imported);

    const second = seedFoundationalKnowledge(db, { ownerApproved: true });
    expect(second.imported).toBe(0);

    // Counts unchanged after second call.
    const candidateCount2 = (db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind='knowledge_candidate'")
      .get() as { c: number }).c;
    expect(candidateCount2).toBe(candidateCount);
  });

  test("per-row hash gate (2026-05-17): legacy install with batch-meta key admits NEW laws on second run", () => {
    const db = openDb(":memory:");
    // Simulate a legacy install: the batch-level meta key was written
    // by an older seedFoundationalKnowledge BEFORE per-row hashing
    // existed. The legacy install would skip every law on the next run
    // (the bug 5JE82MP9TN1ZB3T1DPSYWK614G names).
    db.run("INSERT INTO meta(key, value) VALUES(?, ?)", ["seed:foundational_knowledge", "2025-12-01T00:00:00Z"]);
    db.run("INSERT INTO meta(key, value) VALUES(?, ?)", ["seed:policy_bundles:v1", "2025-12-01T00:00:00Z"]);
    // First post-fix run: the gate retroactively records every current
    // law's hash but imports nothing (legacy claim: "you already had
    // these"). knowledge_candidate count stays at 0 because the legacy
    // install ALSO didn't have the original candidate rows on disk —
    // but the hashes ARE recorded so the next-run upgrade flow has a
    // clean baseline.
    const first = seedFoundationalKnowledge(db, { ownerApproved: true });
    expect(first.imported).toBe(0);
    const hashCount1 = (db.query("SELECT COUNT(*) AS c FROM meta WHERE key LIKE 'seed:law:%' OR key LIKE 'seed:bundle:%'").get() as { c: number }).c;
    expect(hashCount1).toBeGreaterThan(0);

    // Now simulate a NEW law landing in source: pretend we removed one
    // of the recorded hashes (= a new law would appear with a new hash
    // the legacy install hasn't seen). Re-run and confirm at least one
    // law gets imported.
    const oneKey = (db.query("SELECT key FROM meta WHERE key LIKE 'seed:law:%' LIMIT 1").get() as { key: string }).key;
    db.run("DELETE FROM meta WHERE key = ?", [oneKey]);
    const second = seedFoundationalKnowledge(db, { ownerApproved: true });
    expect(second.imported).toBe(1);

    // Idempotent re-run after that: nothing new lands.
    const third = seedFoundationalKnowledge(db, { ownerApproved: true });
    expect(third.imported).toBe(0);
  });

  test("per-row hash gate: fresh install imports every current law + bundle on first run, zero on re-run", () => {
    const db = openDb(":memory:");
    const first = seedFoundationalKnowledge(db, { ownerApproved: true });
    expect(first.imported).toBeGreaterThan(0);
    const hashCount = (db.query("SELECT COUNT(*) AS c FROM meta WHERE key LIKE 'seed:law:%' OR key LIKE 'seed:bundle:%'").get() as { c: number }).c;
    expect(hashCount).toBe(first.imported);
    // Second run is a no-op.
    const second = seedFoundationalKnowledge(db, { ownerApproved: true });
    expect(second.imported).toBe(0);
  });

  test("every seeded knowledge event carries substrate_origin='substrate_auto'", () => {
    const db = openDb(":memory:");
    seedFoundationalKnowledge(db, { ownerApproved: true });
    const origins = new Set(
      (db
        .query(
          "SELECT DISTINCT substrate_origin FROM events WHERE kind IN ('knowledge_candidate','knowledge_promoted')",
        )
        .all() as Array<{ substrate_origin: string }>).map((r) => r.substrate_origin),
    );
    expect(origins.size).toBe(1);
    expect(origins.has("substrate_auto")).toBe(true);
  });

  test("each promoted event cites its candidate via context_refs", () => {
    const db = openDb(":memory:");
    seedFoundationalKnowledge(db, { ownerApproved: true });
    const promotions = db
      .query(
        "SELECT context_refs, payload FROM events WHERE kind = 'knowledge_promoted'",
      )
      .all() as Array<{ context_refs: string; payload: string }>;
    for (const p of promotions) {
      const refs = JSON.parse(p.context_refs) as string[];
      const payload = JSON.parse(p.payload) as { candidate_id?: string };
      expect(refs.length).toBe(1);
      expect(payload.candidate_id).toBeDefined();
      expect(refs[0]).toBe(payload.candidate_id);
    }
  });

  test("seeds typed brain prompt policy bundles", () => {
    const db = openDb(":memory:");
    seedFoundationalKnowledge(db, { ownerApproved: true });
    const rows = db
      .query("SELECT payload FROM events WHERE kind = 'knowledge_promoted' AND json_extract(payload, '$.type') = 'policy_bundle'")
      .all() as Array<{ payload: string }>;
    const sections = rows.map((r) => JSON.parse(r.payload) as { surface?: string; section_name?: string; body?: string });
    expect(sections.some((p) => p.surface === "brain_prompt" && p.section_name === "exit_invariant" && p.body?.includes("MUST invoke at least one substrate.* tool call before exit"))).toBe(true);
    expect(sections.some((p) => p.surface === "brain_prompt" && p.section_name === "runtimes_available" && p.body?.includes("camofox-browser"))).toBe(true);
    expect(sections.some((p) => p.surface === "brain_prompt" && p.section_name === "workflow" && p.body?.includes("CONSTANT ACT-LOOP METADATA"))).toBe(true);
    expect(sections.some((p) => p.surface === "brain_prompt" && p.section_name === "do_not" && p.body?.includes("Exit having produced only conversational text"))).toBe(true);
    expect(sections.some((p) => p.surface === "brain_prompt" && p.section_name === "emission_grammars" && p.body?.includes("declared_sandbox"))).toBe(true);
  });

  test("seeds moved contract knowledge with prompt-composer goal-shape tags on promotion rows", () => {
    const db = openDb(":memory:");
    seedFoundationalKnowledge(db, { ownerApproved: true });
    const rows = db
      .query("SELECT payload FROM events WHERE kind = 'knowledge_promoted'")
      .all() as Array<{ payload: string }>;
    const tagged = rows
      .map((r) => JSON.parse(r.payload) as { goal_shape_tags?: string[] })
      .filter((p) => Array.isArray(p.goal_shape_tags) && p.goal_shape_tags.includes("contract") && p.goal_shape_tags.includes("composer"));
    expect(tagged.length).toBeGreaterThan(0);
  });
});

describe("seedRecipes", () => {
  test("inserts one recipe_extracted row per canonical goal shape", () => {
    const db = openDb(":memory:");
    seedCodeArtifacts(db);
    const summary = seedRecipes(db);
    expect(summary.count).toBeGreaterThan(0);
    expect(summary.count).toBe(seedRecipeGoalTexts().length);

    const rows = db
      .query("SELECT payload FROM events WHERE kind = 'recipe_extracted'")
      .all() as Array<{ payload: string }>;
    expect(rows.length).toBe(summary.count);

    const goalShapesSeeded = new Set(rows.map((r) => {
      const p = JSON.parse(r.payload) as { goal_shape: string };
      return p.goal_shape;
    }));
    for (const text of seedRecipeGoalTexts()) {
      expect(goalShapesSeeded.has(goalShape(text))).toBe(true);
    }
  });

  test("idempotent — re-running does not duplicate rows", () => {
    const db = openDb(":memory:");
    seedCodeArtifacts(db);
    const first = seedRecipes(db);
    const second = seedRecipes(db);
    expect(second.count).toBe(0);
    const total = (db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'recipe_extracted'")
      .get() as { c: number }).c;
    expect(total).toBe(first.count);
  });

  test("each recipe references real seed artifact ids", () => {
    const db = openDb(":memory:");
    seedCodeArtifacts(db);
    seedRecipes(db);
    const validIds = new Set(seedArtifactIds());
    const rows = db
      .query("SELECT payload FROM events WHERE kind = 'recipe_extracted'")
      .all() as Array<{ payload: string }>;
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as {
        trajectory: Array<{ artifact_id: string }>;
      };
      expect(payload.trajectory.length).toBeGreaterThan(0);
      for (const step of payload.trajectory) {
        expect(validIds.has(step.artifact_id)).toBe(true);
      }
    }
  });

  test("recipes seed at confidence=0.7 (above replay threshold, below promoted)", () => {
    const db = openDb(":memory:");
    seedCodeArtifacts(db);
    seedRecipes(db);
    const rows = db
      .query("SELECT payload FROM events WHERE kind = 'recipe_extracted'")
      .all() as Array<{ payload: string }>;
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as { confidence: number; seeded: boolean };
      expect(payload.confidence).toBe(0.7);
      expect(payload.seeded).toBe(true);
    }
  });

  test("after seedFoundationalKnowledge + seedCodeArtifacts + seedRecipes the substrate is populated", () => {
    const db = openDb(":memory:");
    seedFoundationalKnowledge(db, { ownerApproved: true });
    seedCodeArtifacts(db);
    const recipeSummary = seedRecipes(db);

    const knowledgeCandidates = (db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'knowledge_candidate'")
      .get() as { c: number }).c;
    expect(knowledgeCandidates).toBeGreaterThan(0);

    const artifactCount = (db
      .query("SELECT COUNT(*) AS c FROM code_artifact").get() as { c: number }).c;
    expect(artifactCount).toBeGreaterThan(0);

    const recipeRows = db
      .query("SELECT payload FROM events WHERE kind = 'recipe_extracted'")
      .all() as Array<{ payload: string }>;
    expect(recipeRows.length).toBe(recipeSummary.count);
    // Every recipe row's trajectory must point at a real artifact id.
    const artifactIds = new Set(seedArtifactIds());
    for (const r of recipeRows) {
      const payload = JSON.parse(r.payload) as {
        trajectory: Array<{ artifact_id: string }>;
      };
      for (const step of payload.trajectory) {
        expect(artifactIds.has(step.artifact_id)).toBe(true);
      }
    }
  });
});

describe("seedDemoKnowledge", () => {
  test("no-ops when ownerApproved is false (default)", () => {
    const { seedDemoKnowledge } = require("./seed");
    const db = openDb(":memory:");
    const r = seedDemoKnowledge(db);
    expect(r.imported).toBe(0);
    expect((db.query("SELECT COUNT(*) AS c FROM events WHERE kind='knowledge_candidate'").get() as { c: number }).c).toBe(0);
  });

  test("seeds each demo as a knowledge_candidate + knowledge_promoted pair when approved", () => {
    const { seedDemoKnowledge, DEMO_CAPABILITIES } = require("./seed");
    const db = openDb(":memory:");
    const r = seedDemoKnowledge(db, { ownerApproved: true });
    expect(r.imported).toBe(DEMO_CAPABILITIES.length);

    const candidates = (db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind='knowledge_candidate'")
      .get() as { c: number }).c;
    expect(candidates).toBe(DEMO_CAPABILITIES.length);

    const promoted = (db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind='knowledge_promoted'")
      .get() as { c: number }).c;
    expect(promoted).toBe(DEMO_CAPABILITIES.length);
  });

  test("idempotent — second call on same db imports nothing", () => {
    const { seedDemoKnowledge } = require("./seed");
    const db = openDb(":memory:");
    seedDemoKnowledge(db, { ownerApproved: true });
    const r2 = seedDemoKnowledge(db, { ownerApproved: true });
    expect(r2.imported).toBe(0);
  });

  test("each candidate's claim equals its first_demo_prompt — the text that gets embedded", () => {
    const { seedDemoKnowledge, DEMO_CAPABILITIES } = require("./seed");
    const db = openDb(":memory:");
    seedDemoKnowledge(db, { ownerApproved: true });
    const rows = db
      .query("SELECT payload FROM events WHERE kind='knowledge_candidate' ORDER BY rowid ASC")
      .all() as Array<{ payload: string }>;
    expect(rows.length).toBe(DEMO_CAPABILITIES.length);
    for (let i = 0; i < rows.length; i++) {
      const payload = JSON.parse(rows[i]!.payload) as Record<string, unknown>;
      expect(payload.claim).toBe(DEMO_CAPABILITIES[i]!.first_demo_prompt);
      expect((payload.tags as string[]).includes("demo")).toBe(true);
      expect(payload.demo_recipe_id).toBe(DEMO_CAPABILITIES[i]!.demo_recipe_id);
    }
  });

  test("promoted events cite their candidate via context_refs", () => {
    const { seedDemoKnowledge } = require("./seed");
    const db = openDb(":memory:");
    seedDemoKnowledge(db, { ownerApproved: true });
    const promoted = db
      .query("SELECT context_refs FROM events WHERE kind='knowledge_promoted'")
      .all() as Array<{ context_refs: string }>;
    for (const r of promoted) {
      const refs = JSON.parse(r.context_refs) as string[];
      expect(refs.length).toBe(1);
    }
  });
});
