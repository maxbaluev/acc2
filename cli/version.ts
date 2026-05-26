// `acc version` — print the installed acc2 version (from package.json) plus,
// when a daemon is running, the commit it has loaded (loaded_git_head from
// /health). Distribution surface per the operator-install / UPDATING flow:
// an operator can see at a glance which release the source tree is at AND
// which commit the live daemon is actually serving — the two can diverge
// between a `git pull` and a daemon restart.
//
// Read-only. Never opens SQLite directly; the daemon truth comes through the
// same /health aux-port surface every other CLI read uses.

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { auxBaseUrl, rpcGet } from "./rpc";
import { probeCamofoxAvailability } from "../runtime/runtimes/camofox";
import { resolveDbPath } from "../runtime/state_paths";
import { openDb, closeDb } from "../substrate/db";
import { inspectPendingMigrations } from "../substrate/migration_runner";

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

export const readSourceGitHead = (): string | null => {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  return (r.stdout ?? "").trim() || null;
};

export const readStateSchemaSnapshot = (): { db_path: string; latest_version: string | null; pending_versions: string[] } => {
  const dbPath = resolveDbPath();
  if (!existsSync(dbPath)) return { db_path: dbPath, latest_version: null, pending_versions: [] };
  const db = openDb(dbPath);
  try {
    const m = inspectPendingMigrations(db);
    return { db_path: dbPath, latest_version: m.latest_version, pending_versions: m.pending_versions };
  } finally {
    closeDb(dbPath);
  }
};

const toolVersion = (cmd: string, args: string[] = ["--version"]): string | null => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) return null;
  return ((r.stdout || r.stderr) ?? "").split("\n")[0]!.trim() || null;
};

export const runVersion = async (argv: string[]): Promise<number> => {
  const json = argv.includes("--json");
  const version = readPackageVersion();
  const daemonHead = await readDaemonGitHead();
  const sourceHead = readSourceGitHead();
  const schema = readStateSchemaSnapshot();
  // camoufox availability mirrors the runtime probe (binary at the default
  // ~/.cache path OR CAMOUFOX_BINARY_PATH, plus playwright) — not the env var
  // alone, so `acc version` agrees with `acc admin install-deps` and the live
  // runtime resolver instead of falsely reporting "missing" for a fetched binary.
  const camofoxProbe = probeCamofoxAvailability();
  const tools = { bun: toolVersion("bun"), opencode: toolVersion("opencode"), uv: toolVersion("uv"), nsjail: toolVersion("nsjail", ["--version"]), camoufox: camofoxProbe.ok ? (camofoxProbe.executable ?? "present") : null };

  if (json) {
    console.log(JSON.stringify({
      version,
      daemon_running: daemonHead !== null,
      daemon_loaded_git_head: daemonHead,
      source_git_head: sourceHead,
      state_schema: schema,
      tools,
    }, null, 2));
    return 0;
  }

  console.log(`acc2 ${version}`);
  console.log(`  source git_head: ${sourceHead ?? "unknown"}`);
  if (daemonHead) {
    console.log(`  daemon loaded_git_head: ${daemonHead}`);
    if (sourceHead && sourceHead !== daemonHead) console.log("  skew: daemon is not serving current source; run `acc update`");
  } else {
    console.log(`  daemon: not running (start with \`acc daemon start\`)`);
  }
  console.log(`  state schema: ${schema.latest_version ?? "none"}; pending=${schema.pending_versions.length}`);
  console.log(`  tools: bun=${tools.bun ?? "missing"} opencode=${tools.opencode ?? "missing"} uv=${tools.uv ?? "missing"} camoufox=${tools.camoufox ? "present" : "missing"} nsjail=${tools.nsjail ?? "missing"}`);
  return 0;
};
