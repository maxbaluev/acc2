# AccInt v2 — Operator Deployment Guide

This guide covers installing, running, updating, backing up, and troubleshooting an AccInt v2 install on a single host (Linux or macOS). For the architectural ground truth see [v2-design.md](v2-design.md); for the operator contract see `../CLAUDE.md`.

> v2 is greenfield. There is no migration path from v1. v1's substrate lives read-only at `../state/accint.db` and is not consulted.

---

## 1. Prerequisites

AccInt v2 is bound by [v2-design.md §1](v2-design.md) to **subscription CLIs only** with one exception: `OPENAI_API_KEY` for `text-embedding-3-small`. Concretely, you need:

| Component | Required? | Purpose | Install |
|---|---|---|---|
| **Bun** ≥ 1.0 | Yes | Runtime for the daemon, CLI, and `bun` substrate runtime. | <https://bun.sh/docs/installation> — `curl -fsSL https://bun.sh/install \| bash` |
| **opencode** | Yes for `ACC2_BRIDGE_MODE=real` | Subscription CLI for GPT-5.5 brain dispatches. | <https://github.com/sst/opencode> — authenticate per their README. |
| **Claude Code** | Yes (you are reading this from inside it) | Subscription CLI for orchestrator + inline mechanical work. | <https://docs.claude.com/en/docs/claude-code> |
| **uv** (Astral) | Optional | Required for the `uv` runtime (Python code artifacts). Without uv, `bun` and `camofox-browser` runtimes still work. | <https://github.com/astral-sh/uv> — `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| **playwright** | Optional | JS driver for the `camofox-browser` runtime (declared in `package.json`'s `dependencies` and installed by `bun install`). Without playwright, camofox-browser artifacts fail with `camofox_runtime_unavailable`; non-browser directives still work. | Installed automatically by `bun install`; pinned to `^1.50.0`. |
| **camoufox** | Optional | Required for the `camofox-browser` runtime (browser-touching code artifacts). Camoufox brings its own firefox build — you do NOT need `bunx playwright install firefox`. | `pip install camoufox && python -m camoufox fetch` (writes `~/.cache/camoufox/camoufox`) OR download from <https://github.com/daijro/camoufox/releases> + set `CAMOUFOX_BINARY_PATH`. |
| **nsjail** | Optional | Hardens the `uv` runtime sandbox. Without it, uv runs honor-system on a temp dir. | <https://github.com/google/nsjail> — `apt install nsjail` on Debian/Ubuntu. |
| **OpenAI API key** | Optional (recommended) | Embeddings via `text-embedding-3-small`. Without it, knowledge embeddings silently no-op, which degrades retrieval relevance. | <https://platform.openai.com/api-keys> |

`acc doctor` (§3 below) will tell you exactly which of these you have and which you are missing.

---

## 2. Install AccInt v2

```bash
git clone <repo> bos2
cd bos2/system/acc2
bun install
```

That is all the dependency installation v2 needs. Everything else is operator config + the always-on daemon.

---

## 3. First run — `acc init --interactive` + `acc doctor`

Run `acc init --interactive` from Claude Code's guided onboarding flow.
It detects host dependencies, validates and persists `OPENAI_API_KEY`
(used ONLY for embeddings — brain auth is separate, via opencode + your
OpenAI Max subscription), offers `SERPER_API_KEY` as highly recommended
for information search, seeds the substrate, embeds seed events, starts
or verifies the daemon, and then runs `acc doctor`. Manual `.env`
editing is the fallback, not the primary path.

For scripted / CI setup, the manual flow is still available:

```bash
cp .env.example .env
# Edit .env to add OPENAI_API_KEY if you have one.
# ACC2_BRIDGE_MODE defaults to `real` (production dispatch via opencode); leave
# it unset / `real` for normal operation. Tests pin `mock` via bunfig.toml →
# tests/preload.ts — do NOT set ACC2_BRIDGE_MODE=mock in .env unless you
# intentionally want non-test paths to route through the canned fixture mock.
```

Then run the diagnostic:

```bash
bun cli/doctor.ts
```

`acc doctor` is the canonical "is this install ready?" command. It checks:

| Check | What it verifies |
|---|---|
| `daemon health` | The daemon process is running and `/health` returns `status: "ok"`. |
| `db integrity` | `events_count` is reachable through `/health` (the daemon runs `PRAGMA integrity_check` at boot — if the file were corrupt it would refuse to start). |
| `disk space` | The state dir has ≥ 2GB free (warn) / ≥ 500MB free (fail). |
| `OPENAI_API_KEY` | Present and non-empty. Used ONLY for embeddings (`text-embedding-3-small`); brain auth is separate (via opencode + OpenAI Max subscription). |
| `SERPER_API_KEY` | Present and non-empty (warn-only — highly recommended for information-search directives but tasks degrade gracefully without it). |
| `opencode` | The `opencode` binary is on `PATH`. |
| `uv` | The `uv` binary is on `PATH`. |
| `camoufox binary` | `CAMOUFOX_BINARY_PATH` is set OR `~/.cache/camoufox/camoufox` exists. |
| `nsjail` | The `nsjail` binary is on `PATH` (info only — uv sandbox is honor-system without it). |
| `bun` | Bun ≥ 1.0 on `PATH`. |
| `ACC2_BRIDGE_MODE` | `real` is the production default (no override needed); tests pin `mock` via `bunfig.toml` → `tests/preload.ts`. |
| **Composite readiness** | A single PASS/FAIL line summarising whether the install can dispatch to the real brain. The composite passes when daemon ok + `OPENAI_API_KEY` ok + `opencode` ok + `ACC2_BRIDGE_MODE=real`. |

Exit code is `0` if every check is `ok`/`warn`/`info`, `1` if any check is `fail` or the composite is `FAIL`.

---

## 4. Running the daemon

The daemon is the always-on substrate (v2-design.md §5). All CLI surfaces talk to it through MCP + an auxiliary HTTP port. The daemon must be running for `acc task`, `acc state *`, retrieval, embeddings, and external-push to work.

### 4a. Manual (foreground / detached shell)

```bash
# Foreground (Ctrl-C to stop):
bun runtime/daemon.ts

# Detached (survives the shell session but NOT logout/reboot):
bun cli/dispatch.ts daemon start
bun cli/dispatch.ts daemon status     # GET /health
bun cli/dispatch.ts daemon stop       # auth-gated via admin token
```

### 4b. As a service (survives logout + reboot)

The recommended path for a long-lived install.

```bash
bun cli/service-install.ts                  # writes a systemd user unit (Linux) or launchd plist (macOS)
bun cli/service-install.ts --system         # Linux only — writes /etc/systemd/system/accint.service (needs sudo to install)
```

The command writes the unit file but does NOT auto-load it. The CLI prints the load command for you to audit and run:

- **Linux user unit:** `systemctl --user daemon-reload && systemctl --user enable --now accint`
- **Linux system unit:** `sudo systemctl daemon-reload && sudo systemctl enable --now accint`
- **macOS:** `launchctl load ~/Library/LaunchAgents/com.accint.daemon.plist`

The generated unit / plist propagates relevant env vars (`OPENAI_API_KEY`, `ACC2_BRIDGE_MODE`, `ACC2_STATE_DIR`, etc.) from the shell that invoked `install-service`. If you change a var afterwards, regenerate the file and reload.

### 4c. Verifying it is up

```bash
bun cli/dispatch.ts daemon status        # JSON /health response
bun cli/doctor.ts                        # full readiness sweep
```

### 4d. Single-instance per host

The daemon binds a TCP port + writes a lock file at `~/.accint/v2.sock` carrying the MCP port, aux port, pid, and admin token. The acquire path is atomic — a second `bun runtime/daemon.ts` invocation on the same host either picks free ports and a different state dir or refuses to start. There is **no internal coordination** between two daemons sharing the same SQLite file: WAL writers race, the embedding rebuilder duplicates work, and the lock file ends up pointing at whichever process wrote it last. Treat the lock as authoritative.

To run two isolated AccInt environments on the same host (e.g. a stable install plus a development checkout), point each at its own state dir AND its own ports:

```bash
# Terminal A — production
export ACC2_STATE_DIR=$HOME/.accint
export ACC2_DAEMON_PORT=9387
export ACC2_DAEMON_AUX_PORT=9388
bun cli/dispatch.ts daemon start

# Terminal B — development
export ACC2_STATE_DIR=$HOME/.accint-dev
export ACC2_DAEMON_PORT=9487
export ACC2_DAEMON_AUX_PORT=9488
bun cli/dispatch.ts daemon start
```

Each daemon then writes its own lock file under its own state dir, runs its own MCP server, and refuses to clobber the other.

### 4e. Background workers (all ON by default)

The daemon starts six background workers automatically: the **embedder** (text-embedding-3-small over every text-bearing event), the **scheduler** (drains ready dispatches), **father** (long-horizon re-ranking, 5-min cadence), the **rolling-reviewer** (cadence-driven re-opens), **rehabilitation** (probes quarantined artifacts), and **integrity** (PRAGMA integrity + WAL hygiene, 6-hour cadence). All are ON by default — the substrate is meant to run the full organism out of the box.

The canonical opt-OUT is ONE env var — `ACC2_DISABLE_WORKERS` — carrying a comma-separated list of worker names. Empty / unset = all six workers run (the production default). Example: disable the embedder during an OpenAI outage and the father during a controlled long-horizon test:

```bash
ACC2_DISABLE_WORKERS=embedder,father
```

Canonical worker names: `embedder`, `scheduler`, `father`, `rolling_reviewer`, `rehabilitation`, `integrity`. Unknown names in the list are silently ignored (no crash) so forgetting a worker after a rename is a no-op rather than a hard failure.

The test suite (`bun test`) pins five of the six off (`embedder,scheduler,father,rolling_reviewer,rehabilitation`) via `tests/preload.ts`; integrity stays on because it is pure-SQLite and required for `/ready`. Production code does not need to touch any of this.

The legacy per-worker env vars (`ACC2_EMBEDDER_AUTOSTART`, `ACC2_FATHER_AUTOSTART`, `ACC2_ROLLING_AUTOSTART`, `ACC2_REHAB_AUTOSTART`, `ACC2_INTEGRITY_AUTOSTART`, `ACC2_AUTOSCHEDULER`) have been REMOVED. Operators who still export them will have no effect — migrate to `ACC2_DISABLE_WORKERS`.

---

## 5. Updating

```bash
cd bos2 && git pull
cd system/acc2 && bun install            # picks up dep changes
bun cli/dispatch.ts daemon stop          # auth-gated; admin token from ~/.accint/v2.sock.token
# Wait for /health to stop responding, then:
bun cli/dispatch.ts daemon start         # detached restart
# OR if running under systemd / launchd:
#   systemctl --user restart accint
#   launchctl unload ~/Library/LaunchAgents/com.accint.daemon.plist && launchctl load <same path>
bun cli/doctor.ts                        # confirm the new build came up cleanly
```

The substrate schema is versioned in `substrate/schema.sql`. Schema migrations are applied at daemon boot; the daemon refuses to start if the migration fails, so the old process keeps running until you restart cleanly.

### 5a. Keeping the system current

External dependencies evolve independently of acc2. The brain subprocess (opencode) in particular ships breaking model-id renames between minor versions (e.g. `openai/gpt-5-mini` → `openai/gpt-5.4-mini` between 1.3 and 1.4). Each dependency has a documented refresh path; the table below is the canonical list.

| Component | Check version | Update procedure |
|---|---|---|
| **opencode** | `bun cli/admin.ts opencode-version` | `bun cli/admin.ts update-opencode [--yes]` — auto-detects install method (official-script / npm / bun), stops the daemon, runs the upgrade, restarts the daemon. Emits `opencode_upgrade_started` + `opencode_upgrade_completed` events on the substrate so every upgrade is auditable. |
| **camoufox** | `ls ~/.cache/camoufox/camoufox` or `$CAMOUFOX_BINARY_PATH` | `python -m camoufox fetch` — refreshes the bundled Firefox build. The Python package itself comes from `pip install -U camoufox` or `uv pip install -U camoufox`. |
| **uv** (Astral) | `uv --version` | `uv self update` — Astral provides built-in self-update. |
| **bun** | `bun --version` | `bun upgrade` — upgrades the bun runtime in-place. |
| **AccInt v2** | `git -C bos2 log -1` | `git pull && bun install` (see the block above), then restart the daemon. |

`bun cli/admin.ts upgrade-check` queries every external subsystem and renders a one-line summary per row so you can see at a glance which need attention. For opencode it ALSO compares the installed version against the GitHub `releases/latest` tag (cached 1h at `~/.accint/state/cache/opencode-latest.json`; set `GITHUB_TOKEN` if you hit the 60 req/h anonymous rate limit).

---

## 6. Backup

The substrate is one SQLite file (`~/.accint/state.db` by default, configurable via `ACC2_STATE_DIR`/`ACC2_DB_PATH`). It is the canonical state — if you lose it, you lose accumulated judgment. There is no dev-from-checkout fallback; the source tree is never a state location.

**Stop the daemon, copy the file:**

```bash
bun cli/dispatch.ts daemon stop
# Wait for /health to stop responding.
cp -a ~/.accint ~/accint-backup-$(date +%Y%m%d)
bun cli/dispatch.ts daemon start
```

You must copy both `state.db` and any sibling files (`state.db-wal`, `state.db-shm`) — they are part of the same database.

A full `acc admin export` flow with online snapshots ships in Batch 3.

---

## 7. Daily Operator Ritual

Run this short ritual when supervising a live AccInt v2 install:

1. `acc daemon status` to confirm the substrate is reachable.
2. `acc doctor` after code updates, daemon restarts, or dependency changes.
3. `acc trust` to inspect the trust/autonomy surface: `autonomy_score`, recipe extraction and replay success, knowledge promotion/demotion, artifact posterior movement, rolling closure residuals, and amendment-apply outcomes.
4. `acc events --kind dispatcher_violation --limit 20` when `acc trust` or `acc watch` shows regressions.
5. Review structural apply evidence for `contract_amendment_proposed` rows: anchored_replace_v1 diff shape, verifier residual, dispatcher trajectory, irreversible-effect state, and owner_profile.things_to_never_do. Refusing malformed proposals records a non-destructive outcome and does not require owner consent.

The ritual is evidence-oriented: trust increases when replay succeeds, closure residuals stay low, posteriors move after scored actions, and amendments apply with verifier-passing `applied_change_committed` rows.

### 7a. Inspecting one dispatch — `acc dispatch <id>`

The canonical substrate-truth view for "what happened on this dispatch?" is
`acc dispatch <directive_id_or_prefix>`. It reads the event ledger
directly (not the Bash background-task panel) and surfaces, in one report,
the directive metadata + task DAG with per-task status badges, KCs and
`code_artifact_candidate` emissions grouped by task, refinement edges,
`contract_amendment_proposed` rows, and `task_closure_audited` residuals.

This is the command the orchestrator now reaches for instead of authoring
ad-hoc `/tmp/check_*.ts` SQLite scripts. Per
[.claude/rules/orchestrator-runtime.md](../.claude/rules/orchestrator-runtime.md)
the Claude Code Bash panel is non-authoritative; the substrate ledger is.

```bash
# Pretty terminal output (ANSI status badges)
acc dispatch QHTRBV6P

# JSON output for orchestrator / scripting consumption
acc dispatch QHTRBV6PFX2JVBMHDNDA4B03GC --json

# Disable ANSI colors (e.g. piping through `less`)
acc dispatch QHTRBV6P --no-color
```

Prefix resolution: any prefix `>= 6` chars is accepted. Ambiguous prefixes
exit 1 with the candidate directive_ids listed on stderr.

---

## 8. Troubleshooting

### Daemon won't start

Symptoms: `bun cli/dispatch.ts daemon start` returns immediately but `acc daemon status` says "daemon not running".

1. Run the daemon in the foreground: `bun runtime/daemon.ts`. The error will print on stderr.
2. Common causes:
   - Port already in use — set `V2_DAEMON_PORT` to a free port.
   - State dir not writable — check `ACC2_STATE_DIR` permissions.
   - Schema migration failed — restore from backup; file a bug with the schema error.
3. Make sure the lock file (`~/.accint/v2.sock`) is not stale. If the daemon died uncleanly, delete the lock and retry: `rm ~/.accint/v2.sock`.

### MCP unreachable

Symptoms: `acc task` fails with "daemon not running — start it with `acc daemon start`" but `acc daemon status` works.

1. Check the lock file — it carries the MCP port. `cat ~/.accint/v2.sock`.
2. If you set `V2_DAEMON_PORT` in one shell but not the one running `acc task`, both surfaces resolve through the lock file's port — but only when the env var is unset. Unset `V2_DAEMON_PORT` or set it consistently across shells.
3. The MCP transport is `fastmcp:httpStream`. Check the daemon's stderr for "failed to bind MCP port".

### OPENAI rate-limit

Embeddings degrade gracefully — a 429 / 5xx from OpenAI is logged but does not crash the daemon. Affected knowledge candidates are re-embedded on the next daemon boot. If you are hitting persistent 429s, lower your embedding rate or upgrade your OpenAI tier.

### opencode auth

Symptoms: brain dispatches return a stub-shaped response or fail with "opencode: not authenticated".

1. Run `opencode --help` outside of AccInt to confirm the CLI itself works.
2. Re-authenticate per the opencode README. AccInt does not handle opencode auth; it shells out to the subscription CLI.
3. Confirm `ACC2_BRIDGE_MODE` is unset or `real` — `real` is the production default (`runtime/bridge.ts:opencodeQuery`). Tests pin `mock` via `bunfig.toml` → `tests/preload.ts`; only set `mock` here if you intentionally want non-test paths to route through the canned mock.

### camoufox missing

Symptoms: a code artifact targeting `camofox-browser` fails with "camoufox binary not found".

1. Either set `CAMOUFOX_BINARY_PATH=/absolute/path/to/camoufox` or download into `~/.cache/camoufox/camoufox`.
2. `acc doctor` will warn (not fail) when neither is present, because non-browser directives still work.

### `acc doctor` shows FAIL for "ready for real-brain dispatch"

The composite readiness check requires four greens: daemon health + `OPENAI_API_KEY` + `opencode` + `ACC2_BRIDGE_MODE=real`. The `(missing: ...)` line in the FAIL message tells you exactly what to fix. Fix each in turn and re-run `acc doctor`.

---

## 9. Where state lives

| Path | Purpose |
|---|---|
| `~/.accint/state.db` | Substrate SQLite (the only state that matters). |
| `~/.accint/v2.sock` | Lock file with MCP + aux port. |
| `~/.accint/v2.sock.token` | Admin token (required for `daemon stop`). |
| `~/.config/systemd/user/accint.service` | systemd user unit, if installed. |
| `/etc/systemd/system/accint.service` | systemd system unit, if installed. |
| `~/Library/LaunchAgents/com.accint.daemon.plist` | launchd plist (macOS), if installed. |
| `~/Library/Logs/accint.daemon.{out,err}.log` | launchd stdout/stderr (macOS). |

All of these paths respect the `ACC2_STATE_DIR` env var if set. There is
no `state/` subdir under the state root and no fallback into the source
tree — the resolver always lands at `${stateDir}/state.db`. Sweep stale
`/tmp/acc2-harness-*` and `/tmp/acc2-cli-*` dirs left behind by
integration / smoke runs with `acc admin clean-temp-state`.
