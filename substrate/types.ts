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

export type OwnerProfileTimeWindow = {
  timezone?: string;
  /** Open-ended day labels: typically weekday names but also any
   *  domain-specific label the owner uses ("therapy_days",
   *  "kids_with_me", "on_call_rotation_b"). The substrate refuses any
   *  schema that constrains this to a fixed weekday enum — a universal
   *  organism must accept whatever timing vocabulary the owner brings. */
  days?: string[];
  start_hour?: number;
  end_hour?: number;
};

export type OwnerAutonomyScope = {
  /** Open-ended resource-URI patterns the owner has authorized for
   *  autonomous action. Patterns are glob-shaped strings (`repo:cli/**`,
   *  `calendar:work/*`, `contact:close_friends/*`, `ledger:retro/*`).
   *  Defaults to empty — a universal organism makes NO scope assumption
   *  on first contact; the owner narrows or widens through observed
   *  consent. There is no `cli/`+`runtime/` floor; this is not a
   *  source-tree policy, it is the owner's consent surface. */
  include?: string[];
  /** Glob patterns to exclude. Layered on top of `include`. */
  exclude?: string[];
};

// Conversation-as-learning-surface (brain dispatch DSGSAZGMF1, 2026-05-15;
// universalized 2026-05-15 per owner feedback "people not 3 types, all
// of them different"):
//
// Owners are NOT bucketed into a fixed enum. Every owner is a unique
// continuous vector of learned signals that the substrate accumulates
// over many interactions. The renderer reads the signal map and adapts
// per-dimension; no signal carries a meaning the renderer can't ignore
// (so adding signals is purely additive, never breaking).
//
// Signals that exist today (the classifier seeds these; future
// extractors add more):
//
//   - `rendering_signals` — open-ended map of signal name → continuous
//     strength ∈ [0, 1]. Examples: `code_density`,
//     `ops_vocabulary`, `explanation_appetite`, `question_tolerance`.
//     The renderer biases output per-signal; a new signal means
//     "renderer can adapt one more dimension". NO enum, NO fixed set.
//   - `preferred_terms` — the owner's own words for substrate concepts.
//     The orchestrator + brain MUST mirror these back instead of jargon
//     ("my weekly grind" instead of "recurring friction task"; "the
//     daemon" instead of "the substrate" if the owner used that word).
//   - `avoided_terms` — words the owner explicitly rejected ("don't
//     call it a recipe", "stop saying RLM"). The orchestrator MUST
//     never use these.
//   - `exposed_concepts` — map of substrate-concept identifier to
//     first-encounter event id + exposure count. The orchestrator
//     explains a concept on FIRST encounter only; after that, uses
//     the owner's vocabulary and does not re-explain. Updated each
//     time the orchestrator surfaces a concept to the owner.
//
// All four are populated via the existing Layer-2 path —
// `owner_insight_candidate` → Model D extractor → `owner_profile_recorded`
// (substrate/extractors.ts) — so there is NO separate event registry,
// NO parallel state. The schema extension below is the single source
// of truth.

export type OwnerConceptExposure = {
  /** event_id of the first owner_input_received / brain output where
   *  this concept appeared in the owner's view. The orchestrator cites
   *  it when explaining the concept for posterior credit. */
  first_event_id: string;
  /** How many times the orchestrator has surfaced this concept since
   *  the first encounter. Increments each time the renderer references
   *  it. Used to detect "owner has seen this enough — stop explaining". */
  exposure_count: number;
};

export type OwnerProfile = {
  detected_language?: string;
  /** Open-ended map of continuous rendering signals for this specific
   *  owner. Each key is a signal name; each value is a learned strength
   *  ∈ [0, 1]. Consumers read known keys and ignore unknown keys. */
  rendering_signals?: Record<string, number>;
  /** Open-ended autonomy preferences beyond the scalar autonomy_score. */
  autonomy_signals?: Record<string, number>;
  /** Open-ended owner control/delegation preferences. */
  control_signals?: Record<string, number>;
  /** Open-ended risk tolerance and sensitivity dimensions. */
  risk_signals?: Record<string, number>;
  /** Open-ended collaboration / cadence / interruption preferences. */
  collaboration_signals?: Record<string, number>;
  /** Open-ended continuity signals for recurring goals and long arcs. */
  goal_continuity_signals?: Record<string, number>;
  /** Words the owner uses for substrate concepts. The renderer mirrors
   *  these back instead of canonical jargon. */
  preferred_terms?: string[];
  /** Words the owner explicitly rejected. The renderer MUST never use
   *  these in chat output to this owner. */
  avoided_terms?: string[];
  /** Substrate concepts the owner has already been exposed to. Keys are
   *  stable concept identifiers (e.g. "rolling_active",
   *  "knowledge_compounds", "father_ranked"); values track first-event
   *  id + exposure count so the renderer explains on first encounter
   *  only. */
  exposed_concepts?: Record<string, OwnerConceptExposure>;
  understood_concepts?: Record<string, { first_evidence_event_id: string; evidence_count: number; confidence?: number }>;
  declined_concepts?: Record<string, { first_declined_event_id: string; decline_count: number; preferred_term?: string }>;
  observation_count?: number;
  autonomy_scope?: OwnerAutonomyScope;
  /** Continuous autonomy score ∈ [0, 1]. Universal — every owner has
   *  their own score; no fixed enum of "cautious/normal/high" tiers.
   *  The substrate ADJUSTS this score from outcomes: +Δ on each
   *  applied_change_committed without revert, −Δ on each
   *  applied_change_failed or irreversible_effect_recorded. The owner
   *  can also clamp the floor via `autonomy_score_floor` so a bad
   *  outcome never drops trust below their declared minimum.
   *
   *  Gate behavior (auto_apply_worker): when autonomy_score is below
   *  AUTONOMY_MULTI_FILE_THRESHOLD (default 0.4), multi-file diffs are
   *  blocked. Higher dimensions (irreversible, cross-runtime,
   *  permission-sensitive paths) can use other thresholds — the score
   *  is one continuous knob, the thresholds vary by what's at stake.
   *
   *  Default 0.5 (above the multi-file threshold, so a fresh owner's
   *  behavior matches the prior "normal" tier). */
  autonomy_score?: number;
  /** Optional owner-declared floor — autonomy_score never falls below
   *  this. Lets the owner say "even after a bad apply, treat me as ≥
   *  0.3 trust" or "I'm a beginner — clamp me at 0.6 forever". When
   *  omitted, no floor (substrate can drive the score to 0). */
  autonomy_score_floor?: number;
  /** Paths/patterns the auto-apply worker MUST signal (stage-1) only,
   *  never apply (stage-2), even if Layer 1 says they're eligible. */
  manual_review_patterns?: string[];
  /** Working-hours window for the owner. Outside this window, stage-2
   *  apply pauses (stage-1 signaling continues). */
  time_window?: OwnerProfileTimeWindow;
  /** Topics the owner cares about — biases Father objective ranking
   *  + capability-discoverability suggestions. */
  hot_topics?: string[];
  /** Hard-block patterns. Even with autonomy_score=1.0 the worker
   *  refuses to apply edits matching any of these. */
  things_to_never_do?: string[];
};

export const OWNER_PROFILE_DEFAULTS = {
  detected_language: "en",
  rendering_signals: {},
  autonomy_signals: {},
  control_signals: {},
  risk_signals: {},
  collaboration_signals: {},
  goal_continuity_signals: {},
  preferred_terms: [],
  avoided_terms: [],
  exposed_concepts: {},
  understood_concepts: {},
  declined_concepts: {},
  observation_count: 0,
  autonomy_scope: { include: [], exclude: [] },
  autonomy_score: 0.5,
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
    rendering_signals: {
      type: "object",
      // Open-ended: keys are signal names (any string), values are
      // continuous strengths ∈ [0, 1]. No fixed key enum.
      additionalProperties: { type: "number", minimum: 0, maximum: 1 },
    },
    autonomy_signals: { type: "object", additionalProperties: { type: "number", minimum: 0, maximum: 1 } },
    control_signals: { type: "object", additionalProperties: { type: "number", minimum: 0, maximum: 1 } },
    risk_signals: { type: "object", additionalProperties: { type: "number", minimum: 0, maximum: 1 } },
    collaboration_signals: { type: "object", additionalProperties: { type: "number", minimum: 0, maximum: 1 } },
    goal_continuity_signals: { type: "object", additionalProperties: { type: "number", minimum: 0, maximum: 1 } },
    preferred_terms: { type: "array", items: { type: "string", minLength: 1, maxLength: 200 }, default: [] },
    avoided_terms: { type: "array", items: { type: "string", minLength: 1, maxLength: 200 }, default: [] },
    exposed_concepts: {
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        properties: {
          first_event_id: { type: "string", minLength: 1 },
          exposure_count: { type: "integer", minimum: 0 },
        },
      },
    },
    understood_concepts: {
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        properties: {
          first_evidence_event_id: { type: "string", minLength: 1 },
          evidence_count: { type: "integer", minimum: 0 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
    declined_concepts: {
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        properties: {
          first_declined_event_id: { type: "string", minLength: 1 },
          decline_count: { type: "integer", minimum: 0 },
          preferred_term: { type: "string", minLength: 1 },
        },
      },
    },
    observation_count: { type: "integer", minimum: 0 },
    autonomy_scope: {
      type: "object",
      additionalProperties: false,
      properties: {
        include: { type: "array", items: { type: "string", minLength: 1 }, default: [] },
        exclude: { type: "array", items: { type: "string", minLength: 1 }, default: [] },
      },
    },
    autonomy_score: { type: "number", minimum: 0, maximum: 1, default: 0.5 },
    autonomy_score_floor: { type: "number", minimum: 0, maximum: 1 },
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

// Free string, deliberately not a closed taxonomy. New failure modes
// emerge by being emitted and scored, not by editing this type.
export type FailureKind = string;

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
export type ActArtifactStatus = "admitted" | "quarantined" | "promoted" | "retired";

/** F4a deprecated alias — pre-rename name. */
export type CodeArtifactStatus = ActArtifactStatus;

export type ActArtifact = {
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
  status: ActArtifactStatus;
  name: string | null;
  fixture_input: JsonValue;
  fixture_expected_residual: number;
  created_at: string;
  updated_at: string;
};

/** F4a deprecated alias — pre-rename name. */
export type CodeArtifact = ActArtifact;
