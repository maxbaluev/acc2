import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { emitEvent } from "./events";

export const COMPRESSION_MIN_CLUSTER_SIZE = 2;
export const RETIREMENT_AGE_DAYS = 14;
export const SUCCESS_RESIDUAL_THRESHOLD = 0.3;
export const CLOSURE_RESIDUAL_THRESHOLD = 0.3;

/** Hard cap on action_scored rows scanned per tick. Per substrate KC
 *  GJ2KN1J3KD1Z (bounded amendments per worker): on a 280K-event
 *  ledger the unbounded `SELECT ... FROM events WHERE kind='action_scored'
 *  ORDER BY ts ASC` walked thousands of rows synchronously, with N
 *  per-row sub-queries for prediction / closure / lessons / task goal.
 *  The 14-day window already filters by RETIREMENT_AGE_DAYS for lesson
 *  retirement; capping the trajectory scan at the same window keeps the
 *  compression cycle bounded. */
const TRAJECTORY_SCAN_WINDOW_DAYS = 14;
const TRAJECTORY_SCAN_LIMIT = 1000;

/** Hard cap on knowledge_candidate / knowledge_promoted rows scanned
 *  when looking for prior compressions of a cluster_key. The set is
 *  filtered to recipe_shape.enabled rows but historically grows
 *  monotonically. Bounded scan keeps the per-tick cost flat. */
const EXISTING_COMPRESSION_SCAN_LIMIT = 1000;

/** Hard cap on lesson_extracted + applied_change_committed rows scanned
 *  by retireStaleLessons. The retire cutoff already filters lessons to
 *  the > 14-day-old set; bounding the SQL pull keeps a fresh install's
 *  pre-cursor catch-up cycle short. */
const LESSON_SCAN_LIMIT = 1000;
const APPLY_SCAN_LIMIT = 2000;

/** Cooperative yield helper — releases the event loop so the daemon's
 *  /health route, the bridge SSE pumps, and other workers can run while
 *  this worker walks the trajectory + cluster + lesson sets on a
 *  280K-event ledger. */
const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/** Yield every 25 rows matches the bounded-amendments cadence used by
 *  embedder / artifact_kind_backfill_worker / contract_amendment_consumer
 *  / lifecycle_closure_sweep. */
const YIELD_INTERVAL_ROWS = 25;

export type ExperienceCompressionWorkerResult = {
  scanned_scored: number;
  eligible_trajectories: number;
  recipes_extracted: number;
  knowledge_candidates: number;
  skipped_existing_compression: number;
  superseded_refusals: number;
  lessons_retired: number;
  trajectories_scanned: number;
  clusters_found: number;
  candidates_emitted: number;
};

type EventRow = {
  id: string;
  ts: string;
  directive_id: string;
  task_id: string;
  loop_id: string;
  payload: string;
  context_refs?: string;
  residual?: number | null;
  action_artifact_id?: string | null;
  verifier_artifact_id?: string | null;
  predicted_residual?: number | null;
};

type SuccessfulTrajectory = {
  directiveId: string;
  taskId: string;
  loopId: string;
  scoredEventId: string;
  scoredResidual: number;
  predictedEventId: string;
  actionArtifactId: string | null;
  verifierArtifactId: string | null;
  predictedResidual: number | null;
  closureEventId: string;
  closureResidual: number;
  lessonEventId: string;
  lessonKind: string;
  lessonSummary: string;
  goal: string;
  goalShape: string;
  ts: string;
};

const STOPWORDS = new Set(["the", "and", "for", "with", "from", "that", "this", "into", "per", "via"]);

const parsePayload = (raw: string | null | undefined): Record<string, unknown> => {
  try {
    return JSON.parse(raw ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
};

const parseRefs = (raw: string | null | undefined): string[] => {
  try {
    const refs = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(refs) ? refs.filter((ref): ref is string => typeof ref === "string") : [];
  } catch {
    return [];
  }
};

const asNumber = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const asString = (value: unknown): string => (typeof value === "string" ? value : "");

const normalizeGoalShape = (goal: string): string => {
  const tokens = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
  return tokens.slice(0, 8).join("_") || "unknown_goal_shape";
};

const compressionKey = (goalShape: string, lessonKind: string): string => `${goalShape}::${lessonKind || "lesson"}`;

const taskGoalFor = (db: Database, directiveId: string, taskId: string): string => {
  const task = db
    .query(
      `SELECT payload FROM events
       WHERE kind = 'task_node_opened' AND directive_id = ? AND task_id = ?
       ORDER BY ts ASC, rowid ASC LIMIT 1`,
    )
    .get(directiveId, taskId) as { payload: string } | null;
  const taskPayload = parsePayload(task?.payload);
  const taskGoal = asString(taskPayload.goal);
  if (taskGoal) return taskGoal;
  const directive = db
    .query(
      `SELECT payload FROM events
       WHERE kind = 'directive_opened' AND directive_id = ?
       ORDER BY ts ASC, rowid ASC LIMIT 1`,
    )
    .get(directiveId) as { payload: string } | null;
  const directivePayload = parsePayload(directive?.payload);
  return asString(directivePayload.directive_text) || asString(directivePayload.text) || directiveId;
};

const latestPredictionFor = (db: Database, directiveId: string, taskId: string): EventRow | null => {
  return db
    .query(
      `SELECT id, ts, directive_id, task_id, loop_id, payload, action_artifact_id, verifier_artifact_id, predicted_residual
       FROM events
       WHERE kind = 'action_predicted' AND directive_id = ? AND task_id = ?
       ORDER BY ts DESC, rowid DESC LIMIT 1`,
    )
    .get(directiveId, taskId) as EventRow | null;
};

const latestClosureFor = (db: Database, directiveId: string, taskId: string): { id: string; residual: number } | null => {
  const rows = db
    .query(
      `SELECT id, payload FROM events
       WHERE kind = 'task_closure_audited' AND directive_id = ? AND task_id = ?
       ORDER BY ts DESC, rowid DESC`,
    )
    .all(directiveId, taskId) as Array<Pick<EventRow, "id" | "payload">>;
  for (const row of rows) {
    const residual = asNumber(parsePayload(row.payload).closure_residual);
    if (residual !== null) return { id: row.id, residual };
  }
  return null;
};

const loadSuccessfulTrajectories = async (db: Database): Promise<{ scanned: number; trajectories: SuccessfulTrajectory[] }> => {
  // Bounded scan per KC GJ2KN1J3KD1Z: window the action_scored set to
  // the last TRAJECTORY_SCAN_WINDOW_DAYS days and cap at
  // TRAJECTORY_SCAN_LIMIT rows. Older successes are already credited
  // in earlier ticks via the idempotency check on cluster_key +
  // source_action_scored_ids; rescanning them every cycle was pure
  // cost.
  const cutoffIso = new Date(Date.now() - TRAJECTORY_SCAN_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const scoredRows = db
    .query(
      `SELECT id, ts, directive_id, task_id, loop_id, payload, residual
       FROM events
       WHERE kind = 'action_scored'
         AND ts >= ?
       ORDER BY ts ASC, rowid ASC
       LIMIT ?`,
    )
    .all(cutoffIso, TRAJECTORY_SCAN_LIMIT) as EventRow[];
  const trajectories: SuccessfulTrajectory[] = [];
  let processed = 0;
  for (const scored of scoredRows) {
    if (processed > 0 && processed % YIELD_INTERVAL_ROWS === 0) {
      await yieldToEventLoop();
    }
    processed += 1;
    const scoredResidual = typeof scored.residual === "number" ? scored.residual : asNumber(parsePayload(scored.payload).residual);
    if (scoredResidual === null || scoredResidual >= SUCCESS_RESIDUAL_THRESHOLD) continue;
    const predicted = latestPredictionFor(db, scored.directive_id, scored.task_id);
    if (!predicted) continue;
    const closure = latestClosureFor(db, scored.directive_id, scored.task_id);
    if (!closure || closure.residual >= CLOSURE_RESIDUAL_THRESHOLD) continue;
    const lessons = db
      .query(
        `SELECT id, payload FROM events
         WHERE kind = 'lesson_extracted' AND directive_id = ? AND task_id = ?
         ORDER BY ts ASC, rowid ASC`,
      )
      .all(scored.directive_id, scored.task_id) as Array<Pick<EventRow, "id" | "payload">>;
    if (lessons.length === 0) continue;
    const goal = taskGoalFor(db, scored.directive_id, scored.task_id);
    const goalShape = normalizeGoalShape(goal);
    for (const lesson of lessons) {
      const lessonPayload = parsePayload(lesson.payload);
      trajectories.push({
        directiveId: scored.directive_id,
        taskId: scored.task_id,
        loopId: scored.loop_id,
        scoredEventId: scored.id,
        scoredResidual,
        predictedEventId: predicted.id,
        actionArtifactId: predicted.action_artifact_id ?? null,
        verifierArtifactId: predicted.verifier_artifact_id ?? null,
        predictedResidual: typeof predicted.predicted_residual === "number" ? predicted.predicted_residual : null,
        closureEventId: closure.id,
        closureResidual: closure.residual,
        lessonEventId: lesson.id,
        lessonKind: asString(lessonPayload.lesson_kind) || asString(lessonPayload.kind) || "lesson",
        lessonSummary: asString(lessonPayload.summary) || asString(lessonPayload.proposed_action) || "successful lesson",
        goal,
        goalShape,
        ts: scored.ts,
      });
    }
  }
  return { scanned: scoredRows.length, trajectories };
};

const sourceIds = (cluster: SuccessfulTrajectory[]): string[] => cluster.map((trajectory) => trajectory.scoredEventId);
const sameIds = (a: unknown, b: string[]): boolean => Array.isArray(a) && a.length === b.length && a.every((value, index) => value === b[index]);

const existingCompressions = (db: Database, clusterKey: string): Array<{ id: string; sourceIds: string[] }> => {
  // Bounded scan per KC GJ2KN1J3KD1Z: recipe-shaped knowledge rows
  // grow monotonically over the substrate's lifetime. Cap at the
  // EXISTING_COMPRESSION_SCAN_LIMIT most-recent rows; older
  // compressions for the same cluster_key would already have been
  // emitted and credited in prior ticks. Order changed to DESC so the
  // LIMIT keeps the most-recent compressions in view.
  const rows = db
    .query(
      `SELECT id, payload FROM events
       WHERE kind IN ('knowledge_candidate', 'knowledge_promoted')
         AND COALESCE(
           json_extract(payload, '$.recipe_shape.enabled'),
           json_extract(payload, '$.recipe.enabled'),
           json_extract(payload, '$.is_recipe'),
           0
         ) IN (1, 'true')
       ORDER BY ts DESC, rowid DESC
       LIMIT ?`,
    )
    .all(EXISTING_COMPRESSION_SCAN_LIMIT) as Array<{ id: string; payload: string }>;
  const out: Array<{ id: string; sourceIds: string[] }> = [];
  for (const row of rows) {
    const payload = parsePayload(row.payload);
    if (payload.extraction_kind !== "experience_compression_loop_v1" || payload.cluster_key !== clusterKey) continue;
    const ids = Array.isArray(payload.source_action_scored_ids)
      ? payload.source_action_scored_ids.filter((id): id is string => typeof id === "string")
      : [];
    out.push({ id: row.id, sourceIds: ids });
  }
  return out;
};

const average = (values: number[]): number => values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

const emitSupersedeRefusals = (db: Database, previous: Array<{ id: string; sourceIds: string[] }>, nextRecipeId: string, sampleSize: number): number => {
  let emitted = 0;
  for (const row of previous) {
    if (row.sourceIds.length >= sampleSize) continue;
    const already = db
      .query(
        `SELECT 1 FROM events
         WHERE kind = 'applied_change_committed'
           AND json_extract(payload, '$.source_event_id') = ?
           AND json_extract(payload, '$.reason') = 'compression_supersede'
         LIMIT 1`,
      )
      .get(row.id) as { 1: number } | null;
    if (already) continue;
    emitEvent(db, {
      kind: "applied_change_committed",
      substrate_origin: "substrate_auto",
      context_refs: [row.id, nextRecipeId],
      payload: {
        source_event_id: row.id,
        source_kind: "knowledge_candidate",
        recipe_shape: { enabled: true },
        status: "refused",
        reason: "compression_supersede",
        superseded_by_recipe_id: nextRecipeId,
      } as JsonValue,
    });
    emitted += 1;
  }
  return emitted;
};

const emitCompression = (db: Database, clusterKey: string, cluster: SuccessfulTrajectory[]): { recipeId: string; knowledge: number } => {
  const sorted = [...cluster].sort((a, b) => a.ts.localeCompare(b.ts));
  const first = sorted[0]!;
  const heldOut = sorted.slice(1);
  const ids = sourceIds(sorted);
  const contextRefs = Array.from(new Set(sorted.flatMap((trajectory) => [
    trajectory.predictedEventId,
    trajectory.scoredEventId,
    trajectory.closureEventId,
    trajectory.lessonEventId,
  ])));
  const heldOutResidual = heldOut.length === 0 ? 0.5 : average(heldOut.map((trajectory) => Math.max(trajectory.scoredResidual, trajectory.closureResidual)));
  const recipeConfidence = Math.max(0.55, Math.min(0.95, 1 - heldOutResidual));
  const trajectory = [{
    step_kind: "action_predicted",
    artifact_id: first.actionArtifactId,
    verifier_artifact_id: first.verifierArtifactId,
    predicted_residual: first.predictedResidual,
    payload_template: { goal_shape: first.goalShape },
  }];
  // Experience-compression now writes recipe-shaped knowledge_candidate rows
  // (universality proposal A12CR1QCDN0SS51CM95K39T45M absorbed the recipe_*
  // event family). recipe_shape.enabled lets the views project the row as a
  // reusable trajectory while keeping it a normal knowledge candidate.
  const recipe = emitEvent(db, {
    kind: "knowledge_candidate",
    substrate_origin: "substrate_auto",
    directive_id: first.directiveId,
    task_id: first.taskId,
    loop_id: first.loopId,
    context_refs: contextRefs,
    payload: {
      claim: `Repeated successful ${first.lessonKind} trajectories for ${first.goalShape} can be compressed into a reusable trajectory knowledge row.`,
      evidence: [`cluster_size=${sorted.length}`, `held_out_residual=${heldOutResidual}`],
      implications: ["Dispatcher may replay this trajectory through substrate_replay once posterior support catches up."],
      applies_to: ["reusable_trajectory", first.goalShape, first.lessonKind],
      confidence_estimate: recipeConfidence,
      // Top-level mirrors for legacy substrate readers.
      extraction_kind: "experience_compression_loop_v1",
      source_kind: "experience_compression",
      cluster_key: clusterKey,
      goal_shape: first.goalShape,
      topology_signature: clusterKey,
      lesson_kind: first.lessonKind,
      confidence: recipeConfidence,
      source_action_scored_ids: ids,
      source_lesson_ids: sorted.map((trajectory) => trajectory.lessonEventId),
      held_out_task_ids: heldOut.map((trajectory) => trajectory.taskId),
      held_out_evaluation: {
        residual: heldOutResidual,
        status: heldOut.length === 0 ? "pending_future_task" : "tested_against_future_tasks",
        sample_size: heldOut.length,
      },
      reliability_profile: {
        successful_trajectory_count: sorted.length,
        held_out_coverage: heldOut.length / sorted.length,
        reuse_first_compliance: 1,
        new_event_kind_count: 0,
      },
      trajectory,
      recipe_shape: {
        enabled: true,
        promotion_state: "experience_compression",
        extraction_kind: "experience_compression_loop_v1",
        source_kind: "experience_compression",
        cluster_key: clusterKey,
        goal_shape: first.goalShape,
        topology_signature: clusterKey,
        lesson_kind: first.lessonKind,
        confidence: recipeConfidence,
        source_action_scored_ids: ids,
        source_lesson_ids: sorted.map((trajectory) => trajectory.lessonEventId),
        held_out_task_ids: heldOut.map((trajectory) => trajectory.taskId),
        held_out_evaluation: {
          residual: heldOutResidual,
          status: heldOut.length === 0 ? "pending_future_task" : "tested_against_future_tasks",
          sample_size: heldOut.length,
        },
        reliability_profile: {
          successful_trajectory_count: sorted.length,
          held_out_coverage: heldOut.length / sorted.length,
          reuse_first_compliance: 1,
          new_event_kind_count: 0,
        },
        trajectory,
      },
    } as JsonValue,
  });
  emitEvent(db, {
    kind: "knowledge_candidate",
    substrate_origin: "substrate_auto",
    directive_id: first.directiveId,
    task_id: first.taskId,
    loop_id: first.loopId,
    context_refs: [recipe.id, ...contextRefs],
    payload: {
      source_kind: "experience_compression",
      extraction_kind: "experience_compression_loop_v1",
      cluster_key: clusterKey,
      cluster_size: sorted.length,
      source_action_scored_ids: ids,
      held_out_task_ids: heldOut.map((trajectory) => trajectory.taskId),
      claim: `Repeated successful ${first.lessonKind} trajectories for ${first.goalShape} can be compressed into a reusable recipe.`,
      evidence: sorted.map((trajectory) => `${trajectory.directiveId}/${trajectory.taskId}: action_residual=${trajectory.scoredResidual}; closure_residual=${trajectory.closureResidual}; lesson=${trajectory.lessonSummary}`),
      implications: [
        "Future matching tasks should try recipe replay before broader refinement work.",
        "Posterior updates on the emitted recipe and knowledge candidate close the credit loop without new event kinds.",
      ],
      applies_to: ["experience_compression_loop", first.goalShape, first.lessonKind],
      confidence_estimate: Math.max(0.5, Math.min(0.9, 1 - average(sorted.map((trajectory) => Math.max(trajectory.scoredResidual, trajectory.closureResidual))))),
      rlm_mechanism: "closure_learning",
      reliability_profile: {
        reuse_first_compliance: 1,
        dag_decomposition_compliance: 1,
        new_event_kind_count: 0,
      },
    } as JsonValue,
  });
  return { recipeId: recipe.id, knowledge: 1 };
};

const retireStaleLessons = async (db: Database, nowMs: number): Promise<number> => {
  const cutoffMs = nowMs - RETIREMENT_AGE_DAYS * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();
  // Bounded scan per KC GJ2KN1J3KD1Z: only walk lesson_extracted rows
  // already past the retirement cutoff. The retirement audit doesn't
  // need to see fresh lessons — they're not retire-eligible. Bounded
  // by LESSON_SCAN_LIMIT so a fresh install's catch-up cycle stays
  // short.
  const lessons = db
    .query(
      `SELECT id, ts, directive_id, task_id, loop_id FROM events
       WHERE kind = 'lesson_extracted'
         AND ts < ?
       ORDER BY ts ASC, rowid ASC
       LIMIT ?`,
    )
    .all(cutoffIso, LESSON_SCAN_LIMIT) as EventRow[];
  // applied_change_committed scan: cap at APPLY_SCAN_LIMIT most-recent
  // rows. If a lesson was already retired in a prior tick, the
  // refused/compression_supersede apply row is in scope (recent); old
  // applies that pre-date the lesson are irrelevant to the
  // has-history check (they cannot cite a lesson that didn't yet
  // exist).
  const applyRows = db
    .query(
      `SELECT payload, context_refs FROM events
       WHERE kind = 'applied_change_committed'
       ORDER BY ts DESC, rowid DESC
       LIMIT ?`,
    )
    .all(APPLY_SCAN_LIMIT) as Array<{ payload: string; context_refs: string }>;
  let retired = 0;
  let processed = 0;
  for (const lesson of lessons) {
    if (processed > 0 && processed % YIELD_INTERVAL_ROWS === 0) {
      await yieldToEventLoop();
    }
    processed += 1;
    const tsMs = Date.parse(lesson.ts);
    if (!Number.isFinite(tsMs) || tsMs >= cutoffMs) continue;
    const hasHistory = applyRows.some((row) => {
      const payload = parsePayload(row.payload);
      const refs = parseRefs(row.context_refs);
      return payload.source_event_id === lesson.id || refs.includes(lesson.id);
    });
    if (hasHistory) continue;
    emitEvent(db, {
      kind: "applied_change_committed",
      substrate_origin: "substrate_auto",
      directive_id: lesson.directive_id,
      task_id: lesson.task_id,
      loop_id: lesson.loop_id,
      context_refs: [lesson.id],
      payload: {
        source_event_id: lesson.id,
        source_kind: "lesson_extracted",
        status: "refused",
        reason: "compression_supersede",
      } as JsonValue,
    });
    retired += 1;
  }
  return retired;
};

export const experienceCompressionWorkerTick = async (db: Database, now: Date = new Date()): Promise<ExperienceCompressionWorkerResult> => {
  const loaded = await loadSuccessfulTrajectories(db);
  const clusters = new Map<string, SuccessfulTrajectory[]>();
  for (const trajectory of loaded.trajectories) {
    const key = compressionKey(trajectory.goalShape, trajectory.lessonKind);
    const current = clusters.get(key) ?? [];
    current.push(trajectory);
    clusters.set(key, current);
  }

  let clustersFound = 0;
  let recipesExtracted = 0;
  let knowledgeCandidates = 0;
  let skippedExistingCompression = 0;
  let supersededRefusals = 0;
  let processedClusters = 0;
  for (const [key, cluster] of clusters) {
    if (processedClusters > 0 && processedClusters % YIELD_INTERVAL_ROWS === 0) {
      await yieldToEventLoop();
    }
    processedClusters += 1;
    if (cluster.length < COMPRESSION_MIN_CLUSTER_SIZE) continue;
    clustersFound += 1;
    const sorted = [...cluster].sort((a, b) => a.ts.localeCompare(b.ts));
    const ids = sourceIds(sorted);
    const previous = existingCompressions(db, key);
    if (previous.some((row) => sameIds(row.sourceIds, ids))) {
      skippedExistingCompression += 1;
      continue;
    }
    const emitted = emitCompression(db, key, sorted);
    recipesExtracted += 1;
    knowledgeCandidates += emitted.knowledge;
    supersededRefusals += emitSupersedeRefusals(db, previous, emitted.recipeId, sorted.length);
  }

  const lessonsRetired = await retireStaleLessons(db, now.getTime());
  return {
    scanned_scored: loaded.scanned,
    eligible_trajectories: loaded.trajectories.length,
    recipes_extracted: recipesExtracted,
    knowledge_candidates: knowledgeCandidates,
    skipped_existing_compression: skippedExistingCompression,
    superseded_refusals: supersededRefusals,
    lessons_retired: lessonsRetired,
    trajectories_scanned: loaded.trajectories.length,
    clusters_found: clustersFound,
    candidates_emitted: recipesExtracted + knowledgeCandidates,
  };
};
