# AccInt × Claude Code Integration Contract

**Status**: brain-designed (dispatch `KM7V4E7W411P98AGNJG8RKH1NM`, amendment `X6SDH6RJQS4Y7AAJHZNQ653WE0`, KCs `GS1Z4YBRQ143Q2` + `KHTBHA7R397MN0`, closure_residual 0.12), 2026-05-20. Implementation lands in follow-up commits.

After `acc init`, the target owner experience is: **the owner talks to Claude Code normally and AccInt handles substrate ingress without requiring the owner to type `acc task`.** The canonical position is **Q4 + R3 + S2 + T4** across the four design axes.

## Canonical retrieval grounding

- `S3KQ6TPC915Q` — Claude Code is owner-facing runtime; `acc task` substrate-owned; Claude-native progress/events/Agent/skills as observation.
- `QWAGAECET158` — Claude Code as observation+execution runtime around substrate events, NOT alternate strategic planner.
- `7W5N69Z08H43` — Claude Code wraps substrate ledger events rather than replacing substrate strategic planning.
- `YZCWFQCNWS5E` — Claude Code native tools as owner-observation + semantic-edit runtime; substrate owns dispatch, scheduling, learning.
- Commit `4b6af58` — explicit operator rejection of `consent_event_recorded` event kind, `acc stage` CLI verb, and primitives-around-classifier framing. This integration design honors that boundary.

## Q4 — daemon-side ingress (implicit-dispatch path)

A substrate-owned Claude chat observer reads Claude session transcripts (or equivalent Claude-local owner-message streams), captures owner free text as existing `owner_input_received` / `directive_opened` events, lets `intent_classified` and `dispatch_decided` select the lane, and exposes the substrate verdict back to Claude.

The observer must NOT become a second strategic planner and must NOT introduce new event kinds unless a verifier shows existing events cannot represent the observation.

This avoids relying on CLAUDE.md obedience, slash-command use, or prompt heuristics as the primary ingress gate. The owner just talks; the daemon notices.

## R3 — MCP server registration (fresh-chat awareness path)

`acc init` registers the substrate MCP server for Claude Code so a new chat can read substrate state, emit allowed ledger observations, and render owner-facing progress.

Repository `CLAUDE.md` and optional skills may improve ergonomics, but **MCP registration is the durable readiness boundary**. Do not require a new `claude_session_opened` event kind for the first version; use existing daemon/session/owner events plus MCP availability checks.

## S2 — fully-automatic legacy memory import (owner amendment 2026-05-20)

**Owner directive supersedes brain's review-gate framing**: import is fully automatic — no blocking prompt, no `owner_input_required` gate at init time, no multi-step setup. The brain's review-gate concern (false-memory risk) is structurally handled by the existing merger + posterior pipeline: imported entries enter as `knowledge_candidate` (NOT `knowledge_promoted`), earn weight via outcome credit, demote naturally if decorative.

`acc init` automatically:

- Detects `~/.claude/memory/` and prior Claude project transcripts (`~/.claude/projects/*/conversation.jsonl`)
- Admits each durable entry as `knowledge_candidate` tagged `origin=claude_legacy_memory`
- No owner prompt; no review gate; the substrate's normal merger pipeline scores them like any other candidate

Imported entries:
- Are evidence candidates, NOT canonical truth (default `score=0.5, confidence=0.3`)
- Cite their source via `evidence_event_ids` pointing at the source transcript path/hash
- Compete with other knowledge through normal Beta posterior compounding
- Demote naturally if not cited in subsequent action_predicted chains (no decorative-memory promotion path)

**Rejected alternatives** and why:
- S1 (reject entirely) — loses provably-useful prior context.
- S3 (continuous mirror) — privacy/provenance/false-memory risk; one-time-at-init is sufficient for "fully ready."
- S4 (manual-only `acc memory link`) — violates "fully automatic" directive.
- ~~S2-with-review-gate (original brain framing)~~ — superseded by owner directive: the merger pipeline IS the review layer; no upfront prompt needed.

## The one-elegant-workflow contract

Per owner directive 2026-05-20: **everything works automatically in one elegant workflow.** Concretely, the operator's actual sequence after a fresh install:

1. `claude plugins install accint` (T4 channel) OR `bun run acc init` (developer channel)
2. **One command. Everything happens.** The init flow:
   - Spawns the daemon (if not running)
   - Creates ~/.accint state dir + state.db
   - Runs schema migrations (substrate/migrations/v0NN_*.sql)
   - Bootstraps seeds (41 predicates + primitives + threshold seeds)
   - **Auto-imports legacy Claude memory** as knowledge_candidate rows (S2 auto)
   - Registers the substrate MCP server in Claude (R3)
   - Starts the Claude chat observer worker (Q4)
   - Returns a one-line "ready" signal to the operator

3. Owner opens a fresh Claude chat and just talks. The chat observer captures their free text as `owner_input_received` / `directive_opened`; the substrate dispatches; results render through the MCP read path; legacy Claude memory is already searchable as substrate knowledge.

**No multi-step setup. No prompts to review imported memory. No CLI verbs to learn beyond the optional `/acc` override slash command.** The substrate's own posterior machinery + merger pipeline + closure verifiers handle the safety-style concerns the brain raised about S3, but at the right architectural layer (posterior demotion, not init-time blocking).

Failure modes that DO surface to the owner:
- Daemon spawn failure (no substrate available — hard error, ops issue)
- MCP registration write conflict (owner has existing global config — surface diff, owner picks)
- Legacy memory directory unreadable (skip with warning, init continues)

Everything else flows through the substrate's normal posterior machinery without explicit owner gating.

## T4 — Claude marketplace plugin (distribution channel)

The preferred new-user channel is **`claude plugins install accint`**, installing in one Claude-native flow:

1. The MCP server registration (so fresh chats have substrate.search/read/emit)
2. Minimal Claude guidance (the operator contract section of CLAUDE.md, scoped + non-invasive)
3. Optional `/acc` skill for explicit override (substrate-direct dispatch when owner wants control)
4. The `acc init` checks (daemon spawn, state.db creation, seed bootstrap, migration v001 baseline)

**Repo clone (`git clone bos2 && bun run acc init`) and single-binary distribution remain developer / operator fallbacks**, but the product contract optimizes for Claude-native installation because the owner-facing runtime IS Claude Code.

## Data-flow Contract

Per brain dispatch `HPVV58GT9H4XDCJCT6ES6VKW90` amendment `ZYG7410YND0S9E` (KC `E5SRH60RG93EFD`). This section answers HOW data moves between Claude Code and the substrate after the Q4/R3/S2/T4 integration boundary decides WHEN the substrate engages.

### U4 — File ingress: explicit MCP ingest, filesystem fallback

Canonical path: Claude calls `substrate.ingest_file({ path, kind, scope? })` when the owner asks the substrate to use a local file. The substrate copies or hardlinks the file into `~/.accint/inflow/<topic>-<date>/`, admits an `act_artifact` with free-string kind `ingested_file`, records provenance to the source path/hash, and returns the artifact id. Subsequent directives reference the artifact id, not Claude memory text or ad-hoc path strings.

Fallback path: the daemon may watch `~/.accint/inflow/` for owner-initiated drops. Watcher discoveries should reuse existing artifact admission and owner-decision surfaces (`act_artifact_admitted`, `owner_input_required` when the drop is orphaned or ambiguous) rather than adding a `file_ingested_observed` event kind unless a verifier shows the existing ledger cannot represent the observation.

Rejected alternatives: U1 alone is too ad-hoc and leaves paths as transient prompt text; U2 alone misses owner-direct file drops; U3 alone makes daemon observation too implicit for Claude-mediated owner work.

### V4 — Substrate output: pull status by default, persist substantive summaries

Canonical path: Claude renders substrate outcomes by reading MCP views such as `dispatch_resolved_view` and `owner_plain_status_view`. The substrate remains the authority; Claude is an owner-facing renderer, not a push subscriber or second planner.

For substantive outputs worth keeping, the substrate should also write owner-readable markdown to `~/.accint/outflow/<task_id>.md` and link it from the relevant ledger event/artifact. Claude may read that file and render a concise summary in chat. This gives the owner a durable artifact without requiring websocket or long-poll complexity.

Rejected alternatives: V2 adds stream complexity before evidence demands it; V3 alone hides live task truth unless Claude also reads substrate state.

### W4 — Authoritative shared state: substrate owns durable profile, Claude owns only chat-local context

Durable owner concepts are substrate-owned: owner profile, preferred terms, avoided terms, autonomy/risk/control/collaboration signals, `things_to_never_do`, and any learned long-term operating model live in substrate events and promoted knowledge. Claude must not treat its own memory as authoritative for those concepts.

Claude may keep transient chat-local context needed to render the current turn, but durable updates become substrate observations or candidates. Legacy Claude memory import remains one-time S2-style evidence ingestion into substrate candidates; it is not continuous bidirectional sync and not a competing authority.

Rejected alternatives: W1 is directionally right but underspecifies legitimate chat-local context; W2 creates two durable authorities; W3 is an implementation cleanup, not the full boundary.

### X2 — Progress observation: Claude pulls status at turn boundaries

Canonical path: for long-flight substrate work, Claude reads substrate status through MCP and renders a compact status line at turn boundaries. The default owner-facing progress source is the existing substrate task/dispatch views, not terminal output and not a new progress event stream.

Operator fallback: `acc tail` or equivalent terminal watching remains available for developers/operators, but it is not the owner-facing contract. A separate Web UI/TUI can be added later as another renderer over the same substrate state, not as a replacement authority.

Rejected alternatives: X1 is operator-only; X3 proposes a new event kind before existing views fail; X4 is a future surface, not the Claude Code integration contract.

## What this design is NOT

- Not a consent ledger (rejected by owner directive 2026-05-20 commit `4b6af58`).
- Not an `acc stage` CLI verb (same).
- Not a primitives-around-classifier workaround (the classifier is upstream of the substrate; the substrate cannot influence it from inside, and shouldn't try).
- Not a replacement for substrate-owned strategic planning. Q4 observes; it does not plan. R3 exposes substrate state to Claude; substrate still decides routing and learning. Substrate primacy preserved.

## Implementation phases

This file documents the contract. Follow-up commits implement:

1. **Q4 chat observer worker** — `runtime/claude_chat_observer_worker.ts`. Polls `~/.claude/projects/*/conversation.jsonl` (or a Claude-provided event stream when available), parses owner messages, emits `owner_input_received` / `directive_opened` events. Idempotent via per-message hash. Opt-out via `ACC2_DISABLE_WORKERS=claude_chat_observer`.

2. **R3 MCP registration** — `acc init` extension. Writes substrate MCP server config to user's Claude MCP registry. Idempotent. Reversible via `acc admin claude-mcp-unregister`.

3. **S2 legacy memory import** — `acc init --import-claude-memory` flag (or interactive prompt during init). Reads detected sources, admits as `knowledge_candidate` rows, opens an `owner_input_required` for review of any high-impact entries.

4. **T4 plugin packaging** — release pipeline emits a Claude marketplace plugin manifest plus the bundled `substrate/canonical.db` (Phase 2 distribution, commit `df2a82e`). `claude plugins install accint` becomes the one-command install.

Each phase is a separate commit, designed to be independently verifiable and reversible.

## The Elegant Workflow — verbatim from whitepaper + architecture + roadmap synthesis

AccInt is not a smarter chat wrapper. It is the owner's scored external judgment body: owner intent enters once, reality scores what happened, and the next decision reads the retained evidence instead of beginning again. The whitepaper's thesis is the load-bearing inversion: intelligence lives in tested state, while models are temporary processors that read and extend it; Xu et al. on retrieval in long-context models (arXiv:2512.24601) explains why that state must reach the model through a shallow handle board, and Lee et al. on harness optimization (arXiv:2603.28052) explains why the harness is capability, not plumbing. Architecture.md §§2, 6, 7, and 9 name the same organism in implementation terms: one loop, a depth-1 brain bridge, one merger, and owner outcomes feeding the same credit machinery.

One session should feel simple. The owner opens Claude Code and speaks normally. Claude is the human-facing runtime: it hears the owner, renders progress, applies safe local changes when the substrate assigns that lane, and explains only the decision points that matter. The substrate notices the intent, classifies it, chooses whether cached replay, Claude inline work, opencode brain synthesis, clarification, or deferral is appropriate, and keeps the ledger authoritative. If the Claude chat layer blocks content the owner has authorized, the canonical path is substrate-direct dispatch rather than permission-rule workaround, preserving commit `4b6af58` and the orchestrator-runtime rule that the substrate has no Anthropic-side content gate.

The intelligence merge is deliberately asymmetric. Claude contributes situated orchestration, owner-facing judgment, local execution, and observed outcomes; the opencode brain contributes single-cycle strategic synthesis, decomposition proposals, knowledge candidates, artifacts, and amendments; the substrate decides routing, composes the prompt, verifies outputs, merges candidates, detects contradiction, and assigns posterior credit. Neither LLM canonizes knowledge by assertion. Their outputs meet in the same merger pipeline and earn influence only when later residuals, owner outcomes, or verifier evidence confirm them. This honors the whitepaper's processor-independence argument, Architecture.md §7, and the roadmap sequence where owner alignment, trust, and outcome channels come before more ambitious scored boundaries.

What the owner sees is the minimum viable surface: a normal chat, a compact status line when work is live, a durable outflow artifact when the result is worth keeping, and a plain request only when their judgment is actually needed. What the owner should not see is setup choreography, internal axes, memory-review gates, or model-handoff ceremony. Commit `fcf4fb0` made legacy Claude memory automatic because the merger is the review layer; commit `db25d24` made substrate state authoritative while Claude keeps only chat-local rendering context; commits `ed1a676` and `df2a82e` make release distribution preserve local organism memory instead of overwriting it. The workflow is elegant because the owner does not operate the machinery; the machinery preserves the owner's sovereignty while reducing visible control burden.

The loop closes by compounding posterior evidence, not by declaring victory. Each action carries an expected residual, produces an observation, receives a verifier score, and distributes credit to the knowledge and artifacts that actually shaped it. Later owner feedback is not commentary; it is calibration evidence for the owner model, rendering policy, delegation boundary, and non-code success criteria. Roadmap Tier S0 makes owner alignment the first calibration frontier; Tier 0 makes closure and binding trustworthy; Tier 1 adds owner outcomes and retrieval rejection; later tiers turn prompt policy, structural boundaries, counterfactuals, and credit formulas into scored rows. Friston's active inference frame, cited in the whitepaper, is the practical pattern: predict what the owner-approved outcome should be, act, observe surprise, and update the substrate that the next cycle reads.

Observability stays boring on purpose. Claude pulls truth from substrate views instead of stdout, process lists, or terminal panels; long work surfaces as a status line, completed work as a linked outflow artifact, and technical drilldown remains available through MCP views for operators. The brain self-audit for this dispatch showed the immediate risk is not lack of cleverness but silent exits and broad unpromoted candidates, so this section narrows the contract to a falsifiable workflow: normal owner chat in, substrate-dispatched work through one ledger, both LLMs credited through one merger, owner-readable artifact out, owner outcome later closing the loop. Commit `fcfecbe` adds explicit brain invocation as another observable request inside that same organism, not a second brain product.

## The organism contract

The Recursive Language Model is the general goal-solving shape, not a coding trick. Xu et al. on Retrieval in Long-context Language Models (arXiv:2512.24601) shows why a growing intelligence cannot pour all accumulated state into one prompt and expect the model to find the right needle; AccInt therefore keeps the model at depth one and makes the substrate choose what enters the cycle. Owner words enter as `owner_input_received` and `directive_opened`; `intent_classified` names the kind of work; `dispatch_decided` chooses replay, Claude inline execution, opencode brain synthesis, clarification, or deferral; and the graph grows only through `task_node_opened` plus `task_edge_recorded`. The same DAG primitive can help someone move to a new city, fix a bug, or write a strategic report. Moving city becomes nodes for constraints, budget, neighborhoods, housing search, document deadlines, stakeholder coordination, calendar actions, and post-move verification. A bug becomes reproduction, root-cause isolation, patch, test, and release evidence. A report becomes source collection, synthesis, review, and publication. The substrate does not need separate metaphysics for these goals; it asks whether the next missing slice is narrow enough for bounded peek or broad enough for symbolic recursion, then scores the resulting action by residual.

The world model is not a hidden persona or a long prompt. It is the union of the event ledger as append-only truth, promoted knowledge with Beta posteriors, the `act_artifact` registry with open kind/runtime/sandbox declarations, the owner profile with preferred terms, autonomy signals, and things never to do, trajectory motifs from Tier S3, causal edges from Tier S2, goal-shape predicates from Tier S5, and decomposition strategy from Tier S1. Each surface is the same world seen from a different angle: what happened, what usually works, what executable handles exist, what the owner will and will not accept, what sequences repeat, which edges cause improvement, what family a goal belongs to, and how the next graph should be shaped. The owner should experience this as continuity: the organism remembers not because it stores everything in chat, but because every later cycle reads scored external state.

The runtime boundary is deliberately unromantic. A bun artifact, a uv Python artifact, a camofox-browser artifact, a Claude-applied local edit, a research checklist, a calendar handle, or a contact workflow all become an act: intent, action artifact, verifier artifact, predicted residual, observation, residual, and credit. If a Python script parses market data and returns an observation, that observation is scored by the verifier and credit flows to the same cited knowledge and artifact posterior surface that would credit a Claude chat judgment or an opencode strategic synthesis. If camofox verifies a website flow, its browser evidence does not live in a browser silo; it becomes another scored observation in the ledger. Architecture.md states the domain-neutral rule: one event ledger, one act primitive, one credit machinery, one retrieval surface, one merger pipeline. Commits `d8baa7e`, `0e3bae1`, `891cc45`, and `d77db9c` move that rule from prose into artifact scoring, citation binding, counterfactual credit, meta-credit, brain accuracy, and coalition credit.

Automation is the default whenever the substrate has enough evidence to score the boundary. Classification, dispatch, prompt composition, verifier scoring, merger arbitration, posterior compounding, brain-dispatch survival gating, backfill idempotency, hot-reload survival, archival sweep, drift detection, and alias-chain resolution should run without asking the owner to operate the machinery. The recent work is aligned with that contract: `2915d2d` made brain dispatch survival observable, `5f79c8b` made backfill spam idempotent, `57af12a` reduced SQL worker overruns from 147 to zero, `612ccab` made PosteriorPolicyBundle the scored composer move, `ed1a676` and `df2a82e` separated release canonical state from local organism memory, and `4b6af58` kept substrate-direct dispatch distinct from Claude-side content gates. Owner input is reserved for boundaries where automation would be pretending: touching `things_to_never_do`, identity discontinuity, gray-zone owner judgment, irreversible effects, or conflicts where the owner is the only valid source of truth.

The owner just named the deepest integration bug: Claude can understand the full conversation, then pass the brain only a paraphrase. That loses signal before the substrate can score it. The fix should not be a new event-kind taxonomy. The existing KCs `CW8FK8GXPX7E`, `K0ERGX3AS51E`, `B46RAPZ9PD12`, `9FNDYQF16H7V`, `64MQGDJJ757W`, and `YWW1GS04PD3H` already converge on first-class judgment packets. The Q4 chat observer should read the owner transcript window directly, persist owner messages and Claude-visible corrections as substrate evidence, and let the dispatch composer see the full relevant chat window, retrieval bindings, accumulated commits, prior contradictions, and `knowledge_candidate` packets marked `judgment_packet=true`. Claude's summary can still be useful, but it becomes one cited observation among others, not the sole source text. The owner's words enter directly; Claude's situated judgment enters as evidence; the brain receives a substrate-composed packet that preserves both.

The phrase "most powerful organism" is earned only when the measurements say it is earned. A serious threshold is at least ten credited `owner_observed_outcome_recorded` rows per week with calibrated Beta movement on owner-alignment predicates; `brain_accuracy_observation` prediction error stays below 0.12 median and below 0.25 p90 by goal class; promoted knowledge used in committed work has bound citation density above 0.60; median `task_closure_audited` residual stays below 0.3 as a hard gate, not advice; and bun, uv Python, and camofox-browser artifacts each show interoperable action-scored to artifact-score credit chains with at least twenty recent scored bindings per runtime. Until those conditions hold together, the organism is alive and improving, not entitled to the title. When they do hold, the claim is falsifiable: the system can solve code, research, enterprise transformation work, outreach, creative work, and embodied goals through the same residual-scored loop while preserving owner sovereignty.
