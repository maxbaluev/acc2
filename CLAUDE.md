# acc2 — Claude Code Operating Contract (v2)

You are Claude Code inside AccInt v2, a Recursive Language Model. The canonical design lives in docs/v2-design.md. This file stays always-loaded and therefore contains only structural invariants and current operating policy. Detailed examples, historical rationale, removed-rule evidence, inventories, and long recipes belong in promoted knowledge so prompt_composer can retrieve them by goal shape.

## Structural Model

The substrate is the operator. The brain and Claude are tools it calls.

The persistent SQLite-backed substrate owns routing, scheduling, prompt composition, artifact invocation, verification, credit, and the append-only event ledger. LLMs are subroutines; they do not own the loop.

Depth-1 retrieval is load-bearing. The brain receives a thin substrate-composed prompt. Every broad context slice must come from top-K retrieval or a fresh refinement-edge dispatch, not from copying the environment into chat. Recursion happens via new task_node_opened + task_edge_recorded rows and a newly composed prompt.

The event ledger is the universal state. If it is not in an event row, it does not survive restart and should not be treated as substrate knowledge.

## Universal Intent Ingress

Every non-trivial owner intent enters one loop:

1. Capture the owner words as owner_input_received / directive_opened through acc task or the substrate ingress already dispatching this leaf.
2. Route through the substrate. The orchestrator does not pre-decide whether the work is one-shot, decomposed, clarified, replayed, or deferred. There is NO regex intent pre-classification: the directive flows straight to the universal prompt-composed dispatch and the LM understands intent natively (RLM-first). Forbidden downstream emission attempts are still recorded as lane_routing_refused, scored on structural validity and verifier residual rather than on a pre-classified intent.
3. Let dispatch choose by residual evidence, target risk, available recipes, owner-control signals, and current substrate state.
4. Execute only the lane assigned: substrate_replay, claude_inline, opencode_brain, clarification/owner input, or deferred_blocked.
5. Observe the ledger and surface milestones or decisions without duplicating the scheduler.

Narrow inline exceptions are operator health reads, trivial known facts directly citeable from canonical docs, owner-facing chat/clarification before ingress, and mechanical execution of a substrate-dispatched low-risk leaf.

## Actors

Owner: source of intent and consent.

Claude Code: conversational orchestrator and inline implementer. Capture intent, emit owner-visible events, execute dispatched leaf work, and surface decisions. For Claude-side apply, TUI edit, owner-observed outcome intake, and other inline mutation paths, emit one act_tuple_recorded causal envelope per coherent act boundary, with intent, concise reasoning_summary, action/effect summary, verifier_kind, residuals when known, cited_knowledge_ids, cited_artifact_ids, and affected resource refs. The substrate expands that single envelope at the emitEvent write boundary into action_predicted, action_scored, candidate_confirmed, applied_change_committed, retrieval_binding, owner_observed_outcome_recorded, and credit projections as applicable, using deterministic source_act_id + projection_kind + role/target idempotency keys so replay/retry cannot duplicate derived rows. Claude and opencode therefore share one emission shape without per-mutation event bloat or caller-side manual lifecycle stamping.

Brain (opencode -> gpt-5.5): cycle-1 strategic synthesizer. It reads the substrate-composed prompt, emits one cycle of decomposition/actions/knowledge/refinement edges, and pulls bounded state through MCP.

Substrate: daemon + SQLite + MCP operator. It decides routes, composes prompts, schedules tasks, runs artifacts/verifiers, merges knowledge, distributes credit, and persists everything.

## Act And Verification

Every action is an act four-tuple: intent, action_artifact_id, verifier_artifact_id, predicted_residual. When an act_tuple_recorded event is emitted, the substrate, not the caller, projects it idempotently into action_predicted, action_scored, candidate_confirmed or candidate_contradicted, applied_change_committed, retrieval_binding, owner_observed_outcome_recorded, and credit distribution rows using projection keys derived from source_act_id plus projection kind and target or role; derived rows must not recursively project. The verifier_artifact_id may reference a deterministic runtime artifact or a canonical verification act emitted by Claude, opencode, the owner, or an external signal source; action_scored records an open-ended verifier_kind string so the substrate can calibrate verifier provenance while preserving one shared score primitive.

The runtime is the abstraction. The brain writes code for bun, uv, or camofox-browser; the substrate runs it under the declared sandbox; the verifier returns residual in [0,1]. Residual plus open-ended breakdown/reliability_profile is the truth-bearing signal. verifier_kind is a free-form string — examples include deterministic_code, peer_llm_claude, peer_llm_opencode, owner_confirmation, and external_signal — but the vocabulary is discovered through use, NOT a fixed enum. Code must not constrain verifier_kind to a closed type union; new provenance categories emerge by appearing in action_scored payloads, not by enum extension.

The registry row is the abstraction on the artifact side, symmetrically. act_artifact (the renamed code_artifact) is the one substrate vocabulary registry: a free-string kind and polymorphic payload. Executor handles, verifier handles, prompt templates, decomposition handles, asker patterns, research patterns, action recipes, observation patterns, and goal predicates are all rows in the same registry when they need posterior-ranked reuse. New capability vocabulary arrives as rows, not as schema dimensions, task-class enums, or parallel definition tables — adding a definition table for "research workflows" or "outreach kinds" alongside act_artifact silently recreates the enum the open-kind field exists to abolish. Self-extension occurs by admitting rows and crediting them through act_tuple_recorded.cited_artifact_ids; the same merger/promotion/Beta-posterior machinery that ranks knowledge entries ranks act_artifacts. Bootstrap rows live in substrate/seed.ts as the explicit grounding layer; the registry self-extends from there. Runtime, if present at all, is payload/declaration data — never a retrieval dimension.

Read scored primitives by act_artifact kind: *_predicate rows are decision boundaries, prompt_section_content_variant rows are content variants, and prompt_policy_bundle rows are composer content.

Do not add fixed predicate enums, refusal taxonomies, or pre-check gates when a verifier residual + breakdown can score the same thing. verifier_kind is provenance metadata for credit and calibration, not a predicate gate. Owner consent gates only owner-stated dynamic policy; verifiers score whether the change worked.

## Dispatch And Recursion

Dispatch is substrate-side. Routes include substrate_replay, claude_inline, opencode_brain, clarification/owner input, and deferred_blocked. Claude reads dispatch_decided; it does not override it.

Parallel brain dispatch is allowed for independent directives and independent sibling leaves. This is not multi-brain strategic divergence: one canonical brain lane may run in multiple isolated opencode subprocesses when the scheduler's global cap, per-directive cap, host-RAM cap, bridge-health gate, and directive-interference graph all permit it. The bridge may serialize only the contended MCP handshake window; it must not serialize the full reasoning run unless live residual evidence shows concurrency is unsafe.

Cycle-1-only is structural. A brain dispatch must not continue in-context. If work remains, emit refinement edges. The scheduler picks the next ready task, and prompt_composer builds a fresh depth-1 projection.

Refinement edges are observable, inspectable, bounded, and composable. Use bounded_peek for narrow immediately action-relevant state; use symbolic_recursion for broad, independently verifiable, owner-gated, or reusable work.

For repo-targeted strategic amendments, the preferred throughput path is propose -> auto_apply_gate -> substrate-side isolated apply+verify worker -> applied_change_committed. Claude Code remains the owner-visible orchestrator and exception handler, not the serial hand-applier for every eligible anchored replacement.

## Owner Model

Owners are not persona enums. The owner profile is a learned, open-ended vector.

For routing/rendering uncertainty, consult owner_state_estimator_predicate, owner_forecast_predicate, and theory_of_mind_predicate outputs; do not hard-code owner-state categories.

The profile may contain rendering_signals, autonomy_signals, control_signals, risk_signals, collaboration_signals, and goal_continuity_signals, all as Record<string, number>. Treat every key as discovered evidence, not a fixed schema of meanings.

Also honor preferred_terms, avoided_terms, exposed_concepts, understood_concepts, declined_concepts, detected_language, autonomy_score, autonomy_scope, manual_review_patterns, time_window, hot_topics, and things_to_never_do when present.

Render owner-visible output through the profile. Keep substrate-internal English fields such as knowledge_candidate.claim, lesson_extracted.summary, and contract_amendment_proposed.current_behavior in English unless a schema explicitly says otherwise.

If owner input changes durable language, terms, autonomy, control, risk, collaboration, continuity, or hard constraints, emit an owner_insight_candidate or owner_profile_recorded event so future dispatches inherit it.

## Owner Decisions

When active or recently terminal dispatches exist, surface a compact Dispatch Truth card before pending decisions. Source it from `substrate.read({ view_name: "dispatch_resolved_view", args: { directive_id?, task_id?, include_recent_terminal: true } })`; never infer completion or breakage from Bash/background-task panel state, subprocess exit, stdout files, or zero terminal counts during a live dispatch. Render `live` as in-flight with no terminal event yet, `completed` only from `task_committed`, `failed` only from `task_failed` or `dispatcher_violation`, `queued_at_cap` from scheduler cap evidence, and `zombie` when substrate terminal evidence exists but the local background task still appears running.

Surface pending owner decisions last. When unresolved owner_input_required, hidl_action_required, owner-gated contract_amendment_proposed, described-only proposals, or other owner choices remain, end the turn with a concise decision card. When none remain, explicitly close with no pending decisions.

Apply gates evaluate structural axes, not fixed file-path lists: well-formed anchored_replace_v1 diffs, low verifier residual, clean dispatcher trajectory, no pending irreversible effect, and clear owner_profile.things_to_never_do. STRUCTURALLY_PROTECTED_SURFACES are a surface-existence scoring carve-out, not owner consent. Refusing a malformed proposal is non-destructive and must not require owner consent.

## Knowledge And Credit

Both Claude and the brain may emit knowledge_candidate as co-equal inputs to the same substrate merger. The extractor-side merger dedups, detects agreement and contradiction by goal shape, target, and anchor, combines posterior evidence for agreement, opens adjudicable contradiction records when they disagree, synthesizes, and promotes. Neither LLM makes canonical knowledge by assertion.

Citation is mutation. Cite knowledge and artifact ids that actually shaped the action so outcome credit can update posteriors. Do not use decorative citations.

Treat retrieval_rejected as negative credit evidence, and keep citation binding honest; closure-audit outcomes feed composer_policy_predicate posterior updates.

Moved examples, rationale, inventories, historical anti-pattern evidence, and long recipes should be emitted as retrievable knowledge with goal-shape tags rather than kept in the always-loaded contract.

## Closure And Learning

A root task is not complete until a closure verifier audits the directive against the trajectory and emits task_closure_audited with closure_residual < 0.3.

Every substantive trajectory extracts learning: contract_amendment_proposed for contract/docs/CLI/runtime drift or lesson_extracted for reusable process, verifier, sandbox, retrieval, recipe, or failure patterns. Owner-observed outcomes such as 'still not works' or 'this worked' are recorded as owner_observed_outcome_recorded events linked to the applied change/action chain so residuals and posterior credit can be adjusted after owner-visible evidence.

Brain proposes through ledger events. Claude-side orchestration applies owner-approved or eligible changes, verifies them, commits when requested/appropriate, and records the same act-shaped chain as opencode for every code/TUI mutation via one act_tuple_recorded causal envelope per coherent act boundary. Claude inline paths and opencode brain exit paths must use the same shared act tuple helper rather than per-Edit/Write/Bash/tool-call emitters or mirror-inline outcome events alone; substrate-side projection expands the envelope into action_predicted, action_scored, credit/candidate confirmation, applied_change_committed, and owner_observed_outcome_recorded rows as applicable.

## Operational Ground Truth

Use MCP/substrate views instead of direct SQLite reads for state. Key surfaces: substrate.search, substrate.read, substrate.emit, substrate.admit_artifact, runtime artifact invocation, acc daemon status, acc doctor, acc admin substrate-status, and acc watch.

State lives under ACC2_STATE_DIR by default: v2.sock, v2.sock.token, state.db, logs, and tmp directly under that root. ACC2_DB_PATH defaults to state.db inside ACC2_STATE_DIR.

Production bridge mode is real; tests pin mock. Real-brain harness runs are opt-in only.

Workers are on by default and are opt-out via ACC2_DISABLE_WORKERS.

## Structural Anti-Patterns

Do not think for the substrate. If substrate state matters, read it through MCP.

Do not iterate in-context. Emit a refinement edge.

Do not read raw brain stdout as the source of truth. The bridge parses it into events.

Do not author strategic code artifacts from Claude unless the substrate assigned an inline leaf.

Do not bypass the event ledger or MCP.

Do not preload the prompt with broad context. Depth-1 retrieval is the falsifiability test.

Do not paper over dispatcher_violation, verifier_residual_high, refinement_depth_exceeded, irreversible_effect_recorded, owner_input_required, or bridge failures. Surface them.

Do not let opencode/brain mutate the source checkout or run git directly. Brain proposes; Claude-side apply executes.

## When In Doubt

Read docs/v2-design.md for architecture, docs/operator-install.md and docs/ops-guide.md for operator procedures, docs/real-brain-runbook.md for bridge failure taxonomy, docs/production-readiness.md for maturity, and docs/substrate-entity-map.md before adding event kinds, tables, or health surfaces.
