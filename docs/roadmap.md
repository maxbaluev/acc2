# AccInt — Roadmap

**Thesis.** Ordered by structural leverage and causal dependency: Tier S0 calibrates the owner channel that grounds every other posterior; Tier 0 makes posterior evidence trustworthy by closing artifact-credit, citation-binding, and closure-truth gaps; later tiers convert more decision boundaries into posterior-scored, reusable rows. Each entry names the problem, contract shape, tier rationale, closure predicate, and metric direction — detailed proofs stay in substrate events and knowledge, not this file (`SAF9AVJ8HD7W5DK847W72ETXHR`, `6DZ417CCK57P90B7B2FTAV024M`, `FE8DF6H1KN1590MGP6JHFPTWYW`, `433DGRZ27547KESBFYR4FZ10WC`).

Cross-references: architecture surfaces live in `docs/Architecture.md` — §9 (owner alignment) grounds Tier S0; §10 (universal posterior boundary) maps tiers to scored-row moves; §12 (open frontier) enumerates the same tier clusters; §14 (universal intent) cites the live numbers that motivate sequencing.

## Tier A — AUTONOMOUS COMPOUNDING ACTIVATION

Problem: the inner brain dispatch loop compounds once invoked, but the outer loop is owner-mediated when substrate workers detect review debt, pathology exhaustion, dedup drift, calibration drift, or maintenance opportunities without emitting `brain_invocation_request`.

Contract: Father is re-enabled with autonomous-improvement templates and a tighter owner-idle window; rolling reviewer, pathology budget/supervisor, extractors, and credit calibration emit `brain_invocation_request` when their scored views cross thresholds; each request opens substrate-auto work that must propose a concrete amendment or lesson and pass closure audit.

Why this tier: Tier-1 bottlenecks are no longer the limiting factor; the organism now needs autonomous opportunity discovery so improvement is not gated by explicit owner prompts.

Closure predicate: `brain_invocation_request` emissions/day > 10 AND Father template fires/day > 3 AND substrate_auto-origin directives/day > 5.

Metric direction: substrate_auto-origin `contract_amendment_proposed` rows rise above 5/day while owner-observed negative outcomes and high-residual closures stay bounded.

## Tier R — RUNTIME MAIN-LOOP ISOLATION

Problem (measured 2026-05-21): the daemon's single Bun event loop serializes ALL SQLite writes (emitEvent, projections, embedder persist, credit) plus MCP request serving. Three concrete failures observed this session: (a) the embedder's per-row vec0 (sqlite-vec, 1536-dim) persist loop pinned the main thread 30-90s, making `/health` + the MCP HEAD probe time out (surfaced as `mcp_unreachable_at_spawn`); (b) daemon boot-to-listening was ~87s because port-bind is sequenced after every worker's first tick completes, and the embedder's first tick alone took 56s; (c) `EmbeddingIndex.rebuildFromDb` re-upserted every vector into vec_events on every boot (fixed in df4ce5a), and 286K non-embeddable rows bloated the `embedding IS NULL` partial index until the emit-time sentinel fix (369b7ef).

Contract — three independent moves, each closes one structural gap:

- **R1 Write isolation.** `runtime/sql_worker_pool.ts` today is READ-ONLY (`query<T>()`). Add a single dedicated WRITER worker thread that owns the write connection; main thread enqueues writes via a fast channel and gets the row id back via promise. `emitEvent` keeps its synchronous-id contract by minting the ULID client-side and deferring only the INSERT. Closure predicate: main-loop p99 blocked-time per tick < 50ms under a 50-events/sec write load; `/health` responds < 200ms while the embedder drains a 10K backlog. Metric direction: `bridge_failed{reason=mcp_unreachable_at_spawn}` and `Bun.serve request timed out` lines fall to zero.

- **R2 Instant startup.** Decouple port-bind from worker-readiness. Bind MCP + aux ports immediately after `openDb` + `runViews` + migrations (the minimum the MCP handlers need); run seed, orphan reconciliation, `EmbeddingIndex.rebuildFromDb`, and first worker ticks in the background after the daemon is already `listening`. Boot integrity uses `quick_check` not full `integrity_check` (shipped 369b7ef/df4ce5a). Closure predicate: boot-to-`acc2 daemon listening` < 3s on the production-size DB; `/ready` flips true only after first ticks, but `/health` + MCP serve from t+3s. Metric direction: daemon startup_duration_ms drops from ~87,000 to < 3,000.

- **R3 Embedder first-tick cost.** Profile why the embedder's first tick costs 56s with zero genuine backlog (post-sentinel). Candidates: query-plan staleness (needs `ANALYZE` after large mutations — run live this session), vec0 index warmup, or `minReactiveGapMs:0` reactive-storm during boot event bursts. Closure predicate: embedder tick wall-time < 2s at steady state; first-tick < 5s. Metric direction: `worker tick overrun` for the embedder falls to zero at steady state.

Why this tier: it precedes Tier A (autonomous compounding) operationally — father re-activation + brain_invocation_request producers add MORE concurrent dispatch load, which a serialized main loop cannot absorb. Runtime isolation is the substrate that makes autonomous throughput safe. Sits above Tier -1 floors because it is availability/throughput, not correctness-of-bytes.

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

Sandbox parity, freeze-state, token rotation, backup/export cadence, migration sweep, worker-thread pool for heavy aggregates, runtime-runner registry, and Claude-native operator integration land here because they make the same substrate loop operationally universal after trust and posterior boundaries exist. Closure predicate for the cluster: each operational surface ships with declared SLOs, observable health signals, recovery procedures, and absence-of-violation evidence (`A4V81PN9E960S02MWSM4HSM5G4`, `HBQ8FM8HED2AX2R7EDCVY15R8W`).

Claude Code integration contract: `acc init` performs the irreducible user-scope setup by idempotently registering the AccInt MCP server in `~/.claude.json`; Claude hooks (`UserPromptSubmit`, `SessionStart`, `Stop`) capture owner prompts and refresh transcript watches; the chat-transcript observer and automatic legacy-memory import fold into existing `extractors`, emitting existing `owner_input_received` / `directive_opened` / `knowledge_candidate` rows with `payload.origin="claude_legacy_memory"` where applicable; outflow markdown/docs are written by emit-time hooks on existing `applied_change_committed`, `knowledge_promoted`, and `task_closure_audited`; release distribution is an `act_artifact(kind="claude_plugin_package")` so the normal path can become `claude plugins install accint`. Reuse-first constraint: zero new event kinds, zero new MCP methods, zero new worker files, zero new predicate enums. Closure predicate: owner opens Claude Code, talks normally, and the substrate captures intent, routes, dispatches, and returns owner-readable outflow without requiring `acc task` or any other AccInt command; detailed implementation contracts live in Tier 7.

### T5.1 — Bounded hot retention with cold archives

Problem: the hot `state.db` is already past the intended operating envelope: owner-observed status reported ~782MB and 328,723 events (`VVZDM2WY512K11ZHCGW5C5NT8C`); live integrity snapshots now show 328,457 events (`19MHPA61J95V3DP50GRN19BCM0`). Daemon readiness has repeatedly taken 135-161s (`6M019PGH2964ZB6W9PYNNN4X4M`, `SX2CTRKCPD50154EC3HP83EMKW`, `SDRGQMTW5S20FEVVQV5R0CE514`, `Q74ADVHDR979B0JKQ2TBGSS2K4`, `PCCM8NQ06X16V2DDKJFNMCMRSW`), while bridge/MCP windows time out under churn (`93DGXTNR852BZ2RHKXV3X6D8WR`, `0K7GBQ2GJX0EBD39YV1TBZDMDC`, `8RW23BKTFD70K42GTGRX4SZTKC`). Current `event_kind_occurrence_view` shows the hot ledger is dominated by May 2026 production, with high-volume worker and brain telemetry; `worker_liveness_view` identifies `supervisor`, `embedder`, and `integrity` as hot aggregate consumers. `runtime/archival_worker.ts` already implements the intended direction: 30-day default cutoff, monthly `state-archive-YYYY-MM.db` sibling files, verify-then-delete, and `archival_sweep_completed`/`archival_integrity_failed` evidence.

Contract: Tier 5 owns bounded hot retention as the structural operations guarantee named in Architecture.md §3. The hot ledger retains a rolling 30-day window by default; events older than cutoff move to cold monthly sibling SQLite archives named `state-archive-YYYY-MM.db`. Default views, liveness checks, worker first-ticks, prompt composition, and health paths query only hot `state.db`. Explicit history/search reads may opt into cold archives by extending existing `substrate.read` view args to ATTACH sibling archive DBs and union hot+cold results. No new event kinds, MCP methods, worker files, or predicate enums: extend existing `runtime/archival_worker.ts`; use existing `state_snapshot_recorded`, `applied_change_committed`, `archival_sweep_completed`, and `archival_integrity_failed` rows for evidence.

Migration path: first enabled sweep scans the existing ~328K-row hot ledger with a 30-day cutoff, buckets eligible rows by event month, copies them into monthly archives, verifies copied ids, then deletes only verified hot rows. It emits a post-sweep snapshot with hot count, archive inventory, and integrity evidence.

Closure predicates: hot `events_count` remains bounded, target <50K; daemon boot/readiness remains <30s; default views perform no cold joins; explicit history reads return hot+cold results when requested.

Worker-thread pool contract: keep embedded SQLite for microsecond hot paths and offload known heavy aggregate reads only; closure predicate is event-loop freed during heavy queries while writes remain serialized (`A4V81PN9E960S02MWSM4HSM5G4`).

## Tier 7 — CLAUDE-NATIVE INTEGRATION COMPLETION

Five implementation contracts that close the Claude Code integration contract named in Tier 5. Every entry is an extension of an existing file or worker; zero new event kinds, zero new MCP methods, zero new worker files, zero new predicate enums.

### T7.1 — MCP registration in `acc init` (irreducible setup-config)

Problem: fresh Claude Code chats cannot read substrate state through MCP unless the AccInt server is registered at user scope; manual `claude mcp add-json` works but is not part of the install loop.

Contract: extend `cli/init.ts` + `cli/init.test.ts` to idempotently register the AccInt MCP server in Claude Code's `~/.claude.json` at user scope (prefer local stdio transport; the server proxies to the running daemon). Reversal: `claude mcp remove accint` or `acc init --undo-claude-integration`. Emit `state_snapshot_recorded` on success. Closure predicate: `claude mcp list` after `acc init` shows `accint` registered; re-running `acc init` is a no-op.

Metric direction: fresh-chat MCP availability = 1 after install; manual `claude mcp add-json` invocations trend to zero.

### T7.2 — Claude hooks integration

Problem: owner prompts in Claude Code chat do not enter the ledger automatically; only explicit `acc task` invocations do.

Contract: package `UserPromptSubmit`, `SessionStart`, and `Stop` hook configs in `.claude-plugin/hooks/hooks.json`. The `UserPromptSubmit` hook posts the prompt payload to the daemon over the existing MCP `substrate.emit` surface, which writes `owner_input_received` (and `directive_opened` when the intent classifier flags new directive-shaped work). `SessionStart`/`Stop` refresh the chat-transcript observer's active set. Hooks are accelerators, not authority — file polling remains as fallback per existing extractors design.

Closure predicate: owner messages in watched Claude Code chats reach the ledger within one hop without the owner typing `acc task`.

### T7.3 — Chat-transcript observer + legacy memory import (folded into existing `extractors`)

Problem: owner-intent ingress from chat transcripts and legacy memory must enter the ledger as evidence, not as transient text the next session forgets.

Contract: extend `substrate/extractors.ts` to consume `~/.claude/projects/*/conversation.jsonl` and `~/.claude/memory/`. Each owner message → `owner_input_received` event with dedup hash `sha256(transcript_path + stable_message_id_or_offset + role + text)`. Legacy memory snippets → `knowledge_candidate` rows with `payload.origin="claude_legacy_memory"`, source path/hash evidence, baseline `confidence_estimate`. No `owner_input_required` prompts (merger pipeline is the review layer). No new worker file.

Closure predicate: legacy-memory candidates promoted at rates similar to fresh candidates; chat-derived directives reach `task_committed` parity with explicit `acc task` directives.

### T7.4 — Outflow markdown via emit-time hook (extends existing consumers)

Problem: substantive completed work has no durable owner-readable surface.

Contract: emit-time hook on existing `runtime/contract_amendment_consumer.ts` or `runtime/rendering_audit_worker.ts` writes `~/.accint/outflow/<task_id>.{md|pdf|docx|...}` when an `applied_change_committed` / `knowledge_promoted(score≥0.75, owner_readable=true)` / `task_closure_audited(residual<0.3)` / `closure_complete` event lands. Linked ledger event carries the path. Inherits `always_keep` Mnemonic curation. Claude reads via existing `substrate.read({view_name:"outflow_artifact_view"})`.

Closure predicate: outflow artifacts produced per substantive completion ≥ 0.8; owner-observed outcome citations of outflow paths > 0.

### T7.5 — Claude plugin packaging (act_artifact distribution row)

Problem: AccInt installation is multi-step manual setup; the owner-facing channel should be `claude plugins install accint`.

Contract: package the AccInt plugin as `act_artifact(kind="claude_plugin_package")` admitted at release-cut time. Package: `.claude-plugin/plugin.json`, inline `mcpServers` entry for local stdio AccInt server, `hooks/hooks.json` per T7.2, optional `skills/acc/SKILL.md`, and a real bundled `.claude-plugin/substrate/canonical.db` for first install. The release pipeline runs `acc admin export-canonical .claude-plugin/substrate/canonical.db --yes`, not `acc admin export` and not raw `state.db` copy. `export-canonical` creates a fresh SQLite database from the current schema, imports only the portable-wisdom allow-list from Architecture §16, preserves posterior scores for portable `act_artifact` / recipes / promoted knowledge, strips embeddings and owner-local provenance, enforces `do_not_export` as a hard refusal, emits `state_exported {mode:'canonical'}`, and fails if the output contains any forbidden owner-local event kind or private raw-data artifact kind. `acc init` prefers the packaged canonical database when present and initializes an empty local `state.db` that attaches it read-only; when absent in dev checkouts, it falls back to `substrate/seed.ts`.

Implementation shape: add `cli/admin_export_canonical.ts` with `runExportCanonical({sourceDbPath, outputDbPath})`, register `acc admin export-canonical <path> [--yes]` in `cli/admin.ts`, and teach `cli/init.ts` to copy or attach `.claude-plugin/substrate/canonical.db` before running seed fallback. No new event kinds, MCP methods, worker files, or predicate enums.

Closure predicate: `claude plugins install accint` results in a working substrate with daemon health and MCP registered, `.claude-plugin/substrate/canonical.db` is a real SQLite database, and `acc admin export-canonical --verify` proves zero `owner_input_received`, `owner_decision_recorded`, `owner_observed_outcome_recorded`, `owner_profile_recorded`, private corpus, Alex synthesis, or `do_not_export` rows are present.

### T7.7 — Proposal-inbox views (rank 5 consolidation: keep separate, not merge)

Decision (per brain dispatch `QJZQSJ6T750T7A6FQ1GDKC5K10` + orchestrator judgment `KRFDEJQVV57K791QMSX78NPNCM`): `lesson_implementer_queue_view`, `lesson_implementation_status_view`, and `lesson_apply_candidate_view` stay as three separate views, not merged into one parameterized `proposal_inbox_view`. They are complementary projections, not accidental duplicates: queue is the apply inbox (consumed by `cli/apply.ts`, `runtime/prompt_composer.ts`, `cli/admin_pending_decisions.ts`, `runtime/pending_decision_retire_worker.ts`); status is the lifecycle/audit projection (request/action/scored/commit timestamps + residuals + flywheel_status); apply_candidate is the derived contract joining queue + status + `applied_lesson_effectiveness_view`. Merging would either widen every consumer to a mixed mega-row or hide mode-specific joins behind arguments — both recreate three contracts inside one name. If future duplication shows shared normalization logic across the three projections, extract an internal SQL fragment helper without changing the public projections.

### T7.6 — Lesson/judgment consolidation through knowledge_candidate

Problem: `lesson_extracted` and `knowledge_candidate` are both scored, embeddable, evidence-bearing rows that feed the same merger, but lessons still have a parallel proposal lifecycle.

Contract: keep historical `lesson_extracted` rows immutable and queryable; all NEW lesson emissions use `knowledge_candidate` with `payload.is_lesson=true`, `payload.proposed_action`, `payload.failure_kind`, optional `payload.kind="lesson"`, plus normal `claim/evidence/implications/applies_to/confidence_estimate` fields. View re-projection: update `substrate/views.ts` so `lesson_implementer_queue_view` and `lesson_implementation_status_view` select proposals from `lesson_extracted`, `contract_amendment_proposed`, and `knowledge_candidate WHERE payload.is_lesson=true`; `lesson_apply_candidate_view` inherits both via those views and must preserve `source_kind`. Workers: `runtime/experience_compression_worker.ts` reads `lesson_extracted OR knowledge_candidate(payload.is_lesson=true)` for successful-trajectory lessons and stale-lesson retirement; `runtime/closure_deliverable_check.ts` accepts `knowledge_candidate(payload.is_lesson=true, proposed_action)` wherever it currently accepts `lesson_extracted{proposed_action}`. Composer/closure text: prompt policy and roadmap closure predicates must say `lesson_extracted OR knowledge_candidate(payload.is_lesson=true, payload.proposed_action)`, not `lesson_extracted.proposed_action` alone. Emitters: update `substrate/extractors.ts` and any `runtime/*` deterministic lesson emitters to emit lesson-shaped `knowledge_candidate`; leave legacy `lesson_extracted` normalization in `runtime/events.ts` for historical rows only. NO new worker file; the existing readers handle both shapes.

Closure predicate: fixture emits one old `lesson_extracted` and one new lesson-shaped `knowledge_candidate`; all three lesson views project both, closure deliverable check passes for the new shape, experience compression consumes both, no new event kind/tool/worker/predicate appears.

Metric direction: new lesson-shaped `knowledge_candidate` emissions rise; deprecated `lesson_extracted` emissions trend to zero; merger pipeline absorbs both uniformly.

**Closure predicate (Tier 7).** All six contracts land with predicates met; owner opens Claude Code, talks normally, substrate captures intent, routes, dispatches, returns outflow. Zero new event kinds, MCP methods, worker files, or predicate enums introduced by Tier 7 itself.

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
