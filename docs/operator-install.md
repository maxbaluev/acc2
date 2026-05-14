# AccInt v2 — Operator install guide

This document walks an operator through the host-level dependencies acc2
needs before `bun run acc` works end-to-end. Run each section once per
machine. Order matters: bun first (everything else depends on it), then
OPENAI_API_KEY, then opencode, then uv, then Camoufox, then (optional)
nsjail.

When in doubt run `acc doctor` — it checks each dependency individually and
prints the exact install command for whatever is missing.

---

## Quickstart — composite first-run path

The canonical six-step sequence. Run from the acc2 repo root. Every step
is idempotent and safe to re-run. `acc doctor` reporting **PASS** is the
canonical "system is ready" signal — do not start dispatching real work
until you see it.

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

What each step does:

1. `bun install` — installs npm deps; the postinstall hook fetches the
   Camoufox firefox binary into `~/.cache/camoufox/camoufox` (best-effort,
   non-fatal — `acc admin install-deps` finishes anything postinstall
   skipped).
2. `acc admin install-deps` — verifies bun ≥ 1.3.14, opencode on PATH,
   OPENAI_API_KEY in env / `.env`, the camoufox binary, and nsjail
   (warn-only). Emits a structured `dep_check_complete` line so the
   harness can pattern-match it. Exit 0 iff every must-have passes.
3. `acc init --yes` — creates `${stateDir}`, mints the admin token,
   imports the foundational knowledge seed (10 load-bearing principles)
   AND the canonical code-artifact seed pairs (action + verifier). Both
   surfaces are non-empty after this step.
4. `acc doctor` — composite readiness probe. Beyond the file-existence
   checks (daemon /health, opencode on PATH, OPENAI_API_KEY in env), it
   now also asserts:
   - ≥ 5 `knowledge_promoted` events in the ledger,
   - ≥ 5 canonical `seed_*` rows in `code_artifact`,
   - `sqlite-vec` extension loads + `vec0(...)` virtual table works.
   The bottom line reports `[PASS] ready for real-brain dispatch` when
   every must-have is green.
5. `acc daemon start` — spawns the daemon detached. All workers ON by
   default (Father iteration, embedder catch-up, rolling reviewer,
   amendment handler, integrity check).
6. `acc task "..."` — opens a directive; the substrate dispatches the
   brain. Watch the event stream live with `acc watch` in another
   terminal.

The rest of this guide explains each host dependency in detail. Use it
when one of the six steps above reports an issue, or when you want the
manual install path for a specific component.

---

## 0. Canonical on-disk layout

All persistent state — daemon lock file, admin token, SQLite events
ledger, logs, scratch — lives DIRECTLY under one root directory. There
is NO `state/` subdir.

```
${stateDir}/
├── v2.sock              ← daemon lock file (JSON; pid + ports + db path)
├── v2.sock.token        ← admin token (0600; mint-once)
├── state.db             ← SQLite events ledger (+ -wal / -shm sidecars)
├── logs/                ← daemon log files (when ACC2_LOG_FILE=1)
└── tmp/                 ← scratch space
```

**Path resolution (single source of truth: `runtime/state_paths.ts`).**

| Env var               | Default                                  |
|-----------------------|------------------------------------------|
| `ACC2_STATE_DIR`      | `~/.accint`                              |
| `ACC2_SOCKET_FILE`    | `${ACC2_STATE_DIR}/v2.sock`              |
| `ACC2_TOKEN_FILE`     | `${ACC2_STATE_DIR}/v2.sock.token`        |
| `ACC2_DB_PATH`        | `${ACC2_STATE_DIR}/state.db` (always — no dev fallback; the source tree is never a state location). |

Each env var is honored independently — set `ACC2_SOCKET_FILE` alone to
relocate just the socket without touching the rest. The daemon, the
init CLI, and every admin / doctor / watch surface read through the
same resolver so they cannot disagree.

### Legacy `ACCINT_HOME` (removed)

The v1-era `ACCINT_HOME` alias has been removed. Operators who still
have the export in their environment must rename it to
`ACC2_STATE_DIR`:

```bash
# Before:
export ACCINT_HOME=/var/lib/accint

# After:
export ACC2_STATE_DIR=/var/lib/accint
```

The legacy `${stateDir}/state/<file>` layout is migrated forward
automatically on the next `acc init` or daemon boot — a
`cli_layout_migrated` event lands in the ledger so you can see exactly
what moved. Operators who upgraded from a pre-canonical install do not
need to do anything; the rename is idempotent.

Integration / smoke runs occasionally leave stale state dirs under
`/tmp/` (notably `/tmp/acc2-harness-task-*` and `/tmp/acc2-cli-*`).
Sweep them with:

```bash
acc admin clean-temp-state
```

The command emits zero substrate events (OS hygiene only) and refuses
any path outside the matching globs as a safety guard.

---

## 1. Bun (the runtime acc2 is built on)

acc2 is a Bun project (TypeScript, native SQLite, native subprocess). The
daemon, CLI, and all three runtimes (`bun`, `uv`, `camofox-browser`) run
under bun. The minimum supported version is **1.0**.

```bash
curl -fsSL https://bun.sh/install | bash
# Restart shell or `source ~/.bashrc` / `source ~/.zshrc`.
bun --version    # >=1.0.0
```

After bun is on PATH:

```bash
cd /path/to/acc2
bun install
```

---

## 2. OPENAI_API_KEY (for `text-embedding-3-small`)

The substrate's embedding column is filled by OpenAI's `text-embedding-3-small`
model (the only external API key acc2 needs — every other capability comes
through subscription CLIs).

Set the key in `.env` at the acc2 root:

```bash
echo "OPENAI_API_KEY=sk-..." >> .env
```

Or export it in your shell profile. `acc init` will prompt for it on the
first run and write it to `.env` for you if it's missing.

---

## 3. opencode (the brain)

acc2's brain side runs as GPT-5.5 via the opencode subscription CLI. The
dispatcher shells out to `opencode` for every brain cycle.

Install + authenticate:

```bash
# Install (homebrew on macOS, or scripted install elsewhere)
brew install sst/tap/opencode   # macOS
# Linux: see https://opencode.ai/docs/install — the installer is a single binary.

# Authenticate (one-time, browser flow)
opencode auth login
opencode whoami    # confirms you're signed in
```

acc2 dispatches via `opencode run ...`; no API token is needed beyond the
subscription login.

---

## 4. uv (Astral Python for the `uv` runtime)

The `uv` runtime executes Python artifacts in ephemeral, frozen-environment
sandboxes. `uv` (the Astral Python package manager) is the canonical entry
point.

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
# Restart shell.
uv --version
```

Pinned Python versions and per-artifact dependency installs flow through
`uv run --with-requirements`; acc2 generates the requirements list from each
artifact's declared `pypi_allow`.

---

## 5. Camoufox (the `camofox-browser` runtime)

Camoufox is a fingerprint-randomizing Firefox fork distributed at
<https://github.com/daijro/camoufox>. acc2 drives it via playwright's
`firefox.launchPersistentContext({ executablePath, ... })` pointed at the
camoufox binary. There is no chromium download step — camoufox brings its
own firefox build.

You need:

1. **playwright** in `node_modules` (for the JS driver).
2. **A camoufox binary** on disk that the runtime can `executablePath` into.

### 5.1 Install playwright

```bash
cd /path/to/acc2
bun add playwright
```

You do NOT need `bunx playwright install firefox` — acc2 ignores the
playwright-bundled firefox and uses the camoufox binary instead.

### 5.2 Install the camoufox binary

Two paths. **Pick one.**

**Path A — Python (recommended):**

```bash
pip install camoufox    # or: uv pip install camoufox
python -m camoufox fetch
```

This writes the binary to `~/.cache/camoufox/camoufox` (Linux) or
`~/Library/Caches/camoufox/camoufox` (macOS). acc2 auto-detects both
locations — no env var needed.

**Path B — direct binary:**

Download a release from <https://github.com/daijro/camoufox/releases>,
unpack somewhere stable, and point acc2 at it:

```bash
export CAMOUFOX_BINARY_PATH=/your/path/to/camoufox
# Persist in shell profile or .env.
```

The override is checked FIRST — when `CAMOUFOX_BINARY_PATH` is set and
points at an existing file, acc2 uses that path even if a default
fetch-location binary also exists.

### 5.3 Alternative — npm camoufox launchers (informational)

There is an experimental npm package `camoufox-js`
(<https://github.com/apify/camoufox-js>, <https://www.npmjs.com/package/camoufox-js>)
that wraps the launch in a TypeScript-native helper. acc2 does **not** depend
on it — the runtime drives playwright's `firefox.launchPersistentContext`
directly and reads `CAMOUFOX_BINARY_PATH` for the executable. If you prefer
the camoufox-js launch surface for your own scripts you can `bun add
camoufox-js` alongside, but it is not required for the acc2 runtime to
work; the canonical install path remains a fetched/downloaded binary plus
playwright.

### 5.4 Fingerprint hints

Each camofox-browser sandbox declaration may optionally carry fingerprint
hints:

| Field                 | Values                          | Default  |
|-----------------------|---------------------------------|----------|
| `fingerprint_os`      | `linux` / `macos` / `windows`   | `linux`  |
| `fingerprint_locale`  | BCP 47 (e.g. `en-US`, `fr-FR`)  | `en-US`  |
| `headless`            | `true` / `false`                | `true`   |

The runtime threads these into env keys `CAMOUFOX_OS`, `CAMOUFOX_LOCALE`,
`CAMOUFOX_HEADLESS` and into playwright's `launchPersistentContext` options.

---

## 6. nsjail (optional — hardens uv sandbox)

The `uv` runtime can optionally wrap each invocation in `nsjail` for real
filesystem / network isolation. Without nsjail the sandbox runs in
honor-system mode (declarations are validated; enforcement is partial). The
runtime detects nsjail on PATH at launch time and uses it if present.

When nsjail is present, every uv artifact invocation emits a
`sandbox_enforced` event carrying the resolved limits (wall_ms, memory_mb,
fs_read / fs_write / net_allow / pypi_allow). When nsjail is absent, a
**single** `sandbox_degraded` event is emitted per process (not per
invocation) so the audit trail records the operating environment without
flooding the stream. Install nsjail for hardened uv sandboxing; without it
the runtime falls back to honor-system limits and the outer Bun watchdog.

Install on Linux:

```bash
sudo apt install nsjail              # Debian/Ubuntu (where the package exists)
# OR build from source:
git clone https://github.com/google/nsjail
cd nsjail && make
sudo cp nsjail /usr/local/bin/
```

On macOS, nsjail does not have a clean port. Run acc2 inside Docker or a
Linux VM if you need nsjail-grade isolation.

---

## 7. Verification

After all dependencies are installed, run the composite sequence from the
Quickstart at the top of this file (`acc admin install-deps`, then
`acc init --yes`, then `acc doctor`). When every step exits 0 and the
final `acc doctor` reports `[PASS] ready for real-brain dispatch`, the
install is complete.

`acc doctor` reports the status of each component:

- daemon /health reachable + healthy
- db integrity ok (PRAGMA integrity_check at boot)
- disk space (≥ 500MB free under stateDir; ≥ 2GB recommended)
- bun version on PATH (≥ 1.0; install-deps enforces 1.3.14 for the bootstrap)
- OPENAI_API_KEY present in env or `.env`
- opencode on PATH + authenticated
- uv on PATH + version
- camoufox binary resolved (override or default fetch location)
- nsjail on PATH (warn-only — uv sandbox degrades w/o it; bun + browser
  runtimes unaffected)
- ACC2_BRIDGE_MODE (production default = real)
- **seed knowledge** — ≥ 5 `knowledge_promoted` events (Task 3)
- **seed artifacts** — ≥ 5 canonical `seed_*` rows in `code_artifact` (Task 3)
- **sqlite-vec extension** — vec0 loads + virtual-table constructor works (Task 3)

When every must-have line is `[ ok ]` and the composite reports `[PASS]`,
the install is ready. Run:

```bash
bun run acc task "hello world"
```

This routes a directive through the brain end-to-end. If the task lands and
the substrate writes a `task_committed` event, your install is complete.
