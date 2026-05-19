# AccInt — Roadmap

The path from current organism (ALIVE, posterior-scored at the leaves) to the **most universal, elegant, effective, adaptive, fast, efficient self-improving organism on the planet**.

This is not a forward speculation document. Every contract below is grounded in live substrate measurement and the open frontier in `docs/Architecture.md` §11 + §15. Each is sized to be a single brain dispatch with a closure predicate testable against the events ledger.

Ordering principle: dependency + leverage. Earlier contracts unlock the verification surface that later contracts depend on. Per `6H3ZQFZMXN7V` (narrow safe scope), dispatch one at a time; never bundle.

---

## Tier 0 — Foundation (close the trust gaps)

These contracts harden the substrate's self-validation so subsequent contracts can be trusted to land what they claim.

### T0.1 — F-Substrate-Closure-Validation

**Problem:** Brain dispatch `MY0FWYBSKX5PBCVWJBHSQX4GT4` (2026-05-19) emitted `task_closure_audited` claiming `each_row_has_commit_evidence: true` for `contract_amendment_proposed` rows that were never emitted. k_252 advisory-gate fake: the closure audit checked the brain's claim, not the substrate's ledger.

**Contract:** `runtime/closure_audit.ts` gains a hard preconditions block. When `target_files` is declared in the predicate AND `closure_residual < 0.3` is asserted, the verifier MUST query the events table for `contract_amendment_proposed` rows whose `target_resource` matches any declared `target_file` AND that share `directive_id`. Zero matching rows = closure refused; emit `closure_blocked_no_amendments` (new event kind) and bump residual to 1.0.

**Closure predicate:** `closure_complete(target_file_declared_amendments_present OR target_files_empty)`. Tests: pin the "no amendments emitted but closure claimed" failure shape AND its corrected refusal.

**Why first:** every subsequent contract needs trustworthy closure semantics. Without this, brain dispatches can keep claiming work they didn't do.

---

### T0.2 — F-Knowledge-Binding-As-Mutation-Enforcement (meta-move #6)

**Problem:** k_554 says citation without state mutation is decorative. Today `retrieval_binding` rows record what was surfaced, but the brain frequently emits `act_tuple_recorded.cited_knowledge_ids` containing IDs that don't appear in the action's `reasoning_summary` or `effect_summary`. The k_555 four-link chain breaks at the BINDING step on roughly half of recent acts.

**Contract:** Deterministic check at the `emitEvent` boundary in `runtime/events.ts`. For every `act_tuple_recorded`, validate that every entry in `cited_knowledge_ids` appears as a substring in `reasoning_summary` OR `effect_summary` (or one of the bound-field aliases). Unbound citations get auto-stripped AND emit one `decorative_citation_stripped` event per stripped id. Force real binding; substrate-truth gate, not advisory.

**Closure predicate:** `closure_complete(unbound_citations_stripped AND emit_event_per_strip)`. Pin tests on a fixture with mixed bound+unbound citations.

**Why first:** the credit chain's binding step must be honest before counterfactual credit (T2) means anything.

---

## Tier 1 — Outcome Channels (close the credit loops)

The organism currently emits 30 953 candidate verdicts but only 2 `owner_observed_outcome_recorded` events. The owner-truth signal — the load-bearing one for non-technical universality — is starving. These contracts feed it.

### T1.1 — F-Owner-Outcome-Channel

**Problem:** Only 2 `owner_observed_outcome_recorded` events in 260 K. The substrate accumulates owner insights (708 `owner_insight_candidate`) but rarely gets the verdict that closes the credit chain. Every applied change should ask, "did this work for you?" — substrate doesn't.

**Contract:** New worker `owner_outcome_channel_worker` (registered through `ACC2_DISABLE_WORKERS=owner_outcome_channel_worker`). For every `applied_change_committed` whose `verifier_kind ∈ {owner_confirmation, owner_emotional_signal, owner_relational_signal, …}` (open vocabulary, read from `top_laws_view`), AND the directive has been quiet for the predicted `feedback_window.duration_ms`, emit `hidl_action_required` with a question shape ("did <effect_summary> work for you? positive | partial | negative | irrelevant"). Owner answer in chat → maps to `owner_observed_outcome_recorded` → credit flows back.

**Closure predicate:** `closure_complete(worker_registered AND hidl_emitted_per_eligible_applied_change AND owner_answer_persisted_as_outcome_recorded)`.

**Why critical:** this is the load-bearing primitive for ALL non-technical universality (life decisions, relationships, embodied work, research outcomes). Without owner-truth feedback at scale, the substrate is technical-domain-only.

---

### T1.2 — F-Retrieval-Rejection-Emitter

**Problem:** Zero `retrieval_rejected` events ever, vs 6 943 `retrieval_binding` events. The brain receives N retrieval hits and we never learn which ones it ignored. Free improvement signal left on the table; the reranker can't learn to surface less dead-weight per cycle.

**Contract:** Post-act-tuple sweep worker `retrieval_rejection_emitter`. On every `act_tuple_recorded` for a brain dispatch, diff (retrieval_binding rows for this dispatch's task_id) against (cited_knowledge_ids in this act). Every binding NOT cited = one `retrieval_rejected` event with `rejection_kind: not_bound_in_act`. Posterior penalty: candidate's `posterior_beta += rejection_weight` (smaller than confirmation but nonzero — silence is a weak negative signal).

**Closure predicate:** `closure_complete(worker_registered AND retrieval_rejected_count_proportional_to_unbound_bindings AND posterior_beta_increment_visible_in_extractor_pass)`.

**Why second:** trains the reranker passively. No new owner work required.

---

### T1.3 — F-Knowledge-Promotion-Rate (cross-candidate corroboration)

**Problem:** 3 309 candidates → 304 promoted (9.2 %). The cold-start path landed (`maybePromoteKnowledge` synchronous refresh in `runtime/credit.ts`). What remains: candidates that never get directly cited because no act intentionally bound them, but whose CLAIM semantically corroborates other promoted entries. They sit forever.

**Contract:** New extractor in `substrate/extractors.ts` — `extractCrossCandidateCorroboration`. 5-min reactive worker. Pair unverified candidates against promoted ones by embedding similarity (cosine ≥ 0.88) AND `goal_shape` overlap; if the paired promoted entry has `score ≥ 0.85` AND same polarity, emit `candidate_confirmed` on the unverified candidate with `confirmation_source: semantic_corroboration` AND credit weight 0.3 (smaller than direct-credit at 1.0 but nonzero — bootstrap weight).

**Closure predicate:** `closure_complete(extractor_registered AND new_event_kind_semantic_corroboration_recorded AND promotion_rate_observed_above_baseline_in_followup_audit_window)`.

**Why third:** 3 000+ stranded candidates start moving. Promotion volume rises; the recipe-shape population grows; Tier-0 replay activates.

---

## Tier 2 — Posterior-Scored Boundaries (meta-principle, §15)

Now the closed-vocabulary code constants migrate to open-vocabulary substrate rows. Each contract picks one boundary class.

### T2.1 — F-Universal-Threshold-Registry (meta-move #1)

**Problem:** Every literal constant in the runtime (`RECIPE_REPLAY_THRESHOLD`, `INLINE_PATTERN_SCORE_THRESHOLD`, `RECIPE_INERTIA_DECAY_DAYS`, `DEFAULT_BUDGET_TOKENS`, `NOVELTY_BONUS_MULTIPLIER`, supervisor `redispatch_storm threshold=6`, worker tick intervals, `closure_residual < 0.3`) is a code-side guess pending F13 adaptive scoring. The organism is adaptive at the leaves but rigid at the trunk.

**Contract:** Introduce `act_artifact{kind: "threshold_predicate", name: "<canonical_constant_name>"}` for every literal constant in the runtime's `// pending F13 adaptive scoring` comment set. Seed with the current hardcoded value as the artifact's body + `fixture_input + fixture_expected_residual` derived from observed production data. Add `runtime/threshold_registry.ts` accessor: `getThreshold(name: string): number` reads the highest-posterior row matching `name`; falls back to a compile-time default if no row exists. Migrate consumers (`runtime/credit.ts`, `runtime/dispatch_decider.ts`, `runtime/prompt_composer.ts`, `runtime/supervisor.ts`, `runtime/recipe_inertia.ts`) to read through `getThreshold()`.

**Closure predicate:** `closure_complete(threshold_predicate_artifacts_seeded AND getThreshold_accessor_lands AND every_consumer_migrated AND test_suite_green AND posterior_visible_in_act_artifact_registry_view)`.

**Why fourth:** the moment this lands, every threshold becomes adaptive on outcome correlation. F13 closes by definition.

---

### T2.2 — F-Posterior-Scored-Prompt-Composer (meta-move #2)

**Problem:** The composer (`runtime/prompt_composer.ts`) hardcodes which sections go in, their priorities, and which are floor. Sections that don't earn their token cost still consume budget.

**Contract:** Each section becomes an `act_artifact{kind: "prompt_section_predicate", name: "<section_name>"}`. Posterior measures "does including this section in the brain prompt correlate with low `closure_residual` for this `goal_class`?" Composer ranks `posterior × inverse_token_cost` under budget. Floor protection (commit `15863c5`) remains for load-bearing sections; the floor itself becomes a posterior-scored attribute (`floor: boolean` predicate, learned from outcome correlation).

**Closure predicate:** `closure_complete(every_section_is_an_act_artifact AND composer_reads_through_posterior_rank AND floor_flag_is_posterior_attribute_not_code_constant AND test_suite_green AND brain_prompt_budget_utilization_observed)`.

**Why fifth:** the brain prompt becomes self-tuning. Budget waste falls; brain quality rises asymmetrically.

---

### T2.3 — F-Posterior-Scored-Supervisor (meta-move #3)

**Problem:** `supervisor_redispatch_storm threshold=6` is one global rule. Different goal classes have different healthy dispatch counts; the global rule fires on legitimate work.

**Contract:** Per-(goal_class, signal_shape) supervisor thresholds. `act_artifact{kind: "supervisor_threshold_predicate", name: "<signal>_<goal_class>"}`. Each carries its own posterior calibrated by "did kill at threshold T prove correct, or did the kill abort productive work?" Cold-start: every unknown bucket falls back to the global default; mature buckets self-calibrate.

**Closure predicate:** `closure_complete(per_bucket_thresholds_emitted AND supervisor_reads_through_bucket AND cold_start_fallback_works AND test_suite_green)`.

**Why sixth:** pathology detection stops killing legitimate work. Trust in the supervisor rises; fewer false-positive aborts.

---

### T2.4 — F-Counterfactual-Credit (meta-move #4)

**Problem:** Credit flows only along chosen-and-succeeded paths. The selector is calibrated by positive evidence only. Slow convergence.

**Contract:** Every `action_scored` event includes `top_k_alternatives_at_dispatch_time` (already in `artifact_routing_view`). The credit pipeline emits one `counterfactual_credit_recorded` per top-K alternative not selected: `would_have_done_same | would_have_done_worse | would_have_done_better` (open vocabulary). Posterior debit/credit per shape. Same machinery as `candidate_confirmed`, applied to selection-time rankings.

**Closure predicate:** `closure_complete(counterfactual_credit_recorded_emitted_per_dispatch AND top_k_alternatives_persisted AND artifact_posterior_visible_in_act_artifact_registry_view)`.

**Why seventh:** the selector calibrates exponentially faster. Convergence on "which artifact for which goal_class" accelerates 5-10×.

---

### T2.5 — F-Meta-Credit-Formula (meta-move #5)

**Problem:** Credit formula choice (Shapley vs linear vs degenerate fallback, `runtime/credit.ts:822-830`) is hardcoded. Whether Shapley is the right shape for this organism's load is itself a hypothesis.

**Contract:** `act_artifact{kind: "credit_distribution_predicate"}` rows for each formula candidate. Posterior calibrated by "did calibration improve after this choice on this directive class?" The credit pipeline reads the highest-posterior formula per directive (or global if no class-specific row exists). One level of recursion, no infinite tower.

**Closure predicate:** `closure_complete(formula_candidates_seeded AND credit_path_dispatches_through_predicate AND posterior_visible AND no_infinite_recursion)`.

**Why eighth (last of Tier 2):** this is meta-recursion. The substrate scores its own scoring. Once this lands, every decision boundary in the organism is posterior-scored — INCLUDING the boundaries that score other boundaries.

---

## Tier 3 — Universality & Operations (the long tail)

### T3.1 — F-Sandbox-Parity (Phase G remainder, Architecture.md §11)

uv + camofox preflight + credential parity with bun. nsjail enforcement is honor-system when absent; camofox profile-mutex doesn't enforce resource limits.

### T3.2 — F-Father-v2 (Phase K remainder)

Drop planner-era responsibilities. Keep drift detection + self-suspend. Add event-reactive maintenance template (quarterly retro, weekly status digest).

### T3.3 — F-Owner-Freeze-State (Phase L remainder)

`acc admin freeze-state` CLI + freeze-state audit event for reversible operational gating.

### T3.4 — F-Token-Rotation

`acc admin rotate-token` CLI + atomic file replacement + grace-period for existing CLI sessions.

### T3.5 — F-Substrate-Migration-Sweep

One-time row rewriter that scans the events table for legacy `code_artifact_*` kind strings and rewrites them to canonical `act_artifact_*`. After zero remaining legacy rows on every shipped DB, the reader OR-clauses become dead code and can be stripped.

### T3.6 — F-Recipe-Replay-Gate

`findRecipeMatch` falls back from exact `goal_shape` to top-K embedding match (cosine ≥ 0.85) when no exact match exists, AND treats recipe topology as ≥-coverage rather than exact match. Once T2.1 lands, the threshold itself becomes posterior-scored.

### T3.7 — F-Backup-Export-Restore-Cadence

Scheduled-export cron primitive that emits `state_exported` on a cadence the owner profile picks. Operator-facing docs on the export/import workflow.

---

## Tier 4 — Brain-emitted frontier (deep-inspection dispatch `C5TVG369R11C9DAD9HVH8Q562G`)

The 2026-05-19 deep-inspection dispatch produced two contracts that complement Tier 1-2 and were not in my prior list. They land here because they extend §15 meta-principle and the closure-rate work.

### T4.1 — F-Dispatch-Decider-As-Posterior-Predicate (brain-proposed)

**Brain claim:** "Dispatch should be optimized as a learned residual-calibrated primitive before adding more strategic prompt policy, because `dispatch_decider_v1` is high-volume and currently averages above the closure_residual threshold." Cites measurement `T1G2F63H4H18VF7E5SDQ03R0HM`.

**Contract:** The dispatch_decider's per-route scoring (currently a hardcoded weighted sum of `routing_axes`) becomes an `act_artifact{kind: "dispatch_route_predicate"}` row per route. Each row carries a Beta posterior tracking "did selecting this route at this score level prove correct downstream?" The decider reads the posterior at decision time and falls back to the hardcoded weights only when the posterior is uninformative (low evidence count). Closes the gap where dispatch quality is high-volume but not learned.

**Why Tier 4:** depends on T2.1 (threshold registry) for the underlying machinery, and benefits from T2.4 (counterfactual credit) for fast convergence.

### T4.2 — F-Proposal-Digest-Scheduler (brain-proposed)

**Brain claim:** "Pending proposal digestion should be scheduled as a substrate primitive because live inspection shows outstanding amendments/lessons coexisting with new architecture directives, creating compounding decision-debt." Cites measurement `T1G2F63H4H18VF7E5SDQ03R0HM`.

**Contract:** New worker `proposal_digest_scheduler`. Reads `pending_contract_amendments_view` and unresolved `lesson_extracted` rows. Scores each by age + dependency pressure + owner-profile alignment + posterior of similar past landed amendments. Opens bounded apply/refine/reject tasks with `residual_stop_condition` so the worker doesn't fire-hose the dispatcher. Operates within the contract_amendment_consumer's existing dispatch budget.

**Closure predicate:** `closure_complete(worker_registered AND pending_amendments_age_distribution_shifts_younger AND no_dispatcher_overrun)`.

### T4.3 — F-Artifact-Warning-Calibration (brain-proposed insight)

**Brain claim:** "Artifact warning quietness should be treated as an evidence gap, not proof of health, because `artifact_warning_view` returned zero rows while `active_inference_view` still shows high-residual artifact patterns." Cites measurement `T1G2F63H4H18VF7E5SDQ03R0HM`.

**Contract:** Cross-reference `artifact_warning_view` against `active_inference_view`: when an artifact has high-residual scoring history (avg_residual ≥ 0.5, scored_count ≥ 5) but does NOT appear in artifact_warning_view (because its status hasn't flipped to quarantined), emit a new `artifact_warning_gap_detected` event so the operator sees the silent-degradation signal. This calibrates the gauge against ground truth instead of trusting absence of warnings.

**Closure predicate:** `closure_complete(cross_reference_query_lands AND gap_events_emitted_proportional_to_high_residual_unwarned_artifacts AND test_pins_the_invariant)`.

---

## Dispatch order rationale

```
T0.1 (closure validation) →
T0.2 (binding enforcement) →
T1.2 (retrieval rejection, no owner cost) →
T1.1 (owner outcome channel, biggest leverage) →
T1.3 (knowledge promotion) →
T2.1 (threshold registry — F13 closes here) →
T2.2 (prompt composer) →
T2.3 (supervisor) →
T2.4 (counterfactual credit) →
T2.5 (meta-credit formula — meta-principle complete) →
T3.x (long tail, parallelizable after T2)
```

**Tier 0 first** because every Tier 1+ contract claims to "close the chain" and the closure audit must be honest about that. **T1.2 before T1.1** because retrieval-rejection emits without owner work (zero owner-friction); the owner-channel work begins once the substrate has visibly improved retrieval quality. **T2.5 last in Tier 2** because it's recursive and benefits from every prior boundary already being posterior-scored.

After T2.5: the organism has no closed-vocabulary boundaries. Every decision, including how decisions are credited, is a row with a posterior. **The act-loop runs over its own configuration.** This is the final universality collapse.

---

## Cross-cutting principles (apply to every contract)

1. **Open vocabulary always.** No closed enums. New strings appear in events, not in type unions.
2. **Cite live measurement.** Every claim grounds in an events.id from the substrate snapshot.
3. **Single canonical name.** No `seedCodeArtifacts` style aliases. F4a-style migrations are one-shot row sweeps, not perpetual reader OR-clauses.
4. **Fail-closed at substrate boundaries.** Deny is the load-bearing gate (per bridge config commit `1570521`); positive allow-lists need explicit deny to be safe against additive defaults.
5. **Fixture + expected_residual on every threshold-artifact.** Cold-start defaults are testable, not magic.
6. **Substrate is the operator.** Brain proposes events; orchestrator applies. No brain filesystem-write.
7. **Narrow safe scope.** One contract at a time. Never bundle. Verify each closure-residual against the live ledger before dispatching the next.

---

## Live metrics to watch as contracts land

After each contract, the operator should observe:

| Contract | Metric | Expected direction |
|---|---|---|
| T0.1 | `closure_blocked_no_amendments` count | Rises (now caught); brain dispatch closure_residual distribution shifts honest |
| T0.2 | `decorative_citation_stripped` count | Rises initially, falls as brain learns to bind |
| T1.1 | `owner_observed_outcome_recorded` count | Rises from ~2 to dozens per week |
| T1.2 | `retrieval_rejected` count | Rises proportional to bindings; reranker per-origin posterior shifts |
| T1.3 | `knowledge_promoted` count | Rises from 304 → 600+ as corroboration extracts kick in |
| T2.1 | `threshold_predicate` artifacts in `act_artifact_registry_view` | Count = N hardcoded constants migrated |
| T2.2 | `prompt_section_predicate` posteriors | Diverge across goal_class; floor flag earns its scoring |
| T2.3 | `supervisor_redispatch_storm` false-positive rate | Falls |
| T2.4 | `counterfactual_credit_recorded` count | Rises proportional to brain dispatches |
| T2.5 | Credit-formula posterior divergence | Visible per directive class |

**Final state:** every metric in `failure_view` falls toward zero or stabilizes at a known-healthy baseline. Every promoted_knowledge entry has visible credit flow. Every threshold has a posterior that moves on outcomes. The organism becomes the most adaptive, most universal, most compounding learning system on the planet — not by any single architectural insight, but by ensuring **every boundary is in the registry** and **every credit closes the chain**.
