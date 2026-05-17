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
  | "both"        // brain + Claude/orchestrator correction surfaces
  | "seed"        // substrate/seed.ts only
  | "test";       // test fixtures only (never emitted by production)

export type EventKindMetadata = {
  producer: EventKindProducer;
  embeddable: boolean;     // belongs in the vec_events embedding index
  mirror_inline: boolean;  // operator MUST surface inline (orchestrator rule)
  health_metric: boolean;  // counted by `acc admin substrate-status` health block
  narrative: boolean;      // shown in default `acc tail` / `acc events` narrative stream
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
  directive_opened:                        { producer: "claude",    embeddable: true,  mirror_inline: false, health_metric: false, narrative: true },
  directive_amended:                       { producer: "claude",    embeddable: true,  mirror_inline: false, health_metric: false, narrative: true },
  // Substrate-emitted when every task_node_opened under a finite directive
  // has reached a terminal state (task_committed / task_failed /
  // task_abandoned). Scheduler readyTasks() + ready_tasks_view both filter
  // these directives out so no further dispatch fires against a finished
  // DAG. Rolling-active directives never receive this event — they cycle
  // through review subtasks instead (directive_review_due).
  directive_closed:                        { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  directive_review_due:                    { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  directive_milestone_recorded:            { producer: "claude",    embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  directive_interference_edge:             { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: true },
  directive_interference_cycle_detected:   { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: true },
  task_deferred_for_interference:          { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  directive_archived_missed_reviews:       { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },

  // ── DAG topology ────────────────────────────────────────────────────
  task_node_opened:                        { producer: "brain",     embeddable: true,  mirror_inline: false, health_metric: false, narrative: true },
  task_edge_recorded:                      { producer: "brain",     embeddable: false, mirror_inline: false, health_metric: false, narrative: true },
  task_blocked:                            { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  task_ready:                              { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  task_claimed:                            { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  task_committed:                          { producer: "brain",     embeddable: false, mirror_inline: false, health_metric: false, narrative: true },
  task_committed_superseded:               { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  task_failed:                             { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: true },
  task_abandoned:                          { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: true },

  // ── Universal action primitive ──────────────────────────────────────
  // Unified causal envelope emitted once per coherent Claude/opencode act.
  // The emitEvent write path validates this source row, then projects the
  // shared lifecycle rows (action_predicted/action_scored/candidate_confirmed/
  // applied_change_committed) with source_act_id context. Only this source
  // kind projects; derived rows never recursively expand themselves.
  act_tuple_recorded:                      { producer: "runtime",   embeddable: true,  mirror_inline: false, health_metric: false, narrative: true },
  // Claude-side reasoning distillation. ONE summary per substantive turn
  // (commit / multi-file edit / confirmed diagnosis) — NOT per-tool-call.
  // The per-(substrate_origin, goal_shape) primitive
  // (substrate/views.ts originPromotionByGoalShape) uses these to compare
  // Claude's distilled output against opencode emissions for the merger.
  // Cited in cli/emit.ts CSYMEMIT01 SUPPORTED set; was missing here.
  claude_reasoning_recorded:                { producer: "claude",    embeddable: true,  mirror_inline: false, health_metric: false, narrative: true },
  action_predicted:                        { producer: "brain",     embeddable: true,  mirror_inline: false, health_metric: false, narrative: true },
  artifact_invoked:                        { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  artifact_observed:                       { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  // 2026-05-15 embedder right-sizing: action_scored carries numeric residuals
  // + structured outcome — no semantic text. Cosine retrieval over it is noise.
  action_scored:                           { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: true },
  irreversible_effect_recorded:            { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true, narrative: true },

  // ── Knowledge (Model D) ─────────────────────────────────────────────
  knowledge_candidate:                     { producer: "brain",     embeddable: true,  mirror_inline: true,  health_metric: false, narrative: true },
  candidate_confirmed:                     { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  candidate_contradicted:                  { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  // δ-mem follow-up (2026-05-17): substrate-emitted when the emit-time
  // dedup gate at substrate.emit refuses a knowledge_candidate as too
  // similar to a recent prior emission on the same (directive, author).
  // Live ledger evidence (24h window): 770 knowledge_candidate emissions
  // produced 8807 candidate_confirmed rows — ~11x duplication that
  // δ-mem flags as "artificial confidence". Brain receives the existing
  // event_id back from substrate.emit (first-wins idempotent shape, same
  // pattern as the terminal-event-conflict gate at runtime/events.ts).
  // Payload: { refused_emit_kind, matched_event_id, similarity,
  // method ('jaccard'|'cosine'), window_count }.
  knowledge_candidate_redundant:           { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  // Brain-side negative knowledge (loop-elegance gap #2, 2026-05-15):
  // brain can DIRECTLY mutate a knowledge entry's posterior toward
  // contradiction without waiting for an action_scored outcome. Use
  // when the brain reads a retrieved entry and IMMEDIATELY recognizes
  // it as wrong / outdated / domain-mismatched. Payload:
  //   { knowledge_id, reason, weight? (default 0.5) }
  // The extractor counts this as a contradicted observation with the
  // declared weight in the knowledge posterior math.
  knowledge_contradiction_observed:        { producer: "brain",     embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  knowledge_promoted:                      { producer: "substrate", embeddable: true,  mirror_inline: false, health_metric: false, narrative: true },
  knowledge_demoted:                       { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  contradictory_candidates:                { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  // Knowledge audit bc5vdkrik finding #4 (2026-05-15): emitted by the
  // substrate every time a knowledge entry is injected into a brain prompt
  // section (depth-1 retrieval) OR returned by substrate.search. Carries
  // {query, source_event_id, rendered_snippet, rank, rerank_score,
  // posterior, binding_surface: "prompt" | "search"}. Closes the four-link
  // credit chain (k_554/k_555): action_predicted.context_refs cites the
  // binding id, credit resolves binding → source_event_id, posterior
  // updates on the cited candidate/promoted row.
  retrieval_binding:                       { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  // Substrate-authored when a retrieval_binding injects knowledge from one
  // directive into another directive's prompt/search surface. This makes
  // implicit cross-directive transfer auditable and creditable without
  // requiring the brain to explicitly cite the source directive.
  knowledge_propagated:                     { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: false },

  // ── Code artifacts (LATM / Voyager) ─────────────────────────────────
  code_artifact_candidate:                 { producer: "brain",     embeddable: true,  mirror_inline: false, health_metric: false, narrative: false },
  // 2026-05-15 right-sizing: code_artifact_admitted payload carries only
  // {artifact_id, runtime, score, confidence} — the BODY lives in
  // code_artifact.body, never in the event. Retrieval over artifacts goes
  // through code_artifact_registry_view; embedding the admission record
  // returned 0% text-hit on 342 events.
  code_artifact_admitted:                  { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  code_artifact_admission_rejected:        { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  code_artifact_promoted:                  { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: true },
  code_artifact_quarantined:               { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  // Terminal retirement (sandbox audit bsfxsvgh9, 2026-05-15): unlike
  // quarantine, retired artifacts are NEVER re-admitted. Triggered by
  // accumulated hard kills / repeat quarantines / unconsented irreversibles.
  code_artifact_retired:                   { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: true, narrative: false },
  // Per-counter audit emitted by recordArtifactKill so the substrate
  // shows WHY recent_kill_count climbed (and from which event).
  artifact_health_counter_updated:         { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  code_artifact_rehabilitated:             { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  code_artifact_score_updated:             { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  latm_novelty_bonus_applied:              { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  sandbox_violation:                       { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  sandbox_unenforced_warning:              { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },

  // ── Runtime supervision ─────────────────────────────────────────────
  runtime_subprocess_started:              { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  runtime_subprocess_resource_warning:     { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  runtime_subprocess_soft_terminated:      { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  runtime_subprocess_hard_killed:          { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  runtime_subprocess_orphaned:             { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  runtime_subprocess_completed:            { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },

  // ── Knowledge synthesis ─────────────────────────────────────────────
  knowledge_synthesized:                   { producer: "substrate", embeddable: false, mirror_inline: true,  health_metric: false, narrative: true },
  // Explicit two-model merger protocol rows. Payloads MUST keep
  // merger_quality_axes as Record<string, number>; do not enumerate a fixed
  // quality taxonomy in the schema.
  merger_debate_required:                  { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: true },
  merger_debate_resolved:                  { producer: "brain",     embeddable: true,  mirror_inline: false, health_metric: false, narrative: true },
  cross_origin_verification_recorded:      { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: true },
  origin_calibration_recorded:             { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  knowledge_uncertainty_observed:          { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: true },

  // ── External-source registration ────────────────────────────────────
  external_source_registered:              { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  external_source_suggested:               { producer: "substrate", embeddable: true,  mirror_inline: false, health_metric: false, narrative: true },

  // ── Embeddings ──────────────────────────────────────────────────────
  embedding_computed:                      { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },

  // ── Bridge — opencode ───────────────────────────────────────────────
  bridge_invoked:                          { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  bridge_frame_received:                   { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  bridge_completed:                        { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  bridge_failed:                           { producer: "runtime",   embeddable: false, mirror_inline: true,  health_metric: false, narrative: true },
  bridge_mcp_connected:                    { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },

  // ── Dispatcher (cycle-1 enforcement) ────────────────────────────────
  brain_dispatched:                        { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  brain_dispatch_closed:                   { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  brain_cycle_2_started:                   { producer: "brain",     embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  continue_cycle_requested:                { producer: "brain",     embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  dispatcher_violation:                    { producer: "runtime",   embeddable: false, mirror_inline: true,  health_metric: true, narrative: true },

  // ── Stakeholder model ───────────────────────────────────────────────
  stakeholder_state_recorded:              { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  stakeholder_interaction_edge:            { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  stakeholder_alignment_observed:          { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },

  // ── Owner channel ───────────────────────────────────────────────────
  owner_input_received:                    { producer: "claude",    embeddable: true,  mirror_inline: false, health_metric: false, narrative: true },
  owner_decision_recorded:                 { producer: "claude",    embeddable: true,  mirror_inline: false, health_metric: false, narrative: true },
  owner_observed_outcome_recorded:         { producer: "claude",    embeddable: true,  mirror_inline: false, health_metric: false, narrative: true },
  owner_input_required:                    { producer: "brain",     embeddable: false, mirror_inline: true,  health_metric: false, narrative: true },
  // ── Human-In-the-Loop (HIDL) action surface ─────────────────────────
  // Substrate-emitted when an in-flight action cannot proceed without an
  // out-of-band human decision (auth/quota/env missing, an irreversible
  // effect is about to fire, or a constitutional gate refused). This
  // generalizes the legacy `owner_input_required` brain-side prompt:
  // anywhere in the runtime can route a block to the operator via this
  // event, and the orchestrator MUST surface it inline (mirror_inline)
  // so the owner sees the blocker in the chat surface without opening
  // logs. Embeddable so retrieval lookups over `summary` + `reason`
  // find the precedent (recurrence of the same HIDL reason is itself
  // a learnable signal).
  //
  // Payload shape:
  //   {
  //     summary: string;            // one-line human-readable reason
  //     reason: "auth_expired" | "quota_exhausted" | "env_missing"
  //           | "irreversible_about_to_fire" | "owner_decision_needed";
  //     blocked_task_id: string;    // the task pausing on this HIDL
  //     suggested_action: string;   // what the owner should DO next
  //     evidence_event_ids: string[]; // upstream rows the operator can audit
  //   }
  hidl_action_required:                    { producer: "substrate", embeddable: true,  mirror_inline: true,  health_metric: false, narrative: true },

  // ── Crisis mode ─────────────────────────────────────────────────────
  crisis_mode_engaged:                     { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: true },
  crisis_mode_disengaged:                  { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: true },
  crisis_postmortem_opened:                { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  latm_suspended_in_crisis:                { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },

  // ── Stakeholder adjudication ────────────────────────────────────────
  stakeholder_conflict:                    { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: true },
  stakeholder_conflict_detected:           { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: true },

  // ── External-service push ───────────────────────────────────────────
  external_event_received:                 { producer: "runtime",   embeddable: true,  mirror_inline: false, health_metric: false, narrative: false },
  state_snapshot_recorded:                 { producer: "runtime",   embeddable: true,  mirror_inline: false, health_metric: false, narrative: true },
  state_snapshot_diffed:                   { producer: "runtime",   embeddable: true,  mirror_inline: false, health_metric: false, narrative: true },
  external_source_quarantined:             { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  external_source_rehabilitated:           { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },

  // ── Daemon lifecycle ────────────────────────────────────────────────
  daemon_started:                          { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  daemon_shutdown:                         { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  restart_drain_started:                   { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: true },
  restart_drain_completed:                 { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: true },
  restart_drain_timed_out:                 { producer: "runtime",   embeddable: false, mirror_inline: true,  health_metric: true,  narrative: true },
  daemon_index_rebuilt:                    { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  daemon_ready:                            { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  daemon_unhandled_rejection:              { producer: "runtime",   embeddable: false, mirror_inline: true,  health_metric: true,  narrative: true  },

  // ── Daemon ops (crash recovery + DB integrity) ──────────────────────
  integrity_check_completed:               { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  integrity_check_failed:                  { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  wal_checkpointed:                        { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  dispatch_recovered_orphan:               { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },

  // ── Closure audit + lessons learned (universal post-trajectory loop) ─
  //
  // Every task's terminal commit MUST be preceded by a task_closure_audited
  // event scoring closure_residual ∈ [0,1] against the ORIGINAL goal text.
  // When closure has decomposable reliability / quality evidence, payload
  // SHOULD include open-ended Record<string,number> axis vectors such as
  // reliability_profile, closure_breakdown, or outcome_dimensions. Axis names
  // are discovered per goal-domain; examples are not a fixed schema.
  // The brain emits task_closure_audited + zero-or-more lesson_extracted +
  // optional contract_amendment_proposed events before task_committed for
  // the root task of any directive. See prompt_composer.ts WORKFLOW_TEXT
  // steps 7-8 for the exact contract and CLAUDE.md §"Closure + learning".
  // 2026-05-15 right-sizing: closure audits carry structured residual metadata,
  // not retrievable text. The semantic content (what the goal was, what was
  // missed) lives on the directive/task nodes themselves.
  task_closure_audited:                    { producer: "brain",     embeddable: false, mirror_inline: false, health_metric: false, narrative: true },
  lesson_extracted:                        { producer: "brain",     embeddable: true,  mirror_inline: false, health_metric: false, narrative: true },
  contract_amendment_proposed:             { producer: "brain",     embeddable: true,  mirror_inline: false, health_metric: false, narrative: true },
  // Pre-apply correction/adversarial primitive. Payload carries free-string
  // verdict plus target_event_id, adjudicator_origin, evidence_event_ids,
  // and optional owner_authority_level; verdict is intentionally NOT an enum.
  pre_apply_adjudication_recorded:          { producer: "both",      embeddable: true,  mirror_inline: false, health_metric: false, narrative: true },
  // Runtime self-diagnostic (SELF01-04 unified primitive from directive
  // DNXPNDPBEN0MF8B5S4DTFMNP98). Any runtime — bun, uv, camofox-browser,
  // opencode_bridge — emits this when it detects a fault. Free-string
  // `runtime` and `fault_kind` per the universal-kind principle (examples:
  // missing_binary, missing_credential, sandbox_violation, silent_exit,
  // handshake_timeout, network_unreachable). Optional `repair_hint`
  // (human-readable) and `auto_repair_action` (machine-executable shell
  // command + sandbox decl). A reconciliation worker watches for fault
  // patterns and either executes auto_repair_action under owner-approval
  // sandbox or surfaces via owner_input_required for manual action.
  // Per VQA4E2HC3H7X: today only bun preflights — uv and camofox silently
  // pass. This event closes that diagnostic gap.
  runtime_self_diagnostic_recorded:         { producer: "runtime",   embeddable: true,  mirror_inline: false, health_metric: true,  narrative: true },

  // ── Application of lessons + amendments (Option D + Claude subagent executor) ──
  //
  // The brain proposes via lesson_extracted / contract_amendment_proposed.
  // lesson_apply_requested records the owner/auto-gated handoff into the
  // applier before any semantic edit occurs. The orchestrator (main Claude
  // Code) reads those events, spawns a Claude
  // Agent subagent in background_task that performs the semantic file edit
  // + runs the verifier (bun test, lint, type-check) + commits via git.
  // applied_change_committed fires for EVERY apply attempt (success / failed
  // / refused) carrying status + source_kind in payload. Audit #3 collapse
  // (owner-approved 2026-05-16): lesson_applied + contract_amendment_applied
  // are DELETED — they differed only by source_kind which is now in payload.
  lesson_apply_requested:                  { producer: "claude",    embeddable: false, mirror_inline: false, health_metric: false, narrative: true },
  applied_change_committed:                { producer: "claude",    embeddable: false, mirror_inline: true,  health_metric: false, narrative: true },
  // Owner profile (UX dispatch b71pfyddv, 2026-05-15, knowledge_candidate
  // 540ZQYN3): stable owner preferences (language, tone, working hours,
  // boundaries) accumulate as substrate-side profile events so they
  // outlive the rolling 8-row OWNER CONTEXT window. Claude + brain BOTH
  // emit owner_insight_candidate from chat / trajectory observations; the
  // substrate (Model D) periodically promotes consensus insights into a
  // canonical owner_profile_recorded row.
  owner_profile_recorded:                  { producer: "substrate", embeddable: true,  mirror_inline: false, health_metric: false, narrative: true },
  owner_insight_candidate:                 { producer: "brain",     embeddable: true,  mirror_inline: false, health_metric: false, narrative: true },
  // Onboarding demo router (brain dispatch bp93s80hn): records the
  // classifier decision before the demo action runs so outcomes train which
  // demo family fits which owner sentence.
  // Payload: {demo_recipe_id, matcher_id, confidence, owner_sentence, required_auth?: string[]}.
  demo_dispatched:                         { producer: "claude",    embeddable: true,  mirror_inline: false, health_metric: false, narrative: false },

  // Auto-apply worker (DGT1MKXY proposal, 2026-05-15): daemon-side scanner
  // signals each lesson_implementer_queue_view row whose auto_apply_eligible=1.
  // Stage-1 emits this signal so the orchestrator (or future stage-2 mechanical
  // applier) sees the eligible row without polling. Carries {source_event_id,
  // source_kind, target, anchor, structured: bool, scanned_at}.
  auto_apply_signaled:                     { producer: "substrate", embeddable: false, mirror_inline: true,  health_metric: false, narrative: true },
  // Stage-2 outcome: emitted when the auto-apply worker attempted a
  // mechanical replacement, ran tests, and EITHER tests failed OR the
  // diff couldn't be applied unambiguously. The source proposal's
  // posterior should demote on this signal — the brain's proposed shape
  // was wrong even though it passed structural gates.
  applied_change_failed:                   { producer: "substrate", embeddable: false, mirror_inline: true,  health_metric: true, narrative: true },
  // ── Lesson-apply flywheel intermediates (audit-#7, 2026-05-15) ───────
  // Pre-fix these kinds were emitted by the lesson-apply subsystem but
  // absent from EVENT_KINDS — they bypassed embedding eligibility, the
  // health-metric tag filter, and the type system. Registering them
  // properly closes the kind-registry drift gap and ensures the surfaces
  // (TUI Lessons panel, embedding worker, mirror-inline rule) see them.
  // 2026-05-15 right-sizing: pipeline intermediates with structured payloads
  // (no retrievable semantic text).
  apply_candidate_selected:                { producer: "claude",    embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  apply_owner_gate_evaluated:              { producer: "claude",    embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  apply_executor_action_predicted:         { producer: "claude",    embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  apply_change_verified:                   { producer: "claude",    embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  applied_change_compounding_measured:     { producer: "claude",    embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  lesson_apply_candidate_opened:           { producer: "claude",    embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  lesson_apply_gate_evaluated:             { producer: "claude",    embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  lesson_apply_plan_verified:              { producer: "claude",    embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  lesson_apply_planned:                    { producer: "claude",    embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  lesson_apply_verifier_scored:            { producer: "claude",    embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  lesson_compounding_measured:             { producer: "claude",    embeddable: false, mirror_inline: false, health_metric: false, narrative: false },

  // ── Substrate self-events ───────────────────────────────────────────
  projection_checkpointed:                 { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  constitutional_gate_decision:            { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  dispatch_decided:                        { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  self_modification_recorded:              { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  recipe_extracted:                        { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: true },
  recipe_invoked:                          { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  recipe_replay_aborted:                   { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  prompt_truncated:                        { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },

  // ── Father ──────────────────────────────────────────────────────────
  father_cycle_recorded:                   { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  father_yielded:                          { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  father_drift_detected:                   { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  father_self_suspended:                   { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  father_drift_resolved:                   { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },

  // ── Runtime sandbox enforcement ─────────────────────────────────────
  sandbox_enforced:                        { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  sandbox_degraded:                        { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },

  // ── Lifecycle ───────────────────────────────────────────────────────
  goal_committed:                          { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  goal_abandoned:                          { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },

  // ── Opencode subsystem upgrade ──────────────────────────────────────
  opencode_upgrade_started:                { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  opencode_upgrade_completed:              { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  opencode_upgrade_failed:                 { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },

  // ── Admin maintenance ───────────────────────────────────────────────
  admin_token_rotated:                     { producer: "claude",    embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  external_source_token_rotated:           { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  code_artifact_quarantine_overridden:     { producer: "claude",    embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  directive_archived_by_operator:          { producer: "claude",    embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  state_exported:                          { producer: "claude",    embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  state_imported:                          { producer: "claude",    embeddable: false, mirror_inline: false, health_metric: false, narrative: false },

  // ── Robustness telemetry (fail-fast taxonomy) ───────────────────────
  error_caught:                            { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  worker_tick_overrun:                     { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true, narrative: false },
  // Substrate-side proof of worker liveness (audit-#5, 2026-05-15). Emitted
  // by supervisedTick AFTER each successful body() with per-worker dampening
  // (WORKER_TICK_EVENT_DAMPEN_MS = 60s) so the scheduler's 500ms cadence
  // doesn't flood the ledger. Pre-fix the only liveness record was an
  // in-process Map lost across daemon restarts; the TUI Supervisor panel
  // and auditors could never see workers ticking.
  worker_tick_completed:                   { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  bridge_stuck:                            { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: true },
  runtime_subprocess_killed:               { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
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
  brain_prompt_composed:                   { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  // 2026-05-15 right-sizing: brain stdout chatter (1500+ events) and raw
  // reasoning frames pollute retrieval — the brain re-encounters its own
  // verbose self-talk. The distilled semantic claims live in
  // knowledge_candidate / lesson_extracted; embed those, not the trace.
  brain_message_emitted:                   { producer: "brain",     embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  brain_reasoning_recorded:                { producer: "brain",     embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  // ── Daemon source hot-reload (brain audit bqlr29psq, 2026-05-15) ────
  // When a source file under runtime/, substrate/, or cli/ changes, the
  // daemon's fs.watch worker emits daemon_hotreload_triggered. On success
  // (dynamic import + validation passed) daemon_hotreload_completed lands
  // with the swapped module path. On failure (syntax error / missing
  // expected export / quiescence-blocked target) daemon_hotreload_failed
  // lands with the rollback reason and the previous module reference
  // stays installed so the daemon never goes down on a bad edit.
  daemon_hotreload_triggered:              { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  daemon_hotreload_completed:              { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  daemon_hotreload_failed:                 { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true, narrative: false },
  // ── Hot-reload deep-improvement event kinds (2026-05-17) ────────────
  // Pre-improvement: the worker emitted `completed` whenever a dynamic
  // import returned without throwing — even when (a) the new module had
  // the wrong export shape, (b) no consumer was wired to pick up the new
  // code so the daemon's behavior was unchanged, (c) bursty editor saves
  // produced reload storms. The five kinds below restore truth to the
  // hot-reload audit trail.
  //
  // daemon_hotreload_rejected — validation refused the new module
  //   (expected_exports missing, smoke_probe failed). Previous reference
  //   stays in the reloadable registry; emit_count increments per attempt.
  //
  // daemon_hotreload_unmapped — a changed file landed under a watched
  //   directory but matched NO manifest entry. Operator sees the gap and
  //   can extend the manifest. Pre-fix these silently dropped.
  //
  // daemon_hotreload_rate_limited — the same module exceeded its
  //   `rate_limit.count` reloads in `rate_limit.window_ms`. Worker drops
  //   the reload + emits this; protects against save-loop storms (CI
  //   watcher, formatter rewriting after every save).
  //
  // daemon_hotreload_no_op — import returned successfully BUT no
  //   reloadable registry slot exists for the module. The substrate
  //   stays honest: the file was re-read but the live daemon's behavior
  //   did not change because no consumer reads through a reloadable
  //   accessor. This is the structural-truth fix — pre-fix these emitted
  //   `completed` and lied.
  //
  // daemon_hotreload_swapped — the reloadable registry slot accepted the
  //   new module; from this moment every consumer that calls .current()
  //   sees the new code. This is the canonical "the daemon actually
  //   updated" signal.
  daemon_hotreload_rejected:               { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true, narrative: false },
  daemon_hotreload_unmapped:               { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  daemon_hotreload_rate_limited:           { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  daemon_hotreload_no_op:                  { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  daemon_hotreload_swapped:                { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: true },
  // Hot-reload truth-in-audit follow-up (2026-05-17): full_restart
  // strategy is a NORMAL state, not a failure. Pre-fix every edit to a
  // full_restart-classed module emitted daemon_hotreload_failed{reason:
  // full_restart_required}, which counted toward the health_metric
  // failure budget (126/146 = 86% of "failures" in a 24h window were
  // this benign signal). The dedicated kind has health_metric=false so
  // the failure count reflects ACTUAL faults, and narrative=true so
  // operators still see the "needs restart" hint inline.
  daemon_hotreload_restart_pending:        { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: true },
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
  pathology_budget_debited:                { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  pathology_budget_exhausted:              { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true, narrative: false },
  // ── Prompt composition cache (brain elegance bc8je5f3x bet #4, 2026-05-15) ─
  // Telemetry only: cache_hit means composePrompt returned a recently-built
  // prompt without re-scanning the substrate; cache_miss means a fresh
  // composition ran. Operators watch hit rate to spot regressions where the
  // cache is too aggressive (stale prompts) or too lax (no measurable speedup).
  prompt_composition_cache_hit:            { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  prompt_composition_cache_miss:           { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },

  // ── Bridge-health gate (Batch 8.A, cites brain lesson 5SWP11NZFS3YX68Y95T164HT9W) ─
  // Substrate-emitted when ≥ BRIDGE_DEGRADATION_THRESHOLD bridge_failed events
  // land within BRIDGE_FAILURE_WINDOW_MS. Scheduler refuses opencode_brain
  // dispatches until bridge_health_recovered fires (no failures for
  // BRIDGE_HEALTH_COOLDOWN_MS). Brain proposed this in WORKFLOW_TEXT step-8
  // lesson_extracted (kind=failure_pattern) on 2026-05-15T02:10:08.725Z.
  bridge_health_degraded:                  { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true, narrative: false },
  bridge_health_recovered:                 { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },

  // ── Supervisor (Batch 8.B) — auto-stop stucks/loops at every level ──
  // Periodic worker emits this when it detects a pathology and applies the
  // corresponding corrective action (task_failed / directive_archived_by_operator
  // / bridge_health_degraded). Records what the supervisor saw + what it did
  // so operators can audit the auto-intervention chain.
  supervisor_intervention_recorded:        { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true, narrative: false },
  // Owner re-activates a directive previously archived by the supervisor
  // (task-explosion / dispatch-budget). The archive event preserved
  // quarantined_tasks payload; resume lifts the readyTasks filter so the
  // scheduler picks them up again. Owner directive 2026-05-15:
  // "system never should loose tasks if task explosion".
  directive_resumed:                       { producer: "claude",    embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  // Substrate compactor (Batch 10) — emitted when bridge_frame_received rows
  // older than COMPACTION_FRAME_RETENTION_MS were pruned. Audit-only.
  substrate_compacted:                     { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },

  // ── Previously-missing kinds (emitted at runtime, now registered) ───
  embedding_skipped_missing_api_key:       { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  cli_layout_migrated:                     { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
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

// ────────────────────────────────────────────────────────────────────
//  HOT-RELOAD INDIRECTION (2026-05-17, owner directive)
//
//  Pre-this-commit the daemon hot-reloaded substrate/event_kinds.ts
//  successfully but no consumer noticed: runtime/events.ts and
//  runtime/mcp_server/substrate_tools.ts both did
//  `import { EVENT_KINDS }` at module load and captured the OLD
//  reference. Every reload was a daemon_hotreload_no_op semantically
//  per the truth-in-audit principle (lesson PBY1A4BTK93QVF +
//  knowledge KXFD7GXSAH6S18: "extend hotreload_manifest strategies
//  and call-site indirection before proposing supervisor/process
//  work").
//
//  Fix: a synchronous indirection backed by a module-level mutable
//  ref + a registered reloadable that updates the ref on successful
//  reload. Validators call getCurrentEventKinds() and always see the
//  freshest accepted map. Cost is one extra function call per emit
//  validation — orders of magnitude cheaper than the daemon restart
//  that was previously required to teach the substrate a new kind.
//
//  Self-registration mirrors the prompt_composer.ts pattern. The
//  hot-reload worker's reloadable_slot lookup wires
//  manifest:substrate_event_kinds → this self-register entry → the
//  cache-busted import → validate() (shape) → swap → cached_kinds
//  is the new reference → every validator on the next emit sees it.
//
//  Truth-in-audit: the manifest now declares reloadable_slot:
//  "substrate_event_kinds" so a successful reload swaps the slot
//  AND surfaces version on the next daemon_hotreload_completed
//  event. Failed reloads (e.g. malformed registry) keep the
//  previous cached_kinds via reloadable.ts rollback semantics.

let cachedKinds: typeof EVENT_KINDS = EVENT_KINDS;

/** Synchronous accessor — every validator must read EVENT_KINDS
 *  through this function instead of capturing the import-time
 *  reference. Hot-reload swaps the underlying map; the next call
 *  sees the new kind without a daemon restart. */
export const getCurrentEventKinds = (): typeof EVENT_KINDS => cachedKinds;

/** Hot-reload swap point. The reloadable registry calls this after a
 *  successful load + validate so subsequent getCurrentEventKinds()
 *  calls return the new map. Exposed for tests + the registry only. */
export const __setEventKindsForReload = (fresh: typeof EVENT_KINDS): void => {
  cachedKinds = fresh;
};

// Self-register with the reloadable registry. Mirror of the
// prompt_composer.ts pattern. The smokeProbe asserts the loaded
// module exposes the three expected exports + at least one kind that
// existed at boot (sanity check the dynamic import didn't return an
// empty / unrelated object).
import { registerReloadable } from "../runtime/reloadable";
registerReloadable<{
  EVENT_KINDS: typeof EVENT_KINDS;
  EMBEDDABLE_KINDS: typeof EMBEDDABLE_KINDS;
  HEALTH_METRIC_KINDS: typeof HEALTH_METRIC_KINDS;
}>({
  name: "substrate_event_kinds",
  load: async (cacheBustUrl) => {
    if (cacheBustUrl) {
      const mod = await import(cacheBustUrl);
      // After import, update the local cache so consumers see
      // the new kinds on the next validation call.
      if (mod.EVENT_KINDS && typeof mod.EVENT_KINDS === "object") {
        cachedKinds = mod.EVENT_KINDS as typeof EVENT_KINDS;
      }
      return mod as {
        EVENT_KINDS: typeof EVENT_KINDS;
        EMBEDDABLE_KINDS: typeof EMBEDDABLE_KINDS;
        HEALTH_METRIC_KINDS: typeof HEALTH_METRIC_KINDS;
      };
    }
    return { EVENT_KINDS, EMBEDDABLE_KINDS, HEALTH_METRIC_KINDS };
  },
  validate: (mod) => {
    if (!mod.EVENT_KINDS || typeof mod.EVENT_KINDS !== "object") return "missing EVENT_KINDS export";
    if (!Array.isArray(mod.EMBEDDABLE_KINDS)) return "missing EMBEDDABLE_KINDS export";
    if (!Array.isArray(mod.HEALTH_METRIC_KINDS)) return "missing HEALTH_METRIC_KINDS export";
    // Sanity: at least one kind that existed at boot must still be
    // present (catches a dynamic import returning the wrong object).
    if (!("directive_opened" in mod.EVENT_KINDS)) return "EVENT_KINDS missing 'directive_opened' — wrong module?";
    return true;
  },
  smokeProbe: (mod) => {
    try {
      const kinds = Object.keys(mod.EVENT_KINDS);
      if (kinds.length < 50) return { ok: false, error: `EVENT_KINDS suspiciously small (${kinds.length} entries)` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
});
