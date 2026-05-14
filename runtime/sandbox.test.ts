// acc2 sandbox unit tests — covers shape validation, the bun permission
// builder (including the unenforceable-warning surface), and the Phase G
// stub behavior for uv / camofox-browser.

import { describe, expect, test } from "bun:test";
import type { SandboxDecl } from "../substrate/types";
import {
  buildBunPermissionArgs,
  buildCamofoxPermissionArgs,
  buildUvPermissionArgs,
  validateSandboxDecl,
} from "./sandbox";

describe("validateSandboxDecl", () => {
  test("accepts a minimal valid bun decl", () => {
    const decl: SandboxDecl = {
      runtime: "bun",
      cpu_ms: 1000,
      wall_ms: 5000,
      memory_mb: 64,
    };
    expect(validateSandboxDecl(decl)).toEqual({ ok: true });
  });

  test("accepts a bun decl with every optional field populated", () => {
    const decl: SandboxDecl = {
      runtime: "bun",
      fs_read: ["*.md"],
      fs_write: ["out/*"],
      net_allow: ["api.openai.com"],
      proc_allow: ["echo"],
      substrate_access: "ro",
      cpu_ms: 2000,
      wall_ms: 10000,
      memory_mb: 128,
    };
    expect(validateSandboxDecl(decl)).toEqual({ ok: true });
  });

  test("rejects a decl whose runtime field is unknown", () => {
    const decl = { runtime: "wasm", cpu_ms: 1, wall_ms: 1, memory_mb: 1 } as unknown as SandboxDecl;
    const r = validateSandboxDecl(decl);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("unknown_runtime");
  });

  test("rejects a bun decl missing wall_ms", () => {
    const decl = { runtime: "bun", cpu_ms: 1, memory_mb: 1 } as unknown as SandboxDecl;
    const r = validateSandboxDecl(decl);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing_wall_ms");
  });

  test("rejects a bun decl whose fs_read is not a string array", () => {
    const decl = {
      runtime: "bun",
      cpu_ms: 1, wall_ms: 1, memory_mb: 1,
      fs_read: [123],
    } as unknown as SandboxDecl;
    const r = validateSandboxDecl(decl);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("fs_read_not_string_array");
  });

  test("rejects a bun decl whose substrate_access is invalid", () => {
    const decl = {
      runtime: "bun",
      cpu_ms: 1, wall_ms: 1, memory_mb: 1,
      substrate_access: "all",
    } as unknown as SandboxDecl;
    const r = validateSandboxDecl(decl);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("bad_substrate_access");
  });

  test("accepts a minimal valid uv decl", () => {
    const decl: SandboxDecl = {
      runtime: "uv",
      cpu_ms: 1000, wall_ms: 5000, memory_mb: 256,
    };
    expect(validateSandboxDecl(decl)).toEqual({ ok: true });
  });

  test("accepts a valid camofox-browser decl", () => {
    const decl: SandboxDecl = {
      runtime: "camofox-browser",
      browser_allow_domains: ["example.com"],
      browser_profile_root: "/tmp/profile",
      wall_ms: 30000,
      memory_mb: 1024,
    };
    expect(validateSandboxDecl(decl)).toEqual({ ok: true });
  });

  test("rejects a camofox decl missing browser_allow_domains", () => {
    const decl = {
      runtime: "camofox-browser",
      browser_profile_root: "/tmp/profile",
      wall_ms: 1000,
      memory_mb: 64,
    } as unknown as SandboxDecl;
    const r = validateSandboxDecl(decl);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("browser_allow_domains");
  });
});

describe("buildBunPermissionArgs", () => {
  test("returns argv + env for a minimal valid decl with zero warnings", () => {
    const out = buildBunPermissionArgs({
      runtime: "bun",
      cpu_ms: 1000, wall_ms: 5000, memory_mb: 64,
    });
    expect(out.argv).toEqual(["--silent", "--no-color"]);
    expect(out.env.ACC2_SANDBOX_RUNTIME).toBe("bun");
    expect(out.env.ACC2_SANDBOX_WALL_MS).toBe("5000");
    expect(out.warnings).toEqual([]);
  });

  test("declares a warning when net_allow is non-empty (bun cannot enforce)", () => {
    const out = buildBunPermissionArgs({
      runtime: "bun",
      net_allow: ["api.openai.com"],
      cpu_ms: 1000, wall_ms: 5000, memory_mb: 64,
    });
    expect(out.warnings.length).toBe(1);
    expect(out.warnings[0]).toContain("net_allow");
  });

  test("declares a warning when proc_allow is non-empty", () => {
    const out = buildBunPermissionArgs({
      runtime: "bun",
      proc_allow: ["echo"],
      cpu_ms: 1000, wall_ms: 5000, memory_mb: 64,
    });
    expect(out.warnings.length).toBe(1);
    expect(out.warnings[0]).toContain("proc_allow");
  });

  test("exposes fs_read / fs_write in env for cooperating scripts", () => {
    const out = buildBunPermissionArgs({
      runtime: "bun",
      fs_read: ["*.md"],
      fs_write: ["out/*"],
      cpu_ms: 1000, wall_ms: 5000, memory_mb: 64,
    });
    expect(JSON.parse(out.env.ACC2_SANDBOX_FS_READ!)).toEqual(["*.md"]);
    expect(JSON.parse(out.env.ACC2_SANDBOX_FS_WRITE!)).toEqual(["out/*"]);
  });

  test("throws on an invalid decl rather than silently returning bad permissions", () => {
    const bad = { runtime: "bun" } as unknown as SandboxDecl & { runtime: "bun" };
    expect(() => buildBunPermissionArgs(bad)).toThrow(/invalid bun sandbox decl/);
  });
});

describe("Phase G stubs (uv / camofox)", () => {
  test("buildUvPermissionArgs throws with phase_g signal", () => {
    expect(() =>
      buildUvPermissionArgs({
        runtime: "uv", cpu_ms: 1, wall_ms: 1, memory_mb: 1,
      }),
    ).toThrow(/phase_g_runtime_unsupported:uv_sandbox/);
  });

  test("buildCamofoxPermissionArgs throws with phase_g signal", () => {
    expect(() =>
      buildCamofoxPermissionArgs({
        runtime: "camofox-browser",
        browser_allow_domains: ["example.com"],
        browser_profile_root: "/tmp/p",
        wall_ms: 1, memory_mb: 1,
      }),
    ).toThrow(/phase_g_runtime_unsupported:camofox_sandbox/);
  });
});
