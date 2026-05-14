// acc2 uv runtime — end-to-end subprocess tests.
//
// Each spawn test is gated on `uv` being on PATH. When it's absent we still
// run the policy/wiring tests (the runtime should return
// `uv_runtime_unavailable` cleanly without throwing) but skip the actual
// Python execution. nsjail is similarly opportunistic — when present it
// becomes the syscall sandbox; when absent the runtime emits a sandbox
// warning and runs uv directly.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxDecl } from "../../substrate/types";
import { runUvArtifact, buildNsjailArgv, __resetNsjailCacheForTest } from "./uv";

const whichSync = (cmd: string): string | null => {
  const path = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of path.split(sep)) {
    if (!dir) continue;
    try { if (existsSync(join(dir, cmd))) return join(dir, cmd); } catch { /* skip */ }
  }
  return null;
};

const UV_AVAILABLE = whichSync("uv") !== null;
const NSJAIL_AVAILABLE = whichSync("nsjail") !== null;

const stdSandbox: SandboxDecl & { runtime: "uv" } = {
  runtime: "uv",
  cpu_ms: 5000,
  wall_ms: 15000,
  memory_mb: 256,
};

describe("runUvArtifact — runtime-availability surface", () => {
  test("returns uv_runtime_unavailable cleanly when uv is absent", async () => {
    if (UV_AVAILABLE) {
      // Can't synthesise absence — but we can prove the absence shape works
      // by exercising the missing-marker path with a trivial body, which is
      // separately covered. Skip in this environment.
      return;
    }
    const obs = await runUvArtifact({
      artifactId: "art_uv_unavailable",
      body: "result = 1",
      declaredSandbox: stdSandbox,
      inputs: null,
    });
    expect(obs.ok).toBe(false);
    expect(obs.error).toBe("uv_runtime_unavailable");
    expect(obs.sandboxWarnings.some((w) => w.includes("uv runtime not on PATH"))).toBe(true);
  });
});

describe.skipIf(!UV_AVAILABLE)("runUvArtifact — trivial success path", () => {
  test("prints @@RESULT@@ JSON and the parent parses it cleanly", async () => {
    const body = "result = {'value': 42}\nprint('@@RESULT@@ ' + json.dumps(result))";
    const obs = await runUvArtifact({
      artifactId: "art_uv_trivial",
      body,
      declaredSandbox: stdSandbox,
      inputs: null,
    });
    expect(obs.ok).toBe(true);
    expect(obs.exitCode).toBe(0);
    expect(obs.result).toEqual({ value: 42 });
  }, 60000);

  test("receives inputs through ACC2_INPUTS and echoes them in the result", async () => {
    const body = "print('@@RESULT@@ ' + json.dumps({'echoed': inputs}))";
    const obs = await runUvArtifact({
      artifactId: "art_uv_echo",
      body,
      declaredSandbox: stdSandbox,
      inputs: { ping: "pong" },
    });
    expect(obs.ok).toBe(true);
    expect(obs.result).toEqual({ echoed: { ping: "pong" } });
  }, 60000);

  test("emits artifact_invoked + artifact_observed via the emit callback", async () => {
    const events: Array<{ kind: string }> = [];
    const body = "print('@@RESULT@@ ' + json.dumps({'ok': 1}))";
    const obs = await runUvArtifact({
      artifactId: "art_uv_emit",
      body,
      declaredSandbox: stdSandbox,
      inputs: null,
      emit: (e) => events.push({ kind: e.kind }),
    });
    expect(obs.ok).toBe(true);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("artifact_invoked");
    expect(kinds).toContain("artifact_observed");
  }, 60000);

  test("emits sandbox warning when nsjail is absent", async () => {
    const body = "print('@@RESULT@@ ' + json.dumps({'ok': True}))";
    const obs = await runUvArtifact({
      artifactId: "art_uv_nsjail_check",
      body,
      declaredSandbox: stdSandbox,
      inputs: null,
    });
    expect(obs.ok).toBe(true);
    if (!NSJAIL_AVAILABLE) {
      expect(obs.sandboxWarnings.some((w) => w.includes("nsjail not on PATH"))).toBe(true);
    } else {
      // When nsjail is present we should NOT see the absence warning.
      expect(obs.sandboxWarnings.some((w) => w.includes("nsjail not on PATH"))).toBe(false);
    }
  }, 60000);
});

describe.skipIf(!UV_AVAILABLE)("runUvArtifact — failure paths", () => {
  test("a body that throws yields ok:false with the error in stderrTail", async () => {
    const body = "raise RuntimeError('nope: this is the failure message')";
    const obs = await runUvArtifact({
      artifactId: "art_uv_throw",
      body,
      declaredSandbox: stdSandbox,
      inputs: null,
    });
    expect(obs.ok).toBe(false);
    expect(obs.exitCode).not.toBe(0);
    expect(obs.stderrTail).toContain("nope: this is the failure message");
  }, 60000);
});

describe.skipIf(!UV_AVAILABLE)("runUvArtifact — watchdog", () => {
  test("a body exceeding wall_ms is SIGTERM'd and reports wall_timeout", async () => {
    const body = [
      "import time",
      "end = time.time() + 5",
      "while time.time() < end:",
      "    pass",
      "print('@@RESULT@@ ' + json.dumps({'should_not_arrive': True}))",
    ].join("\n");
    const obs = await runUvArtifact({
      artifactId: "art_uv_runaway",
      body,
      declaredSandbox: { ...stdSandbox, wall_ms: 500 },
      inputs: null,
    });
    expect(obs.ok).toBe(false);
    expect(obs.error).toBe("wall_timeout");
  }, 30000);
});

describe("buildNsjailArgv — argv shape verification (Batch 4 Hole 1)", () => {
  test("includes the declared wall_ms, memory_mb, and bind mounts", () => {
    const sandbox: SandboxDecl & { runtime: "uv" } = {
      runtime: "uv",
      cpu_ms: 5000,
      wall_ms: 12_000,
      memory_mb: 128,
      fs_read: ["/home/proj/src/"],
      fs_write: ["/home/proj/build/"],
      net_allow: [],
      pypi_allow: ["numpy"],
    };
    const argv = buildNsjailArgv(
      "/usr/bin/nsjail",
      "/usr/bin/uv",
      ["run", "--no-project", "python", "entry.py"],
      sandbox,
      "/tmp/acc2-uv-test",
      sandbox.wall_ms,
      sandbox.memory_mb,
    );
    // Time limit is in seconds (ceil(wall_ms/1000)).
    expect(argv).toContain("--time_limit");
    const timeIdx = argv.indexOf("--time_limit");
    expect(argv[timeIdx + 1]).toBe("12");

    // Memory rlimit in bytes.
    expect(argv).toContain("--rlimit_as");
    const memIdx = argv.indexOf("--rlimit_as");
    expect(argv[memIdx + 1]).toBe(String(128 * 1024 * 1024));

    // /tmp bindmount.
    const bindIdx = argv.indexOf("--bindmount");
    expect(bindIdx).toBeGreaterThan(0);
    expect(argv[bindIdx + 1]).toBe("/tmp:/tmp");

    // Read glob → readonly bindmount.
    const roIdx = argv.indexOf("--bindmount_ro");
    expect(roIdx).toBeGreaterThan(0);
    expect(argv[roIdx + 1]).toBe("/home/proj/src/:/home/proj/src/");

    // Write glob → read-write bindmount (the second --bindmount entry).
    const allBindRw = argv.flatMap((arg, i) => arg === "--bindmount" ? [argv[i + 1]] : []);
    expect(allBindRw).toContain("/home/proj/build/:/home/proj/build/");

    // CWD pin.
    expect(argv).toContain("--cwd");

    // No net allowlist → leave nsjail's default clone_newnet (child has empty
    // network stack). buildNsjailArgv only emits --disable_clone_newnet when
    // net_allow is non-empty.
    expect(argv).not.toContain("--disable_clone_newnet");

    // The terminator + payload command come last.
    const sepIdx = argv.indexOf("--");
    expect(sepIdx).toBeGreaterThan(0);
    expect(argv[sepIdx + 1]).toBe("/usr/bin/uv");
    expect(argv[sepIdx + 2]).toBe("run");
  });

  test("net.allow_domains non-empty disables clone_newnet (host net reachable)", () => {
    const sandbox: SandboxDecl & { runtime: "uv" } = {
      runtime: "uv",
      cpu_ms: 5000,
      wall_ms: 5000,
      memory_mb: 64,
      net_allow: ["pypi.org"],
    };
    const argv = buildNsjailArgv(
      "/usr/bin/nsjail",
      "/usr/bin/uv",
      ["run", "python", "x.py"],
      sandbox,
      "/tmp/x",
      sandbox.wall_ms,
      sandbox.memory_mb,
    );
    expect(argv).toContain("--disable_clone_newnet");
  });

  test("runUvArtifact emits sandbox_enforced when nsjail path is forced and uv is available", async () => {
    if (!UV_AVAILABLE) return;
    if (!NSJAIL_AVAILABLE) {
      // We can't actually spawn a fake nsjail; the test verifies the
      // sandbox_enforced emit fires on the real nsjail path only when one
      // is on PATH. Skip in environments without nsjail.
      return;
    }
    __resetNsjailCacheForTest(undefined); // force re-probe
    const events: Array<{ kind: string; payload?: unknown }> = [];
    const body = "print('@@RESULT@@ ' + json.dumps({'ok': True}))";
    const obs = await runUvArtifact({
      artifactId: "art_uv_enforced",
      body,
      declaredSandbox: {
        runtime: "uv",
        cpu_ms: 2000,
        wall_ms: 8000,
        memory_mb: 64,
      },
      inputs: null,
      emit: (e) => events.push({ kind: e.kind, payload: e.payload }),
    });
    expect(obs.ok).toBe(true);
    const enforced = events.find((e) => e.kind === "sandbox_enforced");
    expect(enforced).toBeTruthy();
    const payload = enforced!.payload as { runtime: string; limits: Record<string, unknown> };
    expect(payload.runtime).toBe("uv");
    expect(payload.limits.wall_ms).toBe(8000);
    expect(payload.limits.memory_mb).toBe(64);
  }, 60000);

  test("runUvArtifact emits sandbox_degraded ONCE per process when nsjail is forced absent", async () => {
    if (!UV_AVAILABLE) return;
    __resetNsjailCacheForTest(null); // force "not on PATH"
    const events1: Array<{ kind: string }> = [];
    const events2: Array<{ kind: string }> = [];
    const body = "print('@@RESULT@@ ' + json.dumps({'ok': True}))";
    await runUvArtifact({
      artifactId: "art_uv_degraded_1",
      body,
      declaredSandbox: { runtime: "uv", cpu_ms: 2000, wall_ms: 8000, memory_mb: 64 },
      inputs: null,
      emit: (e) => events1.push({ kind: e.kind }),
    });
    await runUvArtifact({
      artifactId: "art_uv_degraded_2",
      body,
      declaredSandbox: { runtime: "uv", cpu_ms: 2000, wall_ms: 8000, memory_mb: 64 },
      inputs: null,
      emit: (e) => events2.push({ kind: e.kind }),
    });
    // First call emits sandbox_degraded; second does not (one-per-process cap).
    expect(events1.filter((e) => e.kind === "sandbox_degraded").length).toBe(1);
    expect(events2.filter((e) => e.kind === "sandbox_degraded").length).toBe(0);
    // Restore default probe behavior for downstream tests.
    __resetNsjailCacheForTest(undefined);
  }, 90000);
});

describe.skipIf(!UV_AVAILABLE)("runUvArtifact — tempdir hygiene", () => {
  test("no acc2-uv-* tempdirs survive after a run", async () => {
    const tmp = tmpdir();
    // Scope to THIS worker's tempdirs only — uv.ts uses a pid-namespaced
    // prefix so parallel test workers don't see each other's in-flight dirs.
    const prefix = `acc2-uv-${process.pid}-`;
    const before = new Set(readdirSync(tmp).filter((n) => n.startsWith(prefix)));
    const body = "print('@@RESULT@@ ' + json.dumps({'done': True}))";
    const obs = await runUvArtifact({
      artifactId: "art_uv_tempdir_hygiene",
      body,
      declaredSandbox: stdSandbox,
      inputs: null,
    });
    expect(obs.ok).toBe(true);
    const after = readdirSync(tmp).filter((n) => n.startsWith(prefix));
    const leaked = after.filter((n) => !before.has(n));
    expect(leaked).toEqual([]);
  }, 60000);
});
