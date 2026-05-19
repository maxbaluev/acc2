// acc2 MCP server — runtime.* tool handlers. Split out of the
// monolithic runtime/mcp_server.ts so the seven runtime-facing methods
// can evolve independently from the substrate-side tools.
//
// Every handler returns `McpResult` (`{ok: true, result} | {ok: false,
// error}`); the bootstrap layer JSON-stringifies the result so the wire
// shape is uniform across tools.

import type { z } from "zod";
import type { JsonValue } from "../../substrate/types";
import { dispatchReadyTask } from "../task_dispatcher";
import { readDagForDirective } from "../task_topology";
import { schedulerTick } from "../task_scheduler";
import { processRollingReviews } from "../rolling_reviewer";
import { fatherIterate, detectFatherDrift } from "../father";
import { replayRecipe } from "../recipe_replay";
import {
  buildBrainSelfAudit,
  buildPromptSelfInspect,
  buildSystemMap,
  buildTrajectoryReplay,
  brainSelfAuditToJson,
  promptSelfInspectToJson,
  systemMapToJson,
  trajectoryReplayToJson,
} from "../brain_introspection";
import type {
  BrainSelfAuditSchema,
  DetectFatherDriftSchema,
  DispatchReadyTaskSchema,
  FatherIterateSchema,
  McpContext,
  McpResult,
  ProcessRollingReviewsSchema,
  PromptSelfInspectSchema,
  RecentEventsSchema,
  ReplayRecipeSchema,
  SchedulerTickSchema,
  SystemMapSchema,
  TrajectoryReplaySchema,
} from "./types";

/** runtime.* control-plane tools the brain (opencode) is NOT allowed to
 *  call. Live evidence (2026-05-15) showed the brain invoking these via
 *  MCP to trigger MORE brain dispatches inside its own cycle — a tight
 *  feedback loop that produced cascading bridge_stuck / mcp_handshake
 *  failures and blocked the daemon's MCP server.
 *
 *  The brain operates within ONE cycle per dispatch (§3.7). Triggering a
 *  scheduler tick, father iteration, recipe replay, or another dispatch
 *  from inside its current cycle violates the cycle-1-only contract AND
 *  the depth-1-retrieval contract. These are daemon-internal control
 *  surfaces; the brain emits events + reads views, nothing more. */
const brainForbiddenRuntimeOp = (ctx: McpContext, opName: string): McpResult | null => {
  if (ctx.invoker === "opencode" || ctx.invoker === "recipe") {
    return {
      ok: false,
      error: `brain_forbidden_runtime_op:${opName}; the brain emits events and reads views — control-plane tools are daemon-internal`,
    };
  }
  return null;
};

export const handleSchedulerTick = async (
  ctx: McpContext,
  args: z.infer<typeof SchedulerTickSchema>,
): Promise<McpResult> => {
  const blocked = brainForbiddenRuntimeOp(ctx, "runtime.scheduler_tick");
  if (blocked) return blocked;
  const tick = await schedulerTick(ctx.db, {
    maxConcurrent: args.max_concurrent,
    directiveId: args.directive_id,
    fixtureTargetPath: args.fixture_target_path,
  });
  return {
    ok: true,
    result: {
      dispatched: tick.dispatched,
      in_flight: tick.in_flight,
      skipped_concurrency_cap: tick.skipped_concurrency_cap,
      skipped_recipe: tick.skipped_recipe,
      skipped_inline: tick.skipped_inline,
      skipped_blocked: tick.skipped_blocked,
    } as JsonValue,
  };
};

export const handleDispatchReadyTask = async (
  ctx: McpContext,
  args: z.infer<typeof DispatchReadyTaskSchema>,
): Promise<McpResult> => {
  const blocked = brainForbiddenRuntimeOp(ctx, "runtime.dispatch_ready_task");
  if (blocked) return blocked;
  // Resolve the TaskNode for the supplied task_id by walking the directive's
  // DAG. The dispatcher needs goal + directive_id + status, which readDag
  // provides.
  const rows = ctx.db
    .query(
      "SELECT directive_id FROM events WHERE task_id = ? AND kind = 'task_node_opened' LIMIT 1",
    )
    .get(args.task_id) as { directive_id: string } | null;
  if (!rows) {
    return { ok: false, error: "task_not_found" };
  }
  const { nodes } = readDagForDirective(ctx.db, rows.directive_id);
  const node = nodes.find((n) => n.id === args.task_id);
  if (!node) {
    return { ok: false, error: "task_not_found_in_dag" };
  }
  const result = await dispatchReadyTask(ctx.db, node, {
    fixtureTargetPath: args.fixture_target_path,
  });
  return {
    ok: true,
    result: {
      dispatch_id: result.dispatch_id,
      task_id: result.task_id,
      events_count: result.events.length,
      violations: result.violations,
      bridge_ok: result.bridge_result?.ok ?? null,
    } as JsonValue,
  };
};

export const handleProcessRollingReviews = async (
  ctx: McpContext,
  args: z.infer<typeof ProcessRollingReviewsSchema>,
): Promise<McpResult> => {
  const blocked = brainForbiddenRuntimeOp(ctx, "runtime.process_rolling_reviews");
  if (blocked) return blocked;
  const summary = await processRollingReviews(ctx.db, args.now);
  return {
    ok: true,
    result: {
      reviews_opened: summary.reviews_opened,
      missed_advanced: summary.missed_advanced,
    } as JsonValue,
  };
};

// ── Phase J + K handlers ──────────────────────────────────────────

export const handleFatherIterate = async (
  ctx: McpContext,
  args: z.infer<typeof FatherIterateSchema>,
): Promise<McpResult> => {
  const blocked = brainForbiddenRuntimeOp(ctx, "runtime.father_iterate");
  if (blocked) return blocked;
  const result = await fatherIterate(ctx.db, {
    now: args.now,
    ownerActiveWindowMs: args.owner_active_window_ms,
  });
  return {
    ok: true,
    result: {
      cycle_id: result.cycle_id,
      action: result.action,
      detail: result.detail,
      ts: result.ts,
    } as JsonValue,
  };
};

export const handleDetectFatherDrift = (
  ctx: McpContext,
  args: z.infer<typeof DetectFatherDriftSchema>,
): McpResult => {
  const report = detectFatherDrift(ctx.db, args.lookback_events);
  return {
    ok: true,
    result: {
      drift_count: report.drift_count,
      offending_event_ids: report.offending_event_ids,
    } as JsonValue,
  };
};

export const handleReplayRecipe = async (
  ctx: McpContext,
  args: z.infer<typeof ReplayRecipeSchema>,
): Promise<McpResult> => {
  const blocked = brainForbiddenRuntimeOp(ctx, "runtime.replay_recipe");
  if (blocked) return blocked;
  const taskRow = ctx.db
    .query("SELECT directive_id, payload FROM events WHERE task_id = ? AND kind = 'task_node_opened' LIMIT 1")
    .get(args.task_id) as { directive_id: string; payload: string } | null;
  if (!taskRow) return { ok: false, error: "task_not_found" };
  let goal = "";
  try {
    const p = JSON.parse(taskRow.payload ?? "{}") as Record<string, unknown>;
    goal = (p.goal as string | undefined) ?? "";
  } catch { /* swallow */ }

  // recipe-shape knowledge absorbed into knowledge_candidate / knowledge_promoted
  // carrying recipe_shape (universality proposal A12CR1QCDN0SS51CM95K39T45M).
  const recipeRow = ctx.db
    .query("SELECT payload FROM events WHERE id = ? AND kind IN ('knowledge_candidate', 'knowledge_promoted')")
    .get(args.recipe_id) as { payload: string } | null;
  if (!recipeRow) return { ok: false, error: "reusable_trajectory_not_found" };
  let recipePayload: Record<string, unknown> = {};
  try { recipePayload = JSON.parse(recipeRow.payload ?? "{}") as Record<string, unknown>; } catch { /* swallow */ }
  // Prefer top-level mirrors; fall back to recipe_shape nested if present.
  const recipeShape = (recipePayload.recipe_shape && typeof recipePayload.recipe_shape === "object")
    ? recipePayload.recipe_shape as Record<string, unknown>
    : {};
  const trajectoryRaw =
    (recipePayload.trajectory as unknown[]) ??
    (recipeShape.trajectory as unknown[]) ??
    [];
  const trajectory = trajectoryRaw as Array<{
    step_kind: string;
    artifact_id?: string | null;
    verifier_artifact_id?: string | null;
    payload_template: JsonValue;
    predicted_residual?: number | null;
  }>;
  const cited: string[] = [];
  for (const step of trajectory) {
    if (step.artifact_id) cited.push(step.artifact_id);
    if (step.verifier_artifact_id) cited.push(step.verifier_artifact_id);
  }
  const match = {
    recipe_id: args.recipe_id,
    recipe_knowledge_event_id: args.recipe_id,
    knowledge_id: args.recipe_id,
    goal_shape: (recipePayload.goal_shape as string | undefined)
      ?? (recipeShape.goal_shape as string | undefined)
      ?? "",
    topology_signature: (recipePayload.topology_signature as string | undefined)
      ?? (recipeShape.topology_signature as string | undefined)
      ?? "",
    confidence: (recipePayload.confidence as number | undefined)
      ?? (recipeShape.confidence as number | undefined)
      ?? 0,
    trajectory,
    cited_act_artifact_ids: Array.from(new Set(cited)),
  };
  const task = { id: args.task_id, directive_id: taskRow.directive_id, parent_id: null, goal, status: "pending" as const };
  const outcome = await replayRecipe(ctx.db, task, match);
  return {
    ok: true,
    result: {
      task_committed: outcome.task_committed,
      residuals: outcome.residuals,
      emitted_event_ids: outcome.emitted_event_ids,
      abort_reason: outcome.abort_reason ?? null,
    } as JsonValue,
  };
};

// ── runtime.recent_events ──────────────────────────────────────────
//
// Initial-buffer fill for `acc watch`: returns the most recent K events
// (default 30, max 200), optionally filtered by kind. Used by the TUI
// before its SSE subscription has caught up. Pure SQL read; no bus
// involvement.

export const handleRecentEvents = (
  ctx: McpContext,
  args: z.infer<typeof RecentEventsSchema>,
): McpResult => {
  const k = Math.max(1, Math.min(200, args.k ?? 30));
  const kinds = (args.kinds ?? []).filter((s) => typeof s === "string" && s.length > 0);
  // FOUNDATIONAL FIX 2026-05-17: SELECT all top-level act-loop columns
  // (action_artifact_id, verifier_artifact_id, predicted_residual, outcome,
  // residual, failure_kind) — pre-fix only the basic columns + payload were
  // returned, so downstream consumers (acc tail renderer, acc watch TUI,
  // alignment tests) read undefined for the act-loop tuple even when the
  // brain emitted it correctly at top-level. The substrate stores these in
  // dedicated columns; the API must surface them.
  const SELECT_COLUMNS = "id, ts, kind, directive_id, task_id, substrate_origin, payload, action_artifact_id, verifier_artifact_id, predicted_residual, outcome, residual, failure_kind, invoker, parent_task_id, loop_id";
  let rows: Array<Record<string, unknown>>;
  if (kinds.length > 0) {
    const placeholders = kinds.map(() => "?").join(",");
    rows = ctx.db
      .query(
        `SELECT ${SELECT_COLUMNS}
         FROM events
         WHERE kind IN (${placeholders})
         ORDER BY ts DESC
         LIMIT ?`,
      )
      .all(...kinds, k) as Array<Record<string, unknown>>;
  } else {
    rows = ctx.db
      .query(
        `SELECT ${SELECT_COLUMNS}
         FROM events
         ORDER BY ts DESC
         LIMIT ?`,
      )
      .all(k) as Array<Record<string, unknown>>;
  }
  // Return ts-ascending so the TUI can append straight into its buffer.
  const events = rows.reverse().map((r) => ({
    event_id: r.id as string,
    ts: r.ts as string,
    kind: r.kind as string,
    directive_id: r.directive_id as string,
    task_id: r.task_id as string,
    substrate_origin: r.substrate_origin as string,
    invoker: r.invoker as string | null,
    parent_task_id: r.parent_task_id as string | null,
    loop_id: r.loop_id as string | null,
    // Top-level act-loop columns (null when not applicable to the kind).
    action_artifact_id: r.action_artifact_id as string | null,
    verifier_artifact_id: r.verifier_artifact_id as string | null,
    predicted_residual: r.predicted_residual as number | null,
    outcome: r.outcome as string | null,
    residual: r.residual as number | null,
    failure_kind: r.failure_kind as string | null,
    payload: JSON.parse((r.payload as string) ?? "{}") as JsonValue,
  }));
  return { ok: true, result: { events } as unknown as JsonValue };
};

// ── Brain self-introspection handlers (Phase 1 brain harness rewrite) ──
//
// Four READ-ONLY tools the brain MAY (and is taught to) invoke. Unlike
// the control-plane handlers above, these expose substrate STRUCTURE
// and BRAIN PERFORMANCE — no side effects, no mutation, safe at any
// recursion depth. Each delegates to runtime/brain_introspection.ts so
// the projection logic stays in one auditable module.

export const handleSystemMap = (
  ctx: McpContext,
  args: z.infer<typeof SystemMapSchema>,
): McpResult => {
  const map = buildSystemMap(ctx.db, { artifactTopK: args.artifact_top_k });
  return { ok: true, result: systemMapToJson(map) };
};

export const handleBrainSelfAudit = (
  ctx: McpContext,
  args: z.infer<typeof BrainSelfAuditSchema>,
): McpResult => {
  const audit = buildBrainSelfAudit(ctx.db, { windowHours: args.window_hours });
  return { ok: true, result: brainSelfAuditToJson(audit) };
};

export const handleTrajectoryReplay = (
  ctx: McpContext,
  args: z.infer<typeof TrajectoryReplaySchema>,
): McpResult => {
  const replay = buildTrajectoryReplay(ctx.db, args.directive_id);
  if (!replay) return { ok: false, error: "directive_not_found" };
  return { ok: true, result: trajectoryReplayToJson(replay) };
};

export const handlePromptSelfInspect = (
  ctx: McpContext,
  args: z.infer<typeof PromptSelfInspectSchema>,
): McpResult => {
  const inspect = buildPromptSelfInspect(ctx.db, args.task_id, {
    budgetTokens: args.budget_tokens,
    includePreview: args.include_preview,
  });
  if (!inspect) return { ok: false, error: "task_not_found" };
  return { ok: true, result: promptSelfInspectToJson(inspect) };
};
