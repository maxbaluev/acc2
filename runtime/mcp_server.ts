// acc2 MCP server — fastmcp-based, exposed as native MCP tools.
//
// Per v2-design.md §11.1 the daemon hosts ONE MCP server that BOTH Claude Code
// and opencode connect to as native MCP clients. This file constructs that
// server using `fastmcp` (https://github.com/punkpeye/fastmcp). Each substrate
// method (`substrate.emit`, `substrate.read`, `substrate.get_event`,
// `substrate.get_artifact`, `substrate.search`, `substrate.run_artifact`,
// `substrate.run_verifier`, `substrate.credit`) is exposed as a fastmcp tool
// with a `z.object(...)` parameter schema; `execute` returns a JSON-stringified
// `McpResult` so callers see one uniform `{ok, result|error}` shape.
//
// Phases (substrate-API surface only — wire-up is in daemon.ts):
//   - B3 (now): substrate.emit, substrate.read (stub), substrate.get_event,
//     substrate.get_artifact, substrate.search (recent-events stand-in).
//   - C: substrate.run_artifact / substrate.run_verifier (lit up by the
//     bun runtime + sandbox + artifact_store) — still stubs here.
//   - H: substrate.credit (the credit pipeline) — still a stub here.
//
// Transport choices:
//   - `httpStream` for daemon production (Claude Code + opencode connect over
//     a port; fastmcp's HTTP streaming transport is the MCP-standard wire).
//   - `stdio` for in-process tests (spawn the same FastMCP instance, attach an
//     MCP Client via StdioClientTransport, list/call tools). This is the same
//     binary; only the transport differs.

import type { Database } from "bun:sqlite";
import { FastMCP } from "fastmcp";
import { z } from "zod";
import type { JsonValue, Runtime, SandboxDecl, SubstrateOrigin } from "../substrate/types";
import { emitEvent, getEventById, type EmitEventInput } from "./events";
import { runBunArtifact } from "./runtimes/bun";
import { runUvArtifact } from "./runtimes/uv";
import { runCamofoxArtifact } from "./runtimes/camofox";
import { getArtifact } from "./artifact_store";
import { admitArtifact } from "./artifact_admission";
import { dispatchReadyTask } from "./task_dispatcher";
import { distributeCredit } from "./credit";
import { openFixtureDCountTodos } from "./fixtures/d_count_todos";
import { readDagForDirective } from "./task_topology";
import { schedulerTick } from "./task_scheduler";
import { emitAndApplyAmendment } from "./amendment_handler";
import { computeEmbedding } from "./embedder";
import { retrieve } from "./retrieval";
import type { EmbeddingIndex } from "./embedding_index";
import { recordStakeholderState, type StakeholderVisibility } from "./stakeholder_compositor";
import { recordInterferenceEdge, type InterferenceEdgeKind } from "./interference";
import { processRollingReviews } from "./rolling_reviewer";
import { fatherIterate, detectFatherDrift } from "./father";
import { findRecipeMatch, replayRecipe } from "./recipe_replay";
import { newId } from "./ids";
import {
  codeArtifactRegistry,
  readyTasks,
  taskGraphFor,
  failureCounts,
  artifactRouting,
  stakeholderStateRows,
  activeObjectives,
  rollingReviewDue,
  directiveConflicts,
  irreversibleEffects,
  embeddingIndex,
  originPromotion,
  ownerConversation,
  lowRiskInlinePatterns,
} from "../substrate/views";

export type McpContext = {
  db: Database;
  /** Caller for any audit event we synthesize. CLI clients default to
   *  `claude_root`; the brain bridge tags `opencode`. */
  invoker: SubstrateOrigin;
  /** Optional embedding index handle. When present AND size > 0 the
   *  search tool routes through the reranker; otherwise it falls back to
   *  the recency stand-in (which stays correct on fresh / unembedded
   *  substrates). */
  index?: EmbeddingIndex | null;
  /** Optional handle on the daemon's external-ingress state. When
   *  present, `substrate.register_external_source` mutates this state.
   *  Tests that don't run the daemon may leave this null. */
  ingressState?: import("./external_ingress").ExternalIngressState | null;
};

export type McpResult =
  | { ok: true; result: JsonValue }
  | { ok: false; error: string };

// ── Method names (single source of truth for the whitelist) ────────

export const McpMethods = [
  "substrate.emit",
  "substrate.read",
  "substrate.get_event",
  "substrate.get_artifact",
  "substrate.search",
  "substrate.embed_text",
  "substrate.run_artifact",
  "substrate.run_verifier",
  "substrate.credit",
  "substrate.admit_artifact",
  "substrate.open_fixture",
  "substrate.amend_directive",
  "substrate.record_stakeholder_state",
  "substrate.record_interference_edge",
  "substrate.open_directive",
  "runtime.dispatch_ready_task",
  "runtime.scheduler_tick",
  "runtime.process_rolling_reviews",
  "runtime.father_iterate",
  "runtime.detect_father_drift",
  "substrate.find_recipe",
  "runtime.replay_recipe",
  "substrate.register_external_source",
  "runtime.recent_events",
] as const;
export type McpMethodName = (typeof McpMethods)[number];

// ── Parameter schemas (zod, per v2-design.md §13.2) ────────────────

// substrate.emit accepts an `event` object, OR — for ergonomic CLI use — the
// event fields directly at the top level. Both shapes are supported; the
// `event` wrapper takes precedence when present.
const EmitEventSchema = z.object({
  kind: z.string(),
  payload: z.unknown().optional(),
  directive_id: z.string().optional(),
  task_id: z.string().optional(),
  parent_task_id: z.string().nullable().optional(),
  loop_id: z.string().optional(),
  substrate_origin: z.string().optional(),
  context_refs: z.array(z.string()).optional(),
  predicted_residual: z.number().optional(),
  action_artifact_id: z.string().optional(),
  verifier_artifact_id: z.string().optional(),
  outcome: z.string().optional(),
  residual: z.number().optional(),
});

const EmitSchema = z.object({
  event: EmitEventSchema.optional(),
  // Top-level fallback (mirrors EmitEventSchema, all optional except `kind`
  // which the handler validates from whichever surface is present).
  kind: z.string().optional(),
  payload: z.unknown().optional(),
  directive_id: z.string().optional(),
  task_id: z.string().optional(),
  parent_task_id: z.string().nullable().optional(),
  loop_id: z.string().optional(),
  substrate_origin: z.string().optional(),
  context_refs: z.array(z.string()).optional(),
});

const ReadSchema = z.object({
  view_name: z.string(),
  args: z.unknown().optional(),
});

const IdSchema = z.object({
  id: z.string(),
});

const SearchSchema = z.object({
  query: z.string(),
  opts: z
    .object({
      k: z.number().optional(),
      runtime: z.string().optional(),
      min_score: z.number().optional(),
      kind_filter: z.array(z.string()).optional(),
    })
    .optional(),
});

const EmbedTextSchema = z.object({
  text: z.string(),
});

const RunArtifactSchema = z.object({
  artifact_id: z.string(),
  inputs: z.unknown().optional(),
  // Legacy alias from B3 surface — accepted for backwards compatibility with
  // any caller that still sends `input` (singular).
  input: z.unknown().optional(),
  budget: z
    .object({
      wall_ms: z.number().optional(),
      memory_mb: z.number().optional(),
    })
    .optional(),
});

const RunVerifierSchema = z.object({
  verifier_artifact_id: z.string(),
  observation: z.unknown().optional(),
  budget: z
    .object({
      wall_ms: z.number().optional(),
      memory_mb: z.number().optional(),
    })
    .optional(),
});

const AdmitArtifactSchema = z.object({
  runtime: z.enum(["bun", "uv", "camofox-browser"]),
  body: z.string(),
  declared_sandbox: z.unknown(),
  fixture_input: z.unknown(),
  fixture_expected_residual_below: z.number().optional(),
  state_root: z.string().optional(),
  name: z.string().optional(),
});

const CreditSchema = z.object({
  action_event_id: z.string(),
  observation_event_id: z.string(),
  scored_event_id: z.string(),
  predicted_residual: z.number(),
  observed_residual: z.number(),
});

const OpenFixtureSchema = z.object({
  fixture: z.literal("d_count_todos"),
  target_path: z.string().optional(),
});

const DispatchReadyTaskSchema = z.object({
  task_id: z.string(),
  fixture_target_path: z.string().optional(),
});

const SchedulerTickSchema = z.object({
  max_concurrent: z.number().optional(),
  directive_id: z.string().optional(),
  fixture_target_path: z.string().optional(),
});

const AmendDirectiveSchema = z.object({
  original_directive_id: z.string(),
  amendment_text: z.string(),
  superseded_tasks: z.array(z.string()).optional(),
  superseded_predictions: z.array(z.string()).optional(),
  new_task_goals: z.array(z.string()).optional(),
  rationale: z.string().optional(),
  amended_by: z.enum(["owner", "claude_root", "opencode"]).optional(),
});

const RecordStakeholderStateSchema = z.object({
  directive_id: z.string(),
  stakeholder_id: z.string(),
  declared_utility: z.unknown(),
  inferred_constraints: z.array(z.string()).optional(),
  information_visibility: z.enum(["full", "limited", "blind"]).optional(),
});

const RecordInterferenceEdgeSchema = z.object({
  from_directive: z.string(),
  to_directive: z.string(),
  kind: z.enum(["blocks", "watches", "depletes"]),
  reason: z.string(),
});

const OpenDirectiveSchema = z.object({
  directive_text: z.string(),
  lifecycle: z.enum(["finite", "rolling_active"]).optional(),
  urgency: z.enum(["normal", "elevated", "crisis"]).optional(),
  review_cadence: z.enum(["daily", "weekly", "monthly", "quarterly", "annually"]).optional(),
  next_review_due: z.string().optional(),
  initial_task_goal: z.string().optional(),
  stakeholders: z
    .array(
      z.object({
        stakeholder_id: z.string(),
        declared_utility: z.unknown(),
        inferred_constraints: z.array(z.string()).optional(),
        information_visibility: z.enum(["full", "limited", "blind"]).optional(),
      }),
    )
    .optional(),
});

const ProcessRollingReviewsSchema = z.object({
  now: z.string().optional(),
  max_missed_reviews: z.number().optional(),
});

const FatherIterateSchema = z.object({
  now: z.string().optional(),
  owner_active_window_ms: z.number().optional(),
});

const DetectFatherDriftSchema = z.object({
  lookback_events: z.number().optional(),
});

const FindRecipeSchema = z.object({
  task_id: z.string(),
  min_confidence: z.number().optional(),
});

const ReplayRecipeSchema = z.object({
  task_id: z.string(),
  recipe_id: z.string(),
});

const RegisterExternalSourceSchema = z.object({
  name: z.string(),
  bearer_token: z.string(),
  schema_hint: z.string().optional(),
  rate_limit_per_min: z.number().optional(),
  default_sensitivity: z.enum(["public", "internal", "private"]).optional(),
});

const RecentEventsSchema = z.object({
  k: z.number().optional(),
  kinds: z.array(z.string()).optional(),
});

// ── Handlers (pure functions over (ctx, args) → McpResult) ──────────
//
// fastmcp's `execute` calls these and JSON-stringifies the result; this
// keeps every method behind a uniform `{ok, …}` envelope so callers can
// pattern-match one shape regardless of which tool they called.

const handleEmit = (
  ctx: McpContext,
  args: z.infer<typeof EmitSchema>,
): McpResult => {
  // Accept either `{event: {…}}` or flat top-level fields.
  const src = args.event ?? args;
  const kind = src.kind;
  if (!kind || typeof kind !== "string") {
    return { ok: false, error: "missing 'kind'" };
  }
  const input: EmitEventInput = {
    kind: kind as EmitEventInput["kind"],
    substrate_origin:
      (src.substrate_origin as SubstrateOrigin | undefined) ?? ctx.invoker,
    directive_id: src.directive_id,
    task_id: src.task_id,
    parent_task_id: src.parent_task_id ?? undefined,
    loop_id: src.loop_id,
    payload: (src.payload as JsonValue) ?? {},
    context_refs: src.context_refs,
    invoker: ctx.invoker,
  };
  // Optional fields that only exist on EmitEventSchema (not on the flat shape).
  if (args.event) {
    const e = args.event;
    input.predicted_residual = e.predicted_residual;
    input.action_artifact_id = e.action_artifact_id;
    input.verifier_artifact_id = e.verifier_artifact_id;
    input.outcome = e.outcome as EmitEventInput["outcome"];
    input.residual = e.residual;
  }
  const emitted = emitEvent(ctx.db, input);
  return { ok: true, result: { id: emitted.id, ts: emitted.ts } };
};

const handleRead = (
  ctx: McpContext,
  args: z.infer<typeof ReadSchema>,
): McpResult => {
  // Phase Audit: route `view_name` to the substrate/views.ts accessor.
  // Views not yet implemented return `view_not_implemented:<name>` so
  // callers see a clear signal instead of a silent empty. The set below
  // mirrors §4.2 of v2-design.md; views computed in TS (knowledge_view,
  // judgment_packet_view) still return view_not_implemented until their
  // accessors land.
  const db = ctx.db;
  const view = args.view_name;
  try {
    switch (view) {
      case "code_artifact_registry_view": {
        const arg = (args.args ?? {}) as Record<string, unknown>;
        const runtime = typeof arg.runtime === "string" ? arg.runtime : undefined;
        return { ok: true, result: codeArtifactRegistry(db, runtime) as unknown as JsonValue };
      }
      case "ready_tasks_view": {
        const arg = (args.args ?? {}) as Record<string, unknown>;
        const limit = typeof arg.limit === "number" ? arg.limit : undefined;
        return { ok: true, result: readyTasks(db, limit) as unknown as JsonValue };
      }
      case "task_graph_view": {
        const arg = (args.args ?? {}) as Record<string, unknown>;
        const directiveId = typeof arg.directive_id === "string" ? arg.directive_id : null;
        if (!directiveId) return { ok: false, error: "task_graph_view_requires_directive_id" };
        return { ok: true, result: taskGraphFor(db, directiveId) as unknown as JsonValue };
      }
      case "failure_view":
        return { ok: true, result: failureCounts(db) as unknown as JsonValue };
      case "artifact_routing_view": {
        const arg = (args.args ?? {}) as Record<string, unknown>;
        const runtime = typeof arg.runtime === "string" ? arg.runtime : undefined;
        return { ok: true, result: artifactRouting(db, runtime) as unknown as JsonValue };
      }
      case "stakeholder_state_view": {
        const arg = (args.args ?? {}) as Record<string, unknown>;
        const directiveId = typeof arg.directive_id === "string" ? arg.directive_id : undefined;
        return { ok: true, result: stakeholderStateRows(db, directiveId) as unknown as JsonValue };
      }
      case "active_objectives_view":
        return { ok: true, result: activeObjectives(db) as unknown as JsonValue };
      case "rolling_review_due_view":
        return { ok: true, result: rollingReviewDue(db) as unknown as JsonValue };
      case "directive_conflicts_view":
        return { ok: true, result: directiveConflicts(db) as unknown as JsonValue };
      case "irreversible_effects_view":
        return { ok: true, result: irreversibleEffects(db) as unknown as JsonValue };
      case "embedding_index_view":
        return { ok: true, result: embeddingIndex(db) as unknown as JsonValue };
      case "origin_promotion_view":
        return { ok: true, result: originPromotion(db) as unknown as JsonValue };
      case "owner_conversation_view": {
        const arg = (args.args ?? {}) as Record<string, unknown>;
        const directiveId = typeof arg.directive_id === "string" ? arg.directive_id : undefined;
        return { ok: true, result: ownerConversation(db, directiveId) as unknown as JsonValue };
      }
      case "contradictory_candidates_view": {
        const rows = db
          .query("SELECT * FROM contradictory_candidates_view ORDER BY ts DESC")
          .all() as Array<Record<string, unknown>>;
        return { ok: true, result: rows as unknown as JsonValue };
      }
      case "low_risk_inline_patterns_view": {
        return {
          ok: true,
          result: lowRiskInlinePatterns(db) as unknown as JsonValue,
        };
      }
      default:
        return { ok: false, error: `view_not_implemented:${view}` };
    }
  } catch (err) {
    return { ok: false, error: `view_read_failed:${(err as Error).message}` };
  }
};

const handleGetEvent = (
  ctx: McpContext,
  args: z.infer<typeof IdSchema>,
): McpResult => {
  const ev = getEventById(ctx.db, args.id);
  if (!ev) return { ok: false, error: "event_not_found" };
  return { ok: true, result: ev as unknown as JsonValue };
};

const handleGetArtifact = (
  ctx: McpContext,
  args: z.infer<typeof IdSchema>,
): McpResult => {
  const row = ctx.db
    .query("SELECT * FROM code_artifact WHERE id = ?")
    .get(args.id) as Record<string, unknown> | null;
  if (!row) return { ok: false, error: "artifact_not_found" };
  return {
    ok: true,
    result: {
      ...row,
      declared_sandbox: JSON.parse((row.declared_sandbox as string) ?? "{}"),
      fixture_input: JSON.parse((row.fixture_input as string) ?? "{}"),
    } as JsonValue,
  };
};

const handleSearch = async (
  ctx: McpContext,
  args: z.infer<typeof SearchSchema>,
): Promise<McpResult> => {
  const k = Math.max(1, Math.min(100, args.opts?.k ?? 20));

  // Phase F: when the daemon mounted an index AND it has entries, route
  // through the reranker. Otherwise fall back to the recency stand-in so
  // fresh substrates / no-API-key environments still return structurally-
  // correct hits.
  if (ctx.index && ctx.index.size() > 0) {
    const result = await retrieve(ctx.db, ctx.index, {
      text: args.query,
      k,
      runtime: args.opts?.runtime,
      minScore: args.opts?.min_score,
      kindFilter: args.opts?.kind_filter,
    });
    if (!result.query_embedding_unavailable) {
      return {
        ok: true,
        result: {
          hits: result.hits,
          mode: "rerank",
          query: args.query,
          mixed_version_excluded: result.mixed_version_excluded,
          retrieved_at: result.retrieved_at,
        } as JsonValue,
      };
    }
    // fall through to recency stand-in when query embedding unavailable
  }

  const rows = ctx.db
    .query(
      "SELECT id, ts, kind, directive_id, task_id, substrate_origin, payload " +
        "FROM events ORDER BY ts DESC LIMIT ?",
    )
    .all(k) as Array<Record<string, unknown>>;
  const hits = rows.map((r) => ({
    id: r.id as string,
    ts: r.ts as string,
    kind: r.kind as string,
    directive_id: r.directive_id as string,
    task_id: r.task_id as string,
    substrate_origin: r.substrate_origin as string,
    payload: JSON.parse((r.payload as string) ?? "{}") as JsonValue,
  }));
  return {
    ok: true,
    result: {
      hits,
      mode: "recent_events_stub",
      query: args.query,
    } as JsonValue,
  };
};

const handleEmbedText = async (
  _ctx: McpContext,
  args: z.infer<typeof EmbedTextSchema>,
): Promise<McpResult> => {
  const result = await computeEmbedding(args.text);
  if (!result) {
    return { ok: false, error: "embedding_unavailable" };
  }
  return {
    ok: true,
    result: {
      embedding: result.embedding,
      version: result.version,
      model: "text-embedding-3-small",
    } as JsonValue,
  };
};

// ── Phase C runtime handlers ──────────────────────────────────────
//
// substrate.run_artifact dispatches by the artifact's stored runtime:
//   - bun  → runBunArtifact (Phase C wires this)
//   - uv / camofox-browser → return `phase_g_runtime_unsupported`
// substrate.run_verifier is structurally identical — verifiers are just
// code artifacts whose body is expected to return `{residual: number}`.
// We do NOT enforce the shape; we pass the observation as inputs and let
// the verifier body decide what to do.
//
// Phase H wires substrate.credit. For Phase C we leave the stub error
// string in place so callers can still pattern-match — applyResidualOutcome
// is exposed to the substrate elsewhere (admission + future credit pipeline).

const callArtifactByRuntime = async (
  ctx: McpContext,
  artifactId: string,
  inputs: JsonValue,
  budget: { wall_ms?: number; memory_mb?: number } | undefined,
): Promise<McpResult> => {
  const row = getArtifact(ctx.db, artifactId);
  if (!row) return { ok: false, error: "artifact_not_found" };
  const decl = row.declaredSandbox;
  if (decl.runtime !== row.runtime) {
    return { ok: false, error: "sandbox_decl_runtime_mismatch" };
  }
  const emit = (event: EmitEventInput): void => {
    try {
      emitEvent(ctx.db, { ...event, invoker: event.invoker ?? ctx.invoker });
    } catch { /* event-emission failure must not poison the runtime */ }
  };
  let observation: {
    ok: boolean;
    result?: JsonValue;
    error?: string;
    durationMs: number;
    exitCode: number;
    stderrTail: string;
    sandboxWarnings: string[];
    irreversibleEffects: Array<{ kind: string; description: string }>;
  };
  if (row.runtime === "bun") {
    observation = await runBunArtifact({
      artifactId: row.id,
      body: row.body,
      declaredSandbox: decl as Extract<SandboxDecl, { runtime: "bun" }>,
      inputs,
      budget: { wallMs: budget?.wall_ms, memoryMb: budget?.memory_mb },
      emit,
    });
  } else if (row.runtime === "uv") {
    observation = await runUvArtifact({
      artifactId: row.id,
      body: row.body,
      declaredSandbox: decl as Extract<SandboxDecl, { runtime: "uv" }>,
      inputs,
      budget: { wallMs: budget?.wall_ms, memoryMb: budget?.memory_mb },
      emit,
    });
  } else {
    observation = await runCamofoxArtifact({
      artifactId: row.id,
      body: row.body,
      declaredSandbox: decl as Extract<SandboxDecl, { runtime: "camofox-browser" }>,
      inputs,
      budget: { wallMs: budget?.wall_ms, memoryMb: budget?.memory_mb },
      emit,
    });
  }
  return {
    ok: true,
    result: {
      ok: observation.ok,
      result: observation.result ?? null,
      error: observation.error ?? null,
      duration_ms: observation.durationMs,
      exit_code: observation.exitCode,
      stderr_tail: observation.stderrTail,
      sandbox_warnings: observation.sandboxWarnings,
      irreversible_effects: observation.irreversibleEffects,
    } as JsonValue,
  };
};

const handleRunArtifact = async (
  ctx: McpContext,
  args: z.infer<typeof RunArtifactSchema>,
): Promise<McpResult> => {
  const inputs = (args.inputs ?? args.input ?? null) as JsonValue;
  return callArtifactByRuntime(ctx, args.artifact_id, inputs, args.budget as { wall_ms?: number; memory_mb?: number } | undefined);
};

const handleRunVerifier = async (
  ctx: McpContext,
  args: z.infer<typeof RunVerifierSchema>,
): Promise<McpResult> => {
  const observation = (args.observation ?? null) as JsonValue;
  return callArtifactByRuntime(ctx, args.verifier_artifact_id, observation, args.budget as { wall_ms?: number; memory_mb?: number } | undefined);
};

const handleAdmitArtifact = async (
  ctx: McpContext,
  args: z.infer<typeof AdmitArtifactSchema>,
): Promise<McpResult> => {
  const runtime = args.runtime as Runtime;
  const decl = args.declared_sandbox as SandboxDecl;
  const result = await admitArtifact(
    ctx.db,
    {
      runtime,
      body: args.body,
      declaredSandbox: decl,
      fixtureInput: (args.fixture_input ?? null) as JsonValue,
      fixtureExpectedResidualBelow: args.fixture_expected_residual_below ?? 0.2,
      stateRoot: args.state_root,
      name: args.name,
    },
    (event) => {
      try {
        emitEvent(ctx.db, { ...event, invoker: event.invoker ?? ctx.invoker });
      } catch { /* swallow */ }
    },
  );
  if (result.ok) {
    return { ok: true, result: { artifact_id: result.artifactId } as JsonValue };
  }
  return { ok: false, error: `${result.reason}${result.detail ? `:${result.detail}` : ""}` };
};

const handleCredit = async (
  ctx: McpContext,
  args: z.infer<typeof CreditSchema>,
): Promise<McpResult> => {
  try {
    const result = await distributeCredit(ctx.db, {
      action_event_id: args.action_event_id,
      observation_event_id: args.observation_event_id,
      scored_event_id: args.scored_event_id,
      predicted_residual: args.predicted_residual,
      observed_residual: args.observed_residual,
    });
    return {
      ok: true,
      result: {
        action_artifact_id: result.action_artifact_id,
        verifier_artifact_id: result.verifier_artifact_id,
        predicted_residual: result.predicted_residual,
        observed_residual: result.observed_residual,
        delta: result.delta,
        contributions: result.contributions as unknown as JsonValue,
        emitted_events: result.emitted_events as unknown as JsonValue,
      } as JsonValue,
    };
  } catch (err) {
    return { ok: false, error: `credit_distribution_failed:${(err as Error).message}` };
  }
};

// ── Phase D handlers ──────────────────────────────────────────────

const handleOpenFixture = async (
  ctx: McpContext,
  args: z.infer<typeof OpenFixtureSchema>,
): Promise<McpResult> => {
  if (args.fixture !== "d_count_todos") {
    return { ok: false, error: `unknown_fixture:${args.fixture}` };
  }
  const result = await openFixtureDCountTodos(ctx.db, args.target_path);
  return {
    ok: true,
    result: {
      directive_id: result.directiveId,
      task_id: result.taskId,
    } as JsonValue,
  };
};

const handleSchedulerTick = async (
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

const handleAmendDirective = async (
  ctx: McpContext,
  args: z.infer<typeof AmendDirectiveSchema>,
): Promise<McpResult> => {
  const summary = await emitAndApplyAmendment(ctx.db, {
    original_directive_id: args.original_directive_id,
    amendment_text: args.amendment_text,
    superseded_tasks: args.superseded_tasks,
    superseded_predictions: args.superseded_predictions,
    new_task_goals: args.new_task_goals,
    rationale: args.rationale,
    amended_by: args.amended_by,
  });
  return {
    ok: true,
    result: {
      amendment_event_id: summary.amendment_event_id,
      superseded_tasks_closed: summary.superseded_tasks_closed,
      superseded_predictions_marked: summary.superseded_predictions_marked,
      new_tasks_opened: summary.new_tasks_opened,
      already_applied: summary.already_applied,
    } as JsonValue,
  };
};

const handleDispatchReadyTask = async (
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

const handleRecordStakeholderState = (
  ctx: McpContext,
  args: z.infer<typeof RecordStakeholderStateSchema>,
): McpResult => {
  const result = recordStakeholderState(ctx.db, {
    directive_id: args.directive_id,
    stakeholder_id: args.stakeholder_id,
    declared_utility: (args.declared_utility ?? null) as JsonValue,
    inferred_constraints: args.inferred_constraints,
    information_visibility: args.information_visibility as StakeholderVisibility | undefined,
  });
  return {
    ok: true,
    result: {
      event_id: result.event_id,
      conflict_count: result.conflicts.length,
      conflicts: result.conflicts as unknown as JsonValue,
    } as JsonValue,
  };
};

const handleRecordInterferenceEdge = (
  ctx: McpContext,
  args: z.infer<typeof RecordInterferenceEdgeSchema>,
): McpResult => {
  const result = recordInterferenceEdge(ctx.db, {
    from_directive: args.from_directive,
    to_directive: args.to_directive,
    kind: args.kind as InterferenceEdgeKind,
    reason: args.reason,
  });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  return { ok: true, result: { event_id: result.event_id } as JsonValue };
};

const handleOpenDirective = (
  ctx: McpContext,
  args: z.infer<typeof OpenDirectiveSchema>,
): McpResult => {
  const directiveId = newId();
  const taskId = newId();
  const lifecyclePayload: Record<string, unknown> = {
    directive_text: args.directive_text,
    lifecycle: args.lifecycle ?? "finite",
    urgency: args.urgency ?? "normal",
  };
  if (args.lifecycle === "rolling_active") {
    lifecyclePayload.review_cadence = args.review_cadence ?? "weekly";
    lifecyclePayload.next_review_due = args.next_review_due ?? new Date().toISOString();
    lifecyclePayload.partial_commit_checkpoints = [];
  }
  emitEvent(ctx.db, {
    kind: "directive_opened",
    substrate_origin: "owner",
    directive_id: directiveId,
    task_id: directiveId,
    payload: lifecyclePayload as JsonValue,
  });

  if (args.urgency === "crisis") {
    emitEvent(ctx.db, {
      kind: "crisis_mode_engaged",
      substrate_origin: "substrate_auto",
      directive_id: directiveId,
      payload: { reason: "directive_urgency_crisis" } as JsonValue,
    });
  }

  emitEvent(ctx.db, {
    kind: "task_node_opened",
    substrate_origin: "owner",
    directive_id: directiveId,
    task_id: taskId,
    parent_task_id: null,
    payload: {
      goal: args.initial_task_goal ?? args.directive_text,
      lifecycle: "finite",
      urgency: args.urgency ?? "normal",
    } as JsonValue,
  });

  const stakeholderEventIds: string[] = [];
  if (args.stakeholders) {
    for (const s of args.stakeholders) {
      const r = recordStakeholderState(ctx.db, {
        directive_id: directiveId,
        stakeholder_id: s.stakeholder_id,
        declared_utility: (s.declared_utility ?? null) as JsonValue,
        inferred_constraints: s.inferred_constraints,
        information_visibility: s.information_visibility as StakeholderVisibility | undefined,
      });
      stakeholderEventIds.push(r.event_id);
    }
  }

  return {
    ok: true,
    result: {
      directive_id: directiveId,
      task_id: taskId,
      stakeholder_event_ids: stakeholderEventIds,
    } as JsonValue,
  };
};

const handleProcessRollingReviews = async (
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

const handleFatherIterate = async (
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

const handleDetectFatherDrift = (
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

const handleFindRecipe = (
  ctx: McpContext,
  args: z.infer<typeof FindRecipeSchema>,
): McpResult => {
  const taskRow = ctx.db
    .query("SELECT directive_id FROM events WHERE task_id = ? AND kind = 'task_node_opened' LIMIT 1")
    .get(args.task_id) as { directive_id: string } | null;
  if (!taskRow) return { ok: false, error: "task_not_found" };
  const taskPayloadRow = ctx.db
    .query("SELECT payload FROM events WHERE task_id = ? AND kind = 'task_node_opened' LIMIT 1")
    .get(args.task_id) as { payload: string } | null;
  let goal = "";
  if (taskPayloadRow) {
    try {
      const p = JSON.parse(taskPayloadRow.payload ?? "{}") as Record<string, unknown>;
      goal = (p.goal as string | undefined) ?? "";
    } catch { /* swallow */ }
  }
  const match = findRecipeMatch(
    ctx.db,
    { id: args.task_id, directive_id: taskRow.directive_id, parent_id: null, goal, status: "pending" },
    { minConfidence: args.min_confidence },
  );
  if (!match) return { ok: true, result: null as unknown as JsonValue };
  return {
    ok: true,
    result: {
      recipe_id: match.recipe_id,
      goal_shape: match.goal_shape,
      topology_signature: match.topology_signature,
      confidence: match.confidence,
      trajectory_length: match.trajectory.length,
    } as JsonValue,
  };
};

const handleReplayRecipe = async (
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

const handleRegisterExternalSource = (
  ctx: McpContext,
  args: z.infer<typeof RegisterExternalSourceSchema>,
): McpResult => {
  if (!ctx.ingressState) {
    return { ok: false, error: "external_ingress_not_mounted" };
  }
  const { registerExternalSource } = require("./external_ingress") as typeof import("./external_ingress");
  const r = registerExternalSource(ctx.db, ctx.ingressState, args);
  if (!r.ok) return { ok: false, error: r.error };
  return {
    ok: true,
    result: { source: r.source, token_preview: r.token_preview } as JsonValue,
  };
};

// ── runtime.recent_events ──────────────────────────────────────────
//
// Initial-buffer fill for `acc watch`: returns the most recent K events
// (default 30, max 200), optionally filtered by kind. Used by the TUI
// before its SSE subscription has caught up. Pure SQL read; no bus
// involvement.

const handleRecentEvents = (
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

// ── FastMCP server factory ─────────────────────────────────────────

export type McpServerOptions = {
  db: Database;
  invoker?: SubstrateOrigin;
  name?: string;
  version?: `${number}.${number}.${number}`;
  /** Embedding index handed to substrate.search. The daemon builds this at
   *  boot via EmbeddingIndex.rebuildFromDb; tests can pass null. */
  index?: EmbeddingIndex | null;
  /** Optional external-ingress state — when provided, the MCP server
   *  exposes `substrate.register_external_source` so a new external source
   *  can be registered without restarting the daemon (§5.2). */
  ingressState?: import("./external_ingress").ExternalIngressState | null;
};

/** Build a FastMCP server with every substrate tool wired against `ctx.db`.
 *  The caller drives `.start({transportType, …})` — daemon uses `httpStream`,
 *  tests use `stdio`. The server holds no Database reference of its own; all
 *  state flows through `db` via the closure here. */
export const createMcpServer = (opts: McpServerOptions): FastMCP => {
  const ctx: McpContext = {
    db: opts.db,
    invoker: opts.invoker ?? "claude_root",
    index: opts.index ?? null,
    ingressState: opts.ingressState ?? null,
  };

  const server = new FastMCP({
    name: opts.name ?? "acc2-substrate",
    version: opts.version ?? "0.0.1",
    instructions:
      "AccInt v2 substrate. Every method returns `{ok, result|error}` " +
      "JSON-stringified. Read v2-design.md §11 + §13.2 for the protocol.",
  });

  // Each tool's `execute` returns `JSON.stringify(McpResult)` so the wire shape
  // is uniform regardless of which method was called. The MCP standard ships
  // text content; the test client / brain re-parses the JSON. Handlers can be
  // sync or async — we await the return so Phase C's runtime handlers (which
  // spawn subprocesses) plug in without contortion.
  const wrap =
    <A>(handler: (ctx: McpContext, args: A) => McpResult | Promise<McpResult>) =>
    async (args: unknown): Promise<string> => {
      try {
        const result = await handler(ctx, args as A);
        return JSON.stringify(result);
      } catch (err) {
        return JSON.stringify({
          ok: false,
          error: `handler_error:${(err as Error).message}`,
        } satisfies McpResult);
      }
    };

  server.addTool({
    name: "substrate.emit",
    description:
      "Emit one substrate event. Returns {ok, result:{id, ts}} on success.",
    parameters: EmitSchema,
    execute: wrap(handleEmit),
  });

  server.addTool({
    name: "substrate.read",
    description:
      "Read a named substrate view. (B3: every view returns " +
      "view_not_implemented; Phase B2/F lights up real dispatch.)",
    parameters: ReadSchema,
    execute: wrap(handleRead),
  });

  server.addTool({
    name: "substrate.get_event",
    description: "Fetch one event by id. Returns {ok, result: Event}.",
    parameters: IdSchema,
    execute: wrap(handleGetEvent),
  });

  server.addTool({
    name: "substrate.get_artifact",
    description:
      "Fetch one code_artifact row by id. JSON columns are pre-parsed.",
    parameters: IdSchema,
    execute: wrap(handleGetArtifact),
  });

  server.addTool({
    name: "substrate.search",
    description:
      "Search the substrate. Phase F: routes through the cosine × posterior " +
      "reranker when an embedding index is mounted; falls back to recent-events " +
      "stand-in on fresh / unembedded substrates. Supports kind_filter to scope.",
    parameters: SearchSchema,
    execute: wrap(handleSearch),
  });

  server.addTool({
    name: "substrate.embed_text",
    description:
      "Embed an arbitrary text via the same model the substrate indexes with " +
      "(text-embedding-3-small). Returns {embedding: number[], version, model}.",
    parameters: EmbedTextSchema,
    execute: wrap(handleEmbedText),
  });

  server.addTool({
    name: "substrate.run_artifact",
    description:
      "Run a code artifact through its declared runtime + sandbox. " +
      "Phase C: bun-runtime artifacts execute end-to-end; uv and " +
      "camofox-browser return phase_g_runtime_unsupported until Phase G.",
    parameters: RunArtifactSchema,
    execute: wrap(handleRunArtifact),
  });

  server.addTool({
    name: "substrate.run_verifier",
    description:
      "Run a verifier artifact against an observation; returns the " +
      "verifier's JSON output (expected shape `{residual: number}`). " +
      "Phase C wires bun verifiers; uv/camofox return phase_g_runtime_unsupported.",
    parameters: RunVerifierSchema,
    execute: wrap(handleRunVerifier),
  });

  server.addTool({
    name: "substrate.credit",
    description:
      "Distribute one action_scored outcome across cited knowledge + " +
      "code artifacts via Shapley decomposition by corroboration order " +
      "(§3.6.1 Rule 3). Returns the per-entity weights, Beta posterior " +
      "deltas, and ids of every emitted event.",
    parameters: CreditSchema,
    execute: wrap(handleCredit),
  });

  server.addTool({
    name: "substrate.admit_artifact",
    description:
      "Admit a new code artifact. Validates its sandbox declaration, runs " +
      "its fixture under the declared runtime, and on success inserts at " +
      "score=0.5/confidence=0.3. uv and camofox-browser admissions are " +
      "deferred to Phase G.",
    parameters: AdmitArtifactSchema,
    execute: wrap(handleAdmitArtifact),
  });

  server.addTool({
    name: "substrate.open_fixture",
    description:
      "Open a named test fixture directive. Phase D ships d_count_todos. " +
      "Returns {directive_id, task_id} so the caller can drive the dispatcher.",
    parameters: OpenFixtureSchema,
    execute: wrap(handleOpenFixture),
  });

  server.addTool({
    name: "runtime.dispatch_ready_task",
    description:
      "Dispatch one ready task through the single-cycle brain pipeline. " +
      "Phase D: composes prompt, calls mocked bridge, runs action + verifier, " +
      "emits action_scored + task_committed when residual < threshold.",
    parameters: DispatchReadyTaskSchema,
    execute: wrap(handleDispatchReadyTask),
  });

  server.addTool({
    name: "runtime.scheduler_tick",
    description:
      "Run one tick of the parallel scheduler. Picks up to max_concurrent " +
      "ready tasks (default 5), routes by dispatch lane, returns the per-tick " +
      "summary (dispatched / in_flight / skipped_*). Phase E.",
    parameters: SchedulerTickSchema,
    execute: wrap(handleSchedulerTick),
  });

  server.addTool({
    name: "substrate.amend_directive",
    description:
      "Emit a directive_amended event AND immediately apply it: supersede " +
      "the named tasks/predictions, open task_node_opened for each new_task_goals " +
      "entry, return the amendment summary. Phase E.",
    parameters: AmendDirectiveSchema,
    execute: wrap(handleAmendDirective),
  });

  server.addTool({
    name: "substrate.record_stakeholder_state",
    description:
      "Record a stakeholder_state_recorded event for a multi-stakeholder " +
      "directive. Auto-detects conflicts against prior stakeholder declarations " +
      "and emits stakeholder_conflict + owner_input_required when they disagree. Phase I.",
    parameters: RecordStakeholderStateSchema,
    execute: wrap(handleRecordStakeholderState),
  });

  server.addTool({
    name: "substrate.record_interference_edge",
    description:
      "Record a directive_interference_edge (kind: blocks | watches | depletes). " +
      "Validates against self-loops, refuses cycle-introducing blocks edges only " +
      "after surfacing them, and emits directive_interference_cycle_detected for " +
      "any cycle in the blocks subgraph. Phase I.",
    parameters: RecordInterferenceEdgeSchema,
    execute: wrap(handleRecordInterferenceEdge),
  });

  server.addTool({
    name: "substrate.open_directive",
    description:
      "Convenience: open a fresh directive with optional lifecycle (finite | " +
      "rolling_active), urgency (normal | elevated | crisis), review cadence, " +
      "initial root task, and an initial stakeholders list. Emits crisis_mode_engaged " +
      "when urgency=crisis. Phase I.",
    parameters: OpenDirectiveSchema,
    execute: wrap(handleOpenDirective),
  });

  server.addTool({
    name: "runtime.process_rolling_reviews",
    description:
      "Drain rolling_review_due_view: emit directive_review_due, open a review " +
      "subtask, advance next_review_due by one cadence period. Father (Phase K) " +
      "calls this on its tick. Phase I.",
    parameters: ProcessRollingReviewsSchema,
    execute: wrap(handleProcessRollingReviews),
  });

  server.addTool({
    name: "runtime.father_iterate",
    description:
      "One Father tick (Phase K, §14). Reads active_objectives_view, " +
      "rolling_review_due_view, and directive_conflicts_view; selects the " +
      "highest-priority unblocked work; opens a directive from a template " +
      "(NEVER calls an LLM). Honors §3 owner-yield: if owner_input_received " +
      "is within the active window, Father yields without opening anything.",
    parameters: FatherIterateSchema,
    execute: wrap(handleFatherIterate),
  });

  server.addTool({
    name: "runtime.detect_father_drift",
    description:
      "Diagnostic: scan recent events with substrate_origin='father' and emit " +
      "father_drift_detected for any event whose kind is outside the §14 " +
      "FATHER_ACTION_EVENT_KINDS taxonomy. Idempotent — already-reported " +
      "offenders are not re-emitted.",
    parameters: DetectFatherDriftSchema,
    execute: wrap(handleDetectFatherDrift),
  });

  server.addTool({
    name: "substrate.find_recipe",
    description:
      "Find a recipe matching the supplied task by goal_shape + topology " +
      "signature with confidence ≥ min_confidence (Phase J, §15). Returns the " +
      "RecipeMatch or null.",
    parameters: FindRecipeSchema,
    execute: wrap(handleFindRecipe),
  });

  server.addTool({
    name: "runtime.replay_recipe",
    description:
      "Replay a matched recipe against a task — execute its trajectory's " +
      "action + verifier artifacts WITHOUT calling the brain (Phase J, §15). " +
      "On success emits action_predicted/scored/task_committed with " +
      "recipe_replayed=true; on residual ≥ threshold emits " +
      "recipe_replay_aborted and the dispatcher routes back to opencode_brain.",
    parameters: ReplayRecipeSchema,
    execute: wrap(handleReplayRecipe),
  });

  server.addTool({
    name: "substrate.register_external_source",
    description:
      "Register a new external-event source (calendar, email, IoT…). Mints a " +
      "per-source bearer token override on the daemon's ingress state and " +
      "emits external_source_registered for audit (§5.2). Requires the " +
      "ingress state to be wired into the MCP context (i.e. running inside " +
      "the daemon, not bare stdio).",
    parameters: RegisterExternalSourceSchema,
    execute: wrap(handleRegisterExternalSource),
  });

  server.addTool({
    name: "runtime.recent_events",
    description:
      "Return the most-recent K events (default 30, max 200), optionally " +
      "filtered by kind. Used by `acc watch` to fill its event buffer before " +
      "SSE has caught up. Result is `{events: [...]}` in ts-ASC order.",
    parameters: RecentEventsSchema,
    execute: wrap(handleRecentEvents),
  });

  return server;
};

// ── HTTP wrapper (Phase-B3 Bun.serve compatibility) ────────────────
//
// The Phase-B3 deliverable specifies a Bun.serve HTTP surface where the
// daemon routes `POST /mcp/<method>` directly to a handler dictionary.
// This export keeps that surface alive alongside the fastmcp transport so
// the daemon's plain-HTTP route handler can dispatch by method name.

const HTTP_DISPATCH: Record<string, (ctx: McpContext, args: any) => McpResult | Promise<McpResult>> = {
  "substrate.emit": handleEmit as any,
  "substrate.read": handleRead as any,
  "substrate.get_event": handleGetEvent as any,
  "substrate.get_artifact": handleGetArtifact as any,
  "substrate.search": handleSearch as any,
  "substrate.embed_text": handleEmbedText as any,
  "substrate.run_artifact": handleRunArtifact as any,
  "substrate.run_verifier": handleRunVerifier as any,
  "substrate.credit": handleCredit as any,
  "substrate.admit_artifact": handleAdmitArtifact as any,
  "substrate.open_fixture": handleOpenFixture as any,
  "substrate.amend_directive": handleAmendDirective as any,
  "substrate.record_stakeholder_state": handleRecordStakeholderState as any,
  "substrate.record_interference_edge": handleRecordInterferenceEdge as any,
  "substrate.open_directive": handleOpenDirective as any,
  "runtime.dispatch_ready_task": handleDispatchReadyTask as any,
  "runtime.scheduler_tick": handleSchedulerTick as any,
  "runtime.process_rolling_reviews": handleProcessRollingReviews as any,
  "runtime.father_iterate": handleFatherIterate as any,
  "runtime.detect_father_drift": handleDetectFatherDrift as any,
  "substrate.find_recipe": handleFindRecipe as any,
  "runtime.replay_recipe": handleReplayRecipe as any,
  "substrate.register_external_source": handleRegisterExternalSource as any,
  "runtime.recent_events": handleRecentEvents as any,
};

/** Bun.serve route handler: POST /mcp/<method>. Parses JSON body, validates
 *  the method against the whitelist, returns `{ok, …}` with status 200 on
 *  success and 400 on handler-rejected errors (404 for unknown methods). */
export const handleMcpRequest = async (ctx: McpContext, req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  }
  const url = new URL(req.url);
  const method = url.pathname.replace(/^\/mcp\//, "");
  const handler = HTTP_DISPATCH[method];
  if (!handler) {
    return Response.json({ ok: false, error: `unknown_method:${method}` }, { status: 404 });
  }
  let body: any = {};
  try {
    const text = await req.text();
    body = text ? JSON.parse(text) : {};
  } catch (err) {
    return Response.json({ ok: false, error: `bad_json:${(err as Error).message}` }, { status: 400 });
  }
  try {
    const result = await handler(ctx, body);
    return Response.json(result, { status: result.ok ? 200 : 400 });
  } catch (err) {
    return Response.json(
      { ok: false, error: `handler_error:${(err as Error).message}` },
      { status: 500 },
    );
  }
};
