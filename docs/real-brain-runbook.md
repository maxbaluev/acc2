# real-brain-runbook — Batch 2.α

Operator-facing recipe for `tests/integration/real_brain_smoke.ts`. This is the gating proof that acc2 actually solves real-world directives end-to-end against the real `opencode run` subprocess (model: `openai/gpt-5-mini` by default).

## Pre-requisites

`acc2/cli/doctor.ts` covers everything below; run it first when something feels off. The smoke ALSO runs its own pre-flight before booting the daemon and refuses to proceed if any item is red.

- `OPENAI_API_KEY` exported in the shell (or loaded via `.env`). Required even though the brain dispatch itself does not call OpenAI directly — downstream embedder workers need the key, and the smoke's `--print-prompt` flag composes a prompt that retrieves through the index.
- `opencode` CLI on PATH. Install from https://github.com/sst/opencode. Run `opencode auth` once so the subprocess can reach the model provider non-interactively.
- Bun >= 1.0.0. Check via `bun --version`.
- No `ACC2_BRIDGE_MODE=mock` already pinned in the shell (the smoke overrides, but warns if it sees a contradicting value).

## How to run

```bash
cd /home/maxbaluev/bos2/system/acc2
bun tests/integration/real_brain_smoke.ts
```

Optional flags:

- `--print-prompt` — render the composed brain prompt to stdout BEFORE dispatching. Useful when debugging "what is the brain actually seeing?"
- `--mock-bridge` — run against `ACC2_BRIDGE_MODE=mock` (the CI lane). The mock returns canonical fixture_d_count_todos events; the success criterion becomes "scenario chain green" rather than "real brain solved a real task".
- `--model=<id>` — override the opencode model. Defaults to `openai/gpt-5-mini`.
- `--timeout=<ms>` — override the per-dispatch watchdog. Default 600s (real opencode boot + reasoning + tool calls can take a full minute on a cold cache).

Typical wall-time:
- `--mock-bridge`: ~3-6 seconds (boot + canned dispatch + assertions).
- Real bridge: ~60-180 seconds (opencode boot + one full reasoning cycle + bun action + verifier run).

## Expected stdout (real bridge, success — Batch 2.β reference run)

```
acc2 real-opencode smoke — Batch 2.α
========================================
mode: real

preflight: PASS
[FastMCP info] server is running on HTTP Stream at http://127.0.0.1:46480/mcp
boot: daemon up on mcp=46480 aux=48602 (0.04s)
seed: knowledge=10, code_artifacts=10 (skipped=0)

dispatch: launching scheduler tick (target mode=real)…
[FastMCP info] HTTP Stream session established
[mcp-proxy] establishing new SSE stream for session ID 5ed4d57f-d73f-4725-ab70-50c140293a20
dispatch: scheduler tick returned dispatched=[NJ74W6CFW1159BT0NRNTFYP9HW] in 93.58s

scheduler dispatched the task .................... PASS (93.58s)  task=NJ74W6CFW1159BT0NRNTFYP9HW
bridge_invoked event ............................. PASS (0.00s)  count=1
action_predicted with both artifact ids .......... PASS (0.00s)  action=KG0VK4E4R11MV3Y8AY040SM75R verifier=X19HKSEQ8X4AK816DXKNAEZ470
both artifacts resolve via getArtifact ........... PASS (0.00s)  action.runtime=bun verifier.runtime=bun
artifact_invoked + artifact_observed ............. PASS (0.00s)  invoked=2 observed=2
action_scored with residual in [0,1] ............. PASS (0.00s)  residual=0.000
no dispatcher_violation events ................... PASS (0.00s)  count=0
task_committed (residual < 0.3) .................. PASS (0.00s)  count=1
observation result.title is non-empty string ..... PASS (0.00s)  title="Example Domain"

========================================
9/9 steps passed in 93.63s
[ok] real opencode dispatch solved the directive end-to-end
```

The `[FastMCP info] HTTP Stream session established` line is the daemon's confirmation that opencode connected as an MCP client. The `[mcp-proxy] establishing new SSE stream` is the streamable-HTTP handshake completing. Under Batch 2.β both lines appear before the first brain emission — that's the structural proof the MCP wire is up.

## Failure modes

When a step fails, the smoke exits with a non-zero code and prints a diagnostic block. The classification below maps each mode to its remediation.

### `auth_missing`
opencode could not authenticate to its provider. Run `opencode auth` (see opencode docs). Verify `which opencode` resolves and `opencode --version` returns. Re-run the smoke once `opencode run --help` lists the `--dangerously-skip-permissions` flag.

### `rate_limit`
The OpenAI API rate-limited either the embedder (less likely — the smoke doesn't tick the embedder) or the opencode model provider. Wait and retry. If it persists across a 5-minute window, the project's API quota is exhausted — check the OpenAI dashboard.

### `parse_error`
opencode emitted a line that wasn't valid JSON despite `--format=json`. File an issue with the opencode stderr capture from the failure block. Workaround: re-run; the failure is occasionally transient on a flaky network. The bridge tolerates non-JSON lines (they're treated as final-response text) so a true `parse_error` only fires when JSON parsing of a structured event field fails in the dispatcher post-bridge.

### `timeout`
Brain dispatch exceeded the watchdog (default 600s; the inner spawnRealOpencode timeout is 60s by default but the smoke runs at the scheduler-tick level so the effective ceiling is the longer one). Likely causes:
- opencode is stuck (check `ps aux | grep opencode`; SIGKILL the stale subprocess).
- Network is slow or down (the directive fetches example.com — verify reachability).
- The model is too slow at this size — try `--model=openai/gpt-5` for a stronger reasoner.

Inspect opencode's own logs: typically `~/.local/share/opencode/logs/` or the path it prints on startup.

### `subprocess_crash`
opencode exited non-zero with stderr captured. The smoke surfaces the last 200 chars of stderr. Common causes:
- Auth not configured (see `auth_missing`).
- Invalid model id (typo on `--model=`).
- Bun version too old (the spawn line uses Bun.spawn under the hood — Bun >= 1.0.0 is required).

### `cycle_1_only_breach`
opencode emitted a `brain_cycle_2_started` or `continue_cycle_requested` event mid-dispatch. This is the cycle-1 enforcement firing (v2-design.md §3.7). Ironically a sign the structural guard works — but the brain shouldn't be hitting it for a task this simple. Investigate the prompt with `--print-prompt`; the brain might be misreading the workflow text. The dispatcher correctly aborts the dispatch and emits `dispatcher_violation` with `failure_kind=cycle_1_only_breach`.

### `verifier_residual_high`
The brain authored an action whose verifier rejected the observation (residual ≥ 0.3). For this title-fetching directive that almost never happens (example.com's `<title>` is stable). When it does:
1. Paste the action artifact body via `bun -e 'const {openDb}=require("./substrate/db"); const db=openDb("<path-to-state.db>"); console.log(db.query("SELECT body FROM code_artifact WHERE id=?").get("<action-id>").body)'`.
2. Inspect the verifier output for the residual reasoning.
3. The smoke does NOT fail on residual≥0.3 — it accepts the refinement-edge path. A real-world directive would emit `task_edge_recorded` kind=refines, and the next scheduler tick would pick up the refined task. The smoke runs ONE tick, so it stops there.

### `no_action_predicted` — RESOLVED (Batch 2.β)
The Batch 2.α gap where opencode reasoned about the directive but never invoked `substrate.admit_artifact` is **closed** as of Batch 2.β. The bridge now:

1. **Materializes a per-dispatch `opencode-config.json`** under a `mkdtemp(os.tmpdir(), "acc2-opencode-cfg-")` tempdir declaring v2's MCP server (`type:"remote"`, `url:"http://127.0.0.1:<port>/mcp"`, `enabled:true`).
2. **Sets `OPENCODE_CONFIG=<that-path>` in the opencode subprocess env** so opencode, on boot, registers v2's full `substrate.*` + `runtime.*` tool surface (24 tools — see `runtime/bridge.ts:V2_MCP_TOOL_SURFACE` for the canonical list).
3. **Watches the stdout event stream for the MCP handshake** — every `tool_use` event whose tool name matches `substrate.*` / `runtime.*` natively OR its opencode-mangled form (`acc2-substrate_substrate_*` / `acc2-substrate_runtime_*`) emits a `bridge_mcp_connected` substrate event with the first-tool name.
4. **Fails fast with `mcp_handshake_failed` if no v2 tool call lands within the handshake window** (default 30s; override via `ACC2_OPENCODE_MCP_HANDSHAKE_MS`). Operators see the gap immediately rather than waiting out the full dispatch watchdog.
5. **Cleans up the materialized config tempdir** after the subprocess exits (best-effort, regardless of outcome).

The Batch 2.β smoke confirmed the wiring is sound — the brain authored bun action + verifier artifacts, admitted them via the MCP wire, emitted `action_predicted` with both artifact ids, and the dispatcher ran both artifacts to `task_committed` in ~95s wall.

If `no_action_predicted` re-appears after Batch 2.β, the cause is no longer the MCP wiring; it's likely the model itself failing to reason about the directive. Re-run with `--print-prompt` to inspect `composed.text`, and consider `--model=openai/gpt-5.4` if the default mini balks.

### `mcp_handshake_failed`
opencode connected to v2's MCP server (the daemon's stdout shows `HTTP Stream session established` + `establishing new SSE stream`) but never invoked any `substrate.*` / `runtime.*` tool within the handshake window. The bridge SIGTERMs the subprocess and emits `bridge_failed { reason: "mcp_handshake_failed", window_ms, mcp_server_url, hint, … }`.

Check, in order:

1. **Is the daemon actually serving `/mcp`?** Run `curl -i http://127.0.0.1:<port>/mcp` from a separate shell while the smoke is mid-flight — fastmcp's httpStream transport should respond with a 405/406 (it requires a session handshake; a bare GET is rejected but the connection succeeds, proving the port is live).
2. **Did opencode pick up our `OPENCODE_CONFIG`?** Set `ACC2_OPENCODE_STDOUT_LOG=/tmp/oc-stdout.log` and re-run; grep the dump for `acc2-substrate` tool names. If absent, opencode did not register the server — verify `OPENCODE_CONFIG=<path>` shows up in `ps aux | grep opencode` env.
3. **Did the model emit any tool_use events at all?** `grep '"type":"tool_use"' /tmp/oc-stdout.log` — if zero, the brain produced text only (model too weak, or prompt insufficient).
4. **Port conflict.** If the smoke booted on a port someone else is also using (rare with the smoke's random 45000-50000 band, but possible), opencode might be connecting to the wrong process. Confirm via `ss -tlnp | grep <port>`.
5. **Firewall / docker bridge.** WSL2 / docker-desktop networking sometimes interferes with `127.0.0.1` between sub-processes. Verify with `curl http://127.0.0.1:<port>/mcp` from the same shell that ran the smoke.
6. **fastmcp not started.** If `bridge_invoked` fired but no `HTTP Stream session established` appeared in stderr, the daemon's MCP server didn't bind. Re-check `bun tests/integration/real_brain_smoke.ts` boot output for the line `boot: daemon up on mcp=<port>` — if absent, the daemon never came up.

Widen the handshake window via `ACC2_OPENCODE_MCP_HANDSHAKE_MS=120000` (or higher) for slow models / cold model caches — the default 30s is enough for the `openai/gpt-5.4-mini` family but a stronger reasoner may spend 60s+ reading the substrate before calling any tool.

## What this proves

When this smoke exits 0 against the real bridge, acc2 is officially capable of:
- Booting a fresh daemon on free ports with a clean state directory.
- Composing a substrate-projected prompt under the 8000-token budget.
- Dispatching to the real `opencode run` subprocess with `--format=json --model openai/gpt-5-mini --dangerously-skip-permissions <prompt>`.
- Streaming the brain's JSON event output through `spawnRealOpencode` line-by-line, with structural cycle-1 enforcement applied identically to mock and real paths via `runtime/cycle_one_gate.ts`.
- Routing brain-authored action + verifier artifacts through `substrate.admit_artifact` (the MCP capability the daemon exposes natively).
- Running both artifacts under the bun runtime sandbox.
- Scoring the verifier residual, emitting `action_scored`, distributing credit via `distributeCredit`, and committing the task with `task_committed` when residual < 0.3.

That is the full Batch 2.α end-to-end loop: a non-trivial real-world directive (fetch HTML, extract title) solved without any human intervention, with the audit trail preserved as event rows in the substrate.

## Updating opencode

opencode evolves quickly (1.4.3 → 1.14.50 within weeks) and each release can rename models or shift the JSON event shape. AccInt v2 ships first-class controls so the operator can keep the brain subprocess current without leaving the CLI.

### Inspect what is installed and what is available

```bash
bun cli/admin.ts opencode-version
```

Prints three lines: `current:` (resolved version + install method + path), `latest:` (newest GitHub release, cached for 1 hour at `~/.accint/state/cache/opencode-latest.json`), and `status:` (`up to date`, `upgrade available`, or `ahead of latest`). When rate-limited by GitHub, set `GITHUB_TOKEN` to authenticate the API call.

`acc doctor` reports the currently-installed version on the `opencode` row; `acc admin opencode-version` is the surface that ALSO surfaces the latest-available comparison.

### Run the upgrade

```bash
bun cli/admin.ts update-opencode          # interactive — prompts before upgrading
bun cli/admin.ts update-opencode --yes    # unattended (use in scripts / CI)
```

The upgrade routine:

1. Detects the install method by inspecting the resolved binary path:
   - `~/.opencode/bin/opencode` → official installer (`curl -fsSL https://opencode.ai/install | bash`).
   - `*/node_modules/.bin/opencode` or `/usr/local/bin/opencode` with `npm list -g opencode-ai` matching → npm (`npm install -g opencode-ai@latest`).
   - `~/.bun/install/global/bin/opencode` → bun (`bun upgrade -g opencode-ai`).
   - Anything else → refused with `permission_denied` (the operator must upgrade manually).
2. **Stops the daemon** if it is running (so the running brain process is not torn out from under a live dispatch). Restarts it automatically when the upgrade returns.
3. Emits three substrate events for the trajectory: `opencode_upgrade_started`, `opencode_upgrade_completed` (success) or `opencode_upgrade_failed` (with `reason: auth_required | network_error | install_failed | permission_denied`).
4. Re-detects the version after the install command returns so the reported `from → to` is the actual new binary, not the GitHub tag.

### Multi-subsystem check

```bash
bun cli/admin.ts upgrade-check
```

Renders one row per external dependency (opencode, bun, uv, camoufox) with a `[UPGRADE]` / `[ok]` flag and the canonical refresh command. Only opencode is checked against a remote registry; the others surface their installed version and the documented refresh path (`bun upgrade`, `uv self update`, `python -m camoufox fetch`).

### What to do after upgrading

1. Run `bun test` to confirm the unit suite still passes against the new opencode.
2. Run `bun tests/integration/real_brain_smoke.ts --mock-bridge` to confirm the scenario chain is still green (the mock bridge does not call opencode, but seeds + scheduler ticks still exercise the full substrate).
3. Optionally run `bun tests/integration/real_brain_smoke.ts` to drive the real-bridge end-to-end loop against the new opencode. If a model id was renamed (recurring failure pattern: `ProviderModelNotFoundError`), pass `--model=<new-id>` after consulting `opencode models openai` for the live list.
