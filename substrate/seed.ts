// acc2 substrate seed — optional foundational knowledge import (§16) +
// the ten seed code artifacts (§11.4). Both functions are idempotent:
// re-running on a warm db produces zero new rows.
//
// Foundational knowledge is OWNER-APPROVED ONLY (k_3601-style explicit
// consent gate). Calling with {ownerApproved: false} is a no-op by
// design — the substrate refuses to seed without the owner's signal.
//
// Seed code artifacts enter at `admitted` with prior scores per the
// design table; the substrate IS the merger, so we never seed them
// directly into `promoted` — only repeated successful invocation
// (extractCodeArtifactScores §11.5 promotion path) earns that status.

import type { Database } from "bun:sqlite";
import { withImmediateTransaction } from "./db";
import { goalShape } from "../runtime/goal_shape";
import type { CodeArtifactStatus, OwnerProfile, Runtime, SandboxDecl } from "./types";

const newId = (): string =>
  crypto.randomUUID().replace(/-/g, "").slice(0, 26).toUpperCase();

const nowIso = (): string => new Date().toISOString();

// ── meta gate ──────────────────────────────────────────────────────

const META_SEEDED_FOUNDATIONAL = "seed:foundational_knowledge";
const META_SEEDED_POLICY_BUNDLES = "seed:policy_bundles:v1";

const readMeta = (db: Database, key: string): string | null => {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null;
  return row?.value ?? null;
};

const writeMeta = (db: Database, key: string, value: string): void => {
  db.run(
    "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
};

// ── Foundational knowledge — load-bearing principles ────────────────
//
// Each entry below carries the canonical text the merger would have
// promoted from real evidence. We mark them substrate_auto with a
// `skip_corroboration: true` flag (per §16) so the promotion event is
// honest about its synthetic provenance.

type FoundationalLaw = {
  text: string;
  tags: string[];
  score: number;
  confidence: number;
  goalShapeTags?: string[];
};

const SEED_LAWS: FoundationalLaw[] = [
  {
    text: "Verifier code artifacts return a scalar residual in [0,1]. 0 = goal met; 1 = goal missed.",
    tags: ["substrate", "verifier", "residual"],
    score: 0.95,
    confidence: 0.95,
  },
  {
    text: "Cycle-1-only is structural. The dispatcher rejects self-iteration; refinement edges replace cycle 2+.",
    tags: ["dispatcher", "cycle-1", "structural"],
    score: 0.95,
    confidence: 0.95,
  },
  {
    text: "v2 does not migrate from v1. The substrate launches empty; v1 is archived read-only.",
    tags: ["greenfield", "no-migration"],
    score: 0.95,
    confidence: 0.95,
  },
  {
    text: "Knowledge merger is owned by the substrate (Model D). Neither LLM judges its own candidate text.",
    tags: ["merger", "model-d", "substrate"],
    score: 0.95,
    confidence: 0.90,
  },
  {
    text: "Citation without state mutation is decorative memory. Every citation must mutate retrieval state.",
    tags: ["k_554", "retrieval", "mutation"],
    score: 0.90,
    confidence: 0.90,
  },
  {
    text: "Advisory gates do not change behavior. Make them hard. (k_252)",
    tags: ["k_252", "advisory", "hard"],
    score: 0.90,
    confidence: 0.90,
  },
  {
    text: "Four links — create, retrieve, mutate, credit — are owned by the substrate, not any LLM.",
    tags: ["k_555", "four-links", "rlm"],
    score: 0.95,
    confidence: 0.90,
  },
  {
    text: "Code artifacts admit at score=0.5/confidence=0.3 and earn 'promoted' only via accumulated action_scored evidence.",
    tags: ["latm", "voyager", "promotion"],
    score: 0.90,
    confidence: 0.85,
  },
  {
    text: "Owner channel is Claude Code chat only. No telegram, no email, no licensed-expert routing.",
    tags: ["owner-channel", "subscription-cli-only"],
    score: 0.95,
    confidence: 0.95,
  },
  {
    text: "Declared sandbox != actual usage at runtime emits sandbox_violation and quarantines the artifact.",
    tags: ["sandbox", "quarantine", "k_252"],
    score: 0.90,
    confidence: 0.85,
  },
  {
    text: "Moved contract examples, historical rationale, source inventories, removed-rule evidence, and long recipes belong in promoted knowledge rows, tagged for prompt_composer goal-shape retrieval instead of always-loaded CLAUDE.md.",
    tags: ["contract", "prompt-composer", "moved-knowledge", "goal-shape"],
    goalShapeTags: ["contract", "claude", "prompt", "composer", "retrieval", "knowledge", "moved", "structural", "amendment"],
    score: 0.90,
    confidence: 0.86,
  },
  {
    text: "Contract anti-pattern examples and removed-rule evidence should be retrieved only for matching amendment or audit goals; CLAUDE.md keeps the structural law, not commit-history catalogs.",
    tags: ["contract", "anti-pattern", "history", "goal-shape"],
    goalShapeTags: ["contract", "anti", "pattern", "history", "removed", "rule", "audit", "amendment"],
    score: 0.88,
    confidence: 0.84,
  },
  {
    text: "Owner modeling examples should use open-ended rendering, autonomy, control, risk, collaboration, and goal-continuity signal maps; do not encode persona enums in prompt or schema surfaces.",
    tags: ["owner-model", "open-ended", "signals", "contract"],
    goalShapeTags: ["owner", "model", "autonomy", "control", "risk", "collaboration", "continuity", "signals", "contract"],
    score: 0.88,
    confidence: 0.84,
  },
  {
    text: "Universal intent ingress examples collapse to one loop: capture owner words, route through substrate, let dispatch choose one-shot, decomposition, clarification, replay, or deferral by residual evidence and owner-control signals.",
    tags: ["intent-ingress", "dispatch", "contract", "owner-control"],
    goalShapeTags: ["intent", "ingress", "dispatch", "decompose", "clarify", "defer", "residual", "owner", "control", "contract"],
    score: 0.88,
    confidence: 0.84,
  },
];

type PolicyBundleSeed = {
  surface: "brain_prompt";
  sectionName: "workflow" | "do_not";
  priority: number;
  version: string;
  body: string;
  goalShapeTags: string[];
  score: number;
  confidence: number;
};

const POLICY_BUNDLE_SEEDS: PolicyBundleSeed[] = [
  {
    surface: "brain_prompt",
    sectionName: "workflow",
    priority: 0,
    version: "2026-05-17.policy_bundle.v1",
    body: "YOUR WORKFLOW (RLM cycle: prompt is constant metadata; substrate is external state; recurse via DAG edges, not chat history):\n  CONSTANT ACT-LOOP METADATA: every action is intent + runtime artifact + verifier artifact + predicted_residual; residual is the universal score.\n  1. Write/reuse a code artifact for any runtime + a verifier artifact for any runtime; action and verifier runtimes may differ (e.g. camofox action + bun verifier).\n     Verifier residuals are a packet: residual ∈ [0,1] is the universal scalar (substrate uses this for scheduling + credit) plus OPEN-ENDED breakdown:Record<string,number> and reliability_profile:Record<string,number> for domain-specific evidence quality, consent, continuity, stakeholder alignment, uncertainty, and any other signal the verifier wants to surface to retrieval. Both maps are free-form by design — invent the keys your domain needs (e.g. for human tasks: evidence_quality, goal_progress, reversibility_or_consent, continuity, stakeholder_alignment, uncertainty; for research: source_diversity, citation_recency; for browser: dom_stability, captcha_risk). DO NOT propose a fixed enum or string-literal union for these dimensions — that recreates the rejected typed-predicate-lattice; the substrate refuses such enums in any code or schema diff.\n  2. Emit action_predicted with action_artifact_id + verifier_artifact_id + predicted_residual. Include budget_estimate={token_upper_bound,wall_ms,verifier_ms,artifact_invocations} when the action can estimate cost; verifiers/action_scored should report budget_observed on the same open-ended axes when available.\n  3. Choose bounded_peek vs symbolic_recursion deliberately before reading more.\n     BOUNDED PEEK: use substrate.search/read when the missing slice is narrow, already indexed, immediately action-relevant, and can fit this cycle's verifier boundary.\n     SYMBOLIC RECURSION: emit task_node_opened + task_edge_recorded (refines/requires) when the next slice is broad, independently verifiable, multi-source/multi-runtime, owner-gated, or likely to produce reusable knowledge/artifacts.\n     For residual-driven recursion, task_edge_recorded.payload must include open-ended trigger_axis, trigger_residual, expected_residual_delta, and stop_condition when those values are known.\n     Include the choice and reason in emitted task/action payloads so closure verifiers can score recursion-vs-peek quality.\n     UNIVERSAL DEMO GENERATION: the substrate seeds CAPABILITY DESCRIPTIONS as promoted\n     knowledge (rolling_active, knowledge_compounds, owner_profile_grounded, father_ranked,\n     stakeholder_tracked, recipe_compounds). These are NOT fixed demos to surface verbatim —\n     they are your VOCABULARY of what kinds of work the substrate enables. When the owner's\n     intent is unclear or this is their first directive, GENERATE a tailored proposal on the\n     fly: read the matched capability descriptions + the OWNER PROFILE + the directive text;\n     compose a fresh proposal in the owner's language, using their vocabulary, framed around\n     their specific goal. Never echo a seeded capability description verbatim — synthesize.\n  4. Propose knowledge_candidate events for new patterns (substrate promotes via outcome).\n     EMIT MID-CYCLE — don't wait for closure. See EMISSION GRAMMARS for the rich schema.\n     When many same-origin candidates have zero promotions, emit a merger/contradiction diagnostic instead of adding more uncited text.\n  5. For new reusable scripts, emit code_artifact_candidate.\n  6. Before any task_committed, satisfy the PROPOSAL GROUNDING GATE:\n     - every referenced event kind exists in substrate/event_kinds.ts;\n     - every repo-targeted amendment has a current anchor + structured diff;\n     - every repo-targeted amendment cites fresh state_snapshot_recorded + state_snapshot_diffed evidence against current master;\n     - proposal_grounding freshness claims are evidence-derived: do NOT set anchor_verified_against_current_master:true (or equivalent) unless evidence_event_ids/context_refs include an action_scored verifier event with residual < 0.3 against current master;\n     - that verifier must score open-ended axes for anchor_freshness, semantic_duplicate_detection, behavioral_novelty, and necessity; stale_or_unverified_snapshot, duplicate_or_renamed_work, behavioral_non_novel, or unnecessary_change residual >= 0.3 means refine, do NOT propose anchored amendments;\n     - semantic-duplicate detection compares existing exports/symbols plus behavior signatures so renamed duplicates are refused before apply;\n     - auto_apply_gate residual must be verifier-computed from anchor-freshness × semantic-duplicate-detection × behavioral-novelty × necessity, not from brain-authored low-risk assertions;\n     - adversarial second-pass review emits adversarial_review_complete before auto-apply unlocks; missing review evidence keeps repo-targeted amendments prose-only or blocked;\n     - every referenced acc CLI command exists or is introduced in this DAG with a requires edge;\n     - every deliverable-shaped leaf goal has emitted a code_artifact_candidate,\n       contract_amendment_proposed, or lesson_extracted.proposed_action.\n     - complex substrate-audit or intelligence-loop research roots cite a measured diagnostics action covering DAG shape, proposal coverage, closure readiness, budget explicitness, and origin/knowledge promotion before root commit.\n     Gate residual ≥ 0.3 → refine, do NOT commit.\n  CLOSURE + LEARNING (required before committing a DIRECTIVE's root task):\n  7. Run a CLOSURE VERIFIER (a code artifact); emit task_closure_audited.\n     Include reliability_profile as an OPEN-ENDED Record<string,number> when available. Axes are discovered per goal-domain from outcomes, never fixed as a schema. Residual stays the universal scalar; reliability_profile is the discovered axis-vector behind it.\n     closure_residual ≥ 0.3 → refine, do NOT commit root.\n  8. Extract lessons: emit contract_amendment_proposed OR lesson_extracted for every friction.\n     Route prior PENDING PROPOSALS through new task_nodes instead of letting them accumulate.\n  RENDERING + OWNER INPUT (conditional surfaces; no fixed enum):\n  9. For owner-visible output, read OWNER PROFILE and render through open-ended rendering/autonomy/control/risk/collaboration/goal_continuity signals, preferred_terms, avoided_terms, and detected_language confidence.\n     Keep substrate-internal English fields unchanged. If corrected, emit owner_insight_candidate citing the owner event.\n  10. When owner_input_received / owner_decision_recorded changes durable constraints, terms, autonomy bounds, hot topics, or recurring decision patterns, emit owner_insight_candidate with cited source event ids.",
    goalShapeTags: ["prompt", "composer", "workflow", "brain", "policy", "rlm", "act", "loop"],
    score: 0.95,
    confidence: 0.92,
  },
  {
    surface: "brain_prompt",
    sectionName: "do_not",
    priority: 0,
    version: "2026-05-17.policy_bundle.v1",
    body: "DO NOT:\n  - Look for a tool menu — there isn't one. Write code for a runtime.\n  - Author canonical knowledge directly — propose candidates; substrate promotes via outcome correlation.\n  - Iterate within this cycle — emit a refinement edge if more work remains.\n  - Rebuild the environment in-context or summarize it as a substitute for substrate state; use symbolic handles + ledger mutations instead.\n  - Exit having produced only conversational text. Every cycle MUST call at least one substrate.* tool (see EXIT INVARIANT). Text-only exits are scored brain_silent_exit and counted as prompt-compliance failures.",
    goalShapeTags: ["prompt", "composer", "do", "not", "brain", "policy", "silent", "exit"],
    score: 0.95,
    confidence: 0.92,
  },
];

export type FoundationalSeedSummary = { imported: number };

export const seedFoundationalKnowledge = (
  db: Database,
  options?: { ownerApproved?: boolean },
): FoundationalSeedSummary => {
  if (!options?.ownerApproved) {
    return { imported: 0 };
  }
  const shouldSeedLaws = readMeta(db, META_SEEDED_FOUNDATIONAL) === null;
  const shouldSeedPolicyBundles = readMeta(db, META_SEEDED_POLICY_BUNDLES) === null;
  if (!shouldSeedLaws && !shouldSeedPolicyBundles) {
    return { imported: 0 };
  }

  const directiveId = "dir_seed_foundational";
  const loopId = "loop_seed_foundational";
  const taskId = "task_seed_foundational";
  let imported = 0;

  withImmediateTransaction(db, () => {
    if (shouldSeedLaws) {
      for (const law of SEED_LAWS) {
      const candidateId = newId();
      db.run(
        `INSERT INTO events (
           id, ts, directive_id, task_id, loop_id, substrate_origin,
           kind, payload, context_refs
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          candidateId,
          nowIso(),
          directiveId,
          taskId,
          loopId,
          "substrate_auto",
          "knowledge_candidate",
          JSON.stringify({
            text: law.text,
            tags: law.tags,
            proposed_tier: "law",
            derived_from: ["v1_archive_import", "v2_design_md"],
            confidence_estimate: law.confidence,
            skip_corroboration: true,
          }),
          JSON.stringify([]),
        ],
      );
      const promoteId = newId();
      db.run(
        `INSERT INTO events (
           id, ts, directive_id, task_id, loop_id, substrate_origin,
           kind, payload, context_refs
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          promoteId,
          nowIso(),
          directiveId,
          taskId,
          loopId,
          "substrate_auto",
          "knowledge_promoted",
          JSON.stringify({
            candidate_id: candidateId,
            score: law.score,
            confidence: law.confidence,
            goal_shape_tags: law.goalShapeTags,
            skip_corroboration: true,
          }),
          JSON.stringify([candidateId]),
        ],
      );
      imported++;
    }
      writeMeta(db, META_SEEDED_FOUNDATIONAL, nowIso());
    }

    if (shouldSeedPolicyBundles) {
      for (const bundle of POLICY_BUNDLE_SEEDS) {
        const candidateId = newId();
        const policyBundle = {
          type: "policy_bundle",
          surface: bundle.surface,
          section_name: bundle.sectionName,
          priority: bundle.priority,
          version: bundle.version,
          body: bundle.body,
          goal_shape_tags: bundle.goalShapeTags,
        };
        db.run(
          `INSERT INTO events (
             id, ts, directive_id, task_id, loop_id, substrate_origin,
             kind, payload, context_refs
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            candidateId,
            nowIso(),
            directiveId,
            taskId,
            loopId,
            "substrate_auto",
            "knowledge_candidate",
            JSON.stringify({
              claim: "Brain prompt policy section " + bundle.surface + "/" + bundle.sectionName + " is stored as a typed substrate policy bundle.",
              text: bundle.body,
              tags: ["prompt_policy", "policy_bundle", bundle.surface, bundle.sectionName],
              proposed_tier: "policy_bundle",
              confidence_estimate: bundle.confidence,
              policy_bundle: policyBundle,
              skip_corroboration: true,
            }),
            JSON.stringify([]),
          ],
        );
        const promoteId = newId();
        db.run(
          `INSERT INTO events (
             id, ts, directive_id, task_id, loop_id, substrate_origin,
             kind, payload, context_refs
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            promoteId,
            nowIso(),
            directiveId,
            taskId,
            loopId,
            "substrate_auto",
            "knowledge_promoted",
            JSON.stringify({
              type: "policy_bundle",
              candidate_id: candidateId,
              score: bundle.score,
              confidence: bundle.confidence,
              surface: bundle.surface,
              section_name: bundle.sectionName,
              priority: bundle.priority,
              version: bundle.version,
              body: bundle.body,
              goal_shape_tags: bundle.goalShapeTags,
              policy_bundle: policyBundle,
              skip_corroboration: true,
            }),
            JSON.stringify([candidateId]),
          ],
        );
        imported++;
      }
      writeMeta(db, META_SEEDED_POLICY_BUNDLES, nowIso());
    }
  });

  return { imported };
};

// ── Seed code artifacts (§11.4) ────────────────────────────────────

type SeedArtifact = {
  seedName: string;        // stable: id = `seed_<seedName>`
  runtime: Runtime;
  body: string;
  declared_sandbox: SandboxDecl;
  state_root: string;
  initial_score: number;
  initial_confidence: number;
  fixture_input: unknown;
  fixture_expected_residual: number;
  display_name: string;
};

const SEED_ARTIFACTS: SeedArtifact[] = [
  {
    seedName: "substrate_read",
    runtime: "bun",
    body: [
      "// substrate_read — query the events table or a substrate view.",
      "// args: { sql: string, params?: unknown[] }",
      "export default async (db, args) => {",
      "  return db.query(args.sql).all(...(args.params ?? []));",
      "};",
    ].join("\n"),
    declared_sandbox: {
      runtime: "bun",
      substrate_access: "ro",
      cpu_ms: 2000,
      wall_ms: 5000,
      memory_mb: 128,
    },
    state_root: "substrate/read",
    initial_score: 0.95,
    initial_confidence: 0.95,
    fixture_input: { sql: "SELECT 1 AS x" },
    fixture_expected_residual: 0.0,
    display_name: "substrate_read",
  },
  {
    seedName: "substrate_save",
    runtime: "bun",
    body: [
      "// substrate_save — append a single event row to the substrate.",
      "// args: { kind, directive_id, task_id, loop_id, substrate_origin, payload }",
      "export default async (db, args, { newId, nowIso }) => {",
      "  const id = newId();",
      "  db.run(",
      "    `INSERT INTO events (id, ts, directive_id, task_id, loop_id,",
      "       substrate_origin, kind, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,",
      "    [id, nowIso(), args.directive_id, args.task_id, args.loop_id,",
      "     args.substrate_origin, args.kind, JSON.stringify(args.payload ?? {})],",
      "  );",
      "  return id;",
      "};",
    ].join("\n"),
    declared_sandbox: {
      runtime: "bun",
      substrate_access: "rw",
      cpu_ms: 2000,
      wall_ms: 5000,
      memory_mb: 128,
    },
    state_root: "substrate/save",
    initial_score: 0.95,
    initial_confidence: 0.95,
    fixture_input: {
      kind: "owner_input_received",
      directive_id: "d_fixture",
      task_id: "t_fixture",
      loop_id: "l_fixture",
      substrate_origin: "owner",
      payload: { text: "fixture ping" },
    },
    fixture_expected_residual: 0.0,
    display_name: "substrate_save",
  },
  {
    seedName: "substrate_embed",
    runtime: "bun",
    // Real OpenAI text-embedding-3-small wrapper. Reads `text` from ACC2_INPUTS,
    // posts to /v1/embeddings, and emits the 1536-dim vector on @@RESULT@@.
    // When OPENAI_API_KEY is unset the artifact returns ok:false with the
    // canonical error rather than fabricating a vector — the verifier scores
    // the residual; an unconfigured key looks like configuration drift.
    body: [
      "const inputs = JSON.parse(process.env.ACC2_INPUTS ?? 'null') ?? {};",
      "const apiKey = process.env.OPENAI_API_KEY;",
      "if (!apiKey) {",
      "  console.log('@@RESULT@@ ' + JSON.stringify({ ok: false, error: 'openai_api_key_missing' }));",
      "  process.exit(0);",
      "}",
      "const text = typeof inputs.text === 'string' ? inputs.text : '';",
      "if (text.length === 0) {",
      "  console.log('@@RESULT@@ ' + JSON.stringify({ ok: false, error: 'text_empty' }));",
      "  process.exit(0);",
      "}",
      "try {",
      "  const baseUrl = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';",
      "  const resp = await fetch(baseUrl + '/embeddings', {",
      "    method: 'POST',",
      "    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },",
      "    body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),",
      "  });",
      "  if (!resp.ok) {",
      "    console.log('@@RESULT@@ ' + JSON.stringify({ ok: false, error: 'openai_http_' + resp.status }));",
      "    process.exit(0);",
      "  }",
      "  const data = await resp.json();",
      "  const vec = data?.data?.[0]?.embedding;",
      "  if (!Array.isArray(vec)) {",
      "    console.log('@@RESULT@@ ' + JSON.stringify({ ok: false, error: 'openai_response_shape' }));",
      "    process.exit(0);",
      "  }",
      "  console.log('@@RESULT@@ ' + JSON.stringify({ ok: true, model: 'text-embedding-3-small', dim: vec.length, embedding: vec }));",
      "} catch (err) {",
      "  console.log('@@RESULT@@ ' + JSON.stringify({ ok: false, error: 'openai_fetch_failed:' + String(err) }));",
      "}",
    ].join("\n"),
    declared_sandbox: {
      runtime: "bun",
      substrate_access: "rw",
      net_allow: ["api.openai.com"],
      cpu_ms: 5000,
      wall_ms: 15000,
      memory_mb: 256,
    },
    state_root: "substrate/embed",
    initial_score: 0.90,
    initial_confidence: 0.85,
    fixture_input: { text: "hello world" },
    fixture_expected_residual: 0.0,
    display_name: "substrate_embed",
  },
  {
    seedName: "web_search",
    runtime: "bun",
    // Honest minimal serper.dev wrapper — when SERPER_API_KEY isn't set we
    // return ok:false with the canonical error rather than emitting a fake
    // success. The substrate's verifier scores the residual; an unconfigured
    // key looks like a configuration drift, not a successful answer.
    body: [
      "const inputs = JSON.parse(process.env.ACC2_INPUTS ?? 'null');",
      "const apiKey = process.env.SERPER_API_KEY;",
      "if (!apiKey) {",
      "  console.log('@@RESULT@@ ' + JSON.stringify({ ok: false, error: 'serper_api_key_missing' }));",
      "  process.exit(0);",
      "}",
      "try {",
      "  const resp = await fetch('https://google.serper.dev/search', {",
      "    method: 'POST',",
      "    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },",
      "    body: JSON.stringify({ q: inputs.query }),",
      "  });",
      "  if (!resp.ok) {",
      "    console.log('@@RESULT@@ ' + JSON.stringify({ ok: false, error: 'serper_http_' + resp.status }));",
      "    process.exit(0);",
      "  }",
      "  const data = await resp.json();",
      "  const hits = (data.organic ?? []).slice(0, 10).map((h) => ({ title: h.title, url: h.link, snippet: h.snippet }));",
      "  console.log('@@RESULT@@ ' + JSON.stringify({ ok: true, query: inputs.query, hits }));",
      "} catch (err) {",
      "  console.log('@@RESULT@@ ' + JSON.stringify({ ok: false, error: 'serper_fetch_failed:' + String(err) }));",
      "}",
    ].join("\n"),
    declared_sandbox: {
      runtime: "bun",
      net_allow: ["google.serper.dev"],
      cpu_ms: 5000,
      wall_ms: 15000,
      memory_mb: 128,
    },
    state_root: "substrate/web_search",
    initial_score: 0.80,
    initial_confidence: 0.70,
    fixture_input: { query: "OpenAI text-embedding-3-small" },
    fixture_expected_residual: 0.0,
    display_name: "web_search",
  },
  {
    seedName: "web_fetch_and_parse",
    runtime: "bun",
    // Phase-G honest impl: Bun.fetch + a tiny readability heuristic. We strip
    // <script>/<style> blocks, then strip remaining tags, then collapse
    // whitespace. This is intentionally NOT a full readability port — Phase H
    // can layer a richer extractor on top once the brain has examples.
    body: [
      "const inputs = JSON.parse(process.env.ACC2_INPUTS ?? 'null') ?? {};",
      "const url = inputs && typeof inputs.url === 'string' ? inputs.url : '';",
      "if (url.length === 0) {",
      "  console.log('@@RESULT@@ ' + JSON.stringify({ ok: false, error: 'missing_input_url' }));",
      "  process.exit(0);",
      "}",
      "try {",
      "  const resp = await fetch(url, { headers: { 'User-Agent': 'acc2/0.0.1' } });",
      "  if (!resp.ok) {",
      "    console.log('@@RESULT@@ ' + JSON.stringify({ ok: false, error: 'http_' + resp.status }));",
      "    process.exit(0);",
      "  }",
      "  const html = await resp.text();",
      "  const titleMatch = html.match(/<title[^>]*>([^<]+)<\\/title>/i);",
      "  const title = titleMatch ? titleMatch[1].trim() : null;",
      "  // Strip <script> + <style> blocks, then collapse remaining tags.",
      "  let text = html",
      "    .replace(/<script[\\s\\S]*?<\\/script>/gi, ' ')",
      "    .replace(/<style[\\s\\S]*?<\\/style>/gi, ' ')",
      "    .replace(/<[^>]+>/g, ' ')",
      "    .replace(/&nbsp;/g, ' ')",
      "    .replace(/&amp;/g, '&')",
      "    .replace(/&lt;/g, '<')",
      "    .replace(/&gt;/g, '>')",
      "    .replace(/&quot;/g, '\"')",
      "    .replace(/\\s+/g, ' ')",
      "    .trim();",
      "  if (text.length > 8000) text = text.slice(0, 8000) + '…';",
      "  console.log('@@RESULT@@ ' + JSON.stringify({ ok: true, url, title, text }));",
      "} catch (err) {",
      "  console.log('@@RESULT@@ ' + JSON.stringify({ ok: false, error: 'fetch_failed:' + String(err) }));",
      "}",
    ].join("\n"),
    declared_sandbox: {
      runtime: "bun",
      net_allow: ["*"],
      cpu_ms: 10000,
      wall_ms: 30000,
      memory_mb: 256,
    },
    state_root: "substrate/web_fetch",
    initial_score: 0.75,
    initial_confidence: 0.70,
    fixture_input: { url: "https://example.com" },
    fixture_expected_residual: 0.0,
    display_name: "web_fetch_and_parse",
  },
  {
    seedName: "browser_session_act",
    runtime: "camofox-browser",
    // Batch 1.α minimal browser-session seed. The runtime wrapper drives the
    // real Camoufox firefox binary via playwright's
    // `firefox.launchPersistentContext({ executablePath, ... })`, then
    // exposes a `session` facade (goto / fill / click / text / url /
    // screenshot / close, plus `session.page` for raw playwright Page
    // methods). When either playwright or the camoufox binary is absent
    // (no `~/.cache/camoufox/camoufox`, no CAMOUFOX_BINARY_PATH override)
    // the runtime returns `ok:false, error:"camofox_runtime_unavailable"`
    // with install instructions in sandboxWarnings; this body is
    // structured to surface that cleanly.
    body: [
      "// inputs: { url: string }",
      "await session.goto(inputs.url);",
      "const title = await session.text('title');",
      "console.log('@@RESULT@@ ' + JSON.stringify({ ok: true, title, final_url: session.url }));",
    ].join("\n"),
    declared_sandbox: {
      runtime: "camofox-browser",
      browser_allow_domains: ["example.com"],
      browser_profile_root: "/var/acc2/browser/profile",
      fingerprint_os: "linux",
      fingerprint_locale: "en-US",
      headless: true,
      wall_ms: 60000,
      memory_mb: 1024,
    },
    state_root: "substrate/browser",
    initial_score: 0.75,
    initial_confidence: 0.65,
    fixture_input: { url: "https://example.com" },
    fixture_expected_residual: 0.0,
    display_name: "browser_session_act",
  },
  {
    seedName: "shell_run",
    runtime: "bun",
    // Phase-G honest impl: Bun.spawnSync against the declared argv. The
    // sandbox decl's proc_allow is advisory at the bun layer (see
    // sandbox.ts) — this body checks the argv[0] against the allow list at
    // run time and refuses if it's missing. Cooperating-script enforcement
    // for the Phase-G surface.
    body: [
      "const inputs = JSON.parse(process.env.ACC2_INPUTS ?? 'null');",
      "const allow = JSON.parse(process.env.ACC2_SANDBOX_PROC_ALLOW ?? '[]');",
      "const argv = inputs.argv ?? [];",
      "if (argv.length === 0) {",
      "  console.log('@@RESULT@@ ' + JSON.stringify({ ok: false, error: 'argv_empty' }));",
      "  process.exit(0);",
      "}",
      "if (allow.length > 0 && !allow.includes(argv[0])) {",
      "  console.log('@@RESULT@@ ' + JSON.stringify({ ok: false, error: 'proc_not_allowed:' + argv[0] }));",
      "  process.exit(0);",
      "}",
      "const proc = Bun.spawnSync({ cmd: argv, stdout: 'pipe', stderr: 'pipe' });",
      "const stdout = new TextDecoder().decode(proc.stdout);",
      "const stderr = new TextDecoder().decode(proc.stderr);",
      "console.log('@@RESULT@@ ' + JSON.stringify({ ok: proc.exitCode === 0, exit_code: proc.exitCode, stdout, stderr }));",
    ].join("\n"),
    declared_sandbox: {
      runtime: "bun",
      proc_allow: ["echo", "ls", "cat"],
      cpu_ms: 5000,
      wall_ms: 10000,
      memory_mb: 128,
    },
    state_root: "substrate/shell",
    initial_score: 0.80,
    initial_confidence: 0.70,
    fixture_input: { argv: ["echo", "ok"] },
    fixture_expected_residual: 0.0,
    display_name: "shell_run",
  },
  {
    seedName: "py_run",
    runtime: "uv",
    // Phase-G honest impl: a Python body that reads `source` from inputs,
    // exec()'s it under a captured namespace, then prints the captured
    // result. The runtime wrapper adds the json import + result-marker
    // emission; this body only authors the user-visible behaviour.
    body: [
      "src = inputs.get('source') if isinstance(inputs, dict) else None",
      "if not src:",
      "    print('@@RESULT@@ ' + json.dumps({'ok': False, 'error': 'no_source'}))",
      "else:",
      "    ns = {}",
      "    try:",
      "        exec(src, ns)",
      "        result = ns.get('result')",
      "        print('@@RESULT@@ ' + json.dumps({'ok': True, 'result': result}))",
      "    except Exception as e:",
      "        print('@@RESULT@@ ' + json.dumps({'ok': False, 'error': 'exec_failed:' + repr(e)}))",
    ].join("\n"),
    declared_sandbox: {
      runtime: "uv",
      pypi_allow: [],
      cpu_ms: 10000,
      wall_ms: 30000,
      memory_mb: 256,
    },
    state_root: "substrate/py",
    initial_score: 0.75,
    initial_confidence: 0.70,
    fixture_input: { source: "result = 'ok'" },
    fixture_expected_residual: 0.0,
    display_name: "py_run",
  },
  {
    // Reusable gap-contract action for strategic-governance decomposition.
    // The lesson (event 1WH7V4VBHD37968S22VPKD3MEG, task T_FATHER_GOVERNANCE_06)
    // observed that governance refinement subtasks land more useful when
    // each gap is packaged as an executable contract (action + scalar
    // verifier) instead of prose. ONE artifact pair (this body + the
    // verifier below) validates many ranked gap contracts because the
    // task-specific metric / gates ride in `inputs`.
    //
    // inputs: { gap_kind, target, current_state, desired_state,
    //           metric_name, evidence_event_ids[] }
    // result: { ok, contract_id, gap_kind, target, current_state,
    //           desired_state, metric_name, evidence_event_ids[] }
    seedName: "governance_gap_contract_action",
    runtime: "bun",
    body: [
      "const inputs = JSON.parse(process.env.ACC2_INPUTS ?? 'null') ?? {};",
      "const required = ['gap_kind', 'target', 'current_state', 'desired_state', 'metric_name'];",
      "const missing = required.filter((k) => !(k in inputs) || typeof inputs[k] !== 'string' || inputs[k].length === 0);",
      "if (missing.length > 0) {",
      "  console.log('@@RESULT@@ ' + JSON.stringify({ ok: false, error: 'missing_fields:' + missing.join(',') }));",
      "  process.exit(0);",
      "}",
      "const evidence = Array.isArray(inputs.evidence_event_ids) ? inputs.evidence_event_ids.filter((e) => typeof e === 'string' && e.length > 0) : [];",
      "if (evidence.length === 0) {",
      "  console.log('@@RESULT@@ ' + JSON.stringify({ ok: false, error: 'evidence_event_ids_empty' }));",
      "  process.exit(0);",
      "}",
      "// Stable contract id derived from gap_kind + target + metric_name so two",
      "// dispatches with the same gap shape land on the same canonical contract.",
      "const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 32);",
      "const contractId = 'gap_' + slug(inputs.gap_kind) + '__' + slug(inputs.target) + '__' + slug(inputs.metric_name);",
      "console.log('@@RESULT@@ ' + JSON.stringify({",
      "  ok: true,",
      "  contract_id: contractId,",
      "  gap_kind: inputs.gap_kind,",
      "  target: inputs.target,",
      "  current_state: inputs.current_state,",
      "  desired_state: inputs.desired_state,",
      "  metric_name: inputs.metric_name,",
      "  evidence_event_ids: evidence,",
      "}));",
    ].join("\n"),
    declared_sandbox: {
      runtime: "bun",
      cpu_ms: 2000,
      wall_ms: 5000,
      memory_mb: 128,
    },
    state_root: "substrate/governance/gap_contract",
    initial_score: 0.80,
    initial_confidence: 0.70,
    fixture_input: {
      gap_kind: "verifier_gap",
      target: "T_FATHER_GOVERNANCE_06",
      current_state: "refinement subtasks land as prose",
      desired_state: "refinement subtasks land as executable gap contracts",
      metric_name: "subtasks_with_scalar_verifier_ratio",
      evidence_event_ids: ["1WH7V4VBHD37968S22VPKD3MEG"],
    },
    fixture_expected_residual: 0.0,
    display_name: "governance_gap_contract_action",
  },
  {
    // Companion scalar verifier for governance_gap_contract_action. Reads
    // the upstream observation and returns residual=0 iff every required
    // field is present, evidence_event_ids is non-empty, and contract_id
    // matches the slug shape. Any other shape returns residual=1. The
    // verifier is task-agnostic — multiple ranked gap contracts share the
    // same code path while the action's inputs carry the task-specific
    // metric and evidence.
    seedName: "governance_gap_contract_verifier",
    runtime: "bun",
    body: [
      "const obs = JSON.parse(process.env.ACC2_INPUTS ?? 'null') ?? {};",
      "const required = ['contract_id', 'gap_kind', 'target', 'current_state', 'desired_state', 'metric_name'];",
      "const fieldsOk = obs.ok === true && required.every((k) => typeof obs[k] === 'string' && obs[k].length > 0);",
      "const evidenceOk = Array.isArray(obs.evidence_event_ids) && obs.evidence_event_ids.length > 0",
      "  && obs.evidence_event_ids.every((e) => typeof e === 'string' && e.length > 0);",
      "const contractIdOk = typeof obs.contract_id === 'string' && /^gap_[a-z0-9_]+__[a-z0-9_]+__[a-z0-9_]+$/.test(obs.contract_id);",
      "const residual = fieldsOk && evidenceOk && contractIdOk ? 0 : 1;",
      "console.log('@@RESULT@@ ' + JSON.stringify({ residual }));",
    ].join("\n"),
    declared_sandbox: {
      runtime: "bun",
      cpu_ms: 2000,
      wall_ms: 5000,
      memory_mb: 128,
    },
    state_root: "substrate/governance/gap_contract/verifier",
    initial_score: 0.80,
    initial_confidence: 0.70,
    fixture_input: {
      ok: true,
      contract_id: "gap_verifier_gap__t_father_governance_06__subtasks_with_scalar_verifier_ra",
      gap_kind: "verifier_gap",
      target: "T_FATHER_GOVERNANCE_06",
      current_state: "refinement subtasks land as prose",
      desired_state: "refinement subtasks land as executable gap contracts",
      metric_name: "subtasks_with_scalar_verifier_ratio",
      evidence_event_ids: ["1WH7V4VBHD37968S22VPKD3MEG"],
    },
    fixture_expected_residual: 0.0,
    display_name: "governance_gap_contract_verifier",
  },
];

export type CodeArtifactSeedSummary = { inserted: number; skipped: number };

const seedIdFor = (seedName: string): string => `seed_${seedName}`;

export const seedCodeArtifacts = (db: Database): CodeArtifactSeedSummary => {
  let inserted = 0;
  let skipped = 0;
  const initialStatus: CodeArtifactStatus = "admitted";

  withImmediateTransaction(db, () => {
    for (const seed of SEED_ARTIFACTS) {
      const id = seedIdFor(seed.seedName);
      const existing = db.query("SELECT id FROM code_artifact WHERE id = ?").get(id);
      if (existing) {
        skipped++;
        continue;
      }
      const ts = nowIso();
      const alpha = 1 + seed.initial_score * 4;
      const beta = 1 + (1 - seed.initial_score) * 4;
      db.run(
        `INSERT INTO code_artifact (
           id, runtime, body, declared_sandbox, state_root,
           posterior_alpha, posterior_beta, score, confidence,
           recent_residual_mean, recent_kill_count, status, name,
           fixture_input, fixture_expected_residual,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          seed.runtime,
          seed.body,
          JSON.stringify(seed.declared_sandbox),
          seed.state_root,
          alpha,
          beta,
          seed.initial_score,
          seed.initial_confidence,
          0.0,
          0,
          initialStatus,
          seed.display_name,
          JSON.stringify(seed.fixture_input),
          seed.fixture_expected_residual,
          ts,
          ts,
        ],
      );
      inserted++;
    }
  });

  return { inserted, skipped };
};

/** Convenience helper — primarily for tests / the daemon boot path.
 *  Returns the canonical seed ids so callers can join against them. */
export const seedArtifactIds = (): string[] => SEED_ARTIFACTS.map((s) => seedIdFor(s.seedName));

// ── Seed recipes (§15 Tier-0 priors) ─────────────────────────────────
//
// Recipes are normally extracted from real `task_committed` traces via
// `extractRecipeCandidates` (substrate/extractors.ts) once ≥3 successful
// replays of the same goal_shape × topology accumulate. Day-1 substrates
// have zero trace history, so the recipe-replay lane is dead until the
// first dozen tasks have committed — that starves the Tier-0 cost
// compression path described in v2-design.md §15.
//
// `seedRecipes` lays down canonical priors for goal shapes the brain
// will see repeatedly in practice (URL title fetch + arithmetic). The
// recipes seed at confidence=0.7 (above the default replay threshold
// 0.6, below the "promoted" mark) so they're elective from cycle one but
// can decay quickly if reality contradicts them (failed replay −0.10,
// auto-archive < 0.2).
//
// Idempotent via meta gate (re-running the same install does NOT
// duplicate rows). Each seeded recipe references real seed code-artifact
// ids so `runArtifactByRuntime` in replay can resolve them.

const META_SEEDED_RECIPES = "seed:recipes";

type SeedRecipe = {
  /** Canonical English description of the goal — fed through `goalShape`
   *  so the matcher collides on the same hash a real user directive
   *  would produce. */
  goalText: string;
  /** Stable display label for the recipe's canonical_id. */
  label: string;
  /** Per-step trajectory — action artifact + optional verifier. */
  trajectory: Array<{
    action_artifact_id: string;
    verifier_artifact_id: string | null;
    payload_template: Record<string, unknown>;
    predicted_residual: number;
  }>;
};

// Onboarding demo capabilities — substrate-native semantic retrieval.
//
// Owner pushback (2026-05-15): "DEMO MATCHER not universal — we should
// use semantic knowledge about the user to understand how to align
// with him better." The earlier `tokens_any` keyword table was a
// category error: keyword matching doesn't translate across languages,
// doesn't compound, doesn't respect the owner's vocabulary, and
// duplicates a primitive the substrate already provides — embedded
// semantic retrieval over the event ledger.
//
// What stayed: rich first-person capability descriptions (one per
// demo) phrased in plain everyday language a non-technical owner
// would say in their own words ("I want to lose weight", "should I
// switch jobs", "I keep redoing this every Monday"). No developer
// vocabulary. No service-specific assumptions.
//
// What changed: these descriptions are SEEDED INTO THE SUBSTRATE as
// knowledge_candidate + knowledge_promoted pairs by `seedDemoKnowledge`
// below. The embedder vectorizes them on its next tick; the brain's
// prompt composer surfaces them via `promoted_knowledge_view` ranked
// by semantic similarity to the owner's directive — automatically,
// in any language, without a keyword table.
//
// As the owner accumulates their own owner_input_received history +
// owner_profile signals, real conversational evidence outranks these
// seed demos naturally. No suppression logic needed; the substrate's
// posterior loop handles it. The categorial DemoRecipeId names below
// are RETRIEVAL TAGS, not categories — they let the brain reference a
// specific capability by id when proposing it, but the seed is the
// authoritative source of truth (every demo is a row in the ledger).
//
// Each demo is wired to exercise ONE substrate capability that NO
// chat-based LLM can replicate:
//   - `lifecycle: rolling_active` → persists across sessions, daemon
//     reopens the review subtask on cadence (a chat starts over)
//   - `compounds_via: knowledge_promoted` → every retrieval mutates the
//     Beta posterior; the answer next week is sharper than this week
//   - `owner_profile_grounded` → answer is conditioned on persistent
//     owner facts (constraints, hot_topics, things_to_never_do)
//   - `father_ranked` → daemon picks the next session for the owner
//   - `stakeholder_tracked` → counterparty history persists across
//     every conversation about that person/org
//   - `recipe_compounds` → workflow observed once becomes a callable
//     trajectory the substrate can replay
//
// Given one owner sentence, `tokens_any` routes to the most-confident
// demo; the orchestrator (Claude Code) reads back the matched
// `first_demo_prompt` in the owner's language and offers the next
// concrete step. Confidence ordering is intentional — universal demos
// (learn_topic_deeply, finish_my_goal) score higher than narrow vertical
// matches.

export type DemoRecipeId =
  | "learn_topic_deeply"
  | "keep_an_eye_on"
  | "finish_my_goal"
  | "make_my_decision"
  | "remember_my_life"
  | "negotiate_for_me"
  | "kill_my_recurring_friction"
  | "find_my_next_move";

/** The substrate capability each demo exercises — used by docs/UX to
 *  explain WHY the owner should care, not to filter routing. */
export type DemoSubstrateCapability =
  | "rolling_active"
  | "knowledge_compounds"
  | "owner_profile_grounded"
  | "father_ranked"
  | "stakeholder_tracked"
  | "recipe_compounds";

export type DemoCapability = {
  id: string;
  demo_recipe_id: DemoRecipeId;
  /** Auth the demo NEEDS to actually fire. Empty means it works with
   *  zero external services — just the brain + the substrate. */
  requires_auth: Array<"OPENAI_API_KEY" | "SERPER_API_KEY" | "opencode">;
  /** Confidence the demo is universally valuable (seed-time prior).
   *  Embedded into the knowledge_promoted payload; the substrate's
   *  posterior loop adjusts from real owner outcomes over time. */
  confidence: number;
  /** "finite" closes on terminal; "rolling_active" stays open and the
   *  Father reopens the review subtask on cadence. */
  lifecycle: "finite" | "rolling_active";
  /** One short sentence the orchestrator reads to the owner in their
   *  language. No developer words. No service names. This is the
   *  TEXT EMBEDDED into the substrate — the embedder vectorizes it
   *  and substrate.search ranks it against owner directives semantically. */
  first_demo_prompt: string;
  /** Why this demo can't be replicated by a fresh chat session. Used as
   *  evidence on the seeded knowledge_candidate so the brain can cite
   *  the differentiator when proposing the demo. */
  substrate_capability: DemoSubstrateCapability[];
};

export const DEMO_CAPABILITIES: DemoCapability[] = [
  {
    id: "learn_topic_deeply_rolling",
    demo_recipe_id: "learn_topic_deeply",
    requires_auth: [],
    confidence: 0.88,
    lifecycle: "rolling_active",
    first_demo_prompt:
      "Pick a topic you wish you understood better. I'll learn it for you a little more every week — every time we talk, I'll know more about it than last time. A chat would start over.",
    substrate_capability: ["rolling_active", "knowledge_compounds"],
  },
  {
    id: "keep_an_eye_on_anything",
    demo_recipe_id: "keep_an_eye_on",
    requires_auth: [],
    confidence: 0.86,
    lifecycle: "rolling_active",
    first_demo_prompt:
      "Tell me anything you'd like me to keep an eye on — a website, a person, a price, a topic. I'll only ping you when something actually changes. Want to point me at it?",
    substrate_capability: ["rolling_active", "knowledge_compounds"],
  },
  {
    id: "finish_my_goal_weekly",
    demo_recipe_id: "finish_my_goal",
    requires_auth: [],
    confidence: 0.85,
    lifecycle: "rolling_active",
    first_demo_prompt:
      "Tell me a goal you've been putting off. I'll break it into the smallest first step, keep one ready for you every week, and check in on what worked. The plan won't disappear.",
    substrate_capability: ["rolling_active", "father_ranked"],
  },
  {
    id: "make_my_decision_grounded",
    demo_recipe_id: "make_my_decision",
    requires_auth: [],
    confidence: 0.83,
    lifecycle: "finite",
    first_demo_prompt:
      "Tell me a decision you're stuck on. I'll weigh it against what you've already told me about yourself, ask about the gaps, and lay out the trade-offs. Next time, I'll already know your context.",
    substrate_capability: ["owner_profile_grounded", "knowledge_compounds"],
  },
  {
    id: "remember_my_life",
    demo_recipe_id: "remember_my_life",
    requires_auth: [],
    confidence: 0.92,
    lifecycle: "rolling_active",
    first_demo_prompt:
      "Tell me anything you want me to remember about you — how you work, what you care about, what's off-limits, who matters to you. I'll keep it forever and use it the next time we talk.",
    substrate_capability: ["owner_profile_grounded"],
  },
  {
    id: "negotiate_for_me",
    demo_recipe_id: "negotiate_for_me",
    requires_auth: [],
    confidence: 0.81,
    lifecycle: "rolling_active",
    first_demo_prompt:
      "Tell me who you're talking to and what you need from them. I'll remember them — their history with you, what they responded to before — every time you come back about them. A chat forgets the moment you close the tab.",
    substrate_capability: ["stakeholder_tracked", "owner_profile_grounded"],
  },
  {
    id: "kill_my_recurring_friction",
    demo_recipe_id: "kill_my_recurring_friction",
    requires_auth: [],
    confidence: 0.79,
    lifecycle: "rolling_active",
    first_demo_prompt:
      "Tell me one thing you redo every week. I'll watch you do it once, turn it into a routine I can run for you, and only ask you when something genuinely needs your judgment. It'll get faster every time.",
    substrate_capability: ["recipe_compounds", "knowledge_compounds"],
  },
  {
    id: "find_my_next_move",
    demo_recipe_id: "find_my_next_move",
    requires_auth: [],
    confidence: 0.77,
    lifecycle: "finite",
    first_demo_prompt:
      "List the things you've been meaning to do. I'll pick the one most likely to actually move the needle for you right now — using what I know about your goals, energy, and what's already in flight.",
    substrate_capability: ["father_ranked", "owner_profile_grounded"],
  },
];

export const composeDemoCapabilityProposal = (
  cap: DemoCapability,
  ownerProfile: Pick<OwnerProfile, "rendering_signals" | "preferred_terms" | "detected_language" | "observation_count"> = {},
  ownerWords = "",
): string => {
  const signals = ownerProfile.rendering_signals ?? {};
  const lowTechnical = (signals.code_density ?? 0) < 0.4 && (signals.ops_vocabulary ?? 0) < 0.4;
  const oneStep = (signals.one_step_at_a_time_vs_batch ?? 0.5) >= 0.5;
  const examples = (signals.concrete_examples_appetite ?? 0) >= 0.5;
  const term = ownerProfile.preferred_terms?.find((t) => ownerWords.toLowerCase().includes(t.toLowerCase())) ?? "this";
  const firstLine = lowTechnical
    ? cap.first_demo_prompt
    : `Proposal: run ${cap.demo_recipe_id} (${cap.lifecycle}) using ${cap.substrate_capability.join(", ")}.`;
  const frame = ownerWords.trim().length > 0 ? `For what you said ("${ownerWords.trim().slice(0, 120)}"), ` : "";
  const next = oneStep ? `First step: tell me the smallest useful detail about ${term}.` : "Options: start now, narrow the scope, or skip.";
  const example = examples ? " Example: give me one goal, person, page, or repeated task to remember." : "";
  return `${frame}${firstLine} ${next}${example}`.trim();
};

// META key for the demo-knowledge seed — idempotency marker.
const META_SEEDED_DEMO_KNOWLEDGE = "seed:demo_knowledge";

export type DemoKnowledgeSeedSummary = { imported: number };

/** Seeds each demo capability as a knowledge_candidate + knowledge_promoted
 *  pair so the substrate's embedded retrieval finds them by semantic
 *  similarity to whatever the owner says — universally, in any language,
 *  without a keyword table. Owner-approved gate (same posture as
 *  seedFoundationalKnowledge): no-op unless ownerApproved=true. */
export const seedDemoKnowledge = (
  db: Database,
  options?: { ownerApproved?: boolean },
): DemoKnowledgeSeedSummary => {
  if (!options?.ownerApproved) return { imported: 0 };
  if (readMeta(db, META_SEEDED_DEMO_KNOWLEDGE) !== null) return { imported: 0 };

  const directiveId = "dir_seed_demo_knowledge";
  const loopId = "loop_seed_demo_knowledge";
  const taskId = "task_seed_demo_knowledge";
  let imported = 0;

  withImmediateTransaction(db, () => {
    for (const cap of DEMO_CAPABILITIES) {
      const candidateId = newId();
      // The `claim` is the first_demo_prompt — that's what gets
      // embedded and searched. Tags + applies_to let the brain filter
      // these knowledge rows when explicitly looking for demos.
      db.run(
        `INSERT INTO events (
           id, ts, directive_id, task_id, loop_id, substrate_origin,
           kind, payload, context_refs
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          candidateId,
          nowIso(),
          directiveId,
          taskId,
          loopId,
          "substrate_auto",
          "knowledge_candidate",
          JSON.stringify({
            claim: cap.first_demo_prompt,
            evidence: [
              `substrate capability: ${cap.substrate_capability.join(", ")}`,
              `lifecycle: ${cap.lifecycle}`,
              ...(cap.requires_auth.length > 0
                ? [`requires: ${cap.requires_auth.join(", ")}`]
                : ["requires no external services"]),
            ],
            applies_to: ["demo", "onboarding", cap.demo_recipe_id, ...cap.substrate_capability],
            tags: ["demo", "onboarding", "first_run"],
            proposed_tier: "demo_capability",
            confidence_estimate: cap.confidence,
            demo_recipe_id: cap.demo_recipe_id,
            skip_corroboration: true,
          }),
          JSON.stringify([]),
        ],
      );
      const promoteId = newId();
      db.run(
        `INSERT INTO events (
           id, ts, directive_id, task_id, loop_id, substrate_origin,
           kind, payload, context_refs
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          promoteId,
          nowIso(),
          directiveId,
          taskId,
          loopId,
          "substrate_auto",
          "knowledge_promoted",
          JSON.stringify({
            candidate_id: candidateId,
            score: cap.confidence,
            confidence: cap.confidence,
            skip_corroboration: true,
            demo_recipe_id: cap.demo_recipe_id,
          }),
          JSON.stringify([candidateId]),
        ],
      );
      imported++;
    }
    writeMeta(db, META_SEEDED_DEMO_KNOWLEDGE, nowIso());
  });

  return { imported };
};

const SEED_RECIPES: SeedRecipe[] = [
  {
    // URL title fetch — uses seed_web_fetch_and_parse, which returns
    // `{ok, url, title, text}`. The replay lane will set `recipe_replayed:true`
    // and stamp the recipe id on every per-step action_predicted event.
    goalText: "fetch URL title",
    label: "fetch_url_title",
    trajectory: [
      {
        action_artifact_id: "seed_web_fetch_and_parse",
        // No verifier seed exists today; the recipe-replayer treats a
        // null verifier as residual=0 when the action returns ok=true.
        // Phase J can replace this with a content-presence verifier once
        // an authored verifier seed lands.
        verifier_artifact_id: null,
        payload_template: { url: "https://example.com" },
        predicted_residual: 0,
      },
    ],
  },
  {
    // Arithmetic — uses seed_py_run which exec()s the provided source.
    // The brain's typical arithmetic dispatch fills `source` from the
    // owner's directive text; the recipe captures the topology only,
    // not a literal expression.
    goalText: "arithmetic",
    label: "arithmetic",
    trajectory: [
      {
        action_artifact_id: "seed_py_run",
        verifier_artifact_id: null,
        payload_template: { source: "result = 2 + 2" },
        predicted_residual: 0,
      },
    ],
  },
];

export type RecipeSeedSummary = { count: number };

export const seedRecipes = (db: Database): RecipeSeedSummary => {
  if (readMeta(db, META_SEEDED_RECIPES) !== null) {
    return { count: 0 };
  }

  const directiveId = "dir_seed_recipes";
  const loopId = "loop_seed_recipes";
  let count = 0;

  withImmediateTransaction(db, () => {
    for (const recipe of SEED_RECIPES) {
      const goal = goalShape(recipe.goalText);
      // Topology signature mirrors `extractRecipeCandidates`: degenerate
      // single-root trajectory. The replay matcher accepts a recipe
      // whose topology endsWith("::1") as a wildcard against any
      // single-task DAG, so this is the minimal-binding shape.
      const topology = `topo_00000000::1`;
      const trajectory = recipe.trajectory.map((step) => ({
        step_kind: "action_predicted" as const,
        artifact_id: step.action_artifact_id,
        verifier_artifact_id: step.verifier_artifact_id,
        payload_template: step.payload_template,
        predicted_residual: step.predicted_residual,
      }));
      const recipeId = newId();
      const taskId = `task_seed_recipe_${recipe.label}`;
      db.run(
        `INSERT INTO events (
           id, ts, directive_id, task_id, loop_id, substrate_origin,
           kind, payload, context_refs
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          recipeId,
          nowIso(),
          directiveId,
          taskId,
          loopId,
          "substrate_auto",
          "recipe_extracted",
          JSON.stringify({
            goal_shape: goal,
            goal_text: recipe.goalText,
            label: recipe.label,
            topology_signature: topology,
            confidence: 0.7,
            success_count: 0,
            window_days: 30,
            directive_ids: [],
            trajectory,
            seeded: true,
            skip_corroboration: true,
          }),
          JSON.stringify(recipe.trajectory.map((s) => s.action_artifact_id)),
        ],
      );
      count++;
    }
    writeMeta(db, META_SEEDED_RECIPES, nowIso());
  });

  return { count };
};

/** Convenience helper — primarily for tests. Returns the canonical
 *  goal texts seeded by `seedRecipes` so tests can assert on them
 *  without re-hashing. */
export const seedRecipeGoalTexts = (): string[] => SEED_RECIPES.map((r) => r.goalText);
