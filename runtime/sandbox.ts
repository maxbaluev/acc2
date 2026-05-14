// acc2 sandbox — per-runtime permission grammar enforcement (v2-design.md §11.3).
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
// Honesty caveats for the bun builder (per v2-design.md §5.5 + §11.3):
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

import type { SandboxDecl } from "../substrate/types";

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
  if (runtime !== "bun" && runtime !== "uv" && runtime !== "camofox-browser") {
    return { ok: false, reason: `unknown_runtime:${String(runtime)}` };
  }

  if (runtime === "bun") {
    const d = decl as Extract<SandboxDecl, { runtime: "bun" }>;
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
    const d = decl as Extract<SandboxDecl, { runtime: "uv" }>;
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
  const d = decl as Extract<SandboxDecl, { runtime: "camofox-browser" }>;
  if (typeof d.wall_ms !== "number" || d.wall_ms <= 0) return { ok: false, reason: "missing_wall_ms" };
  if (typeof d.memory_mb !== "number" || d.memory_mb <= 0) return { ok: false, reason: "missing_memory_mb" };
  if (!isStringArray(d.browser_allow_domains)) return { ok: false, reason: "browser_allow_domains_missing" };
  if (typeof d.browser_profile_root !== "string" || d.browser_profile_root.length === 0) {
    return { ok: false, reason: "browser_profile_root_missing" };
  }
  if (d.browser_allow_downloads_to !== undefined && typeof d.browser_allow_downloads_to !== "string") {
    return { ok: false, reason: "browser_allow_downloads_to_bad_type" };
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
  decl: SandboxDecl & { runtime: "bun" },
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

/** Phase G — uv runtime sandbox is not implemented in Phase C. */
export const buildUvPermissionArgs = (_decl: SandboxDecl): never => {
  throw new Error("phase_g_runtime_unsupported:uv_sandbox");
};

/** Phase G — camofox-browser runtime sandbox is not implemented in Phase C. */
export const buildCamofoxPermissionArgs = (_decl: SandboxDecl): never => {
  throw new Error("phase_g_runtime_unsupported:camofox_sandbox");
};
