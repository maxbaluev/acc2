// acc2 sandbox — per-runtime permission grammar enforcement (Architecture.md).
//
// The sandbox is per-RUNTIME, not per-action: bun has fs/net/proc/substrate_access
// permissions; uv adds pypi; camofox-browser swaps to browser-allow-domains +
// profile-root. This module exposes:
//
//   - validateSandboxDecl(decl) — shape + required-field validation.
//   - buildBunPermissionArgs(decl) — translate a `runtime: 'bun'` decl into
//     argv + env for `Bun.spawn` PLUS the warning strings the caller must
//     surface so the audit trail is honest about what bun cannot enforce.
//   - buildUvPermissionArgs(decl) / buildCamofoxPermissionArgs(decl) — Phase G
//     stubs (throw with `phase_g` so callers fail loudly).
//
// Honesty caveats for the bun builder (per Architecture.md + §11.3):
//   - bun does not have Deno-style --allow-net / --allow-read / --allow-write
//     enforcement at the process level. We approximate by setting `cwd` to a
//     tempdir and refusing to spawn if the decl references absolute paths
//     outside the tempdir (a partial enforcement). We do NOT block ad-hoc
//     fetch() calls — that's honor-system.
//   - For non-empty net_allow we emit a `sandbox_unenforced_warning` flag in
//     the returned `warnings` array so the runtime can pass it back to the
//     event emitter; the caller is responsible for actually emitting the
//     `sandbox_unenforced_warning` event.
//   - For proc_allow we set ACC2_ALLOWED_SUBPROCS env var so user code can
//     opt-in to checking, but the bun runtime itself cannot block subprocess
//     spawning. Phase G adds a real syscall sandbox.
//
// All limitations are documented inline so the design intent isn't lost the
// first time a real artifact runs and someone wonders why the network call
// succeeded despite `net_allow: []`.

import type { BunSandboxDecl, CamofoxSandboxDecl, SandboxDecl, UvSandboxDecl } from "../substrate/types";

export type SandboxResult = { ok: true } | { ok: false; reason: string };

export type BunPermissionArgs = {
  /** argv prefix for `Bun.spawn`. Does NOT include the script path. */
  argv: string[];
  /** Env vars to merge into the spawned process. */
  env: Record<string, string>;
  /** Human-readable warnings about declared permissions the bun runtime
   *  cannot actually enforce. The caller is expected to emit one
   *  `sandbox_unenforced_warning` event per entry. */
  warnings: string[];
};

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/** Validate that a SandboxDecl has the right shape for its declared runtime.
 *  Returns `{ok:true}` on success or `{ok:false, reason}` describing the
 *  first failure. Called at admission AND at every invocation. */
export const validateSandboxDecl = (decl: SandboxDecl): SandboxResult => {
  if (!decl || typeof decl !== "object") {
    return { ok: false, reason: "decl_not_object" };
  }
  const runtime = (decl as { runtime?: unknown }).runtime;
  if (typeof runtime !== "string" || runtime.length === 0) {
    return { ok: false, reason: `unknown_runtime:${String(runtime)}` };
  }
  // Candidate B (2026-05-19): unknown-runtime catch-all variant. The
  // three concrete runtimes fall through to their explicit shape checks
  // below; any other runtime string MUST be a catch-all decl declaring
  // `fields` (the runner's payload). The runner-registry resolves shape
  // semantics at invocation time — validation only enforces that the
  // catch-all envelope is well-formed. Optional resource-budget hints
  // (cpu_ms/wall_ms/memory_mb) are typed-checked when present.
  if (runtime !== "bun" && runtime !== "uv" && runtime !== "camofox-browser") {
    const d = decl as { fields?: unknown; cpu_ms?: unknown; wall_ms?: unknown; memory_mb?: unknown; env_requires?: unknown; fs_read?: unknown; fs_write?: unknown; net_allow?: unknown };
    if (!("fields" in d) || d.fields === undefined) {
      return { ok: false, reason: "unknown_runtime_missing_fields" };
    }
    if (d.cpu_ms !== undefined && (typeof d.cpu_ms !== "number" || d.cpu_ms <= 0)) {
      return { ok: false, reason: "bad_cpu_ms" };
    }
    if (d.wall_ms !== undefined && (typeof d.wall_ms !== "number" || d.wall_ms <= 0)) {
      return { ok: false, reason: "bad_wall_ms" };
    }
    if (d.memory_mb !== undefined && (typeof d.memory_mb !== "number" || d.memory_mb <= 0)) {
      return { ok: false, reason: "bad_memory_mb" };
    }
    if (d.env_requires !== undefined && !isStringArray(d.env_requires)) {
      return { ok: false, reason: "env_requires_not_string_array" };
    }
    if (d.fs_read !== undefined && !isStringArray(d.fs_read)) {
      return { ok: false, reason: "fs_read_not_string_array" };
    }
    if (d.fs_write !== undefined && !isStringArray(d.fs_write)) {
      return { ok: false, reason: "fs_write_not_string_array" };
    }
    if (d.net_allow !== undefined && !isStringArray(d.net_allow)) {
      return { ok: false, reason: "net_allow_not_string_array" };
    }
    return { ok: true };
  }

  if (runtime === "bun") {
    const d = decl as BunSandboxDecl;
    if (typeof d.cpu_ms !== "number" || d.cpu_ms <= 0) return { ok: false, reason: "missing_cpu_ms" };
    if (typeof d.wall_ms !== "number" || d.wall_ms <= 0) return { ok: false, reason: "missing_wall_ms" };
    if (typeof d.memory_mb !== "number" || d.memory_mb <= 0) return { ok: false, reason: "missing_memory_mb" };
    if (d.fs_read !== undefined && !isStringArray(d.fs_read)) return { ok: false, reason: "fs_read_not_string_array" };
    if (d.fs_write !== undefined && !isStringArray(d.fs_write)) return { ok: false, reason: "fs_write_not_string_array" };
    if (d.net_allow !== undefined && !isStringArray(d.net_allow)) return { ok: false, reason: "net_allow_not_string_array" };
    if (d.proc_allow !== undefined && !isStringArray(d.proc_allow)) return { ok: false, reason: "proc_allow_not_string_array" };
    if (d.substrate_access !== undefined &&
        d.substrate_access !== "ro" && d.substrate_access !== "rw" && d.substrate_access !== "none") {
      return { ok: false, reason: `bad_substrate_access:${String(d.substrate_access)}` };
    }
    return { ok: true };
  }

  if (runtime === "uv") {
    const d = decl as UvSandboxDecl;
    if (typeof d.cpu_ms !== "number" || d.cpu_ms <= 0) return { ok: false, reason: "missing_cpu_ms" };
    if (typeof d.wall_ms !== "number" || d.wall_ms <= 0) return { ok: false, reason: "missing_wall_ms" };
    if (typeof d.memory_mb !== "number" || d.memory_mb <= 0) return { ok: false, reason: "missing_memory_mb" };
    if (d.fs_read !== undefined && !isStringArray(d.fs_read)) return { ok: false, reason: "fs_read_not_string_array" };
    if (d.fs_write !== undefined && !isStringArray(d.fs_write)) return { ok: false, reason: "fs_write_not_string_array" };
    if (d.net_allow !== undefined && !isStringArray(d.net_allow)) return { ok: false, reason: "net_allow_not_string_array" };
    if (d.pypi_allow !== undefined && !isStringArray(d.pypi_allow)) return { ok: false, reason: "pypi_allow_not_string_array" };
    return { ok: true };
  }

  // camofox-browser
  const d = decl as CamofoxSandboxDecl;
  if (typeof d.wall_ms !== "number" || d.wall_ms <= 0) return { ok: false, reason: "missing_wall_ms" };
  if (typeof d.memory_mb !== "number" || d.memory_mb <= 0) return { ok: false, reason: "missing_memory_mb" };
  if (!isStringArray(d.browser_allow_domains)) return { ok: false, reason: "browser_allow_domains_missing" };
  if (typeof d.browser_profile_root !== "string" || d.browser_profile_root.length === 0) {
    return { ok: false, reason: "browser_profile_root_missing" };
  }
  if (d.browser_allow_downloads_to !== undefined && typeof d.browser_allow_downloads_to !== "string") {
    return { ok: false, reason: "browser_allow_downloads_to_bad_type" };
  }
  if (d.fingerprint_os !== undefined &&
      d.fingerprint_os !== "linux" && d.fingerprint_os !== "macos" && d.fingerprint_os !== "windows") {
    return { ok: false, reason: `bad_fingerprint_os:${String(d.fingerprint_os)}` };
  }
  if (d.fingerprint_locale !== undefined && typeof d.fingerprint_locale !== "string") {
    return { ok: false, reason: "fingerprint_locale_bad_type" };
  }
  if (d.headless !== undefined && typeof d.headless !== "boolean") {
    return { ok: false, reason: "headless_bad_type" };
  }
  return { ok: true };
};

/** Translate a `runtime: 'bun'` SandboxDecl into spawn argv prefix + env + warnings.
 *
 *  Enforcement matrix (honest about bun's actual capabilities today):
 *    - cpu_ms / wall_ms / memory_mb: NOT enforced via bun flags. The runtime
 *      module enforces wall_ms via a kill-watchdog (see runtimes/bun.ts).
 *      cpu_ms and memory_mb are honor-system on the bun side; Phase G adds a
 *      real cgroup/nsjail wrapper.
 *    - fs_read / fs_write: enforced by spawning with `cwd = <tempdir>` AND
 *      refusing to spawn if any glob references an absolute path that escapes
 *      the tempdir. Globs reading anything under the cwd ARE allowed.
 *    - net_allow: NOT enforceable via bun's flags. Emit a warning so the audit
 *      trail records that the runtime promised something it cannot guarantee.
 *    - proc_allow: NOT enforceable. We expose ACC2_ALLOWED_SUBPROCS in env so
 *      cooperating user code can self-check; uncooperative code can still call
 *      `Bun.spawn` directly. Warning emitted.
 *    - substrate_access: NOT enforced here. Phase D wires the substrate-handle
 *      object the script receives (ro vs rw vs none), and rw access is denied
 *      by the MCP layer when the artifact's decl says ro/none.
 *
 *  Returns argv = ['--silent', '--no-color'] (basic CLI flags) plus env keys
 *  ACC2_SANDBOX_RUNTIME, ACC2_SANDBOX_NET_ALLOW, ACC2_SANDBOX_PROC_ALLOW so a
 *  cooperating script can introspect what it was told it can do.
 */
export const buildBunPermissionArgs = (
  decl: BunSandboxDecl,
): BunPermissionArgs => {
  const v = validateSandboxDecl(decl);
  if (!v.ok) {
    // Throw rather than return error — callers should validate first.
    throw new Error(`invalid bun sandbox decl: ${v.reason}`);
  }
  const argv = ["--silent", "--no-color"];
  const env: Record<string, string> = {
    ACC2_SANDBOX_RUNTIME: "bun",
    ACC2_SANDBOX_WALL_MS: String(decl.wall_ms),
    ACC2_SANDBOX_CPU_MS: String(decl.cpu_ms),
    ACC2_SANDBOX_MEMORY_MB: String(decl.memory_mb),
    ACC2_SANDBOX_NET_ALLOW: JSON.stringify(decl.net_allow ?? []),
    ACC2_SANDBOX_PROC_ALLOW: JSON.stringify(decl.proc_allow ?? []),
    ACC2_SANDBOX_FS_READ: JSON.stringify(decl.fs_read ?? []),
    ACC2_SANDBOX_FS_WRITE: JSON.stringify(decl.fs_write ?? []),
    ACC2_SANDBOX_SUBSTRATE_ACCESS: decl.substrate_access ?? "none",
  };
  const warnings: string[] = [];
  if ((decl.net_allow ?? []).length > 0) {
    warnings.push(
      `net_allow declared (${(decl.net_allow ?? []).join(",")}) but bun runtime cannot enforce — honor-system only`,
    );
  }
  if ((decl.proc_allow ?? []).length > 0) {
    warnings.push(
      `proc_allow declared (${(decl.proc_allow ?? []).join(",")}) but bun runtime cannot enforce — honor-system only`,
    );
  }
  return { argv, env, warnings };
};

export type UvPermissionArgs = {
  /** argv prefix when nsjail is available; empty when nsjail is absent.
   *  The runtime module decides whether to prepend nsjail itself; this
   *  surface is the policy, not the spawn-line. */
  argv: string[];
  /** Env vars to merge into the spawned process. */
  env: Record<string, string>;
  /** Human-readable warnings about declared permissions the uv runtime
   *  cannot enforce without nsjail. */
  warnings: string[];
};

export type CamofoxPermissionArgs = {
  /** Env vars to merge into the spawned process. The chromium subprocess is
   *  spawned by the wrapper, so there is no argv prefix here. */
  env: Record<string, string>;
  /** Human-readable warnings about declared permissions the camofox runtime
   *  cannot enforce (e.g. malformed allow-domain entries, missing profile
   *  root parent dir). */
  warnings: string[];
};

/** Translate a `runtime: 'uv'` SandboxDecl into env vars + warnings.
 *
 *  Phase-G enforcement matrix:
 *    - cpu_ms / wall_ms / memory_mb: outer watchdog enforces wall_ms (see
 *      runtimes/uv.ts). When nsjail is on PATH it ALSO enforces via its
 *      `--time_limit` / `--rlimit_as`; the runtime decides at spawn time.
 *    - fs_read / fs_write: not enforced without nsjail. Warning emitted.
 *    - net_allow: not enforced without nsjail. Warning emitted.
 *    - pypi_allow: enforced by `uv run --with-requirements`; only the
 *      declared package list is installed in the ephemeral env.
 *
 *  The argv list is empty here — the uv runtime decides whether to wrap
 *  with nsjail at spawn time based on `which nsjail`. We surface the
 *  policy via env + warnings; the runtime composes the actual argv.
 */
export const buildUvPermissionArgs = (
  decl: UvSandboxDecl,
): UvPermissionArgs => {
  const v = validateSandboxDecl(decl);
  if (!v.ok) {
    throw new Error(`invalid uv sandbox decl: ${v.reason}`);
  }
  const env: Record<string, string> = {
    ACC2_SANDBOX_RUNTIME: "uv",
    ACC2_SANDBOX_WALL_MS: String(decl.wall_ms),
    ACC2_SANDBOX_CPU_MS: String(decl.cpu_ms),
    ACC2_SANDBOX_MEMORY_MB: String(decl.memory_mb),
    ACC2_SANDBOX_NET_ALLOW: JSON.stringify(decl.net_allow ?? []),
    ACC2_SANDBOX_FS_READ: JSON.stringify(decl.fs_read ?? []),
    ACC2_SANDBOX_FS_WRITE: JSON.stringify(decl.fs_write ?? []),
    ACC2_ALLOWED_PYPI: JSON.stringify(decl.pypi_allow ?? []),
  };
  const warnings: string[] = [];
  if ((decl.net_allow ?? []).length > 0) {
    warnings.push(
      `net_allow declared (${(decl.net_allow ?? []).join(",")}) — uv runtime can only enforce when nsjail is present`,
    );
  }
  // Catch malformed pypi entries early. We allow ==pin, >=range, and bare
  // package names; anything else is suspicious enough to warn about.
  for (const entry of decl.pypi_allow ?? []) {
    if (!/^[A-Za-z0-9_.\-]+(\s*[<>=!~]=?\s*[A-Za-z0-9_.\-]+)?$/.test(entry.trim())) {
      warnings.push(`pypi_allow entry '${entry}' does not look like a pip requirement spec`);
    }
  }
  return { argv: [], env, warnings };
};

/** Translate a `runtime: 'camofox-browser'` SandboxDecl into env vars + warnings.
 *
 *  Batch 1.α enforcement matrix:
 *    - wall_ms / memory_mb: outer watchdog enforces wall_ms via SIGTERM at
 *      wall_ms and SIGKILL at wall_ms × 2 (see runtimes/camofox.ts).
 *    - browser_allow_domains: enforced by the wrapper's `page.route()` —
 *      requests to disallowed domains are aborted before they hit the wire.
 *    - browser_profile_root: validated for shape; the wrapper creates the
 *      directory tree under it on first launch.
 *    - browser_allow_downloads_to: surfaced via env; the wrapper reads
 *      ACC2_DOWNLOAD_DIR when set and rejects writes elsewhere.
 *    - fingerprint_os / fingerprint_locale / headless: Camoufox-specific
 *      fingerprint randomization hints. Surfaced via env keys CAMOUFOX_OS,
 *      CAMOUFOX_LOCALE, CAMOUFOX_HEADLESS — these are read by the wrapper
 *      code that calls `firefox.launchPersistentContext` (CAMOUFOX_OS picks
 *      the fingerprint family the camoufox binary emulates; CAMOUFOX_LOCALE
 *      and CAMOUFOX_HEADLESS thread directly into the launch options).
 *      Defaults: linux / en-US / true. All three are optional on the decl.
 *
 *  No argv prefix — firefox is spawned by playwright inside the wrapper,
 *  so the sandbox here only shapes the env passed to the wrapper.
 */
export const buildCamofoxPermissionArgs = (
  decl: CamofoxSandboxDecl,
): CamofoxPermissionArgs => {
  const v = validateSandboxDecl(decl);
  if (!v.ok) {
    throw new Error(`invalid camofox sandbox decl: ${v.reason}`);
  }
  const fingerprintOs = decl.fingerprint_os ?? "linux";
  const fingerprintLocale = decl.fingerprint_locale ?? "en-US";
  const headless = decl.headless ?? true;
  const env: Record<string, string> = {
    ACC2_SANDBOX_RUNTIME: "camofox-browser",
    ACC2_SANDBOX_WALL_MS: String(decl.wall_ms),
    ACC2_SANDBOX_MEMORY_MB: String(decl.memory_mb),
    ACC2_BROWSER_PROFILE: decl.browser_profile_root,
    ACC2_ALLOWED_DOMAINS: JSON.stringify(decl.browser_allow_domains),
    CAMOUFOX_OS: fingerprintOs,
    CAMOUFOX_LOCALE: fingerprintLocale,
    CAMOUFOX_HEADLESS: headless ? "true" : "false",
  };
  if (decl.browser_allow_downloads_to) {
    env.ACC2_DOWNLOAD_DIR = decl.browser_allow_downloads_to;
  }
  const warnings: string[] = [];
  for (const dom of decl.browser_allow_domains) {
    // A canonical allow-domain entry is a bare hostname (no scheme, no path,
    // no port). Anything else is honored but flagged so the audit trail
    // catches drift.
    if (/^https?:\/\//.test(dom) || dom.includes("/") || dom.includes(":")) {
      warnings.push(`browser_allow_domains entry '${dom}' should be a bare hostname (no scheme/port/path)`);
    }
  }
  if (decl.browser_allow_domains.length === 0) {
    warnings.push("browser_allow_domains is empty — camoufox will allow ALL outbound requests");
  }
  return { env, warnings };
};
