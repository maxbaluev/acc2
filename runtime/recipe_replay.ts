// acc2 recipe replay — Tier-0 cost compression (Architecture.md).
//
// A recipe is a cached successful task-graph trajectory: a goal_shape +
// topology_signature with a sequence of action_predicted + verifier artifact
// invocations that closed cleanly. When a new task matches an existing recipe,
// the dispatcher routes through this module to replay the cached sequence
// WITHOUT calling the brain. The verifier residual is the final ground truth —
// any mid-replay verifier above threshold aborts and the dispatcher falls
// through to a normal opencode_brain refinement.
//
// Confidence model (§15 + §17 cutover criterion 6):
//   - Initial confidence = 0.5 (set by extractRecipeCandidates).
//   - Successful replay → +0.05 (capped at 0.95).
//   - Failed replay     → −0.10 (floored at 0.0; auto-archive at < 0.2).
//
// Why this is a DIFFERENT formula than the Beta posterior used for
// act_artifact + knowledge_candidate (see artifact_store.ts / extractors.ts):
// recipes do not carry a residual-driven posterior — they have a single
// "did the cached trajectory replay successfully" bit. The Beta model
// (alpha/beta + EMA half-life 20) is designed for noisy residual signals
// where each observation contributes proportionally to the success or
// failure mass. Recipe confidence is qualitative-coarse: it is a sticky
// score that compounds slowly on success (+0.05) and falls fast on
// failure (−0.10) so a recipe that worked once but stops working gets
// retired before it pollutes the Tier-0 lane. This divergence is
// intentional; Phase Align Principle 9 pins both the band constants and
// this comment so a future refactor cannot silently unify them.
//
// Goal-shape match is computed via runtime/goal_shape.ts. Topology match is the
// signature emitted on the recipe payload by extractRecipeCandidates. When
// crisis mode is active (§3.5) the dispatcher lowers the confidence threshold
// from 0.7 → 0.4 (§I crisis_mode.ts already exposes that constant).

import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { emitEvent } from "./events";
import { goalShape } from "./goal_shape";
import { getArtifact } from "./artifact_store";
import { applyScoredOutcome } from "./posterior";
import { runArtifactForRuntime } from "./runtimes/index";
import type { TaskNode } from "./task_topology";
import { distributeCredit } from "./credit";
import { nowIso } from "./ids";
import { invokeVerifierWithMeta } from "./verifier_invocation";
import { recipesLatestView, type RecipesLatestRow } from "../substrate/views";

// Tier-0 replay must be STRICTLY conservative — a false-positive match
// against a new directive replays the wrong recipe, residual=0 fires from
// the recipe's own verifier, and the directive is "committed" without the
// brain ever seeing the prompt. This session exposed the bug: a recipe
// extracted from the convergence DAG matched the foundational STOP-FUNCTION
// directive via loose-topology escape (endsWith "::1") + 0.6 token overlap
// and falsely committed it. Conservative thresholds prevent this class.
export const RECIPE_DEFAULT_MIN_CONFIDENCE = 0.85;
export const RECIPE_MAX_CONFIDENCE = 0.95;
export const RECIPE_AUTO_ARCHIVE_FLOOR = 0.2;
export const RECIPE_VERIFIER_ABORT_THRESHOLD = 0.3;
/** Minimum token-overlap fraction for the legacy goal_shape match path.
 *  Pre-fix this was 0.6 — generic strategic words ("design", "extract",
 *  "verifier") matched too easily. 1.0 requires EVERY recipe token to appear
 *  in the task goal: a recipe `scrape_inventory::n1` matches `scrape inventory
 *  of warehouse` (both tokens present) but a 7-token convergence recipe will
 *  not match an unrelated foundational directive. The accompanying minimum
 *  `RECIPE_MIN_TOKEN_COUNT` (≥ 2) prevents single-generic-token recipes from
 *  matching anything by accident. */
export const RECIPE_TOKEN_OVERLAP_FLOOR = 1.0;
export const RECIPE_MIN_TOKEN_COUNT = 2;

export type RecipeTrajectoryStep = {
  step_kind: "action_predicted" | "task_node_opened" | string;
  artifact_id?: string | null;
  verifier_artifact_id?: string | null;
  runtime?: "bun" | "uv" | "camofox-browser" | string;
  input_refs?: string[];
  output_ref?: string | null;
  resource_refs?: string[];
  verifier_class?: string | null;
  payload_template: JsonValue;
  predicted_residual?: number | null;
};

export type RecipeRuntimeSignature = {
  runtimes: string[];
  step_runtimes: string[];
  selected_runtime?: string | null;
  runtime_fit_score?: number;
};

export type RecipeMatch = {
  /** The knowledge_candidate / knowledge_promoted event id carrying recipe_shape. */
  recipe_id: string;
  /** Alias of recipe_id naming the new substrate (knowledge event) — held as a
   *  field on the match for callers that prefer the explicit name. */
  recipe_knowledge_event_id: string;
  /** Knowledge-shape name preferred by the new substrate vocabulary. */
  knowledge_id: string;
  goal_shape: string;
  topology_signature: string;
  confidence: number;
  trajectory: RecipeTrajectoryStep[];
  runtime_signature: RecipeRuntimeSignature;
  /** Cited act_artifact handles harvested from the trajectory steps; surfaces
   *  for credit attribution and substrate retrieval. */
  cited_act_artifact_ids: string[];
};

/** SQL for the per-directive task-node scan that feeds taskTopologySignature.
 *  Shared verbatim by the sync path (db.query) and the off-loop pooled path
 *  (poolQuery) so the signature is byte-identical regardless of which thread
 *  executes the SELECT. */
const TASK_TOPOLOGY_SCAN_SQL =
  `SELECT task_id, parent_task_id FROM events
       WHERE kind = 'task_node_opened' AND directive_id = ?
       ORDER BY ts ASC`;

/** Off-loop read router injected by the MCP handler (substrate_tools.poolQuery):
 *  routes the SELECT through the SQL worker pool when present, sync db.query
 *  otherwise. Same signature both surfaces use. */
export type RecipePoolQuery = <T>(db: Database, sql: string, params: unknown[]) => Promise<T[]>;

/** Pure folding of the task-node rows into a topology signature. Identical
 *  arithmetic for the sync and pooled paths — only WHERE the SELECT ran
 *  differs. */
const foldTopologySignature = (
  rows: Array<{ task_id: string; parent_task_id: string | null }>,
): string => {
  if (rows.length === 0) return "topo_00000000::0";
  const ordinal = new Map<string, number>();
  rows.forEach((r, idx) => { ordinal.set(r.task_id, idx); });
  const edges: string[] = [];
  for (const r of rows) {
    const child = ordinal.get(r.task_id) ?? -1;
    const parent = r.parent_task_id !== null ? (ordinal.get(r.parent_task_id) ?? -1) : -1;
    edges.push(`${parent}->${child}`);
  }
  edges.sort();
  const canonical = `n${rows.length}::${edges.join(",")}`;
  let h = 5381;
  for (let i = 0; i < canonical.length; i++) {
    h = ((h * 33) ^ canonical.charCodeAt(i)) | 0;
  }
  return `topo_${(h >>> 0).toString(16).padStart(8, "0")}::${rows.length}`;
};

/** Compute a topology signature for a task. Today this is a degenerate "single
 *  root task" shape — when Phase E DAGs land, this walks the actual subtree.
 *  The replay matcher accepts a recipe whose signature matches the current
 *  task's signature OR is degenerate (count=1). */
const taskTopologySignature = (db: Database, task: TaskNode): string => {
  const rows = db
    .query(TASK_TOPOLOGY_SCAN_SQL)
    .all(task.directive_id) as Array<{ task_id: string; parent_task_id: string | null }>;
  return foldTopologySignature(rows);
};

const runtimeSignatureFromRecipePayload = (payload: Record<string, unknown>, trajectory: RecipeTrajectoryStep[]): RecipeRuntimeSignature => {
  const recipeShape = payload.recipe_shape && typeof payload.recipe_shape === "object" && !Array.isArray(payload.recipe_shape) ? payload.recipe_shape as Record<string, unknown> : {};
  const existing = recipeShape.runtime_signature && typeof recipeShape.runtime_signature === "object" && !Array.isArray(recipeShape.runtime_signature) ? recipeShape.runtime_signature as Record<string, unknown> : {};
  const step_runtimes = trajectory.map((s) => typeof s.runtime === "string" ? s.runtime : null).filter((s): s is string => !!s);
  const declared = Array.isArray(existing.runtimes) ? existing.runtimes.filter((s): s is string => typeof s === "string") : [];
  const selected_runtime = typeof existing.selected_runtime === "string" ? existing.selected_runtime : null;
  const runtime_fit_score = typeof existing.runtime_fit_score === "number" ? existing.runtime_fit_score : undefined;
  return { runtimes: Array.from(new Set([...declared, ...step_runtimes, ...(selected_runtime ? [selected_runtime] : [])])), step_runtimes, selected_runtime, ...(runtime_fit_score !== undefined ? { runtime_fit_score } : {}) };
};

/** Filter / shape one recipes_latest_view row into a RecipeMatch when it
 *  passes goal_shape + topology + confidence gating. */
const tryMatchCandidate = (
  candidate: {
    id: string;
    goal_shape: string;
    topology_signature: string;
    confidence: number;
    trajectory: RecipeTrajectoryStep[];
    runtime_signature: RecipeRuntimeSignature;
  },
  taskGoalShape: string,
  taskGoalLower: string,
  taskTopology: string,
  minConfidence: number,
): RecipeMatch | null => {
  // Two match strategies:
  //   1. Exact: recipe.goal_shape == task's goalShape() hash.
  //   2. Token overlap: recipe.goal_shape is the legacy normalized-text
  //      token (e.g. "count_todos_in_repo::n1"). Treat it as a bag of
  //      tokens (length ≥ 3); accept ONLY when ≥ RECIPE_TOKEN_OVERLAP_FLOOR
  //      (1.0) of the recipe's tokens appear in the task goal AND ≥ 2 tokens
  //      match. Pre-fix this was 0.6 — generic strategic vocabulary
  //      ("design", "extract", "verifier") was enough to claim a match,
  //      replaying the wrong recipe against unrelated directives.
  const exactGoalMatch = candidate.goal_shape === taskGoalShape;
  const recipeToken = candidate.goal_shape.split("::")[0] ?? "";
  const recipeTokens = recipeToken.split("_").filter((t) => t.length >= 3);
  let tokenMatchHits = 0;
  if (recipeTokens.length > 0) {
    for (const tk of recipeTokens) {
      if (taskGoalLower.includes(tk)) tokenMatchHits++;
    }
  }
  const tokenMatchScore = recipeTokens.length > 0
    ? tokenMatchHits / recipeTokens.length
    : 0;
  const legacyTokenMatch =
    recipeTokens.length >= RECIPE_MIN_TOKEN_COUNT &&  // ≥2 tokens (specificity)
    tokenMatchScore >= RECIPE_TOKEN_OVERLAP_FLOOR;    // 100% overlap (no false-positive)
  if (!exactGoalMatch && !legacyTokenMatch) return null;

  // Topology match: STRICTLY exact. The pre-fix `endsWith("::1")` escape
  // accepted any recipe extracted from a single-task DAG (which is most
  // of them) against ANY new task — combined with loose goal_shape this
  // matched anything to anything. The `=""` exact-empty path stays for
  // recipes seeded without a topology stamp (substrate/seed.ts).
  const topologyMatch =
    candidate.topology_signature === taskTopology ||
    candidate.topology_signature === "";
  if (!topologyMatch) return null;

  if (candidate.confidence < minConfidence) return null;
  if (candidate.confidence < RECIPE_AUTO_ARCHIVE_FLOOR) return null;

  const cited: string[] = [];
  const stepRuntimes: string[] = [];
  for (const step of candidate.trajectory) {
    if (step.artifact_id) cited.push(step.artifact_id);
    if (step.verifier_artifact_id) cited.push(step.verifier_artifact_id);
    if (step.runtime) stepRuntimes.push(step.runtime);
  }
  const runtimeSignature = candidate.runtime_signature ?? {
    runtimes: Array.from(new Set(stepRuntimes)),
    step_runtimes: stepRuntimes,
    selected_runtime: stepRuntimes[0] ?? null,
    runtime_fit_score: stepRuntimes.length > 0 ? 1 : 0.5,
  };
  return {
    recipe_id: candidate.id,
    recipe_knowledge_event_id: candidate.id,
    knowledge_id: candidate.id,
    goal_shape: candidate.goal_shape,
    topology_signature: candidate.topology_signature,
    confidence: candidate.confidence,
    trajectory: candidate.trajectory,
    runtime_signature: candidate.runtime_signature,
    cited_act_artifact_ids: Array.from(new Set(cited)),
  };
};

/** Find a recipe that matches the supplied task. Returns the highest-
 *  confidence match whose value is ≥ minConfidence, or null when no recipe
 *  matches. Uses goalShape() to compute the task's goal hash.
 *
 *  Queries `recipes_latest_view` — the substrate's materialized index keyed
 *  by (goal_shape, topology_signature) that picks the highest-confidence row
 *  per key. The view now projects from knowledge_candidate / knowledge_promoted
 *  rows carrying recipe_shape.enabled (universality proposal
 *  A12CR1QCDN0SS51CM95K39T45M). View errors intentionally surface to the
 *  dispatcher diagnostics path instead of falling back to a dispatch-time scan
 *  over recipe-shape knowledge history. */
export const findRecipeMatch = (
  db: Database,
  task: TaskNode,
  opts?: { minConfidence?: number },
): RecipeMatch | null => {
  const minConfidence = opts?.minConfidence ?? RECIPE_DEFAULT_MIN_CONFIDENCE;
  const taskGoalShape = goalShape(task.goal ?? "");
  const taskTopology = taskTopologySignature(db, task);
  const taskGoalLower = task.goal.toLowerCase();

  const viewRows: RecipesLatestRow[] = recipesLatestView(db);
  return pickBestRecipeMatch(viewRows, taskGoalShape, taskGoalLower, taskTopology, minConfidence);
};

/** Pure best-match fold over recipes_latest_view rows. Shared verbatim by the
 *  sync `findRecipeMatch` and the off-loop `findRecipeMatchPooled` so the
 *  selected recipe is byte-identical regardless of which thread ran the two
 *  heavy SELECTs (the recipes_latest_view scan + the topology event scan). */
const pickBestRecipeMatch = (
  viewRows: RecipesLatestRow[],
  taskGoalShape: string,
  taskGoalLower: string,
  taskTopology: string,
  minConfidence: number,
): RecipeMatch | null => {
  let best: RecipeMatch | null = null;
  for (const r of viewRows) {
    const p = r.payload as Record<string, unknown>;
    const trajectory = Array.isArray(p.trajectory) ? (p.trajectory as RecipeTrajectoryStep[]) : [];
    const match = tryMatchCandidate(
      {
        id: r.id,
        goal_shape: r.goal_shape,
        topology_signature: r.topology_signature,
        confidence: r.confidence,
        trajectory,
        runtime_signature: runtimeSignatureFromRecipePayload(p, trajectory),
      },
      taskGoalShape,
      taskGoalLower,
      taskTopology,
      minConfidence,
    );
    if (match && (!best || match.confidence > best.confidence)) best = match;
  }
  return best;
};

/** Off-loop variant of findRecipeMatch for the MCP daemon's single event loop.
 *
 *  Runtime profiling (ACC2_PROFILE_LOOP=1) measured substrate.find_recipe at
 *  ~20s during a brain dispatch — the dominant event-loop blocker. The cost is
 *  the two heavy synchronous SELECTs: the recipes_latest_view scan (~876
 *  recipe-shape knowledge rows) and the per-directive task_node_opened scan
 *  that feeds the topology signature. This variant routes BOTH SELECTs through
 *  the injected poolQuery (SQL worker pool when present; sync db.query fallback
 *  when absent — tests, ACC2_DISABLE_SQL_POOL). The matching arithmetic is the
 *  same pure fold (pickBestRecipeMatch + foldTopologySignature), so the result
 *  is byte-identical to findRecipeMatch — only WHERE the SELECTs execute moved
 *  off the dispatch loop. WRITES are never on this path. */
export const findRecipeMatchPooled = async (
  db: Database,
  poolQuery: RecipePoolQuery,
  task: TaskNode,
  opts?: { minConfidence?: number },
): Promise<RecipeMatch | null> => {
  const minConfidence = opts?.minConfidence ?? RECIPE_DEFAULT_MIN_CONFIDENCE;
  const taskGoalShape = goalShape(task.goal ?? "");
  const taskGoalLower = task.goal.toLowerCase();

  // Topology event scan — off-loop. Same SQL + params + fold as the sync path.
  const topoRows = await poolQuery<{ task_id: string; parent_task_id: string | null }>(
    db,
    TASK_TOPOLOGY_SCAN_SQL,
    [task.directive_id],
  );
  const taskTopology = foldTopologySignature(topoRows);

  // recipes_latest_view scan — off-loop. Byte-identical SQL + mapping to
  // substrate/views.ts:recipesLatestView (same WHERE, same ORDER BY).
  const raw = await poolQuery<Record<string, unknown>>(
    db,
    `SELECT id, goal_shape, topology_signature, confidence, payload
       FROM recipes_latest_view
       WHERE goal_shape IS NOT NULL AND topology_signature IS NOT NULL
       ORDER BY goal_shape ASC, topology_signature ASC`,
    [],
  );
  const viewRows: RecipesLatestRow[] = raw.map((r) => {
    let payload: Record<string, unknown> = {};
    const rawPayload = r.payload;
    if (typeof rawPayload === "string" && rawPayload.length > 0) {
      try { payload = JSON.parse(rawPayload) as Record<string, unknown>; } catch { payload = {}; }
    } else if (rawPayload && typeof rawPayload === "object") {
      payload = rawPayload as Record<string, unknown>;
    }
    return {
      id: r.id as string,
      goal_shape: r.goal_shape as string,
      topology_signature: r.topology_signature as string,
      confidence: (r.confidence as number) ?? 0,
      payload,
    };
  });

  return pickBestRecipeMatch(viewRows, taskGoalShape, taskGoalLower, taskTopology, minConfidence);
};

export type RecipeReplayOutcome = {
  task_committed: boolean;
  residuals: number[];
  emitted_event_ids: string[];
  abort_reason?: string;
};

export type RecipeArtifactRunner = (
  db: Database,
  artifactId: string,
  inputs: JsonValue,
) => Promise<{ ok: boolean; result: JsonValue | null; error?: string; runtimeUnavailable?: Record<string, JsonValue> }>;

const runArtifactByRuntime: RecipeArtifactRunner = async (
  db,
  artifactId,
  inputs,
) => {
  const row = getArtifact(db, artifactId);
  if (!row) return { ok: false, result: null, error: "artifact_not_found" };
  // Dispatcher quarantine gate (§11.6): replay MUST NOT execute quarantined
  // artifacts. The rehab worker is the only path back to `admitted`.
  if (row.status === "quarantined") {
    return { ok: false, result: null, error: "artifact_quarantined" };
  }
  // Brain sandbox audit bsfxsvgh9 (2026-05-15): terminal-retired
  // artifacts are NEVER auto-readmitted. Mirror the dispatcher hard
  // fence so Tier-0 recipes can't replay known-bad trajectories.
  if (row.status === "retired") {
    return { ok: false, result: null, error: "artifact_retired" };
  }
  // Hard kill-count fence (mirrors task_dispatcher.ts ARTIFACT_HARD_KILL_FENCE).
  const killFence = 5;
  if (row.recentKillCount >= killFence) {
    return { ok: false, result: null, error: `artifact_kill_fenced:count=${row.recentKillCount}` };
  }
  const decl = row.declaredSandbox;
  // Path A (2026-05-20, contract A0DQT211JH): data-class rows carry
  // runtime=null and declaredSandbox=null — they have NO executable
  // semantics. A recipe trajectory that names a data-class artifact_id as
  // an action step cannot replay it; fail closed cleanly (no throw on
  // `decl.runtime`) so the dispatcher routes back to brain refinement
  // instead of crashing the replay. resolveRuntime would throw on a null
  // declaredSandbox by design, so we never reach it.
  if (row.runtime === null || decl === null) {
    return { ok: false, result: null, error: "data_class_artifact_not_executable" };
  }
  if (decl.runtime !== row.runtime) {
    return { ok: false, result: null, error: "sandbox_decl_runtime_mismatch" };
  }
  let observation: {
    ok: boolean;
    result?: JsonValue;
    error?: string;
    runtimeUnavailable?: Record<string, JsonValue>;
  };
  // Capability-aware runtime resolution is centralized in
  // runArtifactForRuntime (runtime/runtimes/index.ts resolveRuntime):
  // replay no longer switches on row.runtime or performs its own
  // registry-runner existence check. A missing/unavailable runtime returns
  // a fail-closed observation (error: runtime_unavailable:<rt> /
  // unknown_runtime:<rt>) instead of throwing, so the dispatcher falls
  // through to brain refinement without poisoning the recipe trajectory.
  const obs = await runArtifactForRuntime({
    artifactId: row.id,
    body: row.body,
    declaredSandbox: decl,
    inputs,
    db,
  });
  observation = { ok: obs.ok, result: obs.result ?? null, error: obs.error, runtimeUnavailable: (obs as { runtimeUnavailable?: Record<string, JsonValue> }).runtimeUnavailable };
  return {
    ok: observation.ok,
    result: observation.result ?? null,
    error: observation.error,
    runtimeUnavailable: observation.runtimeUnavailable,
  };
};

/** Replay a matched recipe against the current task. Walks the trajectory,
 *  running each action artifact + verifier in order. If any verifier residual
 *  exceeds RECIPE_VERIFIER_ABORT_THRESHOLD, replay aborts cleanly and the
 *  dispatcher falls through to opencode_brain refinement.
 *
 *  NO brain call ever happens during replay — that's the whole point of
 *  Tier-0 (§15).
 *
 *  Batch 4 Hole 4 — multi-step replay: a recipe whose trajectory contains
 *  multiple `action_predicted` steps is replayed in trajectory order. Each
 *  step's residual is appended to `residuals[]`. If any step's verifier
 *  residual >= RECIPE_VERIFIER_ABORT_THRESHOLD the replay aborts at that
 *  step (the dispatcher routes back to opencode_brain). The recipe's
 *  terminal residual (used for `task_committed`) is the LAST step's
 *  verifier residual on success, or the worst observed when aborted. */
export const replayRecipe = async (
  db: Database,
  task: TaskNode,
  match: RecipeMatch,
  opts: { runArtifact?: RecipeArtifactRunner } = {},
): Promise<RecipeReplayOutcome> => {
  const emitted: string[] = [];
  const residuals: number[] = [];
  const runArtifact = opts.runArtifact ?? runArtifactByRuntime;

  // Walk every action_predicted step in trajectory order (Batch 4 Hole 4).
  // Multi-step recipes are first class. Steps without an artifact_id are
  // skipped (some trajectories include task_node_opened markers for audit
  // but no executable artifact).
  const actionSteps = match.trajectory.filter(
    (s) => s.step_kind === "action_predicted" && !!s.artifact_id,
  );
  if (actionSteps.length === 0) {
    // recipe-replay-abort action_scored absorbed into action_scored (universality proposal
    // A12CR1QCDN0SS51CM95K39T45M). residual=1 + replay_aborted=true on the
    // payload renders the abort on the same scoring substrate.
    const ev = emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "recipe",
      directive_id: task.directive_id,
      task_id: task.id,
      action_artifact_id: "recipe_replay_selector_v1",
      verifier_artifact_id: "reusable_trajectory_replay_verifier",
      predicted_residual: 1 - match.confidence,
      residual: 1,
      outcome: "failed",
      failure_kind: "trajectory_missing_action_step",
      payload: {
        recipe_replayed: true,
        replay_aborted: true,
        recipe_id: match.recipe_id,
        knowledge_id: match.recipe_id,
        reusable_trajectory_knowledge_id: match.recipe_id,
        abort_reason: "trajectory_missing_action_step",
        reason: "trajectory_missing_action_step",
        breakdown: { replay_abort: 1, trajectory_completeness: 1 },
      } as JsonValue,
      context_refs: [match.recipe_id],
    });
    emitted.push(ev.id);
    updateRecipeConfidence(db, match.recipe_id, false);
    return {
      task_committed: false,
      residuals,
      emitted_event_ids: emitted,
      abort_reason: "trajectory_missing_action_step",
    };
  }

  // Last action artifact + verifier ids — needed for the final task_committed
  // row that closes the task. On a partial-failure abort we still want the
  // commit row (when emitted) to cite the step that observed the residual.
  let lastActionArtifactId = "";
  let lastVerifierArtifactId: string | undefined;
  // Pipe each step's observation envelope into the next step's inputs so
  // multi-runtime trajectories can compose without runtime-specific lanes.
  // The envelope is ordinary JsonValue but should carry resource_uri,
  // media_type, producer_runtime, state_ref, summary, claims, tables, and
  // artifact refs when available; verifiers score the envelope contract.
  let upstreamResult: JsonValue | null = null;

  for (let stepIdx = 0; stepIdx < actionSteps.length; stepIdx++) {
    const actionStep = actionSteps[stepIdx]!;
    if (!actionStep.artifact_id) continue;
    lastActionArtifactId = actionStep.artifact_id;
    lastVerifierArtifactId = actionStep.verifier_artifact_id ?? undefined;

    const actionTemplate = (actionStep.payload_template ?? {}) as Record<string, unknown>;
    const stampedPayload: Record<string, unknown> = {
      ...actionTemplate,
      recipe_replayed: true,
      recipe_id: match.recipe_id,
      recipe_step_index: stepIdx,
      recipe_step_count: actionSteps.length,
      // Inputs sourced from the task — strip the original task_id and
      // directive_id so we don't pollute the replay with the recipe's anchor.
      target_path: (actionTemplate.target_path as string | undefined) ?? null,
    };
    const predictedEv = emitEvent(db, {
      kind: "action_predicted",
      substrate_origin: "recipe",
      directive_id: task.directive_id,
      task_id: task.id,
      action_artifact_id: actionStep.artifact_id,
      verifier_artifact_id: actionStep.verifier_artifact_id ?? undefined,
      predicted_residual: actionStep.predicted_residual ?? 0,
      payload: stampedPayload as JsonValue,
    });
    emitted.push(predictedEv.id);

    // Inputs for THIS step's action artifact. Step 0 honors any target_path
    // the task carries (the single-step legacy fixture path); subsequent
    // steps receive the previous step's `action_result` as their inputs,
    // mirroring the brain-refinement contract where each cycle reads the
    // last cycle's outcome.
    const actionInputs: JsonValue = stepIdx === 0
      ? ({
          target_path:
            (stampedPayload.target_path as string | undefined) ??
            (actionTemplate.target_path as string | undefined) ??
            ".",
        } as JsonValue)
      : (upstreamResult ?? ({} as JsonValue));

    const actionObs = await runArtifact(db, actionStep.artifact_id, actionInputs);
    if (!actionObs.ok) {
      const ev = emitEvent(db, {
        kind: "action_scored",
        substrate_origin: "recipe",
        directive_id: task.directive_id,
        task_id: task.id,
        action_artifact_id: actionStep.artifact_id,
        verifier_artifact_id: actionStep.verifier_artifact_id ?? undefined,
        predicted_residual: actionStep.predicted_residual ?? 0,
        residual: 1,
        outcome: "failed",
        failure_kind: "artifact_runtime_error",
        payload: {
          recipe_replayed: true,
          replay_aborted: true,
          recipe_id: match.recipe_id,
          runtime_signature: match.runtime_signature,
          knowledge_id: match.recipe_id,
          reusable_trajectory_knowledge_id: match.recipe_id,
          step_index: stepIdx,
          step_count: actionSteps.length,
          reason: `action_runtime_failed:${actionObs.error ?? "unknown"}`,
          abort_reason: `action_runtime_failed:${actionObs.error ?? "unknown"}`,
          runtimeUnavailable: actionObs.runtimeUnavailable ?? null,
          reliability_profile: actionObs.runtimeUnavailable ? { runtime_unavailable: 1, brain_actionable_degrade: 1 } : undefined,
          breakdown: { replay_abort: 1, runtime_error: 1, runtime_unavailable: actionObs.runtimeUnavailable ? 1 : 0 },
        } as JsonValue,
        context_refs: [match.recipe_id],
      });
      emitted.push(ev.id);
      updateRecipeConfidence(db, match.recipe_id, false);
      return {
        task_committed: false,
        residuals,
        emitted_event_ids: emitted,
        abort_reason: `action_runtime_failed:${actionObs.error ?? "unknown"}`,
      };
    }

    upstreamResult = (actionObs.result ?? null) as JsonValue;

    // Run the verifier (when present). `{residual: number}` is the canonical
    // shape; anything else falls to residual=1.
    let residual = 1;
    if (actionStep.verifier_artifact_id) {
      // F6 completion (decision 11) — wrap verifier invocation so the
      // verifier_handle earns or loses posterior via the meta verifier.
      const verifierStepId = actionStep.verifier_artifact_id;
      const verifierObs = await invokeVerifierWithMeta(db, {
        verifierHandle: verifierStepId,
        inputs: (actionObs.result ?? null) as JsonValue,
        directiveId: task.directive_id,
        taskId: task.id,
        sourceEventId: predictedEv.id,
        citedArtifactIds: [verifierStepId],
        invoke: () => runArtifact(
          db,
          verifierStepId,
          (actionObs.result ?? null) as JsonValue,
        ),
      });
      if (
        verifierObs.ok &&
        verifierObs.result &&
        typeof verifierObs.result === "object" &&
        !Array.isArray(verifierObs.result) &&
        typeof (verifierObs.result as Record<string, unknown>).residual === "number"
      ) {
        const raw = (verifierObs.result as { residual: number }).residual;
        // Broken-signal-is-never-a-pass (mirrors the credit-residual write
        // boundary, commit 79785a1): a verifier can return NaN, Infinity, a
        // negative number, or a value > 1. The `typeof === "number"` guard
        // above admits all of those. If we accepted them raw, a NaN residual
        // would fail the `residual >= ABORT_THRESHOLD` comparison (NaN
        // compares false) and the recipe would COMMIT with a NaN terminal
        // residual — a broken signal masquerading as a clean replay. A
        // negative residual would likewise slip past the abort gate and
        // commit. Clamp finite values into [0,1]; treat non-finite as a
        // verifier failure (residual=1) so the abort gate fires.
        residual = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 1;
      }
    } else {
      residual = actionObs.ok ? 0 : 1;
    }
    residuals.push(residual);

    // Emit action_scored for THIS step so credit accounting flows per-step
    // (Phase H credit pipeline scoring applies to every step independently).
    const scoredEv = emitEvent(db, {
      kind: "action_scored",
      substrate_origin: "recipe",
      directive_id: task.directive_id,
      task_id: task.id,
      action_artifact_id: actionStep.artifact_id,
      verifier_artifact_id: actionStep.verifier_artifact_id ?? undefined,
      predicted_residual: actionStep.predicted_residual ?? 0,
      residual,
      payload: {
        recipe_replayed: true,
        recipe_id: match.recipe_id,
        recipe_step_index: stepIdx,
        recipe_step_count: actionSteps.length,
        action_result: actionObs.result ?? null,
      } as JsonValue,
    });
    emitted.push(scoredEv.id);

    // Close the credit chain (Architecture.md Rule 3; Phase Align Principle 6).
    // Every action_scored event MUST be followed by a distributeCredit call.
    try {
      await distributeCredit(db, {
        action_event_id: predictedEv.id,
        observation_event_id: scoredEv.id,
        scored_event_id: scoredEv.id,
        predicted_residual: actionStep.predicted_residual ?? residual,
        observed_residual: residual,
      });
    } catch {
      // action_scored universal projection already owns primary posterior
      // credit; recipe replay must not retain a duplicate direct fallback.
    }

    // If THIS step's verifier residual exceeds the abort threshold, the
    // replay is rejected and the dispatcher routes the task back to
    // opencode_brain for refinement. The recipe's terminal residual on
    // abort is the worst observed (= this step's residual, since it's the
    // first to fail).
    if (residual >= RECIPE_VERIFIER_ABORT_THRESHOLD) {
      const ev = emitEvent(db, {
        kind: "action_scored",
        substrate_origin: "recipe",
        directive_id: task.directive_id,
        task_id: task.id,
        action_artifact_id: actionStep.artifact_id,
        verifier_artifact_id: actionStep.verifier_artifact_id ?? undefined,
        predicted_residual: actionStep.predicted_residual ?? 0,
        residual,
        outcome: "failed",
        failure_kind: "verification_high_residual",
        payload: {
          recipe_replayed: true,
          replay_aborted: true,
          recipe_id: match.recipe_id,
          runtime_signature: match.runtime_signature,
          knowledge_id: match.recipe_id,
          reusable_trajectory_knowledge_id: match.recipe_id,
          step_index: stepIdx,
          step_count: actionSteps.length,
          worst_residual: residuals.reduce((a, b) => Math.max(a, b), 0),
          threshold: RECIPE_VERIFIER_ABORT_THRESHOLD,
          reason: "verifier_residual_above_threshold",
          abort_reason: "verifier_residual_above_threshold",
          breakdown: { replay_abort: 1, verifier_residual: residual },
        } as JsonValue,
        context_refs: [match.recipe_id],
      });
      emitted.push(ev.id);
      updateRecipeConfidence(db, match.recipe_id, false);
      return {
        task_committed: false,
        residuals,
        emitted_event_ids: emitted,
        abort_reason: "verifier_residual_above_threshold",
      };
    }
  }

  // Every step's verifier passed. The task's terminal residual is the LAST
  // step's residual (the final ground truth — multi-step trajectories close
  // on the final verifier, not an aggregate). Emit task_committed citing
  // the last step's action + verifier artifacts.
  const terminalResidual = residuals[residuals.length - 1]!;
  const commitEv = emitEvent(db, {
    kind: "task_committed",
    substrate_origin: "recipe",
    directive_id: task.directive_id,
    task_id: task.id,
    outcome: "succeeded",
    residual: terminalResidual,
    action_artifact_id: lastActionArtifactId,
    verifier_artifact_id: lastVerifierArtifactId,
    payload: {
      recipe_replayed: true,
      recipe_id: match.recipe_id,
      step_count: actionSteps.length,
      residuals,
    } as JsonValue,
  });
  emitted.push(commitEv.id);
  updateRecipeConfidence(db, match.recipe_id, true);

  return {
    task_committed: true,
    residuals,
    emitted_event_ids: emitted,
  };
};

/** Update a recipe's confidence based on an outcome. Success → +0.05, failure
 *  → −0.10. Floored at 0.0 (auto-archive at < 0.2). Ceiling at 0.95. The
 *  update is recorded by appending a fresh recipe-shape knowledge_candidate
 *  row carrying the same (goal_shape, topology_signature) and the new
 *  confidence — the matcher always reads the LATEST row for a given key. We
 *  read the LATEST matching row's confidence (not the seed's) so successive
 *  updates compound. */
export const updateRecipeConfidence = (
  db: Database,
  recipeId: string,
  success: boolean,
): { newConfidence: number } => {
  // Locate the seed row to recover goal_shape + topology_signature.
  const seed = db
    .query("SELECT directive_id, task_id, loop_id, payload FROM events WHERE id = ?")
    .get(recipeId) as { directive_id: string; task_id: string; loop_id: string; payload: string } | null;
  if (!seed) return { newConfidence: 0 };
  let seedPayload: Record<string, unknown> = {};
  try { seedPayload = JSON.parse(seed.payload ?? "{}") as Record<string, unknown>; } catch { seedPayload = {}; }
  const goalShape = (seedPayload.goal_shape as string | undefined) ?? "";
  const topology = (seedPayload.topology_signature as string | undefined) ?? "";

  // Read the LATEST recipe-shaped knowledge row for this (goal_shape, topology)
  // pair — that's where the current confidence lives. Successive updates
  // then compound on the previous result.
  const latest = db
    .query(
      `SELECT payload FROM events
       WHERE kind IN ('knowledge_candidate', 'knowledge_promoted')
         AND COALESCE(
           json_extract(payload, '$.recipe_shape.enabled'),
           json_extract(payload, '$.recipe.enabled'),
           json_extract(payload, '$.is_recipe'),
           0
         ) IN (1, 'true')
       ORDER BY ts DESC, rowid DESC`,
    )
    .all() as Array<{ payload: string }>;
  let currentConfidence = (seedPayload.confidence as number | undefined) ?? 0.5;
  for (const r of latest) {
    try {
      const p = JSON.parse(r.payload ?? "{}") as Record<string, unknown>;
      if (p.goal_shape === goalShape && p.topology_signature === topology) {
        if (typeof p.confidence === "number") {
          currentConfidence = p.confidence;
          break;
        }
      }
    } catch { /* skip */ }
  }

  const delta = success ? 0.05 : -0.10;
  const newConfidence = Math.max(0.0, Math.min(RECIPE_MAX_CONFIDENCE, currentConfidence + delta));

  // Append-only confidence-update row in the same recipe-shape knowledge
  // substrate. The matcher reads the LATEST row for the (goal_shape, topology)
  // key, so this row becomes the new confidence-of-record.
  const prevRecipeShape =
    (seedPayload.recipe_shape && typeof seedPayload.recipe_shape === "object")
      ? (seedPayload.recipe_shape as Record<string, unknown>)
      : seedPayload;
  emitEvent(db, {
    kind: "knowledge_candidate",
    substrate_origin: "substrate_auto",
    directive_id: seed.directive_id,
    task_id: seed.task_id,
    loop_id: seed.loop_id,
    payload: {
      claim: `Reusable trajectory ${recipeId} replay confidence updated to ${newConfidence.toFixed(2)}.`,
      evidence: [success ? "replay succeeded" : "replay failed", `previous_confidence=${currentConfidence}`],
      implications: ["Replay confidence remains ordinary promotable knowledge rather than a recipe event family."],
      applies_to: ["reusable_trajectory", goalShape, topology],
      confidence_estimate: newConfidence,
      // Top-level mirrors for legacy readers.
      ...seedPayload,
      confidence: newConfidence,
      previous_confidence: currentConfidence,
      confidence_update: success ? "success" : "failure",
      derived_from_recipe_id: recipeId,
      derived_from_knowledge_id: recipeId,
      recipe_shape: {
        ...prevRecipeShape,
        enabled: true,
        confidence: newConfidence,
        previous_confidence: currentConfidence,
        confidence_update: success ? "success" : "failure",
        derived_from_recipe_id: recipeId,
        derived_from_knowledge_id: recipeId,
      },
    } as JsonValue,
    context_refs: [recipeId],
  });

  // P6 stage B (amendment 5XRDMG6G): additively route the recipe outcome
  // through the canonical `applyScoredOutcome` primitive so each recipe
  // also lands as ONE `scored_entity` row (entity_kind="recipe"), audited
  // by ONE `entity_score_updated` event — the consolidation target.
  //
  // This is ADDITIVE, NOT a replacement. The bespoke sticky
  // (+0.05/−0.10) confidence-of-record above is DELIBERATELY a different
  // shape than the Beta posterior (see the module header + Phase-Align
  // Principle 9, which PINS the divergence and forbids silent unification)
  // AND it is the row the recipe matcher (fetchMatchedRecipe /
  // recipesLatestView) reads to gate replay. Removing it would (a) change
  // recipe gating semantics from sticky→Beta and (b) require restructuring
  // the knowledge_candidate read path the matcher and the
  // extractRecipeCandidates seed share — that read path is the knowledge
  // spine, out of this stage's scope. So we mirror the outcome into the
  // scored_entity substrate WITHOUT removing the sticky drift. A later
  // (in-scope-for-knowledge-spine) stage may move the matcher onto
  // scored_entity and retire the sticky row; this stage only establishes
  // the parallel canonical row. Map success→residual 0, failure→1 (the
  // coarse single-bit recipe outcome the sticky model already uses).
  applyScoredOutcome(db, {
    entity_id: recipeId,
    entity_kind: "recipe",
    outcome: success ? "succeeded" : "failed",
    ts: nowIso(),
    directive_id: seed.directive_id,
    task_id: seed.task_id,
    context_refs: [recipeId],
  });

  return { newConfidence };
};
