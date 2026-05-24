// acc2 brain prompt composer — substrate projection under a strict token budget
// (Architecture.md).
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
import { poolQuery } from "./sql_pool_singleton";
import { snapshotWatchedOutputs } from "./watch_edges";
import { encodingForModel, type Tiktoken } from "js-tiktoken";
import type { EmbeddingIndex } from "./embedding_index";
import type { RetrievalHit, RetrievalResult } from "./retrieval";
import { renderStakeholderBlock } from "./stakeholder_compositor";
import { renderInterferenceBlock } from "./interference";
import { emitEvent } from "./events";
import { logger } from "./logger";
import { goalShape } from "./goal_shape";
import {
  currentHighWaterRowid,
  lookupCachedPrompt,
  recordPromptCacheHit,
  recordPromptCacheMiss,
  storeCachedPrompt,
  type CacheKey,
} from "./prompt_cache";
import { categorizeGoalShapeSemantic } from "./decomposition_strategy_extractor";
import { buildBrainSelfAudit, renderBrainSelfAuditSection } from "./brain_introspection";
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
  /** Q2 (brain amendment MDBZV4YVRH7D172BW40W1J5ASM, 2026-05-19): per-
   *  section pre-retrieved policy bundles. The dispatcher queries
   *  act_artifact for kind ∈ {prompt_policy_bundle, composer_policy_
   *  predicate} matching the directive goal_shape before composePrompt
   *  and passes the result here. pushRetrievedPolicyArtifactSection
   *  prefers the highest-score bundle; falls back to policyByName; then
   *  to the literal warning string. Retrieval stays OUT of composePrompt
   *  so composePrompt remains synchronous. */
  retrievedPolicyArtifacts?: Partial<Record<PolicyBundleSectionName, RetrievedPolicyArtifactBundle[]>>;
};

/** A pre-retrieved policy artifact bundle (Q2). Carries enough metadata
 *  for the composer to pick the highest-score row per section and emit a
 *  prompt_policy_section_selected audit row. The `artifactKind` field
 *  is an artifact-registry discriminator (NOT an event kind), so it is
 *  named `artifactKind` rather than `kind` to keep the substrate's
 *  event-kind literal-scan happy. */
export type RetrievedPolicyArtifactBundle = {
  artifactId: string;
  artifactKind: "prompt_policy_bundle" | "emission_grammar" | "self_introspection";
  surface: string;
  sectionName: PolicyBundleSectionName;
  body: string;
  priority?: number;
  floor?: boolean;
  score?: number;
  goalShape?: string;
  evidence_event_ids?: string[];
};

/** Q3 (brain amendment 945GW64HN91JBD8YYTAR0S4P0W, 2026-05-19): an
 *  admitted prompt_section_content_variant act_artifact, ranked by
 *  score × goal_shape_match × owner_profile_alignment. When the variant
 *  posterior STRICTLY exceeds the retrieved bundle / promoted policy
 *  bundle posterior, the variant body replaces it. Ties favor the
 *  policy bundle to keep cold-start stable. */
export type PromptSectionVariant = {
  variantId: string;
  sectionName: PolicyBundleSectionName;
  body: string;
  priority?: number;
  score: number;
  confidence?: number;
  goalShapeMatch: number;
  ownerProfileAlignment: number;
  evidence_event_ids?: string[];
};

type PromptSection = {
  name: string;
  priorityP: number;
  tokens: number;
  floor?: boolean;
};

type ComposedPrompt = {
  text: string;
  sections: PromptSection[];
  truncated: string[];
};

// 32k matches the realistic floor-section needs (top_laws +
// owner_profile + owner_rendering_policy + retrieved_knowledge run
// 10–15k tokens once the substrate accumulates ~300+ promoted_knowledge
// rows). Below this floor, dispatcher_violation{kind:floor_section_missing}
// fires on every brain dispatch — alarm noise on a structural undersize,
// not a structural fault. Modern brain models (gpt-5.5, opus 4.7) have
// 128K-1M context windows; 32k is a comfortable headroom over the
// load-bearing sections while staying well under any model's cap.
const DEFAULT_BUDGET_TOKENS = 32000;

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

const readTaskRow = async (db: Database, taskId: string): Promise<TaskRow | null> => {
  // Phase D: task rows live as `task_node_opened` events with payload.goal.
  // Once a tasks table exists (Phase E DAG topology), we'll query it directly.
  const rows = await poolQuery<Record<string, unknown>>(
    db,
    "SELECT id, directive_id, payload FROM events WHERE task_id = ? AND kind = 'task_node_opened' ORDER BY ts ASC LIMIT 1",
    [taskId],
  );
  const row = rows[0] ?? null;
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

const readDirectiveGoal = async (db: Database, directiveId: string): Promise<string | null> => {
  const rows = await poolQuery<Record<string, unknown>>(
    db,
    "SELECT payload FROM events WHERE directive_id = ? AND kind = 'directive_opened' ORDER BY ts ASC LIMIT 1",
    [directiveId],
  );
  const row = rows[0] ?? null;
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
const readExistingDecomposition = async (
  db: Database,
  directiveId: string,
  excludeTaskId: string,
  cap = 30,
): Promise<ExistingChild[]> => {
  if (!directiveId) return [];
  const rows = await poolQuery<{ task_id: string; ts: string; payload: string }>(
    db,
    `SELECT task_id, ts, payload FROM events
       WHERE kind = 'task_node_opened'
         AND directive_id = ?
         AND task_id != ?
       ORDER BY ts ASC`,
    [directiveId, excludeTaskId],
  );
  if (rows.length === 0) return [];
  const committedSet = new Set(
    (await poolQuery<{ task_id: string }>(
      db,
      `SELECT task_id FROM events WHERE kind = 'task_committed' AND directive_id = ?`,
      [directiveId],
    )).map((r) => r.task_id),
  );
  const failedSet = new Set(
    (await poolQuery<{ task_id: string }>(
      db,
      `SELECT task_id FROM events WHERE kind = 'task_failed' AND directive_id = ?`,
      [directiveId],
    )).map((r) => r.task_id),
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

// ── Proven decomposition strategy (Tier-S1 retrieval-binding leg) ──────────
//
// The decomposition_strategy_extractor scans CLOSED directives, buckets each
// by deterministic shape_category, and admits one
// act_artifact{kind:decomposition_strategy_predicate, id:decomp_<category>}
// row carrying an outcome-derived Beta posterior (effective_score is high when
// that shape historically closed with LOW aggregate closure_residual and LOW
// variance). Until now those scored rows were WRITTEN but never RETRIEVED —
// the write side of primitive #1 existed, the retrieval-binding leg did not.
//
// This reader closes the loop: at compose time it maps the directive goal to
// the SAME shape_category the extractor would assign (goal_class derived from
// the goal text, zero DAG geometry yet because the brain has not decomposed),
// looks up the matching scored predicate row, and — when that shape has
// historically closed well (effective_score above the advisory floor with
// enough samples) — surfaces it as advisory context so the brain retrieves a
// PROVEN decomposition strategy for similar future goals.
//
// Purely additive: a non-floor advisory candidate that drops first under
// budget pressure. It changes nothing about how/whether tasks dispatch or
// close — it only feeds the brain an outcome-scored structural prior.

const PROVEN_DECOMP_MIN_SAMPLES = 5;
const PROVEN_DECOMP_MIN_SCORE = 0.55;

type ProvenDecompositionStrategy = {
  shape_category: string;
  predicate_act_artifact_id: string;
  effective_score: number;
  mean_residual: number;
  sample_count: number;
  avg_fan_out: number;
  avg_max_depth: number;
  avg_total_nodes: number;
};

const readProvenDecompositionStrategy = async (
  db: Database,
  goalText: string | null | undefined,
): Promise<ProvenDecompositionStrategy | null> => {
  const goal = (goalText ?? "").trim();
  if (goal.length === 0) return null;
  // Map the goal to the SEMANTIC shape_category the extractor credits — no DAG
  // geometry exists pre-decomposition, so the semantic-only classifier carries
  // the signal. Returns null when no semantic signal fires (don't guess).
  let shapeCategory: ReturnType<typeof categorizeGoalShapeSemantic>;
  try {
    shapeCategory = categorizeGoalShapeSemantic(goal);
  } catch {
    return null;
  }
  if (!shapeCategory) return null;
  const id = `decomp_${shapeCategory}`;
  let row: { body: string | null; score: number | null } | null = null;
  try {
    const rows = await poolQuery<{ body: string | null; score: number | null }>(
      db,
      `SELECT body, score FROM act_artifact
          WHERE id = ?
            AND kind = 'decomposition_strategy_predicate'
            AND superseded_by IS NULL
            AND status IN ('admitted', 'promoted')
          LIMIT 1`,
      [id],
    );
    row = rows[0] ?? null;
  } catch {
    return null;
  }
  if (!row || !row.body) return null;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(row.body) as Record<string, unknown>;
  } catch {
    return null;
  }
  const sampleCount = typeof body.sample_count === "number" ? body.sample_count : 0;
  const effectiveScore =
    typeof body.effective_score === "number"
      ? body.effective_score
      : typeof row.score === "number"
        ? row.score
        : 0;
  // Advisory floor: only surface shapes the substrate has SEEN enough times
  // AND that historically closed well. A low-score shape is not a strategy to
  // recommend — surfacing it would be noise, not signal.
  if (sampleCount < PROVEN_DECOMP_MIN_SAMPLES) return null;
  if (effectiveScore < PROVEN_DECOMP_MIN_SCORE) return null;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    shape_category: shapeCategory,
    predicate_act_artifact_id: id,
    effective_score: effectiveScore,
    mean_residual: num(body.mean_residual),
    sample_count: sampleCount,
    avg_fan_out: num(body.avg_fan_out),
    avg_max_depth: num(body.avg_max_depth),
    avg_total_nodes: num(body.avg_total_nodes),
  };
};

const buildProvenDecompositionStrategySection = (
  s: ProvenDecompositionStrategy | null,
): string => {
  if (!s) return "";
  const pct = (v: number): string => `${(v * 100).toFixed(0)}%`;
  return [
    `PROVEN DECOMPOSITION STRATEGY (outcome-scored from ${s.sample_count} closed directive(s) of shape "${s.shape_category}"):`,
    `  This goal shape historically closed well (effective_score=${s.effective_score.toFixed(2)}, mean closure_residual=${s.mean_residual.toFixed(2)}) with a structure averaging ~${s.avg_fan_out.toFixed(1)} root child task(s), depth ~${s.avg_max_depth.toFixed(1)}, ~${s.avg_total_nodes.toFixed(1)} total node(s).`,
    `  ADVISORY ONLY: prefer this proven structure when it fits; deviate when the directive genuinely differs. If this prior shapes a root decomposition, put ${s.predicate_act_artifact_id} in the context_refs or cited_artifact_ids of the root task_node_opened/task_edge_recorded rows you emit. The root closure verifier back-credits that structural citation, so winning shapes rise and losing shapes decay. [cite ${s.predicate_act_artifact_id}]`,
  ].join("\n");
};

// ── Proven trajectory motif (Tier-S3 retrieval-binding leg) ────────────────
//
// The trajectory_motif_extractor mines recurring n-gram (length 3/4) tuples of
// event KINDS across closed directives and admits one
// act_artifact{kind:trajectory_motif_predicate, id:motif_<n>_<hash>} row per
// recurring sub-sequence. The row body is { kinds, length, frequency,
// avg_closure_residual }; its `score` is calibrated to 1 - avg_closure_residual
// (a motif whose directives closed with LOW residual is a GOOD recipe → high
// score). Until now those scored rows were WRITTEN + CREDITED but never
// RETRIEVED — the write+credit side of the primitive existed, the
// retrieval-binding leg did not, so "reuse proven trajectory shapes for similar
// goals" was unrealized.
//
// KEY MAPPING (no goal-text guessing, no DAG-geometry invention). A motif key
// is PURELY post-hoc event-kind geometry — it carries no goal_class/shape
// bucket, so there is no decomposition-style goal→category key to reuse. The
// only honest compose-time key is the directive's OWN trajectory-so-far: the
// substrate already knows the ordered event KINDS this open directive has
// emitted. A motif is a recurring contiguous sub-sequence; if the directive's
// recent trajectory tail matches a motif's leading kinds, that motif is a
// proven continuation of the path the directive is already on. So we read the
// directive's event-kind sequence and surface the highest-scoring motif whose
// kinds are anchored to (overlap a suffix of) that trajectory. This is
// retrieval by REAL substrate state, not by guessed goal geometry.
//
// Purely additive: a non-floor advisory candidate that drops first under budget
// pressure. It reads existing scored rows + the directive's own ledger events
// and emits nothing; it changes nothing about how/whether tasks dispatch or
// close. It only feeds the brain an outcome-scored recipe-shape prior.

const PROVEN_MOTIF_MIN_SAMPLES = 5;
const PROVEN_MOTIF_MIN_SCORE = 0.55;
// Bound the trajectory read: scan the directive's first N event kinds for a
// contiguous motif run. A motif is at most a 4-gram and the strategic spine
// (directive_opened → task_node_opened → …) lands early, so a bounded window
// captures the recipe while keeping the synchronous read cheap.
const PROVEN_MOTIF_TRAJECTORY_WINDOW = 64;

type ProvenTrajectoryMotif = {
  predicate_act_artifact_id: string;
  motif_name: string;
  kinds: string[];
  length: number;
  frequency: number;
  effective_score: number;
  avg_closure_residual: number;
};

// True when the directive's trajectory has already TRAVERSED the motif's
// recipe path: the motif's leading kinds appear as a CONTIGUOUS run somewhere
// in `trajectory`. A motif IS a recurring contiguous sub-sequence of event
// kinds (the extractor mines 3/4-grams), so "anchored" means the directive is
// on — or partway through — that proven sub-sequence. We require at least the
// first 2 motif kinds to match contiguously (a single shared kind is noise,
// not a recipe); a directive partway through a longer motif still matches its
// proven prefix. The directive's own trajectory accumulates composer-internal
// events (prompt_policy_section_selected, …) between the strategic kinds, so a
// pure suffix/prefix line-up is too brittle — contiguous containment of the
// motif's leading run is the honest, pollution-tolerant signal.
const motifAnchoredToTrajectory = (
  trajectory: ReadonlyArray<string>,
  motif: ReadonlyArray<string>,
): boolean => {
  if (motif.length < 2 || trajectory.length < 2) return false;
  // Longest leading run of the motif (down to 2 kinds) that appears verbatim
  // and contiguous somewhere in the trajectory.
  for (let runLen = Math.min(motif.length, trajectory.length); runLen >= 2; runLen--) {
    const run = motif.slice(0, runLen);
    for (let start = 0; start + runLen <= trajectory.length; start++) {
      let ok = true;
      for (let i = 0; i < runLen; i++) {
        if (trajectory[start + i] !== run[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
  }
  return false;
};

const readProvenTrajectoryMotif = async (
  db: Database,
  directiveId: string | null | undefined,
): Promise<ProvenTrajectoryMotif | null> => {
  const dir = (directiveId ?? "").trim();
  if (dir.length === 0) return null;
  // Read the directive's OWN trajectory-so-far (ordered event kinds). This is
  // the only honest compose-time key for a geometry-only motif — match the
  // directive against the path it is already on, never against guessed goal
  // shape.
  let trajectory: string[];
  try {
    const rows = await poolQuery<{ kind: string }>(
      db,
      `SELECT kind FROM events
          WHERE directive_id = ?
          ORDER BY ts ASC, rowid ASC
          LIMIT ?`,
      [dir, PROVEN_MOTIF_TRAJECTORY_WINDOW],
    );
    trajectory = rows.map((r) => r.kind);
  } catch {
    return null;
  }
  if (trajectory.length < 2) return null;

  // Pull admitted/promoted motif rows ranked by score (best recipe first).
  // Scored = score reflects 1 - avg_closure_residual, so high score = low
  // residual = proven-good recipe. Bound the candidate set; the first one whose
  // kinds anchor to the trajectory AND clear the advisory floor wins.
  let rows: Array<{ id: string; name: string | null; body: string | null; score: number | null }>;
  try {
    rows = await poolQuery<{ id: string; name: string | null; body: string | null; score: number | null }>(
      db,
      `SELECT id, name, body, score FROM act_artifact
          WHERE kind = 'trajectory_motif_predicate'
            AND superseded_by IS NULL
            AND status IN ('admitted', 'promoted')
          ORDER BY score DESC, updated_at DESC
          LIMIT 200`,
    );
  } catch {
    return null;
  }

  for (const row of rows) {
    if (!row.body) continue;
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(row.body) as Record<string, unknown>;
    } catch {
      continue;
    }
    const kinds = Array.isArray(body.kinds)
      ? (body.kinds.filter((k) => typeof k === "string") as string[])
      : [];
    if (kinds.length < 2) continue;
    const frequency = typeof body.frequency === "number" ? body.frequency : 0;
    // Advisory floor — sample side. frequency is the count of motif occurrences
    // across the closed-directive corpus (the extractor's `sample_count`
    // analogue). Don't recommend a recipe the substrate has barely seen.
    if (frequency < PROVEN_MOTIF_MIN_SAMPLES) continue;
    const score = typeof row.score === "number" ? row.score : 0;
    // Advisory floor — score side. A low-score motif (high avg_closure_residual)
    // is a path that historically closed POORLY — surfacing it would be noise.
    if (score < PROVEN_MOTIF_MIN_SCORE) continue;
    // Only recommend a motif the directive is actually on the path of. A motif
    // whose kinds don't anchor to this trajectory is some other directive's
    // recipe — irrelevant here.
    if (!motifAnchoredToTrajectory(trajectory, kinds)) continue;
    const avgResidual =
      typeof body.avg_closure_residual === "number" && Number.isFinite(body.avg_closure_residual)
        ? body.avg_closure_residual
        : clamp01(1 - score);
    return {
      predicate_act_artifact_id: row.id,
      motif_name: (row.name && row.name.length > 0 ? row.name : kinds.join(">")),
      kinds,
      length: kinds.length,
      frequency,
      effective_score: score,
      avg_closure_residual: avgResidual,
    };
  }
  return null;
};

const buildProvenTrajectoryMotifSection = (
  m: ProvenTrajectoryMotif | null,
): string => {
  if (!m) return "";
  const pct = (v: number): string => `${(Math.max(0, Math.min(1, v)) * 100).toFixed(0)}%`;
  return [
    `PROVEN TRAJECTORY MOTIF (outcome-scored recipe shape recurring across ${m.frequency} occurrence(s) of similar work):`,
    `  Directives that followed the event sequence "${m.kinds.join(" → ")}" historically closed well (effective_score=${m.effective_score.toFixed(2)}, mean closure_residual=${m.avg_closure_residual.toFixed(2)}). Your directive is already on this path.`,
    `  ADVISORY ONLY: continue this proven sub-sequence when it fits; deviate when the work genuinely differs. The substrate credits whichever trajectory closes — your residual feeds back into this score (${pct(m.effective_score)} confidence today). [cite ${m.predicate_act_artifact_id}]`,
  ].join("\n");
};

const goalShapeTags = (goalText?: string | null): string[] => {
  const tokens = String(goalText ?? "")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .split(/\s+/u)
    .filter((t) => t.length >= 3);
  return Array.from(new Set(tokens)).slice(0, 24);
};

const readKnowledgeTopK = async (
  db: Database,
  k: number,
  goalText?: string | null,
  shapeMatchOnly = false,
): Promise<Array<{ id: string; text: string; score: number }>> => {
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
  const rows = await poolQuery<Record<string, unknown>>(
    db,
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
       ORDER BY shape_match DESC,
                CAST(COALESCE(json_extract(p.payload, '$.score'), 0) AS REAL) DESC,
                p.ts DESC, p.rowid DESC
       LIMIT ?`,
    [shape, shape, shape, shapeTagsJson, shapeMatchOnly ? 1 : 0, shape, shape, shape, shapeTagsJson, k],
  );
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

const REQUIRED_POLICY_SECTION_NAMES = ["exit_invariant", "runtimes_available", "workflow", "do_not", "emission_grammars", "self_introspection"] as const;
type PolicyBundleSectionName = typeof REQUIRED_POLICY_SECTION_NAMES[number];
type PolicyBundleSection = { sectionName: PolicyBundleSectionName; priority: number; body: string; floor?: boolean };

const isPolicyBundleSectionName = (value: string): value is PolicyBundleSectionName => {
  return (REQUIRED_POLICY_SECTION_NAMES as readonly string[]).includes(value);
};

const readPolicyBundleSections = async (
  db: Database,
  surface: string,
  sectionNames: readonly PolicyBundleSectionName[],
): Promise<PolicyBundleSection[]> => {
  const wanted = new Set(sectionNames);
  const rows = await poolQuery<{ payload: string }>(
    db,
    `SELECT payload
         FROM events
        WHERE kind = 'knowledge_promoted'
          AND COALESCE(json_extract(payload, '$.policy_bundle.surface'), json_extract(payload, '$.surface')) = ?
          AND COALESCE(json_extract(payload, '$.type'), json_extract(payload, '$.policy_bundle.type')) = 'policy_bundle'
        ORDER BY ts DESC, rowid DESC
        LIMIT 100`,
    [surface],
  );

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
        floor: bundle.floor === true,
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

// ── Q2 (on-demand grammar retrieval) + Q3 (variant body selection) ────
// Brain amendments MDBZV4YVRH7D172BW40W1J5ASM + 945GW64HN91JBD8YYTAR0S4P0W
// (2026-05-19). Pre-fix the composer hard-coded section bodies through
// pushPolicySection(name, fallback) — the dispatcher could not feed
// scored, retrieved policy bundles or admitted variant rows into the
// emission_grammars / self_introspection slots. The two amendments
// rewire body selection precedence:
//
//   variant (strict-higher posterior than bundle)
//     > retrieved prompt_policy_bundle (from opts.retrievedPolicyArtifacts)
//     > promoted policyByName bundle
//     > literal "BRAIN PROMPT POLICY MISSING …" warning
//
// On exact tie the policy_bundle wins (cold-start stability — never let a
// brand-new variant displace a battle-tested bundle without evidence).

const LITERAL_POLICY_MISSING_WARNING = (name: string): string =>
  "BRAIN PROMPT POLICY MISSING: knowledge_promoted policy_bundle surface=brain_prompt section_name=" +
  name +
  ". Seed foundational knowledge before dispatch; do not substitute local literal prompt policy.";

const pickHighestScorePolicyBundle = (
  bundles: RetrievedPolicyArtifactBundle[] | undefined,
  sectionName: PolicyBundleSectionName,
): RetrievedPolicyArtifactBundle | null => {
  if (!bundles || bundles.length === 0) return null;
  let best: RetrievedPolicyArtifactBundle | null = null;
  for (const b of bundles) {
    if (b.sectionName !== sectionName) continue;
    if (typeof b.body !== "string" || b.body.length === 0) continue;
    const bScore = typeof b.score === "number" && Number.isFinite(b.score) ? b.score : 0;
    const bestScore = best && typeof best.score === "number" && Number.isFinite(best.score) ? best.score : -Infinity;
    if (!best || bScore > bestScore) best = b;
  }
  return best;
};

// Q3: read latest owner_profile_recorded payload (or null on failure)
// for variant ranking. Re-uses the export below (`readOwnerProfile`)
// when called from selectPromptSectionVariant; defaults applied there.
const readOwnerProfileForVariantSelection = (db: Database): OwnerProfile | null => {
  try {
    return readOwnerProfile(db);
  } catch {
    return null;
  }
};

// Q3: compute open-ended owner_profile alignment between a variant's
// payload.owner_profile_alignment map and the live OwnerProfile signal
// vectors. Normalised dot product over shared axes ∈ [0, 1]. When the
// profile is null OR the variant declares no alignment map, return 1.0
// (no penalty) so cold-start variants are not punished for the absence
// of profile data. See "owner_profile_alignment heuristic" in the
// originating brain dispatch for the formal recipe.
const computeOwnerProfileAlignment = (
  variantAlignment: unknown,
  profile: OwnerProfile | null,
): number => {
  if (!profile) return 1;
  if (!variantAlignment || typeof variantAlignment !== "object") return 1;
  const alignment = variantAlignment as Record<string, unknown>;
  const keys = Object.keys(alignment);
  if (keys.length === 0) return 1;
  // Concatenate every numeric signal-map on the profile into a single
  // signal vector. Open-ended Record<string, number> per substrate/
  // types.ts:OwnerProfile. We do not restrict to any named axis set —
  // every key the variant cites against the open-ended owner-profile
  // map can score.
  const signalVector: Record<string, number> = {};
  const mapsToScan: Array<unknown> = [
    profile.rendering_signals,
    profile.autonomy_signals,
    profile.control_signals,
    profile.risk_signals,
    profile.collaboration_signals,
    profile.goal_continuity_signals,
  ];
  for (const map of mapsToScan) {
    if (!map || typeof map !== "object") continue;
    for (const [k, v] of Object.entries(map as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) {
        const prev = signalVector[k] ?? 0;
        signalVector[k] = Math.max(prev, clamp01(v));
      }
    }
  }
  let dot = 0;
  let variantNorm = 0;
  let profileNorm = 0;
  for (const k of keys) {
    const vRaw = alignment[k];
    if (typeof vRaw !== "number" || !Number.isFinite(vRaw)) continue;
    const v = clamp01(vRaw);
    const p = signalVector[k] ?? 0;
    dot += v * p;
    variantNorm += v * v;
    profileNorm += p * p;
  }
  if (variantNorm === 0) return 1;
  // Normalize against the variant's own L2 magnitude — preserves the
  // open-ended axis vocabulary while keeping the result in [0, 1].
  const denom = Math.sqrt(variantNorm) * Math.max(Math.sqrt(profileNorm), Math.sqrt(variantNorm));
  if (denom === 0) return 1;
  return clamp01(dot / denom);
};

// Q3: compute goal_shape_match. Simple substring match between the
// directive goal_shape (or raw goal text tokens) and any string in
// payload.goal_shape_tags returns 1.0; otherwise 0.0. Embedding-based
// match is out of scope (defer to later contract per brain plan).
const computeGoalShapeMatch = (variantGoalShapeTags: unknown, goalText: string): number => {
  if (!Array.isArray(variantGoalShapeTags) || variantGoalShapeTags.length === 0) return 0;
  const shape = goalShape(goalText || "").toLowerCase();
  const shapeTokens = new Set(goalShapeTags(goalText));
  for (const raw of variantGoalShapeTags) {
    if (typeof raw !== "string" || raw.length === 0) continue;
    const tag = raw.toLowerCase();
    if (shape && (shape.includes(tag) || tag.includes(shape))) return 1;
    if (shapeTokens.has(tag)) return 1;
  }
  return 0;
};

// Q3: select the best admitted prompt_section_content_variant for the
// given section. Returns null when no variant scores positive.
const selectPromptSectionVariant = async (
  db: Database,
  opts: {
    sectionName: PolicyBundleSectionName;
    goalText: string;
    ownerProfile: OwnerProfile | null;
    fallbackBody: string;
    policyBundleArtifactId?: string | null;
  },
): Promise<PromptSectionVariant | null> => {
  const rows = await poolQuery<Record<string, unknown>>(
    db,
    `SELECT id, body, score, confidence, name
         FROM act_artifact
        WHERE kind = 'prompt_section_content_variant'
          AND status = 'admitted'
          AND (name = ? OR name IS NULL)
        ORDER BY score DESC, confidence DESC
        LIMIT 50`,
    [opts.sectionName],
  );
  let best: PromptSectionVariant | null = null;
  let bestRanked = -Infinity;
  for (const r of rows) {
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(String(r.body ?? "{}")) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!parsed) continue;
    const payload = (parsed.payload && typeof parsed.payload === "object")
      ? parsed.payload as Record<string, unknown>
      : parsed;
    const sectionName = (payload.section_name as string | undefined) ?? (parsed.name as string | undefined);
    if (sectionName !== opts.sectionName) continue;
    const body = payload.body;
    if (typeof body !== "string" || body.length === 0) continue;
    const score = typeof r.score === "number" && Number.isFinite(r.score) ? (r.score as number) : 0;
    if (score <= 0) continue;
    const goalShapeMatch = computeGoalShapeMatch(payload.goal_shape_tags, opts.goalText);
    const ownerProfileAlignment = computeOwnerProfileAlignment(payload.owner_profile_alignment, opts.ownerProfile);
    const ranked = score * ownerProfileAlignment;
    if (ranked <= 0) continue;
    if (ranked > bestRanked) {
      bestRanked = ranked;
      const evidenceRaw = payload.evidence_event_ids;
      best = {
        variantId: String(r.id),
        sectionName: opts.sectionName,
        body,
        priority: typeof payload.priority === "number" ? (payload.priority as number) : undefined,
        score,
        confidence: typeof r.confidence === "number" && Number.isFinite(r.confidence) ? (r.confidence as number) : undefined,
        goalShapeMatch,
        ownerProfileAlignment,
        evidence_event_ids: Array.isArray(evidenceRaw) ? (evidenceRaw as unknown[]).map(String) : undefined,
      };
    }
  }
  return best;
};

// Organism-alignment audit b3qc9ryzj finding #5 (2026-05-15): pending
// lesson_extracted / contract_amendment_proposed rows lived in a view
// (lesson_implementer_queue_view) but never entered the brain prompt.
// Now they do — the brain SEES its own past proposals at decision time
// and can route them through new task DAGs / actions. Owner-gated
// proposals are excluded (those need orchestrator-side apply, not
// brain-side automation). Capped at k entries by ts ASC (oldest first).
const readPendingProposals = async (
  db: Database,
  k: number,
  excludeDirectiveId?: string,
): Promise<Array<{ id: string; ts: string; kind: string; target: string | null; summary: string; directive_id: string }>> => {
  // lesson_implementer_queue_view already filters out applied proposals
  // (its WHERE clause excludes rows with applied_change_committed). We
  // additionally skip owner-gated proposals — those need orchestrator-
  // side apply, not brain-side automation. Filter by directive when
  // excludeDirectiveId is set so the section doesn't echo the current
  // goal's own proposals.
  const rows = await poolQuery<Record<string, unknown>>(
    db,
    `SELECT source_event_id, ts, source_kind, directive_id, target, anchor,
              proposed_behavior, proposed_action, lesson_kind, owner_gate_required
       FROM lesson_implementer_queue_view
       WHERE COALESCE(owner_gate_required, 0) = 0
         AND (? IS NULL OR directive_id != ?)
       ORDER BY ts ASC
       LIMIT ?`,
    [excludeDirectiveId ?? null, excludeDirectiveId ?? null, k],
  );
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

const buildPendingProposalsSection = (rows: Awaited<ReturnType<typeof readPendingProposals>>): string => {
  if (rows.length === 0) return "PENDING PROPOSALS: (none)";
  const lines = ["PENDING PROPOSALS:"];
  for (const r of rows) {
    const targetSuffix = r.target ? ` → ${r.target}` : "";
    lines.push(`  [${r.id.slice(0, 12)}] ${r.kind}${targetSuffix}: ${r.summary.slice(0, 240)}`);
  }
  return lines.join("\n");
};

// F11 (2026-05-18, contract 2AMJKN0GTX32790173EPYH6YT4): OUTSTANDING
// CONTRACT AMENDMENTS section sourced from pending_contract_amendments_view
// so the brain sees live unsettled proposals at compose time and can
// cite, supersede, clarify, decline, or route them within the same
// cycle. The view filters to proposals with no closure verdict and no
// applied_change_committed; this section additionally prefers the
// current directive's own proposals (k slots from the current
// directive) before others (k slots from peer directives), capped by
// a hard byte budget so a backlog spike can't bloat the prompt.
const OUTSTANDING_AMENDMENT_BYTE_BUDGET = 2000;
const OUTSTANDING_AMENDMENT_ROW_CAP = 10;

const formatAge = (ageMs: number): string => {
  if (ageMs < 60_000) return `${Math.max(0, Math.floor(ageMs / 1000))}s`;
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m`;
  if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}h`;
  return `${Math.floor(ageMs / 86_400_000)}d`;
};

const readOutstandingContractAmendments = async (
  db: Database,
  currentDirectiveId: string,
  rowCap: number = OUTSTANDING_AMENDMENT_ROW_CAP,
): Promise<PendingContractAmendmentRow[]> => {
  // Pull a generous slice so we can prefer the current directive's own
  // rows before falling back to peers. The view already orders by ts
  // ASC, so re-sort here keeps deterministic ordering. Routed through the
  // SQL worker pool (pendingContractAmendmentsPooled) so the view's two
  // full-ledger json_each scans run OFF the daemon event loop — same SQL,
  // same row shape, byte-identical result; only the execution thread differs.
  const all = await pendingContractAmendmentsPooled(db, poolQuery, { limit: rowCap * 4 });
  const own: PendingContractAmendmentRow[] = [];
  const others: PendingContractAmendmentRow[] = [];
  for (const r of all) {
    if (r.directive_id === currentDirectiveId) own.push(r);
    else others.push(r);
  }
  // Within each bucket prefer newest first — the brain should see the
  // freshest design context first; older proposals are likely already
  // covered by the lifecycle sweep's stuck-row path.
  own.sort((a, b) => b.ts.localeCompare(a.ts));
  others.sort((a, b) => b.ts.localeCompare(a.ts));
  return [...own, ...others].slice(0, rowCap);
};

const buildOutstandingContractAmendmentsSection = (rows: PendingContractAmendmentRow[]): string => {
  if (rows.length === 0) return "OUTSTANDING CONTRACT AMENDMENTS: (none)";
  const lines = ["OUTSTANDING CONTRACT AMENDMENTS:"];
  let totalBytes = lines[0].length;
  let truncated = 0;
  for (const r of rows) {
    const target = r.target_resource ?? "(no target_resource)";
    const predicate = r.predicate ? r.predicate.slice(0, 80) : "(no predicate)";
    const supSuffix = r.supersession_state === "superseded_by" && r.newer_proposal_id
      ? ` superseded_by=${r.newer_proposal_id.slice(0, 12)}`
      : "";
    const line = `  [${r.proposal_id.slice(0, 12)}] target=${target} predicate=${predicate} age=${formatAge(r.age_ms)}${supSuffix}`;
    if (totalBytes + line.length + 1 > OUTSTANDING_AMENDMENT_BYTE_BUDGET) {
      truncated++;
      continue;
    }
    lines.push(line);
    totalBytes += line.length + 1;
  }
  if (truncated > 0) lines.push(`  … (${truncated} more elided by byte budget)`);
  return lines.join("\n");
};

// Cross-goal context (multi-directive parallelism): list OTHER active
// directives so the brain knows what concurrent work is in flight and
// can avoid duplication / cite peer work / propose interference edges.
const readOtherActiveGoals = async (
  db: Database,
  currentDirectiveId: string,
  k: number,
): Promise<Array<{ id: string; opened_ts: string; text: string; lifecycle: string }>> => {
  const rows = await poolQuery<Record<string, unknown>>(
    db,
    `SELECT directive_id, opened_ts, payload
       FROM active_objectives_view
       WHERE directive_id != ?
       ORDER BY opened_ts DESC
       LIMIT ?`,
    [currentDirectiveId, k],
  );
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

const buildOtherGoalsSection = (rows: Awaited<ReturnType<typeof readOtherActiveGoals>>): string => {
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
const readOwnerContext = async (
  db: Database,
  k: number,
): Promise<OwnerContextRow[]> => {
  const rows = await poolQuery<Record<string, unknown>>(
    db,
    `SELECT event_id, ts, directive_id, kind, payload
       FROM owner_conversation_view
       ORDER BY ts DESC
       LIMIT ?`,
    [k],
  );
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

const buildOwnerContextSection = (rows: Awaited<ReturnType<typeof readOwnerContext>>): string => {
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
    "  render_policy: render naturally in the owner's detected_language at high quality; keep code identifiers literal; use compact evidence/event language when code_density or ops_vocabulary is high",
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
  // preferred_terms / avoided_terms vocabulary-mirroring removed: the owner's
  // LANGUAGE comes from detected_language and the owner predicates
  // (theory_of_mind / owner_state); mirroring their exact word-forms back
  // into output degraded deliverable quality (a non-native owner's imperfect
  // phrasing is not a style guide). Fields remain on the profile but are no
  // longer injected into the composed prompt.
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

// ── OWNER RENDERING POLICY (brain contract Q471RAN88X0H513V8BC3BTW0AW, 2026-05-17) ──
//
// Two prompt sections — OWNER RENDERING POLICY and OWNER FEEDBACK SUMMARY —
// teach every cycle that produces owner-visible language to:
//   1) hide substrate IDs/jargon from primary surfaces,
//   2) match the owner's preferred_terms / avoided_terms,
//   3) ask ONE plain-words question when blocked,
//   4) request confirmation before irreversible/owner-sensitive steps,
//   5) hold detail behind an explicit drilldown surface.
//
// The policy comes from `owner_rendering_policy_view` (latest profile +
// 14-day feedback aggregates); the section is always emitted, even on a
// cold install, so the brain knows the rendering contract exists.

import {
  ownerRenderingPolicy,
  ownerStateBelief,
  topLaws,
  pendingContractAmendmentsPooled,
  type OwnerRenderingPolicyRow,
  type OwnerStateBeliefRow,
  type PendingContractAmendmentRow,
  type TopLawRow,
} from "../substrate/views";

const RENDERING_INVARIANT_LINES: readonly string[] = [
  "1. Primary owner-visible text MUST NOT contain event_ids, task_ids, directive_ids, view names, residual numbers, or substrate vocabulary.",
  "2. When primary surface implies action (verify/dispatch/abort/etc.), end with ONE plain-words ask: 'reply when ready', 'do you want me to...', 'please confirm'.",
  "3. Detail surfaces (drilldown / drawer / --json) MAY surface IDs and substrate vocabulary; that is the explicit technical-detail audience.",
  "4. Before irreversible / owner-sensitive steps, emit owner_input_required (brain) or hidl_action_required (substrate) with a plain-words summary + suggested_action.",
  "5. Render owner-visible language in detected_language when policy.detected_language is set with confidence ≥ 0.7; otherwise default to English.",
  "6. After emitting an owner-visible string, emit rendered_owner_message_recorded so owner_rendering_feedback_recorded can credit the policy posterior.",
] as const;

const formatStringArray = (xs: readonly string[]): string => {
  if (!xs || xs.length === 0) return "(none)";
  return xs.slice(0, 12).join(", ");
};

export const buildOwnerRenderingPolicySection = (policy: OwnerRenderingPolicyRow | null): string => {
  const lines: string[] = ["## OWNER RENDERING POLICY"];
  if (!policy) {
    lines.push("(no owner_profile_recorded row yet — default invariants apply; do not assume preferences)");
  } else {
    if (policy.detected_language) {
      lines.push(`detected_language: ${policy.detected_language} (render owner-visible language in this when confidence ≥ 0.7)`);
    }
    if (typeof policy.autonomy_score === "number") {
      lines.push(`autonomy_score: ${policy.autonomy_score.toFixed(2)} (below ~0.4 → block multi-file diffs and require explicit owner confirmation before action)`);
    }
    // preferred_terms / avoided_terms vocabulary-mirroring removed (see
    // buildOwnerProfileSection): owner language is sourced from
    // detected_language + owner predicates, not word-form mirroring.
    if (policy.declined_concepts.length > 0) {
      lines.push(`declined_concepts (owner declined this concept; use preferred_term mapping if present): ${formatStringArray(policy.declined_concepts)}`);
    }
    if (policy.understood_concepts.length > 0) {
      lines.push(`understood_concepts (owner has demonstrated comprehension; safe to reference without re-explaining): ${formatStringArray(policy.understood_concepts)}`);
    }
    if (policy.things_to_never_do.length > 0) {
      lines.push("things_to_never_do (owner-set hard constraints; refuse + explain + ask for alternative):");
      for (const t of policy.things_to_never_do) lines.push(`  - ${t}`);
    }
    if (policy.manual_review_patterns.length > 0) {
      lines.push("manual_review_patterns (route via owner_input_required before action):");
      for (const p of policy.manual_review_patterns) lines.push(`  - ${p}`);
    }
    lines.push(`policy_health: ${policy.policy_health.toFixed(2)} (1.0 = clean recent feedback; below ~0.7 → route to careful-render mode)`);
  }
  lines.push("");
  lines.push("Rendering invariants (ALWAYS apply when rendering owner-facing text):");
  for (const inv of RENDERING_INVARIANT_LINES) lines.push(inv);
  return lines.join("\n");
};

// ── OWNER STATE BELIEF + ALIGNMENT ACTION POLICY + STATE FEEDBACK SUMMARY
//    (brain contract CY7E62DSNX1DZ1BTD56845D994 Phase H2, 2026-05-18)
//
// The substrate maintains a dynamic owner world model in
// owner_state_belief_view: latest latent-state hypothesis + 14-day
// prediction-error aggregate. These three sections expose the belief to
// every brain cycle so action selection becomes belief-conditioned, not
// just task-conditioned. The brain reads OWNER STATE BELIEF to know
// what it currently thinks about the owner, ALIGNMENT ACTION POLICY to
// know which actions fit the belief, and STATE FEEDBACK SUMMARY to know
// how wrong the substrate has been recently (calibration signal).

const ALIGNMENT_ACTION_POLICY_LINES: readonly string[] = [
  "When emotional_register is 'frustrated' or 'tired' (high confidence): contract output, lead with status + next concrete action, skip explanation unless asked.",
  "When attention_budget is 'low': defer non-critical clarifications; batch related asks; do not request approval for reversible inline work.",
  "When attention_budget is 'high' and decision_style includes 'evidence_first': surface evidence + posteriors + the artifact id behind any change.",
  "When skill_calibration shows 'novice' in the current domain: define unfamiliar terms once at first use; never assume.",
  "When latent_larger_goal is set and the current task diverges from it (high uncertainty about fit): emit owner_input_required asking 'does this serve <larger_goal>?'.",
  "Before any action that hits things_to_never_do: refuse, explain why, propose an alternative. Do NOT proceed silently.",
  "When uncertainty > 0.6 or is_stale=true: ask one short clarifying question before acting; the belief is too weak to act on.",
  "After every owner-visible interaction: emit alignment_action_selected referencing the hypothesis_event_id you read from this section. That closes the loop — the rendering_audit worker + closure_audited credit the policy posterior.",
] as const;

const formatLatentState = (latent: Record<string, unknown>, confidence: Record<string, number>): string[] => {
  const out: string[] = [];
  const fmt = (key: string, label?: string): void => {
    const v = latent[key];
    if (v == null || v === "") return;
    const c = confidence[key];
    const cStr = typeof c === "number" ? ` (conf ${c.toFixed(2)})` : "";
    if (Array.isArray(v)) {
      if (v.length > 0) out.push(`  ${label ?? key}: ${v.slice(0, 6).join(", ")}${cStr}`);
    } else if (typeof v === "object") {
      out.push(`  ${label ?? key}: ${JSON.stringify(v)}${cStr}`);
    } else {
      out.push(`  ${label ?? key}: ${String(v)}${cStr}`);
    }
  };
  fmt("emotional_register", "emotional_register");
  fmt("attention_budget", "attention_budget");
  fmt("energy_budget", "energy_budget");
  fmt("decision_style", "decision_style");
  fmt("working_memory_horizon", "working_memory_horizon");
  fmt("skill_calibration", "skill_calibration");
  fmt("latent_larger_goal", "latent_larger_goal");
  fmt("goal_intent", "goal_intent");
  fmt("recent_disappointments", "recent_disappointments");
  fmt("recent_satisfactions", "recent_satisfactions");
  return out;
};

export const buildOwnerStateBeliefSection = (belief: OwnerStateBeliefRow | null): string => {
  const lines: string[] = ["## OWNER STATE BELIEF"];
  if (!belief) {
    lines.push("(no owner_state_hypothesis_recorded row yet — substrate has not formed a latent-state belief)");
    lines.push("Hint: when you have enough owner_input_received / owner_observed_outcome_recorded evidence to form a hypothesis, emit owner_state_hypothesis_recorded with latent_state, per-axis confidence, observation_refs, and uncertainty.");
    return lines.join("\n");
  }
  lines.push(`hypothesis_event_id: ${belief.hypothesis_event_id ?? "?"} (cite when emitting alignment_action_selected so the loop credits posteriors)`);
  lines.push(`hypothesis_ts: ${belief.hypothesis_ts ?? "?"}  age_ms=${belief.belief_age_ms}  uncertainty=${belief.uncertainty.toFixed(2)}${belief.is_stale ? "  STALE (decay_after_iso < now — refresh before relying on this)" : ""}`);
  lines.push("latent_state:");
  const formatted = formatLatentState(belief.latent_state, belief.confidence);
  if (formatted.length === 0) {
    lines.push("  (latent_state payload was empty or unparseable)");
  } else {
    for (const l of formatted) lines.push(l);
  }
  if (belief.observation_refs.length > 0) {
    lines.push(`grounded_in (event_ids): ${belief.observation_refs.slice(0, 8).join(", ")}${belief.observation_refs.length > 8 ? ", …" : ""}`);
  }
  if (belief.recent_prediction_error_count > 0) {
    const avg = belief.recent_avg_prediction_error;
    lines.push(`recent_prediction_errors (14d): ${belief.recent_prediction_error_count}${avg != null ? `  avg=${avg.toFixed(3)}` : ""} — substrate has been wrong about the belief; route to careful-render mode if avg > 0.3`);
  }
  return lines.join("\n");
};

export const buildAlignmentActionPolicySection = (belief: OwnerStateBeliefRow | null): string => {
  const lines: string[] = ["## ALIGNMENT ACTION POLICY"];
  if (!belief) {
    lines.push("(no owner_state_belief — emit alignment_action_selected only when you have a hypothesis_event_id to cite; otherwise act per OWNER PROFILE defaults)");
    return lines.join("\n");
  }
  lines.push("Decision rules (consult OWNER STATE BELIEF above for current axis values):");
  for (const rule of ALIGNMENT_ACTION_POLICY_LINES) lines.push(`- ${rule}`);
  return lines.join("\n");
};

// ── TOP LAWS section (brain dispatch 3NWCD7PW315W Phase I3+, 2026-05-18) ──
// Surfaces the substrate's highest-scoring promoted_knowledge rows
// (top_laws_view, score >= 0.75 by default) so the brain sees its own
// current principles at compose time. Same pattern as the legacy
// system/CLAUDE.md auto-compiled Top Laws section — but driven from
// live Beta posterior, refreshed every cycle. The brain emits with
// fewer prompt-compliance failures (k_201 retrieval binding becomes
// literal: cite the law id when the law shaped the action).
export const buildTopLawsSection = (laws: TopLawRow[]): string => {
  const lines: string[] = ["## TOP LAWS (auto-compiled from scored knowledge — score >= 0.75)"];
  if (laws.length === 0) {
    lines.push("(no promoted_knowledge rows above the floor yet — substrate is still learning its principles)");
    return lines.join("\n");
  }
  lines.push("");
  lines.push("These are the organism's current highest-scored principles by Beta posterior. They govern brain emission. Cite the relevant law's event_id in any action_predicted.context_refs when a law shaped the action — citation is mutation (k_554).");
  lines.push("");
  for (const law of laws) {
    const shortText = law.text.replace(/\s+/g, " ").trim();
    const truncated = shortText.length > 320 ? shortText.slice(0, 317) + "…" : shortText;
    lines.push(`${law.law_rank}. ${law.event_id} (score ${law.score.toFixed(2)}): ${truncated}`);
  }
  return lines.join("\n");
};

export const buildOwnerStateFeedbackSummarySection = (belief: OwnerStateBeliefRow | null): string => {
  const lines: string[] = ["## OWNER STATE FEEDBACK SUMMARY (14-day calibration window)"];
  if (!belief) {
    lines.push("(no belief yet — no prediction-error window to aggregate)");
    return lines.join("\n");
  }
  if (belief.recent_prediction_error_count === 0) {
    lines.push("(no owner_state_prediction_error_recorded rows in window — belief is uncalibrated; emit prediction-error rows after owner-visible interactions so the substrate learns where the hypothesis was wrong)");
    return lines.join("\n");
  }
  const avg = belief.recent_avg_prediction_error;
  lines.push(`prediction_error_count: ${belief.recent_prediction_error_count}`);
  if (avg != null) {
    lines.push(`avg_prediction_error: ${avg.toFixed(3)} (0 = always right; ≥0.3 = substrate is systematically wrong, refresh the hypothesis)`);
    if (avg >= 0.5) {
      lines.push("WARNING: prediction error is high. Treat the belief as a weak prior; ask one plain-words question before acting on a belief axis you are about to use.");
    } else if (avg >= 0.3) {
      lines.push("Route to careful-render mode: prediction error is elevated. Cite the belief but also surface the alternative interpretation when uncertainty matters.");
    } else {
      lines.push("Belief is well-calibrated in window — safe to act on high-confidence axes inline.");
    }
  }
  return lines.join("\n");
};

export const buildOwnerFeedbackSummarySection = (policy: OwnerRenderingPolicyRow | null): string => {
  const lines: string[] = ["## OWNER FEEDBACK SUMMARY (14-day window)"];
  if (!policy) {
    lines.push("(no owner_profile_recorded row yet — no rendering feedback aggregated)");
    return lines.join("\n");
  }
  const total =
    policy.recent_correction_count
    + policy.recent_decline_count
    + policy.recent_ignored_count
    + policy.recent_satisfaction_count
    + policy.recent_clarification_count
    + policy.recent_override_count;
  if (total === 0) {
    lines.push("(no rendering feedback yet — render carefully; the substrate is still learning the owner's signal vocabulary)");
    return lines.join("\n");
  }
  lines.push(`corrections: ${policy.recent_correction_count} (raise: owner rephrased/explicitly corrected the substrate)`);
  lines.push(`declines: ${policy.recent_decline_count} (raise: owner declined an action or option)`);
  lines.push(`ignored: ${policy.recent_ignored_count} (raise: owner did not respond when expected)`);
  lines.push(`satisfaction: ${policy.recent_satisfaction_count} (raise: owner approved / confirmed / signalled positive)`);
  lines.push(`clarification_loops: ${policy.recent_clarification_count} (raise: owner asked us to re-explain — usually a jargon leak)`);
  lines.push(`manual_overrides: ${policy.recent_override_count} (raise: owner manually overrode our action — major rendering signal)`);
  lines.push("");
  lines.push("Use these aggregates to choose the careful-render mode (when corrections+declines+ignored+overrides ≥ 2) or the trusting-render mode (when satisfaction outweighs negative signal).");
  return lines.join("\n");
};

const readArtifactRegistryTopK = async (db: Database, k: number): Promise<Array<{ id: string; runtime: string; name: string; score: number; kind?: string }>> => {
  const rows = await poolQuery<Record<string, unknown>>(
    db,
    "SELECT id, runtime, name, score, confidence, kind FROM act_artifact WHERE status IN ('admitted','promoted') ORDER BY score DESC, confidence DESC LIMIT ?",
    [k],
  );
  return rows.map((r) => ({
    id: r.id as string,
    runtime: r.runtime as string,
    name: ((r.name as string | null) ?? "(unnamed)"),
    score: r.score as number,
    kind: r.kind as string | undefined,
  }));
};

/** T4.1 counterfactual credit boundary — read the next K artifact-registry
 *  rows that LOST the top-K cut. The counterfactual_credit_worker scores
 *  these against the chosen path's residual after window_seconds. */
const readArtifactRegistryRejected = async (
  db: Database,
  chosenK: number,
  rejectedK: number,
): Promise<Array<{ id: string; score: number; kind?: string }>> => {
  const rows = await poolQuery<Record<string, unknown>>(
    db,
    "SELECT id, score, kind FROM act_artifact WHERE status IN ('admitted','promoted') ORDER BY score DESC, confidence DESC LIMIT ? OFFSET ?",
    [rejectedK, chosenK],
  );
  return rows.map((r) => ({
    id: r.id as string,
    score: r.score as number,
    kind: r.kind as string | undefined,
  }));
};

/** T4.1 counterfactual credit boundary — read the next K knowledge_promoted
 *  rows that LOST the top-K cut (the K+1, K+2 near-misses). Simpler than
 *  readKnowledgeTopK (no rich-payload extraction needed — the worker only
 *  needs id + score for the counterfactual emission). */
const readKnowledgeRejected = async (
  db: Database,
  chosenK: number,
  rejectedK: number,
  goalText?: string | null,
): Promise<Array<{ id: string; score: number }>> => {
  // RLMQ_PROMPT_COMP: order the rejected boundary the SAME way the chosen
  // top-K is ordered — relevance class (goal-shape match) first, then
  // numeric relevance_score, then recency — so the K+1..K+rejectedK rows
  // are the rows that actually lost the relevance-first cut, not the
  // recency-first cut. When no goalText is supplied the shape_match class
  // collapses to 0 for all rows and the ordering degrades to
  // score-then-recency.
  const shape = goalText ? goalShape(goalText) : null;
  const shapeTagsJson = JSON.stringify(goalShapeTags(goalText));
  const rows = await poolQuery<Record<string, unknown>>(
    db,
    `SELECT p.id AS id, p.payload AS payload,
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
        WHERE p.kind = 'knowledge_promoted'
        ORDER BY shape_match DESC,
                 CAST(COALESCE(json_extract(p.payload, '$.score'), 0) AS REAL) DESC,
                 p.ts DESC, p.rowid DESC
        LIMIT ? OFFSET ?`,
    [shape, shape, shape, shapeTagsJson, rejectedK, chosenK],
  );
  const out: Array<{ id: string; score: number }> = [];
  for (const r of rows) {
    let score = 0;
    try {
      const p = JSON.parse((r.payload as string) ?? "{}") as Record<string, unknown>;
      if (typeof p.score === "number") score = p.score;
    } catch { /* skip */ }
    out.push({ id: r.id as string, score });
  }
  return out;
};

const readRecentFailures = async (db: Database, k: number): Promise<Array<{ kind: string; ts: string }>> => {
  const rows = await poolQuery<Record<string, unknown>>(
    db,
    "SELECT failure_kind, ts FROM events WHERE failure_kind IS NOT NULL ORDER BY ts DESC LIMIT ?",
    [k],
  );
  return rows.map((r) => ({ kind: r.failure_kind as string, ts: r.ts as string }));
};

const readConstitutionalGates = async (db: Database): Promise<string[]> => {
  const rows = await poolQuery<Record<string, unknown>>(
    db,
    "SELECT payload FROM events WHERE kind = 'constitutional_gate_decision' ORDER BY ts DESC LIMIT 10",
  );
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

const FIXTURE_D_MARKER = "FIXTURE: fixture_d_count_todos";

// Sub-stage profiling inside composePrompt (gated behind ACC2_PROFILE_LOOP,
// mirrors task_dispatcher.ts timeStage + daemon.ts startLoopLagMonitor). The
// dispatcher's `compose_prompt` stage was the largest warm cost (~7s) but
// opaque at sub-step granularity: it bundles ~20 awaited view reads, several
// SYNCHRONOUS view reads (topLaws / pendingContractAmendments / owner-state)
// that block the single event loop, and per-section pack/rank loops. This
// helper wraps each meaningful sub-step so daemon.log attributes the >7s (and
// any residual loop-block) to a SPECIFIC operation. Default OFF → zero overhead
// (the awaited/sync work still runs; only the timer + log is skipped). The
// threshold is well below the loop-block budget so a sub-step trending toward
// it is visible before it regresses.
const COMPOSE_PROFILE_ENABLED = process.env.ACC2_PROFILE_LOOP === "1";
const COMPOSE_SUBSTAGE_THRESHOLD_MS = 25;

const subStage = async <T>(stage: string, taskId: string, fn: () => Promise<T> | T): Promise<T> => {
  if (!COMPOSE_PROFILE_ENABLED) return await fn();
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    const ms = performance.now() - t0;
    if (ms > COMPOSE_SUBSTAGE_THRESHOLD_MS) {
      logger.warn(
        { event: "compose_substage_timing", stage, ms: Math.round(ms), task_id: taskId },
        "compose_substage_timing",
      );
    }
  }
};

/** Compose the brain prompt as a substrate projection. Sections are emitted
 *  in priority order; lowest-priority sections drop first when the budget
 *  would be exceeded. Returns the rendered text plus a section manifest so
 *  callers (and tests) can audit what was kept vs dropped. */
export const composePrompt = async (db: Database, opts: PromptComposeOptions): Promise<ComposedPrompt> => {
  const budget = opts.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  const task = await readTaskRow(db, opts.taskId);
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

  const directiveText = await readDirectiveGoal(db, task.directive_id);

  // RLMQ_PROMPT_COMP (brain design, 2026-05-23): bounded in-memory
  // composition reuse. The cache key is the task/directive identity plus
  // an options_signature over every NON-substrate input that changes the
  // composed text — budget, goal-shape, and the signatures of any
  // pre-computed retrieval / policy-artifact inputs the caller passed.
  // Substrate movement is captured separately by prompt_cache's high-water
  // mark (which excludes prompt-composer telemetry). On a miss we compose
  // normally and store; on a hit we return a deep clone of the cached
  // ComposedPrompt so callers can't mutate the shared entry. Fail-soft:
  // any cache error degrades to a normal compose.
  const retrievalSignature = (r: RetrievalResult | null | undefined): string => {
    if (!r) return "-";
    return r.hits.map((h) => `${h.event_id}:${(h as { score?: number }).score ?? ""}`).join(",");
  };
  const policyArtifactSignature = (): string => {
    const bundles = opts.retrievedPolicyArtifacts;
    if (!bundles) return "-";
    return Object.entries(bundles)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([section, rows]) => `${section}=${(rows ?? []).map((r) => `${r.artifactId}:${r.score ?? ""}`).join("+")}`)
      .join(";");
  };
  const optionsSignature = JSON.stringify({
    budget,
    goal_shape: goalShape(directiveText ?? task.goal),
    retrieval_unavailable: opts.retrievalUnavailable?.reason ?? null,
    knowledge_sig: retrievalSignature(opts.retrievedKnowledge),
    artifact_sig: retrievalSignature(opts.retrievedArtifacts),
    policy_sig: policyArtifactSignature(),
  });
  const cacheKey: CacheKey = {
    directive_id: task.directive_id,
    task_id: task.id,
    options_signature: optionsSignature,
  };
  // Snapshot the high-water mark BEFORE composition. Composition emits its
  // own act_tuple_recorded (citation-choice credit) which is not in the
  // telemetry-exclusion set; stamping the pre-composition mark prevents
  // that self-emitted row from invalidating the just-stored entry.
  let preComposeHighWater = 0;
  try {
    const cached = lookupCachedPrompt<ComposedPrompt>(db, cacheKey);
    if (cached.hit) {
      recordPromptCacheHit(db, cacheKey, cached.age_ms);
      return {
        text: cached.value.text,
        sections: cached.value.sections.map((s) => ({ ...s })),
        truncated: [...cached.value.truncated],
      };
    }
    recordPromptCacheMiss(db, cacheKey, cached.reason);
    preComposeHighWater = currentHighWaterRowid(db);
  } catch { /* fail-soft: cache must never block composition */ }

  // Build candidate sections in priority order. Each entry is {name, p, body}.
  type Candidate = { name: string; p: number; body: string; floor?: boolean };
  const candidates: Candidate[] = [];
  const policySections = await subStage("read_policy_bundle_sections", task.id, () => readPolicyBundleSections(db, "brain_prompt", REQUIRED_POLICY_SECTION_NAMES));
  const policyByName = new Map(policySections.map((policy) => [policy.sectionName, policy]));
  // Q3 owner-profile snapshot for variant ranking. Read once per
  // composePrompt — variant queries below reuse this. Failure returns
  // null (do NOT abort composition).
  const ownerProfileForVariants = readOwnerProfileForVariantSelection(db);
  const goalTextForVariants = directiveText ?? task.goal;

  type PosteriorPolicyBundle = {
    artifactId: string;
    eventId: string | null;
    body: string;
    priority?: number;
    floor?: boolean;
    posteriorScore: number;
    confidence: number;
    goalShape?: string;
    taskClass?: string;
    evidence_event_ids?: string[];
  };

  const betaPosteriorScore = (alpha: unknown, beta: unknown, fallback: unknown): number => {
    const a = typeof alpha === "number" && Number.isFinite(alpha) ? alpha : 0;
    const b = typeof beta === "number" && Number.isFinite(beta) ? beta : 0;
    if (a + b > 0) return a / (a + b);
    return typeof fallback === "number" && Number.isFinite(fallback) ? fallback : 0;
  };

  const selectPolicyBundleByPosterior = async (
    db: Database,
    goal_shape: string,
    task_class: string,
  ): Promise<PosteriorPolicyBundle | null> => {
    const rows = await poolQuery<Record<string, unknown>>(
      db,
      `SELECT id, body, posterior_alpha, posterior_beta, score, confidence, name,
              intent, summary, target_files, target_resources, source_candidate_id
         FROM act_artifact
        WHERE kind = 'prompt_policy_bundle'
          AND status IN ('admitted', 'promoted')
        ORDER BY score DESC, confidence DESC, updated_at DESC
        LIMIT 200`,
    );

    const matches: PosteriorPolicyBundle[] = [];
    for (const row of rows) {
      const rawBody = typeof row.body === "string" ? row.body : "";
      let parsed: Record<string, unknown> | null = null;
      try {
        const candidate = JSON.parse(rawBody) as unknown;
        if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) parsed = candidate as Record<string, unknown>;
      } catch { /* body can be plain policy prose */ }
      const bundle = parsed && parsed.policy_bundle && typeof parsed.policy_bundle === "object"
        ? parsed.policy_bundle as Record<string, unknown>
        : parsed;
      const body = typeof bundle?.body === "string" && bundle.body.length > 0 ? bundle.body : rawBody;
      if (body.length === 0) continue;
      const metadataText = JSON.stringify({
        id: row.id,
        name: row.name,
        intent: row.intent,
        summary: row.summary,
        target_files: row.target_files,
        target_resources: row.target_resources,
        source_candidate_id: row.source_candidate_id,
        body: rawBody,
        parsed,
      }).toLowerCase();
      const goalShapeMatch = goal_shape.length === 0
        || metadataText.includes(goal_shape.toLowerCase())
        || metadataText.includes("all_goal_shapes")
        || metadataText.includes("goal_shape:any");
      const taskClassMatch = task_class.length === 0
        || metadataText.includes(task_class.toLowerCase())
        || metadataText.includes(("brain_prompt/" + task_class).toLowerCase())
        || metadataText.includes("task_class:any");
      if (!goalShapeMatch || !taskClassMatch) continue;
      const evidenceIds = Array.isArray(bundle?.evidence_event_ids)
        ? bundle.evidence_event_ids.map(String)
        : (typeof row.source_candidate_id === "string" && row.source_candidate_id.length > 0 ? [row.source_candidate_id] : []);
      matches.push({
        artifactId: String(row.id),
        eventId: evidenceIds[0] ?? null,
        body,
        priority: typeof bundle?.priority === "number" ? bundle.priority : undefined,
        floor: bundle?.floor === true,
        posteriorScore: betaPosteriorScore(row.posterior_alpha, row.posterior_beta, row.score),
        confidence: typeof row.confidence === "number" && Number.isFinite(row.confidence) ? row.confidence : 0,
        goalShape: goal_shape,
        taskClass: task_class,
        evidence_event_ids: evidenceIds,
      });
    }

    matches.sort((a, b) => {
      const byPosterior = b.posteriorScore - a.posteriorScore;
      if (byPosterior !== 0) return byPosterior;
      return b.confidence - a.confidence;
    });
    return matches[0] ?? null;
  };

  // T3.7 (pedagogical RL composer policy): prompt_policy_bundle rows are
  // act_artifacts, so section bodies should be selected by their Beta
  // posterior for this directive's goal_shape + section task_class. If no
  // scored registry bundle matches, fall back to the Q2/Q3 heuristic path.
  const composerGoalShape = goalShape(directiveText ?? task.goal);

  const pushPolicySection = async (name: PolicyBundleSectionName, fallbackPriority: number, floor = false) => {
    const policy = policyByName.get(name);
    const bundleScore = policy ? 1 : 0; // fallback heuristic: promoted policy_bundle rows are admitted = 1, missing = 0.
    const retrievedBundle = pickHighestScorePolicyBundle(opts.retrievedPolicyArtifacts?.[name], name);
    const retrievedScore = retrievedBundle && typeof retrievedBundle.score === "number" && Number.isFinite(retrievedBundle.score)
      ? retrievedBundle.score
      : 0;
    const posteriorBundle = await subStage(`policy_section.${name}.posterior_bundle`, task.id, () => selectPolicyBundleByPosterior(db, "", name));
    const posteriorScore = posteriorBundle?.posteriorScore ?? 0;
    const variant = await subStage(`policy_section.${name}.variant`, task.id, () => selectPromptSectionVariant(db, {
      sectionName: name,
      goalText: goalTextForVariants,
      ownerProfile: ownerProfileForVariants,
      fallbackBody: posteriorBundle?.body ?? policy?.body ?? "",
      policyBundleArtifactId: posteriorBundle?.artifactId ?? null,
    }));

    let chosenBody: string;
    let chosenPriority: number;
    let chosenFloor: boolean;
    let source: "variant" | "posterior_policy_bundle" | "retrieved_artifact" | "policy_bundle" | "literal_missing_warning";
    let chosenArtifactId: string | null = null;
    let chosenEventId: string | null = null;
    let chosenScore: number | null = null;
    let fallbackReason: string | null = null;
    let variantWon = false;
    let policyTiePreserved = false;
    const variantScore = variant ? variant.score * variant.goalShapeMatch * variant.ownerProfileAlignment : 0;
    const competitorScore = Math.max(posteriorScore, retrievedScore, bundleScore);
    if (variant && variantScore > competitorScore) {
      chosenBody = variant.body;
      chosenPriority = variant.priority ?? posteriorBundle?.priority ?? policy?.priority ?? fallbackPriority;
      chosenFloor = floor || posteriorBundle?.floor === true || policy?.floor === true;
      source = "variant";
      chosenArtifactId = variant.variantId;
      chosenScore = variant.score;
      variantWon = true;
    } else if (posteriorBundle) {
      if (variant && variantScore === competitorScore) policyTiePreserved = true;
      chosenBody = posteriorBundle.body;
      chosenPriority = posteriorBundle.priority ?? policy?.priority ?? fallbackPriority;
      chosenFloor = floor || posteriorBundle.floor === true || policy?.floor === true;
      source = "posterior_policy_bundle";
      chosenArtifactId = posteriorBundle.artifactId;
      chosenEventId = posteriorBundle.eventId;
      chosenScore = posteriorScore;
    } else if (retrievedBundle && retrievedScore >= bundleScore && retrievedBundle.body) {
      // Fallback to the existing heuristic when no scored registry bundle
      // matches this goal_shape/task_class.
      if (variant && variantScore === competitorScore) policyTiePreserved = true;
      chosenBody = retrievedBundle.body;
      chosenPriority = retrievedBundle.priority ?? policy?.priority ?? fallbackPriority;
      chosenFloor = floor || retrievedBundle.floor === true || policy?.floor === true;
      source = "retrieved_artifact";
      chosenArtifactId = retrievedBundle.artifactId;
      chosenEventId = retrievedBundle.evidence_event_ids?.[0] ?? null;
      chosenScore = retrievedScore;
      fallbackReason = "no_scored_prompt_policy_bundle_match";
    } else if (policy) {
      if (variant && variantScore === bundleScore) policyTiePreserved = true;
      chosenBody = policy.body;
      chosenPriority = policy.priority ?? fallbackPriority;
      chosenFloor = floor || policy.floor === true;
      source = "policy_bundle";
      chosenScore = bundleScore;
      fallbackReason = "no_scored_prompt_policy_bundle_match";
    } else {
      chosenBody = LITERAL_POLICY_MISSING_WARNING(name);
      chosenPriority = fallbackPriority;
      chosenFloor = floor;
      source = "literal_missing_warning";
      fallbackReason = "no_policy_bundle_no_retrieved_artifact_no_variant";
    }

    candidates.push({ name, p: chosenPriority, floor: chosenFloor, body: chosenBody });

    // Audit emission: one prompt_policy_section_selected per pushPolicy
    // call so T4.2 meta-credit can associate action outcomes with the
    // prompt_policy_bundle act_artifact selected for this section.
    try {
      emitEvent(db, {
        kind: "prompt_policy_section_selected",
        substrate_origin: "substrate_auto",
        directive_id: task.directive_id,
        task_id: task.id,
        context_refs: chosenEventId ? [chosenEventId] : (chosenArtifactId ? [chosenArtifactId] : []),
        payload: {
          section_name: name,
          source,
          artifact_id: chosenArtifactId,
          event_id: chosenEventId,
          score: chosenScore,
          goal_shape: composerGoalShape,
          task_class: name,
          fallback_reason: fallbackReason,
          variant_score_observed: variant ? variantScore : null,
          competitor_score_observed: competitorScore,
        } as JsonValue,
      });
    } catch { /* fail-soft: composer must not fail on side-effect emit */ }

    if (variantWon && variant) {
      try {
        const variantEvent = emitEvent(db, {
          kind: "prompt_section_variant_selected",
          substrate_origin: "substrate_auto",
          directive_id: task.directive_id,
          task_id: task.id,
          payload: {
            section_name: name,
            variant_id: variant.variantId,
            score: variant.score,
            goal_shape_match: variant.goalShapeMatch,
            owner_profile_alignment: variant.ownerProfileAlignment,
            policy_bundle_tie_preserved: false,
            evidence_event_ids: variant.evidence_event_ids,
          } as JsonValue,
        });
        // Q3 step 5: retrieval_binding so artifact credit flows back to
        // the variant when the action eventually scores. Cite both the
        // variant artifact id (target of credit) and the section
        // selection event id (provenance of the binding).
        emitEvent(db, {
          kind: "retrieval_binding",
          substrate_origin: "substrate_auto",
          directive_id: task.directive_id,
          task_id: task.id,
          context_refs: [variantEvent.id, variant.variantId],
          payload: {
            query: goalTextForVariants,
            source_event_id: variant.variantId,
            rendered_snippet: variant.body.slice(0, 200),
            rank: 0,
            rerank_score: variantScore,
            posterior: variant.score,
            binding_surface: "prompt_section_variant",
            section_name: name,
          } as JsonValue,
        });
      } catch { /* fail-soft */ }
    } else if (variant && variantScore === competitorScore && (policy || retrievedBundle || posteriorBundle)) {
      // Variant tied but did not win — emit the tie-preservation audit
      // so the operator can see that cold-start stability fired (k_252
      // closure: scored variant existed, was tied, policy_bundle won).
      try {
        emitEvent(db, {
          kind: "prompt_section_variant_selected",
          substrate_origin: "substrate_auto",
          directive_id: task.directive_id,
          task_id: task.id,
          payload: {
            section_name: name,
            variant_id: variant.variantId,
            score: variant.score,
            goal_shape_match: variant.goalShapeMatch,
            owner_profile_alignment: variant.ownerProfileAlignment,
            policy_bundle_tie_preserved: true,
            winning_source: source,
          } as JsonValue,
        });
        // Compiler hint: keep the var read so TS/linter does not warn
        // about unused state.
        void policyTiePreserved;
      } catch { /* fail-soft */ }
    }
  };

  // Q2 step 4: alias used at the emission_grammars + self_introspection
  // call sites so the brain-design vocabulary stays explicit. The helper
  // is functionally identical to pushPolicySection — every call site
  // already consults opts.retrievedPolicyArtifacts via pushPolicySection
  // — but the dedicated name makes the on-demand-retrieval intent
  // legible at the call site (the brain amendment named these two slots
  // specifically).
  const pushRetrievedPolicyArtifactSection = async (
    name: PolicyBundleSectionName,
    fallbackPriority: number,
    floor = false,
  ): Promise<void> => {
    await pushPolicySection(name, fallbackPriority, floor);
  };

  // EXIT INVARIANT first — load-bearing structural rule against brain_silent_exit
  // (commit 59b2872 + this fix). p=0 so it never drops; first in order so the
  // brain reads "you MUST call substrate.* before exit" before anything else.
  await pushPolicySection("exit_invariant", 0, true);
  candidates.push({ name: "task_goal", p: 0, floor: true, body: buildTaskGoalSection(task, directiveText) });
  // Existing decomposition awareness — load-bearing reuse-first signal
  // against the re-decomposition explosion (audit 2026-05-17: hot-reload
  // directive accumulated 62 task_node_opened events because the brain
  // re-decomposed Q1-Q6 nine times). p=0 so it never drops; placed right
  // after task_goal so the brain reads it before workflow/emission grammar.
  const existingDecomp = await subStage("read_existing_decomposition", task.id, () => readExistingDecomposition(db, task.directive_id, task.id));
  const existingDecompBody = buildExistingDecompositionSection(existingDecomp);
  if (existingDecompBody.length > 0) {
    candidates.push({ name: "existing_decomposition", p: 0, floor: true, body: existingDecompBody });
  }
  // Proven decomposition strategy — Tier-S1 retrieval-binding leg. Surfaces
  // the outcome-scored decomposition_strategy_predicate row matching this
  // goal's shape_category so the brain retrieves a PROVEN structural prior
  // for similar future goals. Purely additive: non-floor (drops first under
  // budget pressure), advisory-only, changes nothing about dispatch/closure.
  // P1 so it lands in normal flow but never displaces a load-bearing section.
  const provenDecomp = await subStage("read_proven_decomposition_strategy", task.id, () => readProvenDecompositionStrategy(db, directiveText ?? task.goal));
  const provenDecompBody = buildProvenDecompositionStrategySection(provenDecomp);
  if (provenDecompBody.length > 0) {
    candidates.push({ name: "proven_decomposition_strategy", p: 1, body: provenDecompBody });
  }
  // Proven trajectory motif — Tier-S3 retrieval-binding leg. Surfaces the
  // outcome-scored trajectory_motif_predicate row whose recurring event-kind
  // sub-sequence is anchored to this directive's OWN trajectory-so-far, so the
  // brain retrieves a PROVEN recipe shape for the path it is already on.
  // Purely additive: non-floor (drops first under budget pressure),
  // advisory-only, read-only, changes nothing about dispatch/closure. P1 so it
  // lands in normal flow but never displaces a load-bearing section.
  const provenMotif = await subStage("read_proven_trajectory_motif", task.id, () => readProvenTrajectoryMotif(db, task.directive_id));
  const provenMotifBody = buildProvenTrajectoryMotifSection(provenMotif);
  if (provenMotifBody.length > 0) {
    candidates.push({ name: "proven_trajectory_motif", p: 1, body: provenMotifBody });
  }
  await pushPolicySection("runtimes_available", 0, true);
  await pushPolicySection("workflow", 0, true);
  await pushPolicySection("do_not", 0, true);
  // Detailed emission grammars — env_requires + rich knowledge schema +
  // artifact provenance. P1 so it drops first under tight-budget pressure
  // (depth-1 tests pin a tiny ~500-token budget) but lands in normal flow.
  // Q2 (brain amendment MDBZV4YVRH7D172BW40W1J5ASM): routed through
  // pushRetrievedPolicyArtifactSection so the dispatcher's on-demand
  // act_artifact retrieval feeds the body selection.
  await pushRetrievedPolicyArtifactSection("emission_grammars", 1);
  // Phase 1 brain-harness rewrite (2026-05-17): teach the brain about
  // runtime.{system_map, brain_self_audit, trajectory_replay,
  // prompt_self_inspect}. P1 so it ships in normal flow but drops first
  // along with emission_grammars under tight-budget pressure — the
  // EXIT INVARIANT + WORKFLOW + DO NOT still win the tightest budgets.
  await pushRetrievedPolicyArtifactSection("self_introspection", 1);

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
  let knowledgeBody: string;
  if (opts.retrievalUnavailable) {
    knowledgeBody = `RETRIEVED KNOWLEDGE: (unavailable: ${opts.retrievalUnavailable.reason})`;
  } else if (opts.retrievedKnowledge && opts.retrievedKnowledge.hits.length > 0) {
    knowledgeBody = buildRetrievedKnowledgeSection(
      opts.retrievedKnowledge.hits,
      await subStage("read_knowledge_topk.shape_match", task.id, () => readKnowledgeTopK(db, 4, directiveText ?? task.goal, true)),
    );
  } else {
    knowledgeBody = buildKnowledgeSection(await subStage("read_knowledge_topk.recency", task.id, () => readKnowledgeTopK(db, 8, directiveText ?? task.goal)));
  }
  candidates.push({ name: "retrieved_knowledge", p: 1, floor: true, body: knowledgeBody });

  // F6 completion (decision 12) — citation choice wrap. The composer
  // just SELECTED a set of event ids to surface as cited knowledge; that
  // choice itself is a scored decision (retrieval_binding rows credit
  // outcomes per-citation, but the SELECTOR's reliability was invisible
  // until this hook). One act per non-empty selection; idempotent via
  // the sorted-id projection key so retrying the same selection collapses.
  if (opts.retrievedKnowledge && opts.retrievedKnowledge.hits.length > 0) {
    try {
      const { recordCitationChoiceAct } = require("./citation_choice") as typeof import("./citation_choice");
      recordCitationChoiceAct(db, {
        candidateEventIds: opts.retrievedKnowledge.hits.map((h) => h.event_id),
        directiveId: task.directive_id,
        taskId: task.id,
        selectionPoint: "retrieved_knowledge",
        candidatePoolSize: opts.retrievedKnowledge.hits.length,
      });
    } catch { /* fail-soft: composer must not fail on side-effect emit */ }
  }

  // T4.1 counterfactual credit — knowledge top-K boundary. The composer
  // just selected which knowledge_promoted rows enter the prompt; rows
  // at K+1..K+rejectedK lost the cut. Persist them so the credit worker
  // can score them against the chosen path's residual after the window.
  // Wrapped in try/catch — emission failure must never block compose.
  try {
    const chosenIds: string[] = opts.retrievedKnowledge && opts.retrievedKnowledge.hits.length > 0
      ? opts.retrievedKnowledge.hits.map((h) => h.event_id)
      : (await readKnowledgeTopK(db, 8, directiveText ?? task.goal)).map((r) => r.id);
    if (chosenIds.length > 0) {
      const rejected = await readKnowledgeRejected(db, chosenIds.length, 6, directiveText ?? task.goal);
      if (rejected.length > 0) {
        emitEvent(db, {
          kind: "counterfactual_alternative_recorded",
          substrate_origin: "substrate_auto",
          directive_id: task.directive_id,
          task_id: task.id,
          context_refs: chosenIds.slice(0, 4),
          payload: {
            selection_kind: "retrieval_topk_filter",
            selection_subkind: "knowledge_topk",
            chosen_id: chosenIds[0],
            chosen_ids: chosenIds,
            rejected_candidates: rejected.map((r) => ({
              id: r.id,
              score: r.score,
              reason: "knowledge_topk_offset_loss",
            })),
            window_seconds: 600,
          } as JsonValue,
        });
      }
    }
  } catch { /* fail-soft */ }

  const chosenArtifactsTopK = await subStage("read_artifact_registry_topk", task.id, () => readArtifactRegistryTopK(db, 6));
  const artifactBody = opts.retrievedArtifacts && opts.retrievedArtifacts.hits.length > 0
    ? buildRetrievedArtifactSection(opts.retrievedArtifacts.hits)
    : buildArtifactSection(chosenArtifactsTopK);
  candidates.push({ name: "act_artifact_registry", p: 1, body: artifactBody });

  // T4.1 counterfactual credit — artifact registry top-K boundary. The
  // composer just selected the top K=6 act_artifact rows by score; the
  // next 6 rows lost the cut. Persist them as counterfactual alternatives
  // so the worker can credit them against the chosen path's residual.
  try {
    const chosenArtifactIds = opts.retrievedArtifacts && opts.retrievedArtifacts.hits.length > 0
      ? opts.retrievedArtifacts.hits.map((h) => h.event_id)
      : chosenArtifactsTopK.map((r) => r.id);
    if (chosenArtifactIds.length > 0) {
      const rejected = await readArtifactRegistryRejected(db, chosenArtifactIds.length, 6);
      if (rejected.length > 0) {
        emitEvent(db, {
          kind: "counterfactual_alternative_recorded",
          substrate_origin: "substrate_auto",
          directive_id: task.directive_id,
          task_id: task.id,
          context_refs: chosenArtifactIds.slice(0, 4),
          payload: {
            selection_kind: "artifact_selection",
            selection_subkind: "artifact_registry_topk",
            chosen_id: chosenArtifactIds[0],
            chosen_ids: chosenArtifactIds,
            rejected_candidates: rejected.map((r) => ({
              id: r.id,
              score: r.score,
              artifact_kind: r.kind,
              reason: "artifact_registry_topk_offset_loss",
            })),
            window_seconds: 600,
          } as JsonValue,
        });
      }
    }
  } catch { /* fail-soft */ }

  // P2/P3 sections. Upstream-task outputs land via the watch_edges walk just
  // below (Phase E `watch_edges.ts`); stakeholder + cross-directive interference
  // are populated by their respective compositors at the bottom. The
  // `upstream_outputs` placeholder header below remains a stand-in until
  // the upstream-task projection lands (no producer wires non-watch outputs
  // into this slot yet).
  candidates.push({ name: "upstream_outputs", p: 2, body: "UPSTREAM OUTPUTS: (none)" });
  // Watch edges (Architecture.md) — projected through declared consistency
  // mode. Empty when no watch edges target this task.
  const watched = await subStage("snapshot_watched_outputs[sync]", task.id, () => snapshotWatchedOutputs(db, opts.taskId));
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
  const ownerContextRows = await subStage("read_owner_context", task.id, () => readOwnerContext(db, 8));
  const ownerProfileBody = buildOwnerProfileSection(await subStage("read_owner_profile[sync]", task.id, () => readOwnerProfile(db)), {
    recentOwnerContext: ownerContextRows,
    directive: {
      text: directiveText,
      goal: task.goal,
      lifecycle: task.lifecycle,
      urgency: task.urgency,
    },
  });
  candidates.push({ name: "owner_profile", p: 1, floor: true, body: ownerProfileBody });
  // Brain contract Q471RAN88X0H513V8BC3BTW0AW (2026-05-17): the rendering
  // invariant + feedback summary teach every brain cycle that produces
  // owner-visible language to hide IDs/jargon and use the owner's words.
  // We pull policy + 14-day feedback aggregates from one view and split
  // them into two sections so the brain can tune one without re-reading
  // the other.
  const renderingPolicyRow = await subStage("owner_rendering_policy[sync]", task.id, () => ownerRenderingPolicy(db));
  candidates.push({ name: "owner_rendering_policy", p: 1, floor: true, body: buildOwnerRenderingPolicySection(renderingPolicyRow) });
  candidates.push({ name: "owner_feedback_summary", p: 1, body: buildOwnerFeedbackSummarySection(renderingPolicyRow) });
  // Brain contract CY7E62DSNX1DZ1BTD56845D994 Phase H2 (2026-05-18):
  // owner world-model evidence layer exposed to the brain. The belief
  // section answers "what does the substrate currently think about
  // the owner?", the policy section answers "which actions fit?", and
  // the calibration section answers "how wrong has the substrate been?".
  // Together they make action selection belief-conditioned, not just
  // task-conditioned.
  const beliefRow = await subStage("owner_state_belief[sync]", task.id, () => ownerStateBelief(db));
  candidates.push({ name: "owner_state_belief", p: 1, body: buildOwnerStateBeliefSection(beliefRow) });
  candidates.push({ name: "alignment_action_policy", p: 1, body: buildAlignmentActionPolicySection(beliefRow) });
  candidates.push({ name: "owner_state_feedback_summary", p: 1, body: buildOwnerStateFeedbackSummarySection(beliefRow) });
  // Phase I3+ consumer (brain dispatch 3NWCD7PW315W): surface the
  // substrate's auto-compiled Top Laws so the brain sees its own
  // principles at compose time. Closes the 88ESCTN8XN6J flywheel for
  // top_laws_view — without this section the view exists but nothing
  // reads it during dispatch. Limit 10 keeps the section compact
  // (default token budget); operator can widen via owner_profile.
  const liveTopLaws = await subStage("top_laws[sync]", task.id, () => topLaws(db, { min_score: 0.75, limit: 10 }));
  candidates.push({ name: "top_laws", p: 1, floor: true, body: buildTopLawsSection(liveTopLaws) });
  const ownerContextBody = buildOwnerContextSection(ownerContextRows);
  candidates.push({ name: "owner_context", p: 1, body: ownerContextBody });
  const stakeholderBody = await subStage("render_stakeholder_block[sync]", task.id, () => renderStakeholderBlock(db, task.directive_id));
  candidates.push({
    name: "stakeholder_state",
    p: 3,
    body: stakeholderBody.length > 0 ? stakeholderBody : "STAKEHOLDER STATE: (none)",
  });
  const interferenceBody = await subStage("render_interference_block[sync]", task.id, () => renderInterferenceBlock(db, task.directive_id));
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
    await subStage("read_pending_proposals", task.id, () => readPendingProposals(db, 6, task.directive_id)),
  );
  candidates.push({ name: "pending_proposals", p: 3, body: proposalsBody });
  // F11 (2026-05-18, contract 2AMJKN0GTX32790173EPYH6YT4): OUTSTANDING
  // CONTRACT AMENDMENTS section sourced from
  // pending_contract_amendments_view. The brain can cite the proposal
  // id when it proposes a supersession, supplies a missing predicate /
  // target_files, declines a stale proposal, or routes work into a
  // task_node_opened that closes the proposal via
  // applied_change_committed. P3 so it ships with PENDING PROPOSALS /
  // OTHER ACTIVE GOALS under normal budgets and drops cleanly under
  // depth-1 tight-budget tests.
  const outstandingAmendmentsBody = buildOutstandingContractAmendmentsSection(
    await subStage("read_outstanding_contract_amendments[pooled]", task.id, () => readOutstandingContractAmendments(db, task.directive_id)),
  );
  candidates.push({ name: "outstanding_contract_amendments", p: 3, body: outstandingAmendmentsBody });
  // Multi-goal cross-pollination: surface OTHER active directives so the
  // brain knows what concurrent work is in flight and can defer / cite
  // / coordinate. Pre-fix the brain saw only its own directive in the
  // prompt — couldn't tell if a peer goal was already covering this work.
  const otherGoalsBody = buildOtherGoalsSection(
    await subStage("read_other_active_goals", task.id, () => readOtherActiveGoals(db, task.directive_id, 5)),
  );
  candidates.push({ name: "other_active_goals", p: 3, body: otherGoalsBody });

  candidates.push({ name: "active_failures", p: 4, body: buildFailuresSection(await readRecentFailures(db, 3)) });
  candidates.push({ name: "constitutional_gates", p: 4, body: buildGatesSection(await readConstitutionalGates(db)) });

  // Brain self-audit reflexive section (Phase 3 brain harness rewrite,
  // 2026-05-17). The brain sees its own live report card every cycle —
  // citation rate, proposal accept rate, residual distribution,
  // effectiveness classification. P2 so it persists through normal
  // budgets but drops under the tightest test-pin budget (where the
  // P0 policy + task_goal must win). Fail-soft: a builder exception
  // (no events table yet, fresh substrate) emits a stub line.
  try {
    const audit = await subStage("build_brain_self_audit[sync]", task.id, () => buildBrainSelfAudit(db, { windowHours: 168 }));
    candidates.push({
      name: "brain_self_audit",
      p: 2,
      body: renderBrainSelfAuditSection(audit),
    });
  } catch (err) {
    candidates.push({
      name: "brain_self_audit",
      p: 2,
      body: `BRAIN SELF-AUDIT: (unavailable: ${(err as Error).message})`,
    });
  }

  // Fill in priority order. Track running tokens; drop bottom-up when over.
  const kept: Candidate[] = [];
  const truncated: string[] = [];
  const floorOverBudget: string[] = [];
  let totalTokens = 0;

  // Sort by p ascending so P0 fills first.
  const sorted = [...candidates].sort((a, b) => a.p - b.p);
  for (const c of sorted) {
    const sectionTokens = estimateTokens(c.body) + 2; // +2 for separator overhead
    if (totalTokens + sectionTokens > budget) {
      if (c.floor) {
        kept.push(c);
        totalTokens += sectionTokens;
        floorOverBudget.push(c.name);
        continue;
      }
      truncated.push(c.name);
      continue;
    }
    kept.push(c);
    totalTokens += sectionTokens;
  }

  // Restore canonical order in output (P0 → P4). The sort already did this.
  const text = kept.map((c) => c.body).join("\n\n");

  // Depth-1 retrieval budget enforcement (Architecture.md, prompt budget).
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

  const keptFloor = new Set(kept.filter((c) => c.floor).map((c) => c.name));
  const missingFloor = candidates.filter((c) => c.floor && !keptFloor.has(c.name)).map((c) => c.name);
  if (missingFloor.length > 0 || floorOverBudget.length > 0) {
    emitEvent(db, {
      kind: "dispatcher_violation",
      substrate_origin: "substrate_auto",
      directive_id: task.directive_id,
      task_id: task.id,
      failure_kind: "floor_section_missing",
      payload: {
        kind: "floor_section_missing",
        missing_floor_sections: missingFloor,
        floor_sections_over_budget: floorOverBudget,
        budget_tokens: budget,
        total_tokens: totalTokens,
        refused_compose: missingFloor.length > 0,
      } as JsonValue,
    });
  }

  const composed: ComposedPrompt = {
    text,
    sections: kept.map((c) => ({ name: c.name, priorityP: c.p, tokens: estimateTokens(c.body), floor: c.floor === true })),
    truncated,
  };
  // Store under the cache key stamped with the pre-composition high-water
  // mark (see the lookup above). Fail-soft: a store failure must never
  // surface to the caller.
  try {
    storeCachedPrompt(db, cacheKey, composed, { highWaterRowid: preComposeHighWater });
  } catch { /* fail-soft */ }
  return composed;
};

// Hot-reload deep-improvement (2026-05-17): register the composer with
// the reloadable registry so a hot-reload of runtime/prompt_composer.ts
// actually swaps the function the daemon calls — not just re-imports a
// detached copy. Consumers that need hot-reload semantics call
// `getReloadable("prompt_composer").current()` and get the freshest
// composePrompt + estimateTokens; consumers that imported statically
// keep the boot-time copy (acceptable for stable surfaces).
import { registerReloadable } from "./reloadable";
registerReloadable<{
  composePrompt: typeof composePrompt;
  estimateTokens: typeof estimateTokens;
}>({
  name: "prompt_composer",
  load: async (cacheBustUrl) => {
    if (cacheBustUrl) return (await import(cacheBustUrl)) as { composePrompt: typeof composePrompt; estimateTokens: typeof estimateTokens };
    return { composePrompt, estimateTokens };
  },
  validate: (mod) => {
    if (typeof mod.composePrompt !== "function") return "missing composePrompt export";
    if (typeof mod.estimateTokens !== "function") return "missing estimateTokens export";
    return true;
  },
  smokeProbe: (mod) => {
    // Tiny pure call: estimateTokens on a known string. Cheap, no DB
    // dependency. Confirms the new module's basic call path works
    // before the swap commits.
    try {
      const n = mod.estimateTokens("hello world");
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
        return { ok: false, error: `estimateTokens returned non-number: ${n}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
});
