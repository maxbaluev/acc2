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
| **camoufox** | Optional | Required for the `camofox-browser` runtime (browser-touching code artifacts). | Download from <https://github.com/daijro/camoufox/releases> into `~/.cache/camoufox/camoufox` OR set `CAMOUFOX_BINARY_PATH`. |
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

## 3. First run — `acc init` + `acc doctor`

Phase 1.γ adds an interactive `acc init` (not in this batch). For now, manually create `.env` from `.env.example`:

```bash
cp .env.example .env
# Edit .env to add OPENAI_API_KEY if you have one.
# Set ACC2_BRIDGE_MODE=real when you are ready for production dispatch.
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
| `OPENAI_API_KEY` | Present and non-empty. |
| `opencode` | The `opencode` binary is on `PATH`. |
| `uv` | The `uv` binary is on `PATH`. |
| `camoufox binary` | `CAMOUFOX_BINARY_PATH` is set OR `~/.cache/camoufox/camoufox` exists. |
| `nsjail` | The `nsjail` binary is on `PATH` (info only — uv sandbox is honor-system without it). |
| `bun` | Bun ≥ 1.0 on `PATH`. |
| `ACC2_BRIDGE_MODE` | `real` is the production setting; `mock` is for tests. |
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

---

## 6. Backup

The substrate is one SQLite file (`~/.accint/state/accint.db` by default, configurable via `ACC2_STATE_DIR`/`ACC2_DB_PATH`). It is the canonical state — if you lose it, you lose accumulated judgment.

**Stop the daemon, copy the file:**

```bash
bun cli/dispatch.ts daemon stop
# Wait for /health to stop responding.
cp -a ~/.accint/state ~/accint-backup-$(date +%Y%m%d)
bun cli/dispatch.ts daemon start
```

You must copy both `accint.db` and any sibling files (`accint.db-wal`, `accint.db-shm`) — they are part of the same database.

A full `acc admin export` flow with online snapshots ships in Batch 3.

---

## 7. Troubleshooting

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
3. Confirm `ACC2_BRIDGE_MODE=real`. The default (mock) routes to a hermetic stub for tests.

### camoufox missing

Symptoms: a code artifact targeting `camofox-browser` fails with "camoufox binary not found".

1. Either set `CAMOUFOX_BINARY_PATH=/absolute/path/to/camoufox` or download into `~/.cache/camoufox/camoufox`.
2. `acc doctor` will warn (not fail) when neither is present, because non-browser directives still work.

### `acc doctor` shows FAIL for "ready for real-brain dispatch"

The composite readiness check requires four greens: daemon health + `OPENAI_API_KEY` + `opencode` + `ACC2_BRIDGE_MODE=real`. The `(missing: ...)` line in the FAIL message tells you exactly what to fix. Fix each in turn and re-run `acc doctor`.

---

## 8. Where state lives

| Path | Purpose |
|---|---|
| `~/.accint/state/accint.db` | Substrate SQLite (the only state that matters). |
| `~/.accint/v2.sock` | Lock file with MCP + aux port. |
| `~/.accint/v2.sock.token` | Admin token (required for `daemon stop`). |
| `~/.config/systemd/user/accint.service` | systemd user unit, if installed. |
| `/etc/systemd/system/accint.service` | systemd system unit, if installed. |
| `~/Library/LaunchAgents/com.accint.daemon.plist` | launchd plist (macOS), if installed. |
| `~/Library/Logs/accint.daemon.{out,err}.log` | launchd stdout/stderr (macOS). |

All of these paths respect the `ACC2_STATE_DIR` env var if set.
