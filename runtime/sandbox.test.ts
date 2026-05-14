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

describe("buildUvPermissionArgs (Phase G)", () => {
  test("returns env + zero warnings for a minimal valid decl", () => {
    const out = buildUvPermissionArgs({
      runtime: "uv",
      cpu_ms: 1000, wall_ms: 5000, memory_mb: 256,
    });
    expect(out.argv).toEqual([]);
    expect(out.env.ACC2_SANDBOX_RUNTIME).toBe("uv");
    expect(out.env.ACC2_SANDBOX_WALL_MS).toBe("5000");
    expect(out.env.ACC2_SANDBOX_MEMORY_MB).toBe("256");
    expect(JSON.parse(out.env.ACC2_ALLOWED_PYPI!)).toEqual([]);
    expect(out.warnings).toEqual([]);
  });

  test("exposes pypi_allow via env for the uv runtime to convert into requirements.txt", () => {
    const out = buildUvPermissionArgs({
      runtime: "uv",
      pypi_allow: ["requests==2.31.0", "numpy"],
      cpu_ms: 1000, wall_ms: 5000, memory_mb: 256,
    });
    expect(JSON.parse(out.env.ACC2_ALLOWED_PYPI!)).toEqual(["requests==2.31.0", "numpy"]);
  });

  test("declares a warning when net_allow is non-empty (without nsjail enforcement)", () => {
    const out = buildUvPermissionArgs({
      runtime: "uv",
      net_allow: ["pypi.org"],
      cpu_ms: 1000, wall_ms: 5000, memory_mb: 256,
    });
    expect(out.warnings.length).toBeGreaterThanOrEqual(1);
    expect(out.warnings.some((w) => w.includes("net_allow"))).toBe(true);
  });

  test("warns when pypi_allow entry is malformed", () => {
    const out = buildUvPermissionArgs({
      runtime: "uv",
      pypi_allow: ["a bad pkg with spaces!"],
      cpu_ms: 1000, wall_ms: 5000, memory_mb: 256,
    });
    expect(out.warnings.some((w) => w.includes("pip requirement spec"))).toBe(true);
  });

  test("throws on a malformed uv decl rather than returning bad permissions", () => {
    const bad = { runtime: "uv" } as unknown as SandboxDecl & { runtime: "uv" };
    expect(() => buildUvPermissionArgs(bad)).toThrow(/invalid uv sandbox decl/);
  });
});

describe("buildCamofoxPermissionArgs (Batch 1.α)", () => {
  test("returns env populated with allow_domains + profile_root for a valid decl", () => {
    const out = buildCamofoxPermissionArgs({
      runtime: "camofox-browser",
      browser_allow_domains: ["example.com"],
      browser_profile_root: "/tmp/p",
      wall_ms: 30000, memory_mb: 1024,
    });
    expect(out.env.ACC2_SANDBOX_RUNTIME).toBe("camofox-browser");
    expect(out.env.ACC2_BROWSER_PROFILE).toBe("/tmp/p");
    expect(JSON.parse(out.env.ACC2_ALLOWED_DOMAINS!)).toEqual(["example.com"]);
    expect(out.warnings).toEqual([]);
  });

  test("populates CAMOUFOX_OS / CAMOUFOX_LOCALE / CAMOUFOX_HEADLESS env with defaults when fingerprint hints are omitted", () => {
    const out = buildCamofoxPermissionArgs({
      runtime: "camofox-browser",
      browser_allow_domains: ["example.com"],
      browser_profile_root: "/tmp/p",
      wall_ms: 30000, memory_mb: 1024,
    });
    expect(out.env.CAMOUFOX_OS).toBe("linux");
    expect(out.env.CAMOUFOX_LOCALE).toBe("en-US");
    expect(out.env.CAMOUFOX_HEADLESS).toBe("true");
  });

  test("propagates fingerprint_os / fingerprint_locale / headless overrides into env", () => {
    const out = buildCamofoxPermissionArgs({
      runtime: "camofox-browser",
      browser_allow_domains: ["example.com"],
      browser_profile_root: "/tmp/p",
      fingerprint_os: "macos",
      fingerprint_locale: "fr-FR",
      headless: false,
      wall_ms: 30000, memory_mb: 1024,
    });
    expect(out.env.CAMOUFOX_OS).toBe("macos");
    expect(out.env.CAMOUFOX_LOCALE).toBe("fr-FR");
    expect(out.env.CAMOUFOX_HEADLESS).toBe("false");
  });

  test("rejects an invalid fingerprint_os value at validation", () => {
    const decl = {
      runtime: "camofox-browser",
      browser_allow_domains: ["example.com"],
      browser_profile_root: "/tmp/p",
      fingerprint_os: "plan9",
      wall_ms: 30000, memory_mb: 1024,
    } as unknown as SandboxDecl & { runtime: "camofox-browser" };
    expect(() => buildCamofoxPermissionArgs(decl)).toThrow(/bad_fingerprint_os/);
  });

  test("rejects a non-boolean headless at validation", () => {
    const decl = {
      runtime: "camofox-browser",
      browser_allow_domains: ["example.com"],
      browser_profile_root: "/tmp/p",
      headless: "yes",
      wall_ms: 30000, memory_mb: 1024,
    } as unknown as SandboxDecl & { runtime: "camofox-browser" };
    expect(() => buildCamofoxPermissionArgs(decl)).toThrow(/headless_bad_type/);
  });

  test("warns when an allow-domain entry contains a scheme/port/path", () => {
    const out = buildCamofoxPermissionArgs({
      runtime: "camofox-browser",
      browser_allow_domains: ["https://example.com/path", "good.example.com"],
      browser_profile_root: "/tmp/p",
      wall_ms: 1000, memory_mb: 64,
    });
    expect(out.warnings.some((w) => w.includes("bare hostname"))).toBe(true);
  });

  test("warns when allow_domains is empty (full-open policy)", () => {
    const out = buildCamofoxPermissionArgs({
      runtime: "camofox-browser",
      browser_allow_domains: [],
      browser_profile_root: "/tmp/p",
      wall_ms: 1000, memory_mb: 64,
    });
    // The decl validator requires non-empty in admit; the BUILDER still
    // surfaces the warning for any odd code path that bypasses validation.
    // But validateSandboxDecl currently requires it be a string array
    // (empty allowed). Either way: warning fires when empty.
    expect(out.warnings.some((w) => w.includes("empty"))).toBe(true);
  });

  test("surfaces browser_allow_downloads_to via env when declared", () => {
    const out = buildCamofoxPermissionArgs({
      runtime: "camofox-browser",
      browser_allow_domains: ["example.com"],
      browser_profile_root: "/tmp/p",
      browser_allow_downloads_to: "/tmp/dl",
      wall_ms: 1000, memory_mb: 64,
    });
    expect(out.env.ACC2_DOWNLOAD_DIR).toBe("/tmp/dl");
  });

  test("throws on a malformed camofox decl rather than returning bad permissions", () => {
    const bad = { runtime: "camofox-browser" } as unknown as SandboxDecl & { runtime: "camofox-browser" };
    expect(() => buildCamofoxPermissionArgs(bad)).toThrow(/invalid camofox sandbox decl/);
  });
});
