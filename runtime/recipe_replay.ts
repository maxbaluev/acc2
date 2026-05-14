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
// Goal-shape match is computed via runtime/goal_shape.ts. Topology match is the
// signature emitted on the recipe payload by extractRecipeCandidates. When
// crisis mode is active (§3.5) the dispatcher lowers the confidence threshold
// from 0.7 → 0.4 (§I crisis_mode.ts already exposes that constant).

import type { Database } from "bun:sqlite";
import type { JsonValue, SandboxDecl } from "../substrate/types";
import { emitEvent } from "./events";
import { goalShape } from "./goal_shape";
import { getArtifact } from "./artifact_store";
import { runBunArtifact } from "./runtimes/bun";
import { runUvArtifact } from "./runtimes/uv";
import { runCamofoxArtifact } from "./runtimes/camofox";
import type { TaskNode } from "./task_topology";

export const RECIPE_DEFAULT_MIN_CONFIDENCE = 0.6;
export const RECIPE_MAX_CONFIDENCE = 0.95;
export const RECIPE_AUTO_ARCHIVE_FLOOR = 0.2;
export const RECIPE_VERIFIER_ABORT_THRESHOLD = 0.3;

export type RecipeTrajectoryStep = {
  step_kind: "action_predicted" | "task_node_opened" | string;
  artifact_id?: string | null;
  verifier_artifact_id?: string | null;
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

/** Find a recipe that matches the supplied task. Returns the highest-
 *  confidence match whose value is ≥ minConfidence, or null when no recipe
 *  matches. Uses goalShape() to compute the task's goal hash. */
export const findRecipeMatch = (
  db: Database,
  task: TaskNode,
  opts?: { minConfidence?: number },
): RecipeMatch | null => {
  const minConfidence = opts?.minConfidence ?? RECIPE_DEFAULT_MIN_CONFIDENCE;
  const taskGoalShape = goalShape(task.goal ?? "");
  const taskTopology = taskTopologySignature(db, task);

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

    // Two match strategies:
    //   1. Exact: recipe.goal_shape == task's goalShape() hash.
    //   2. Token overlap: recipe.goal_shape is the legacy normalized-text
    //      token (e.g. "count_todos_in_repo::n1"). Treat it as a bag of
    //      tokens (length ≥ 3); accept when ≥ 60% of the recipe's tokens
    //      appear in the task goal. This survives the 80-char slice that
    //      may have truncated the recipe text mid-word.
    const exactGoalMatch = payload.goal_shape === taskGoalShape;
    const recipeToken = payload.goal_shape.split("::")[0] ?? "";
    const taskGoalLower = task.goal.toLowerCase();
    const recipeTokens = recipeToken.split("_").filter((t) => t.length >= 3);
    let tokenMatchScore = 0;
    if (recipeTokens.length > 0) {
      let hits = 0;
      for (const tk of recipeTokens) {
        if (taskGoalLower.includes(tk)) hits++;
      }
      tokenMatchScore = hits / recipeTokens.length;
    }
    const legacyTokenMatch = recipeTokens.length > 0 && tokenMatchScore >= 0.6;
    if (!exactGoalMatch && !legacyTokenMatch) continue;

    // Topology match: exact OR recipe topology is degenerate (single root).
    const topologyMatch =
      payload.topology_signature === taskTopology ||
      payload.topology_signature.endsWith("::1") ||
      payload.topology_signature === "";
    if (!topologyMatch) continue;

    const currentConfidence = currentConfidenceFor(db, r.id, payload.confidence);
    if (currentConfidence < minConfidence) continue;
    if (currentConfidence < RECIPE_AUTO_ARCHIVE_FLOOR) continue;

    const match: RecipeMatch = {
      recipe_id: r.id,
      recipe_extracted_event_id: r.id,
      goal_shape: payload.goal_shape,
      topology_signature: payload.topology_signature,
      confidence: currentConfidence,
      trajectory: payload.trajectory,
    };
    if (!best || match.confidence > best.confidence) best = match;
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
 *  Tier-0 (§15). */
export const replayRecipe = async (
  db: Database,
  task: TaskNode,
  match: RecipeMatch,
): Promise<RecipeReplayOutcome> => {
  const emitted: string[] = [];
  const residuals: number[] = [];

  // Find the trajectory's action_predicted step (Phase J directives are
  // single-action; future multi-step recipes will iterate). If the recipe
  // has no executable step, abort.
  const actionStep = match.trajectory.find((s) => s.step_kind === "action_predicted");
  if (!actionStep || !actionStep.artifact_id) {
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

  // Replay action_predicted on the substrate so the audit trail matches a
  // normal brain dispatch. The `recipe_replayed: true` flag tells extractors
  // and credit pipeline this was a replay, not a fresh prediction.
  const actionTemplate = (actionStep.payload_template ?? {}) as Record<string, unknown>;
  const stampedPayload: Record<string, unknown> = {
    ...actionTemplate,
    recipe_replayed: true,
    recipe_id: match.recipe_id,
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

  // Inputs for the action artifact. We honor any target_path the task carries
  // (the fixture uses it); otherwise fall back to the recipe's template.
  const actionInputs: JsonValue = {
    target_path:
      (stampedPayload.target_path as string | undefined) ??
      (actionTemplate.target_path as string | undefined) ??
      ".",
  } as JsonValue;

  // Run the action artifact through the appropriate runtime.
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

  // Run the verifier artifact (when present). Verifier output shape is
  // `{residual: number}`; anything else falls to residual=1.
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

  // Emit action_scored so credit accounting flows the same way it would on a
  // fresh brain dispatch (Phase H credit pipeline scoring still applies).
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
      action_result: actionObs.result ?? null,
    } as JsonValue,
  });
  emitted.push(scoredEv.id);

  // If verifier residual exceeds the abort threshold, the replay is rejected;
  // the dispatcher routes the task back to opencode_brain for refinement.
  if (residual >= RECIPE_VERIFIER_ABORT_THRESHOLD) {
    const ev = emitEvent(db, {
      kind: "recipe_replay_aborted",
      substrate_origin: "recipe",
      directive_id: task.directive_id,
      task_id: task.id,
      failure_kind: "verification_high_residual",
      payload: {
        recipe_id: match.recipe_id,
        residual,
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

  // Success — commit the task and credit the recipe.
  const commitEv = emitEvent(db, {
    kind: "task_committed",
    substrate_origin: "recipe",
    directive_id: task.directive_id,
    task_id: task.id,
    outcome: "succeeded",
    residual,
    action_artifact_id: actionStep.artifact_id,
    verifier_artifact_id: actionStep.verifier_artifact_id ?? undefined,
    payload: {
      recipe_replayed: true,
      recipe_id: match.recipe_id,
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
