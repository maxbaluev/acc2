// `acc version` — print the installed acc2 version (from package.json) plus,
// when a daemon is running, the commit it has loaded (loaded_git_head from
// /health). Distribution surface per the operator-install / UPDATING flow:
// an operator can see at a glance which release the source tree is at AND
// which commit the live daemon is actually serving — the two can diverge
// between a `git pull` and a daemon restart.
//
// Read-only. Never opens SQLite directly; the daemon truth comes through the
// same /health aux-port surface every other CLI read uses.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { auxBaseUrl, rpcGet } from "./rpc";

/** The shipped semver, read once from the package manifest at module load.
 *  Single source of truth — bump package.json `version` and every surface
 *  (this command, any future telemetry) follows. */
export const readPackageVersion = (): string => {
  try {
    const pkgPath = resolve(import.meta.dirname ?? ".", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version && pkg.version.trim().length > 0 ? pkg.version.trim() : "unknown";
  } catch {
    return "unknown";
  }
};

/** Probe the running daemon's loaded git HEAD (the commit it booted from).
 *  Returns null when no daemon is reachable — the version surface degrades
 *  to "source-tree version only" rather than failing. */
export const readDaemonGitHead = async (): Promise<string | null> => {
  const base = auxBaseUrl();
  if (!base) return null;
  try {
    const health = await rpcGet<{ loaded_git_head?: string | null }>(`${base}/health`);
    const head = health?.loaded_git_head;
    return typeof head === "string" && head.trim().length > 0 ? head.trim() : null;
  } catch {
    return null;
  }
};

export const runVersion = async (argv: string[]): Promise<number> => {
  const json = argv.includes("--json");
  const version = readPackageVersion();
  const daemonHead = await readDaemonGitHead();

  if (json) {
    console.log(JSON.stringify({
      version,
      daemon_running: daemonHead !== null,
      daemon_loaded_git_head: daemonHead,
      compatibility: {
        cli_package_version: version,
        daemon_loaded_git_head: daemonHead,
        // version.ts stays read-only / never opens SQLite — these two fields
        // name the canonical probes the operator runs for the full picture
        // rather than duplicating those surfaces here.
        state_schema: "probe via listPendingMigrations(openDb(resolveDbPath()))",
        external_tools: "doctor-compatible snapshot: bun/opencode/uv/camoufox/nsjail",
      },
    }, null, 2));
    return 0;
  }

  console.log(`acc2 ${version}`);
  if (daemonHead) {
    console.log(`  daemon loaded_git_head: ${daemonHead}`);
  } else {
    console.log(`  daemon: not running (start with \`acc daemon start\`)`);
  }
  return 0;
};
