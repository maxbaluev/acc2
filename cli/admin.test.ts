// acc2 cli/admin tests — drive the programmatic entry against injected
// AdminEnv stubs. Hermetic: no subprocess, no daemon, no network, no fs.

import { describe, expect, test } from "bun:test";
import { runAdmin, type AdminEnv } from "./admin";
import { defaultVersionEnv, type VersionEnv } from "../runtime/opencode_version";

const makeVersionEnv = (overrides: Partial<VersionEnv> = {}): VersionEnv => {
  const files = new Map<string, string>();
  return {
    which: () => null,
    spawn: () => ({ status: 0, stdout: "", stderr: "" }),
    fileExists: (p) => files.has(p),
    readFile: (p) => files.get(p) ?? null,
    writeFile: (p, c) => { files.set(p, c); },
    mkdirp: () => undefined,
    fetch: async () => ({ ok: false, status: 500, text: async () => "" }),
    homedir: () => "/home/test",
    now: () => 1_700_000_000_000,
    env: {},
    ...overrides,
  };
};

const makeEnv = (overrides: Partial<AdminEnv> = {}): { env: AdminEnv; out: string[]; err: string[] } => {
  const out: string[] = [];
  const err: string[] = [];
  const env: AdminEnv = {
    version: makeVersionEnv(),
    stopDaemon: async () => false,
    startDaemon: async () => undefined,
    prompt: async () => "y",
    out: (line) => { out.push(line); },
    err: (line) => { err.push(line); },
    yes: false,
    ...overrides,
  };
  return { env, out, err };
};

describe("acc admin help", () => {
  test("prints usage banner when no subcommand", async () => {
    const { env, out } = makeEnv();
    const code = await runAdmin([], env);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("opencode-version");
    expect(out.join("\n")).toContain("update-opencode");
    expect(out.join("\n")).toContain("upgrade-check");
  });

  test("returns 1 for unknown subcommand", async () => {
    const { env, err } = makeEnv();
    const code = await runAdmin(["bogus"], env);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("unknown subcommand");
  });
});

describe("acc admin opencode-version", () => {
  test("prints current + latest + up-to-date when versions equal", async () => {
    const { env, out } = makeEnv({
      version: makeVersionEnv({
        which: () => "/home/test/.opencode/bin/opencode",
        fileExists: () => true,
        spawn: () => ({ status: 0, stdout: "1.4.3\n", stderr: "" }),
        fetch: async () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ tag_name: "v1.4.3", published_at: "2026-04-01T00:00:00Z" }),
        }),
      }),
    });
    const code = await runAdmin(["opencode-version"], env);
    expect(code).toBe(0);
    const joined = out.join("\n");
    expect(joined).toContain("current: 1.4.3");
    expect(joined).toContain("latest:  1.4.3");
    expect(joined).toContain("up to date");
  });

  test("flags upgrade-available when current < latest", async () => {
    const { env, out } = makeEnv({
      version: makeVersionEnv({
        which: () => "/home/test/.opencode/bin/opencode",
        fileExists: () => true,
        spawn: () => ({ status: 0, stdout: "1.4.3\n", stderr: "" }),
        fetch: async () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ tag_name: "v1.5.0" }),
        }),
      }),
    });
    const code = await runAdmin(["opencode-version"], env);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("upgrade available");
  });

  test("returns 1 when opencode missing", async () => {
    const { env, err } = makeEnv({
      version: makeVersionEnv({
        which: () => null,
        fileExists: () => false,
      }),
    });
    const code = await runAdmin(["opencode-version"], env);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("not installed");
  });

  test("renders unknown when fetch fails", async () => {
    const { env, out } = makeEnv({
      version: makeVersionEnv({
        which: () => "/home/test/.opencode/bin/opencode",
        fileExists: () => true,
        spawn: () => ({ status: 0, stdout: "1.4.3\n", stderr: "" }),
        fetch: async () => ({ ok: false, status: 503, text: async () => "" }),
      }),
    });
    const code = await runAdmin(["opencode-version"], env);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("latest:  unknown");
  });
});

describe("acc admin update-opencode", () => {
  test("returns 1 when opencode missing", async () => {
    const { env, err } = makeEnv({
      version: makeVersionEnv({
        which: () => null,
        fileExists: () => false,
      }),
    });
    const code = await runAdmin(["update-opencode", "--yes"], env);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("not installed");
  });

  test("returns 0 when already current (informational)", async () => {
    const { env, out } = makeEnv({
      version: makeVersionEnv({
        which: () => "/home/test/.opencode/bin/opencode",
        fileExists: () => true,
        spawn: () => ({ status: 0, stdout: "1.5.0\n", stderr: "" }),
        fetch: async () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ tag_name: "v1.5.0" }),
        }),
      }),
    });
    const code = await runAdmin(["update-opencode", "--yes"], env);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("already current");
  });

  test("--yes path bypasses prompt and calls upgrade", async () => {
    let promptCalled = false;
    // `--version` is queried multiple times across the chain (admin pre-check
    // + updateOpencode's internal check + post-upgrade re-detection). We
    // flip to the new version only AFTER the upgrade command has been seen.
    let upgraded = false;
    const { env, out } = makeEnv({
      version: makeVersionEnv({
        which: () => "/home/test/.opencode/bin/opencode",
        fileExists: () => true,
        spawn: (cmd, args) => {
          if (args[0] === "--version") {
            return upgraded
              ? { status: 0, stdout: "1.5.0\n", stderr: "" }
              : { status: 0, stdout: "1.4.3\n", stderr: "" };
          }
          // Anything else is the upgrade command (`sh -lc curl … | bash`).
          upgraded = true;
          return { status: 0, stdout: "ok", stderr: "" };
        },
        fetch: async () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ tag_name: "v1.5.0" }),
        }),
      }),
      prompt: async () => { promptCalled = true; return "n"; },
    });
    const code = await runAdmin(["update-opencode", "--yes"], env);
    expect(promptCalled).toBe(false);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("opencode upgraded");
  });

  test("interactive 'n' answer cancels and returns 0", async () => {
    const { env, out } = makeEnv({
      version: makeVersionEnv({
        which: () => "/home/test/.opencode/bin/opencode",
        fileExists: () => true,
        spawn: () => ({ status: 0, stdout: "1.4.3\n", stderr: "" }),
        fetch: async () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ tag_name: "v1.5.0" }),
        }),
      }),
      prompt: async () => "n",
    });
    const code = await runAdmin(["update-opencode"], env);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("upgrade cancelled");
  });

  test("returns 1 on install failure", async () => {
    const { env, err } = makeEnv({
      version: makeVersionEnv({
        which: () => "/home/test/.opencode/bin/opencode",
        fileExists: () => true,
        spawn: (cmd, args) => {
          if (args[0] === "--version") return { status: 0, stdout: "1.4.3\n", stderr: "" };
          return { status: 1, stdout: "", stderr: "boom" };
        },
        fetch: async () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ tag_name: "v1.5.0" }),
        }),
      }),
    });
    const code = await runAdmin(["update-opencode", "--yes"], env);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("upgrade failed");
  });

  test("daemon stop+start invoked when daemon running", async () => {
    let stopCalled = false;
    let startCalled = false;
    let upgraded = false;
    const { env, out } = makeEnv({
      version: makeVersionEnv({
        which: () => "/home/test/.opencode/bin/opencode",
        fileExists: () => true,
        spawn: (cmd, args) => {
          if (args[0] === "--version") {
            return upgraded
              ? { status: 0, stdout: "1.5.0\n", stderr: "" }
              : { status: 0, stdout: "1.4.3\n", stderr: "" };
          }
          upgraded = true;
          return { status: 0, stdout: "ok", stderr: "" };
        },
        fetch: async () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ tag_name: "v1.5.0" }),
        }),
      }),
      stopDaemon: async () => { stopCalled = true; return true; },
      startDaemon: async () => { startCalled = true; },
    });
    const code = await runAdmin(["update-opencode", "--yes"], env);
    expect(code).toBe(0);
    expect(stopCalled).toBe(true);
    expect(startCalled).toBe(true);
    expect(out.join("\n")).toContain("daemon stopped before upgrade");
  });
});

describe("acc admin upgrade-check", () => {
  test("reports all subsystems", async () => {
    const { env, out } = makeEnv({
      version: makeVersionEnv({
        which: () => "/home/test/.opencode/bin/opencode",
        fileExists: () => true,
        spawn: (cmd, args) => {
          if (cmd === "/home/test/.opencode/bin/opencode" && args[0] === "--version") {
            return { status: 0, stdout: "1.4.3\n", stderr: "" };
          }
          if (cmd === "bun" && args[0] === "--version") return { status: 0, stdout: "1.3.0\n", stderr: "" };
          if (cmd === "uv" && args[0] === "--version") return { status: 0, stdout: "uv 0.5.0\n", stderr: "" };
          return { status: 1, stdout: "", stderr: "" };
        },
        fetch: async () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ tag_name: "v1.5.0" }),
        }),
      }),
    });
    const code = await runAdmin(["upgrade-check"], env);
    expect(code).toBe(0);
    const joined = out.join("\n");
    expect(joined).toContain("opencode");
    expect(joined).toContain("bun");
    expect(joined).toContain("uv");
    expect(joined).toContain("camoufox");
    expect(joined).toContain("[UPGRADE]"); // opencode 1.4.3 → 1.5.0
  });

  test("reports all-current when no upgrades available", async () => {
    const { env, out } = makeEnv({
      version: makeVersionEnv({
        which: () => "/home/test/.opencode/bin/opencode",
        fileExists: () => true,
        spawn: () => ({ status: 0, stdout: "1.5.0\n", stderr: "" }),
        fetch: async () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ tag_name: "v1.5.0" }),
        }),
      }),
    });
    const code = await runAdmin(["upgrade-check"], env);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("all subsystems current");
  });
});

describe("export shape", () => {
  test("runAdmin is exported as expected", () => {
    expect(typeof runAdmin).toBe("function");
  });

  test("defaultVersionEnv constructs without throwing", () => {
    const env = defaultVersionEnv();
    expect(typeof env.which).toBe("function");
    expect(typeof env.spawn).toBe("function");
  });
});
