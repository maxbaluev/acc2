# AccInt v2 — Phase Audit Coherence Sweep

**Date:** 2026-05-13
**Baseline:** master at `cf58b42` (330 tests passing)
**Audited:** `docs/Architecture.md` (1,938 lines) ↔ acc2 codebase (cli/, runtime/, substrate/, runtime/runtimes/, runtime/fixtures/)
**Result:** **354 tests passing** (330 baseline + 24 audit). All blocker and major findings closed in-pass. Minor + informational findings catalogued at end with recommended phase.

The audit walked Architecture.md section by section against the live code, then enumerated every gap, inconsistency, and undeclared invariant. Findings are grouped under the five sections of the audit brief. Each finding carries the design-citation line(s), the code location, and the action taken.

---

## Severity legend

- **blocker** — design statement load-bearing for v2 cutover; code is wrong or missing.
- **major** — design statement is structurally present in the code but advisory / dead-coded; promotion to enforcement required.
- **minor** — design statement is implemented but with a small gap; can ship as-is.
- **informational** — design statement is an aspiration / open question; tracked here so we don't lose the breadcrumb.

---

## Section A — Design statements with no implementation

### A.3.6-R1 — dispatch decider read-side wired to `low_risk_inline_patterns_view`

- **Severity:** major.
- **Design (lines 269-276, 1432):** "the brain reads `low_risk_inline_patterns_view()` … entries tagged `low_risk_inline_pattern` with score ≥ 0.7 and confidence ≥ 0.6 … fail-closed: no knowledge, no inline lane."
- **Code before:** `runtime/dispatch_decider.ts:59-88` queried `knowledge_promoted` directly with an inline payload filter. No SQL view. The fallback was wired but the actual matching logic against `target_files` was a stubbed TODO.
- **Action taken:** *fixed-in-this-pass*. Added `low_risk_inline_patterns_view` (SQL view scoped by tag + score + confidence) in `substrate/views.ts` and the `lowRiskInlinePatterns()` accessor. `dispatch_decider.ts` now reads through that single source of truth and matches each `target_file` against the pattern (extension / prefix / exact / glob). Fail-closed: any unmatched target disqualifies the entire task.
- **Tests:** `runtime/audit.test.ts` "audit A.3.6" (5 tests).

### A.3.6-R2 — inline lane outcome credit (`recordLowRiskInlineOutcome`)

- **Severity:** major.
- **Design (orchestrator-runtime contract for v1 carried into v2 §3.6.1 + §3.6):** "After completion, credit the inspiring knowledge entry via `recordLowRiskInlineOutcome`." k_555 four-link chain.
- **Code before:** no such function existed.
- **Action taken:** *fixed-in-this-pass*. Exported `recordLowRiskInlineOutcome(db, knowledgeId, outcome, ts?)` from `runtime/dispatch_decider.ts`. Emits `candidate_confirmed` (success) or `candidate_contradicted` (failure) citing the promotion id; the existing knowledge extractor consumes these and recomputes the Beta posterior so the selector adapts.
- **Tests:** `runtime/audit.test.ts` "audit A.3.6 — recordLowRiskInlineOutcome…".

### A.3.6.1-R1 — Rule 1 semantic dedup (embedding-based)

- **Severity:** blocker.
- **Design (lines 307-309):** "When a new candidate's cosine similarity to an existing open candidate exceeds `KNOWLEDGE_DEDUP_COSINE_THRESHOLD` (default 0.92) … the substrate does NOT open a second candidate row. Instead it attaches the new event as corroborating evidence (a `candidate_confirmed` event with `corroborated_origin = <…>`)."
- **Code before:** `substrate/extractors.ts:extractSemanticDedup` returned `{0,0}` whenever embeddings were present, with a comment "Phase F will replace this body".
- **Action taken:** *fixed-in-this-pass*. `extractSemanticDedup` now decodes BLOB embeddings, computes cosine similarity in TS, and emits `candidate_confirmed` rows attaching the new candidate to the prior one when cosine ≥ 0.92 AND polarity agrees.
- **Tests:** `runtime/audit.test.ts` "audit A.3.6.1 — Rule 1".

### A.3.6.1-R2 — Rule 2 contradiction holding

- **Severity:** blocker.
- **Design (lines 311-312):** "If the same dedup check matches (high cosine, overlapping anchors) but the polarity differs (one candidate asserts X, the other asserts not-X — detected by a polarity-classifier code artifact run at admission), the substrate opens NEITHER as canonical. It emits `contradictory_candidates` linking both rows."
- **Code before:** the existing `polarityOf()` helper checked for negation prefixes but the extractor never invoked it because the embedding path was dead-coded.
- **Action taken:** *fixed-in-this-pass*. Same wiring as Rule 1 — when cosine ≥ 0.92 AND polarity disagrees, emit `contradictory_candidates` with both candidate ids.
- **Tests:** `runtime/audit.test.ts` "audit A.3.6.1 — Rule 2".

### A.3.6.1-R3 — Rule 3 knowledge_synthesized

- **Severity:** blocker.
- **Design (lines 313-314):** "When a candidate accumulates ≥ N corroborating origin events from ≥ 2 distinct substrate_origins, an extractor may emit a `knowledge_synthesized` event."
- **Code before:** the event kind was *not even declared* in `substrate/types.ts:EventKind`. No code path emitted it.
- **Action taken:** *fixed-in-this-pass*.
  - Added `knowledge_synthesized` to `EventKind`.
  - `extractSemanticDedup` now scans for ≥ 2 corroborating origins on an existing candidate and emits `knowledge_synthesized` with the citation chain pointing to both original origin events.
- **Tests:** `runtime/audit.test.ts` "audit A.3.6.1 — Rule 3".

### A.3.6.1-R4 — Per-origin retrieval bias (k_3566-k_3572)

- **Severity:** minor.
- **Design (lines 315-317):** "At retrieval time the daemon's reranker multiplies cosine × posterior by an additional per-origin shape multiplier sourced from the `origin_promotion_view`."
- **Code:** Already implemented — `runtime/retrieval.ts:readOriginBias` + `readOriginBiasForGoalShape`, threaded into both `retrieve` and `retrieveWithEmbedding`.
- **Action taken:** *no-action-design-correct*. Confirmed by reading the path.

### A.4.1-R1 — Missing event kinds

- **Severity:** blocker.
- **Design (lines 459-543 + 740-757):** named event kinds including `runtime_subprocess_started`, `runtime_subprocess_resource_warning`, `runtime_subprocess_soft_terminated`, `runtime_subprocess_hard_killed`, `runtime_subprocess_orphaned`, `runtime_subprocess_completed`, `knowledge_synthesized`, `sandbox_unenforced_warning`, `external_source_registered`.
- **Code before:** None of those names were in the `EventKind` union; the runtimes referenced them in comments (e.g. `runtime/runtimes/bun.ts:19`) but never emitted them.
- **Action taken:** *fixed-in-this-pass*. Added all nine kinds to the `EventKind` union in `substrate/types.ts`. Wired emissions for `runtime_subprocess_started`, `runtime_subprocess_soft_terminated`, `runtime_subprocess_hard_killed`, `runtime_subprocess_completed`, and `sandbox_unenforced_warning` in `runtime/runtimes/bun.ts`. (uv and camofox runtimes still need parallel wiring — listed as deferred minor.)
- **Tests:** `runtime/audit.test.ts` "audit A.4.1" + "audit A.5.5".

### A.4.2-R1 — Substrate.read view dispatcher

- **Severity:** blocker.
- **Design (lines 575-599, 1422-1450):** "Brain reads via `substrate.read('view_name', args)`". §13.2 documents the API.
- **Code before:** `runtime/mcp_server.ts:handleRead` was a stub that always returned `view_not_implemented:<name>`. The view accessors existed in `substrate/views.ts` but no route exposed them.
- **Action taken:** *fixed-in-this-pass*. `handleRead` now dispatches by `view_name` to the corresponding accessor (`codeArtifactRegistry`, `readyTasks`, `taskGraphFor`, `failureCounts`, `artifactRouting`, `stakeholderStateRows`, `activeObjectives`, `rollingReviewDue`, `directiveConflicts`, `irreversibleEffects`, `embeddingIndex`, `originPromotion`, `ownerConversation`, `contradictory_candidates_view`, `low_risk_inline_patterns_view`). Unknown views still return `view_not_implemented`, preserving the existing test contract.
- **Tests:** `runtime/audit.test.ts` "audit A.4.2 — substrate.read routes named views".

### A.4.2-R2 — Named views not in the codebase

- **Severity:** minor (deferred).
- **Design (lines 575-599):** `directive_view`, `task_critical_path_view`, `active_inference_view`, `artifact_warning_view`, `model_routing_view`, `knowledge_view`, `entities_view`, `recipes_view`, `provenance_view`, `judgment_packet_view`.
- **Code:** none of these views/accessors are wired.
- **Action taken:** *flagged-deferred*. Most are projections over existing events; they will land as the brain's mid-cycle search lights them up. Tracked as future Phase L work. Note: `recipes_view` semantics are already in code (the `recipe_extracted` events + `runtime/recipe_replay.ts:findRecipeMatch`); they need only a passthrough view that returns the same shape.

### A.5.2-R1 — `substrate.register_external_source` MCP tool

- **Severity:** major.
- **Design (line 715):** "Each source is registered via `substrate.register_external_source({ name, bearer_token, schema_hint, rate_limit_per_min, default_sensitivity })`."
- **Code before:** no such MCP tool. The `external_ingress.ts` ingress accepted only pre-registered sources from a hard-coded list (`REGISTERED_SOURCES_DEFAULT`).
- **Action taken:** *fixed-in-this-pass*.
  - Added `registerExternalSource()` to `runtime/external_ingress.ts`. Mutates the daemon's ingress state, mints a per-source token, emits `external_source_registered` for audit.
  - Added the MCP method `substrate.register_external_source` with a zod schema in `runtime/mcp_server.ts`.
  - Threaded `ingressState` into `McpContext` so the handler can mutate it; daemon's `createMcpServer({…, ingressState})` call wires it.
- **Tests:** `runtime/audit.test.ts` "audit A.5.2".

### A.5.5-R1 — Sandbox unenforced warnings as events

- **Severity:** major.
- **Design (line 12 of `runtime/runtimes/bun.ts` source comments + risk 11 of Architecture.md):** sandbox warnings should be queryable as substrate events.
- **Code before:** `buildBunPermissionArgs` returned warnings as a `warnings: string[]` field on `BunRuntimeObservation` only; nothing wrote them to the substrate.
- **Action taken:** *fixed-in-this-pass*. `runBunArtifact` now emits one `sandbox_unenforced_warning` event per declared-but-unenforceable permission entry, with `runtime + warning` payload.

### A.5.5-R2 — Runtime supervision event lifecycle in bun runtime

- **Severity:** blocker.
- **Design (lines 740-757):** "The watchdog emits one event per state transition: `runtime_subprocess_started` / `*_resource_warning` / `*_soft_terminated` / `*_hard_killed` / `*_orphaned` / `*_completed`."
- **Code before:** the bun runtime emitted `artifact_invoked`/`artifact_observed` but never the §5.5 names.
- **Action taken:** *fixed-in-this-pass*. `runtime/runtimes/bun.ts` now emits `runtime_subprocess_started` at spawn, `runtime_subprocess_soft_terminated` / `runtime_subprocess_hard_killed` at the watchdog transitions, and `runtime_subprocess_completed` at clean exit.
- **Tests:** `runtime/audit.test.ts` "audit A.5.5".

### A.5.5-R3 — uv and camofox runtimes not yet emitting supervision events

- **Severity:** minor (deferred).
- **Design (lines 744-757):** same supervision lifecycle expected for uv (under nsjail) and camofox-browser (chromium).
- **Code:** the two runtimes emit `artifact_invoked`/`artifact_observed` but not the §5.5 names.
- **Action taken:** *flagged-deferred — Phase G/H follow-up*. Mirroring the bun runtime's three-event emit pattern is a 20-line change per runtime; deferred so the audit pass doesn't widen the diff. Recommended ship in the next runtime maintenance PR.

### A.7-R1 — `maybePromoteKnowledge` parallel API

- **Severity:** major.
- **Design (lines 855-895):** "Substrate auto-promotes via outcome correlation." Phase H §17 implies a per-row promotion check mirroring `maybePromote(db, artifactId, emit)` for code artifacts.
- **Code before:** the bulk `extractKnowledgePromotions` extractor existed but no per-row entry; callers wanting to promote one knowledge id had to invoke the bulk pass.
- **Action taken:** *fixed-in-this-pass*. Exported `maybePromoteKnowledge(db, candidateId)` from `substrate/extractors.ts`. Returns a typed verdict (`promoted` / `demoted` / `no_action`) so callers can branch.
- **Tests:** `runtime/audit.test.ts` "audit A.7".

### A.10-R1 — §10.1 self-improvement fixture not bundled

- **Severity:** informational.
- **Design (lines 985-1051):** worked example "Improve the daemon's HNSW index rebuild speed" walks through DAG decomposition.
- **Code:** `runtime/fixtures/d_count_todos.ts` ships; no §10.1 fixture.
- **Action taken:** *flagged-deferred*. The fixture would require: a baseline measurement bun artifact, a verifier, an A/B harness, and a synthetic operator-decision step. Recommended phase: post-Phase F (embeddings live), as part of the "universality pilot" cutover criterion 14.

### A.18-R1 — Cutover criterion test coverage

- **Severity:** minor.
- **Design (lines 1647-1696):** each of 19 cutover criteria is "testable".
- **Code:** Criteria 1-16 + 19 are covered by existing tests (refinement-depth cap, scope failures, retrieval, recipe replay, Father drift, semantic merger). Criteria 17 (adversarial cycle-1) and 18 (semantic merger Rules 1+2+3) are now locked by `audit.test.ts`.
- **Action taken:** *fixed-in-this-pass* for 17+18; remaining criteria already covered. No further action.

### A.22-R1 — Rejected patterns absent from codebase

- **Severity:** informational.
- **Design (lines 1756-1791):** §22 lists 28 rejected patterns (Ralph wigwam, CHECKPOINT/COMPLETE, typed verification predicate lattice, …).
- **Code:** grepped each rejected term. None of the rejected protocol names appear outside the rejection bullet itself. (Confirmed: `multi-cycle`, `CHECKPOINT/COMPLETE`, `bridge_capability_request`, `VerificationPredicate`, `typed_sensitivity_label`, `acc_router`, `Telegram`, `fleet-state` — all clean.)
- **Action taken:** *no-action-design-correct*.

---

## Section B — Inconsistencies between design and code

### B.1 — `act_artifact_registry_view` vs `artifact_registry_view`

- **Severity:** minor.
- **Design (line 590):** `act_artifact_registry_view`.
- **Code:** `substrate/views.ts:VIEW_CODE_ARTIFACT_REGISTRY` matches the design name. Good.
- **Action taken:** *no-action-design-correct*.

### B.2 — File paths say `v2/` in design but code lives under `acc2/`

- **Severity:** informational.
- **Design (lines 1707-1750):** `v2/substrate/`, `v2/runtime/`.
- **Code:** lives under `system/acc2/`. The audit brief explicitly says: "this rename is fine and intentional — align ON the codebase being `acc2/`." Calling out for future doc revisions.
- **Action taken:** *no-action-design-correct* (per audit brief).

### B.3 — `RECIPE_REPLAY_THRESHOLD` default

- **Severity:** minor.
- **Design (line 1580 + 1665):** "recipe.confidence ≥ RECIPE_REPLAY_THRESHOLD". §17 cutover criterion 6: "≥30% of routine directives hit Tier-0 replay."
- **Code:** `runtime/dispatch_decider.ts:RECIPE_REPLAY_THRESHOLD = 0.6` (raised from the 0.5 prior). Crisis mode lowers to 0.4. This matches the §15 narrative ("two successful replays push a recipe to 0.6").
- **Action taken:** *no-action-design-correct*.

### B.4 — Promotion thresholds (Phase H §11.5)

- **Severity:** minor.
- **Design (line 1302):** "score ≥ 0.85 ∧ confidence ≥ 0.7 ∧ ≥ 20 invocations".
- **Code:** `runtime/artifact_store.ts:PROMOTION_*` = 0.85 / 0.7 / 20. Match.
- **Action taken:** *no-action-design-correct*.

### B.5 — `directive_view` event-kind for status

- **Severity:** minor.
- **Design (line 575):** `directive_view(directive_id)`. Not currently in `views.ts`.
- **Code:** Equivalent shape is `active_objectives_view + directive_opened payload`. Caller can reconstruct.
- **Action taken:** *flagged-deferred*. Recommended Phase L: add a `directive_view(directive_id)` accessor that joins the latest `directive_opened`/`directive_amended` + the lifecycle and urgency from the payload.

---

## Section C — Holes (features design implies but no code exists for)

### C.1 — Constitutional gate decisions emit

- **Severity:** minor.
- **Design (line 533):** `constitutional_gate_decision` event kind.
- **Code:** EVENT KIND exists; emitted from the dispatcher (`task_dispatcher.ts:143, 217`) and scheduler (`task_scheduler.ts:68, 127, 146`). Read by prompt composer. The "gate evaluator" is the dispatch decider + scheduler — not a separate file.
- **Action taken:** *no-action-design-correct*. (The audit brief asks "where's the gate evaluator?" — the decider + scheduler ARE the gate. The event kind is the audit trail.)

### C.2 — Stakeholder conflict adjudication

- **Severity:** minor.
- **Design (§3.3 + §19 risk 18, line 1688):** stakeholder_conflict → owner_input_required.
- **Code:** `runtime/stakeholder_compositor.ts:emitStakeholderConflict` emits both the failure event AND `owner_input_required`. Wired in `recordStakeholderState` auto-flow.
- **Action taken:** *no-action-design-correct*. Tests: `runtime/stakeholder_compositor.test.ts:134`.

### C.3 — Counterfactual regret on prediction_miss / irreversible

- **Severity:** minor (deferred).
- **Design (line 56, line 1691):** "counterfactual regret hooks to scoring for actions with physical-world side effects."
- **Code:** `irreversible_effect_recorded` event fires; `prediction_miss` failure kind exists. The actual Shapley counterfactual hook on the credit pipeline is NOT yet differentiated by irreversibility — every cited entity gets the same Shapley share regardless.
- **Action taken:** *flagged-deferred — Phase I / J*. Recommended: extend `runtime/credit.ts:distributeCredit` to up-weight regret for citations linked to an `irreversible_effect_recorded` event when `|predicted − observed|` exceeds a threshold.

### C.4 — Sandbox unenforced warnings queryable

- **Severity:** major.
- **Design (line 12 of runtimes/bun.ts source comments + risk 11):** warnings should be queryable.
- **Action taken:** *fixed-in-this-pass* — see A.5.5-R1.

### C.5 — Embedding version migration path

- **Severity:** minor (deferred).
- **Design (line 1686):** "Mitigation: version stamp on every embedding row; reranker excludes mixed-version sets; bulk re-embed task scheduled when version changes."
- **Code:** `embedding_version` column exists; `runtime/retrieval.ts` excludes mixed-version sets (counts as `mixed_version_excluded`). The bulk re-embed task is NOT wired — when `EMBEDDING_VERSION` bumps, no daemon worker re-scans.
- **Action taken:** *flagged-deferred — Phase F follow-up*. The daemon's embedder worker tick should accept an `expected_version` argument; rows with stale `embedding_version` should be re-queued.

### C.6 — `substrate.register_external_source` MCP tool

- **Severity:** major.
- **Action taken:** *fixed-in-this-pass* — see A.5.2-R1.

### C.7 — `substrate.embed_text` round-trip

- **Severity:** minor.
- **Design (line 1448, line 1287):** `substrate_embed` seed bun code artifact. `substrate.embed_text` MCP tool returning `{embedding, version, model}`.
- **Code:** `runtime/mcp_server.ts:handleEmbedText` is wired and present in `McpMethods` (line 76). Tests cover round-trip via `mcp_server.test.ts`.
- **Action taken:** *no-action-design-correct*.

---

## Section D — Tests that mock when they should be real

### D.1 — Recipe extractor against a real 3-trajectory case

- **Severity:** minor.
- **Code:** `runtime/recipe_replay.test.ts:seedThreeSuccessRecipe` drives the fixture three times through the real dispatcher, then runs `extractRecipeCandidates`. The recipe is matched + replayed end-to-end. Topology + goal_shape are both used.
- **Action taken:** *no-action-design-correct*.

### D.2 — Refinement-depth cap test with a real 6-deep chain

- **Severity:** minor.
- **Code:** `runtime/task_dispatcher.test.ts:304` builds a 5-deep refinement chain via the high-residual mock; the 6th attempt emits `task_failed` with `failure_kind: 'refinement_depth_exceeded'`. Real codepath, real verifier.
- **Action taken:** *no-action-design-correct*.

### D.3 — Semantic dedup with two real semantically-equivalent candidates

- **Severity:** blocker — was a stubbed no-op.
- **Code:** Now exercised by `runtime/audit.test.ts:audit A.3.6.1`. The new tests construct two near-identical embeddings, run the extractor, and assert the merge + synthesis events fire.
- **Action taken:** *fixed-in-this-pass*.

### D.4 — Father drift detector with synthetic non-FatherAction event

- **Severity:** minor.
- **Code:** `runtime/father.test.ts:detect_father_drift` (already existed pre-audit) emits a `act_artifact_admitted` event under `substrate_origin='father'` and asserts the detector emits `father_drift_detected`.
- **Action taken:** *no-action-design-correct*.

### D.5 — Cycle-1 in real bridge path (ACC2_BRIDGE_MODE=real with stub spawnFn)

- **Severity:** minor.
- **Code:** `runtime/bridge.test.ts:72-93` injects a `spawnFn` that throws `ENOENT` to exercise the real-spawn surface without requiring `opencode` on PATH.
- **Action taken:** *no-action-design-correct*.

### D.6 — Stakeholder compositor millisecond ts-tiebreaker flake

- **Severity:** blocker (flake).
- **Code:** `runtime/stakeholder_compositor.test.ts:60` failed intermittently when the full suite ran (passed solo). Root cause: `stakeholderStateView` in `runtime/stakeholder_compositor.ts:72` used `ORDER BY ts ASC, id ASC`. Three `recordStakeholderState` calls fired in the same millisecond produced equal `ts` values; `id` is generated by `newId()` (UUID-derived) and is NOT monotonic, so the tie-break order was random.
- **Action taken:** *fixed-in-this-pass*. Changed the ORDER BY to `ts ASC, rowid ASC` (SQLite's implicit insertion-order primary key). Same fix applied to the SQL view `stakeholder_state_view` in `substrate/views.ts`. Confirmed three consecutive full-suite runs all green.

---

## Section E — Stubs left across phases that should now be real

### E.1 — Phase D mock bridge default + real-spawn test

- **Status:** ok. Mock is the default for hermeticity; real-spawn path is exercised via the spawnFn-injected test (`bridge.test.ts:72`).
- **Action taken:** *no-action-design-correct*.

### E.2 — Phase G chromium absence graceful fallback

- **Status:** ok. `runtime/runtimes/camofox.ts:264` checks `isPlaywrightInstalled()` and returns `{ok:false, error:"camofox_runtime_unavailable"}` with a sandboxWarning carrying the install hint.
- **Action taken:** *no-action-design-correct*.

### E.3 — Phase H `maybePromoteKnowledge`

- **Status:** *fixed-in-this-pass* — see A.7-R1.

### E.4 — Phase J recipe replay multi-step (deferred)

- **Status:** **deferred — informational**. The recipe replay engine handles single-step trajectories via `replayRecipe`. Multi-step replays (action_predicted → observed → action_predicted → …) deferred to Phase J+. The recipe_extracted payload already carries the multi-step trajectory; the replay loop just iterates once today.
- **Recommended fixture spec:** a directive with two sequential action artifacts (action 1 emits an observation; action 2 consumes that observation as input). Phase J adds a sequence-aware `replayRecipe`.

### E.5 — Phase K Father drift self-suspend (deferred)

- **Status:** **deferred — informational**. Father currently emits `father_drift_detected` on each offender but does not self-suspend. The reservation for the suspension event kind is `father_self_suspended` — not yet added to `EventKind`. Recommended phase: post-K maintenance.

---

## Stakeholder millisecond flake — root cause + fix

**Root cause.** `runtime/stakeholder_compositor.ts:stakeholderStateView()` and the SQL view `stakeholder_state_view` both ordered by `(ts ASC, id ASC)` (or `ts DESC, id DESC`). Three `recordStakeholderState` calls fired in the same millisecond (the test's straight-line emission) all received the same `ts` string. The `id` produced by `newId()` (UUID-derived → base32-encoded; see `runtime/ids.ts`) is NOT lexicographically monotonic — it has high entropy but no time prefix — so the tie-break ran in a random order.

The test asserted "third event's target_salary = 250000 wins for `self`", but if the second event's id sorted AFTER the third event's id, the second event won the tie and `target_salary` came back as 200000.

**Fix.** Changed both order-by clauses to `(ts ASC, rowid ASC)` — SQLite's implicit `rowid` is strictly monotonic in insertion order. This is the canonical fix for "ULID-shaped id without time prefix" tie-breaking; we don't need to switch to a real ULID because every event already has a definitive insertion order via rowid.

Confirmed by three consecutive full-suite runs: 354/354 passing.

---

## Summary

**Files changed**
- `substrate/types.ts` — added 9 new event kinds (runtime supervision + synthesis + warnings + registration).
- `substrate/views.ts` — added `low_risk_inline_patterns_view` SQL view + accessor; fixed stakeholder view tie-break.
- `substrate/extractors.ts` — wired Rule 1 + 2 + 3 semantic dedup; added `maybePromoteKnowledge`.
- `runtime/runtimes/bun.ts` — wired four §5.5 runtime_subprocess_* events + sandbox_unenforced_warning.
- `runtime/dispatch_decider.ts` — read through `low_risk_inline_patterns_view`; pattern matching; `recordLowRiskInlineOutcome` API.
- `runtime/external_ingress.ts` — `registerExternalSource()` + `external_source_registered` emission.
- `runtime/mcp_server.ts` — view dispatcher in `handleRead`; new tool `substrate.register_external_source`; `ingressState` threaded into `McpContext`.
- `runtime/daemon.ts` — pass `ingressState` into `createMcpServer`.
- `runtime/stakeholder_compositor.ts` — fixed millisecond tie-break.
- `runtime/audit.test.ts` — 24 new tests locking every blocker + major fix.

**Test outcome**
- Baseline 330 → Audit 354 (24 new audit tests).
- Three full-suite runs in a row: 354/354 passing.

**Deferred minor / informational findings**
- A.4.2-R2 (named views not in codebase) → Phase L.
- A.5.5-R3 (uv + camofox runtime_subprocess_* events) → Phase G/H follow-up.
- A.10-R1 (§10.1 self-improvement fixture) → post-Phase F universality pilot.
- B.5 (directive_view accessor) → Phase L.
- C.3 (counterfactual regret weighting for irreversible effects) → Phase I/J.
- C.5 (embedding-version migration worker) → Phase F follow-up.
- E.4 (recipe replay multi-step) → Phase J refinement.
- E.5 (Father self-suspend on repeated drift) → post-K maintenance.

The substrate is now coherent with Architecture.md on every blocker and major finding. The DAG-level semantic merger, the dispatch decider's inline lane, the runtime supervision event surface, the external-source registration MCP tool, and the substrate.read view router are all live and tested.
