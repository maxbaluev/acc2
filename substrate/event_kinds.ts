// Canonical event-kind registry — ONE source of truth for every kind the
// substrate persists or emits, plus the metadata that derives the four
// hand-maintained lists that previously drifted:
//
//   1. `EventKind` union (this file → re-exported from `./types`).
//   2. `EMBEDDABLE_KINDS` (consumed by the embedder + `acc admin
//      substrate-status`).
//   3. `HEALTH_METRIC_KINDS` (counted by `acc admin substrate-status`).
//   4. The orchestrator's mirror-inline set (reserved here for the
//      acc1 progress-event bus; acc2 has no such surface today — flag
//      stays false for every kind until a v2 mirror surface lands).
//
// Each kind is declared exactly once. Adding a new kind to the union
// without registering it here is a compile error; adding it here without
// updating the dependent surface (status / embedder / etc.) is caught
// by `event_kinds.test.ts`.
//
// Cross-reference: `docs/substrate-entity-map.md` enumerates every kind
// with its producer + which surface covers it; this file is the
// machine-readable mirror of that table.

export type EventKindProducer =
  | "substrate"   // daemon-owned workers (extractor, embedder, admission, …)
  | "brain"       // opencode bridge frames
  | "claude"      // Claude Code orchestrator (owner channel + inline lane)
  | "runtime"     // runtime/* modules observing scheduled work
  | "seed"        // substrate/seed.ts only
  | "test";       // test fixtures only (never emitted by production)

export type EventKindMetadata = {
  producer: EventKindProducer;
  embeddable: boolean;     // belongs in the vec_events embedding index
  mirror_inline: boolean;  // operator MUST surface inline (orchestrator rule)
  health_metric: boolean;  // counted by `acc admin substrate-status` health block
};

/**
 * Every canonical event kind, registered exactly once with its
 * producer and surface metadata. Order follows the lifecycle-phase
 * groups in `substrate/types.ts` so a diff between the two files is
 * trivially inspectable.
 *
 * Adding a new kind:
 *   1. Append an entry here (producer + booleans).
 *   2. If `embeddable: true`, ensure `runtime/embedder.ts` text
 *      extraction handles its payload shape.
 *   3. If `health_metric: true`, decide whether the count belongs in
 *      `cli/admin_substrate_status.ts` rendering.
 *   4. Run `bun test --bail`.
 */
export const EVENT_KINDS = {
  // ── Directive lifecycle ─────────────────────────────────────────────
  directive_opened:                        { producer: "claude",    embeddable: true,  mirror_inline: false, health_metric: false },
  directive_amended:                       { producer: "claude",    embeddable: true,  mirror_inline: false, health_metric: false },
  // Substrate-emitted when every task_node_opened under a finite directive
  // has reached a terminal state (task_committed / task_failed /
  // task_abandoned). Scheduler readyTasks() + ready_tasks_view both filter
  // these directives out so no further dispatch fires against a finished
  // DAG. Rolling-active directives never receive this event — they cycle
  // through review subtasks instead (directive_review_due).
  directive_closed:                        { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  directive_review_due:                    { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  directive_milestone_recorded:            { producer: "claude",    embeddable: false, mirror_inline: false, health_metric: false },
  directive_interference_edge:             { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  directive_interference_cycle_detected:   { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  task_deferred_for_interference:          { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  directive_archived_missed_reviews:       { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },

  // ── DAG topology ────────────────────────────────────────────────────
  task_node_opened:                        { producer: "brain",     embeddable: true,  mirror_inline: false, health_metric: false },
  task_edge_recorded:                      { producer: "brain",     embeddable: false, mirror_inline: false, health_metric: false },
  task_blocked:                            { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  task_ready:                              { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  task_claimed:                            { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  task_committed:                          { producer: "brain",     embeddable: false, mirror_inline: false, health_metric: false },
  task_committed_superseded:               { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  task_failed:                             { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  task_abandoned:                          { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },

  // ── Universal action primitive ──────────────────────────────────────
  action_predicted:                        { producer: "brain",     embeddable: true,  mirror_inline: false, health_metric: false },
  artifact_invoked:                        { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false },
  artifact_observed:                       { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false },
  action_scored:                           { producer: "substrate", embeddable: true,  mirror_inline: false, health_metric: false },
  irreversible_effect_recorded:            { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true  },

  // ── Knowledge (Model D) ─────────────────────────────────────────────
  knowledge_candidate:                     { producer: "brain",     embeddable: true,  mirror_inline: false, health_metric: false },
  candidate_confirmed:                     { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false },
  candidate_contradicted:                  { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false },
  knowledge_promoted:                      { producer: "substrate", embeddable: true,  mirror_inline: false, health_metric: false },
  knowledge_demoted:                       { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false },
  contradictory_candidates:                { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false },
  // Knowledge audit bc5vdkrik finding #4 (2026-05-15): emitted by the
  // substrate every time a knowledge entry is injected into a brain prompt
  // section (depth-1 retrieval) OR returned by substrate.search. Carries
  // {query, source_event_id, rendered_snippet, rank, rerank_score,
  // posterior, binding_surface: "prompt" | "search"}. Closes the four-link
  // credit chain (k_554/k_555): action_predicted.context_refs cites the
  // binding id, credit resolves binding → source_event_id, posterior
  // updates on the cited candidate/promoted row.
  retrieval_binding:                       { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false },

  // ── Code artifacts (LATM / Voyager) ─────────────────────────────────
  code_artifact_candidate:                 { producer: "brain",     embeddable: true,  mirror_inline: false, health_metric: false },
  code_artifact_admitted:                  { producer: "substrate", embeddable: true,  mirror_inline: false, health_metric: false },
  code_artifact_admission_rejected:        { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false },
  code_artifact_promoted:                  { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false },
  code_artifact_quarantined:               { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false },
  code_artifact_rehabilitated:             { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false },
  code_artifact_score_updated:             { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false },
  latm_novelty_bonus_applied:              { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false },
  sandbox_violation:                       { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  sandbox_unenforced_warning:              { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },

  // ── Runtime supervision ─────────────────────────────────────────────
  runtime_subprocess_started:              { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  runtime_subprocess_resource_warning:     { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  runtime_subprocess_soft_terminated:      { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  runtime_subprocess_hard_killed:          { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  runtime_subprocess_orphaned:             { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  runtime_subprocess_completed:            { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },

  // ── Knowledge synthesis ─────────────────────────────────────────────
  knowledge_synthesized:                   { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false },

  // ── External-source registration ────────────────────────────────────
  external_source_registered:              { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },

  // ── Embeddings ──────────────────────────────────────────────────────
  embedding_computed:                      { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },

  // ── Bridge — opencode ───────────────────────────────────────────────
  bridge_invoked:                          { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  bridge_frame_received:                   { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  bridge_completed:                        { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  bridge_failed:                           { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  bridge_mcp_connected:                    { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },

  // ── Dispatcher (cycle-1 enforcement) ────────────────────────────────
  brain_dispatched:                        { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  brain_dispatch_closed:                   { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  brain_cycle_2_started:                   { producer: "brain",     embeddable: false, mirror_inline: false, health_metric: false },
  continue_cycle_requested:                { producer: "brain",     embeddable: false, mirror_inline: false, health_metric: false },
  dispatcher_violation:                    { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true  },

  // ── Stakeholder model ───────────────────────────────────────────────
  stakeholder_state_recorded:              { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  stakeholder_interaction_edge:            { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  stakeholder_alignment_observed:          { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },

  // ── Owner channel ───────────────────────────────────────────────────
  owner_input_received:                    { producer: "claude",    embeddable: true,  mirror_inline: false, health_metric: false },
  owner_decision_recorded:                 { producer: "claude",    embeddable: true,  mirror_inline: false, health_metric: false },
  owner_input_required:                    { producer: "brain",     embeddable: false, mirror_inline: false, health_metric: false },

  // ── Crisis mode ─────────────────────────────────────────────────────
  crisis_mode_engaged:                     { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  crisis_mode_disengaged:                  { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  crisis_postmortem_opened:                { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  latm_suspended_in_crisis:                { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },

  // ── Stakeholder adjudication ────────────────────────────────────────
  stakeholder_conflict:                    { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  stakeholder_conflict_detected:           { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },

  // ── External-service push ───────────────────────────────────────────
  external_event_received:                 { producer: "runtime",   embeddable: true,  mirror_inline: false, health_metric: false },
  external_source_quarantined:             { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  external_source_rehabilitated:           { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },

  // ── Daemon lifecycle ────────────────────────────────────────────────
  daemon_started:                          { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  daemon_shutdown:                         { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  daemon_index_rebuilt:                    { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  daemon_ready:                            { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },

  // ── Daemon ops (crash recovery + DB integrity) ──────────────────────
  integrity_check_completed:               { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  integrity_check_failed:                  { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  wal_checkpointed:                        { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  dispatch_recovered_orphan:               { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },

  // ── Closure audit + lessons learned (universal post-trajectory loop) ─
  //
  // Every task's terminal commit MUST be preceded by a task_closure_audited
  // event scoring closure_residual ∈ [0,1] against the ORIGINAL goal text.
  // The brain emits task_closure_audited + zero-or-more lesson_extracted +
  // optional contract_amendment_proposed events before task_committed for
  // the root task of any directive. See prompt_composer.ts WORKFLOW_TEXT
  // steps 7-8 for the exact contract and CLAUDE.md §"Closure + learning".
  task_closure_audited:                    { producer: "brain",     embeddable: true,  mirror_inline: false, health_metric: false },
  lesson_extracted:                        { producer: "brain",     embeddable: true,  mirror_inline: false, health_metric: false },
  contract_amendment_proposed:             { producer: "brain",     embeddable: true,  mirror_inline: false, health_metric: false },

  // ── Application of lessons + amendments (Option D + Claude subagent executor) ──
  //
  // The brain proposes via lesson_extracted / contract_amendment_proposed.
  // lesson_apply_requested records the owner/auto-gated handoff into the
  // applier before any semantic edit occurs. The orchestrator (main Claude
  // Code) reads those events, spawns a Claude
  // Agent subagent in background_task that performs the semantic file edit
  // + runs the verifier (bun test, lint, type-check) + commits via git. Only
  // a successful, verifier-passing apply emits applied_change_committed citing
  // the originating lesson/amendment id; failed/refused attempts remain visible
  // as action_scored + *_applied rows. The optional legacy *_applied rows remain
  // readable, but applied_change_committed is the normalized flywheel terminal event.
  // See CLAUDE.md §"Applying lessons via Claude Agent subagents".
  lesson_apply_requested:                  { producer: "claude",    embeddable: true,  mirror_inline: false, health_metric: false },
  applied_change_committed:                { producer: "claude",    embeddable: true,  mirror_inline: false, health_metric: false },
  lesson_applied:                          { producer: "claude",    embeddable: true,  mirror_inline: false, health_metric: false },
  contract_amendment_applied:              { producer: "claude",    embeddable: true,  mirror_inline: false, health_metric: false },
  // ── Lesson-apply flywheel intermediates (audit-#7, 2026-05-15) ───────
  // Pre-fix these kinds were emitted by the lesson-apply subsystem but
  // absent from EVENT_KINDS — they bypassed embedding eligibility, the
  // health-metric tag filter, and the type system. Registering them
  // properly closes the kind-registry drift gap and ensures the surfaces
  // (TUI Lessons panel, embedding worker, mirror-inline rule) see them.
  apply_candidate_selected:                { producer: "claude",    embeddable: true,  mirror_inline: false, health_metric: false },
  apply_owner_gate_evaluated:              { producer: "claude",    embeddable: false, mirror_inline: false, health_metric: false },
  apply_executor_action_predicted:         { producer: "claude",    embeddable: true,  mirror_inline: false, health_metric: false },
  apply_change_verified:                   { producer: "claude",    embeddable: false, mirror_inline: false, health_metric: false },
  applied_change_compounding_measured:     { producer: "claude",    embeddable: false, mirror_inline: false, health_metric: false },
  lesson_apply_candidate_opened:           { producer: "claude",    embeddable: true,  mirror_inline: false, health_metric: false },
  lesson_apply_gate_evaluated:             { producer: "claude",    embeddable: false, mirror_inline: false, health_metric: false },
  lesson_apply_plan_verified:              { producer: "claude",    embeddable: false, mirror_inline: false, health_metric: false },
  lesson_apply_planned:                    { producer: "claude",    embeddable: true,  mirror_inline: false, health_metric: false },
  lesson_apply_verifier_scored:            { producer: "claude",    embeddable: false, mirror_inline: false, health_metric: false },
  lesson_compounding_measured:             { producer: "claude",    embeddable: false, mirror_inline: false, health_metric: false },

  // ── Substrate self-events ───────────────────────────────────────────
  projection_checkpointed:                 { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false },
  constitutional_gate_decision:            { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false },
  self_modification_recorded:              { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false },
  recipe_extracted:                        { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false },
  recipe_invoked:                          { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  recipe_replay_aborted:                   { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  prompt_truncated:                        { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },

  // ── Father ──────────────────────────────────────────────────────────
  father_cycle_recorded:                   { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  father_yielded:                          { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  father_drift_detected:                   { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  father_self_suspended:                   { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  father_drift_resolved:                   { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },

  // ── Runtime sandbox enforcement ─────────────────────────────────────
  sandbox_enforced:                        { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  sandbox_degraded:                        { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },

  // ── Lifecycle ───────────────────────────────────────────────────────
  goal_committed:                          { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  goal_abandoned:                          { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },

  // ── Opencode subsystem upgrade ──────────────────────────────────────
  opencode_upgrade_started:                { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  opencode_upgrade_completed:              { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  opencode_upgrade_failed:                 { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },

  // ── Admin maintenance ───────────────────────────────────────────────
  admin_token_rotated:                     { producer: "claude",    embeddable: false, mirror_inline: false, health_metric: false },
  external_source_token_rotated:           { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  code_artifact_quarantine_overridden:     { producer: "claude",    embeddable: false, mirror_inline: false, health_metric: false },
  directive_archived_by_operator:          { producer: "claude",    embeddable: false, mirror_inline: false, health_metric: false },
  state_exported:                          { producer: "claude",    embeddable: false, mirror_inline: false, health_metric: false },
  state_imported:                          { producer: "claude",    embeddable: false, mirror_inline: false, health_metric: false },

  // ── Robustness telemetry (fail-fast taxonomy) ───────────────────────
  error_caught:                            { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  worker_tick_overrun:                     { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true  },
  // Substrate-side proof of worker liveness (audit-#5, 2026-05-15). Emitted
  // by supervisedTick AFTER each successful body() with per-worker dampening
  // (WORKER_TICK_EVENT_DAMPEN_MS = 60s) so the scheduler's 500ms cadence
  // doesn't flood the ledger. Pre-fix the only liveness record was an
  // in-process Map lost across daemon restarts; the TUI Supervisor panel
  // and auditors could never see workers ticking.
  worker_tick_completed:                   { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  bridge_stuck:                            { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  runtime_subprocess_killed:               { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  // ── Brain-observability (audit b0kheqg3g, 2026-05-15) ───────────────
  // Pre-fix the brain was a black box: tool frames were persisted but the
  // model's MESSAGE / reasoning text + the composed prompt + the model's
  // decisions-that-didn't-fire-tools were never persisted. These three
  // event kinds close the observability gap with hard payload caps so the
  // ledger doesn't bloat:
  //   - brain_prompt_composed: emitted by the bridge just after bridge_invoked,
  //     before spawn. Carries sha256(prompt) + capped preview (32768 chars max)
  //     + truncated boolean + chars_original. Not embeddable (contains owner
  //     context retrieved from substrate; auditor-only surface).
  //   - brain_message_emitted: emitted by consumeLine when opencode produces
  //     a `message` or `text` frame. Capped at 4096 chars per emit and 20
  //     emits per task (then one suppression summary). Embeddable so Model-D
  //     can retrieve and credit reasoning that didn't fire a tool call.
  //   - brain_reasoning_recorded: same shape as brain_message_emitted but
  //     for `step_start` / `step_complete` / structured reasoning frames.
  brain_prompt_composed:                   { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  brain_message_emitted:                   { producer: "brain",     embeddable: true,  mirror_inline: false, health_metric: false },
  brain_reasoning_recorded:                { producer: "brain",     embeddable: true,  mirror_inline: false, health_metric: false },
  // ── Daemon source hot-reload (brain audit bqlr29psq, 2026-05-15) ────
  // When a source file under runtime/, substrate/, or cli/ changes, the
  // daemon's fs.watch worker emits daemon_hotreload_triggered. On success
  // (dynamic import + validation passed) daemon_hotreload_completed lands
  // with the swapped module path. On failure (syntax error / missing
  // expected export / quiescence-blocked target) daemon_hotreload_failed
  // lands with the rollback reason and the previous module reference
  // stays installed so the daemon never goes down on a bad edit.
  daemon_hotreload_triggered:              { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  daemon_hotreload_completed:              { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  daemon_hotreload_failed:                 { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true  },
  // ── Unified pathology budget (brain elegance bc8je5f3x, 2026-05-15) ─
  // Pre-fix six backpressure mechanisms (bridge_failure_streak,
  // consecutive_bridge_failures, supervisor_redispatch_storm,
  // dispatch_budget_exceeded, ready_starvation, bridge_health_degraded)
  // each had their own thresholds and emit shapes. The directive-scoped
  // pathology budget collapses them: every existing detector now ALSO
  // debits the budget; one canonical pathology_budget_exhausted event
  // fires when the accumulated weight crosses the threshold, enumerating
  // every contributing pathology in one payload so operators see a single
  // "this directive is consuming attention without converging" signal.
  pathology_budget_debited:                { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  pathology_budget_exhausted:              { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true  },
  // ── Prompt composition cache (brain elegance bc8je5f3x bet #4, 2026-05-15) ─
  // Telemetry only: cache_hit means composePrompt returned a recently-built
  // prompt without re-scanning the substrate; cache_miss means a fresh
  // composition ran. Operators watch hit rate to spot regressions where the
  // cache is too aggressive (stale prompts) or too lax (no measurable speedup).
  prompt_composition_cache_hit:            { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  prompt_composition_cache_miss:           { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },

  // ── Bridge-health gate (Batch 8.A, cites brain lesson 5SWP11NZFS3YX68Y95T164HT9W) ─
  // Substrate-emitted when ≥ BRIDGE_DEGRADATION_THRESHOLD bridge_failed events
  // land within BRIDGE_FAILURE_WINDOW_MS. Scheduler refuses opencode_brain
  // dispatches until bridge_health_recovered fires (no failures for
  // BRIDGE_HEALTH_COOLDOWN_MS). Brain proposed this in WORKFLOW_TEXT step-8
  // lesson_extracted (kind=failure_pattern) on 2026-05-15T02:10:08.725Z.
  bridge_health_degraded:                  { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true  },
  bridge_health_recovered:                 { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },

  // ── Supervisor (Batch 8.B) — auto-stop stucks/loops at every level ──
  // Periodic worker emits this when it detects a pathology and applies the
  // corresponding corrective action (task_failed / directive_archived_by_operator
  // / bridge_health_degraded). Records what the supervisor saw + what it did
  // so operators can audit the auto-intervention chain.
  supervisor_intervention_recorded:        { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true  },
  // Owner re-activates a directive previously archived by the supervisor
  // (task-explosion / dispatch-budget). The archive event preserved
  // quarantined_tasks payload; resume lifts the readyTasks filter so the
  // scheduler picks them up again. Owner directive 2026-05-15:
  // "system never should loose tasks if task explosion".
  directive_resumed:                       { producer: "claude",    embeddable: false, mirror_inline: false, health_metric: false },
  // Substrate compactor (Batch 10) — emitted when bridge_frame_received rows
  // older than COMPACTION_FRAME_RETENTION_MS were pruned. Audit-only.
  substrate_compacted:                     { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },

  // ── Previously-missing kinds (emitted at runtime, now registered) ───
  embedding_skipped_missing_api_key:       { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
  cli_layout_migrated:                     { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false },
} as const satisfies Record<string, EventKindMetadata>;

/** The canonical union — derived from the registry. */
export type EventKind = keyof typeof EVENT_KINDS;

/** Kinds whose payload text we embed (vec_events index). */
export const EMBEDDABLE_KINDS: EventKind[] = (Object.entries(EVENT_KINDS) as Array<
  [EventKind, EventKindMetadata]
>)
  .filter(([, m]) => m.embeddable)
  .map(([k]) => k);

/** Kinds counted by the `acc admin substrate-status` health block. */
export const HEALTH_METRIC_KINDS: EventKind[] = (Object.entries(EVENT_KINDS) as Array<
  [EventKind, EventKindMetadata]
>)
  .filter(([, m]) => m.health_metric)
  .map(([k]) => k);

/** Orchestrator mirror-inline set (operator MUST see these inline). The
 *  rule lives in the parent harness's CLAUDE.md; acc2 has no progress-
 *  event bus today so the set is empty until a v2 surface lands. */
export const MIRROR_INLINE_EVENT_TYPES: ReadonlySet<EventKind> = new Set(
  (Object.entries(EVENT_KINDS) as Array<[EventKind, EventKindMetadata]>)
    .filter(([, m]) => m.mirror_inline)
    .map(([k]) => k),
);
