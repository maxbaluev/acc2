// acc2 brain prompt composer — substrate projection under a strict token budget
// (v2-design.md §13).
//
// Composes the prompt the brain sees as a projection over substrate state:
//   - P0 sections always present (TASK GOAL, RUNTIMES, WORKFLOW).
//   - P1: retrieved knowledge (top-K by score), code artifact registry.
//   - P2: upstream completed-task outputs, watched outputs.
//   - P3: stakeholder state, cross-directive interference.
//   - P4: active failures, constitutional gates.
//
// Sections are filled in priority order; lower-priority sections truncate or
// drop first when the budget runs out. Token counting is approximate
// (chars/4); Phase F replaces with a real tokenizer.
//
// The prompt is intentionally lean — the brain pulls more via substrate.search
// mid-cycle (§13.2). Depth-1 retrieval is the RLM constraint.

import type { Database } from "bun:sqlite";
import { snapshotWatchedOutputs } from "./watch_edges";
import { encodingForModel, type Tiktoken } from "js-tiktoken";
import type { EmbeddingIndex } from "./embedding_index";
import type { RetrievalHit, RetrievalResult } from "./retrieval";
import { renderStakeholderBlock } from "./stakeholder_compositor";
import { renderInterferenceBlock } from "./interference";
import { emitEvent } from "./events";
import type { JsonValue, OwnerProfile } from "../substrate/types";
import { OWNER_PROFILE_DEFAULTS } from "../substrate/types";

export type PromptComposeOptions = {
  taskId: string;
  budgetTokens?: number;
  /** Optional embedding-index handle. When provided AND `index.size() > 0`,
   *  RETRIEVED KNOWLEDGE and CODE ARTIFACT REGISTRY pull through the
   *  reranker via `retrievedKnowledge` / `retrievedArtifacts` below (which
   *  the caller pre-computes — the composer stays synchronous). */
  retrievedKnowledge?: RetrievalResult | null;
  retrievedArtifacts?: RetrievalResult | null;
  /** When the caller has an EmbeddingIndex but no pre-computed retrieval
   *  result, it can be omitted entirely. Organism-alignment audit
   *  b3qc9ryzj #2/#3 (2026-05-15): for the production path the dispatcher
   *  now signals an explicit `retrievalUnavailable` reason when retrieval
   *  failed (no API key, index empty, retrieve() exception). The composer
   *  then renders an explicit "(unavailable: <reason>)" section instead
   *  of falling back to the recency-stand-in — fail-loud beats silent
   *  stale knowledge. The recency stand-in remains only for callers that
   *  don't pass either field (tests + fresh-empty substrates). */
  retrievalUnavailable?: { reason: string } | null;
  index?: EmbeddingIndex | null;
};

export type PromptSection = {
  name: string;
  priorityP: number;
  tokens: number;
};

export type ComposedPrompt = {
  text: string;
  sections: PromptSection[];
  truncated: string[];
};

const DEFAULT_BUDGET_TOKENS = 8000;

// Phase F: real tokenizer via js-tiktoken's cl100k_base (the BPE that
// text-embedding-3-small uses). One encoder is initialised lazily on first
// call — encoders are stateless after construction, safe to share across
// composer invocations. We swallow construction errors and fall back to the
// chars/4 heuristic; tiktoken's data file fetches at module load if the
// runtime resolves it lazily, so we want this to degrade gracefully.
let _tiktokenEncoder: Tiktoken | null = null;
let _tiktokenInitTried = false;

const initTokenizer = (): Tiktoken | null => {
  if (_tiktokenEncoder) return _tiktokenEncoder;
  if (_tiktokenInitTried) return _tiktokenEncoder;
  _tiktokenInitTried = true;
  try {
    _tiktokenEncoder = encodingForModel("text-embedding-3-small");
  } catch {
    _tiktokenEncoder = null;
  }
  return _tiktokenEncoder;
};

/** Real token count via js-tiktoken's cl100k_base (matches the
 *  text-embedding-3-small family). Falls back to a chars/4 heuristic on the
 *  one path where tiktoken initialisation fails (no native data file in the
 *  bundle). Phase F resolution: kept under 200kB install size, no native
 *  deps required. */
export const estimateTokens = (text: string): number => {
  const enc = initTokenizer();
  if (enc) {
    try {
      return enc.encode(text).length;
    } catch {
      /* fall through to char heuristic */
    }
  }
  return Math.ceil(text.length / 4);
};

type TaskRow = {
  id: string;
  directive_id: string;
  goal: string;
  lifecycle: string;
  urgency: string;
};

const readTaskRow = (db: Database, taskId: string): TaskRow | null => {
  // Phase D: task rows live as `task_node_opened` events with payload.goal.
  // Once a tasks table exists (Phase E DAG topology), we'll query it directly.
  const row = db
    .query(
      "SELECT id, directive_id, payload FROM events WHERE task_id = ? AND kind = 'task_node_opened' ORDER BY ts ASC LIMIT 1",
    )
    .get(taskId) as Record<string, unknown> | null;
  if (!row) return null;
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse((row.payload as string) ?? "{}") as Record<string, unknown>;
  } catch { /* keep empty */ }
  return {
    id: taskId,
    directive_id: row.directive_id as string,
    goal: (payload.goal as string) ?? "(no goal recorded)",
    lifecycle: (payload.lifecycle as string) ?? "finite",
    urgency: (payload.urgency as string) ?? "normal",
  };
};

const readDirectiveGoal = (db: Database, directiveId: string): string | null => {
  const row = db
    .query(
      "SELECT payload FROM events WHERE directive_id = ? AND kind = 'directive_opened' ORDER BY ts ASC LIMIT 1",
    )
    .get(directiveId) as Record<string, unknown> | null;
  if (!row) return null;
  try {
    const payload = JSON.parse((row.payload as string) ?? "{}") as Record<string, unknown>;
    return (payload.directive_text as string) ?? (payload.goal as string) ?? null;
  } catch {
    return null;
  }
};

const readKnowledgeTopK = (db: Database, k: number): Array<{ id: string; text: string; score: number }> => {
  // Recency fallback for the RETRIEVED KNOWLEDGE section: pulls recent
  // promoted knowledge candidates when the caller did NOT pre-compute a
  // reranker hit list (i.e. the embedding index is empty or the caller chose
  // not to run retrieval). When `opts.retrievedKnowledge` is provided, the
  // canonical embedding × posterior reranker (`runtime/retrieval.ts`) supplies
  // the section instead — see `buildRetrievedKnowledgeSection` above.
  //
  // Brain knowledge audit bc5vdkrik finding #2 (2026-05-15): the promotion
  // payload typically carries only metadata (candidate_id, score). The
  // truth-bearing text lives on the candidate row under any of
  // {text, claim, summary, insight}. Join through to candidate via
  // payload.candidate_id (or context_refs[0]) and walk the fallback chain
  // so the prompt section renders useful text instead of '(no text)'.
  const rows = db
    .query(
      `SELECT
         p.id              AS id,
         p.payload         AS p_payload,
         p.context_refs    AS p_ctx,
         c.payload         AS c_payload
       FROM events p
       LEFT JOIN events c
         ON c.kind = 'knowledge_candidate'
        AND c.id = COALESCE(
              json_extract(p.payload, '$.candidate_id'),
              json_extract(p.context_refs, '$[0]')
            )
       WHERE p.kind = 'knowledge_promoted'
       ORDER BY p.ts DESC
       LIMIT ?`,
    )
    .all(k) as Array<Record<string, unknown>>;
  const out: Array<{ id: string; text: string; score: number }> = [];
  for (const r of rows) {
    try {
      const pPayload = JSON.parse((r.p_payload as string) ?? "{}") as Record<string, unknown>;
      const cPayload = JSON.parse((r.c_payload as string) ?? "{}") as Record<string, unknown>;
      // Rich candidate schema (brain knowledge audit bc5vdkrik #4):
      // when the candidate emitter includes structural fields, render
      // claim + compressed evidence + implications inline so the brain
      // sees the WHY, not just the headline. Falls through the
      // canonical text-extraction chain when rich fields are absent.
      const claim =
        (cPayload.claim as string | undefined) ??
        (cPayload.text as string | undefined) ??
        (cPayload.summary as string | undefined) ??
        (cPayload.insight as string | undefined) ??
        (pPayload.synthesized_text as string | undefined) ??
        (pPayload.text as string | undefined);
      const evidence = Array.isArray(cPayload.evidence) ? (cPayload.evidence as unknown[]).map(String) : [];
      const implications = Array.isArray(cPayload.implications) ? (cPayload.implications as unknown[]).map(String) : [];
      const text = claim
        ? [
            claim,
            evidence.length > 0 ? `  evidence: ${evidence.slice(0, 3).join("; ")}` : "",
            implications.length > 0 ? `  implications: ${implications.slice(0, 3).join("; ")}` : "",
          ].filter((s) => s !== "").join("\n")
        : "(no text)";
      out.push({
        id: r.id as string,
        text,
        score: (pPayload.score as number) ?? 0,
      });
    } catch { /* skip malformed */ }
  }
  return out;
};

// Organism-alignment audit b3qc9ryzj finding #5 (2026-05-15): pending
// lesson_extracted / contract_amendment_proposed rows lived in a view
// (lesson_implementer_queue_view) but never entered the brain prompt.
// Now they do — the brain SEES its own past proposals at decision time
// and can route them through new task DAGs / actions. Owner-gated
// proposals are excluded (those need orchestrator-side apply, not
// brain-side automation). Capped at k entries by ts ASC (oldest first).
const readPendingProposals = (
  db: Database,
  k: number,
  excludeDirectiveId?: string,
): Array<{ id: string; ts: string; kind: string; target: string | null; summary: string; directive_id: string }> => {
  // lesson_implementer_queue_view already filters out applied proposals
  // (its WHERE clause excludes rows with applied_change_committed). We
  // additionally skip owner-gated proposals — those need orchestrator-
  // side apply, not brain-side automation. Filter by directive when
  // excludeDirectiveId is set so the section doesn't echo the current
  // goal's own proposals.
  const rows = db
    .query(
      `SELECT source_event_id, ts, source_kind, directive_id, target, anchor,
              proposed_behavior, proposed_action, lesson_kind, owner_gate_required
       FROM lesson_implementer_queue_view
       WHERE COALESCE(owner_gate_required, 0) = 0
         AND (? IS NULL OR directive_id != ?)
       ORDER BY ts ASC
       LIMIT ?`,
    )
    .all(excludeDirectiveId ?? null, excludeDirectiveId ?? null, k) as Array<Record<string, unknown>>;
  return rows.map((r) => {
    const proposedBehavior = (r.proposed_behavior as string | null) ?? "";
    const proposedAction = (r.proposed_action as string | null) ?? "";
    // The proposed_behavior / proposed_action JSON carries a `summary` or
    // `description` field; fall back to the lesson_kind label otherwise.
    let summary = "";
    for (const raw of [proposedBehavior, proposedAction]) {
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        summary = (parsed.summary as string | undefined) ??
          (parsed.description as string | undefined) ??
          summary;
      } catch { /* skip malformed */ }
    }
    return {
      id: r.source_event_id as string,
      ts: r.ts as string,
      kind: (r.source_kind as string) ?? "unknown",
      target: (r.target as string | null) ?? null,
      directive_id: (r.directive_id as string) ?? "",
      summary: summary || (r.lesson_kind as string | null) || "(no summary)",
    };
  });
};

const buildPendingProposalsSection = (rows: ReturnType<typeof readPendingProposals>): string => {
  if (rows.length === 0) return "PENDING PROPOSALS: (none)";
  const lines = ["PENDING PROPOSALS:"];
  for (const r of rows) {
    const targetSuffix = r.target ? ` → ${r.target}` : "";
    lines.push(`  [${r.id.slice(0, 12)}] ${r.kind}${targetSuffix}: ${r.summary.slice(0, 240)}`);
  }
  return lines.join("\n");
};

// Cross-goal context (multi-directive parallelism): list OTHER active
// directives so the brain knows what concurrent work is in flight and
// can avoid duplication / cite peer work / propose interference edges.
const readOtherActiveGoals = (
  db: Database,
  currentDirectiveId: string,
  k: number,
): Array<{ id: string; opened_ts: string; text: string; lifecycle: string }> => {
  const rows = db
    .query(
      `SELECT directive_id, opened_ts, payload
       FROM active_objectives_view
       WHERE directive_id != ?
       ORDER BY opened_ts DESC
       LIMIT ?`,
    )
    .all(currentDirectiveId, k) as Array<Record<string, unknown>>;
  return rows.map((r) => {
    let text = "";
    let lifecycle = "finite";
    try {
      const p = JSON.parse((r.payload as string) ?? "{}") as Record<string, unknown>;
      text = (p.directive_text as string) ?? (p.text as string) ?? "";
      lifecycle = (p.lifecycle as string) ?? "finite";
    } catch { /* malformed */ }
    return {
      id: r.directive_id as string,
      opened_ts: r.opened_ts as string,
      text,
      lifecycle,
    };
  });
};

const buildOtherGoalsSection = (rows: ReturnType<typeof readOtherActiveGoals>): string => {
  if (rows.length === 0) return "OTHER ACTIVE GOALS: (none — this is the only goal in flight)";
  const lines = ["OTHER ACTIVE GOALS:"];
  for (const r of rows) {
    lines.push(`  [${r.id.slice(0, 12)}] ${r.lifecycle}: ${r.text.slice(0, 180)}`);
  }
  return lines.join("\n");
};

// Persistent owner-profile memory (Batch 2 / universal-for-any-human-work):
// Project the last k owner-channel rows (owner_input_received +
// owner_decision_recorded) so the brain sees what the owner actually said /
// decided in recent history. Tone, preferences, prior corrections, explicit
// constraints — the kind of context a careful human collaborator would
// remember between sessions. Stored on the ledger; surfaced through the
// canonical owner_conversation_view (substrate/views.ts:275-289).
const readOwnerContext = (
  db: Database,
  k: number,
): Array<{ id: string; ts: string; kind: string; directive_id: string | null; text: string; detected_language?: string | null }> => {
  const rows = db
    .query(
      `SELECT event_id, ts, directive_id, kind, payload
       FROM owner_conversation_view
       ORDER BY ts DESC
       LIMIT ?`,
    )
    .all(k) as Array<Record<string, unknown>>;
  // Sort ascending for chronological narrative (oldest → newest of the recent window).
  return rows.reverse().map((r) => {
    let text = "";
    try {
      const p = JSON.parse((r.payload as string) ?? "{}") as Record<string, unknown>;
      // Owner input payloads vary across surface: directive amendments carry
      // amendment_text, chat turns carry text / words / input. Walk a small
      // fallback chain so the prompt actually sees the owner's words.
      text =
        (p.text as string | undefined) ??
        (p.input as string | undefined) ??
        (p.words as string | undefined) ??
        (p.amendment_text as string | undefined) ??
        (p.decision as string | undefined) ??
        (p.note as string | undefined) ??
        "";
    } catch { /* malformed */ }
    return {
      id: r.event_id as string,
      ts: r.ts as string,
      kind: (r.kind as string) ?? "owner_input_received",
      directive_id: (r.directive_id as string | null) ?? null,
      text,
    };
  });
};

const buildOwnerContextSection = (rows: ReturnType<typeof readOwnerContext>): string => {
  if (rows.length === 0) return "OWNER CONTEXT: (no prior owner messages on file)";
  const lines = ["OWNER CONTEXT (recent owner-channel events, oldest → newest):"];
  for (const r of rows) {
    if (!r.text) continue;
    const kindLabel = r.kind === "owner_decision_recorded" ? "decision" : "input";
    lines.push(`  [${r.id.slice(0, 12)}] ${kindLabel}: ${r.text.slice(0, 220)}`);
  }
  return lines.length === 1 ? "OWNER CONTEXT: (no readable owner text on file)" : lines.join("\n");
};

// Owner profile — Layer-2 autonomy preferences (UX dispatch b71pfyddv,
// brain dispatch ZMJQQ963Z124V7VS amendment 2026-05-15). The substrate
// promotes owner_insight_candidate rows into owner_profile_recorded via
// Model D consensus (substrate/extractors.ts:maybePromoteOwnerProfile).
// The prompt composer surfaces the LATEST profile row so the brain has
// persistent owner preferences (language, autonomy_trust_level, hot_topics,
// hard blocks, working hours, manual-review patterns) on every dispatch —
// continuity that outlives the rolling 8-row OWNER CONTEXT window.
//
// Never omit this section even when defaults are in force — the brain
// learns to look for it, so an explicit "no owner profile recorded yet"
// is more useful than absence.
export const readOwnerProfile = (db: Database): OwnerProfile => {
  const row = db
    .query(
      `SELECT payload FROM events
       WHERE kind = 'owner_profile_recorded'
       ORDER BY ts DESC LIMIT 1`,
    )
    .get() as { payload: string } | null;
  if (!row) return { ...OWNER_PROFILE_DEFAULTS } as OwnerProfile;
  try {
    const parsed = JSON.parse(row.payload ?? "{}") as Record<string, unknown>;
    // Strip substrate-stamped audit fields — they live on the row for
    // provenance (which candidate inspired this promotion + via which
    // route) but aren't part of OWNER_PROFILE_JSON_SCHEMA.
    delete parsed.promoted_from;
    delete parsed.promotion_route;
    return { ...OWNER_PROFILE_DEFAULTS, ...parsed } as OwnerProfile;
  } catch {
    return { ...OWNER_PROFILE_DEFAULTS } as OwnerProfile;
  }
};

const formatTimeWindow = (tw: OwnerProfile["time_window"]): string => {
  if (!tw || typeof tw !== "object") return "";
  const parts: string[] = [];
  if (typeof tw.start_hour === "number" && typeof tw.end_hour === "number") {
    parts.push(`${tw.start_hour}:00-${tw.end_hour}:00`);
  }
  if (Array.isArray(tw.days) && tw.days.length > 0) parts.push(tw.days.join(","));
  if (typeof tw.timezone === "string" && tw.timezone) parts.push(tw.timezone);
  return parts.join(" ");
};

const formatAutonomyScope = (s: OwnerProfile["autonomy_scope"]): string => {
  if (!s || typeof s !== "object") return "";
  const parts: string[] = [];
  if (Array.isArray(s.include) && s.include.length > 0) {
    parts.push(`include=[${s.include.join(", ")}]`);
  }
  if (Array.isArray(s.exclude) && s.exclude.length > 0) {
    parts.push(`exclude=[${s.exclude.join(", ")}]`);
  }
  return parts.join(" ");
};

const arrayEquals = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean => {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

const isDefaultAutonomyScope = (s: OwnerProfile["autonomy_scope"]): boolean => {
  if (!s || typeof s !== "object") return true;
  const d = OWNER_PROFILE_DEFAULTS.autonomy_scope;
  return arrayEquals(s.include, d.include) && arrayEquals(s.exclude, d.exclude);
};

export const buildOwnerProfileSection = (profile: OwnerProfile): string => {
  // Render only non-default fields so the prompt stays lean when the
  // owner hasn't expressed any preference. When everything is default,
  // emit a stub so the brain learns to look for this section.
  const lines: string[] = [];
  const lang = profile.detected_language;
  if (lang && lang !== OWNER_PROFILE_DEFAULTS.detected_language) {
    lines.push(`detected_language: ${lang}`);
  }
  const trust = profile.autonomy_trust_level;
  if (trust && trust !== OWNER_PROFILE_DEFAULTS.autonomy_trust_level) {
    lines.push(`autonomy_trust_level: ${trust}`);
  }
  if (Array.isArray(profile.hot_topics) && profile.hot_topics.length > 0) {
    lines.push(`hot_topics: ${profile.hot_topics.join(", ")}`);
  }
  if (Array.isArray(profile.things_to_never_do) && profile.things_to_never_do.length > 0) {
    lines.push("things_to_never_do:");
    for (const t of profile.things_to_never_do) lines.push(`  - ${t}`);
  }
  if (Array.isArray(profile.manual_review_patterns) && profile.manual_review_patterns.length > 0) {
    lines.push("manual_review_patterns:");
    for (const p of profile.manual_review_patterns) lines.push(`  - ${p}`);
  }
  const tw = formatTimeWindow(profile.time_window);
  if (tw) lines.push(`time_window: ${tw}`);
  if (!isDefaultAutonomyScope(profile.autonomy_scope)) {
    const scope = formatAutonomyScope(profile.autonomy_scope);
    if (scope) lines.push(`autonomy_scope: ${scope}`);
  }

  if (lines.length === 0) {
    return "## OWNER PROFILE\n(no owner profile recorded yet)";
  }
  return ["## OWNER PROFILE", ...lines].join("\n");
};

const readArtifactRegistryTopK = (db: Database, k: number): Array<{ id: string; runtime: string; name: string; score: number }> => {
  const rows = db
    .query(
      "SELECT id, runtime, name, score, confidence FROM code_artifact WHERE status IN ('admitted','promoted') ORDER BY score DESC, confidence DESC LIMIT ?",
    )
    .all(k) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    runtime: r.runtime as string,
    name: ((r.name as string | null) ?? "(unnamed)"),
    score: r.score as number,
  }));
};

const readRecentFailures = (db: Database, k: number): Array<{ kind: string; ts: string }> => {
  const rows = db
    .query(
      "SELECT failure_kind, ts FROM events WHERE failure_kind IS NOT NULL ORDER BY ts DESC LIMIT ?",
    )
    .all(k) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ kind: r.failure_kind as string, ts: r.ts as string }));
};

const readConstitutionalGates = (db: Database): string[] => {
  const rows = db
    .query(
      "SELECT payload FROM events WHERE kind = 'constitutional_gate_decision' ORDER BY ts DESC LIMIT 10",
    )
    .all() as Array<Record<string, unknown>>;
  const gates: string[] = [];
  for (const r of rows) {
    try {
      const payload = JSON.parse((r.payload as string) ?? "{}") as Record<string, unknown>;
      const name = payload.gate as string | undefined;
      if (name) gates.push(name);
    } catch { /* skip */ }
  }
  return Array.from(new Set(gates));
};

// ── Section builders ──────────────────────────────────────────────

const buildTaskGoalSection = (task: TaskRow, directiveText: string | null): string => {
  const lines: string[] = [];
  lines.push("TASK GOAL: " + task.goal);
  lines.push("TASK ID: " + task.id);
  lines.push("DIRECTIVE ID: " + task.directive_id);
  if (directiveText) lines.push("DIRECTIVE TEXT: " + directiveText);
  lines.push("DIRECTIVE LIFECYCLE: " + task.lifecycle);
  lines.push("URGENCY: " + task.urgency);
  return lines.join("\n");
};

const RUNTIMES_AVAILABLE_TEXT = [
  "RUNTIMES AVAILABLE (you write code for these):",
  "  - bun           — TypeScript, substrate API, HTTP, arithmetic, text composition",
  "  - uv            — Python, numpy/pandas/PIL/sklearn, image processing, sensor parsing",
  "  - camofox-browser — TypeScript against the camofox API; real chromium driven against a profile",
].join("\n");

const WORKFLOW_TEXT = [
  "YOUR WORKFLOW (RLM cycle: prompt is constant metadata; substrate is external state; recurse via DAG edges, not chat history):",
  "  CONSTANT ACT-LOOP METADATA: every action is intent + runtime artifact + verifier artifact + predicted_residual; residual is the universal score.",
  "  1. Write/reuse a code artifact for any runtime + a verifier artifact for any runtime; action and verifier runtimes may differ (e.g. camofox action + bun verifier).",
  "     Verifier residuals may include breakdown={evidence_quality, goal_progress, reversibility_or_consent, continuity, stakeholder_alignment, uncertainty}, but residual ∈ [0,1] is the universal scalar — substrate uses the scalar; breakdowns inform retrieval.",
  "  2. Emit action_predicted with action_artifact_id + verifier_artifact_id + predicted_residual.",
  "  3. For complex sub-goals, emit task_node_opened + task_edge_recorded (refines/requires).",
  "     Use substrate.search/read as BOUNDED PEEKS into external state; if the next semantic slice",
  "     is too large or independent, emit a refinement edge so the scheduler composes a fresh prompt.",
  "  4. Propose knowledge_candidate events for new patterns (substrate promotes via outcome).",
  "     EMIT MID-CYCLE — don't wait for closure. See EMISSION GRAMMARS for the rich schema.",
  "  5. For new reusable scripts, emit code_artifact_candidate.",
  "  6. Commit task via task_committed when verifier residual is below threshold.",
  "  CLOSURE + LEARNING (required before committing a DIRECTIVE's root task):",
  "  7. Run a CLOSURE VERIFIER (a code artifact); emit task_closure_audited.",
  "     closure_residual ≥ 0.3 → refine, do NOT commit root.",
  "  8. Extract lessons: emit contract_amendment_proposed OR lesson_extracted for every friction.",
  "     Route prior PENDING PROPOSALS through new task_nodes instead of letting them accumulate.",
].join("\n");

// Detailed emission grammar — P1 so it drops first under tight-budget
// pressure but is present in the standard 8K budget. Brain prompt
// teaching for env_requires + rich knowledge schema + provenance fields
// landed 2026-05-15 (organism-alignment follow-up to b3qc9ryzj).
const EMISSION_GRAMMARS_TEXT = [
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
  "      resource_uri:     \"repo:runtime/foo.ts\", // alias accepted for cross-domain proposals",
  "      anchor:           \"<unique line/section anchor in current resource>\",",
  "      current_behavior: \"<exact current text at anchor — for audit + reversibility>\",",
  "      proposed_behavior: {",
  "        target_resource: \"repo:runtime/foo.ts\", // MUST equal payload.target_resource/resource_uri",
  "        resource_uri:    \"repo:runtime/foo.ts\", // same value; use one or both consistently",
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
  "    The structured proposed_behavior is what unlocks lesson_implementer_queue_view.",
  "    auto_apply_eligible=1 (and surfaces an auto_apply_signaled event); the gate",
  "    REFUSES unstructured prose for repo:cli/* + repo:runtime/* resources (owner-consent targets",
  "    like CLAUDE.md require explicit approval regardless).",
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
].join("\n");

const buildKnowledgeSection = (rows: Array<{ id: string; text: string; score: number }>): string => {
  if (rows.length === 0) return "RETRIEVED KNOWLEDGE: (none)";
  const lines: string[] = ["RETRIEVED KNOWLEDGE (top-K by embedding × posterior):"];
  for (const r of rows) {
    lines.push(`  [${r.id}] (score=${r.score.toFixed(2)}) ${r.text}`);
  }
  return lines.join("\n");
};

/** Render reranked retrieval hits into the RETRIEVED KNOWLEDGE section.
 *  Used when the caller passed `retrievedKnowledge` (i.e. the index lit
 *  up and reranker produced hits). Each row cites the source event id +
 *  posterior + cosine distance so the brain can audit retrieval. */
const buildRetrievedKnowledgeSection = (hits: RetrievalHit[]): string => {
  if (hits.length === 0) return "RETRIEVED KNOWLEDGE: (none)";
  const lines: string[] = ["RETRIEVED KNOWLEDGE (top-K by embedding × posterior):"];
  for (const h of hits) {
    const snippet = h.snippet.length > 0 ? h.snippet : "(no snippet)";
    lines.push(
      `  [${h.event_id}] (rerank=${h.rerank_score.toFixed(2)} d=${h.distance.toFixed(3)} p=${h.posterior.toFixed(2)} origin=${h.origin}) ${snippet}`,
    );
  }
  return lines.join("\n");
};

const buildArtifactSection = (rows: Array<{ id: string; runtime: string; name: string; score: number }>): string => {
  if (rows.length === 0) return "CODE ARTIFACT REGISTRY: (none)";
  const lines: string[] = ["CODE ARTIFACT REGISTRY (top-K by posterior, scoped to your runtimes):"];
  for (const r of rows) {
    lines.push(`  [${r.id}] runtime=${r.runtime} name=${r.name} score=${r.score.toFixed(2)}`);
  }
  return lines.join("\n");
};

/** Render reranked code-artifact retrieval hits. The brain reads this to
 *  pick reusable artifacts; the rerank surface ensures cosine-similar
 *  artifacts (by event embedding) bubble up over pure posterior-only
 *  ordering. */
const buildRetrievedArtifactSection = (hits: RetrievalHit[]): string => {
  if (hits.length === 0) return "CODE ARTIFACT REGISTRY: (none)";
  const lines: string[] = ["CODE ARTIFACT REGISTRY (top-K by embedding × posterior, scoped to your runtimes):"];
  for (const h of hits) {
    const snippet = h.snippet.length > 0 ? h.snippet : "(no snippet)";
    lines.push(
      `  [${h.event_id}] (rerank=${h.rerank_score.toFixed(2)} p=${h.posterior.toFixed(2)}) ${snippet}`,
    );
  }
  return lines.join("\n");
};

const buildFailuresSection = (rows: Array<{ kind: string; ts: string }>): string => {
  if (rows.length === 0) return "ACTIVE FAILURES: (none)";
  const lines: string[] = ["ACTIVE FAILURES (recent failure_recorded for similar goals):"];
  for (const r of rows) lines.push(`  - ${r.kind} @ ${r.ts}`);
  return lines.join("\n");
};

const buildGatesSection = (gates: string[]): string => {
  if (gates.length === 0) return "CONSTITUTIONAL GATES ACTIVE: (none)";
  return "CONSTITUTIONAL GATES ACTIVE:\n" + gates.map((g) => `  - ${g}`).join("\n");
};

const NOT_DO_TEXT = [
  "DO NOT:",
  "  - Look for a tool menu — there isn't one. Write code for a runtime.",
  "  - Author canonical knowledge directly — propose candidates; substrate promotes via outcome correlation.",
  "  - Iterate within this cycle — emit a refinement edge if more work remains.",
  "  - Rebuild the environment in-context or summarize it as a substitute for substrate state; use symbolic handles + ledger mutations instead.",
].join("\n");

const FIXTURE_D_MARKER = "FIXTURE: fixture_d_count_todos";

/** Compose the brain prompt as a substrate projection. Sections are emitted
 *  in priority order; lowest-priority sections drop first when the budget
 *  would be exceeded. Returns the rendered text plus a section manifest so
 *  callers (and tests) can audit what was kept vs dropped. */
export const composePrompt = (db: Database, opts: PromptComposeOptions): ComposedPrompt => {
  const budget = opts.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  const task = readTaskRow(db, opts.taskId);
  if (!task) {
    // Empty stub so tests have something to assert; the dispatcher gates
    // on the task existing before calling us.
    const text = `TASK NOT FOUND: ${opts.taskId}`;
    return {
      text,
      sections: [{ name: "task_not_found", priorityP: 0, tokens: estimateTokens(text) }],
      truncated: [],
    };
  }

  const directiveText = readDirectiveGoal(db, task.directive_id);

  // Build candidate sections in priority order. Each entry is {name, p, body}.
  type Candidate = { name: string; p: number; body: string };
  const candidates: Candidate[] = [];

  candidates.push({ name: "task_goal", p: 0, body: buildTaskGoalSection(task, directiveText) });
  candidates.push({ name: "runtimes_available", p: 0, body: RUNTIMES_AVAILABLE_TEXT });
  candidates.push({ name: "workflow", p: 0, body: WORKFLOW_TEXT });
  candidates.push({ name: "do_not", p: 0, body: NOT_DO_TEXT });
  // Detailed emission grammars — env_requires + rich knowledge schema +
  // artifact provenance. P1 so it drops first under tight-budget pressure
  // (depth-1 tests pin a tiny 800-token budget) but lands in normal flow.
  candidates.push({ name: "emission_grammars", p: 1, body: EMISSION_GRAMMARS_TEXT });

  // Phase D fixture marker — the mocked bridge keys off this so the
  // fixture_d_count_todos dispatch can be reproduced deterministically.
  if (directiveText && /count files .* TODO/i.test(directiveText)) {
    candidates.push({ name: "fixture_marker", p: 0, body: FIXTURE_D_MARKER });
  }

  // P1 sections: organism-alignment audit b3qc9ryzj #2/#3 (2026-05-15).
  // Three explicit paths:
  //   1. retrievalUnavailable set → render fail-loud section so the brain
  //      sees that depth-1 retrieval was attempted but unavailable. NO
  //      silent recency fallback (that masquerade hid SERPER-style holes).
  //   2. retrievedKnowledge present + has hits → render reranked section.
  //   3. neither flag set → recency stand-in (tests / fresh empty substrate).
  const knowledgeBody = opts.retrievalUnavailable
    ? `RETRIEVED KNOWLEDGE: (unavailable: ${opts.retrievalUnavailable.reason})`
    : opts.retrievedKnowledge && opts.retrievedKnowledge.hits.length > 0
      ? buildRetrievedKnowledgeSection(opts.retrievedKnowledge.hits)
      : buildKnowledgeSection(readKnowledgeTopK(db, 8));
  candidates.push({ name: "retrieved_knowledge", p: 1, body: knowledgeBody });

  const artifactBody = opts.retrievedArtifacts && opts.retrievedArtifacts.hits.length > 0
    ? buildRetrievedArtifactSection(opts.retrievedArtifacts.hits)
    : buildArtifactSection(readArtifactRegistryTopK(db, 6));
  candidates.push({ name: "code_artifact_registry", p: 1, body: artifactBody });

  // P2/P3 sections. Upstream-task outputs land via the watch_edges walk just
  // below (Phase E `watch_edges.ts`); stakeholder + cross-directive interference
  // are populated by their respective compositors at the bottom. The
  // `upstream_outputs` placeholder header below remains a stand-in until
  // the upstream-task projection lands (no producer wires non-watch outputs
  // into this slot yet).
  candidates.push({ name: "upstream_outputs", p: 2, body: "UPSTREAM OUTPUTS: (none)" });
  // Watch edges (v2-design.md §9.4) — projected through declared consistency
  // mode. Empty when no watch edges target this task.
  const watched = snapshotWatchedOutputs(db, opts.taskId);
  const watchedBody = watched.length === 0
    ? "WATCHED OUTPUTS: (none)"
    : (() => {
        const lines: string[] = [
          "WATCHED OUTPUTS (upstream observations under declared consistency mode):",
        ];
        for (const w of watched.slice(0, 12)) {
          const payloadJson = JSON.stringify(w.payload);
          const truncated = payloadJson.length > 240 ? `${payloadJson.slice(0, 240)}…` : payloadJson;
          lines.push(
            `  [${w.upstream_task_id}] mode=${w.consistency_mode} kind=${w.event_kind} @${w.observed_at}: ${truncated}`,
          );
        }
        if (watched.length > 12) lines.push(`  … (${watched.length - 12} more elided)`);
        return lines.join("\n");
      })();
  candidates.push({ name: "watched_outputs", p: 2, body: watchedBody });
  // Persistent owner-profile memory (Batch 2): show recent owner-channel
  // events so the brain has continuity across directives — tone,
  // preferences, prior corrections, explicit constraints the owner stated
  // out loud. P2 so it survives normal-budget composition; drops with the
  // upstream/watched pair when the budget tightens.
  const ownerProfileBody = buildOwnerProfileSection(readOwnerProfile(db));
  candidates.push({ name: "owner_profile", p: 2, body: ownerProfileBody });
  const ownerContextBody = buildOwnerContextSection(readOwnerContext(db, 8));
  candidates.push({ name: "owner_context", p: 2, body: ownerContextBody });
  const stakeholderBody = renderStakeholderBlock(db, task.directive_id);
  candidates.push({
    name: "stakeholder_state",
    p: 3,
    body: stakeholderBody.length > 0 ? stakeholderBody : "STAKEHOLDER STATE: (none)",
  });
  const interferenceBody = renderInterferenceBlock(db, task.directive_id);
  candidates.push({
    name: "cross_directive_interference",
    p: 3,
    body: interferenceBody.length > 0 ? interferenceBody : "CROSS-DIRECTIVE INTERFERENCE: (none)",
  });
  // Organism-alignment audit b3qc9ryzj finding #5 (2026-05-15):
  // surface PENDING PROPOSALS so the brain sees lesson_extracted /
  // contract_amendment_proposed rows it (or peers) previously emitted
  // and can route them through new task DAGs / actions. Owner-gated
  // proposals are filtered out — those need orchestrator-side apply.
  const proposalsBody = buildPendingProposalsSection(
    readPendingProposals(db, 6, task.directive_id),
  );
  candidates.push({ name: "pending_proposals", p: 3, body: proposalsBody });
  // Multi-goal cross-pollination: surface OTHER active directives so the
  // brain knows what concurrent work is in flight and can defer / cite
  // / coordinate. Pre-fix the brain saw only its own directive in the
  // prompt — couldn't tell if a peer goal was already covering this work.
  const otherGoalsBody = buildOtherGoalsSection(
    readOtherActiveGoals(db, task.directive_id, 5),
  );
  candidates.push({ name: "other_active_goals", p: 3, body: otherGoalsBody });

  candidates.push({ name: "active_failures", p: 4, body: buildFailuresSection(readRecentFailures(db, 3)) });
  candidates.push({ name: "constitutional_gates", p: 4, body: buildGatesSection(readConstitutionalGates(db)) });

  // Fill in priority order. Track running tokens; drop bottom-up when over.
  const kept: Candidate[] = [];
  const truncated: string[] = [];
  let totalTokens = 0;

  // Sort by p ascending so P0 fills first.
  const sorted = [...candidates].sort((a, b) => a.p - b.p);
  for (const c of sorted) {
    const sectionTokens = estimateTokens(c.body) + 2; // +2 for separator overhead
    if (totalTokens + sectionTokens > budget) {
      truncated.push(c.name);
      continue;
    }
    kept.push(c);
    totalTokens += sectionTokens;
  }

  // Restore canonical order in output (P0 → P4). The sort already did this.
  const text = kept.map((c) => c.body).join("\n\n");

  // Depth-1 retrieval budget enforcement (v2-design.md §13, prompt budget).
  // When any section was dropped to fit under the budget, emit a single
  // `prompt_truncated` event so the audit trail records the structural
  // budget bite — the brain sees a leaner prompt, the substrate can see
  // WHY in one row. Idempotent: at most one event per composePrompt call.
  if (truncated.length > 0) {
    emitEvent(db, {
      kind: "prompt_truncated",
      substrate_origin: "substrate_auto",
      directive_id: task.directive_id,
      task_id: task.id,
      payload: {
        budget_tokens: budget,
        total_tokens: totalTokens,
        kept_sections: kept.map((c) => c.name),
        truncated_sections: truncated,
      } as JsonValue,
    });
  }

  return {
    text,
    sections: kept.map((c) => ({ name: c.name, priorityP: c.p, tokens: estimateTokens(c.body) })),
    truncated,
  };
};
