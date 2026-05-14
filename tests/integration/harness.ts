#!/usr/bin/env bun
// acc2 integration harness — the final cutover gate.
//
// Boots the real daemon (fastmcp + Bun.serve aux + SQLite + workers) in a
// temp state directory on free ports, then runs nine scenarios end-to-end.
// Each scenario asserts a §17 / §18 cutover criterion. Exit code 0 iff every
// scenario passes; exit code 1 otherwise.
//
// Run:
//   cd /home/maxbaluev/bos2/system/acc2 && bun tests/integration/harness.ts
//
// The harness does NOT use bun:test — it is the integration gate, not a
// unit-test suite. A separate smoke test (tests/harness-smoke.test.ts)
// imports the same scenarios and runs scenario 2 inside the bun-test runner
// so CI can validate the harness compiles + boots + runs at least one
// scenario in under 10 seconds.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../../substrate/db";
import type { DaemonHandle } from "../../runtime/daemon";
import {
  bootDaemon,
  scenarioAmendmentSupersession,
  scenarioCreditChainClosure,
  scenarioCycleOneEnforcement,
  scenarioDaemonLifecycle,
  scenarioDistributionMerger,
  scenarioExternalPushRetrievable,
  scenarioFatherOneShot,
  scenarioMvpFixture,
  scenarioRefinementEdge,
} from "./scenarios";
import { stopDaemon } from "../../runtime/daemon";

type ScenarioFn = () => Promise<void> | Promise<void>;
type ScenarioEntry = {
  id: string;
  label: string;
  /** Scenarios that take a daemon handle vs. those that own their own. */
  kind: "shared_daemon" | "own_daemon";
  run: (handle: DaemonHandle | null) => Promise<void>;
};

const PAD_LABEL = 38;
const formatLabel = (s: string): string => {
  if (s.length >= PAD_LABEL) return s;
  return s + " " + ".".repeat(Math.max(0, PAD_LABEL - s.length - 1));
};

const SCENARIOS: ScenarioEntry[] = [
  {
    id: "daemon_lifecycle",
    label: "daemon_lifecycle",
    kind: "own_daemon",
    run: async (_h) => { await scenarioDaemonLifecycle(); },
  },
  {
    id: "mvp_fixture_d_count_todos",
    label: "mvp_fixture_d_count_todos",
    kind: "shared_daemon",
    run: async (h) => { await scenarioMvpFixture(h!); },
  },
  {
    id: "refinement_edge_high_residual",
    label: "refinement_edge_high_residual",
    kind: "shared_daemon",
    run: async (h) => { await scenarioRefinementEdge(h!); },
  },
  {
    id: "cycle_one_enforcement",
    label: "cycle_one_enforcement",
    kind: "shared_daemon",
    run: async (h) => { await scenarioCycleOneEnforcement(h!); },
  },
  {
    id: "distribution_semantic_merger",
    label: "distribution_semantic_merger",
    kind: "shared_daemon",
    run: async (h) => { await scenarioDistributionMerger(h!); },
  },
  {
    id: "credit_chain_closure",
    label: "credit_chain_closure",
    kind: "shared_daemon",
    run: async (h) => { await scenarioCreditChainClosure(h!); },
  },
  {
    id: "external_push_retrievable",
    label: "external_push_retrievable",
    kind: "shared_daemon",
    run: async (h) => { await scenarioExternalPushRetrievable(h!); },
  },
  {
    id: "father_one_shot_tick",
    label: "father_one_shot_tick",
    kind: "shared_daemon",
    run: async (h) => { await scenarioFatherOneShot(h!); },
  },
  {
    id: "amendment_supersession",
    label: "amendment_supersession",
    kind: "shared_daemon",
    run: async (h) => { await scenarioAmendmentSupersession(h!); },
  },
];

type ScenarioResult = {
  id: string;
  label: string;
  status: "pass" | "fail";
  elapsedMs: number;
  error?: Error;
};

const formatSeconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

export const runHarness = async (): Promise<number> => {
  const startedAt = Date.now();
  const tmpDir = mkdtempSync(join(tmpdir(), "acc2-harness-shared-"));
  const dbPath = join(tmpDir, "state.db");

  process.stdout.write("acc2 integration harness — Phase Harness\n");
  process.stdout.write("========================================\n");

  // Boot the shared daemon (used by every scenario except scenario 1, which
  // exercises lifecycle on its own dedicated daemon pair).
  let handle: DaemonHandle | null = null;
  try {
    handle = await bootDaemon(tmpDir, dbPath);
  } catch (err) {
    process.stdout.write(`boot: FAILED — ${(err as Error).message}\n`);
    rmSync(tmpDir, { recursive: true, force: true });
    return 1;
  }
  process.stdout.write(
    `boot: daemon up on mcp=${handle.port} aux=${handle.auxPort} state=${dbPath}\n\n`,
  );

  const results: ScenarioResult[] = [];
  let index = 1;
  for (const sc of SCENARIOS) {
    const labelTxt = `[${index}/${SCENARIOS.length}] ${formatLabel(sc.label)}`;
    const scStart = Date.now();
    try {
      await sc.run(handle);
      const elapsed = Date.now() - scStart;
      results.push({ id: sc.id, label: sc.label, status: "pass", elapsedMs: elapsed });
      process.stdout.write(`${labelTxt} PASS (${formatSeconds(elapsed)})\n`);
    } catch (err) {
      const elapsed = Date.now() - scStart;
      const e = err instanceof Error ? err : new Error(String(err));
      results.push({ id: sc.id, label: sc.label, status: "fail", elapsedMs: elapsed, error: e });
      process.stdout.write(`${labelTxt} FAIL (${formatSeconds(elapsed)})\n`);
      process.stdout.write(`        ${e.message}\n`);
      if (e.stack) {
        const frames = e.stack.split("\n").slice(1, 4).map((s) => `        ${s.trim()}`).join("\n");
        process.stdout.write(`${frames}\n`);
      }
    }
    index++;
  }

  // Shut the shared daemon down cleanly.
  process.stdout.write("\n");
  try {
    await stopDaemon(handle);
    process.stdout.write("shutdown: daemon stopped cleanly\n");
  } catch (err) {
    process.stdout.write(`shutdown: error stopping daemon — ${(err as Error).message}\n`);
  }
  try { closeDb(); } catch { /* swallow */ }
  rmSync(tmpDir, { recursive: true, force: true });

  // Summary
  const elapsedTotal = Date.now() - startedAt;
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.length - passed;
  process.stdout.write("\n========================================\n");
  if (failed === 0) {
    process.stdout.write(
      `${passed}/${results.length} scenarios passed in ${formatSeconds(elapsedTotal)}\n`,
    );
    process.stdout.write("[ok] acc2 is fully workable end-to-end\n");
    return 0;
  }
  process.stdout.write(
    `${passed}/${results.length} passed — ${failed} failure${failed > 1 ? "s" : ""}\n`,
  );
  return 1;
};

// Entrypoint when invoked directly.
if (import.meta.main) {
  void (async () => {
    const code = await runHarness();
    process.exit(code);
  })();
}
