# AccInt — Architecture

A universal, self-extending, posterior-scored organism. One SQLite events ledger is the canonical state. LLMs (Claude, opencode/gpt-5.5) are subroutines the substrate calls; they do not own the loop. Every action is a four-tuple (intent + action artifact + verifier artifact + predicted_residual); every verifier returns a scalar residual ∈ [0,1]; every cited knowledge or artifact id earns posterior credit on outcome. The system compounds by accumulating events, promoting knowledge through outcome correlation, and ranking artifacts by Beta posterior.

This document is **current state + path to final state**. Section 1 is the operating contract. Sections 2–10 are shipped architecture, each row cited to module + tests + live substrate evidence. Section 11 is the open frontier — what is PARTIAL today and the contracts that close it.

This replaces the prior `docs/v2-design.md` (v2 design plan). The plan's `§17 Phased Cutover` shipped; the design intent migrated here and the prose-heavy speculation was archived. Where a prior section number is still useful for tracing, it is named inline.

Live substrate snapshot (2026-05-19 18:26 UTC): **260 839 events** · **1 490 act_artifacts** (27 seed, 1 463 brain-authored) · **304 promoted_knowledge** · **598 recipe-shape knowledge** rows · **15 251 vec_events** embedded · **0 stuck workers** · `verdict: ALIVE`.

---

## 1. Top Laws (auto-compiled from scored knowledge ≥ 0.95)

The substrate's highest-scored principles by Beta posterior. They govern every decision in the organism. Citing a law's event_id in an action's `cited_knowledge_ids` is how credit flows back when the law shapes an outcome (k_201, k_554, k_555).

| # | Law | Citation |
|---|-----|----------|
| 1 | Cycle-1-only is structural. The dispatcher rejects self-iteration; refinement edges replace cycle 2+. | `206B19C06C2E461A8E8C3720C6` |
| 2 | Verifier code artifacts return a scalar residual in [0,1]. 0 = goal met; 1 = goal missed. | `01EFDC6E614E47E4B9F4FE73FF` |
| 3 | v2 does not migrate from v1. The substrate launches empty; v1 is archived read-only. | `5480522523764A4AB6E0BCCAC7` |
| 4 | Owner channel is Claude Code chat only. No telegram, no email, no licensed-expert routing. | `0E53D8E6241B47B989CDA6B5DA` |
| 5 | Exit invariant — every brain cycle MUST invoke at least one `substrate.*` tool call before exit. Producing only conversational text is `brain_silent_exit`, not a transport issue. | `4EAFA894A8194C4CA74F08430C` |
| 6 | Self-extension occurs by admitting rows and crediting them through `act_tuple_recorded.cited_artifact_ids`. The same machinery that ranks knowledge ranks act_artifacts. | `T8A83QFGHX72996DCVPQV8K93G` |
| 7 | Same substrate at two timescales — judgment and knowledge are the same primitive. | k_200 |
| 8 | Citation = mutation. Citation without state mutation is decorative memory. | k_554 |
| 9 | Four links — create → retrieve → mutate retrieval state → credit outcome. | k_555 |
| 10 | Advisory = fake. Advisory gates that don't change behavior are k_252 violations. | k_252 |

`acc state search "<topic>"` returns the current top-K laws ranked by score. The composer in `runtime/prompt_composer.ts` surfaces the live top laws on every brain dispatch (floor section; never truncated).

---

## 2. Universal Workflow

The organism runs one loop for every goal — business outreach, research, code change, embodied work, life decisions, self-improvement. The only thing that differs across goals is which action/verifier artifacts are composed.

```
owner words → directive_opened (acc task "...")
            ↓
substrate routes (substrate_replay | claude_inline | opencode_brain | deferred_blocked)
            ↓
brain or replay emits act tuple (intent + action + verifier + predicted_residual)
            ↓
runtime executes action artifact → action_predicted event
            ↓
runtime executes verifier artifact → action_scored event with residual ∈ [0,1]
            ↓
substrate distributes Shapley credit across cited knowledge + artifacts
            ↓
posterior updates → promotions / quarantine / retirement
            ↓
closure_audit verifies directive intent met; emits lesson_extracted on friction
```

Cycle-1-only is structural. Refinement edges (`task_edge_recorded.kind = 'refines'`) replace iteration; the dispatcher kills any cycle-2 attempt and emits `dispatcher_violation`.

**Reference:** `runtime/task_scheduler.ts`, `runtime/task_dispatcher.ts`, `runtime/task_topology.ts`. Verifier residual is the universal score — same primitive for code correctness, research quality, owner emotional outcome.

---

## 3. Substrate — One Events Table, Many Views

`substrate/schema.sql` declares one append-only `events` table. Every domain primitive is an event kind in `substrate/event_kinds.ts` (open-vocabulary registry, currently ~120 entries). Schema invariants:

- `events(id, ts, directive_id, task_id, parent_task_id, loop_id, substrate_origin, kind, payload, context_refs, failure_kind, residual, predicted_residual, action_artifact_id, verifier_artifact_id, embedding, embedding_version)`
- `act_artifact(id, runtime, kind, body, declared_sandbox, score, confidence, posterior_alpha, posterior_beta, status, recent_residual_mean, recent_kill_count, supersedes, superseded_by, …)`
- `vec_events` virtual table (sqlite-vec) — disk-resident embedding index over `events.embedding`.

**Views (computed projections, `substrate/views.ts`, ~6 000 LOC):** 38 named views including `task_graph_view`, `ready_tasks_view`, `dispatch_resolved_view`, `act_artifact_registry_view`, `embedding_index_view`, `promoted_knowledge_view`, `top_laws_view`, `owner_profile_view`, `owner_rendering_policy_view`, `directive_view`, `task_critical_path_view`, `active_inference_view`, `artifact_warning_view`, `model_routing_view` (the last five landed `f92b652` 2026-05-19, closing the §4.2 named-views gap).

**Workers (`runtime/daemon.ts`):** every always-on subsystem registers via `runtime/worker_autostart.ts`. Canonical opt-out: `ACC2_DISABLE_WORKERS=<csv>`. Reactive workers wake on event publication (`runtime/activation_bus.ts`); the shared 30-min `reactive_safety_net` guarantees deadline coverage. Timer-only workers handle elapsed-time decay (recipe_inertia 1h, rehabilitation 30min, integrity 6h, compaction 1h, lifecycle_closure_sweep 6h).

**Tests:** `substrate/views.test.ts` (92 tests, all 38 views projected), `runtime/daemon.test.ts`, `tests/wal_burst_resilience.test.ts`, `tests/restart_quiescence.test.ts`.

---

## 4. The Substrate Daemon — Always-On, Externally-Reachable

The daemon IS the operator. `runtime/daemon.ts` (~2 200 LOC) owns:

- The WAL-backed SQLite connection (single writer per process; multi-process WAL coexistence is safe — `ACC2_DAEMON_ROLE=server|worker|all` allows split deployment).
- The MCP server (`runtime/mcp_server/index.ts`, fastmcp Streamable-HTTP at `/mcp`) — brain and CLI consume the same substrate surface.
- External ingress (`runtime/external_ingress.ts`) — webhook POST → `external_event_received`, per-source bearer tokens registered via `substrate.register_external_source`.
- Worker supervision (`runtime/supervisor.ts`) — redispatch-storm / DAG-explosion / bridge-health detection on a 30s reactive tick.
- Health + readiness (`runtime/readiness.ts`) — every always-on worker registers its tick deadline; `/health` flags stuck workers.
- Hot reload (`runtime/hotreload_manifest.ts`, `runtime/hotreload_worker.ts`) — declared module manifest with in-process / quiescent / full-restart strategies. The composer reload is via reloadable slot so live brain dispatches see new logic without restart.
- Restart drain (`runtime/daemon_supervisor.ts`) — graceful shutdown with bounded drain budget.

State paths (`runtime/state_paths.ts`): single canonical layout under `${ACC2_STATE_DIR ?? ~/.accint}`. No `state/` subdir, no v1 alias.

**Tests:** `runtime/daemon.test.ts`, `runtime/external_ingress.test.ts`, `runtime/mcp_server.test.ts`, `tests/restart_quiescence.test.ts`, `tests/wal_burst_resilience.test.ts`, `runtime/daemon_supervisor.test.ts`.

---

## 5. The Universal Act Primitive

Every action is an `act_tuple_recorded` event with shape:

```typescript
{
  intent: string,              // free-text statement of what the action is for
  action_artifact_id: string,  // open-vocabulary id; registry row in act_artifact
  verifier_artifact_id: string,
  predicted_residual: number | { value: number, feedback_window: { duration_ms, classification } },
  reasoning_summary: string,
  effect_summary: string,
  verifier_kind: string,       // open-string vocabulary: deterministic_code, peer_llm_claude,
                                //   owner_confirmation, external_signal, owner_emotional_signal, …
  cited_knowledge_ids: string[],
  cited_artifact_ids: string[],
  affected_resource_refs: ResourceRef[],
}
```

The substrate's `projectActTupleRecorded` (`runtime/events.ts`) expands one envelope into derived rows: `action_predicted`, `action_scored`, `applied_change_committed`, `retrieval_binding`, `candidate_confirmed` / `candidate_contradicted`, `owner_observed_outcome_recorded`. Idempotency keys = `source_act_id + projection_kind + role/target`.

The runtime is the abstraction on one side; the act_artifact registry row is the abstraction on the other. **There is no closed enum for verifier_kind or artifact kind** — vocabulary is discovered through use (k_252-closure proof: a closed enum is a typed-predicate-lattice the substrate refuses).

**Reference:** `runtime/act_tuple.ts`, `runtime/events.ts`, `runtime/internal_act_projection.ts`. Tests: `runtime/act_tuple.test.ts`, `runtime/events.test.ts`, `runtime/internal_act_projection.test.ts`.

---

## 6. Runtimes — Three Sandboxes, One Registry

Action and verifier artifacts run in one of three sandboxed runtimes. Each declares a sandbox via `declared_sandbox` in the artifact registry row; admission runs the fixture once and refuses if residual >= 0.2.

| Runtime | Module | Purpose | Sandbox shape |
|---|---|---|---|
| **bun** | `runtime/runtimes/bun.ts` | TypeScript code: substrate API, HTTP, arithmetic, text | `cpu_ms`, `wall_ms`, `memory_mb`, `fs_read[]`, `fs_write[]`, `net_allow[]`, `proc_allow[]`, `env_requires[]`, `substrate_access: ro|rw` |
| **uv** | `runtime/runtimes/uv.ts` | Python: numpy/pandas/PIL/scrapy/etc., nsjail-isolated when present | Same shape; `env_requires` for credentials |
| **camofox-browser** | `runtime/runtimes/camofox.ts` | Playwright + Camoufox: browser-driven workflows under stateful per-profile mutex | `CAMOUFOX_OS / LOCALE / HEADLESS` env, per-profile-root mutex |

Sandbox enforcement state (PARTIAL — frontier): bun has full nsjail enforcement on Linux when nsjail is installed; uv and camofox have parity gaps tracked under the §11 frontier. Honor-system warnings emit `sandbox_unenforced_warning` so audit catches what wasn't structurally enforced.

**Subprocess supervision (`runtime/subprocess_lifecycle.ts`):** every runtime emits the canonical lifecycle: `runtime_subprocess_started → runtime_subprocess_resource_warning? → runtime_subprocess_soft_terminated | runtime_subprocess_hard_killed | runtime_subprocess_orphaned`. Health metrics surface in `dispatch_resolved_view`.

**Tests:** `runtime/runtimes/bun.test.ts`, `runtime/runtimes/uv.test.ts`, `runtime/runtimes/camofox.test.ts`, `runtime/sandbox.test.ts`.

---

## 7. Brain Bridge — opencode Subprocess (Strict Read-Only Surface)

`runtime/bridge/opencode.ts` (~1 500 LOC) spawns `opencode run --format=json --agent acc2-brain --model <model> <prompt>` and streams its NDJSON frames into `bridge_frame_received` events. Frame shapes: `step_start`, `tool_use`, `tool_result`, `text`, `error`.

The brain is **read-only against the source checkout** (k_201 proof of provenance):

1. The agent block in OPENCODE_CONFIG enumerates positive tools only (`runtime/bridge/config.ts:BRAIN_OPENCODE_TOOL_SURFACE`): `read`, `glob`, `grep`, `list`, `lsp`, and every `substrate.*` / `runtime.*` MCP method.
2. The top-level `permission` map stamps explicit `deny` for every filesystem-write tool: `bash`, `edit`, `write`, `apply_patch`, `task`, `external_directory`, `repo_clone`, `repo_overview`, `patch`, `multiedit`, `shell`. (Commit `1570521`, 2026-05-19 — earlier positive enumeration alone was insufficient: opencode 1.14.50 treats `tools` as additive, so the deny gate is the load-bearing structural fix.)
3. The brain cwd is an isolated tempdir per dispatch.

Brain side effects flow only through the substrate event ledger: `brain_dispatched`, `bridge_frame_received`, `brain_reasoning_recorded`, `brain_message_emitted`, `act_tuple_recorded`, `knowledge_candidate`, `act_artifact_candidate`, `contract_amendment_proposed`, `lesson_extracted`, `task_committed`, `bridge_completed | bridge_failed`. Claude-side `cli/apply.ts` applies brain-proposed amendments under the ApplyRoute predicate (`AUTO_APPLY | OWNER_GATE | AUTO_DEFER_DEPENDENCY | AUTO_DECLINE_*`).

Failure-mode hardening: `bridge_stuck` watchdog (first-frame deadline), `brain_silent_exit` classifier (zero substrate frames + exit_code 0), overall wall-clock timeout, mcp-handshake window.

**Tests:** `runtime/bridge.test.ts` (19 tests), `runtime/bridge_health.test.ts`, `runtime/alignment/*.test.ts`.

---

## 8. Knowledge Merger (Model D)

`substrate/extractors.ts` (~1 800 LOC) is the substrate's brain. It runs reactively on every new candidate emission and on a 5-min safety-net tick. Pipelines:

- **Semantic dedup (§3.6.1 Rule 1):** cosine-similarity over `vec_events`; ≥ 0.92 collapses into one row with corroborating evidence.
- **Contradiction holding (Rule 2):** opposing candidates at the same goal/anchor produce `contradictory_candidates` rows; neither promotes until owner adjudication or counter-evidence.
- **Synthesis (Rule 3):** sufficiently corroborated candidates emit `knowledge_synthesized` whose citation chain points to BOTH source events.
- **Per-origin posterior bias (Rule 4):** `origin_promotion_view` + `origin_promotion_by_directive_view` learn that some origins (`claude_root` vs `opencode`) promote at different rates per goal_shape; reranker uses both global and per-shape signals.
- **Posterior promotion (`maybePromoteKnowledge`):** Beta posterior lower bound vs per-owner-per-goal-class threshold (`runtime/posterior_promotion.ts`).

Both Claude and the brain emit `knowledge_candidate` and `act_artifact_candidate` as co-equal inputs to the same merger. **Neither LLM makes canonical knowledge by assertion.**

**Recipe-shape knowledge** (`payload.recipe_shape.enabled = 1`) replaces the former first-class `recipe_extracted` event family (universality proposal #2, commits `2c6ef8f` + `67c430a` + `5567e90`). 598 recipe-shape rows live; `recipes_latest_view` and `recipe_registry_view` project them.

**Tests:** `substrate/extractors.test.ts`, `runtime/knowledge_dedup.test.ts`, `tests/non_technical_n1_promotion.test.ts`.

---

## 9. Dispatch & Routing

`runtime/task_scheduler.ts` + `runtime/task_dispatcher.ts` + `runtime/dispatch_decider.ts`. Routes (open-string, current vocabulary):

- **`substrate_replay`** — recipe match confidence >= `RECIPE_REPLAY_THRESHOLD` (0.85). Brain-free dispatch; substrate replays the action/verifier trajectory.
- **`claude_inline`** — low-risk leaves identified by `low_risk_inline_patterns_view` (scored knowledge with `pattern_kind` ∈ `extension|prefix|exact|glob`). Main Claude instance executes; no opencode subprocess.
- **`opencode_brain`** — full brain dispatch.
- **`deferred_blocked`** — preconditions failed (target file in another terminal's claim, irreversible effect pending owner consent, etc.).

`dispatch_decided` event records the route, open-ended `routing_axes` (one_shot_confidence, information_gap, reversibility, owner_control_need, decomposition_value, cost_pressure, time_sensitivity), and per-route `route_scores`. **Routing axes are open-vocabulary; new axes emerge by appearing in events, not by enum extension** (universality proposal #6, commit `f7e2836`).

**Fairness floor (commit `b305719`):** age bonus prevents operator-dispatch starvation when brain refinement edges saturate the scheduler. Beyond 5 min of waiting, age bonus grows linearly; after 30 min it beats any branchCompetitionScore. Operator dispatches never starve indefinitely.

**Multi-stakeholder + interference + crisis mode:** `runtime/stakeholder_compositor.ts`, `runtime/interference.ts`, `runtime/crisis_mode.ts`. Each surface has a passing fixture in `runtime/fixtures/d_*.ts`.

**Tests:** `runtime/task_scheduler.test.ts`, `runtime/task_dispatcher.test.ts`, `runtime/dispatch_decider.test.ts`, `runtime/fixtures/*.test.ts` (8 universal-goal pilots).

---

## 10. Credit, Retrieval, Owner, Closure

### Credit (`runtime/credit.ts`)

Shapley distribution across cited knowledge + artifacts. One outcome (`action_scored.residual`) flows to:
- The action artifact (Beta posterior update).
- The verifier artifact (verifiers accrue their own posterior).
- Every cited knowledge_id (emits `candidate_confirmed | candidate_contradicted`; the extractor recomputes the candidate's Beta posterior synchronously after each credit emit — Audit `b7kjyk2k1` cold-start fix).
- Every cited act_artifact (via `act_artifact_score_updated`).

Weights = `raw_i / Σ raw` where `raw_i = 1 / 2^(i+1)` in first-seen order. LATM novelty bonus (1.5×) on first credit for an artifact's novel goal_shape (`runtime/goal_shape.ts`).

### Retrieval (`runtime/retrieval.ts`, `runtime/embedding_index.ts`, `runtime/embedder.ts`)

Disk-resident `sqlite-vec` `vec_events`. Query path: embed query → SQL KNN against `vec_events` → cosine-distance hits → rerank by `score × (1 + posterior bias)` × per-section K-cap. The composer slot in `runtime/prompt_composer.ts` carries open-ended `aspect_weights` and `domain_hints` so callers steer retrieval. Embeddings are `text-embedding-3-small` (1536 dims).

Brain prompt budget default 32 000 tokens (`runtime/prompt_composer.ts:DEFAULT_BUDGET_TOKENS`, commit `25eb1e9`). Floor sections (top_laws, owner_profile, owner_rendering_policy, retrieved_knowledge) resist truncation; budget overruns emit `dispatcher_violation{kind: floor_section_missing}` observational events but do not refuse the compose.

### Owner Model (`runtime/owner_profile.ts`, `runtime/owner_gate.ts`)

Open-ended learned profile (not a persona enum). Fields the substrate observes and re-derives from outcomes:
- `rendering_signals`, `autonomy_signals`, `control_signals`, `risk_signals`, `collaboration_signals`, `goal_continuity_signals` — each `Record<string, number>`, all keys discovered through evidence.
- `preferred_terms`, `avoided_terms`, `exposed_concepts`, `understood_concepts`, `declined_concepts`, `detected_language`, `autonomy_score`, `autonomy_scope`, `manual_review_patterns`, `time_window`, `hot_topics`, `things_to_never_do`.

`owner_observed_outcome_recorded` events feed back to credit; `owner_insight_candidate` / `owner_profile_recorded` updates durable preferences.

### Closure & Learning (`runtime/lifecycle_closure_sweep.ts`, `runtime/closure_audit.ts`)

A root task is not complete until a closure verifier emits `task_closure_audited` with `closure_residual < 0.3`. Every substantive trajectory extracts either:
- `contract_amendment_proposed` — repo/docs/CLI drift, anchored_replace_v1 diff with `target_resource` + `anchor` + `before` + `after`.
- `lesson_extracted` — reusable process/recipe/verifier/failure pattern.

`feedback_window` semantics on `predicted_residual`: long-horizon outcomes (`long`, `very_long` classifications) keep their lifecycle open through the closure sweep instead of getting retired as stale (commit `99b5a30`, F7 non-technical goal extensions).

**Tests:** `runtime/credit.test.ts`, `runtime/retrieval.test.ts`, `runtime/owner_gate.test.ts`, `runtime/owner_profile.test.ts`, `runtime/lifecycle_closure_sweep.test.ts`, `runtime/closure_audit.test.ts`.

---

## 11. Open Frontier — Path to Final State

What's PARTIAL today, classified by why it's not closed and what closes it. Each entry names the contract shape to ship.

### F-Sandbox-Parity (Phase G remainder)

uv and camofox runtime lanes work in tests but live evidence (`SDT7PDPYX13J3BMAMANZHG58F4`, `VQA4E2HC3H7X16M56JB3PJ2YXW`) shows preflight/credential parity gaps with bun. nsjail enforcement is honor-system on uv when nsjail is absent; camofox profile-mutex doesn't enforce resource limits.

**Closes by:** structural sandbox enforcement test fixtures that REFUSE to admit a uv/camofox artifact when nsjail/firejail isn't proven present AND the declared sandbox would otherwise be ignored. Contract should land `runtime/runtimes/{uv,camofox}.ts` parity events + `sandbox_unenforced_warning → admission_rejected` upgrade.

### F-Father-v2 (Phase K remainder)

Father is shipped for the original constrained recurring-task contract but is being re-scoped toward event-reactive journaling/pacing rather than planner-era objective selection (evidence `V9AG24HSX53A51BEXM17EQPP84`, `MYBBGQ9N0D0DVCYX49FN1HGCEC`).

**Closes by:** drop planner-era responsibilities (`6XBE0M3NJ91EK1HW7D95272G7M`), keep drift detection + self-suspend, add event-reactive maintenance template (e.g., quarterly retro, weekly status digest) so Father becomes a substrate scheduler not a strategist.

### F-Owner-Freeze-State (Phase L remainder)

v1 is archive-only in practice and `722f928` deleted the migration code. The operational owner-freeze/drain/archive state is now gated by owner consent + narrow-safe-scope apply gates rather than a one-time switch.

**Closes by:** `acc admin freeze-state` CLI + a freeze-state audit event (kind to be designed in-contract; not yet registered) so the operational state is auditable and reversible per `9F9QH3BHX12KQ1YPX0K7WP33NC` safe-additive-contract evidence.

### F-Adaptive-Scoring (the F13 frontier, GEZ955QDYN3R)

Many timers and threshold constants are hardcoded universals pending learned adaptive scoring: `NOVELTY_BONUS_MULTIPLIER = 1.5`, `RECIPE_REPLAY_THRESHOLD = 0.85`, `INLINE_PATTERN_SCORE_THRESHOLD = 0.7`, `RECIPE_INERTIA_DECAY_DAYS = 14`, `DEFAULT_BUDGET_TOKENS = 32000`, embedder/compaction/rehab tick intervals.

**Closes by:** one `adaptive_scoring` worker that consumes outcome correlations and emits `threshold_recalibrated` events; the runtime reads through a single accessor that returns either the learned value or the universal default. Same machinery as Beta posterior promotion — substrate self-extends.

### F-Knowledge-Cold-Start (audit `b7kjyk2k1`)

Recent data: only 8.2 % of candidates ever get a `candidate_confirmed | candidate_contradicted` verdict. The substrate accumulates candidates faster than it credits them.

**Closes by:** the credit-time synchronous refresh ALREADY shipped (`runtime/credit.ts:maybePromoteKnowledge` import). What remains is the upstream: cross-origin auto-credit when one candidate's claim semantically corroborates another's outcome (rather than waiting for both to be cited together). Contract should land a per-origin × per-goal-shape extractor that pairs structurally-similar candidates and emits cross-credit events.

### F-Substrate-Closure-Validation

Brain dispatch `MY0FWYBSKX5PBCVWJBHSQX4GT4` (2026-05-19) demonstrated that `task_closure_audited.checks` reported `each_row_has_commit_evidence: true` for amendments that were NEVER emitted as events. The audit is checking the brain's claim, not the substrate's ledger.

**Closes by:** the closure-audit verifier MUST query the events table directly and refuse `closure_residual < 0.3` when `target_files` was declared but `contract_amendment_proposed` count for those targets is zero. Substrate-truth gate, not advisory.

### F-Substrate-Migration-Sweep (`code_artifact_*` aliases)

Historical event rows physically carry `kind` strings in the legacy `code_artifact_*` set. Reader paths in 6 modules (artifact_store, retrieval, task_dispatcher, extractors, closure_deliverable_check, brain_dispatch_reconciler) do `IN ('act_artifact_*', 'code_artifact_*')` OR-clauses. The aliases stay registered in `substrate/event_kinds.ts` because production DBs would otherwise refuse them.

**Closes by:** one-time substrate-row rewriter worker that scans the events table for legacy `kind` strings and rewrites them to canonical equivalents. After the worker reports zero remaining legacy rows on every shipped DB, the OR-clauses and registry aliases become dead code.

### F-Backup-Export-Restore (Top-10 #10 in legacy production-readiness audit)

`acc admin export` exists (`cli/admin_export.ts`); a `acc admin import` symmetrical exists (`cli/admin_import.ts`). Both are tested. The remaining gap is the operational story — owner-facing docs on when/how to use them, and a scheduled-export cron primitive that emits `state_exported` on a cadence the owner profile picks.

### F-Token-Rotation

Admin token + external-push token are minted once at first run, written to `${stateDir}/v2.sock.token`, plaintext, no rotation path. (Legacy production-readiness Top-10 #5.)

**Closes by:** `acc admin rotate-token` CLI that mints a new token, atomically replaces the file, emits `admin_token_rotated`, and gives existing CLI sessions a deadline to re-authenticate.

---

## 12. Failure Modes — Observed, Classified, Tested

`failure_view` projects `task_failed.failure_kind` counts; `supervisor.ts` watches for redispatch storms, DAG explosions, bridge health. Observed in production (event counts live):

- `dispatcher_violation`: 97 historical; now 0/hour after the 32k budget + floor-section fix (commit `25eb1e9`).
- `lane_routing_refused: decorative_citation`: 95 historical; now 0/hour after the unique-prefix citation resolver landed (commit `2a33f46`).
- `worker_tick_overrun`: 266 historical, all on embedder under OpenAI-backlog drain; threshold raised 6×→10× (commit `8df5b56`) so the alarm only fires on structural hangs.
- `bridge_failed: timeout`: 33 historical; the bridge wall-clock kill is now firing reliably; pre-fix one dispatch ran 60 min vs 15 min limit.
- `supervisor_redispatch_storm`: 22 historical; gate triggers at 7 dispatches in 5 min window per task.
- `closure_obsolete`: 1 957 historical — these are the lifecycle sweep correctly retiring stuck `contract_amendment_proposed` / `owner_input_required` / `task_node_opened` rows whose terminator never arrived.
- `brain_silent_exit`: classifier in `runtime/bridge/opencode.ts` catches the worst-frame-shape pattern (zero substrate frames + exit_code 0).
- `brain_native_filesystem_bypass`: 1 observed (the §17 rewrite). Caught by post-hoc audit; structural fix shipped commit `1570521` (explicit `deny` for filesystem-write tools).

The pattern: **observability event → tightened deny rule → closed-out alarm**. The substrate accumulates failure-mode shapes the way it accumulates knowledge.

---

## 13. Operating Contract

The orchestrator's live operating manual is `system/acc2/CLAUDE.md`. Recovery recipes live in `system/acc2/.claude/rules/orchestrator-runtime.md`. Top invariants enforced there:

1. **Substrate is the operator.** Read state via MCP/views, not direct SQLite.
2. **Depth-1 retrieval is load-bearing.** Brain receives a thin composed prompt; broader context comes from refinement edges, not from copying state into chat.
3. **Cycle-1-only is structural.** Refinement, not iteration.
4. **Citation = mutation.** Cite ids that shape an action; decorative citations break the k_555 chain at the binding step.
5. **No two-way paths.** Open vocabulary is fine; closed enums that re-create the typed-predicate-lattice are refused.
6. **Universal intent ingress.** Every non-trivial owner intent enters through `acc task`. No pre-routing; substrate decides the lane.

This document and CLAUDE.md are the two doors into the organism. This one tells you what is; CLAUDE.md tells you what to do.

---

## 14. Universal Intent

The thesis: a substrate that compounds intelligence by accumulating events, ranking by Beta posterior, and routing through learned policies works the same way whether the goal is writing code, sending a partner outreach email, researching a vendor, deciding whether to take a job offer, or processing grief. Verifier residual is the universal score; cited knowledge IDs are the universal currency; refinement edges are the universal recursion.

Most universal, elegant, effective, adaptive, fast, efficient — proven only by the path: every shipped capability is in the registry, every credit closes the chain, every failure mode lands in `failure_view`, every threshold falls under adaptive scoring once F13 closes. The organism is the substrate; the substrate is the operator; the LLMs are subroutines.

**Live verdict (`acc admin substrate-status`): ALIVE.**
