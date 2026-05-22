// acc2 substrate seed tests — proves the seed entrypoints are
// idempotent and respect the owner-approval gate for foundational
// knowledge.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, openDb } from "./db";
import {
  PREDICATE_SEED_NAMES,
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

  test("seed ids use the stable seed_<name> prefix (legacy seeds) or a canonical stable_id (substrate primitives, 2026-05-19)", () => {
    const db = openDb(":memory:");
    seedActArtifacts(db);
    const ids = (db.query("SELECT id FROM act_artifact").all() as Array<{ id: string }>).map((r) => r.id);
    // Substrate-primitive rows (brain 198YWW39K94KH2ZQ1A7XHP2T8R) register
    // at their canonical action_artifact_id (e.g. knowledge_merger_v1)
    // because thousands of pre-existing action_scored events already
    // carry that id; forcing a seed_ prefix would orphan the credit
    // pipeline. Legacy seeds keep the stable seed_ prefix.
    const SUBSTRATE_PRIMITIVE_IDS = new Set([
      "knowledge_merger_v1",
      "opencode_brain_exit_action",
      "owner_profile_promoter_action",
      "recipe_cluster_extraction_action",
      "knowledge_promotion_action",
      "dispatch_decider_v1",
      "lesson_apply_gate_action",
      "claude_agent_apply_change_action",
      "lesson_extractor_v1",
      "closure_verifier_v1",
      "citation_chooser_v1",
      "recipe_confidence_bump_action",
      "predicate_gate_v1",
      "auto_apply_worker_stage2_action",
      "refinement_edge_opener_v1",
      // Canonical verifier_kind seeds (brain ZNYFGRV8NS33B1EZR3S8T80DZR).
      // Bare canonical names — consistent with d84618d's lift gate which
      // sets action_artifact_id = verifier_kind verbatim.
      "deterministic_code",
      "peer_llm_opencode",
      "auto_apply_gate",
      "brain_self_audit_checklist",
      "owner_confirmation",
      "external_signal",
    ]);
    for (const id of ids) {
      if (SUBSTRATE_PRIMITIVE_IDS.has(id)) continue;
      // 2026-05-20: Tier-1 + Tier S0 + Tier 6 scoreable predicates use
      // the `predicate_<name>_v1` id form so the registry can filter
      // predicate rows from raw code artifacts without an out-of-band
      // lookup. Predicate ids are canonical stable handles — not
      // `seed_` prefixed — same shape as the substrate-primitive ids.
      if (id.startsWith("predicate_") && id.endsWith("_v1")) continue;
      // Threshold registry seeds (commit ae6d869) admit as `threshold_<name>`
      // act_artifact rows with kind='threshold_predicate'. Stable canonical
      // ids — same rationale as primitive ids: forced `seed_` prefix would
      // orphan getThreshold callers that lookup by name.
      if (id.startsWith("threshold_")) continue;
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
    // Substrate-primitive rows (brain 198YWW39K94KH2ZQ1A7XHP2T8R) live
    // under state_root LIKE 'substrate/primitive/%' and declare their own
    // kinds (merger / decider / extractor / promoter / verifier / action /
    // predicate / exit_classifier) — excluded from the legacy default-
    // kind check.
    // Threshold registry seeds (commit ae6d869) live under
    // state_root='substrate/threshold/<name>' and declare
    // kind='threshold_predicate'. Excluded from the legacy default-
    // kind check below.
    const legacyRows = db
      .query(
        "SELECT kind FROM act_artifact WHERE state_root NOT LIKE 'dispatch/%' AND state_root NOT LIKE 'recipes/%' AND state_root NOT LIKE 'render/%' AND state_root NOT LIKE 'substrate/primitive/%' AND state_root NOT LIKE 'substrate/threshold/%' AND state_root NOT LIKE 'release/claude-plugin/%'",
      )
      .all() as Array<{ kind: string }>;
    expect(legacyRows.length).toBeGreaterThan(0);
    for (const r of legacyRows) expect(r.kind).toBe("code_artifact");
    // Substrate primitives carry kind values from the open vocabulary
    // {merger, decider, extractor, promoter, verifier, action, predicate,
    // exit_classifier}. Assert the set is non-empty and that none of the
    // rows accidentally fall back to 'code_artifact'.
    const primitiveRows = db
      .query("SELECT id, kind FROM act_artifact WHERE state_root LIKE 'substrate/primitive/%'")
      .all() as Array<{ id: string; kind: string }>;
    expect(primitiveRows.length).toBeGreaterThanOrEqual(16);
    for (const r of primitiveRows) expect(r.kind).not.toBe("code_artifact");
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

  test("Tier -1 + Tier S0 + Tier 6 scoreable predicates (2026-05-20) admit as act_artifact rows with verbatim roadmap payload", () => {
    // Per docs/roadmap.md the substrate documents 30 scoreable predicates
    // (5 Tier-1 floor + 5 Tier S0 owner alignment + 20 Tier 6 scoreable
    // assumptions). Until admitted as act_artifact rows the universal
    // projector (action_scored → updateActionPosterior) had nothing to
    // credit; this test pins the admission set so the gap cannot
    // silently regress.
    const db = openDb(":memory:");
    seedActArtifacts(db);

    // Expected: at least the 30 documented predicates by name. The
    // canonical list lives in PREDICATE_SEED_NAMES so future additions
    // flow through the same export.
    expect(PREDICATE_SEED_NAMES.length).toBeGreaterThanOrEqual(30);

    const rows = db
      .query(
        `SELECT id, kind, name, body, runtime, status,
                posterior_alpha, posterior_beta, score, confidence, state_root
         FROM act_artifact
         WHERE state_root LIKE 'substrate/primitive/predicate/%'
         ORDER BY id`,
      )
      .all() as Array<{
        id: string;
        kind: string;
        name: string | null;
        body: string;
        runtime: string;
        status: string;
        posterior_alpha: number;
        posterior_beta: number;
        score: number;
        confidence: number;
        state_root: string;
      }>;

    // 1. The 30 predicates are all present, each as exactly one row.
    expect(rows.length).toBe(PREDICATE_SEED_NAMES.length);
    const byKind = new Map(rows.map((r) => [r.kind, r]));
    for (const name of PREDICATE_SEED_NAMES) {
      const row = byKind.get(name);
      expect(row).toBeDefined();
      if (!row) continue;
      // 2. Stable id form is `predicate_<name>_v1` (NOT seed_ prefixed).
      expect(row.id).toBe(`predicate_${name}_v1`);
      // 3. Kind equals the predicate name verbatim (open vocabulary —
      //    matches threshold_predicate naming convention).
      expect(row.kind).toBe(name);
      // 4. Runtime is bun (verifier/scorer is a bun fn).
      expect(row.runtime).toBe("bun");
      // 5. Status is admitted (cold-start; learns from cited
      //    action_scored events).
      expect(row.status).toBe("admitted");
      // 6. Uninformative Beta(1,1) prior: alpha=beta=1, score=0.5,
      //    confidence=0.3. They learn — no synthetic evidence weight.
      expect(row.posterior_alpha).toBe(1);
      expect(row.posterior_beta).toBe(1);
      expect(row.score).toBe(0.5);
      expect(row.confidence).toBeCloseTo(0.3, 5);
      // 7. State root partitions by predicate name under primitive.
      expect(row.state_root).toBe(`substrate/primitive/predicate/${name}`);
      // 8. body is JSON-encoded predicate payload — non-empty
      //    problem / contract / why / closure_predicate / metric_direction
      //    + tier.
      const payload = JSON.parse(row.body) as {
        tier?: string;
        problem?: string;
        contract?: string;
        why?: string;
        closure_predicate?: string;
        metric_direction?: string;
        evaluator_artifact_id?: string;
        consumer_gate?: string;
      };
      expect(typeof payload.tier).toBe("string");
      expect(payload.tier && payload.tier.length).toBeGreaterThan(0);
      expect(typeof payload.problem).toBe("string");
      expect(payload.problem && payload.problem.length).toBeGreaterThan(0);
      expect(typeof payload.contract).toBe("string");
      expect(payload.contract && payload.contract.length).toBeGreaterThan(0);
      expect(typeof payload.why).toBe("string");
      expect(payload.why && payload.why.length).toBeGreaterThan(0);
      expect(typeof payload.closure_predicate).toBe("string");
      expect(payload.closure_predicate && payload.closure_predicate.length).toBeGreaterThan(0);
      expect(typeof payload.metric_direction).toBe("string");
      expect(payload.metric_direction && payload.metric_direction.length).toBeGreaterThan(0);
      if (name === "delegation_safety_predicate") {
        expect(payload.evaluator_artifact_id).toBe("delegation_safety_evaluator_v1");
        expect(payload.consumer_gate).toContain("deterministicApplyRoute");
      }
    }

    // 9. Tier distribution. Original split was 5/5/20; 2026-research
    // integration (commit a750bbb) added 2 Tier -1 predicates
    // (memory_reconciliation + recursive_self_improvement_safeguard
    // per SSGM arXiv:2603.11768 + SAHOO arXiv:2603.06333). The S0
    // replan (commit 776007c) restructured the flat 5 into 8 tiered
    // boundaries (preservation + policy + safety + state + forecast
    // + rendering + belief + orchestration) per brain 70XT4ZKMBH5CQ3A3
    // grounded in Kriger/HILA/SBD/COSMIC/Adaptive ToM/MetaMind.
    // Commit a750bbb added constitutional_amendment_ratification per
    // AgentCity arXiv:2604.07007. Current split: 7/9/20.
    const byTier = new Map<string, number>();
    for (const r of rows) {
      const tier = (JSON.parse(r.body) as { tier?: string }).tier ?? "unknown";
      byTier.set(tier, (byTier.get(tier) ?? 0) + 1);
    }
    expect(byTier.get("tier_minus_1_floor")).toBe(7);
    expect(byTier.get("tier_s0_owner_alignment")).toBe(9);
    expect(byTier.get("tier_6_scoreable_assumption")).toBe(20);
  });

  test("Tier -1 + Tier S0 + Tier 6 predicate admission is idempotent (same-ID upserts preserve posterior history, k_555 four-link chain)", () => {
    const db = openDb(":memory:");
    seedActArtifacts(db);

    // Simulate calibration: bump alpha on one predicate to look as if
    // the universal projector has credited it from action_scored events.
    const target = `predicate_${PREDICATE_SEED_NAMES[0]}_v1`;
    db.run(
      "UPDATE act_artifact SET posterior_alpha = 5.0, posterior_beta = 2.0, score = 0.71, confidence = 0.62 WHERE id = ?",
      [target],
    );

    // Re-run the seed loop. The expectation is "same-ID upsert preserves
    // posterior history" — content-hash gate means body/sandbox stays
    // identical so the row is skipped; the bumped posterior remains.
    seedActArtifacts(db);

    const after = db
      .query(
        "SELECT posterior_alpha, posterior_beta, score, confidence FROM act_artifact WHERE id = ?",
      )
      .get(target) as {
        posterior_alpha: number;
        posterior_beta: number;
        score: number;
        confidence: number;
      } | null;
    expect(after).not.toBeNull();
    if (!after) return;
    expect(after.posterior_alpha).toBe(5.0);
    expect(after.posterior_beta).toBe(2.0);
    expect(after.score).toBeCloseTo(0.71, 5);
    expect(after.confidence).toBeCloseTo(0.62, 5);

    // No duplicate rows.
    const count = (
      db
        .query(
          "SELECT COUNT(*) AS c FROM act_artifact WHERE state_root LIKE 'substrate/primitive/predicate/%'",
        )
        .get() as { c: number }
    ).c;
    expect(count).toBe(PREDICATE_SEED_NAMES.length);
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
  test("inserts one recipe-shape knowledge row per canonical goal shape", () => {
    const db = openDb(":memory:");
    seedActArtifacts(db);
    const summary = seedRecipes(db);
    expect(summary.count).toBeGreaterThan(0);
    expect(summary.count).toBe(seedRecipeGoalTexts().length);

    const rows = db
      .query("SELECT payload FROM events WHERE kind = 'knowledge_candidate' AND COALESCE(json_extract(payload, '$.recipe_shape.enabled'), 0) IN (1, 'true')")
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
      .query("SELECT COUNT(*) AS c FROM events WHERE kind = 'knowledge_candidate' AND COALESCE(json_extract(payload, '$.recipe_shape.enabled'), 0) IN (1, 'true')")
      .get() as { c: number }).c;
    expect(total).toBe(first.count);
  });

  test("each recipe references real seed artifact ids", () => {
    const db = openDb(":memory:");
    seedActArtifacts(db);
    seedRecipes(db);
    const validIds = new Set(seedArtifactIds());
    const rows = db
      .query("SELECT payload FROM events WHERE kind = 'knowledge_candidate' AND COALESCE(json_extract(payload, '$.recipe_shape.enabled'), 0) IN (1, 'true')")
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
      .query("SELECT payload FROM events WHERE kind = 'knowledge_candidate' AND COALESCE(json_extract(payload, '$.recipe_shape.enabled'), 0) IN (1, 'true')")
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
      .query("SELECT payload FROM events WHERE kind = 'knowledge_candidate' AND COALESCE(json_extract(payload, '$.recipe_shape.enabled'), 0) IN (1, 'true')")
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

  test("each candidate embeds a capability description with open goal-shape tags", () => {
    const { seedDemoKnowledge, DEMO_CAPABILITIES } = require("./seed");
    const db = openDb(":memory:");
    seedDemoKnowledge(db, { ownerApproved: true });
    const rows = db
      .query("SELECT payload FROM events WHERE kind='knowledge_candidate' ORDER BY rowid ASC")
      .all() as Array<{ payload: string }>;
    expect(rows.length).toBe(DEMO_CAPABILITIES.length);
    for (let i = 0; i < rows.length; i++) {
      const payload = JSON.parse(rows[i]!.payload) as Record<string, unknown>;
      expect(payload.claim).toBe(DEMO_CAPABILITIES[i]!.capability_description);
      expect((payload.tags as string[]).includes("demo")).toBe(true);
      expect(Array.isArray(payload.goal_shape_tags)).toBe(true);
      expect(payload).not.toHaveProperty("demo_recipe_id");
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
