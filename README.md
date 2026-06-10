> ⚠️ **Outdated early experiment — not the current architecture.**
> This is an old prototype, kept for history. The current work is **acc4** — a
> Recursive Language Model over a late-interaction scored-token memory:
> **[github.com/maxbaluev/accreted-intelligence](https://github.com/maxbaluev/accreted-intelligence)**

---

# AccInt v2

A universal **Recursive Language Model** whose recursive memory, synthesis operator, and code-runtime broker all live in a persistent substrate daemon. The owner speaks naturally; Claude Code (you) routes; opencode (gpt-5.5) reasons; the substrate compounds.

**Canonical design:** [`docs/Architecture.md`](docs/Architecture.md) (1,940+ lines, ground truth).

## How it works

```
Owner (Claude Code chat)
        │ "your first goal"
        ▼
┌─────────────────────────────────────────────────────────────┐
│ acc task → substrate (always-on daemon)                     │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │  events ledger (SQLite, one table)                      │ │
│ │  • directive_opened → task_node_opened → brain_*        │ │
│ │  • action_predicted → artifact_invoked/observed/scored  │ │
│ │  • task_committed | task_edge_recorded(refines)         │ │
│ └─────────────────────────────────────────────────────────┘ │
│  dispatch_decider → recipe_replay | inline lane | opencode  │
│  three runtimes: bun.ts | uv.ts | camofox.ts                │
│  cycle-1-only gate; refinement edges replace iteration      │
└─────────────────────────────────────────────────────────────┘
        │ MCP (substrate.* + runtime.* tools)
        ▼
   opencode run (gpt-5.5 brain) — one cycle per dispatch
```

Owner words → directive event → dispatch route → brain emits action + verifier artifacts → runtimes execute under sandbox → verifier returns scalar residual → credit propagates → next cycle's retrieval reflects the outcome. Knowledge candidates from both LLM substrates merge through embedding-based dedup + contradiction holding (Model D).

## Install — composite first-run path

The canonical six-step sequence. Each command is idempotent — re-running
is always safe. `acc doctor` reporting **PASS** is the canonical
"system is ready" signal.

```bash
cd /home/maxbaluev/bos2/system/acc2
bun install                          # installs npm deps
acc admin install-deps               # canonical host dependency installer/checker
acc init --yes                       # state dir, admin token, knowledge + artifact seeds
acc doctor                           # composite readiness — must be PASS
acc daemon start                     # all workers ON by default
acc task "your first goal"           # the loop begins
acc watch                            # live TUI in another terminal
```

What you get when the loop is ready:

- `acc admin install-deps` verifies bun ≥ 1.3.14, opencode on PATH,
  OPENAI_API_KEY, camoufox binary, nsjail (warn-only). Emits a structured
  `dep_check_complete {passes,fails,warns}` line; exit 0 iff every
  must-have passes.
- `acc init --yes` seeds the foundational knowledge laws AND the canonical
  `seed_*` code-artifact pairs. Both surfaces are non-empty post-init.
- `acc doctor` checks file existence AND state-content correctness:
  knowledge_promoted ≥ 5, act_artifact seed rows ≥ 5, sqlite-vec
  extension loads. A FAIL on any of those flips the composite verdict.

For per-component manual install paths, see
[`docs/operator-install.md`](docs/operator-install.md).

## What works today

- [x] Directives via natural language (`acc task "<words>"`).
- [x] Persistent daemon with `/health`, `/shutdown` (auth-gated), `/external/push` (token-gated).
- [x] Three runtimes: `bun` (TS/JS), `uv` (Python under nsjail when present), `camofox-browser` (Camoufox via Playwright).
- [x] Real-brain dispatch via opencode CLI (gpt-5-mini default; pass `--model=<id>` to override).
- [x] Cycle-1-only structural enforcement + refinement edges in the task DAG.
- [x] Recipe replay (tier-0 cost compression — high-confidence recipes skip the brain).
- [x] OwnerAutonomy scheduler (brainless recurring task driver — `runtime/owner_autonomy.ts`).
- [x] sqlite-vec retrieval backend (k-NN via the `vec_events` virtual table; `ACC2_USE_VEC=1`).
- [x] Production observability: structured logging (`runtime/logger.ts`, pino), Prometheus metrics (`runtime/metrics.ts`), readiness probes (`runtime/readiness.ts`).
- [x] Admin surface: `acc admin update-opencode`, `acc admin opencode-version`, `acc admin upgrade-check`, export/import/rotate.
- [x] Canonical Camoufox setup via `acc admin install-deps` (with `CAMOUFOX_BINARY_PATH` as an explicit override).
- [x] Integration harness: 9 plumbing scenarios + 1 real-brain scenario, exit-coded for CI.

**Test status.** 570 unit tests passing across 56 test files (`bun test`). Integration harness: 10/10 scenarios green when `OPENAI_API_KEY` + `opencode` are present (9/10 + 1 skip otherwise). Real-brain smoke (`tests/integration/real_brain_smoke.ts`) confirms the loop end-to-end against live opencode.

## Commands

| Command | Purpose |
|---|---|
| `acc admin install-deps` | Verify + install host prereqs (bun ≥ 1.3.14, opencode, OPENAI_API_KEY, camoufox, nsjail). Single-command bootstrap. Run before `acc init`. |
| `acc init [--yes]` | Fresh-install bootstrap. Mints admin token, seeds foundational knowledge AND canonical code artifacts. |
| `acc task "<words>"` | Open a directive; substrate dispatches the brain. |
| `acc daemon {start\|stop\|status\|install-service}` | Daemon lifecycle. |
| `acc watch` | Live TUI subscribed to the daemon's event stream. |
| `acc doctor` | Composite readiness — file existence AND state content (seed knowledge, seed artifacts, sqlite-vec). PASS is the canonical "ready" signal. |
| `acc version [--json]` | Print the installed acc2 semver + (when a daemon is running) its loaded `git_head`. Canonical post-update check — see [`UPDATING.md`](UPDATING.md). |
| `acc admin update-opencode [--yes]` | Upgrade the opencode subscription CLI in place. |
| `acc admin opencode-version` | Print installed + latest opencode versions. |
| `acc admin upgrade-check` | Multi-subsystem upgrade report (opencode, bun, uv, camoufox). |
| `bun tests/integration/harness.ts [--include-real\|--real-only]` | End-to-end integration harness (9 plumbing scenarios by default; real-brain opt-in). |
| `bun tests/integration/real_brain_smoke.ts [--mock-bridge]` | Standalone real-brain smoke (Batch 2.α). |
| `bun test` | Unit suite (570+ tests). |

## Architecture

- **Canonical design:** [`docs/Architecture.md`](docs/Architecture.md) — the architectural ground truth.
- **Operator install:** [`docs/operator-install.md`](docs/operator-install.md) — first-install walkthrough.
- **Ops guide:** [`docs/ops-guide.md`](docs/ops-guide.md) — running, updating, backing up, troubleshooting.
- **Real-brain runbook:** [`docs/real-brain-runbook.md`](docs/real-brain-runbook.md) — diagnosing real-bridge failures.
- **Production-readiness audit:** [`docs/production-readiness.md`](docs/production-readiness.md) — honest assessment of what is production-grade and what is maturing.
- **Operator contract:** [`CLAUDE.md`](CLAUDE.md) — the Claude Code operating contract.

## Layout

```
acc2/
├── substrate/            schema, types, extractors, views, seed, db
├── runtime/              daemon, three runtimes, sandbox, artifact_store, embedder, retrieval, dispatch decider, bridge,
│   │                     cycle_one_gate, credit, owner_autonomy, recipe_replay, prompt_composer, integrity_worker, metrics, ...
│   └── runtimes/         bun.ts, uv.ts, camofox.ts
├── cli/                  thin RPC clients to the daemon (init, dispatch, doctor, watch, admin, service-install, rpc)
├── tests/                unit tests + harness-smoke + real-brain-smoke-shape
│   └── integration/      harness.ts, scenarios.ts (10 scenarios), real_brain_smoke.ts, crash_recovery.ts
├── docs/                 Architecture.md (canonical), whitepaper.md, ops-guide.md, real-brain-runbook.md, production-readiness.md
├── scripts/              postinstall.ts (thin install-deps wrapper)
└── bunfig.toml           pins ACC2_BRIDGE_MODE=mock for `bun test`
```

## Environment

`acc2/.env` (copy from `.env.example`) holds:

- `OPENAI_API_KEY` — required for `text-embedding-3-small` retrieval. The one external API key v2 needs.
- `ACC2_BRIDGE_MODE=real` — production default. Tests pin `mock` via the `bunfig.toml` preload.
- `ACC2_OPENCODE_TIMEOUT_MS`, `ACC2_OPENCODE_MCP_HANDSHAKE_MS`, `ACC2_OPENCODE_MODEL` — opencode subprocess tuning.
- `ACC2_DAEMON_PORT`, `ACC2_DAEMON_AUX_PORT` — pinned ports (auto-pick when unset).
- `CAMOUFOX_BINARY_PATH` — override the auto-detected Camoufox binary.
- Worker autostart opt-OUT (all six workers default ON): `ACC2_DISABLE_WORKERS=embedder,owner_autonomy,...` — single comma-separated env var. Canonical names: `embedder`, `scheduler`, `owner_autonomy`, `rolling_reviewer`, `rehabilitation`, `integrity`. Tests pin five off via `tests/preload.ts` (integrity stays on for `/ready`).

Claude Code and opencode authenticate via their subscription CLIs — no API keys needed for the LLM substrates themselves.

## Project status

acc2 is a substrate-recursive operator system that compiles, boots, dispatches to a live LLM brain, and round-trips real directives end-to-end. The plumbing (daemon, runtimes, dispatch routes, refinement edges, credit, retrieval, sandbox, MCP wire) is well-tested. Production hardening (logging, metrics, readiness probes, admin surface, opencode upgrade path) has landed.

What is still maturing — and what an operator should know before promoting a build:

- The mock bridge recognizes two fixture markers (`fixture_d_count_todos` + `example.com`). Any other prompt under `ACC2_BRIDGE_MODE=mock` returns `mock_bridge_prompt_unrecognized` by design.
- Real-bridge cold-boot can take 60–180s on first dispatch (model warm-up + reasoning + tool calls). Widen `ACC2_OPENCODE_TIMEOUT_MS` for slow reasoners.
- See [`docs/production-readiness.md`](docs/production-readiness.md) for the full audit and known gaps.
