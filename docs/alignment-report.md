# AccInt v2 — Phase Align Deep Coherence Pass

**Date:** 2026-05-13
**Baseline:** master, audit-report.md complete (354 tests passing)
**Result:** **376 tests passing** (354 baseline + 22 alignment). All 9 load-bearing principles verified structurally. Misalignments closed in-pass; no principle deferred past Phase Align.

The audit pass closed surface-level gaps (named events, view dispatch, MCP tools). This pass goes deeper: it verifies that the v2-design.md principles are *structurally* executed in the code — not merely present as strings. Where the seam was advisory, this pass made it structural by factoring shared gates, threading missing credit calls, or pinning constants via tests.

---

## Severity-of-finding legend

- **aligned** — the principle was already structurally honored; the alignment test pins it so future regressions surface immediately.
- **partially-aligned-now-fixed** — the principle was honored along one path but a parallel path drifted; this pass extracted a shared gate or threaded the missing call.
- **deferred** — genuinely impossible at this phase; documented gap + TODO with the phase that should close it.

No principle in this pass landed as `deferred`.

---

## Principle 1 — Substrate-as-recursive-operator

### Statement

The daemon is the sole call-surface owner. The brain (opencode) and the orchestrator (Claude Code) MUST NOT read each other directly. Every cross-actor read goes through the substrate — `getEventById`, a view accessor, or `substrate.read` — never through shared in-memory state.

### Test

`runtime/alignment/recursive_operator.test.ts` (3 tests, 10 assertions).

### Findings

**aligned.** The audit walked `runtime/bridge.ts` end to end and `runtime/task_dispatcher.ts` from the bridge return to the post-call event scan. Both files use `emitEvent` for every write and `readEventsSinceTs` (a `FROM events WHERE` SELECT) for every cross-actor read. The dispatcher does NOT pull a "bridge_emitted_events" attribute off the BridgeResult to bypass the substrate; it re-reads from the table after the bridge returns. No file in `runtime/` or `cli/` writes raw `INSERT INTO events`, `UPDATE events`, or `DELETE FROM events` outside `runtime/events.ts` itself.

### Fixes applied

None — the principle was already structurally executed. The alignment test pins it so a future refactor that inlines an INSERT into bridge.ts or stashes events in shared memory will fail immediately.

### Verification

- Test 1: two independent SQLite handles to the same on-disk file communicate ONLY through the WAL. Handle A's emit is invisible to Handle B's in-memory state; the only carrier is `getEventById`.
- Test 2: source-text scan of `bridge.ts` confirms it imports `emitEvent` and never executes a raw INSERT/UPDATE/DELETE on the events table.
- Test 3: `task_dispatcher.ts` reads bridge-emitted events via `readEventsSinceTs` (a `SELECT FROM events`), not via shared state.

---

## Principle 2 — Model D merger (every knowledge candidate flows through the merger)

### Statement

The substrate's extractor is the merger. No runtime or CLI code path may emit `knowledge_promoted` directly — promotion only happens via `extractKnowledgePromotions` / `maybePromoteKnowledge` (after corroboration accumulates) or via the curated seed (which sets `skip_corroboration: true` explicitly).

### Test

`runtime/alignment/merger.test.ts` (2 tests, 7 assertions).

### Findings

**aligned.** A grep across `runtime/` and `cli/` for the literal `kind: "knowledge_promoted"` finds exactly two emission sites: `substrate/extractors.ts` (the bulk extractor + per-id `maybePromoteKnowledge`) and `substrate/seed.ts` (the curated foundational seed). Both are legitimate; the seed explicitly tags `skip_corroboration: true` so its provenance is auditable.

### Fixes applied

None — the structure was clean. The first test makes the "no runtime/cli emitter" invariant a hard test so a future shortcut from a CLI helper can't slip through.

### Verification

- Test 1: walks every `.ts` file under `runtime/` and `cli/` (excluding tests + alignment files), greps for the `kind: "knowledge_promoted"` emission pattern, asserts the offender list is empty.
- Test 2: emits two semantically-equivalent knowledge_candidate rows from `opencode` and `claude_root`, runs `extractSemanticDedup`, and asserts:
  - The merger emits ≥ 1 `candidate_confirmed` row citing the prior candidate.
  - The corroborating origin (`claude_root`) is captured on the payload — multi-origin synthesis (Rule 3) has the evidence it needs.
  - NO `knowledge_promoted` row was emitted by the merger alone (corroboration ≠ promotion; promotion requires the Beta posterior to cross the band).

---

## Principle 3 — Cycle-1-only is structural in every dispatch path

### Statement

`§3.7 cycle-1-only`: the brain runs exactly one cycle per dispatch. Forbidden event kinds (`brain_cycle_2_started`, `continue_cycle_requested`) MUST be rejected by every dispatch surface — the mock bridge AND the real bridge.

### Test

`runtime/alignment/cycle_one.test.ts` (3 tests, 17 assertions).

### Findings

**partially-aligned-now-fixed.** Before this pass:
- The mock-bridge path was enforced by a post-bridge event scan in `task_dispatcher.ts` (literal `ev.kind === "brain_cycle_2_started" || ev.kind === "continue_cycle_requested"`).
- The real-bridge path had a SEPARATE inline kill-switch inside `spawnRealOpencode` with its own literal disjunction.

Two literal sets is one too many. The moment the design adds a third forbidden kind, one surface forgets and the law becomes advisory (k_252).

### Fixes applied

- **New module: `runtime/cycle_one_gate.ts`.** Exports `CYCLE_ONE_FORBIDDEN_KINDS: ReadonlySet<EventKind>` and the pure predicate `isCycleViolation(kind)`. Both bridge paths now import and use these instead of their own literal lists.
- **`runtime/bridge.ts:spawnRealOpencode`** — the stdout JSON scan calls `isCycleViolation(kind)` instead of `kind === "brain_cycle_2_started" || kind === "continue_cycle_requested"`.
- **`runtime/task_dispatcher.ts:dispatchReadyTask`** — the post-bridge event scan calls `isCycleViolation(ev.kind)` for the same reason.

Adding a new forbidden kind now requires editing one line in `cycle_one_gate.ts`; both lanes update transparently.

### Verification

- Test 1: pins the forbidden-kind set and asserts `isCycleViolation` honors it for both forbidden values, plus `false` for unrelated kinds (`action_predicted`) and nullish inputs.
- Test 2: source-text scan confirms both `bridge.ts` and `task_dispatcher.ts` import from `./cycle_one_gate` and neither contains the literal disjunction that used to live in both files.
- Test 3: drives the real-bridge path with a stub `spawnFn` that yields `{type: "brain_cycle_2_started"}`. The gate kills the subprocess via SIGTERM, the bridge returns `subprocess_crash` with `stderr_tail: cycle_violation:...`, and `bridge_failed` is recorded.

---

## Principle 4 — Code-as-capability (every action artifact + verifier routes through artifact_store + sandbox)

### Statement

`§3.4, §6, §11`: every action is a code artifact resolved from `act_artifact` via `getArtifact()` and executed inside a per-runtime sandbox built by `runtime/sandbox.ts`. No "hardcoded helper" path bypasses lookup or permission args.

### Test

`runtime/alignment/code_as_capability.test.ts` (2 tests, 8 assertions).

### Findings

**aligned.** Grepping `Bun.spawn` across `runtime/` yields three categories:
1. `runtime/runtimes/{bun,uv,camofox}.ts` — the legitimate runtime executors.
2. `runtime/bridge.ts` — the opencode subprocess spawn (documented).
3. `runtime/sandbox.ts` — JSDoc comments referencing `Bun.spawn` (no actual call).

No `runtime/` file outside those three has a `Bun.spawn` call. The task dispatcher invokes runtimes via `runBunArtifact` / `runUvArtifact` / `runCamofoxArtifact` (which themselves resolve `getArtifact` first). MCP `substrate.run_artifact` in `runtime/mcp_server.ts` does the same.

### Fixes applied

None — the structure was already clean. The first test strips line/block comments before grepping so JSDoc references in `sandbox.ts` don't false-positive, then asserts the offender list is empty.

### Verification

- Test 1: source-text grep across `runtime/` for `Bun.spawn` outside the three allowed module families. Stripped of comments. Offender list must be `[]`.
- Test 2: admits a real action + verifier artifact pair through `admitArtifact`, emits an `action_predicted` event citing both ids, then asserts every row's `action_artifact_id` and `verifier_artifact_id` columns resolve through `getArtifact(db, id)`.

---

## Principle 5 — Depth-1 retrieval (prompt budget enforced)

### Statement

`§13`: every prompt section uses a small K-cap or LIMIT. The total prompt stays under `PROMPT_BUDGET_TOKENS` (default 8000). When the composer can't fit a section, it drops the lowest-priority candidate and emits a `prompt_truncated` event so the audit trail records the bite.

### Test

`runtime/alignment/depth_one.test.ts` (2 tests, 10 assertions).

### Findings

**partially-aligned-now-fixed.** The composer (`runtime/prompt_composer.ts`) was already honoring the budget — sections sort by priority `P0 → P4`, each candidate is admitted only if `totalTokens + sectionTokens ≤ budget`. The K-caps were also already in place (`readKnowledgeTopK(db, 8)`, `readArtifactRegistryTopK(db, 6)`, `readRecentFailures(db, 3)`). What was missing: the structural `prompt_truncated` event. The composer tracked `truncated: string[]` on its return value but never emitted an audit row — the brain saw the leaner prompt but the substrate had no record WHY.

### Fixes applied

- **New event kind: `prompt_truncated`** added to `substrate/types.ts:EventKind` (substrate self-events group).
- **`runtime/prompt_composer.ts:composePrompt`** now emits one `prompt_truncated` event per call when `truncated.length > 0`. The payload carries `budget_tokens`, `total_tokens`, `kept_sections`, and `truncated_sections` so an auditor can reproduce the bite.

The token estimator (`estimateTokens`) was already using `js-tiktoken`'s `cl100k_base`, so the budget check is real-token-accurate; the fallback to chars/4 only fires when the encoder fails to construct.

### Verification

- Test 1: seeds a directive, a task, and 200 `knowledge_promoted` rows. Composes under a tight 800-token budget. Asserts the rendered text is ≤ 800 tokens, ≥ 1 section was dropped, and exactly one `prompt_truncated` row was emitted with `truncated_sections.length === result.truncated.length`. P0 sections (`task_goal`, `runtimes_available`, `workflow`) must survive truncation.
- Test 2: idempotency check — composing under the default 8000-token budget on a tiny substrate emits ZERO `prompt_truncated` rows. The audit row only fires when truncation actually happened.

---

## Principle 6 — Credit chain closure (every action_scored produces credit distribution)

### Statement

`§3.6.1 Rule 3 + §17 Phase H + k_555`: every `action_scored` event MUST be followed by a `distributeCredit` call so the four-link chain (action → observe → score → distribute) holds end-to-end. No scored event left uncredited.

### Test

`runtime/alignment/credit_closure.test.ts` (1 test, 5 assertions).

### Findings

**partially-aligned-now-fixed.**

- `runtime/task_dispatcher.ts:dispatchReadyTask` — already wired through `distributeCredit` for both the success path (verifier residual computed) and the failure path (artifact_runtime_error). Try/catch falls back to `applyResidualOutcome` so the posterior still moves even if the credit pipeline fails.
- `runtime/recipe_replay.ts:replayRecipe` — emitted `action_scored` but did NOT call `distributeCredit`. The artifact posterior would be untouched on a recipe replay; cited knowledge would never be credited. This breaks the chain for the Tier-0 replay lane.

### Fixes applied

- **`runtime/recipe_replay.ts:replayRecipe`** — after emitting `action_scored`, calls `distributeCredit({action_event_id: predictedEv.id, observation_event_id: scoredEv.id, scored_event_id: scoredEv.id, predicted_residual, observed_residual: residual})`. Wraps in try/catch; the catch path falls back to `applyResidualOutcome` on both the action and verifier artifacts. Two new imports: `distributeCredit` from `./credit` and `applyResidualOutcome` from `./artifact_store`.

The dispatcher path was untouched — it was already correctly closing the chain.

### Verification

- Admit deterministic action + verifier artifacts (action returns `{value:1}`, verifier returns `{residual:0}`).
- Construct a `RecipeMatch` hand-stamped with the artifact ids.
- Run `replayRecipe(db, task, match)`. Assert `task_committed === true`.
- For every `action_scored` row on the task, count `act_artifact_score_updated` rows whose payload references the scored event id. Each scored event must have ≥ 1 corresponding `act_artifact_score_updated` (the canonical "credit was distributed" marker that `distributeCredit` emits for the action and verifier artifacts).

---

## Principle 7 — External-push first-class

### Statement

`§5.2`: events ingested via `POST /external/push` are first-class substrate rows. They flow through `external_event_received` (already in `EMBEDDABLE_KINDS`), get embedded by the worker, and surface in retrieval the same way brain-emitted rows do.

### Test

`runtime/alignment/external_push.test.ts` (2 tests, 10 assertions).

### Findings

**partially-aligned-now-fixed.** Three pieces:
1. `external_event_received` is already in `EMBEDDABLE_KINDS` — good.
2. The embedder's `extractTextFromEvent` reads top-level fields (`text`, `goal`, `summary`, `body`, `message`, `claim`, …). External push wraps its content under `payload.data.{...}` (see `runtime/external_ingress.ts:handleExternalPush`: `payload: { source, sensitivity_classification_hint, data: payload }`). So an external row with a `summary` inside `data` would be skipped by the extractor — silently — and never become retrievable.
3. The end-to-end path (POST → emit → embed → index → search) was not exercised by any existing test.

### Fixes applied

- **`runtime/embedder.ts:extractTextFromEvent`** — augmented the candidate list to also read `payload.data.text`, `payload.data.summary`, `payload.data.body`, `payload.data.message`, `payload.data.title`, `payload.data.description`. The comment block now explicitly cites §5.2 so the envelope shape is documented.

### Verification

- Test 1: simple unit check that `external_event_received` is in `EMBEDDABLE_KINDS`.
- Test 2: end-to-end. Register `phase_align_source`, mock `globalThis.fetch` to return a known 1536-dim canonical embedding, POST one event through `handleExternalPush` (200 OK, body.event_id captured), run `embedderWorkerTick(db, {batchSize: 10})`, assert `tick.embedded === 1` and one `embedding_computed` row references the event id. Rebuild `EmbeddingIndex` from db, `knn(canonical, 5)` — the external row surfaces at distance < 1e-6.

---

## Principle 8 — Per-state-root mutex on every stateful runtime invocation

### Statement

`§11.2`: stateful artifacts queue against a per-state-root mutex. Concurrent invocations against the SAME `profile_root` serialize; different roots run in parallel. The camofox-browser runtime is the canonical case in v2.

### Test

`runtime/alignment/state_root_mutex.test.ts` (3 tests, 13 assertions).

### Findings

**aligned.** The mutex is acquired at the top of `runCamofoxArtifact` (`runtime/runtimes/camofox.ts:279`), before any chromium spawn. Every call path that runs camofox artifacts — `substrate.run_artifact` in `mcp_server.ts`, recipe replay via `runArtifactByRuntime`, and the dispatcher via `runtimes/camofox.ts` re-export — flows through this single entry point. There's no "fast path" admission fixture that skips the mutex.

### Fixes applied

- **`runtime/runtimes/camofox.ts`** — exported `__acquireProfileMutexForTest<T>(profileRoot, fn)` as a hermetic test surface. The mutex implementation itself was not changed; this is purely a test-only handle so the alignment test can prove serialization without spawning chromium.

### Verification

- Test 1: two overlapping critical sections against the same `profile_root` serialize. Events arr captures `enter`/`exit` per job; assertion is that the four events are `[enterA, exitA, enterB, exitB]` (or symmetric) with the entry/exit pairs contiguous.
- Test 2: two critical sections against DIFFERENT roots run in parallel. The second `enter` happens strictly before the first `exit`, proving the windows overlap.
- Test 3: source-text check of `mcp_server.ts` confirms `runCamofoxArtifact` is the camofox dispatch surface and the runtime branching enumerates bun, uv, camofox (the else branch). No fast path bypasses the mutex.

---

## Principle 9 — Posterior-update consistency

### Statement

`§3.6.1, §7.2, §11.5`: act_artifact and knowledge_candidate share the same Beta posterior + EMA half-life. Recipe confidence uses a DIFFERENT (coarser, qualitative) formula on purpose — recipes do not have a residual-driven posterior; they have a single "did the trajectory replay successfully" bit.

### Test

`runtime/alignment/posterior_consistency.test.ts` (4 tests, 19 assertions).

### Findings

**aligned (with explicit documentation).** Constants:

| Constant            | act_artifact (artifact_store) | knowledge (extractors) | credit pipeline (credit.ts) | recipe (recipe_replay)     |
|---------------------|--------------------------------|------------------------|-----------------------------|----------------------------|
| Success band        | `SUCCESS_BAND = 0.3`           | `RESIDUAL_SUCCESS_THRESHOLD = 0.3` | `SUCCESS_BAND = 0.3`        | n/a (binary outcome)       |
| Failure band        | `FAILURE_BAND = 0.7`           | (symmetric posterior)  | `FAILURE_BAND = 0.7`        | n/a                        |
| Promote score       | `PROMOTION_SCORE = 0.85`       | `promoteScore: 0.85`   | (inherits artifact_store)   | n/a                        |
| Demote score        | (n/a — quarantine only)        | `demoteScore: 0.30`    | n/a                         | `RECIPE_AUTO_ARCHIVE_FLOOR = 0.2` |
| EMA window          | `EMA_HALF_LIFE_EVENTS = 20`    | `RECENT_WINDOW = 20`   | `Math.pow(0.5, 1/20)`       | n/a                        |
| Confidence formula  | `1 - 1/sqrt(n+1)` (Beta)       | `betaConfidence` (same)| (inherits artifact_store)   | success +0.05, failure −0.10 |

The recipe formula is intentionally different — it's a sticky qualitative score that compounds slowly on success and falls fast on failure so a recipe that worked once but stops working gets retired before it pollutes the Tier-0 lane.

### Fixes applied

- **`runtime/recipe_replay.ts`** — extended the module header docstring with an explicit "Why this is a DIFFERENT formula" paragraph citing §15 + §17 cutover criterion 6 and pinning the divergence to Phase Align Principle 9. The constants themselves were not changed; the rationale is now structurally documented so a future refactor cannot silently unify recipes onto a Beta posterior without an explicit design decision.

### Verification

- Test 1: source-text pins the artifact + knowledge band constants (`SUCCESS_BAND = 0.3`, `FAILURE_BAND = 0.7`, `RESIDUAL_SUCCESS_THRESHOLD = 0.3`, `RECENT_WINDOW = 20`, `EMA_HALF_LIFE_EVENTS = 20`).
- Test 2: knowledge extractor uses Beta posterior shape — `promoteScore: 0.85`, `demoteScore: 0.30`, `betaMean`, `betaConfidence`.
- Test 3: credit pipeline shares the same band + EMA constants — `SUCCESS_BAND = 0.3`, `FAILURE_BAND = 0.7`, `Math.pow(0.5, 1 / 20)`.
- Test 4: recipe formula is documented and divergent — `0.05`, `-0.10`, `RECIPE_MAX_CONFIDENCE = 0.95`, `RECIPE_AUTO_ARCHIVE_FLOOR = 0.2`, plus the header strings `Confidence model`, `Successful replay`, `Failed replay` so the divergence comment can't be silently deleted.

---

## Summary of structural fixes

| Area                          | Change                                                                                       |
|-------------------------------|----------------------------------------------------------------------------------------------|
| Cycle-1 enforcement (Principle 3) | Extracted `runtime/cycle_one_gate.ts` with `CYCLE_ONE_FORBIDDEN_KINDS` + `isCycleViolation`. Both bridge.ts and task_dispatcher.ts now route through it. |
| Prompt budget (Principle 5)   | New event kind `prompt_truncated` in `substrate/types.ts`. `prompt_composer.ts` emits it when ≥ 1 section is dropped. |
| Credit closure (Principle 6)  | `recipe_replay.replayRecipe` now calls `distributeCredit` after emitting `action_scored`. Try/catch fallback to `applyResidualOutcome` preserves posterior invariant. |
| External push (Principle 7)   | `embedder.extractTextFromEvent` now reads `payload.data.{text,summary,body,message,title,description}` so external-pushed events become first-class for retrieval. |
| State-root mutex (Principle 8) | Exported `__acquireProfileMutexForTest` from `runtimes/camofox.ts` for hermetic test verification; mutex implementation itself unchanged. |
| Posterior divergence (Principle 9) | `recipe_replay.ts` header now carries an explicit "Why this is a DIFFERENT formula" paragraph pinning the intentional divergence. |

### New event kinds

One: `prompt_truncated` (Principle 5). The kind name documents the structural budget bite; payload carries the budget, total, and kept/truncated section names so audit can reproduce the decision.

### New module

One: `runtime/cycle_one_gate.ts` (~30 LOC). Owns the canonical set of forbidden self-iteration kinds and the predicate both bridge paths use.

### Tests added

- `runtime/alignment/recursive_operator.test.ts` (3 tests, Principle 1)
- `runtime/alignment/merger.test.ts` (2 tests, Principle 2)
- `runtime/alignment/cycle_one.test.ts` (3 tests, Principle 3)
- `runtime/alignment/code_as_capability.test.ts` (2 tests, Principle 4)
- `runtime/alignment/depth_one.test.ts` (2 tests, Principle 5)
- `runtime/alignment/credit_closure.test.ts` (1 test, Principle 6)
- `runtime/alignment/external_push.test.ts` (2 tests, Principle 7)
- `runtime/alignment/state_root_mutex.test.ts` (3 tests, Principle 8)
- `runtime/alignment/posterior_consistency.test.ts` (4 tests, Principle 9)

**Total: 22 alignment tests across 9 files. Full suite: 376 tests passing.**

---

## Anything deferred

None. Every principle was either already aligned (3 cases) or had its drift closed in-pass (6 cases). The alignment tests pin the structural properties so future regressions surface immediately rather than waiting for an integration failure.

Two narrow notes for future phases:

1. **Real opencode bridge cycle-1 enforcement (Principle 3, real bridge).** The real-bridge path emits `bridge_failed` with `reason: cycle_violation:<kind>`, but it does NOT yet emit a parallel `dispatcher_violation` event with `failure_kind: cycle_1_only_breach` the way the mock-bridge dispatcher does. The structural enforcement (kill the subprocess on detection) IS in place; the post-bridge dispatcher event scan will still pick up the forbidden kind from the substrate when running in real mode. If a future operator wants the same `dispatcher_violation` row on both lanes, the bridge can emit it directly; this is a minor audit-shape consistency item, not a structural gap.
2. **Per-state-root mutex for uv runtime.** The uv runtime is structurally stateless (Python ephemeral env per invocation) so it has no equivalent of `profile_root`. If a future stateful Python use case lands (e.g. a long-lived numpy notebook session), the same `acquireProfileMutex` pattern in `camofox.ts` should be lifted into a shared helper. Tracked as Phase L note, not Phase Align scope.
