// acc2 bun runtime — end-to-end subprocess tests.
//
// Each test spawns a real bun child process via runBunArtifact. We don't mock
// Bun.spawn: the watchdog, the @@RESULT@@ parsing, and the tempdir cleanup are
// the meat of this module and only one of them works in isolation.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxDecl } from "../../substrate/types";
import { runBunArtifact } from "./bun";

const stdSandbox: SandboxDecl & { runtime: "bun" } = {
  runtime: "bun",
  cpu_ms: 2000,
  wall_ms: 5000,
  memory_mb: 128,
};

describe("runBunArtifact — trivial success path", () => {
  test("prints @@RESULT@@ JSON and the parent parses it cleanly", async () => {
    const body = `console.log('@@RESULT@@ ' + JSON.stringify({ value: 42 }));`;
    const obs = await runBunArtifact({
      artifactId: "art_trivial",
      body,
      declaredSandbox: stdSandbox,
      inputs: null,
    });
    expect(obs.ok).toBe(true);
    expect(obs.exitCode).toBe(0);
    expect(obs.result).toEqual({ value: 42 });
    expect(obs.irreversibleEffects).toEqual([]);
    expect(obs.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("receives inputs through ACC2_INPUTS and echoes them in the result", async () => {
    const body = [
      "const inputs = JSON.parse(process.env.ACC2_INPUTS ?? 'null');",
      "console.log('@@RESULT@@ ' + JSON.stringify({ echoed: inputs }));",
    ].join("\n");
    const obs = await runBunArtifact({
      artifactId: "art_echo",
      body,
      declaredSandbox: stdSandbox,
      inputs: { ping: "pong" },
    });
    expect(obs.ok).toBe(true);
    expect(obs.result).toEqual({ echoed: { ping: "pong" } });
  });

  test("emits artifact_invoked + artifact_observed via the emit callback", async () => {
    const events: Array<{ kind: string }> = [];
    const body = `console.log('@@RESULT@@ ' + JSON.stringify({ ok: 1 }));`;
    const obs = await runBunArtifact({
      artifactId: "art_emit",
      body,
      declaredSandbox: stdSandbox,
      inputs: null,
      emit: (e) => events.push({ kind: e.kind }),
    });
    expect(obs.ok).toBe(true);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("artifact_invoked");
    expect(kinds).toContain("artifact_observed");
  });
});

describe("runBunArtifact — failure paths", () => {
  test("a body that throws yields ok:false with the error in stderrTail", async () => {
    const body = `throw new Error("nope: this is the failure message");`;
    const obs = await runBunArtifact({
      artifactId: "art_throw",
      body,
      declaredSandbox: stdSandbox,
      inputs: null,
    });
    expect(obs.ok).toBe(false);
    expect(obs.exitCode).not.toBe(0);
    expect(obs.stderrTail).toContain("nope: this is the failure message");
  });

  test("missing @@RESULT@@ marker reports result_marker_missing", async () => {
    const body = `console.log('hello, no marker here');`;
    const obs = await runBunArtifact({
      artifactId: "art_nomark",
      body,
      declaredSandbox: stdSandbox,
      inputs: null,
    });
    expect(obs.ok).toBe(false);
    expect(obs.error).toBe("result_marker_missing");
  });

  test("malformed JSON on the @@RESULT@@ line reports result_parse_failed", async () => {
    const body = `console.log('@@RESULT@@ {bad json');`;
    const obs = await runBunArtifact({
      artifactId: "art_badjson",
      body,
      declaredSandbox: stdSandbox,
      inputs: null,
    });
    expect(obs.ok).toBe(false);
    expect(obs.error ?? "").toContain("result_parse_failed");
  });
});

describe("runBunArtifact — watchdog", () => {
  test("a body exceeding wall_ms is SIGTERM'd and reports wall_timeout", async () => {
    const body = [
      "// Busy-wait past wall_ms then print a marker that never reaches stdout.",
      "const end = Date.now() + 5000;",
      "while (Date.now() < end) { /* spin */ }",
      "console.log('@@RESULT@@ ' + JSON.stringify({ should_not_arrive: true }));",
    ].join("\n");
    const obs = await runBunArtifact({
      artifactId: "art_runaway",
      body,
      declaredSandbox: { ...stdSandbox, wall_ms: 250 },
      inputs: null,
    });
    expect(obs.ok).toBe(false);
    expect(obs.exitCode).not.toBe(0);
    expect(obs.error).toBe("wall_timeout");
  }, 20000);
});

describe("runBunArtifact — tempdir hygiene", () => {
  test("no acc2-bun-* tempdirs survive after a run", async () => {
    const tmp = tmpdir();
    // Capture pre-existing acc2-bun-* dirs so concurrent test runs do not
    // foul this check. We only assert ours got cleaned up — we don't assume
    // a globally clean tempdir.
    const before = new Set(
      readdirSync(tmp).filter((n) => n.startsWith("acc2-bun-")),
    );
    const body = `console.log('@@RESULT@@ ' + JSON.stringify({ done: true }));`;
    const obs = await runBunArtifact({
      artifactId: "art_tempdir_hygiene",
      body,
      declaredSandbox: stdSandbox,
      inputs: null,
    });
    expect(obs.ok).toBe(true);
    const after = readdirSync(tmp).filter((n) => n.startsWith("acc2-bun-"));
    // At minimum, no NEW acc2-bun-* dir is left behind by THIS run. (Other
    // concurrent tests may have their own dirs; we tolerate them.)
    const leaked = after.filter((n) => !before.has(n));
    expect(leaked).toEqual([]);
  });
});
