// acc2 admin install-deps tests — drive each check with an injected
// InstallDepsEnv stub so the test stays hermetic (no subprocess, no
// real filesystem, no network).

import { describe, expect, test } from "bun:test";
import {
  BUN_MIN_VERSION,
  checkBun,
  checkCamoufoxBinary,
  checkNsjail,
  checkOpenAiKey,
  checkOpencodeOnPath,
  collectInstallDepsSummary,
  compareVersions,
  runInstallDeps,
  type InstallDepsEnv,
} from "./admin_install_deps";

const makeEnv = (overrides: Partial<InstallDepsEnv> = {}): InstallDepsEnv => ({
  env: {},
  which: () => null,
  version: () => null,
  readFile: () => null,
  fileExists: () => false,
  installCamoufox: async () => ({ ok: false, detail: "test stub: install not attempted" }),
  cwd: () => "/work",
  homedir: () => "/home/test",
  out: () => { /* swallow */ },
  ...overrides,
});

describe("compareVersions", () => {
  test("1.3.14 == 1.3.14", () => { expect(compareVersions("1.3.14", "1.3.14")).toBe(0); });
  test("1.3.14 > 1.3.13", () => { expect(compareVersions("1.3.14", "1.3.13")).toBeGreaterThan(0); });
  test("1.3.13 < 1.3.14", () => { expect(compareVersions("1.3.13", "1.3.14")).toBeLessThan(0); });
  test("1.4.0 > 1.3.14", () => { expect(compareVersions("1.4.0", "1.3.14")).toBeGreaterThan(0); });
});

describe("checkBun", () => {
  test("pass at exactly BUN_MIN_VERSION", () => {
    const c = checkBun(makeEnv({ version: () => BUN_MIN_VERSION }));
    expect(c.status).toBe("pass");
    expect(c.detail).toContain(BUN_MIN_VERSION);
  });
  test("pass at newer than min", () => {
    expect(checkBun(makeEnv({ version: () => "1.4.0" })).status).toBe("pass");
  });
  test("fail when older than min", () => {
    const c = checkBun(makeEnv({ version: () => "1.3.0" }));
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("need");
    expect(c.remediation).toContain("https://bun.com");
  });
  test("fail when bun not on PATH", () => {
    const c = checkBun(makeEnv({ version: () => null }));
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("not found");
  });
});

describe("checkOpencodeOnPath", () => {
  test("pass when on PATH", () => {
    const c = checkOpencodeOnPath(makeEnv({
      which: (cmd) => cmd === "opencode" ? "/usr/bin/opencode" : null,
      version: () => "opencode 1.4.3",
    }));
    expect(c.status).toBe("pass");
    expect(c.detail).toContain("/usr/bin/opencode");
  });
  test("fail when missing", () => {
    const c = checkOpencodeOnPath(makeEnv({ which: () => null }));
    expect(c.status).toBe("fail");
    expect(c.remediation).toContain("github.com/sst/opencode");
  });
});

describe("checkOpenAiKey", () => {
  test("pass when in env (length surfaced, value never printed)", () => {
    const key = "sk-abcdef123456";
    const c = checkOpenAiKey(makeEnv({ env: { OPENAI_API_KEY: key } }));
    expect(c.status).toBe("pass");
    expect(c.detail).toContain(`length=${key.length}`);
    expect(c.detail).not.toContain("sk-abcdef");
  });
  test("pass when in .env file", () => {
    const value = "sk-from-dotenv-xy";
    const c = checkOpenAiKey(makeEnv({
      fileExists: (p) => p === "/work/.env",
      readFile: () => `FOO=bar\nOPENAI_API_KEY=${value}\n`,
    }));
    expect(c.status).toBe("pass");
    expect(c.detail).toContain(".env");
    expect(c.detail).toContain(`length=${value.length}`);
  });
  test("fail when both absent", () => {
    const c = checkOpenAiKey(makeEnv({}));
    expect(c.status).toBe("fail");
    expect(c.remediation).toContain(".env");
  });
  test("fail when .env has empty value", () => {
    const c = checkOpenAiKey(makeEnv({
      fileExists: () => true,
      readFile: () => "OPENAI_API_KEY=\n",
    }));
    expect(c.status).toBe("fail");
  });
});

describe("checkCamoufoxBinary", () => {
  test("pass via CAMOUFOX_BINARY_PATH", async () => {
    const c = await checkCamoufoxBinary(makeEnv({
      env: { CAMOUFOX_BINARY_PATH: "/opt/cf/camoufox" },
      fileExists: (p) => p === "/opt/cf/camoufox",
    }));
    expect(c.status).toBe("pass");
    expect(c.detail).toContain("/opt/cf/camoufox");
  });
  test("pass via cached path (already done)", async () => {
    const c = await checkCamoufoxBinary(makeEnv({
      fileExists: (p) => p === "/home/test/.cache/camoufox/camoufox",
    }));
    expect(c.status).toBe("pass");
    expect(c.detail).toContain("already done");
  });
  test("attempts install when neither path present", async () => {
    let called = false;
    const c = await checkCamoufoxBinary(makeEnv({
      fileExists: () => false,
      installCamoufox: async () => {
        called = true;
        return { ok: true, detail: "installed via uvx at /home/test/.cache/camoufox/camoufox" };
      },
    }));
    expect(called).toBe(true);
    expect(c.status).toBe("pass");
  });
  test("fail when install attempt fails", async () => {
    const c = await checkCamoufoxBinary(makeEnv({
      fileExists: () => false,
      installCamoufox: async () => ({ ok: false, detail: "no uvx, no python" }),
    }));
    expect(c.status).toBe("fail");
    expect(c.remediation).toContain("camoufox");
  });
});

describe("checkNsjail (warn-only — production-grade uv sandbox needs it)", () => {
  test("pass when present", () => {
    const c = checkNsjail(makeEnv({ which: (cmd) => cmd === "nsjail" ? "/usr/bin/nsjail" : null }));
    expect(c.status).toBe("pass");
  });
  test("warn (not fail) when missing — bun + camofox-browser still work", () => {
    const c = checkNsjail(makeEnv({ which: () => null }));
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("uv sandbox");
  });
});

describe("runInstallDeps (composite — happy path)", () => {
  test("exit 0 when every must-have passes", async () => {
    const lines: string[] = [];
    const env = makeEnv({
      env: { OPENAI_API_KEY: "sk-happy-path-xxxxx" },
      which: (cmd) => cmd === "opencode" ? "/usr/bin/opencode"
                    : cmd === "nsjail" ? "/usr/bin/nsjail" : null,
      version: (cmd) => cmd === "bun" ? BUN_MIN_VERSION
                      : cmd === "opencode" ? "opencode 1.4" : null,
      fileExists: (p) => p === "/home/test/.cache/camoufox/camoufox",
      out: (s) => lines.push(s),
    });
    const code = await runInstallDeps([], env);
    expect(code).toBe(0);
    const joined = lines.join("");
    expect(joined).toContain("dep_check_complete");
    expect(joined).toContain('"fails":[]');
    expect(joined).toContain("all must-have prereqs satisfied");
  });
});

describe("runInstallDeps (composite — missing dependencies)", () => {
  test("exit 1 + emits structured fails list when must-haves missing", async () => {
    const lines: string[] = [];
    const env = makeEnv({
      env: {}, // no OPENAI_API_KEY
      which: () => null,
      version: () => null,
      fileExists: () => false,
      installCamoufox: async () => ({ ok: false, detail: "test: no installer available" }),
      out: (s) => lines.push(s),
    });
    const code = await runInstallDeps([], env);
    expect(code).toBe(1);
    const joined = lines.join("");
    expect(joined).toContain("dep_check_complete");
    // The structured line must enumerate the failing must-haves.
    expect(joined).toContain("bun");
    expect(joined).toContain("opencode");
    expect(joined).toContain("OPENAI_API_KEY");
    expect(joined).toContain("camoufox");
    // nsjail must NOT be in fails (warn-only).
    expect(joined).toContain('"warns":["nsjail"]');
  });
});

describe("collectInstallDepsSummary structured output", () => {
  test("returns checks[] + categorised passes/fails/warns arrays", async () => {
    const env = makeEnv({
      env: { OPENAI_API_KEY: "sk-summary" },
      which: (cmd) => cmd === "opencode" ? "/usr/bin/opencode" : null,
      version: (cmd) => cmd === "bun" ? BUN_MIN_VERSION
                      : cmd === "opencode" ? "opencode 1.4" : null,
      fileExists: (p) => p === "/home/test/.cache/camoufox/camoufox",
    });
    const sum = await collectInstallDepsSummary(env);
    expect(sum.checks.length).toBe(5);
    expect(sum.passes).toContain("bun");
    expect(sum.passes).toContain("opencode");
    expect(sum.passes).toContain("OPENAI_API_KEY");
    expect(sum.passes).toContain("camoufox binary");
    expect(sum.warns).toContain("nsjail");
    expect(sum.fails.length).toBe(0);
  });
});

describe("idempotency", () => {
  test("re-running with all prereqs satisfied is a clean no-op", async () => {
    const env = makeEnv({
      env: { OPENAI_API_KEY: "sk-already-set" },
      which: (cmd) => cmd === "opencode" ? "/usr/bin/opencode"
                    : cmd === "nsjail" ? "/usr/bin/nsjail" : null,
      version: (cmd) => cmd === "bun" ? "1.4.0"
                      : cmd === "opencode" ? "opencode 1.5" : null,
      fileExists: () => true, // camoufox cached
    });
    // First run.
    const code1 = await runInstallDeps([], env);
    // Second run — exactly the same env, no side effects expected.
    const code2 = await runInstallDeps([], env);
    expect(code1).toBe(0);
    expect(code2).toBe(0);
  });
});
