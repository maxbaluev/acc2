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
import { runUvArtifact } from "./uv";

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

describe.skipIf(!UV_AVAILABLE)("runUvArtifact — tempdir hygiene", () => {
  test("no acc2-uv-* tempdirs survive after a run", async () => {
    const tmp = tmpdir();
    const before = new Set(readdirSync(tmp).filter((n) => n.startsWith("acc2-uv-")));
    const body = "print('@@RESULT@@ ' + json.dumps({'done': True}))";
    const obs = await runUvArtifact({
      artifactId: "art_uv_tempdir_hygiene",
      body,
      declaredSandbox: stdSandbox,
      inputs: null,
    });
    expect(obs.ok).toBe(true);
    const after = readdirSync(tmp).filter((n) => n.startsWith("acc2-uv-"));
    const leaked = after.filter((n) => !before.has(n));
    expect(leaked).toEqual([]);
  }, 60000);
});
