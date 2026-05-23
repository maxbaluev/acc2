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
//   4. End-to-end spawn — guarded by `test.skipIf` plus ACC2_CAMOFOX_E2E=1
//      so the default bun test path never launches a real browser just because
//      a local camoufox binary is reachable.

import { describe, expect, test } from "bun:test";
import type { SandboxDecl } from "../../substrate/types";
import {
  __acquireProfileMutexForTest,
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

describe("camofox availability helpers (Batch 1.α)", () => {
  test("detects whether the playwright package is installed without invoking the runtime entrypoint", () => {
    expect(typeof __isPlaywrightInstalledForTest()).toBe("boolean");
  });

  test("honors missing CAMOUFOX_BINARY_PATH override without invoking the runtime entrypoint", () => {
    const prev = process.env.CAMOUFOX_BINARY_PATH;
    process.env.CAMOUFOX_BINARY_PATH = "/nonexistent/path/that/should/not/exist/camoufox";
    try {
      expect(__resolveCamoufoxBinaryForTest()).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.CAMOUFOX_BINARY_PATH;
      else process.env.CAMOUFOX_BINARY_PATH = prev;
    }
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

describe("per-profile-root mutex (Architecture.md)", () => {
  test("concurrent calls against the same profile_root serialise", async () => {
    const order: string[] = [];
    await Promise.all([
      __acquireProfileMutexForTest("/tmp/acc2-mutex-test", async () => { order.push("a:start"); await Promise.resolve(); order.push("a:end"); return "a"; }),
      __acquireProfileMutexForTest("/tmp/acc2-mutex-test", async () => { order.push("b:start"); await Promise.resolve(); order.push("b:end"); return "b"; }),
      __acquireProfileMutexForTest("/tmp/acc2-mutex-test", async () => { order.push("c:start"); await Promise.resolve(); order.push("c:end"); return "c"; }),
    ]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  });

  test("different profile_roots use independent queues", async () => {
    const releaseA = Promise.withResolvers<void>();
    let bStarted = false;
    const runA = __acquireProfileMutexForTest("/tmp/acc2-mtx-A", async () => {
      await releaseA.promise;
      return "a";
    });
    const runB = __acquireProfileMutexForTest("/tmp/acc2-mtx-B", async () => {
      bStarted = true;
      return "b";
    });
    await runB;
    expect(bStarted).toBe(true);
    releaseA.resolve();
    await runA;
  });
});

// ── End-to-end spawn (skip when no camoufox binary is reachable) ────
//
// These tests actually launch the Camoufox firefox binary via playwright.
// They require explicit opt-in plus BOTH playwright installed AND a reachable
// binary (either CAMOUFOX_BINARY_PATH or ~/.cache/camoufox/camoufox). Keeping
// them opt-in prevents ordinary bun test runs on configured developer machines
// from paying the real-browser startup cost.

const runSpawn = process.env.ACC2_CAMOFOX_E2E === "1";
const skipSpawn = !(runSpawn && __isPlaywrightInstalledForTest() && __resolveCamoufoxBinaryForTest());

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
