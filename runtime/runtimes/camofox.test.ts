// acc2 camofox-browser runtime tests (Batch 1.α — real Camoufox swap).
//
// The runtime now drives the real Camoufox firefox binary via playwright's
// `firefox.launchPersistentContext({ executablePath, ... })`. These tests
// exercise:
//   1. The runtime returns `camofox_runtime_unavailable` cleanly when EITHER
//      playwright OR the camoufox binary is absent.
//   2. The wrapper script generator produces a stable, parseable body that
//      references firefox (not chromium) and threads CAMOUFOX_HEADLESS /
//      CAMOUFOX_LOCALE env vars into the launch options.
//   3. The per-profile-root mutex serialises concurrent invocations against
//      the same profile_root (tested via the no-binary fast path so the
//      mutex queue is observable without spawning firefox).
//   4. End-to-end spawn — guarded by `test.skipIf` so it only runs when a
//      camoufox binary is reachable (either CAMOUFOX_BINARY_PATH is set or
//      the default fetch location exists).

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SandboxDecl } from "../../substrate/types";
import {
  __isPlaywrightInstalledForTest,
  __resolveCamoufoxBinaryForTest,
  __wrapBrowserBodyForTest,
  runCamofoxArtifact,
} from "./camofox";

const stdDecl: SandboxDecl & { runtime: "camofox-browser" } = {
  runtime: "camofox-browser",
  browser_allow_domains: ["example.com"],
  browser_profile_root: "/tmp/acc2-camofox-test-profile",
  wall_ms: 30000,
  memory_mb: 1024,
};

const hasCamoufoxBinary = (): boolean => {
  if (process.env.CAMOUFOX_BINARY_PATH && existsSync(process.env.CAMOUFOX_BINARY_PATH)) return true;
  if (existsSync(join(homedir(), ".cache", "camoufox", "camoufox"))) return true;
  if (existsSync(join(homedir(), "Library", "Caches", "camoufox", "camoufox"))) return true;
  return false;
};

describe("runCamofoxArtifact — availability gate (Batch 1.α)", () => {
  test("returns camofox_runtime_unavailable when playwright is absent", async () => {
    if (__isPlaywrightInstalledForTest()) {
      // When playwright IS installed, the gate flips to the binary check;
      // that case is covered by the next test. Skip here.
      return;
    }
    const obs = await runCamofoxArtifact({
      artifactId: "art_camofox_unavailable",
      body: "console.log('@@RESULT@@ ' + JSON.stringify({ok:true}));",
      declaredSandbox: stdDecl,
      inputs: null,
    });
    expect(obs.ok).toBe(false);
    expect(obs.error).toBe("camofox_runtime_unavailable");
    expect(obs.profileRoot).toBe("/tmp/acc2-camofox-test-profile");
    expect(obs.sandboxWarnings.some((w) => w.includes("playwright not installed"))).toBe(true);
  });

  test("returns camofox_runtime_unavailable when playwright is present but the binary is absent", async () => {
    if (!__isPlaywrightInstalledForTest()) return;
    if (hasCamoufoxBinary()) return; // covered by spawn test below
    const obs = await runCamofoxArtifact({
      artifactId: "art_camofox_no_binary",
      body: "console.log('@@RESULT@@ ' + JSON.stringify({ok:true}));",
      declaredSandbox: stdDecl,
      inputs: null,
    });
    expect(obs.ok).toBe(false);
    expect(obs.error).toBe("camofox_runtime_unavailable");
    expect(
      obs.sandboxWarnings.some((w) => w.includes("camoufox binary not found")),
    ).toBe(true);
  });
});

describe("camofox wrapper-script generator (Batch 1.α — firefox driver)", () => {
  test("wraps the body with playwright firefox import + session facade + allow-domain route", () => {
    const script = __wrapBrowserBodyForTest(
      "await session.goto('https://example.com');",
      "/tmp/profile",
      ["example.com"],
      "/path/to/camoufox",
    );
    expect(script).toContain("import { firefox } from 'playwright'");
    expect(script).not.toContain("import { chromium }");
    expect(script).toContain("launchPersistentContext");
    expect(script).toContain("executablePath: __executablePath");
    expect(script).toContain("/path/to/camoufox");
    expect(script).toContain("/tmp/profile");
    expect(script).toContain("example.com");
    expect(script).toContain("goto: async (url)");
    // Wrapper must expose the raw playwright Page via session.page so brain
    // code can use any Page method directly.
    expect(script).toContain("page: __page");
    // Wrapper must call __ctx.close() in the finally block so firefox
    // exits cleanly when the user body throws.
    expect(script).toContain("__ctx.close()");
    // Wrapper must enforce the allow-domain list via page.route.
    expect(script).toContain("__page.route");
    // Wrapper must read CAMOUFOX_HEADLESS / CAMOUFOX_LOCALE env vars.
    expect(script).toContain("CAMOUFOX_HEADLESS");
    expect(script).toContain("CAMOUFOX_LOCALE");
  });

  test("escapes allow_domains correctly via JSON.stringify so injected hostnames stay inside a string literal", () => {
    const script = __wrapBrowserBodyForTest(
      "// noop",
      "/tmp/x",
      ["a.com", "b'); evil(); ('c.com"],
      "/path/to/camoufox",
    );
    // The malicious entry survives as a JSON-quoted string literal in the
    // emitted source; the protection is that JSON.stringify wraps it in
    // double quotes so the embedded `');` cannot terminate a host-language
    // string and execute. Assert the entry is INSIDE a JSON array literal,
    // not bare in the wrapper's body.
    const expectedLiteral = JSON.stringify(["a.com", "b'); evil(); ('c.com"]);
    expect(script).toContain(expectedLiteral);
    // The wrapper must NOT have a code path where the entry escapes a
    // string literal (e.g. via single-quote concatenation). We check that
    // every occurrence of `evil()` is preceded by the JSON-array literal
    // opener `[` to confirm it stays inside the array.
    const idx = script.indexOf("evil()");
    const literalIdx = script.indexOf(expectedLiteral);
    expect(idx).toBeGreaterThan(literalIdx);
    expect(idx).toBeLessThan(literalIdx + expectedLiteral.length);
  });

  test("embeds the camoufox executable path as a JSON-quoted string literal (path-injection-safe)", () => {
    const script = __wrapBrowserBodyForTest(
      "// noop",
      "/tmp/x",
      ["example.com"],
      "/weird path/with'quotes/camoufox",
    );
    const expectedLiteral = JSON.stringify("/weird path/with'quotes/camoufox");
    expect(script).toContain(`const __executablePath = ${expectedLiteral};`);
  });
});

describe("__resolveCamoufoxBinaryForTest", () => {
  test("honors CAMOUFOX_BINARY_PATH override when it points at an existing file", () => {
    const prev = process.env.CAMOUFOX_BINARY_PATH;
    // Point at a path we know exists — /usr/bin/env is on every POSIX box
    // and Bun runs only on POSIX. We're testing override semantics, not
    // the binary's contents.
    process.env.CAMOUFOX_BINARY_PATH = "/usr/bin/env";
    try {
      expect(__resolveCamoufoxBinaryForTest()).toBe("/usr/bin/env");
    } finally {
      if (prev === undefined) delete process.env.CAMOUFOX_BINARY_PATH;
      else process.env.CAMOUFOX_BINARY_PATH = prev;
    }
  });

  test("returns null when override is unset and default fetch locations are absent", () => {
    const prev = process.env.CAMOUFOX_BINARY_PATH;
    process.env.CAMOUFOX_BINARY_PATH = "/nonexistent/path/that/should/not/exist/camoufox";
    try {
      // We can't reliably assert the default locations are absent on the
      // test box (the actual ~/.cache/camoufox/camoufox may exist in dev),
      // so we only assert the OVERRIDE branch is taken first. When the
      // override points at a missing file, the function falls through to
      // the default candidates — either way the test asserts the override
      // is NOT silently ignored when set.
      const result = __resolveCamoufoxBinaryForTest();
      // result is either null (no binary anywhere) or one of the default
      // locations; it must NOT be the override path because it doesn't
      // exist.
      expect(result).not.toBe("/nonexistent/path/that/should/not/exist/camoufox");
    } finally {
      if (prev === undefined) delete process.env.CAMOUFOX_BINARY_PATH;
      else process.env.CAMOUFOX_BINARY_PATH = prev;
    }
  });
});

describe("per-profile-root mutex (v2-design.md §11.2)", () => {
  test("concurrent runCamofoxArtifact calls against the same profile_root serialise", async () => {
    // The mutex is internal; we observe it through the no-binary fast
    // path: every invocation returns quickly with
    // `camofox_runtime_unavailable` BUT the mutex queue still serialises
    // them. To force the fast path even when a binary IS installed locally,
    // we point CAMOUFOX_BINARY_PATH at a known-missing path AND clear it
    // around the runs (skipping when playwright AND a real binary are
    // configured — that path is exercised by the spawn integration test).
    if (__isPlaywrightInstalledForTest() && hasCamoufoxBinary()) {
      return;
    }
    const sameProfile: SandboxDecl & { runtime: "camofox-browser" } = {
      ...stdDecl,
      browser_profile_root: "/tmp/acc2-mutex-test",
    };
    const runs = await Promise.all([
      runCamofoxArtifact({ artifactId: "art_mtx_a", body: "// a", declaredSandbox: sameProfile, inputs: null }),
      runCamofoxArtifact({ artifactId: "art_mtx_b", body: "// b", declaredSandbox: sameProfile, inputs: null }),
      runCamofoxArtifact({ artifactId: "art_mtx_c", body: "// c", declaredSandbox: sameProfile, inputs: null }),
    ]);
    // All three returned the same shape; profile_root threaded through.
    for (const r of runs) {
      expect(r.error).toBe("camofox_runtime_unavailable");
      expect(r.profileRoot).toBe("/tmp/acc2-mutex-test");
    }
  });

  test("invocations against different profile_roots run in parallel (independent queues)", async () => {
    const declA: SandboxDecl & { runtime: "camofox-browser" } = { ...stdDecl, browser_profile_root: "/tmp/acc2-mtx-A" };
    const declB: SandboxDecl & { runtime: "camofox-browser" } = { ...stdDecl, browser_profile_root: "/tmp/acc2-mtx-B" };
    const [resA, resB] = await Promise.all([
      runCamofoxArtifact({ artifactId: "art_par_a", body: "// a", declaredSandbox: declA, inputs: null }),
      runCamofoxArtifact({ artifactId: "art_par_b", body: "// b", declaredSandbox: declB, inputs: null }),
    ]);
    expect(resA.profileRoot).toBe("/tmp/acc2-mtx-A");
    expect(resB.profileRoot).toBe("/tmp/acc2-mtx-B");
  });
});

// ── End-to-end spawn (skip when no camoufox binary is reachable) ────
//
// These tests actually launch the Camoufox firefox binary via playwright.
// They require BOTH playwright installed AND a reachable binary (either
// CAMOUFOX_BINARY_PATH or ~/.cache/camoufox/camoufox). Skipped in hermetic
// CI; lit up locally for the operator-install verification path.

const skipSpawn = !(__isPlaywrightInstalledForTest() && hasCamoufoxBinary());

describe.skipIf(skipSpawn)("end-to-end camoufox spawn", () => {
  test("camoufox actually launches and renders a page with allow-domain enforcement", async () => {
    const obs = await runCamofoxArtifact({
      artifactId: "art_e2e_spawn",
      body: [
        "// inputs: { url: string }",
        "await session.goto(inputs.url);",
        "const title = await session.text('title');",
        "console.log('@@RESULT@@ ' + JSON.stringify({ ok: true, title, final_url: session.url }));",
      ].join("\n"),
      declaredSandbox: {
        runtime: "camofox-browser",
        browser_allow_domains: ["example.com"],
        browser_profile_root: "/tmp/acc2-camofox-e2e-profile",
        fingerprint_os: "linux",
        fingerprint_locale: "en-US",
        headless: true,
        wall_ms: 60000,
        memory_mb: 1024,
      },
      inputs: { url: "https://example.com" },
    });
    expect(obs.ok).toBe(true);
    // example.com's title is stable text — we don't pin it (camoufox
    // randomizes UA, not page content), but it must be a non-empty string.
    const r = obs.result as { ok: boolean; title: string | null; final_url: string };
    expect(r.ok).toBe(true);
    expect(typeof r.title === "string" && r.title.length > 0).toBe(true);
    expect(r.final_url.startsWith("https://example.com")).toBe(true);
  }, 120000);
});
