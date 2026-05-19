# AccInt — Architecture

**Thesis.** The substrate is the operator; LLMs are subroutines it calls. Every decision boundary that can be scored becomes a posterior-weighted row, every cited binding mutates that posterior on outcome, and intelligence compounds because the same residual-scored loop covers code, research, outreach, embodied work, and owner relationships. AccInt is ALIVE today (262K events, 1.5K artifacts, 305 promoted knowledge rows, 4K scored actions); the rate limiter is artifact-credit revival, not architecture (`SAF9AVJ8HD7W5DK847W72ETXHR`, `A4V81PN9E960S02MWSM4HSM5G4`, `6DZ417CCK57P90B7B2FTAV024M`).

One event ledger, one act primitive, one credit machinery, one retrieval surface, one merger pipeline. Inventories, migration history, long proofs, and test counts stay in substrate knowledge and roadmap contracts — not in the always-loaded architecture (`433DGRZ27547KESBFYR4FZ10WC`, `HW5CRSMF8S1NDF4HGT2E2PFKZM`).

## 1. Top Laws

Top laws are the substrate's posterior-scored operating truths; the live prompt surface compiles them from scored knowledge (`4EAFA894A8194C4CA74F08430C`, `6FDAD5FFB0954E3094D24808CE`). Live snapshot (state.db as of this revision): **262,325 events, 1,496 act_artifacts, 305 promoted knowledge, 2,197 act_tuple_recorded, 4,027 action_scored, 695 closure audits, 7,036 retrieval bindings, 20 artifact-score updates, 2 owner-observed outcomes** — the last two numbers diagnose why Tier 0 (artifact-credit revival) and Tier 1 (owner-outcome channel) are sequenced first in `docs/roadmap.md`.

- The substrate is the operator; brain and Claude are invoked tools (`5F21YF13Z13W5FNJ6DR2YJ04M0`).
- Cycle-1-only is structural; recursion is a new task edge, not in-context continuation (`206B19C06C2E461A8E8C3720C6`).
- Verifier residual in [0,1] is the universal score (`01EFDC6E614E46DBA1E9A5C73B`).
- Citation is mutation; honest binding is required for compounding (`YB2C2QCKC10BNBDVF22CX1Y5V8`).
- Self-extension occurs by admitting rows and crediting them through outcomes (`6DZ417CCK57P90B7B2FTAV024M`, `4VERR5ZBH57QQ0KC1ZD50TAAT0`).

## 2. Universal Workflow

One loop handles code, research, enterprise transformation work, outreach, embodied tasks, creative work, and decisions; only the action/verifier artifact changes (`5F21YF13Z13W5FNJ6DR2YJ04M0`).

```
owner words
  -> directive_opened / owner_input_received
  -> intent_classified
  -> dispatch_decided
  -> act_tuple_recorded
  -> action artifact observation
  -> verifier residual
  -> Shapley credit
  -> knowledge/artifact posterior update
  -> closure_audit
```

The loop is universal because residual is universal and breakdown axes are open vocabulary (`A24CCF6C2C2C4E85A91A529DFB`, `879407FA824B4B94A96CE7ADBC`).

## 3. Substrate Daemon

The daemon owns the append-only SQLite ledger, MCP surface, worker registry, external ingress, hot reload, restart drain, and health/readiness projections (`SAF9AVJ8HD7W5DK847W72ETXHR`). Fast hot paths stay embedded and local; heavy aggregate reads move to worker-thread contracts rather than network SQL (`A4V81PN9E960S02MWSM4HSM5G4`).

State is projected through views, not direct SQLite reads by agents (`D2624218B9C64BF29A2D203A2D`). Workers are always-on operators with opt-out controls, not strategic planners (`runtime.system_map`, `SAF9AVJ8HD7W5DK847W72ETXHR`).

## 4. The Act Primitive

Every action is an act tuple: intent, action_artifact_id, verifier_artifact_id, predicted_residual, reasoning/effect summaries, cited knowledge/artifacts, and affected resources (`A24CCF6C2C2C4E85A91A529DFB`). The substrate projects one envelope into action prediction, scoring, retrieval binding, candidate confirmation/contradiction, applied-change rows, owner-observed outcomes, and credit rows (`17WRSQT7015DFDPQN5SXGM25FG`).

The artifact-credit gap is the current rate limiter: 20 `act_artifact_score_updated` events against 4,027 scored actions (~0.5%), and 1,419 of 1,496 artifact rows (94.9%) still carry the legacy `kind=code_artifact` discriminator. Selected action/verifier artifacts must be auto-bound before frontier predicates can compound — this is contract `T0.2` in the roadmap (`SAF9AVJ8HD7W5DK847W72ETXHR`, `A4V81PN9E960S02MWSM4HSM5G4`, `4VERR5ZBH57QQ0KC1ZD50TAAT0`).

## 5. Runtimes & Sandboxes

Artifacts can target bun, uv, or camofox-browser; runtime is execution metadata, while artifact kind stays open vocabulary in the registry (`879407FA824B4B94A96CE7ADBC`). Sandbox declarations must state reads, writes, network, processes, env, CPU, wall, and memory budgets (`6FDAD5FFB0954E3094D24808CE`).

When nsjail or equivalent enforcement is absent, the runtime must emit warnings rather than pretending the sandbox is hard (`5EKBX6PTDS6XS1XAZXAZD0NMX4`). Opening runtime type vocabulary remains deferred until SandboxDecl and runner registry are redesigned (`A4V81PN9E960S02MWSM4HSM5G4`).

## 6. Brain Bridge & Depth-1 RLM

The brain is opencode gpt-5.5, pinned rather than scored as a model marketplace. The bridge denies filesystem-write tools and treats zero-substrate-frame success as `brain_silent_exit` prompt-compliance failure (`4EAFA894A8194C4CA74F08430C`, `SAF9AVJ8HD7W5DK847W72ETXHR`).

Depth-1 RLM means small invariant prompt metadata plus retrieval from substrate state; detailed emission grammars, examples, gates, and runbooks are substrate-level policy artifacts, named here but not re-explained (`433DGRZ27547KESBFYR4FZ10WC`, `S1PCZEFEDD4BS04RVPQF2JNBY8`). Cycle-1-only is enforced by dispatch and refinement edges (`206B19C06C2E461A8E8C3720C6`).

## 7. Knowledge Merger

Knowledge candidates from brain, Claude, owner-derived signals, and substrate automation enter one merger: semantic dedup, contradiction holding, synthesis, origin calibration, and Beta promotion (`FE8DF6H1KN1590MGP6JHFPTWYW`). Neither LLM canonizes knowledge by assertion (`A24CCF6C2C2C4E85A91A529DFB`).

The next frontier makes merger rules themselves scored artifacts, so dedup thresholds, synthesis thresholds, and corroboration weights earn posterior evidence by outcome (`D2NCDZ76RD11K3PEA4D5CCZRA8`).

## 8. Dispatch & Routing

Routes are open vocabulary: replay, Claude inline, opencode brain, owner clarification, or blocked/deferred; route axes are evidence-bearing strings, not enum limits (`5F21YF13Z13W5FNJ6DR2YJ04M0`). Fairness floors protect operator work from starvation when refinement branches are busy (`SAF9AVJ8HD7W5DK847W72ETXHR`).

Dispatch quality becomes a posterior boundary after Tier 0 trust and Tier 3 structural scorers close (`G3PR7X6TCD4T57D7T6GXCDY9AW`).

## 9. Credit, Retrieval, Owner, Closure

Credit distributes verifier outcomes across cited knowledge and artifacts; artifact auto-binding revives the selected action/verifier path (`17WRSQT7015DFDPQN5SXGM25FG`). Retrieval uses exposure bindings plus accepted/rejected use signals; the rejection emitter extends item-level and section-level credit (`AT2T17VAP159Z385DCM7GBTN4G`, `XZBAVD6YR53894C4TECXRC6440`).

Owner profile is open-ended evidence, not a persona enum; owner outcomes close non-technical loops (`B13YVJDAJD5E1928KG3Q97P7RW`). Closure audit is substrate truth and must refuse claims not supported by ledger rows (`SAF9AVJ8HD7W5DK847W72ETXHR`).

Owner alignment is the same posterior-scored loop as knowledge and artifacts. The five owner-alignment primitives — `owner_state_estimator_predicate`, `owner_state_transition_predicate`, `owner_forecast_predicate`, `renderer_predicate`, and `theory_of_mind_predicate` — are `act_artifact` rows calibrated by owner-observed outcomes through the shared Beta posterior, retrieval, merger, and credit machinery. The owner is another actor scored in the same substrate, not a persona enum. The current 2-row `owner_observed_outcome_recorded` count is the empirical reason owner alignment is Tier S0 in `docs/roadmap.md`; the design grounds in the 2026 alignment literature (VARS 2603.20939, PAHF 2602.16173, POPI 2510.17881, Adaptive Querying with AI Persona Priors 2605.00696, Causal Preference Learning 2506.05967, Theory of Mind LLM Agents 2509.22887, COPR 2402.14228, Adaptive Alignment MORL 2410.23630).

## 10. Universal Posterior Boundary

Every decision boundary that can be scored becomes a row with posterior evidence (`FE8DF6H1KN1590MGP6JHFPTWYW`). The eight moves are: 0 artifact-credit revival, 1 universal threshold registry, 2a section inclusion, 2b prompt-content and prose-rule variants, 3 supervisor predicates, 4 counterfactual credit, 5 meta-credit, and 6 binding-as-mutation (`4VERR5ZBH57QQ0KC1ZD50TAAT0`, `HW5CRSMF8S1NDF4HGT2E2PFKZM`, `V6M5EMAPQD2G32HNCDH3PAE0G8`). Each maps to a roadmap tier: T0.2 → move 0; T3.1 → move 1; T2.1-T2.4 → moves 2a/2b; T3.2-T3.7 → move 3; T4.1 → move 4; T4.2 → move 5; T0.3/T1.2 → move 6.

**Tier S frontiers land in this order** (rationale: each scorer depends on the previous one's signal being honest): **S2** causal-edge posterior, then **S4** merger-rule predicates, then **S5** goal-shape extraction strategy, then **S3** trajectory-motif extractor, then **S1** DAG decomposition strategy. Edges first because every later scorer cites them; merger second because knowledge quality gates every later posterior; goal-shape third because class-local thresholds need reliable classes; motifs fourth because they need both edges and goal-shape semantics; decomposition last because fair scoring needs all prior signals (`G3PR7X6TCD4T57D7T6GXCDY9AW`, `3F2FK5J04144D9MCRKDXHH5CA8`, `D2NCDZ76RD11K3PEA4D5CCZRA8`, `3517MGZAEH6856BRDSCT1HXJM8`, `NWZSMV8F5N33N6FG4XKW9ZDHEC`, `MQQCK9FQ452H1FYA4H72Z9RJPR`). Contracts live in `docs/roadmap.md` §Tier 3 (T3.2 → T3.3 → T3.4 → T3.5 → T3.6).

**Pedagogical RL** moves fold into the same universal posterior list: `composer_policy_predicate`, `pedagogical_reward_predicate`, `citation_spike_auditor`, and `surprisal_gate_predicate`. `composer_policy_predicate` is the deepest move because it routes closure-audit and owner-outcome evidence into future prompt composition, making the substrate's depth-1 RLM pedagogically self-guided rather than fixed. Source: <https://noahziems.com/pedagogical-rl> (LADDER 2503.00735, Gödel Agent 2410.04444, ICLR 2026 RSI Workshop). Contract is `T3.7` in the roadmap.

**Load-bearing security carve-out.** `surface_existence_predicate` and every other posterior boundary explicitly excludes load-bearing security/schema gates: admin_token, deny-lists, owner_gate `things_to_never_do`, foreign keys, NOT NULL, single-writer SQLite. These earn keep-decisions by **absence-of-violation evidence**, not by usage-frequency posterior — a low-call-rate gate is exactly as load-bearing as a high-call-rate one, and the moment it is needed defines its value (`HBQ8FM8HED2AX2R7EDCVY15R8W`, `RPB5W9PRPS6S3EPTYAE33JD4MW`, `5EKBX6PTDS6XS1XAZXAZD0NMX4`).

## 11. Failure Modes

The repair pattern is observability event, tightened deny or verifier rule, then closed alarm. The bridge already classifies silent exits; the deny-list closed source-checkout mutation risk after the observed bypass (`4EAFA894A8194C4CA74F08430C`, `SAF9AVJ8HD7W5DK847W72ETXHR`).

Failure counts belong in `failure_view`; this file keeps only the invariant pattern (`D2624218B9C64BF29A2D203A2D`).

## 12. Open Frontier

PARTIAL items are contracts, not prose promises. Each cluster maps to a roadmap tier:

- **Owner alignment (Tier S0)** — five owner-alignment predicates (`owner_state_estimator_predicate`, `owner_state_transition_predicate`, `owner_forecast_predicate`, `renderer_predicate`, `theory_of_mind_predicate`); reason: 2 owner-observed outcomes is too sparse to calibrate other posteriors (`VVD2T4QAAH19`).
- **Trust gaps (Tier 0)** — closure-audit ledger truth (T0.1), artifact auto-binding (T0.2), knowledge-binding enforcement (T0.3), artifact-kind backfill (T0.4) (`SAF9AVJ8HD7W5DK847W72ETXHR`, `4VERR5ZBH57QQ0KC1ZD50TAAT0`, `SDP3E1V50973X1AZ4V2FSERCEC`).
- **Outcome channels (Tier 1)** — owner outcome (T1.1), retrieval rejection (T1.2), cross-candidate corroboration (T1.3) (`AT2T17VAP159Z385DCM7GBTN4G`, `XZBAVD6YR53894C4TECXRC6440`).
- **RLM-efficiency at the substrate (Tier 2)** — on-demand policy bundles (T2.1), prompt content variants (T2.2), prose-rule variants (T2.3), section retrieval credit (T2.4), surface-existence scoring (T2.5) (`433DGRZ27547KESBFYR4FZ10WC`, `HW5CRSMF8S1NDF4HGT2E2PFKZM`, `V6M5EMAPQD2G32HNCDH3PAE0G8`, `HBQ8FM8HED2AX2R7EDCVY15R8W`).
- **Structural posterior boundaries (Tier 3)** — threshold registry (T3.1), Tier S S2→S4→S5→S3→S1 (T3.2-T3.6), pedagogical RL (T3.7).
- **Meta-credit (Tier 4)** — counterfactual credit (T4.1), meta-credit formula (T4.2), brain prediction-accuracy posterior (T4.3), coalition posterior (T4.4).
- **Operations (Tier 5)** — sandbox parity, freeze-state, token rotation, backup/export cadence, migration sweep, SQL worker-thread pool (`A4V81PN9E960S02MWSM4HSM5G4`).

Security and schema surfaces have a carve-out (also enforced in §10): admin_token, deny-lists, owner_gate `things_to_never_do`, foreign keys, NOT NULL, and single-writer SQLite earn keep-decisions by absence of violation, not by usage-frequency posterior (`HBQ8FM8HED2AX2R7EDCVY15R8W`, `RPB5W9PRPS6S3EPTYAE33JD4MW`, `5EKBX6PTDS6XS1XAZXAZD0NMX4`).

## 13. Operating Contract

`CLAUDE.md` is the live operator contract; `.claude/rules/orchestrator-runtime.md` holds recovery and runtime operating procedures (`D2624218B9C64BF29A2D203A2D`). This document states what the organism is; those files state what the orchestrator must do (`A24CCF6C2C2C4E85A91A529DFB`).

## 14. Universal Intent

AccInt is alive when every goal enters one residual-scored loop, selected artifacts and cited knowledge receive honest credit, failures tighten the substrate, and open-vocabulary rows replace hardcoded boundaries.

**Verdict: ALIVE, not done.** Live ledger: 262,325 events, 1,496 act_artifacts (94.9% still legacy-kind), 305 promoted knowledge, 4,027 scored actions, 2,197 act tuples, 695 closure audits, 7,036 retrieval bindings — and only 20 artifact-score updates plus 2 owner-observed outcomes. The numbers themselves diagnose the next moves: **artifact-credit revival (T0.2) unlocks compounding**, the **owner-outcome channel (T1.1) calibrates non-code goals**, and **Tier S (S2→S4→S5→S3→S1) follows only after trust gaps close** (`SAF9AVJ8HD7W5DK847W72ETXHR`, `A4V81PN9E960S02MWSM4HSM5G4`, `6DZ417CCK57P90B7B2FTAV024M`, `G3PR7X6TCD4T57D7T6GXCDY9AW`). The roadmap (`docs/roadmap.md`) is the executable plan.
