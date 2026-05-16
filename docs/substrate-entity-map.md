# acc2 substrate entity map

Canonical inventory of every base table, virtual table, view, and event
kind the substrate persists or emits. One row per entity. Surfaces show
which subsystems are required to know about the entity to keep the
substrate live-at-boot and observable.

Surface columns:

- **seed** — laid down by `substrate/seed.ts` on `acc init --yes`
  (either a row in the table / view's underlying tables, or an event
  of this kind).
- **doctor** — gated by a `cli/doctor.ts` content check (FAIL flips
  composite readiness to FAIL).
- **status** — counted or exposed by `cli/admin_substrate_status.ts`
  (`acc admin substrate-status`).
- **view** — projected by a `CREATE VIEW IF NOT EXISTS` in
  `substrate/views.ts` (so a view query reads it through Bun-SQL).

GAP is `—` when an entity is live in the substrate but no surface
covers it AND something downstream depends on operator visibility. Cells
that say `n/a` mean the surface intentionally does not apply.

Producers:

- `substrate` — written by daemon-owned workers (scheduler, embedder,
  rolling reviewer, integrity worker, runtime supervisors, daemon
  lifecycle).
- `brain` — written by the opencode bridge from the brain's emitted
  frames (`task_node_opened`, `action_predicted`, `knowledge_candidate`,
  `code_artifact_candidate`, …).
- `claude` — written by Claude Code (this orchestrator) on owner
  channel turns and the scored low-risk inline lane.
- `runtime` — written by `runtime/*` modules that observe substrate-
  scheduled work (bridge, dispatcher, sandbox, embedder, crisis mode,
  father, rolling reviewer, integrity worker).
- `seed` — written exclusively by `substrate/seed.ts` during install.

## Base tables

| Entity            | Kind     | Producer            | seed | doctor | status | view | GAP |
|-------------------|----------|---------------------|------|--------|--------|------|-----|
| `meta`            | table    | substrate / seed    | yes  | n/a    | n/a    | n/a  | —   |
| `events`          | table    | all four            | yes  | yes (knowledge_promoted floor) | yes (event count) | n/a | — |
| `code_artifact`   | table    | seed + brain        | yes  | yes (seed_* floor)             | yes (seed + brain split) | yes (`code_artifact_registry_view`, `artifact_routing_view`) | — |
| `vec_events`      | virtual  | substrate (embedder) | n/a | yes (vec0 loadable)            | yes (count)            | n/a | — |

`meta` is k/v metadata (`schema_version`, seed-completion markers).
`events` carries every observable fact. `code_artifact` is the LATM /
Voyager registry. `vec_events` is the canonical embedding index
(sqlite-vec, 1536-dim, text-embedding-3-small).

## Views (substrate/views.ts)

All views are CREATE VIEW IF NOT EXISTS over `events` ± `code_artifact`.
`runViews(db)` is idempotent; the daemon runs it at boot.

| View                                       | Reads kinds / tables                                                            | Used by                                  | seed-evidence at boot |
|--------------------------------------------|----------------------------------------------------------------------------------|------------------------------------------|-----------------------|
| `task_graph_view`                          | `task_node_opened`, `task_edge_recorded`                                         | retrieval, prompt composer, scheduler    | empty until first directive |
| `ready_tasks_view`                         | `task_node_opened`, `task_edge_recorded`, `task_committed`                       | scheduler                                | empty until first directive |
| `failure_view`                             | `task_failed`                                                                    | brain (failure landscape)                | empty                 |
| `code_artifact_registry_view`              | `code_artifact` (status in admitted/promoted)                                    | retrieval, prompt composer               | yes — 8 seed artifacts |
| `artifact_routing_view`                    | `code_artifact`                                                                  | dispatch decider                         | yes                   |
| `embedding_index_view`                     | `events` (embedding NOT NULL)                                                    | embedder, retrieval                      | yes after `embedPendingEvents` |
| `origin_promotion_view`                    | `knowledge_promoted` × `substrate_origin`                                        | reranker                                 | yes — 10 promoted seed rows |
| `origin_promotion_by_directive_view`       | `knowledge_promoted` × `directive_id`                                            | reranker (per-directive bias)            | yes (seed directive)  |
| `contradictory_candidates_view`            | `contradictory_candidates`                                                       | retrieval (surface contradictions)       | empty                 |
| `owner_conversation_view`                  | `owner_input_received`, `owner_decision_recorded`                                | brain (owner channel surface)            | empty until first chat |
| `rolling_review_due_view`                  | `directive_opened` (lifecycle=rolling_active), `directive_review_due`            | Father (rolling cadence)                 | empty                 |
| `watch_edge_observations_view`             | `task_edge_recorded` (kind=watches), upstream events                             | watching tasks                           | empty                 |
| `directive_conflicts_view`                 | `directive_interference_edge`                                                    | Father (objective ranking)               | empty                 |
| `stakeholder_state_view`                   | `stakeholder_state_recorded`                                                     | stakeholder compositor                   | empty                 |
| `active_objectives_view`                   | `directive_opened` × `directive_amended`                                         | Father                                   | empty                 |
| `low_risk_inline_patterns_view`            | `knowledge_promoted` (tag=low_risk_inline_pattern)                               | dispatch decider (claude_inline lane)    | yes (seed knowledge)  |
| `irreversible_effects_view`                | `irreversible_effect_recorded`                                                   | crisis mode, audit                       | empty                 |
| `promoted_knowledge_view`                  | `knowledge_promoted`                                                             | retrieval, prompt composer               | yes — 10 promoted seed rows |
| `lesson_implementer_queue_view`            | `lesson_extracted`, `contract_amendment_proposed`, `owner_decision_recorded`, `dispatcher_violation`, `irreversible_effect_recorded`, `applied_change_committed` | lesson apply orchestrator | empty |
| `lesson_implementation_status_view`        | `lesson_extracted`, `contract_amendment_proposed`, `lesson_apply_requested`, `action_scored`, `applied_change_committed` | lesson apply orchestrator, audit | empty |
| `applied_lesson_effectiveness_view`        | `applied_change_committed`, future cited `action_scored`, `recipe_invoked`, `action_predicted`, `task_committed`, `task_node_opened` | compounding measurement | empty |
| `lesson_apply_candidate_view`              | `lesson_implementation_status_view` × `lesson_implementer_queue_view` × `applied_lesson_effectiveness_view` | normalized apply candidate | empty |

Every view is covered by `substrate/views.test.ts`. None requires a
separate seed-population path: views read whatever `events` /
`code_artifact` contain.

## Event kinds (canonical union — substrate/types.ts `EventKind`)

119 canonical event kinds. Grouped by lifecycle phase. The `status`
column means the kind contributes to a count exposed by
`acc admin substrate-status`; `doctor` means the kind has a content
check in `cli/doctor.ts`; `seed` means rows of this kind are emitted by
`substrate/seed.ts`.

### Directive lifecycle (`substrate/types.ts:60-68`)

| Kind                                       | Producer       | seed | doctor | status | GAP |
|--------------------------------------------|----------------|------|--------|--------|-----|
| `directive_opened`                         | claude         | yes  | —      | embeddable | — |
| `directive_amended`                        | claude         | —    | —      | embeddable | — |
| `directive_review_due`                     | runtime (rolling reviewer) | — | — | — | — |
| `directive_milestone_recorded`             | claude         | —    | —      | — | — |
| `directive_interference_edge`              | runtime / brain | —   | —      | yes (count) | — |
| `directive_interference_cycle_detected`    | runtime        | —    | —      | — | — |
| `task_deferred_for_interference`           | runtime        | —    | —      | — | — |
| `directive_archived_missed_reviews`        | runtime (rolling reviewer) | — | — | — | — |

### DAG topology (`substrate/types.ts:70-79`)

| Kind                                       | Producer       | seed | doctor | status | GAP |
|--------------------------------------------|----------------|------|--------|--------|-----|
| `task_node_opened`                         | brain / claude | —    | —      | embeddable | — |
| `task_edge_recorded`                       | brain / claude | —    | —      | — | — |
| `task_blocked`                             | runtime        | —    | —      | — | — |
| `task_ready`                               | runtime        | —    | —      | — | — |
| `task_claimed`                             | runtime        | —    | —      | — | — |
| `task_committed`                           | brain / claude (inline) | — | — | — | — |
| `task_committed_superseded`                | runtime (amendment) | — | — | — | — |
| `task_failed`                              | runtime        | —    | —      | — | — |
| `task_abandoned`                           | runtime        | —    | —      | — | — |

### Universal action primitive (`substrate/types.ts:81-86`)

| Kind                                       | Producer       | seed | doctor | status | GAP |
|--------------------------------------------|----------------|------|--------|--------|-----|
| `action_predicted`                         | brain / claude | —    | —      | embeddable | — |
| `artifact_invoked`                         | substrate      | —    | —      | — | — |
| `artifact_observed`                        | substrate      | —    | —      | — | — |
| `action_scored`                            | substrate      | —    | —      | embeddable | — |
| `irreversible_effect_recorded`             | runtime (dispatcher) | — | — | yes (count) | — |

### Knowledge — Model D (`substrate/types.ts:88-94`)

| Kind                                       | Producer       | seed | doctor | status | GAP |
|--------------------------------------------|----------------|------|--------|--------|-----|
| `knowledge_candidate`                      | brain / claude | yes  | —      | embeddable | — |
| `candidate_confirmed`                      | substrate (extractor) | — | — | — | — |
| `candidate_contradicted`                   | substrate (extractor) | — | — | — | — |
| `knowledge_promoted`                       | substrate (extractor) | yes (10 rows) | yes (≥ 5) | yes (count) + embeddable | — |
| `knowledge_demoted`                        | substrate (extractor) | — | — | — | — |
| `contradictory_candidates`                 | substrate (extractor) | — | — | — | — |

### Code artifacts — LATM / Voyager (`substrate/types.ts:96-106`)

| Kind                                       | Producer       | seed | doctor | status | GAP |
|--------------------------------------------|----------------|------|--------|--------|-----|
| `code_artifact_candidate`                  | brain          | —    | —      | embeddable | — |
| `code_artifact_admitted`                   | substrate (admission) | yes (8 seed rows) | yes (seed_* ≥ 5) | yes (count + seed/brain split) | — |
| `code_artifact_admission_rejected`         | substrate (admission) | — | — | — | — |
| `code_artifact_promoted`                   | substrate      | —    | —      | — | — |
| `code_artifact_quarantined`                | substrate      | —    | —      | — | — |
| `code_artifact_rehabilitated`              | substrate      | —    | —      | — | — |
| `code_artifact_score_updated`              | substrate      | —    | —      | — | — |
| `latm_novelty_bonus_applied`               | substrate      | —    | —      | — | — |
| `sandbox_violation`                        | runtime (sandbox) | — | — | — | — |
| `sandbox_unenforced_warning`               | runtime (sandbox) | — | — | — | — |

### Runtime supervision (`substrate/types.ts:108-114`)

| Kind                                       | Producer       | seed | doctor | status | GAP |
|--------------------------------------------|----------------|------|--------|--------|-----|
| `runtime_subprocess_started`               | runtime        | —    | —      | — | — |
| `runtime_subprocess_resource_warning`      | runtime        | —    | —      | — | — |
| `runtime_subprocess_soft_terminated`       | runtime        | —    | —      | — | — |
| `runtime_subprocess_hard_killed`           | runtime        | —    | —      | — | — |
| `runtime_subprocess_orphaned`              | runtime        | —    | —      | — | — |
| `runtime_subprocess_completed`             | runtime        | —    | —      | — | — |
| `runtime_subprocess_killed`                | runtime (escalation) | — | — | — | — |
| `sandbox_enforced`                         | runtime        | —    | —      | — | — |
| `sandbox_degraded`                         | runtime        | —    | —      | — | — |

### Knowledge synthesis (`substrate/types.ts:116-117`)

| Kind                                       | Producer       | seed | doctor | status | GAP |
|--------------------------------------------|----------------|------|--------|--------|-----|
| `knowledge_synthesized`                    | substrate (extractor) | — | — | — | — |

### External-source registration & ingress (`substrate/types.ts:119-120, 160-163`)

| Kind                                       | Producer       | seed | doctor | status | GAP |
|--------------------------------------------|----------------|------|--------|--------|-----|
| `external_source_registered`               | runtime (ingress) | — | — | — | — |
| `external_event_received`                  | runtime (ingress) | — | — | embeddable | — |
| `external_source_quarantined`              | runtime (ingress) | — | — | — | — |
| `external_source_rehabilitated`            | runtime (ingress) | — | — | — | — |
| `external_source_token_rotated`            | runtime (admin) | — | — | — | — |

### Embeddings (`substrate/types.ts:123`)

| Kind                                       | Producer       | seed | doctor | status | GAP |
|--------------------------------------------|----------------|------|--------|--------|-----|
| `embedding_computed`                       | runtime (embedder) | — | yes (vec0 loadable) | yes (vec_events count) | — |

### Bridge — opencode (`substrate/types.ts:125-130`)

| Kind                                       | Producer       | seed | doctor | status | GAP |
|--------------------------------------------|----------------|------|--------|--------|-----|
| `bridge_invoked`                           | runtime (bridge) | — | — | — | — |
| `bridge_frame_received`                    | runtime (bridge) | — | — | — | — |
| `bridge_completed`                         | runtime (bridge) | — | — | — | — |
| `bridge_failed`                            | runtime (bridge) | — | — | — | — |
| `bridge_mcp_connected`                     | runtime (bridge) | — | — | — | — |
| `bridge_stuck`                             | runtime (bridge) | — | — | — | — |

### Dispatcher — §3.7 cycle-1 enforcement (`substrate/types.ts:132-137`)

| Kind                                       | Producer       | seed | doctor | status | GAP |
|--------------------------------------------|----------------|------|--------|--------|-----|
| `brain_dispatched`                         | runtime (dispatcher) | — | — | — | — |
| `brain_dispatch_closed`                    | runtime (dispatcher) | — | — | — | — |
| `brain_cycle_2_started`                    | bridge mock / brain frame | — | — | — | — |
| `continue_cycle_requested`                 | brain frame    | —    | —      | — | — |
| `dispatcher_violation`                     | runtime (dispatcher, scheduler) | — | — | yes (count) | — |

### Stakeholder model (`substrate/types.ts:139-142, 156-157`)

| Kind                                       | Producer       | seed | doctor | status | GAP |
|--------------------------------------------|----------------|------|--------|--------|-----|
| `stakeholder_state_recorded`               | runtime (compositor) | — | — | yes (count) | — |
| `stakeholder_interaction_edge`             | runtime (compositor) | — | — | — | — |
| `stakeholder_alignment_observed`           | runtime (compositor) | — | — | — | — |
| `stakeholder_conflict`                     | runtime / brain | — | — | — | — |
| `stakeholder_conflict_detected`            | runtime        | —    | —      | — | — |

### Owner channel (`substrate/types.ts:144-147`)

| Kind                                       | Producer       | seed | doctor | status | GAP |
|--------------------------------------------|----------------|------|--------|--------|-----|
| `owner_input_received`                     | claude         | yes  | —      | embeddable | — |
| `owner_decision_recorded`                  | claude         | —    | —      | embeddable | — |
| `owner_input_required`                     | brain / runtime | — | —      | — | — |

### Crisis mode (`substrate/types.ts:149-153`)

| Kind                                       | Producer       | seed | doctor | status | GAP |
|--------------------------------------------|----------------|------|--------|--------|-----|
| `crisis_mode_engaged`                      | runtime (crisis) | — | — | — | — |
| `crisis_mode_disengaged`                   | runtime (crisis) | — | — | — | — |
| `crisis_postmortem_opened`                 | runtime (crisis) | — | — | — | — |
| `latm_suspended_in_crisis`                 | runtime (crisis) | — | — | — | — |

### Daemon lifecycle & ops (`substrate/types.ts:164-174`)

| Kind                                       | Producer       | seed | doctor | status | GAP |
|--------------------------------------------|----------------|------|--------|--------|-----|
| `daemon_started`                           | runtime (daemon) | — | yes (health) | — | — |
| `daemon_ready`                             | runtime (daemon) | — | — | — | — |
| `daemon_index_rebuilt`                     | runtime (daemon) | — | — | — | — |
| `daemon_shutdown`                          | runtime (daemon) | — | — | — | — |
| `integrity_check_completed`                | runtime (integrity worker) | — | — | — | — |
| `integrity_check_failed`                   | runtime (integrity worker) | — | — | — | — |
| `wal_checkpointed`                         | runtime (daemon) | — | — | — | — |
| `dispatch_recovered_orphan`                | runtime (daemon recovery) | — | — | — | — |

### Substrate self-events (`substrate/types.ts:176-183`)

| Kind                                       | Producer       | seed | doctor | status | GAP |
|--------------------------------------------|----------------|------|--------|--------|-----|
| `projection_checkpointed`                  | substrate      | —    | —      | — | — |
| `constitutional_gate_decision`             | substrate      | —    | —      | — | — |
| `self_modification_recorded`               | substrate      | —    | —      | — | — |
| `recipe_extracted`                         | seed + substrate (extractor) | yes (2 seed rows) | yes (≥ 1, this pass) | yes (count) | — |
| `recipe_invoked`                           | runtime (recipe replay) | — | — | — | — |
| `recipe_replay_aborted`                    | runtime (recipe replay) | — | — | — | — |
| `prompt_truncated`                         | runtime (prompt composer) | — | — | — | — |

### Closure learning and application (`substrate/event_kinds.ts`)

The lesson-implementer flywheel uses the existing event ledger as its only
storage surface. It adds no table and no posterior family: queue state,
authorization state, verifier state, terminal mutation state, and cheaper-next
economics are derived from events. This preserves the universal workflow in
`v2-design.md` §3, the act primitive in §6, the cited-event credit path in §7,
the code-artifact authoring loop in §11.5, and recipe replay compounding in §15.

| Kind                                       | Producer       | seed | doctor | status | GAP |
|--------------------------------------------|----------------|------|--------|--------|-----|
| `task_closure_audited`                     | brain          | —    | —      | embeddable | — |
| `lesson_extracted`                         | brain          | —    | —      | embeddable | — |
| `contract_amendment_proposed`              | brain          | —    | —      | embeddable | — |
| `lesson_apply_requested`                   | claude         | —    | —      | embeddable | — |
| `applied_change_committed`                 | claude         | —    | —      | embeddable | — |

Irreducible data-structure contract:

- New event kinds: `lesson_apply_requested` records the owner/auto-gated handoff into the applier; `applied_change_committed` is the unified terminal kind firing for every apply attempt (success/failed/refused) carrying `payload.status` + `payload.source_kind` (audit #3 collapse at commit `3208a41` subsumed the legacy `lesson_applied` + `contract_amendment_applied` kinds — they differed only by source_kind discriminator which is now in payload).
- New derived views: `lesson_implementer_queue_view`, `lesson_implementation_status_view`, `applied_lesson_effectiveness_view`, and `lesson_apply_candidate_view`. The candidate view exposes the single normalized apply-candidate projection `{ source_event_id, target, anchor, patch_or_recipe, verifier_residual, owner_gate, trajectory_health, compounding_metric }` for `recipe_candidate`, `verifier_gap`, and `contract_amendment_proposed` sources.
- New tables: none.
- New posterior shapes: none. Compounding updates flow through existing cited `action_scored`, knowledge, code-artifact, and recipe posterior paths.
- Owner gating: `lesson_implementer_queue_view` derives explicit-consent and safe auto-apply eligibility from the declarative target policy in `substrate/lesson_apply_policy.ts`; cli/runtime targets are auto-apply candidates only when the proposal is structured as `{ file_path, anchor, diff }` and the source trajectory has no `dispatcher_violation` or `irreversible_effect_recorded`.
- Flywheel sequence: `lesson_extracted` or `contract_amendment_proposed` -> gate `action_predicted` / `action_scored` -> `lesson_apply_requested` -> apply `action_predicted` -> apply `action_scored` with residual < 0.3 -> `applied_change_committed` -> future cited `action_scored` / `recipe_invoked` rows measured by `applied_lesson_effectiveness_view`.

### Father (`substrate/types.ts:185-190`)

| Kind                                       | Producer       | seed | doctor | status | GAP |
|--------------------------------------------|----------------|------|--------|--------|-----|
| `father_cycle_recorded`                    | runtime (father) | — | — | — | — |
| `father_yielded`                           | runtime (father) | — | — | — | — |
| `father_drift_detected`                    | runtime (father) | — | — | — | — |
| `father_self_suspended`                    | runtime (father) | — | — | — | — |
| `father_drift_resolved`                    | runtime (father) | — | — | — | — |

### Lifecycle (`substrate/types.ts:196-198`)

| Kind                                       | Producer       | seed | doctor | status | GAP |
|--------------------------------------------|----------------|------|--------|--------|-----|
| `goal_committed`                           | runtime / brain | — | — | — | — |
| `goal_abandoned`                           | runtime / brain | — | — | — | — |

### Opencode subsystem upgrade (`substrate/types.ts:201-205`)

| Kind                                       | Producer       | seed | doctor | status | GAP |
|--------------------------------------------|----------------|------|--------|--------|-----|
| `opencode_upgrade_started`                 | runtime (opencode_version) | — | yes (`opencode` PATH check) | — | — |
| `opencode_upgrade_completed`               | runtime (opencode_version) | — | — | — | — |
| `opencode_upgrade_failed`                  | runtime (opencode_version) | — | — | — | — |

### Admin maintenance (`substrate/types.ts:207-220`)

| Kind                                       | Producer       | seed | doctor | status | GAP |
|--------------------------------------------|----------------|------|--------|--------|-----|
| `admin_token_rotated`                      | cli (admin)    | —    | —      | — | — |
| `code_artifact_quarantine_overridden`      | cli (admin)    | —    | —      | — | — |
| `directive_archived_by_operator`           | cli (admin)    | —    | —      | — | — |
| `state_exported`                           | cli (admin)    | —    | —      | — | — |
| `state_imported`                           | cli (admin)    | —    | —      | — | — |

### Robustness telemetry (`substrate/types.ts:222-237`)

| Kind                                       | Producer       | seed | doctor | status | GAP |
|--------------------------------------------|----------------|------|--------|--------|-----|
| `error_caught`                             | runtime (everywhere) | — | — | — | — |
| `worker_tick_overrun`                      | runtime (daemon) | — | — | yes (count) | — |

## Non-union event kinds emitted by live producers (flagged, not deleted)

These are emitted at runtime but NOT in the `EventKind` union in
`substrate/types.ts`. Per audit scope they are flagged here, not added
to the union (that is a substrate-types change, out of scope for this
audit pass).

| Kind                                          | Producer                              | GAP |
|-----------------------------------------------|---------------------------------------|-----|
| `embedding_skipped_missing_api_key`           | `runtime/embedder.ts:380`             | union miss (operator-visible no-op when OPENAI_API_KEY unset) |
| `cli_layout_migrated`                         | `runtime/state_paths.ts:169`          | union miss (one-shot migration shim event) |

## Test-only event kinds (not real substrate kinds)

These exist exclusively in test fixtures and are never emitted by
production code. They are noise in a fleet grep and are intentionally
excluded from the canonical `EventKind` union.

| Kind                  | Used by                       |
|-----------------------|-------------------------------|
| `watch_test_any`      | `cli/watch.test.ts`           |
| `watch_test_inflight` | `cli/watch.test.ts`           |
| `watch_test_runwatch` | `cli/watch.test.ts`           |
| `watch_test_seed`     | `cli/watch.test.ts`           |
| `watch_test_synthetic`| `cli/watch.test.ts`           |

## Sub-payload string-literals that grep matches but are NOT event kinds

The naive `grep "kind:"` over `substrate/`, `runtime/`, `cli/` reports
~138 distinct quoted strings, but ~30 of them are sub-payload values
(edge kinds, `failure_kind` enum members, `target_kind` for credit
flow, `row_kind` discriminators in views, `interaction` enum). Listed
here so future audits do not mistake them for event kinds.

- Edge kinds in `task_edge_recorded` payload: `requires`, `refines`,
  `watches`, `blocks`, `depletes`.
- Failure kinds (`substrate/types.ts:34` enum): `auth_missing`,
  `rate_limit`, `timeout`, `parse_error`, `subprocess_crash`,
  `cycle_1_only_breach`, `refinement_depth_exceeded`,
  `verification_high_residual`, `bridge_killed`, `bridge_timeout`,
  `artifact_runtime_error`, `rolling_directive_archived`.
- Credit `target_kind` values (`runtime/credit.ts:123`): `knowledge`,
  `code_artifact`.
- View `row_kind` discriminators: `node`, `extension`.
- Lifecycle / cadence enum strings: `rolling_active`, `rolling_review`,
  `normal_objective`, `promoted`, `demoted`.
- Stakeholder interaction enum: `mutual_exclusion`, `water_damage`,
  `evacuation`, `none`, `unspecified`, `yield_template`,
  `directive_interference_cycle`.
- Compositor task-kind strings: `stakeholder_consult`.
- Bridge / extractor outcome enums: `no_action`,
  `mock_bridge_prompt_unrecognized`.

## Coverage summary

- 3 base tables + 1 virtual table — all four surfaced in
  `acc admin substrate-status` (events, code_artifact, vec_events) or
  doctor (vec_events extension load probe). `meta` is intentionally
  unsurfaced (schema bookkeeping only).
- 18 views — all covered by `substrate/views.test.ts`. Eight depend
  on seeded events / artifacts at boot; the rest are correctly empty
  on a fresh install.
- 108 canonical event kinds — every one is grouped above with its
  producer. Health-metric kinds (`dispatcher_violation`,
  `irreversible_effect_recorded`, `worker_tick_overrun`) are now
  counted in `substrate-status`. Seed-required kinds
  (`knowledge_promoted`, `code_artifact_admitted`, `recipe_extracted`)
  are gated by doctor.
- 2 non-union emitted kinds flagged for follow-up
  (`embedding_skipped_missing_api_key`, `cli_layout_migrated`).
- 5 test-only kinds excluded from production accounting.
