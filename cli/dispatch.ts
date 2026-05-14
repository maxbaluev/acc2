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

  acc task "<owner words>"       Open a directive; brain pickup is Phase D.
  acc daemon start                Spawn the daemon detached if not running.
  acc daemon stop                 Auth-gated shutdown via admin token.
  acc daemon status               GET /health on the running daemon.
  acc doctor                      See cli/doctor.ts.
`;

const dispatchTask = async (words: string): Promise<number> => {
  let env;
  try {
    env = await mcpCall("substrate.emit", {
      kind: "directive_opened",
      substrate_origin: "owner",
      payload: { text: words },
    });
  } catch (err) {
    console.error(`acc task failed: ${(err as Error).message}`);
    return 1;
  }
  if (!env.ok) {
    console.error(`acc task failed: ${env.error}`);
    return 1;
  }
  const { id, ts } = env.result as { id: string; ts: string };
  console.log(`directive_opened ${id} (ts=${ts})`);
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
  if (cmd === "task") {
    const words = argv.slice(1).join(" ").trim();
    if (!words) { console.error("acc task: missing directive text"); return 1; }
    return dispatchTask(words);
  }
  if (cmd === "daemon") {
    if (sub === "start")  return daemonStart();
    if (sub === "stop")   return daemonStop();
    if (sub === "status") return daemonStatus();
    console.error(`acc daemon: unknown subcommand '${sub ?? ""}'. expected: start|stop|status`);
    return 1;
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
