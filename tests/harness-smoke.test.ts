// acc2 harness smoke test — proves the integration harness compiles + boots
// + can run scenario 2 (the MVP fixture) inside the bun-test runner. CI uses
// this to validate the harness module without having to spawn the full
// nine-scenario run on every test pass.
//
// The full integration run lives at tests/integration/harness.ts and is
// invoked directly via `bun tests/integration/harness.ts`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonHandle } from "../runtime/daemon";
import { stopDaemon } from "../runtime/daemon";
import { closeDb } from "../substrate/db";
import { bootDaemon, scenarioMvpFixture } from "./integration/scenarios";

describe("integration harness — smoke", () => {
  let handle: DaemonHandle | null = null;
  let tmpDir = "";

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "acc2-harness-smoke-"));
    handle = await bootDaemon(tmpDir, join(tmpDir, "smoke.db"));
  });

  afterAll(async () => {
    if (handle) {
      try { await stopDaemon(handle); } catch { /* swallow */ }
    }
    try { closeDb(); } catch { /* swallow */ }
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  test("daemon boots + scenario 2 (MVP fixture) runs end-to-end", async () => {
    expect(handle).not.toBeNull();
    // scenario 2 throws on any assertion failure; passing here proves the
    // harness scaffolding works against a real daemon process.
    await scenarioMvpFixture(handle!);
  }, 15_000);
});
