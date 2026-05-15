// acc2 opencode version-adaptation subsystem — detect the installed opencode
// version, check for newer releases on GitHub, and run an in-place upgrade
// using the install method that produced the binary. Trajectory of every
// upgrade is auditable on the substrate via three new event kinds:
//   - opencode_upgrade_started
//   - opencode_upgrade_completed
//   - opencode_upgrade_failed
//
// Why this module exists: Batch 2.α's real-brain smoke run hit
// `ProviderModelNotFoundError` for `openai/gpt-5-mini` because opencode 1.4.3
// renamed the model id. Version-driven breakage will recur as opencode
// evolves; v2 needs a first-class way to keep opencode current AND a bridge
// surface that is resilient to opencode's evolution. This is the version
// half — bridge.ts owns the adaptation half (Batch 2.β scope).
//
// Design notes:
//   - All subprocess + filesystem + network calls go through an injectable
//     `VersionEnv` shim (mirrors cli/doctor.ts:DoctorEnv). Production wires
//     real implementations; tests inject hermetic stubs.
//   - The GitHub release fetch is cached for 1 hour at
//     ~/.accint/state/cache/opencode-latest.json to avoid GitHub anonymous
//     rate-limit (60 req/h/IP). Honours GITHUB_TOKEN if set.
//   - Install-method detection inspects the resolved binary path:
//       /.opencode/bin       → official-script
//       /node_modules/.bin   → npm (also matched when `npm list -g` confirms)
//       /.bun/install/global → bun
//       (otherwise)          → manual / unknown
//   - updateOpencode dispatches the correct upgrade command per method.
//     manual/unknown returns ok:false with reason="permission_denied" — we
//     refuse to run a scripted upgrade on a binary we did not place.

import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { emitEvent } from "./events";

export type OpencodeInstallMethod =
  | "official-script"
  | "npm"
  | "bun"
  | "manual"
  | "unknown";

export type OpencodeVersion = {
  /** Parsed semver string, e.g. "1.4.3". "unknown" if `opencode --version`
   *  was unparseable. */
  version: string;
  /** Resolved absolute path from `command -v opencode`. Empty string if
   *  not on PATH. */
  installPath: string;
  /** Inferred install method — drives the upgrade command. */
  installMethod: OpencodeInstallMethod;
  /** True iff `installPath` exists on disk. */
  binaryExists: boolean;
};

export type LatestRelease = {
  /** Tag stripped of the leading `v`, e.g. "1.4.4". */
  version: string;
  /** GitHub `published_at` (ISO 8601). */
  releasedAt: string;
  /** Permalink to the release page. */
  releaseUrl: string;
  /** Truncated body (≤ 4000 chars) so the cache file stays small. */
  releaseNotes?: string;
};

export type UpdateResult =
  | { ok: true; from: string; to: string; durationMs: number }
  | {
      ok: false;
      reason:
        | "auth_required"
        | "network_error"
        | "install_failed"
        | "permission_denied"
        | "no_update_available";
      detail: string;
    };

/** Environment shim — injected by tests, defaulted to real I/O. */
export type VersionEnv = {
  which: (cmd: string) => string | null;
  /** Spawn synchronously, return { status, stdout, stderr }. */
  spawn: (cmd: string, args: string[], opts?: { env?: Record<string, string | undefined> }) =>
    { status: number | null; stdout: string; stderr: string };
  fileExists: (path: string) => boolean;
  readFile: (path: string) => string | null;
  writeFile: (path: string, content: string) => void;
  mkdirp: (path: string) => void;
  /** Async fetch; injected by tests to skip real network. */
  fetch: (url: string, init?: { headers?: Record<string, string> }) =>
    Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
  homedir: () => string;
  now: () => number;
  env: Record<string, string | undefined>;
};

const realSpawn: VersionEnv["spawn"] = (cmd, args, opts) => {
  const out = spawnSync(cmd, args, {
    encoding: "utf8",
    env: opts?.env ? (opts.env as NodeJS.ProcessEnv) : process.env,
  });
  return {
    status: out.status,
    stdout: (out.stdout ?? "").toString(),
    stderr: (out.stderr ?? "").toString(),
  };
};

const realWhich = (cmd: string): string | null => {
  const out = spawnSync("sh", ["-lc", `command -v ${JSON.stringify(cmd)}`], { encoding: "utf8" });
  if (out.status !== 0) return null;
  const path = (out.stdout ?? "").trim();
  return path.length > 0 ? path : null;
};

export const defaultVersionEnv = (): VersionEnv => ({
  which: realWhich,
  spawn: realSpawn,
  fileExists: (p) => existsSync(p),
  readFile: (p) => {
    try { return readFileSync(p, "utf8"); } catch { return null; }
  },
  writeFile: (p, content) => {
    const d = dirname(p);
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    writeFileSync(p, content);
  },
  mkdirp: (p) => { if (!existsSync(p)) mkdirSync(p, { recursive: true }); },
  fetch: async (url, init) => {
    const resp = await fetch(url, init);
    return { ok: resp.ok, status: resp.status, text: () => resp.text() };
  },
  homedir,
  now: () => Date.now(),
  env: process.env,
});

// ── Semver helpers ────────────────────────────────────────────────────

/** Parse a semver-ish string and return [major, minor, patch]. Trailing
 *  pre-release / build identifiers are ignored. Non-numeric segments
 *  collapse to 0. */
export const parseSemver = (raw: string): [number, number, number] => {
  // Strip leading `v` or `opencode ` prefix and any trailing whitespace.
  const cleaned = raw.replace(/^(?:opencode\s+)?v?/i, "").trim();
  // Split on the FIRST run of non-version chars after the patch number.
  const head = cleaned.split(/[\s\-+]/)[0] ?? "";
  const parts = head.split(".").slice(0, 3);
  const out: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const n = Number.parseInt(parts[i] ?? "0", 10);
    out[i] = Number.isFinite(n) ? n : 0;
  }
  return out;
};

/** Compare two semver strings. Returns -1 if a<b, 0 if equal, 1 if a>b. */
export const compareSemver = (a: string, b: string): -1 | 0 | 1 => {
  const A = parseSemver(a);
  const B = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if ((A[i] ?? 0) < (B[i] ?? 0)) return -1;
    if ((A[i] ?? 0) > (B[i] ?? 0)) return 1;
  }
  return 0;
};

// ── Install-method detection ─────────────────────────────────────────

const inferInstallMethod = (installPath: string, env: VersionEnv): OpencodeInstallMethod => {
  if (!installPath) return "unknown";
  // Order matters: more specific matches first.
  if (installPath.includes("/.opencode/bin")) return "official-script";
  if (installPath.includes("/.bun/install/global/bin")) return "bun";
  if (installPath.includes("/node_modules/.bin")) return "npm";
  // /usr/local/bin can come from either npm-global or a manual symlink.
  // Probe `npm list -g opencode-ai`; if it answers, it's npm.
  if (installPath.startsWith("/usr/local/bin") || installPath.startsWith("/usr/bin")) {
    const probe = env.spawn("npm", ["list", "-g", "--depth=0", "opencode-ai"]);
    if (probe.status === 0 && /opencode-ai/.test(probe.stdout)) return "npm";
    return "manual";
  }
  return "unknown";
};

// ── detectOpencodeVersion ────────────────────────────────────────────

/** Detect the installed opencode version + install method. */
export const detectOpencodeVersion = async (
  envOverride?: VersionEnv,
): Promise<OpencodeVersion> => {
  const env = envOverride ?? defaultVersionEnv();
  const installPath = env.which("opencode") ?? "";
  const binaryExists = installPath.length > 0 && env.fileExists(installPath);
  if (!binaryExists) {
    return { version: "unknown", installPath, installMethod: "unknown", binaryExists: false };
  }
  const out = env.spawn(installPath, ["--version"]);
  // opencode prints e.g. "1.4.3\n" on stdout. Some builds prefix "opencode ".
  const raw = (out.stdout || out.stderr || "").split("\n")[0] ?? "";
  const trimmed = raw.replace(/^opencode\s+/i, "").trim();
  // Only accept strings that begin with a digit; anything else is unparseable.
  const version = /^\d/.test(trimmed) ? trimmed : "unknown";
  const installMethod = inferInstallMethod(installPath, env);
  return { version, installPath, installMethod, binaryExists };
};

// ── checkLatestOpencodeVersion ───────────────────────────────────────

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const GITHUB_LATEST_URL = "https://api.github.com/repos/sst/opencode/releases/latest";

const cachePath = (env: VersionEnv): string =>
  join(env.homedir(), ".accint", "state", "cache", "opencode-latest.json");

type CacheRow = {
  fetched_at: number;
  release: LatestRelease;
};

/** Check the latest opencode release from GitHub. Cached for 1 hour. */
export const checkLatestOpencodeVersion = async (
  envOverride?: VersionEnv,
): Promise<LatestRelease | null> => {
  const env = envOverride ?? defaultVersionEnv();
  const path = cachePath(env);
  // Cache hit?
  const cached = env.readFile(path);
  if (cached) {
    try {
      const row = JSON.parse(cached) as CacheRow;
      if (row.fetched_at && env.now() - row.fetched_at < CACHE_TTL_MS) {
        return row.release;
      }
    } catch {
      // Fall through — invalid cache is overwritten on next fetch.
    }
  }
  // Miss — fetch from GitHub.
  const headers: Record<string, string> = {
    "User-Agent": "acc2-opencode-version-checker",
    "Accept": "application/vnd.github+json",
  };
  if (env.env.GITHUB_TOKEN) headers["Authorization"] = `Bearer ${env.env.GITHUB_TOKEN}`;
  let resp;
  try {
    resp = await env.fetch(GITHUB_LATEST_URL, { headers });
  } catch {
    return null;
  }
  if (!resp.ok) return null;
  let body;
  try {
    body = JSON.parse(await resp.text()) as {
      tag_name?: string;
      name?: string;
      published_at?: string;
      html_url?: string;
      body?: string;
    };
  } catch {
    return null;
  }
  const tag = (body.tag_name ?? body.name ?? "").replace(/^v/i, "").trim();
  if (!tag) return null;
  const release: LatestRelease = {
    version: tag,
    releasedAt: body.published_at ?? "",
    releaseUrl: body.html_url ?? `https://github.com/sst/opencode/releases/tag/${tag}`,
    releaseNotes: (body.body ?? "").slice(0, 4000),
  };
  // Write-through cache.
  try {
    env.mkdirp(dirname(path));
    env.writeFile(path, JSON.stringify({ fetched_at: env.now(), release } satisfies CacheRow));
  } catch {
    // Cache write failures are non-fatal.
  }
  return release;
};

// ── updateOpencode ────────────────────────────────────────────────────

const upgradeCommand = (
  method: OpencodeInstallMethod,
): { cmd: string; args: string[]; shell?: boolean } | null => {
  if (method === "official-script") {
    // The official installer is "curl … | bash"; we run it via sh -lc.
    return {
      cmd: "sh",
      args: ["-lc", "curl -fsSL https://opencode.ai/install | bash"],
      shell: true,
    };
  }
  if (method === "npm") {
    return { cmd: "npm", args: ["install", "-g", "opencode-ai@latest"] };
  }
  if (method === "bun") {
    return { cmd: "bun", args: ["upgrade", "-g", "opencode-ai"] };
  }
  return null;
};

export type UpdateOpts = {
  db?: Database;
  force?: boolean;
  env?: VersionEnv;
};

/** Cooldown window after a failed upgrade attempt. Any caller (operator,
 *  brain shell, autonomous loop) that hits updateOpencode with the same
 *  (from, to) target within this window is short-circuited with
 *  `recent_failure_cooldown`. Prevents the retry storms observed
 *  2026-05-15 07:00-07:05 (15+ attempts in 5 min, all failing with the
 *  same install_failed reason). 10min gives a real upstream fix time
 *  to land while making retries cheap to ignore. Override with `force`. */
export const UPDATE_OPENCODE_COOLDOWN_MS = 10 * 60 * 1000;

/** Run the upgrade. Detects install method, dispatches the appropriate
 *  command, emits substrate events for the trajectory. */
export const updateOpencode = async (opts: UpdateOpts = {}): Promise<UpdateResult> => {
  const env = opts.env ?? defaultVersionEnv();
  const current = await detectOpencodeVersion(env);
  const latest = await checkLatestOpencodeVersion(env);
  const fromVersion = current.version;
  const toVersion = latest?.version ?? "unknown";

  // Recent-failure cooldown gate. If the same (from→to) recently failed,
  // refuse without spawning. Caller can force with opts.force.
  if (!opts.force && opts.db && toVersion !== "unknown") {
    const cutoffIso = new Date(Date.now() - UPDATE_OPENCODE_COOLDOWN_MS).toISOString();
    const recentFail = opts.db
      .query(
        `SELECT ts, payload FROM events
         WHERE kind = 'opencode_upgrade_failed' AND ts >= ?
         ORDER BY ts DESC LIMIT 1`,
      )
      .get(cutoffIso) as { ts: string; payload: string } | null;
    if (recentFail) {
      try {
        const p = JSON.parse(recentFail.payload ?? "{}") as { from?: string; to?: string; reason?: string };
        if (p.from === fromVersion && p.to === toVersion) {
          return {
            ok: false,
            reason: "no_update_available",
            detail: `recent_failure_cooldown:last_failure_at=${recentFail.ts} reason=${p.reason ?? "?"}; window=${UPDATE_OPENCODE_COOLDOWN_MS}ms`,
          };
        }
      } catch { /* malformed payload — fall through to attempt */ }
    }
  }

  // Refuse if we don't know how to upgrade this install.
  const command = upgradeCommand(current.installMethod);
  if (!command) {
    const detail =
      `cannot scripted-upgrade install method '${current.installMethod}' at ${current.installPath || "(no path)"}; ` +
      "see https://github.com/sst/opencode for manual upgrade";
    if (opts.db) {
      emitEvent(opts.db, {
        kind: "opencode_upgrade_failed",
        substrate_origin: "substrate_auto",
        payload: {
          reason: "permission_denied",
          install_method: current.installMethod,
          install_path: current.installPath,
          detail,
        },
      });
    }
    return { ok: false, reason: "permission_denied", detail };
  }

  // Skip if already current and not forced.
  if (
    !opts.force &&
    latest &&
    fromVersion !== "unknown" &&
    compareSemver(fromVersion, latest.version) >= 0
  ) {
    return {
      ok: false,
      reason: "no_update_available",
      detail: `current ${fromVersion} >= latest ${latest.version}`,
    };
  }

  const startedAt = env.now();
  if (opts.db) {
    emitEvent(opts.db, {
      kind: "opencode_upgrade_started",
      substrate_origin: "substrate_auto",
      payload: {
        from: fromVersion,
        to: toVersion,
        install_method: current.installMethod,
        install_path: current.installPath,
      },
    });
  }

  const out = env.spawn(command.cmd, command.args);
  const durationMs = env.now() - startedAt;

  if (out.status !== 0) {
    const detail = (out.stderr || out.stdout || "").split("\n").slice(-10).join("\n").trim()
      || `exit ${out.status}`;
    // Heuristic reason classification.
    const lower = detail.toLowerCase();
    let reason: "auth_required" | "network_error" | "install_failed" | "permission_denied" = "install_failed";
    if (/permission denied|eacces|operation not permitted/.test(lower)) reason = "permission_denied";
    else if (/network|enotfound|econnrefused|getaddrinfo|timed out/.test(lower)) reason = "network_error";
    else if (/auth|unauthor|401|403/.test(lower)) reason = "auth_required";
    if (opts.db) {
      emitEvent(opts.db, {
        kind: "opencode_upgrade_failed",
        substrate_origin: "substrate_auto",
        payload: {
          reason,
          from: fromVersion,
          to: toVersion,
          install_method: current.installMethod,
          detail,
          duration_ms: durationMs,
        },
      });
    }
    return { ok: false, reason, detail };
  }

  // Success — re-detect to confirm the new version.
  const after = await detectOpencodeVersion(env);
  if (opts.db) {
    emitEvent(opts.db, {
      kind: "opencode_upgrade_completed",
      substrate_origin: "substrate_auto",
      payload: {
        from: fromVersion,
        to: after.version,
        install_method: current.installMethod,
        duration_ms: durationMs,
      },
    });
  }
  return {
    ok: true,
    from: fromVersion,
    to: after.version,
    durationMs,
  };
};
