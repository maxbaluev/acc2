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
import { goalShape } from "./goal_shape";
import type { JsonValue, OwnerProfile } from "../substrate/types";
import { OWNER_PROFILE_DEFAULTS } from "../substrate/types";

type PromptComposeOptions = {
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

type PromptSection = {
  name: string;
  priorityP: number;
  tokens: number;
};

type ComposedPrompt = {
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

type OwnerContextRow = { id: string; ts: string; kind: string; directive_id: string | null; text: string; detected_language?: string | null };

type OwnerPolicyProjectionInput = {
  recentOwnerContext?: OwnerContextRow[];
  directive?: { text?: string | null; goal?: string; lifecycle?: string; urgency?: string };
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

// ── Existing-decomposition surface (REUSE-FIRST against re-decomposition) ──
// Audit 2026-05-17: the hot-reload directive accumulated 62 task_node_opened
// events because the brain re-dispatched the root and blindly re-decomposed
// the same Q1-Q6 questions on each cycle. The fix is structural: surface
// every task_node_opened that already exists for the same directive so the
// brain SEES what its prior cycles already produced and refuses to open
// duplicates. This is the canonical reuse-first principle applied to
// decomposition itself: existing children with committed answers ARE the
// answer; the brain should compose the root-closure from them, not re-spawn.
type ExistingChild = {
  task_id: string;
  ts: string;
  goal_head: string;
  status: "committed" | "failed" | "open";
};
const readExistingDecomposition = (
  db: Database,
  directiveId: string,
  excludeTaskId: string,
  cap = 30,
): ExistingChild[] => {
  if (!directiveId) return [];
  const rows = db
    .query<
      { task_id: string; ts: string; payload: string },
      [string, string]
    >(
      `SELECT task_id, ts, payload FROM events
       WHERE kind = 'task_node_opened'
         AND directive_id = ?
         AND task_id != ?
       ORDER BY ts ASC`,
    )
    .all(directiveId, excludeTaskId);
  if (rows.length === 0) return [];
  const committedSet = new Set(
    db
      .query<{ task_id: string }, [string]>(
        `SELECT task_id FROM events WHERE kind = 'task_committed' AND directive_id = ?`,
      )
      .all(directiveId)
      .map((r) => r.task_id),
  );
  const failedSet = new Set(
    db
      .query<{ task_id: string }, [string]>(
        `SELECT task_id FROM events WHERE kind = 'task_failed' AND directive_id = ?`,
      )
      .all(directiveId)
      .map((r) => r.task_id),
  );
  const out: ExistingChild[] = [];
  for (const r of rows) {
    let goal = "";
    try {
      const p = JSON.parse(r.payload ?? "{}") as Record<string, unknown>;
      goal = String(p.goal ?? "");
    } catch { /* skip malformed */ }
    const status: ExistingChild["status"] = committedSet.has(r.task_id)
      ? "committed"
      : failedSet.has(r.task_id)
        ? "failed"
        : "open";
    out.push({ task_id: r.task_id, ts: r.ts, goal_head: goal.slice(0, 80), status });
    if (out.length >= cap) break;
  }
  return out;
};

const buildExistingDecompositionSection = (rows: ExistingChild[]): string => {
  if (rows.length === 0) return "";
  // Dedup by goal-head prefix to collapse repeated decomposition cycles into
  // a single representative line per question. The brain should see "Q1
  // already has 4 siblings (2 committed)" not "Q1 1, Q1 2, Q1 3, Q1 4".
  const groups = new Map<string, ExistingChild[]>();
  for (const r of rows) {
    // Group by first ~16 chars of goal (catches "Q1 DETECTION", "Q2 RELOAD",
    // etc) — short enough that "Q1 DETECTION" and "Q1 — DETECTION" cluster,
    // long enough that "Q1" and "Q2" don't.
    const key = r.goal_head.slice(0, 16).replace(/\s+/g, " ").trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  const lines: string[] = [
    "EXISTING DECOMPOSITION FOR THIS DIRECTIVE (do NOT open siblings with overlapping goals — that is re-decomposition, the structural anti-pattern named in audit lesson Q2):",
  ];
  for (const [, items] of [...groups.entries()].sort()) {
    const repr = items[0]!;
    const committed = items.filter((i) => i.status === "committed").length;
    const failed = items.filter((i) => i.status === "failed").length;
    const open = items.filter((i) => i.status === "open").length;
    const status = `committed=${committed} failed=${failed} open=${open}`;
    lines.push(`  - "${repr.goal_head}" → ${items.length} sibling(s) [${status}]`);
  }
  lines.push(
    "If a question on your decomposition list already has ≥ 1 committed sibling above, COMPOSE THE ANSWER FROM THE COMMITTED CHILD (substrate.read/get_event); do NOT emit another task_node_opened for it. Closure verifier will count duplicates as a decomposition-explosion failure.",
  );
  return lines.join("\n");
};

const goalShapeTags = (goalText?: string | null): string[] => {
  const tokens = String(goalText ?? "")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .split(/\s+/u)
    .filter((t) => t.length >= 3);
  return Array.from(new Set(tokens)).slice(0, 24);
};

const readKnowledgeTopK = (
  db: Database,
  k: number,
  goalText?: string | null,
  shapeMatchOnly = false,
): Array<{ id: string; text: string; score: number }> => {
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
  const shape = goalText ? goalShape(goalText) : null;
  const shapeTagsJson = JSON.stringify(goalShapeTags(goalText));
  const rows = db
    .query(
      `SELECT
         p.id              AS id,
         p.payload         AS p_payload,
         p.context_refs    AS p_ctx,
         c.payload         AS c_payload,
         CASE
           WHEN ? IS NOT NULL AND (
             json_extract(p.payload, '$.goal_shape') = ?
             OR EXISTS (
               SELECT 1 FROM json_each(p.payload, '$.goal_shapes')
               WHERE value = ?
             )
             OR EXISTS (
               SELECT 1 FROM json_each(p.payload, '$.goal_shape_tags')
               WHERE lower(value) IN (SELECT value FROM json_each(?))
             )
           ) THEN 1
           ELSE 0
         END AS shape_match
       FROM events p
       LEFT JOIN events c
         ON c.kind = 'knowledge_candidate'
        AND c.id = COALESCE(
              json_extract(p.payload, '$.candidate_id'),
              json_extract(p.context_refs, '$[0]')
            )
       WHERE p.kind = 'knowledge_promoted'
         AND (
           ? = 0
           OR (
             ? IS NOT NULL AND (
               json_extract(p.payload, '$.goal_shape') = ?
               OR EXISTS (
                 SELECT 1 FROM json_each(p.payload, '$.goal_shapes')
                 WHERE value = ?
               )
               OR EXISTS (
                 SELECT 1 FROM json_each(p.payload, '$.goal_shape_tags')
                 WHERE lower(value) IN (SELECT value FROM json_each(?))
               )
             )
           )
         )
       ORDER BY shape_match DESC, p.ts DESC, p.rowid DESC
       LIMIT ?`,
    )
    .all(shape, shape, shape, shapeTagsJson, shapeMatchOnly ? 1 : 0, shape, shape, shape, shapeTagsJson, k) as Array<Record<string, unknown>>;
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
        (pPayload.claim as string | undefined) ??
        (pPayload.synthesized_text as string | undefined) ??
        (pPayload.text as string | undefined) ??
        (pPayload.summary as string | undefined) ??
        (pPayload.insight as string | undefined);
      const evidenceSource = Array.isArray(cPayload.evidence) ? cPayload.evidence : pPayload.evidence;
      const implicationsSource = Array.isArray(cPayload.implications) ? cPayload.implications : pPayload.implications;
      const evidence = Array.isArray(evidenceSource) ? (evidenceSource as unknown[]).map(String) : [];
      const implications = Array.isArray(implicationsSource) ? (implicationsSource as unknown[]).map(String) : [];
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

const REQUIRED_POLICY_SECTION_NAMES = ["workflow", "do_not"] as const;
type PolicyBundleSectionName = typeof REQUIRED_POLICY_SECTION_NAMES[number];
type PolicyBundleSection = { sectionName: PolicyBundleSectionName; priority: number; body: string };

const isPolicyBundleSectionName = (value: string): value is PolicyBundleSectionName => {
  return (REQUIRED_POLICY_SECTION_NAMES as readonly string[]).includes(value);
};

const readPolicyBundleSections = (
  db: Database,
  surface: string,
  sectionNames: readonly PolicyBundleSectionName[],
): PolicyBundleSection[] => {
  const wanted = new Set(sectionNames);
  const rows = db
    .query(
      `SELECT payload
         FROM events
        WHERE kind = 'knowledge_promoted'
          AND COALESCE(json_extract(payload, '$.policy_bundle.surface'), json_extract(payload, '$.surface')) = ?
          AND COALESCE(json_extract(payload, '$.type'), json_extract(payload, '$.policy_bundle.type')) = 'policy_bundle'
        ORDER BY ts DESC, rowid DESC
        LIMIT 100`,
    )
    .all(surface) as Array<{ payload: string }>;

  const latestBySection = new Map<string, PolicyBundleSection>();
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload ?? "{}") as Record<string, unknown>;
      const bundle = (payload.policy_bundle && typeof payload.policy_bundle === "object")
        ? payload.policy_bundle as Record<string, unknown>
        : payload;
      const sectionName = (bundle.section_name as string | undefined) ?? (bundle.sectionName as string | undefined);
      const body = bundle.body as string | undefined;
      if (!sectionName || !isPolicyBundleSectionName(sectionName) || !wanted.has(sectionName) || typeof body !== "string" || body.length === 0) continue;
      if (latestBySection.has(sectionName)) continue;
      latestBySection.set(sectionName, {
        sectionName,
        priority: Number(bundle.priority ?? 0),
        body,
      });
    } catch { /* skip malformed policy rows */ }
  }

  return Array.from(latestBySection.values()).sort((a, b) => {
    const byPriority = a.priority - b.priority;
    if (byPriority !== 0) return byPriority;
    return sectionNames.indexOf(a.sectionName) - sectionNames.indexOf(b.sectionName);
  });
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
): OwnerContextRow[] => {
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
// persistent owner preferences (language, autonomy_score, hot_topics,
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

const bootstrapPolicyForObservationCount = (count: unknown): string => {
  const n = typeof count === "number" && Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (n >= 50) return "bootstrap_policy: sparse profile (mature); keep using plain language defaults only for unknown axes, trust repeated observed preferences, ask one adapted question only when blocked";
  if (n >= 10) return "bootstrap_policy: sparse profile (growing); adapt to observed rendering_signals, keep explanations short, ask one question at a time unless batch preference is known";
  return "bootstrap_policy: sparse profile (new); use plain language + one question at a time + explain concepts on first encounter; respond in the owner's detected language when available and do not assume English";
};

const clamp01 = (n: number): number => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
const ownerPolicyNumber = (n: number): string => clamp01(n).toFixed(2);

const numericSignalEntries = (raw: unknown): Array<[string, number]> => {
  if (!raw || typeof raw !== "object") return [];
  return Object.entries(raw as Record<string, unknown>)
    .filter(([, v]) => typeof v === "number" && Number.isFinite(v))
    .map(([k, v]) => [k, clamp01(v as number)]);
};

const meanSignal = (raw: unknown): number => {
  const entries = numericSignalEntries(raw).filter(([, v]) => v > 0);
  if (entries.length === 0) return 0;
  return entries.reduce((sum, [, v]) => sum + v, 0) / entries.length;
};

const topSignalKeys = (raw: unknown, limit = 3): string[] => numericSignalEntries(raw)
  .filter(([, v]) => v > 0)
  .sort((a, b) => b[1] - a[1])
  .slice(0, limit)
  .map(([k]) => k);

const conceptComprehension = (profile: OwnerProfile): number => {
  const understood = profile.understood_concepts && typeof profile.understood_concepts === "object" ? Object.values(profile.understood_concepts) : [];
  if (understood.length === 0) return 0;
  const confidence = understood.reduce((sum, c) => {
    const explicit = typeof c?.confidence === "number" ? c.confidence : undefined;
    const inferred = typeof c?.evidence_count === "number" ? Math.min(1, c.evidence_count / 3) : 0;
    return sum + clamp01(explicit ?? inferred);
  }, 0) / understood.length;
  return clamp01(confidence * Math.min(1, understood.length / 6));
};

const buildSituationalOwnerPolicyLines = (profile: OwnerProfile, input: OwnerPolicyProjectionInput = {}): string[] => {
  const directiveText = String(input.directive?.text ?? "") + "\n" + String(input.directive?.goal ?? "");
  const recent = input.recentOwnerContext ?? [];
  const recentText = recent.map((r) => r.text).join("\n");
  const signals = profile.rendering_signals && typeof profile.rendering_signals === "object" ? profile.rendering_signals : {};
  const recentDecisions = recent.filter((r) => r.kind === "owner_decision_recorded").length;
  const recentConsent = /\b(consent granted|approved|authorized|apply|implement)\b/i.test(recentText);
  const recentControlLanguage = /\b(ask|before applying|confirm|manual|review|do not|don't|stop|wait)\b/i.test(recentText) ? 1 : 0;
  const recentUncertaintyLanguage = /\b(unclear|confusing|confused|not sure|ambiguous|what does|explain)\b/i.test(recentText) ? 1 : 0;
  const directiveRisk = clamp01((/\b(runtime|cli|docs|contract|irreversible|delete|external|stakeholder|protected|consent)\b/i.test(directiveText) ? 0.45 : 0.15) + (/\b(multi-file|parallel|amendments|refactor|audit|migration)\b/i.test(directiveText) ? 0.30 : 0));
  const taskAmbiguity = clamp01((/\b(audit|understand|improve|design|complex|universal|situational|policy)\b/i.test(directiveText) ? 0.45 : 0.15) + (directiveText.split(/\s+/).filter(Boolean).length > 80 ? 0.30 : 0) + (recentUncertaintyLanguage * 0.20));
  const autonomy = typeof profile.autonomy_score === "number" ? clamp01(profile.autonomy_score) : OWNER_PROFILE_DEFAULTS.autonomy_score;
  const profileAutonomySignal = meanSignal(profile.autonomy_signals);
  const profileControlSignal = meanSignal(profile.control_signals);
  const profileRiskSignal = meanSignal(profile.risk_signals);
  const renderingComprehension = clamp01(((signals.code_density ?? 0) * 0.35) + ((signals.ops_vocabulary ?? 0) * 0.30));
  const observedComprehension = clamp01(renderingComprehension + (conceptComprehension(profile) * 0.30) - (recentUncertaintyLanguage * 0.25));
  const comprehensionGap = clamp01(1 - observedComprehension);
  const urgencyPressure = input.directive?.urgency === "crisis" ? 1 : input.directive?.urgency === "elevated" ? 0.65 : 0.25;
  const ownerControlNeed = clamp01(((1 - autonomy) * 0.42) + (profileControlSignal * 0.22) + (profileRiskSignal * 0.18) + (directiveRisk * 0.25) + (recentControlLanguage * 0.18) + (comprehensionGap * 0.12) - (recentConsent ? 0.10 : 0));
  const axes: Record<string, number> = {
    directive_risk: directiveRisk,
    task_ambiguity: taskAmbiguity,
    owner_control_need: ownerControlNeed,
    autonomy_capacity: clamp01((autonomy * 0.70) + (profileAutonomySignal * 0.30)),
    observed_comprehension: observedComprehension,
    comprehension_gap: comprehensionGap,
    urgency_pressure: urgencyPressure,
    recent_owner_decision_density: Math.min(1, recentDecisions / 4),
    profile_control_signal: profileControlSignal,
    profile_risk_signal: profileRiskSignal,
  };
  const axisText = Object.entries(axes).map(([k, v]) => k + "=" + ownerPolicyNumber(v)).join(", ");
  const terms = Array.isArray(profile.preferred_terms) && profile.preferred_terms.length > 0 ? profile.preferred_terms.slice(0, 12).join(", ") : "(none recorded)";
  const signalSources = [
    ...topSignalKeys(profile.control_signals).map((k) => "control." + k),
    ...topSignalKeys(profile.risk_signals).map((k) => "risk." + k),
    ...topSignalKeys(profile.autonomy_signals).map((k) => "autonomy." + k),
  ];
  const actionPolicy = ownerControlNeed >= 0.60 || directiveRisk >= 0.65
    ? "surface evidence, anchors, residuals, and owner-visible decision points before risky apply; keep repo-internal claims English"
    : "proceed compactly when verifier evidence is strong; still cite events and surface uncertainty instead of hiding it";
  const comprehensionPolicy = comprehensionGap >= 0.55
    ? "explain the next concrete step and ask one narrow question if blocked"
    : "use substrate/runtime vocabulary directly; avoid re-explaining understood concepts unless confusion appears";
  return [
    "owner_policy (situational projection; open-ended Records, no persona enums):",
    "  axes: " + axisText,
    "  control_surface: autonomy_score=" + ownerPolicyNumber(autonomy) + " recent_consent=" + (recentConsent ? 1 : 0) + " recent_decisions=" + recentDecisions + " recent_control_language=" + recentControlLanguage,
    "  action_policy: " + actionPolicy,
    "  comprehension_policy: " + comprehensionPolicy,
    "  source_mix: profile_maps=" + (signalSources.length > 0 ? signalSources.join(",") : "none") + " recent_owner_events=" + recent.length + " directive_urgency=" + (input.directive?.urgency ?? "normal") + " directive_lifecycle=" + (input.directive?.lifecycle ?? "finite"),
    "  render_policy: mirror preferred_terms; keep code identifiers literal; use compact evidence/event language when code_density or ops_vocabulary is high",
    "  preferred_terms_sample: " + terms,
  ];
};
export const buildOwnerProfileSection = (profile: OwnerProfile, input: OwnerPolicyProjectionInput = {}): string => {
  // Render only non-default fields so the prompt stays lean when the
  // owner hasn't expressed any preference. When everything is default,
  // emit a stub so the brain learns to look for this section.
  const lines: string[] = [];
  const ownerPolicyLines = buildSituationalOwnerPolicyLines(profile, input);
  lines.push(...ownerPolicyLines);
  const lang = profile.detected_language;
  if (lang && lang !== OWNER_PROFILE_DEFAULTS.detected_language) {
    lines.push(`detected_language: ${lang}`);
    lines.push("owner_language_policy: respond to owner-visible summaries in detected_language when confidence >= 0.7; do not assume English; keep substrate-internal claims/artifact summaries in English");
  }
  // Conversation-as-learning-surface fields (universal): open-ended
  // signal maps are discovered dimensions, not fixed persona enums.
  const signalFields = [
    "rendering_signals",
    "autonomy_signals",
    "control_signals",
    "risk_signals",
    "collaboration_signals",
    "goal_continuity_signals",
  ] as const;
  for (const field of signalFields) {
    const raw = profile[field];
    if (!raw || typeof raw !== "object") continue;
    const sigs = Object.entries(raw)
      .filter(([, v]) => typeof v === "number" && (v as number) > 0);
    if (sigs.length === 0) continue;
    sigs.sort((a, b) => (b[1] as number) - (a[1] as number));
    const lineParts = sigs.map(([k, v]) => `${k}=${(v as number).toFixed(2)}`);
    lines.push(`${field} (continuous, open-ended Record<string,number>): ${lineParts.join(", ")}`);
  }
  if (Array.isArray(profile.preferred_terms) && profile.preferred_terms.length > 0) {
    lines.push(`preferred_terms (mirror these back; do NOT use jargon equivalents): ${profile.preferred_terms.join(", ")}`);
  }
  if (Array.isArray(profile.avoided_terms) && profile.avoided_terms.length > 0) {
    lines.push("avoided_terms (NEVER use in chat output to this owner):");
    for (const t of profile.avoided_terms) lines.push(`  - ${t}`);
  }
  if (profile.exposed_concepts && typeof profile.exposed_concepts === "object") {
    const concepts = Object.keys(profile.exposed_concepts).filter((k) => k.length > 0);
    if (concepts.length > 0) {
      lines.push("exposed_concepts (already explained — do NOT re-explain; use owner's vocabulary):");
      for (const c of concepts) {
        const e = profile.exposed_concepts[c];
        lines.push(`  - ${c} (seen ${e?.exposure_count ?? 0}x)`);
      }
    }
  }
  if (profile.understood_concepts && typeof profile.understood_concepts === "object") {
    const concepts = Object.keys(profile.understood_concepts).filter((k) => k.length > 0);
    if (concepts.length > 0) {
      lines.push("understood_concepts (owner showed comprehension — use directly unless confusion appears):");
      for (const c of concepts) {
        const e = profile.understood_concepts[c];
        const conf = typeof e?.confidence === "number" ? ` confidence=${e.confidence.toFixed(2)}` : "";
        lines.push(`  - ${c} (evidence ${e?.evidence_count ?? 0}x${conf})`);
      }
    }
  }
  if (profile.declined_concepts && typeof profile.declined_concepts === "object") {
    const concepts = Object.keys(profile.declined_concepts).filter((k) => k.length > 0);
    if (concepts.length > 0) {
      lines.push("declined_concepts (owner declined learning this — avoid teaching; use preferred term if present):");
      for (const c of concepts) {
        const e = profile.declined_concepts[c];
        lines.push(`  - ${c} (declined ${e?.decline_count ?? 0}x${e?.preferred_term ? `; preferred_term=${e.preferred_term}` : ""})`);
      }
    }
  }
  if (typeof profile.observation_count === "number" && profile.observation_count > 0) {
    lines.push(`observation_count: ${profile.observation_count} (calibrate bootstrap strength; 0-turn owner differs from 50-turn owner)`);
    lines.push(bootstrapPolicyForObservationCount(profile.observation_count));
  }
  const score = profile.autonomy_score;
  if (typeof score === "number" && score !== OWNER_PROFILE_DEFAULTS.autonomy_score) {
    lines.push(`autonomy_score: ${score.toFixed(2)} (continuous 0..1; below ~0.4 → block multi-file diffs)`);
  }
  if (typeof profile.autonomy_score_floor === "number") {
    lines.push(`autonomy_score_floor: ${profile.autonomy_score_floor.toFixed(2)}`);
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

  if (lines.length === ownerPolicyLines.length) {
    return [
      "## OWNER PROFILE",
      ...ownerPolicyLines,
      bootstrapPolicyForObservationCount(profile.observation_count),
      `detected_language: ${OWNER_PROFILE_DEFAULTS.detected_language} (default; update via owner_insight_candidate when evidence appears)`,
      `autonomy_score: ${OWNER_PROFILE_DEFAULTS.autonomy_score.toFixed(2)} (default; below ~0.4 blocks multi-file diffs)`,
      "signal maps: sparse (rendering/autonomy/control/risk/collaboration/goal_continuity are open-ended; do not infer absent axes without evidence)",
    ].join("\n");
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
const formatScoreRecord = (prefix: string, scores: Record<string, number> | undefined): string => {
  if (!scores) return "";
  const entries = Object.entries(scores).filter(([, v]) => Number.isFinite(v));
  if (entries.length === 0) return "";
  return " " + entries.map(([k, v]) => `${prefix}:${k}=${v.toFixed(2)}`).join(" ");
};

const buildRetrievedKnowledgeSection = (
  hits: RetrievalHit[],
  goalShapeRows: Array<{ id: string; text: string; score: number }> = [],
): string => {
  if (hits.length === 0 && goalShapeRows.length === 0) return "RETRIEVED KNOWLEDGE: (none)";
  const lines: string[] = ["RETRIEVED KNOWLEDGE (top-K by embedding × posterior plus goal-shape promoted rows):"];
  const seen = new Set<string>();
  for (const h of hits) {
    seen.add(h.event_id);
    const snippet = h.snippet.length > 0 ? h.snippet : "(no snippet)";
    const aspectAxes = formatScoreRecord("aspect", h.aspect_scores);
    const domainAxes = formatScoreRecord("domain", h.domain_scores);
    lines.push(
      `  [${h.event_id}] (rerank=${h.rerank_score.toFixed(2)} d=${h.distance.toFixed(3)} p=${h.posterior.toFixed(2)} origin=${h.origin}${aspectAxes}${domainAxes}) ${snippet}`,
    );
  }
  for (const r of goalShapeRows) {
    if (seen.has(r.id)) continue;
    lines.push(`  [${r.id}] (goal_shape score=${r.score.toFixed(2)}) ${r.text}`);
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


// ── EXIT INVARIANT (load-bearing, structural) ─────────────────────
// Audit 2026-05-16 (bridge classifier split, commit 59b2872): 87% of
// bridge_failed events were `brain_silent_exit` — opencode ran cleanly
// to exit_code:0 in the handshake window but invoked ZERO substrate.*
// tool calls. That is a prompt-compliance failure, not a transport
// issue, and the root cause is that nothing in the prompt structurally
// forbade text-only exits. This section is the structural counter:
// every brain cycle MUST emit at least one substrate.* tool call. Placed
// at p=0 so the budget never drops it; placed FIRST in the candidate
// order so the brain reads it before the workflow.
const EXIT_INVARIANT_TEXT = [
  "EXIT INVARIANT (read this first — load-bearing):",
  "  Every brain cycle MUST invoke at least one substrate.* tool call before exit.",
  "  Producing only conversational text and exiting (exit_code:0 with zero substrate frames) is scored",
  "  `brain_silent_exit` — a prompt-compliance failure, not a transport issue. The bridge will surface it",
  "  as bridge_failed{reason=brain_silent_exit, classifier_class=prompt_compliance, frames_received_count=0}.",
  "  Acceptable shapes that satisfy the invariant:",
  "    A. EMIT a real ledger event: substrate.emit({kind:'task_committed'|'task_node_opened'|'task_edge_recorded'|'action_predicted'|'knowledge_candidate'|'code_artifact_candidate'|'contract_amendment_proposed'|'lesson_extracted'|...}).",
  "    B. PEEK substrate state: substrate.read or substrate.search (counts as a tool call, but on its own does not advance the task — pair with an emit when work is real).",
  "    C. REFINE: emit task_node_opened + task_edge_recorded with reason for why this cycle could not finish in-context.",
  "    D. EXPLICIT NO-OP: if you truly believe no substrate change is warranted, EMIT a knowledge_candidate.payload.claim explaining WHY this directive needs no further substrate mutation, cite the directive's task_id in evidence_event_ids, and THEN exit.",
  "  Conversational silence is NOT one of the acceptable shapes. There is no 'I have nothing to add' exit path that bypasses the substrate.",
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

  // EXIT INVARIANT first — load-bearing structural rule against brain_silent_exit
  // (commit 59b2872 + this fix). p=0 so it never drops; first in order so the
  // brain reads "you MUST call substrate.* before exit" before anything else.
  candidates.push({ name: "exit_invariant", p: 0, body: EXIT_INVARIANT_TEXT });
  candidates.push({ name: "task_goal", p: 0, body: buildTaskGoalSection(task, directiveText) });
  // Existing decomposition awareness — load-bearing reuse-first signal
  // against the re-decomposition explosion (audit 2026-05-17: hot-reload
  // directive accumulated 62 task_node_opened events because the brain
  // re-decomposed Q1-Q6 nine times). p=0 so it never drops; placed right
  // after task_goal so the brain reads it before workflow/emission grammar.
  const existingDecomp = readExistingDecomposition(db, task.directive_id, task.id);
  const existingDecompBody = buildExistingDecompositionSection(existingDecomp);
  if (existingDecompBody.length > 0) {
    candidates.push({ name: "existing_decomposition", p: 0, body: existingDecompBody });
  }
  candidates.push({ name: "runtimes_available", p: 0, body: RUNTIMES_AVAILABLE_TEXT });
  const policySections = readPolicyBundleSections(db, "brain_prompt", REQUIRED_POLICY_SECTION_NAMES);
  for (const policy of policySections) {
    candidates.push({ name: policy.sectionName, p: policy.priority, body: policy.body });
  }
  for (const required of REQUIRED_POLICY_SECTION_NAMES) {
    if (policySections.some((policy) => policy.sectionName === required)) continue;
    candidates.push({
      name: required,
      p: 0,
      body: "BRAIN PROMPT POLICY MISSING: knowledge_promoted policy_bundle surface=brain_prompt section_name=" + required + ". Seed foundational knowledge before dispatch; do not substitute local literal prompt policy.",
    });
  }
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
      ? buildRetrievedKnowledgeSection(
          opts.retrievedKnowledge.hits,
          readKnowledgeTopK(db, 4, directiveText ?? task.goal, true),
        )
      : buildKnowledgeSection(readKnowledgeTopK(db, 8, directiveText ?? task.goal));
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
  // Persistent owner-profile memory is part of depth-1 retrieval, not a
  // decorative UX footer. P1 (with retrieved knowledge + artifacts) so
  // the brain reads the owner's continuous signals, vocabulary, and
  // accumulated context on every cycle — even when P2/P3 sections are
  // trimmed under tight-budget pressure. The owner-channel data is
  // load-bearing for the LLM-on-the-fly demo generation (WORKFLOW step
  // 3) AND for the rendering rule (step 9) AND for owner-input learning
  // (step 10) — three workflow steps depend on this being present.
  const ownerContextRows = readOwnerContext(db, 8);
  const ownerProfileBody = buildOwnerProfileSection(readOwnerProfile(db), {
    recentOwnerContext: ownerContextRows,
    directive: {
      text: directiveText,
      goal: task.goal,
      lifecycle: task.lifecycle,
      urgency: task.urgency,
    },
  });
  candidates.push({ name: "owner_profile", p: 1, body: ownerProfileBody });
  const ownerContextBody = buildOwnerContextSection(ownerContextRows);
  candidates.push({ name: "owner_context", p: 1, body: ownerContextBody });
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
