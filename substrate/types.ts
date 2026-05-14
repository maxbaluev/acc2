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
  | "amendment_invalidates_prediction"
  | "cycle_1_only_breach"
  | "refinement_depth_exceeded"
  | "directive_interference_cycle"
  | "rolling_directive_archived";

export type TaskEdgeKind = "requires" | "refines" | "watches";

// ── Event kinds — twelve groups (§4.1) ──────────────────────────────

export type EventKind =
  // Directive lifecycle
  | "directive_opened"
  | "directive_amended"
  | "directive_review_due"
  | "directive_milestone_recorded"
  | "directive_interference_edge"
  | "directive_interference_cycle_detected"
  | "task_deferred_for_interference"
  | "directive_archived_missed_reviews"

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
  | "code_artifact_score_updated"
  | "sandbox_violation"
  | "sandbox_unenforced_warning"

  // Runtime supervision (§5.5)
  | "runtime_subprocess_started"
  | "runtime_subprocess_resource_warning"
  | "runtime_subprocess_soft_terminated"
  | "runtime_subprocess_hard_killed"
  | "runtime_subprocess_orphaned"
  | "runtime_subprocess_completed"

  // Knowledge synthesis (§3.6.1 Rule 3)
  | "knowledge_synthesized"

  // External-source registration (§5.2)
  | "external_source_registered"

  // Embeddings
  | "embedding_computed"

  // Bridge
  | "bridge_invoked"
  | "bridge_frame_received"
  | "bridge_completed"
  | "bridge_failed"
  | "bridge_mcp_connected"

  // Dispatcher (Phase D — §3.7 cycle-1 enforcement)
  | "brain_dispatched"
  | "brain_dispatch_closed"
  | "brain_cycle_2_started"
  | "continue_cycle_requested"
  | "dispatcher_violation"

  // Stakeholder model
  | "stakeholder_state_recorded"
  | "stakeholder_interaction_edge"
  | "stakeholder_alignment_observed"

  // Owner channel
  | "owner_input_received"
  | "owner_decision_recorded"
  | "owner_input_required"

  // Crisis mode
  | "crisis_mode_engaged"
  | "crisis_mode_disengaged"
  | "crisis_postmortem_opened"
  | "latm_suspended_in_crisis"

  // Stakeholder adjudication
  | "stakeholder_conflict"
  | "stakeholder_conflict_detected"

  // External-service push
  | "external_event_received"
  | "external_source_quarantined"
  | "external_source_rehabilitated"

  // Daemon lifecycle
  | "daemon_started"
  | "daemon_shutdown"
  | "daemon_index_rebuilt"
  | "daemon_ready"

  // Daemon ops (Batch 3.OPS: crash recovery + DB integrity)
  | "integrity_check_completed"
  | "integrity_check_failed"
  | "wal_checkpointed"
  | "dispatch_recovered_orphan"

  // Substrate self-events
  | "projection_checkpointed"
  | "constitutional_gate_decision"
  | "self_modification_recorded"
  | "recipe_extracted"
  | "recipe_invoked"
  | "recipe_replay_aborted"
  | "prompt_truncated"

  // Father
  | "father_cycle_recorded"
  | "father_yielded"
  | "father_drift_detected"
  | "father_self_suspended"
  | "father_drift_resolved"

  // Runtime sandbox enforcement (Batch 4)
  | "sandbox_enforced"
  | "sandbox_degraded"

  // Lifecycle
  | "goal_committed"
  | "goal_abandoned"

  // Opencode subsystem upgrade (Batch 2.γ — `acc admin update-opencode`)
  // Emitted by runtime/opencode_version.ts so the trajectory of every
  // upgrade (start → completion or failure) is auditable on the substrate.
  | "opencode_upgrade_started"
  | "opencode_upgrade_completed"
  | "opencode_upgrade_failed"

  // Admin maintenance surface (Batch 3.ADMIN — operator-facing audit trail)
  //   admin_token_rotated                  — `acc admin rotate-admin-token`
  //   external_source_token_rotated        — `acc admin rotate-external-token <source>`
  //   code_artifact_quarantine_overridden  — `acc admin override-quarantine`
  //   directive_archived_by_operator       — `acc admin archive-rolling` (distinct
  //                                          from `directive_archived_missed_reviews`)
  //   state_exported                       — `acc admin export <path>`
  //   state_imported                       — `acc admin import <path>`
  | "admin_token_rotated"
  | "external_source_token_rotated"
  | "code_artifact_quarantine_overridden"
  | "directive_archived_by_operator"
  | "state_exported"
  | "state_imported";

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
      // Camoufox fingerprint hints (Batch 1.α). All optional; defaults are
      // applied in the sandbox builder so old decls remain valid.
      //   fingerprint_os      — "linux" | "macos" | "windows" (default linux)
      //   fingerprint_locale  — BCP 47 string, e.g. "en-US" (default en-US)
      //   headless            — boolean (default true)
      fingerprint_os?: "linux" | "macos" | "windows";
      fingerprint_locale?: string;
      headless?: boolean;
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
