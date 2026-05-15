// acc2 substrate types — canonical shape per docs/v2-design.md §4.1, §11.3.
// One events table, many views. Three runtimes. Sandbox is per-runtime.

export type Ulid = string;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [k: string]: JsonValue };

// ── Layer-2 owner-communication autonomy (brain dispatch bs3r8kdhw, 85EYVZM4T531) ──
//
// The owner-driven preferences that gate substrate autonomy ON TOP of the
// existing structural Layer 1 (cli/* + runtime/* targets, 5-min cooldown,
// one-per-tick rate limit). Layer 2 RESTRICTS or RE-ROUTES within Layer 1,
// never overrides — the safety floor stays inviolate.
//
// Profile values accumulate via owner_insight_candidate events (brain or
// Claude emit on chat observation) and get promoted to owner_profile_recorded
// by the substrate's Model D extractor (substrate/extractors.ts) when either
// multi-origin corroboration OR confidence ≥ 0.85 OR explicit owner_decision_recorded
// approval fires. The auto-apply worker + prompt composer read the latest
// profile row via substrate/views.ts:owner_profile_view.

export type OwnerAutonomyTrustLevel = "cautious" | "normal" | "high";

export type OwnerProfileTimeWindow = {
  timezone?: string;
  days?: Array<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun">;
  start_hour?: number;
  end_hour?: number;
};

export type OwnerAutonomyScope = {
  /** Glob patterns to include. Defaults to ["cli/**", "runtime/**"] —
   *  the same as Layer 1's safe-auto-apply policy. Owner can NARROW
   *  (exclude *.test.ts, exclude WIP files) but cannot widen beyond
   *  the cli/runtime floor. */
  include?: string[];
  /** Glob patterns to exclude. Layered on top of `include`. */
  exclude?: string[];
};

export type OwnerProfile = {
  detected_language?: string;
  autonomy_scope?: OwnerAutonomyScope;
  autonomy_trust_level?: OwnerAutonomyTrustLevel;
  /** Paths/patterns the auto-apply worker MUST signal (stage-1) only,
   *  never apply (stage-2), even if Layer 1 says they're eligible. */
  manual_review_patterns?: string[];
  /** Working-hours window for the owner. Outside this window, stage-2
   *  apply pauses (stage-1 signaling continues). */
  time_window?: OwnerProfileTimeWindow;
  /** Topics the owner cares about — biases Father objective ranking
   *  + capability-discoverability suggestions. */
  hot_topics?: string[];
  /** Hard-block patterns. Even with autonomy_trust_level=high, the
   *  worker refuses to apply edits matching any of these. */
  things_to_never_do?: string[];
};

export const OWNER_PROFILE_DEFAULTS = {
  detected_language: "en",
  autonomy_scope: { include: ["cli/**", "runtime/**"], exclude: [] },
  autonomy_trust_level: "normal",
  manual_review_patterns: [],
  time_window: null,
  hot_topics: [],
  things_to_never_do: [],
} as const;

export const OWNER_PROFILE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    detected_language: { type: "string", minLength: 2, maxLength: 32 },
    autonomy_scope: {
      type: "object",
      additionalProperties: false,
      properties: {
        include: { type: "array", items: { type: "string", minLength: 1 }, default: ["cli/**", "runtime/**"] },
        exclude: { type: "array", items: { type: "string", minLength: 1 }, default: [] },
      },
    },
    autonomy_trust_level: { enum: ["cautious", "normal", "high"], default: "normal" },
    manual_review_patterns: { type: "array", items: { type: "string", minLength: 1 }, default: [] },
    time_window: {
      type: "object",
      additionalProperties: false,
      properties: {
        timezone: { type: "string", minLength: 1 },
        days: { type: "array", items: { enum: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] } },
        start_hour: { type: "integer", minimum: 0, maximum: 23 },
        end_hour: { type: "integer", minimum: 0, maximum: 23 },
      },
    },
    hot_topics: { type: "array", items: { type: "string", minLength: 1 }, default: [] },
    things_to_never_do: { type: "array", items: { type: "string", minLength: 1 }, default: [] },
  },
} as const;

// ── Origin / outcome / failure / edge kinds (§4.1) ──────────────────

export type SubstrateOrigin =
  | "claude_root"
  | "claude_sub"
  | "opencode"
  | "recipe"
  | "scheduler"
  | "father"
  | "substrate_auto"
  | "owner";

export type OutcomeStatus =
  | "pending"
  | "succeeded"
  | "failed"
  | "abandoned"
  | "rolling_active"
  | "amended";

export type FailureKind =
  | "verification_high_residual"
  | "artifact_runtime_error"
  | "bridge_auth"
  | "bridge_rate_limit"
  | "bridge_timeout"
  | "bridge_killed"
  | "budget_exhausted"
  | "prediction_miss"
  | "sandbox_violation"
  | "dag_cycle_detected"
  | "upstream_failure"
  | "concurrency_conflict"
  | "governance_block"
  | "stakeholder_conflict"
  | "amendment_invalidates_prediction"
  | "cycle_1_only_breach"
  | "refinement_depth_exceeded"
  | "directive_interference_cycle"
  | "rolling_directive_archived"
  /** Scheduler quarantined the task after MAX_CONSECUTIVE_BRIDGE_FAILURES
   *  in a row with no successful interleaving event. Prevents the retry
   *  storm a structurally broken dispatch would otherwise produce. */
  | "consecutive_bridge_failures"
  /** Integrity worker reaped a task_node_opened row that lingered past
   *  ZOMBIE_TASK_NODE_THRESHOLD_MS without ever being dispatched. Drops
   *  the task out of readyTasks / ready_tasks_view; operators can
   *  re-open via a fresh task_id. */
  | "abandoned_no_dispatch"
  /** Supervisor detected > SUPERVISOR_MAX_REDISPATCHES_PER_TASK
   *  brain_dispatched events on the same task within
   *  SUPERVISOR_REDISPATCH_WINDOW_MS. The scheduler was looping despite
   *  the per-task consecutive_bridge_failures cap (which can be bypassed
   *  by interleaved non-bridge_failed events). Force-fails the task to
   *  drop it from readyTasks. */
  | "redispatch_storm";

export type TaskEdgeKind = "requires" | "refines" | "watches";

// ── Event kinds — canonical registry (`./event_kinds.ts`) ──────────
//
// The hand-maintained `EventKind` union that lived here drifted from the
// embedder's allow-list, the substrate-status reporter's allow-list, and
// the runtime emitter call sites. The canonical registry now lives in
// `substrate/event_kinds.ts` — one entry per kind with producer +
// surface metadata. We re-export `EventKind` (derived as
// `keyof typeof EVENT_KINDS`) so existing call sites keep compiling.

export type { EventKind } from "./event_kinds";

// ── The event row (§4.1) ────────────────────────────────────────────

export type Event = {
  id: Ulid;
  ts: string;
  directive_id: string;
  task_id: string;
  parent_task_id: string | null;
  loop_id: string;
  substrate_origin: SubstrateOrigin;
  kind: EventKind;
  payload: JsonValue;
  context_refs: string[];
  predicted_residual?: number;
  action_artifact_id?: string;
  verifier_artifact_id?: string;
  outcome?: OutcomeStatus;
  residual?: number;
  embedding?: number[];
  payload_hash?: string;
  blob_ref?: string;
  failure_kind?: FailureKind;
  invoker?: SubstrateOrigin;
};

// ── Runtime + sandbox declarations (§6.1, §11.3) ────────────────────

export type Runtime = "bun" | "uv" | "camofox-browser";

// Brain sandbox audit bsfxsvgh9 + dataflow audit bxdhdkm9e (2026-05-15):
// `env_requires` declares which environment variables an artifact needs
// in process.env at invocation time. Universal — no regex, no hardcoded
// service list. The brain composes the artifact AND declares its env
// dependencies; the runtime checks declared vars against process.env
// BEFORE spawning the subprocess. Missing → emit owner_input_required
// (flows to the operator via SSE → Claude shell), refuse to invoke.
// One source of truth replacing the previous body-scan heuristic.
export type SandboxDecl =
  | {
      runtime: "bun";
      fs_read?: string[];
      fs_write?: string[];
      net_allow?: string[];
      proc_allow?: string[];
      substrate_access?: "ro" | "rw" | "none";
      env_requires?: string[];
      cpu_ms: number;
      wall_ms: number;
      memory_mb: number;
    }
  | {
      runtime: "uv";
      fs_read?: string[];
      fs_write?: string[];
      net_allow?: string[];
      pypi_allow?: string[];
      env_requires?: string[];
      cpu_ms: number;
      wall_ms: number;
      memory_mb: number;
    }
  | {
      runtime: "camofox-browser";
      browser_allow_domains: string[];
      browser_profile_root: string;
      browser_allow_downloads_to?: string;
      // Camoufox fingerprint hints (Batch 1.α). All optional; defaults are
      // applied in the sandbox builder so old decls remain valid.
      //   fingerprint_os      — "linux" | "macos" | "windows" (default linux)
      //   fingerprint_locale  — BCP 47 string, e.g. "en-US" (default en-US)
      //   headless            — boolean (default true)
      fingerprint_os?: "linux" | "macos" | "windows";
      fingerprint_locale?: string;
      headless?: boolean;
      env_requires?: string[];
      wall_ms: number;
      memory_mb: number;
    };

// ── Code artifact registry row (§11) ────────────────────────────────

// Brain sandbox audit bsfxsvgh9 (2026-05-15): `retired` is the terminal
// status for chronically-failing artifacts — rehabilitation does NOT
// re-admit a retired artifact (only quarantined → admitted is allowed).
// Used when an artifact has accumulated ≥ 3 quarantines, ≥ 10 hard
// kills, or ≥ 3 irreversible_effect_recorded rows without owner consent.
export type CodeArtifactStatus = "admitted" | "quarantined" | "promoted" | "retired";

export type CodeArtifact = {
  id: Ulid;
  runtime: Runtime;
  body: string;
  declared_sandbox: SandboxDecl;
  state_root: string;
  posterior_alpha: number;
  posterior_beta: number;
  score: number;
  confidence: number;
  embedding?: number[];
  recent_residual_mean: number;
  recent_kill_count: number;
  status: CodeArtifactStatus;
  name: string | null;
  fixture_input: JsonValue;
  fixture_expected_residual: number;
  created_at: string;
  updated_at: string;
};
