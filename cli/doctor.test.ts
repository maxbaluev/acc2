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
  checkPendingMigrations,
  checkSourceUpdateAvailability,
  checkDaemonSourceSkew,
  checkOpencode,
  checkSeedArtifacts,
  checkSeedKnowledge,
  checkSeedRecipes,
  checkUv,
  checkVecExtensionLoadable,
  collectChecks,
  computeReadiness,
  renderReport,
  runDoctor,
  SEED_ARTIFACT_MIN,
  SEED_KNOWLEDGE_MIN,
  SEED_RECIPE_MIN,
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
  // Default to "substrate looks seeded" so unrelated tests don't have to
  // re-stub them. The three substrate-content checks have their own
  // describe blocks below that override these on purpose.
  substrateCounts: () => ({
    knowledgePromoted: SEED_KNOWLEDGE_MIN + 5,
    seedArtifacts: SEED_ARTIFACT_MIN + 3,
    recipeRows: SEED_RECIPE_MIN + 1,
    error: null,
  }),
  vecExtensionLoadable: () => ({ ok: true, version: "v0.1.6" }),
  pendingMigrations: () => ({ latest_version: "v002", applied_versions: ["v001", "v002"], pending_versions: [], pending_files: [], total_files: 2, up_to_date: true }),
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
  // UX dispatch b71pfyddv W8EPM66KFH (2026-05-15): missing OPENAI_API_KEY
  // is now a HARD FAIL, not a warn. Embeddings + real-brain retrieval
  // silently no-op without it; the system feels half-broken. The new
  // detail message points at `acc init --interactive` for paste+validate.
  test("fail when absent", () => {
    expect(checkOpenAiKey(makeEnv({ env: {} })).verdict).toBe("fail");
  });
  test("fail when empty string", () => {
    expect(checkOpenAiKey(makeEnv({ env: { OPENAI_API_KEY: "   " } })).verdict).toBe("fail");
  });
});

describe("checkSerperKey", () => {
  test("ok when present", () => {
    const { checkSerperKey } = require("./doctor");
    expect(checkSerperKey(makeEnv({ env: { SERPER_API_KEY: "abc" } })).verdict).toBe("ok");
  });
  test("warn when absent (recommended, not required)", () => {
    const { checkSerperKey } = require("./doctor");
    expect(checkSerperKey(makeEnv({ env: {} })).verdict).toBe("warn");
  });
});

describe("update/skew checks", () => {
  test("checkPendingMigrations warns when versions are pending", () => {
    const c = checkPendingMigrations(makeEnv({ pendingMigrations: () => ({ latest_version: "v003", applied_versions: ["v001"], pending_versions: ["v002", "v003"], pending_files: ["v002_a.sql", "v003_b.sql"], total_files: 3, up_to_date: false }) }));
    expect(c.verdict).toBe("warn");
    expect(c.detail).toContain("acc update");
  });
  test("checkSourceUpdateAvailability warns when upstream differs", () => {
    const c = checkSourceUpdateAvailability(makeEnv({ version: (_cmd, args) => args[1] === "HEAD" ? "aaa" : "bbb" }));
    expect(c.verdict).toBe("warn");
  });
  test("checkDaemonSourceSkew warns when daemon reports a different loaded head", async () => {
    const c = await checkDaemonSourceSkew(makeEnv({ version: () => "source-head", daemonHealth: async () => ({ reachable: true, ok: true, raw: { loaded_git_head: "daemon-head" } }) }));
    expect(c.verdict).toBe("warn");
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

describe("parseOpencodeAuth", () => {
  const { parseOpencodeAuth } = require("./doctor");
  test("parses two credentials + two env providers", () => {
    const raw = [
      "┌  Credentials ~/.local/share/opencode/auth.json",
      "│",
      "●  Cerebras api",
      "│",
      "●  OpenAI oauth",
      "│",
      "└  2 credentials",
      "",
      "┌  Environment",
      "│",
      "●  Google GEMINI_API_KEY",
      "●  Anthropic ANTHROPIC_API_KEY",
      "└  2 environment variables",
    ].join("\n");
    const s = parseOpencodeAuth(raw);
    expect(s.credentialCount).toBe(2);
    expect(s.envProviderCount).toBe(2);
    expect(s.credentials).toEqual(["Cerebras", "OpenAI"]);
    expect(s.envProviders).toEqual(["Google", "Anthropic"]);
  });
  test("ignores ANSI escape sequences", () => {
    const raw = "\x1b[0m┌  Credentials \x1b[90m~/auth.json\n●  OpenAI \x1b[90moauth\n└  1 credentials";
    const s = parseOpencodeAuth(raw);
    expect(s.credentialCount).toBe(1);
    expect(s.credentials).toEqual(["OpenAI"]);
  });
  test("empty when no sections", () => {
    const s = parseOpencodeAuth("");
    expect(s.credentialCount).toBe(0);
    expect(s.envProviderCount).toBe(0);
  });
});

describe("checkOpencodeAuth", () => {
  const { checkOpencodeAuth } = require("./doctor");
  test("warn when opencode binary is missing", () => {
    const c = checkOpencodeAuth(makeEnv({ which: () => null }));
    expect(c.verdict).toBe("warn");
    expect(c.detail).toContain("skipped");
  });
  test("warn when `opencode auth list` exits non-zero", () => {
    const c = checkOpencodeAuth(makeEnv({
      which: (cmd) => cmd === "opencode" ? "/u/b/opencode" : null,
      version: () => null,
    }));
    expect(c.verdict).toBe("warn");
    expect(c.detail).toContain("could not probe");
  });
  test("fail when zero credentials AND zero env providers", () => {
    const raw = "┌  Credentials ~/auth.json\n└  0 credentials\n┌  Environment\n└  0 environment variables";
    const c = checkOpencodeAuth(makeEnv({
      which: (cmd) => cmd === "opencode" ? "/u/b/opencode" : null,
      version: () => raw,
    }));
    expect(c.verdict).toBe("fail");
    expect(c.detail).toContain("opencode auth login");
  });
  test("warn when env-var providers only (no OAuth)", () => {
    const raw = "┌  Credentials ~/auth.json\n└  0 credentials\n┌  Environment\n●  Anthropic ANTHROPIC_API_KEY\n└  1 environment variables";
    const c = checkOpencodeAuth(makeEnv({
      which: (cmd) => cmd === "opencode" ? "/u/b/opencode" : null,
      version: () => raw,
    }));
    expect(c.verdict).toBe("warn");
    expect(c.detail).toContain("OAuth login recommended");
  });
  test("ok when at least one credential is present", () => {
    const raw = "┌  Credentials ~/auth.json\n●  OpenAI oauth\n└  1 credentials\n┌  Environment\n└  0 environment variables";
    const c = checkOpencodeAuth(makeEnv({
      which: (cmd) => cmd === "opencode" ? "/u/b/opencode" : null,
      version: () => raw,
    }));
    expect(c.verdict).toBe("ok");
    expect(c.detail).toContain("OpenAI");
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
  test("ok when absent (defaults to real per production default)", () => {
    expect(checkBridgeMode(makeEnv({ env: {} })).verdict).toBe("ok");
  });
  test("warn for unknown value", () => {
    expect(checkBridgeMode(makeEnv({ env: { ACC2_BRIDGE_MODE: "weird" } })).verdict).toBe("warn");
  });
});

describe("checkSeedKnowledge (Task 3 substrate-content check)", () => {
  test("ok when knowledge_promoted >= SEED_KNOWLEDGE_MIN", () => {
    const c = checkSeedKnowledge(makeEnv({
      substrateCounts: () => ({
        knowledgePromoted: SEED_KNOWLEDGE_MIN,
        seedArtifacts: SEED_ARTIFACT_MIN,
        recipeRows: SEED_RECIPE_MIN,
        error: null,
      }),
    }));
    expect(c.verdict).toBe("ok");
    expect(c.detail).toContain("knowledge_promoted");
  });
  test("fail when below the minimum", () => {
    const c = checkSeedKnowledge(makeEnv({
      substrateCounts: () => ({
        knowledgePromoted: 0,
        seedArtifacts: 0,
        recipeRows: 0,
        error: null,
      }),
    }));
    expect(c.verdict).toBe("fail");
    expect(c.detail).toContain("acc init");
  });
  test("fail when probe errors (e.g. db missing)", () => {
    const c = checkSeedKnowledge(makeEnv({
      substrateCounts: () => ({
        knowledgePromoted: NaN,
        seedArtifacts: NaN,
        recipeRows: NaN,
        error: "state DB not found at /tmp/missing",
      }),
    }));
    expect(c.verdict).toBe("fail");
    expect(c.detail).toContain("state DB not found");
  });
});

describe("checkSeedArtifacts (Task 3 substrate-content check)", () => {
  test("ok when seed_* artifacts >= SEED_ARTIFACT_MIN", () => {
    const c = checkSeedArtifacts(makeEnv({
      substrateCounts: () => ({
        knowledgePromoted: SEED_KNOWLEDGE_MIN,
        seedArtifacts: SEED_ARTIFACT_MIN,
        recipeRows: SEED_RECIPE_MIN,
        error: null,
      }),
    }));
    expect(c.verdict).toBe("ok");
    expect(c.detail).toContain("seed_*");
  });
  test("fail when no seed artifacts present", () => {
    const c = checkSeedArtifacts(makeEnv({
      substrateCounts: () => ({
        knowledgePromoted: SEED_KNOWLEDGE_MIN,
        seedArtifacts: 0,
        recipeRows: SEED_RECIPE_MIN,
        error: null,
      }),
    }));
    expect(c.verdict).toBe("fail");
    expect(c.detail).toContain("acc init");
  });
});

describe("checkSeedRecipes (final substrate-content check)", () => {
  test("ok when recipe-shape knowledge >= SEED_RECIPE_MIN", () => {
    const c = checkSeedRecipes(makeEnv({
      substrateCounts: () => ({
        knowledgePromoted: SEED_KNOWLEDGE_MIN,
        seedArtifacts: SEED_ARTIFACT_MIN,
        recipeRows: SEED_RECIPE_MIN,
        error: null,
      }),
    }));
    expect(c.verdict).toBe("ok");
    expect(c.detail).toContain("recipe-shape knowledge");
  });
  test("fail when no recipes seeded", () => {
    const c = checkSeedRecipes(makeEnv({
      substrateCounts: () => ({
        knowledgePromoted: SEED_KNOWLEDGE_MIN,
        seedArtifacts: SEED_ARTIFACT_MIN,
        recipeRows: 0,
        error: null,
      }),
    }));
    expect(c.verdict).toBe("fail");
    expect(c.detail).toContain("acc init");
  });
  test("fail when probe errors", () => {
    const c = checkSeedRecipes(makeEnv({
      substrateCounts: () => ({
        knowledgePromoted: NaN,
        seedArtifacts: NaN,
        recipeRows: NaN,
        error: "state DB not found",
      }),
    }));
    expect(c.verdict).toBe("fail");
    expect(c.detail).toContain("state DB not found");
  });
});

describe("checkVecExtensionLoadable (Task 3 substrate-content check)", () => {
  test("ok when vec0 loads + virtual-table constructor works", () => {
    const c = checkVecExtensionLoadable(makeEnv({
      vecExtensionLoadable: () => ({ ok: true, version: "v0.1.6" }),
    }));
    expect(c.verdict).toBe("ok");
    expect(c.detail).toContain("v0.1.6");
  });
  test("fail when extension cannot load", () => {
    const c = checkVecExtensionLoadable(makeEnv({
      vecExtensionLoadable: () => ({ ok: false, error: "loadExtension refused" }),
    }));
    expect(c.verdict).toBe("fail");
    expect(c.detail).toContain("silently degrade");
    expect(c.detail).toContain("loadExtension refused");
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

  test("FAIL when seed knowledge / seed artifacts / sqlite-vec extension fail (Task 3)", () => {
    const checks = [
      { name: "daemon health", verdict: "ok", detail: "" },
      { name: "OPENAI_API_KEY", verdict: "ok", detail: "" },
      { name: "opencode", verdict: "ok", detail: "" },
      { name: "ACC2_BRIDGE_MODE", verdict: "ok", detail: "" },
      { name: "seed knowledge", verdict: "fail", detail: "0 promoted" },
      { name: "seed artifacts", verdict: "fail", detail: "0 seed_*" },
      { name: "sqlite-vec extension", verdict: "fail", detail: "vec0 not loadable" },
    ] as const;
    const r = computeReadiness([...checks]);
    expect(r.check.verdict).toBe("fail");
    expect(r.missing).toContain("seed knowledge");
    expect(r.missing).toContain("seed artifacts");
    expect(r.missing).toContain("sqlite-vec extension");
  });

  test("FAIL when seed recipes fail (final unification pass)", () => {
    const checks = [
      { name: "daemon health", verdict: "ok", detail: "" },
      { name: "OPENAI_API_KEY", verdict: "ok", detail: "" },
      { name: "opencode", verdict: "ok", detail: "" },
      { name: "ACC2_BRIDGE_MODE", verdict: "ok", detail: "" },
      { name: "seed knowledge", verdict: "ok", detail: "" },
      { name: "seed artifacts", verdict: "ok", detail: "" },
      { name: "seed recipes", verdict: "fail", detail: "0 recipes" },
      { name: "sqlite-vec extension", verdict: "ok", detail: "" },
    ] as const;
    const r = computeReadiness([...checks]);
    expect(r.check.verdict).toBe("fail");
    expect(r.missing).toContain("seed recipes");
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
      version: (cmd, args) => {
        if (cmd === "bun") return "1.3.11";
        if (cmd === "opencode" && args[0] === "auth") {
          return "┌  Credentials ~/auth.json\n●  OpenAI oauth\n└  1 credentials";
        }
        if (cmd === "opencode") return "opencode 1.0";
        if (cmd === "uv") return "uv 0.8";
        return null;
      },
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
      "SERPER_API_KEY",
      "opencode",
      "opencode auth",
      "uv",
      "camoufox binary",
      "nsjail",
      "bun",
      "pending migrations",
      "acc source update",
      "daemon/source skew",
      "ACC2_BRIDGE_MODE",
      "seed knowledge",
      "seed artifacts",
      "seed recipes",
      "sqlite-vec extension",
    ]);
  });
});
