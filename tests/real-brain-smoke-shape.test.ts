// acc2 real-brain-smoke shape test — proves tests/integration/real_brain_smoke.ts
// compiles + assertion chain is sound by running the smoke against the mock
// bridge (no opencode subprocess required). CI runs this; operators run the
// real-bridge smoke manually via:
//   bun tests/integration/real_brain_smoke.ts
//
// The mock-bridge mode routes through the canonical fixture_d_count_todos
// mock (the only canned bridge path that produces a full action_predicted +
// artifact_observed + action_scored + task_committed chain). When green,
// every event-stream assertion in the smoke has fired at least once, so
// the structural shape is validated.

import { afterAll, describe, expect, test } from "bun:test";
import { closeDb } from "../substrate/db";
import { runRealBrainSmoke } from "./integration/real_brain_smoke";

describe("real_brain_smoke shape (mock-bridge)", () => {
  afterAll(() => { try { closeDb(); } catch { /* swallow */ } });

  test("runRealBrainSmoke({ mockBridge: true }) returns exit 0", async () => {
    const code = await runRealBrainSmoke({ mockBridge: true });
    expect(code).toBe(0);
  }, 30_000);
});
