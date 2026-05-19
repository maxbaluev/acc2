// acc2 MCP server — shared types + zod parameter schemas. Split out of
// the monolithic runtime/mcp_server.ts so the substrate.* / runtime.*
// handler files and the server bootstrap (index.ts) can each consume
// these definitions without circular dependencies.
//
// The schemas mirror v2-design.md §13.2 — keep this file in lockstep
// with the canonical surface declared in `McpMethods` below.

import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { JsonValue, SubstrateOrigin } from "../../substrate/types";
import type { EmbeddingIndex } from "../embedding_index";

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
  ingressState?: import("../external_ingress").ExternalIngressState | null;
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
  "runtime.system_map",
  "runtime.brain_self_audit",
  "runtime.trajectory_replay",
  "runtime.prompt_self_inspect",
] as const;
export type McpMethodName = (typeof McpMethods)[number];

// ── Parameter schemas (zod, per v2-design.md §13.2) ────────────────

// substrate.emit accepts an `event` object, OR — for ergonomic CLI use — the
// event fields directly at the top level. Both shapes are supported; the
// `event` wrapper takes precedence when present.
export const EmitEventSchema = z.object({
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

export const EmitSchema = z.object({
  event: EmitEventSchema.optional(),
  // Top-level fallback (mirrors EmitEventSchema, all optional except `kind`
  // which the handler validates from whichever surface is present).
  //
  // Batch 2.β: opencode's MCP-client flattens our zod schema into top-level
  // tool-call args (no `event` wrapper). action_predicted carries
  // action_artifact_id / verifier_artifact_id / predicted_residual at the top
  // level — so the FLAT schema must accept them too or those fields are
  // silently dropped (no-action-predicted gap). Mirroring EmitEventSchema
  // exactly here closes that gap.
  kind: z.string().optional(),
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

export const ReadSchema = z.object({
  view_name: z.string(),
  args: z.unknown().optional(),
});

export const IdSchema = z.object({
  id: z.string(),
});

export const SearchSchema = z.object({
  query: z.string(),
  opts: z
    .object({
      k: z.number().optional(),
      runtime: z.string().optional(),
      min_score: z.number().optional(),
      kind_filter: z.array(z.string()).optional(),
      // Open-ended retrieval routing records. Keys are emitter/domain supplied,
      // not fixed enums; retrieval.ts clamps values and ignores unknown axes.
      aspect_weights: z.record(z.number()).optional(),
      domain_hints: z.record(z.number()).optional(),
    })
    .optional(),
});

export const EmbedTextSchema = z.object({
  text: z.string(),
});

export const RunArtifactSchema = z.object({
  artifact_id: z.string(),
  inputs: z.unknown().optional(),
  budget: z
    .object({
      wall_ms: z.number().optional(),
      memory_mb: z.number().optional(),
    })
    .optional(),
});

export const RunVerifierSchema = z.object({
  verifier_artifact_id: z.string(),
  observation: z.unknown().optional(),
  budget: z
    .object({
      wall_ms: z.number().optional(),
      memory_mb: z.number().optional(),
    })
    .optional(),
});

export const AdmitArtifactSchema = z.object({
  runtime: z.enum(["bun", "uv", "camofox-browser"]),
  body: z.string(),
  declared_sandbox: z.unknown(),
  fixture_input: z.unknown(),
  fixture_expected_residual_below: z.number().optional(),
  state_root: z.string().optional(),
  name: z.string().optional(),
  target_files: z.array(z.string()).optional(),
  target_resources: z.array(z.string()).optional(),
  directive_id: z.string().optional(),
  owner_consent_event_id: z.string().optional(),
  // Dark-gate observability (2026-05-18). The brain emits these
  // provenance / lineage fields on act_artifact_candidate and they
  // feed the predicate gate, strategy-first gate, supersedes lane gate,
  // and render-pipeline lineage gate downstream. Pre-2026-05-18 the
  // MCP schema dropped them, so admission ran with the gates blind.
  audience: z.string().optional(),
  cited_knowledge_ids: z.array(z.string()).optional(),
  source_candidate_id: z.string().optional(),
  intent: z.string().optional(),
  summary: z.string().optional(),
  kind: z.string().optional(),
  supersedes: z.string().optional(),
  rendered_docx_id: z.string().optional(),
  markdown_body_id: z.string().optional(),
  reference_docx_artifact_id: z.string().optional(),
});

export const CreditSchema = z.object({
  action_event_id: z.string(),
  observation_event_id: z.string(),
  scored_event_id: z.string(),
  predicted_residual: z.number(),
  observed_residual: z.number(),
});

export const OpenFixtureSchema = z.object({
  fixture: z.literal("d_count_todos"),
  target_path: z.string().optional(),
});

export const DispatchReadyTaskSchema = z.object({
  task_id: z.string(),
  fixture_target_path: z.string().optional(),
});

export const SchedulerTickSchema = z.object({
  max_concurrent: z.number().optional(),
  directive_id: z.string().optional(),
  fixture_target_path: z.string().optional(),
});

export const AmendDirectiveSchema = z.object({
  original_directive_id: z.string(),
  amendment_text: z.string(),
  superseded_tasks: z.array(z.string()).optional(),
  superseded_predictions: z.array(z.string()).optional(),
  new_task_goals: z.array(z.string()).optional(),
  rationale: z.string().optional(),
  amended_by: z.enum(["owner", "claude_root", "opencode"]).optional(),
});

export const RecordStakeholderStateSchema = z.object({
  directive_id: z.string(),
  stakeholder_id: z.string(),
  declared_utility: z.unknown(),
  inferred_constraints: z.array(z.string()).optional(),
  information_visibility: z.enum(["full", "limited", "blind"]).optional(),
});

export const RecordInterferenceEdgeSchema = z.object({
  from_directive: z.string(),
  to_directive: z.string(),
  kind: z.enum(["blocks", "watches", "depletes"]),
  reason: z.string(),
});

export const OpenDirectiveSchema = z.object({
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

export const ProcessRollingReviewsSchema = z.object({
  now: z.string().optional(),
  max_missed_reviews: z.number().optional(),
});

export const FatherIterateSchema = z.object({
  now: z.string().optional(),
  owner_active_window_ms: z.number().optional(),
});

export const DetectFatherDriftSchema = z.object({
  lookback_events: z.number().optional(),
});

export const FindRecipeSchema = z.object({
  task_id: z.string(),
  min_confidence: z.number().optional(),
});

export const ReplayRecipeSchema = z.object({
  task_id: z.string(),
  recipe_id: z.string(),
});

export const RegisterExternalSourceSchema = z.object({
  name: z.string(),
  bearer_token: z.string(),
  schema_hint: z.string().optional(),
  rate_limit_per_min: z.number().optional(),
  default_sensitivity: z.enum(["public", "internal", "private"]).optional(),
});

export const RecentEventsSchema = z.object({
  k: z.number().optional(),
  kinds: z.array(z.string()).optional(),
});

// ── Brain self-introspection (Phase 1 brain harness rewrite) ───────
// One canonical surface for the brain to read what the substrate IS,
// how the brain itself is performing, what happened on a directive,
// and what was composed into its prompt. All four are pure reads.

export const SystemMapSchema = z.object({
  artifact_top_k: z.number().optional(),
});

export const BrainSelfAuditSchema = z.object({
  window_hours: z.number().optional(),
});

export const TrajectoryReplaySchema = z.object({
  directive_id: z.string(),
});

export const PromptSelfInspectSchema = z.object({
  task_id: z.string(),
  budget_tokens: z.number().optional(),
  include_preview: z.boolean().optional(),
});

// ── createMcpServer options ────────────────────────────────────────

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
  ingressState?: import("../external_ingress").ExternalIngressState | null;
};
