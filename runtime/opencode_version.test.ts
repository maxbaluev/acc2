// acc2 opencode_version tests — drive each function with an injected
// VersionEnv stub so the suite stays hermetic (no subprocess, no real
// network, no real fs).

import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb } from "../substrate/db";
import {
  checkLatestOpencodeVersion,
  compareSemver,
  detectOpencodeVersion,
  parseSemver,
  updateOpencode,
  type VersionEnv,
} from "./opencode_version";

const makeEnv = (overrides: Partial<VersionEnv> = {}): VersionEnv => {
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

describe("parseSemver / compareSemver", () => {
  test("parses simple semver", () => {
    expect(parseSemver("1.4.3")).toEqual([1, 4, 3]);
  });

  test("parses v-prefixed semver", () => {
    expect(parseSemver("v1.4.3")).toEqual([1, 4, 3]);
  });

  test("parses 'opencode 1.4.3' shape", () => {
    expect(parseSemver("opencode 1.4.3")).toEqual([1, 4, 3]);
  });

  test("ignores pre-release suffix", () => {
    expect(parseSemver("1.5.0-beta.2")).toEqual([1, 5, 0]);
  });

  test("compareSemver: 1.4.3 < 1.4.4", () => {
    expect(compareSemver("1.4.3", "1.4.4")).toBe(-1);
  });

  test("compareSemver: 1.4.3 < 1.5.0", () => {
    expect(compareSemver("1.4.3", "1.5.0")).toBe(-1);
  });

  test("compareSemver: 2.0.0 > 1.99.99", () => {
    expect(compareSemver("2.0.0", "1.99.99")).toBe(1);
  });

  test("compareSemver: equal", () => {
    expect(compareSemver("1.4.3", "1.4.3")).toBe(0);
  });
});

describe("detectOpencodeVersion", () => {
  test("returns version + official-script method for ~/.opencode/bin/opencode", async () => {
    const env = makeEnv({
      which: () => "/home/test/.opencode/bin/opencode",
      fileExists: () => true,
      spawn: (cmd, args) => {
        if (args[0] === "--version") return { status: 0, stdout: "1.4.3\n", stderr: "" };
        return { status: 1, stdout: "", stderr: "" };
      },
    });
    const v = await detectOpencodeVersion(env);
    expect(v.version).toBe("1.4.3");
    expect(v.installMethod).toBe("official-script");
    expect(v.binaryExists).toBe(true);
  });

  test("returns npm method for /node_modules/.bin path", async () => {
    const env = makeEnv({
      which: () => "/usr/lib/node_modules/.bin/opencode",
      fileExists: () => true,
      spawn: () => ({ status: 0, stdout: "1.4.3\n", stderr: "" }),
    });
    const v = await detectOpencodeVersion(env);
    expect(v.installMethod).toBe("npm");
  });

  test("returns bun method for ~/.bun/install/global/bin path", async () => {
    const env = makeEnv({
      which: () => "/home/test/.bun/install/global/bin/opencode",
      fileExists: () => true,
      spawn: () => ({ status: 0, stdout: "1.4.3\n", stderr: "" }),
    });
    const v = await detectOpencodeVersion(env);
    expect(v.installMethod).toBe("bun");
  });

  test("returns unknown method when binary missing", async () => {
    const env = makeEnv({
      which: () => null,
      fileExists: () => false,
    });
    const v = await detectOpencodeVersion(env);
    expect(v.binaryExists).toBe(false);
    expect(v.installMethod).toBe("unknown");
    expect(v.version).toBe("unknown");
  });

  test("handles 'opencode <ver>' prefix in --version output", async () => {
    const env = makeEnv({
      which: () => "/home/test/.opencode/bin/opencode",
      fileExists: () => true,
      spawn: () => ({ status: 0, stdout: "opencode 1.5.0\n", stderr: "" }),
    });
    const v = await detectOpencodeVersion(env);
    expect(v.version).toBe("1.5.0");
  });

  test("/usr/local/bin probed via npm list", async () => {
    const env = makeEnv({
      which: () => "/usr/local/bin/opencode",
      fileExists: () => true,
      spawn: (cmd, args) => {
        if (cmd === "/usr/local/bin/opencode" && args[0] === "--version") {
          return { status: 0, stdout: "1.4.3\n", stderr: "" };
        }
        if (cmd === "npm" && args[0] === "list") {
          return { status: 0, stdout: "/usr/lib/node_modules\n└── opencode-ai@1.4.3\n", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: "" };
      },
    });
    const v = await detectOpencodeVersion(env);
    expect(v.installMethod).toBe("npm");
  });
});

describe("checkLatestOpencodeVersion", () => {
  test("fetches from GitHub when cache absent", async () => {
    let fetchCount = 0;
    const env = makeEnv({
      fetch: async (url) => {
        fetchCount++;
        expect(url).toContain("api.github.com/repos/sst/opencode");
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            tag_name: "v1.5.0",
            published_at: "2026-05-01T12:00:00Z",
            html_url: "https://github.com/sst/opencode/releases/tag/v1.5.0",
            body: "Release notes go here.",
          }),
        };
      },
    });
    const r = await checkLatestOpencodeVersion(env);
    expect(r?.version).toBe("1.5.0");
    expect(r?.releasedAt).toBe("2026-05-01T12:00:00Z");
    expect(fetchCount).toBe(1);
  });

  test("writes through to cache file", async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const env = makeEnv({
      fetch: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ tag_name: "v1.6.0", published_at: "" }),
      }),
      writeFile: (path, content) => { writes.push({ path, content }); },
    });
    await checkLatestOpencodeVersion(env);
    expect(writes.length).toBe(1);
    expect(writes[0]!.path).toBe("/home/test/.accint/state/cache/opencode-latest.json");
    const parsed = JSON.parse(writes[0]!.content);
    expect(parsed.release.version).toBe("1.6.0");
    expect(parsed.fetched_at).toBeGreaterThan(0);
  });

  test("returns cached entry when within TTL", async () => {
    const cached = JSON.stringify({
      fetched_at: 1_700_000_000_000 - 30_000, // 30s old
      release: {
        version: "1.4.4",
        releasedAt: "2026-04-15T00:00:00Z",
        releaseUrl: "https://example.com",
      },
    });
    let fetchCount = 0;
    const env = makeEnv({
      readFile: (p) =>
        p === "/home/test/.accint/state/cache/opencode-latest.json" ? cached : null,
      fileExists: (p) =>
        p === "/home/test/.accint/state/cache/opencode-latest.json",
      fetch: async () => { fetchCount++; return { ok: true, status: 200, text: async () => "{}" }; },
    });
    const r = await checkLatestOpencodeVersion(env);
    expect(r?.version).toBe("1.4.4");
    expect(fetchCount).toBe(0);
  });

  test("re-fetches when cache expired", async () => {
    const cached = JSON.stringify({
      fetched_at: 1_700_000_000_000 - 2 * 60 * 60 * 1000, // 2h old > TTL
      release: { version: "1.4.4", releasedAt: "", releaseUrl: "" },
    });
    let fetchCount = 0;
    const env = makeEnv({
      readFile: () => cached,
      fileExists: () => true,
      fetch: async () => {
        fetchCount++;
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ tag_name: "v1.5.0" }),
        };
      },
    });
    const r = await checkLatestOpencodeVersion(env);
    expect(r?.version).toBe("1.5.0");
    expect(fetchCount).toBe(1);
  });

  test("returns null on fetch failure", async () => {
    const env = makeEnv({
      fetch: async () => ({ ok: false, status: 502, text: async () => "" }),
    });
    expect(await checkLatestOpencodeVersion(env)).toBeNull();
  });

  test("includes GITHUB_TOKEN authorization header when set", async () => {
    let seenHeaders: Record<string, string> = {};
    const env = makeEnv({
      env: { GITHUB_TOKEN: "ghp_test" },
      fetch: async (url, init) => {
        seenHeaders = init?.headers ?? {};
        return { ok: true, status: 200, text: async () => JSON.stringify({ tag_name: "v1.5.0" }) };
      },
    });
    await checkLatestOpencodeVersion(env);
    expect(seenHeaders["Authorization"]).toBe("Bearer ghp_test");
  });
});

describe("updateOpencode", () => {
  let dir = "";
  let dbPath = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "acc2-opencode-upd-"));
    dbPath = join(dir, "test.db");
  });

  const makeDb = () => openDb(dbPath);

  test("returns no_update_available when current >= latest", async () => {
    const env = makeEnv({
      which: () => "/home/test/.opencode/bin/opencode",
      fileExists: () => true,
      spawn: () => ({ status: 0, stdout: "1.5.0\n", stderr: "" }),
      fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ tag_name: "v1.5.0" }) }),
    });
    const result = await updateOpencode({ env });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_update_available");
    closeDb(dbPath);
    rmSync(dir, { recursive: true, force: true });
  });

  test("refuses scripted upgrade for manual install method", async () => {
    const db = makeDb();
    let spawnCount = 0;
    const env = makeEnv({
      which: () => "/usr/local/bin/opencode",
      fileExists: () => true,
      spawn: (cmd, args) => {
        spawnCount++;
        if (cmd === "/usr/local/bin/opencode" && args[0] === "--version") {
          return { status: 0, stdout: "1.4.3\n", stderr: "" };
        }
        // npm list -g returns non-zero → manual
        return { status: 1, stdout: "", stderr: "" };
      },
      fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ tag_name: "v1.5.0" }) }),
    });
    const result = await updateOpencode({ env, db });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("permission_denied");

    // Verify the failure event landed.
    const rows = db.query("SELECT kind FROM events WHERE kind = 'opencode_upgrade_failed'").all() as Array<{ kind: string }>;
    expect(rows.length).toBe(1);
    expect(spawnCount).toBeGreaterThan(0);
    closeDb(dbPath);
    rmSync(dir, { recursive: true, force: true });
  });

  test("success path emits started + completed events", async () => {
    const db = makeDb();
    // Stage: first spawn = --version (current), second = upgrade (npm install -g),
    // third = post-upgrade --version. Use a state machine.
    let phase = 0;
    const env = makeEnv({
      which: () => "/home/test/.opencode/bin/opencode",
      fileExists: () => true,
      spawn: (cmd, args) => {
        if (args[0] === "--version") {
          phase++;
          // First call returns 1.4.3, after upgrade returns 1.5.0
          return phase === 1
            ? { status: 0, stdout: "1.4.3\n", stderr: "" }
            : { status: 0, stdout: "1.5.0\n", stderr: "" };
        }
        // The upgrade command (sh -lc "curl … | bash" for official-script).
        return { status: 0, stdout: "installed", stderr: "" };
      },
      fetch: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ tag_name: "v1.5.0", published_at: "2026-05-01T00:00:00Z" }),
      }),
      now: (() => {
        let t = 1_700_000_000_000;
        return () => { t += 1000; return t; };
      })(),
    });

    const result = await updateOpencode({ env, db });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.from).toBe("1.4.3");
      expect(result.to).toBe("1.5.0");
      expect(result.durationMs).toBeGreaterThan(0);
    }

    const kinds = (db.query("SELECT kind FROM events ORDER BY ts").all() as Array<{ kind: string }>)
      .map((r) => r.kind);
    expect(kinds).toContain("opencode_upgrade_started");
    expect(kinds).toContain("opencode_upgrade_completed");
    closeDb(dbPath);
    rmSync(dir, { recursive: true, force: true });
  });

  test("install failure surfaces install_failed reason + event", async () => {
    const db = makeDb();
    const env = makeEnv({
      which: () => "/home/test/.opencode/bin/opencode",
      fileExists: () => true,
      spawn: (cmd, args) => {
        if (args[0] === "--version") return { status: 0, stdout: "1.4.3\n", stderr: "" };
        return { status: 1, stdout: "", stderr: "boom: install fell over" };
      },
      fetch: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ tag_name: "v1.5.0" }),
      }),
    });
    const result = await updateOpencode({ env, db });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("install_failed");
      expect(result.detail).toContain("boom");
    }
    const failRows = db.query("SELECT kind FROM events WHERE kind = 'opencode_upgrade_failed'").all();
    expect(failRows.length).toBe(1);
    closeDb(dbPath);
    rmSync(dir, { recursive: true, force: true });
  });

  test("classifies network failure", async () => {
    const db = makeDb();
    const env = makeEnv({
      which: () => "/home/test/.opencode/bin/opencode",
      fileExists: () => true,
      spawn: (cmd, args) => {
        if (args[0] === "--version") return { status: 0, stdout: "1.4.3\n", stderr: "" };
        return { status: 1, stdout: "", stderr: "curl: (6) Could not resolve host: getaddrinfo ENOTFOUND" };
      },
      fetch: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ tag_name: "v1.5.0" }),
      }),
    });
    const result = await updateOpencode({ env, db });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("network_error");
    closeDb(dbPath);
    rmSync(dir, { recursive: true, force: true });
  });

  test("force=true overrides no_update_available", async () => {
    const db = makeDb();
    let upgraded = false;
    const env = makeEnv({
      which: () => "/home/test/.opencode/bin/opencode",
      fileExists: () => true,
      spawn: (cmd, args) => {
        if (args[0] === "--version") return { status: 0, stdout: "1.5.0\n", stderr: "" };
        upgraded = true;
        return { status: 0, stdout: "ok", stderr: "" };
      },
      fetch: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ tag_name: "v1.5.0" }),
      }),
    });
    const result = await updateOpencode({ env, db, force: true });
    expect(result.ok).toBe(true);
    expect(upgraded).toBe(true);
    closeDb(dbPath);
    rmSync(dir, { recursive: true, force: true });
  });
});
