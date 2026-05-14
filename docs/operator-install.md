# AccInt v2 — Operator install guide

This document walks an operator through the host-level dependencies acc2
needs before `bun run acc` works end-to-end. Run each section once per
machine. Order matters: bun first (everything else depends on it), then
OPENAI_API_KEY, then opencode, then uv, then Camoufox, then (optional)
nsjail.

When in doubt run `acc doctor` — it checks each dependency individually and
prints the exact install command for whatever is missing.

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

After all dependencies are installed:

```bash
cd /path/to/acc2
bun run acc doctor
```

`acc doctor` reports the status of each component:

- bun version + path
- OPENAI_API_KEY present in env or `.env`
- opencode on PATH + authenticated
- uv on PATH + version
- playwright in `node_modules`
- camoufox binary resolved (override or default fetch location)
- nsjail on PATH (optional — reported as "missing (optional)" when absent)

When every required line is green, run:

```bash
bun run acc task "hello world"
```

This routes a directive through the brain end-to-end. If the task lands and
the substrate writes a `task_committed` event, your install is complete.
