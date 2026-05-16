// acc2 recipe replay — Tier-0 cost compression (v2-design.md §15).
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
// code_artifact + knowledge_candidate (see artifact_store.ts / extractors.ts):
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
import type { JsonValue, SandboxDecl } from "../substrate/types";
import { emitEvent } from "./events";
import { goalShape } from "./goal_shape";
import { getArtifact, applyResidualOutcome } from "./artifact_store";
import { runBunArtifact } from "./runtimes/bun";
import { runUvArtifact } from "./runtimes/uv";
import { runCamofoxArtifact } from "./runtimes/camofox";
import type { TaskNode } from "./task_topology";
import { distributeCredit } from "./credit";
import { nowIso } from "./ids";
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

export type RecipeMatch = {
  /** The recipe_extracted event id. */
  recipe_id: string;
  recipe_extracted_event_id: string;
  goal_shape: string;
  topology_signature: string;
  confidence: number;
  trajectory: RecipeTrajectoryStep[];
};

/** Compute a topology signature for a task. Today this is a degenerate "single
 *  root task" shape — when Phase E DAGs land, this walks the actual subtree.
 *  The replay matcher accepts a recipe whose signature matches the current
 *  task's signature OR is degenerate (count=1). */
const taskTopologySignature = (db: Database, task: TaskNode): string => {
  const rows = db
    .query(
      `SELECT task_id, parent_task_id FROM events
       WHERE kind = 'task_node_opened' AND directive_id = ?
       ORDER BY ts ASC`,
    )
    .all(task.directive_id) as Array<{ task_id: string; parent_task_id: string | null }>;
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

const parseRecipePayload = (raw: string): {
  goal_shape: string;
  topology_signature: string;
  confidence: number;
  trajectory: RecipeTrajectoryStep[];
} | null => {
  try {
    const p = JSON.parse(raw ?? "{}") as Record<string, unknown>;
    const goal = (p.goal_shape as string | undefined) ?? "";
    const topology = (p.topology_signature as string | undefined) ?? "";
    const confidence = typeof p.confidence === "number" ? p.confidence : 0;
    const trajectory = Array.isArray(p.trajectory) ? (p.trajectory as RecipeTrajectoryStep[]) : [];
    if (!goal) return null;
    return { goal_shape: goal, topology_signature: topology, confidence, trajectory };
  } catch {
    return null;
  }
};

/** Look up the freshest confidence value for a recipe — recipes accumulate
 *  outcome updates via `recipe_confidence_updated` payloads. We project the
 *  latest update; the original recipe_extracted's value is the seed. */
const currentConfidenceFor = (db: Database, recipeId: string, baseConfidence: number): number => {
  const row = db
    .query(
      `SELECT payload FROM events
       WHERE kind = 'recipe_extracted' AND id = ?
       ORDER BY ts DESC LIMIT 1`,
    )
    .get(recipeId) as { payload: string } | null;
  if (!row) return baseConfidence;
  // updateRecipeConfidence rewrites the original event's payload via
  // applyConfidenceUpdate (no append-only violation — we re-emit a fresh
  // recipe_extracted with the new value when needed). For Phase J we keep
  // the appended-row contract: read the LATEST recipe_extracted row for the
  // same goal_shape+topology to find the current confidence.
  try {
    const p = JSON.parse(row.payload ?? "{}") as Record<string, unknown>;
    const c = typeof p.confidence === "number" ? p.confidence : baseConfidence;
    return c;
  } catch { return baseConfidence; }
};

/** Filter / shape one candidate row (view-projected OR legacy-scanned) into a
 *  RecipeMatch when it passes goal_shape + topology + confidence gating. The
 *  matching rules are identical for both code paths so the view-integrated
 *  fast path and the legacy linear-scan fallback agree on every decision. */
const tryMatchCandidate = (
  candidate: {
    id: string;
    goal_shape: string;
    topology_signature: string;
    confidence: number;
    trajectory: RecipeTrajectoryStep[];
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

  return {
    recipe_id: candidate.id,
    recipe_extracted_event_id: candidate.id,
    goal_shape: candidate.goal_shape,
    topology_signature: candidate.topology_signature,
    confidence: candidate.confidence,
    trajectory: candidate.trajectory,
  };
};

/** Legacy linear-scan path — kept as a fallback for the rare case where the
 *  view query throws (malformed payload, missing column, schema drift). The
 *  dispatch surface MUST stay alive even if the view is misconfigured. */
const findRecipeMatchLinearScan = (
  db: Database,
  taskGoalShape: string,
  taskGoalLower: string,
  taskTopology: string,
  minConfidence: number,
): RecipeMatch | null => {
  const rows = db
    .query(
      `SELECT id, payload FROM events
       WHERE kind = 'recipe_extracted'
       ORDER BY ts DESC, rowid DESC`,
    )
    .all() as Array<{ id: string; payload: string }>;

  // Track per-(goal,topology) the freshest recipe row (latest ts wins).
  const seenKeys = new Set<string>();
  let best: RecipeMatch | null = null;

  for (const r of rows) {
    const payload = parseRecipePayload(r.payload);
    if (!payload) continue;
    const key = `${payload.goal_shape}||${payload.topology_signature}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    const currentConfidence = currentConfidenceFor(db, r.id, payload.confidence);
    const match = tryMatchCandidate(
      {
        id: r.id,
        goal_shape: payload.goal_shape,
        topology_signature: payload.topology_signature,
        confidence: currentConfidence,
        trajectory: payload.trajectory,
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

/** Find a recipe that matches the supplied task. Returns the highest-
 *  confidence match whose value is ≥ minConfidence, or null when no recipe
 *  matches. Uses goalShape() to compute the task's goal hash.
 *
 *  Fast path (default): query `recipes_latest_view` — the substrate's
 *  materialized index keyed by (goal_shape, topology_signature) that picks
 *  the highest-confidence row per key. This replaces the dispatch-time
 *  linear scan over `recipe_extracted` history with one keyed projection
 *  (brain audit QQEHAW97GS0AX7TEQ717Y3P174, 2026-05-15).
 *
 *  Fallback: if the view query throws (malformed payload, missing column,
 *  schema drift), surface as `error_caught` and fall back to the legacy
 *  linear-scan path so dispatch stays alive. */
export const findRecipeMatch = (
  db: Database,
  task: TaskNode,
  opts?: { minConfidence?: number },
): RecipeMatch | null => {
  const minConfidence = opts?.minConfidence ?? RECIPE_DEFAULT_MIN_CONFIDENCE;
  const taskGoalShape = goalShape(task.goal ?? "");
  const taskTopology = taskTopologySignature(db, task);
  const taskGoalLower = task.goal.toLowerCase();

  // Fast path — keyed projection from recipes_latest_view.
  let viewRows: RecipesLatestRow[] | null = null;
  try {
    viewRows = recipesLatestView(db);
  } catch (err) {
    try {
      emitEvent(db, {
        kind: "error_caught",
        substrate_origin: "substrate_auto",
        payload: {
          where: "recipe_replay.findRecipeMatch.recipesLatestView",
          recoverable: true,
          message: (err as Error).message,
          fallback: "linear_scan",
        } as JsonValue,
      });
    } catch { /* db may be closed — fall through to legacy scan */ }
    return findRecipeMatchLinearScan(
      db,
      taskGoalShape,
      taskGoalLower,
      taskTopology,
      minConfidence,
    );
  }

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

export type RecipeReplayOutcome = {
  task_committed: boolean;
  residuals: number[];
  emitted_event_ids: string[];
  abort_reason?: string;
};

const runArtifactByRuntime = async (
  db: Database,
  artifactId: string,
  inputs: JsonValue,
): Promise<{ ok: boolean; result: JsonValue | null; error?: string }> => {
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
  if (decl.runtime !== row.runtime) {
    return { ok: false, result: null, error: "sandbox_decl_runtime_mismatch" };
  }
  let observation: {
    ok: boolean;
    result?: JsonValue;
    error?: string;
  };
  if (row.runtime === "bun") {
    observation = await runBunArtifact({
      artifactId: row.id,
      body: row.body,
      declaredSandbox: decl as Extract<SandboxDecl, { runtime: "bun" }>,
      inputs,
    });
  } else if (row.runtime === "uv") {
    observation = await runUvArtifact({
      artifactId: row.id,
      body: row.body,
      declaredSandbox: decl as Extract<SandboxDecl, { runtime: "uv" }>,
      inputs,
    });
  } else {
    observation = await runCamofoxArtifact({
      artifactId: row.id,
      body: row.body,
      declaredSandbox: decl as Extract<SandboxDecl, { runtime: "camofox-browser" }>,
      inputs,
    });
  }
  return {
    ok: observation.ok,
    result: observation.result ?? null,
    error: observation.error,
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
): Promise<RecipeReplayOutcome> => {
  const emitted: string[] = [];
  const residuals: number[] = [];

  // Walk every action_predicted step in trajectory order (Batch 4 Hole 4).
  // Phase J recipes were single-step; multi-step recipes are now first
  // class. Steps without an artifact_id are skipped (some trajectories
  // include task_node_opened markers for audit but no executable artifact).
  const actionSteps = match.trajectory.filter(
    (s) => s.step_kind === "action_predicted" && !!s.artifact_id,
  );
  if (actionSteps.length === 0) {
    const ev = emitEvent(db, {
      kind: "recipe_replay_aborted",
      substrate_origin: "recipe",
      directive_id: task.directive_id,
      task_id: task.id,
      payload: {
        recipe_id: match.recipe_id,
        reason: "trajectory_missing_action_step",
      } as JsonValue,
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

    const actionObs = await runArtifactByRuntime(db, actionStep.artifact_id, actionInputs);
    if (!actionObs.ok) {
      const ev = emitEvent(db, {
        kind: "recipe_replay_aborted",
        substrate_origin: "recipe",
        directive_id: task.directive_id,
        task_id: task.id,
        failure_kind: "artifact_runtime_error",
        payload: {
          recipe_id: match.recipe_id,
          step_index: stepIdx,
          step_count: actionSteps.length,
          reason: `action_runtime_failed:${actionObs.error ?? "unknown"}`,
        } as JsonValue,
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
      const verifierObs = await runArtifactByRuntime(
        db,
        actionStep.verifier_artifact_id,
        (actionObs.result ?? null) as JsonValue,
      );
      if (
        verifierObs.ok &&
        verifierObs.result &&
        typeof verifierObs.result === "object" &&
        !Array.isArray(verifierObs.result) &&
        typeof (verifierObs.result as Record<string, unknown>).residual === "number"
      ) {
        residual = (verifierObs.result as { residual: number }).residual;
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

    // Close the credit chain (v2-design.md §3.6.1 Rule 3; Phase Align Principle 6).
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
      applyResidualOutcome(db, actionStep.artifact_id, residual, nowIso());
      if (actionStep.verifier_artifact_id) {
        applyResidualOutcome(db, actionStep.verifier_artifact_id, residual, nowIso());
      }
    }

    // If THIS step's verifier residual exceeds the abort threshold, the
    // replay is rejected and the dispatcher routes the task back to
    // opencode_brain for refinement. The recipe's terminal residual on
    // abort is the worst observed (= this step's residual, since it's the
    // first to fail).
    if (residual >= RECIPE_VERIFIER_ABORT_THRESHOLD) {
      const ev = emitEvent(db, {
        kind: "recipe_replay_aborted",
        substrate_origin: "recipe",
        directive_id: task.directive_id,
        task_id: task.id,
        failure_kind: "verification_high_residual",
        payload: {
          recipe_id: match.recipe_id,
          step_index: stepIdx,
          step_count: actionSteps.length,
          residual,
          worst_residual: residuals.reduce((a, b) => Math.max(a, b), 0),
          threshold: RECIPE_VERIFIER_ABORT_THRESHOLD,
          reason: "verifier_residual_above_threshold",
        } as JsonValue,
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
 *  update is recorded by appending a fresh recipe_extracted row carrying the
 *  same (goal_shape, topology_signature) and the new confidence — the
 *  matcher always reads the LATEST row for a given key. We read the LATEST
 *  matching row's confidence (not the seed's) so successive updates compound. */
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

  // Read the LATEST recipe_extracted row for this (goal_shape, topology)
  // pair — that's where the current confidence lives. Successive updates
  // then compound on the previous result.
  const latest = db
    .query(
      `SELECT payload FROM events
       WHERE kind = 'recipe_extracted'
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

  emitEvent(db, {
    kind: "recipe_extracted",
    substrate_origin: "substrate_auto",
    directive_id: seed.directive_id,
    task_id: seed.task_id,
    loop_id: seed.loop_id,
    payload: {
      ...seedPayload,
      confidence: newConfidence,
      previous_confidence: currentConfidence,
      confidence_update: success ? "success" : "failure",
      derived_from_recipe_id: recipeId,
    } as JsonValue,
    context_refs: [recipeId],
  });

  return { newConfidence };
};
