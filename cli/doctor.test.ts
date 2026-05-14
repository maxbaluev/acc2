// acc2 cli/doctor tests — drive each check with an injected DoctorEnv stub so
// the test stays hermetic (no subprocess, no real daemon, no real fs). The
// production wiring (`defaultDoctorEnv`) is exercised indirectly via
// dispatch.test.ts when `acc doctor` is invoked against a live daemon.

import { describe, expect, test } from "bun:test";
import {
  checkBridgeMode,
  checkBunVersion,
  checkCamoufoxBinary,
  checkDaemonHealth,
  checkDbIntegrity,
  checkDiskFree,
  checkNsjail,
  checkOpenAiKey,
  checkOpencode,
  checkUv,
  collectChecks,
  computeReadiness,
  renderReport,
  runDoctor,
  type DoctorEnv,
  type DaemonHealthSnapshot,
} from "./doctor";

const makeEnv = (overrides: Partial<DoctorEnv> = {}): DoctorEnv => ({
  env: {},
  which: () => null,
  version: () => null,
  fileExists: () => false,
  diskFreeBytes: () => 10_000_000_000,
  daemonHealth: async (): Promise<DaemonHealthSnapshot> =>
    ({ reachable: true, ok: true, pid: 999, uptime_ms: 1000, events_count: 0 }),
  homedir: () => "/home/test",
  platform: "linux",
  ...overrides,
});

describe("checkDaemonHealth", () => {
  test("ok when daemon reachable + healthy", async () => {
    const c = await checkDaemonHealth(makeEnv({
      daemonHealth: async () => ({ reachable: true, ok: true, pid: 42, uptime_ms: 3_600_000 + 60_000, events_count: 12 }),
    }));
    expect(c.verdict).toBe("ok");
    expect(c.detail).toContain("pid 42");
    expect(c.detail).toContain("uptime 1h1m");
    expect(c.detail).toContain("events=12");
  });

  test("warn when unreachable", async () => {
    const c = await checkDaemonHealth(makeEnv({
      daemonHealth: async () => ({ reachable: false, ok: false, error: "ECONNREFUSED" }),
    }));
    expect(c.verdict).toBe("warn");
    expect(c.detail).toContain("acc daemon start");
  });

  test("fail when reachable but unhealthy", async () => {
    const c = await checkDaemonHealth(makeEnv({
      daemonHealth: async () => ({ reachable: true, ok: false, raw: { status: "degraded" } }),
    }));
    expect(c.verdict).toBe("fail");
  });
});

describe("checkDbIntegrity", () => {
  test("ok when daemon healthy", async () => {
    const c = await checkDbIntegrity(makeEnv({
      daemonHealth: async () => ({ reachable: true, ok: true, events_count: 7 }),
    }));
    expect(c.verdict).toBe("ok");
    expect(c.detail).toContain("events=7");
  });

  test("warn when daemon unreachable", async () => {
    const c = await checkDbIntegrity(makeEnv({
      daemonHealth: async () => ({ reachable: false, ok: false }),
    }));
    expect(c.verdict).toBe("warn");
  });

  test("fail when daemon unhealthy", async () => {
    const c = await checkDbIntegrity(makeEnv({
      daemonHealth: async () => ({ reachable: true, ok: false }),
    }));
    expect(c.verdict).toBe("fail");
  });
});

describe("checkDiskFree", () => {
  test("ok at ≥ 2GB", () => {
    expect(checkDiskFree(makeEnv({ diskFreeBytes: () => 5_000_000_000 })).verdict).toBe("ok");
  });
  test("warn between 500MB and 2GB", () => {
    expect(checkDiskFree(makeEnv({ diskFreeBytes: () => 1_500_000_000 })).verdict).toBe("warn");
  });
  test("fail at < 500MB", () => {
    expect(checkDiskFree(makeEnv({ diskFreeBytes: () => 100_000_000 })).verdict).toBe("fail");
  });
  test("warn when statfs fails (null)", () => {
    expect(checkDiskFree(makeEnv({ diskFreeBytes: () => null })).verdict).toBe("warn");
  });
});

describe("checkOpenAiKey", () => {
  test("ok when present", () => {
    expect(checkOpenAiKey(makeEnv({ env: { OPENAI_API_KEY: "sk-test" } })).verdict).toBe("ok");
  });
  test("warn when absent", () => {
    expect(checkOpenAiKey(makeEnv({ env: {} })).verdict).toBe("warn");
  });
  test("warn when empty string", () => {
    expect(checkOpenAiKey(makeEnv({ env: { OPENAI_API_KEY: "   " } })).verdict).toBe("warn");
  });
});

describe("checkOpencode", () => {
  test("ok when on PATH", () => {
    const c = checkOpencode(makeEnv({
      which: (cmd) => cmd === "opencode" ? "/usr/local/bin/opencode" : null,
      version: () => "opencode 1.4.3",
    }));
    expect(c.verdict).toBe("ok");
    expect(c.detail).toContain("/usr/local/bin/opencode");
  });
  test("fail when missing", () => {
    expect(checkOpencode(makeEnv({ which: () => null })).verdict).toBe("fail");
  });
});

describe("checkUv", () => {
  test("ok when on PATH", () => {
    const c = checkUv(makeEnv({ which: (cmd) => cmd === "uv" ? "/home/u/.local/bin/uv" : null, version: () => "uv 0.8.23" }));
    expect(c.verdict).toBe("ok");
  });
  test("warn when missing", () => {
    expect(checkUv(makeEnv({ which: () => null })).verdict).toBe("warn");
  });
});

describe("checkCamoufoxBinary", () => {
  test("ok via explicit CAMOUFOX_BINARY_PATH", () => {
    const c = checkCamoufoxBinary(makeEnv({
      env: { CAMOUFOX_BINARY_PATH: "/opt/camoufox/camoufox" },
      fileExists: (p) => p === "/opt/camoufox/camoufox",
    }));
    expect(c.verdict).toBe("ok");
    expect(c.detail).toContain("/opt/camoufox/camoufox");
  });
  test("ok via ~/.cache/camoufox/camoufox", () => {
    const c = checkCamoufoxBinary(makeEnv({
      fileExists: (p) => p === "/home/test/.cache/camoufox/camoufox",
    }));
    expect(c.verdict).toBe("ok");
  });
  test("warn when neither present", () => {
    expect(checkCamoufoxBinary(makeEnv({ fileExists: () => false })).verdict).toBe("warn");
  });
});

describe("checkNsjail", () => {
  test("ok when present", () => {
    const c = checkNsjail(makeEnv({ which: (cmd) => cmd === "nsjail" ? "/usr/bin/nsjail" : null }));
    expect(c.verdict).toBe("ok");
  });
  test("warn when missing (Batch 3.CLEANUP — security-sensitive surfacing)", () => {
    // Bumped from `info` to `warn` so the doctor's overall verdict surfaces
    // the gap. nsjail is the uv runtime's enforcement boundary; without it
    // the sandbox is honor-system and brain-authored artifacts can escape.
    const c = checkNsjail(makeEnv({ which: () => null }));
    expect(c.verdict).toBe("warn");
    expect(c.detail).toContain("honor-system");
  });
});

describe("checkBunVersion", () => {
  test("ok at 1.x", () => {
    expect(checkBunVersion(makeEnv({ version: () => "1.3.11" })).verdict).toBe("ok");
  });
  test("fail at 0.x", () => {
    expect(checkBunVersion(makeEnv({ version: () => "0.9.0" })).verdict).toBe("fail");
  });
  test("fail when bun not found", () => {
    expect(checkBunVersion(makeEnv({ version: () => null })).verdict).toBe("fail");
  });
});

describe("checkBridgeMode", () => {
  test("ok at 'real'", () => {
    expect(checkBridgeMode(makeEnv({ env: { ACC2_BRIDGE_MODE: "real" } })).verdict).toBe("ok");
  });
  test("info at 'mock'", () => {
    expect(checkBridgeMode(makeEnv({ env: { ACC2_BRIDGE_MODE: "mock" } })).verdict).toBe("info");
  });
  test("info when absent (defaults to mock)", () => {
    expect(checkBridgeMode(makeEnv({ env: {} })).verdict).toBe("info");
  });
  test("warn for unknown value", () => {
    expect(checkBridgeMode(makeEnv({ env: { ACC2_BRIDGE_MODE: "weird" } })).verdict).toBe("warn");
  });
});

describe("computeReadiness", () => {
  test("PASS when daemon ok + OPENAI ok + opencode ok + bridge real", () => {
    const checks = [
      { name: "daemon health", verdict: "ok", detail: "" },
      { name: "OPENAI_API_KEY", verdict: "ok", detail: "" },
      { name: "opencode", verdict: "ok", detail: "" },
      { name: "ACC2_BRIDGE_MODE", verdict: "ok", detail: "" },
    ] as const;
    const r = computeReadiness([...checks]);
    expect(r.check.verdict).toBe("ok");
    expect(r.missing).toEqual([]);
  });

  test("FAIL lists every missing prereq", () => {
    const checks = [
      { name: "daemon health", verdict: "warn", detail: "" },
      { name: "OPENAI_API_KEY", verdict: "warn", detail: "" },
      { name: "opencode", verdict: "fail", detail: "" },
      { name: "ACC2_BRIDGE_MODE", verdict: "info", detail: "" },
    ] as const;
    const r = computeReadiness([...checks]);
    expect(r.check.verdict).toBe("fail");
    expect(r.missing).toContain("daemon health");
    expect(r.missing).toContain("OPENAI_API_KEY");
    expect(r.missing).toContain("opencode");
    expect(r.missing).toContain("ACC2_BRIDGE_MODE=real");
  });
});

describe("renderReport", () => {
  test("plain mode emits no ANSI codes", () => {
    const checks = [{ name: "x", verdict: "ok", detail: "ok" } as const];
    const r = computeReadiness([...checks, { name: "daemon health", verdict: "ok", detail: "" }, { name: "OPENAI_API_KEY", verdict: "ok", detail: "" }, { name: "opencode", verdict: "ok", detail: "" }, { name: "ACC2_BRIDGE_MODE", verdict: "ok", detail: "" }]);
    const lines = renderReport([...checks], r, false);
    const joined = lines.join("\n");
    expect(joined).not.toContain("\x1b[");
    expect(joined).toContain("[ok  ]");
  });

  test("colour mode includes ANSI codes", () => {
    const checks = [{ name: "x", verdict: "fail", detail: "fail" } as const];
    const r = computeReadiness([...checks]);
    const lines = renderReport([...checks], r, true);
    expect(lines.join("\n")).toContain("\x1b[31m");
  });
});

describe("runDoctor end-to-end (stubbed)", () => {
  test("exit 0 on all-ok env", async () => {
    const out: string[] = [];
    const env = makeEnv({
      env: { OPENAI_API_KEY: "sk-test", ACC2_BRIDGE_MODE: "real" },
      which: (cmd) => cmd === "opencode" ? "/usr/bin/opencode" : cmd === "uv" ? "/usr/bin/uv" : cmd === "nsjail" ? "/usr/bin/nsjail" : null,
      version: (cmd) => cmd === "bun" ? "1.3.11" : cmd === "opencode" ? "opencode 1.0" : cmd === "uv" ? "uv 0.8" : null,
      fileExists: () => true,
      daemonHealth: async () => ({ reachable: true, ok: true, pid: 1, uptime_ms: 100, events_count: 5 }),
    });
    const code = await runDoctor([], env, (l) => out.push(l));
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("PASS");
  });

  test("exit 1 when daemon down + missing key + missing opencode + mock mode", async () => {
    const out: string[] = [];
    const env = makeEnv({
      env: { ACC2_BRIDGE_MODE: "mock" },
      which: () => null,
      version: (cmd) => cmd === "bun" ? "1.3.0" : null,
      daemonHealth: async () => ({ reachable: false, ok: false, error: "ECONNREFUSED" }),
    });
    const code = await runDoctor([], env, (l) => out.push(l));
    expect(code).toBe(1);
    const joined = out.join("\n");
    expect(joined).toContain("FAIL");
    expect(joined).toContain("opencode");
    expect(joined).toContain("OPENAI_API_KEY");
  });
});

describe("collectChecks ordering", () => {
  test("emits checks in the documented order", async () => {
    const env = makeEnv();
    const checks = await collectChecks(env);
    const names = checks.map((c) => c.name);
    expect(names).toEqual([
      "daemon health",
      "db integrity",
      "disk space",
      "OPENAI_API_KEY",
      "opencode",
      "uv",
      "camoufox binary",
      "nsjail",
      "bun",
      "ACC2_BRIDGE_MODE",
    ]);
  });
});
