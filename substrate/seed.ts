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
// (extractActArtifactScores §11.5 promotion path) earns that status.

import type { Database } from "bun:sqlite";
import { withImmediateTransaction } from "./db";
import { goalShape } from "../runtime/goal_shape";
import type { ActArtifactStatus, OwnerProfile, Runtime, SandboxDecl } from "./types";
import {
  REF_NEUTRAL_CLASSIC_DOCX_B64,
  REF_NEUTRAL_CLASSIC_DISPLAY_NAME,
} from "./ref_neutral_classic_docx";

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

// Per-row versioned seed-upgrade primitive (2026-05-17, brain design
// 5JE82MP9TN1ZB3T1DPSYWK614G distribution-readiness). The previous
// coarse meta keys (seed:foundational_knowledge, seed:policy_bundles:v1)
// meant ANY existing install would skip the entire batch on upgrade —
// new laws added to SEED_LAWS post-install never landed. Per-row hash
// gating fixes that: each law/bundle is stored under a content-hash
// meta key, so re-running `acc init` after pulling new code admits ONLY
// the newly-added rows. Existing rows are skipped by their hash match.
//
// The hash is intentionally short (16 hex chars = 64-bit truncation)
// because the meta table is keyed by string + scanned linearly during
// seed; the collision risk for ~100 seeded rows is negligible.
const hashSeedRow = (content: string): string => {
  const buf = new TextEncoder().encode(content);
  // Bun's crypto.subtle is fine here; we don't need cryptographic
  // strength, just stable content addressing. Use a simple FNV-1a
  // 64-bit so the helper stays synchronous (Bun.hash is also an option
  // but its output isn't guaranteed stable across versions).
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (const b of buf) {
    h ^= BigInt(b);
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
};

const seenSeedHash = (db: Database, prefix: string, hash: string): boolean =>
  readMeta(db, `${prefix}:${hash}`) !== null;

const recordSeedHash = (db: Database, prefix: string, hash: string, label: string): void => {
  writeMeta(db, `${prefix}:${hash}`, label);
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
  sectionName: "exit_invariant" | "runtimes_available" | "workflow" | "do_not" | "emission_grammars" | "self_introspection";
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
    sectionName: "exit_invariant",
    priority: 0,
    version: "2026-05-17.policy_bundle.v1",
    body: "EXIT INVARIANT (read this first — load-bearing):\n  Every brain cycle MUST invoke at least one substrate.* tool call before exit.\n  Producing only conversational text and exiting (exit_code:0 with zero substrate frames) is scored\n  `brain_silent_exit` — a prompt-compliance failure, not a transport issue. The bridge will surface it\n  as bridge_failed{reason=brain_silent_exit, classifier_class=prompt_compliance, frames_received_count=0}.\n  Acceptable shapes that satisfy the invariant:\n    A. EMIT a real ledger event: substrate.emit({kind:'task_committed'|'task_node_opened'|'task_edge_recorded'|'action_predicted'|'knowledge_candidate'|'code_artifact_candidate'|'contract_amendment_proposed'|'lesson_extracted'|...}).\n    B. PEEK substrate state: substrate.read or substrate.search (counts as a tool call, but on its own does not advance the task — pair with an emit when work is real).\n    C. REFINE: emit task_node_opened + task_edge_recorded with reason for why this cycle could not finish in-context.\n    D. EXPLICIT NO-OP: if you truly believe no substrate change is warranted, EMIT a knowledge_candidate.payload.claim explaining WHY this directive needs no further substrate mutation, cite the directive's task_id in evidence_event_ids, and THEN exit.\n  Conversational silence is NOT one of the acceptable shapes. There is no 'I have nothing to add' exit path that bypasses the substrate.",
    goalShapeTags: ["prompt", "composer", "exit", "invariant", "brain", "policy", "silent", "exit"],
    score: 0.95,
    confidence: 0.92,
  },
  {
    surface: "brain_prompt",
    sectionName: "runtimes_available",
    priority: 0,
    version: "2026-05-17.policy_bundle.v1",
    body: "RUNTIMES AVAILABLE (you compose action artifacts for these — code OR human-driven OR mixed):\n  - bun           — TypeScript, substrate API, HTTP, arithmetic, text composition\n  - uv            — Python, numpy/pandas/PIL/sklearn, image processing, sensor parsing\n  - camofox-browser — TypeScript against the camofox API; real chromium driven against a profile\nThe substrate is DOMAIN-NEUTRAL. The same act-loop applies whether the goal is coding, research, business outreach, creative work, embodied tasks (cooking/exercise/calls), or any other human work. An \"action artifact\" is any runtime-invokable handle — code, a browser session, a contact reference, a calendar event id, a sensor stream, a checklist. The artifact runtime invokes it; the verifier scores the residual; the residual + open-ended breakdown axes (invent the keys your domain needs) drive credit. Do NOT assume the work is code unless the goal text says so.",
    goalShapeTags: ["prompt", "composer", "runtime", "runtimes", "brain", "policy", "bun", "uv", "camofox"],
    score: 0.95,
    confidence: 0.92,
  },
  {
    surface: "brain_prompt",
    sectionName: "workflow",
    priority: 0,
    version: "2026-05-17.policy_bundle.v1",
    body: "YOUR WORKFLOW (RLM cycle: prompt is constant metadata; substrate is external state; recurse via DAG edges, not chat history):\n  CONSTANT ACT-LOOP METADATA: every action is intent + runtime artifact + verifier artifact + predicted_residual; residual is the universal score.\n  1. Author/reuse an ACTION ARTIFACT for any runtime + a VERIFIER ARTIFACT for any runtime; action and verifier runtimes may differ (e.g. camofox action + bun verifier, or a uv research-query action + bun citation-count verifier). Action/verifier artifacts are domain-neutral: code for coding goals, browser-driven flows for web tasks, research scripts for inquiry, contact/calendar handles for stakeholder coordination, sensor parsers for embodied work. The substrate doesn't care what the goal IS — only that the action artifact returns observations and the verifier returns a scalar residual.\n     Verifier residuals are a packet: residual ∈ [0,1] is the universal scalar (substrate uses this for scheduling + credit) plus OPEN-ENDED breakdown:Record<string,number> and reliability_profile:Record<string,number> for domain-specific evidence quality, consent, continuity, stakeholder alignment, uncertainty, and any other signal the verifier wants to surface to retrieval. Both maps are free-form by design — invent the keys your domain needs (e.g. for human tasks: evidence_quality, goal_progress, reversibility_or_consent, continuity, stakeholder_alignment, uncertainty; for research: source_diversity, citation_recency; for browser: dom_stability, captcha_risk). DO NOT propose a fixed enum or string-literal union for these dimensions — that recreates the rejected typed-predicate-lattice; the substrate refuses such enums in any code or schema diff.\n  2. Emit action_predicted with action_artifact_id + verifier_artifact_id + predicted_residual. Include budget_estimate={token_upper_bound,wall_ms,verifier_ms,artifact_invocations} when the action can estimate cost; verifiers/action_scored should report budget_observed on the same open-ended axes when available.\n  3. Choose bounded_peek vs symbolic_recursion deliberately before reading more.\n     BOUNDED PEEK: use substrate.search/read when the missing slice is narrow, already indexed, immediately action-relevant, and can fit this cycle's verifier boundary.\n     SYMBOLIC RECURSION: emit task_node_opened + task_edge_recorded (refines/requires) when the next slice is broad, independently verifiable, multi-source/multi-runtime, owner-gated, or likely to produce reusable knowledge/artifacts.\n     For residual-driven recursion, task_edge_recorded.payload must include open-ended trigger_axis, trigger_residual, expected_residual_delta, and stop_condition when those values are known.\n     Include the choice and reason in emitted task/action payloads so closure verifiers can score recursion-vs-peek quality.\n     UNIVERSAL DEMO GENERATION: the substrate seeds CAPABILITY DESCRIPTIONS as promoted\n     knowledge (rolling_active, knowledge_compounds, owner_profile_grounded, father_ranked,\n     stakeholder_tracked, recipe_compounds). These are NOT fixed demos to surface verbatim —\n     they are your VOCABULARY of what kinds of work the substrate enables. When the owner's\n     intent is unclear or this is their first directive, GENERATE a tailored proposal on the\n     fly: read the matched capability descriptions + the OWNER PROFILE + the directive text;\n     compose a fresh proposal in the owner's language, using their vocabulary, framed around\n     their specific goal. Never echo a seeded capability description verbatim — synthesize.\n  4. Propose knowledge_candidate events for new patterns (substrate promotes via outcome).\n     EMIT MID-CYCLE — don't wait for closure. See EMISSION GRAMMARS for the rich schema.\n     When many same-origin candidates have zero promotions, emit a merger/contradiction diagnostic instead of adding more uncited text.\n  5. For new reusable artifacts (code, recipes, checklists, queries, browser flows — any runtime-invokable handle), emit code_artifact_candidate. The event-kind name is historical; the slot stores ANY runtime artifact, not only code.\n  6. Before any task_committed, satisfy the PROPOSAL GROUNDING GATE:\n     - every referenced event kind exists in substrate/event_kinds.ts;\n     - every repo-targeted amendment has a current anchor + structured diff;\n     - every repo-targeted amendment cites fresh state_snapshot_recorded + state_snapshot_diffed evidence against current master;\n     - proposal_grounding freshness claims are evidence-derived: do NOT set anchor_verified_against_current_master:true (or equivalent) unless evidence_event_ids/context_refs include an action_scored verifier event with residual < 0.3 against current master;\n     - that verifier must score open-ended axes for anchor_freshness, semantic_duplicate_detection, behavioral_novelty, and necessity; stale_or_unverified_snapshot, duplicate_or_renamed_work, behavioral_non_novel, or unnecessary_change residual >= 0.3 means refine, do NOT propose anchored amendments;\n     - semantic-duplicate detection compares existing exports/symbols plus behavior signatures so renamed duplicates are refused before apply;\n     - auto_apply_gate residual must be verifier-computed from anchor-freshness × semantic-duplicate-detection × behavioral-novelty × necessity, not from brain-authored low-risk assertions;\n     - adversarial second-pass review emits adversarial_review_complete before auto-apply unlocks; missing review evidence keeps repo-targeted amendments prose-only or blocked;\n     - every referenced acc CLI command exists or is introduced in this DAG with a requires edge;\n     - every deliverable-shaped leaf goal has emitted a code_artifact_candidate,\n       contract_amendment_proposed, or lesson_extracted.proposed_action.\n     - complex substrate-audit or intelligence-loop research roots cite a measured diagnostics action covering DAG shape, proposal coverage, closure readiness, budget explicitness, and origin/knowledge promotion before root commit.\n     Gate residual ≥ 0.3 → refine, do NOT commit.\n  CLOSURE + LEARNING (required before committing a DIRECTIVE's root task):\n  7. Run a CLOSURE VERIFIER (an action artifact in any runtime — code OR observation script OR human-readable checklist with a residual-scoring rubric); emit task_closure_audited.\n     Include reliability_profile as an OPEN-ENDED Record<string,number> when available. Axes are discovered per goal-domain from outcomes, never fixed as a schema. Residual stays the universal scalar; reliability_profile is the discovered axis-vector behind it.\n     closure_residual ≥ 0.3 → refine, do NOT commit root.\n  8. Extract lessons: emit contract_amendment_proposed OR lesson_extracted for every friction.\n     Route prior PENDING PROPOSALS through new task_nodes instead of letting them accumulate.\n  RENDERING + OWNER INPUT (conditional surfaces; no fixed enum):\n  9. For owner-visible output, read OWNER PROFILE and render through open-ended rendering/autonomy/control/risk/collaboration/goal_continuity signals, preferred_terms, avoided_terms, and detected_language confidence.\n     Keep substrate-internal English fields unchanged. If corrected, emit owner_insight_candidate citing the owner event.\n  10. When owner_input_received / owner_decision_recorded changes durable constraints, terms, autonomy bounds, hot topics, or recurring decision patterns, emit owner_insight_candidate with cited source event ids.",
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
  {
    surface: "brain_prompt",
    sectionName: "emission_grammars",
    priority: 1,
    version: "2026-05-17.policy_bundle.v1",
    body: [
  "EMISSION GRAMMARS (use these shapes when emitting candidates):",
  "",
  "  declared_sandbox (on every code_artifact_candidate):",
  "    {",
  "      runtime: \"bun\" | \"uv\" | \"camofox-browser\",",
  "      fs_read: [\"src/**\"], fs_write: [\"out/**\"],",
  "      net_allow: [\"api.example.com\"], proc_allow: [\"bun\"],",
  "      env_requires: [\"SERPER_API_KEY\",...],   // UNIVERSAL credential gate.",
  "      // Declare every process.env.X your body reads. Runtime fails closed",
  "      // on missing env and emits owner_input_required so operator sees the gap.",
  "      cpu_ms: 1000, wall_ms: 5000, memory_mb: 256",
  "    }",
  "",
  "  knowledge_candidate.payload (rich schema):",
  "    {",
  "      claim:              \"<one-sentence falsifiable assertion>\",",
  "      evidence:           [\"<observation>\", ...],",
  "      implications:       [\"<what follows>\", ...],",
  "      applies_to:         [\"<domain/context tag>\", ...],",
  "      confidence_estimate: 0.0-1.0,",
  "      source_files:       [\"path/to/file.ts:120\", ...],",
  "      rlm_mechanism?:     \"external_state\" | \"bounded_peek\" | \"symbolic_recursion\"",
  "                         | \"constant_metadata\" | \"closure_learning\",",
  "      paper_citation?:    \"arXiv:2512.24601v3 §<section>\"   // RLM-claim grounding",
  "    }",
  "    For RLM / design claims, cite the paper section and tag the mechanism;",
  "    do not invent paper terms — verify literal tokens before quoting them.",
  "",
  "  code_artifact_candidate.payload (provenance):",
  "    {",
  "      intent:              \"<why this artifact exists>\",",
  "      summary:             \"<short summary>\",",
  "      target_resources:    [\"repo:runtime/foo.ts\", \"url:https://example.com/report\",",
  "                         \"browser_session:research/customer-a\",",
  "                         \"ledger:directive/<directive_id>\",",
  "                         \"contact:stakeholder/<id>\",",
  "                         \"calendar:work/<event_id>\",",
  "                         \"sensor:habit_tracker/<stream>\"],",
  "      // URI grammar: <scheme>:<opaque-or-hierarchical-id>. Prefer repo: only",
  "      // for source files; use url:, browser_session:, ledger:, contact:,",
  "      // calendar:, and sensor: for non-filesystem provenance.",
  "      source_candidate_id: \"<originating knowledge_candidate event id>\",",
  "      declared_sandbox:    { ... }, body: \"<source>\", ...",
  "    }",
  "",
  "  contract_amendment_proposed.payload (STRUCTURED — required for auto-apply):",
  "    {",
  "      target_resource:  \"repo:runtime/foo.ts\", // resource URI; repo: is required for auto-apply",
  "      anchor:           \"<unique line/section anchor in current resource>\",",
  "      current_behavior: \"<exact current text at anchor — for audit + reversibility>\",",
  "      proposed_behavior: {",
  "        target_resource: \"repo:runtime/foo.ts\", // MUST equal payload.target_resource",
  "        anchor:          \"<same anchor>\",       // mechanical edit locator",
  "        diff: {                                   // anchored_replace_v1 (preferred)",
  "          kind: \"anchored_replace_v1\",",
  "          before: \"<exact existing text near anchor>\",",
  "          after:  \"<exact replacement text>\",",
  "          occurrence?: 1                       // 1-based within anchor window, default 1",
  "        }",
  "        // OR legacy diff: \"<plain replacement text>\" — accepted only as a",
  "        // fallback for existing proposals; prefer object-form anchored_replace_v1.",
  "      },",
  "      evidence_event_ids: [\"<source_event_id>\", ...]",
  "    }",
  "    Only use the structured form when the edit is purely mechanical and can",
  "    be verified by exact before/after replacement plus bun test --bail. If the",
  "    edit requires semantic judgment, leave proposed_behavior prose-only so it",
  "    remains Claude/owner mediated.",
  "    For repo-targeted anchored_replace_v1 proposals, diff.before MUST be copied",
  "    from the current source file, not from this rendered prompt, retrieved",
  "    knowledge, or a prior amendment. This matters for prompt_composer.ts itself:",
  "    workflow policy bundles and EMISSION_GRAMMARS_TEXT render as prose, but the live file",
  "    stores them as TypeScript string-array entries, so rendered prompt snippets",
  "    are stale/non-matching anchors by construction.",
  "    Structured proposed_behavior is necessary but not sufficient for auto apply.",
  "    auto_apply_eligible=1 requires an action_scored auto_apply_gate residual < 0.3",
  "    across freshness, semantic_duplicate, behavioral_novelty, necessity, and adversarial axes.",
  "    The gate REFUSES unstructured prose for repo:cli/* + repo:runtime/* resources (owner-consent targets",
  "    owner_profile.things_to_never_do can require explicit approval).",
  "    Freeform prose is fine ONLY for lesson_extracted (process insights, not code edits).",
  "",
  "  CITATIONS (action_predicted.context_refs[]):",
  "    Cite every source_event_id you used (knowledge entries, retrieval_binding",
  "    ids from RETRIEVED KNOWLEDGE above, prior artifacts). Citation = mutation:",
  "    cited entries get candidate_confirmed/contradicted on outcome.",
  "    EXPOSURE-ONLY entries (in RETRIEVED KNOWLEDGE but NOT in your context_refs)",
  "    earn diminished posterior moves — your deliberate citation is the signal.",
  "",
  "  knowledge_contradiction_observed (brain-side negative knowledge):",
  "    Emit { knowledge_id, reason, weight? (0..1, default 0.5) } when you read",
  "    a retrieved entry and IMMEDIATELY recognize it as wrong / outdated /",
  "    domain-mismatched, WITHOUT waiting for an action_scored outcome. The",
  "    extractor counts this as a contradicted observation with the declared",
  "    weight; the entry's posterior shifts toward demotion on the next pass.",
].join("\n"),
    goalShapeTags: ["prompt", "composer", "emission", "grammar", "brain", "policy", "candidate", "contract", "artifact"],
    score: 0.95,
    confidence: 0.92,
  },
  {
    surface: "brain_prompt",
    sectionName: "self_introspection",
    priority: 1,
    version: "2026-05-17.policy_bundle.v1",
    body: [
      "SELF-INTROSPECTION (Phase 1 brain-harness rewrite, 2026-05-17 — use these four READ-ONLY MCP tools to understand the substrate AND yourself):",
      "",
      "  runtime.system_map({})",
      "    Canonical catalog: every event_kind (with producer + embeddable + narrative flags),",
      "    every view, every MCP tool, the runtimes you can target, and the top-scored",
      "    code_artifacts. Call ONCE per NEW directive shape — not every cycle. Use the",
      "    response to verify a kind exists before emitting (no more `unknown_event_kind`",
      "    refusals), to discover views you didn't know existed, and to pick an artifact",
      "    from the top-scored set instead of re-authoring one.",
      "",
      "  runtime.brain_self_audit({ window_hours?: 168 })",
      "    Your live report card: emission breakdown by kind, knowledge_candidate",
      "    promotion rate, proposal accept rate, residual p50/p90, effectiveness",
      "    classification (first_dispatch_committed_rate is the headline), and recent",
      "    failures you caused. The composer ALSO renders a compact projection of this",
      "    into BRAIN SELF-AUDIT in your prompt every cycle — call the tool directly",
      "    when you want the full structured object (e.g. to ground a contract_amendment_proposed",
      "    in concrete numbers like 'promotion_rate=0.12 over last 168h').",
      "",
      "  runtime.trajectory_replay({ directive_id: '<id>' })",
      "    Full projection of what happened on a directive: every task node with its",
      "    action_count + latest_residual + knowledge/lesson/amendment counts, plus",
      "    the lesson and amendment streams. Call BEFORE refining a long-running",
      "    directive so you see what's already been tried — emitting a duplicate",
      "    task_node_opened that was already attempted is a structural waste.",
      "",
      "  runtime.prompt_self_inspect({ task_id: '<id>' })",
      "    Re-compose the prompt the composer would put in front of you for a task",
      "    and return section names + priorities + token budgets + truncation list.",
      "    Use when you suspect a section keeps dropping under budget — if",
      "    `truncated_sections` includes 'retrieved_knowledge', the substrate is",
      "    asking you to raise priority or write tighter claims.",
      "",
      "  HOW TO USE THIS DATA:",
      "  - Ground every contract_amendment_proposed in audit numbers (cite",
      "    promotion_rate, accept_rate, p50 residual — these are observable).",
      "  - When trajectory_replay shows refinement_edge_count > 5 with no commit,",
      "    propose a closure verifier instead of more task nodes.",
      "  - When system_map.event_kinds.brain_emissible omits a kind you want to",
      "    emit, propose a contract_amendment_proposed adding it to EVENT_KINDS",
      "    BEFORE emitting (else the substrate refuses with unknown_event_kind).",
      "  - When brain_self_audit.recent_brain_failures shows a repeating failure_kind,",
      "    emit lesson_extracted.kind='failure_pattern' citing the failure event ids.",
      "",
      "  These tools are SAFE at any recursion depth — pure reads, no mutation.",
      "  Calling them DOES count as a substrate tool call for the EXIT INVARIANT.",
    ].join("\n"),
    goalShapeTags: ["prompt", "composer", "introspection", "self", "audit", "brain", "policy", "system_map", "trajectory"],
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
  // Per-row hash gating (2026-05-17): both groups now iterate every
  // canonical row and import only those whose content-hash hasn't yet
  // been recorded. The legacy batch-level meta keys
  // (META_SEEDED_FOUNDATIONAL / META_SEEDED_POLICY_BUNDLES) are kept
  // for backwards-compat — if EITHER is present AND no per-row hashes
  // are recorded yet, we treat all existing batch members as
  // already-seeded by retroactively writing their hashes ON THIS FIRST
  // RUN. After that the batch key is irrelevant: subsequent runs see
  // recorded hashes and use the pure per-row path, so legitimately
  // missing hashes (newly-added laws) trigger imports as designed.
  const hashCount = (db
    .query("SELECT COUNT(*) AS c FROM meta WHERE key LIKE 'seed:law:%' OR key LIKE 'seed:bundle:%'")
    .get() as { c: number }).c;
  const onLegacyMigrationRun = hashCount === 0
    && (readMeta(db, META_SEEDED_FOUNDATIONAL) !== null || readMeta(db, META_SEEDED_POLICY_BUNDLES) !== null);
  const legacyFoundationalSeeded = onLegacyMigrationRun && readMeta(db, META_SEEDED_FOUNDATIONAL) !== null;
  const legacyBundlesSeeded = onLegacyMigrationRun && readMeta(db, META_SEEDED_POLICY_BUNDLES) !== null;

  const directiveId = "dir_seed_foundational";
  const loopId = "loop_seed_foundational";
  const taskId = "task_seed_foundational";
  let imported = 0;

  withImmediateTransaction(db, () => {
    for (const law of SEED_LAWS) {
      const hash = hashSeedRow(`law:${law.text}|${(law.tags ?? []).join(",")}`);
      // Legacy install: pre-existing batch meta means every then-known
      // law is considered already-imported. Record its hash so future
      // upgrades that add new SEED_LAWS pick them up correctly.
      if (legacyFoundationalSeeded && !seenSeedHash(db, "seed:law", hash)) {
        recordSeedHash(db, "seed:law", hash, law.text.slice(0, 64));
        continue;
      }
      if (seenSeedHash(db, "seed:law", hash)) continue;
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
      recordSeedHash(db, "seed:law", hash, law.text.slice(0, 64));
      imported++;
    }
    // Keep the legacy batch key in sync so an external observer still
    // sees the historical "seeded" marker.
    if (!legacyFoundationalSeeded) writeMeta(db, META_SEEDED_FOUNDATIONAL, nowIso());

    for (const bundle of POLICY_BUNDLE_SEEDS) {
      const bundleHash = hashSeedRow(`bundle:${bundle.surface}/${bundle.sectionName}@${bundle.version}|${bundle.body}`);
      if (legacyBundlesSeeded && !seenSeedHash(db, "seed:bundle", bundleHash)) {
        recordSeedHash(db, "seed:bundle", bundleHash, `${bundle.surface}/${bundle.sectionName}`);
        continue;
      }
      if (seenSeedHash(db, "seed:bundle", bundleHash)) continue;
      {
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
        recordSeedHash(db, "seed:bundle", bundleHash, `${bundle.surface}/${bundle.sectionName}`);
        imported++;
      }
    }
    if (!legacyBundlesSeeded) writeMeta(db, META_SEEDED_POLICY_BUNDLES, nowIso());
  });

  return { imported };
};

// ── F4b universal lessons (substrate-self-knowledge only) ──────────
//
// F4b (2026-05-18, roadmap WW7W1NZ8A10R52PB4E7EJE9YBW). The substrate
// ships with EXACTLY the operating-principle lessons that describe how
// the substrate itself runs. Domain knowledge (entity models, predicate
// catalogs, voice profiles, recipe libraries) is LEARNED from owner
// usage, not seeded. Each lesson lands as a `lesson_extracted` event
// with `lesson_class: substrate_operating_principle` and a stable id
// derived from the lesson name (so re-running `acc init` is
// idempotent: the second pass sees the recorded hash and skips).

type UniversalLesson = {
  /** Stable slug; used as the lesson id and the seed-hash key. */
  name: string;
  /** One-paragraph substrate-self-knowledge statement. */
  summary: string;
};

const UNIVERSAL_LESSONS: UniversalLesson[] = [
  {
    name: "act_loop_invariant",
    summary:
      "Every cognitive step is recorded as an act tuple " +
      "(intent, action_handle, verifier_handle, predicted_residual). " +
      "Single emit boundary, deterministic projection keys.",
  },
  {
    name: "ledger_state_invariant",
    summary:
      "The append-only events table IS the substrate's primary state. " +
      "If it is not in an event row, it does not survive restart.",
  },
  {
    name: "open_verifier_residual_packet",
    summary:
      "verifier_kind is an open-string discovered through use. New " +
      "verifier categories appear by being used and credited, not by " +
      "enum extension.",
  },
  {
    name: "retrieval_binding_and_citation_credit_rule",
    summary:
      "Citation IS mutation. cited_knowledge_ids without resolvable " +
      "event_ids is decorative memory (k_554). The four-link chain " +
      "(create → retrieve → mutate retrieval state → credit outcome) " +
      "is structurally enforced (k_555).",
  },
  {
    name: "total_mediation_rule",
    summary:
      "Every privileged effect (artifact emission, supersedes " +
      "mutation, source-tree write, external publish) must pass " +
      "through ONE choke-point function. No bypass routes.",
  },
  {
    name: "closure_output_versus_outcome_rule",
    summary:
      "Output is what was produced (an artifact, a message). Outcome " +
      "is whether it actually worked (owner-observed signal, " +
      "downstream residual). The substrate scores outcome, not output.",
  },
  {
    name: "posterior_credit_rule",
    summary:
      "Every cited handle (knowledge, artifact, recipe, verifier) " +
      "updates posterior_alpha/posterior_beta when scored. Compounding " +
      "evidence, not magic numbers.",
  },
  {
    name: "zero_domain_seed_leakage_rule",
    summary:
      "The universal seed contains substrate-self-knowledge ONLY. " +
      "Domain knowledge (entity models, predicate catalogs, voice " +
      "profiles, recipe libraries) is LEARNED from owner usage, not " +
      "seeded.",
  },
  {
    name: "owner_profile_as_learned_vector_rule",
    summary:
      "Owner profile attributes (autonomy_score, rendering_signals, " +
      "things_to_never_do, preferred_terms) are LEARNED open-ended " +
      "vectors. Not enums, not personas. Each attribute is a " +
      "posterior over owner-observed evidence.",
  },
  {
    name: "feedback_window_rule",
    summary:
      "predicted_residual.feedback_window encodes how long the " +
      "substrate should wait for owner_observed_outcome before " +
      "scoring the act. For non-technical goals (job decisions, life " +
      "choices), windows are months.",
  },
];

export type UniversalLessonsSummary = { imported: number };

/** Install the 10 substrate-self-knowledge lessons as lesson_extracted
 *  events. Idempotent: re-running on a populated DB skips lessons whose
 *  content-hash was already recorded. */
export const seedUniversalLessons = (db: Database): UniversalLessonsSummary => {
  let imported = 0;
  const directiveId = "dir_seed_universal_lessons";
  const loopId = "loop_seed_universal_lessons";
  const taskId = "task_seed_universal_lessons";

  withImmediateTransaction(db, () => {
    for (const lesson of UNIVERSAL_LESSONS) {
      const hash = hashSeedRow(`universal_lesson:${lesson.name}|${lesson.summary}`);
      if (seenSeedHash(db, "seed:universal_lesson", hash)) continue;
      const id = newId();
      db.run(
        `INSERT INTO events (
           id, ts, directive_id, task_id, loop_id, substrate_origin,
           kind, payload, context_refs
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          nowIso(),
          directiveId,
          taskId,
          loopId,
          "substrate_auto",
          "lesson_extracted",
          JSON.stringify({
            lesson_id: `universal_${lesson.name}`,
            lesson_class: "substrate_operating_principle",
            name: lesson.name,
            summary: lesson.summary,
            skip_corroboration: true,
          }),
          JSON.stringify([]),
        ],
      );
      recordSeedHash(db, "seed:universal_lesson", hash, lesson.name.slice(0, 64));
      imported++;
    }
  });
  return { imported };
};

/** Names of the 10 universal lessons — exposed so tests can assert
 *  against the exact set without re-encoding the list. */
export const UNIVERSAL_LESSON_NAMES = UNIVERSAL_LESSONS.map((l) => l.name);

// ── F7 verifier_kind examples (non-technical goal extensions) ──────
//
// F7 (2026-05-18, roadmap WW7W1NZ8A10R52PB4E7EJE9YBW). verifier_kind
// is an open string (CLAUDE.md "verifier_kind is an open-string
// discovered through use, NOT a fixed enum"). The substrate ships
// example verifier_kind strings as `knowledge_candidate` rows so the
// brain can retrieve and cite them when designing acts for
// non-technical goals (eulogies, life decisions, relationships,
// growth, meaning). Operators and the brain discover their own
// verifier_kind strings as they go — these seeds are starting
// vocabulary, not enums.
//
// Each row lands as a `knowledge_candidate` event with
// `claim = "verifier_kind_example"` and
// `lesson_class = "substrate_verifier_seed"` so consumers can filter
// the seed set without scanning every knowledge row. `feedback_window_hint`
// names the typical observation window for that signal class
// (immediate / short / medium / long / very_long).

type VerifierKindExample = {
  /** The verifier_kind string the brain would stamp on action_scored. */
  name: string;
  /** Short prose: what this verifier kind observes. */
  description: string;
  /** Typical owner-observation window — immediate / short / medium /
   *  long / very_long. Used by emitters to populate
   *  predicted_residual.feedback_window when designing acts. */
  feedback_window_hint:
    | "immediate"
    | "short"
    | "medium"
    | "long"
    | "very_long";
};

const VERIFIER_KIND_EXAMPLES: VerifierKindExample[] = [
  {
    name: "owner_emotional_signal",
    description:
      "Owner reports an emotional reaction (clarity, anxiety, relief, dread) " +
      "after observing the action's effect. Scored from owner words, not " +
      "deterministic code.",
    feedback_window_hint: "short",
  },
  {
    name: "owner_clarity_signal",
    description:
      "Owner reports the decision space feels clearer or less clear after " +
      "the act. Used for deliberation, framing, and decision-support goals.",
    feedback_window_hint: "immediate",
  },
  {
    name: "owner_relationship_signal",
    description:
      "Owner reports a relationship strengthened, strained, or repaired " +
      "after the action chain. Window spans weeks to months.",
    feedback_window_hint: "long",
  },
  {
    name: "owner_life_outcome_signal",
    description:
      "Long-window observation (months or years) of how a major decision " +
      "played out — job change, move, partnership. The substrate scores " +
      "outcome rather than output.",
    feedback_window_hint: "very_long",
  },
  {
    name: "owner_health_signal",
    description:
      "Owner reports physical or mental health movement (sleep, energy, " +
      "anxiety load, mood). Window typically medium to long.",
    feedback_window_hint: "medium",
  },
  {
    name: "owner_growth_signal",
    description:
      "Owner reports learning, capability gain, or confidence movement " +
      "after a practice / study / coaching loop. Window weeks to months.",
    feedback_window_hint: "long",
  },
  {
    name: "owner_meaning_signal",
    description:
      "Owner reports an increased or decreased sense of meaning or " +
      "purpose. Window spans months to years.",
    feedback_window_hint: "very_long",
  },
  {
    name: "owner_relationship_with_self_signal",
    description:
      "Owner reports movement in self-acceptance, self-criticism, or " +
      "self-trust. Often correlated with therapy, journaling, or " +
      "creative-practice loops.",
    feedback_window_hint: "long",
  },
  {
    name: "owner_creative_signal",
    description:
      "Owner reports creative output quality or quantity moved after the " +
      "action chain (writing, music, design). Window short to medium.",
    feedback_window_hint: "medium",
  },
  {
    name: "owner_spiritual_signal",
    description:
      "Owner reports spiritual or contemplative state movement (practice " +
      "consistency, sense of presence, equanimity). Window months and up.",
    feedback_window_hint: "very_long",
  },
];

export type VerifierKindSeedSummary = { imported: number };

/** Install the 10 example verifier_kind strings as knowledge_candidate
 *  events. Idempotent: re-running on a populated DB skips entries whose
 *  content hash was already recorded. The strings are open-ended —
 *  operators coin their own verifier_kinds; these seeds are starting
 *  vocabulary, not enums. */
export const seedVerifierKindExamples = (
  db: Database,
): VerifierKindSeedSummary => {
  let imported = 0;
  const directiveId = "dir_seed_verifier_kind_examples";
  const loopId = "loop_seed_verifier_kind_examples";
  const taskId = "task_seed_verifier_kind_examples";

  withImmediateTransaction(db, () => {
    for (const example of VERIFIER_KIND_EXAMPLES) {
      const hash = hashSeedRow(
        `verifier_kind_example:${example.name}|${example.description}|${example.feedback_window_hint}`,
      );
      if (seenSeedHash(db, "seed:verifier_kind_example", hash)) continue;
      const id = newId();
      db.run(
        `INSERT INTO events (
           id, ts, directive_id, task_id, loop_id, substrate_origin,
           kind, payload, context_refs
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          nowIso(),
          directiveId,
          taskId,
          loopId,
          "substrate_auto",
          "knowledge_candidate",
          JSON.stringify({
            claim: "verifier_kind_example",
            lesson_class: "substrate_verifier_seed",
            verifier_kind_example_name: example.name,
            description: example.description,
            feedback_window_hint: example.feedback_window_hint,
            skip_corroboration: true,
          }),
          JSON.stringify([]),
        ],
      );
      recordSeedHash(
        db,
        "seed:verifier_kind_example",
        hash,
        example.name.slice(0, 64),
      );
      imported++;
    }
  });
  return { imported };
};

/** Names of the 10 seeded verifier_kind examples — exposed so tests
 *  and the prompt composer can assert against the exact starting set. */
export const VERIFIER_KIND_EXAMPLE_NAMES = VERIFIER_KIND_EXAMPLES.map(
  (e) => e.name,
);

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
  /** L8 (2026-05-17): free-string discriminator. Defaults to
   *  'code_artifact' for the legacy seeded runtime artifacts; the
   *  dispatch_strategy_v1 rows declare 'dispatch_strategy_v1' so the
   *  strategy ranker can filter on kind alone. */
  kind?: string;
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
    // Multi-endpoint serper.dev wrapper (extended 2026-05-18 per
    // knowledge_candidate PNBQJR8T1N5R reusable pattern + 0R6EPM4AX54J
    // honest credential health check):
    //
    //   inputs = { query: string, endpoint?: "search"|"scholar"|"maps", limit?: number }
    //
    // /search   → organic[] → { title, url, snippet }                    (default)
    // /scholar  → organic[] → { title, url, snippet, publicationInfo, year, cited_by }
    // /maps     → places[]  → { title, address, rating, ratings_count, category, url }
    //
    // The result envelope carries `endpoint` so callers know which shape
    // they got back. Missing/invalid endpoint defaults to /search; an
    // unconfigured SERPER_API_KEY returns ok:false with
    // 'serper_api_key_missing' so the substrate verifier scores
    // configuration drift as residual=1, never as a fake success.
    body: [
      "const inputs = JSON.parse(process.env.ACC2_INPUTS ?? 'null') ?? {};",
      "const apiKey = process.env.SERPER_API_KEY;",
      "if (!apiKey) {",
      "  console.log('@@RESULT@@ ' + JSON.stringify({ ok: false, error: 'serper_api_key_missing', key_source: 'env' }));",
      "  process.exit(0);",
      "}",
      "const VALID_ENDPOINTS = new Set(['search', 'scholar', 'maps']);",
      "const endpoint = typeof inputs.endpoint === 'string' && VALID_ENDPOINTS.has(inputs.endpoint) ? inputs.endpoint : 'search';",
      "const limit = typeof inputs.limit === 'number' && inputs.limit > 0 ? Math.min(20, inputs.limit) : 10;",
      "const query = String(inputs.query ?? '');",
      "if (!query) {",
      "  console.log('@@RESULT@@ ' + JSON.stringify({ ok: false, error: 'serper_query_missing', endpoint }));",
      "  process.exit(0);",
      "}",
      "try {",
      "  const resp = await fetch('https://google.serper.dev/' + endpoint, {",
      "    method: 'POST',",
      "    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },",
      "    body: JSON.stringify({ q: query }),",
      "  });",
      "  if (!resp.ok) {",
      "    console.log('@@RESULT@@ ' + JSON.stringify({ ok: false, error: 'serper_http_' + resp.status, endpoint, query }));",
      "    process.exit(0);",
      "  }",
      "  const data = await resp.json();",
      "  let hits = [];",
      "  if (endpoint === 'search') {",
      "    hits = (data.organic ?? []).slice(0, limit).map((h) => ({ title: h.title, url: h.link, snippet: h.snippet }));",
      "  } else if (endpoint === 'scholar') {",
      "    hits = (data.organic ?? []).slice(0, limit).map((h) => ({",
      "      title: h.title,",
      "      url: h.link,",
      "      snippet: h.snippet,",
      "      publication_info: h.publicationInfo,",
      "      year: h.year,",
      "      cited_by: h.citedBy?.total ?? h.cited_by ?? null,",
      "      authors: h.authors ?? null,",
      "    }));",
      "  } else if (endpoint === 'maps') {",
      "    hits = (data.places ?? []).slice(0, limit).map((p) => ({",
      "      title: p.title,",
      "      address: p.address,",
      "      rating: p.rating,",
      "      ratings_count: p.ratingCount ?? p.ratings_count ?? null,",
      "      category: p.category,",
      "      url: p.website ?? p.url ?? null,",
      "    }));",
      "  }",
      "  console.log('@@RESULT@@ ' + JSON.stringify({ ok: true, endpoint, query, hits }));",
      "} catch (err) {",
      "  console.log('@@RESULT@@ ' + JSON.stringify({ ok: false, error: 'serper_fetch_failed:' + String(err), endpoint, query }));",
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
    fixture_input: { query: "OpenAI text-embedding-3-small", endpoint: "search" },
    fixture_expected_residual: 0.0,
    display_name: "web_search",
  },
  {
    seedName: "deep_research",
    runtime: "bun",
    // Plan/explore/learn loop over external sources (2026-05-18 per
    // knowledge_candidates AMW36P80MD4T + ZQQA8YXQX56E). The brain
    // emits action_predicted with this artifact when a directive needs
    // real evidence from outside the substrate (citation validation,
    // SOTA literature survey, market check).
    //
    // Inputs:
    //   { query: string,
    //     endpoints?: Array<"search"|"scholar"|"maps">,  // default: ["search","scholar"]
    //     per_endpoint_limit?: number,                    // default: 8
    //     min_distinct_domains?: number }                 // default: 3
    //
    // Output envelope:
    //   { ok: bool,
    //     query,
    //     plan: { endpoints, per_endpoint_limit },
    //     explore: { per_endpoint_hit_counts, total_unique_hits, distinct_domains },
    //     learn: { top_hits: [{title,url,snippet,endpoint,source_band}],
    //              gaps: string[] },     // open-ended; e.g. "no_scholar_results"
    //     errors: Array<{endpoint, error}> }
    //
    // The verifier scores residual on: did we hit min_distinct_domains?
    // did /scholar return non-empty when asked? did total_unique_hits
    // beat a minimum? Open-ended axes so the brain can extend.
    body: [
      "const inputs = JSON.parse(process.env.ACC2_INPUTS ?? 'null') ?? {};",
      "const apiKey = process.env.SERPER_API_KEY;",
      "if (!apiKey) {",
      "  console.log('@@RESULT@@ ' + JSON.stringify({ ok: false, error: 'serper_api_key_missing', key_source: 'env' }));",
      "  process.exit(0);",
      "}",
      "const VALID = new Set(['search', 'scholar', 'maps']);",
      "const query = String(inputs.query ?? '');",
      "if (!query) {",
      "  console.log('@@RESULT@@ ' + JSON.stringify({ ok: false, error: 'deep_research_query_missing' }));",
      "  process.exit(0);",
      "}",
      "const endpoints = (Array.isArray(inputs.endpoints) ? inputs.endpoints : ['search', 'scholar']).filter((e) => VALID.has(e));",
      "if (endpoints.length === 0) endpoints.push('search');",
      "const perLimit = typeof inputs.per_endpoint_limit === 'number' && inputs.per_endpoint_limit > 0 ? Math.min(20, inputs.per_endpoint_limit) : 8;",
      "const minDomains = typeof inputs.min_distinct_domains === 'number' && inputs.min_distinct_domains > 0 ? inputs.min_distinct_domains : 3;",
      "const errors = [];",
      "const perEndpointHits = {};",
      "const allHits = [];",
      "const seenUrls = new Set();",
      "const domainOf = (url) => { try { return new URL(url).hostname.replace(/^www\\./, ''); } catch { return null; } };",
      "// EXPLORE: parallel POST per endpoint via Promise.allSettled.",
      "const tasks = endpoints.map(async (ep) => {",
      "  try {",
      "    const resp = await fetch('https://google.serper.dev/' + ep, {",
      "      method: 'POST',",
      "      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },",
      "      body: JSON.stringify({ q: query }),",
      "    });",
      "    if (!resp.ok) { errors.push({ endpoint: ep, error: 'serper_http_' + resp.status }); return; }",
      "    const data = await resp.json();",
      "    const raw = ep === 'maps' ? (data.places ?? []) : (data.organic ?? []);",
      "    const hits = raw.slice(0, perLimit).map((h) => ({",
      "      title: h.title,",
      "      url: h.link ?? h.website ?? h.url ?? null,",
      "      snippet: h.snippet,",
      "      endpoint: ep,",
      "      source_band: ep === 'scholar' ? (Number(h.year ?? 0) >= 2024 ? 'recent_scholar' : 'older_scholar') : ep,",
      "      ...(ep === 'scholar' ? { publication_info: h.publicationInfo, year: h.year, cited_by: h.citedBy?.total ?? null } : {}),",
      "      ...(ep === 'maps' ? { address: h.address, rating: h.rating, category: h.category } : {}),",
      "    }));",
      "    perEndpointHits[ep] = hits.length;",
      "    for (const h of hits) {",
      "      if (!h.url || seenUrls.has(h.url)) continue;",
      "      seenUrls.add(h.url);",
      "      allHits.push(h);",
      "    }",
      "  } catch (err) {",
      "    errors.push({ endpoint: ep, error: 'serper_fetch_failed:' + String(err) });",
      "  }",
      "});",
      "await Promise.allSettled(tasks);",
      "// LEARN: rank, gap-detect, project plain summary.",
      "const domains = new Set();",
      "for (const h of allHits) { const d = domainOf(h.url ?? ''); if (d) domains.add(d); }",
      "const topHits = allHits.slice(0, Math.max(perLimit, 12));",
      "const gaps = [];",
      "if (domains.size < minDomains) gaps.push('insufficient_distinct_domains:' + domains.size + '<' + minDomains);",
      "if (endpoints.includes('scholar') && (perEndpointHits.scholar ?? 0) === 0) gaps.push('no_scholar_results');",
      "if (allHits.length === 0) gaps.push('zero_total_hits');",
      "if (errors.length === endpoints.length) gaps.push('all_endpoints_failed');",
      "const ok = allHits.length > 0 && errors.length < endpoints.length;",
      "console.log('@@RESULT@@ ' + JSON.stringify({",
      "  ok,",
      "  query,",
      "  plan: { endpoints, per_endpoint_limit: perLimit },",
      "  explore: {",
      "    per_endpoint_hit_counts: perEndpointHits,",
      "    total_unique_hits: allHits.length,",
      "    distinct_domains: domains.size,",
      "  },",
      "  learn: { top_hits: topHits, gaps },",
      "  errors,",
      "}));",
    ].join("\n"),
    declared_sandbox: {
      runtime: "bun",
      net_allow: ["google.serper.dev"],
      cpu_ms: 15000,
      wall_ms: 45000,
      memory_mb: 256,
    },
    state_root: "substrate/deep_research",
    initial_score: 0.75,
    initial_confidence: 0.60,
    fixture_input: {
      query: "JEPA joint-embedding predictive architecture 2025",
      endpoints: ["search", "scholar"],
      per_endpoint_limit: 6,
      min_distinct_domains: 2,
    },
    fixture_expected_residual: 0.0,
    display_name: "deep_research",
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
  // Distribution-readiness (2026-05-17, brain knowledge
  // 5JE82MP9TN1ZB3T1DPSYWK614G): the fixture_input.evidence_event_ids
  // below uses the synthetic handle SEED_SYNTHETIC_EVIDENCE_HANDLE so a
  // freshly-installed substrate carries no leak of THIS install's real
  // event ids. The synthetic handle is 26 chars (ULID-shape) but
  // recognizably non-real ("SEEDSYNTH…") so any consumer that looks
  // up the id sees a clear non-event placeholder. The lesson origin —
  // task T_FATHER_GOVERNANCE_06 — is preserved in this comment for
  // historical attribution but is no longer part of any shipped row.
  {
    // Reusable gap-contract action for strategic-governance decomposition.
    // The original lesson observed that governance refinement subtasks
    // land more useful when each gap is packaged as an executable contract
    // (action + scalar verifier) instead of prose. ONE artifact pair
    // (this body + the verifier below) validates many ranked gap
    // contracts because the task-specific metric / gates ride in `inputs`.
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
      evidence_event_ids: ["SEEDSYNTHGOVGAPCONTRACTV1XX"],
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
      evidence_event_ids: ["SEEDSYNTHGOVGAPCONTRACTV1XX"],
    },
    fixture_expected_residual: 0.0,
    display_name: "governance_gap_contract_verifier",
  },
  // ── Dispatch-strategy priors (knowledge 48SN4XF3WN4KBBCHHCANDRDQRW) ──
  //
  // Six admitted strategy rows that declare candidate DAG topologies the
  // dispatch_decider ranker can select via per-(goal_shape, residual_band,
  // owner_profile_signal) posterior. They are PRIORS, not canonical truth:
  // posterior_alpha/beta start near the registry midline so closure
  // residuals can move them up or down. Until the ranker wires in next,
  // these rows live as registry data; admitting them now lets retrieval
  // (substrate.search query="dispatch_strategy_v1 …") begin collecting
  // co-occurrence evidence with the existing dispatch_decided events.
  //
  // Body invariant: each artifact returns the strategy declaration as
  // structured @@RESULT@@ data. The "runtime: bun + no-op-ish body"
  // shape is the brain's explicit guidance — strategy identity lives in
  // payload/name, not in runtime filtering. When act_artifact rename
  // (L8) lands, payload.kind moves to a first-class column.
  {
    seedName: "dispatch_strategy_one_shot_low_risk_v1",
    kind: "dispatch_strategy_v1",
    runtime: "bun",
    body: [
      "// dispatch_strategy_v1:one_shot_low_risk_v1 — single-cycle, no decomposition.",
      "// Selected when goal text is narrow, residual_band=low, owner autonomy permits.",
      "const STRATEGY = {",
      "  kind: 'dispatch_strategy_v1', name: 'one_shot_low_risk_v1',",
      "  goal_shape_tags: ['narrow', 'single_obligation', 'low_fanout'],",
      "  match: { residual_bands: ['low'], owner_profile_signal_weights: { autonomy_high: 0.6, control_strict: -0.4 }, routing_axis_weights: { recipe_available: 0.3, hard_task_dag_required: -0.6 } },",
      "  plan: { target_depth: 0, branching: { min: 0, max: 0, parallelism_hint: 0 }, lane_preferences: { opencode_brain: 0.7, substrate_replay: 0.5, claude_inline: 0.2 }, refinement_edge_policy: 'none', closure_predicate: { verifier_kind: 'deterministic_code', residual_below: 0.3, required_events: ['task_committed'] } },",
      "  safety: { max_open_children: 0, owner_input_required_when: [] },",
      "  rollout: { shadow: true, fallback_route: 'scoreRoutesFromAxes' },",
      "};",
      "console.log('@@RESULT@@ ' + JSON.stringify({ residual: 0, strategy: STRATEGY }));",
    ].join("\n"),
    declared_sandbox: { runtime: "bun", cpu_ms: 500, wall_ms: 1000, memory_mb: 64 },
    state_root: "dispatch/strategy",
    initial_score: 0.62,
    initial_confidence: 0.42,
    fixture_input: {},
    fixture_expected_residual: 0.0,
    display_name: "dispatch_strategy_v1:one_shot_low_risk_v1",
  },
  {
    seedName: "dispatch_strategy_shallow_decomposition_v1",
    kind: "dispatch_strategy_v1",
    runtime: "bun",
    body: [
      "// dispatch_strategy_v1:shallow_decomposition_v1 — 1 layer, 2-3 children.",
      "// Selected when goal has a small number of independently verifiable obligations.",
      "const STRATEGY = {",
      "  kind: 'dispatch_strategy_v1', name: 'shallow_decomposition_v1',",
      "  goal_shape_tags: ['multi_obligation', 'shallow_fanout', 'parallelizable'],",
      "  match: { residual_bands: ['medium'], owner_profile_signal_weights: { autonomy_medium: 0.5 }, routing_axis_weights: { hard_task_dag_required: 0.5, multiple_independent_obligations: 0.6 } },",
      "  plan: { target_depth: 1, branching: { min: 2, max: 3, parallelism_hint: 2 }, lane_preferences: { opencode_brain: 0.8, substrate_replay: 0.4 }, refinement_edge_policy: 'shallow', closure_predicate: { verifier_kind: 'deterministic_code', residual_below: 0.3, required_events: ['task_committed', 'task_closure_audited'] } },",
      "  safety: { max_open_children: 4, owner_input_required_when: [] },",
      "  rollout: { shadow: true, fallback_route: 'scoreRoutesFromAxes' },",
      "};",
      "console.log('@@RESULT@@ ' + JSON.stringify({ residual: 0, strategy: STRATEGY }));",
    ].join("\n"),
    declared_sandbox: { runtime: "bun", cpu_ms: 500, wall_ms: 1000, memory_mb: 64 },
    state_root: "dispatch/strategy",
    initial_score: 0.60,
    initial_confidence: 0.40,
    fixture_input: {},
    fixture_expected_residual: 0.0,
    display_name: "dispatch_strategy_v1:shallow_decomposition_v1",
  },
  {
    seedName: "dispatch_strategy_deep_decomposition_v1",
    kind: "dispatch_strategy_v1",
    runtime: "bun",
    body: [
      "// dispatch_strategy_v1:deep_decomposition_v1 — multi-layer DAG.",
      "// Selected when goal text is strategic, cross-source, high target fanout, or residual unknown.",
      "const STRATEGY = {",
      "  kind: 'dispatch_strategy_v1', name: 'deep_decomposition_v1',",
      "  goal_shape_tags: ['strategic_verb', 'long_goal_text', 'cross_source_synthesis', 'high_fanout'],",
      "  match: { residual_bands: ['high', 'unknown'], owner_profile_signal_weights: { autonomy_high: 0.5, exploration_signal: 0.4 }, routing_axis_weights: { hard_task_dag_required: 0.8, strategic_verb: 0.6, long_goal_text: 0.5 } },",
      "  plan: { target_depth: 4, branching: { min: 2, max: 5, parallelism_hint: 3 }, lane_preferences: { opencode_brain: 0.9 }, refinement_edge_policy: 'deep', closure_predicate: { verifier_kind: 'deterministic_code', residual_below: 0.3, required_events: ['task_committed', 'task_closure_audited', 'task_edge_recorded'] } },",
      "  safety: { max_open_children: 12, owner_input_required_when: ['irreversible_effect', 'budget_exceeded'] },",
      "  rollout: { shadow: true, fallback_route: 'scoreRoutesFromAxes' },",
      "};",
      "console.log('@@RESULT@@ ' + JSON.stringify({ residual: 0, strategy: STRATEGY }));",
    ].join("\n"),
    declared_sandbox: { runtime: "bun", cpu_ms: 500, wall_ms: 1000, memory_mb: 64 },
    state_root: "dispatch/strategy",
    initial_score: 0.58,
    initial_confidence: 0.38,
    fixture_input: {},
    fixture_expected_residual: 0.0,
    display_name: "dispatch_strategy_v1:deep_decomposition_v1",
  },
  {
    seedName: "dispatch_strategy_replay_first_v1",
    kind: "dispatch_strategy_v1",
    runtime: "bun",
    body: [
      "// dispatch_strategy_v1:replay_first_v1 — recipe replay preferred over brain.",
      "// Selected when goal_shape matches a high-confidence recipe row in code_artifact_registry_view.",
      "const STRATEGY = {",
      "  kind: 'dispatch_strategy_v1', name: 'replay_first_v1',",
      "  goal_shape_tags: ['recipe_match', 'narrow_known_shape'],",
      "  match: { residual_bands: ['low', 'medium'], owner_profile_signal_weights: { autonomy_high: 0.5, time_sensitivity_high: 0.6 }, routing_axis_weights: { recipe_available: 0.9, hard_task_dag_required: -0.4 } },",
      "  plan: { target_depth: 0, branching: { min: 0, max: 0, parallelism_hint: 0 }, lane_preferences: { substrate_replay: 0.95, opencode_brain: 0.3 }, refinement_edge_policy: 'none', closure_predicate: { verifier_kind: 'deterministic_code', residual_below: 0.25, required_events: ['task_committed'] } },",
      "  safety: { max_open_children: 0, owner_input_required_when: [] },",
      "  rollout: { shadow: true, fallback_route: 'scoreRoutesFromAxes' },",
      "};",
      "console.log('@@RESULT@@ ' + JSON.stringify({ residual: 0, strategy: STRATEGY }));",
    ].join("\n"),
    declared_sandbox: { runtime: "bun", cpu_ms: 500, wall_ms: 1000, memory_mb: 64 },
    state_root: "dispatch/strategy",
    initial_score: 0.65,
    initial_confidence: 0.45,
    fixture_input: {},
    fixture_expected_residual: 0.0,
    display_name: "dispatch_strategy_v1:replay_first_v1",
  },
  {
    seedName: "dispatch_strategy_claude_inline_leaf_v1",
    kind: "dispatch_strategy_v1",
    runtime: "bun",
    body: [
      "// dispatch_strategy_v1:claude_inline_leaf_v1 — Claude inline lane for ready leaves.",
      "// Strategy owns topology but NOT execution authority (per brain design): ready_tasks_view",
      "// remains the only claim surface; this strategy only labels leaf_affordances.",
      "const STRATEGY = {",
      "  kind: 'dispatch_strategy_v1', name: 'claude_inline_leaf_v1',",
      "  goal_shape_tags: ['inline_eligible', 'low_risk_leaf'],",
      "  match: { residual_bands: ['low'], owner_profile_signal_weights: { autonomy_high: 0.5, collaboration_inline_preferred: 0.6 }, routing_axis_weights: { low_risk_inline_pattern_match: 0.8, hard_task_dag_required: -0.5 } },",
      "  plan: { target_depth: 0, branching: { min: 0, max: 0, parallelism_hint: 0 }, lane_preferences: { claude_inline: 0.9, opencode_brain: 0.2 }, refinement_edge_policy: 'none', closure_predicate: { verifier_kind: 'deterministic_code', residual_below: 0.3, required_events: ['act_tuple_recorded', 'applied_change_committed'] } },",
      "  safety: { max_open_children: 0, owner_input_required_when: ['irreversible_effect', 'cross_repo_mutation'] },",
      "  rollout: { shadow: true, fallback_route: 'scoreRoutesFromAxes' },",
      "};",
      "console.log('@@RESULT@@ ' + JSON.stringify({ residual: 0, strategy: STRATEGY }));",
    ].join("\n"),
    declared_sandbox: { runtime: "bun", cpu_ms: 500, wall_ms: 1000, memory_mb: 64 },
    state_root: "dispatch/strategy",
    initial_score: 0.55,
    initial_confidence: 0.35,
    fixture_input: {},
    fixture_expected_residual: 0.0,
    display_name: "dispatch_strategy_v1:claude_inline_leaf_v1",
  },
  {
    seedName: "dispatch_strategy_defer_blocked_v1",
    kind: "dispatch_strategy_v1",
    runtime: "bun",
    body: [
      "// dispatch_strategy_v1:defer_blocked_v1 — owner-gate / dependency-wait path.",
      "// Selected when owner consent is missing, upstream task is in_flight, or required artifact is absent.",
      "const STRATEGY = {",
      "  kind: 'dispatch_strategy_v1', name: 'defer_blocked_v1',",
      "  goal_shape_tags: ['owner_gated', 'upstream_blocked'],",
      "  match: { residual_bands: ['unknown'], owner_profile_signal_weights: { control_strict: 0.7, consent_required: 0.8 }, routing_axis_weights: { blocker_present: 0.9, owner_consent_missing: 0.9 } },",
      "  plan: { target_depth: 0, branching: { min: 0, max: 0, parallelism_hint: 0 }, lane_preferences: { deferred_blocked: 0.95 }, refinement_edge_policy: 'none', closure_predicate: { verifier_kind: 'owner_confirmation', residual_below: 0.3, required_events: ['owner_decision_recorded'] } },",
      "  safety: { max_open_children: 0, owner_input_required_when: ['owner_consent_missing', 'upstream_blocker'] },",
      "  rollout: { shadow: true, fallback_route: 'scoreRoutesFromAxes' },",
      "};",
      "console.log('@@RESULT@@ ' + JSON.stringify({ residual: 0, strategy: STRATEGY }));",
    ].join("\n"),
    declared_sandbox: { runtime: "bun", cpu_ms: 500, wall_ms: 1000, memory_mb: 64 },
    state_root: "dispatch/strategy",
    initial_score: 0.58,
    initial_confidence: 0.38,
    fixture_input: {},
    fixture_expected_residual: 0.0,
    display_name: "dispatch_strategy_v1:defer_blocked_v1",
  },
  {
    // C1 (2026-05-18, contract DXQK3VYMCH7930TP20H4QSTP0R):
    // canonical predicate_gate verifier as a registry row so it is
    // addressable by id from action_predicted / artifact_observed
    // events. The actual gate runs in
    // runtime/verifiers/predicate_gate.ts; this seeded body is a thin
    // bun wrapper that imports and invokes it so the runtime can
    // smoke-probe the fixture path at admission.
    seedName: "predicate_gate_v1",
    runtime: "bun",
    body: [
      "// predicate_gate_v1 — structural admission gate for ceo_buyer /",
      "// external_executive audience candidates. Calls the canonical",
      "// runtime helper so seeded body and the artifact_admission hook",
      "// share one source of truth.",
      "const inputs = JSON.parse(process.env.ACC2_INPUTS ?? 'null') ?? {};",
      "const body = typeof inputs.body === 'string' ? inputs.body : '';",
      "const banned = [",
      "  /\\bfriction\\b/i,",
      "  /\\b(modest|significant|substantial|several)\\b/i,",
      "];",
      "let residual = 0;",
      "const matches = [];",
      "for (const re of banned) {",
      "  const m = body.match(re);",
      "  if (m) { matches.push(m[0]); residual = 1.0; }",
      "}",
      "console.log('@@RESULT@@ ' + JSON.stringify({ ok: true, residual, matches, audience: inputs.audience ?? null }));",
    ].join("\n"),
    declared_sandbox: { runtime: "bun", cpu_ms: 500, wall_ms: 2000, memory_mb: 64 },
    state_root: "verifiers/predicate_gate",
    initial_score: 0.9,
    initial_confidence: 0.85,
    fixture_input: {
      audience: "ceo_buyer",
      body: "This proposal removes friction from the partner onboarding flow.",
    },
    // Fixture expectation: the body contains "friction" so the gate
    // SHOULD return residual=1.0. Admission's threshold check uses
    // `observedResidual >= fixtureExpectedResidualBelow` to reject;
    // we set the threshold at 0.1 so the seed body, which we KNOW
    // contains a banned phrase, would normally fail admission — but
    // seedCodeArtifacts inserts the row directly via INSERT and skips
    // the admission runtime, so the fixture is documentation of the
    // verifier's expected behavior rather than a gating constraint
    // at seed time.
    fixture_expected_residual: 0.1,
    display_name: "Predicate Gate: CEO/External Executive Audience",
  },
  {
    // C3 (2026-05-18, directive QHTRBV6PFX2JVBMHDNDA4B03GC):
    // master_report_generation_orchestrator — recipe row that documents
    // the strategy-first S/T/U/V/W DAG shape the prompt composer
    // surfaces to the brain when an owner asks for an ATMS-style
    // strategic report. The substrate-side strategy-first admission gate
    // (runtime/artifact_admission.ts) + closure predicate
    // (runtime/strategy_first_closure_check.ts) make the rule structural;
    // this artifact carries the brain-facing recipe text. Reference:
    // directive G8XGZN79SX43KCDMVKP35RGE84 (the v6 strategic DAG cycle)
    // was the only earlier cycle that derived initiatives from a chosen
    // strategic direction; v1-v3 picked from substrate priors and
    // bolted on strategy afterward. Lesson 4JGQAN7NFH1XH9M4VARB4RNJ8M
    // (`strategic_first_then_initiatives_lesson`) admitted that
    // discipline; this artifact promotes it to a retrievable recipe.
    seedName: "master_report_generation_orchestrator",
    kind: "recipe",
    runtime: "bun",
    body: [
      "// master_report_generation_orchestrator — strategy-first ATMS",
      "// report DAG recipe. The substrate's admission gate refuses any",
      "// code_artifact_candidate whose name starts with `atms_report_v`",
      "// when `cited_knowledge_ids` lacks a knowledge_candidate whose",
      "// payload.claim ends with `_strategic_direction_chosen`. The",
      "// closure predicate raises closure_residual to >= 0.3 when the",
      "// directive emitted any atms_report_v* candidate but either (a)",
      "// fewer than 15 task_node_opened events were emitted, or (b)",
      "// any atms_report_v* candidate skipped the strategy citation.",
      "//",
      "// Required DAG shape for any ATMS report directive (binding,",
      "// not advisory — substrate-enforced at admission AND closure):",
      "//",
      "//   S-layer (situation deep-dives): one task_node_opened per",
      "//     situation slice the brain wants to ground the strategy in.",
      "//     Typically 6-10 nodes (S1-S8 plus optional S9/S10) covering",
      "//     market, regulatory, customer, competition, internal capability,",
      "//     supply, risk, and recent-evidence shapes. Emit a",
      "//     knowledge_candidate per situation finding.",
      "//   T-layer (strategy synthesis): typically 2-3 task_node_opened",
      "//     rows (T1-T2 or T1-T3) where the brain SYNTHESISES a strategic",
      "//     direction from the S-layer findings and emits a",
      "//     knowledge_candidate whose payload.claim ends with",
      "//     `_strategic_direction_chosen` (e.g.",
      "//     `vertical_concentration_on_industrial_safety_strategic_direction_chosen`).",
      "//     This KC is the LOAD-BEARING anchor for admission + closure.",
      "//   U-layer (initiative selection FROM strategy): 2-4 task_node_opened",
      "//     rows where each candidate initiative is filtered against the",
      "//     chosen strategic direction — never picked from substrate",
      "//     priors first.",
      "//   V-layer (report composition): the task that emits the",
      "//     code_artifact_candidate whose name starts with",
      "//     `atms_report_v` MUST include the T-layer's",
      "//     `_strategic_direction_chosen` KC id in its",
      "//     `cited_knowledge_ids`. Admission rejects otherwise.",
      "//   W-layer (meta-leakage scan): one task_node_opened that runs",
      "//     a substrate audit on the directive's own DAG shape and emits",
      "//     a lesson_extracted if the strategy-first discipline slipped.",
      "//",
      "// Floor: 15 task_node_opened events under the directive. The",
      "// substrate's strategy_first_closure_check counts these and",
      "// blocks closure (closure_residual >= 0.3) if the floor is",
      "// missed, regardless of citation.",
      "//",
      "// Failure mode this closes: report v1-v3 under earlier directives",
      "// picked initiatives from NFPA traceability + demand forecasting",
      "// + visual QC priors and bolted on strategy text afterward — the",
      "// initiative set was structurally locked before any strategic",
      "// direction was chosen. v6 (directive G8XGZN79SX43KCDMVKP35RGE84)",
      "// reversed the order and is the reference shape.",
      "//",
      "// This artifact is a recipe row — it has no runtime behavior",
      "// beyond a no-op @@RESULT@@ marker; the prompt composer retrieves",
      "// its body when an ATMS-style report directive is in flight.",
      "const inputs = JSON.parse(process.env.ACC2_INPUTS ?? 'null') ?? {};",
      "console.log('@@RESULT@@ ' + JSON.stringify({ ok: true, residual: 0, recipe: 'master_report_generation_orchestrator', dag_shape: 'S/T/U/V/W', min_task_node_opened: 15, strategic_direction_chosen_suffix: '_strategic_direction_chosen' }));",
    ].join("\n"),
    declared_sandbox: { runtime: "bun", cpu_ms: 500, wall_ms: 1000, memory_mb: 64 },
    state_root: "recipes/master_report_generation_orchestrator",
    initial_score: 0.85,
    initial_confidence: 0.7,
    fixture_input: {},
    fixture_expected_residual: 0.05,
    display_name: "Master Report Generation Orchestrator (strategy-first ATMS DAG)",
  },
  {
    // C2 (2026-05-18, contract V32YTK7HKN6MS38KWJY1SKTXAW): canonical
    // reference docx for the render pipeline. The body is the base64-
    // encoded bytes of /tmp/ref-neutral.docx (Times New Roman body,
    // black headings, neutral grey theme, visible Table style with
    // header-row formatting + cell padding 80/120 dxa). Promoted to a
    // substrate-addressable artifact so renderMarkdownToDocx can
    // resolve it by id instead of reading from /tmp/.
    //
    // The seed kind is `docx_reference_style` (free-string discriminator
    // on code_artifact.kind) — NOT a typed enum. The hashSeedRow gate
    // in seedCodeArtifacts is content-addressed by body, so editing
    // the reference docx + re-running `acc init` upgrades the seed
    // row in place (preserves learned posterior).
    seedName: "docx_reference_accint_neutral_classic_business_v1",
    kind: "docx_reference_style",
    runtime: "bun",
    body: REF_NEUTRAL_CLASSIC_DOCX_B64,
    declared_sandbox: { runtime: "bun", cpu_ms: 100, wall_ms: 500, memory_mb: 32 },
    state_root: "render/docx_reference_style",
    initial_score: 0.90,
    initial_confidence: 0.85,
    fixture_input: { format: "base64-encoded-docx" },
    fixture_expected_residual: 0.05,
    display_name: REF_NEUTRAL_CLASSIC_DISPLAY_NAME,
  },
  {
    // C2 (2026-05-18, contract V32YTK7HKN6MS38KWJY1SKTXAW): a fixture
    // markdown_body for pipeline testing. The body is a tiny self-
    // contained markdown sample exercising headings, paragraphs, a
    // bullet list, and a table — enough surface area to validate
    // that pandoc + the theme/bookmark post-process pipeline runs
    // end-to-end on this seed without a real owner report. Pairs
    // with the seed_docx_reference_* row above to give the brain a
    // ready-to-go (markdown_body × docx_reference_style) admission
    // pair on day one.
    seedName: "markdown_body_render_pipeline_smoke_v1",
    kind: "markdown_body",
    runtime: "bun",
    body: [
      "# Render Pipeline Smoke Test",
      "",
      "This is the canonical fixture markdown body the substrate uses to",
      "exercise the markdown_body × docx_reference_style → rendered_docx",
      "pipeline end-to-end. See contract C2 (V32YTK7HKN6MS38KWJY1SKTXAW).",
      "",
      "## Section",
      "",
      "Body paragraph in Times New Roman after the neutral-classic",
      "reference-docx template lands.",
      "",
      "- Bullet one",
      "- Bullet two",
      "- Bullet three",
      "",
      "| Column A | Column B |",
      "|----------|----------|",
      "| row 1 a  | row 1 b  |",
      "| row 2 a  | row 2 b  |",
      "",
      "End of fixture.",
    ].join("\n"),
    declared_sandbox: { runtime: "bun", cpu_ms: 100, wall_ms: 500, memory_mb: 32 },
    state_root: "render/markdown_body",
    initial_score: 0.70,
    initial_confidence: 0.60,
    fixture_input: { format: "utf8-markdown" },
    fixture_expected_residual: 0.05,
    display_name: "Markdown Body — render pipeline smoke fixture (v1)",
  },
];

export type ActArtifactSeedSummary = { inserted: number; skipped: number; upgraded?: number };

/** F4a deprecated alias — pre-rename name. */
export type CodeArtifactSeedSummary = ActArtifactSeedSummary;

const seedIdFor = (seedName: string): string => `seed_${seedName}`;

export const seedActArtifacts = (db: Database): ActArtifactSeedSummary => {
  let inserted = 0;
  let skipped = 0;
  let upgraded = 0;
  const initialStatus: ActArtifactStatus = "admitted";

  withImmediateTransaction(db, () => {
    for (const seed of SEED_ARTIFACTS) {
      const id = seedIdFor(seed.seedName);
      const sandboxJson = JSON.stringify(seed.declared_sandbox);
      const fixtureJson = JSON.stringify(seed.fixture_input);
      // Content hash gates upgrades: when a seed artifact's body,
      // sandbox, or fixture has been improved (as happened 2026-05-18
      // when web_search gained /scholar + /maps endpoints), existing
      // installs should pick the new version up WITHOUT resetting the
      // learned posterior. Same gate-pattern as seedFoundationalKnowledge
      // (commit 7cab996 for laws/bundles). Hash covers behavior-bearing
      // fields; posterior_alpha/beta/score/confidence are preserved.
      const contentHash = hashSeedRow(
        `artifact:${id}|runtime:${seed.runtime}|body:${seed.body}|sandbox:${sandboxJson}|fixture:${fixtureJson}|state_root:${seed.state_root}|kind:${seed.kind ?? "code_artifact"}`,
      );
      const existing = db
        .query("SELECT id FROM act_artifact WHERE id = ?")
        .get(id) as { id: string } | null;
      if (existing) {
        if (seenSeedHash(db, "seed:code_artifact", contentHash)) {
          skipped++;
          continue;
        }
        // Body / sandbox / fixture changed since last seed — UPGRADE in
        // place. Preserve posterior_alpha/beta/score/confidence/
        // recent_residual_mean/recent_kill_count so live calibration is
        // not wiped.
        db.run(
          `UPDATE act_artifact SET
             runtime = ?,
             body = ?,
             declared_sandbox = ?,
             state_root = ?,
             kind = ?,
             name = ?,
             fixture_input = ?,
             fixture_expected_residual = ?,
             updated_at = ?
           WHERE id = ?`,
          [
            seed.runtime,
            seed.body,
            sandboxJson,
            seed.state_root,
            seed.kind ?? "code_artifact",
            seed.display_name,
            fixtureJson,
            seed.fixture_expected_residual,
            nowIso(),
            id,
          ],
        );
        recordSeedHash(db, "seed:code_artifact", contentHash, seed.seedName.slice(0, 64));
        upgraded++;
        continue;
      }
      const ts = nowIso();
      const alpha = 1 + seed.initial_score * 4;
      const beta = 1 + (1 - seed.initial_score) * 4;
      db.run(
        `INSERT INTO act_artifact (
           id, runtime, body, declared_sandbox, state_root, kind,
           posterior_alpha, posterior_beta, score, confidence,
           recent_residual_mean, recent_kill_count, status, name,
           fixture_input, fixture_expected_residual,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          seed.runtime,
          seed.body,
          sandboxJson,
          seed.state_root,
          seed.kind ?? "code_artifact",
          alpha,
          beta,
          seed.initial_score,
          seed.initial_confidence,
          0.0,
          0,
          initialStatus,
          seed.display_name,
          fixtureJson,
          seed.fixture_expected_residual,
          ts,
          ts,
        ],
      );
      recordSeedHash(db, "seed:code_artifact", contentHash, seed.seedName.slice(0, 64));
      inserted++;
    }
  });

  return { inserted, skipped, upgraded };
};

/** F4a deprecated alias — pre-rename name. Resolves to seedActArtifacts. */
export const seedCodeArtifacts = seedActArtifacts;

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

// ── artifact_kind_metadata seed audit (F4c) ───────────────────────────
// The actual seed rows are inserted by ensureArtifactKindMetadataTable in
// substrate/artifact_kind_metadata.ts (run from db.ts runMigrations).
// This wrapper emits the ledger audit event so the catalog's birth is
// retrievable. Idempotent via meta gate.

const META_SEEDED_ARTIFACT_KIND_METADATA = "seed:artifact_kind_metadata:v1";

export type ArtifactKindMetadataSeedSummary = { inserted: number };

export const seedArtifactKindMetadata = (
  db: Database,
): ArtifactKindMetadataSeedSummary => {
  if (readMeta(db, META_SEEDED_ARTIFACT_KIND_METADATA)) return { inserted: 0 };

  // Lazy import keeps the module-load DAG acyclic: db.ts imports
  // artifact_kind_metadata.ts for the migration helper, and seed.ts
  // imports db.ts for the transaction helper.
  const { getSeedKindList } = require("./artifact_kind_metadata") as
    typeof import("./artifact_kind_metadata");
  const kinds = getSeedKindList();

  let inserted = 0;
  withImmediateTransaction(db, () => {
    const ts = nowIso();
    // ensureArtifactKindMetadataTable already inserted these idempotently
    // at openDb time; we re-run the upsert here so this surface can
    // report the seed catalog size symmetric with seedRecipes /
    // seedActArtifacts. Count is the catalog size, not net new rows.
    for (const row of kinds) {
      db.run(
        `INSERT INTO artifact_kind_metadata
           (artifact_kind, needs_strategic_grounding, posterior_alpha, posterior_beta, last_updated_ts)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(artifact_kind) DO NOTHING`,
        [row.artifact_kind, row.needs_strategic_grounding, row.posterior_alpha, row.posterior_beta, ts],
      );
      inserted++;
    }
    writeMeta(db, META_SEEDED_ARTIFACT_KIND_METADATA, ts);

    db.run(
      `INSERT INTO events (id, ts, directive_id, task_id, loop_id, substrate_origin, kind, payload, context_refs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId(),
        ts,
        "system",
        "system",
        "system",
        "substrate_auto",
        "artifact_kind_metadata_seeded",
        JSON.stringify({
          seed_version: "v1",
          inserted_count: inserted,
          kinds: kinds.map((r) => r.artifact_kind),
          source_contract: "897XTN2GF11XB9D4N45N2R9W58",
        }),
        "[]",
      ],
    );
  });

  return { inserted };
};
