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
import type {
  DetectFatherDriftSchema,
  DispatchReadyTaskSchema,
  FatherIterateSchema,
  McpContext,
  McpResult,
  ProcessRollingReviewsSchema,
  RecentEventsSchema,
  ReplayRecipeSchema,
  SchedulerTickSchema,
} from "./types";

export const handleSchedulerTick = async (
  ctx: McpContext,
  args: z.infer<typeof SchedulerTickSchema>,
): Promise<McpResult> => {
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
  const taskRow = ctx.db
    .query("SELECT directive_id, payload FROM events WHERE task_id = ? AND kind = 'task_node_opened' LIMIT 1")
    .get(args.task_id) as { directive_id: string; payload: string } | null;
  if (!taskRow) return { ok: false, error: "task_not_found" };
  let goal = "";
  try {
    const p = JSON.parse(taskRow.payload ?? "{}") as Record<string, unknown>;
    goal = (p.goal as string | undefined) ?? "";
  } catch { /* swallow */ }

  const recipeRow = ctx.db
    .query("SELECT payload FROM events WHERE id = ? AND kind = 'recipe_extracted'")
    .get(args.recipe_id) as { payload: string } | null;
  if (!recipeRow) return { ok: false, error: "recipe_not_found" };
  let recipePayload: Record<string, unknown> = {};
  try { recipePayload = JSON.parse(recipeRow.payload ?? "{}") as Record<string, unknown>; } catch { /* swallow */ }
  const match = {
    recipe_id: args.recipe_id,
    recipe_extracted_event_id: args.recipe_id,
    goal_shape: (recipePayload.goal_shape as string | undefined) ?? "",
    topology_signature: (recipePayload.topology_signature as string | undefined) ?? "",
    confidence: (recipePayload.confidence as number | undefined) ?? 0,
    trajectory: ((recipePayload.trajectory as unknown[]) ?? []) as Array<{
      step_kind: string;
      artifact_id?: string | null;
      verifier_artifact_id?: string | null;
      payload_template: JsonValue;
      predicted_residual?: number | null;
    }>,
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
  let rows: Array<Record<string, unknown>>;
  if (kinds.length > 0) {
    const placeholders = kinds.map(() => "?").join(",");
    rows = ctx.db
      .query(
        `SELECT id, ts, kind, directive_id, task_id, substrate_origin, payload
         FROM events
         WHERE kind IN (${placeholders})
         ORDER BY ts DESC
         LIMIT ?`,
      )
      .all(...kinds, k) as Array<Record<string, unknown>>;
  } else {
    rows = ctx.db
      .query(
        `SELECT id, ts, kind, directive_id, task_id, substrate_origin, payload
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
    payload: JSON.parse((r.payload as string) ?? "{}") as JsonValue,
  }));
  return { ok: true, result: { events } as unknown as JsonValue };
};
