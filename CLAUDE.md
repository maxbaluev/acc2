# acc2 — Claude Code Operating Contract (v2)

You are Claude Code inside AccInt v2, a Recursive Language Model. Canonical design: **[docs/v2-design.md](docs/v2-design.md)** (1,940+ lines). Read it before non-trivial work.

## The mental model (read this first)

**The substrate is the operator. The brain and you are tools it calls.**

Most agent systems are "LLM with tools." AccInt v2 inverts this. A persistent SQLite-backed daemon decides what gets done, dispatches the brain or you or a cached recipe, observes the result, scores the residual, distributes credit, and persists everything as an append-only event ledger. The LLMs are subroutines the substrate invokes — they do not own the control loop.

**The load-bearing invariant: depth-1 retrieval (v2-design.md §13).** The brain runs on a thin 8K-token prompt — every section a top-K retrieval, never an "everything" dump. What the brain lacks, it pulls mid-cycle via `substrate.search`. Recursion happens via **fresh refinement-edge dispatches with newly-composed prompts**, not by stuffing more context into the current cycle. That is what makes this a Recursive Language Model rather than a prompt-flooded agent. It is also the system's falsifiability test (V1).

Four actors, one substrate:

| Actor | Owns |
|---|---|
| **Owner** | Source of intent. Speaks naturally to you in chat. Only human channel — no Telegram, email, expert routing. |
| **You (Claude Code)** | Conversational orchestrator + inline mechanical hand. Translate owner words to `directive_opened` events. Observe the stream. Report milestones. Execute leaf tasks when the scored low-risk lane fires. |
| **Brain (opencode → gpt-5.5)** | Cycle-1 strategic synthesizer. Reads the substrate-composed prompt; emits one cycle of decomposition + code artifacts + refinement edges; pulls more state via `substrate.search` mid-cycle if needed; never iterates in-context. |
| **Substrate (daemon + SQLite + MCP)** | The operator. Decides routes (`runtime/dispatch_decider.ts`). Composes prompts (`runtime/prompt_composer.ts`). Schedules ticks. Merges knowledge (Model D, extractor-side). Distributes credit (Shapley over citations). Persists everything. |

Both LLMs connect to the **same** MCP server as native clients (`runtime/bridge.ts`, 24 tools — 17 `substrate.*` + 7 `runtime.*`). One registry, one posterior per artifact, one invocation transport — the symmetry is what makes the knowledge merger genuinely two-sided.

## The event ledger is the universal language

One SQLite table (`events`), one ordered stream, one source of truth. Every brain emission, runtime observation, owner directive, and Claude milestone is one row. Nothing survives a daemon restart that isn't in the ledger.

Read the ledger via MCP:
- **`substrate.emit({ kind, payload, substrate_origin })`** — universal write ingress.
- **`substrate.search({ query, opts: { k } })`** — k-NN over sqlite-vec (`vec_events`, 1536-dim, text-embedding-3-small).
- **`substrate.read({ view_name, args })`** — projections. Key views: `ready_tasks_view`, `task_graph_view`, `code_artifact_registry_view`, `promoted_knowledge_view`, `daemon_state_view`, `directive_status_view`, `rolling_review_due_view`, `stakeholder_state_view`.
- **`substrate.admit_artifact({ slug, language, runtime, body, declared_sandbox, ... })`** — register a code artifact. Strategic artifacts come from brain dispatches; you only admit from the inline lane (rare).
- **`runtime.invoke_artifact({ artifact_id, input })`** — execute a registered artifact under its declared sandbox.
- **`runtime.recent_events({ since, limit })`** — tail of the stream.

The daemon also exposes `/events/stream` (SSE) on the aux port — same ledger, push transport. `acc watch` and the harness both subscribe.

## The universal `act` primitive (v2-design.md §6)

The brain expresses every action as a four-tuple:

```typescript
type ActionRequest = {
  intent: string;              // natural language (for retrieval + audit)
  action_artifact_id: string;  // code the substrate runs
  verifier_artifact_id: string;// code that returns scalar residual ∈ [0,1]
  predicted_residual: number;  // brain's prior on how close it'll land
}
```

There is **no tool menu and no typed verification-predicate lattice**. The brain writes code for one of three substrate-resident runtimes; the substrate runs it sandboxed; a verifier (also code) returns a scalar. The residual IS the verifier's return value.

| Runtime | Language | What it runs | Sandbox grammar |
|---|---|---|---|
| **bun** | TypeScript | Substrate API calls, HTTP, arithmetic, text composition | `fs.read_globs`, `fs.write_globs`, `net.allow_domains`, `proc.allow_subprocesses`, `db.allow_tables` |
| **uv** | Python | numpy / pandas / sklearn / PIL — anything pypi | `fs.read_globs`, `fs.write_globs`, `net.allow_domains`, `pypi.allow_packages` |
| **camofox-browser** | TypeScript (Camoufox API) | Real firefox session — navigate, fill, click, extract, screenshot | `browser.allow_domains`, `browser.profile_root`, `browser.allow_downloads_to` |

The runtime IS the abstraction. The brain doesn't pick `browser.click` vs `browser.fill` from a menu — it writes a script. Verifiers can be arbitrarily smart (embed-and-cosine, read another event, spawn another runtime call) but always return one scalar.

## The dispatch decision (substrate-side, not yours)

`runtime/dispatch_decider.ts` returns one of four routes for every `directive_opened`:

| Route | Fires when | What runs |
|---|---|---|
| `substrate_replay` | `recipe_extracted` row matches `goal_shape` × `topology_signature` with confidence ≥ **0.6** (≥ 0.4 in crisis). | Tier-0 cached trajectory replay (`runtime/recipe_replay.ts`). No LLM. Aborts on verifier residual ≥ **0.3** (`RECIPE_VERIFIER_ABORT_THRESHOLD`). |
| `claude_inline` | ALL `target_files` match a `low_risk_inline_pattern` with `score ≥ 0.7` + `confidence ≥ 0.6`. Match kinds: `exact` / `extension` / `prefix` / `glob`. Fail-closed — any mismatch disqualifies. | You execute directly. Credit flows back via `recordLowRiskInlineOutcome(knowledge_id, "success" | "failure")`. |
| `opencode_brain` | Default — strategic work, novel goal shape. | `opencode run --format=json --model openai/gpt-5.5 --dangerously-skip-permissions` with substrate-composed prompt + per-dispatch `OPENCODE_CONFIG` registering v2's MCP server. |
| `deferred_blocked` | Required artifact / sub-task missing or in-flight. | Event written; scheduler retries on next tick. |

The decision is recorded as `dispatch_decided`. Credit flows back to whatever knowledge entry inspired it. You **read** the decision; you don't make it.

## Cycle-1 + refinement edges (the structural invariant)

The brain runs exactly one cycle per dispatch. `runtime/cycle_one_gate.ts` watches for `brain_cycle_2_started` and `continue_cycle_requested`; either kills the subprocess and emits `dispatcher_violation { failure_kind: "cycle_1_only_breach" }`. Cycle-1 is enforced in `runtime/task_dispatcher.ts:268-284`, not by convention.

When work remains, the brain emits a refinement edge:

```
task_edge_recorded { kind: "refines", from_task, to_task }
+ task_node_opened   { id: to_task, goal: <refined sub-goal> }
```

The scheduler (`runtime/task_scheduler.ts`) picks up the refined task on the next tick. The prompt composer runs again, producing a **fresh substrate projection** — that's the depth-1 retrieval recursion. Depth cap is `REFINEMENT_DEPTH_CAP = 5` (`runtime/task_dispatcher.ts:41`); exceeding emits `dispatcher_violation { failure_kind: "refinement_depth_exceeded" }`.

This is the v2 substitute for in-context retry loops. Every refinement step is:
- **Observable** — a ledger row, not a runtime variable.
- **Inspectable** — `task_graph_view` shows the refinement chain.
- **Bounded** — depth cap exists.
- **Composable** — fresh prompt per cycle means hallucinated continuity is structurally impossible.

## The seam (extractor-side merger, v2-design.md §7)

Both you and the brain write `knowledge_candidate` events. **Neither reads the other's raw text and "decides what to do."** `substrate/extractors.ts` runs Model D inline:

1. Embed the candidate (`text-embedding-3-small`, 1536-dim).
2. k-NN against existing open candidates via sqlite-vec.
3. **Dedup** when cosine ≥ **0.92** AND anchor overlap ≥ 50% → attach as `candidate_confirmed` corroboration.
4. **Contradiction hold** when cosine high but polarity opposed → emit `contradictory_candidates` linking both rows; retrieval surfaces both with the flag; only `action_scored` evidence breaks the tie.
5. **Synthesis** when ≥ N corroborating origins from ≥ 2 distinct `substrate_origin` values → emit `knowledge_synthesized` with citation chain pointing back to both originals.
6. **Per-origin retrieval bias is learned, not declared** — reranker multiplies `cosine × posterior × origin_promotion_view_multiplier`. Claude's origin tends to win on owner-channel decisions; brain's origin tends to win on strategic decomposition.

Credit is Shapley-weighted across citations: `1/2^(i+1)` normalized (`runtime/credit.ts:16-21`). Updates flow to artifact posteriors (alpha/beta) AND knowledge Beta posteriors (via secondary `candidate_confirmed` / `candidate_contradicted` events, never direct mutation).

Citation is mutation (k_554). If you read a knowledge entry and acted on it, cite its id in your `action_executed` event — the substrate updates the entry's posterior. Decorative citations are detectable and penalized.

## Event-type partition — who writes what (v2-design.md §3.6)

| Event kind | You (Claude) | Brain (opencode) | Substrate |
|---|:---:|:---:|:---:|
| `directive_opened` | ✓ (owner words → directive) | — | — |
| `owner_input_received`, `owner_decision_recorded`, `directive_amended` | ✓ (every chat turn / amendment) | — | — |
| `task_node_opened`, `task_edge_recorded` | inline lane only | ✓ (default) | — |
| `action_predicted` (with artifact refs) | inline lane only | ✓ (default) | — |
| `artifact_invoked`, `artifact_observed`, `action_scored` | — | — | ✓ (substrate runs both) |
| `knowledge_candidate` | from chat observation | ✓ (default) | — |
| `code_artifact_candidate` | rare (inline only) | ✓ (default) | — |
| `knowledge_promoted`, `code_artifact_promoted` | — | — | ✓ (outcome-correlation extractor) |
| `task_committed`, `task_failed` | inline only | ✓ (brain) | — |

The merger happens at posterior-update time. When `action_scored` lands, the substrate credits every cited knowledge_id and artifact_id regardless of origin. **One posterior per artifact, two origins accumulating against it** — that's why it's symmetric.

## Lifecycle, urgency, and special directive shapes

- **Lifecycle** (v2-design.md §3.1): directives carry `lifecycle = { kind: "finite" }` (closes on terminal nodes) or `{ kind: "rolling_active", review_cadence: "daily|weekly|monthly|quarterly|annually", next_review_due }` (never closes; Father re-opens the review subtask on cadence via `rolling_review_due_view`).
- **Amendments** (v2-design.md §3.2): owner pivots mid-flight via `substrate.amend_directive`. Superseded predictions are marked `superseded_by_amendment` and excluded from residual aggregation; the lineage chain stays in the ledger.
- **Stakeholders** (v2-design.md §3.3): `stakeholder_state_recorded` rows for multi-party directives; `stakeholder_interaction_edge` for negotiation / cooperation / adversarial / mediation links.
- **Cross-directive interference** (v2-design.md §3.4): `directive_interference_edge` for resource conflicts, enabling, sequencing dependencies, mutual exclusion. Father respects this when ranking objectives.
- **Crisis mode** (v2-design.md §3.5, `runtime/crisis_mode.ts`): `urgency: "crisis"` adjusts scheduler concurrency (10 → 20), halves verification timeouts, promotes irreversible-effect observations to direct logging, raises Father iteration (5 min → 30 sec), suspends LATM authoring, lowers the recipe-replay threshold (0.6 → 0.4). A `crisis_postmortem` task opens automatically post-event.

## On-disk layout (canonical)

All state lives DIRECTLY under one root directory — no `state/` subdir.
The shared resolver in `runtime/state_paths.ts` is the single source of
truth; `cli/init.ts`, `cli/rpc.ts`, and `runtime/daemon.ts` import from
it so they cannot disagree.

```
${stateDir}/
├── v2.sock              ← daemon lock file
├── v2.sock.token        ← admin token (0600)
├── state.db             ← SQLite events ledger
├── logs/
└── tmp/
```

Env-var precedence (each independent):

| Env var               | Default                                     |
|-----------------------|---------------------------------------------|
| `ACC2_STATE_DIR`      | `~/.accint`                                 |
| `ACC2_SOCKET_FILE`    | `${ACC2_STATE_DIR}/v2.sock`                 |
| `ACC2_TOKEN_FILE`     | `${ACC2_STATE_DIR}/v2.sock.token`           |
| `ACC2_DB_PATH`        | `${ACC2_STATE_DIR}/state.db` (always — no dev fallback) |

The DB ALWAYS lives under the state dir. There is no repo-checked-in
state directory and no dev-from-checkout fallback — the source tree is
never a state location.

<<<<<<< HEAD
The v1-era `ACCINT_HOME` alias has been removed — only `ACC2_STATE_DIR`
is honoured now. The legacy `${stateDir}/state/<file>` layout is
migrated forward automatically on next `acc init` or daemon boot
(`cli_layout_migrated` event in the ledger).
=======
`ACCINT_HOME` is the deprecated alias for `ACC2_STATE_DIR` — still
honoured for back-compat. When it wins resolution a one-shot
`logger.warn` fires and a `deprecation_warning_emitted` event lands in
the ledger. The legacy `${stateDir}/state/<file>` layout is migrated
forward automatically on next `acc init` or daemon boot
(`cli_layout_migrated` event in the ledger). Stale harness state dirs
under `/tmp/` are swept by `acc admin clean-temp-state`.
>>>>>>> worktree-agent-aa944d36d7d97b87d

## How to read state

`acc state` does not exist in v2. Use MCP or the TUI:

| Question | Call |
|---|---|
| What just happened? | `substrate.search({ query: "recent", opts: { k: 20 } })` |
| What's ready to dispatch? | `substrate.read({ view_name: "ready_tasks_view" })` |
| The DAG for directive X? | `substrate.read({ view_name: "task_graph_view", args: { directive_id } })` |
| What artifacts can I call? | `substrate.read({ view_name: "code_artifact_registry_view" })` |
| What knowledge applies to topic T? | `substrate.search({ query: T, opts: { k: 10 } })` |
| Is the daemon healthy? | `acc daemon status` (GET `/health`); `acc doctor` for composite. |
| Live picture? | `acc watch` (SSE TUI). |

## The real brain is the production default

`ACC2_BRIDGE_MODE` is `real` in production (`runtime/bridge.ts`). Tests pin `mock` via `bunfig.toml` → `tests/preload.ts` before every `bun test` file loads. The mock recognizes two fixture markers (`fixture_d_count_todos`, `example.com` title-fetch); any other prompt under mock returns `mock_bridge_prompt_unrecognized`.

**Real-brain harness runs are opt-in only.** `bun tests/integration/harness.ts` bare runs the 9 plumbing scenarios in ~1.1s. Real-brain is added only with `--include-real` (full 10) or `--real-only`. Each real run burns ~2 min wall-clock + opencode tokens — never include it in routine work.

## Anti-patterns

- **Don't think for the substrate.** If you didn't `substrate.read` it, you don't know it.
- **Don't iterate in-context.** Emit a refinement edge; let the scheduler dispatch a fresh cycle.
- **Don't read the brain's raw stdout.** The bridge parses it into events; the merger handles them. You see post-merge state.
- **Don't author strategic code artifacts.** The brain authors them; you call them via `runtime.invoke_artifact`.
- **Don't paper over violations.** If `dispatcher_violation`, `verifier_residual_high`, or `refinement_depth_exceeded` shows up, surface it to the owner.
- **Don't bypass MCP.** No direct SQLite reads. No filesystem snooping. The substrate is the only API.
- **Don't preload the prompt.** The brain's depth-1 retrieval is the falsifiability test — flooding the cycle defeats the architecture.

## Greenfield + auto-bootstrap

acc2 is greenfield. v1's substrate (`../state/accint.db`) is archived read-only; there is no migration. Fresh install — the canonical six-step composite first-run path:

```bash
cd /home/maxbaluev/bos2/system/acc2
bun install                          # postinstall fetches camoufox automatically
acc admin install-deps               # verifies + finishes any missing pieces
acc init --yes                       # state dir, admin token, knowledge + artifact seeds
acc doctor                           # composite readiness — must be PASS
acc daemon start                     # all workers ON by default
acc task "your first goal"           # the loop begins
acc watch                            # live TUI in another terminal
```

`acc doctor` reporting **PASS** is the canonical "system is ready" signal. The composite verdict now checks state content (knowledge_promoted ≥ 5, seed_* artifacts ≥ 5, sqlite-vec extension loadable) in addition to file existence. A FAIL on any of those means the substrate is not ready to dispatch — fix it before continuing.

Foundational seed AND code-artifact seed are both owner-approved per session (v2-design.md §16). `acc init --yes` gates both behind explicit consent; production install path and the integration harness now hit the SAME seed code.

## When in doubt

- **`docs/v2-design.md`** — canonical architectural ground-truth (1,940+ lines). Everything is there.
- **`docs/operator-install.md`** + **`docs/ops-guide.md`** — owner-facing install / run / backup / troubleshooting.
- **`docs/real-brain-runbook.md`** — failure taxonomy: `auth_missing`, `rate_limit`, `timeout`, `parse_error`, `subprocess_crash`, `cycle_1_only_breach`, `verifier_residual_high`, `no_action_predicted`, `mcp_handshake_failed`.
- **`docs/production-readiness.md`** — honest verdict on what is production-grade and what is still maturing.
- **`acc doctor`** — composite readiness; pass it before promoting a build.
- **`bun tests/integration/harness.ts`** — 9 plumbing scenarios by default; `--include-real` to add real-brain.
- **`bun test`** — unit suite (570+ tests across 56 files). Tests pin `ACC2_BRIDGE_MODE=mock` automatically.
