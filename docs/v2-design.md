# AccInt V2 — Universal RLM, Substrate-Resident Capabilities, Symmetric Merger

## 0. TL;DR

AccInt v2 is a universal Recursive Language Model whose recursive memory, synthesis operator, and code-runtime broker all live in a **persistent substrate daemon** backed by one SQLite events ledger. The daemon is always-on: there is no cold start, external services push data in asynchronously via webhooks, and every brain dispatch arrives at a warm projection.

The brain expresses every action as **code-as-capability**: it writes a script for one of three substrate-resident runtimes — **bun** (TypeScript), **uv** (Python under nsjail), **camofox-browser** (chromium under a substrate-owned profile) — and a verifier script that returns a scalar residual in [0,1]. There is no tool menu and no typed verification-predicate lattice. A "capability" is a code artifact promoted via outcome correlation.

Every brain dispatch is **exactly one cycle**. Multi-cycle iteration within a dispatch is rejected because v1's cycle 2 is empirically broken. When work remains, the brain emits a **refinement edge** on the task DAG and a fresh single-cycle session picks it up later. Recursion happens via the DAG, not via re-prompting.

Two LLM substrates contribute: **Claude Code** (orchestrator, conversational, inline mechanical work) and **opencode/GPT-5.5** (brain, strategic synthesis, DAG decomposition, code-artifact authoring). Both connect to the same shared MCP server as native clients. Their semantic knowledge merges at the substrate via embedding-based candidate deduplication, contradiction holding, and outcome-correlation promotion — **Model D**: neither LLM is the canonical author, the substrate is.

The owner is the only human in the loop, reached through Claude Code chat. No external-expert routing, no Telegram, no licensure-bound escalation, no fine-tuning. Subscription CLIs only; one API key exception: `OPENAI_API_KEY` for `text-embedding-3-small`. v2 starts fresh; v1's substrate is archived read-only; optional curated foundational seed is owner-approved per session.

**One workflow. Any high-level goal. Substrate compounds intelligence across dispatches.**

## 1. Status & Provenance

**Authored:** 2026-05-14 by Claude Code (orchestrator side of the merger), directly synthesizing the entire conversation: the RLM paper (arxiv 2512.24601), the whitepaper (`docs/whitepaper.md`), four rounds of brain critique (`k_3566`–`k_3642`), three prior v2 designs (25a8cd2 → ac47778 → 2fbae15 → d7fa1d9), and the accumulated 16 binding constraints below.

**Supersedes:** `docs/v2-design.md` at master `d7fa1d9` (1,233 lines). That version correctly named the three deeper unifications (universal `act` primitive, substrate-as-synthesizer, self-as-target) but missed two more after the cycle-1 universality + tool-architecture critiques:

1. **Code-as-capability universal action surface** — the prior verification predicate lattice and discrete capability menu both collapse into one mechanism: the brain writes code for one of three substrate-resident runtimes (bun, uv, camofox-browser); the substrate runs it sandboxed; a verifier code artifact returns a scalar residual. Long-horizon, embodied, relational, and multi-stakeholder domains are expressed through rolling-active directives and refinement edges in the DAG — same machinery as any directive.
2. **Substrate-as-capability-broker via shared MCP server** — capabilities (now code artifacts) are SUBSTRATE-resident, exposed via ONE MCP server that BOTH Claude Code and opencode connect to as native MCP clients. Both substrates run artifacts through the same MCP transport — no bridge stream interception, no asymmetric routing. ONE registry, ONE posterior per artifact, ONE state owner, ONE sandbox policy, ONE invocation transport.

Plus the 22 universality critique entries (`k_3601`–`k_3622`) + 20 tool-architecture entries (`k_3623`–`k_3642`) are all addressed in line below.

**Citations (load-bearing throughout):** `k_555` (four-link chain), `k_200` (same substrate), `k_252` (advisory=fake), `k_1101` (shared ledger), `k_2367` (one substrate), `k_201` (retrieval binding), `k_174` (judgment packets), `k_199` (causal ledger), `k_554` (citation=mutation); brain insights `k_3566`–`k_3572` (RLM/merger prior), `k_3582`–`k_3600` (architectural critique), `k_3601`–`k_3622` (universality critique), `k_3623`–`k_3642` (tool architecture).

**Binding constraints (all 16 honored):**

Foundational:
- (F1) System IS the RLM — substrate owns the recursive state transition (`k_3582`, `k_3588`).
- (F2) Goals as DAG with **first-class refinement edges** — rework is graph-native (`k_3583`, `k_3589`, `k_3597`).
- (F3) Async parallel tasks with **explicit consistency contract** — completed-task snapshot + opt-in watch edges (`k_3584`, `k_3592`, `k_3598`).
- (F4) Tools as scored substrate (LATM/Voyager) with **capability-declared sandbox** (`k_3585`, `k_3594`, `k_3599`).

Universal:
- (U1) Universal `act(intent, action_artifact, verifier_artifact, predicted_residual)` primitive — code-as-capability, no tool menu, no typed predicate lattice.
- (U2) Substrate-as-synthesizer knowledge merger (Model D) — both LLMs propose candidates; substrate auto-promotes via outcome correlation.
- (U3) Self-as-target as ordinary directive — same recursion for self-modification as for any external goal.
- (U4) **Three substrate-resident runtimes (bun, uv, camofox-browser)** — the brain writes code for whichever runtime fits the intent; verification is a code artifact returning a scalar residual; embodied/relational/long-horizon domains use these runtimes through ordinary directives.
- (U5) **Rolling-active directives** — review cadence + amendment lineage + partial-commit for long-horizon goals that never terminate (`k_3612`, `k_3620`).
- (U6) **Multi-stakeholder directives** — `stakeholder_state` rows + conflict/interaction edges for goals affecting more than the owner (negotiation, partner, family, team; `k_3613`, `k_3621`).
- (U7) **Owner-as-only-human-in-the-loop** — the owner communicates via Claude Code chat; there is no external-expert routing, no licensure-bound escalation protocol, and no sensitivity-label gating in the substrate.
- (U8) **Substrate-as-capability-broker via shared MCP server** — ONE registry, both Claude Code and opencode connect as native MCP clients to the SAME server; one invocation transport, one posterior counting both invokers.

Operational:
- (O1) Both LLM substrates via CLI subprocess routing — no API tokens for Claude Code or opencode. Embeddings remain an explicit exception: `OPENAI_API_KEY` calls `text-embedding-3-small` (as v1 does); this is the only external API key the system needs, and it is required because embedding is not a subscription-CLI capability.
- (O2) Typed `bridge.opencode_query` transport (streaming, auth, retry, cleanup — purely for opencode's textual response; capabilities flow through MCP separately; `k_3586`, `k_3595`, `k_3600`).
- (O3) Idempotency rules explicit (first-wins vs latest-wins vs payload-hash — `k_3591`).
- (O4) Tool quarantine + rehabilitation policy (`k_3593`).
- (O5) Fan-in residual attribution (`k_3596`).
- (O6) **Cross-directive interference graph** — explicit conflict edges between directives (retirement vs house vs relocate; `k_3618`).
- (O7) **Directive amendment primitive** — first-class `directive_amended` events with causal linkage (`k_3616`).
- (O8) **Irreversible-effect observations** — counterfactual regret hooks to scoring for actions with physical-world side effects (`k_3617`).

Verification:
- (V1) System-IS-RLM falsifiability test — wired into cutover criteria.

## 2. Thesis

AccInt v2 is **a universal Recursive Language Model whose recursive memory, synthesis operator, and code-runtime broker all live in a persistent substrate daemon backed by a SQLite events table**, processed by short-lived Claude Code and opencode/GPT-5.5 sessions that observe each other through one append-only ledger AND share one runtime registry. The daemon is always-on: it holds the WAL connection, the in-memory embedding index, the shared MCP server, and the external-push endpoints open across owner sessions. There is no cold-start because the substrate is never cold — external services push data in asynchronously, embeddings update continuously, and every brain dispatch arrives at a warm projection.

The same recursion solves any high-level human goal — coding, research, business, creative, relational, embodied, health-decision, long-horizon — via one `act` primitive: the brain writes code for one of three substrate-resident runtimes (bun, uv, camofox-browser), the substrate runs it sandboxed, and a verifier code artifact returns a scalar residual that scores the prediction. Both subscriptions invoke runtimes symmetrically through the shared MCP server. Knowledge candidates and code-artifact candidates from any origin are promoted by the substrate via outcome correlation. The system improves itself with the same workflow.

The substrate is not storage and not a CLI tool. It is **a persistent thinking daemon — the recursive operator AND the runtime broker AND the external-push ingress**. Sessions are workers; both LLM substrates are stateless at the session layer; durable state lives in the daemon and its delegated runtime processes. The brain operates on a strict prompt budget that surfaces depth-1 retrieval (per the RLM paper) — recursion happens via fresh refinement-edge calls with newly-composed prompts, not by flooding the current cycle with everything the substrate knows. That is the falsifiable test (V1).

Actor separation is an execution boundary, not a cognitive ontology. "Owner", "Claude", "opencode brain", "Father", and "substrate" name who may execute, schedule, speak, or mutate a given surface; they do not imply separate minds with separate memory/planning/reflection/communication/learning modules. Those functions are ledger-level operations over one substrate: memory is event persistence plus retrieval, planning is task-DAG mutation, reflection is verifier-scored closure plus lesson extraction, communication is owner-channel event rendering, and learning is posterior credit over cited events and artifacts.

## 3. The Universal Workflow

Every goal — any domain — flows through the same shape:

```
Owner intent (any high-level goal, natural language; may be rolling-active or finite)
   │
   ▼
Ingress: directive parsed → opened in substrate (one root task node)
   - Rolling-active vs finite flag set
   - Stakeholders enumerated if multi-party (default: owner only)
   │
   ▼
Decomposition: brain reads the directive + analogous past task graphs →
   emits a sub-DAG of task nodes + edges (requires/refines/watches +
   conflict edges to cross-directive constraints)
   │
   ▼
┌─────────────────────────────────────────────────────────────────┐
│ Scheduler reads ready_tasks_view (topology + concurrency cap)   │
│   │                                                             │
│   ├── spawns N concurrent sessions per ready task               │
│   │     (configurable concurrency, default 5–10; one cycle each)│
│   │                                                             │
│   ├── each session:                                             │
│   │     1. reads task goal + upstream observations + stakeholder│
│   │        states + active failures + retrieved knowledge       │
│   │     2. emits one or more act() calls, each referencing      │
│   │        an action code artifact + a verifier code artifact   │
│   │     3. substrate runs the artifact in its declared runtime  │
│   │        (bun | uv | camofox-browser) under per-runtime       │
│   │        sandbox; same execution path regardless of invoker   │
│   │     4. verifier artifact returns scalar residual ∈ [0,1]    │
│   │     5. records irreversible_effect if artifact declared one │
│   │     6. saves events + may propose knowledge_candidate(s) +  │
│   │        code_artifact_candidate(s) for future reuse          │
│   │     7. if more work remains, emits a refinement edge        │
│   │        (replaces multi-cycle iteration; cycle-1-only)       │
│   │     8. commits the task with outcome status                 │
│   │                                                             │
│   ├── completed events unblock downstream tasks                 │
│   ├── refinement edges schedule new single-cycle invocations    │
│   ├── owner may emit directive_amended via chat; substrate      │
│   │     links to superseded tasks/predictions                   │
│   └── directive closes when terminal nodes commit OR enters     │
│        rolling-active review cycle if long-horizon              │
└─────────────────────────────────────────────────────────────────┘
   │
   ▼
Substrate computes (via SQL views):
  - knowledge candidates promoted/demoted via outcome correlation
  - code_artifact posteriors updated (LATM/Voyager promotion)
  - active_inference_view residuals tracked
  - recipe candidates extracted from successful task graphs
  - stakeholder utility deltas tracked per directive
  - cross-directive interference graph updated
```

The brain never picks from a tool menu and never writes a typed verification predicate. It writes an action code artifact, a verifier code artifact, and a predicted residual. The substrate runs both; reality scores the prediction via the verifier's scalar return; knowledge and artifacts accrete via outcome correlation. The owner is the only human in the loop, reached through Claude Code chat. This is universal across every domain.

Owner-visible UX is the same universal workflow rendered through the owner profile: capture the owner's words, route through the substrate, expose residual/evidence/decision state, and propose the next concrete capability in the owner's vocabulary. Seeded capability descriptions are retrieval vocabulary, not a menu to echo; the owner should see a tailored proposal, pending decision card, or verified closure summary rather than substrate internals unless their profile shows they want those details.

Grounded world modeling uses the same shape. The substrate does not need a separate "world model" ontology before evidence demands one; it stores provisional, posterior-scored predictions and causal claims about resources, people, environments, organizations, software, and other external systems. Prefer reusing `knowledge_candidate` and `lesson_extracted` payloads with fields such as `predicted_outcome`, `causal_claim`, `hidden_state_estimate`, `validity_horizon`, `later_observation_refs`, and `calibration_residual` before adding new event kinds. A later verifier or observation can cite the original claim and move its posterior through the same credit chain as any other knowledge.

### 3.1 Rolling-active directives (closes `k_3608`, `k_3612`, `k_3620`)

Long-horizon goals — retirement saving, parenting, chronic-condition management, career transition — don't fit "terminate via committed terminal nodes." They are rolling commitments with periodic review, not finite tickets.

Directives carry a `lifecycle` field:

```typescript
type DirectiveLifecycle =
  | { kind: 'finite'; expected_close_by?: string }      // standard — closes when terminal nodes commit
  | { kind: 'rolling_active';                            // never closes; periodically reviews
      review_cadence: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'annually';
      partial_commit_checkpoints: string[];              // milestone events that count as partial closure
      next_review_due: string };
```

Rolling-active directives:
- Never emit `goal_committed` — instead emit `directive_review_due` on cadence
- Father (§14) reads `rolling_review_due_view` and re-opens the directive's review subtask each cadence period
- Partial commits emit `directive_milestone_recorded` events that show observable progress without forcing closure
- Amendment is the norm, not exception (see §3.2)

This deletes the "fake closure or abandonment" pressure for year-scale goals (`k_3620` deletion target).

### 3.2 Directive amendments (closes `k_3616`, `O7`)

Human reality reframes goals mid-flight. Therapy, travel, job search routinely change success criteria after new evidence arrives. The substrate captures this as a first-class event:

```typescript
substrate.emit({
  kind: 'directive_amended',
  payload: {
    original_directive_id: 'd_find_job',
    amendment_text: 'narrow to remote-only, drop in-person interviews',
    superseded_predictions: ['evt_pred_abc', 'evt_pred_def'],
    superseded_tasks: ['t_in_person_logistics'],
    new_tasks: ['t_remote_only_filter'],
    rationale: 'spouse relocation timeline shifted',
    amended_by: 'owner',
  },
});
```

Amendment lineage preserves the causal chain: superseded events stay in substrate (audit), but `task_graph_view` excludes them from active topology. Predictions written before amendment are scored against the AMENDED goal where applicable, or marked `superseded_by_amendment` and excluded from residual aggregation.

### 3.3 Multi-stakeholder directives (closes `k_3613`, `k_3621`, `U6`)

Negotiation, hiring/firing, partnership decisions involve multiple agents with distinct utilities. The substrate represents stakeholders explicitly:

```typescript
substrate.emit({
  kind: 'stakeholder_state_recorded',
  payload: {
    directive_id: 'd_salary_negotiation',
    stakeholder_id: 'self',
    declared_utility: { target_salary: 250000, min_acceptable: 220000, ... },
    inferred_constraints: ['must close by EOQ'],
    information_visibility: 'full',  // self sees own state fully
  },
});

substrate.emit({
  kind: 'stakeholder_state_recorded',
  payload: {
    directive_id: 'd_salary_negotiation',
    stakeholder_id: 'counterpart',
    declared_utility: { /* from observable signals */ },
    inferred_constraints: ['budget ceiling estimated 270k from posting'],
    information_visibility: 'inferred',  // counterpart is opaque; we model
  },
});

// Conflict/interaction edges
substrate.emit({
  kind: 'stakeholder_interaction_edge',
  payload: {
    from: 'self',
    to: 'counterpart',
    edge_kind: 'negotiation' | 'cooperation' | 'adversarial' | 'mediation',
    information_flow: 'partial' | 'asymmetric' | 'symmetric',
  },
});
```

The brain at each task reads `stakeholder_state_view(directive_id)` and reasons about partial agreements, hidden information, and asymmetric utility. The DAG can include `stakeholder_consult` tasks that explicitly verify alignment.

### 3.4 Cross-directive interference (closes `k_3618`, `O6`)

Human goals are portfolio-shaped. "Save for retirement," "buy a house," and "relocate" interact. Substrate captures this:

```typescript
substrate.emit({
  kind: 'directive_interference_edge',
  payload: {
    from_directive: 'd_save_retirement',
    to_directive: 'd_buy_house',
    interaction: 'resource_conflict' | 'enabling' | 'sequencing_dependency' | 'mutual_exclusion',
    impact_estimate: 'down_payment_drains_401k_contribution_for_18mo',
  },
});
```

Father (§14) reads `directive_conflicts_view` when ranking objectives — prioritization respects the interference graph instead of pretending directives are isolated.

### 3.5 Emergency-mode execution (closes `k_3606`)

Crisis response (medical emergency, system breakdown, accident) needs different defaults: faster escalation, irreversible actions logged with post-hoc reconciliation, lower verification thresholds.

Directives carry an optional `urgency` field:

```typescript
type DirectiveUrgency = 'normal' | 'elevated' | 'crisis';

// Crisis mode adjusts:
// - Scheduler concurrency cap raised (10 → 20 sessions)
// - Verification timeouts halved
// - irreversible_effect observations promoted to direct logging without batching
// - Father iteration frequency raised (5 min → 30 sec)
// - LATM authoring loop suspended (no time to author new tools)
// - Recipes preferred over fresh brain dispatch (Tier 0 first, hard)
```

Post-crisis, a `crisis_postmortem` task automatically opens to reconcile irreversible effects with planned outcomes.

### 3.6 When Claude calls opencode — the merger decision

Claude Code is the orchestrator and conversational surface. Opencode (GPT-5/GPT-5.5 via subscription CLI) is the strategic reasoner. Both write to the same substrate, but they do not have the same role and they do not run concurrently on the same task by default. The merger is governed by a **scored dispatch predicate**, not by prose:

```typescript
type DispatchDecision =
  | { route: 'claude_inline';     reason: string; cited_artifact_ids: string[] }
  | { route: 'opencode_brain';    reason: string; predicted_complexity: 'low' | 'mid' | 'high' }
  | { route: 'substrate_replay';  reason: string; recipe_id: string };

function decideDispatch(directive: Directive, substrate: Substrate): DispatchDecision {
  // 1. Tier-0: substrate.recipes_view matches by embedding × shape → replay (no LLM call)
  const recipe = substrate.recipes_view.match(directive);
  if (recipe && recipe.confidence >= RECIPE_REPLAY_THRESHOLD) {
    return { route: 'substrate_replay', recipe_id: recipe.id, reason: 'recipe_match' };
  }
  // 2. Claude inline lane: low-risk patterns sourced from scored knowledge entries
  //    tagged 'low_risk_inline_pattern' with score ≥ 0.7 and confidence ≥ 0.6.
  //    If EVERY target file/runtime matches at least one pattern, Claude executes inline.
  const inlinePatterns = substrate.low_risk_inline_patterns_view();
  if (inlinePatterns.length > 0 && directive.all_targets_match(inlinePatterns)) {
    return { route: 'claude_inline',
             cited_artifact_ids: inlinePatterns.map(p => p.cited_id),
             reason: 'scored_inline_lane' };
  }
  // 3. Default: dispatch to opencode for strategic work — DAG design, contract emission,
  //    knowledge synthesis, code-artifact authoring, multi-step planning.
  return { route: 'opencode_brain', reason: 'no_recipe_no_inline_match',
           predicted_complexity: estimateComplexity(directive) };
}
```

**Event-type partition (who writes what):**

| Event kind | Claude orchestrator | Opencode brain | Substrate |
|---|---|---|---|
| `directive_opened` | ✓ (owner words → directive) | — | — |
| `task_node_opened` / `task_edge_recorded` | only inline lane | ✓ default author | — |
| `action_predicted` (with artifact refs) | inline lane only | ✓ default author | — |
| `artifact_invoked` / `artifact_observed` | — | — | ✓ (substrate runs the artifact) |
| `action_scored` | — | — | ✓ (substrate runs verifier, records residual) |
| `knowledge_candidate` | from chat observation | ✓ default author | — |
| `code_artifact_candidate` | rare (low-risk only) | ✓ default author | — |
| `knowledge_promoted` / `code_artifact_promoted` | — | — | ✓ (outcome correlation extractor) |
| `owner_input_received` | ✓ every chat turn | — | — |
| `owner_decision_recorded` | ✓ when owner answers | — | — |
| `directive_amended` | ✓ (owner speaks amendment via chat) | — | — |
| `task_committed` / `task_failed` | ✓ (inline) | ✓ (brain) | — |

Hard invariant: opencode brain dispatches are read-only against the source checkout. The bridge must not launch the brain with blanket permission approval; its per-dispatch config allows read/list/glob/grep plus acc2 MCP tools and denies direct edit/write/bash/git/source-mutation surfaces. The brain proposes source changes only through substrate events (`code_artifact_candidate`, `lesson_extracted`, `contract_amendment_proposed`). Claude-side orchestration applies accepted proposals and owns any resulting git commit.

The merger HAPPENS at posterior-update time. When `action_scored` lands, the substrate credits every knowledge_id and code_artifact_id cited by either the action artifact or the verifier artifact, regardless of who wrote them. There is no "Claude's posterior" vs "opencode's posterior" — there is one substrate posterior per cited artifact, and both substrates' contributions accumulate against it. That is what makes the merger genuinely symmetric (k_3566-k_3572).

Opencode runs **one cycle per dispatch** (the cycle-1-only constraint, §3.7). Claude is conversational and does not run "cycles" — it observes chat turns, decides per turn whether to dispatch, and otherwise stays idle. Father (§14) is a recurring scheduler that may also trigger dispatches on cadence (rolling reviews, queued backlog) without an owner turn.

This separation is about execution rights and observability, not about splitting cognition into actor-local faculties. Claude may speak to the owner and apply approved edits; opencode may synthesize and propose artifacts; Father may open scheduled directives without an LLM; the substrate alone owns durable state, scheduling, retrieval, scoring, and posterior updates. Memory, planning, reflection, communication, and learning therefore remain substrate functions expressed as events, views, verifiers, and credit updates, even when different actors execute the immediate step.

#### 3.6.1 Semantic knowledge merger — what the substrate does when both substrates have an opinion

Claude and opencode produce knowledge candidates from different angles. Claude observes the owner's chat turn-by-turn; opencode synthesizes from accumulated substrate state during a strategic dispatch. The two streams will frequently overlap, sometimes corroborate, and sometimes contradict each other. The substrate — not either LLM — owns the merger via four extractor-side rules grounded in `k_3566`-`k_3572` (Model D merger):

**Rule 1: Embedding-based candidate deduplication.** Every `knowledge_candidate` is embedded at admission time (`text-embedding-3-small`). When a new candidate's cosine similarity to an existing open candidate exceeds `KNOWLEDGE_DEDUP_COSINE_THRESHOLD` (default 0.92) AND their entity-anchor sets overlap by ≥ 50%, the substrate does NOT open a second candidate row. Instead it attaches the new event as **corroborating evidence** to the existing candidate (a `candidate_confirmed` event with `corroborated_origin = <new candidate's substrate_origin>`). One semantic claim, one candidate row, two origin events backing it.

**Rule 2: Embedding-based contradiction holding.** If the same dedup check matches (high cosine, overlapping anchors) but the polarity differs (one candidate asserts X, the other asserts not-X — detected by a polarity-classifier code artifact run at admission), the substrate opens NEITHER as canonical. It emits `contradictory_candidates` linking both rows. Retrieval surfaces both with the contradiction flag; only `action_scored` evidence on actions citing one side can break the tie. The substrate does not silently pick a side.

**Rule 3: Optional synthesis without losing provenance.** When a candidate accumulates `≥ N corroborating origin events from ≥ 2 distinct substrate_origins`, an extractor may emit a `knowledge_synthesized` event whose payload is a canonical merged text (currently produced by a seed bun code artifact `synthesize_corroborated_candidates` that takes the candidate text + corroborating events and emits a tightened restatement). The synthesized row carries the citation chain pointing back to BOTH original origin events. The originals persist for audit; the synthesized text is what retrieval surfaces by default.

**Rule 4: Per-origin retrieval bias is learned, not declared.** At retrieval time the daemon's reranker multiplies cosine × posterior by an additional per-origin shape multiplier sourced from the `origin_promotion_view` (a view summarizing how often each `substrate_origin` has produced candidates that promoted on this goal-shape). Claude's origin tends to win on owner-channel decisions (chat-context insights); opencode's origin tends to win on strategic-decomposition tasks. The multiplier is the substrate's compounding judgment, not a hand-tuned weight.

**Provenance preservation:** even after dedup/synthesis, the citation chain for any merged or synthesized knowledge points to BOTH original origin events. When `action_scored` credits flow to a cited knowledge_id, the substrate distributes the credit across all corroborating origin events using a Shapley decomposition by corroboration order — first-discoverer and corroborator both gain posterior, neither is erased.

**Where this lives in code:** `v2/substrate/extractors.ts` implements all four rules as deterministic SQL+extractor passes over the event log. Neither LLM ever sees the other's raw candidate text and "decides what to do with it." Merger happens in the extractor, observable as event rows.

### 3.7 Cycle-1-only — refinement edges replace iteration

Every opencode dispatch is exactly one brain cycle. Multi-cycle iteration within a single dispatch is rejected because (a) v1's cycle-2-and-beyond is empirically broken (cycle 2 routinely fails to deliver) and (b) iteration as opaque retry is inferior to refinement as inspectable substrate state.

When a brain cycle reaches its conclusion with work remaining, it emits a **refinement edge** on the task DAG (`task_edge_recorded` with `kind: 'refines'`) plus a new `task_node_opened` for the refinement target. The substrate's scheduler picks the new task up like any other ready task and triggers a fresh single-cycle dispatch later, with a freshly composed prompt (a fresh recursive call — see §13). The brain does not re-prompt itself within a cycle.

This makes every refinement step:
- **Observable** — the refinement edge is a row, not a runtime variable.
- **Inspectable** — the owner can see "task X needed 3 refinement edges to converge" in `task_graph_view`.
- **Bounded** — a per-task refinement-depth cap prevents runaway loops; exceeding the cap surfaces as `failure_kind: 'refinement_depth_exceeded'` for owner judgment.

**Dispatcher enforcement (not just a stated rule, per k_252).** Cycle-1-only is enforced structurally by `runtime/task_dispatcher.ts`. The dispatcher emits exactly one `brain_dispatched` event per ready task, spawns one opencode subprocess, and closes the dispatch when the subprocess exits — regardless of what the subprocess claims about needing more cycles. Any attempt by the brain to self-iterate (e.g. emitting a `brain_cycle_2_started` event, calling a `continue_cycle` substrate primitive, or returning a "needs another cycle" sentinel in its final response) is rejected as `dispatcher_violation` and the dispatch closes anyway:

```typescript
// v2/runtime/task_dispatcher.ts (sketch)
async function dispatchReadyTask(task: ReadyTask): Promise<DispatchResult> {
  const dispatchId = ulid();
  substrate.emit({ kind: 'brain_dispatched', payload: { task_id: task.id, dispatch_id: dispatchId } });

  const proc = bridge.spawnOpencode(prompt_composer.compose(task));
  const events: Event[] = [];

  for await (const ev of proc.events()) {
    // Hard reject any self-iteration signal — the brain runs exactly one cycle.
    if (ev.kind === 'brain_cycle_2_started' || ev.kind === 'continue_cycle_requested') {
      substrate.emit({
        kind: 'dispatcher_violation',
        failure_kind: 'cycle_1_only_breach',
        payload: { dispatch_id: dispatchId, attempted_event: ev.kind },
      });
      proc.kill('SIGTERM');
      break;
    }
    events.push(ev);
  }

  // The dispatch closes when the process exits OR a self-iteration attempt was rejected.
  substrate.emit({ kind: 'brain_dispatch_closed', payload: { dispatch_id: dispatchId, events_count: events.length } });

  // If work remains, the brain MUST have emitted a refinement_edge (task_edge_recorded
  // with kind:'refines'); the scheduler will pick up the new ready task on its next tick.
  return { dispatch_id: dispatchId, events };
}
```

The single-cycle invariant is also exercised in the test fixtures and in §18 cutover criterion 17 (added below): a fixture directive that intentionally tries to self-iterate must produce a `dispatcher_violation` event and the substrate must continue to make forward progress via refinement edges rather than via the rejected iteration.

### 3.8 Intelligence extraction — how high-level goals decompose into work

v1 extracted intelligence with a wigwam-style multi-cycle Ralph loop: one long brain process churning through cycles on the same prompt, hoping each cycle adds something. The cycle-2-and-beyond breakage of that loop is exactly why v2 rejects it. v2's replacement is structurally different and observably more elegant:

```
Owner gives a high-level goal
       │
       ▼
Brain dispatches ONCE → emits a DAG decomposition: top-level subtasks + edges.
                       The decomposition is a TREE of intentions, not a plan to execute.
       │
       ▼
Scheduler picks each ready subtask and dispatches the brain AGAIN — once per subtask —
with a FRESH prompt composed from the updated substrate state. The brain at each
node sees only what is relevant to that node (depth-1 retrieval), not the full goal
again. This is the RLM recursion: each recursive call is a fresh brain dispatch over
a fresh, narrow retrieval. The brain at node B doesn't re-derive node A's reasoning —
it reads node A's committed observation and reasons one step deeper.
       │
       ▼
Each leaf node emits act() with action + verifier artifacts. Substrate runs the
artifacts, verifier returns a residual. Observations propagate up.
       │
       ▼
If a node's verifier residual is high (work failed), the brain at that node emits a
refinement edge: a NEW child task under the failed node, with a narrowed sub-goal.
Refinement is not retry — it is a fresh recursion at one level deeper.
       │
       ▼
Successful trajectories accumulate. After ≥ 3 similar shapes succeed on similar
goals, the recipe extractor promotes a recipe; future similar directives hit Tier-0
replay without any brain dispatch at all.
       │
       ▼
Across many directives, the substrate's posterior on each code artifact, each
knowledge entry, and each recipe accumulates evidence. The next dispatch on a
related goal sees better retrievals (cosine × posterior), spends fewer brain
cycles, hits more recipe replays, refines fewer times. Intelligence compounds at
the substrate, not in any single brain run.
```

What this concretely buys over Ralph's wigwam loop:

| Property | v1 Ralph loop | v2 substrate recursion |
|---|---|---|
| Where intelligence accumulates | Inside a single brain process across cycles | In the substrate across dispatches |
| What survives a crash | Nothing past the last cycle commit | Every event; the daemon rebuilds at boot |
| What can be inspected mid-run | Brain stdout (opaque) | Task DAG + refinement edges + every action_scored row |
| What can be tested in isolation | The Ralph loop end-to-end | Every single brain dispatch is an independent unit test |
| What recurses | The same prompt across cycles | The DAG; each level is a fresh recursive call |
| What gets retrieved | Whatever the brain remembered last cycle | Depth-1 top-K, freshly composed per dispatch |
| What an external service can inject | Nothing; loop owns its execution | Anything; the daemon's webhook accepts it and the next retrieval sees it |
| How fine-tuning helps | Could be useful (v1 considered it) | Not needed; substrate retrieval compounds without it |

The four mechanisms that together extract intelligence elegantly:

1. **DAG decomposition** — high-level goals become a tree of typed task nodes; each node has a defined success criterion (a verifier) and a budget.
2. **Per-node fresh dispatch** — each node gets a fresh brain cycle with depth-1 retrieval, so the brain at that node reasons specifically, not abstractly.
3. **Refinement edges** — failures don't restart the loop; they recurse one level deeper at the specific failure point, with the failure's residual + observation visible to the new dispatch.
4. **Substrate-level compounding** — every action's residual posterior-updates the cited knowledge and code artifacts; next time a similar node fires, retrieval pulls the artifacts that succeeded last time, not just the artifacts named "good." Outcome correlation, not naming, drives reuse.

The system achieves high-level goals because (1) every step is structurally small, (2) every step's residual feeds back into the retrieval that fuels future steps, and (3) recipes auto-extract from successful trajectory shapes so routine work is replay, not fresh brain dispatch.

## 4. Substrate — One Events Table, Many Views

### 4.1 Schema

```typescript
type Event = {
  id: string;                           // ULID
  ts: string;                           // ISO timestamp
  directive_id: string;                 // root directive this trace belongs to
  task_id: string;                      // task node within the directive DAG
  parent_task_id: string | null;        // DAG provenance
  loop_id: string;                      // the session id that emitted
  substrate_origin: SubstrateOrigin;
  kind: EventKind;
  payload: JsonValue;
  context_refs: string[];               // citation chain
  predicted_residual?: number;          // brain's prior in [0,1] before the verifier ran
  action_artifact_id?: string;          // ref to code_artifact that produced the observation
  verifier_artifact_id?: string;        // ref to code_artifact that scored the residual
  outcome?: OutcomeStatus;
  residual?: number;                    // verifier's scalar return
  embedding?: number[];                 // dense vector for text-bearing payloads
  payload_hash?: string;                // deterministic sha256 for idempotency
  blob_ref?: string;                    // for large payloads
  failure_kind?: FailureKind;
  invoker?: SubstrateOrigin;            // who invoked (vs substrate_origin = who emitted)
};

type EventKind =
  // Directive lifecycle
  | 'directive_opened'
  | 'directive_amended'
  | 'directive_review_due'              // rolling-active
  | 'directive_milestone_recorded'      // partial commit
  | 'directive_interference_edge'       // cross-directive

  // DAG topology
  | 'task_node_opened'
  | 'task_edge_recorded'                // requires | refines | watches
  | 'task_blocked'
  | 'task_ready'
  | 'task_claimed'
  | 'task_committed'
  | 'task_committed_superseded'
  | 'task_failed'
  | 'task_abandoned'

  // Universal action primitive
  | 'action_predicted'                  // carries action_artifact_id + verifier_artifact_id + predicted_residual
  | 'artifact_invoked'                  // substrate ran a code artifact
  | 'artifact_observed'                 // observation returned
  | 'action_scored'                     // verifier returned residual ∈ [0,1]
  | 'irreversible_effect_recorded'      // physical-world side effect captured before/during action

  // Knowledge (substrate-synthesized — Model D)
  | 'knowledge_candidate'
  | 'candidate_confirmed'
  | 'candidate_contradicted'
  | 'knowledge_promoted'
  | 'knowledge_demoted'
  | 'contradictory_candidates'

  // Code artifacts (LATM/Voyager — code-as-capability)
  | 'code_artifact_candidate'           // brain proposed a new code artifact
  | 'code_artifact_admitted'            // fixture passed, artifact entered registry
  | 'code_artifact_admission_rejected'
  | 'code_artifact_promoted'            // posterior crossed naming threshold → blessed capability
  | 'code_artifact_quarantined'
  | 'code_artifact_rehabilitated'
  | 'sandbox_violation'                 // declared ≠ actual at runtime

  // Embeddings (substrate-managed)
  | 'embedding_computed'                // text-bearing payload was embedded + indexed

  // Bridge (subscription CLI transport for opencode text responses;
  // capability invocations flow through MCP server, NOT bridge)
  | 'bridge_invoked'
  | 'bridge_frame_received'             // streaming text output frame
  | 'bridge_completed'
  | 'bridge_failed'

  // Stakeholder model (multi-stakeholder directives)
  | 'stakeholder_state_recorded'
  | 'stakeholder_interaction_edge'
  | 'stakeholder_alignment_observed'

  // Owner channel (Claude Code chat — the only human-in-the-loop surface)
  | 'owner_input_received'              // owner spoke; substrate logged the turn
  | 'owner_decision_recorded'           // owner answered a question / chose an option

  // External-service push (daemon ingress; see §5.2)
  | 'external_event_received'           // webhook / inbox poller / IoT subscription pushed data
  | 'external_source_quarantined'       // rate-limit or auth violation; source paused
  | 'external_source_rehabilitated'

  // Daemon lifecycle (see §5)
  | 'daemon_started'
  | 'daemon_shutdown'
  | 'daemon_index_rebuilt'              // emitted at boot after in-memory index restore

  // Substrate self-events
  | 'projection_checkpointed'
  | 'constitutional_gate_decision'
  | 'self_modification_recorded'
  | 'recipe_extracted'

  // Father (constrained scheduler events)
  | 'father_cycle_recorded'
  | 'father_yielded'

  // Lifecycle
  | 'goal_committed'
  | 'goal_abandoned';

type SubstrateOrigin =
  | 'claude_root' | 'claude_sub' | 'opencode' | 'recipe' | 'scheduler' | 'father' | 'substrate_auto' | 'owner';

type OutcomeStatus = 'pending' | 'succeeded' | 'failed' | 'abandoned' | 'rolling_active' | 'amended';

type FailureKind =
  | 'verification_high_residual'        // verifier returned residual above threshold
  | 'artifact_runtime_error'            // code artifact threw / timed out / OOMed
  | 'bridge_auth' | 'bridge_rate_limit' | 'bridge_timeout' | 'bridge_killed'
  | 'budget_exhausted'
  | 'prediction_miss'                   // |predicted_residual − residual| above threshold
  | 'sandbox_violation'                 // artifact tried to exceed declared sandbox
  | 'dag_cycle_detected'                // non-refinement cycle
  | 'upstream_failure'
  | 'concurrency_conflict'
  | 'governance_block'
  | 'stakeholder_conflict'              // multi-stakeholder utilities cannot reconcile
  | 'amendment_invalidates_prediction';

type TaskEdgeKind =
  | 'requires'
  | 'refines'
  | 'watches';
```

One table. Twelve event-kind groups. Everything else is a view.

### 4.2 Views (computed projections)

**Pure SQL views:**
- `directive_view(directive_id)` — root + status + lifecycle + urgency
- `task_graph_view(directive_id)` — DAG topology
- `ready_tasks_view` — `task_node_opened` whose upstreams all `task_committed`
- `task_critical_path_view(directive_id)` — edge-kind-aware longest chain
- `contradictory_candidates_view` — opposing knowledge candidates
- `failure_view` — `task_failed` grouped by failure_kind
- `active_inference_view` — residual stats per task-kind, substrate_origin
- `artifact_routing_view` — intent_shape → code artifact ranked by embedding × posterior (counts ALL invokers; see §11)
- `artifact_warning_view` — quarantined code artifacts with rehabilitation eligibility
- `model_routing_view` — `{sub_task_kind, model}` success rates
- `stakeholder_state_view(directive_id)` — current stakeholder utilities + interactions (U6)
- `directive_conflicts_view` — cross-directive interference edges (O6)
- `rolling_review_due_view` — directives whose next_review_due ≤ now (§3.1)
- `irreversible_effects_view(directive_id)` — physical-world side effects to date
- `embedding_index_view` — text-bearing events keyed by vector for nearest-K retrieval
- `code_artifact_registry_view` — current admitted artifacts ranked by posterior, sandbox shape, runtime
- `owner_conversation_view` — Claude Code chat turns indexed by directive

**Typed-extractor views (parser/indexer stages):**
- `knowledge_view` — Model D promotion extractor (see §7)
- `entities_view` — NER-style indexer
- `recipes_view` — trajectory extractor
- `provenance_view` — causal lineage walker

Each extractor lives in `v2/substrate/extractors.ts` (~80-200 LOC each).

### 4.3 The four-link chain — substrate owns it (closes `k_3582`, `k_3588`)

The system IS the RLM because the substrate (not any LLM) owns each step:

| Link | Who | Event kind |
|---|---|---|
| **create** | Any substrate_origin proposes | `knowledge_candidate` (with origin field) OR `code_artifact_candidate` |
| **retrieve** | Brain reads via judgment_packet_view at decision time | `context_refs` field on next `action_predicted` |
| **mutate** | Outcome event references | `candidate_confirmed` / `candidate_contradicted` / `action_scored` |
| **credit** | Substrate auto-promotes/demotes via extractor | `knowledge_promoted` / `knowledge_demoted` / `code_artifact_score_updated` (emitted by substrate, no LLM in loop) |

V1 falsifiability test: **swap the scheduler or either LLM substrate**, and credit emission still happens from substrate extractors. Posterior promotion is not in the model or the scheduler; it is in the substrate.

### 4.4 Concurrency contract (closes `k_3590`, `k_3591`, `k_3592`)

**Event-level writes:** SQLite WAL. Every event has ULID `id`. Append-only.

**View-level projections:** Idempotent SQL. Re-running produces identical results. `projection_checkpointed` events store materialized snapshots.

**Conflict semantics:**

| Artifact | Rule |
|---|---|
| `world_model.fleet` entry | last-committed-task-wins by `task_committed.ts`; older → `task_committed_superseded` |
| `capability_admitted` (same capability_name) | first-wins; rejection emits `capability_admission_rejected` |
| `knowledge_promoted` | extractor idempotent: same evidence → same promotion event id |
| `recipe_extracted` | idempotent: same trajectory shape → same recipe id |
| capability score update | monotonic merge — Beta-posterior summation across all invokers |
| stakeholder_state | latest-wins by ts; prior states retained as `stakeholder_state_superseded` |

**Mid-flight observation semantics:**

Default: **completed-task snapshot reads** (only `task_committed` upstream visible).

Watch-edge consistency modes:
- `monotonic` — observations grow, never retract
- `snapshot_now` — read at edge-open time
- `read_your_writes` — within own task (always)

**Idempotency rule:** `payload_hash` (sha256 of canonical payload). `(task_id, payload_hash)` deduplicated at write time. Different payloads emit distinct events; winner resolved per artifact type.

## 5. The Substrate Daemon — Always-On, Externally-Reachable

The substrate is not a SQLite file that CLI commands open per-invocation. It is a **persistent process** that holds the WAL connection, the in-memory embedding index, and the shared MCP server open for the lifetime of the system. The "cold start" problem disappears because the substrate is never cold: it is running before any directive arrives and stays running after it commits. External services (webhooks, email inboxes, calendar feeds, IoT subscriptions) push data INTO the substrate asynchronously; the brain reads what has accumulated rather than asking what is true at call time.

### 5.1 Process shape

```
┌──────────────────────────────────────────────────────────────────┐
│  v2/runtime/daemon.ts          (single bun process, supervisor)  │
│                                                                  │
│  ┌─────────────────────────┐  ┌──────────────────────────────┐   │
│  │  SQLite WAL             │  │  sqlite-vec embedding index  │   │
│  │  (persistent connection)│  │  (vec0 virtual table; on disk │  │
│  │                         │  │   alongside the WAL — NO      │   │
│  │                         │  │   in-memory rebuild at boot)  │   │
│  └─────────────────────────┘  └──────────────────────────────┘   │
│                                                                  │
│  ┌─────────────────────────┐  ┌──────────────────────────────┐   │
│  │  Shared MCP server      │  │  External-push ingress       │   │
│  │  (HTTP/SSE on local     │  │  (HTTP webhook endpoint;     │   │
│  │   port; both Claude     │  │   pluggable inbox pollers)   │   │
│  │   Code and opencode     │  │                              │   │
│  │   connect as clients)   │  │                              │   │
│  └─────────────────────────┘  └──────────────────────────────┘   │
│                                                                  │
│  ┌─────────────────────────┐  ┌──────────────────────────────┐   │
│  │  Background workers:    │  │  Father scheduler tick       │   │
│  │   - embedder            │  │  (in-process; reads          │   │
│  │   - posterior updater   │  │   rolling_review_due_view;   │   │
│  │   - recipe extractor    │  │   no separate process)       │   │
│  │   - quarantine ager     │  │                              │   │
│  └─────────────────────────┘  └──────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
                            ▲
                            │   port lock + Unix socket
                            ▼
                ┌──────────┴───────────┐
                │   `acc` CLI commands │
                │   (thin RPC client)  │
                └──────────────────────┘
```

The daemon is **single-instance** via a port lock (`V2_DAEMON_PORT`) and a Unix-domain socket (`~/.accint/v2.sock`). A second-instance attempt fails fast with the existing PID. The `acc` CLI becomes a thin RPC client over the socket — every `acc state ...`, `acc task ...`, `acc watch` call routes to the daemon. No CLI command opens SQLite directly.

### 5.2 External-service push

The daemon exposes a webhook endpoint (`POST /external/push`) authenticated by an owner-provisioned token. Any external service can push an event:

```json
POST /external/push
Authorization: Bearer <owner-token>
{
  "source": "calendar.google.com" | "email" | "github_webhook" | "telegram" | "iot:home" | ...,
  "kind": "external_event_received",
  "payload": { /* opaque to substrate; embedded for retrieval */ },
  "sensitivity_classification_hint": "public" | "internal" | "private"
}
```

The daemon ingests, emits an `external_event_received` event, embeds the text payload, and indexes it. The next brain dispatch retrieving by embedding will see the new data without any cold-start re-scan. The owner does not have to ask "what came in" — Father's recurring cycle observes the inflow and may open a `directive_opened` event in response if a watch rule matches (e.g. "if an email from X arrives, open a follow-up directive").

**Concrete external-source examples** (Phase B seed integrations; the owner enables each per-source by minting a bearer token):

| Source | Trigger | `payload` shape | Typical Father watch rule |
|---|---|---|---|
| `calendar.google.com` | Inbound webhook on new/updated event | `{ event_id, title, start_iso, end_iso, attendees[], description, location }` | `if event.title matches "<keyword>" → open directive "prepare for <event>"` |
| `email` (IMAP-poll or webhook from a mail processor) | New message in monitored inbox | `{ message_id, from, to[], subject, body_text, body_html, attachments_blob_refs[], received_iso }` | `if from in watch_senders AND subject_matches → open follow-up directive` |
| `github_webhook` | PR opened / review requested / CI status / issue assigned | `{ event_type, repo, pr_number, actor, title, body, head_sha, ci_state? }` | `if pr_review_requested AND assignee=self → open directive "review PR"` |
| `slack_webhook` (or equivalent) | Mention in monitored channel / DM | `{ channel, user, text, thread_ts, mentions[] }` | `if direct_mention → record owner_input_received; if channel in priority_set → embed and surface in next dispatch` |
| `bank` (Plaid-style poller or owner-pushed) | New transaction or balance change | `{ account_id, txn_id, amount, merchant, category, posted_iso, balance_after }` | `if amount > threshold → open directive "review unusual transaction"` |
| `iot:home` (e.g. Home Assistant push) | Sensor reading or device event | `{ device_id, kind: 'temperature'|'motion'|'door'|..., value, unit, ts }` | `if door_opened AND mode=away → open directive "verify entry"` |
| `health` (e.g. Apple Health / Fitbit export or owner-pushed) | Daily summary or anomaly | `{ source, metric: 'hrv'|'sleep'|'steps'|..., value, baseline, deviation_z, period }` | `if deviation_z > 2 → embed and surface in next rolling-active health directive` |
| `fs_watch` (local-filesystem inotify) | File created/modified under watched path | `{ path, op: 'create'|'modify'|'delete', size, mtime }` | `if path matches "<project>/inbox/*" → open directive "ingest new artifact"` |

Each source is registered via `substrate.register_external_source({ name, bearer_token, schema_hint, rate_limit_per_min, default_sensitivity })`. The daemon validates inbound payloads against the registered `schema_hint`, rate-limits per source, and quarantines a source that breaches its rate limit or fails repeated auth.

### 5.3 Crash recovery

SQLite WAL guarantees durability up to the last fsync. On daemon restart:
1. Acquire the port lock + Unix socket.
2. Open the WAL connection; verify integrity.
3. The embedding index is the **sqlite-vec `vec_events` virtual table** (substrate/schema.sql) — persistent on disk alongside the WAL. There is NO in-memory rebuild step; the index is queryable the moment the WAL connection is open. The legacy `events.embedding` BLOB column is kept transitionally for parity testing during the cutover window (see substrate/schema.sql header comment) and the `EmbeddingIndex` wrapper backfills `vec_events` from it at first open.
4. Re-arm the background workers (embedder catches up on any payloads emitted after the last `embedding_computed` for them; posterior updater catches up on any `action_scored` events emitted after the last `code_artifact_score_updated`).
5. Resume MCP server + external-push endpoint.

The CLI's RPC client retries against the new socket transparently. In-flight brain dispatches (opencode subprocesses) are unaffected by daemon restart since they emit through their own SQLite connection; the daemon only owns the in-memory caches.

### 5.4 Retrieval state — empty / seeded / warm

The daemon's retrieval behavior still depends on substrate maturity:

| Mode | When | Behavior |
|---|---|---|
| **empty** | Fresh substrate, zero events | `judgment_packet_view` returns `[]`; `code_artifact_registry_view` returns seed artifacts; recipes disabled until ≥ N successes; brain prompt falls back to runtime descriptions only |
| **seeded** | Foundational seed import done (optional, curated) | Promoted laws + score ≥ 0.85 entries imported as `knowledge_candidate` + `knowledge_promoted` with `substrate_origin = substrate_auto`; artifacts still seed-only; recipes still disabled |
| **warm** | ≥ 100 successful task commits across ≥ 5 distinct goal shapes | Full retrieval; recipes enabled; brain-emitted code-artifact candidates accepted; artifact routing posteriors trusted |

Seeded mode is OPTIONAL. NOT a migration. Curated event insertion with synthetic provenance. Owner approves seed list before import. The daemon is the same daemon in all three modes — only the projection content differs.

### 5.5 Runtime supervision and timeouts

Every code-artifact invocation spawns a runtime subprocess (bun script, uv-managed Python process, or a chromium-driving camofox session). Subprocesses misbehave: they hang on network calls, leak memory, refuse SIGTERM, or simply take longer than declared. The daemon supervises each subprocess against the sandbox declaration's `wall_ms` + `cpu_ms` + `memory_mb` budgets plus a hard-stop watchdog:

| Subprocess kind | Soft timeout signal | Hard timeout signal | Watchdog interval | Special handling |
|---|---|---|---|---|
| **bun script** | SIGTERM at `wall_ms` | SIGKILL at `wall_ms × 1.25` | every 250 ms | None — bun honors SIGTERM cleanly. |
| **uv Python** | SIGTERM at `wall_ms` | SIGKILL at `wall_ms × 1.5` (Python can be slow to unwind) | every 500 ms | Run under nsjail; nsjail's own `--time_limit` is the floor; outer watchdog is the ceiling. |
| **camofox chromium** | `session.close()` graceful at `wall_ms` | `proc.kill('SIGKILL')` at `wall_ms × 2` (chromium hung-page recovery is slow) | every 1 s | If chromium fails to exit after SIGKILL, the supervisor detaches the profile root and spawns a fresh chromium on next invocation; the previous PID is reaped via process-group teardown. Profile is marked `profile_quarantine_pending` and a recovery task is queued to verify integrity. |
| **opencode subprocess** (brain dispatch) | SIGTERM at task budget | SIGKILL at task budget × 1.5 | every 1 s | Closure-of-dispatch is handled by `task_dispatcher.ts` (§3.7); watchdog is the fallback for a hung opencode. |

The watchdog emits one event per state transition:
- `runtime_subprocess_started` — pid + sandbox decl recorded.
- `runtime_subprocess_resource_warning` — at 80% of any budget (wall, cpu, memory).
- `runtime_subprocess_soft_terminated` — SIGTERM sent because soft timeout hit.
- `runtime_subprocess_hard_killed` — SIGKILL sent because soft timeout didn't drain.
- `runtime_subprocess_orphaned` — pid couldn't be reaped after SIGKILL; orphan tracker takes ownership and retries reap every 5 s.
- `runtime_subprocess_completed` — clean exit; resource summary recorded.

A subprocess that triggers `runtime_subprocess_hard_killed` or `runtime_subprocess_orphaned` increments the source code artifact's `recent_kill_count`. If `recent_kill_count ≥ 3` within a 30-day rolling window, the artifact auto-quarantines (§11.6) until owner override or admission re-fixture. State-root contention on the camofox profile is recovered by re-spawning chromium; the brain's next dispatch sees a fresh session.

Runtime supervision lives in `v2/runtime/sandbox.ts` (the policy layer) + `v2/runtime/daemon.ts` (the watchdog ticks) + each `v2/runtime/runtimes/<runtime>.ts` (the subprocess-specific signal handling). This is the missing implementer-grade detail beneath §5.1's single-process supervisor claim.

### 5.6 Substrate liveness invariant — live at boot

A fresh `acc init` followed by `acc daemon start` must produce a **LIVE** substrate, not a partially-populated shell that is technically "running" but starves the RLM surface. The bug class this closes: a freshly-installed daemon ticks happily while `substrate.search` returns nothing because no event has an embedding, no recipe priors exist, and no code artifact has been admitted yet — the brain's first dispatch runs without retrieval context and the RLM mechanism is dead before the system ever observes a real task.

**The invariant (enforced structurally, not by convention):**

1. **After `acc init`** — every canonical table/view has at least one row:
   - `events` ≥ 10 (foundational knowledge seed, owner-approved at install time)
   - `code_artifact` ≥ 8 (seed code artifacts: bun / uv / camofox-browser runtime entries)
   - `events` (recipe_extracted) ≥ 2 (canonical priors for repeated goal shapes: "fetch URL title" + "arithmetic")
   - `vec_events` > 0 (synchronous embedder pass over the seeded events)
2. **After `acc daemon start`** — the embedder worker ticks within 10s and produces `embedding_computed` events. Any embeddable event written after the synchronous boot pass (owner directives, brain candidates) lands in `vec_events` on the next tick.
3. **`acc doctor` PASS implies substrate is ALIVE.** The composite check now includes the substrate-content verdict surfaced by `acc admin substrate-status`. A PASS means events > 0 AND code_artifact > 0 AND vec_events > 0.
4. **The harness `--task` mode inherits the same liveness invariant** via the shared init + startDaemon path. A scenario that boots a substrate for an integration test sees the same seeded baseline a real operator install sees.

**Verdict taxonomy (`acc admin substrate-status`):**

| Verdict | Meaning | Recovery |
|---|---|---|
| **ALIVE** | events > 0 AND code_artifact > 0 AND vec_events > 0 | Substrate is ready; RLM surface populated |
| **DEGRADED** | events > 0 but vec_events == 0 or code_artifact == 0 | Run `acc admin embed-all` (closes vec_events gap) or re-run `acc init` to re-seed artifacts |
| **DEAD** | events == 0 | Substrate has never been seeded; run `acc init` |

**Operator-facing surfaces:**

- `acc admin substrate-status` — single-screen ALIVE/DEGRADED/DEAD report with per-table counts, freshness (latest event ts, oldest unembedded ts), and the seed-vs-brain-authored artifact split.
- `acc admin embed-all` — synchronous one-shot embedder pass. Refuses while the daemon is running (would race the embedder worker — operator must `acc daemon stop` first). Idempotent: a second call with no pending rows is a cheap no-op.

**Implementation surfaces:**

- `runtime/embedder.ts::embedPendingEvents(db)` — public synchronous batch embedder. Drains every event where `kind ∈ EMBEDDABLE_KINDS AND embedding IS NULL` through the existing batch-of-100 OpenAI request path; emits `embedding_skipped_missing_api_key` (one row, carrying the pending count) when `OPENAI_API_KEY` is unset and returns `{embedded: 0, skipped: N, failed: 0}` rather than throwing.
- `substrate/seed.ts::seedRecipes(db)` — canonical Tier-0 priors for "fetch URL title" + "arithmetic". Seeds at confidence=0.7 (above replay threshold 0.6, below the "promoted" mark) so they're elective from cycle one but decay quickly if reality contradicts them (failed replay −0.10, auto-archive < 0.2). Each recipe references real seed artifact ids so `runArtifactByRuntime` in replay can resolve them.

The synchronous boot pass is what separates "DEGRADED, daemon is running but substrate is dead" from "ALIVE, retrieval is populated". `acc init` step 7 (post-seed) calls `seedRecipes(db)` and then `await embedPendingEvents(db)` so the synchronous handoff to `acc daemon start` cannot leave the substrate in DEGRADED.

## 6. The Universal `act` Primitive

The brain expresses **intent + an action code artifact + a verifier code artifact + predicted residual**. The substrate runs both in sandboxed runtimes; the verifier's scalar return is the residual. There is no discrete capability menu and no typed predicate lattice — the universal mechanism is code-as-capability.

```typescript
type ActionRequest = {
  intent: string;                       // natural language description (for retrieval + audit)
  action_artifact_id: string;           // code artifact the substrate executes
  verifier_artifact_id: string;         // code artifact returning a scalar residual in [0,1]
  predicted_residual: number;           // brain's prior on how close the action will land
  budget?: { wall_clock_ms?: number; max_tokens?: number };
};

async function act(request: ActionRequest): Promise<ActionResult> {
  // 1. Predict before acting
  const predictedEventId = substrate.emit({
    kind: 'action_predicted',
    payload: { intent, action_artifact_id, verifier_artifact_id, predicted_residual },
  });

  // 2. Run the action artifact in its declared runtime (bun | uv | camofox-browser).
  //    The substrate-managed sandbox enforces capability-declared permissions on the
  //    runtime itself — not on per-action whitelists.
  const observation = await substrate.run_artifact(request.action_artifact_id, request.budget);

  // 3. Record irreversible effect if the artifact declared one
  if (observation.irreversible_effects?.length) {
    substrate.emit({
      kind: 'irreversible_effect_recorded',
      payload: { effects: observation.irreversible_effects },
      context_refs: [predictedEventId],
    });
  }

  // 4. Run the verifier artifact against the observation. Verifier returns a scalar in [0,1].
  //    No predicate lattice; verification is just a code call returning a number.
  const residual = await substrate.run_verifier(request.verifier_artifact_id, observation);

  // 5. Credit the action artifact, the verifier artifact, and all knowledge entries
  //    cited by either artifact via posterior update on (predicted_residual − residual).
  substrate.credit({
    action_artifact_id: request.action_artifact_id,
    verifier_artifact_id: request.verifier_artifact_id,
    predicted: request.predicted_residual,
    observed: residual,
  });

  return { observation, residual, events_emitted };
}
```

Verification is just another `act()`. The verifier IS a code artifact. Its sandbox, posterior, embedding, and LATM promotion path are identical to any other code artifact. A verifier that performs well across many directives gets promoted to a named reusable verifier the same way an action artifact gets promoted to a named capability — same merger, same substrate.

### 6.1 Three substrate runtimes — bun, uv, camofox-browser

The substrate hosts THREE code runtimes. The brain writes code for whichever runtime fits the intent. There is no typed predicate lattice and no curated capability menu — the runtime is the abstraction.

| Runtime | Language | What the brain writes for it | Sandbox grammar |
|---|---|---|---|
| **bun** | TypeScript | scripts that call the substrate API, fetch HTTP, do arithmetic, compose text | `fs.read_globs`, `fs.write_globs`, `net.allow_domains`, `proc.allow_subprocesses`, `db.allow_tables` |
| **uv** | Python | scripts that need numpy / pandas / scikit / PIL / any pypi package; image processing; sensor parsing | `fs.read_globs`, `fs.write_globs`, `net.allow_domains`, `pypi.allow_packages` |
| **camofox-browser** | TypeScript (camofox API) | scripts that drive a real chromium session — page navigation, form fill, click, extract, screenshot | `browser.allow_domains`, `browser.profile_root`, `browser.allow_downloads_to` |

Camofox-browser is a runtime, not a discrete capability. The brain doesn't pick from `camofox.click` / `camofox.fill` / `camofox.extract` — it writes a script that uses the camofox API directly:

```typescript
// action_artifact (camofox-browser runtime)
import { session } from 'camofox';
const s = await session.open({ profile: 'main' });
await s.goto('https://example.com/contact');
await s.fill('#email', OWNER_CONTACT_EMAIL);
await s.fill('#message', INTENT_BODY);
await s.click('button[type=submit]');
return { confirmation_text: await s.text('.confirmation'), final_url: s.url };
```

```typescript
// verifier_artifact (bun runtime) — returns scalar residual in [0,1]
import { observation } from '@substrate/in';
const ok = observation.confirmation_text.toLowerCase().includes('thanks') &&
           observation.final_url.includes('/contact/thanks');
return ok ? 0 : 1;
```

That is the universal pattern. Browser, system, data, math, parsing — all the same: brain writes code, substrate runs it in a sandboxed runtime, verifier code returns a scalar.

### 6.2 Residual is a scalar — verifier output

The verifier returns a number in [0,1] where 0 = predicted matches observed and 1 = maximal disagreement. There are no per-intent-kind residual adapters. The brain writes the verifier; the residual IS the verifier's return value.

This collapses what was previously twelve typed adapters into one universal mechanism. Verifiers can be arbitrarily smart — they can embed-and-cosine, they can read another substrate event, they can spawn another runtime call — but their output shape is always one scalar. The substrate stores it, posterior-updates against the brain's `predicted_residual`, and moves on.

## 7. Substrate-Synthesized Knowledge Merger (Model D, U2)

Both LLMs (Claude root, Claude sub, opencode) propose `knowledge_candidate` events into one shared posterior space. Candidate clustering is keyed by goal-shape semantic claim + target resource/domain + anchor set, with `substrate_origin` / `llm_source` retained as evidence provenance rather than ownership. When distinct origins agree on the same key, the extractor attaches corroborating evidence and promotes or synthesizes one canonical row with a combined posterior_alpha update. When distinct origins conflict on the same key, the extractor emits `contradictory_candidates` for adjudication instead of silently choosing a source-local winner. Substrate auto-promotes via outcome correlation.

Grounded world-model claims are knowledge candidates unless a later measured need proves otherwise. A candidate may predict what will happen, assert a causal mechanism, estimate hidden state, name a validity horizon, and later cite observations that calibrate it. This keeps world modeling provisional and posterior-scored: the substrate records claims about resources, people, environments, organizations, and software as falsifiable event payloads, then moves their posteriors when `action_scored`, `artifact_observed`, `owner_input_received`, or other evidence confirms or contradicts them.

### 7.1 Candidate proposal

Any session emits:

```typescript
substrate.emit({
  kind: 'knowledge_candidate',
  substrate_origin: 'claude_root' | 'claude_sub' | 'opencode',
  payload: {
    claim: 'falsifiable claim text',
    evidence: [evidence_event_ids_or_observations],
    applies_to: ['goal-shape or resource tag'],
    confidence_estimate: 0.7,

    // Optional world-model fields. Keep them open-ended; do not add a new
    // event kind until verifier outcomes show this shape cannot be represented
    // as scored knowledge.
    predicted_outcome: 'what the claim expects to happen',
    causal_claim: 'why the outcome should happen',
    hidden_state_estimate: { /* resource/person/environment/org/software state */ },
    validity_horizon: 'time, version, situation, or condition where claim expires',
    later_observation_refs: [],
    calibration_residual: null,
  },
});
```

### 7.2 Substrate promotion (SQL extractor)

```sql
WITH candidate_outcomes AS (
  SELECT c.id, COALESCE(c.payload->>'claim', c.payload->>'text') AS claim, c.substrate_origin,
         COUNT(CASE WHEN o.kind = 'candidate_confirmed' THEN 1 END) AS wins,
         COUNT(CASE WHEN o.kind = 'candidate_contradicted' THEN 1 END) AS losses
  FROM events c
  LEFT JOIN events o ON c.id = ANY(o.context_refs)
  WHERE c.kind = 'knowledge_candidate'
  GROUP BY c.id
)
SELECT id, claim, substrate_origin, wins, losses,
       beta_posterior(wins, losses) AS score
FROM candidate_outcomes
WHERE score >= 0.85 AND wins >= 5;
-- Idempotent emitter: INSERT knowledge_promoted (dedup by candidate_id + score_bucket).
```

Demotion symmetric: `score ≤ 0.3 AND losses ≥ 5`.

### 7.3 Cross-validation

`contradictory_candidates_view` surfaces opposing candidates. Brain may use one (outcome resolves), spawn evidence-gathering, or surface to owner.

### 7.4 Why this is the cleanest merger

- Reality is the canonical scorer (k_555)
- Neither LLM judges its own work (k_252)
- Cross-model validation built in
- Substrate is an active synthesizer
- Both subscriptions are first-class contributors
- Lineage preserved via `derived_from`

## 8. DAG Goals with Refinement Edges

(F2; closes `k_3583`, `k_3589`, `k_3597`.)

Three edge types:
- `requires` — hard dependency
- `refines` — refinement loop (graph-native rework)
- `watches` — soft dependency (opt-in mid-flight reads)

Plus interference edges across directives (§3.4) and stakeholder interaction edges (§3.3).

### 8.1 Refinement example

```typescript
// t_email_compose failed
substrate.emit({ kind: 'task_node_opened', payload: { task_id: 't_email_compose_v2', goal: 'compose email, subject ≤ 60 chars' } });
substrate.emit({ kind: 'task_edge_recorded', payload: { from: 't_email_compose_v2', to: 't_email_compose', kind: 'refines' } });
```

Cycle detector allows refinement edges; only non-refinement cycles emit `dag_cycle_detected`. Closure rules: task resolved if no incoming `refines` AND outcome=succeeded, or latest refining task succeeded.

## 9. Async Parallel Execution

(F3; closes `k_3584`, `k_3592`, `k_3598`.)

### 9.1 Scheduler (`v2/runtime/task_scheduler.ts`, ~150 LOC)

```typescript
async function schedulerLoop(): Promise<void> {
  while (!stopRequested()) {
    const ready = await substrate.read('ready_tasks_view', { limit: CONCURRENCY_LIMIT });
    const claimed = await Promise.all(ready.map(task => claimAndDispatch(task)));
    await waitForAnyCompletion(claimed);
  }
}
```

Concurrency cap default 5-10; in crisis mode raised to 20 (§3.5).

### 9.2 Dispatcher (`v2/runtime/task_dispatcher.ts`, ~200 LOC)

```typescript
async function dispatchClaudeCodeSession(task: ReadyTask): Promise<TaskResult> {
  const prompt = await composeTaskPrompt({
    task_goal: task.payload.goal,
    upstream_outputs: await substrate.read_upstream_observations(task.id, task.requires),
    watched_outputs: await substrate.read_watch_observations(task.id, task.watches),
    judgment_packet: await substrate.judgment_packet_view(task.payload.goal),
    code_artifact_registry: await substrate.code_artifact_registry_view(task.payload.goal),
    stakeholder_state: task.directive.is_multi_stakeholder
      ? await substrate.stakeholder_state_view(task.directive_id) : null,
    constitutional_state: await substrate.constitutional_state_view(),
  });

  return claudeCodeSession.run(prompt, {
    tools: V2_TOOLS,
    task_id: task.id,
    on_event: (e) => substrate.emit({ ...e, task_id: task.id, loop_id: session.id }),
  });
}
```

### 9.3 Topology (`v2/runtime/task_topology.ts`, ~80 LOC)

DAG analysis: cycle detection (refinement-aware), critical path, ready-set. Pure functions.

### 9.4 Consistency contract

Default `requires` reads only `task_committed`. `watches` opts into typed consistency (monotonic / snapshot_now / read_your_writes).

## 10. Universal Goal Walkthroughs

(U3 — same workflow for all domains.)

### 10.1 Self-improvement — the system improving itself (worked example)

Directive: *"Improve the daemon's HNSW index rebuild speed at boot — current rebuild is ~12s on a substrate of ~50k embedded events."*

```
DAG decomposition (brain dispatches once, emits this DAG):

  t_baseline_measure
    action_artifact: bun script that runs `daemon --measure-boot-only` 5 times,
                     emits per-run wall-clock + memory profile to substrate.
    verifier_artifact: bun script — residual = 0 if 5 runs completed AND
                       variance < 15%; else residual = variance_ratio.
    predicted_residual: 0.1

  t_research_index_alternatives (requires: t_baseline_measure)
    action_artifact: bun script that queries substrate.search("HNSW index
                     parallel rebuild")  AND fetches relevant prior art via
                     web_search seed artifact; emits research summary.
    verifier_artifact: bun script — residual = 0 if ≥ 3 distinct candidate
                       approaches captured with citation; else 1.
    predicted_residual: 0.2

  t_propose_change (requires: t_research_index_alternatives)
    action_artifact: bun script that writes a candidate v2/runtime/embedding_index.ts
                     under a feature flag (parallel batch load + HNSW.M tuning); emits
                     code_artifact_candidate for the new module.
    verifier_artifact: bun script — residual = 0 iff
                       (a) the file compiles under bun --check
                       AND (b) all existing v2/tests/embedding_index.test.ts pass.
    predicted_residual: 0.3

  t_ab_test (requires: t_propose_change; refines: t_baseline_measure)
    action_artifact: bun script that runs the daemon under each variant 5x,
                     emits per-variant wall-clock + memory + retrieval-precision-at-K.
    verifier_artifact: bun script — residual = 1 - (improvement_ratio); 0 means
                       new variant is at least 30% faster with no retrieval-precision
                       regression; 1 means no improvement or precision regressed.
    predicted_residual: 0.4
    refinement_rule: if residual > 0.5 AND ≥ one candidate approach unexplored,
                     emit refinement edge back to t_research_index_alternatives
                     with the explored-set excluded.

  t_owner_decision (requires: t_ab_test)
    action_artifact: bun script that emits a summary owner_input_required event
                     with: baseline metrics, new variant metrics, recommended action,
                     reversion procedure.
    verifier_artifact: bun script — residual = 0 if owner_decision_recorded event
                       lands within 24h; else residual = age_hours / 24.
    predicted_residual: 0.0 (owner is conversational)

  t_apply_or_revert (requires: t_owner_decision)
    action_artifact: bun script that either commits the new module OR reverts;
                     emits self_modification_recorded with before/after metrics.
    verifier_artifact: bun script — residual = 0 if the chosen action completed
                       cleanly AND a fresh daemon boot validates the choice.
    predicted_residual: 0.05
```

What this walkthrough demonstrates concretely:

- **No typed verification labels.** Every node has an action code artifact and a verifier code artifact; verification is whatever code the brain wrote. Residual is a scalar.
- **Refinement edges replace iteration.** If the A/B test doesn't show improvement, t_ab_test emits a refines edge back to t_research_index_alternatives — the next single-cycle dispatch on that node picks up with the explored-set excluded, not by re-prompting the same brain.
- **Code artifacts compound.** When this run succeeds, the substrate accumulates `code_artifact_candidate` rows for the new bun scripts (the index variant, the A/B harness, the boot-measurement script). Future self-improvement directives on similar shapes will retrieve these artifacts via embedding × posterior and reuse them — no fresh authoring needed.
- **Knowledge feeds back.** The brain's research findings emit `knowledge_candidate` rows tying "parallel batch HNSW rebuild improves boot speed by N%" to the citation chain. On the NEXT self-improvement directive that touches embedding-index code, these knowledge entries surface in retrieval and shorten the research step.
- **Self-modification is observable.** The `self_modification_recorded` event ties before/after metrics + the new artifact id + the owner's decision into one row, audited by `provenance_view`.

This is what "self-as-target uses the same workflow as any external goal" means structurally: the directive is processed by the same DAG decomposition, the same act() primitive, the same verifier code artifacts, the same refinement edges, the same posterior compounding. There is no separate self-improvement subsystem.

### 10.2 Business outreach (browser-business)

```
DAG decomposition:
  t_define_ICP                                                       [verification: cited_evidence]
  t_discover_candidates (requires: t_define_ICP)                     [verification: composite (page_state + substrate_event count=20)]
  t_score_candidates (requires: t_discover_candidates)               [verification: semantic_match]
  t_research_top_5 (requires: t_score_candidates)                    // fans out to 5 parallel sub-tasks
  t_compose_emails (requires: t_research_top_5)
  t_send_emails (requires: t_compose_emails)                         [verification: composite (substrate_event email_sent_proof × 5)]
  t_track_responses (requires: t_send_emails; watches: ... monotonic) // long-horizon weeks
```

### 10.3 Research

```
t_survey_docs
t_identify_benchmarks (requires: t_survey_docs)
t_run_local_benchmark (requires: t_identify_benchmarks)              [verification: substrate_event]
t_analyze_results (requires: t_run_local_benchmark)
t_synthesize_claim (requires: t_analyze_results)
  // Emits knowledge_candidate
```

### 10.4 Creative

```
t_gather_session_history
t_identify_themes (requires: t_gather_session_history)
t_draft (requires: t_identify_themes)                                [verification: composite (semantic_match + owner_confirmation)]
t_revise (requires: t_draft; refines: t_draft if not approved)
t_finalize (requires: approved t_revise or t_draft)
t_track_aesthetic_reuse (watches: t_finalize)                        [verification: aesthetic_reuse] // long-tail measurement
```

### 10.5 Strategic decision (multi-stakeholder)

```
DAG decomposition:
  t_gather_evidence                                                  [verification: cited_evidence]
  t_enumerate_stakeholders (requires: t_gather_evidence)
    // emits stakeholder_state_recorded events for each party
  t_identify_options (requires: t_enumerate_stakeholders)
  t_analyze_each (requires: t_identify_options)                      // fan-out per option, per stakeholder
  t_synthesize_with_conflict_check (requires: t_analyze_each)        // reads stakeholder_state_view
  t_owner_consultation (requires: t_synthesize_with_conflict_check)  [verification: owner_confirmation]
  t_record_decision (requires: t_owner_consultation)
```

### 10.6 Health / legal / financial — normal directives, owner-judged

```
Directive: "Plan response to chronic back pain"
- lifecycle: rolling_active (chronic condition)

DAG decomposition:
  t_gather_history                       (verifier: substrate has ≥ N relevant history events)
  t_research_evidence_landscape          (verifier: ≥ K cited sources from distinct domains)
  t_summarize_options_for_owner          (verifier: summary covers options, evidence quality, trade-offs)
  t_owner_decides_next_step              (verifier: owner_decision event recorded via chat)
  t_track_symptoms (rolling, weekly)     (verifier: owner-supplied weekly observation events)
```

Health, legal, and financial directives go through the same machinery as anything else. The brain researches and summarizes; the owner — talking to Claude Code — makes the call. There is no licensed-expert routing protocol, no licensure-credentialed verifier, and no licensure-bound sensitivity gating in the substrate. Owners who want a doctor / lawyer / accountant call one outside the system and bring the result back into chat as new context, the same way they would for any other source.

### 10.7 Embodied (cooking / repair)

```
Directive: "Fix the leaky faucet"

DAG decomposition:
  t_diagnose (verification: physical_observation, witness_type: photo)
  t_acquire_parts (requires: t_diagnose)                             [verification: file_exists (receipt) OR substrate_event (delivery confirmed)]
  t_repair (requires: t_acquire_parts)                               [verification: physical_observation, witness_type: video, target: "faucet does not drip in 5 min observation"]
  t_verify (requires: t_repair; refines: t_repair if still leaks)    [verification: physical_observation × time interval]
```

Physical residuals captured via photo/video proof artifacts. Owner confirms or refinement-edge restarts repair.

### 10.8 Long-horizon (relationship / parenting / retirement)

```
Directive: "Improve relationship with partner over next 6 months"
- lifecycle: rolling_active
- review_cadence: weekly
- partial_commit_checkpoints: ['month_1_review', 'month_3_review', 'month_6_review']

DAG decomposition:
  t_baseline_relational_state                                        [verification: relational_panel, observers: [self, partner], window_days: 7]
  t_weekly_practice                                                  // recurring task, refines itself weekly
  t_monthly_review (cadence: monthly)                                [verification: relational_panel, observers: [self, partner], window_days: 30, partial_credit: 0.5]
  t_six_month_assessment                                             [verification: relational_panel, observers: [self, partner, therapist], partial_credit: 0.7]
```

Directive never closes; rolling reviews track progress. Multi-observer relational predicates score real outcomes over months. Amendments common as the relationship evolves.

### 10.9 Crisis response (emergency mode, §3.5)

```
Directive (urgency=crisis): "Server is down, customers cannot log in"

DAG decomposition (emergency mode adjusts):
  t_check_status_page                                                // 30s timeout
  t_check_recent_deploys (parallel)                                  // 30s timeout
  t_check_database_health (parallel)                                 // 30s timeout
  t_decide_action (requires: 3 above all attempted)                  // may dispatch even if not all complete
  t_apply_fix                                                        // logs irreversible_effect_recorded
  t_verify_recovery                                                  [verification: substrate_event service_health]
  t_postmortem (refines: t_apply_fix, lifecycle: finite, not crisis) // reconciles irreversible effects
```

Concurrency raised to 20; recipes preferred; LATM suspended.

**Same workflow, 9 domain classes.** The substrate compounds across them.

## 11. Action Surface — Three Runtimes, Code-as-Capability, Shared MCP

The substrate hosts THREE code runtimes — **bun**, **uv**, **camofox-browser** — and the brain writes code for whichever one fits the intent. There is no discrete capability menu. A "capability" in v2 is just a code artifact (with an embedding, a posterior, and a sandbox declaration) that has been promoted via the same merger that promotes any knowledge candidate.

### 11.1 Architecture — substrate runs the code, ONE MCP server exposes the runtimes

```
            ┌─────────────────────────────────────┐
            │  v2/runtime/runtimes/               │
            │  ─ bun.ts       (TS scripts)        │
            │  ─ uv.ts        (Python scripts)    │
            │  ─ camofox.ts   (browser scripts)   │
            │                                     │
            │  ─ sandbox.ts   (per-runtime perms) │
            │  ─ artifact_store.ts (code_artifact │
            │     table; posterior per artifact)  │
            └─────────────────────────────────────┘
                            ▲
                            │
                   v2/runtime/mcp_server.ts
                  (exposes three tools:
                   bun.run, uv.run, camofox.run
                   plus substrate.{read,save,
                   embed,search,credit})
                            │
                ┌───────────┴────────────┐
                │                        │
        ┌───────┴────────────┐  ┌────────┴──────────┐
        │  Claude Code       │  │  opencode         │
        │  (native MCP       │  │  (native MCP      │
        │   client)          │  │   client)         │
        │  invoker:          │  │  invoker:         │
        │  claude_root       │  │  opencode         │
        └────────────────────┘  └───────────────────┘
```

One MCP server. Two native MCP clients. Symmetric invocation. The posterior on a code artifact accrues regardless of who ran it.

### 11.2 The runtime invocation function

```typescript
type Runtime = 'bun' | 'uv' | 'camofox-browser';

type RuntimeInvocation = {
  artifact_id: string;          // code_artifact row to execute
  runtime: Runtime;             // must match artifact's declared runtime
  inputs: JsonValue;            // arguments handed to the script
  invoker: 'claude_root' | 'claude_sub' | 'opencode' | 'recipe' | 'father';
  task_id?: string;
  directive_id?: string;
  budget?: { wall_clock_ms?: number; memory_mb?: number };
};

async function substrate.run_artifact(inv: RuntimeInvocation): Promise<Observation> {
  const artifact = substrate.get_code_artifact(inv.artifact_id);
  if (!artifact) throw new ArtifactNotFound(inv.artifact_id);
  if (artifact.runtime !== inv.runtime) throw new RuntimeMismatch();

  // Sandbox is per-runtime: bun perms, uv perms, camofox perms.
  await sandbox.assertAllowed(inv.runtime, artifact.declared_perms);

  const invokeEventId = substrate.emit({
    kind: 'artifact_invoked',
    invoker: inv.invoker,
    payload: { artifact_id: inv.artifact_id, runtime: inv.runtime, inputs_hash: hash(inv.inputs) },
  });

  // Stateful artifacts (e.g. camofox session against a profile) queue on a per-state-root mutex
  const observation = artifact.state_root
    ? await mutex.acquire(artifact.state_root, () => runtimes[inv.runtime].exec(artifact, inv))
    : await runtimes[inv.runtime].exec(artifact, inv);

  substrate.emit({
    kind: 'artifact_observed',
    invoker: 'substrate_auto',
    payload: { artifact_id: inv.artifact_id, observation_hash: hash(observation) },
    context_refs: [invokeEventId],
  });

  return observation;
}
```

Verification uses the same function — verifier artifacts are just code artifacts whose return type is `{ residual: number }`. The substrate posts the residual back as a credit event against both the action artifact and the verifier, and against every knowledge_id cited by either.

### 11.3 Per-runtime sandbox declaration

The sandbox grammar is per-runtime, not per-action. The brain declares what its script needs from its runtime; the substrate enforces.

```typescript
type SandboxDecl =
  | { runtime: 'bun';
      fs_read?: string[];          // glob list
      fs_write?: string[];
      net_allow?: string[];        // domain list
      proc_allow?: string[];       // subprocess names
      substrate_access?: 'ro' | 'rw' | 'none';
      cpu_ms: number; wall_ms: number; memory_mb: number }
  | { runtime: 'uv';
      fs_read?: string[];
      fs_write?: string[];
      net_allow?: string[];
      pypi_allow?: string[];       // package allowlist (locked versions in v2/runtime/uv-locks/)
      cpu_ms: number; wall_ms: number; memory_mb: number }
  | { runtime: 'camofox-browser';
      browser_allow_domains: string[];
      browser_profile_root: string;
      browser_allow_downloads_to?: string;
      wall_ms: number; memory_mb: number };
```

Bun runs under Deno-style permissions (--allow-read, --allow-net, --allow-run). Uv runs under `nsjail` with a locked pypi mirror. Camofox runs in a long-lived chromium under a profile root the substrate owns. Declared-≠-actual at runtime → `sandbox_violation` event, immediate artifact quarantine.

### 11.4 Seed code artifacts (Phase B initial state)

| Artifact | Runtime | Sandbox shape | What it does | Initial score / conf |
|---|---|---|---|---|
| `substrate_read` | bun | substrate ro | Read events / projections by query | 0.95 / 0.95 |
| `substrate_save` | bun | substrate rw | Emit an event row | 0.95 / 0.95 |
| `substrate_embed` | bun | substrate rw + net to embedding service OR uv-local model | Compute + store embedding for text | 0.90 / 0.85 |
| `substrate_search` | bun | substrate ro | Embedding + posterior reranked retrieval | 0.90 / 0.85 |
| `agent_invoke` | bun | proc allow (claude/opencode) | Spawn sub-agent for a sub-directive | 0.85 / 0.75 |
| `web_search` | bun | net allow `google.serper.dev` | Serper.dev wrapper | 0.80 / 0.70 |
| `web_fetch_and_parse` | bun | net allow `*` (declared per directive) | HTTP fetch + readability extract | 0.75 / 0.70 |
| `browser_session_act` | camofox-browser | browser allow declared domains | Open chromium against a profile, do a sequence of page operations | 0.75 / 0.65 |
| `shell_run` | bun | proc declared | Spawn a subprocess with declared argv | 0.80 / 0.70 |
| `py_run` | uv | pypi allow declared | Run a Python snippet under nsjail with declared dependencies | 0.75 / 0.70 |

Internal runtime libraries (`v2/runtime/env`, `v2/runtime/state`) are imported as modules, not registered as artifacts. Pywebflow is gone — the camofox-browser runtime supersedes it.

### 11.5 Authoring loop (LATM / Voyager via code_artifact promotion)

The substrate does not gate authoring with a special admission protocol. New code artifacts enter the substrate just like any knowledge candidate: the brain emits a `code_artifact_candidate` event with the script body, declared sandbox, runtime, and a small fixture (input + expected residual). The substrate runs the fixture once at admission time; if the verifier returns residual < 0.2, the candidate is admitted at `score = 0.5, confidence = 0.3` and begins accumulating posterior over real invocations.

Repeated successful use is the only path to "blessed reusable capability" — the substrate auto-names an artifact once its posterior crosses `score ≥ 0.85 ∧ confidence ≥ 0.7 ∧ ≥ 20 invocations`. Naming is purely a label for retrieval; the artifact's score, sandbox, and embedding are unchanged. This is the LATM/Voyager promotion path expressed in the same merger machinery that promotes knowledge candidates (§7).

### 11.6 Quarantine + rehabilitation

Same as before, but applied to code artifacts:
- 30-day rolling residual mean > 0.6 (with ≥ 10 invocations) → quarantine
- 5 consecutive `sandbox_violation` events → quarantine
- Owner explicit quarantine event
- Rehabilitation requires a 14-day cooldown, re-running the admission fixture, and 10 controlled successful invocations.

## 12. Bridge — opencode Subprocess (Simple Text Transport)

(O2.)

The bridge is simple: spawn opencode subprocess, give it a prompt, capture its text response. **Opencode connects to the substrate's MCP server natively** (not through the bridge) — capability invocations from opencode flow through MCP, not through bridge stream parsing. The bridge is purely for the opencode text response when Claude calls `Agent`-style for GPT-5/GPT-5-mini reasoning.

Claude Code uses the same separation when acting as the owner conversation surface: MCP carries substrate/runtime invocations, while hooks, settings, slash commands, SDK sessions, and chat output are observation or ingress surfaces that must be normalized into ledger rows. The observer must render background work from ledger state, not terminal scrollback: prompt/message/reasoning rows are capped, cap suppression is surfaced as `at_cap`, stale detection compares last observation time against terminal lifecycle rows and process liveness when available, and slash-command intent still enters the owner_input_received/directive_opened dispatch loop.

```typescript
type OpenCodeRequest = {
  prompt: string;
  model: 'gpt-5' | 'gpt-5-mini';
  max_tokens?: number;
  stream?: boolean;
  timeout_ms?: number;
  budget_tokens?: number;
  retries?: number;
};

type OpenCodeFrame =
  | { kind: 'started'; pid: number }
  | { kind: 'stdout_chunk'; text: string; sequence: number }
  | { kind: 'stderr_chunk'; text: string }
  | { kind: 'completed'; exit_code: 0; final_response: string; usage: TokenUsage }
  | { kind: 'failed'; exit_code: number; reason: BridgeFailureReason };

type BridgeFailureReason =
  | { kind: 'auth_missing'; detail: string }
  | { kind: 'auth_expired'; detail: string }
  | { kind: 'rate_limit'; retry_after_ms: number }
  | { kind: 'timeout'; ms_elapsed: number }
  | { kind: 'process_killed'; signal: string }
  | { kind: 'subprocess_crash'; stderr_tail: string }
  | { kind: 'parse_error'; raw: string };

async function opencode_query(req: OpenCodeRequest): Promise<OpenCodeFrame[]> {
  const invokeEventId = substrate.emit({
    kind: 'bridge_invoked',
    payload: { prompt_hash: hash(req.prompt), model: req.model },
  });

  // Spawn opencode with MCP server config so it connects to our capability broker
  const proc = Bun.spawn(['opencode', '--model', req.model, '--no-interactive', '@-'], {
    stdin: req.prompt,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: req.timeout_ms ?? 60_000,
    env: {
      ...process.env,
      OPENCODE_BUDGET: String(req.budget_tokens ?? 50_000),
      MCP_SERVER_URL: process.env.V2_MCP_SERVER_URL,  // opencode uses native MCP to reach capability broker
    },
  });

  const frames: OpenCodeFrame[] = [{ kind: 'started', pid: proc.pid }];
  let stdoutBuffer = '';

  for await (const chunk of proc.stdout) {
    const text = new TextDecoder().decode(chunk);
    stdoutBuffer += text;
    frames.push({ kind: 'stdout_chunk', text, sequence: frames.length });
    substrate.emit({ kind: 'bridge_frame_received', context_refs: [invokeEventId], payload: { text } });
  }

  const exitCode = await proc.exited;
  if (exitCode === 0) {
    const final = parseFinalResponse(stdoutBuffer);
    frames.push({ kind: 'completed', exit_code: 0, final_response: final.text, usage: final.usage });
    substrate.emit({
      kind: 'bridge_completed',
      context_refs: [invokeEventId],
      payload: { final_response: final.text, usage: final.usage, frames_count: frames.length },
    });
  } else {
    const reason = classifyFailure(exitCode, stderrText);
    frames.push({ kind: 'failed', exit_code: exitCode, reason });
    substrate.emit({
      kind: 'bridge_failed',
      context_refs: [invokeEventId],
      failure_kind: failureKindFor(reason),
      payload: { reason, exit_code: exitCode },
    });
    if (req.retries > 0 && isRetryable(reason)) return opencode_query({ ...req, retries: req.retries - 1 });
  }

  await ensureProcessGroupReaped(proc.pid);
  return frames;
}
```

### 12.1 How opencode uses capabilities (native MCP, NOT through bridge)

When opencode is spawned, the environment includes `MCP_SERVER_URL` pointing to v2's MCP server. Opencode's native MCP client connects on startup, discovers available tools (the substrate-resident capabilities), and uses them just as Claude does — through standard MCP tool calls. The bridge sees opencode's TEXT response only; capability invocations are direct opencode→MCP_server→substrate, with `invoker: 'opencode'` tagged on each `capability_invoked` event.

This means:
- No `<<CAPABILITY>>` marker parsing
- No bidirectional stdin/stdout interception
- No `bridge_capability_request` / `bridge_capability_result_spliced` events
- The capability mutex (per state_root) still serializes correctly because all clients hit the same broker

### 12.2 Stateful capability mutex

The capability broker (§11.2) holds one mutex per `state_root` (e.g., `~/.camofox/profiles/main`). Invocations from Claude or opencode queue identically. Stateless capabilities parallelize freely.

`v2/runtime/bridge.ts` total ~200 LOC — text transport only, no capability proxy.

## 13. Brain Prompt — Substrate Projection Under a Strict Budget

The brain prompt is a **minimal substrate projection**, not a hand-authored template with placeholders and not a transcript of the substrate. The prompt is only the contract needed for one dispatch: task identity, available runtimes, the universal act tuple, top-K evidence handles, and the current owner rendering policy. Everything else is retrievable knowledge or event state.

Two principles govern composition:

1. **Strict token budget.** A dispatch's total prompt size is capped at `PROMPT_BUDGET_TOKENS` (default 8,000). Sections are filled in priority order; lower-priority sections are truncated or omitted when the budget runs out. The brain MUST be able to operate on a thin prompt — what it lacks, it pulls via `substrate.search(...)` or `substrate.read(...)` mid-cycle.
2. **Depth-1 retrieval (per the RLM paper).** No section dumps "everything"; every retrieval is K-nearest by embedding distance × posterior reranking, where K is per-section (see table below). This is the load-bearing constraint that makes the system genuinely a Recursive Language Model: each level of recursion sees a controlled top-K subset, and deeper drill-down happens via fresh recursive calls (refinement edges), not by flooding the current prompt.
3. **Minimal prompt contract.** P0 prompt material is limited to: task identity and lifecycle, available runtimes, the universal `act` tuple (`intent + action_artifact_id + verifier_artifact_id + predicted_residual`), top-K evidence handles with ids, and current `owner_policy`. Emission grammars, examples, failure taxonomies, proposal gates, and long runbooks must live as retrievable knowledge or docs that can be pulled by id. They are not copied into every prompt by default.

### 13.1 Section budget and priority

| Section | Priority | K default | Source view | Contract role |
|---|---|---|---|---|
| TASK IDENTITY (goal + task/directive ids + lifecycle + urgency + budget) | P0 (always) | — | task row | Names the symbolic handle being executed |
| RUNTIMES AVAILABLE (one-line each) | P0 (always) | 3 | static/runtime registry | Names where artifacts may run |
| UNIVERSAL ACT CONTRACT | P0 (always) | — | static | Defines `intent + action_artifact_id + verifier_artifact_id + predicted_residual` and scalar residual scoring |
| CURRENT OWNER POLICY | P0 (always) | 1 | `owner_profile_view` / policy renderer | Controls owner-visible rendering language, terms, and density |
| RETRIEVED KNOWLEDGE (embedding × posterior evidence handles) | P1 | 8 | `knowledge_view` reranked by embedding distance to task goal × posterior | Supplies citeable evidence ids, not a full memory dump |
| ACT ARTIFACT REGISTRY (top-K reusable artifacts across any kind) | P1 | 6 | `act_artifact_registry_view` reranked by intent-shape embedding × posterior, with NO `kind` filter | Supplies reusable handles for executors, verifiers, prompt templates, decomposers, askers, researchers, recipes, observation patterns, and goal predicates — all out of the same registry. Runtime, when present, is payload/declaration data, never a retrieval dimension. Adding a kind filter silently recreates the closed enum the open-kind field exists to abolish. |
| UPSTREAM OUTPUTS (completed-task snapshot) | P2 | all required edges, summarized to 200 chars each | `requires_edge_observations` | Bounded local DAG context |
| WATCHED OUTPUTS (mid-flight, monotonic) | P2 | all watched, summarized | `watch_edge_observations` | Bounded live dependency context |
| STAKEHOLDER STATE (multi-stakeholder only) | P3 | all stakeholders, current row each | `stakeholder_state_view` | Bounded social context |
| CROSS-DIRECTIVE INTERFERENCE (portfolio context) | P3 | 5 | `directive_conflicts_view` | Bounded portfolio context |
| ACTIVE FAILURES (recent failures for similar goals) | P4 | 3 | `failure_view` reranked by goal embedding | Optional warning handles |
| RETRIEVABLE OPERATING KNOWLEDGE (grammars, examples, runbooks, gates, taxonomies) | pulled on demand | K by query | `knowledge_view` / docs handles | Not in the default prompt; retrieve only when needed |

When the budget is exceeded, the daemon truncates from the BOTTOM of the priority list. A dispatched brain always sees P0+P1 handles; P2+P3 are best-effort; P4 is dropped first under pressure. Long emission grammars, proposal-gate details, failure taxonomies, and examples are not protected prompt mass. If a task needs one, the brain cites the handle and pulls that slice deliberately.

### 13.2 Substrate API the brain queries mid-cycle

The prompt is intentionally lean. The brain pulls more by calling the substrate inside its cycle:

```typescript
// Reads (the brain may call any of these during its cycle)
substrate.search(query: string, opts?: { k?: number; runtime?: Runtime; min_score?: number }): KnowledgeRow[] | ArtifactRow[]
substrate.get_event(event_id: string): Event
substrate.get_artifact(artifact_id: string): CodeArtifact
substrate.read_view(view_name: string, args?: JsonValue): Row[]

// Writes (the brain emits these as typed events)
substrate.emit_action_predicted({ intent, action_artifact_id, verifier_artifact_id, predicted_residual })
substrate.emit_task_node_opened({ parent_task_id, goal, edge_kind })  // edge_kind ∈ requires|refines|watches
substrate.emit_knowledge_candidate({ claim, evidence, applies_to, confidence_estimate, ...open_world_model_fields })
substrate.emit_code_artifact_candidate({ runtime, body, declared_sandbox, fixture })
substrate.emit_directive_amended({ original_directive_id, amendment_text, ... })  // owner-only by default
```

Every read is depth-1 retrieval at that call — the brain decides when to retrieve more, and the substrate decides what is returned per call. Together they realize the RLM pattern: the brain is the language model, the substrate is the recursive operator, and recursion happens via controlled retrieval calls rather than by stuffing the prompt up-front.

### 13.3 Prompt template (minimal contract under the budget)

```text
You are operating as one task node in the AccInt v2 substrate.

TASK GOAL: {task.payload.goal}
TASK ID: {task.id}
DIRECTIVE ID: {task.directive_id}
DIRECTIVE LIFECYCLE: {finite | rolling_active (review_cadence)}
URGENCY: {normal | elevated | crisis}
BUDGET: wall_clock_ms={...}, max_tokens={...}

OWNER POLICY (current rendering contract):
{owner_policy — language, rendering_signals, preferred_terms, avoided_terms, exposed concepts}

RUNTIMES AVAILABLE (you write code for these):
  - bun
  - uv
  - camofox-browser

UNIVERSAL ACT CONTRACT:
  action = intent + action_artifact_id + verifier_artifact_id + predicted_residual
  verifier returns residual ∈ [0,1] plus optional open-ended breakdown/reliability maps
  substrate runs action + verifier, records action_scored, and credits cited evidence

RETRIEVED KNOWLEDGE (top-K evidence handles by embedding × posterior):
{knowledge_entries — ids, claims/summaries, scores; cite used ids or dismiss stale ids}

CODE ARTIFACT REGISTRY (top-K by posterior, scoped to your runtimes):
{code_artifact_entries — id, runtime, declared_sandbox, score, confidence, recent_residual_mean}

UPSTREAM OUTPUTS / WATCHED OUTPUTS / STAKEHOLDER STATE / INTERFERENCE / FAILURES:
{bounded handles and summaries only when present}

YOUR WORKFLOW (one cycle per dispatch; retrieve details by handle when needed):
  1. Choose bounded peek vs symbolic recursion.
  2. For each act, write or reuse action + verifier artifacts and emit action_predicted.
  3. If work remains, emit refinement edges instead of iterating in context.
  4. Propose knowledge_candidate or lesson_extracted for reusable claims, including
     world-model fields when the claim predicts outcomes or causal structure.
  5. Before root commit, run closure audit and extract lessons.

DO NOT:
  - Dump the environment into the prompt. Pull missing slices by substrate handle.
  - Treat emission grammars, examples, gates, or failure taxonomies as default prompt mass.
  - Iterate within this cycle. Emit a refinement edge if more work remains.

The substrate is your recursive memory AND your code-runtime broker.
Reality scores your predictions through the verifier you wrote.
```

## 14. Father — Brainless Scheduler, Recurring Task

(F4 drift prevention; closes `k_3593` Father drift.)

Father is a recurring task in the substrate, not a separate process:

```typescript
async function fatherIterate(): Promise<void> {
  // Reads directive_conflicts_view to respect interference
  const objectives = await substrate.read('active_objectives_view');
  const rollingReviews = await substrate.read('rolling_review_due_view');

  const priority = selectByPriorityAndFreshnessAndConflicts(objectives, rollingReviews);

  if (await ownerActive()) {
    substrate.emit({ kind: 'father_yielded', payload: { reason: 'owner_active' } });
    return scheduleNextIteration(BACKOFF_MS);
  }

  if (priority.kind === 'rolling_review') {
    await openReviewDirective(priority);
  } else if (priority.kind === 'normal_objective') {
    const directive = compileDirectiveFromTemplate(priority);  // template only, NO free-form generation
    await openDirectiveInSubstrate(directive);
  }

  substrate.emit({ kind: 'father_cycle_recorded', payload: { ...summary } });
  return scheduleNextIteration(NORMAL_INTERVAL_MS);
}
```

**Drift prevention:**

- Action taxonomy fixed: `read_objectives`, `select_priority` (deterministic, NO LLM), `compile_directive_from_template`, `open_directive`, `open_review_directive`, `journal_cycle`, `yield`
- Constitutional gate rejects events outside this list
- Father's capability profile declares **zero LLM-call capability** — Father cannot invoke `agent.*` or `bridge.*`
- Adversarial test suite asserts no free-form generation
- Father reads `rolling_review_due_view` for long-horizon goals on cadence (§3.1)
- Father respects `directive_conflicts_view` when ranking (O6)

## 15. Recipe Replay — Tier-0 Cost Compression

Recipes are a kind of capability. Whitepaper Tier-0 ladder unified into capability curriculum.

The dispatcher checks Tier 0 first:

```typescript
async function dispatchTask(task: ReadyTask): Promise<TaskResult> {
  const recipe = await substrate.recipes_view.match(task);
  if (recipe && recipe.confidence >= RECIPE_REPLAY_THRESHOLD) {
    substrate.emit({ kind: 'recipe_invoked', payload: { recipe_id: recipe.id, task_id: task.id } });
    return await replayRecipe(recipe, task);  // NO LLM call
  }
  return await brainDispatch(task);
}
```

Recipes accrete via `recipes_view` extractor: ≥3 similar task graph shapes with similar parameters → emit `recipe_extracted` with confidence prior 0.5.

In crisis mode (§3.5), recipe threshold lowered to 0.6 (prefer cached over fresh).

## 16. Starting Fresh from v1 — No Migration

v2 launches with empty substrate. v1 archived read-only at `state/v1-archive/accint.db`.

**Optional foundational seeding (owner-approved):**

```typescript
const SEED_LAWS = [
  // k_201, k_174, k_199, k_200, k_204, k_555, k_554, k_252, k_1010, k_1101, k_2367,
  // k_3566-k_3572, k_3582-k_3600, k_3601-k_3622, k_3623-k_3642
];

async function seedFoundationalKnowledge(): Promise<void> {
  for (const law of SEED_LAWS) {
    const candidateEvent = substrate.emit({
      kind: 'knowledge_candidate',
      substrate_origin: 'substrate_auto',
      payload: { ...law, derived_from: ['v1_archive_import'] },
    });
    substrate.emit({
      kind: 'knowledge_promoted',
      substrate_origin: 'substrate_auto',
      payload: { candidate_id: candidateEvent.id, score: law.score, confidence: law.confidence, skip_corroboration: true },
    });
  }
}
```

NOT a migration. Curated event insertion with synthetic provenance.

v1 code patterns may be COPIED into v2 cleaner abstractions case-by-case. No automated transform.

**Pywebflow:** legacy, NOT ported. Replaced by `camofox.*` capabilities.

## 17. Phased Cutover

The daemon (§5) is the foundation: nothing else runs hot without it. Phases are ordered so that the minimum viable v2 — daemon + one runtime + one brain dispatch on a fixture directive — lands by Phase D. Subsequent phases are mostly independent of each other and may be parallelized as schedule allows.

| Phase | Goal | Contract shape | Exit criterion (testable) |
|---|---|---|---|
| **A** | This design + scaffold `v2/` | Single-file: this doc (closure_exemption: documentation_only) | This document is committed to master. |
| **B** | Daemon foundation — substrate process, WAL connection, MCP server, external-push endpoint, port-lock single-instance, RPC client | `v2/runtime/daemon.ts` + `v2/substrate/{types,schema.sql,extractors,views,seed}.ts` + `v2/runtime/mcp_server.ts` + `v2/cli/dispatch.ts` (thin RPC client) | Daemon starts, holds a SQLite WAL connection, accepts a webhook POST, emits `external_event_received`, survives kill+restart and replays embeddings. |
| **C** | First runtime end-to-end — bun runtime + sandbox + code-artifact store | `v2/runtime/{runtimes/bun,sandbox,artifact_store,artifact_admission}.ts` | A seed bun code artifact runs under Deno permissions; a verifier bun artifact returns a residual; `action_scored` is emitted. |
| **D** | MVP brain dispatch — single-cycle opencode call, prompt projection under budget, refinement-edge emission | `v2/runtime/{bridge,prompt_composer,task_dispatcher,task_scheduler}.ts` | Fixture directive **`fixture_d_count_todos`** opens: "Count files in `scripts/cli/` whose contents contain the substring `TODO`, return the integer count." Brain dispatches once, emits action_predicted with a bun action artifact (recursive grep) + bun verifier artifact (residual = 0 if integer returned AND ≥ 0; else 1) + predicted_residual ≤ 0.1. Substrate runs the artifact, verifier records residual, task_committed fires. The directive closes in a single dispatch with no refinement edges. |
| **E** | Async parallel + DAG topology + watch edges + amendment | `v2/runtime/{task_topology,amendment_handler}.ts` | Two ready tasks run concurrently; a watch edge updates mid-flight; an owner-emitted directive_amended supersedes a prediction. |
| **F** | Embedding pipeline + retrieval reranker — depth-1 retrieval per RLM | `v2/runtime/{embedder,retrieval}.ts` | Brain prompt fits under 8K tokens; brain pulls more via substrate.search mid-cycle; embedding index rebuilds from WAL after restart. |
| **G** | Remaining runtimes — uv (Python under nsjail) and camofox-browser (chromium under profile) | `v2/runtime/runtimes/{uv,camofox}.ts` | Brain authors a uv artifact and a camofox artifact; both pass admission fixtures and accumulate posteriors. |
| **H** | Code-artifact promotion + quarantine ageing | `v2/runtime/artifact_store.ts` (extend) | An artifact crosses the naming threshold and is auto-promoted; another with high recent residual is auto-quarantined. |
| **I** | Multi-stakeholder + cross-directive interference + rolling-active + crisis-mode | `v2/runtime/{stakeholder_compositor,interference,rolling_reviewer,crisis_mode}.ts` | Each surface demonstrates one passing fixture directive. |
| **J** | Recipe replay (Tier-0) | `v2/runtime/recipe_replay.ts` + `recipes_view` extractor |
| **K** | Father (constrained, recurring task) | `v2/runtime/father.ts` |
| **L** | Owner freeze on v1; drain in-flight; archive v1 | Operational |

Most phases are single-file new-file contracts (closure-clean). Multi-file contracts declare `data.predicate`. There is no fine-tuning phase: the substrate's posterior-weighted retrieval over an event log is the compounding mechanism; a small custom model would just duplicate it less reliably and the subscription-CLI-only constraint precludes a custom inference path anyway.

## 18. Cutover Criteria (must ALL hold)

1. **Test parity:** v2 runs all v1 test fixtures ≥99% pass; new v2 tests cover all new event kinds + views.
2. **Performance:** v2 cold-start ≤ 30s; brain wake-up ≤ 60s; cycle-1 brain dispatch completes without depending on a second cycle.
3. **Save_receipt parity:** 20 fixture directives; ≥95% content equivalence.
4. **Father autonomy:** 24h continuous run with zero manual intervention.
5. **Active-inference convergence:** mean residual declining over 100 directive cycles.
6. **Recipe coverage:** ≥30% of routine directives hit Tier-0 replay.
7. **Code-artifact authorship:** brain emitted ≥10 reusable code artifacts; ≥7 admitted; sandbox enforcement verified across all three runtimes.
8. **Knowledge promotion balance:** ≥50 candidates promoted from each substrate_origin (claude_root, opencode); observable cross-origin contribution.
9. **Artifact invocation symmetry:** opencode-invoked artifacts contribute ≥30% of total invocations during pilot.
10. **Concurrency:** sustained 10 parallel tasks for 1h with no concurrency_conflict events.
11. **Constitutional integrity:** gates audit themselves; zero unrecovered violations.
12. **Zero stale rows:** no equivalent of v1's brain_flights/emit_claims rot.
13. **V1 falsifiability:** swap scheduler with stub; recursive control (knowledge_promoted/demoted, recipe_extracted, code_artifact_score_updated) still emits from substrate extractors.
14. **Universality pilot:** at least 1 successful directive each from embodied (physical-observation verifier), long-horizon (rolling-active), multi-stakeholder, and self-as-target.
15. **Refinement-edge convergence:** ≥3 directives that required ≥3 refinement edges each, all closing within budget, demonstrating cycle-1-only is sufficient.
16. **Amendment integrity:** ≥3 directives amended mid-flight without prediction-residual corruption.
17. **Dispatcher-enforced cycle-1-only.** Adversarial test fixture deliberately emits a `brain_cycle_2_started` event during a dispatch; `task_dispatcher.ts` MUST emit `dispatcher_violation` with `failure_kind: 'cycle_1_only_breach'`, terminate the opencode subprocess, and the directive MUST still close to `task_committed` via refinement edges on subsequent dispatches — proving the structural enforcement of §3.7 (k_252: advisory gates do not change behavior).
18. **Semantic-merger extractor invariants.** Three fixture directives with paired Claude-origin + opencode-origin candidates: (a) two semantically-equivalent candidates collapse to one row with corroborating evidence (Rule 1), (b) two semantically-opposed candidates produce a `contradictory_candidates` event with both rows held open (Rule 2), (c) a sufficiently corroborated candidate emits `knowledge_synthesized` whose citation chain points to BOTH original origin events (Rule 3).
19. **Per-origin retrieval bias is learned, not declared.** `origin_promotion_view` shows a measurable per-origin × per-goal-shape multiplier after ≥ 50 directives; reranker output observably shifts in response (§3.6.1 Rule 4).

## 19. Risk Inventory (greenfield + universal)

1. **Cold-start competence loss.** Empty substrate has no recipes/judgment. Mitigation: optional seeding; recipes disabled until N successes; base LLM fallback.
2. **Foundational seeding policy drift.** Over-seed → back-door migration. Mitigation: owner-approved seed list.
3. **Code-artifact authorship drift.** Brain emits low-quality artifacts. Mitigation: admission fixture + sandbox enforcement; quarantine + rehabilitation; posterior reranking pushes weak artifacts out of retrieval.
4. **Concurrent edit contention.** Mitigation: append-only events + explicit conflict rules per artifact type.
5. **DAG cycles (non-refinement).** Mitigation: edge-kind-aware cycle detector.
6. **Refinement-edge runaway.** A task keeps emitting refinement edges and never converges. Mitigation: per-task refinement-depth cap; budget exhaustion → directive_amended via owner chat.
7. **Failure cascade.** Mitigation: refinement edges + watch edges route around; budget limits cascade depth.
8. **Bridge subprocess instability.** Mitigation: typed `BridgeFailureReason`; retry-on-retryable; process-group teardown; every frame recorded.
9. **Code-artifact proliferation.** Many similar artifacts compete for posterior. Mitigation: top-K per embedding cluster; demotion; sparse-use exemption.
10. **Verification integrity.** Mitigation: verifiers ARE code artifacts and accrue their own posterior; periodic re-audit by replaying with a known-good fixture.
11. **Sandbox escape.** Mitigation: bun under Deno permissions, uv under nsjail with pypi lockfile, camofox under a long-lived chromium owned by the substrate; runtime sandbox_violation → artifact quarantine.
12. **Knowledge candidate spam.** Mitigation: dedup by `payload_hash`; rate-limit per task; demotion when never confirmed.
13. **Fan-in misattribution.** Mitigation: substrate credits all knowledge_ids + artifact_ids cited by an action; outcome weight distributed proportionally.
14. **Mid-flight observation revocation.** Mitigation: monotonic-only mode; revocation forbidden.
15. **Subscription rate limits.** Mitigation: per-loop budgets; CLI internal backoff; `bridge_rate_limit` events.
16. **Embedding drift.** The substrate's embedding model changes versions and old vectors become non-comparable. Mitigation: version stamp on every embedding row; reranker excludes mixed-version sets; bulk re-embed task scheduled when version changes.
17. **Concurrent MCP client races on stateful artifact.** Claude and opencode both run camofox against the same profile. Mitigation: per-state-root mutex inside the broker; stateless artifacts parallelize freely.
18. **Multi-stakeholder unreconcilable conflict.** Stakeholder utilities cannot be reconciled. Mitigation: emit `stakeholder_conflict` failure_kind; surface to owner via chat for adjudication; do not silently choose one side.
19. **Rolling-active directive accumulation.** Many never-closing directives clog Father. Mitigation: max-active cap; oldest-inactive review-cadence-missed directives auto-archived after N missed reviews.
20. **Cross-directive interference graph cycles.** A blocks B, B blocks C, C blocks A. Mitigation: cycle detector on interference edges; surface to owner.
21. **Irreversible effect mis-prediction.** Action records irreversible_effect but predicted otherwise. Mitigation: discrepancy emits `prediction_miss`; future retrieval down-weights similar artifact shapes.
22. **Directive amendment cascade.** Amendment invalidates many predictions. Mitigation: amendment recorded explicitly with `superseded_predictions` field; residual aggregation excludes invalidated predictions; new tasks under amendment receive recomputed budgets.
23. **Daemon crash with in-memory state.** HNSW index, MCP server state, scheduler queues all live in daemon memory. Mitigation: WAL guarantees event durability; daemon boot rebuilds the index from `embedding_index_view` and re-arms workers from event log; in-flight brain dispatches use their own SQLite connection and survive daemon restart.
24. **External-push token leak.** Webhook bearer token grants substrate write access. Mitigation: token scoped to `external_event_received` only (cannot emit task/action/knowledge events); rate-limited per source; rotateable; abuse triggers `external_source_quarantined`.
25. **Embedding API outage.** OPENAI_API_KEY-backed embedding service goes down. Mitigation: embedder worker buffers unembedded payloads and retries with exponential backoff; retrieval continues to function using already-indexed embeddings; new payloads index when service recovers.

## 20. Open Questions

Only items that remain genuinely empirical after the daemon (§5) + cycle-1-only + code-as-capability decisions. Everything else has a default that the phased cutover ships and that A/B tests can refine.

1. **Reranker shape.** Embedding-cosine × posterior multiplier — linear (`cos × (1 + score)`) versus learned reranker over a small in-cycle prompt-budget window. Default linear; A/B in Phase F.
2. **Prompt budget value.** Default `PROMPT_BUDGET_TOKENS = 8000` is a guess. Real measurement post-Phase F: at what budget does brain quality plateau, and at what budget does latency become acceptable on the subscription CLI path?
3. **Webhook authentication and policy.** Owner-provisioned bearer token is the MVP. Open: per-source policy (rate limits, sensitivity classification on inbound, allowed-event-kind whitelist), and what happens when the token leaks.
4. **Crisis-mode trigger.** Currently owner-declared. Future: substrate-detected via pattern recognition on directive intent. Default: owner-declared only; reconsider after Phase I if owners can articulate a useful trigger heuristic.

**Resolved (kept for traceability):**

- **Embedding model.** `text-embedding-3-small` via `OPENAI_API_KEY`, dim 1536. See `runtime/embedder.ts` `EMBEDDING_MODEL` / `EMBEDDING_DIMS`.
- **Embedding storage.** `sqlite-vec` (`vec0` virtual table `vec_events` in `substrate/schema.sql`). Replaces the prior in-memory linear-scan (HNSW was promised but never materialised in code). Disk-resident — no boot rebuild, no JS-side Float32Array footprint at scale. Filter columns (`kind`, `ts`, `embedding_version`) participate in WHERE clauses in the same KNN statement, enabling hybrid queries in one SQL pass.

## 21. Module Breakdown — v2/ Directory Layout

```
v2/
├── substrate/
│   ├── types.ts                 ~280 LOC — Event, EventKind, FailureKind, OutcomeStatus, edge kinds, DirectiveLifecycle, Runtime, SandboxDecl
│   ├── schema.sql                ~80 LOC — events table + indexes + embedding column + code_artifact table
│   ├── extractors.ts            ~600 LOC — knowledge/entities/recipes/provenance extractors + code_artifact_score_updated extractor
│   ├── views.ts                 ~500 LOC — pure SQL views (task_graph, ready_tasks, contradictory_candidates, stakeholder_state, directive_conflicts, rolling_review_due, code_artifact_registry, embedding_index, owner_conversation, etc.)
│   └── seed.ts                  ~180 LOC — seed code artifacts + optional foundational knowledge import
├── runtime/
│   ├── daemon.ts                ~320 LOC — persistent process; port-lock + Unix socket; supervises workers; bootstraps WAL + in-memory index; serves MCP + external-push endpoints
│   ├── act.ts                   ~200 LOC — universal act() primitive (action artifact + verifier artifact + predicted residual)
│   ├── runtimes/
│   │   ├── bun.ts               ~180 LOC — TS runner under Deno permissions
│   │   ├── uv.ts                ~180 LOC — Python runner under nsjail with locked pypi mirror
│   │   └── camofox.ts           ~220 LOC — long-lived chromium under substrate-owned profile root
│   ├── artifact_store.ts        ~250 LOC — code_artifact CRUD + posterior update + LATM promotion threshold
│   ├── artifact_admission.ts    ~180 LOC — admission fixture runner + sandbox-decl-vs-actual check
│   ├── embedder.ts              ~150 LOC — text → vector via OpenAI text-embedding-3-small (OPENAI_API_KEY); version-stamps embeddings
│   ├── embedding_index.ts       ~140 LOC — thin wrapper over sqlite-vec `vec_events` virtual table; SQL knn for 1536-dim production embeddings, JS-fallback for test-dim vectors; no in-memory rebuild
│   ├── retrieval.ts             ~200 LOC — cosine × posterior reranker; depth-1 retrieval enforcing per-section K caps
│   ├── external_ingress.ts      ~180 LOC — webhook POST /external/push handler + pluggable inbox pollers
│   ├── task_scheduler.ts        ~150 LOC
│   ├── task_dispatcher.ts       ~220 LOC — composes prompt under PROMPT_BUDGET_TOKENS, spawns ONE single-cycle session
│   ├── task_topology.ts          ~100 LOC — DAG analysis incl. interference cycles + refinement-edge depth check
│   ├── bridge.ts                ~200 LOC — opencode subprocess for text response (artifact runs flow via shared MCP, not bridge)
│   ├── mcp_server.ts            ~280 LOC — exposes bun.run / uv.run / camofox.run + substrate.{read,save,embed,search,credit} via MCP (both clients connect)
│   ├── dispatch_decider.ts      ~140 LOC — scored decideDispatch() router (recipe replay / Claude inline / opencode brain)
│   ├── sandbox.ts               ~280 LOC — per-runtime permission enforcement (Deno perms / nsjail / chromium profile boundary)
│   ├── recipe_replay.ts         ~180 LOC — Tier-0 replay
│   ├── father.ts                ~200 LOC — constrained in-process recurring tick + rolling-review-due reader (no notification surface)
│   ├── prompt_composer.ts       ~240 LOC — substrate-rows → brain prompt generator (RLM-style projection under strict token budget)
│   ├── constitutional_gate.ts   ~150 LOC — gate decisions as events
│   ├── amendment_handler.ts     ~100 LOC — directive_amended processing + superseded prediction filtering
│   ├── crisis_mode.ts            ~80 LOC — emergency-mode scheduler adjustments
│   └── stakeholder_compositor.ts ~120 LOC — stakeholder_state_view rendering for multi-stakeholder prompts
├── cli/
│   ├── dispatch.ts              ~140 LOC — `acc task` thin RPC client to daemon
│   ├── state.ts                 ~320 LOC — `acc state {me,contracts,focus,...}` thin RPC client to daemon
│   ├── doctor.ts                ~150 LOC
│   └── watch.ts                 ~200 LOC — TUI live monitor (subscribes to daemon's event stream)
└── tests/
    ├── fixtures/                 — directives across the universal walkthroughs in §10
    └── falsifiability/           — V1 test (swap scheduler) + invocation-symmetry test + daemon-restart-replay test
```

**Total v2 LOC target: ~7,150** — substrate ~1,640 + runtime ~4,690 (daemon, three runtimes, artifact_store, artifact_admission, embedder, embedding_index, retrieval, external_ingress, task_scheduler, task_dispatcher, task_topology, bridge, mcp_server, dispatch_decider, sandbox, recipe_replay, father, prompt_composer, constitutional_gate, amendment_handler, crisis_mode, stakeholder_compositor) + cli ~820 (init + dispatch + state + doctor + watch as thin RPC clients) + act.ts ~200, tests not counted. Still ~3.5× smaller than v1's ~25,000 LOC across `scripts/cli/` despite adding the daemon, the three runtimes, and the external-push ingress that v1 lacks entirely.

## 22. What This Design Rejects

- **Multi-cycle outer loop within a single brain dispatch (Ralph wigwam).** v1's "cycle 1 → cycle 2 → cycle N" iteration is broken in practice; cycle 2 routinely fails to deliver. Replaced by cycle-1-only dispatch with refinement edges in the DAG — if a single cycle didn't finish the work, it emits a refinement edge and the next single-cycle session picks it up. Inspectable substrate state instead of opaque retry. Intelligence accumulates in the substrate across dispatches (§3.8), not inside a long-running brain process.
- **CLI-cold-start substrate access.** v1's `acc task` re-opens SQLite, re-loads embeddings, re-computes posteriors, re-builds the prompt from scratch on every invocation. Replaced by a persistent substrate daemon (§5) that holds the WAL connection, the in-memory embedding index, and the shared MCP server open across owner sessions. CLI commands become thin RPC clients to the daemon.
- **Prompt flooding ("dump everything the substrate knows into the prompt").** Replaced by depth-1 retrieval under a strict `PROMPT_BUDGET_TOKENS` cap (§13). Each prompt section retrieves K-nearest by embedding × posterior, not all-of-it. The brain pulls more via `substrate.search` mid-cycle when it needs to.
- **`acc task` as a one-shot subprocess that owns intelligence extraction.** Replaced by the dispatch decider (§3.6) that routes between substrate replay (recipe), Claude inline lane (scored low-risk), and opencode brain (default for strategic work). One-shot CLI invocation is no longer the single intelligence-extraction path.
- **CHECKPOINT/COMPLETE cross-process protocol** (replaced by task-level commits in substrate).
- **Verbalized subagent delegation as the recursive primitive** (RLM paper §1 critique — replaced by `act` + code-as-capability).
- **Two compute substrates at the architecture layer** (replaced by two model providers as per-call routing).
- **File-scoped closure validator** (replaced by evidence-shape closure on trajectory).
- **`ACC_RUNTIME_SCOPE` projection-pinning** (replaced by one resolver per question).
- **Typed substrate ontology** (entities, knowledge, judgments, contracts as separate types — replaced by events + views).
- **Typed verification predicate lattice.** The 12-variant `VerificationPredicate` discriminated union (file_exists, tests_pass, page_state, physical_observation, relational_panel, economic_state, aesthetic_reuse, demonstrated_competence, expert_confirmation, …) was a tool menu in disguise. Replaced by a verifier code artifact that returns a scalar residual ∈ [0,1]. Verifiers can be arbitrarily smart but their output shape is one number.
- **Per-intent-kind residual adapter bank** (semantic_residual, code_residual, browser_residual, physical_residual, …) — replaced by "the verifier returns the residual." No adapters.
- **Discrete capability menu** (`serper.search`, `camofox.click`, `camofox.fill`, `camofox.extract`, …) — replaced by three substrate-resident runtimes (bun, uv, camofox-browser) for which the brain writes code. A "capability" in v2 is just a code artifact promoted via LATM/Voyager outcome correlation.
- **Specialty runtime hosts.** camofox-browser is one of three universal runtimes (alongside bun, uv), not a curated capability host with its own daemon API. The brain writes scripts that drive chromium via the camofox API the same way it writes bun scripts that drive the filesystem.
- **Multi-agent decomposition as default** (whitepaper §7 — 30-70% degradation; depth-1 sweet spot).
- **Tree-shaped goal decomposition** (replaced by DAG with refinement edges).
- **Hardcoded-only tool registration** (replaced by seed code artifacts + brain-emitted candidates).
- **One session per directive** (replaced by N concurrent sessions per ready task).
- **"Claude is canonical knowledge author" master-slave merger** (replaced by Model D — substrate auto-promotes any-origin candidates).
- **Migration from v1** (replaced by greenfield + optional curated foundational seed + v1 archive).
- **Retry/refinement as policy prose** (replaced by first-class refinement edges).
- **"Pure SQL views" handwaving** (replaced by named typed extractors).
- **"Idempotency falls out for free"** (replaced by explicit first-vs-latest-wins + payload-hash rules).
- **Vague "sandboxed subprocess"** (replaced by per-runtime sandbox declaration).
- **Untyped opencode bridge** (replaced by typed `BridgeFailureReason` + frame protocol; text transport only).
- **Bridge stream interception protocol.** Opencode has native MCP client support; artifact runs flow through MCP, not parsed `<<CAPABILITY>>` markers in bridge stdout.
- **Self-improvement as separate subsystem** (replaced by self-as-target via ordinary directive workflow).
- **Asymmetric MCP-only tool host.** Replaced by ONE shared MCP server; BOTH Claude Code and opencode connect as native MCP clients; ONE posterior per artifact counting both invokers.
- **External-expert / licensure-bound escalation protocol.** No `expert_escalation_requested`, no `expert_response_received`, no licensed-expert routing, no marketplace gateway. The owner is the only human in the loop, reached through Claude Code chat. Health, legal, financial directives are normal directives; the brain researches and summarizes, the owner decides.
- **Typed `sensitivity_label` as a first-class concept.** Sandbox permissions per-runtime are sufficient; data classification gating in the substrate is over-engineering without an external-expert routing surface to enforce it against.
- **Telegram / email / inbox notification surface.** Father is a pure background scheduler with no notification surface. The owner pulls state by chatting with Claude Code.
- **Fine-tune a small custom model on v2 trajectories.** The substrate's posterior-weighted retrieval over an event log IS the compounding mechanism; a custom model would duplicate it less reliably. The subscription-CLI-only constraint precludes a custom inference path anyway.
- **One-owner objective semantics** (replaced by stakeholder_state rows + interaction edges for the cases — partner, family, team — where more than one party's utility matters).
- **Goal terminality assumed** (`outcome` enum includes `rolling_active` and `amended` alongside committed/abandoned).
- **Pywebflow** (replaced by the camofox-browser runtime).

## Appendix A: v1 → v2 File Mapping

v2 is greenfield: there is no automated migration. This appendix is a port plan, not a transform. For every v1 file or directory the table names the v2 destination and the **port action**: `lift` (copy with minor rename), `rewrite` (preserve the idea but rewrite under v2's substrate-event-sourcing discipline), `drop` (no v2 equivalent — the v1 file solved a problem v2 does not have), or `new` (v2 introduces a module that has no v1 ancestor). Rationale is one sentence per row.

v1 inventory snapshot at port time: 12 top-level CLI scripts (`scripts/cli/*.ts`, ~1.0 MB combined), 75 utility modules in `scripts/cli/util/`, four projection modules in `scripts/cli/projection/`, two hooks, ten install-control modules, four TUI modules, ~30 `.opencode/tool/acc-state/` submodules plus serper/tg/state/pywebflow tool dirs, 399 test files in `tests/`, and ~40 docs in `docs/`. v1 ledger: `state/accint.db` 684 MB live, WAL active.

### A.1 Top-level CLI commands (`scripts/cli/*.ts`)

| v1 file | LOC | Port | v2 destination | Rationale |
|---|---|---|---|---|
| `init.ts` | 6.3k | rewrite | `v2/cli/init.ts` (~400) + `v2/runtime/daemon.ts` (boot phase) | v1 bootstrap conflates first-run + capability registry + Claude rule files; v2 splits into thin CLI init and daemon-side seed loading. |
| `state.ts` | 1.7k | rewrite | `v2/cli/state.ts` (~320) | RPC client only; current state.ts opens SQLite directly and renders inline — v2 routes every read through the daemon's MCP. |
| `contract.ts` | 6.4k | drop | — | The entire `contract` claim/done/integrate machinery is replaced by DAG task rows + refinement edges + daemon-owned lock state. Worktree-per-contract is dropped (replaced by per-task-dispatch sandboxed runtime). |
| `self-build.ts` | 12.7k | drop (mostly) + lift (pieces) | scattered into `v2/runtime/{task_dispatcher,prompt_composer,artifact_admission,verify_orchestrator}.ts` | This is v1's mega-file: closure validator, predicate evaluator, brain dispatch, write-pending validator, target-files closure logic, multi-cycle Ralph orchestrator. Multi-cycle Ralph and closure-validator are dropped (§22 rejections). Predicate evaluator becomes the verifier-artifact runner. Brain dispatch shape is reused (single-cycle) in task_dispatcher. |
| `father.ts` | 1.2k | rewrite | `v2/runtime/father.ts` (~200) | Recurring scheduler tick moves in-process inside the daemon — no separate process. The Father-drift adversarial test surface is preserved. |
| `distribute.ts` | 2.7k | drop | — | Fleet enrollment / distribution is v1-specific orchestrator infra; v2 owner deploys the daemon directly. If multi-machine fleet returns, it returns as a separate v2-fleet contract — not part of the core organism. |
| `watch.ts` | 1.4k | rewrite | `v2/cli/watch.ts` (~200) | TUI subscribes to daemon's event stream (Unix-socket SSE) instead of polling SQLite. |
| `browser.ts` | 580 | drop | — | Browser actions are now ordinary `camofox-browser` runtime invocations through `act()`; no dedicated CLI surface needed. |
| `update.ts` | 1.1k | drop | — | Auto-update infrastructure decouples from the organism; package via standard distribution channel. |
| `lock.ts` | 380 | drop | — | All lock state lives in daemon memory (port-lock + per-state-root mutex); v1's filesystem-lock machinery vanishes. |
| `operator-packet.ts` | 1.1k | drop | — | The operator-packet shape is a v1 contract-queue concern; v2 replaces it with the live task DAG view served by the daemon. |
| `profile.ts` | 145 | lift | `v2/cli/profile.ts` (~150) | Camofox profile management stays; the substrate owns the profile root. |

### A.2 Utility modules (`scripts/cli/util/*`)

Grouped by function. Most rows are aggregations; rationale is the per-group story.

| v1 group | Representative files | Port | v2 destination | Rationale |
|---|---|---|---|---|
| **Brain dispatch & prompt machinery** | `brain-extraction.ts`, `brain-lease.ts`, `prompt.ts`, `acc-stream.ts`, `ralph.ts`, `ralph-stream.ts`, `father-stream.ts`, `father-tui.ts`, `father-core.ts` | rewrite | `v2/runtime/{prompt_composer,task_dispatcher,bridge,father}.ts` | Single-cycle dispatch with substrate-projection prompt under PROMPT_BUDGET_TOKENS; Ralph wigwam loop removed entirely; brain-lease replaced by daemon-owned per-directive flight serializer in memory. |
| **Closure validator & predicate evaluator** | `closure-validator.ts`, `predicate-evaluator.ts`, `test-import-graph.ts` | drop | — | Both are tied to v1's file-scoped closure invariant — replaced by per-task verifier code artifacts (§6) and DAG task scoping. The IDEA of "evaluate a predicate against substrate state" is preserved as the verifier-artifact runner inside `artifact_store.ts`. |
| **Contract lifecycle** | `contract-guards.ts`, `contract-liveness.ts`, `contract-reconciler.ts`, `contract-status-vocab.ts`, `contract-baseline-resolver.test.ts`, `contract-emit-validator.ts`, `integration-queue.ts`, `integration-bare.ts`, `integration-worktree.ts`, `branch-workstash.ts`, `tree-workspace.ts` | drop | — | The contract → branch → worktree → claim CAS protocol is replaced by per-ready-task daemon dispatch; no branches, no worktrees, no integration queue. |
| **Verify orchestrator** | `verify-orchestrator.ts`, `verify-replay.ts`, `verify-snapshot.ts`, `verify-shards.ts`, `verify-content-addressed.ts`, `verify-contamination.ts`, `verify-stage.ts`, `llm-verify.ts` | rewrite (idea only) | `v2/runtime/artifact_admission.ts` + verifier code artifacts | The contamination / replay / shard machinery was specific to file-diff verify. v2 verification is whatever code the brain wrote; admission-fixture is a thin runner inside artifact_admission. |
| **Action packets & execution** | `action-packet-dispatch.ts`, `exec-action-packet.ts`, `exec-js.ts`, `exec-python.ts`, `script-execution-sandbox.ts` | rewrite | `v2/runtime/runtimes/{bun,uv}.ts` + `v2/runtime/sandbox.ts` | The brain-emits-action-packet pattern is exactly what v2's `act()` formalizes. The sandbox machinery (Deno permissions for bun, nsjail for python) is lifted as-is. |
| **Camofox & browser** | `browser-open.ts`, `camofox-install.ts`, `capability-manifest.ts` | rewrite | `v2/runtime/runtimes/camofox.ts` (~220) | camofox-install stays as a daemon bootstrap step; runtime invocation becomes a script that uses the camofox API, not a curated capability host. |
| **Persistent test runner & sandbox** | `persistent-test-runner.ts`, `persistent-test-runner-host.ts`, `agent-isolation.ts`, `actor-identity.ts` | drop | — | v2 dispatches one fresh brain cycle per ready task; no long-running test-runner host. Actor identity collapses to one daemon process and per-task invoker tags. |
| **Capability projection** | `projection/capabilities.ts`, `projection/capability-types.ts`, `projection/packet.ts`, `projection/types.ts` | rewrite | `v2/substrate/extractors.ts` + `v2/substrate/views.ts` | Projections become pure SQL views in v2 (§4.2). The TS extractors that did parser-style indexing are kept in extractors.ts. |
| **Recipe & replay** | `recipe-executor.ts`, `improvement-engine.ts` | lift | `v2/runtime/recipe_replay.ts` (~180) | Tier-0 replay is one of the few v1 mechanisms that worked well; lift with minor renaming. |
| **Embeddings & retrieval** | `.opencode/tool/acc-state/embeddings.ts`, `acc-state/code-artifact-retrieval.ts`, `acc-state/knowledge.ts` | rewrite | `v2/runtime/{embedder,embedding_index,retrieval}.ts` | Embedding API call (text-embedding-3-small) lifted; the index moves to in-memory HNSW; retrieval becomes cosine × posterior reranker under per-section K caps. |
| **Constitutional / governance** | `constitutional-gate.ts`, `directive-pursuit-failure-resolver.ts`, `directive-semantics.ts`, `improvement-engine.ts` | rewrite | `v2/runtime/{constitutional_gate,amendment_handler}.ts` | Gate decisions become event-recorded rather than free-form prose; pursuit-failure resolver folds into the amendment_handler. |
| **Workspace & paths** | `paths.ts`, `workspace.ts`, `runtime-artifacts.ts`, `state-artifact-hygiene.ts`, `service-controller.ts` | lift | `v2/cli/paths.ts` + `v2/runtime/daemon.ts` boot | Paths and runtime-artifact hygiene stay; integrated into daemon boot. |
| **Owner & external channels** | `telegram.ts`, `tg-outbox.ts`, `owner-events.ts`, `voice.ts`, `team-writing-style.ts` | drop | — | External notification surfaces are gone (§22). The owner channel is Claude Code chat. owner-events conceptually becomes `owner_input_received` / `owner_decision_recorded` event kinds (§4.1). |
| **Persona & voice** | `persona-compiler.ts`, `team-writing-style.ts`, `voice.ts` | lift (selectively) | `v2/substrate/seed.ts` (style as seed knowledge) | Persona stays as scored knowledge, not a separate compiler. |
| **Crypto, log, process plumbing** | `crypto.ts`, `log.ts`, `process.ts`, `progress-event.ts`, `progress-line.ts`, `coordination-log.ts` | lift | `v2/runtime/{crypto,log,process,progress_event}.ts` | Boring infrastructure; lift with minor renames. progress-event is canonical (k_252); preserved verbatim. |
| **Preflight & daemons** | `preflight-daemon.ts`, `service-controller.ts`, `runtime-artifacts.ts` | rewrite | `v2/runtime/daemon.ts` boot phase | v1 has a preflight daemon for pulse-cache; v2 collapses it into the single substrate daemon. |
| **Surface-link / context membrane** | `surface-links.ts`, `context.ts`, `external-mode.ts` | drop | — | The "surface links" abstraction was v1-CLI-specific; v2's substrate API replaces it. |
| **Self-build core** | `self-build-core.ts`, `autonomous-builder.ts` | drop (most), lift (artifact_admission pieces) | `v2/runtime/artifact_admission.ts` | Self-build's autonomous builder is the v1 equivalent of LATM authoring; the idea moves into artifact_admission with a much smaller surface. |
| **Misc** | `human-lock.ts`, `release-channel.ts`, `secret-writer.ts` | lift | `v2/runtime/secrets.ts` + `v2/cli/release.ts` | Secret-writing for env vars stays. |

### A.3 `.opencode/tool/*` — MCP-shaped surfaces

| v1 path | Port | v2 destination | Rationale |
|---|---|---|---|
| `.opencode/tool/acc-state/` (33 submodules) | rewrite + collapse | `v2/substrate/*.ts` (extractors, views, types) + `v2/runtime/mcp_server.ts` | This is the v1 "MCP tool" surface — closest equivalent to the v2 daemon. Most submodules collapse into the daemon's MCP server + substrate extractors. The acc-state/audit, acc-state/migrations, acc-state/db files are lifted with renaming. Per-MCP-surface eviction and write-metrics survive as daemon background workers. |
| `.opencode/tool/serper/` | lift | seed bun code artifact `web_search` | Becomes a seed code artifact for the bun runtime (small fetch wrapper) — not a registered capability. |
| `.opencode/tool/tg/` | drop | — | Telegram surface gone (§22). |
| `.opencode/tool/state/` | drop | — | Subsumed by v2 substrate's view layer. |
| `.opencode/tool/pywebflow/runtime.py` | drop | — | Replaced by `camofox-browser` runtime (§22). |
| `.opencode/tool/env/` | drop | — | Env-var loading folds into daemon boot. |

### A.4 State directory (`state/*`)

| v1 path | Port | v2 destination | Rationale |
|---|---|---|---|
| `state/accint.db` (684 MB live) | freeze | `state/v1-archive/accint.db` (read-only) | v1 ledger archived; v2 starts fresh per §16. Optional curated seed import is owner-approved. |
| `state/accint.db-wal` / `db-shm` | drop | — | Tied to v1 connection state. |
| `state/browser-profiles/` | lift | `state/v2/camofox-profiles/` | Profile roots carry across; camofox runtime uses them. |
| `state/memories/` (knowledge JSONs + MDs) | rewrite | `state/v2/seed/` (optional foundational seed) | Curated entries can become seed knowledge_candidates; not auto-imported. |
| `state/entities/` | rewrite | substrate `entities_view` rows | Entity index becomes a typed extractor view (§4.2). |
| `state/runtime/` | drop | — | Runtime-state files vanish — daemon owns runtime state in memory. |
| `state/helia/`, `state/python-cache/` | drop | — | Specific to v1 sub-runtimes; v2 starts fresh. |
| `state/tg-outbox/`, `state/tg-sidecar.pid` | drop | — | Telegram gone. |
| `state/logs/`, `state/pids/`, `state/tmp/` | lift | `state/v2/{logs,pids,tmp}/` | Daemon writes here. |
| `state/fleet-state.json` | drop | — | Fleet feature is post-MVP. |

### A.5 Tests (`tests/*`, 399 files)

Tests are categorized by what they assert. Tests of a v1 surface that v2 drops do not port. Tests of an invariant v2 preserves are reauthored against v2 modules.

| v1 test category | Examples | Port | Rationale |
|---|---|---|---|
| **Substrate invariants** | `acc-save-*.test.ts`, `acc-state-*.test.ts`, `sqlite-*.test.ts`, `acc-pulse-*.test.ts` | rewrite | These cover the event ledger + projection invariants — exactly what v2 substrate must also satisfy. Re-authored against the v2 daemon's API. ~80 tests survive. |
| **Brain dispatch shape** | `brain-prompt-*.test.ts`, `brain-extraction.test.ts`, `brain-flight-*.test.ts`, `brain-lease.test.ts`, `brain-cycle-*.test.ts` | rewrite | Single-cycle dispatch shape (k_252-style discipline) preserved; brain-flight rewritten against daemon's in-memory serializer. Multi-cycle tests (brain-cycle-convergence) dropped. ~30 tests survive. |
| **Closure validator + predicate evaluator** | `closure-validator.test.ts`, `closure-keyed-fast-path.test.ts`, `predicate-evaluator-*.test.ts`, `contract-closure-*.test.ts` | drop | Validator and per-contract closure invariant are dropped (§22). The IDEA tests of verifier evaluation move to `artifact_admission` tests under v2. |
| **Contract lifecycle** | `contract-*.test.ts` (~50 files) | drop | Contract machinery dropped; no port. |
| **Verify orchestrator** | `verify-*.test.ts` | drop | v2 verification is whatever code the brain wrote; no shared orchestrator. |
| **Capability / tool admission** | `capability-compiler.test.ts`, `capability-manifest.test.ts`, `acc-task-rlm-surface-spec.test.ts` | rewrite | Re-authored as `code_artifact_admission` tests under v2. |
| **Embeddings & retrieval** | `acc-save-embedding-freshness-*.test.ts`, `acc-state-retrieval-bandit.test.ts`, `acc-state-search-lexical-rescue.test.ts` | rewrite | Re-authored against v2's embedder + retrieval modules. |
| **Recipe & replay** | `recipe-*.test.ts`, `acc-task-preseeds-cycle-prompts.test.ts` | lift | Recipe-shape tests carry across with minimal change. |
| **Father drift** | `father-*.test.ts`, `father-core.test.ts`, `father-tui.test.ts` | rewrite | Adversarial drift tests preserved against v2's in-process Father tick. |
| **Distribution / fleet** | `acc-router-*.test.ts`, `fleet-*.test.ts`, `distribute-*.test.ts` | drop | Fleet feature is post-MVP. |
| **Telegram / external channels** | `telegram-*.test.ts`, `tg-*.test.ts`, `owner-events*.test.ts` | drop | External channels gone. |
| **Action packet / exec** | `action-packet-*.test.ts`, `script-execution-sandbox.test.ts` | rewrite | Re-authored as `runtimes/{bun,uv}.test.ts` tests; sandbox tests preserved. |
| **Progress event / observability** | `progress-event.test.ts`, `state-contract-live-helptext.test.ts` | lift | Mirror-inline observability discipline preserved. |
| **Pulse / focus / govern** | `acc-state-pulse.test.ts`, `acc-state-goal.test.ts` | rewrite | Re-authored against daemon's projection RPC. |

Estimated v1 test survival: ~120 of 399 files port across (rewrites + lifts); the remaining ~280 are tests of dropped surfaces (contract lifecycle, closure validator, verify orchestrator, fleet, telegram, multi-cycle Ralph). v2 will add ~80 new tests for new surfaces (daemon lifecycle, external-push, code-artifact admission, dispatch decider, refinement-edge depth, prompt budget).

### A.6 Docs (`docs/*`)

| v1 doc | Port | v2 destination | Rationale |
|---|---|---|---|
| `whitepaper.md` | lift | `docs/whitepaper.md` | Canonical philosophy doc; cited throughout v2-design. |
| `v2-design.md` | this doc | `docs/v2-design.md` | Self-reference; current file. |
| `quickstart.md` | rewrite | `docs/v2-quickstart.md` (post-Phase D) | Re-authored against daemon CLI shape. |
| `acc-rlm-surface-spec.md` | lift (selectively) | `docs/v2-design.md` §13 | The RLM-surface-spec ideas are folded into §13 here. |
| `prompt-architecture.md` | lift (selectively) | `docs/v2-design.md` §13 | Folded into §13. |
| `science.md` | lift | keep | Static science background. |
| `runtime-ephemeral-sqlite.md`, `runtime-lock-audit.md`, `sqlite-*.md` | drop | — | v1-internal audits; not relevant to v2 daemon shape. |
| `substrate-consolidation-2026-05-11.md`, `system-subsystem-scorecard.md`, `universal-task-solver.md`, `universal-workflow-vision-plan.md` | drop | — | Working notes from v2 design rounds; superseded by this doc. |
| `pitch-deck.*`, `pitch-memo.*`, `verify-*.png`, `visuals/` | lift | keep | Marketing/visual assets unchanged. |
| `architecture/`, `generative-owner-surface/`, `papers/`, `visuals/` | lift | keep | Reference materials. |
| `*self-promotion*.md`, `accint_self_promotion_pipeline.json`, `reflybags-domain-research.md`, `hermes-compare.md`, `patterns-subjects-approaches-cleanup.md`, `tony-install-log-*.md` | drop | — | Operational artifacts of specific v1 directives; not core. |
| `brain-wake-up-*.md`, `gamified-onboarding.md`, `operator-handoff-security.md`, `ops-runbook.md` | drop | — | v1-specific operational docs. |

### A.7 Summary

- v1 → v2 lift: ~12 modules (paths, log, progress_event, crypto, profile, persona seed, recipe_replay, embedding API call, sandbox runners, owner-input event shape, whitepaper, science).
- v1 → v2 rewrite: ~25 modules (substrate views, brain dispatch, prompt composer, daemon boot, verify-as-artifact-admission, Father tick, constitutional gate, amendment handler, watch TUI, embeddings + retrieval + index, state CLI, init CLI).
- v1 → v2 drop: ~50 modules (entire contract lifecycle, closure validator, predicate evaluator file-scoped invariant, verify orchestrator content-addressed contamination machinery, multi-cycle Ralph, fleet distribution, telegram, owner notification surfaces, tg-outbox sidecar, helia, browser CLI, lock CLI, update CLI, operator-packet, surface-links, context-membrane).
- v2 new (no v1 ancestor): daemon.ts, embedding_index.ts in-memory HNSW, external_ingress.ts, dispatch_decider.ts, runtimes/camofox.ts as runtime (not host), refinement-edge depth check inside task_topology.ts.

Estimated effort: Phase B (daemon + minimum substrate) carries ~3-5 lifted modules and ~6 rewrites; the bulk of the rewrite cost is concentrated in Phases B-D where the daemon, the first runtime, and the brain dispatch land. Phases E onward are mostly additive new modules with focused tests.

## 23. Decision

Proceed with v2 phased cutover (Phase A through Phase L). Phase A is implementable immediately: this document is the deliverable.

The architecture is grounded in:
- **Whitepaper** — handle board, Bayesian scoring, provenance chains, judgment packet, iteration capsules, active inference, recipe scoring, Father, single-brain-first, constitutional gates, processor independence.
- **RLM paper (arxiv 2512.24601)** — substrate as recursive operator; symbolic handle; depth-1 retrieval; programmatic recursion via code; in-context decomposition examples as curriculum.
- **Brain critiques** — durable knowledge entries `k_3566`–`k_3642`: RLM-merger reasoning, RLM/DAG/async/tools architecture, universality findings, all integrated.
- **Operating reality** — multi-cycle brain dispatch is broken in v1; cycle 2 routinely fails. v2 commits to cycle-1-only with refinement edges as the inspectable substrate replacement for opaque iteration.
- **Subscription constraints** — Claude Code CLI + opencode CLI; no API tokens; no custom inference path.
- **Owner-as-only-human-in-the-loop** — the owner converses with Claude Code; there is no external-expert routing, no Telegram, no inbox, no licensure-bound escalation protocol. Health/legal/financial directives are normal directives.

The system IS the RLM. The substrate is the recursive operator AND the artifact broker. Reality scores predictions via verifier code artifacts that return scalar residuals. Knowledge and code artifacts accrete via the same outcome correlation through Beta posteriors counting both invokers. The brain writes code for three substrate-resident runtimes (bun, uv, camofox-browser); a "capability" is just a high-posterior code artifact. Refinement edges in the DAG replace multi-cycle iteration. Rolling-active directives accommodate long-horizon goals. Multi-stakeholder state captures the cases where more than the owner's utility matters. Self-modification uses the same workflow.

**One workflow. Three runtimes. Code-as-capability. Cycle-1-only. The owner is the only human in the loop. Any high-level goal.**

---

*Substrate is the recursive operator.*
*Models are temporary workers; the substrate writes the credit chain.*
*Verifiers are code; residuals are scalars; reality scores predictions through code the brain wrote.*
*One workflow. Any goal. Including improving itself.*
