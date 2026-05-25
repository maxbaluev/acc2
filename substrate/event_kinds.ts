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

  // Tier U/U5 Claude-agent job queue. The substrate never spawns Claude;
  // it requests work that a live, externally-launched Claude orchestrator
  // drains by claiming the job and later completing it with the same
  // act_tuple_recorded envelope used by every other execution peer.
  claude_agent_job_requested:              { producer: "runtime",   embeddable: true,  mirror_inline: false, health_metric: false, narrative: true },
  claude_agent_job_claimed:                { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: true },
  claude_agent_job_completed:              { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: true },
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
  // Tier-S2 causal-edge posterior (brain KC G3PR7X6TCD4T57D7T6GXCDY9AW,
  // 2026-05-19): substrate-emitted when the bounded causal-edge extractor
  // (runtime/causal_edge_extractor.ts) observes a pair of substrate
  // entities co-cited on the same act or wired by a task_edge_recorded
  // refinement edge. Carries { edge_class, node_a, node_b,
  // edge_act_artifact_id, source_act_id|source_event_id }. The
  // edge_act_artifact_id resolves to an act_artifact{kind:
  // causal_edge_predicate} row whose Beta posterior calibrates from
  // downstream outcome credit — citing the edge row's id on a future
  // act lets distributeCredit adjust the edge's posterior alongside its
  // endpoint nodes.
  causal_edge_observed:                    { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  // 2026-05-22: emitted by the causal-edge extractor's credit half when a
  // co-citing act's OWN residual (predicted_residual on the tuple, or its
  // projected action_scored residual) moves an edge's Beta posterior.
  // Carries { edge_act_artifact_id, source_act_id, act_residual, outcome,
  // posterior_alpha, posterior_beta, score }; idempotency key is
  // (edge_act_artifact_id, source_act_id). Without this registration the
  // real-mode daemon throws unknown_event_kind and the whole credit tick
  // aborts — the credit loop was double-inert before (scope mismatch +
  // unregistered emit kind).
  causal_edge_credited:                    { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  // Tier-S3 trajectory-motif posterior (brain KC G3PR7X6TCD4T57D7T6GXCDY9AW,
  // 2026-05-19): substrate-emitted when the bounded trajectory-motif
  // extractor (runtime/trajectory_motif_extractor.ts) observes a
  // frequent (≥ 3 occurrences in a 30-day window) ordered n-gram of
  // event kinds across directives. Carries { motif_act_artifact_id,
  // kinds, length, frequency, directive_count, avg_closure_residual,
  // admitted_this_tick }. The motif_act_artifact_id resolves to an
  // act_artifact{kind: trajectory_motif_predicate} row whose Beta
  // posterior calibrates from downstream closure outcomes — citing
  // the motif row on a future act lets distributeCredit adjust its
  // posterior alongside the entities it composes.
  trajectory_motif_observed:               { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  // Tier-S5 goal-shape predicate (brain KC G3PR7X6TCD4T57D7T6GXCDY9AW,
  // 2026-05-19): substrate-emitted when the bounded goal-shape
  // predicate extractor (runtime/goal_shape_predicate_extractor.ts)
  // groups recent act_artifact_score_updated residuals by goal_shape
  // and admits or refreshes an act_artifact{kind:
  // goal_shape_strategy_predicate} row. Carries { goal_shape,
  // predicate_act_artifact_id, sample_count, mean_residual,
  // std_residual, effective_score, last_observed_ts, created }. The
  // predicate row scores whether a given goal_shape tag PREDICTS
  // trajectory similarity (low variance of residual = good shape) —
  // the signal downstream T2.2/T2.3/T4.1 posteriors read.
  goal_shape_strategy_observed:            { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  // Tier-S1 DAG decomposition strategy (brain KC G3PR7X6TCD4T57D7T6GXCDY9AW,
  // 2026-05-19): substrate-emitted when the bounded decomposition-
  // strategy extractor (runtime/decomposition_strategy_extractor.ts)
  // buckets completed directives by DAG shape category and admits or
  // refreshes an act_artifact{kind:decomposition_strategy_predicate}
  // row. Carries { shape_category, predicate_act_artifact_id,
  // sample_count, mean_residual, std_residual, effective_score,
  // avg_fan_out, avg_max_depth, avg_total_nodes, last_observed_ts,
  // created }. The predicate row scores whether a given decomposition
  // SHAPE (wide_shallow / deep_narrow / balanced / tree_heavy /
  // minimal / other) PREDICTS closure_residual — the structural
  // primitive S1 closes the Tier-S sequence with.
  decomposition_strategy_observed:         { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },

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
  // ── RLM credit loop (brain knowledge_candidate KZE8EXYFWH7C, task_node
  //    FX9PZDQ3W932 — RLM_RETRIEVAL_ACTS_MIN_LEAP, 2026-05-18). The
  //    contraction-first slice: make retrieval credit observable so the
  //    substrate can DETECT which retrievals actually changed outcomes
  //    vs which were decorative. Two new event kinds:
  //
  //    retrieval_credit_attributed (substrate-emitted) — fires when an
  //    action_scored row carries low residual AND cites one-or-more
  //    retrieval_bindings via context_refs. Attributes credit per
  //    binding by Shapley-style equal-weight division (1/N per cited
  //    binding when N bindings were cited) modulated by polarity
  //    (negative residual → debit; positive → credit). Payload:
  //      { retrieval_binding_event_id, action_scored_event_id,
  //        contribution_score, polarity, residual_at_score,
  //        knowledge_source_event_id, projection_key }
  //    Idempotency: projection_key = retrieval_binding_event_id +
  //                 ":credit:" + action_scored_event_id ensures one
  //                 credit row per (binding, score) pair even on replay.
  //
  //    retrieval_rejected (brain or claude-emitted) — when a renderer
  //    or brain reads a retrieval_binding and decides it does NOT
  //    contribute (low relevance, contradicts task, owner-declined
  //    concept), it emits this event so the rejection is visible.
  //    Without rejection events, retrievals show "binding exists" but
  //    the substrate can't tell "was the LM forced to ignore it?"
  //    Payload:
  //      { retrieval_binding_event_id, reason, rejected_by, evidence_ref? }
  //    reason is open-ended (k_201): low_similarity, off_task,
  //    declined_concept, contradicts_belief, etc.
  retrieval_credit_attributed:             { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  retrieval_rejected:                      { producer: "both",      embeddable: false, mirror_inline: false, health_metric: false, narrative: true },
  // Substrate-authored when a retrieval_binding injects knowledge from one
  // directive into another directive's prompt/search surface. This makes
  // implicit cross-directive transfer auditable and creditable without
  // requiring the brain to explicitly cite the source directive.
  knowledge_propagated:                     { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: false },

  // ── T4.1 counterfactual credit (docs/roadmap.md Tier 6) ─────────────
  // At every selection boundary (artifact pick, route choice, retrieval
  // top-K filter) the substrate previously dropped the rejected
  // alternatives — selectors had no signal from outcomes the chosen
  // path produced. counterfactual_alternative_recorded persists the
  // rejected set with a window_seconds so a later worker can score
  // them against the chosen's residual:
  //   - chosen succeeded → small negative posterior delta on rejected
  //     (counterfactual_penalty: chosen was correct, you would have lost)
  //   - chosen failed    → small positive posterior delta on rejected
  //     (counterfactual_bonus: chosen lost, you MIGHT have done better)
  // Idempotency: counterfactual_credit:{counterfactual_event_id}:{rejected_id}
  // stamped on the act_artifact_score_updated payload via projection_key.
  // counterfactual_closure_audited records the closure-predicate proxy:
  // count of rejected_ids that subsequently won a later selection
  // within 24h / total rejected_ids — selectors that learn from
  // counterfactual posteriors should see their reject set re-enter the
  // chosen pool over time.
  counterfactual_alternative_recorded:     { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true,  narrative: false },
  counterfactual_closure_audited:          { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true,  narrative: false },

  // ── Act artifacts (polymorphic handle registry, F4a 2026-05-18) ────
  // F4a (roadmap WW7W1NZ8A10R52PB4E7EJE9YBW): kinds were code_artifact_*
  // before the rename. Historical events in the ledger retain the old
  // kind strings; the legacy aliases below are kept so existing-row
  // queries continue to resolve. New emissions use the canonical
  // act_artifact_* names.
  act_artifact_candidate:                  { producer: "brain",     embeddable: true,  mirror_inline: false, health_metric: false, narrative: false },
  // 2026-05-15 right-sizing: act_artifact_admitted payload carries only
  // {artifact_id, runtime, score, confidence} — the BODY lives in
  // act_artifact.body, never in the event. Retrieval over artifacts goes
  // through act_artifact_registry_view; embedding the admission record
  // returned 0% text-hit on 342 events.
  act_artifact_admitted:                   { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  act_artifact_admission_rejected:         { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  // 2026-05-19 (brain EH5A37DPHX0GSCJKBSRNZDX700): substrate auto-admits
  // unseen verifier_kinds as kind="verifier" act_artifact rows at the
  // action_scored projection boundary (runtime/events.ts), with neutral
  // Beta(1,1) prior so credit accrues on every subsequent action_scored.
  // For peer_llm_opencode_* variants the row carries
  // parent_kind=peer_llm_opencode, variant_tag, rollup=true as METADATA
  // — a follow-up verifier_rollup_evaluator worker will route credit to
  // the parent until promotion criteria (≥3 obs, ≥2 directives, OR
  // residual diverges ≥ 0.20) are met. Narrative-only: surfaces in the
  // default tail so operators see new verifier_kinds enter the registry.
  verifier_kind_auto_admitted:             { producer: "runtime",    embeddable: false, mirror_inline: false, health_metric: false, narrative: true },
  // C1 (2026-05-18): substrate-side structural admission gate that
  // runs alex_predicate_* knowledge_candidates against
  // act_artifact_candidate bodies whose audience tag is
  // ceo_buyer / external_executive. Health-metric so dashboards can
  // surface how often the gate fires (k_252 advisory→structural
  // conversion evidence).
  predicate_gate_rejected:                 { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: true,  narrative: false },
  // C3 (2026-05-18, directive QHTRBV6PFX2JVBMHDNDA4B03GC): substrate-side
  // structural strategy-first gate. Rejects any act_artifact_candidate
  // whose `name` starts with `atms_report_v` when `cited_knowledge_ids`
  // lacks at least one knowledge_candidate with claim ending
  // `_strategic_direction_chosen`. Closes the failure mode where report
  // v1-v3 picked initiatives from substrate priors WITHOUT first
  // synthesising a strategic direction (lesson 4JGQAN7NFH1XH9M4VARB4RNJ8M
  // `strategic_first_then_initiatives_lesson`). Health-metric so
  // dashboards can show how often the gate fires.
  atms_strategy_first_violation:           { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: true,  narrative: false },
  // F4c (2026-05-18, contract 897XTN2GF11XB9D4N45N2R9W58): emitted by
  // seedArtifactKindMetadata once per fresh install / migration so the
  // event ledger records which kinds the substrate is born believing
  // need strategic grounding. Health-metric so the catalog's growth is
  // auditable.
  artifact_kind_metadata_seeded:           { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: true,  narrative: false },
  // F4c (2026-05-18): emitted whenever the posterior on a kind's
  // `needs_strategic_grounding` shifts (owner-rejection feedback path,
  // future verifier-outcome paths). Carries the previous/new score and
  // the posterior counts so credit attribution can replay the change.
  artifact_kind_strategic_grounding_updated: { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: true,  narrative: false },
  // C5 (2026-05-18, contract HJJS1665H961B2SRYHC5J85D14): emitted when
  // a published_drive_doc admission (or explicit operator action) marks
  // a prior artifact superseded by a newer one. Carries
  // {prior_artifact_id, new_artifact_id, kind, target_resources}.
  // Non-destructive — the substrate flips the prior row's
  // superseded_by field; trashing the external Drive doc remains an
  // explicit owner action.
  act_artifact_superseded:                 { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: true },
  // C2 (2026-05-18, contract V32YTK7HKN6MS38KWJY1SKTXAW): substrate-side
  // admission gates for the render pipeline (markdown_body ×
  // docx_reference_style → rendered_docx → published_drive_doc). Each
  // kind below carries the reason string emitted by the gate when
  // payload metadata fails the structural check (missing input
  // artifact id, wrong kind on resolved id, PDF target in the
  // Alex-facing path). Health-metric so dashboards can surface how
  // often the gate fires.
  rendered_docx_invalid_inputs:            { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: true,  narrative: false },
  published_drive_doc_invalid_inputs:      { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: true,  narrative: false },
  act_artifact_promoted:                   { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: true },
  act_artifact_quarantined:                { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  // Terminal retirement (sandbox audit bsfxsvgh9, 2026-05-15): unlike
  // quarantine, retired artifacts are NEVER re-admitted. Triggered by
  // accumulated hard kills / repeat quarantines / unconsented irreversibles.
  act_artifact_retired:                    { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: true, narrative: false },
  // Per-counter audit emitted by recordArtifactKill so the substrate
  // shows WHY recent_kill_count climbed (and from which event).
  artifact_health_counter_updated:         { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  act_artifact_rehabilitated:              { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  // RESIDUAL_D (directive 3XETJCYT): OFFENSIVE half of the artifact
  // lifecycle. The defensive loop (maybeQuarantine/maybeRetire) only
  // DEMOTES a failing artifact; capability_gap_detected is the durable,
  // ledgered trigger emitted by runtime/capability_gap.ts when an
  // artifact the defensive loop already quarantined/retired keeps failing
  // (rolling residual ≥ band over ≥ N obs) for a goal_shape that still has
  // demand. The worker then opens a brain-authoring directive so a
  // more-effective replacement is authored (the brain authors; the
  // detector only triggers). health_metric so dashboards surface how
  // often the offensive loop fires. capability_gap_resolved is the
  // resolution marker that closes the idempotency window for a pair.
  capability_gap_detected:                 { producer: "runtime", embeddable: false, mirror_inline: false, health_metric: true,  narrative: true },
  capability_gap_resolved:                 { producer: "runtime", embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  act_artifact_score_updated:              { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  // T0.2 universal projection — emit-boundary projector for action_scored
  // walks source_act_event_id → action_predicted's cited_artifact_ids and
  // emits act_artifact_score_updated per cited artifact. Errors during
  // that projection emit a projection_error row (fail-soft: the parent
  // action_scored already landed; the error is observable for audits but
  // does not block the primary emit).
  projection_error:                        { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  // T4.2 meta-credit (roadmap.md §T4.2) — when distributeCredit projects a
  // residual outcome, the COMPOSER policy bundle / prompt section that was
  // active for the task at scoring time accrues posterior alongside the
  // artifact/knowledge it selected. One meta_credit_projected row per
  // selected policy_bundle per scored event so the credit chain shows the
  // "scorer behind the score". Embedded act_artifact_score_updated emit
  // for the bundle row is the structural mutation; this kind is the
  // audit surface.
  meta_credit_projected:                   { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true,  narrative: false },
  // T4.3 brain prediction-accuracy posterior (roadmap.md §T4.3) — at each
  // brain dispatch close (or whenever an action_predicted with the brain
  // as substrate_origin meets its action_scored), |predicted − observed|
  // is the brain's calibration sample. The substrate emits one
  // brain_accuracy_observation per (action_predicted, action_scored) pair
  // and updates a per-goal_shape brain_accuracy_predicate act_artifact
  // posterior — low residual → confirmed (brain predicted well),
  // high residual → contradicted (brain predicted poorly).
  brain_accuracy_observation:              { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true,  narrative: false },
  // T4.4 coalition / joint-citation posterior (roadmap.md §T4.4) — when
  // action_predicted.cited_artifact_ids.length > 1 (multiple artifacts
  // cooperated on the action), distributeCredit splits the residual
  // among them via shapleyWeightsByCorroboration(N). The coalition
  // itself is now first-class: a coalition_credit_distributed row
  // captures the (sorted) coalition id, per-member shapley shares, and
  // the observed residual so future routing can score combinations,
  // not just nodes.
  coalition_credit_distributed:            { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true,  narrative: false },
  // Dense post-closure credit (HCAPO arXiv:2603.08754 / Mem-T
  // arXiv:2601.23014: dense/hindsight credit > coarse terminal credit for
  // long-horizon agents). On a ROOT task's task_closure_audited, the
  // dense-credit pass walks the directive's OWN task DAG + the act/retrieval
  // citation graph and applies the existing credit primitives
  // (applyResidualOutcome / candidate_confirmed) to the INTERMEDIATE
  // contributors, weighted by closure_residual and damped by graph distance.
  // One dense_closure_credit_distributed audit row summarizes the bounded
  // pass (node count, contributors seen/credited, cap flag). Additive +
  // idempotent: dispatch, the four-link chain, and per-act terminal credit
  // are unchanged. health_metric so the pass's reach is observable.
  dense_closure_credit_distributed:        { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true,  narrative: false },
  // Observability-fidelity guard (2026-05-22, phase-2 SJPF3VB9). The
  // standing observability_guard_worker institutionalizes two bug
  // classes as permanent self-audits:
  //   - loop_inert_alert    — a wired loop emitted 0 over the trailing
  //     window while its upstream trigger fired >= min_upstream times
  //     (e.g. counterfactual_closure_audited=0 while
  //     counterfactual_alternative_recorded>50). The producer is wired
  //     but inert; without this alert the silence is invisible.
  //   - metric_veracity_alert — a status metric diverged from ground
  //     truth beyond tolerance (e.g. reported retrieval-index count
  //     vs. genuinely-embeddable event count). A lying metric.
  // Both health_metric so dashboards can plot guard firings; a rising
  // rate is a regression signal that a loop went silent or a metric
  // started lying.
  //   - error_flood_alert  — the same error_caught (where,message) repeated
  //     past ERROR_FLOOD_THRESHOLD inside a short flood window (default 50 in
  //     1h). The LOUD failure class the silent-loop/lying-metric checks
  //     missed: this session error_caught flooded 2245x/15min with the same
  //     vec0 message and only the owner caught it via `acc watch`. Grouping
  //     by (where,message) means a diversity of occasional recoverable
  //     errors is benign — only a single repeating culprit trips it.
  loop_inert_alert:                        { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true,  narrative: true },
  metric_veracity_alert:                   { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true,  narrative: true },
  error_flood_alert:                       { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true,  narrative: true },
  // Tier U/U1 peer registry foundation: participation is symmetric across
  // opencode brains, Claude terminals, and Claude background agents, while
  // spawning remains asymmetric (only opencode is substrate-spawnable).
  // peer_registered is the durable identity/scope row; peer_liveness is the
  // heartbeat/activity row used by peer_registry_view to age stale peers.
  peer_registered:                         { producer: "both",      embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  peer_liveness:                           { producer: "both",      embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  // F4a deprecated aliases — historical event rows wrote these kind
  // strings before the rename. Registered here so existing queries that
  // SELECT WHERE kind = 'code_artifact_admitted' still match. The
  // substrate emits the new act_artifact_* names going forward; only
  // historical rows carry the legacy strings. Surface flags are deliberately
  // false so the legacy strings do not count twice in derived sets
  // (HEALTH_METRIC_KINDS / EMBEDDABLE_KINDS) — the canonical
  // act_artifact_* entries above carry the live truth.
  code_artifact_candidate:                 { producer: "brain",     embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  code_artifact_admitted:                  { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  code_artifact_admission_rejected:        { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  code_artifact_superseded:                { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: true },
  code_artifact_promoted:                  { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: true },
  code_artifact_quarantined:               { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  code_artifact_retired:                   { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  code_artifact_rehabilitated:             { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  code_artifact_score_updated:             { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  // 2026-05-19 (brain dispatch J4HP5SYT3N4GK45S Candidate A — substrate-wide
  // kind="code_artifact" alias removal). The artifact_kind_backfill_worker
  // (runtime/artifact_kind_backfill_worker.ts) scans every act_artifact row
  // whose kind is the legacy default "code_artifact" and infers the
  // concrete kind from weighted evidence (name suffix → body signature →
  // declared_sandbox.runtime → state_root prefix). Three audit kinds:
  //
  //   artifact_kind_inferred — per-row inference verdict. NOT health-metric
  //     (every scanned row emits one; signal is in the breakdown rows).
  //     Surfaces evidence map (name_pattern / body_signature / runtime /
  //     state_root_prefix / source_candidate_id / target_resources) so the
  //     audit trail of WHY the worker picked the kind is replayable.
  //
  //   artifact_kind_backfilled — applied: kind column updated in place
  //     (high-confidence verdict ≥ 0.75). Health-metric so dashboards can
  //     count substrate-wide backfill convergence — the bigger this count
  //     is per sweep, the closer the substrate is to legacy-kind-zero.
  //
  //   artifact_kind_inference_uncertain — deferred: row stays as
  //     code_artifact because no evidence strand crossed the confidence
  //     floor. Health-metric so dashboards can show how many rows the
  //     sweep declined to mutate; non-zero count after a sweep is the
  //     signal a human-curated kind override may be needed.
  artifact_kind_inferred:                  { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  artifact_kind_backfilled:                { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true,  narrative: true  },
  artifact_kind_inference_uncertain:       { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true,  narrative: true  },
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
  origin_calibration_recorded:             { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  knowledge_uncertainty_observed:          { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: true },

  // ── External-source registration ────────────────────────────────────
  external_source_registered:              { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },

  // ── Embeddings ──────────────────────────────────────────────────────
  embedding_computed:                      { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },

  // ── Bridge — opencode ───────────────────────────────────────────────
  bridge_invoked:                          { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  bridge_frame_received:                   { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  bridge_completed:                        { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  bridge_failed:                           { producer: "runtime",   embeddable: false, mirror_inline: true,  health_metric: false, narrative: true },
  bridge_mcp_connected:                    { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  bridge_mcp_preflight:                    { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  // ── Brain-dispatch liveness heartbeat (2026-05-23 false-zombie fix) ──
  // Emitted by the opencode bridge on a ~60s timer while a brain subprocess
  // is ALIVE for an OPEN dispatch. opencode 1.4 buffers/bursts its stdout
  // frames and a slow MCP read over a large ledger can stall for minutes
  // with ZERO frames — yet the subprocess is healthy and actively working.
  // The dispatch_resolved_view zombie classifier flags a dispatch when the
  // oldest open dispatch is > 300s old AND there is NO event for the
  // directive in the last 3 minutes. A silent-but-alive brain therefore got
  // FALSE-flagged as zombie. This heartbeat carries the SAME directive_id
  // the zombie view's activity-guard filters on, so a live dispatch always
  // shows recent activity and the false-zombie window closes — WITHOUT
  // touching the zombie view itself. The timer is cleared on every
  // subprocess-exit path (proc.exited / closeBrainDispatch / timeout / kill)
  // and .unref()'d so it never blocks process exit. Strictly substrate-
  // internal: NOT narrative (one row/min/live-dispatch would flood the
  // owner stream), NOT embeddable, NOT health_metric, NOT mirror_inline.
  // Payload: { dispatch_id, directive_id, task_id, heartbeat_seq,
  // subprocess_pid, emitted_at_ms }.
  brain_liveness_heartbeat:                { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },

  // ── Dispatcher (cycle-1 enforcement) ────────────────────────────────
  brain_dispatched:                        { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  brain_dispatch_closed:                   { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  brain_cycle_2_started:                   { producer: "brain",     embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  continue_cycle_requested:                { producer: "brain",     embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  dispatcher_violation:                    { producer: "runtime",   embeddable: false, mirror_inline: true,  health_metric: true, narrative: true },

  // ── Stakeholder model ───────────────────────────────────────────────
  stakeholder_state_recorded:              { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },

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
  //     reason: string;             // OPEN-ENDED — vocabulary discovered from use,
  //                                 //   not a closed enum. The substrate refuses
  //                                 //   any schema that constrains this to a fixed
  //                                 //   union. Examples that exist today AND
  //                                 //   tomorrow span the full goal space:
  //                                 //   auth_expired, quota_exhausted, env_missing,
  //                                 //   irreversible_about_to_fire,
  //                                 //   owner_decision_needed (devops blockers);
  //                                 //   emotional_readiness, stakeholder_boundary,
  //                                 //   fatigue, consent_unclear, grief_timing,
  //                                 //   social_risk, calendar_conflict, energy_low,
  //                                 //   relational_repair_pending (human blockers);
  //                                 //   plus any reason that emerges from future use.
  //     blocked_task_id: string;    // the task pausing on this HIDL
  //     suggested_action: string;   // what the owner should DO next
  //     evidence_event_ids: string[]; // upstream rows the operator can audit
  //   }
  hidl_action_required:                    { producer: "substrate", embeddable: true,  mirror_inline: true,  health_metric: false, narrative: true },

  // ── Crisis mode ─────────────────────────────────────────────────────
  crisis_mode_engaged:                     { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: true },
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
  // 2026-05-23: MCP session GC. fastmcp's httpStream transport keeps one
  // FastMCPSession per client connection; ungracefully-closed clients leak
  // their session (the server-side transport.onclose never fires on its
  // own). After hundreds accumulate the daemon event loop pegs CPU. The
  // mcp_session_reaper worker force-closes dead/idle/over-cap sessions and
  // emits this event with the reaped count + remaining count so the GC is
  // visible in the ledger. Only emitted when at least one session is reaped.
  mcp_sessions_reaped:                     { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  // 2026-05-23 event-class tiering: emitted by the telemetry-eviction
  // sweep (runtime/archival_worker.ts runTelemetryEvictionSweep) when it
  // purges EPHEMERAL_TELEMETRY_KINDS rows older than a short TTL from the
  // hot `events` table. These are pure process telemetry with ZERO
  // compounding/credit/retrieval value whose only consumers are
  // observability/health counters (and those counters read a RETAINED
  // running-count aggregate in `meta`, not the raw rows). Payload:
  //   { by_kind: Record<string, number>, count: number,
  //     retention_hours: number, cutoff_iso: string }.
  // health_metric so the eviction's reach is auditable in
  // `acc admin substrate-status`; narrative so an operator tailing the
  // ledger sees the hot-ledger shrink. Not embeddable (numeric only).
  telemetry_evicted:                       { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true,  narrative: true },

  // ── MCP operation receipt + non-blocking projection cascade ──────────
  // (directive NHY908W0EX5Q72KGWXMASPFEY0, amendments N71APFH5Y9 /
  //  B0DVM2APWX / 9J0CSDP7ND, 2026-05-24).
  //
  // ROOT CAUSE addressed: emitEvent ran its full post-insert projection
  // cascade (recordInternalAct / dense-closure / action_scored projectors
  // / artifact-candidate screen / verifier auto-admit / entity+owner-profile
  // attribute writes) SYNCHRONOUSLY on the single bun event loop, so a
  // heavy write cascade over a large ledger could monopolize the loop past
  // the MCP client deadline and return "Request timed out" while the daemon
  // was alive. The fix makes emitEvent DURABLE-FIRST: the row is INSERTed
  // and the in-process bus/activation notification fires, then every heavy
  // projection branch is enqueued onto a BOUNDED post-commit projection
  // queue that drains in event-loop-yielding slices (runtime/post_commit_
  // projection_queue.ts). emitEvent returns its {id, ts} ack the moment the
  // row is durable — never before persistence, so we never ack a write that
  // is not committed.
  //
  // Vocabulary (producer=runtime, not brain-emissible):
  //  - mcp_operation_watchdog_fired — exactly one fire-once watchdog per
  //    armed projection drain detected no progress within the budget.
  //    Payload: {watchdog_id, queue_depth, last_drained_seq, hung_for_ms}.
  //  - post_commit_projection_overflow — the BOUNDED queue rejected an
  //    enqueue because depth hit its cap (backpressure, OOM guard). The
  //    durable event row is already persisted; only the deferred projection
  //    is dropped, and THIS row is the clear overflow signal so the loss is
  //    never silent. Payload: {dropped_kind, dropped_event_id, queue_depth,
  //    cap}. health_metric so overflow pressure is auditable.
  mcp_operation_watchdog_fired:            { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true,  narrative: true },
  post_commit_projection_overflow:         { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true,  narrative: true },

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
  // T0.1 substrate-truth gate (brain dispatch TFZ6AJXNPS6655QMFWT6KPB3QM,
  // amendment R8GNSJ63DH7AZE16E05GSJD5Y4). Emitted by runtime/closure_audit.ts
  // when a closure attempt declares target_files AND the asserted residual is
  // below the 0.3 commit gate AND the substrate has zero
  // contract_amendment_proposed rows matching those files on the same
  // directive. The closure is refused — task_closure_audited is rewritten
  // with residual=1.0 + substrate_verifications.target_files_have_amendments
  // = false. Operators MUST see these (narrative + health_metric) so the
  // k_252 advisory-gate fake at the closure boundary surfaces in real time.
  // Not embeddable: payload is structural (file list + query) with no
  // retrievable semantic text.
  // Payload contract:
  //   {
  //     directive_id: string,
  //     task_id?: string,
  //     target_files: string[],          // normalized to repo:<path>
  //     query: string,                   // the SQL the substrate ran
  //     asserted_residual: number,       // what the brain claimed
  //     residual: 1.0,                   // what substrate verified to
  //     evidence_event_ids: string[],    // matching amendments (empty here)
  //     reason: "no_contract_amendment_for_declared_target_files"
  //   }
  closure_blocked_no_amendments:           { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true,  narrative: true },
  // Hardened closure commit gate (2026-05-20). Refuses task_committed when the
  // current root's most recent task_closure_audited row carries
  // closure_residual >= getThreshold(db, "closure_gate_residual_threshold", 0.3)
  // and no fresh owner_input_received{closure_override:true} is on file.
  // Closes the k_252 advisory-gate fake at the dispatcher boundary — pre-fix
  // the workflow documented "closure_residual >= 0.3 → refine, do NOT commit
  // root" but the dispatcher committed anyway (10 task_committed events at
  // closure_residual >= 0.3 in the last 24h of live evidence; 3 at residual
  // = 1.00). Payload:
  //   {
  //     task_id: string,
  //     closure_residual: number,
  //     threshold: number,
  //     discrepancies?: string[],
  //     closure_audit_event_id: string,
  //     recommended_action: "refine_or_decline"
  //   }
  closure_blocked_high_residual:           { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true,  narrative: true },
  // Owner consent override acknowledgement: when an owner_input_received
  // event carrying payload.closure_override = true post-dates the most
  // recent task_closure_audited row, the gate permits commit and stamps
  // this acknowledgement on the ledger for audit. Stale overrides (older
  // than the audit) do NOT unlock commit — every fresh audit re-locks the
  // gate. Payload:
  //   {
  //     task_id: string,
  //     closure_residual: number,
  //     threshold: number,
  //     closure_audit_event_id: string,
  //     override_event_id: string,
  //     override_ts: string
  //   }
  closure_override_acknowledged:           { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true,  narrative: true },
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
  // ── Owner-visible rendering loop (brain contract Q471RAN88X0H513V8BC3BTW0AW,
  //    2026-05-17). The substrate is the operator; owner-facing primary
  //    surfaces must hide IDs/jargon and render in the owner's language.
  //    These two events close the four-link chain (k_555): rendering policy
  //    is composed from owner_profile_view → renderer emits the message →
  //    rendered_owner_message_recorded captures what was shown → owner's
  //    next behavior (correction / decline / approval / ignored) →
  //    owner_rendering_feedback_recorded credits the policy.
  //
  //    Payload shape (rendered_owner_message_recorded):
  //      { rendered_text, audience: "primary"|"detail_drawer", policy_snapshot,
  //        owner_profile_hash, suppressed_refs: string[],
  //        intended_owner_action: string, est_attention_cost: number,
  //        renderer: string, surface: "tui"|"chat"|"export"|... }
  //
  //    Payload shape (owner_rendering_feedback_recorded):
  //      { source_rendered_event_id, feedback_kind: string,  // open-ended
  //        evidence: string, residual?: number,
  //        observed_behavior: string, policy_snapshot_hash? }
  //    feedback_kind is intentionally free-string — examples include
  //    correction, decline, ignored_ask, repeated_clarification,
  //    confirmation, satisfaction, manual_override. Vocabulary discovered
  //    through use, NOT a fixed persona enum.
  rendered_owner_message_recorded:         { producer: "claude",    embeddable: true,  mirror_inline: false, health_metric: false, narrative: true },
  owner_rendering_feedback_recorded:       { producer: "claude",    embeddable: true,  mirror_inline: false, health_metric: false, narrative: true },
  // ── Owner world-model evidence layer (brain contract CY7E62DSNX1DZ1BTD56845D994,
  //    2026-05-18). The owner_profile is a static signal vector; this layer
  //    adds dynamic latent-state belief + prediction-error update so the
  //    substrate maintains a true owner world model (per 2026 alignment
  //    literature — user as stochastic process with latent goals/skills/
  //    constraints, updated by observation).
  //
  //    All payload fields are OPEN-ENDED (free strings + numbers + arrays):
  //    no closed persona enums, no fixed register/skill taxonomy. The
  //    extractor merger discovers vocabulary from real owner traces.
  //
  //    owner_state_hypothesis_recorded payload shape:
  //      {
  //        latent_state: {
  //          goal_intent: string,                  // free-string + confidence
  //          attention_budget: string,             // e.g. "low" | "medium" | "high" (free)
  //          energy_budget: string,                // free
  //          emotional_register: string,           // free (frustrated/satisfied/etc.)
  //          recent_disappointments: string[],
  //          recent_satisfactions: string[],
  //          working_memory_horizon: string,       // short | session | multi_day (free)
  //          decision_style: string,               // direct_confirm | options_first | etc.
  //          skill_calibration: { domain: string, estimated_skill: string, confidence: number },
  //          latent_larger_goal: string,
  //        },
  //        confidence: Record<string, number>,     // per-axis confidence ∈ [0,1]
  //        observation_refs: string[],             // event ids that ground the hypothesis
  //        decay_after_iso?: string,               // hypothesis stale after this ts
  //        uncertainty: number,                    // ∈ [0,1] aggregate
  //      }
  //
  //    owner_state_prediction_error_recorded payload shape:
  //      {
  //        hypothesis_event_id: string,
  //        interaction_event_id: string,           // the action/event being scored
  //        observed_signal: string,                // free description
  //        prediction_error: Record<string, number>, // per-axis residual ∈ [0,1]
  //        evidence_refs: string[],
  //      }
  //
  //    alignment_action_selected payload shape:
  //      {
  //        hypothesis_event_id: string,            // belief that informed the choice
  //        action_kind: string,                    // free: ask_clarification, defer,
  //                                                //   render_plain, render_technical,
  //                                                //   propose_alternative, etc.
  //        rationale: string,
  //        cited_artifact_ids?: string[],
  //      }
  owner_state_hypothesis_recorded:         { producer: "both",      embeddable: true,  mirror_inline: false, health_metric: false, narrative: true },
  owner_state_prediction_error_recorded:   { producer: "substrate", embeddable: true,  mirror_inline: false, health_metric: false, narrative: true },
  alignment_action_selected:               { producer: "both",      embeddable: true,  mirror_inline: false, health_metric: false, narrative: true },
  // Onboarding demo router (brain dispatch bp93s80hn): records the
  // classifier decision before the demo action runs so outcomes train which
  // demo family fits which owner sentence.
  // Payload: {goal_shape_tags, matcher_id, confidence, owner_sentence, required_auth?: string[]}.

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

  // ── Substrate self-events ───────────────────────────────────────────
  constitutional_gate_decision:            { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  dispatch_decided:                        { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  self_modification_recorded:              { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  // The recipe event family was absorbed into knowledge_candidate /
  // knowledge_promoted (carrying payload.recipe_shape) plus dispatch_decided
  // (route=substrate_replay) plus action_predicted/action_scored (citing the
  // selector artifact handles) under universality proposal
  // A12CR1QCDN0SS51CM95K39T45M, owner approval 7S0FQ8REES1XDEGQW7VVVEWSYW.
  prompt_truncated:                        { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  // Q2 (brain amendment MDBZV4YVRH7D172BW40W1J5ASM, 2026-05-19):
  // composer-side audit row recording WHICH precedence rung supplied a
  // policy section body (variant > retrieved_artifact > policy_bundle >
  // literal_missing_warning). One emit per pushPolicySection call;
  // payload carries section_name, source, artifact_id (when present),
  // score, fallback_reason (when literal).
  prompt_policy_section_selected:          { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  // Q3 (brain amendment 945GW64HN91JBD8YYTAR0S4P0W, 2026-05-19): emitted
  // when an admitted prompt_section_content_variant beats the
  // policy_bundle posterior (or ties it — tie row carries
  // policy_bundle_tie_preserved=true so the credit chain still credits
  // the tied variant when the outcome lands). Paired with one
  // retrieval_binding so artifact credit flows back to the variant_id
  // on action scoring.
  prompt_section_variant_selected:         { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },

  // ── Legacy Father diagnostics ───────────────────────────────────────
  // Deprecated: autonomous origination now uses normal directive/task/action
  // events plus scored forecast_predicate/autonomy_gate_predicate artifacts.
  // These rows remain only for historical ledger readability until migration.
  father_cycle_recorded:                   { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  father_yielded:                          { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  father_drift_detected:                   { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  father_self_suspended:                   { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  father_drift_resolved:                   { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },

  // ── Runtime sandbox enforcement ─────────────────────────────────────
  sandbox_enforced:                        { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  sandbox_degraded:                        { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },

  // ── Tier -1 floor enforcement (absence-of-violation evidence) ───────
  // Per docs/roadmap.md Tier -1: floors precede posterior scoring.
  // Each predicate (event_authenticity_predicate, storage_integrity_predicate,
  // deterministic_computation_sanity_predicate; rows admitted in seed.ts)
  // receives periodic evidence events that score residual=0 on clean
  // pass and route through integrity_check_failed on violation.
  // Workers:
  //   - runtime/event_authenticity_worker.ts (60s)
  //   - runtime/storage_integrity_worker.ts (5min) — also emits wal_checkpointed
  //   - runtime/deterministic_computation_worker.ts (10min)
  //   - runtime/kernel_sandbox_worker.ts (5min) — reuses sandbox_degraded
  //     above for the violation path; emits kernel_sandbox_check clean.
  //   - runtime/owner_identity_worker.ts (5min) — emits owner_identity_check
  //     clean; on discontinuity emits owner_identity_discontinuity AND
  //     owner_input_required so autonomous commit pauses.
  event_authenticity_check:                { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true,  narrative: false },
  storage_integrity_check:                 { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true,  narrative: false },
  deterministic_computation_check:         { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true,  narrative: false },
  kernel_sandbox_check:                    { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true,  narrative: false },
  owner_identity_check:                    { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true,  narrative: false },
  owner_identity_discontinuity:            { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true,  narrative: false },

  // ── Hot/cold archival worker (runtime/archival_worker.ts) ───────────
  // Per docs/Architecture.md commit 6b8ebea + brain KC TE6P3958
  // (conf=0.86): hot/cold archival is the ONLY policy that bounds
  // aggregate-scan cost independently of event production rate. The
  // 6h sweep moves events older than archival_retention_days into
  // sibling state-archive-YYYY-MM.db files (verify-then-delete);
  // archival_sweep_completed records the per-month deltas. On any
  // verify mismatch the archive transaction rolls back and
  // archival_integrity_failed fires (hot rows untouched).
  archival_sweep_completed:                { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true,  narrative: false },
  archival_integrity_failed:               { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true,  narrative: false },

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
  act_artifact_quarantine_overridden:      { producer: "claude",    embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  // F4a deprecated alias — see act_artifact_* block above.
  code_artifact_quarantine_overridden:     { producer: "claude",    embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  directive_archived_by_operator:          { producer: "claude",    embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  state_exported:                          { producer: "claude",    embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  state_imported:                          { producer: "claude",    embeddable: false, mirror_inline: false, health_metric: false, narrative: false },

  // ── Robustness telemetry (fail-fast taxonomy) ───────────────────────
  error_caught:                            { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  worker_tick_overrun:                     { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true, narrative: false },
  // Shared low-frequency safety net for reactive-primary workers. Emitted
  // by the daemon-owned safety-net sweep when it detects work that should
  // have been caught by activation_bus.onEvent but was not. Non-zero
  // missed_work_count is observability evidence for reactive misses.
  // Substrate-side proof of worker liveness (audit-#5, 2026-05-15). Emitted
  // by supervisedTick AFTER each successful body() with per-worker dampening
  // (WORKER_TICK_EVENT_DAMPEN_MS = 60s) so the scheduler's 500ms cadence
  // doesn't flood the ledger. Pre-fix the only liveness record was an
  // in-process Map lost across daemon restarts; the TUI Supervisor panel
  // and auditors could never see workers ticking.
  worker_tick_completed:                   { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  // SQL worker-thread pool metrics. Emitted by the daemon every ~30s with
  // pending / active / completed counters + percentile wait+exec latencies.
  // Health-metric so /metrics + observability dashboards can plot
  // event-loop unblock progress (Bun.SQL is fake-async — pre-pool baseline
  // = 3 worker tick overruns / 21 min, 28 dispatch orphan recoveries /
  // 15 min). Per T3.8/T5: the metric IS the live verification path.
  sql_worker_pool_metrics:                 { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true, narrative: false },
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
  // Brain-dispatch-survival gate (XA3ABKERHD4H + 77N73035F97Z, 2026-05-19):
  // emitted by the hot-reload quiescence callback in runtime/daemon.ts
  // when noActiveBrainDispatches(db) returns false — a recent
  // brain_dispatched row lacks brain_dispatch_closed within the 1-hour
  // recency window. health_metric=true so persistent deferrals surface
  // as a substrate-status signal (operator sees "reload deferred N times
  // waiting on brain close"); the orphan-close path emitted by
  // reconcileBrainDispatchesAtBoot / reconcileOrphanedDispatches is the
  // deterministic backstop so deferrals can't wedge forever.
  hotreload_deferred:                      { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true,  narrative: false },
  // ── Brain invocation as substrate-side primitive (2026-05-20) ───────
  // Per brain HCWM88JN0H6NDB8V amendment GMZ08ASMTD7W (cites prior
  // meta-verdict MYMQZFM2XX7732AQ conf=0.86 on subagent-spawning being
  // an unledgered execution lane). Any substrate component can emit
  // brain_invocation_request when its verifier/view detects design
  // ambiguity, structural fault, repeated silent exits, or insufficient
  // synthesis. The daemon's brain_invocation_worker (30s tick) reads
  // the queue, applies COSMIC SSA loop prevention (3 requests / 5min /
  // emitter_identity → throttle), dedups by topic_keywords +
  // triggering_event_ids (1h window), composes a directive, and
  // dispatches through the existing acc task entry point.
  brain_invocation_request:                { producer: "runtime",   embeddable: true,  mirror_inline: false, health_metric: false, narrative: false },
  brain_invocation_dispatched:             { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true,  narrative: false },
  brain_invocation_throttled:              { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true,  narrative: false },
  brain_invocation_failed:                 { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true,  narrative: false },
  // ── 2026 research integration (2026-05-20) ───────────────────────
  // SSGM memory reconciliation (Lam et al. 2026, arXiv:2603.11768):
  // periodic operator R re-aligns mutable in-memory caches against
  // the immutable ledger. drift_detected fires when cache hash
  // diverges from ledger projection; completed fires per clean tick.
  memory_reconciliation_completed:         { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true,  narrative: false },
  memory_reconciliation_drift_detected:    { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true,  narrative: false },
  // SAHOO safeguarded alignment (Sahoo et al. 2026, arXiv:2603.06333):
  // intrinsic diagnostics 5-tuple emitted per 10min tick — delegation
  // safety, drift bound headroom, closure residual avg, owner outcome
  // coverage, posterior promotion rate. Operators read the tuple to
  // catch recursive self-improvement regression.
  sahoo_diagnostics_recorded:              { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true,  narrative: false },
  // AgentCity constitutional ratification (Ruan & Zhang 2026,
  // arXiv:2604.07007): high-impact repo: amendment apply requires
  // multi-verifier consensus (claude + opencode + owner_consent when
  // owner_profile.things_to_never_do touched). Below count as health
  // metrics so dashboards plot ratification refusals + the
  // multi-verifier-consensus path.
  constitutional_ratification_recorded:    { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true,  narrative: false },
  constitutional_ratification_refused:     { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true,  narrative: false },
  // ── Distribution / Upgrade primitives (2026-05-20) ──────────────
  // Per brain VJDMME8JD961SE6F amendment 4AV2NPJW2H1HV0XQ3MR2ZV78KC +
  // KCs R6BS0FP17S6375 + ZM4HZPQFMS2D7E. Canonical-vs-learned boundary
  // is separate-canonical.db (choice C); aliasing is generic
  // act_artifact_aliased event (choice E); update mechanism is
  // acc upgrade CLI (choice H). See docs/Architecture.md.
  //
  // act_artifact_aliased: emitted when a release renames a handle
  // (predicate/artifact/etc). Alias chains are append-only, cycle-
  // refused, and credit resolution updates the new_id when prior
  // action_scored events cite the old_id. Open vocabulary — same
  // event kind covers every renamed handle. Embeddable so prompt
  // composition + retrieval surface rename evidence to the brain.
  act_artifact_aliased:                    { producer: "runtime",   embeddable: true,  mirror_inline: false, health_metric: false, narrative: false },
  // schema_migration_applied: substrate/migrations registry emits one
  // row per applied migration. Idempotent — version is the canonical
  // dedup key. Health metric so dashboards plot migration history.
  schema_migration_applied:                { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true,  narrative: false },
  schema_migration_failed:                 { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true,  narrative: false },
  // release_announced: RESERVED seam for the FUTURE P2P distribution layer
  // (DISTREL_P2, directive 3GZGQ0V5TH5KHF3YDTTDVQ6BH8). When the planned
  // IPFS pub/sub network ships, a peer will emit this to announce an
  // available release; the payload will carry
  //   { release_version, bundle_cid, manifest_cid, signature,
  //     min_acc_version, announced_by }
  // resolving to a ReleaseSource of kind "pubsub_announcement" (see
  // runtime/release_source.ts). It is emitted by NO producer today — the
  // pub/sub transport, libp2p, and the consumer/query are intentionally
  // unimplemented. The kind is registered now only to reserve the seam so
  // the schema is stable when the P2P layer arrives. producer is set to
  // "runtime" (a substrate-side peer worker will own it); not embeddable
  // and not a health metric until the layer is real.
  release_announced:                       { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
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

  // ── Query-embedding cache (compounding lever #4, 2026-05-22) ──────────────
  // Broadens the prompt_composition_cache idiom to the per-search-query
  // OpenAI embedding round-trip. computeEmbedding(text) is a pure deterministic
  // function of (text, model, dims, version) — no ledger state — so it needs no
  // high-water-mark version key. cache_hit means a query embedding was reused
  // without an OpenAI fetch; cache_miss means a fresh embedding was computed.
  query_embedding_cache_hit:               { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },
  query_embedding_cache_miss:              { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: false },

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

  // ── Dark-gate observability (contract TJGFQC72, 2026-05-18). The
  //    regex-based intent_classified gate was removed (RLM-first: the LM
  //    reads directive intent natively — no regex pre-classification). The
  //    kinds below remain for the structural / verifier gates that are not
  //    intent-based.
  //
  //    lane_routing_refused — substrate-emitted when a downstream gate
  //    refuses to admit a payload (e.g. decorative citation,
  //    under-rooted citation, empty-body-below-threshold). Payload:
  //      { reason, refused_kind, directive_id, observed_intent_class }
  //    Free-string fields preserve the open vocabulary.
  //
  //    refinement_depth_exceeded — explicit event kind (was previously a
  //    failure_kind enum value only). Payload: { depth, cap }. Marked
  //    health_metric so the rate of cap-hits is countable.
  //
  //    verifier_residual_high — explicit event kind paired with the
  //    pathology budget weight. Payload: { residual, verifier_kind }.
  //    verifier_kind is intentionally a free string.
  lane_routing_refused:                    { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: true,  narrative: true },
  refinement_depth_exceeded:               { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true,  narrative: true },
  verifier_residual_high:                  { producer: "substrate", embeddable: false, mirror_inline: false, health_metric: true,  narrative: true },

  // ── F3 lifecycle closure sweep (2026-05-18). Open contract amendments,
  //    stale owner_input_required prompts, and abandoned task_node_opened
  //    rows pile up forever otherwise — substrate audit found 987 stuck
  //    contract_amendment_proposed rows ≥24h old with no
  //    applied_change_committed citing them. The closure worker emits ONE
  //    of these three terminators per open lifecycle so the read-models
  //    can stop returning the stale row.
  //
  //    closure_complete — a downstream event (applied_change_committed,
  //      task_committed, owner_decision_recorded) already satisfied the
  //      open lifecycle but no terminator fired; the worker emits the
  //      terminator citing the resolving event.
  //
  //    closure_obsolete — the anchor (target file / target_resource)
  //      named by the proposal no longer exists in the current source
  //      checkout, so the proposal can never apply. Carries the missing
  //      anchor in payload.
  //
  //    closure_owner_required — the open lifecycle has been waiting on
  //      the owner for ≥ 7 days without resolution; the worker emits
  //      this terminator to record that the request expired without
  //      owner action so the brain stops re-asking.
  closure_complete:                        { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: false, narrative: true },
  closure_obsolete:                        { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true,  narrative: true },
  closure_owner_required:                  { producer: "runtime",   embeddable: false, mirror_inline: true,  health_metric: true,  narrative: true },

  // ── pending_decision_retire_worker (2026-05-19). Brain validation
  //    dispatch REFUSED full removal of the pending-owner-decision queue
  //    (the audit trail for failed amendments matters), and recommended
  //    Option B+: auto-retire stale + test-file + anchor-missing
  //    candidates while preserving the operator-visibility surface. The
  //    worker emits ONE pending_decision_retired event per retire so the
  //    historical audit captures WHICH stale-class triggered the retire.
  //    Payload: { amendment_event_id, reason: "stale" | "test_file_target"
  //    | "legacy_amendment_churn", retired_at: iso, ... }. substrate-internal,
  //    NOT narrative (operator already sees the count drop on the live
  //    view; no need to surface every retire in the owner narrative).
  pending_decision_retired:                { producer: "runtime",   embeddable: false, mirror_inline: false, health_metric: true,  narrative: false },
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

/** 2026-05-21 dual-kind consolidation. The 2026-05-17 code_artifact →
 *  act_artifact rename left ~2,559 IMMUTABLE historical code_artifact_*
 *  rows in the ledger, so read paths must still match BOTH names. Pre-fix
 *  the dual-kind list was copy-pasted across 8 call sites (retrieval,
 *  task_dispatcher, extractors, daemon, closure checks) — a "one path"
 *  violation. These canonical constants are the single source of truth;
 *  the reads stay (immutable history) but the duplication collapses here.
 *  `*_SQL` variants are pre-quoted for `kind IN (…)` clauses (constants,
 *  no injection surface). */
export const ARTIFACT_CANDIDATE_KINDS = [
  "act_artifact_candidate",
  "code_artifact_candidate",
] as const;
export const ARTIFACT_LIFECYCLE_KINDS = [
  "act_artifact_candidate",
  "act_artifact_admitted",
  "act_artifact_promoted",
  "code_artifact_candidate",
  "code_artifact_admitted",
  "code_artifact_promoted",
] as const;
/** Pre-quoted comma lists for SQL `kind IN (...)`. */
export const ARTIFACT_CANDIDATE_KINDS_SQL = ARTIFACT_CANDIDATE_KINDS.map((k) => `'${k}'`).join(", ");

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
