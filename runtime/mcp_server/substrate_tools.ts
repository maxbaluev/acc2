// acc2 MCP server — substrate.* tool handlers. Split out of the
// monolithic runtime/mcp_server.ts so the substrate-facing 17 methods
// can evolve independently from the runtime.* tools.
//
// Every handler returns `McpResult` (`{ok: true, result} | {ok: false,
// error}`); fastmcp's `execute` wrapper JSON-stringifies the result so
// the wire shape is uniform.

import type { z } from "zod";
import type { JsonValue, Runtime, SandboxDecl, SubstrateOrigin } from "../../substrate/types";
import { emitEvent, getEventById, type EmitEventInput } from "../events";
import { runBunArtifact } from "../runtimes/bun";
import { runUvArtifact } from "../runtimes/uv";
import { runCamofoxArtifact } from "../runtimes/camofox";
import { getArtifact } from "../artifact_store";
import { admitArtifact } from "../artifact_admission";
import { distributeCredit } from "../credit";
import { openFixtureDCountTodos } from "../fixtures/d_count_todos";
import { emitAndApplyAmendment } from "../amendment_handler";
import { computeEmbedding } from "../embedder";
import { retrieve } from "../retrieval";
import { recordStakeholderState, type StakeholderVisibility } from "../stakeholder_compositor";
import { recordInterferenceEdge, type InterferenceEdgeKind } from "../interference";
import { findRecipeMatch } from "../recipe_replay";
import { newId } from "../ids";
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
  lessonImplementerQueue,
  lessonImplementationStatus,
  appliedLessonEffectiveness,
} from "../../substrate/views";
import type {
  AdmitArtifactSchema,
  AmendDirectiveSchema,
  CreditSchema,
  EmbedTextSchema,
  EmitSchema,
  FindRecipeSchema,
  IdSchema,
  McpContext,
  McpResult,
  OpenDirectiveSchema,
  OpenFixtureSchema,
  ReadSchema,
  RecordInterferenceEdgeSchema,
  RecordStakeholderStateSchema,
  RegisterExternalSourceSchema,
  RunArtifactSchema,
  RunVerifierSchema,
  SearchSchema,
} from "./types";

export const handleEmit = (
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
  // Optional event fields. Accept BOTH the `args.event.*` wrapped shape and
  // the flat `args.*` shape — opencode 1.4+ flattens our zod schema when
  // surfacing the tool to the brain, so flat is the dominant calling shape.
  // The wrapper shape stays for callers using the explicit `event` envelope.
  const e = args.event ?? args;
  input.predicted_residual = e.predicted_residual;
  input.action_artifact_id = e.action_artifact_id;
  input.verifier_artifact_id = e.verifier_artifact_id;
  input.outcome = e.outcome as EmitEventInput["outcome"];
  input.residual = e.residual;
  const emitted = emitEvent(ctx.db, input);
  return { ok: true, result: { id: emitted.id, ts: emitted.ts } };
};

export const handleRead = (
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
      case "lesson_implementer_queue_view":
        return { ok: true, result: lessonImplementerQueue(db) as unknown as JsonValue };
      case "lesson_implementation_status_view":
        return { ok: true, result: lessonImplementationStatus(db) as unknown as JsonValue };
      case "applied_lesson_effectiveness_view":
        return { ok: true, result: appliedLessonEffectiveness(db) as unknown as JsonValue };
      default:
        return { ok: false, error: `view_not_implemented:${view}` };
    }
  } catch (err) {
    return { ok: false, error: `view_read_failed:${(err as Error).message}` };
  }
};

export const handleGetEvent = (
  ctx: McpContext,
  args: z.infer<typeof IdSchema>,
): McpResult => {
  const ev = getEventById(ctx.db, args.id);
  if (!ev) return { ok: false, error: "event_not_found" };
  return { ok: true, result: ev as unknown as JsonValue };
};

export const handleGetArtifact = (
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

export const handleSearch = async (
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

export const handleEmbedText = async (
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

// ── Phase C runtime handlers (substrate.run_artifact / run_verifier) ──
//
// substrate.run_artifact dispatches by the artifact's stored runtime:
//   - bun  → runBunArtifact
//   - uv   → runUvArtifact (Phase G wires this)
//   - camofox-browser → runCamofoxArtifact (Phase G wires this)
// substrate.run_verifier is structurally identical — verifiers are just
// code artifacts whose body is expected to return `{residual: number}`.
// We do NOT enforce the shape; we pass the observation as inputs and let
// the verifier body decide what to do.

const callArtifactByRuntime = async (
  ctx: McpContext,
  artifactId: string,
  inputs: JsonValue,
  budget: { wall_ms?: number; memory_mb?: number } | undefined,
): Promise<McpResult> => {
  const row = getArtifact(ctx.db, artifactId);
  if (!row) return { ok: false, error: "artifact_not_found" };
  // Dispatcher quarantine gate (§11.6): quarantined artifacts MUST NOT be
  // invoked. The rehab worker is the only path back to `admitted`. Fail
  // closed so a stale brain dispatch can't poke a known-bad artifact.
  if (row.status === "quarantined") {
    return { ok: false, error: "artifact_quarantined" };
  }
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

export const handleRunArtifact = async (
  ctx: McpContext,
  args: z.infer<typeof RunArtifactSchema>,
): Promise<McpResult> => {
  const inputs = (args.inputs ?? args.input ?? null) as JsonValue;
  return callArtifactByRuntime(ctx, args.artifact_id, inputs, args.budget as { wall_ms?: number; memory_mb?: number } | undefined);
};

export const handleRunVerifier = async (
  ctx: McpContext,
  args: z.infer<typeof RunVerifierSchema>,
): Promise<McpResult> => {
  const observation = (args.observation ?? null) as JsonValue;
  return callArtifactByRuntime(ctx, args.verifier_artifact_id, observation, args.budget as { wall_ms?: number; memory_mb?: number } | undefined);
};

export const handleAdmitArtifact = async (
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
      governance: (args.directive_id || args.owner_consent_event_id) ? {
        directiveId: args.directive_id,
        ownerConsentEventId: args.owner_consent_event_id,
      } : undefined,
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

export const handleCredit = async (
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

export const handleOpenFixture = async (
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

export const handleAmendDirective = async (
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

export const handleRecordStakeholderState = (
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

export const handleRecordInterferenceEdge = (
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

export const handleOpenDirective = (
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

// ── Phase J: recipe lookup ────────────────────────────────────────

export const handleFindRecipe = (
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

// ── External-source registration (§5.2) ───────────────────────────

export const handleRegisterExternalSource = (
  ctx: McpContext,
  args: z.infer<typeof RegisterExternalSourceSchema>,
): McpResult => {
  if (!ctx.ingressState) {
    return { ok: false, error: "external_ingress_not_mounted" };
  }
  const { registerExternalSource } = require("../external_ingress") as typeof import("../external_ingress");
  const r = registerExternalSource(ctx.db, ctx.ingressState, args);
  if (!r.ok) return { ok: false, error: r.error };
  return {
    ok: true,
    result: { source: r.source, token_preview: r.token_preview } as JsonValue,
  };
};
