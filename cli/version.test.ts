// acc version test — verifies the version surface reads the shipped semver
// from package.json and degrades gracefully when no daemon is reachable.
// Self-contained: points ACC2_STATE_DIR at an empty temp dir so auxBaseUrl()
// resolves to null (no daemon lock) and the no-daemon branch is exercised
// without standing up a daemon fixture.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPackageVersion, runVersion } from "./version";

// Bun's console.log writes directly to the tty, NOT through
// process.stdout.write — so we capture by overriding console.log itself.
const capture = () => {
  const out: string[] = [];
  const orig = console.log;
  console.log = ((...args: unknown[]) => { out.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" ")); }) as typeof console.log;
  return { out, restore: () => { console.log = orig; } };
};

describe("acc version", () => {
  let tmpDir = "";
  let prevStateDir: string | undefined;
  let prevSocketFile: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "acc2-version-"));
    prevStateDir = process.env.ACC2_STATE_DIR;
    prevSocketFile = process.env.ACC2_SOCKET_FILE;
    process.env.ACC2_STATE_DIR = tmpDir;
    delete process.env.ACC2_SOCKET_FILE; // force resolution under the temp state dir
  });

  afterEach(() => {
    if (prevStateDir === undefined) delete process.env.ACC2_STATE_DIR;
    else process.env.ACC2_STATE_DIR = prevStateDir;
    if (prevSocketFile === undefined) delete process.env.ACC2_SOCKET_FILE;
    else process.env.ACC2_SOCKET_FILE = prevSocketFile;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  test("readPackageVersion returns a non-empty semver", () => {
    const v = readPackageVersion();
    expect(v).not.toBe("unknown");
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("plain output prints the version and the no-daemon hint", async () => {
    const c = capture();
    const code = await runVersion([]);
    c.restore();
    const text = c.out.join("");
    expect(code).toBe(0);
    expect(text).toContain(`acc2 ${readPackageVersion()}`);
    expect(text).toContain("daemon: not running");
  });

  test("--json emits machine-readable shape with null head when no daemon", async () => {
    const c = capture();
    const code = await runVersion(["--json"]);
    c.restore();
    expect(code).toBe(0);
    const parsed = JSON.parse(c.out.join("")) as {
      version: string;
      daemon_running: boolean;
      daemon_loaded_git_head: string | null;
      compatibility: {
        cli_package_version: string;
        daemon_loaded_git_head: string | null;
        state_schema: string;
        external_tools: string;
      };
    };
    expect(parsed.version).toBe(readPackageVersion());
    expect(parsed.daemon_running).toBe(false);
    expect(parsed.daemon_loaded_git_head).toBeNull();
    // Distribution/compat surface: version --json carries a compatibility block
    // pairing the CLI package version with the daemon's loaded head and naming
    // the canonical schema/tool probes (version.ts stays read-only / no SQLite).
    expect(parsed.compatibility).toBeDefined();
    expect(parsed.compatibility.cli_package_version).toBe(readPackageVersion());
    expect(parsed.compatibility.daemon_loaded_git_head).toBeNull();
    expect(typeof parsed.compatibility.state_schema).toBe("string");
    expect(parsed.compatibility.state_schema.length).toBeGreaterThan(0);
    expect(typeof parsed.compatibility.external_tools).toBe("string");
    expect(parsed.compatibility.external_tools.length).toBeGreaterThan(0);
  });
});
