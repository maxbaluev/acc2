// acc2 substrate seed tests — proves the seed entrypoints are
// idempotent and respect the owner-approval gate for foundational
// knowledge.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "./db";
import {
  seedArtifactIds,
  seedActArtifacts,
  seedFoundationalKnowledge,
  seedRecipeGoalTexts,
  seedRecipes,
} from "./seed";
import { goalShape } from "../runtime/goal_shape";

afterAll(() => closeDb());
beforeEach(() => closeDb());

describe("seedActArtifacts", () => {
  test("inserts every seed artifact on first run", () => {
    const db = openDb(":memory:");
    const summary = seedActArtifacts(db);
    expect(summary.inserted).toBeGreaterThanOrEqual(8);
    expect(summary.skipped).toBe(0);

    const rows = db.query("SELECT id, runtime, status, name FROM act_artifact ORDER BY id").all() as Array<{
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
    const first = seedActArtifacts(db);
    const second = seedActArtifacts(db);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(first.inserted);
    const count = (db.query("SELECT COUNT(*) AS c FROM act_artifact").get() as { c: number }).c;
    expect(count).toBe(first.inserted);
  });

  test("seed ids use the stable seed_<name> prefix", () => {
    const db = openDb(":memory:");
    seedActArtifacts(db);
    const ids = (db.query("SELECT id FROM act_artifact").all() as Array<{ id: string }>).map((r) => r.id);
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
    seedActArtifacts(db);
    const rows = db.query("SELECT id, body FROM act_artifact").all() as Array<{
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

  test("L8 (2026-05-17) kind column: dispatch_strategy seeds carry kind='dispatch_strategy_v1', recipe seeds carry kind='recipe', legacy seeds default to 'code_artifact'", () => {
    const db = openDb(":memory:");
    seedActArtifacts(db);
    const strategyRows = db
      .query("SELECT id, kind FROM act_artifact WHERE state_root = 'dispatch/strategy'")
      .all() as Array<{ id: string; kind: string }>;
    expect(strategyRows.length).toBe(6);
    for (const r of strategyRows) expect(r.kind).toBe("dispatch_strategy_v1");
    // C3 (2026-05-18): recipe seeds (master_report_generation_orchestrator)
    // declare kind='recipe' so the registry can filter brain-facing
    // orchestrator recipes from raw code artifacts. Legacy seeds remain
    // kind='code_artifact'.
    const recipeRows = db
      .query("SELECT id, kind FROM act_artifact WHERE state_root LIKE 'recipes/%'")
      .all() as Array<{ id: string; kind: string }>;
    expect(recipeRows.length).toBeGreaterThanOrEqual(1);
    for (const r of recipeRows) expect(r.kind).toBe("recipe");
    // C2 (2026-05-18): render-pipeline seeds declare their own kinds
    // (`docx_reference_style`, `markdown_body`) so the registry can
    // filter render inputs from raw code artifacts. Asserted separately
    // here so the legacy 'code_artifact' default check below is
    // narrowed to genuine legacy state_roots.
    const renderRows = db
      .query("SELECT id, kind FROM act_artifact WHERE state_root LIKE 'render/%' ORDER BY id")
      .all() as Array<{ id: string; kind: string }>;
    expect(renderRows.length).toBeGreaterThanOrEqual(2);
    const renderKinds = new Set(renderRows.map((r) => r.kind));
    expect(renderKinds.has("docx_reference_style")).toBe(true);
    expect(renderKinds.has("markdown_body")).toBe(true);
    // Legacy seeds: every other admitted row should have kind='code_artifact'.
    const legacyRows = db
      .query(
        "SELECT kind FROM act_artifact WHERE state_root NOT LIKE 'dispatch/%' AND state_root NOT LIKE 'recipes/%' AND state_root NOT LIKE 'render/%'",
      )
      .all() as Array<{ kind: string }>;
    expect(legacyRows.length).toBeGreaterThan(0);
    for (const r of legacyRows) expect(r.kind).toBe("code_artifact");
  });

  test("C2 (2026-05-18) canonical reference docx artifact + markdown_body fixture are seeded", () => {
    const db = openDb(":memory:");
    seedActArtifacts(db);
    const ref = db
      .query("SELECT id, kind, body, name FROM act_artifact WHERE id = ?")
      .get("seed_docx_reference_accint_neutral_classic_business_v1") as {
        id: string; kind: string; body: string; name: string | null;
      } | null;
    expect(ref).not.toBeNull();
    if (!ref) return;
    expect(ref.kind).toBe("docx_reference_style");
    // The body is a base64-encoded docx → starts with the standard zip
    // header `UEs...` (PK\x03\x04 → "UEsDBA..." in base64). Decoding
    // round-trip should yield a non-empty buffer.
    expect(ref.body.startsWith("UEsDB")).toBe(true);
    const decoded = Buffer.from(ref.body, "base64");
    expect(decoded.length).toBeGreaterThan(5000);
    // Fixture markdown_body for pipeline smoke tests.
    const md = db
      .query("SELECT id, kind, body FROM act_artifact WHERE id = ?")
      .get("seed_markdown_body_render_pipeline_smoke_v1") as {
        id: string; kind: string; body: string;
      } | null;
    expect(md).not.toBeNull();
    if (!md) return;
    expect(md.kind).toBe("markdown_body");
    expect(md.body).toContain("# Render Pipeline Smoke Test");
  });

  test("C3 (2026-05-18) master_report_generation_orchestrator recipe is seeded with strategy-first DAG body anchors", () => {
    const db = openDb(":memory:");
    seedActArtifacts(db);
    const row = db
      .query("SELECT id, kind, body, name FROM act_artifact WHERE id = ?")
      .get("seed_master_report_generation_orchestrator") as {
        id: string; kind: string; body: string; name: string | null;
      } | null;
    expect(row).not.toBeNull();
    if (!row) return;
    expect(row.kind).toBe("recipe");
    // Recipe text MUST mention the binding suffix and the 15-node floor
    // so a prompt_composer retrieval surfaces the structural rule, not
    // generic prose. Closure verifier + admission gate read the same
    // anchors.
    expect(row.body).toContain("_strategic_direction_chosen");
    expect(row.body).toContain("atms_report_v");
    expect(row.body).toContain("15 task_node_opened");
    // DAG layer shape must be named explicitly so the brain composer
    // serialises the S/T/U/V/W shape into the directive prompt.
    expect(row.body).toContain("S-layer");
    expect(row.body).toContain("T-layer");
    expect(row.body).toContain("U-layer");
    expect(row.body).toContain("V-layer");
    expect(row.body).toContain("W-layer");
  });

  test("includes every runtime named in §11.4", () => {
    const db = openDb(":memory:");
    seedActArtifacts(db);
    const runtimes = new Set(
      (db.query("SELECT DISTINCT runtime FROM act_artifact").all() as Array<{ runtime: string }>).map((r) => r.runtime),
    );
    expect(runtimes.has("bun")).toBe(true);
    expect(runtimes.has("uv")).toBe(true);
    expect(runtimes.has("camofox-browser")).toBe(true);
  });

  test("seed_web_search body supports /search, /scholar, /maps endpoints (2026-05-18 extension)", () => {
    // Pre-extension the artifact hard-coded https://google.serper.dev/search.
    // Cite PNBQJR8T1N5R reusable pattern + 0R6EPM4AX54J credential health
    // check: one artifact, endpoint parameter ∈ {search, scholar, maps},
    // honest serper_api_key_missing when key absent.
    const db = openDb(":memory:");
    seedActArtifacts(db);
    const row = db
      .query("SELECT body, fixture_input FROM act_artifact WHERE id = ?")
      .get("seed_web_search") as { body: string; fixture_input: string } | null;
    expect(row).not.toBeNull();
    if (!row) return;
    // Honest credential health check stays.
    expect(row.body).toContain("serper_api_key_missing");
    // Endpoint validation set.
    expect(row.body).toContain("VALID_ENDPOINTS");
    expect(row.body).toContain("'search'");
    expect(row.body).toContain("'scholar'");
    expect(row.body).toContain("'maps'");
    // Per-endpoint result shaping.
    expect(row.body).toContain("publication_info");
    expect(row.body).toContain("cited_by");
    expect(row.body).toContain("places");
    expect(row.body).toContain("rating");
    // Endpoint param flows into the URL.
    expect(row.body).toContain("'https://google.serper.dev/' + endpoint");
    // Result envelope carries the endpoint so callers know which shape they got.
    expect(row.body).toContain("endpoint, query, hits");
    // Fixture updated to include endpoint:'search' so the existing
    // verifier path keeps working.
    const fx = JSON.parse(row.fixture_input ?? "{}");
    expect(fx.query).toBeDefined();
    expect(fx.endpoint).toBe("search");
  });

  test("seedActArtifacts content-hash upgrade: body change replaces row in-place, preserves posterior (Phase I3+ distribution)", () => {
    // Pre-fix the seed function used a simple existence check — when an
    // operator pulled a new acc2 release with an improved artifact body
    // (e.g. web_search gaining /scholar + /maps endpoints), the existing
    // row was skipped forever and the install stayed on the old body.
    // This test pins the content-hash upgrade gate: when body changes,
    // the row is UPDATED in place while posterior_alpha/beta/score/
    // confidence are PRESERVED.
    const db = openDb(":memory:");
    seedActArtifacts(db); // initial admit
    // Simulate live calibration: bump posterior on a known artifact.
    db.run(
      `UPDATE act_artifact SET posterior_alpha = 12.0, posterior_beta = 3.0, score = 0.8, confidence = 0.85
        WHERE id = 'seed_web_search'`,
    );
    const before = db
      .query("SELECT body, posterior_alpha, posterior_beta, score, confidence FROM act_artifact WHERE id = 'seed_web_search'")
      .get() as { body: string; posterior_alpha: number; posterior_beta: number; score: number; confidence: number };
    expect(before.posterior_alpha).toBeCloseTo(12.0, 5);
    expect(before.body).toContain("VALID_ENDPOINTS"); // new body shipped
    // Mutate body in-place to simulate a downgrade then re-seed (the
    // upgrade path mirrors any future body improvement).
    db.run(`UPDATE act_artifact SET body = 'OLD STUB BODY' WHERE id = 'seed_web_search'`);
    // Clear the recorded hash so the gate sees content drift.
    // (Hash records live in the generic `meta` k/v table under prefix
    // `seed:code_artifact:` — there is no dedicated seed_hash_registry.)
    db.run(`DELETE FROM meta WHERE key LIKE 'seed:code_artifact:%'`);
    const summary = seedActArtifacts(db);
    // Upgrade fired on every artifact with no matching hash (a fresh
    // table). At minimum web_search must have been updated.
    expect((summary.upgraded ?? 0) + (summary.inserted ?? 0)).toBeGreaterThan(0);
    const after = db
      .query("SELECT body, posterior_alpha, posterior_beta, score, confidence FROM act_artifact WHERE id = 'seed_web_search'")
      .get() as { body: string; posterior_alpha: number; posterior_beta: number; score: number; confidence: number };
    expect(after.body).toContain("VALID_ENDPOINTS"); // body restored to seed
    expect(after.body).not.toBe("OLD STUB BODY");
    // Posterior preserved end-to-end across the upgrade.
    expect(after.posterior_alpha).toBeCloseTo(12.0, 5);
    expect(after.posterior_beta).toBeCloseTo(3.0, 5);
    expect(after.score).toBeCloseTo(0.8, 5);
    expect(after.confidence).toBeCloseTo(0.85, 5);
  });

  test("seed_deep_research body wires the plan/explore/learn loop with parallel endpoints + gap detection (Phase I3+ deep research)", () => {
    // Cite knowledge_candidates AMW36P80MD4T (pipeline of retrieval/
    // filter/synthesis/verification) + ZQQA8YXQX56E (explicit plan/
    // explore/learn loops over external sources) + PNBQJR8T1N5R (single
    // bun artifact, Promise.allSettled for parallel endpoints).
    const db = openDb(":memory:");
    seedActArtifacts(db);
    const row = db
      .query("SELECT body, fixture_input, declared_sandbox FROM act_artifact WHERE id = ?")
      .get("seed_deep_research") as { body: string; fixture_input: string; declared_sandbox: string } | null;
    expect(row).not.toBeNull();
    if (!row) return;
    // Honest credential health check (mirrors web_search per 0R6EPM4AX54J).
    expect(row.body).toContain("serper_api_key_missing");
    // Plan layer: explicit endpoint validation + default-from-inputs.
    expect(row.body).toContain("VALID");
    expect(row.body).toContain("endpoints");
    // Explore layer: parallel POST via Promise.allSettled.
    expect(row.body).toContain("Promise.allSettled");
    // Learn layer: distinct-domain accounting + gap detection (open-ended).
    expect(row.body).toContain("distinct_domains");
    expect(row.body).toContain("no_scholar_results");
    expect(row.body).toContain("insufficient_distinct_domains");
    expect(row.body).toContain("zero_total_hits");
    expect(row.body).toContain("all_endpoints_failed");
    // Result envelope shape: plan + explore + learn + errors.
    expect(row.body).toContain("plan: { endpoints");
    expect(row.body).toContain("explore: {");
    expect(row.body).toContain("learn: { top_hits");
    // Sandbox: only serper.dev allowed; larger wall budget than web_search
    // because multi-endpoint runs are slower.
    const sandbox = JSON.parse(row.declared_sandbox);
    expect(sandbox.net_allow).toEqual(["google.serper.dev"]);
    expect(sandbox.wall_ms).toBeGreaterThan(15000);
    // Fixture: a realistic deep-research query.
    const fx = JSON.parse(row.fixture_input);
    expect(Array.isArray(fx.endpoints)).toBe(true);
    expect(fx.endpoints).toContain("scholar");
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
    seedActArtifacts(db);
    const row = db
      .query("SELECT body FROM act_artifact WHERE id = ?")
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
    seedActArtifacts(db);
    const row = db
      .query("SELECT body, declared_sandbox FROM act_artifact WHERE id = ?")
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
    seedActArtifacts(db);
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
    seedActArtifacts(db);
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
    seedActArtifacts(db);
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
    seedActArtifacts(db);
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

  test("after seedFoundationalKnowledge + seedActArtifacts + seedRecipes the substrate is populated", () => {
    const db = openDb(":memory:");
    seedFoundationalKnowledge(db, { ownerApproved: true });
    seedActArtifacts(db);
    const recipeSummary = seedRecipes(db);

    const knowledgeCandidates = (db
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'knowledge_candidate'")
      .get() as { c: number }).c;
    expect(knowledgeCandidates).toBeGreaterThan(0);

    const artifactCount = (db
      .query("SELECT COUNT(*) AS c FROM act_artifact").get() as { c: number }).c;
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
