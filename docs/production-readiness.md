# AccInt v2 — Production Readiness Audit

**Generated:** 2026-05-14
**Substrate state:** HEAD `4178f42` ("feat(tests): real opencode smoke + first non-trivial directive (Batch 2.α)"); 458 tests passing across 56 test files; ~28,179 lines of TypeScript across 51 source modules.
**Reviewer:** Phase-Audit follow-up subagent (read-only inspection pass; only deliverable is this file).
**Scope:** Inspection of `system/acc2/` only — design (`docs/v2-design.md`, 1,938 lines), schema (`substrate/schema.sql`), event taxonomy (`substrate/types.ts`), views (`substrate/views.ts`), runtime modules under `runtime/`, CLI surfaces under `cli/`, integration scenarios under `tests/`. v1's `system/scripts` and v1's `.opencode/tool` are out of scope.

---

## TL;DR

acc2 has crossed the "every-design-statement-in-source" bar (Phase Audit + Phase Align reports document this). It is **not** crossed the "production-ready" bar. The biggest remaining gaps are NOT in feature coverage — they are in the four areas a production substrate has to nail before a real owner can trust it overnight: **sandbox enforcement**, **operational observability**, **token + secret rotation**, and **the design's still-uncoded views/event-kinds** (the five "Phase H+ / Phase J+ / Phase L" deferrals catalogued below).

The **Top-10 production blockers** in compact form (each detailed in §"Top 10 production-blocking gaps"):

| # | Severity | Gap | Effort | Phase that owns it |
|---|----------|-----|--------|--------------------|
| 1 | blocker  | Sandbox is honor-system on bun + uv when nsjail is absent; no enforced fs_read/fs_write/net_allow/proc_allow. (`runtime/sandbox.ts:119,199`) | XL | Phase G follow-up |
| 2 | blocker  | No structured logging or metrics surface — `console.log` / `console.error` are the only signals; no Prometheus, OTLP, structured JSON to stdout, or log rotation. (whole codebase) | L | post-Phase L "ops" |
| 3 | blocker  | Embedder + retrieval index has **no HNSW** (`runtime/embedding_index.ts:9`) — design § 5.1 promises HNSW, code does brute-force linear cosine. Acceptable at ≤10k events; production-blocking past pilot. | L | post-Phase F |
| 4 | blocker  | Recipe replay is **single-step only** (audit-report.md E.4); multi-step trajectories defer to a Phase J refinement that has no contract yet. | L | Phase J+ |
| 5 | major    | Admin token + external-push token are **never rotated** — minted once at first run, written to `~/.accint/v2.sock.token`, plaintext, no rotation path. (`runtime/daemon.ts:157`, `runtime/external_ingress.ts`) | M | Phase H+ |
| 6 | major    | Father drift detection emits `father_drift_detected` but never **self-suspends** (audit-report.md E.5) — the `father_self_suspended` event kind is not even declared in `EventKind`. | M | post-Phase K |
| 7 | major    | Five named views from v2-design.md §4.2 are **never created**: `directive_view`, `task_critical_path_view`, `active_inference_view`, `artifact_warning_view`, `model_routing_view`, plus the typed-extractor views `knowledge_view`, `entities_view`, `recipes_view`, `provenance_view`, `judgment_packet_view`. (audit-report.md A.4.2-R2) | L | Phase L |
| 8 | major    | `.env.example` is **stale from v1** — references TELEGRAM, PINATA, AdsPower, ACC_OPERATOR, ACC_BUDGET_WARN_THRESHOLD, ACC_HARD_SILENCE_TIMEOUT_MS — none of which acc2 reads. (`acc2/.env.example`) | S | Phase L |
| 9 | major    | `runtime/bridge.ts` is **1,235 LOC** and growing — by far the largest module after `runtime/mcp_server.ts` (1,465 LOC). Both are due for a module split. | M | post-Phase L |
| 10 | major   | No backup / export / snapshot CLI yet (`docs/ops-guide.md:150` says "A full `acc admin export` flow with online snapshots ships in Batch 3"). For a substrate whose canonical state is one SQLite file, this is critical. | M | Batch 3 |

The substrate is functionally complete enough to run a real opencode dispatch end-to-end (Batch 2.α smoke proves it). It is NOT enough to be deployed to an owner who can't read SQLite directly when something goes wrong.

---

## Severity legend

- **blocker** — v2 cannot be considered production-ready without this.
- **major** — significant gap; ship-blocking for some use cases.
- **minor** — refinement; not ship-blocking.
- **info** — design choice; no fix needed but worth documenting.

## Effort legend

- **S** — < 1 hour.
- **M** — 1-4 hours.
- **L** — < 1 day.
- **XL** — > 1 day.

---

## Findings by category

### A. Phase markers (deferrals across the implementation)

Every site that names a still-pending Phase as the owner of behavior we ship anyway. Source-of-truth phase plan is `docs/v2-design.md` §17.

| File:line | Comment / verbatim string | Responsible phase | Impact |
|-----------|--------------------------|-------------------|--------|
| `substrate/extractors.ts:7-23` | "Phase B2 scope: …", "Phase B2 stub: no-op when no embeddings are present (Phase F)" | Phase F (mostly closed by Audit) | Embeddings + dedup wired; markers historical. |
| `substrate/extractors.ts:404,408,642` | "Phase B2: gracefully no-op when no embeddings are present. Phase F …", "Phase J refines the matching" | Phase F (closed), Phase J (open) | Stable until Phase J multi-step recipes land. |
| `substrate/views.ts:9-12` | "Phase B3 and any test that uses views must invoke runViews(db) explicitly" | Phase B (closed) | Historical comment. |
| `substrate/views.ts:114` | "cosine × posterior reranker is Phase F; this is a placeholder ordering." (`artifact_routing_view`) | Phase F (closed) | Reranker now reads through `retrieval.ts`. |
| `substrate/views.ts:138-143` | "Phase H: still returns the GLOBAL per-origin aggregation here…" | Phase H (closed) | TS-side per-shape aggregation lives in `originPromotionByGoalShape`. |
| `substrate/views.ts:178-181` | "contradictory_candidates_view — Phase B2 placeholder. … once embeddings light up (Phase F), this view surfaces those pairs" | Phase F (closed) | View now populated by `extractSemanticDedup`. |
| `substrate/views.ts:594` | "Routing ranking — score × (1 - residual_mean). Phase B+ adds cosine." | Phase F+ | Cosine reranker not yet a view; it lives in `retrieval.ts`. **Info.** |
| `substrate/views.ts:763` | "Per-(origin, goal_shape) promotion ratio — Phase H (§3.6.1 Rule 4, §18 cutover criterion 19)" | Phase H (closed) | Functional. |
| `substrate/seed.ts:273,292,310` | THREE seed code artifacts whose `body` is literally "`// stub Phase B+: will be authored per LATM. Computes text-embedding-3-small over args.text + stores in events.embedding.`" — the seed `substrate_embed`, `substrate_search`, `agent_invoke` artifacts are stub strings, not real code. | Phase F follow-up | **major** — these are admitted as seed artifacts but cannot actually run; if a brain picks one, the bun runtime will execute a comment-only file and emit `nonzero_exit:0` (no @@RESULT@@ marker). See `substrate/seed.ts:273` (substrate_embed), `:292` (substrate_search), `:310` (agent_invoke). |
| `substrate/seed.ts:375` | "This is intentionally NOT a full readability port — Phase H readability_extract_v2 …" | Phase H | Note only. |
| `runtime/task_dispatcher.ts:7-15` | "Phase D's MVP fixture targets residual=0; Phase E adds threshold" | Phase E (closed) | Historical. |
| `runtime/task_dispatcher.ts:53` | "Override the bridge call — Phase D tests use this to inject the …" | Phase D (closed) | DI for tests. |
| `runtime/task_dispatcher.ts:161` | "Phase J: route through recipe_replay.ts. The decider already validated …" | Phase J (closed via E.4-deferred multi-step) | See item 4. |
| `runtime/task_dispatcher.ts:233-239` | "Phase E wires Claude inline lane; Phase D never returns this lane.", `payload.reason = "claude_inline_phase_e_stub"` | Phase E (NOT fully wired — the inline lane is **stubbed out** in the dispatcher; if `low_risk_inline_patterns_view` returned a match the dispatcher would emit this stub). | **major** — the read-side of the inline lane is wired via `lowRiskInlinePatterns()` (audit fix A.3.6-R1), but the dispatcher's write-side STILL records `claude_inline_phase_e_stub` instead of doing the inline execution. The orchestrator was supposed to call this; today it's a refused-with-marker path. See `runtime/task_dispatcher.ts:239`. |
| `runtime/task_dispatcher.ts:345-388` | "Phase H: surface any declared irreversible effects via …" / "Route through the Phase H credit pipeline." | Phase H (closed) | Functional. |
| `runtime/task_dispatcher.ts:447` | "Phase H: credit pipeline distributes the residual across the …" | Phase H (closed) | Functional. |
| `runtime/task_dispatcher.test.ts:190` | `test("Phase H: action_scored triggers credit pipeline …")` | Phase H | Test exists. |
| `runtime/task_dispatcher.test.ts:239` | `test("Phase J: substrate_replay route commits without calling the bridge", …)` | Phase J | Test exists for single-step only. |
| `runtime/sandbox.ts:11,26,119,129` | "Phase G adds a real syscall sandbox.", "cpu_ms and memory_mb are honor-system on the bun side; Phase G adds a …", "Phase D wires the substrate-handle …" | Phase G (NOT closed for bun, partially closed for uv via nsjail when present, NOT closed for memory) | **blocker** — see Top-10 item 1. |
| `runtime/artifact_admission.ts:11,129,170` | "`phase_g_runtime_unsupported` and rolls back the row.", "Phase G lights up …", "(will run at execution time once playwright/uv are present). For Phase G we …" | Phase G (closed for happy path; uv + camofox return runtime_unavailable when binaries absent) | OK. |
| `runtime/embedder.ts:207` | "by Phase F's schema migration" | Phase F | Closed. |
| `runtime/recipe_replay.ts:26,70,132,287,393,411` | Multiple "Phase J" markers — band constants, "fresh brain dispatch (Phase H credit pipeline scoring still applies)", "trajectory's action_predicted step (Phase J directives are …)" | Phase J | Functional for single-step. **major** multi-step still open. |
| `runtime/bridge.ts:4-11,183,207,517,1096,1114,1120` | "PHASE D MOCK. The real bridge spawns `opencode run` … Phase E work", "Phase E real bridge", "phase_e_real_bridge_not_wired" failure reason | Phase E + Batch 2.β (closed for real path; mock still default) | OK — both paths work; mock is the test default. |
| `runtime/bridge.ts:207` | `payload: { reason: "phase_e_real_bridge_not_wired" }` emitted when the mock bridge sees an unknown prompt marker | Phase E (closed for the two fixtures; UNKNOWN prompts still fail with this string) | **major** — the mock can only handle two fixture prompts (`FIXTURE_D_MARKER`, `EXAMPLE_COM_MARKER`). Any other prompt under mock-mode returns `auth_missing`, which is misleading (the failure is "mock doesn't recognise the prompt", not "auth missing"). |
| `runtime/task_scheduler.ts:11,57,141` | `error: "phase_j"` failure-shape from `phaseJRecipeReplay` — the substrate-replay route still uses this string. Comment: "Phase J recipe replay: stub returns {ok:false, error:'phase_j'}." | Phase J | **minor** — only the new dispatcher path uses the real `replayRecipe`; this stub remains in the scheduler's older dispatch path for back-compat. See item 4. |
| `runtime/watch_edges.ts:22-23` | "(Phase D) currently feeds an empty array into prompt_composer's WATCHED OUTPUTS section; Phase E lights up the real walk." | Phase E | Closed via `watch_edges.ts` real walk; comment is historical. |
| `runtime/prompt_composer.ts:13,39-40,58-82,105-106,142,335-355` | "Phase F replaces with a real tokenizer." (closed), "Phase F wires the async retrieve()", "Phase F: real tokenizer via js-tiktoken's cl100k_base", "Phase D stand-in: pull recent promoted knowledge candidates. Phase F lights …", "P2/P3 sections are stubs in Phase D (no upstream-task or stakeholder data …)" | Phase D + F | **minor** — P2/P3 prompt sections are now populated by real upstream walks (Phase E `watch_edges.ts`) but the comment says "stubs in Phase D" — comments are stale. Verify via code, not comments. |
| `runtime/runtimes/bun.ts:25,27,71,148` | "Irreversible-effect detection (v2-design.md §6.2) is honor-system in Phase C: substrate watches stdout for `@@IRREVERSIBLE@@` markers and trusts them. Phase G adds an out-of-process detector." | Phase G | **major** — `@@IRREVERSIBLE@@` marker discipline is the brain's responsibility today; the substrate cannot OBSERVE a real side-effect (write to network, fs outside the sandbox). |
| `runtime/runtimes/camofox.ts:165` | "mutex without spawning firefox. Phase Align Principle 8 uses this to …" | Phase Align | Closed. |
| `runtime/runtimes/uv.ts:16,27` | "Phase G adds nsjail wrapper" / "Irreversible-effect detection is honor-system in Phase G" | Phase G | nsjail wrapper is OPPORTUNISTIC (uses if installed, warns + runs directly if not). |
| `runtime/mcp_server.ts:363-367,431,517,545,1170,1214,1224` | "Phase Audit: route `view_name` to the substrate/views.ts accessor.", "Views not yet implemented return `view_not_implemented:<name>`", "mode: recent_events_stub", "uv / camofox-browser → return `phase_g_runtime_unsupported`" | Phase Audit (closed for routed views) + Phase G (closed when binaries present) | OK. |
| `runtime/dispatch_decider.ts:5-13,42,61,124-134` | "Phase J wires the recipe view; Phase D never returns this lane …", "Phase D never returns this lane", "Phase J: delegate to the real matcher in runtime/recipe_replay.ts", "Phase Audit: route through `low_risk_inline_patterns_view`", "Phase D heuristic: short single-noun goals are 'low', everything else mid. Phase F can replace with an embedding-derived feature." | Phase D + Phase F + Phase J | **minor** — heuristic-based risk classification (`computeRisk`) is still a string-length check at line 124. A Phase F embedding-derived feature was promised. |
| `runtime/father.ts` (~12 mentions) | Father is Phase K; the Phase K marker is design-doc-correct, but Father's `father_self_suspended` reservation never materialised (E.5 deferral). | Phase K + post-K | See Top-10 item 6. |
| `runtime/cycle_one_gate.ts:8` | "surfaces is one too many: the moment the design's two forbidden event kinds …" | Phase Align | Closed. |
| `cli/init.ts:219` | warns "OPENAI_API_KEY missing — Phase F embeddings disabled" | Phase F | Closed; the warn is correct degrade-path messaging. |
| `cli/init.ts:254` | warn "[5/8] uv: NOT FOUND — needed for Phase G uv runtime; install …" | Phase G | OK. |
| `tests/integration/harness.ts:124` | `"acc2 integration harness — Phase Harness\n"` | Phase Harness (closed) | Marker only. |

### B. TODO / FIXME / HACK comments

Direct grep on `TODO|FIXME|HACK|XXX` across runtime/cli/substrate non-test source produces **0 hits**. (Every "TODO" surfaced by the grep is the literal string `"TODO"` inside `fixture_d_count_todos` test data — fixture content, not a code marker.) **info — clean.**

### C. Skipped tests

Direct grep on `test.skip|test.skipIf|it.skip|describe.skip` yields exactly **5 skip sites**, all in `runtime/runtimes/{camofox,uv}.test.ts`. None are skipped permanently — all are gated by binary-presence detection (`UV_AVAILABLE`, `__isPlaywrightInstalledForTest()`, `hasCamoufoxBinary()`).

| File:line | Skip reason | What un-skipping would prove |
|-----------|-------------|-----------------------------|
| `runtime/runtimes/camofox.test.ts:232` | `describe.skipIf(skipSpawn)("end-to-end camoufox spawn", …)` — needs both playwright + camoufox binary. | End-to-end browser session: real `firefox.launchPersistentContext` against a profile. Today this is uncovered on a stock dev machine. |
| `runtime/runtimes/uv.test.ts:57` | `describe.skipIf(!UV_AVAILABLE)("runUvArtifact — trivial success path", …)` | uv runtime smoke. |
| `runtime/runtimes/uv.test.ts:117` | `describe.skipIf(!UV_AVAILABLE)("runUvArtifact — failure paths", …)` | uv exit-code propagation. |
| `runtime/runtimes/uv.test.ts:132` | `describe.skipIf(!UV_AVAILABLE)("runUvArtifact — watchdog", …)` | uv wall-timeout SIGTERM. |
| `runtime/runtimes/uv.test.ts:152` | `describe.skipIf(!UV_AVAILABLE)("runUvArtifact — tempdir hygiene", …)` | uv tempdir cleanup. |

**Severity: info.** The gating is the right design (CI machines that lack uv / playwright / camoufox legitimately can't run these). But a production deploy MUST have all three present — currently only `acc doctor` warns, not enforces.

### D. Deferred stubs (Phase B+ / Phase G+ markers)

The three seed code artifacts in `substrate/seed.ts:273,292,310` whose `body` field is a **stub string** rather than an executable artifact:

```
ca_substrate_embed   body = "// stub Phase B+: will be authored per LATM. Computes text-embedding-3-small over args.text + stores in events.embedding."
ca_substrate_search  body = "// stub Phase B+: will be authored per LATM. Embedding+posterior reranked retrieval over substrate view rows."
ca_agent_invoke      body = "// stub Phase B+: will be authored per LATM. Spawns a sub-agent (Claude or opencode) for a sub-directive."
```

These three are admitted at install time (seed loader inserts them with `posterior_alpha/beta = 1/1`, `score=0.5/0.3`) but they CANNOT actually run — the bun runtime will execute the comment-only TS file, emit no `@@RESULT@@` marker, and the verifier will see no observation. They were placeholders to satisfy the design's seed table; the brain was expected to author real versions once it learned the substrate API.

**Severity: major.** A naive brain dispatch that picks `ca_substrate_embed` (e.g. on a "compute embeddings for these texts" directive) will run the stub, fail silently, and the residual will be high — *but the failure mode is the runtime, not a "this artifact is incomplete" message*. The right cure is either (a) **delete the three stub seed entries from `substrate/seed.ts`** so the brain has to author them itself, or (b) **write a real implementation** of each (substrate_embed calls `computeEmbedding`, substrate_search calls `retrieve`, agent_invoke spawns a sub-bridge).

Other Phase-X deferred stubs surfaced by the grep set:

| File:line | What it stubs | Phase that should fix |
|-----------|--------------|----------------------|
| `runtime/task_dispatcher.ts:239` | `claude_inline_phase_e_stub` — the inline lane records this when matched, but never actually runs inline (see Item 10 in Top-10). | Phase E follow-up |
| `runtime/bridge.ts:207` | `phase_e_real_bridge_not_wired` — the mock bridge emits this on unknown prompts, even though Phase E is closed. | Phase E follow-up (rename the failure reason) |
| `runtime/task_scheduler.ts:11,141` | `phase_j` failure shape returned by `phaseJRecipeReplay` — surfaces in the scheduler's older replay path. | Phase J |
| `runtime/mcp_server.ts:517` | `mode: "recent_events_stub"` returned by `substrate.search` when the embedding index is empty. **info** — this is correct degrade-path behaviour; "stub" is the WRONG label, it's the recency fallback. Rename to `mode: "recency_fallback"`. | minor |
| `runtime/mcp_server.ts:1170,1214,1224` | `view_not_implemented` (described in tool-description prose) — the brain reads this and discovers it can't reach `directive_view`, `task_critical_path_view`, etc. | Phase L |

### E. Modules without tests

Direct grep for `*.test.ts` siblings of each source `.ts` file shows the following modules have **no dedicated test**:

| Module | LOC | Why no test? |
|--------|-----|--------------|
| `runtime/cycle_one_gate.ts` | 34 | Pure-data constant + predicate. **Covered indirectly** by `runtime/alignment/cycle_one.test.ts:104` (literal-set assertion + behaviour-of-both-paths test). **info — covered.** |
| `runtime/event_bus.ts` | 106 | In-process pub/sub. **Covered indirectly** by `runtime/daemon.test.ts` (SSE stream tests subscribe through the bus). **minor — direct test of `subscribe/unsubscribe/publish/resetBus` semantics would be cheap.** |
| `runtime/events.ts` | 119 | `emitEvent` thin wrapper around the events table. **Covered indirectly** by every dispatcher/credit/extractor test. **info — covered.** |
| `runtime/ids.ts` | 42 | ID minter. **info — pure function, lightly covered transitively.** |
| `runtime/mcp_server_stdio_entry.ts` | 22 | Entry point. **info — trivially small.** |
| `cli/rpc.ts` | 250 | RPC + SSE client. **Covered indirectly** by `cli/dispatch.test.ts` and `cli/watch.test.ts`. **major — `mcpCall` failure-mode coverage (network failure, malformed JSON, reconnect) is not directly asserted; this is the substrate's contact-with-reality layer.** |
| `substrate/types.ts` | 275 | Pure types. **info — no runtime behaviour to test.** |
| `substrate/schema.sql.d.ts` | 5 | Module declaration. **info.** |

### F. Honor-system sandbox warnings (security/safety boundaries)

Every site where the substrate emits `sandbox_unenforced_warning` or comments "honor-system" / "not enforced":

| File:line | Boundary | What's NOT enforced | Severity |
|-----------|----------|---------------------|----------|
| `runtime/sandbox.ts:19-23` | bun: `net_allow` | The bun runtime cannot block outbound HTTP — a script declaring `net_allow=[example.com]` can still `fetch("https://attacker.com")`. We emit a warning event but proceed. | **blocker** |
| `runtime/sandbox.ts:43,160` | bun: `net_allow` declared | Per-entry warning emitted as `sandbox_unenforced_warning` in the buildBunPermissionArgs output. | **blocker** |
| `runtime/sandbox.ts:165` | bun: `proc_allow` declared | Same shape — declared but not enforced. | **blocker** |
| `runtime/sandbox.ts:117-129` | bun: `cpu_ms`, `memory_mb` | wall_ms IS enforced via kill-watchdog (`runtimes/bun.ts`). cpu_ms + memory_mb are honor-system on the bun side. | **major** |
| `runtime/sandbox.ts:199-200` | uv: `fs_read` / `fs_write` / `net_allow` without nsjail | Warning emitted. uv runs in a tempdir; the temp boundary is the only barrier. | **blocker** when nsjail is absent |
| `runtime/sandbox.ts:262` | camofox: env-shaping only | "the sandbox here only shapes the env passed to the wrapper" — chromium is otherwise unrestricted within `browser_allow_domains` (which **is** enforceable via playwright's request-router, but the code doesn't intercept). | **major** |
| `runtime/runtimes/bun.ts:25,267` | bun: irreversible effects | Honor-system: brain emits `@@IRREVERSIBLE@@` markers; substrate parses them. A malicious script can SKIP emitting the marker. | **major** |
| `runtime/runtimes/uv.ts:16,27,228,255` | uv: irreversible effects + nsjail | Same shape — honor-system without nsjail. "nsjail not on PATH — uv runtime executing without syscall sandbox" emitted as warning. | **blocker** when nsjail is absent |
| `cli/doctor.ts:196` | nsjail | "not installed — uv sandbox is honor-system without nsjail (runs still work)" — verdict `info`, not `warn`. **Should be `warn` in production-readiness mode.** | **minor** |

**Severity overall: blocker.** The design (`v2-design.md` §11.3) promises "per-runtime sandbox declaration … the substrate enforces." Today the substrate WARNS but does not enforce. A brain that authors a network-exfiltrating action artifact succeeds at runtime; only the warning event is generated.

### G. External tool dependencies + absence handling

For each external tool acc2 references:

| Tool | Required for | Absent → what happens? | Absence tested? |
|------|-------------|-----------------------|-----------------|
| `bun` ≥1.0 | Everything (the runtime itself) | Daemon won't even start. `cli/doctor.ts:checkBunVersion` → `fail`. | Implicit (all tests need bun). |
| `opencode` CLI | `ACC2_BRIDGE_MODE=real` brain dispatch | `cli/doctor.ts:checkOpencode` → `fail`. `runtime/bridge.ts:spawnRealOpencode` raises `spawn_failed:ENOENT` → bridge returns `auth_missing`. The default mock keeps tests green. | Yes — `runtime/bridge.test.ts:72-93` injects ENOENT-throwing spawnFn. |
| `OPENAI_API_KEY` | Embeddings (`text-embedding-3-small`) only | `runtime/embedder.ts` returns `null` from `computeEmbedding`; semantic dedup falls back to lexical; retrieval falls back to recency. `cli/doctor.ts:checkOpenAiKey` → `warn`. | Yes — `runtime/embedder.test.ts` covers the null-key path. |
| `uv` | uv-runtime code artifacts only | `cli/doctor.ts:checkUv` → `warn`. `runtime/runtimes/uv.ts` returns `runtime_unavailable` cleanly. | Yes (and gated by `UV_AVAILABLE`). |
| `nsjail` | uv sandbox enforcement only | `cli/doctor.ts:checkNsjail` → `info`. `runtime/runtimes/uv.ts:228` emits `sandbox_unenforced_warning` and runs directly. | Yes — `runtime/runtimes/uv.test.ts:99`. |
| `playwright` (npm) | camofox-browser runtime only | `runtime/runtimes/camofox.ts:357` returns `camofox_runtime_unavailable` with hint. **Not in `package.json`** — operator must `bun add playwright` separately. | Yes — `runtime/runtimes/camofox.test.ts:64-100`. |
| `camoufox` binary | camofox-browser runtime only | `runtime/runtimes/camofox.ts:374` returns `camofox_runtime_unavailable`. `cli/doctor.ts:checkCamoufoxBinary` → `warn`. | Yes (gated). |

**Severity: minor.** Every external tool has graceful-degrade handling AND a doctor check. The one **major** in this matrix: `playwright` is referenced by the camofox runtime but is **not declared in `package.json`'s `dependencies`** — operators must remember to `bun add playwright`. The dependency should be added (or extracted to an `optionalDependencies` block that npm-style ecosystems honour).

### H. Schema + view + event-kind coverage vs design

#### Tables

`substrate/schema.sql` declares 3 tables: `meta` (k/v), `events` (append-only ledger), `code_artifact` (LATM registry). Design §4.1 names these three. **info — aligned.**

#### Views (CREATE VIEW IF NOT EXISTS in `substrate/views.ts`)

**Created (15):**
1. `task_graph_view`
2. `ready_tasks_view`
3. `failure_view`
4. `code_artifact_registry_view`
5. `artifact_routing_view`
6. `embedding_index_view`
7. `origin_promotion_view`
8. `contradictory_candidates_view`
9. `owner_conversation_view`
10. `rolling_review_due_view`
11. `directive_conflicts_view`
12. `stakeholder_state_view`
13. `active_objectives_view`
14. `irreversible_effects_view`
15. `low_risk_inline_patterns_view` (added by Phase Audit)

**Designed (§4.2) but NOT created:**
- `directive_view(directive_id)` — design line 575. **major.**
- `task_critical_path_view(directive_id)` — design line 578. **minor.**
- `active_inference_view` — design line 581. **minor.**
- `artifact_warning_view` — design line 583. **minor.**
- `model_routing_view` — design line 584. **minor.**
- `knowledge_view` (typed extractor view) — design line 594. **major.** Referenced by §13.1 prompt RETRIEVED KNOWLEDGE section.
- `entities_view` — design line 595. **minor.**
- `recipes_view` — design line 596. **info** — recipe lookup is in `recipe_replay.ts:findRecipeMatch`; design promises a passthrough view that returns the same shape.
- `provenance_view` — design line 597. **info.**
- `judgment_packet_view` — referenced in §13.1 retrieval table. **major** — prompt composer §13.1 names it as a load-bearing P1 retrieval source.

(All five "typed-extractor" views were always known to be deferred; audit-report.md flags them as Phase L work.)

#### Event kinds (substrate/types.ts EventKind union)

**70+ event kinds declared.** Spot-checked against §4.1:

- Every kind named in `runtime/audit.test.ts:455` is in the union.
- 9 new kinds added by Phase Audit (per audit-report.md): `runtime_subprocess_started`, `runtime_subprocess_resource_warning`, `runtime_subprocess_soft_terminated`, `runtime_subprocess_hard_killed`, `runtime_subprocess_orphaned`, `runtime_subprocess_completed`, `knowledge_synthesized`, `sandbox_unenforced_warning`, `external_source_registered`. All present.

**Declared but never emitted (dead-coded):**
- `projection_checkpointed` — declared at `types.ts:167`. No emit site. **major** — design §4.4 says "view-level projections: idempotent SQL. Re-running produces identical results. `projection_checkpointed` events store materialized snapshots." This is the consistency-checkpoint mechanism; nothing emits it.
- `self_modification_recorded` — declared at `types.ts:169`. No emit site. **minor** — design §3.6 implies self-as-target events use this kind.
- `runtime_subprocess_resource_warning` — declared, **never emitted**. Memory/CPU warning thresholds are not checked. **major.**
- `runtime_subprocess_orphaned` — declared, never emitted. Means the substrate has no way to surface "subprocess survived parent termination." **minor.**

**Reserved but not yet in the union:**
- `father_self_suspended` — audit-report.md E.5 reserves this name; never added to `EventKind`. Father continues to emit `father_drift_detected` instead of suspending. **major.**

#### MCP tools exposed (runtime/mcp_server.ts → substrate.* + runtime.* surface)

`runtime/mcp_server.ts` registers **24 tools** via `server.addTool(...)` (lines 1158-1397). The same set is also routed via `HTTP_DISPATCH` for Bun.serve-style HTTP POST `/mcp/<method>` (line 1409). `cli/rpc.ts:McpMethods` exports the same 24 method names.

**Coverage vs §13.2 (substrate API the brain queries mid-cycle):**

| §13.2 method | MCP tool name | Status |
|--------------|---------------|--------|
| `substrate.search(query, opts?)` | `substrate.search` | OK |
| `substrate.get_event(event_id)` | `substrate.get_event` | OK |
| `substrate.get_artifact(artifact_id)` | `substrate.get_artifact` | OK |
| `substrate.read_view(view_name, args?)` | `substrate.read` | OK (renamed) |
| `substrate.emit_action_predicted(...)` | `substrate.emit` (with kind=action_predicted) | OK (one emit endpoint) |
| `substrate.emit_task_node_opened(...)` | `substrate.emit` | OK |
| `substrate.emit_knowledge_candidate(...)` | `substrate.emit` | OK |
| `substrate.emit_code_artifact_candidate(...)` | `substrate.emit` → routed to `substrate.admit_artifact` for fixture admission | OK |
| `substrate.emit_directive_amended(...)` | `substrate.amend_directive` | OK (also accepts emit kind=directive_amended) |

Plus 15 tools BEYOND what §13.2 documents: `substrate.embed_text`, `substrate.run_artifact`, `substrate.run_verifier`, `substrate.credit`, `substrate.admit_artifact`, `substrate.open_fixture`, `runtime.dispatch_ready_task`, `runtime.scheduler_tick`, `substrate.record_stakeholder_state`, `substrate.record_interference_edge`, `substrate.open_directive`, `runtime.process_rolling_reviews`, `runtime.father_iterate`, `runtime.detect_father_drift`, `substrate.find_recipe`, `runtime.replay_recipe`, `substrate.register_external_source`, `runtime.recent_events`. All design-justified (added by Phase E-K) but not documented in §13.2 of the design doc. **minor — design doc could be updated to enumerate the full tool surface.**

### I. MCP tool surface coverage vs design — see §H above

### J. Dependency hygiene (package.json)

```json
{
  "dependencies": {
    "@types/bun": "^1.3.0",
    "fastmcp": "^4.0.1",
    "js-tiktoken": "^1.0.21",
    "sqlite-vec": "^0.1.9",
    "zod": "^4.4.3"
  },
  "devDependencies": {}
}
```

| Dep | Pinned? | Risk |
|-----|---------|------|
| `@types/bun` | caret (`^1.3.0`) | Type-only. **info.** |
| `fastmcp` | caret | The MCP server transport. Caret is **major risk** — fastmcp 5.x could break httpStream transport semantics. Pin to `~4.0.1` or exact `4.0.1`. |
| `js-tiktoken` | caret | Real tokenizer; data-file fetched at module load. **minor.** |
| `sqlite-vec` | caret | **Imported but I cannot find a single import site under `runtime/` or `substrate/`** — `grep -rn 'sqlite-vec' --include='*.ts' .` returns hits only in **comments** (`substrate/extractors.ts:405`, `runtime/embedder.ts:59,73`). The package is installed (`node_modules/sqlite-vec` + `node_modules/sqlite-vec-linux-x64`) but no code actually loads it. The embedding index is brute-force linear scan; `sqlite-vec` was intended for HNSW that never materialized. **major — unused production dep.** Either remove it from `package.json` or wire `embedding_index.ts` to use it. |
| `zod` | caret | Schema validation. OK. |

**Missing production-critical deps:**
- **No structured logger** (`pino`, `winston`, `bunyan`). Logs are `console.log`/`console.error` only. **blocker** for any production deploy.
- **No metrics surface** (`prom-client`, `@opentelemetry/api`, `pino-pretty`). **blocker.**
- **No error tracker** (`@sentry/node`, `bugsnag`). **major.**
- **No `playwright`** — referenced by `runtime/runtimes/camofox.ts` but not in `dependencies`. **major** (see §G).

**Unused:** `sqlite-vec` (see above).

### K. Docs coverage gaps

`docs/` enumeration (7 files; 3,786 lines total):
- `v2-design.md` (1,938 LOC) — canonical design.
- `whitepaper.md` (612 LOC) — philosophy.
- `audit-report.md` (355 LOC) — Phase Audit findings.
- `alignment-report.md` (333 LOC) — Phase Align findings.
- `operator-install.md` (220 LOC) — install steps.
- `ops-guide.md` (212 LOC) — running/updating/troubleshooting.
- `real-brain-runbook.md` (116 LOC) — Batch 2.α smoke recipe.

**Missing operator docs:**

| Concern | Doc that should exist | Severity |
|---------|----------------------|----------|
| First-run quickstart (≤30 lines) | `docs/quickstart.md` | **major** — design A.6 says "Re-authored against daemon CLI shape" but the file is not yet created. |
| MCP tool reference (every tool + parameter shape) | `docs/mcp-reference.md` | **major** — operators wiring third-party MCP clients have no canonical surface. |
| Brain prompt structure (literal §13 walkthrough) | `docs/prompt-structure.md` or §13 sub-page | **minor** — `v2-design.md` §13 exists but isn't operator-extractable. |
| Architecture overview (1-pager for new contributors) | `docs/architecture.md` | **major** — v2-design.md at 1,938 lines is too dense for first-read. |
| Failure-mode runbook (not just the Batch 2.α one) | `docs/runbook.md` | **major** — `real-brain-runbook.md` covers ONE path; a generalized "what to do when X" runbook is missing. |
| Contributing guide / module layout | `docs/CONTRIBUTING.md` | **minor.** |
| Security model (token rotation, sandbox guarantees, threat model) | `docs/security.md` | **blocker** — relates directly to §F honor-system warnings. |
| Backup / restore procedure | partial in `ops-guide.md:135` | **major** — promises `acc admin export` but tells operators "cp -a" today. |

### L. Code-quality smells

**Files > 600 LOC** (good split candidates):
- `runtime/mcp_server.ts` — **1,465 LOC**. Mostly handlers + tool registration; could split into `mcp_handlers.ts` + `mcp_server.ts`.
- `runtime/bridge.ts` — **1,235 LOC**. Mock + real path + config materializer all in one file. Split: `bridge_mock.ts` + `bridge_real.ts` + `bridge_types.ts`.
- `substrate/extractors.ts` — **836 LOC**. Multiple extractors (knowledge, recipe, code-artifact, semantic-dedup) live together; split per-extractor for testability.
- `substrate/views.ts` — **843 LOC**. SQL view definitions + TS accessors interleaved. Either split (`views_ddl.ts` + `views_accessors.ts`) or accept the cohesion.
- `cli/watch.ts` — **480 LOC**. TUI rendering. Borderline.
- `runtime/recipe_replay.ts` — **548 LOC**. Tier-0 replay + recipe extraction. Borderline.
- `runtime/runtimes/camofox.ts` — **582 LOC**. Browser orchestration. Inherent complexity.
- `runtime/task_dispatcher.ts` — **571 LOC**. The dispatcher; arguably too big given how much code lives in `bridge.ts` for the same path.
- `runtime/daemon.ts` — **556 LOC**. Supervisor + HTTP + SSE + workers. The SSE handler (`handleEventsStream`) is large enough to split.
- `tests/integration/scenarios.ts` — **838 LOC** (test code).
- `tests/integration/real_brain_smoke.ts` — **538 LOC** (test code).

**Functions > 100 LOC** (heuristic walk; not exhaustive):
- `runtime/bridge.ts:spawnRealOpencode` — ~470 LOC start-to-finish (lines 657-1100). Watchdog + spawn + JSON-line parsing + handshake + cleanup all in one function. **major** split candidate.
- `runtime/task_dispatcher.ts:dispatchReadyTask` — ~360 LOC (lines ~115-470). Core dispatch path. Reasonable but at the high end.
- `runtime/runtimes/camofox.ts:runCamofoxArtifactInner` — ~250 LOC (lines ~387-540).

**TypeScript `any` usage outside tests:**
- `runtime/mcp_server.ts:1422-1446` — `HTTP_DISPATCH` table is typed with `(ctx, args: any)`; each handler is registered with `... as any`. **24 sites of `as any`.** Reason: each handler's `args` is its own Zod-validated shape; the table needs ONE type for all 24. Tractable: wrap with a generic `<S extends ZodSchema>` indirection. **minor.**
- `runtime/mcp_server.ts:1462` — `let body: any = {};` in `handleMcpRequest`. Acceptable (it's a parsed JSON envelope before validation). **info.**
- `cli/rpc.ts:226` — `{ ok: true; result: any }` in the parsed McpResult shape. Acceptable. **info.**

**Magic numbers:** Mostly named-constant'd. A few survivors:
- `runtime/task_topology.ts:176` — `if (depth > 1000) break; // pathological cap`. **info — guarded with a comment.**
- `runtime/daemon.ts:166` — `setInterval(() => {…}, 5000)` — heartbeat. **minor — should be a named const.**
- `runtime/daemon.ts:181,193,259,302` — assorted `2000` / `10_000` / `60_000` literals. **minor.**
- `runtime/runtimes/camofox.ts:104` — `KILL_GRACE_MS = 1000` — properly named.
- `runtime/father.ts:122,123` — `OWNER_ACTIVE_WINDOW_MS_DEFAULT = 60_000`, `TEMPLATE_USE_COOLDOWN_MS = 10 * 60 * 1000`. OK.
- `runtime/rolling_reviewer.ts:46-50` — cadence period multipliers. OK.

**Inline regex without comment:**
- `runtime/prompt_composer.ts:337` — `/count files .* TODO/i.test(directiveText)` — Phase D fixture key. Comment is on the line above; OK.
- `runtime/bridge.ts:157` — `/<title[^>]*>([\s\S]*?)<\/title>/i` in `EXAMPLE_COM_ACTION_BODY` (inside a code-artifact body). Comment above. OK.

**Missing JSDoc on exported functions:** light-touch grep shows most exports have `/** … */` blocks. **info — clean.**

### M. Operational gaps

| Concern | Status | Severity |
|---------|--------|----------|
| **Metrics surface** | None. No Prometheus `/metrics`, no OpenTelemetry, no metrics emission. | **blocker** |
| **Structured logging** | None. `console.log`/`console.error` only. Log goes to stdout/stderr of the spawned daemon; no rotation, no level, no JSON-line shape. | **blocker** |
| **Health endpoint** | `GET /health` (aux port) — returns `{status, pid, uptime_ms, db_path, events_count, mcp_port, aux_port, mcp_transport}`. Sufficient for liveness probe. | **OK — info.** |
| **Readiness endpoint** | Absent. No `/ready` distinct from `/health`. For k8s deploys this matters. | **major** |
| **Backup** | "cp -a `~/.accint/state ~/accint-backup-$(date)`" (`ops-guide.md:135`). Online snapshot promised for Batch 3. | **blocker** |
| **Restore** | No restore CLI; operator restores manually. | **major** |
| **Admin token rotation** | Token written at `runtime/daemon.ts:157` via `newAdminToken()`, plaintext to `~/.accint/v2.sock.token` (mode 0o600). Daemon restart re-mints. **No rotation while running.** | **major** |
| **External-push token rotation** | Default token from env at boot. Per-source tokens minted by `substrate.register_external_source`. **No rotation tool; source removal requires daemon restart.** | **major** |
| **Multi-tenant** | Single daemon per host, single state file. Two owners cannot share a daemon. Document this constraint. | **info — design choice.** |
| **Shutdown is auth-gated** | Yes (`/shutdown` with admin token). OK. **info.** |
| **SIGTERM cleanup** | `process.once("SIGTERM", …)` calls `stop()`. WAL flush + lock-file removal. OK. **info.** |
| **Idempotent restart** | Lock file is reaped if pid is dead (`runtime/daemon.ts:117,131`). OK. **info.** |
| **Embedding API outage retry** | `runtime/embedder.ts` returns null on error; embedder worker on next tick retries. OK. **info.** |
| **Database integrity check** | Implicit at daemon boot (`PRAGMA integrity_check` referenced in `cli/doctor.ts:131`). No explicit check in `db.ts`. | **minor — verify the implicit check actually runs.** |
| **Schema migrations** | Schema is one `schema.sql` file; no migration framework. Doctor says "schema migrations are applied at daemon boot; the daemon refuses to start if the migration fails." (`ops-guide.md:131`). Today there's only one schema version — but when v2 adds a column, the migration story is `CREATE TABLE IF NOT EXISTS …` only. **major** — proper migrations (numbered, transactional, recordable) are absent. |
| **Daemon supervises subprocesses** | Yes — `runtime/runtimes/{bun,uv,camofox}.ts` watchdogs each subprocess with SIGTERM/SIGKILL. **info — covered.** |
| **Daemon crash recovery** | The HNSW index, scheduler queues, MCP server state, in-flight brain dispatches all live in daemon memory. WAL guarantees event durability; the boot path rebuilds the embedding index from `embedding_index_view`. **In-flight brain subprocesses do NOT survive daemon restart** (the bridge spawns them with the daemon as parent; daemon termination kills them). | **major — needs explicit documentation.** |

---

## Top 10 production-blocking gaps (detail)

### Top-1: Sandbox is honor-system on net_allow / proc_allow / cpu / memory

**Gap.** The design (`v2-design.md` §11.3) promises "per-runtime sandbox declaration … the substrate enforces." Today, only `--allow-read` / `--allow-write` and `wall_ms` are enforced by the bun runtime; `net_allow`, `proc_allow`, `cpu_ms`, `memory_mb` are honor-system on the bun side. uv runs honor-system without nsjail. Camofox's `browser_allow_domains` is declared but not enforced via playwright's request-router.

**Why it blocks production.** A brain that authors a network-exfiltrating action artifact succeeds at runtime. The substrate generates `sandbox_unenforced_warning` events but proceeds. An owner cannot trust a long-horizon directive that pulls in unknown third-party data sources.

**Fix path (LOC estimate):**
- Wrap bun spawns with a real netfilter/seccomp filter (e.g. via `firejail` opportunistic detection, like nsjail for uv). ~150 LOC in `runtime/runtimes/bun.ts` + new `cli/doctor.ts:checkFirejail`.
- Wire playwright's `page.route()` to enforce `browser_allow_domains` deny-by-default. ~80 LOC in `runtime/runtimes/camofox.ts`.
- Make nsjail a HARD requirement for uv (or fail-closed when absent). ~30 LOC change in `runtime/runtimes/uv.ts` plus `cli/doctor.ts:checkNsjail` upgraded to `fail`.

**Test that should lock the fix.** A new `runtime/sandbox.test.ts` test: a bun artifact declaring `net_allow=[]` attempts `fetch("https://example.com")` and must FAIL — the substrate must deny the call, NOT emit a warning and proceed.

---

### Top-2: No structured logging or metrics

**Gap.** The daemon prints `console.log` / `console.error`. There is no JSON-line log shape, no log level (`info`/`warn`/`error`), no log rotation, no Prometheus `/metrics`, no OpenTelemetry traces.

**Why it blocks production.** A `bun runtime/daemon.ts` invocation under systemd writes plain text to `journalctl`. Operators cannot:
- Query "how many `bridge_failed` events fired in the last hour" without opening SQLite.
- Aggregate latency percentiles across dispatch cycles.
- Wire to PagerDuty / Slack / on-call.

**Fix path.**
- Add `pino` (or `bunyan`) to `package.json:dependencies`. ~5 LOC.
- New `runtime/log.ts` (~80 LOC) — initialize logger, expose `log.info(...)` / `log.error(...)` / `log.warn(...)`.
- Replace ~30 `console.*` sites across runtime + cli with the logger. ~120 LOC churn.
- Add `prom-client` and a `/metrics` aux-port route. ~60 LOC new file + 20 LOC in `runtime/daemon.ts:routeAux`. Counters: events emitted per kind, dispatch latency histogram, sandbox warning count, embedder retries.

**Test.** A new `runtime/log.test.ts` asserts that every log call produces a JSON line with `{level, ts, msg, ...}`. Plus a daemon test that asserts `/metrics` returns a Prometheus exposition.

---

### Top-3: No HNSW; embedding retrieval is brute-force linear scan

**Gap.** `runtime/embedding_index.ts:9` documents the intentional choice: "ALWAYS do the brute-force pass and accept O(n·d) per query. A real HNSW only makes sense once measured query latency under the operational substrate volume warrants it." Design §5.1 promises HNSW.

**Why it blocks production at scale.** At ≤10k events this is fine (the documented threshold). Past that, retrieval latency dominates dispatch and the substrate's own design promise is broken.

**Fix path.**
- Wire `sqlite-vec` (already a dep — see §J) for kNN ANN over the embedding column. ~200 LOC in `runtime/embedding_index.ts`.
- Or pull `hnswlib-node` and persist the index alongside the WAL. ~150 LOC + cleanup at daemon boot.

**Test.** A perf regression test: build an index with 50k random vectors, assert nearest-K returns in <50ms.

---

### Top-4: Recipe replay is single-step only

**Gap.** `audit-report.md` E.4 marks this as deferred — informational. `runtime/recipe_replay.ts:replayRecipe` iterates ONCE over the trajectory. The `recipe_extracted` payload already carries the multi-step trajectory; the loop just stops after action 1.

**Why it blocks production.** Recipe coverage is one of the cutover criteria (`v2-design.md` §18 criterion 6: "≥30% of routine directives hit Tier-0 replay"). A single-step replay can only match the shortest trajectories. Anything that took ≥2 actions to solve historically must re-dispatch the full opencode chain.

**Fix path.**
- Sequence-aware `replayRecipe` that runs each `action_artifact_id` in order, feeding observation N into action N+1's inputs. ~120 LOC in `runtime/recipe_replay.ts`.
- Update `runtime/task_scheduler.ts:phaseJRecipeReplay` to call the new path (delete the stub).
- New `recipe_replay.test.ts` cases for 2-step and 3-step recipes.

**Test.** Recipe extracted from a 3-success seed of a 2-step directive must replay end-to-end with NO opencode call.

---

### Top-5: Admin token + external-push token never rotated

**Gap.** Tokens are minted once at daemon boot via `newAdminToken()` (`runtime/daemon.ts:157`) and written plaintext to `~/.accint/v2.sock.token` (mode 0o600). There is no rotate command, no rolling key, no expiry.

**Why it blocks production.** Leaked token = permanent access to the substrate (admin token grants `/shutdown`; external-push token grants writes to `external_event_received`). Industry standard: rotate every 30/90 days.

**Fix path.**
- New `cli/admin.ts` with `acc admin rotate-token --admin` and `--external-push`. ~80 LOC.
- Daemon-side hot reload of the token file (or a tiny `POST /admin/rotate` route). ~40 LOC.
- Existing tokens recorded in a SHORT history with overlap window so an in-flight `acc daemon stop` doesn't fail mid-rotation.

**Test.** Rotate the admin token; assert the old token returns 401 on `/shutdown` and the new token returns 200.

---

### Top-6: Father never self-suspends on repeated drift

**Gap.** `audit-report.md` E.5: "Father currently emits `father_drift_detected` on each offender but does not self-suspend. The reservation for the suspension event kind is `father_self_suspended` — not yet added to `EventKind`."

**Why it blocks production.** Father runs autonomously every 5 minutes. If it starts emitting forbidden events (anything outside `FATHER_ACTION_EVENT_KINDS`), the drift detector logs it but Father keeps running. An owner who has gone to sleep is not protected from a Father run amok.

**Fix path.**
- Add `father_self_suspended` to `EventKind` in `substrate/types.ts`.
- In `runtime/father.ts`, after N=3 consecutive `father_drift_detected` events for the same Father instance, emit `father_self_suspended` and refuse further iteration until an owner-driven `acc father resume`. ~50 LOC.
- `acc father resume` CLI subcommand in `cli/dispatch.ts`. ~25 LOC.

**Test.** Trigger 3 drift events in a row; assert Father emits `father_self_suspended` and subsequent `fatherIterate` calls return without action.

---

### Top-7: Five named views from §4.2 are never created

**Gap.** `directive_view`, `task_critical_path_view`, `active_inference_view`, `artifact_warning_view`, `model_routing_view`, plus the typed-extractor views `knowledge_view`, `entities_view`, `recipes_view`, `provenance_view`, `judgment_packet_view`. The brain reads them via `substrate.read("knowledge_view", …)` and gets `view_not_implemented:knowledge_view`.

**Why it blocks production.** `knowledge_view` and `judgment_packet_view` are LOAD-BEARING in §13.1 — the prompt composer's P1 RETRIEVED KNOWLEDGE section is sourced from them. Without them, the prompt is reaching into raw `knowledge_promoted` rows directly, losing the per-shape reranking that the design promises.

**Fix path.**
- `knowledge_view` — SQL view over `knowledge_promoted` joined with `origin_promotion_view`. ~30 LOC in `substrate/views.ts`.
- `judgment_packet_view` — TS-side view (it composes per-task-shape top-K) in `substrate/extractors.ts`. ~80 LOC.
- The remaining six — straightforward joins over existing events. ~150 LOC total.

**Test.** New `substrate/views.test.ts` cases for each new view.

---

### Top-8: `.env.example` is stale from v1

**Gap.** `acc2/.env.example` (the file referenced by `docs/operator-install.md:42` for "copy `.env.example` to `.env`") references TELEGRAM_BOT_TOKEN, PINATA_JWT, ADSPOWER_URL, ACC_OPERATOR, ACC_HARD_SILENCE_TIMEOUT_MS, ACC_BUDGET_WARN_THRESHOLD, ACC_REFLECT_TIMEOUT, and ACC_MAX_CONSECUTIVE_FAILURES. None of these are read by any acc2 source file.

**Why it blocks production.** Operators copy the example, see TELEGRAM/PINATA, and either (a) waste time installing services that aren't connected, or (b) lose trust in the rest of the doc. The acc2 design rejected all of these surfaces (`v2-design.md` §22).

**Fix path.** Rewrite `acc2/.env.example` to only document acc2-reachable env vars: OPENAI_API_KEY, ACC2_BRIDGE_MODE, ACC2_OPENCODE_MODEL, ACC2_OPENCODE_TIMEOUT_MS, ACC2_OPENCODE_MCP_HANDSHAKE_MS, ACC2_DISABLE_WORKERS (canonical opt-OUT, comma-separated worker names), ACC2_FATHER_INTERVAL_MS, V2_DAEMON_PORT, V2_DAEMON_AUX_PORT, V2_MCP_SERVER_URL, ACC2_STATE_DIR, ACC2_DB_PATH, ACC2_EXTERNAL_PUSH_TOKEN, CAMOUFOX_BINARY_PATH, CAMOUFOX_HEADLESS, CAMOUFOX_LOCALE, ACC2_SANDBOX_PROC_ALLOW, SERPER_API_KEY, ACC2_TEST_DB_PATH. ~60 LOC delete + ~30 LOC add.

**Test.** A new `cli/init.test.ts` case asserts that every env var in `.env.example` matches `^[A-Z][A-Z0-9_]*=` and is referenced by at least one source file (heuristic grep).

---

### Top-9: `runtime/bridge.ts` (1,235 LOC) + `runtime/mcp_server.ts` (1,465 LOC) are due for a module split

**Gap.** Two largest files in the codebase. `runtime/bridge.ts` mixes mock + real + config materialization + watchdog + JSON-line parsing. `runtime/mcp_server.ts` mixes 24 handler functions + tool registration + HTTP dispatch.

**Why it blocks production maintenance.** A new contributor reading `bridge.ts` end-to-end has to hold ~470 lines of `spawnRealOpencode` in their head. The mocked path is structurally separable from the real path; today they coexist in one module.

**Fix path.**
- `runtime/bridge.ts` → split:
  - `runtime/bridge_types.ts` (BridgeRequest/Result/Failure types) — ~50 LOC.
  - `runtime/bridge_mock.ts` (`opencodeQueryMock`, fixture bodies) — ~400 LOC.
  - `runtime/bridge_real.ts` (`spawnRealOpencode`, config materializer) — ~600 LOC.
  - `runtime/bridge.ts` (dispatch by `ACC2_BRIDGE_MODE`) — ~80 LOC.
- `runtime/mcp_server.ts` → split:
  - `runtime/mcp_handlers.ts` (all 24 `handle*` functions) — ~800 LOC.
  - `runtime/mcp_schemas.ts` (the Zod schemas) — ~250 LOC.
  - `runtime/mcp_server.ts` (`createMcpServer`, `handleMcpRequest`) — ~250 LOC.

**Test.** Existing tests should pass unchanged; the goal is refactor, not feature change.

---

### Top-10: No backup / export / restore CLI; promised in Batch 3

**Gap.** `docs/ops-guide.md:150`: "A full `acc admin export` flow with online snapshots ships in Batch 3." Today operators are instructed to `bun cli/dispatch.ts daemon stop` + `cp -a ~/.accint/state ~/accint-backup-...`.

**Why it blocks production.** Every backup requires daemon downtime. WAL snapshots are not atomic without daemon coordination. There's no point-in-time restore (no incremental backups). For a substrate where the SQLite file IS the accumulated organism state, this is critical.

**Fix path.**
- New `cli/admin.ts` (also covers Top-5 token rotation) — `acc admin export <path>` runs `VACUUM INTO` against the live db (atomic, no daemon stop). ~60 LOC.
- `acc admin restore <path>` (offline) — refuses if the daemon is running; copies the file into place; restarts. ~40 LOC.
- Daemon-side `POST /admin/snapshot` route gated by admin token. ~30 LOC in `runtime/daemon.ts`.
- Document in `docs/ops-guide.md` §6.

**Test.** Export the live db, drop the original, restore, assert event count + event ids match.

---

## Recommendations summary

| Area | Next phase that should run | Notes |
|------|---------------------------|-------|
| **substrate** | Phase L typed-extractor views (`knowledge_view`, `judgment_packet_view`, etc.) — closes Top-7 | Also delete or replace the three stub seed code artifacts (Top-D). |
| **runtime — sandbox** | Phase G+ "real sandbox" milestone — closes Top-1 | Promote nsjail from "info" to "fail" in doctor when production-mode; wire firejail (or seccomp) for bun. |
| **runtime — bridge / dispatcher** | Phase E follow-up to wire the inline lane EXECUTION (not just retrieval — see `claude_inline_phase_e_stub`). | Same phase split `bridge.ts` per Top-9. |
| **runtime — recipe replay** | Phase J multi-step — closes Top-4 | Required for §18 cutover criterion 6. |
| **runtime — observability** | New phase "Ops Foundation" — closes Top-2 | pino + prom-client + `/metrics` route + `/ready` route. **Highest leverage** unblocked work. |
| **runtime — Father** | post-K maintenance — closes Top-6 | Add `father_self_suspended` event kind; add `acc father resume` command. |
| **runtime — embeddings** | post-Phase F perf milestone — closes Top-3 | Wire `sqlite-vec` (already a dep) or `hnswlib-node`. |
| **cli — admin / backup** | Batch 3 — closes Top-5 + Top-10 | `cli/admin.ts` covers both token rotation and export/restore. |
| **tests** | Direct tests for `event_bus.ts`, `cli/rpc.ts` failure modes; un-skip uv + camofox tests on CI machines that have the binaries. | Maintenance. |
| **docs** | `docs/quickstart.md`, `docs/architecture.md`, `docs/security.md`, `docs/runbook.md`. Update `.env.example` (Top-8). Document daemon-restart-kills-in-flight-bridges. | Several small files. |
| **env** | Pin `fastmcp` to `~4.0.1` (caret risk on MCP transport). Add `playwright` to `dependencies` (or `optionalDependencies`). Either remove unused `sqlite-vec` or wire it. Add `pino` + `prom-client`. | Small package.json edits. |

---

## Anything surprising

A short list of things I expected to find one way and found the other:

1. **`sqlite-vec` is a declared dependency but completely unused.** The package and its linux-x64 binary live under `node_modules/`; not a single source file imports it. The brute-force linear scan in `runtime/embedding_index.ts` was explicitly chosen over HNSW (per the file's own header comment) but the SQL-side vector extension that the dep ships was also rejected and never deleted. **Dead production dep.**

2. **`playwright` is imported by `runtime/runtimes/camofox.ts` but missing from `package.json`.** The camofox runtime gates on `isPlaywrightInstalled()` (existence-check on `node_modules/playwright/package.json`) and refuses cleanly when absent. But the operator-install path expects the operator to run `bun add playwright` manually. This is missing from `docs/operator-install.md`'s step list (only mentions camoufox binary). The single line in `docs/ops-guide.md` mentions it parenthetically.

3. **Three seed code artifacts have stub strings for bodies** (`substrate/seed.ts:273,292,310`). They are admitted at install time. If the brain picks them, the bun runtime will execute the comment-only file and the verifier will produce a high residual. This is a working-but-misleading behaviour — better to either delete the seeds (let the brain author them) or write real bodies.

4. **The "inline lane" is wired READ-side but not WRITE-side.** Phase Audit (A.3.6-R1, A.3.6-R2) wired `low_risk_inline_patterns_view`, the matching logic in `dispatch_decider.ts`, and `recordLowRiskInlineOutcome` for credit. But the dispatcher itself, when matched, records `claude_inline_phase_e_stub` instead of doing the inline run (`runtime/task_dispatcher.ts:239`). The path is half-built: retrieval lights up correctly, execution is a stub.

5. **`projection_checkpointed` is declared in `EventKind` but never emitted.** Design §4.4 names it as the consistency-checkpoint mechanism. The grep shows zero emit sites — the kind exists in the type-union only. Same shape for `self_modification_recorded`, `runtime_subprocess_resource_warning`, `runtime_subprocess_orphaned`. Four declared-but-dead event kinds.

6. **Comments and reality have diverged in `prompt_composer.ts`.** Multiple comments say "P2/P3 sections are stubs in Phase D (no upstream-task or stakeholder data …)" but the actual code now invokes the real `watch_edges.ts` walk and `stakeholder_state_view`. The Phase E + I wiring landed without comment cleanup.

7. **The daemon is single-instance per host (lock file at `~/.accint/v2.sock`)**, but this is not surfaced in any operator doc as a hard constraint. Two owners on one machine cannot run `acc daemon start` in parallel. `ops-guide.md` does not mention this; `operator-install.md` does not mention this.

8. **`acc doctor` reports nsjail as `info`** ("not installed — uv sandbox is honor-system without nsjail (runs still work)"). The "runs still work" framing understates the security gap. In production-readiness mode this should be `warn`; for a security-sensitive deploy, `fail`.

9. **`runtime/bridge.ts:207` emits `phase_e_real_bridge_not_wired`** as the failure reason when the mock bridge sees an unrecognised prompt. This is a misleading failure-reason string in a world where Phase E IS wired — the real reason is "mock bridge only knows two fixture prompts." Rename to `mock_bridge_unrecognised_prompt`.

10. **The mock bridge can only handle two fixture prompts.** `FIXTURE_D_MARKER` and `EXAMPLE_COM_MARKER`. Any other directive routed through `ACC2_BRIDGE_MODE=mock` returns `auth_missing`. The mock was never expanded as new fixtures landed. Tests workaround this with explicit mode-real spawnFn injection. **info** — by design, but worth knowing.

— end of report.

---

## Resolutions

### Top-3 + dead-dep `sqlite-vec` — resolved (2026-05-13)

**Blocker #3 ("Embedder + retrieval index has no HNSW … brute-force linear cosine")** and the dead-dep finding (`sqlite-vec` was installed but never imported) both close with one cutover. We did NOT add HNSW; we wired the already-installed `sqlite-vec` extension as the canonical embedding index, which is the better answer for the substrate shape:

- `substrate/db.ts` loads the extension at every `openDb()` (failure throws — no silent degradation).
- `substrate/schema.sql` declares a `vec_events` vec0 virtual table with `float[1536]` embedding column plus filterable metadata columns (`kind`, `ts`, `embedding_version`).
- `runtime/embedder.ts:upsertVecEventRow` upserts the vec0 row alongside the legacy BLOB column update (the BLOB column stays for one cutover window, then drops in a follow-up phase).
- `runtime/embedding_index.ts` is now a thin wrapper: its `knn` for production-dim (1536) embeddings is a single SQL query against `vec_events`; the daemon no longer materialises every Float32Array in JS memory at boot. (A small JS-fallback path remains for tests that seed non-1536-dim vectors — `vec_events` rejects those by schema, so the wrapper stashes them inline. Production callers always emit 1536-dim through OpenAI.)
- `runtime/daemon.ts`'s `daemon_index_rebuilt` payload now carries `{ mode: "sqlite_vec_backed", vec_count }` so log consumers can identify the new path.
- New hermetic smoke at `runtime/sqlite_vec.test.ts` proves extension load, KNN ordering, metadata-WHERE filters, and the dim-mismatch contract the wrapper's fallback relies on.

At pilot scale (20 events, 1536-dim) the SQL KNN path measures ~0.6 ms per query. The 300 MB Float32Array footprint that would have appeared at 50k embedded events no longer exists. Hybrid queries (vector match + SQL filter) compose in one statement, matching the §3.6.1 Rule-1 dedup shape directly.

Two related findings remain explicitly open, intentionally:
- The `events.embedding` BLOB column stays for one cutover window so we can compare new-vs-old retrieval on regressions; a follow-up phase drops it.
- The audit's text at §"Top-3" and "Unused production dep" describes the pre-resolution state and is preserved unchanged for traceability.

### Batch 3.CLEANUP — audit minors close-out (2026-05-14)

This batch closes the audit's small-but-correct items that were trivially fixable without changing canonical behaviour. Each finding maps to one or more concrete edits below; the commit hash is appended after the batch lands.

| Audit finding | Resolution | File(s) touched |
|---|---|---|
| `.env.example` is stale (carries v1 TELEGRAM, PINATA, AdsPower keys) | Rewrote to v2-shaped content only: `OPENAI_API_KEY`, `ACC2_BRIDGE_MODE`, daemon ports, opencode flags, Camoufox path, background-worker toggles, external-push token, log level. No v1 vars survive. | `.env.example` |
| `playwright` referenced by camofox runtime but not declared in `package.json` | Pinned `playwright ^1.50.0` under `dependencies`. `bun install` resolves it cleanly. Operator-install.md already documented the install path (§5.1); `ops-guide.md`'s dependency table now lists playwright explicitly. | `package.json`, `docs/ops-guide.md` |
| Three seed code artifacts have stub-string bodies (`substrate_embed`, `substrate_search`, `agent_invoke` at `substrate/seed.ts:273,292,310`) | `substrate_embed` got a real OpenAI `text-embedding-3-small` fetch body (matching the `web_search` honest-degrade shape: returns `ok:false, error:'openai_api_key_missing'` when key is absent). `substrate_search` and `agent_invoke` were removed — they overlap with v2's MCP tool surface (`substrate.search`) and v2's opencode-only dispatch model respectively, so admitting them as seeds was an anti-pattern. New test asserts no admitted seed body contains `"stub Phase B+"` or `"will be authored per LATM"`. | `substrate/seed.ts`, `substrate/seed.test.ts` |
| `self_modification_recorded` event kind declared but never emitted | Wired emission from `runtime/task_dispatcher.ts` immediately after `task_committed`: when the action artifact's observation declares a `modified_paths` array AND any path falls under the acc2 codebase root (`/system/acc2/`, `acc2/`, or `system/acc2/`), emit `self_modification_recorded` citing the action artifact + filtered path list. The heuristic is opt-in (artifacts declare what they touched) — silent file mutations do not trigger. | `runtime/task_dispatcher.ts` |
| Misleading bridge failure name `phase_e_real_bridge_not_wired` (Phase E IS wired) | Renamed to `mock_bridge_prompt_unrecognized` with the supported-marker list surfaced on the typed `BridgeFailureReason` AND in the substrate `bridge_failed` payload. Operators now see `supported_markers: [FIXTURE_D_MARKER, EXAMPLE_COM_MARKER]` in the failure row instead of an inaccurate phase reference. | `runtime/bridge.ts`, `runtime/bridge.test.ts` |
| Mock bridge handles generic prompts gracefully | Same change as above — instead of returning `auth_missing` (the prior misleading bucket), the mock now returns `{ ok: false, reason: { kind: "mock_bridge_prompt_unrecognized", supported_markers } }` with a `hint` payload pointing operators at `ACC2_BRIDGE_MODE=real`. | `runtime/bridge.ts`, `runtime/bridge.test.ts` |
| Stale "Phase D stub" comments in `runtime/prompt_composer.ts` | Updated the `readKnowledgeTopK` doc-comment to reflect the recency-fallback semantics (the recency path is the fallback, not a stub — the canonical embedding × posterior reranker runs when `opts.retrievedKnowledge` is supplied). Updated the P2/P3 section block to acknowledge that watch_edges + stakeholder/interference compositors are wired (Phase E + I) — only the `upstream_outputs` slot remains a stand-in. | `runtime/prompt_composer.ts` |
| Daemon single-instance per host not documented | Added §4d "Single-instance per host" to `docs/ops-guide.md` explaining the port-lock + `~/.accint/v2.sock` semantics and giving the canonical recipe for running two isolated environments (distinct `ACC2_STATE_DIR` + `ACC2_DAEMON_PORT` + `ACC2_DAEMON_AUX_PORT` per daemon). | `docs/ops-guide.md` |
| `nsjail` doctor check verdict `info` masks the warning | Bumped to `warn` so the overall doctor verdict surfaces the gap. Detail now reads "uv sandbox degrades to honor-system (runs still work, but net/proc/fs restrictions are advisory)". | `cli/doctor.ts`, `cli/doctor.test.ts` |

These items were "minor" in the audit; closing them removes paper-cuts without touching the architecturally significant parts of the substrate. Tests: full suite re-runs green after the batch.

### Batch 3.OPS — daemon ops hardening (2026-05-14)

This batch closes the audit's **blocker #2** ("No structured logging or metrics surface") and the cluster of operator-facing gaps that depend on it: crash recovery, DB integrity, readiness probe, and three declared-but-never-emitted event kinds.

| Audit finding | Resolution | File(s) touched |
|---|---|---|
| **Top-2 / blocker #2**: No structured logging — `console.log`/`console.error` only, no level, no JSON shape, no log rotation hook. | New `runtime/logger.ts` wraps `pino` (added to `dependencies`). Exposes a canonical `logger` plus `withContext({ correlation_id, dispatch_id, task_id, … })` for child loggers. Level resolves from `ACC2_LOG_LEVEL` → `NODE_ENV` (test → silent, production → info, else → debug). Optional file output via `ACC2_LOG_FILE=1` → `~/.accint/logs/daemon.jsonl` (rotation external, per `ops-guide.md`). Production hot paths in `daemon.ts` and `embedder.ts` now log structured JSON; the entrypoint `console.log/error` and `embedder.ts:persistEmbedding` `console.warn` are replaced. Test file `runtime/logger.test.ts` covers level resolution + child-context bindings. | `runtime/logger.ts`, `runtime/logger.test.ts`, `runtime/daemon.ts`, `runtime/embedder.ts`, `package.json` |
| **Top-2 / blocker #2**: No metrics surface — no Prometheus `/metrics`, no histogram surface, no operator-aggregable signals. | New `runtime/metrics.ts` wraps `prom-client` (added to `dependencies`). Exports counters (`acc2_dispatches_total{route,outcome}`, `acc2_artifact_invocations_total{runtime,outcome}`, `acc2_embeddings_computed_total`, `acc2_events_emitted_total{kind}`, `acc2_external_pushes_total{source}`), histograms (`acc2_dispatch_duration_seconds{route}`, `acc2_action_residual{runtime}`, `acc2_artifact_durations_seconds{runtime}`, `acc2_embedding_duration_seconds`), and gauges (`acc2_daemon_uptime_seconds`, `acc2_substrate_events_total`, `acc2_code_artifacts_admitted/promoted/quarantined_total`). Typed recording helpers (`recordDispatch`, `recordArtifactInvocation`, `recordEmbedding`, `recordEventEmission`, `recordExternalPush`, `recordActionResidual`) are the only public mutation surface; `refreshGauges(db, startedAtMs)` snapshots SQLite-backed gauges every 30s. Default Node metrics (event-loop lag, GC, heap) come along via `collectDefaultMetrics`. Daemon aux Bun.serve handles `GET /metrics` with `Content-Type: text/plain; version=0.0.4`. Wiring sites: `runtime/events.ts:emitEvent` → `recordEventEmission`; `runtime/task_dispatcher.ts:dispatchReadyTask` → `recordDispatch` + `recordActionResidual` at close; `runtime/embedder.ts:embedderWorkerTick` → `recordEmbedding`; `runtime/external_ingress.ts:handleExternalPush` → `recordExternalPush`. New test `runtime/metrics.test.ts` covers counter/histogram increments, /metrics format compliance, and gauge refresh round-trip. | `runtime/metrics.ts`, `runtime/metrics.test.ts`, `runtime/events.ts`, `runtime/task_dispatcher.ts`, `runtime/embedder.ts`, `runtime/external_ingress.ts`, `runtime/daemon.ts`, `package.json` |
| **Top-2 follow-on**: No readiness probe distinct from liveness. | New `runtime/readiness.ts` tracks `registerWorker(name)` → `markWorkerReady(name)` transitions for every enabled background worker (amendment, gauge_refresh, integrity, plus opt-in embedder, rehabilitation, rolling_reviewer, father, scheduler). New `GET /ready` route returns 200 with `{ status:"ready", ready_at_ms, startup_duration_ms }` once ALL registered workers complete their first tick, otherwise 503 with `{ status:"not_ready", pending_workers }`. The transition fires `daemon_ready` (new event kind) exactly once. At pilot scale `/ready` flips ~3-8 ms after boot. Test coverage in `runtime/daemon.test.ts` proves the 200/503 transition + the single-emit `daemon_ready` guarantee. | `runtime/readiness.ts`, `runtime/daemon.ts`, `runtime/daemon.test.ts`, `substrate/types.ts` |
| **DB integrity blind spot**: `cli/doctor.ts` referenced `PRAGMA integrity_check` but the daemon itself never ran it. WAL hygiene also implicit. | New `runtime/integrity_worker.ts` ships three exports: `runIntegrityCheck(db)` returns `{ ok, pragma_integrity_check, wal_size_bytes, events_count, embeddings_count, duration_ms }`; `integrityWorkerTick(db)` runs the check, emits `integrity_check_completed` (healthy) or `integrity_check_failed` (with error text + `marker:"integrity_check_failed_v1"`), and conditionally truncates the WAL via `PRAGMA wal_checkpoint(TRUNCATE)` when WAL > 100 MB (emitting `wal_checkpointed` on success); `reconcileOrphanedDispatches(db)` finds `brain_dispatched` rows whose tasks did not close in the previous boot (no matching `brain_dispatch_closed`/`dispatcher_violation`/`task_failed`) and emits `dispatch_recovered_orphan` for each. Daemon now runs `runIntegrityCheck` BEFORE accepting traffic — non-`ok` result writes a stderr diagnostic and throws. The integrity worker tick runs every 6h by default (configurable via `ACC2_INTEGRITY_INTERVAL_MS`; disable via `ACC2_DISABLE_WORKERS=integrity` for tests). The daemon does NOT auto-restart on integrity failure — the operator decides. | `runtime/integrity_worker.ts`, `runtime/integrity_worker.test.ts`, `runtime/daemon.ts`, `substrate/types.ts` |
| **Crash recovery story untested end-to-end**. | New `tests/integration/crash_recovery.ts` (executable smoke matching `harness.ts` / `real_brain_smoke.ts` shape) covers: (1) `clean_shutdown_round_trip` — stop, restart, events count matches, no orphan rows; (2) `sigkill_mid_dispatch_orphan_recovery` — seed an unclosed `brain_dispatched`, restart, assert `dispatch_recovered_orphan`; (3) `wal_replay_after_kill` — spawn a separate daemon process, seed 1000 events, SIGKILL it, restart on the same db, assert WAL replays losslessly; (4) `corrupt_db_refuses_to_start` — corrupt page data in the db file, assert `startDaemon` throws with integrity-check error. All four scenarios pass in ~0.6s. | `tests/integration/crash_recovery.ts` |
| **Three declared-but-never-emitted event kinds** flagged in the audit. | `daemon_ready`, `integrity_check_completed`, `integrity_check_failed`, `wal_checkpointed`, and `dispatch_recovered_orphan` added to `EventKind` under "Daemon lifecycle" and "Daemon ops" comment groups. Each kind now has at least one canonical emit site: `daemon_ready` from `runtime/daemon.ts:setOnReady`; `integrity_check_completed/_failed` and `wal_checkpointed` from `runtime/integrity_worker.ts`; `dispatch_recovered_orphan` from `reconcileOrphanedDispatches`. | `substrate/types.ts`, `runtime/daemon.ts`, `runtime/integrity_worker.ts` |

Tests: 512 → 570 pass (+58 new across `runtime/logger.test.ts`, `runtime/metrics.test.ts`, `runtime/integrity_worker.test.ts`, and 4 new `runtime/daemon.test.ts` cases). The 4-scenario `tests/integration/crash_recovery.ts` smoke passes in ~0.6s. `/metrics` exposes the canonical `acc2_*` counters/histograms/gauges alongside prom-client's default Node metrics; `/ready` flips < 10 ms after boot on the pilot substrate. The `projection_checkpointed` case (the fourth declared-but-dead kind in the audit) stays open: its canonical emit site lives in the typed-extractor views (Phase L), not the daemon ops layer. Batch 3.CLEANUP closes `self_modification_recorded` separately.
