# AccInt — Architecture

**Thesis.** The substrate is the operator; LLMs are subroutines it calls. Every decision boundary that can be scored becomes a posterior-weighted row, every cited binding mutates that posterior on outcome, and intelligence compounds because the same residual-scored loop covers code, research, outreach, embodied work, and owner relationships. AccInt is ALIVE today (262K events, 1.5K artifacts, 305 promoted knowledge rows, 4K scored actions); the rate limiter is artifact-credit revival, not architecture (`SAF9AVJ8HD7W5DK847W72ETXHR`, `A4V81PN9E960S02MWSM4HSM5G4`, `6DZ417CCK57P90B7B2FTAV024M`).

One event ledger, one act primitive, one credit machinery, one retrieval surface, one merger pipeline. Inventories, migration history, long proofs, and test counts stay in substrate knowledge and roadmap contracts — not in the always-loaded architecture (`433DGRZ27547KESBFYR4FZ10WC`, `HW5CRSMF8S1NDF4HGT2E2PFKZM`).

## 1. Top Laws

Top laws are the substrate's posterior-scored operating truths; the live prompt surface compiles them from scored knowledge (`4EAFA894A8194C4CA74F08430C`, `6FDAD5FFB0954E3094D24808CE`). Point-in-time ledger snapshots belong in generated state_snapshot_recorded/state_snapshot_diffed evidence, not durable architecture prose; the invariant is that artifact-credit and owner-outcome metrics diagnose why Tier 0 (artifact-credit revival) and Tier 1 (owner-outcome channel) are sequenced first in `docs/roadmap.md`.

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

The daemon owns the hot SQLite ledger and its retention/archival policy, MCP surface, worker registry, external ingress, hot reload, restart drain, and health/readiness projections (`SAF9AVJ8HD7W5DK847W72ETXHR`). The ledger is append-only inside each retention class, but the hot store is bounded: high-volume telemetry may be rolled up or evicted according to a per-kind retention taxonomy, while knowledge, task, action, owner, and amendment rows retain audit-grade provenance. Fast hot paths stay embedded and local; heavy aggregate reads move to worker-thread contracts rather than network SQL (`A4V81PN9E960S02MWSM4HSM5G4`).

Longevity contract: production state is a bounded hot SQLite ledger plus cold sibling archive databases. Events older than the hot-retention window (default target: 30 days unless operations evidence changes it) are moved into monthly `state-archive-YYYY-MM.db` files with provenance and integrity evidence; default views and liveness queries hit only the hot ledger, while explicit history/search paths can join hot + cold archives transparently. High-volume event rollups, per-kind emit budgets, and deferred-row suppression are slope controls, but bounded hot retention is the structural guarantee that multi-year SQLite operation does not turn every aggregate into an all-history scan.

Fast hot paths stay embedded and local; heavy aggregate reads move to worker-thread contracts rather than network SQL (`A4V81PN9E960S02MWSM4HSM5G4`).

State is projected through views, not direct SQLite reads by agents (`D2624218B9C64BF29A2D203A2D`). Workers are always-on operators with opt-out controls, not strategic planners (`runtime.system_map`, `SAF9AVJ8HD7W5DK847W72ETXHR`).

Task world models are first-class projections, not a second state ledger. The current storage contract reuses `state_snapshot_recorded` for latest model snapshots and `state_snapshot_diffed` for model deltas; `world_model_view` projects goal state, environment, reader, medium, reality evidence, convergence, and latest delta for task-scoped readers.

## 4. The Act Primitive

Every action is an act tuple: intent, action_artifact_id, verifier_artifact_id, predicted_residual, reasoning/effect summaries, cited knowledge/artifacts, and affected resources (`A24CCF6C2C2C4E85A91A529DFB`). The substrate projects one envelope into action prediction, scoring, retrieval binding, candidate confirmation/contradiction, applied-change rows, owner-observed outcomes, and credit rows (`17WRSQT7015DFDPQN5SXGM25FG`).

The artifact-credit gap is the current rate limiter: 20 `act_artifact_score_updated` events against 4,027 scored actions (~0.5%), and 1,419 of 1,496 artifact rows (94.9%) still carry the legacy `kind=code_artifact` discriminator. Selected action/verifier artifacts must be auto-bound before frontier predicates can compound — this is contract `T0.2` in the roadmap (`SAF9AVJ8HD7W5DK847W72ETXHR`, `A4V81PN9E960S02MWSM4HSM5G4`, `4VERR5ZBH57QQ0KC1ZD50TAAT0`).

## 5. Runtimes & Sandboxes

Artifacts can target bun, uv, or camofox-browser; runtime is execution metadata, while artifact kind stays open vocabulary in the registry (`879407FA824B4B94A96CE7ADBC`). Sandbox declarations must state reads, writes, network, processes, env, CPU, wall, and memory budgets (`6FDAD5FFB0954E3094D24808CE`).

ResourceUri scheme vocabulary is open like `act_artifact.kind`. Repository paths (`repo:`), URLs (`url:`), inflow/outflow artifacts (`inflow:`, `outflow:`), runtime artifacts (`runtime:<runtime-name>:<artifact_id>`), and external MCP sources (`external:<mcp-server-name>:<resource_id>`) all coexist without enum closure. Any MCP server the owner registers in Claude Code's `~/.claude.json` automatically becomes reachable as a new `external:<server-name>:` scheme without substrate code change; the substrate discovers servers through the existing MCP registry and routes reads through `substrate.read` view-name projections that the brain calls from its opencode shell.

When nsjail or equivalent enforcement is absent, the runtime must emit warnings rather than pretending the sandbox is hard (`5EKBX6PTDS6XS1XAZXAZD0NMX4`). Opening runtime type vocabulary remains deferred until SandboxDecl and runner registry are redesigned (`A4V81PN9E960S02MWSM4HSM5G4`).

**Multi-runtime code creation is one substrate primitive.** The brain proposes executable handles as `act_artifact` rows with open `kind` and runtime declaration: `python_script_v1` payload carries `{code, runtime:"uv", sandbox, inputs_schema, outputs_schema, verifier_artifact_id}`; `bun_script_v1` is analogous for bun; `browser_flow_v1` is analogous for camofox steps; `telegram_action_v1` and `gdrive_action_v1` are analogous for external MCP runtimes; `claude_inline_edit_v1` carries an `anchored_replace_v1` diff for Claude apply. The substrate admits through existing `substrate.admit_artifact` (no new MCP method). The runtime executor reads the row, runs it under the declared sandbox, emits `artifact_invoked` + `artifact_observed` with output evidence. The verifier returns `action_scored` with open `verifier_kind`, residual, breakdown, and reliability profile. Credit flows through existing `runtime/credit.ts`: `retrieval_credit_attributed` for cited knowledge that inspired the script, `act_artifact_score_updated` for the artifact's posterior, and `candidate_confirmed`/`candidate_contradicted` for predicted-vs-observed claims. This closes the act four-tuple uniformly across code and non-code domains; the empirical proof is the live cross-domain workload at directive `MPF9FF644502D7V8DW5ZJ6TPH0` (Telegram + Google Drive auto-ingest) flowing through identical primitives as code dispatches.

**ResourceUri routing must not assume repo-file shape.** The universality bottleneck identified by knowledge entries `BC7H26S5NS7S`, `NJR1JP2ZC52Z`, and `WT9M8BW95X0F` is provenance/routing assuming `repo:path/to/file` everywhere. The parser must accept additional schemes: `runtime:python:<artifact_id>`, `runtime:bun:<artifact_id>`, `runtime:browser:<artifact_id>`, `external:telegram:<chat_id>:<msg_id>`, `external:gdrive:<doc_id>`, `inflow:<artifact_id>`, and `outflow:<task_id>:<ext>` — same parser, more schemes; no enum closure; `contract_amendment_proposed.target_resource` accepts any URI scheme so non-code domains are first-class. Code creation is recursive in the RLM sense: a bun script that succeeded yesterday becomes a cited artifact today, not a re-derived plan; external scored state replaces deeper deliberation.

## 6. Brain Bridge & Depth-1 RLM

The brain is opencode gpt-5.5, pinned rather than scored as a model marketplace. The bridge denies filesystem-write tools and treats zero-substrate-frame success as `brain_silent_exit` prompt-compliance failure (`4EAFA894A8194C4CA74F08430C`, `SAF9AVJ8HD7W5DK847W72ETXHR`).

Depth-1 RLM means small invariant prompt metadata plus retrieval from substrate state; detailed emission grammars, examples, gates, and runbooks are substrate-level policy artifacts, named here but not re-explained (`433DGRZ27547KESBFYR4FZ10WC`, `S1PCZEFEDD4BS04RVPQF2JNBY8`). Cycle-1-only is enforced by dispatch and refinement edges (`206B19C06C2E461A8E8C3720C6`).

**Depth-1 retrieval is load-bearing.** Xu et al. on Retrieval in Long-context Language Models (arXiv:2512.24601) shows a growing intelligence cannot pour accumulated state into one prompt and expect the model to find the right needle. AccInt therefore keeps the model at depth one and makes the substrate choose what enters each cycle through top-K posterior-ranked retrieval. The task world model is the projected, updateable goal/environment object for a task: event ledger facts, promoted knowledge, `act_artifact` handles, owner profile, reader and delivery medium, trajectory motifs, causal edges, decomposition strategy, resource claims, reality evidence, and convergence state. Progress is a verified model delta, and closure means the model's goal predicates are satisfied against reality surfaces such as git, tests, rendered artifacts, publication evidence, or owner outcomes. Residual remains the scalar verifier summary, but it cannot replace the model or justify summary-only closure. Continuity is not memory inside Claude or the brain; it is later cycles reading scored external state.

**Composer trimming is load-bearing.** Live evidence shows `brain_prompt_composed` events with `chars_original=46699, truncated=true` — knowledge entry `WETXPFZZAN2X` already named the tension: the composer over-injects workflow grammar and emission tutorials instead of producing the minimal substrate projection the depth-1 contract requires. The remediation lives in `docs/roadmap.md` Tier 7 (composer trimming): keep evidence sections (directive, retrieved knowledge ranked by score×confidence, owner profile, active failures, pending proposals, top laws); keep minimal emission grammar for opencode brain per knowledge entry `38GYZ26QYX1N` (GPT-5.5 needs explicit MCP/ledger grammar to avoid silent exits); delete workflow tutoring, vocabulary tutorials, MCP tool catalogs (already advertised by opencode), and example scaffolding; compact section markers and headers. Typical dispatch projects to ~8000-9000 chars; cross-domain dispatches with broad retrieval cap at 11000; the 12000-char gate becomes real, not aspirational.

**Brain content observability via extended `substrate.read`.** The brain runs in its opencode background_job shell and must observe whole-system content — raw event payloads, artifact bodies, inflow file contents, owner transcript spans, cross-directive proposal clusters — through the EXISTING `substrate.read` MCP method with extended `view_name` arguments, NOT new MCP vocabulary. New `view_name` values to project from existing events: `event_payload_view` (raw `events.payload` JSON for given ids), `act_artifact_body_view` (project `act_artifact.payload` + `kind` + runtime declaration), `inflow_artifact_view` (resolves `act_artifact(kind="ingested_file")` to bytes/text with source hash), `owner_conversation_window_view` (owner_input_received + directives within time range), `proposal_cluster_view` (joins amendments/lessons/applied-changes by `payload.diff_cluster_id`), `outflow_artifact_view` (resolves `~/.accint/outflow/<task_id>.<ext>` paths). All views are projections over existing event rows; zero new MCP methods.

## 7. Knowledge Merger

Knowledge candidates from brain, Claude, owner-derived signals, and substrate automation enter one merger: semantic dedup, contradiction holding, synthesis, origin calibration, and Beta promotion (`FE8DF6H1KN1590MGP6JHFPTWYW`). Neither LLM canonizes knowledge by assertion (`A24CCF6C2C2C4E85A91A529DFB`).

The next frontier makes merger rules themselves scored artifacts, so dedup thresholds, synthesis thresholds, and corroboration weights earn posterior evidence by outcome (`D2NCDZ76RD11K3PEA4D5CCZRA8`).

## 8. Dispatch & Routing

Routes are open vocabulary: replay, Claude inline, opencode brain, owner clarification, blocked, deferred, paced, or serialized; route axes are evidence-bearing strings, not enum limits (`5F21YF13Z13W5FNJ6DR2YJ04M0`). Fairness floors protect operator work from starvation when refinement branches are busy (`SAF9AVJ8HD7W5DK847W72ETXHR`).

Execution shape is not a rate-limit subsystem. Every act declares the resources and constraints it engages as open ResourceUri/act_artifact rows: shared external handles, repository files, browser profiles, accounts, physical devices, temporal/ordering constraints, owner-consent class, and reversibility. The existing interference graph is the single scheduler primitive: conflicting resource/constraint rows serialize or defer; independent rows parallelize; owner-gated rows wait for consent; temporal rows pace by their declared window. The same rule prevents two agents editing one file, two browser flows sharing one profile, too many outreach actions against one account, and embodied tasks running out of order.

Execution constraints learn through the normal residual-posterior path. A ban, corrupted file, clobbered edit, unsafe physical outcome, or owner-stated "too fast/too much" is a high-residual outcome credited to the engaged resource-class constraint artifact, tightening future admission for that class. Clean outcomes loosen by the same Beta update. No platform enums, no hardcoded rate tables, and no parallel limiter: new surfaces are ordinary `act_artifact.kind` rows plus payload fields on `action_predicted`/`act_tuple_recorded`, read by the existing scheduler/interference path.

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

## 15. Recursion Stop Floor (Two Epistemic Regimes)

AccInt has two epistemic regimes. Scoreable assumptions become predicate rows whose residuals improve routing, credit, and retrieval. Floor assumptions are different: they are established by absence-of-violation evidence because the substrate cannot use a possibly compromised substrate to recursively prove them (`2XXFM1SPZX5XHFN31RWSR69TN4`, `PY1WBY1RF12RSBCQEQKBHDFH8R`).

The five floor predicates are `event_authenticity_predicate`, `storage_integrity_predicate`, `kernel_sandbox_integrity_predicate`, `deterministic_computation_sanity_predicate`, and `owner_identity_continuity_predicate`. Their contract is not higher posterior from frequent use; it is immediate quarantine on violation plus continuous absence-of-violation checks.

The graceful set remains scoreable: causality, economics, provenance, retrieval binding, epistemic convergence, language grounding, continuity, and time. This dispatch surfaced the full assumption ledger as predicate signatures (`WF1JWSVCV908NDNPYR35WX1B0G`, `PZ0A37EG4H5A7AK5A1ZC31AFRC`, `9SYBW09P5D22VERW9ZD4VNJB74`, `63R4HGE6R51953Q8MCZDV00GGC`, `3PE66T6YHH1W10S3JR1PMHN7GM`, `N8Z83PT9VS2VZ3PCHN3MDA4XHW`, `Q893DFQK0X6MF3BZ153NJZ3KA0`, `FQWQQSS4F1341CXF4AH0NB0W70`, `0QQ1SY4FDX7ZV45CGPXACGS3MG`, `JV56YRF4SH4YSBZ102BXCZVVT8`, `05YEB51TA91376PE273B62KGF0`, `YQQZBASDHD693C56KGWYH6S8BM`, `BC0XEFQ6W92ZZBVRJNRDX4ET08`, `M1GB6W46V576B5165EZ5TAZPAM`, `XHKNFE83914ES4SW1FRW82ZFKW`, `KSEEXD1PKN2GFF7TBCVCWG728W`, `2D0J7KSV9N7DH86BBASWHVZ62M`, `11HQGPNDVS6TB4D3Y4A7KVSRVG`, `CF30S9MAWN2FF62H9W99AA3H50`, `NSSPCF3XKD6750NX3HW45QW40M`, `NGAPYB5QHH50K4XHCPBKQJRXP8`, `AG9PZRDRP57RQEZDPQAE8EQ5Y4`, `PSZTCA96497YSB68CE4VM1H7MW`, `R2NV90BZV95CF267BBDJPNT5RW`, `QFRHFNFZG11P14A9NWPTDVA5MG`).

Interaction triage matrix (`TNMTQAZS3D7T3AD78GAA2TKTSG`):

```
Floor                         | Scoreable assumptions invalidated or compounded
------------------------------|------------------------------------------------
event_authenticity            | causal_edge, intervention_effect, credit_assignment, retrieval_binding, epistemic_convergence, contradiction_resolution, ledger_time, goal_continuity
storage_integrity             | source_provenance, retrieval_binding, epistemic_convergence, calibration_transfer, semantic_anchor, ledger_time, review_cadence, cost_model
kernel_sandbox_integrity      | intervention_effect, cost_model, artifact_reuse, marginal_information, artifact_observation, source_provenance, uncertainty_expression
deterministic_computation     | action_residuals, credit_assignment, cost_model, counterfactual_comparison, epistemic_convergence, uncertainty_expression, calibration_transfer
owner_identity_continuity     | owner_term_alignment, goal_continuity, language_grounding, opportunity_cost, review_cadence, owner_outcome_calibration
```

Boot order is substrate-of-itself dependency order, not a metaphysical claim: host/hardware sanity must return stable bytes; storage integrity must preserve ledger state; kernel/sandbox integrity must enforce runtime observations; deterministic computation sanity must make residuals repeatable; owner identity continuity must bind goals to the right authority (`29PYKT08KN7SH4AXEVMNEJAE0R`). A disk returning stale pages, a compromised kernel, nondeterministic verifier arithmetic, or spoofed owner input each invalidates a different downstream layer.

## 16. Distribution & Upgrade Architecture

Per brain dispatch `VJDMME8JD961SE6F` amendment `4AV2NPJW2H1HV0XQ3MR2ZV78KC` (KCs `R6BS0FP17S6375` + `ZM4HZPQFMS2D7E`, commit `ed1a676`), the substrate ships as a release while every installation is a living organism. Three normative boundaries close the distribution-readiness gap:

**Portable-wisdom boundary (separate canonical.db).** Each release ships a versioned `canonical.db` containing only release-owned or explicitly portable organism wisdom: seed rows from `substrate/seed.ts`; substrate primitive, predicate, threshold, prompt-bundle, verifier, recipe, and plugin-package `act_artifact` rows; `artifact_kind_metadata`; and promoted knowledge whose payload declares `portable: true` or whose source candidate declares `judgment_packet: true` and passes the export allow-list. The organism's `state.db` remains local-only and contains the full event ledger, owner profile, owner input and decisions, private corpus artifacts, local/federated knowledge, local posterior evidence, aliases emitted by the organism, and portability metadata. Runtime read paths join both with explicit precedence: local organism evidence can cite, shadow, or override canonical rows without mutating the canonical baseline. Catastrophic forgetting is structurally impossible: updates touch `canonical.db` only.

**Non-export boundary.** Export is deny-by-default. A row never ships when any event in its provenance chain carries `payload.do_not_export=true`, `payload.sensitivity` in `['private','owner_private','do_not_export']`, an external/private raw-data kind such as `telegram_chat_dump`, `google_drive_doc_dump`, or `google_drive_doc_comments`, an owner-local kind such as `owner_input_received`, `owner_decision_recorded`, `owner_observed_outcome_recorded`, `owner_profile_recorded`, `owner_insight_candidate`, `rendered_owner_message_recorded`, or free-text owner/corpus fields including `payload.text`, `payload.directive_text`, `payload.owner_profile`, `payload.full_text`, `payload.body` from private inflow. `do_not_export` is an enforced export-time hard gate, not advisory metadata.

**Canonical packaging choice.** `canonical.db` lives in the package at `substrate/canonical.db` and is built at release-cut time by `acc admin export-canonical <path> --yes` from the current organism through the portable-wisdom allow-list above. The command preserves posterior_alpha, posterior_beta, score, confidence, status, and stable ids for portable `act_artifact`, recipe, prompt-bundle, and promoted-knowledge rows, while stripping directive_id, task_id, owner text, raw evidence ids, embeddings, and provenance rows that would identify the source owner. It is checked into the release artifact as read-only release state. It is not fetched at init/upgrade time and is not regenerated locally at daemon boot; those alternatives either add distribution/network trust to first-run setup or let local derivation drift from the release checksum.

**Runtime join choice.** The daemon attaches the packaged database with SQLite `ATTACH DATABASE ... AS canonical` in read-only mode at boot or upgrade preflight. Runtime reads of canonicalized registries use a single attached-connection query shape that unions `canonical.act_artifact` with `main.act_artifact`, with `main`/organism rows taking precedence on id conflict. Callers should not branch between local and canonical stores; the join boundary stays in the substrate data-access layer.

**Existing-organism migration choice.** Existing `state.db` seed rows are not moved or deleted. If an organism already has predicate, recipe, promoted-knowledge, or seed artifact rows in `state.db`, those rows shadow same-id canonical rows at runtime and keep their posterior credit chains, event references, and aliases intact. Fresh installs start with packaged canonical rows plus an empty local ledger. Future migrations may add aliases for renamed canonical handles, but Phase 2 dedupe is a read-precedence rule rather than a mutating reconciliation pass.

**Predicate/artifact aliasing (`act_artifact_aliased` event).** Renames are first-class. When a release renames `owner_state_estimator_predicate` to `continual_owner_state_predicate`, the migration emits `act_artifact_aliased {old_id, new_id, reason, release_version?}`. Alias chains are append-only, cycle-refused, and credit resolution updates the current id when prior `action_scored` events cite the old id. The organism's accumulated posterior survives the rename. No predicate-specific evolution enum: generic `act_artifact_aliased` covers every renamed handle in the open vocabulary.

**Update mechanism (`acc update` CLI).** Updates are deterministic, not brain-mediated mutation. `acc update` (1) fetches the release; (2) verifies signatures and checksums; (3) attaches the packaged `canonical.db`; (4) runs a local preflight against the organism's actual state (load new modules in sandbox, run module-exposed `selfTest(db)` checks); (5) applies registered schema migrations to `state.db` only; (6) resolves `act_artifact_aliased` chains for renamed handles; (7) smoke-tests workers and verifiers; (8) hot-reloads when the survival gate (`XA3ABKERHD4H`, commit `2915d2d`) passes; (9) restarts the daemon only when required by hot-swap classification. `brain_invocation_request` (commit `fcfecbe`) may be reused for evaluation or owner-control checks during upgrade, but the primary mechanism is deterministic. (Current `cli/update.ts` implements the deterministic core — git pull, schema migrations, daemon restart, health gate, and source rollback on failure; the signature/checksum verification, `canonical.db` attach, sandbox preflight, and survival-gated hot-reload are the designed target surface.)

A `substrate/migrations/` registry is the ONLY path for `state.db` schema changes. Migrations are idempotent, ledger-audited (each application emits `schema_migration_applied {version, ts, success}`), and tested against representative organism snapshots before release. Schema changes outside this registry are a substrate violation.

Owner-state portability is a CLI capability layered on this boundary: `acc admin export` / `acc admin import` export/import the organism's `state.db` plus ledger artifacts, never `canonical.db`. The mnemonic-sovereignty curation set (`always_keep` kinds — owner-channel, knowledge-graph backbone, Tier -1 violations, constitutional events) is the minimum portable surface.

### 16.1 Release transport abstraction & reserved P2P seam (DISTREL_P2)

`acc update` does not hard-code git as the only way a release arrives. The transport is the `ReleaseSource` discriminated union (`runtime/release_source.ts`, pure types — no network code):

- `{ kind: "git" }` — the CURRENT path: clone/pull a release ref.
- `{ kind: "ipfs_cid"; cid; gateway? }` — the NEW fetch-by-CID path: `acc update` retrieves the release bundle by content id through an HTTP gateway. **Pinata is the pin + metadata + discovery provider now**: it pins the bundle/manifest and serves the gateway, so a CID published via Pinata is the practical `ipfs_cid` source today.
- `{ kind: "pubsub_announcement"; announcement_event_id }` — the **RESERVED, NOT-IMPLEMENTED** future P2P path: a `release_announced` event id that a future pub/sub layer will resolve to a `bundle_cid`.

`parseReleaseSource(spec)` maps a CLI `--from <spec>` string (`"git"`, `"ipfs:<cid>[@<gateway>]"`, `"pubsub:<event_id>"`) to the union. `git` and `ipfs_cid` parse and resolve fully. The `pubsub:` spec **parses into a real source** so the seam is genuine, but `resolveReleaseSource` returns `{ error: "pubsub_source_not_yet_implemented" }` — the parse succeeds, the resolve is gated.

**Future P2P layer (RESERVED — not built).** The owner's vision is a peer-to-peer network for release distribution + peer communication + a market, carried over IPFS pub/sub with Pinata as the metadata/pinning provider. That layer sits behind the `release_announced` event kind (registered in `substrate/event_kinds.ts` but emitted by NO producer today) and the `pubsub_announcement` `ReleaseSource`. When it ships, a peer will emit `release_announced { release_version, bundle_cid, manifest_cid, signature, min_acc_version, announced_by }`; the resolver will verify the signature and extract `bundle_cid`, yielding an `ipfs_cid` fetch. No pub/sub, libp2p, or peer transport is implemented yet — only the event-kind and union seams are reserved so the schema is stable when the layer arrives.

## 17. Reuse-First Contract

Before adding any new event kind, predicate, worker, MCP method, or `act_artifact.kind`, verify no existing entity can carry the burden (`P2TH6BYK6H6FVEP1BH5SH8NVRW`). The substrate's open vocabulary — `act_artifact.kind` and payload extensions such as `knowledge_candidate.payload.judgment_packet=true` — is the canonical extension point. Every entity not added is one less surface to learn, one less dashboard row to explain, and one less integration contract to keep synchronized.

**Audit rule.** Every implementation proposal must classify each proposed entity as one of: folded into existing worker (name the worker), carried by existing event kind via payload extension (name the kind and field), implemented as `act_artifact` row with open `kind` (name the kind), read through existing view (name the view), or genuinely irreducible (prove existing surface fails). A generic "new" claim is insufficient. Closed enums, fixed predicate tables, and parallel registries are substrate violations.

**Current surface inventory.** Do NOT hand-transcribe counts here — frozen numbers drift silently against the live substrate (a prior snapshot of "239 event kinds / 46 views / 1,673 `act_artifact` rows" was already stale by ~5% kinds and ~5x artifact rows within days). Generate the inventory on demand from `runtime.system_map` (event kinds, views, MCP/runtime methods, registered workers) and the `act_artifact` registry (`SELECT kind, COUNT(*) FROM act_artifact GROUP BY kind`); treat that generated view as the single source of truth. Worker absorption points are the stable structural fact worth recording here: `experience_compression`, `extractors`, `contract_amendment_consumer`, `amendment`, `rendering_audit`, `owner_outcome_followup`, `scheduler`.

## 18. Dataflow Contract

Every data source maps to exactly one substrate primitive; orchestrator intelligence is preserved as durable evidence packets, never as Claude chat-memory paraphrase (`GX3B0TTE453XQ1W6TDGDJXBZWM`, `QWAGAECET158`, `1BDDY69G3N1J`, `40MQX7P41150`). The four-link causal chain (k_555) — create → retrieve → mutate retrieval state → credit outcome — holds for every path. Citation without retrieval binding is decorative memory (k_554); retrieval rejection feeds composer-policy posterior updates (k_201).

| Source | Substrate primitive |
|---|---|
| Owner words via chat | `owner_input_received` → `directive_opened` → `dispatch_decided` |
| Owner files via inflow | `act_artifact(kind="ingested_file")` via existing `substrate.admit_artifact`; `artifact_observed` for runtime observation |
| Claude observation of substrate views | Pure read = no emit; durable insight → `knowledge_candidate(payload.judgment_packet=true)` |
| Claude situated judgment | `knowledge_candidate(payload.judgment_packet=true, payload.evidence_event_ids[], payload.source_actor="claude_orchestrator")`; known-false brain output → `payload.contradiction_observation=true, payload.contradicted_event_ids[]` |
| Brain depth-1 reasoning | `action_predicted`, `knowledge_candidate`, `lesson_extracted`, `contract_amendment_proposed`, `task_node_opened`, `task_edge_recorded(payload.edge_kind="refines")` |
| Runtime artifact observations | `artifact_invoked`, `artifact_observed` |
| Runtime verifier residuals | `action_scored` with open `verifier_kind`, `breakdown`, `reliability_profile` |
| Owner feedback on output | `owner_observed_outcome_recorded`; profile changes → `owner_profile_recorded` |
| Claude-applied mutations | One `act_tuple_recorded` envelope per coherent act → substrate projects `action_predicted`, `action_scored`, `applied_change_committed`, `retrieval_binding`, credit rows idempotently |

**Downstream consumers read substrate state, never Claude chat memory.** `prompt_composer` reads ledger + candidates + judgment packets + profile + contradictions + proposals + task graph + artifact registry. Dispatch reads task graph + dispatch state + recipe/artifact registry + residuals + owner-control surfaces. Merger reads `knowledge_candidate` + `candidate_confirmed`/`candidate_contradicted` + embeddings + thresholds, absorbing both actors' candidates through one pipeline (`substrate/extractors.ts`: `extractKnowledgePromotions`, `maybePromoteKnowledge`, `extractSemanticDedup`, `extractCrossCandidateCorroboration`; `runtime/credit.ts`: distributes action outcomes over cited entities and emits candidate verdicts). Credit reads `action_predicted` + `action_scored` + `act_tuple_recorded` projections + `retrieval_binding` + citations + `owner_observed_outcome_recorded`.

**Dispatch-resume continuity.** Every new `acc task` brain run reads three continuity surfaces from prior runs (knowledge entry `44NHV1MZKS2R`): proposal inbox (already exposed through `lesson_implementer_queue_view`, `lesson_implementation_status_view`, `pending_contract_amendments_view`, composer sections `pending_proposals` and `outstanding_contract_amendments`); cited diff clusters (payload extensions: `contract_amendment_proposed.payload.diff_cluster_id`, `lesson_extracted.payload.diff_cluster_id`, `act_tuple_recorded.payload.cited_diff_cluster_ids`, `applied_change_committed.payload.diff_cluster_id`); retrieval/credit handoff (already exposed through `retrieval_credit_view`, `act_projection_observability_view`, `promoted_knowledge_view`; payload extensions: `retrieval_binding.payload.handoff_role`, `action_predicted.payload.cited_retrieval_binding_ids`, `act_tuple_recorded.payload.cited_knowledge_ids`/`cited_artifact_ids`). Judgment inbox: ordinary `knowledge_candidate` rows with `payload.judgment_packet=true`, `payload.contradiction_observation=true`, `payload.source_actor`, `payload.evidence_event_ids`, `payload.contradicted_event_ids` — prompt composer prioritizes these when they match the active directive.

## 19. Reactive Invariant

Substrate transitions are event-driven, not polled. **Load-bearing invariant: `event_emitted → subscribed_worker → next_event_emitted`.** The 30 registered workers in `worker_liveness_view` already subscribe to event kinds; no `setInterval` scans are permitted inside the daemon loop. Polling is allowed only at the external boundary (Claude transcript file watcher, opencode bridge, external MCP source like Telegram or Drive) and must normalize to an event within one hop. External adapters write `external_event_received` or admit the source's content as `act_artifact`; from that point the cascade is reactive. Compounding consequence: dispatch resume always reads the ledger as authoritative; there is no in-memory state that survives daemon restart unless an event row carries it.

## 20. CLI ↔ MCP Canonical Surface Map

The CLI composes MCP primitives — it does NOT bypass them. Every CLI command that mutates substrate state routes through a named MCP method; no parallel paths.

| CLI command | Canonical MCP method | Purpose |
|---|---|---|
| `acc task "..."` | `substrate.emit({kind:"owner_input_received"})` + `substrate.emit({kind:"directive_opened"})` | Owner intent ingress |
| `acc status` | `substrate.read({view_name})` | Owner-facing status reads |
| `substrate.search` (no dedicated CLI verb; reached via `acc task` retrieval and composer) | `substrate.search({query, k})` | Knowledge retrieval |
| `acc inspect <id_prefix>` / `acc directive <directive_id>` | `substrate.read({view_name})` | Entity / directive inspection |
| `acc dispatch <directive_id>` | `substrate.read({view_name:"dispatch_resolved_view"})` | Dispatch trajectory inspection (v2 has no contract model — dispatch state is the coordination surface) |
| `acc watch` | `substrate.read({view_name:"watch_panels_view"})` streaming | Live TUI |
| `acc doctor` | `runtime.system_map` + `substrate.read({view_name:"failure_view"})` | Diagnostic |
| `acc admin substrate-status` | `runtime.system_map` + `substrate.read({view_name:"health_view"})` | Operator status |
| `acc admin claude-mcp-register` | filesystem-only setup write (irreducible: writes Claude Code `~/.claude.json`) | One-time bootstrap |
| `acc init` | filesystem setup + `substrate.emit({kind:"state_snapshot_recorded"})` | First-run bootstrap |
| `acc daemon start/stop/restart/status` | daemon process control + `runtime.system_map` for health | Process lifecycle |

The only legitimate CLI-direct paths are (a) daemon process control (no substrate state involved) and (b) bootstrap operations that precede daemon start. All other CLI-direct mutations are legacy and must be re-routed through `runtime/mcp_server/substrate_tools.ts`; the retirement contract lives in `docs/roadmap.md` Tier 7.

## 21. Legacy Path Retirement

Two-way paths violate the one-workflow contract. Canonical writer per concern, retirement step via `act_artifact_aliased` for renames or payload migration for shape changes:

| Legacy / parallel | Canonical | Retirement |
|---|---|---|
| `code_artifact_*` event kinds | `act_artifact` registry | Emit `act_artifact_aliased(old_id, new_id, reason)` for in-place renames; alias chains resolved via existing `substrate/migration_runner.ts:resolveAliasChain` |
| Direct DB writes from `cli/*.ts` | `runtime/mcp_server/substrate_tools.ts` | Re-route per §20 surface map |
| Per-Edit/Write/Bash event emitters | One `act_tuple_recorded` envelope per coherent act | Substrate-side projection in `runtime/internal_act_projection.ts` expands one envelope into all derived rows |
| Mirror-inline outcome events | Same `act_tuple_recorded` envelope | Same projector |
| Duplicate `knowledge_candidate.payload` shapes | Single payload schema with `payload.judgment_packet` and `payload.contradiction_observation` flags | Existing `substrate/extractors.ts` merger handles uniformly |
| CLI-side dispatch race with daemon workers | Daemon is authoritative writer for all reactive event kinds | CLI emits only ingress events (`owner_input_received`, `directive_opened`) |

Each retirement is a payload migration or alias emission; no schema changes. Contract entries with closure predicates live in `docs/roadmap.md` Tier 7.

## 22. Multi-Brain Substrate Concurrency

Multiple terminals × multiple brain dispatches each share one daemon process. Three structural mechanisms keep this scalable without serializing the brain runs themselves:

**Persistent MCP client (`cli/rpc.ts`, commit `1eb4b71`)** — every CLI process holds ONE cached `StreamableHTTPClientTransport` + `Client` pair across all `mcpCall` invocations in its lifetime. Pre-fix, each `mcpCall` opened a fresh session (10-20 sessions per `acc task` invocation × N terminals × orchestrator poll loops = fastmcp session-table thrashing). Cache invalidates on transport-level errors so a wedged connection auto-reconnects. `beforeExit` / `SIGINT` / `SIGTERM` close the client so sessions don't outlive the process. Measured drop: ~95% fewer session establishments under live load.

**Handshake serialization gate (`runtime/bridge/opencode.ts`, commit `b9869bc`)** — bounded semaphore (default 2 permits, env override `ACC2_BRIDGE_HANDSHAKE_PERMIT_CAP`) caps concurrent MCP-handshake-window holders. Permits acquire before opencode spawn and release when the first MCP frame lands OR the subprocess exits (belt-and-suspenders in `proc.exited.finally`). This serializes ONLY the contended handshake window — brain runs continue in parallel after handshake. Pre-spawn `probeMcpReachable` HEAD probe surfaces dead-daemon as `mcp_unreachable_at_spawn` instead of burning 120s on a guaranteed-fail handshake. Wait budget `ACC2_BRIDGE_HANDSHAKE_WAIT_BUDGET_MS` (default 45s) fails open so a leaked permit can't permanently starve dispatches.

**Worker-tick dampen (`runtime/daemon.ts:173`, commit `2ee0618`)** — `WORKER_TICK_EVENT_DAMPEN_MS = 5*60_000` (5min per worker). Pre-fix at 60s the substrate absorbed ~1200 `worker_tick_completed` rows/hour × 20 workers; post-fix ~240/hour. Stuck-worker detection unaffected (reads `recordWorkerTick` state, not events). Reactive-fire path (line 620) also gates via `lastTickEmitMs` so subscription-driven workers don't bypass the dampen.

**JSON-path indexes (`substrate/db.ts:139+`, commit `826771f`)** — partial indexes on the 6 hottest payload extractions: `source_event_id`, `knowledge_id`, `source_act_id`, `retrieval_binding_event_id`, `artifact_id`, `dispatch_id`. Every view that joins by these (e.g. `lesson_implementation_status_view`, `retrieval_credit_view`) was previously full-scanning 355K+ rows. Measured: 0.02-0.10ms indexed lookup vs ~50ms full scan = ~100× speedup. Partial WHERE clauses (`IS NOT NULL`) keep index size small.

**Operator observability** — `/health` returns `handshake_gate: {permitsInUse, waitersWaiting, permitCap, waitBudgetMs}` so `acc daemon status` surfaces gate state directly. Combined with `bridge_mcp_preflight` event (kind registered in `substrate/event_kinds.ts`, emitted when permit-acquire waited >100ms), operators see queue dynamics live without instrumenting the bridge.

**Data-class admission (`runtime/artifact_admission.ts`, contract A0DQT211JH)** — non-executing rows (telegram dumps, doc content, target universes) admit with `runtime: null` and `declaredSandbox: null`. Path A short-circuits before fixture / owner-gate / predicate-gate machinery, requires `body + name + summary`, emits `act_artifact_admitted{admission_mode: 'data_class_nullable'}`. No `runtime='data'` sentinel — null IS the data signal.

**Wall-clock budget (`runtime/bridge/config.ts:48`, commit `867ce8d`)** — `DEFAULT_TIMEOUT_MS = 1500_000` (25min). Bumped from 900s after live evidence (`GHYWE89D5D5GB941XS5HCWMC20`) showed a legitimate multi-file refactor brain run hit 930s emitting valid amendments then SIGTERMed before reaching task_committed. `STALE_DISPATCH_THRESHOLD_MS` tracks the same 25min budget so stale-detection aligns. Override via `ACC2_OPENCODE_TIMEOUT_MS`.

The composite property: N terminals × M brain dispatches each remain effective because the bottlenecks (MCP session establishment, SQLite write lock contention, handshake-window races) are all bounded by either substrate-level concurrency primitives or substrate-observable telemetry.

## 23. Unified Intelligence Protocol (one organism, two hemispheres)

§22 makes multi-brain concurrency *scale*; this section states what it *is*. AccInt is ONE intelligence that merges two LLM families — Claude Code and opencode→gpt-5.5 — through the substrate. The substrate is the corpus callosum: both hemispheres read/write the same event ledger, and judgment merges there (knowledge `8T39G4DB`).

**Spawning is asymmetric.** The substrate can run **only opencode** programmatically — the bridge (`runtime/bridge/opencode.ts`) spawns opencode subprocesses. It **cannot spawn Claude Code**: Claude is the human-launched interactive harness, reached only through the MCP surface, never `spawn()`. Any design that assumes "the substrate dispatches a Claude brain" is wrong; the substrate can *signal/queue work for* Claude (a Claude terminal or agent picks it up via MCP) but cannot *launch* it.

**Claude-side parallelism is Claude-driven, not substrate-driven.** A Claude instance fans out its own intelligence: the Agent tool spawns background sub-agents (with `isolation: "worktree"` for isolated work + merge), git worktrees give parallel isolated checkouts, and a human opens multiple Claude terminals. The substrate does not orchestrate these — Claude does, and reports results into the ledger. This is the Claude-side analogue of opencode multi-dispatch: opencode parallelism is substrate-spawned; Claude parallelism is Claude-spawned. Worktree-isolate-then-merge is the shared isolation primitive (contract worktrees, the stage-2 auto-apply worker, and Claude background agents all use it).

**Participation is symmetric.** Every intelligence — each opencode brain (substrate-spawned), each Claude terminal (human-launched), each Claude background agent (Claude-spawned in a worktree) — registers as a co-equal **peer** and merges judgment through the same primitives: `act_tuple_recorded` causal envelopes, `action_scored` with open `verifier_kind` (`peer_llm_claude` / `peer_llm_opencode`), and `knowledge_candidate` rows feeding ONE merger (§7). Neither hemisphere is subordinate; the merger dedups, agrees, contradicts, and promotes regardless of which intelligence emitted the input.

**Claude is never removed from review/think/score.** Claude Code is a co-equal reasoning hemisphere, not a serial applier to be automated away. The stage-2 auto-apply worker (default-off `ACC2_ENABLE_AUTO_APPLY`) stays deliberately **narrow** — trivial mechanical eligible diffs only — so it *frees* Claude's intelligence for higher-value review/scoring, never replaces it. Claude remains the owner-visible exception handler for owner-gated, unstructured, stale-anchor, failing-test, or cross-surface proposals, and emits its review/score as first-class merger input.

**Adaptive/reactive routing + on-the-fly mutual awareness** (frontier — the multi-brain registry tier). The target: a peer registry distinguishing substrate-spawnable peers (opencode) from externally-launched peers (Claude terminals + agents), a depth-1 peer-awareness read surface so any brain sees what other brains/terminals are doing *right now* (in-flight acts, recent scores, reviews) and adapts — avoid duplicate work, defer to a peer mid-flight, merge a peer's review — and routing that chooses opencode-spawn vs Claude-signal by residual evidence + peer liveness + spawnability. This generalizes Tier D's multi-terminal coordination (D2) into a full multi-brain organism. The non-coder invariant holds throughout: all of this is invisible plumbing; the owner talks naturally and the merged organism answers, faster, in their own terms.
