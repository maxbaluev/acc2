# AccInt — Roadmap

The roadmap is ordered by structural leverage and dependency. Tier 0 makes posterior evidence trustworthy; later tiers make more boundaries posterior-scored and reusable (`SAF9AVJ8HD7W5DK847W72ETXHR`, `6DZ417CCK57P90B7B2FTAV024M`, `FE8DF6H1KN1590MGP6JHFPTWYW`).

Each entry names the problem, contract shape, tier rationale, and metric direction. Detailed proofs stay in substrate events and knowledge, not this file (`433DGRZ27547KESBFYR4FZ10WC`).

## Tier S0 — OWNER ALIGNMENT

Owner truth calibrates every other posterior; owner-observed outcomes are currently sparse relative to candidate confirmations, so the five `owner_*_predicate` primitives — `owner_state_estimator_predicate`, `owner_state_transition_predicate`, `owner_forecast_predicate`, `renderer_predicate`, and `theory_of_mind_predicate` — are prioritized before structural posterior boundaries. Each is an `act_artifact` row scored by owner-observed outcomes through the shared Beta posterior, retrieval, merger, and credit machinery; `owner_forecast_predicate` answers the missing-forecast question (`VVD2T4QAAH19`).

## Tier 0 — TRUST

### T0.1 — Closure-audit substrate-truth gate

Problem: closure can claim row-level delivery without ledger-backed amendments, so later posteriors can trust a false success (`SAF9AVJ8HD7W5DK847W72ETXHR`).

Contract: `runtime/closure_audit.ts` must query the ledger for declared target files and refuse low residual when matching deliverable events are absent; closure predicate is `declared_targets_have_events OR no_declared_targets` (`SAF9AVJ8HD7W5DK847W72ETXHR`).

Why this tier: all subsequent contracts depend on honest closure evidence (`YB2C2QCKC10BNBDVF22CX1Y5V8`).

Metric direction: refused false closures rise first, then closure residual distribution becomes more honest (`SAF9AVJ8HD7W5DK847W72ETXHR`).

### T0.2 — Artifact auto-binding and credit revival

Problem: artifact promotion is dormant; live evidence reports 0 promoted/quarantined artifacts, 20 artifact-score updates vs 3980 scored actions, only 18 acts citing artifacts, and 95% legacy artifact kinds (`SAF9AVJ8HD7W5DK847W72ETXHR`, `A4V81PN9E960S02MWSM4HSM5G4`).

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

Pedagogical RL primitives are scored boundaries that route closure-audit and owner-outcome evidence back into composition. Order by leverage: `composer_policy_predicate` first (subsumes prior section-credit work by making the prompt composer pedagogically self-guided through closure and owner-outcome evidence), then `pedagogical_reward_predicate`, `citation_spike_auditor`, and `surprisal_gate_predicate`. Each lands as an `act_artifact` row with closure predicate "posterior movement tied to closure/owner outcomes."

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

Sandbox parity, freeze-state, token rotation, backup/export cadence, migration sweep, worker-thread pool for heavy aggregates, and runtime-runner registry land here because they improve operational universality after the trust and posterior boundaries are in place (`A4V81PN9E960S02MWSM4HSM5G4`, `HBQ8FM8HED2AX2R7EDCVY15R8W`).

Worker-thread pool contract: keep embedded SQLite for microsecond hot paths and offload known heavy aggregate reads only; closure predicate is event-loop freed during heavy queries while writes remain serialized (`A4V81PN9E960S02MWSM4HSM5G4`).

## Rejected Alternatives

### rqlite

Rejected because HTTP roundtrips are the wrong tradeoff for AccInt's embedded SQLite hot path; the heavy-query problem is solved by a worker-thread pool, not a network database layer (`A4V81PN9E960S02MWSM4HSM5G4`).

### Opening runtime type to string as a one-line change

Deferred because SandboxDecl and runner dispatch are structurally coupled to runtime-specific declarations; the correct contract is a runner registry plus SandboxDecl redesign (`A4V81PN9E960S02MWSM4HSM5G4`).

### Multiple-brain operation

Rejected: the organism uses opencode gpt-5.5 as the brain; adding alternate model arbitration would add routing complexity before the artifact-credit, binding, and closure-truth gaps are closed (`SAF9AVJ8HD7W5DK847W72ETXHR`, `6DZ417CCK57P90B7B2FTAV024M`).

## Cross-cutting Principles

- Open vocabulary at boundaries; new strings appear as rows and events, not closed enums (`HBQ8FM8HED2AX2R7EDCVY15R8W`).
- Security and schema gates are protected by absence-of-violation evidence, not usage-frequency posterior (`RPB5W9PRPS6S3EPTYAE33JD4MW`).
- Every contract must cite live substrate evidence and define a closure predicate (`SAF9AVJ8HD7W5DK847W72ETXHR`).
- Brain proposes; substrate and orchestrator apply through ledger-visible gates (`4EAFA894A8194C4CA74F08430C`).
- Docs stay small; detailed inventories and historical proofs stay retrievable (`433DGRZ27547KESBFYR4FZ10WC`).

## Live Metrics To Watch

| Area | Metric | Expected direction |
|---|---|---|
| T0.1 | false-closure refusals | Up first, then stable |
| T0.2 | `act_artifact_score_updated` / `action_scored` | Up sharply |
| T0.3 | stripped decorative citations | Up first, then down |
| T0.4 | legacy artifact-kind share | Down |
| T1.1 | owner outcome events | Up |
| T1.2 | retrieval rejections | Up proportional to unused exposure |
| T1.3 | promoted knowledge with bounded contradictions | Up |
| T2 | prompt tokens per successful dispatch | Down without residual rise |
| T3 | boundary predicate rows with moving posteriors | Up |
| T4 | selector and credit calibration error | Down |
| T5 | health latency under heavy aggregate load | Down |

Final state: every reusable boundary is a scored row, every credit path closes, protected security gates stay protected, and the substrate compounds across code, work, research, relationships, and embodied goals through the same residual-scored loop (`5F21YF13Z13W5FNJ6DR2YJ04M0`, `YB2C2QCKC10BNBDVF22CX1Y5V8`, `HBQ8FM8HED2AX2R7EDCVY15R8W`).
