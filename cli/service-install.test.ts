// acc2 cli/service-install tests — drive the platform-conditional unit/plist
// builder through an injected ServiceInstallEnv stub. We do NOT actually load
// the unit (loading is an explicit operator action), and we substitute
// `globalThis.process.platform` via the stub so the same test file exercises
// both Linux + macOS code paths regardless of where bun runs.

import { describe, expect, test } from "bun:test";
import {
  buildLaunchdPlist,
  buildSystemdUnit,
  installService,
  type ServiceInstallEnv,
} from "./service-install";

const captureEnv = (overrides: Partial<ServiceInstallEnv> = {}): { env: ServiceInstallEnv; writes: Array<{ path: string; contents: string }> } => {
  const writes: Array<{ path: string; contents: string }> = [];
  const env: ServiceInstallEnv = {
    platform: "linux",
    homedir: () => "/home/test",
    bunPath: "/usr/local/bin/bun",
    daemonScript: "/opt/acc2/runtime/daemon.ts",
    env: {},
    writer: (path, contents) => { writes.push({ path, contents }); },
    ...overrides,
  };
  return { env, writes };
};

describe("buildSystemdUnit", () => {
  test("user unit references the bun + daemon paths and includes propagated env", () => {
    const { env } = captureEnv({ env: { OPENAI_API_KEY: "sk-secret", ACC2_BRIDGE_MODE: "real", PATH: "/usr/bin" } });
    const unit = buildSystemdUnit(env, "user");
    expect(unit).toContain("[Unit]");
    expect(unit).toContain("[Service]");
    expect(unit).toContain("[Install]");
    expect(unit).toContain("ExecStart=/usr/local/bin/bun /opt/acc2/runtime/daemon.ts");
    expect(unit).toContain('Environment="OPENAI_API_KEY=sk-secret"');
    expect(unit).toContain('Environment="ACC2_BRIDGE_MODE=real"');
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain("Restart=on-failure");
  });

  test("system unit targets multi-user.target", () => {
    const { env } = captureEnv({ env: {} });
    const unit = buildSystemdUnit(env, "system");
    expect(unit).toContain("WantedBy=multi-user.target");
  });

  test("omits env keys that are unset", () => {
    const { env } = captureEnv({ env: {} });
    const unit = buildSystemdUnit(env, "user");
    expect(unit).not.toContain("Environment=\"OPENAI_API_KEY=");
  });
});

describe("buildLaunchdPlist", () => {
  test("plist contains Label, ProgramArguments, and KeepAlive", () => {
    const { env } = captureEnv({ platform: "darwin", env: { OPENAI_API_KEY: "sk-test" } });
    const plist = buildLaunchdPlist(env);
    expect(plist).toContain("<key>Label</key>");
    expect(plist).toContain("<string>com.accint.daemon</string>");
    expect(plist).toContain("<key>ProgramArguments</key>");
    expect(plist).toContain("<string>/usr/local/bin/bun</string>");
    expect(plist).toContain("<string>/opt/acc2/runtime/daemon.ts</string>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<true/>");
    expect(plist).toContain("<key>OPENAI_API_KEY</key>");
    expect(plist).toContain("<string>sk-test</string>");
  });

  test("escapes plist-special chars in env values", () => {
    const { env } = captureEnv({ platform: "darwin", env: { OPENAI_API_KEY: 'a<b&c>"d' } });
    const plist = buildLaunchdPlist(env);
    expect(plist).toContain("a&lt;b&amp;c&gt;&quot;d");
    expect(plist).not.toContain('a<b&c>"d');
  });
});

describe("installService (Linux)", () => {
  test("user scope writes to ~/.config/systemd/user/accint.service", () => {
    const { env, writes } = captureEnv({ platform: "linux" });
    const result = installService([], env);
    expect(result.exitCode).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toBe("/home/test/.config/systemd/user/accint.service");
    expect(writes[0]!.contents).toContain("ExecStart=");
    expect(result.loadCommand).toContain("systemctl --user");
    expect(result.outputs.join("\n")).toContain("wrote systemd user unit");
  });

  test("system scope writes to /etc/systemd/system/accint.service", () => {
    const { env, writes } = captureEnv({ platform: "linux" });
    const result = installService(["--system"], env);
    expect(result.exitCode).toBe(0);
    expect(writes[0]!.path).toBe("/etc/systemd/system/accint.service");
    expect(result.loadCommand).toContain("sudo systemctl");
  });

  test("write failure exits 1 with a helpful message", () => {
    const { env } = captureEnv({
      platform: "linux",
      writer: () => { throw new Error("EACCES: permission denied"); },
    });
    const result = installService(["--system"], env);
    expect(result.exitCode).toBe(1);
    expect(result.outputs.join("\n")).toContain("permission denied");
    expect(result.outputs.join("\n")).toContain("sudo");
  });
});

describe("installService (macOS)", () => {
  test("writes to ~/Library/LaunchAgents/com.accint.daemon.plist", () => {
    const { env, writes } = captureEnv({ platform: "darwin" });
    const result = installService([], env);
    expect(result.exitCode).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toBe("/home/test/Library/LaunchAgents/com.accint.daemon.plist");
    expect(writes[0]!.contents).toContain("<?xml version");
    expect(result.loadCommand).toContain("launchctl load");
  });
});

describe("installService (unsupported)", () => {
  test("exits 1 on win32", () => {
    const { env, writes } = captureEnv({ platform: "win32" });
    const result = installService([], env);
    expect(result.exitCode).toBe(1);
    expect(writes).toHaveLength(0);
    expect(result.outputs.join("\n")).toContain("not supported");
  });
});
