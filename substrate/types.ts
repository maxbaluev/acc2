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
  | "amendment_invalidates_prediction";

export type TaskEdgeKind = "requires" | "refines" | "watches";

// ── Event kinds — twelve groups (§4.1) ──────────────────────────────

export type EventKind =
  // Directive lifecycle
  | "directive_opened"
  | "directive_amended"
  | "directive_review_due"
  | "directive_milestone_recorded"
  | "directive_interference_edge"

  // DAG topology
  | "task_node_opened"
  | "task_edge_recorded"
  | "task_blocked"
  | "task_ready"
  | "task_claimed"
  | "task_committed"
  | "task_committed_superseded"
  | "task_failed"
  | "task_abandoned"

  // Universal action primitive
  | "action_predicted"
  | "artifact_invoked"
  | "artifact_observed"
  | "action_scored"
  | "irreversible_effect_recorded"

  // Knowledge (Model D)
  | "knowledge_candidate"
  | "candidate_confirmed"
  | "candidate_contradicted"
  | "knowledge_promoted"
  | "knowledge_demoted"
  | "contradictory_candidates"

  // Code artifacts (LATM / Voyager)
  | "code_artifact_candidate"
  | "code_artifact_admitted"
  | "code_artifact_admission_rejected"
  | "code_artifact_promoted"
  | "code_artifact_quarantined"
  | "code_artifact_rehabilitated"
  | "sandbox_violation"

  // Embeddings
  | "embedding_computed"

  // Bridge
  | "bridge_invoked"
  | "bridge_frame_received"
  | "bridge_completed"
  | "bridge_failed"

  // Stakeholder model
  | "stakeholder_state_recorded"
  | "stakeholder_interaction_edge"
  | "stakeholder_alignment_observed"

  // Owner channel
  | "owner_input_received"
  | "owner_decision_recorded"

  // External-service push
  | "external_event_received"
  | "external_source_quarantined"
  | "external_source_rehabilitated"

  // Daemon lifecycle
  | "daemon_started"
  | "daemon_shutdown"
  | "daemon_index_rebuilt"

  // Substrate self-events
  | "projection_checkpointed"
  | "constitutional_gate_decision"
  | "self_modification_recorded"
  | "recipe_extracted"

  // Father
  | "father_cycle_recorded"
  | "father_yielded"

  // Lifecycle
  | "goal_committed"
  | "goal_abandoned";

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

export type SandboxDecl =
  | {
      runtime: "bun";
      fs_read?: string[];
      fs_write?: string[];
      net_allow?: string[];
      proc_allow?: string[];
      substrate_access?: "ro" | "rw" | "none";
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
      cpu_ms: number;
      wall_ms: number;
      memory_mb: number;
    }
  | {
      runtime: "camofox-browser";
      browser_allow_domains: string[];
      browser_profile_root: string;
      browser_allow_downloads_to?: string;
      wall_ms: number;
      memory_mb: number;
    };

// ── Code artifact registry row (§11) ────────────────────────────────

export type CodeArtifactStatus = "admitted" | "quarantined" | "promoted";

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
