#!/usr/bin/env bun
// `acc task "<owner words>"` and `acc daemon {start|stop|status}` thin client
// per v2-design.md §21. The CLI never opens SQLite directly — every surface
// flows through the daemon: substrate.* via MCP (fastmcp StreamableHTTP),
// /health + /shutdown via plain HTTP on the auxiliary port.

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import {
  auxBaseUrl, mcpCall, rpcGet, rpcPostAuth, requireAux,
  readAdminToken, readDaemonLock,
} from "./rpc";

const usage = (): string => `acc — v2 thin CLI

  acc init [--yes]                Fresh-install bootstrap (state dir, admin token,
                                  optional foundational seed). Run me first.
  acc task "<owner words>" [--no-follow] [--timeout SECS]
                                  Open a directive; the substrate dispatches the
                                  brain. By default, tails the narrative event
                                  stream until the root task hits a terminal state
                                  — designed for run_in_background:true so each
                                  brain emit is one Claude notification with no
                                  separate Monitor wiring. --no-follow / --bare
                                  reverts to fire-and-return (just emit + ack).
  acc events [--limit N] [--task PREFIX] [--directive PREFIX] [--kind K] [--verbose]
                                  Recent events, one structured line per event.
                                  Replaces inline 'bun -e mcpCall(...)' boilerplate.
  acc tail   [--directive PREFIX] [--task PREFIX] [--kind K] [--timeout SECS]
                                  Poll-and-stream events; exits on the first
                                  terminal event (task_committed / task_failed /
                                  dispatcher_violation) when scoped, runs until
                                  Ctrl-C otherwise.
  acc notify [--follow]           Claude Code chat-friendly event stream for the
                                  canonical mirror-inline kinds only: HIDL,
                                  owner_input_required, auto_apply_signaled,
                                  applied_change_committed, applied_change_failed,
                                  dispatcher_violation, bridge_failed. Thin
                                  alias over 'acc tail --kind <mirror-set>
                                  --follow'; does not inspect SQLite directly.
                                  Without --follow, prints the most recent N
                                  matching rows and exits.
  acc graph <directive_id>        Render the task DAG (nodes ranked, edges).
  acc inspect <task_id_prefix>    Per-task report: event histogram + chronology.
  acc apply <event_id> [--owner-approved]
                                  Render the Claude Agent subagent prompt for a
                                  lesson_extracted / contract_amendment_proposed
                                  event. Orchestrator feeds output into the Agent
                                  tool (run_in_background:true) to apply the edit.
  acc apply --record <event_id> --status applied|failed|refused [...]
                                  Emit the act-shaped applied_change_committed spine
                                  plus the *_applied credit event.
  acc verify <directive_id>       Orchestrator-side merger verification — aggregate
                                  every contract_amendment_proposed under a directive,
                                  join to contract_amendment_applied, and verify each
                                  named commit_sha touches the proposed target with
                                  the expected text. Exit 0 clean / 1 stranded /
                                  2 drift|missing.
  acc daemon start                Spawn the daemon detached if not running.
  acc daemon stop                 Auth-gated shutdown via admin token.
  acc daemon status               GET /health on the running daemon.
  acc daemon install-service      Write systemd unit (Linux) / launchd plist (macOS).
  acc watch                       Live TUI subscribing to the daemon's event stream.
  acc admin <sub>                 Operator maintenance (update-opencode, opencode-version, ...).
  acc doctor                      Multi-check readiness report.
`;

// Pre-dispatch credential preflight (cli-quick first line of defense).
//
// Architecture: the BRAIN's artifact declared_sandbox.env_requires is the
// canonical authority on what env vars an artifact needs (runtime gate in
// runtime/runtimes/bun.ts). This CLI check is the FAST-LANE belt-and-
// suspenders: if the owner explicitly names an env-var-shaped identifier
// in their directive AND that var isn't on the daemon process, refuse to
// dispatch immediately — no need to round-trip through the brain.
//
// Token shape is universal: `<NAME>_KEY` / `_TOKEN` / `_SECRET` /
// `_PASSWORD`. The runtime gate covers dynamic + library-indirected env
// access (which a directive-text scan can't see) via the declared_sandbox.
const ENV_VAR_TOKEN = /\b([A-Z][A-Z0-9]+(?:_[A-Z0-9]+)*(?:_KEY|_TOKEN|_SECRET|_PASSWORD))\b/g;
const PREFLIGHT_IGNORE = new Set([
  "ACC2_ADMIN_TOKEN", "ACC2_EXTERNAL_PUSH_TOKEN",
]);

const preflightCredentials = (words: string): string[] => {
  const seen = new Set<string>();
  for (const m of words.matchAll(ENV_VAR_TOKEN)) {
    const name = m[1]!;
    if (PREFLIGHT_IGNORE.has(name)) continue;
    if (process.env[name] && process.env[name]!.length > 0) continue;
    seen.add(name);
  }
  return [...seen];
};

const dispatchTask = async (
  words: string,
  opts: { follow?: boolean; timeoutSecs?: number } = {},
): Promise<number> => {
  // Pre-dispatch credential check. Refuses when an env-var-shaped token
  // appears in the directive text without a value in process.env.
  const missing = preflightCredentials(words);
  if (missing.length > 0) {
    console.error(`acc task: missing required env var(s): ${missing.join(", ")}`);
    console.error(`  the directive references these credentials but they are not set on the daemon process.`);
    console.error(`  add to .env (or export in your shell) and rerun:`);
    for (const k of missing) console.error(`    ${k}=...`);
    console.error(`  refusing to dispatch — would have burned brain tokens probing without the credential.`);
    return 2;
  }

  // `substrate.open_directive` is the canonical write surface: it emits
  // `directive_opened` AND the root `task_node_opened` in one transaction
  // so the scheduler has a ready task to dispatch on the next tick. Using
  // `substrate.emit` here was a structural bug — the directive landed but
  // no root task existed, so the scheduler never picked it up and the
  // brain was never invoked.
  let env;
  try {
    env = await mcpCall("substrate.open_directive", {
      directive_text: words,
    });
  } catch (err) {
    console.error(`acc task failed: ${(err as Error).message}`);
    return 1;
  }
  if (!env.ok) {
    console.error(`acc task failed: ${env.error}`);
    return 1;
  }
  const { directive_id, task_id } = env.result as { directive_id: string; task_id: string };
  console.log(`directive_opened ${directive_id} (root task=${task_id})`);
  console.log(`  text: ${words}`);

  // Conversation-as-learning-surface (DSGSAZGMF1, universalized per
  // owner feedback "people not 3 types, all of them different"):
  // extract continuous rendering signals from the directive text +
  // recent prior input. Each signal is independent — code_density,
  // ops_vocabulary, explanation_appetite, etc. — and accumulates
  // into a per-owner vector. NO persona enum, NO bucketing.
  // Best-effort — classifier failure never blocks dispatch.
  try {
    const { classifyOwnerRenderingSignals } = await import("../substrate/owner_rendering_classifier");
    const priorEnv = await mcpCall("runtime.recent_events", {
      k: 5,
      kinds: ["owner_input_received"],
    }).catch(() => null);
    const priorTexts: string[] = [];
    if (priorEnv?.ok) {
      const evs = ((priorEnv.result as { events?: Array<{ payload?: unknown }> })?.events ?? []);
      for (const e of evs) {
        const p = e.payload as { text?: string; directive_text?: string } | undefined;
        const t = p?.text ?? p?.directive_text;
        if (typeof t === "string" && t.length > 0 && t !== words) priorTexts.push(t);
      }
    }
    const replyWords = words.match(/[\p{L}\p{N}_-]+/gu)?.length ?? 0;
    const commandTokens = words.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^(acc|bun|git|npm|pnpm|yarn|uv|cargo|docker|kubectl)\b/.test(l)).length;
    const turnPattern = {
      reply_length_chars: words.length,
      reply_word_count: replyWords,
      command_token_count: commandTokens,
      prose_token_count: Math.max(0, replyWords - commandTokens),
      prior_turn_count: priorTexts.length,
    };
    const ownerInputEnv = await mcpCall("substrate.emit", {
      kind: "owner_input_received",
      substrate_origin: "owner",
      directive_id,
      task_id,
      payload: { text: words, directive_text: words, turn_pattern: turnPattern },
    }).catch(() => null);
    const ownerInputId = ownerInputEnv?.ok ? (ownerInputEnv.result as { id?: string })?.id : undefined;
    const cls = classifyOwnerRenderingSignals(words, priorTexts, turnPattern);
    const languageConfidence = cls.language_distribution?.[0]?.confidence ?? cls.confidence;
    if (cls.detected_language) {
      await mcpCall("substrate.emit", {
        kind: "owner_insight_candidate",
        substrate_origin: "claude_root",
        directive_id,
        payload: {
          field: "detected_language",
          value: cls.detected_language,
          confidence: languageConfidence,
          claim: `Detected owner directive language '${cls.detected_language}' from dispatch text.`,
          evidence: cls.evidence,
          turn_pattern: cls.turn_pattern,
          language_distribution: cls.language_distribution ?? [{ lang: cls.detected_language, confidence: cls.confidence, evidence: "legacy_classifier" }],
        },
      }).catch(() => null);
    }
    if (Object.keys(cls.signals).length > 0) {
      // Only emit when at least one signal fired — silent observations
      // pollute the ledger without earning posterior.
      const summary = Object.entries(cls.signals)
        .map(([k, v]) => `${k}=${v.toFixed(2)}`)
        .join(", ");
      await mcpCall("substrate.emit", {
        kind: "owner_insight_candidate",
        substrate_origin: "claude_root",
        directive_id,
        payload: {
          field: "rendering_signals",
          value: cls.signals,
          confidence: cls.confidence,
          claim: `Rendering signals extracted from directive text: ${summary}. Evidence: ${cls.evidence.join("; ")}.`,
          evidence: cls.evidence,
          turn_pattern: cls.turn_pattern,
        },
        context_refs: ownerInputId ? [ownerInputId] : [],
      }).catch(() => null);
    }
  } catch {
    // Classifier failure must not block dispatch. The brain's cycle-1
    // OWNER PROFILE section will just render "no rendering signals
    // recorded yet" and the next directive will retry.
  }

  if (!opts.follow) return 0;
  // Default mode (when invoked under run_in_background:true): stream the
  // narrative event surface as structured one-liners. Each stdout line is
  // one Claude notification — no separate Monitor wiring required. Exits
  // when the ROOT task hits a terminal event (task_committed / task_failed
  // / dispatcher_violation) or --timeout is reached.
  const { runTail } = await import("./observe");
  // Scope by directive_id, not task_id. Brain dispatches spawn sub-tasks
  // with NEW task_ids (refines edges) — filtering by the root task hides
  // every brain frame after the first decomposition. The directive_id
  // is stable across the whole subtree, so this captures the full
  // brain trajectory under one follow stream.
  console.log(`  (following — scoped to directive=${directive_id.slice(0, 16)}…; root-terminal will exit)`);
  return runTail({
    directive: directive_id,
    rootTaskId: task_id,
    // SSE push by default — each event arrives the instant the bus emits.
    stream: true,
    exitOnTerminal: true,
    deadlineMs: opts.timeoutSecs ? Date.now() + opts.timeoutSecs * 1000 : undefined,
  });
};

const daemonStart = async (): Promise<number> => {
  if (auxBaseUrl()) {
    const lock = readDaemonLock();
    console.log(`daemon already running pid=${lock?.pid ?? "?"} mcp=${lock?.port ?? "?"} aux=${lock?.aux_port ?? "?"}`);
    return 0;
  }
  const entry = resolve(import.meta.dirname ?? ".", "..", "runtime", "daemon.ts");
  // PRIOR 2 (never silently fail): pre-fix the daemon spawned with
  // stdio: "ignore", so any startup crash / runtime panic disappeared
  // into /dev/null and operators had no way to diagnose. Now wire
  // stdout/stderr to a rotating file under ${stateDir}/logs so a
  // silent death leaves a trace the operator can tail.
  const fs = await import("node:fs");
  const { resolveStateDir } = await import("../runtime/state_paths");
  const logsDir = `${resolveStateDir()}/logs`;
  try { fs.mkdirSync(logsDir, { recursive: true }); } catch { /* exists */ }
  const logPath = `${logsDir}/daemon.log`;
  const logFd = fs.openSync(logPath, "a");
  const child = spawn("bun", [entry], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env },
  });
  child.unref();
  console.log(`daemon spawn requested (pid=${child.pid}); poll with \`acc daemon status\``);
  console.log(`  logs: ${logPath}`);
  return 0;
};

const daemonStop = async (): Promise<number> => {
  const base = auxBaseUrl();
  if (!base) { console.log("daemon not running"); return 0; }
  const token = readAdminToken();
  if (!token) { console.error("admin token file missing — cannot stop daemon safely"); return 1; }
  // rpcPostAuth applies SHUTDOWN_TIMEOUT_MS (10s) implicitly via the URL
  // resolver — a wedged daemon now fails the CLI fast instead of hanging.
  const reply = await rpcPostAuth<{ ok?: boolean; error?: string }>(`${base}/shutdown`, token, {});
  if (!reply.ok) { console.error(`shutdown refused: ${reply.error}`); return 1; }
  console.log("daemon shutdown requested");
  return 0;
};

const daemonStatus = async (): Promise<number> => {
  const base = auxBaseUrl();
  if (!base) { console.log("daemon not running"); return 1; }
  const health = await rpcGet<Record<string, unknown>>(`${base}/health`);
  console.log(JSON.stringify(health, null, 2));
  return 0;
};

/** Atomic stop+start with readiness polling. Operator workflow: edit
 *  code → `acc daemon restart` → resume work. Returns 0 once the new
 *  daemon's /health surface returns status=ok or 1 on timeout. */
const daemonRestart = async (): Promise<number> => {
  const wasRunning = auxBaseUrl();
  if (wasRunning) {
    const stopCode = await daemonStop();
    if (stopCode !== 0) return stopCode;
    // Poll until the old daemon's lock + port are clear (up to 10s).
    const stopDeadline = Date.now() + 10_000;
    while (Date.now() < stopDeadline) {
      if (!auxBaseUrl()) break;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  // Clean any lingering stale lock from a killed daemon.
  try {
    const { homedir } = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const sock = path.join(homedir(), ".accint", "v2.sock");
    const token = path.join(homedir(), ".accint", "v2.sock.token");
    if (fs.existsSync(sock)) fs.unlinkSync(sock);
    if (fs.existsSync(token)) fs.unlinkSync(token);
  } catch { /* best-effort */ }
  const startCode = await daemonStart();
  if (startCode !== 0) return startCode;
  // Poll until the NEW daemon is ready (up to 30s — boot includes integrity
  // check + worker first-tick).
  const readyDeadline = Date.now() + 30_000;
  while (Date.now() < readyDeadline) {
    try {
      const base = auxBaseUrl();
      if (base) {
        const health = await rpcGet<{ status?: string }>(`${base}/health`).catch(() => null);
        if (health && health.status === "ok") {
          console.log("daemon restart complete (status=ok)");
          return 0;
        }
      }
    } catch { /* poll retry */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error("daemon restart timed out waiting for /health=ok");
  return 1;
};

/** Programmatic entry — exported so dispatch.test.ts can drive it without
 *  shelling out. Returns the process exit code. */
export const runDispatch = async (argv: string[]): Promise<number> => {
  const cmd = argv[0];
  const sub = argv[1];
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(usage());
    return 0;
  }
  if (cmd === "help") {
    const tail = argv.slice(1).join(" ").trim();
    const m = tail.match(/^me\s+with\s+(.+)$/i);
    if (m?.[1]) return dispatchTask(m[1].trim(), { follow: true });
    console.log(usage());
    return 0;
  }
  if (cmd === "init") {
    const { runInit } = await import("./init");
    return runInit(argv.slice(1));
  }
  if (cmd === "task") {
    const rest = argv.slice(1);
    // Follow-mode is the default — the dispatch tail streams events as
    // structured notifications when the orchestrator runs this command
    // with run_in_background:true (each stdout line becomes a Claude
    // notification automatically). Opt OUT with `--no-follow` for the
    // bare directive-open shape (just emit and return).
    const noFollow = rest.includes("--no-follow") || rest.includes("--bare");
    const follow = !noFollow;
    const timeoutIdx = rest.findIndex((x) => x === "--timeout");
    const timeoutSecs = timeoutIdx >= 0 && rest[timeoutIdx + 1]
      ? Number(rest[timeoutIdx + 1]) : undefined;
    const words = rest
      .filter((x, i) =>
        x !== "--follow" &&
        x !== "--no-follow" &&
        x !== "--bare" &&
        x !== "--timeout" &&
        rest[i - 1] !== "--timeout"
      )
      .join(" ").trim();
    if (!words) { console.error("acc task: missing directive text"); return 1; }
    return dispatchTask(words, { follow, timeoutSecs });
  }
  if (cmd === "events" || cmd === "tail" || cmd === "graph" || cmd === "inspect") {
    const { runObserve } = await import("./observe");
    return runObserve(cmd, argv.slice(1));
  }
  if (cmd === "notify") {
    const { runNotify } = await import("./observe");
    return runNotify(argv.slice(1));
  }
  if (cmd === "apply") {
    const { runApply } = await import("./apply");
    return runApply(argv.slice(1));
  }
  if (cmd === "owner") {
    const { runOwnerPolicy } = await import("./owner_policy");
    return runOwnerPolicy(argv.slice(1));
  }
  if (cmd === "trust") {
    const { runTrust } = await import("./trust");
    return runTrust(argv.slice(1));
  }
  if (cmd === "verify") {
    const { runVerify } = await import("./verify");
    return runVerify(argv.slice(1));
  }
  if (cmd === "daemon") {
    if (sub === "start")          return daemonStart();
    if (sub === "stop")           return daemonStop();
    if (sub === "restart" || sub === "reload") return daemonRestart();
    if (sub === "status")         return daemonStatus();
    if (sub === "install-service") {
      const { runServiceInstall } = await import("./service-install");
      return runServiceInstall(argv.slice(2));
    }
    console.error(`acc daemon: unknown subcommand '${sub ?? ""}'. expected: start|stop|status|install-service`);
    return 1;
  }
  if (cmd === "watch") {
    const { runWatch } = await import("./watch");
    return runWatch(argv.slice(1));
  }
  if (cmd === "admin") {
    const { runAdmin } = await import("./admin");
    return runAdmin(argv.slice(1));
  }
  if (cmd === "doctor") {
    const { runDoctor } = await import("./doctor");
    return runDoctor(argv.slice(1));
  }
  if (cmd === "status") {
    const { runStatus } = await import("./status");
    return runStatus(argv.slice(1));
  }
  if (cmd === "directive") {
    const { runDirective } = await import("./directive");
    return runDirective(argv.slice(1));
  }
  console.error(`acc: unknown command '${cmd}'`);
  console.error(usage());
  return 1;
};

if (import.meta.main) {
  void runDispatch(process.argv.slice(2)).then((code) => process.exit(code));
}

// Verify await import compatibility (silences unused-warning if any tooling flags it).
void requireAux;
