// `acc admin <sub>` — operator-side maintenance namespace. First three
// subcommands ship with Batch 2.γ:
//
//   acc admin opencode-version          Print current + latest opencode version.
//   acc admin update-opencode [--yes]   Upgrade opencode to the latest version.
//   acc admin upgrade-check             Check if any subsystem has an update available.
//
// The daemon is stopped before an upgrade (if running) and restarted after,
// because opencode is the brain subprocess and upgrading a live binary while
// the daemon may dispatch through it is unsafe.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline";
import { openDb } from "../substrate/db";
import {
  checkLatestOpencodeVersion,
  compareSemver,
  defaultVersionEnv,
  detectOpencodeVersion,
  updateOpencode,
  type VersionEnv,
} from "../runtime/opencode_version";
import {
  auxBaseUrl, readAdminToken, readDaemonLock,
  rpcPostAuth,
} from "./rpc";

const usage = (): string => `acc admin — operator-side maintenance

  acc admin opencode-version          Print current + latest opencode version.
  acc admin update-opencode [--yes]   Upgrade opencode to latest (prompts unless --yes).
  acc admin upgrade-check             Show which subsystems (opencode / camoufox / uv / bun) have updates.
`;

// ── Shared types ─────────────────────────────────────────────────────

export type AdminEnv = {
  version: VersionEnv;
  /** Stop the daemon if it is running. Returns true if the daemon was
   *  running (so the caller knows to restart it after the upgrade). */
  stopDaemon: () => Promise<boolean>;
  /** Detached respawn of the daemon. */
  startDaemon: () => Promise<void>;
  /** Read line from stdin for interactive prompts (--yes bypasses). */
  prompt: (q: string) => Promise<string>;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Used by `update-opencode --yes` to override the prompt path. */
  yes: boolean;
};

// Real daemon-control implementations.

const realStopDaemon = async (): Promise<boolean> => {
  const base = auxBaseUrl();
  if (!base) return false;
  const token = readAdminToken();
  if (!token) return false;
  try {
    const reply = await rpcPostAuth<{ ok?: boolean }>(`${base}/shutdown`, token, {});
    return Boolean(reply.ok);
  } catch {
    return false;
  }
};

const realStartDaemon = async (): Promise<void> => {
  if (auxBaseUrl()) return; // already running
  const entry = resolve(import.meta.dirname ?? ".", "..", "runtime", "daemon.ts");
  const child = spawn("bun", [entry], { detached: true, stdio: "ignore", env: { ...process.env } });
  child.unref();
};

const realPrompt = async (q: string): Promise<string> => {
  return new Promise((resolveLine) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (answer) => { rl.close(); resolveLine(answer); });
  });
};

const defaultAdminEnv = (yes: boolean): AdminEnv => ({
  version: defaultVersionEnv(),
  stopDaemon: realStopDaemon,
  startDaemon: realStartDaemon,
  prompt: realPrompt,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  yes,
});

// ── opencode-version ─────────────────────────────────────────────────

export const runOpencodeVersion = async (env: AdminEnv): Promise<number> => {
  const current = await detectOpencodeVersion(env.version);
  if (!current.binaryExists) {
    env.err(`opencode not installed (not on PATH)`);
    env.err(`install: https://github.com/sst/opencode`);
    return 1;
  }
  env.out(`current: ${current.version} (${current.installMethod}) at ${current.installPath}`);
  const latest = await checkLatestOpencodeVersion(env.version);
  if (!latest) {
    env.out(`latest:  unknown (could not reach api.github.com — set GITHUB_TOKEN if rate-limited)`);
    return 0;
  }
  env.out(`latest:  ${latest.version} (released ${latest.releasedAt || "?"})`);
  const cmp = compareSemver(current.version, latest.version);
  if (cmp < 0) {
    env.out(`status:  upgrade available (run \`acc admin update-opencode\`)`);
  } else if (cmp === 0) {
    env.out(`status:  up to date`);
  } else {
    env.out(`status:  ahead of latest (dev build?)`);
  }
  return 0;
};

// ── update-opencode ──────────────────────────────────────────────────

export const runUpdateOpencode = async (env: AdminEnv): Promise<number> => {
  const current = await detectOpencodeVersion(env.version);
  if (!current.binaryExists) {
    env.err(`opencode not installed; nothing to upgrade. Install from https://github.com/sst/opencode`);
    return 1;
  }
  const latest = await checkLatestOpencodeVersion(env.version);
  if (!latest) {
    env.err(`could not check latest opencode version (network or GitHub rate-limit)`);
    return 1;
  }
  const cmp = compareSemver(current.version, latest.version);
  if (cmp >= 0) {
    env.out(`opencode ${current.version} is already current (latest = ${latest.version}); nothing to do`);
    return 0;
  }
  // Prompt unless --yes.
  if (!env.yes) {
    const answer = (await env.prompt(`Upgrade opencode from ${current.version} to ${latest.version}? [Y/n] `)).trim().toLowerCase();
    if (answer === "n" || answer === "no") {
      env.out(`upgrade cancelled`);
      return 0;
    }
  }
  // Stop daemon first if running.
  const wasRunning = await env.stopDaemon();
  if (wasRunning) {
    env.out(`daemon stopped before upgrade; will restart after`);
    // Brief settle window so the socket file is released.
    await new Promise((r) => setTimeout(r, 500));
  }
  // Open the substrate DB so events land even when the daemon is down.
  const stateDb = process.env.ACC2_STATE_DB
    ?? resolve(import.meta.dirname ?? ".", "..", "state", "accint.db");
  const db = existsSync(stateDb) ? openDb(stateDb) : undefined;
  env.out(`upgrading opencode (${current.installMethod})…`);
  const result = await updateOpencode({ env: env.version, db });
  if (wasRunning) await env.startDaemon();
  if (!result.ok) {
    env.err(`upgrade failed: ${result.reason}`);
    env.err(result.detail.split("\n").slice(0, 6).join("\n"));
    return 1;
  }
  env.out(`opencode upgraded: ${result.from} → ${result.to} (${result.durationMs}ms)`);
  if (wasRunning) env.out(`daemon restart requested; poll with \`acc daemon status\``);
  return 0;
};

// ── upgrade-check ────────────────────────────────────────────────────

type SubsystemStatus = {
  name: string;
  installed: string;
  latest?: string;
  updateAvailable: boolean;
  detail: string;
};

export const runUpgradeCheck = async (env: AdminEnv): Promise<number> => {
  const reports: SubsystemStatus[] = [];

  // opencode
  const current = await detectOpencodeVersion(env.version);
  if (current.binaryExists) {
    const latest = await checkLatestOpencodeVersion(env.version);
    const updateAvailable = latest != null && compareSemver(current.version, latest.version) < 0;
    reports.push({
      name: "opencode",
      installed: current.version,
      latest: latest?.version,
      updateAvailable,
      detail: updateAvailable
        ? `upgrade via \`acc admin update-opencode\``
        : (latest ? "up to date" : "could not check"),
    });
  } else {
    reports.push({
      name: "opencode",
      installed: "missing",
      updateAvailable: false,
      detail: "install from https://github.com/sst/opencode",
    });
  }

  // bun
  const bun = env.version.spawn("bun", ["--version"]);
  if (bun.status === 0) {
    const v = (bun.stdout || "").split("\n")[0]!.trim();
    reports.push({
      name: "bun",
      installed: v,
      updateAvailable: false,
      detail: "upgrade with `bun upgrade`",
    });
  } else {
    reports.push({ name: "bun", installed: "missing", updateAvailable: false, detail: "install from https://bun.sh" });
  }

  // uv
  const uvProbe = env.version.spawn("uv", ["--version"]);
  if (uvProbe.status === 0) {
    const v = (uvProbe.stdout || "").split("\n")[0]!.trim();
    reports.push({
      name: "uv",
      installed: v,
      updateAvailable: false,
      detail: "upgrade with `uv self update`",
    });
  } else {
    reports.push({ name: "uv", installed: "missing", updateAvailable: false, detail: "optional; install from https://github.com/astral-sh/uv" });
  }

  // camoufox — binary check only (versions are bundled with the binary).
  const explicit = process.env.CAMOUFOX_BINARY_PATH;
  const cached = join(homedir(), ".cache", "camoufox", "camoufox");
  const camoPath = explicit && existsSync(explicit) ? explicit : (existsSync(cached) ? cached : null);
  if (camoPath) {
    reports.push({
      name: "camoufox",
      installed: "present",
      updateAvailable: false,
      detail: `at ${camoPath}; refresh with \`python -m camoufox fetch\``,
    });
  } else {
    reports.push({
      name: "camoufox",
      installed: "missing",
      updateAvailable: false,
      detail: "optional; download from https://github.com/daijro/camoufox/releases",
    });
  }

  // Render table.
  env.out(`acc admin upgrade-check — subsystem versions`);
  env.out(`─────────────────────────────────────────────`);
  const nameW = Math.max(...reports.map((r) => r.name.length));
  const installedW = Math.max(...reports.map((r) => r.installed.length));
  for (const r of reports) {
    const flag = r.updateAvailable ? "[UPGRADE]" : "[ok    ]";
    const latest = r.latest ? ` → ${r.latest}` : "";
    env.out(`${flag} ${r.name.padEnd(nameW)}  ${r.installed.padEnd(installedW)}${latest}  ${r.detail}`);
  }
  env.out(`─────────────────────────────────────────────`);
  const anyAvailable = reports.some((r) => r.updateAvailable);
  if (anyAvailable) {
    env.out(`updates available; run the listed command(s)`);
    return 0;
  }
  env.out(`all subsystems current`);
  return 0;
};

// ── Programmatic entry ───────────────────────────────────────────────

export const runAdmin = async (argv: string[], envOverride?: AdminEnv): Promise<number> => {
  const sub = argv[0];
  const flags = new Set(argv.slice(1));
  const yes = flags.has("--yes") || flags.has("-y");
  const env = envOverride ?? defaultAdminEnv(yes);
  if (envOverride && yes) env.yes = true; // honour --yes even with injected env

  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    env.out(usage());
    return 0;
  }
  if (sub === "opencode-version") return runOpencodeVersion(env);
  if (sub === "update-opencode") return runUpdateOpencode(env);
  if (sub === "upgrade-check") return runUpgradeCheck(env);
  env.err(`acc admin: unknown subcommand '${sub}'`);
  env.err(usage());
  return 1;
};

if (import.meta.main) {
  void runAdmin(process.argv.slice(2)).then((code) => process.exit(code));
}

// Mark the realDaemonLock import as referenced (used in some test paths).
void readDaemonLock;
void spawnSync;
