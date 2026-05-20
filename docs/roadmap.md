# AccInt — Roadmap

**Thesis.** Ordered by structural leverage and causal dependency: Tier S0 calibrates the owner channel that grounds every other posterior; Tier 0 makes posterior evidence trustworthy by closing artifact-credit, citation-binding, and closure-truth gaps; later tiers convert more decision boundaries into posterior-scored, reusable rows. Each entry names the problem, contract shape, tier rationale, closure predicate, and metric direction — detailed proofs stay in substrate events and knowledge, not this file (`SAF9AVJ8HD7W5DK847W72ETXHR`, `6DZ417CCK57P90B7B2FTAV024M`, `FE8DF6H1KN1590MGP6JHFPTWYW`, `433DGRZ27547KESBFYR4FZ10WC`).

Cross-references: architecture surfaces live in `docs/Architecture.md` — §9 (owner alignment) grounds Tier S0; §10 (universal posterior boundary) maps tiers to scored-row moves; §12 (open frontier) enumerates the same tier clusters; §14 (universal intent) cites the live numbers that motivate sequencing.

## Tier -1 — RECURSION STOP FLOOR

These contracts precede posterior scoring. They are floors, not high-frequency features: the contract is absence-of-violation evidence plus immediate quarantine on violation (`2XXFM1SPZX5XHFN31RWSR69TN4`, `PY1WBY1RF12RSBCQEQKBHDFH8R`).

- `event_authenticity_predicate` — Problem: forged events can make every downstream score self-confirming. Contract: accept ledger evidence only through authenticated append paths. Why: causal, credit, and retrieval evidence depends on event origin. Closure predicate: no unauthenticated event accepted; violation forces quarantine. Metric direction: authenticity violations stay zero.
- `storage_integrity_predicate` — Problem: SQLite/WAL or filesystem corruption can rewrite memory. Contract: integrity checks, checkpoint evidence, and backup/export recovery preserve ledger bytes. Why: retrieval and time reasoning are meaningless over corrupt state. Closure predicate: no failed integrity check without quarantine. Metric direction: integrity failures stay zero and recovery evidence remains fresh.
- `kernel_sandbox_integrity_predicate` — Problem: a compromised kernel or unenforced sandbox can fake observations. Contract: sandbox enforcement/degradation is explicit and resource claims are not trusted when the floor fails. Why: artifact observations are only useful if runtime boundaries hold. Closure predicate: sandbox violations/degradations are surfaced and never scored as clean success. Metric direction: silent sandbox bypass stays zero.
- `deterministic_computation_sanity_predicate` — Problem: arithmetic or deterministic recomputation faults can invalidate residuals. Contract: verifier computation is repeatable within declared tolerance. Why: residual is the universal score. Closure predicate: deterministic fixtures agree or the scorer quarantines its result. Metric direction: recomputation mismatches stay zero.
- `owner_identity_continuity_predicate` — Problem: spoofed or discontinuous owner authority can optimize the wrong goal. Contract: owner input remains bound to the same authority channel before irreversible or high-control actions. Why: every posterior is subordinate to owner intent. Closure predicate: identity discontinuity triggers owner-input-required rather than autonomous commit. Metric direction: unresolved identity discontinuities stay zero.

Boot order follows dependency, not metaphysics: hardware/host sanity returns stable bytes; storage preserves them; kernel/sandbox enforces runtime boundaries; deterministic computation makes residuals repeatable; owner identity binds the resulting loop to the right authority (`29PYKT08KN7SH4AXEVMNEJAE0R`).

## Tier S0 — OWNER ALIGNMENT

Owner truth calibrates every other posterior, but the owner model is now treated as a bounded, drifting representation rather than an infinitely compoundable profile. Live evidence (2 `owner_observed_outcome_recorded` events against 2,197 act tuples and 4,027 scored actions) still shows owner outcomes are too sparse to ground other posteriors today; 2026 work adds a stronger requirement: owner alignment must score preservation, adaptation, delegation, rendering, and belief modeling as separate boundaries. Each boundary remains an `act_artifact` row scored by owner-observed outcomes and structural residuals through the shared Beta posterior, retrieval, merger, and credit machinery — the owner is another actor in the substrate, not a persona enum (`VVD2T4QAAH19`; see Architecture.md §9).

The S0 owner-alignment decomposition is tiered inside S0:

- **S0 floor: `owner_goal_preservation_drift_predicate`** — detects when accumulated owner-profile, knowledge-merger, embedding, retrieval top-K, or summarized-session state has drifted from fresh owner evidence; grounds in Kriger 2026 on formal goal-preservation bounds under lossy compression. Contract: high drift residual blocks autonomous commit and opens owner reconciliation or evidence refresh.
- **S0 policy: `metacognitive_owner_policy_predicate`** — tracks per-session and cross-session metacognitive policy state, including when the substrate should learn, ask, defer, or compress; grounds in HILA Yang et al. 2026 (arXiv 2603.07972) dual-loop policy optimization with continual learning. Contract: owner alignment is not only per-cycle inference; the policy that selects owner interactions is itself scored.
- **S0 safety: `delegation_safety_predicate`** — scores whether a task should autonomous-commit, ask the owner, route to Claude inline, route to brain, or defer; grounds in SBD Sun 2026 (arXiv 2604.27358) safe bilevel delegation and COSMIC Vashishtha et al. 2026 self-supervised agent selection. Contract: delegation choice is a verifier-scored safety boundary, not advisory prose.
- **S0 state: `continual_owner_state_predicate`** — replaces the split estimator/transition pair for roadmap purposes; infers latent owner state and transition dynamics across sessions while retaining VARS (arXiv 2603.20939), Causal Preference Learning (arXiv 2506.05967), Adaptive Alignment MORL (arXiv 2410.23630), and personalized preference benchmarking, now including Personalized RewardBench Ma et al. 2026 as a benchmark target alongside or above POPI.
- **S0 forecast: `owner_outcome_forecast_predicate`** — predicts owner-observed outcome before commit; retains PAHF (arXiv 2602.16173) and COPR (arXiv 2402.14228), but consumes drift, metacognitive policy, and delegation-safety residuals rather than acting as the only pre-commit owner check.
- **S0 rendering: `owner_rendering_predicate`** — selects owner-visible rendering by profile and task context; retains Adaptive Querying with AI Persona Priors (arXiv 2605.00696), but is downstream of delegation safety so rendering cannot launder a decision that should have asked the owner.
- **S0 belief: `ordered_theory_of_mind_predicate`** — replaces flat ToM modeling with an explicit order axis and staged assessment: first-order owner beliefs, second-order owner beliefs about substrate beliefs, then moral/constraint evaluation; grounds in Theory of Mind LLM Agents (arXiv 2509.22887), Adaptive ToM Mu et al. AAAI 2026 on ToM-order alignment, MetaMind Zhang et al. NeurIPS 2026 staged ToM Agent to Moral Agent assessment, and the ICLR 2026 RSI Workshop agenda.
- **S0 orchestration: `owner_alignment_orchestrator_predicate`** — selects which owner-alignment predicate(s) must run for a task, using SSA-style self-selection while preventing self-invocation loops; grounds in COSMIC Vashishtha et al. IEEE 2026 and reuses brain/substrate primitive visibility lessons (`34Z9VFMP5H5N`, `MYMQZFM2XX7732AQ`, `V3CED593BH5M`). Contract: the substrate chooses the minimum owner-alignment boundary set needed for the current risk, novelty, drift, and control signals.

**Closure predicate (S0).** Each S0 predicate row reaches > 30 relevant bindings where possible, posterior movement (alpha+beta growth), and non-degenerate Beta variance; additionally, drift residuals trigger reconciliation when high, HILA-style metacognitive policy state changes across sessions are visible, delegation-safety decisions are scored before autonomous commit, ToM outputs include an order axis or explicit rejection reason, and contradiction rate stays bounded.

**Metric direction.** `owner_observed_outcome_recorded` count rises from 2 toward the calibration floor; non-code closure residuals calibrate against owner truth rather than deterministic-test residual alone.

## Tier 0 — TRUST

### T0.1 — Closure-audit substrate-truth gate

Problem: closure can claim row-level delivery without ledger-backed amendments, so later posteriors can trust a false success (`SAF9AVJ8HD7W5DK847W72ETXHR`).

Contract: `runtime/closure_audit.ts` must query the ledger for declared target files and refuse low residual when matching deliverable events are absent; closure predicate is `declared_targets_have_events OR no_declared_targets` (`SAF9AVJ8HD7W5DK847W72ETXHR`).

Why this tier: all subsequent contracts depend on honest closure evidence (`YB2C2QCKC10BNBDVF22CX1Y5V8`).

Metric direction: refused false closures rise first, then closure residual distribution becomes more honest (`SAF9AVJ8HD7W5DK847W72ETXHR`).

### T0.2 — Artifact auto-binding and credit revival

Problem: artifact promotion is dormant. Live state.db evidence: **20 `act_artifact_score_updated` events against 4,027 `action_scored` events (~0.5%)**, **1,419 of 1,496 act_artifact rows still carry the legacy `kind=code_artifact` discriminator (94.9%)**, and only a small minority of `act_tuple_recorded` envelopes populate `cited_artifact_ids` at all (`SAF9AVJ8HD7W5DK847W72ETXHR`, `A4V81PN9E960S02MWSM4HSM5G4`).

Contract: `runtime/events.ts:normalizeActTuple` auto-binds selected action and verifier artifacts into `cited_artifact_ids`, then credit updates artifact posteriors; closure predicate is artifact-score updates proportional to action-scored rows and selected artifacts visible in retrieval/credit projections (`17WRSQT7015DFDPQN5SXGM25FG`, `4VERR5ZBH57QQ0KC1ZD50TAAT0`).

Why this tier: artifacts are the reusable composition primitives, so frontier predicates cannot compound while selected artifacts remain invisible (`6DZ417CCK57P90B7B2FTAV024M`).

Metric direction: `act_artifact_score_updated` rises sharply; artifact promotion/quarantine becomes nonzero (`SAF9AVJ8HD7W5DK847W72ETXHR`).

### T0.3 — Knowledge citation binding enforcement

Problem: citation without substring binding breaks the k_555 chain and creates decorative credit (`YB2C2QCKC10BNBDVF22CX1Y5V8`).

Contract: emit-boundary validation strips unbound `cited_knowledge_ids` and records a rejection event; closure predicate is mixed bound/unbound fixture strips only unbound IDs (`YB2C2QCKC10BNBDVF22CX1Y5V8`).

Why this tier: retrieval, merger, and counterfactual credit need honest source bindings (`AT2T17VAP159Z385DCM7GBTN4G`).

Metric direction: decorative strips rise first, then fall as emitters learn binding (`YB2C2QCKC10BNBDVF22CX1Y5V8`).

### T0.4 — Artifact-kind backfill

Problem: most artifact rows carry legacy `kind=code_artifact`, so the open-kind discriminator exists but cannot guide extractors (`SAF9AVJ8HD7W5DK847W72ETXHR`, `SDP3E1V50973X1AZ4V2FSERCEC`).

Contract: a one-time inferred-kind sweep uses body signatures, sandbox declarations, target resources, and citation/dispatch patterns; ambiguous rows get review tasks; closure predicate is inferred metadata events plus low ambiguous residual (`SDP3E1V50973X1AZ4V2FSERCEC`).

Why this tier: kind-aware scorers need populated kind data before they can learn (`SDP3E1V50973X1AZ4V2FSERCEC`).

Metric direction: legacy-kind share falls; kind-specific posterior divergence becomes measurable (`SDP3E1V50973X1AZ4V2FSERCEC`).

## Tier 1 — OUTCOME CHANNELS

### T1.1 — Owner-outcome channel

Problem: non-technical goals need owner truth, but owner-observed outcomes are sparse compared with candidate and action volume (`SAF9AVJ8HD7W5DK847W72ETXHR`).

Contract: worker opens owner follow-up actions after feedback windows for eligible applied changes; closure predicate is owner answers persisted as `owner_observed_outcome_recorded` and credited (`B13YVJDAJD5E1928KG3Q97P7RW`).

Why this tier: universal goals need lived outcome evidence, not just deterministic code tests (`5F21YF13Z13W5FNJ6DR2YJ04M0`).

Metric direction: owner outcome count rises and non-code closure residuals calibrate (`B13YVJDAJD5E1928KG3Q97P7RW`).

### T1.2 — Retrieval-rejection emitter

Problem: retrieval exposure exists, but unused hits are not credited as weak negative evidence (`AT2T17VAP159Z385DCM7GBTN4G`).

Contract: `runtime/credit.ts` emits `retrieval_rejected` for exposed bindings not cited by the act; closure predicate is rejected count proportional to unbound bindings and posterior beta movement (`XZBAVD6YR53894C4TECXRC6440`).

Why this tier: improves retrieval without owner effort and extends section-level retrieval credit (`AT2T17VAP159Z385DCM7GBTN4G`).

Metric direction: rejection events rise, retrieval dead weight falls (`AT2T17VAP159Z385DCM7GBTN4G`).

### T1.3 — Cross-candidate knowledge-promotion corroboration

Problem: candidates can corroborate promoted knowledge without being directly cited, leaving useful claims stranded (`FE8DF6H1KN1590MGP6JHFPTWYW`).

Contract: extractor pairs unverified candidates with promoted neighbors by embedding and goal-shape overlap; closure predicate is semantic-corroboration confirmations and promotion-rate lift without false-promotion lift (`FE8DF6H1KN1590MGP6JHFPTWYW`).

Why this tier: raises knowledge throughput after trust and retrieval signals are honest (`YB2C2QCKC10BNBDVF22CX1Y5V8`).

Metric direction: promoted knowledge rises while contradiction rate stays bounded (`FE8DF6H1KN1590MGP6JHFPTWYW`).

## Tier 2 — RLM-EFFICIENCY AT THE SUBSTRATE

### T2.1 — On-demand policy bundles

Problem: long policy grammars consume default prompt mass (`433DGRZ27547KESBFYR4FZ10WC`).

Contract: emission grammars, examples, gates, and runbooks become retrieved `act_artifact` policy rows; closure predicate is task-relevant bundles selected with lower prompt mass (`S1PCZEFEDD4BS04RVPQF2JNBY8`).

Why this tier: keeps the operating prompt small without weakening load-bearing rules (`433DGRZ27547KESBFYR4FZ10WC`).

Metric direction: prompt tokens fall; missed-policy residual does not rise (`S1PCZEFEDD4BS04RVPQF2JNBY8`).

### T2.2 — Prompt section content variants

Problem: section inclusion can be scored, but section wording is still hardcoded (`HW5CRSMF8S1NDF4HGT2E2PFKZM`).

Contract: `prompt_section_content_variant` rows are selected by goal and owner profile; closure predicate is selected variant binding and posterior movement (`MZ7VJ4GCT12YB9STJEHEQV1EEW`, `QZ528KXXP161Q8FBJKWZP8A03M`).

Why this tier: content quality becomes adaptive without adding doc prose (`HW5CRSMF8S1NDF4HGT2E2PFKZM`).

Metric direction: variant posteriors diverge and token-adjusted closure improves (`QZ528KXXP161Q8FBJKWZP8A03M`).

### T2.3 — CLAUDE.md prose-rule variants

Problem: prose rules are natural-language constants unless represented as scored rows (`V6M5EMAPQD2G32HNCDH3PAE0G8`).

Contract: `prose_rule_variant` rows compete only within invariant-equivalent scopes; closure predicate is variant selection, binding, and no protected-rule weakening (`V6M5EMAPQD2G32HNCDH3PAE0G8`).

Why this tier: wording adapts while structural invariants stay protected (`V6M5EMAPQD2G32HNCDH3PAE0G8`).

Metric direction: rule-variant posteriors diverge by goal class and owner profile (`V6M5EMAPQD2G32HNCDH3PAE0G8`).

### T2.4 — Section-level retrieval credit

Problem: item-level retrieval credit does not tell whether a whole prompt section earned its tokens (`AT2T17VAP159Z385DCM7GBTN4G`).

Contract: emit used/unused judgments per section after action scoring; closure predicate is section posterior movement and composer budget shifts (`AT2T17VAP159Z385DCM7GBTN4G`).

Why this tier: it is the smallest high-leverage prompt-quality signal once T1.2 exists (`AT2T17VAP159Z385DCM7GBTN4G`).

Metric direction: section token allocation follows outcome evidence (`AT2T17VAP159Z385DCM7GBTN4G`).

### T2.5 — Surface-existence posterior with security carve-out

Problem: registered surfaces lack usage-by-outcome scoring, but security/schema gates must not be retired for low frequency (`HBQ8FM8HED2AX2R7EDCVY15R8W`).

Contract: `surface_existence_predicate` scores event kinds, tools, workers, views, and CLI verbs; admin_token, deny-lists, owner_gate `things_to_never_do`, FK, NOT NULL, and single-writer SQLite are protected by absence-of-violation evidence; closure predicate is scored surfaces plus protected reasons (`RPB5W9PRPS6S3EPTYAE33JD4MW`, `5EKBX6PTDS6XS1XAZXAZD0NMX4`).

Why this tier: trims dead surfaces without cutting safety gates (`HBQ8FM8HED2AX2R7EDCVY15R8W`).

Metric direction: retirement candidates appear for low-value surfaces while protected gates remain (`5EKBX6PTDS6XS1XAZXAZD0NMX4`).

## Tier 3 — STRUCTURAL POSTERIOR BOUNDARIES

Tier S order is S2, S4, S5, S3, S1 (`G3PR7X6TCD4T57D7T6GXCDY9AW`).

### T3.1 — Universal threshold registry

Problem: hardcoded thresholds keep trunk behavior rigid (`FE8DF6H1KN1590MGP6JHFPTWYW`).

Contract: threshold predicates live as artifact rows read through a runtime accessor; closure predicate is all named constants migrated with fallback defaults (`FE8DF6H1KN1590MGP6JHFPTWYW`).

Why this tier: later boundary predicates need the same registry pattern (`G3PR7X6TCD4T57D7T6GXCDY9AW`).

Metric direction: threshold rows gain posterior movement (`FE8DF6H1KN1590MGP6JHFPTWYW`).

### T3.2 — S2 causal-edge posterior

Problem: nodes have scores but citation/refinement/supersession edges do not (`G3PR7X6TCD4T57D7T6GXCDY9AW`).

Contract: `causal_edge_predicate` scores edge kinds by closure improvement; closure predicate is edge posterior used by retrieval and credit (`3F2FK5J04144D9MCRKDXHH5CA8`).

Why this tier: every later scorer depends on reliable edges (`G3PR7X6TCD4T57D7T6GXCDY9AW`).

Metric direction: edge weights diverge by goal shape (`3F2FK5J04144D9MCRKDXHH5CA8`).

### T3.3 — S4 merger-rule predicates

Problem: merger thresholds and weights are still fixed rules (`D2NCDZ76RD11K3PEA4D5CCZRA8`).

Contract: `merger_rule_predicate` rows score dedup, corroboration, synthesis, and origin-bias settings; closure predicate is faster promotion without false-promotion lift (`D2NCDZ76RD11K3PEA4D5CCZRA8`).

Why this tier: merger wisdom controls knowledge quality for all later learning (`G3PR7X6TCD4T57D7T6GXCDY9AW`).

Metric direction: promotion speed rises with bounded contradiction rate (`D2NCDZ76RD11K3PEA4D5CCZRA8`).

### T3.4 — S5 goal-shape extraction strategy

Problem: atomic goal shapes can poison per-class posteriors when split or merged poorly (`3517MGZAEH6856BRDSCT1HXJM8`).

Contract: `goal_shape_strategy_predicate` scores extractors by within-group residual variance; closure predicate is lower variance and better transfer (`3517MGZAEH6856BRDSCT1HXJM8`).

Why this tier: class-local thresholds depend on reliable classes (`G3PR7X6TCD4T57D7T6GXCDY9AW`).

Metric direction: within-class residual variance falls (`3517MGZAEH6856BRDSCT1HXJM8`).

### T3.5 — S3 trajectory-motif extractor

Problem: repeated event sequences are not promoted into reusable motifs at scale (`NWZSMV8F5N33N6FG4XKW9ZDHEC`).

Contract: `trajectory_motif_extractor_predicate` scores sequence motifs by replay usefulness; closure predicate is motif rows that improve replay or dispatch (`NWZSMV8F5N33N6FG4XKW9ZDHEC`).

Why this tier: motifs need edge and goal-shape semantics first (`G3PR7X6TCD4T57D7T6GXCDY9AW`).

Metric direction: recipe/motif reuse rises (`NWZSMV8F5N33N6FG4XKW9ZDHEC`).

### T3.6 — S1 DAG decomposition strategy

Problem: fan-out, depth, sibling order, and edge selection are not scored as reusable strategy (`MQQCK9FQ452H1FYA4H72Z9RJPR`).

Contract: `decomposition_strategy_predicate` scores DAG structure by goal class; closure predicate is lower duplicate work and lower residual (`MQQCK9FQ452H1FYA4H72Z9RJPR`).

Why this tier: fair scoring needs the prior edge, merger, shape, and motif signals (`G3PR7X6TCD4T57D7T6GXCDY9AW`).

Metric direction: duplicate siblings and redispatch storms fall (`MQQCK9FQ452H1FYA4H72Z9RJPR`).

### T3.7 — Pedagogical RL contracts

Pedagogical RL primitives are scored boundaries that route closure-audit and owner-outcome evidence back into composition. Source: <https://noahziems.com/pedagogical-rl> (with LADDER 2503.00735, Gödel Agent 2410.04444, ICLR 2026 RSI Workshop). Order by leverage:

1. `composer_policy_predicate` — first, subsumes prior section-credit work (T2.4) by making the prompt composer pedagogically self-guided through closure-audit and owner-outcome evidence.
2. `pedagogical_reward_predicate` — second, scores synthetic curriculum signals against downstream closure/owner outcomes.
3. `citation_spike_auditor` — third, flags retrieval citations whose binding correlates with closure-residual spikes (positive or negative) for credit weighting.
4. `surprisal_gate_predicate` — fourth, gates emission on surprise-vs-residual ratio so high-surprise low-residual paths cannot dominate.

Each lands as an `act_artifact` row. **Closure predicate (T3.7).** Posterior alpha/beta movement on each predicate row tied to `task_closure_audited` and `owner_observed_outcome_recorded` events within the same trajectory, with composer-policy posterior outperforming the prior fixed-section baseline by a measurable closure-residual margin.

**Metric direction.** Composer-policy variants diverge by goal class; section-token allocation shifts toward closure-correlated sections; high-surprise low-residual emissions decline.

## Tier 4 — META-CREDIT + COUNTERFACTUAL

### T4.1 — Counterfactual credit

Problem: chosen artifacts get evidence while near-miss alternatives do not (`FE8DF6H1KN1590MGP6JHFPTWYW`).

Contract: persist top-K alternatives at dispatch and score unchosen alternatives after action scoring; closure predicate is counterfactual credit rows and selector calibration (`FE8DF6H1KN1590MGP6JHFPTWYW`).

Why this tier: needs artifact credit and edge evidence first (`6DZ417CCK57P90B7B2FTAV024M`).

Metric direction: selector convergence accelerates (`FE8DF6H1KN1590MGP6JHFPTWYW`).

### T4.2 — Meta-credit formula

Problem: the credit formula is itself an unscored choice (`FE8DF6H1KN1590MGP6JHFPTWYW`).

Contract: credit-distribution predicate rows compete by calibration improvement; closure predicate is bounded one-level recursion (`FE8DF6H1KN1590MGP6JHFPTWYW`).

Why this tier: scores the scorer only after base credit is trustworthy (`YB2C2QCKC10BNBDVF22CX1Y5V8`).

Metric direction: formula posterior diverges by directive class (`FE8DF6H1KN1590MGP6JHFPTWYW`).

### T4.3 — Brain prediction-accuracy posterior

Problem: predicted residual quality is high-value routing evidence but not separately calibrated (`A24CCF6C2C2C4E85A91A529DFB`).

Contract: score predicted-vs-observed residual per goal class and route; closure predicate is prediction accuracy visible to dispatch (`A24CCF6C2C2C4E85A91A529DFB`).

Why this tier: routing can trust forecasts only after closure truth and credit paths stabilize (`SAF9AVJ8HD7W5DK847W72ETXHR`).

Metric direction: prediction error falls by class (`A24CCF6C2C2C4E85A91A529DFB`).

### T4.4 — Coalition / joint-citation posterior

Problem: individual nodes get credit, but recurring coalitions of artifacts, knowledge, sections, and edges are not scored as combinations (`YB2C2QCKC10BNBDVF22CX1Y5V8`).

Contract: emit coalition posterior rows for repeated bound sets; closure predicate is coalition predictions beating independent-node baselines (`YB2C2QCKC10BNBDVF22CX1Y5V8`).

Why this tier: true composition growth is combination reuse, not only node reuse (`6DZ417CCK57P90B7B2FTAV024M`).

Metric direction: successful coalition reuse rises (`YB2C2QCKC10BNBDVF22CX1Y5V8`).

## Tier 5 — UNIVERSALITY + OPERATIONS

Sandbox parity, freeze-state, token rotation, backup/export cadence, migration sweep, worker-thread pool for heavy aggregates, and runtime-runner registry land here because they improve operational universality after the trust and posterior boundaries are in place. Closure predicate for the cluster: each operational surface ships with declared SLOs, observable health signals, and recovery procedures cited from substrate knowledge — no operational change earns "done" without measurable absence-of-violation evidence (`A4V81PN9E960S02MWSM4HSM5G4`, `HBQ8FM8HED2AX2R7EDCVY15R8W`).

Worker-thread pool contract: keep embedded SQLite for microsecond hot paths and offload known heavy aggregate reads only; closure predicate is event-loop freed during heavy queries while writes remain serialized (`A4V81PN9E960S02MWSM4HSM5G4`).

## Tier 6 — Scoreable-Assumption Predicates

These are graceful-degradation assumptions: violations raise residuals and route repair, but they do not by themselves stop recursion when the Tier -1 floors hold (`TNMTQAZS3D7T3AD78GAA2TKTSG`).

- `causal_edge_reliability_predicate` — Problem: graph edges can be decorative. Contract: score whether edges predict closure improvement. Why: later routing trusts edges. Closure predicate: edge weights move with outcomes. Metric direction: edge-residual error falls.
- `intervention_effect_estimation_predicate` — Problem: actions may precede rather than cause improvement. Contract: compare chosen acts to observed residual deltas. Why: credit needs causal evidence. Closure predicate: intervention forecasts calibrate. Metric direction: attribution error falls.
- `counterfactual_comparison_predicate` — Problem: rejected alternatives lack fair evidence. Contract: persist near-miss alternatives for after-action scoring. Why: selectors learn from unchosen options. Closure predicate: counterfactual rows affect routing. Metric direction: regret falls.
- `credit_assignment_fidelity_predicate` — Problem: outcome credit can land on uninfluential bindings. Contract: score whether cited knowledge/artifacts actually shaped success. Why: posterior compounding depends on honest credit. Closure predicate: decorative credit beta rises. Metric direction: miscredit falls.
- `cost_model_accuracy_predicate` — Problem: token, wall, verifier, and invocation budgets drift. Contract: compare estimates to observations. Why: economics guide dispatch. Closure predicate: budget residuals calibrate. Metric direction: forecast error falls.
- `opportunity_cost_predicate` — Problem: selected work may delay higher-value objectives. Contract: score expected residual delta against active alternatives. Why: scheduling is economic choice. Closure predicate: delayed-work regret is measurable. Metric direction: missed-value residual falls.
- `artifact_reuse_value_predicate` — Problem: reuse can be cargo cult. Contract: compare reused artifacts/recipes to fresh authoring cost and residual. Why: self-extension needs reusable value. Closure predicate: reuse posteriors diverge. Metric direction: residual per cost improves.
- `marginal_information_value_predicate` — Problem: extra retrieval/review can waste cycles. Contract: score residual reduction per added evidence step. Why: bounded peeks need a stopping rule. Closure predicate: low-yield peeks decline. Metric direction: information ROI rises.
- `source_provenance_reliability_predicate` — Problem: source quality varies after floor authenticity holds. Contract: score provenance against later outcomes. Why: not all authentic sources are reliable. Closure predicate: provenance posteriors diverge. Metric direction: source-calibration error falls.
- `retrieval_binding_honesty_predicate` — Problem: citations can be decorative. Contract: bind cited claims to actual action influence. Why: citation is mutation. Closure predicate: unbound citation rejection works. Metric direction: decorative citations fall.
- `review_cadence_sufficiency_predicate` — Problem: review intervals can miss drift. Contract: score cadence against drift/high-residual incidence. Why: continuity needs timed review. Closure predicate: cadence adjusts by outcome. Metric direction: stale-review residual falls.
- `epistemic_convergence_predicate` — Problem: independent-looking evidence can share one compromised source. Contract: score corroboration independence. Why: merger quality depends on non-circular evidence. Closure predicate: circular corroboration is contradicted. Metric direction: false convergence falls.
- `contradiction_resolution_quality_predicate` — Problem: contradictions can be suppressed or duplicated. Contract: score adjudication quality. Why: knowledge improves by resolving conflict. Closure predicate: resolved contradictions improve closure. Metric direction: unresolved contradiction age falls.
- `calibration_transfer_predicate` — Problem: evidence may over-transfer across goal shapes. Contract: score transfer by class-local outcome. Why: generalization must be earned. Closure predicate: transferred rules beat local baseline. Metric direction: transfer regret falls.
- `uncertainty_expression_predicate` — Problem: residual packets can hide unknowns. Contract: score whether uncertainty/reliability axes predict later surprises. Why: low residual without uncertainty is overconfidence. Closure predicate: surprise residual calibrates. Metric direction: overconfidence falls.
- `language_grounding_predicate` — Problem: natural-language referents can drift through execution. Contract: score referent preservation from directive to closure. Why: contracts are linguistic handles. Closure predicate: drifted referents raise residual. Metric direction: referent drift falls.
- `owner_term_alignment_predicate` — Problem: owner-visible language can violate preferred/avoided terms. Contract: score rendering against owner profile and feedback. Why: owner trust is evidence-bearing. Closure predicate: feedback and rendering audits calibrate. Metric direction: rendering misses fall.
- `semantic_anchor_stability_predicate` — Problem: doc anchors can match text while meaning changes. Contract: score anchor meaning across concurrent edits. Why: auto-apply needs semantic locality. Closure predicate: stale anchors are refused. Metric direction: anchor-collision residual falls.
- `goal_continuity_predicate` — Problem: refinements can optimize a different goal. Contract: score objective preservation across DAG edges. Why: recursion must serve the originating intent. Closure predicate: goal drift is detected before commit. Metric direction: drift residual falls.
- `ledger_time_consistency_predicate` — Problem: event ordering and due dates can mislead reasoning. Contract: score timestamp/order consistency. Why: causality and review cadence depend on time. Closure predicate: inconsistent temporal claims raise residual. Metric direction: temporal inconsistency falls.

## Rejected Alternatives

### rqlite

Rejected because HTTP roundtrips are the wrong tradeoff for AccInt's embedded SQLite hot path; the heavy-query problem is solved by a worker-thread pool, not a network database layer (`A4V81PN9E960S02MWSM4HSM5G4`).

### Opening runtime type to string as a one-line change

Deferred because SandboxDecl and runner dispatch are structurally coupled to runtime-specific declarations; the correct contract is a runner registry plus SandboxDecl redesign (`A4V81PN9E960S02MWSM4HSM5G4`).

### Multiple-brain operation

Rejected. The organism pins opencode gpt-5.5 as the brain. Alternate-model arbitration would add routing complexity and selector noise before the artifact-credit, citation-binding, and closure-truth gaps (Tier 0) are closed. Once those gaps close and `T4.3` (brain prediction-accuracy posterior) calibrates, model choice could in principle become another scored row — but the current substrate has no signal that would benefit from arbitration (`SAF9AVJ8HD7W5DK847W72ETXHR`, `6DZ417CCK57P90B7B2FTAV024M`).

## Cross-cutting Principles

- Open vocabulary at boundaries; new strings appear as rows and events, not closed enums (`HBQ8FM8HED2AX2R7EDCVY15R8W`).
- Security and schema gates are protected by absence-of-violation evidence, not usage-frequency posterior (`RPB5W9PRPS6S3EPTYAE33JD4MW`).
- Every contract must cite live substrate evidence and define a closure predicate (`SAF9AVJ8HD7W5DK847W72ETXHR`).
- Brain proposes; substrate and orchestrator apply through ledger-visible gates (`4EAFA894A8194C4CA74F08430C`).
- Docs stay small; detailed inventories and historical proofs stay retrievable (`433DGRZ27547KESBFYR4FZ10WC`).

## Live Metrics To Watch

| Area | Metric | Live baseline | Expected direction |
|---|---|---|---|
| S0 | `owner_observed_outcome_recorded` count | 2 | Up toward calibration floor (>30 per predicate) |
| T0.1 | false-closure refusals | n/a | Up first, then stable |
| T0.2 | `act_artifact_score_updated` / `action_scored` | 20 / 4,027 (~0.5%) | Up sharply |
| T0.3 | stripped decorative citations | n/a | Up first, then down |
| T0.4 | legacy artifact-kind share | 1,419 / 1,496 (94.9%) | Down |
| T1.1 | owner outcome events | 2 | Up |
| T1.2 | retrieval rejections | n/a | Up proportional to unused exposure |
| T1.3 | promoted knowledge with bounded contradictions | 305 promoted | Up |
| T2 | prompt tokens per successful dispatch | n/a | Down without residual rise |
| T3 | boundary-predicate rows with moving posteriors | n/a | Up |
| T4 | selector and credit calibration error | n/a | Down |
| T5 | health latency under heavy aggregate load | n/a | Down |

Baseline numbers are a point-in-time diagnostic snapshot, not a canonical promise. Regenerate them from the substrate status/audit surface before making dispatch-order decisions; Architecture.md should cite the same generated snapshot event rather than repeating mutable counts.

**Final state.** Every reusable boundary is a scored row, every credit path closes, protected security gates stay protected by absence-of-violation evidence, and the substrate compounds across code, research, work, relationships, and embodied goals through one residual-scored loop. The roadmap is done when (a) Tier S0/T0/T1 metrics calibrate, (b) Tier 2/3 predicates show posterior divergence, and (c) Tier 4 selector error trends down — see Architecture.md §14 for the live ALIVE verdict (`5F21YF13Z13W5FNJ6DR2YJ04M0`, `YB2C2QCKC10BNBDVF22CX1Y5V8`, `HBQ8FM8HED2AX2R7EDCVY15R8W`).
