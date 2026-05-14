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
  acc task "<owner words>"        Open a directive; the substrate dispatches the brain.
  acc daemon start                Spawn the daemon detached if not running.
  acc daemon stop                 Auth-gated shutdown via admin token.
  acc daemon status               GET /health on the running daemon.
  acc daemon install-service      Write systemd unit (Linux) / launchd plist (macOS).
  acc watch                       Live TUI subscribing to the daemon's event stream.
  acc admin <sub>                 Operator maintenance (update-opencode, opencode-version, ...).
  acc doctor                      Multi-check readiness report.
`;

const dispatchTask = async (words: string): Promise<number> => {
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
  return 0;
};

const daemonStart = async (): Promise<number> => {
  if (auxBaseUrl()) {
    const lock = readDaemonLock();
    console.log(`daemon already running pid=${lock?.pid ?? "?"} mcp=${lock?.port ?? "?"} aux=${lock?.aux_port ?? "?"}`);
    return 0;
  }
  const entry = resolve(import.meta.dirname ?? ".", "..", "runtime", "daemon.ts");
  const child = spawn("bun", [entry], { detached: true, stdio: "ignore", env: { ...process.env } });
  child.unref();
  console.log(`daemon spawn requested (pid=${child.pid}); poll with \`acc daemon status\``);
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

/** Programmatic entry — exported so dispatch.test.ts can drive it without
 *  shelling out. Returns the process exit code. */
export const runDispatch = async (argv: string[]): Promise<number> => {
  const cmd = argv[0];
  const sub = argv[1];
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(usage());
    return 0;
  }
  if (cmd === "init") {
    const { runInit } = await import("./init");
    return runInit(argv.slice(1));
  }
  if (cmd === "task") {
    const words = argv.slice(1).join(" ").trim();
    if (!words) { console.error("acc task: missing directive text"); return 1; }
    return dispatchTask(words);
  }
  if (cmd === "daemon") {
    if (sub === "start")          return daemonStart();
    if (sub === "stop")           return daemonStop();
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
  console.error(`acc: unknown command '${cmd}'`);
  console.error(usage());
  return 1;
};

if (import.meta.main) {
  void runDispatch(process.argv.slice(2)).then((code) => process.exit(code));
}

// Verify await import compatibility (silences unused-warning if any tooling flags it).
void requireAux;
