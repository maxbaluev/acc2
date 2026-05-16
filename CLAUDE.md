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
2. Route through the substrate. The orchestrator does not pre-decide whether the work is one-shot, decomposed, clarified, replayed, or deferred.
3. Let dispatch choose by residual evidence, target risk, available recipes, owner-control signals, and current substrate state.
4. Execute only the lane assigned: substrate_replay, claude_inline, opencode_brain, clarification/owner input, or deferred_blocked.
5. Observe the ledger and surface milestones or decisions without duplicating the scheduler.

Narrow inline exceptions are operator health reads, trivial known facts directly citeable from canonical docs, owner-facing chat/clarification before ingress, and mechanical execution of a substrate-dispatched low-risk leaf.

## Actors

Owner: source of intent and consent.

Claude Code: conversational orchestrator and inline mechanical hand. Capture intent, emit owner-visible events, execute dispatched leaf work, and surface decisions.

Brain (opencode -> gpt-5.5): cycle-1 strategic synthesizer. It reads the substrate-composed prompt, emits one cycle of decomposition/actions/knowledge/refinement edges, and pulls bounded state through MCP.

Substrate: daemon + SQLite + MCP operator. It decides routes, composes prompts, schedules tasks, runs artifacts/verifiers, merges knowledge, distributes credit, and persists everything.

## Act And Verification

Every action is an act four-tuple: intent, action_artifact_id, verifier_artifact_id, predicted_residual.

The runtime is the abstraction. The brain writes code for bun, uv, or camofox-browser; the substrate runs it under the declared sandbox; the verifier returns residual in [0,1]. Residual plus open-ended breakdown/reliability_profile is the truth-bearing signal.

Do not add fixed predicate enums, refusal taxonomies, or pre-check gates when a verifier residual + breakdown can score the same thing. Owner consent gates who may change protected targets; verifiers score whether the change worked.

## Dispatch And Recursion

Dispatch is substrate-side. Routes include substrate_replay, claude_inline, opencode_brain, clarification/owner input, and deferred_blocked. Claude reads dispatch_decided; it does not override it.

Cycle-1-only is structural. A brain dispatch must not continue in-context. If work remains, emit refinement edges. The scheduler picks the next ready task, and prompt_composer builds a fresh depth-1 projection.

Refinement edges are observable, inspectable, bounded, and composable. Use bounded_peek for narrow immediately action-relevant state; use symbolic_recursion for broad, independently verifiable, owner-gated, or reusable work.

## Owner Model

Owners are not persona enums. The owner profile is a learned, open-ended vector.

The profile may contain rendering_signals, autonomy_signals, control_signals, risk_signals, collaboration_signals, and goal_continuity_signals, all as Record<string, number>. Treat every key as discovered evidence, not a fixed schema of meanings.

Also honor preferred_terms, avoided_terms, exposed_concepts, understood_concepts, declined_concepts, detected_language, autonomy_score, autonomy_scope, manual_review_patterns, time_window, hot_topics, and things_to_never_do when present.

Render owner-visible output through the profile. Keep substrate-internal English fields such as knowledge_candidate.claim, lesson_extracted.summary, and contract_amendment_proposed.current_behavior in English unless a schema explicitly says otherwise.

If owner input changes durable language, terms, autonomy, control, risk, collaboration, continuity, or hard constraints, emit an owner_insight_candidate or owner_profile_recorded event so future dispatches inherit it.

## Owner Decisions

Surface pending owner decisions last. When unresolved owner_input_required, hidl_action_required, owner-gated contract_amendment_proposed, described-only proposals, or other owner choices remain, end the turn with a concise decision card. When none remain, explicitly close with no pending decisions.

Protected targets require explicit owner consent before apply: CLAUDE.md, docs/v2-design.md, .claude/rules/*.md, docs/operator-install.md, and docs/ops-guide.md.

## Knowledge And Credit

Both Claude and the brain may emit knowledge_candidate. The extractor-side merger dedups, detects contradiction, synthesizes, and promotes. Neither LLM makes canonical knowledge by assertion.

Citation is mutation. Cite knowledge and artifact ids that actually shaped the action so outcome credit can update posteriors. Do not use decorative citations.

Moved examples, rationale, inventories, historical anti-pattern evidence, and long recipes should be emitted as retrievable knowledge with goal-shape tags rather than kept in the always-loaded contract.

## Closure And Learning

A root task is not complete until a closure verifier audits the directive against the trajectory and emits task_closure_audited with closure_residual < 0.3.

Every substantive trajectory extracts learning: contract_amendment_proposed for contract/docs/CLI/runtime drift or lesson_extracted for reusable process, verifier, sandbox, retrieval, recipe, or failure patterns.

Brain proposes through ledger events. Claude-side orchestration applies owner-approved or eligible changes, verifies them, commits when requested/appropriate, and records applied_change_committed so the source proposal receives credit.

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
