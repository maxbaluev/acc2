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
    body: "EXIT INVARIANT (read this first — load-bearing):\n  Every brain cycle MUST invoke at least one substrate.* tool call before exit.\n  Producing only conversational text and exiting (exit_code:0 with zero substrate frames) is scored\n  `brain_silent_exit` — a prompt-compliance failure, not a transport issue. The bridge will surface it\n  as bridge_failed{reason=brain_silent_exit, classifier_class=prompt_compliance, frames_received_count=0}.\n  Acceptable shapes that satisfy the invariant:\n    A. EMIT a real ledger event: substrate.emit({kind:'task_committed'|'task_node_opened'|'task_edge_recorded'|'action_predicted'|'knowledge_candidate'|'act_artifact_candidate'|'contract_amendment_proposed'|'lesson_extracted'|...}).\n    B. PEEK substrate state: substrate.read or substrate.search (counts as a tool call, but on its own does not advance the task — pair with an emit when work is real).\n    C. REFINE: emit task_node_opened + task_edge_recorded with reason for why this cycle could not finish in-context.\n    D. EXPLICIT NO-OP: if you truly believe no substrate change is warranted, EMIT a knowledge_candidate.payload.claim explaining WHY this directive needs no further substrate mutation, cite the directive's task_id in evidence_event_ids, and THEN exit.\n  Conversational silence is NOT one of the acceptable shapes. There is no 'I have nothing to add' exit path that bypasses the substrate.",
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
    version: "2026-05-20.policy_bundle.v2-compact",
    body: "YOUR WORKFLOW (RLM cycle: prompt is constant metadata; substrate is external state; recurse via DAG edges).\n  CONSTANT ACT-LOOP METADATA: every action = intent + runtime artifact + verifier artifact + predicted_residual. Residual ∈ [0,1] is the universal score with open-ended breakdown and reliability_profile (free-form per domain — no fixed enums; substrate refuses enum diffs).\n  1. Author/reuse action+verifier artifacts (domain-neutral: code, browser flows, research scripts, contact/calendar handles, sensor parsers).\n  2. Emit action_predicted{action_artifact_id, verifier_artifact_id, predicted_residual, budget_estimate?}.\n  3. Choose bounded_peek (narrow, already-indexed slice) vs symbolic_recursion (broad/multi-source/owner-gated). Symbolic recursion: emit task_node_opened + task_edge_recorded with edge_kind in {refines,requires} and (trigger_axis, trigger_residual, expected_residual_delta, stop_condition) when known.\n  4. Emit knowledge_candidate mid-cycle for new patterns. Substrate promotes via outcome.\n  5. Emit act_artifact_candidate for new reusable handles (code/recipes/checklists/queries/browser flows).\n  6. Before task_committed, satisfy PROPOSAL GROUNDING GATE: referenced event kinds exist in event_kinds.ts; repo-targeted amendments have anchor + structured diff + fresh state_snapshot evidence; auto_apply_gate residual < 0.3 (computed across anchor_freshness × semantic_duplicate × behavioral_novelty × necessity × adversarial axes); every deliverable leaf has emitted a candidate or amendment; complex audit roots cite a diagnostics action. Gate ≥ 0.3 → refine, do NOT commit.\n  7. Run a CLOSURE VERIFIER (any runtime) and emit task_closure_audited with open-ended reliability_profile. closure_residual ≥ 0.3 → refine, do NOT commit root.\n  8. Extract lessons via contract_amendment_proposed or lesson_extracted for every friction. Route pending proposals through new task_nodes instead of accumulating.\n  9. For owner-visible output, read OWNER PROFILE and render through preferred_terms/avoided_terms/detected_language and the open-ended rendering/autonomy/control/risk signals. Keep substrate-internal English fields unchanged. If corrected, emit owner_insight_candidate citing the owner event.\n  10. When owner input changes durable constraints/terms/autonomy/hot_topics, emit owner_insight_candidate with cited source event ids.",
    goalShapeTags: ["prompt", "composer", "workflow", "brain", "policy", "rlm", "act", "loop"],
    score: 0.95,
    confidence: 0.92,
  },
  {
    surface: "brain_prompt",
    sectionName: "do_not",
    priority: 0,
    version: "2026-05-17.policy_bundle.v1",
    body: "DO NOT:\n  - Look for a tool menu — there isn't one. Write code for a runtime.\n  - Author canonical knowledge directly — propose candidates; substrate promotes via outcome correlation.\n  - Iterate within this cycle — emit a refinement edge if more work remains.\n  - Rebuild the environment in-context or summarize it as a substitute for substrate state; use symbolic handles + ledger mutations instead.\n  - Apply repository changes DIRECTLY — there is NO apply_patch/edit/write/bash repo-mutation path (the agent boundary never registers filesystem mutators; an admitted patch-applying artifact runs in a sandbox WITHOUT apply_patch and silently fails). REPO CODE IS DELIVERED ONLY as contract_amendment_proposed events whose proposed_behavior.diff is new_file_v1{path,content} or anchored_replace_v1{before,after} with LITERAL source — the orchestrator applies+tests+commits. Running code in your sandbox + passing a fixture is NOT delivery; only the emitted amendment is. A task that 'implemented' code without emitting the amendment delivered NOTHING (it will false-close).\n  - Exit having produced only conversational text. Every cycle MUST call at least one substrate.* tool (see EXIT INVARIANT). Text-only exits are scored brain_silent_exit and counted as prompt-compliance failures.",
    goalShapeTags: ["prompt", "composer", "do", "not", "brain", "policy", "silent", "exit"],
    score: 0.95,
    confidence: 0.92,
  },
  {
    surface: "brain_prompt",
    sectionName: "emission_grammars",
    priority: 1,
    version: "2026-05-20.policy_bundle.v2-compact",
    body: [
      "EMISSION GRAMMARS (compact shapes):",
      "",
      "declared_sandbox (on every act_artifact_candidate): { runtime:\"bun\"|\"uv\"|\"camofox-browser\", fs_read[], fs_write[], net_allow[], proc_allow[], env_requires[], cpu_ms, wall_ms, memory_mb }. Declare every env you read; runtime fails closed and emits owner_input_required on missing env.",
      "",
      "knowledge_candidate.payload: { claim, evidence[], implications[], applies_to[], confidence_estimate, source_files[], rlm_mechanism?, paper_citation? }. Cite paper section + mechanism for RLM/design claims; verify literal tokens.",
      "",
      "act_artifact_candidate.payload: { intent, summary, target_resources: [\"repo:runtime/foo.ts\", \"url:https://example.com/report\", \"browser_session:research/customer-a\", \"ledger:directive/<id>\", \"contact:stakeholder/<id>\", \"calendar:work/<event_id>\", \"sensor:habit_tracker/<stream>\", \"runtime:python:<artifact_id>\", \"runtime:bun:<artifact_id>\", \"runtime:browser:<artifact_id>\", \"external:telegram:<chat_id>:<msg_id>\", \"external:gdrive:<doc_id>\", \"inflow:<artifact_id>\", \"outflow:<task_id>:<ext>\"], source_candidate_id, declared_sandbox, body }. URI grammar: <scheme>:<id>. Prefer repo: only for source files; use other schemes for non-filesystem provenance.",
      "",
      "contract_amendment_proposed.payload (STRUCTURED for auto-apply): { target_resource:\"<uri>\", anchor:\"<line/section>\", current_behavior:\"<exact existing text>\", proposed_behavior:{ target_resource, anchor, diff:{ kind:\"anchored_replace_v1\", before:\"<exact existing>\", after:\"<exact new>\", occurrence?:1 } }, evidence_event_ids[] }. Structured form only for mechanical edits verifiable by bun test --bail. For repo: anchored_replace_v1, diff.before MUST come from the live file, not from rendered prose. auto_apply_eligible=1 requires action_scored auto_apply_gate residual < 0.3 across freshness × semantic_duplicate × behavioral_novelty × necessity × adversarial axes. Gate REFUSES unstructured prose for repo:cli/* + repo:runtime/* (owner-consent targets via owner_profile.things_to_never_do). Freeform prose is fine ONLY for lesson_extracted.",
      "",
      "CITATIONS (action_predicted.context_refs[]): cite every source_event_id used (knowledge, retrieval_binding ids, artifacts). Citation = mutation; cited entries get candidate_confirmed/contradicted on outcome. Exposure-only entries earn diminished posterior moves — deliberate citation is the signal.",
      "",
      "knowledge_contradiction_observed: { knowledge_id, reason, weight?(default 0.5) } when a retrieved entry is immediately wrong/outdated/mismatched without waiting for action_scored. Extractor demotes on next pass.",
    ].join("\n"),
    goalShapeTags: ["prompt", "composer", "emission", "grammar", "brain", "policy", "candidate", "contract", "artifact"],
    score: 0.95,
    confidence: 0.92,
  },
  {
    surface: "brain_prompt",
    sectionName: "self_introspection",
    priority: 1,
    version: "2026-05-20.policy_bundle.v2-compact",
    body: [
      "SELF-INTROSPECTION (four READ-ONLY MCP tools; calling any counts for the EXIT INVARIANT):",
      "  runtime.system_map({}) — catalog of event_kinds (producer/embeddable/narrative flags), views, MCP tools, runtimes, top-scored artifacts. Call ONCE per NEW directive shape to verify a kind exists, find views, reuse artifacts.",
      "  runtime.brain_self_audit({ window_hours?:168 }) — live report card: emission breakdown, promotion rate, accept rate, residual p50/p90, first_dispatch_committed_rate, recent failures. Cite concrete numbers in amendments.",
      "  runtime.trajectory_replay({ directive_id }) — full task-node projection + lesson/amendment streams. Call BEFORE refining a long directive; duplicate task_node_opened is structural waste.",
      "  runtime.prompt_self_inspect({ task_id }) — re-compose the prompt with section names + priorities + budgets + truncation list. Use when a section keeps dropping under budget.",
      "  USE PATTERNS: ground amendments in audit numbers; if refinement_edge_count > 5 with no commit → emit a closure verifier instead; if system_map omits a kind you want → propose adding it to EVENT_KINDS first; if recent_brain_failures repeats → emit lesson_extracted.kind='failure_pattern' citing the failure ids.",
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
  /** Typical owner-observation window. Suggested baseline vocabulary —
   *  immediate / short / medium / long / very_long — but the column is
   *  open-string so new classifications can emerge per
   *  `FeedbackWindowClassification` in runtime/act_tuple.ts. Used by
   *  emitters to populate predicted_residual.feedback_window when
   *  designing acts. */
  feedback_window_hint: string;
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
  seedName: string;        // stable: id = `seed_<seedName>` when stable_id absent
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
  /** 2026-05-19 (brain 198YWW39K94KH2ZQ1A7XHP2T8R): canonical row id when
   *  the act_artifact must collide with a substrate-emitted
   *  action_artifact_id that does NOT carry the seed_ prefix. Used to
   *  register the 17 named substrate primitives (knowledge_merger_v1,
   *  dispatch_decider_v1, owner_profile_promoter_action, etc) whose
   *  events already exist in the wild and must be credited rather than
   *  skipped as synthetic actuators. When unset, id falls back to
   *  `seed_<seedName>` so legacy seeds keep their stable prefix. */
  stable_id?: string;
  /** 2026-05-20 (Tier-1 + Tier S0 + Tier 6 predicate admission): when
   *  set, overrides the default `alpha = 1 + initial_score * 4` formula
   *  used to derive Beta posterior from `initial_score`. Lets predicate
   *  seeds declare an uninformative Beta(1,1) prior — they learn from
   *  cited action_scored events rather than starting with synthetic
   *  evidence weight. Unset for legacy seeds preserves existing
   *  behavior. */
  posterior_alpha_override?: number;
  posterior_beta_override?: number;
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
    // seedActArtifacts inserts the row directly via INSERT and skips
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
      "// act_artifact_candidate whose name starts with `atms_report_v`",
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
      "//     act_artifact_candidate whose name starts with",
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
    // in seedActArtifacts is content-addressed by body, so editing
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

// ── Substrate-primitive act_artifact rows (2026-05-19) ──────────────
//
// Brain proposal 198YWW39K94KH2ZQ1A7XHP2T8R closes the artifact-credit
// trunk leak. Sixteen named substrate primitives emit `action_scored`
// events against canonical artifact ids (`knowledge_merger_v1`,
// `dispatch_decider_v1`, `owner_profile_promoter_action`, etc) that are
// NOT registered in `act_artifact`. Credit pipeline correctly skipped
// them as "synthetic actuators" (runtime/credit.ts:558-568), leaving
// ~3 100 weekly scored events with 0 posterior update.
//
// These rows REGISTER each primitive at its canonical name. After
// admission the same action_scored path that today flows through
// credit's fallback branch will hit the registered row's Beta posterior
// (`updateActionPosterior` / `updateVerifierPosterior`) and update it
// against the 7-day empirical residuals captured below.
//
// Status: admitted. We skip the cold-start verifier because each
// primitive already has thousands of successful production runs;
// initial_score is grounded in the avg residual observed over the last
// 168 hours.
//
// Idempotency: same hash-gated upgrade path as the legacy seeds —
// re-running the seeder neither duplicates rows nor wipes posteriors.
const SUBSTRATE_PRIMITIVE_SANDBOX: SandboxDecl = {
  runtime: "bun",
  substrate_access: "rw",
  cpu_ms: 5000,
  wall_ms: 10000,
  memory_mb: 64,
  fs_read: [],
  fs_write: [],
  net_allow: [],
  proc_allow: [],
};

const SUBSTRATE_PRIMITIVE_ARTIFACTS: SeedArtifact[] = [
  {
    stable_id: "knowledge_merger_v1",
    seedName: "knowledge_merger_v1",
    runtime: "bun",
    body: "Substrate primitive — runtime/knowledge_merger.ts; semantic dedup + posterior promotion of knowledge candidates emitted by Claude and the brain (Model D merger).",
    declared_sandbox: SUBSTRATE_PRIMITIVE_SANDBOX,
    state_root: "substrate/primitive/knowledge_merger",
    initial_score: 0.8,
    initial_confidence: 0.7,
    fixture_input: { evidence_window_hours: 168, scored_count: 964, expected_residual: 0.2 },
    fixture_expected_residual: 0.2,
    display_name: "Knowledge merger — semantic dedup + posterior promotion",
    kind: "merger",
  },
  {
    stable_id: "opencode_brain_exit_action",
    seedName: "opencode_brain_exit_action",
    runtime: "bun",
    body: "Substrate primitive — runtime/opencode_bridge.ts; bridge exit classification (clean/dispatcher_violation/refinement_depth_exceeded/verifier_residual_high) for opencode brain runs.",
    declared_sandbox: SUBSTRATE_PRIMITIVE_SANDBOX,
    state_root: "substrate/primitive/opencode_brain_exit",
    initial_score: 1.0,
    initial_confidence: 0.85,
    fixture_input: { evidence_window_hours: 168, scored_count: 727, expected_residual: 0.0 },
    fixture_expected_residual: 0.0,
    display_name: "OpenCode brain exit action — bridge exit classification",
    kind: "exit_classifier",
  },
  {
    stable_id: "owner_profile_promoter_action",
    seedName: "owner_profile_promoter_action",
    runtime: "bun",
    body: "Substrate primitive — runtime/owner_profile_promoter.ts; schema-validated merge of owner_insight_candidate → owner_profile_recorded.",
    declared_sandbox: SUBSTRATE_PRIMITIVE_SANDBOX,
    state_root: "substrate/primitive/owner_profile_promoter",
    initial_score: 1.0,
    initial_confidence: 0.85,
    fixture_input: { evidence_window_hours: 168, scored_count: 326, expected_residual: 0.0 },
    fixture_expected_residual: 0.0,
    display_name: "Owner profile promoter — schema-validated profile merge",
    kind: "promoter",
  },
  {
    stable_id: "recipe_cluster_extraction_action",
    seedName: "recipe_cluster_extraction_action",
    runtime: "bun",
    body: "Substrate primitive — substrate/extractors.ts; successful-trajectory compression into reusable recipe rows (goal_shape × topology clustering).",
    declared_sandbox: SUBSTRATE_PRIMITIVE_SANDBOX,
    state_root: "substrate/primitive/recipe_cluster_extraction",
    initial_score: 0.9,
    initial_confidence: 0.8,
    fixture_input: { evidence_window_hours: 168, scored_count: 209, expected_residual: 0.1 },
    fixture_expected_residual: 0.1,
    display_name: "Recipe cluster extractor — successful trajectory compression",
    kind: "extractor",
  },
  {
    stable_id: "knowledge_promotion_action",
    seedName: "knowledge_promotion_action",
    runtime: "bun",
    body: "Substrate primitive — runtime/knowledge_promotion.ts; candidate → promoted_knowledge transition (Beta posterior threshold + corroboration evidence).",
    declared_sandbox: SUBSTRATE_PRIMITIVE_SANDBOX,
    state_root: "substrate/primitive/knowledge_promotion",
    initial_score: 0.9,
    initial_confidence: 0.8,
    fixture_input: { evidence_window_hours: 168, scored_count: 176, expected_residual: 0.1 },
    fixture_expected_residual: 0.1,
    display_name: "Knowledge promotion — candidate to promoted knowledge",
    kind: "promoter",
  },
  {
    stable_id: "dispatch_decider_v1",
    seedName: "dispatch_decider_v1",
    runtime: "bun",
    body: "Substrate primitive — runtime/dispatch_decider.ts; route selection (substrate_replay / claude_inline / opencode_brain / clarification / deferred_blocked) by residual evidence and owner-control signals.",
    declared_sandbox: SUBSTRATE_PRIMITIVE_SANDBOX,
    state_root: "substrate/primitive/dispatch_decider",
    initial_score: 0.67,
    initial_confidence: 0.7,
    fixture_input: { evidence_window_hours: 168, scored_count: 172, expected_residual: 0.33 },
    fixture_expected_residual: 0.33,
    display_name: "Dispatch decider — route selection by residual evidence",
    kind: "decider",
  },
  {
    stable_id: "lesson_apply_gate_action",
    seedName: "lesson_apply_gate_action",
    runtime: "bun",
    body: "Substrate primitive — runtime/lesson_apply_gate.ts; implementation readiness check for lesson_extracted → contract_amendment_proposed / auto_apply pipeline.",
    declared_sandbox: SUBSTRATE_PRIMITIVE_SANDBOX,
    state_root: "substrate/primitive/lesson_apply_gate",
    initial_score: 0.9,
    initial_confidence: 0.8,
    fixture_input: { evidence_window_hours: 168, scored_count: 133, expected_residual: 0.1 },
    fixture_expected_residual: 0.1,
    display_name: "Lesson apply gate — implementation readiness check",
    kind: "action",
  },
  {
    stable_id: "claude_agent_apply_change_action",
    seedName: "claude_agent_apply_change_action",
    runtime: "bun",
    body: "Substrate primitive — runtime/claude_agent_apply.ts; repository mutation wrapper for Claude-side apply of owner-approved or eligible contract amendments.",
    declared_sandbox: SUBSTRATE_PRIMITIVE_SANDBOX,
    state_root: "substrate/primitive/claude_agent_apply_change",
    initial_score: 0.9,
    initial_confidence: 0.8,
    fixture_input: { evidence_window_hours: 168, scored_count: 96, expected_residual: 0.1 },
    fixture_expected_residual: 0.1,
    display_name: "Claude agent apply change — repository mutation wrapper",
    kind: "action",
  },
  {
    stable_id: "lesson_extractor_v1",
    seedName: "lesson_extractor_v1",
    runtime: "bun",
    body: "Substrate primitive — substrate/extractors.ts; future-failure prevention signal extracted from substantive trajectories (verifier/sandbox/retrieval/recipe failure patterns).",
    declared_sandbox: SUBSTRATE_PRIMITIVE_SANDBOX,
    state_root: "substrate/primitive/lesson_extractor",
    initial_score: 0.6,
    initial_confidence: 0.6,
    fixture_input: { evidence_window_hours: 168, scored_count: 72, expected_residual: 0.4 },
    fixture_expected_residual: 0.4,
    display_name: "Lesson extractor — future failure prevention signal",
    kind: "extractor",
  },
  {
    stable_id: "closure_verifier_v1",
    seedName: "closure_verifier_v1",
    runtime: "bun",
    body: "Substrate primitive — runtime/closure_verifier.ts; audits the directive against trajectory and emits task_closure_audited with closure_residual; root task gated until closure_residual < 0.3.",
    declared_sandbox: SUBSTRATE_PRIMITIVE_SANDBOX,
    state_root: "substrate/primitive/closure_verifier",
    initial_score: 0.82,
    initial_confidence: 0.75,
    fixture_input: { evidence_window_hours: 168, scored_count: 58, expected_residual: 0.18 },
    fixture_expected_residual: 0.18,
    display_name: "Closure verifier — task completion audit",
    kind: "verifier",
  },
  {
    stable_id: "intent_classifier_v1",
    seedName: "intent_classifier_v1",
    runtime: "bun",
    body: "Substrate primitive — runtime/intent_classifier.ts; directive ingress classification (intent_classified event) that selects the prompt template and constrains eligible emission lanes.",
    declared_sandbox: SUBSTRATE_PRIMITIVE_SANDBOX,
    state_root: "substrate/primitive/intent_classifier",
    initial_score: 0.46,
    initial_confidence: 0.55,
    fixture_input: { evidence_window_hours: 168, scored_count: 46, expected_residual: 0.54 },
    fixture_expected_residual: 0.54,
    display_name: "Intent classifier — directive ingress route constraint",
    kind: "decider",
  },
  {
    stable_id: "citation_chooser_v1",
    seedName: "citation_chooser_v1",
    runtime: "bun",
    body: "Substrate primitive — runtime/citation_chooser.ts; retrieval-binding citation selector that closes the k_554 mutation-on-citation loop.",
    declared_sandbox: SUBSTRATE_PRIMITIVE_SANDBOX,
    state_root: "substrate/primitive/citation_chooser",
    initial_score: 0.8,
    initial_confidence: 0.7,
    fixture_input: { evidence_window_hours: 168, scored_count: 41, expected_residual: 0.2 },
    fixture_expected_residual: 0.2,
    display_name: "Citation chooser — retrieval binding credit closure",
    kind: "decider",
  },
  {
    stable_id: "recipe_confidence_bump_action",
    seedName: "recipe_confidence_bump_action",
    runtime: "bun",
    body: "Substrate primitive — runtime/recipe_posterior.ts; posterior updater for recipe rows after a successful replay (Beta evidence accrual against the recipe's canonical_id).",
    declared_sandbox: SUBSTRATE_PRIMITIVE_SANDBOX,
    state_root: "substrate/primitive/recipe_confidence_bump",
    initial_score: 0.9,
    initial_confidence: 0.8,
    fixture_input: { evidence_window_hours: 168, scored_count: 39, expected_residual: 0.1 },
    fixture_expected_residual: 0.1,
    display_name: "Recipe confidence bump — replay posterior updater",
    kind: "action",
  },
  {
    stable_id: "predicate_gate_v1",
    seedName: "predicate_gate_v1",
    runtime: "bun",
    body: "Substrate primitive — runtime/predicate_gate.ts; structural admission/refusal scorer applied to contract amendments and apply proposals (well-formed diff, low residual, clean trajectory).",
    declared_sandbox: SUBSTRATE_PRIMITIVE_SANDBOX,
    state_root: "substrate/primitive/predicate_gate",
    initial_score: 0.9,
    initial_confidence: 0.8,
    fixture_input: { evidence_window_hours: 168, scored_count: 27, expected_residual: 0.1 },
    fixture_expected_residual: 0.1,
    display_name: "Predicate gate — structural admission/refusal scorer",
    kind: "predicate",
  },
  {
    stable_id: "auto_apply_worker_stage2_action",
    seedName: "auto_apply_worker_stage2_action",
    runtime: "bun",
    body: "Substrate primitive — runtime/workers/auto_apply.ts; stage-2 amendment application worker (post-predicate-gate apply for owner-eligible contract_amendment_proposed rows).",
    declared_sandbox: SUBSTRATE_PRIMITIVE_SANDBOX,
    state_root: "substrate/primitive/auto_apply_worker_stage2",
    initial_score: 0.9,
    initial_confidence: 0.8,
    fixture_input: { evidence_window_hours: 168, scored_count: 9, expected_residual: 0.1 },
    fixture_expected_residual: 0.1,
    display_name: "Auto-apply worker stage 2 — amendment application stage",
    kind: "action",
  },
  {
    stable_id: "refinement_edge_opener_v1",
    seedName: "refinement_edge_opener_v1",
    runtime: "bun",
    body: "Substrate primitive — runtime/task_topology.ts; depth/fanout task expansion via refinement_edge_recorded + task_node_opened (bounded_peek + symbolic_recursion edges).",
    declared_sandbox: SUBSTRATE_PRIMITIVE_SANDBOX,
    state_root: "substrate/primitive/refinement_edge_opener",
    initial_score: 0.21,
    initial_confidence: 0.4,
    fixture_input: { evidence_window_hours: 168, scored_count: 5, expected_residual: 0.79 },
    fixture_expected_residual: 0.79,
    display_name: "Refinement edge opener — depth/fanout task expansion",
    kind: "action",
  },
  // ── Canonical verifier_kind seeds (brain ZNYFGRV8NS33B1EZR3S8T80DZR) ──
  //
  // Six canonical verifier_kinds receive admitted act_artifact rows so
  // verifier-side credit can flow at observation time. Stable_id is the
  // BARE canonical name (NOT prefixed) — consistent with commit d84618d's
  // lift gate which sets action_artifact_id = verifier_kind verbatim, and
  // with the 16 substrate-primitive rows above (knowledge_merger_v1 etc.)
  // whose ids are also bare. Auto-admit gate in runtime/events.ts
  // (verifier_kind_auto_admitted) handles variants on first observation;
  // these rows are the named provenance handle for credit.
  {
    stable_id: "deterministic_code",
    seedName: "deterministic_code",
    runtime: "bun",
    body: "Canonical verifier — deterministic code/runtime invariant check. Auto-admit gate (runtime/events.ts) registers variants on first observation; this row is the named provenance handle for credit.",
    declared_sandbox: SUBSTRATE_PRIMITIVE_SANDBOX,
    state_root: "substrate/primitive/verifier_deterministic_code",
    initial_score: 0.7,
    initial_confidence: 0.7,
    fixture_input: { evidence_window_hours: 168, live_inventory_count: 13, fixture_expected_residual: 0.30 },
    fixture_expected_residual: 0.30,
    display_name: "Deterministic code verifier — substrate/runtime invariant check",
    kind: "verifier",
  },
  {
    stable_id: "peer_llm_opencode",
    seedName: "peer_llm_opencode",
    runtime: "bun",
    body: "Canonical verifier — peer LLM critique / brain self-review. Auto-admit gate (runtime/events.ts) registers variants on first observation; this row is the named provenance handle for credit. peer_llm_opencode_* variants collapse to this parent until promotion criteria met (≥3 obs, ≥2 directives, OR residual diverges by ≥ 0.20).",
    declared_sandbox: SUBSTRATE_PRIMITIVE_SANDBOX,
    state_root: "substrate/primitive/verifier_peer_llm_opencode",
    initial_score: 0.6,
    initial_confidence: 0.6,
    fixture_input: { evidence_window_hours: 168, live_inventory_count: 5, fixture_expected_residual: 0.40 },
    fixture_expected_residual: 0.40,
    display_name: "Peer LLM critique verifier — brain self-review",
    kind: "verifier",
  },
  {
    stable_id: "auto_apply_gate",
    seedName: "auto_apply_gate",
    runtime: "bun",
    body: "Canonical verifier — auto-apply eligibility (freshness × duplicate × novelty × necessity × review axes). Auto-admit gate (runtime/events.ts) registers variants on first observation; this row is the named provenance handle for credit.",
    declared_sandbox: SUBSTRATE_PRIMITIVE_SANDBOX,
    state_root: "substrate/primitive/verifier_auto_apply_gate",
    initial_score: 0.7,
    initial_confidence: 0.65,
    fixture_input: { evidence_window_hours: 168, live_inventory_count: 2, fixture_expected_residual: 0.30 },
    fixture_expected_residual: 0.30,
    display_name: "Auto-apply eligibility verifier — freshness × duplicate × novelty × necessity × review axes",
    kind: "verifier",
  },
  {
    stable_id: "brain_self_audit_checklist",
    seedName: "brain_self_audit_checklist",
    runtime: "bun",
    body: "Canonical verifier — brain self-audit checklist (closure_audit named-check evaluator). Auto-admit gate (runtime/events.ts) registers variants on first observation; this row is the named provenance handle for credit.",
    declared_sandbox: SUBSTRATE_PRIMITIVE_SANDBOX,
    state_root: "substrate/primitive/verifier_brain_self_audit_checklist",
    initial_score: 0.65,
    initial_confidence: 0.6,
    fixture_input: { evidence_window_hours: 168, live_inventory_count: 0, fixture_expected_residual: 0.35 },
    fixture_expected_residual: 0.35,
    display_name: "Brain self-audit checklist verifier — closure_audit named-check evaluator",
    kind: "verifier",
  },
  {
    stable_id: "owner_confirmation",
    seedName: "owner_confirmation",
    runtime: "bun",
    body: "Canonical verifier — owner-observed confirmation (owner-truth provenance). Auto-admit gate (runtime/events.ts) registers variants on first observation; this row is the named provenance handle for credit.",
    declared_sandbox: SUBSTRATE_PRIMITIVE_SANDBOX,
    state_root: "substrate/primitive/verifier_owner_confirmation",
    initial_score: 0.8,
    initial_confidence: 0.7,
    fixture_input: { evidence_window_hours: 168, live_inventory_count: 0, fixture_expected_residual: 0.20 },
    fixture_expected_residual: 0.20,
    display_name: "Owner-observed confirmation verifier — owner-truth provenance",
    kind: "verifier",
  },
  {
    stable_id: "external_signal",
    seedName: "external_signal",
    runtime: "bun",
    body: "Canonical verifier — external signal (webhook / system event provenance). Auto-admit gate (runtime/events.ts) registers variants on first observation; this row is the named provenance handle for credit.",
    declared_sandbox: SUBSTRATE_PRIMITIVE_SANDBOX,
    state_root: "substrate/primitive/verifier_external_signal",
    initial_score: 0.6,
    initial_confidence: 0.55,
    fixture_input: { evidence_window_hours: 168, live_inventory_count: 0, fixture_expected_residual: 0.40 },
    fixture_expected_residual: 0.40,
    display_name: "External signal verifier — webhook/system event provenance",
    kind: "verifier",
  },
];

// ── Tier -1 + Tier S0 + Tier 6 scoreable predicates (2026-05-20) ─────
//
// Per docs/roadmap.md: 30 documented predicates (5 Tier-1 recursion-
// stop floors, 5 Tier S0 owner-alignment, 20 Tier 6 scoreable
// assumptions) had no act_artifact rows. The substrate's posterior +
// credit machinery scores predicates only when they exist as rows;
// every roadmap-documented predicate was dead code until admission.
//
// Each row carries the verbatim problem / contract / why /
// closure_predicate / metric_direction from roadmap.md (encoded as
// JSON in `body`) plus an uninformative Beta posterior (alpha=beta=1,
// score=0.5, confidence=0.3). Calibration accrues from
// action_scored events that cite these predicate ids — the same
// universal-projector path d8baa7e shipped.
//
// Same-ID upserts preserve posterior history (k_555 four-link chain).
// State root prefix `substrate/primitive/predicate/<name>` keeps the
// rows inside the existing primitive partition so the kind-column
// test continues to assert primitive rows carry non-'code_artifact'
// kinds without further test surgery.

type PredicateSeed = {
  name: string;
  tier: "tier_minus_1_floor" | "tier_s0_owner_alignment" | "tier_6_scoreable_assumption";
  problem: string;
  contract: string;
  why: string;
  closure_predicate: string;
  metric_direction: string;
  display_name: string;
  evaluator_artifact_id?: string;
  consumer_gate?: string;
};

const PREDICATE_SEEDS: PredicateSeed[] = [
  // ── Tier -1 (5 recursion-stop floor predicates) ───────────────────
  {
    name: "event_authenticity_predicate",
    tier: "tier_minus_1_floor",
    problem: "forged events can make every downstream score self-confirming.",
    contract: "accept ledger evidence only through authenticated append paths.",
    why: "causal, credit, and retrieval evidence depends on event origin.",
    closure_predicate: "no unauthenticated event accepted; violation forces quarantine.",
    metric_direction: "authenticity violations stay zero.",
    display_name: "Event authenticity floor — authenticated ledger append path",
  },
  {
    name: "storage_integrity_predicate",
    tier: "tier_minus_1_floor",
    problem: "SQLite/WAL or filesystem corruption can rewrite memory.",
    contract: "integrity checks, checkpoint evidence, and backup/export recovery preserve ledger bytes.",
    why: "retrieval and time reasoning are meaningless over corrupt state.",
    closure_predicate: "no failed integrity check without quarantine.",
    metric_direction: "integrity failures stay zero and recovery evidence remains fresh.",
    display_name: "Storage integrity floor — SQLite/WAL integrity + recovery evidence",
  },
  {
    name: "kernel_sandbox_integrity_predicate",
    tier: "tier_minus_1_floor",
    problem: "a compromised kernel or unenforced sandbox can fake observations.",
    contract: "sandbox enforcement/degradation is explicit and resource claims are not trusted when the floor fails.",
    why: "artifact observations are only useful if runtime boundaries hold.",
    closure_predicate: "sandbox violations/degradations are surfaced and never scored as clean success.",
    metric_direction: "silent sandbox bypass stays zero.",
    display_name: "Kernel sandbox integrity floor — explicit enforcement/degradation",
  },
  {
    name: "deterministic_computation_sanity_predicate",
    tier: "tier_minus_1_floor",
    problem: "arithmetic or deterministic recomputation faults can invalidate residuals.",
    contract: "verifier computation is repeatable within declared tolerance.",
    why: "residual is the universal score.",
    closure_predicate: "deterministic fixtures agree or the scorer quarantines its result.",
    metric_direction: "recomputation mismatches stay zero.",
    display_name: "Deterministic computation sanity floor — verifier repeatability",
  },
  {
    name: "owner_identity_continuity_predicate",
    tier: "tier_minus_1_floor",
    problem: "spoofed or discontinuous owner authority can optimize the wrong goal.",
    contract: "owner input remains bound to the same authority channel before irreversible or high-control actions.",
    why: "every posterior is subordinate to owner intent.",
    closure_predicate: "identity discontinuity triggers owner-input-required rather than autonomous commit.",
    metric_direction: "unresolved identity discontinuities stay zero.",
    display_name: "Owner identity continuity floor — authority channel binding",
  },
  // ── 2026 research integration (2026-05-20) ────────────────────────
  // Three predicates landing the post-roadmap 2026-research enhancements:
  // SSGM memory reconciliation (Tier -1), SAHOO recursive-self-improvement
  // safeguard (Tier -1), AgentCity constitutional ratification (Tier S0).
  {
    name: "memory_reconciliation_predicate",
    tier: "tier_minus_1_floor",
    problem: "mutable in-memory caches (embedder buffer, hot-reload state, prompt_composer cache, threshold registry TTL, SQL worker pool prepared statements, owner_profile maps) can drift silently from the immutable event ledger; without periodic reconciliation, downstream posteriors compound stale state.",
    contract: "periodically project the ledger to a deterministic per-cache hash; compare against live cache hash; mismatch emits memory_reconciliation_drift_detected and flushes the cache. Grounds in SSGM Lam, Li, Zhang, Zhao 2026 (arXiv:2603.11768) — Stability and Safety-Governed Memory framework Reconciliation operator R.",
    why: "Tier -1 floor: without cache-vs-ledger reconciliation, every Tier-S extractor reads possibly-stale state — invalidates posterior compounding.",
    closure_predicate: "ledger projection hash matches live cache hash across all surfaces; mismatches trigger flush and emit drift_detected.",
    metric_direction: "drift_detected count stays bounded; reconciliation_completed ticks fire on cadence.",
    display_name: "Memory reconciliation — SSGM operator R for mutable caches vs ledger",
  },
  {
    name: "recursive_self_improvement_safeguard_predicate",
    tier: "tier_minus_1_floor",
    problem: "Kriger 2026 proves goal preservation under recursive self-improvement is subject to a formal upper bound under lossy compression; without a concrete gate that ACTS on the bound, drift accumulates silently.",
    contract: "evaluate Go/No-Go gate before amendment apply: drift_score (from integrity_check_failed + memory_reconciliation_drift_detected + closure_blocked_high_residual + owner_identity_discontinuity events in 24h window) must stay below sahoo_drift_bound threshold; high-impact targets additionally require non-empty evidence_event_ids chain. Per SAHOO Sahoo, Chadha, Jain, Chaudhary 2026 (arXiv:2603.06333) three safeguards: Go/No-Go gate, constraint-preserving evidence chain, intrinsic diagnostics 5-tuple.",
    why: "Tier -1 floor: SAHOO is the formal mechanism that ACTS on Kriger's drift bound; without it, owner_goal_preservation_drift_predicate scores drift but the substrate has no concrete refusal gate.",
    closure_predicate: "drift_score < bound AND high-impact amendments cite evidence chain; sahoo_diagnostics_recorded 5-tuple emitted per 10min tick.",
    metric_direction: "drift_bound_headroom stays positive; Go/No-Go refusals rise when drift accumulates and fall when reconciled.",
    display_name: "Recursive self-improvement safeguard — SAHOO Go/No-Go + constraint-preserving + diagnostics",
  },
  {
    name: "constitutional_amendment_ratification_predicate",
    tier: "tier_s0_owner_alignment",
    problem: "closure gate is executive-only refusal; high-impact amendments (repo:runtime/, repo:substrate/, repo:cli/) need legislative ratification across multiple verifiers, not single-gate apply.",
    contract: "for high-impact target_resources, amendment apply requires multi-verifier consensus: (1) deterministic_code verifier (tests pass + anchor matches live file), (2) peer_llm verifier (second-pass review residual < 0.3), (3) owner_consent when owner_profile.things_to_never_do is touched. Lower-impact amendments retain single-verifier path. Per AgentCity Ruan & Zhang 2026 (arXiv:2604.07007) Separation of Power constitutional governance architecture.",
    why: "Tier S0: constitutional separation of legislative/executive/judicial roles in LLM-MAS enables causal attribution. Single closure gate cannot prevent the closure_blocked_high_residual override path from laundering autonomous-commit creep into high-impact files.",
    closure_predicate: "ratification_recorded for every high-impact amendment apply; refusals fire on missing verifier consensus.",
    metric_direction: "high-impact amendment refusal rate stays bounded by verifier-disagreement rate; autonomous-commit reversals on high-impact targets fall to zero.",
    display_name: "Constitutional amendment ratification — AgentCity SoP multi-verifier consensus",
  },
  // ── Tier S0 owner alignment (8 tiered predicates) ─────────────────
  // Per brain dispatch 70XT4ZKMBH5CQ3A3 amendment Q29A3DWAHN69F4TQPB:
  // owner alignment is a tiered decomposition of 8 scoreable boundaries
  // (floor + policy + safety + state + forecast + rendering + belief +
  // orchestration), not a flat list of 5 predicates. Each boundary
  // grounds in specific 2026 papers and feeds the next.
  {
    name: "owner_goal_preservation_drift_predicate",
    tier: "tier_s0_owner_alignment",
    problem: "accumulated owner-profile, knowledge-merger, embedding, retrieval top-K, or summarized-session state drifts from fresh owner evidence under lossy compression; without a drift floor every downstream owner posterior compounds error.",
    contract: "detect when accumulated owner state diverges from fresh owner evidence; ground in Kriger 2026 (academia.edu/131938021) formal goal-preservation upper bound under lossy compression. High drift residual blocks autonomous commit and opens owner reconciliation or evidence refresh.",
    why: "S0 floor — guards every downstream owner-profile posterior against lossy compression drift ceiling before continual learning, forecasting, rendering, or belief modeling fires.",
    closure_predicate: "drift residual stays below the Kriger upper bound; violations trigger owner_input_required + evidence refresh.",
    metric_direction: "drift residual falls after reconciliation; autonomous-commit reversals fall.",
    evaluator_artifact_id: "owner_goal_preservation_drift_evaluator_v1",
    consumer_gate: "cli/apply.ts deterministicApplyRoute blocks AUTO_APPLY when drift residual >= 0.6 and emits owner_input_required",
    display_name: "Owner goal-preservation drift — Kriger-bounded compression-drift floor",
  },
  {
    name: "metacognitive_owner_policy_predicate",
    tier: "tier_s0_owner_alignment",
    problem: "owner alignment is not only per-cycle inference; the policy that selects owner interactions (learn vs ask vs defer vs compress) drifts without metacognitive scoring across sessions.",
    contract: "track per-session and cross-session metacognitive policy state via dual-loop policy optimization; ground in HILA Yang, Cao, Pang, Weng, Liu 2026 (arXiv 2603.07972) — Dual-Loop Policy Optimization with continual learning. Closest architectural match to acc2's event-ledger + posterior-compounding design.",
    why: "S0 policy — meta-policy state must be scored across sessions, not collapsed to per-task posteriors.",
    closure_predicate: "outer-loop GRPO reward improves across sessions; per-cycle DPO loss converges within budget.",
    metric_direction: "metacognitive policy drift falls; cost-aware reward improves.",
    evaluator_artifact_id: "metacognitive_owner_policy_evaluator_v1",
    consumer_gate: "cli/apply.ts deterministicApplyRoute blocks AUTO_APPLY when metacognitive owner-policy residual >= 0.6 and the recommended policy action is ask or defer",
    display_name: "Metacognitive owner policy — HILA Dual-Loop Policy Optimization with continual learning",
  },
  {
    name: "delegation_safety_predicate",
    tier: "tier_s0_owner_alignment",
    problem: "delegation choice (autonomous-commit vs ask owner vs route Claude inline vs route brain vs defer) is currently advisory prose, not verifier-scored.",
    contract: "score the delegation decision as a safety boundary; ground in SBD Sun 2026 (arXiv 2604.27358) safe bilevel delegation and COSMIC Vashishtha et al. IEEE 2026 self-supervised agent selection with self-invocation loop prevention.",
    why: "S0 safety — delegation is high-leverage owner-control gate; advisory delegation collapses to autonomous-commit creep.",
    closure_predicate: "delegation_safety residual scored on every dispatch_decided; autonomous-commit reversals + owner_input_required precision both move.",
    metric_direction: "autonomous-commit reversals fall; owner-input-required precision rises.",
    evaluator_artifact_id: "delegation_safety_evaluator_v1",
    consumer_gate: "cli/apply.ts deterministicApplyRoute downgrades unsafe AUTO_APPLY recommendations to owner-gate/defer at the final autonomous-commit decision",
    display_name: "Delegation safety — SBD bilevel + COSMIC SSA scored boundary",
  },
  {
    name: "continual_owner_state_predicate",
    tier: "tier_s0_owner_alignment",
    problem: "split estimator/transition pair forced flat per-cycle inference; owner state and its dynamics across sessions must compound, not collapse.",
    contract: "infer latent owner state and transition dynamics jointly across sessions; ground in VARS variance-aware reward shaping (arXiv 2603.20939), POPI personalized-objective inference (arXiv 2510.17881), Causal Preference Learning (arXiv 2506.05967), Adaptive Alignment MORL (arXiv 2410.23630), Anchor-guided Variance-aware Reward Modeling (Fang et al. 2026, arXiv:2605.11865), and Personalized RewardBench (Ma et al. 2026) as the canonical benchmark target.",
    why: "S0 state — supersedes the split estimator+transition pair; continual learning across sessions is the right granularity.",
    closure_predicate: "joint state-and-transition outputs match owner-observed outcome on a calibration window; posteriors compound across sessions.",
    metric_direction: "owner-state estimation + transition forecast error falls.",
    evaluator_artifact_id: "continual_owner_state_evaluator_v1",
    consumer_gate: "cli/apply.ts deterministicApplyRoute recycles AUTO_APPLY when continual owner-state residual >= 0.6, after drift/delegation/metacognitive gates preserve their existing downgrade reasons",
    display_name: "Continual owner state — joint state + transition across sessions",
  },
  {
    name: "owner_outcome_forecast_predicate",
    tier: "tier_s0_owner_alignment",
    problem: "owner-observed outcome must be predicted before commit so reversible decisions can be re-checked; pre-fix this was the only pre-commit owner check.",
    contract: "predict owner-observed outcome before commit, consuming drift, metacognitive policy, and delegation-safety residuals as inputs; ground in PAHF predictive alignment from human feedback (arXiv 2602.16173), COPR cumulative online preference reward (arXiv 2402.14228), and Personalized RewardBench (Ma et al. 2026).",
    why: "S0 forecast — pre-commit owner outcome forecasting, now downstream of drift + policy + safety rather than acting alone.",
    closure_predicate: "forecast residual converges to observed owner residual; consumes upstream S0 floor + policy + safety residuals.",
    metric_direction: "owner-forecast residual falls.",
    evaluator_artifact_id: "owner_outcome_forecast_evaluator_v1",
    consumer_gate: "cli/apply.ts deterministicApplyRoute gates AUTO_APPLY on owner_outcome_forecast_predicate after continual owner-state; reject forecasts recycle, revise forecasts route to owner gate, and later owner_observed_outcome_recorded rows calibrate residuals through runtime/owner_outcome_channel.ts",
    display_name: "Owner outcome forecast — pre-commit prediction consuming drift/policy/safety",
  },
  {
    name: "owner_rendering_predicate",
    tier: "tier_s0_owner_alignment",
    problem: "owner-visible rendering must select profile-conditioned variants; without delegation safety upstream, rendering can launder decisions that should have asked the owner.",
    contract: "score owner-visible rendering before it reaches the owner, consuming preferred_terms, avoided_terms, detected_language, exposed_concepts, declined_concepts, and rendering_signals from the owner profile; ground in Adaptive Querying with AI Persona Priors (arXiv 2605.00696) and Personalized RewardBench (Ma et al. 2026).",
    why: "S0 rendering — owner trust is evidence-bearing; rendering pipeline must NOT auto-format around an autonomous-commit decision delegation_safety would have refused.",
    closure_predicate: "rendering audits + owner feedback agree on chosen variant AND delegation_safety/owner_outcome_forecast did not refuse upstream.",
    metric_direction: "rendering misses fall; rendering-laundered autonomous commits fall to zero.",
    evaluator_artifact_id: "owner_rendering_evaluator_v1",
    consumer_gate: "cli/apply.ts deterministicApplyRoute gates AUTO_APPLY on owner_rendering_predicate after owner_outcome_forecast_predicate; avoided terms, wrong language, or declined concept exposure recycle before owner-visible display",
    display_name: "Owner rendering — profile-conditioned variant selection, downstream of delegation safety",
  },
  {
    name: "ordered_theory_of_mind_predicate",
    tier: "tier_s0_owner_alignment",
    problem: "flat ToM modeling misses ToM order alignment (first-order: owner thinks X; second-order: owner thinks substrate thinks X) and stages (latent state → moral evaluation).",
    contract: "model owner belief about substrate with an explicit order axis and staged assessment: first-order owner beliefs, second-order owner-about-substrate beliefs, then moral/constraint evaluation; ground in Theory of Mind LLM Agents (arXiv 2509.22887), Adaptive ToM (Mu, Zeng, Zhang, Shao, Chu — AAAI 2026) on ToM-order alignment as critical coordination factor, MetaMind (Zhang, Chen, Yeh, Li — NeurIPS 2026) staged ToM-Agent-to-Moral-Agent assessment, and the ICLR 2026 RSI Workshop agenda.",
    why: "S0 belief — anticipating owner beliefs about substrate capability AT EACH ORDER improves transparency and consent.",
    closure_predicate: "ToM outputs include explicit order axis (or explicit rejection reason); ToM-derived expectations match later owner_input_received corrections.",
    metric_direction: "ToM expectation error falls; order-axis coverage rises.",
    evaluator_artifact_id: "ordered_theory_of_mind_evaluator_v1",
    consumer_gate: "cli/apply.ts deterministicApplyRoute gates AUTO_APPLY on ordered_theory_of_mind_predicate after owner_rendering_predicate; hard constraint misses and order mismatches recycle, sparse ordered-belief evidence routes to owner gate only when residual is high, and owner_state_belief_view plus recent owner events ground nested-belief estimates",
    display_name: "Ordered theory of mind — order-axis + staged ToM-Agent-to-Moral-Agent model",
  },
  {
    name: "orchestrator_predicate",
    tier: "tier_s0_owner_alignment",
    problem: "the seven S0 owner-alignment predicates can each pass locally while the overall orchestration decision remains misaligned because their residuals, verdicts, order, and selected boundary set were never composed into one top-level verdict.",
    contract: "compose owner_goal_preservation_drift, delegation_safety, metacognitive_owner_policy, continual_owner_state, owner_outcome_forecast, owner_rendering, and ordered_theory_of_mind into one scored owner-alignment verdict before autonomous apply. Ground in COSMIC Vashishtha et al. IEEE 2026 self-supervised agent selection with self-invocation loop prevention and the ordered_theory_of_mind S0 boundary just shipped on floor b592551.",
    why: "S0 final composition — owner alignment must be scored at the orchestration level, not only as seven independent local gates.",
    closure_predicate: "orchestrator residual composes all seven S0 sub-predicate residuals/verdicts; AUTO_APPLY survives only when the composed verdict is aligned.",
    metric_direction: "orchestration-level owner-alignment residual falls; autonomous-commit reversals caused by cross-predicate disagreement fall to zero.",
    evaluator_artifact_id: "orchestrator_predicate_evaluator_v1",
    consumer_gate: "cli/apply.ts deterministicApplyRoute gates AUTO_APPLY on orchestrator_predicate after ordered_theory_of_mind_predicate; misaligned compositions recycle and watch compositions route to owner gate while clean compositions preserve AUTO_APPLY",
    display_name: "Orchestrator predicate — top-level S0 owner-alignment composition",
  },
  // ── Tier 6 scoreable assumption predicates (20) ───────────────────
  {
    name: "causal_edge_reliability_predicate",
    tier: "tier_6_scoreable_assumption",
    problem: "graph edges can be decorative.",
    contract: "score whether edges predict closure improvement.",
    why: "later routing trusts edges.",
    closure_predicate: "edge weights move with outcomes.",
    metric_direction: "edge-residual error falls.",
    display_name: "Causal edge reliability — edge-weight outcome correlation",
  },
  {
    name: "intervention_effect_estimation_predicate",
    tier: "tier_6_scoreable_assumption",
    problem: "actions may precede rather than cause improvement.",
    contract: "compare chosen acts to observed residual deltas.",
    why: "credit needs causal evidence.",
    closure_predicate: "intervention forecasts calibrate.",
    metric_direction: "attribution error falls.",
    display_name: "Intervention effect estimation — chosen-act vs residual-delta",
  },
  {
    name: "counterfactual_comparison_predicate",
    tier: "tier_6_scoreable_assumption",
    problem: "rejected alternatives lack fair evidence.",
    contract: "persist near-miss alternatives for after-action scoring.",
    why: "selectors learn from unchosen options.",
    closure_predicate: "counterfactual rows affect routing.",
    metric_direction: "regret falls.",
    display_name: "Counterfactual comparison — near-miss alternative scoring",
  },
  {
    name: "credit_assignment_fidelity_predicate",
    tier: "tier_6_scoreable_assumption",
    problem: "outcome credit can land on uninfluential bindings.",
    contract: "score whether cited knowledge/artifacts actually shaped success.",
    why: "posterior compounding depends on honest credit.",
    closure_predicate: "decorative credit beta rises.",
    metric_direction: "miscredit falls.",
    display_name: "Credit assignment fidelity — citation-shaped-success scoring",
  },
  {
    name: "cost_model_accuracy_predicate",
    tier: "tier_6_scoreable_assumption",
    problem: "token, wall, verifier, and invocation budgets drift.",
    contract: "compare estimates to observations.",
    why: "economics guide dispatch.",
    closure_predicate: "budget residuals calibrate.",
    metric_direction: "forecast error falls.",
    display_name: "Cost model accuracy — budget estimate vs observed",
  },
  {
    name: "opportunity_cost_predicate",
    tier: "tier_6_scoreable_assumption",
    problem: "selected work may delay higher-value objectives.",
    contract: "score expected residual delta against active alternatives.",
    why: "scheduling is economic choice.",
    closure_predicate: "delayed-work regret is measurable.",
    metric_direction: "missed-value residual falls.",
    display_name: "Opportunity cost — residual-delta vs active alternatives",
  },
  {
    name: "artifact_reuse_value_predicate",
    tier: "tier_6_scoreable_assumption",
    problem: "reuse can be cargo cult.",
    contract: "compare reused artifacts/recipes to fresh authoring cost and residual.",
    why: "self-extension needs reusable value.",
    closure_predicate: "reuse posteriors diverge.",
    metric_direction: "residual per cost improves.",
    display_name: "Artifact reuse value — reuse vs fresh-authoring cost/residual",
  },
  {
    name: "marginal_information_value_predicate",
    tier: "tier_6_scoreable_assumption",
    problem: "extra retrieval/review can waste cycles.",
    contract: "score residual reduction per added evidence step.",
    why: "bounded peeks need a stopping rule.",
    closure_predicate: "low-yield peeks decline.",
    metric_direction: "information ROI rises.",
    display_name: "Marginal information value — residual reduction per evidence step",
  },
  {
    name: "source_provenance_reliability_predicate",
    tier: "tier_6_scoreable_assumption",
    problem: "source quality varies after floor authenticity holds.",
    contract: "score provenance against later outcomes.",
    why: "not all authentic sources are reliable.",
    closure_predicate: "provenance posteriors diverge.",
    metric_direction: "source-calibration error falls.",
    display_name: "Source provenance reliability — outcome-vs-provenance calibration",
  },
  {
    name: "retrieval_binding_honesty_predicate",
    tier: "tier_6_scoreable_assumption",
    problem: "citations can be decorative.",
    contract: "bind cited claims to actual action influence.",
    why: "citation is mutation.",
    closure_predicate: "unbound citation rejection works.",
    metric_direction: "decorative citations fall.",
    display_name: "Retrieval binding honesty — citation-influence binding",
  },
  {
    name: "review_cadence_sufficiency_predicate",
    tier: "tier_6_scoreable_assumption",
    problem: "review intervals can miss drift.",
    contract: "score cadence against drift/high-residual incidence.",
    why: "continuity needs timed review.",
    closure_predicate: "cadence adjusts by outcome.",
    metric_direction: "stale-review residual falls.",
    display_name: "Review cadence sufficiency — interval vs drift/residual incidence",
  },
  {
    name: "epistemic_convergence_predicate",
    tier: "tier_6_scoreable_assumption",
    problem: "independent-looking evidence can share one compromised source.",
    contract: "score corroboration independence.",
    why: "merger quality depends on non-circular evidence.",
    closure_predicate: "circular corroboration is contradicted.",
    metric_direction: "false convergence falls.",
    display_name: "Epistemic convergence — corroboration-independence scoring",
  },
  {
    name: "contradiction_resolution_quality_predicate",
    tier: "tier_6_scoreable_assumption",
    problem: "contradictions can be suppressed or duplicated.",
    contract: "score adjudication quality.",
    why: "knowledge improves by resolving conflict.",
    closure_predicate: "resolved contradictions improve closure.",
    metric_direction: "unresolved contradiction age falls.",
    display_name: "Contradiction resolution quality — adjudication scoring",
  },
  {
    name: "calibration_transfer_predicate",
    tier: "tier_6_scoreable_assumption",
    problem: "evidence may over-transfer across goal shapes.",
    contract: "score transfer by class-local outcome.",
    why: "generalization must be earned.",
    closure_predicate: "transferred rules beat local baseline.",
    metric_direction: "transfer regret falls.",
    display_name: "Calibration transfer — class-local-outcome scoring",
  },
  {
    name: "uncertainty_expression_predicate",
    tier: "tier_6_scoreable_assumption",
    problem: "residual packets can hide unknowns.",
    contract: "score whether uncertainty/reliability axes predict later surprises.",
    why: "low residual without uncertainty is overconfidence.",
    closure_predicate: "surprise residual calibrates.",
    metric_direction: "overconfidence falls.",
    display_name: "Uncertainty expression — uncertainty-vs-surprise calibration",
  },
  {
    name: "language_grounding_predicate",
    tier: "tier_6_scoreable_assumption",
    problem: "natural-language referents can drift through execution.",
    contract: "score referent preservation from directive to closure.",
    why: "contracts are linguistic handles.",
    closure_predicate: "drifted referents raise residual.",
    metric_direction: "referent drift falls.",
    display_name: "Language grounding — referent preservation directive-to-closure",
  },
  {
    name: "owner_term_alignment_predicate",
    tier: "tier_6_scoreable_assumption",
    problem: "owner-visible language can violate preferred/avoided terms.",
    contract: "score rendering against owner profile and feedback.",
    why: "owner trust is evidence-bearing.",
    closure_predicate: "feedback and rendering audits calibrate.",
    metric_direction: "rendering misses fall.",
    display_name: "Owner term alignment — preferred/avoided term enforcement",
  },
  {
    name: "semantic_anchor_stability_predicate",
    tier: "tier_6_scoreable_assumption",
    problem: "doc anchors can match text while meaning changes.",
    contract: "score anchor meaning across concurrent edits.",
    why: "auto-apply needs semantic locality.",
    closure_predicate: "stale anchors are refused.",
    metric_direction: "anchor-collision residual falls.",
    display_name: "Semantic anchor stability — anchor-meaning consistency",
  },
  {
    name: "goal_continuity_predicate",
    tier: "tier_6_scoreable_assumption",
    problem: "refinements can optimize a different goal.",
    contract: "score objective preservation across DAG edges.",
    why: "recursion must serve the originating intent.",
    closure_predicate: "goal drift is detected before commit.",
    metric_direction: "drift residual falls.",
    display_name: "Goal continuity — objective preservation across DAG edges",
  },
  {
    name: "ledger_time_consistency_predicate",
    tier: "tier_6_scoreable_assumption",
    problem: "event ordering and due dates can mislead reasoning.",
    contract: "score timestamp/order consistency.",
    why: "causality and review cadence depend on time.",
    closure_predicate: "inconsistent temporal claims raise residual.",
    metric_direction: "temporal inconsistency falls.",
    display_name: "Ledger time consistency — timestamp/order coherence",
  },
];

const PREDICATE_SANDBOX: SandboxDecl = {
  runtime: "bun",
  substrate_access: "ro",
  cpu_ms: 100,
  wall_ms: 1000,
  memory_mb: 8,
  fs_read: [],
  fs_write: [],
  net_allow: [],
  proc_allow: [],
};

const PREDICATE_ARTIFACTS: SeedArtifact[] = PREDICATE_SEEDS.map((p) => ({
  stable_id: `predicate_${p.name}_v1`,
  seedName: `predicate_${p.name}_v1`,
  runtime: "bun" as Runtime,
  // body is the JSON-encoded predicate payload; the substrate's open
  // vocabulary stores the verbatim roadmap.md description so callers
  // (closure verifier, prompt composer, MCP reads) can hydrate the
  // contract from the row without an out-of-band lookup.
  body: JSON.stringify({
    tier: p.tier,
    problem: p.problem,
    contract: p.contract,
    why: p.why,
    closure_predicate: p.closure_predicate,
    metric_direction: p.metric_direction,
    evaluator_artifact_id: p.evaluator_artifact_id,
    consumer_gate: p.consumer_gate,
  }),
  declared_sandbox: PREDICATE_SANDBOX,
  state_root: `substrate/primitive/predicate/${p.name}`,
  // Uninformative prior — they LEARN from observed action_scored
  // residuals citing them. Beta(1,1) ↔ score 0.5, confidence 0.3.
  initial_score: 0.5,
  initial_confidence: 0.3,
  fixture_input: { tier: p.tier, predicate: p.name },
  fixture_expected_residual: 0.5,
  display_name: p.display_name,
  kind: p.name,
  posterior_alpha_override: 1,
  posterior_beta_override: 1,
}));

// ── Threshold predicates (act_artifact{kind:"threshold_predicate"}) ──
//
// Universal threshold registry (runtime/threshold_registry.ts) reads
// the HIGHEST-posterior admitted row whose kind = 'threshold_predicate'
// and name matches the queried threshold name. The body is JSON
// `{value: <number>}` — getThreshold parses body.value.
//
// closure_gate_residual_threshold (default 0.3) gates task_committed:
// the hardened closure commit gate in runtime/closure_audit.ts refuses
// the emission when the referenced task's most recent
// task_closure_audited row carries closure_residual >= this value.
// Brain amendments can propose new variants (per-goal-class, per-risk
// profile, etc.) and the registry resolves to the highest-posterior
// admitted row. Default ships at 0.3 so first-boot installs match the
// documented "closure_residual >= 0.3 → refine, do NOT commit root"
// workflow contract that pre-fix was advisory.
type ThresholdPredicateSeed = {
  name: string;
  value: number;
  display_name: string;
  why: string;
};

const THRESHOLD_PREDICATE_SEEDS: ThresholdPredicateSeed[] = [
  {
    name: "closure_gate_residual_threshold",
    value: 0.3,
    display_name: "closure_gate_residual_threshold",
    why:
      "Hardened closure commit gate (k_252): task_committed is refused when " +
      "the referenced task's most recent task_closure_audited row carries " +
      "closure_residual >= this value. Live evidence (24h) showed 10 commits " +
      "at residual >= 0.3 with the dispatcher's advisory check ignored; the " +
      "gate is now structural and reads this threshold from the registry so " +
      "brain amendments can tune it without editing dispatcher code.",
  },
  {
    name: "archival_retention_days",
    value: 30,
    display_name: "archival_retention_days",
    why:
      "Hot/cold archival retention horizon (docs/Architecture.md commit " +
      "6b8ebea + brain KC TE6P3958, conf=0.86). Events older than this " +
      "value move from hot state.db to sibling state-archive-YYYY-MM.db " +
      "files; only bounded hot retention caps aggregate-scan cost as the " +
      "event ledger grows. Live pre-fix: 301K events in 5.5 days / 746 MB " +
      "projected 50 GB/year. Default 30 days bounds the hot DB at ~30 × " +
      "daily-rate. Brain amendments can tune via posterior calibration.",
  },
];

const THRESHOLD_PREDICATE_ARTIFACTS: SeedArtifact[] = THRESHOLD_PREDICATE_SEEDS.map((t) => ({
  stable_id: `threshold_${t.name}`,
  seedName: `threshold_${t.name}`,
  runtime: "bun" as Runtime,
  // body MUST be `{value: <number>}` — getThreshold parses body.value.
  body: JSON.stringify({ value: t.value, why: t.why }),
  declared_sandbox: PREDICATE_SANDBOX,
  state_root: `substrate/threshold/${t.name}`,
  // Uninformative prior so brain amendments calibrate via cited
  // action_scored events; default value still applies at cold-start
  // because the registry resolves the highest-posterior admitted row.
  initial_score: 0.5,
  initial_confidence: 0.3,
  fixture_input: { name: t.name },
  fixture_expected_residual: 0.5,
  display_name: t.display_name,
  kind: "threshold_predicate",
  posterior_alpha_override: 1,
  posterior_beta_override: 1,
}));

const CLAUDE_PLUGIN_PACKAGE_ARTIFACTS: SeedArtifact[] = [
  {
    seedName: "claude_plugin_package_accint",
    runtime: "bun",
    body: JSON.stringify({
      kind: "claude_plugin_package",
      package_root: ".claude-plugin",
      required_files: [
        ".claude-plugin/plugin.json",
        ".claude-plugin/hooks/hooks.json",
        ".mcp.json",
        ".claude-plugin/substrate/canonical.db",
      ],
      validator: "claude plugin validator",
      install_command: "claude plugins install accint",
    }),
    declared_sandbox: {
      runtime: "bun",
      fs_read: [".claude-plugin/**", ".mcp.json"],
      fs_write: [],
      net_allow: [],
      proc_allow: ["claude"],
      env_requires: [],
      cpu_ms: 1000,
      wall_ms: 5000,
      memory_mb: 128,
    },
    state_root: "release/claude-plugin/accint",
    initial_score: 0.5,
    initial_confidence: 0.3,
    fixture_input: { package_root: ".claude-plugin" },
    fixture_expected_residual: 0.0,
    display_name: "AccInt Claude plugin package",
    kind: "claude_plugin_package",
  },
];

export type ActArtifactSeedSummary = { inserted: number; skipped: number; upgraded?: number };

const seedIdFor = (seedName: string): string => `seed_${seedName}`;

export const seedActArtifacts = (db: Database): ActArtifactSeedSummary => {
  let inserted = 0;
  let skipped = 0;
  let upgraded = 0;
  const initialStatus: ActArtifactStatus = "admitted";

  withImmediateTransaction(db, () => {
    for (const seed of [
      ...SEED_ARTIFACTS,
      ...SUBSTRATE_PRIMITIVE_ARTIFACTS,
      ...PREDICATE_ARTIFACTS,
      ...THRESHOLD_PREDICATE_ARTIFACTS,
      ...CLAUDE_PLUGIN_PACKAGE_ARTIFACTS,
    ]) {
      // 2026-05-19: stable_id takes precedence so substrate-primitive rows
      // collide with the canonical action_artifact_id their events already
      // carry (e.g. knowledge_merger_v1). Legacy seeds without stable_id
      // keep the `seed_<seedName>` form so their content-hash meta keys
      // remain stable across upgrade.
      const id = seed.stable_id ?? seedIdFor(seed.seedName);
      const sandboxJson = JSON.stringify(seed.declared_sandbox);
      const fixtureJson = JSON.stringify(seed.fixture_input);
      // Content hash gates upgrades: when a seed artifact's body,
      // sandbox, or fixture has been improved (as happened 2026-05-18
      // when web_search gained /scholar + /maps endpoints), existing
      // installs should pick the new version up WITHOUT resetting the
      // learned posterior. Same gate-pattern as seedFoundationalKnowledge
      // (commit 7cab996 for laws/bundles). Hash covers behavior-bearing
      // fields; posterior_alpha/beta/score/confidence are preserved.
      // stable_id is mixed into the hash so a row that flips from
      // legacy `seed_<seedName>` to a canonical primitive id (or
      // vice-versa) is detected as content drift and upgraded in place.
      const contentHash = hashSeedRow(
        `artifact:${id}|stable_id:${seed.stable_id ?? ""}|runtime:${seed.runtime}|body:${seed.body}|sandbox:${sandboxJson}|fixture:${fixtureJson}|state_root:${seed.state_root}|kind:${seed.kind ?? "code_artifact"}`,
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
      const alpha = seed.posterior_alpha_override ?? (1 + seed.initial_score * 4);
      const beta = seed.posterior_beta_override ?? (1 + (1 - seed.initial_score) * 4);
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

/** Convenience helper — primarily for tests / the daemon boot path.
 *  Returns the canonical seed ids so callers can join against them.
 *  Substrate primitives use their `stable_id` (matches the
 *  action_artifact_id their events already carry); legacy seeds fall
 *  back to `seed_<seedName>`. */
export const seedArtifactIds = (): string[] => [
  ...SEED_ARTIFACTS.map((s) => s.stable_id ?? seedIdFor(s.seedName)),
  ...SUBSTRATE_PRIMITIVE_ARTIFACTS.map((s) => s.stable_id ?? seedIdFor(s.seedName)),
  ...PREDICATE_ARTIFACTS.map((s) => s.stable_id ?? seedIdFor(s.seedName)),
  ...THRESHOLD_PREDICATE_ARTIFACTS.map((s) => s.stable_id ?? seedIdFor(s.seedName)),
  ...CLAUDE_PLUGIN_PACKAGE_ARTIFACTS.map((s) => s.stable_id ?? seedIdFor(s.seedName)),
];

/** Names of the 30 seeded scoreable predicates (Tier -1 floor +
 *  Tier S0 owner alignment + Tier 6 scoreable assumptions). Exposed
 *  so tests, prompt composer, and closure verifier can join against
 *  the canonical set. Cite docs/roadmap.md for problem/contract text. */
export const PREDICATE_SEED_NAMES = PREDICATE_SEEDS.map((p) => p.name);

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
// posterior loop handles it. The goal_shape_tags on each capability are
// OPEN RETRIEVAL TAGS, not a fixed menu — they let the brain reference a
// specific capability by goal shape when proposing it, but the seed is
// the authoritative source of truth (every example is a row in the ledger).
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
// Given one owner sentence, semantic retrieval ranks the most-confident
// capability example; the orchestrator (Claude Code) synthesizes a fresh
// owner-profile-aware proposal at render time (no canned echo) and offers
// the next concrete step. Confidence ordering is intentional — universal
// examples (learn_topic_deeply, finish_my_goal) score higher than narrow
// vertical matches.

export type DemoCapability = {
  id: string;
  /** Open goal-shape tags used by retrieval and posterior credit. These are
   *  learned vocabulary, not a fixed menu of demonstrations. */
  goal_shape_tags: string[];
  /** Auth the example NEEDS to actually fire. Empty means it works with
   *  zero external services — just the brain + the substrate. */
  requires_auth: string[];
  /** Confidence the example is universally valuable (seed-time prior).
   *  Embedded into the knowledge_promoted payload; the substrate's
   *  posterior loop adjusts from real owner outcomes over time. */
  confidence: number;
  /** "finite" closes on terminal; "rolling_active" stays open and the
   *  Father reopens the review subtask on cadence. */
  lifecycle: "finite" | "rolling_active";
  /** One concise capability description. It is embedded for retrieval but
   *  never surfaced verbatim as a canned demo; renderers synthesize a fresh
   *  owner-profile-aware proposal around the owner's actual goal. */
  capability_description: string;
  /** Why this example can't be replicated by a fresh chat session. Open
   *  strings keep capability discovery in promoted knowledge rows. */
  substrate_capability: string[];
};

export const DEMO_CAPABILITIES: DemoCapability[] = [
  {
    id: "learn_topic_deeply_rolling",
    goal_shape_tags: ["learn_topic_deeply", "rolling_active", "knowledge_compounds"],
    requires_auth: [],
    confidence: 0.88,
    lifecycle: "rolling_active",
    capability_description:
      "The substrate can keep learning a topic over time, preserve what changed between sessions, and use promoted knowledge evidence to make each later answer sharper than a fresh chat.",
    substrate_capability: ["rolling_active", "knowledge_compounds"],
  },
  {
    id: "keep_an_eye_on_anything",
    goal_shape_tags: ["keep_an_eye_on", "rolling_active", "knowledge_compounds"],
    requires_auth: [],
    confidence: 0.86,
    lifecycle: "rolling_active",
    capability_description:
      "The substrate can hold a watch target across sessions, detect genuine state changes, and only surface owner-relevant deltas instead of repeating noise.",
    substrate_capability: ["rolling_active", "knowledge_compounds"],
  },
  {
    id: "finish_my_goal_weekly",
    goal_shape_tags: ["finish_my_goal", "rolling_active", "father_ranked"],
    requires_auth: [],
    confidence: 0.85,
    lifecycle: "rolling_active",
    capability_description:
      "The substrate can decompose a long-running goal into ready next steps, surface them at the right cadence, and credit what actually moved progress.",
    substrate_capability: ["rolling_active", "father_ranked"],
  },
  {
    id: "make_my_decision_grounded",
    goal_shape_tags: ["make_my_decision", "owner_profile_grounded", "knowledge_compounds"],
    requires_auth: [],
    confidence: 0.83,
    lifecycle: "finite",
    capability_description:
      "The substrate can weigh a decision against persistent owner facts and promoted knowledge, ask only about the real gaps, and carry the context forward to future decisions.",
    substrate_capability: ["owner_profile_grounded", "knowledge_compounds"],
  },
  {
    id: "remember_my_life",
    goal_shape_tags: ["remember_my_life", "owner_profile_grounded"],
    requires_auth: [],
    confidence: 0.92,
    lifecycle: "rolling_active",
    capability_description:
      "The substrate can hold durable facts about the owner — how they work, what they avoid, who matters — and ground every later answer on that profile instead of starting blind.",
    substrate_capability: ["owner_profile_grounded"],
  },
  {
    id: "negotiate_for_me",
    goal_shape_tags: ["negotiate_for_me", "stakeholder_tracked", "owner_profile_grounded"],
    requires_auth: [],
    confidence: 0.81,
    lifecycle: "rolling_active",
    capability_description:
      "The substrate can track counterparties across conversations, remember what each responded to, and ground a negotiation in real history instead of a fresh blank.",
    substrate_capability: ["stakeholder_tracked", "owner_profile_grounded"],
  },
  {
    id: "kill_my_recurring_friction",
    goal_shape_tags: ["kill_my_recurring_friction", "recipe_compounds", "knowledge_compounds"],
    requires_auth: [],
    confidence: 0.79,
    lifecycle: "rolling_active",
    capability_description:
      "The substrate can observe a repeated task once, promote it to a callable trajectory, and reuse the trajectory automatically while only escalating genuine judgment calls.",
    substrate_capability: ["recipe_compounds", "knowledge_compounds"],
  },
  {
    id: "find_my_next_move",
    goal_shape_tags: ["find_my_next_move", "father_ranked", "owner_profile_grounded"],
    requires_auth: [],
    confidence: 0.77,
    lifecycle: "finite",
    capability_description:
      "The substrate can rank pending owner intents by likely impact using the owner profile and what is already in flight, so the next move is chosen on evidence not memory.",
    substrate_capability: ["father_ranked", "owner_profile_grounded"],
  },
];

export const composeDemoCapabilityProposal = (
  cap: DemoCapability,
  ownerProfile: Pick<OwnerProfile, "rendering_signals" | "preferred_terms" | "detected_language" | "observation_count"> = {},
  ownerWords = "",
): string => {
  const signals = ownerProfile.rendering_signals ?? {};
  const oneStep = (signals.one_step_at_a_time_vs_batch ?? 0.5) >= 0.5;
  const examples = (signals.concrete_examples_appetite ?? 0) >= 0.5;
  const ownerGoal = ownerWords.trim();
  const term = ownerProfile.preferred_terms?.find((t) => ownerGoal.toLowerCase().includes(t.toLowerCase())) ?? "this goal";
  const capability = cap.substrate_capability.join(", ");
  const frame = ownerGoal.length > 0 ? `For what you said ("${ownerGoal.slice(0, 120)}"), ` : "";
  const proposal = `${frame}I can shape a persistent operating-model loop around ${term}: keep the relevant context, score progress with verifier evidence, and reuse what works instead of picking from a fixed menu.`;
  const next = oneStep ? ` First step: tell me the smallest useful detail about ${term}.` : " Options: start now, narrow the scope, or skip.";
  const example = examples ? ` Example capability evidence retrieved: ${capability}.` : "";
  return `${proposal}${next}${example}`.trim();
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
      // The `claim` is the capability_description — that's what gets
      // embedded and searched. Tags + applies_to carry open goal-shape
      // tags so retrieval ranks by goal shape rather than a fixed
      // recipe-id menu.
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
            claim: cap.capability_description,
            evidence: [
              `substrate capability: ${cap.substrate_capability.join(", ")}`,
              `lifecycle: ${cap.lifecycle}`,
              ...(cap.requires_auth.length > 0
                ? [`requires: ${cap.requires_auth.join(", ")}`]
                : ["requires no external services"]),
            ],
            applies_to: ["demo", "onboarding", ...cap.goal_shape_tags, ...cap.substrate_capability],
            tags: ["demo", "onboarding", "first_run", ...cap.goal_shape_tags],
            proposed_tier: "capability_example",
            confidence_estimate: cap.confidence,
            goal_shape_tags: cap.goal_shape_tags,
            render_policy: "synthesize_owner_profile_grounded_proposal_at_runtime",
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
            goal_shape_tags: cap.goal_shape_tags,
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
          "knowledge_candidate",
          JSON.stringify({
            claim: `Seeded reusable trajectory ${recipe.label} can replay ${recipe.goalText} without a brain call when goal_shape and topology_signature match.`,
            evidence: ["seeded reusable trajectory fixture"],
            implications: ["runtime replay can cite this knowledge row and its act_artifact handles"],
            applies_to: ["reusable_trajectory", goal],
            confidence_estimate: 0.7,
            // Top-level mirrors for legacy substrate readers.
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
            recipe_shape: {
              enabled: true,
              promotion_state: "seeded",
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
            },
          }),
          JSON.stringify(recipe.trajectory.flatMap((s) => [s.action_artifact_id, s.verifier_artifact_id].filter(Boolean))),
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
