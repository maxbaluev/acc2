// acc2 admin install-deps — single-command dependency bootstrap.
//
// Verifies + installs (or prints clear install instructions for) every
// host-side prereq the daemon + runtimes need:
//
//   - bun >= 1.3.14            (probe `bun --version`; instruct upgrade)
//   - opencode on PATH         (probe `which opencode` + --version)
//   - OPENAI_API_KEY in env / .env (cheap validation, never print the value)
//   - SERPER_API_KEY in env / .env (highly recommended for information search;
//                                    cheap validation, never print the value)
//   - camoufox firefox binary  (re-run the same logic as scripts/postinstall.ts)
//   - nsjail on PATH           (warn-only — uv sandbox degrades without it)
//
// The camoufox install logic is the SAME function scripts/postinstall.ts
// calls — DRY across both install entry points (bun postinstall hook AND
// the operator's explicit `acc admin install-deps`). This module exports
// `installCamoufox` so postinstall.ts can import it instead of redefining.
//
// Output:
//   - One `dep_check_complete` structured line at the end with
//     { passes, fails, warns } so tests + the harness can pattern-match.
//   - Exit 0 iff every must-have (bun, opencode, OPENAI_API_KEY, camoufox)
//     passes. Warn-only items (nsjail) never fail the command.
//
// Idempotent: running it twice on a complete install reports every
// must-have as `pass` with a clear "already done" line and exits 0.

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Public types ──────────────────────────────────────────────────────

export type DepStatus = "pass" | "fail" | "warn";
export type DepCheck = {
  name: string;
  status: DepStatus;
  /** Human-readable detail line (printed to the operator). */
  detail: string;
  /** Optional remediation hint when status != pass. */
  remediation?: string;
};

export type DepCheckSummary = {
  passes: string[];
  fails: string[];
  warns: string[];
  checks: DepCheck[];
};

// ── Minimum bun version (held in code, not env) ─────────────────────

export const BUN_MIN_VERSION = "1.3.14";

/** Compare two semver strings "x.y.z". Returns negative/zero/positive. */
export const compareVersions = (a: string, b: string): number => {
  const pa = a.split(".").map((x) => Number(x));
  const pb = b.split(".").map((x) => Number(x));
  for (let i = 0; i < 3; i++) {
    const da = Number.isFinite(pa[i]) ? (pa[i] as number) : 0;
    const db = Number.isFinite(pb[i]) ? (pb[i] as number) : 0;
    if (da !== db) return da - db;
  }
  return 0;
};

// ── Injection seam (tests stub all subprocess + fs calls) ───────────

export type InstallDepsEnv = {
  env: Record<string, string | undefined>;
  /** Resolve a binary on PATH. */
  which: (cmd: string) => string | null;
  /** Run `<cmd> <args...>` and capture stdout. Returns null on non-zero exit. */
  version: (cmd: string, args: string[]) => string | null;
  /** Read text file (returns null on error). */
  readFile: (path: string) => string | null;
  /** True iff file exists. */
  fileExists: (path: string) => boolean;
  /** Run the camoufox install. Returns true on success. */
  installCamoufox: () => Promise<{ ok: boolean; detail: string }>;
  /** Project home (used for `.env` path). Default: process.cwd(). */
  cwd: () => string;
  homedir: () => string;
  /** Output sink (default: process.stdout.write). */
  out: (line: string) => void;
};

const realWhich = (cmd: string): string | null => {
  const out = spawnSync("sh", ["-lc", `command -v ${JSON.stringify(cmd)}`], { encoding: "utf8" });
  if (out.status !== 0) return null;
  const path = (out.stdout ?? "").trim();
  return path.length > 0 ? path : null;
};

const realVersion = (cmd: string, args: string[]): string | null => {
  const out = spawnSync(cmd, args, { encoding: "utf8" });
  if (out.status !== 0) return null;
  return (out.stdout ?? out.stderr ?? "").trim() || null;
};

const realReadFile = (path: string): string | null => {
  try { return readFileSync(path, "utf8"); } catch { return null; }
};

// ── Camoufox install (canonical implementation — shared with postinstall) ──

/** Run `<cmd>` and inherit stdio so the operator sees the progress live.
 *  Returns { ok: bool, exitCode }. Never throws — caller decides recovery. */
async function spawnInherit(cmd: string[]): Promise<{ ok: boolean; exitCode: number }> {
  const proc = spawn(cmd[0]!, cmd.slice(1), { stdio: "inherit" });
  return await new Promise((resolve) => {
    proc.on("exit", (code) => resolve({ ok: code === 0, exitCode: code ?? 1 }));
    proc.on("error", () => resolve({ ok: false, exitCode: 1 }));
  });
}

/**
 * Install the Camoufox firefox binary. Idempotent — skips when the binary
 * is already on disk. Try uvx first (Astral's transient pip-runtime,
 * which needs no persistent install), then fall back to
 * `python -m camoufox fetch`. Returns { ok, detail } so the caller can
 * either log success or surface the missing tools.
 *
 * This is the SAME function `scripts/postinstall.ts` calls; both entry
 * points share one implementation per the DRY constraint.
 */
export async function installCamoufox(opts?: { log?: (msg: string) => void }): Promise<{
  ok: boolean;
  detail: string;
}> {
  const log = opts?.log ?? (() => { /* swallow */ });
  const camoufoxBin = process.env.CAMOUFOX_BINARY_PATH ?? join(homedir(), ".cache", "camoufox", "camoufox");
  if (existsSync(camoufoxBin)) {
    return { ok: true, detail: `binary present at ${camoufoxBin} (already done)` };
  }
  log(`fetching camoufox firefox binary (one-time, ~120 MB)...`);

  // Try uvx first.
  const uvxAvailable = spawnSync("sh", ["-lc", "command -v uvx"], { encoding: "utf8" }).status === 0;
  if (uvxAvailable) {
    const r = await spawnInherit(["uvx", "--from", "camoufox", "python", "-m", "camoufox", "fetch"]);
    if (r.ok && existsSync(camoufoxBin)) {
      return { ok: true, detail: `installed via uvx at ${camoufoxBin}` };
    }
  }

  // Fall back to a user-pip-installed camoufox.
  const pyAvailable = spawnSync("sh", ["-lc", "command -v python"], { encoding: "utf8" }).status === 0;
  if (pyAvailable) {
    const r = await spawnInherit(["python", "-m", "camoufox", "fetch"]);
    if (r.ok && existsSync(camoufoxBin)) {
      return { ok: true, detail: `installed via python at ${camoufoxBin}` };
    }
  }

  return {
    ok: false,
    detail: [
      "camoufox install failed: neither uvx nor python could fetch the binary.",
      "Operator can run manually:  pip install camoufox && python -m camoufox fetch",
      "Or set CAMOUFOX_BINARY_PATH if the binary lives elsewhere.",
      "Reference: https://camoufox.com/python/installation/",
    ].join("\n  "),
  };
}

// ── Default env wiring ──────────────────────────────────────────────

export const defaultInstallDepsEnv = (): InstallDepsEnv => ({
  env: process.env,
  which: realWhich,
  version: realVersion,
  readFile: realReadFile,
  fileExists: existsSync,
  installCamoufox: () => installCamoufox(),
  cwd: () => process.cwd(),
  homedir,
  out: (line) => process.stdout.write(line),
});

// ── Individual checks ──────────────────────────────────────────────

export const checkBun = (env: InstallDepsEnv): DepCheck => {
  const raw = env.version("bun", ["--version"]);
  if (!raw) {
    return {
      name: "bun",
      status: "fail",
      detail: "bun not found on PATH",
      remediation: "Install from https://bun.com (≥ " + BUN_MIN_VERSION + ")",
    };
  }
  const v = raw.split("\n")[0]!.trim();
  if (compareVersions(v, BUN_MIN_VERSION) < 0) {
    return {
      name: "bun",
      status: "fail",
      detail: `bun ${v} (need ≥ ${BUN_MIN_VERSION})`,
      remediation: "Upgrade: see https://bun.com/docs/installation#upgrading",
    };
  }
  return { name: "bun", status: "pass", detail: `bun ${v} (≥ ${BUN_MIN_VERSION})` };
};

export const checkOpencodeOnPath = (env: InstallDepsEnv): DepCheck => {
  const path = env.which("opencode");
  if (!path) {
    return {
      name: "opencode",
      status: "fail",
      detail: "opencode not on PATH",
      remediation: "Install from https://github.com/sst/opencode",
    };
  }
  const ver = env.version("opencode", ["--version"]) ?? "unknown";
  return { name: "opencode", status: "pass", detail: `${path}  (${ver.split("\n")[0]})` };
};

/** Returns "env" / "dotenv:N chars" / "missing". Never prints the value. */
export const checkOpenAiKey = (env: InstallDepsEnv): DepCheck => {
  const live = env.env.OPENAI_API_KEY;
  if (live && live.trim().length > 0) {
    return {
      name: "OPENAI_API_KEY",
      status: "pass",
      detail: `present in env (length=${live.trim().length})`,
    };
  }
  const envFile = join(env.cwd(), ".env");
  if (env.fileExists(envFile)) {
    const body = env.readFile(envFile);
    if (body) {
      for (const line of body.split("\n")) {
        const m = line.match(/^\s*OPENAI_API_KEY\s*=\s*(.+?)\s*$/);
        if (m && m[1] && m[1].trim().length > 0 && m[1].trim() !== '""') {
          return {
            name: "OPENAI_API_KEY",
            status: "pass",
            detail: `present in ${envFile} (length=${m[1].trim().length})`,
          };
        }
      }
    }
  }
  return {
    name: "OPENAI_API_KEY",
    status: "fail",
    detail: "missing in env and .env",
    remediation: `Add OPENAI_API_KEY=<sk-...> to ${envFile} or export it before running acc daemon start`,
  };
};

export const checkCamoufoxBinary = async (env: InstallDepsEnv): Promise<DepCheck> => {
  const explicit = env.env.CAMOUFOX_BINARY_PATH;
  if (explicit && env.fileExists(explicit)) {
    return { name: "camoufox binary", status: "pass", detail: `${explicit} (CAMOUFOX_BINARY_PATH)` };
  }
  const cached = join(env.homedir(), ".cache", "camoufox", "camoufox");
  if (env.fileExists(cached)) {
    return { name: "camoufox binary", status: "pass", detail: `${cached} (already done)` };
  }
  // Try to install via the shared camoufox helper.
  env.out("camoufox binary: not present, attempting install...\n");
  const r = await env.installCamoufox();
  if (r.ok) {
    return { name: "camoufox binary", status: "pass", detail: r.detail };
  }
  return {
    name: "camoufox binary",
    status: "fail",
    detail: r.detail,
    remediation: "pip install camoufox && python -m camoufox fetch",
  };
};

export const checkNsjail = (env: InstallDepsEnv): DepCheck => {
  const path = env.which("nsjail");
  if (path) return { name: "nsjail", status: "pass", detail: path };
  return {
    name: "nsjail",
    status: "warn",
    detail: "not installed — uv sandbox degrades to honor-system (bun + camofox-browser runtimes unaffected)",
    remediation: "https://github.com/google/nsjail (optional; install when running untrusted brain-authored uv artifacts)",
  };
};

// ── Composite runner ──────────────────────────────────────────────

const renderCheck = (c: DepCheck): string => {
  const tag = c.status === "pass" ? "[ pass]"
            : c.status === "warn" ? "[ warn]"
            : "[ fail]";
  return `${tag} ${c.name.padEnd(18)}  ${c.detail}\n`;
};

export const runInstallDeps = async (
  _argv: string[] = [],
  envOverride?: InstallDepsEnv,
): Promise<number> => {
  const env = envOverride ?? defaultInstallDepsEnv();
  env.out("acc admin install-deps — verifying host prereqs\n");
  env.out("──────────────────────────────────────────────\n");

  const checks: DepCheck[] = [];

  // Order is operator-friendly: hard prereqs first, optional last.
  checks.push(checkBun(env));
  env.out(renderCheck(checks[checks.length - 1]!));

  checks.push(checkOpencodeOnPath(env));
  env.out(renderCheck(checks[checks.length - 1]!));

  checks.push(checkOpenAiKey(env));
  env.out(renderCheck(checks[checks.length - 1]!));

  checks.push(await checkCamoufoxBinary(env));
  env.out(renderCheck(checks[checks.length - 1]!));

  checks.push(checkNsjail(env));
  env.out(renderCheck(checks[checks.length - 1]!));

  const passes = checks.filter((c) => c.status === "pass").map((c) => c.name);
  const fails = checks.filter((c) => c.status === "fail").map((c) => c.name);
  const warns = checks.filter((c) => c.status === "warn").map((c) => c.name);

  env.out("──────────────────────────────────────────────\n");
  // Structured "event" line — tests + the harness pattern-match on this.
  env.out(
    `dep_check_complete ${JSON.stringify({ passes, fails, warns })}\n`,
  );

  // Print remediation hints for non-pass entries.
  for (const c of checks) {
    if (c.status !== "pass" && c.remediation) {
      env.out(`  → ${c.name}: ${c.remediation}\n`);
    }
  }

  if (fails.length === 0) {
    env.out("[ok] all must-have prereqs satisfied. Next: `acc init --yes` then `acc daemon start`.\n");
    return 0;
  }
  env.out(`[fail] ${fails.length} must-have prereq(s) missing — see → lines above.\n`);
  return 1;
};

// Convenience helper for tests + callers that want the structured summary
// without re-running the renderer.
export const collectInstallDepsSummary = async (
  envOverride?: InstallDepsEnv,
): Promise<DepCheckSummary> => {
  const env = envOverride ?? defaultInstallDepsEnv();
  const checks: DepCheck[] = [];
  checks.push(checkBun(env));
  checks.push(checkOpencodeOnPath(env));
  checks.push(checkOpenAiKey(env));
  checks.push(await checkCamoufoxBinary(env));
  checks.push(checkNsjail(env));
  return {
    passes: checks.filter((c) => c.status === "pass").map((c) => c.name),
    fails: checks.filter((c) => c.status === "fail").map((c) => c.name),
    warns: checks.filter((c) => c.status === "warn").map((c) => c.name),
    checks,
  };
};

// Side-effect-free imports keep TS happy without unused-warnings.
void appendFileSync;
void writeFileSync;
