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

## Expected stdout (real bridge, success)

```
acc2 real-opencode smoke — Batch 2.α
========================================
mode: real

preflight: PASS
boot: daemon up on mcp=45123 aux=47456 (0.32s)
seed: knowledge=8, code_artifacts=10 (skipped=0)

dispatch: launching scheduler tick (target mode=real)…
dispatch: scheduler tick returned dispatched=[t_…] in 95.41s

scheduler dispatched the task ................. PASS (95.41s)  task=t_…
bridge_invoked event .......................... PASS (0.00s)  count=1
action_predicted with both artifact ids ....... PASS (0.00s)  action=ca_… verifier=cv_…
both artifacts resolve via getArtifact ........ PASS (0.00s)  action.runtime=bun verifier.runtime=bun
artifact_invoked + artifact_observed .......... PASS (0.00s)  invoked=2 observed=2
action_scored with residual in [0,1] .......... PASS (0.00s)  residual=0.000
no dispatcher_violation events ................ PASS (0.00s)  count=0
task_committed (residual < 0.3) ............... PASS (0.00s)  count=1
observation result.title is non-empty string .. PASS (0.00s)  title="Example Domain"

========================================
9/9 steps passed in 95.78s
[ok] real opencode dispatch solved the directive end-to-end
```

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

### `no_action_predicted`
The brain returned a response but never emitted `action_predicted`. This is the canonical Batch 2.α gap: opencode reasons about the directive (the bridge captures its text reply) but never invokes `substrate.admit_artifact`. Two likely root causes:

1. **opencode is not configured with the daemon's MCP server.** v2-design.md §12.1 says opencode discovers the substrate via the `MCP_SERVER_URL` environment variable; the bridge sets `V2_MCP_SERVER_URL` → `MCP_SERVER_URL`, but opencode also needs its own `opencode.json` or `--mcp` flag to register the URL as a usable MCP server. Until that wiring is complete, opencode produces a natural-language reply only.
2. **The model isn't strong enough.** Try `--model=openai/gpt-5.4` (or whatever the strongest current opencode-resolvable id is). The default `openai/gpt-5.4-mini` is fast but sometimes balks at multi-step reasoning under the substrate-projected prompt.

Re-run with `--print-prompt`; check `composed.text` ends with the workflow instructions correctly. Inspect the database for `code_artifact_candidate` rows on the directive — if those appear without `code_artifact_admitted`, admission rejected the artifacts (likely a sandbox-declaration violation). When the bridge completes with `final_response_chars > 0` but no `action_predicted`, the gap is the MCP wiring, not the brain itself.

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
