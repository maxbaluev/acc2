#!/usr/bin/env bun
// acc2 integration harness — the final cutover gate AND the operator's
// real-brain validation tool.
//
// Two modes:
//
// 1. Scenario gate (default). Boots an ephemeral daemon and runs the 9
//    plumbing scenarios under ACC2_BRIDGE_MODE=mock (~1.1s, hermetic).
//    `--include-real` adds the 10th canned real-brain scenario; `--real-only`
//    runs only that one. Real-brain runs are opt-in because each burns
//    ~2 min wall-clock + opencode tokens.
//
// 2. Ad-hoc task (`--task "<owner words>"`). Boots an ephemeral daemon,
//    flips ACC2_BRIDGE_MODE=real, dispatches the operator's directive
//    through the real brain (opencode → gpt-5.5), and streams the full
//    event chain live as it lands. Exits 0 on task_committed, 1 on
//    task_failed / timeout / dispatcher_violation. Lets the operator
//    validate the loop on any goal without touching production state.
//
// Run:
//   cd /home/maxbaluev/bos2/system/acc2
//   bun tests/integration/harness.ts                              # 9 plumbing
//   bun tests/integration/harness.ts --include-real               # 9+1
//   bun tests/integration/harness.ts --real-only                  # canned real-brain
//   bun tests/integration/harness.ts --task "<owner words>"       # ad-hoc real-brain
//
// Flags:
//   --include-real        Add real_brain_end_to_end to the scenario run.
//   --real-only           Run ONLY real_brain_end_to_end (skips plumbing).
//   --task "<text>"       Ad-hoc mode: drive the brain on the given directive.
//   --timeout-ms <n>      Ad-hoc timeout (default 300000 = 5 min).
//   --keep-state          Ad-hoc only: keep temp state dir on exit (printed in summary).
//
// Real-brain prereqs (both modes): OPENAI_API_KEY + opencode on PATH.
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
  realBrainPreflight,
  scenarioAdHocTask,
  scenarioAmendmentSupersession,
  scenarioCreditChainClosure,
  scenarioCycleOneEnforcement,
  scenarioDaemonLifecycle,
  scenarioDistributionMerger,
  scenarioExternalPushRetrievable,
  scenarioFatherOneShot,
  scenarioMvpFixture,
  scenarioRealBrainEndToEnd,
  scenarioRefinementEdge,
} from "./scenarios";
import { stopDaemon } from "../../runtime/daemon";

type ScenarioFn = () => Promise<void> | Promise<void>;
type ScenarioEntry = {
  id: string;
  label: string;
  /** Scenarios that take a daemon handle vs. those that own their own. */
  kind: "shared_daemon" | "own_daemon";
  /** Optional pre-flight returning a skip reason; `null` means "run me". */
  preflight?: (argv: string[]) => string | null;
  run: (handle: DaemonHandle | null) => Promise<void>;
};

const PAD_LABEL = 38;
const formatLabel = (s: string): string => {
  if (s.length >= PAD_LABEL) return s;
  return s + " " + ".".repeat(Math.max(0, PAD_LABEL - s.length - 1));
};

const PLUMBING_SCENARIOS: ScenarioEntry[] = [
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

const REAL_BRAIN_SCENARIO: ScenarioEntry = {
  id: "real_brain_end_to_end",
  label: "real_brain_end_to_end",
  kind: "own_daemon",
  preflight: realBrainPreflight,
  run: async (_h) => { await scenarioRealBrainEndToEnd(); },
};

type ScenarioResult = {
  id: string;
  label: string;
  status: "pass" | "fail" | "skip";
  elapsedMs: number;
  detail?: string;
  error?: Error;
};

const formatSeconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

type HarnessOpts = {
  includeReal: boolean;
  realOnly: boolean;
  taskText: string | null;
  timeoutMs: number;
  keepState: boolean;
};

const parseArgs = (argv: string[]): HarnessOpts => {
  const taskIdx = argv.indexOf("--task");
  const timeoutIdx = argv.indexOf("--timeout-ms");
  return {
    includeReal: argv.includes("--include-real"),
    realOnly: argv.includes("--real-only"),
    taskText: taskIdx >= 0 && argv[taskIdx + 1] ? argv[taskIdx + 1]! : null,
    timeoutMs: timeoutIdx >= 0 && argv[timeoutIdx + 1] ? Number(argv[timeoutIdx + 1]) : 5 * 60_000,
    keepState: argv.includes("--keep-state"),
  };
};

/** Dispatch the operator's directive through the real brain in an ephemeral
 *  daemon and stream the event chain. Exit 0 on task_committed, 1 otherwise. */
const runAdHocTask = async (opts: HarnessOpts): Promise<number> => {
  // Real-brain prereqs: OPENAI_API_KEY + opencode on PATH.
  const skip = realBrainPreflight([]);
  if (skip !== null) {
    process.stdout.write(`acc2 harness: cannot run --task — ${skip}\n`);
    return 1;
  }
  const result = await scenarioAdHocTask({
    taskText: opts.taskText!,
    timeoutMs: opts.timeoutMs,
    keepState: opts.keepState,
  });
  if (result.committed && result.violations === 0) return 0;
  return 1;
};

export const runHarness = async (
  argv: string[] = [],
): Promise<number> => {
  const startedAt = Date.now();
  const opts = parseArgs(argv);

  // Ad-hoc mode short-circuits the scenario gate.
  if (opts.taskText !== null) {
    return runAdHocTask(opts);
  }

  process.stdout.write("acc2 integration harness — Phase Harness\n");
  process.stdout.write("========================================\n");

  // Pin mock for plumbing scenarios (must happen BEFORE bootDaemon so any
  // bridge calls during boot see mock). The real-brain scenario flips to
  // `real` for its own dispatch and restores on exit. The production
  // default for bridge.ts is `real` — the harness explicitly overrides
  // because the 9 plumbing scenarios use canned fixture markers.
  const originalBridgeMode = process.env.ACC2_BRIDGE_MODE;
  process.env.ACC2_BRIDGE_MODE = "mock";

  // Real-brain is OPT-IN: only run it when --include-real or --real-only
  // was passed. Bare invocation runs the 9 plumbing scenarios only.
  const runPlumbing = !opts.realOnly;
  const runReal = opts.realOnly || opts.includeReal;

  // Build the schedule.
  const scheduled: ScenarioEntry[] = [];
  if (runPlumbing) scheduled.push(...PLUMBING_SCENARIOS);
  if (runReal) scheduled.push(REAL_BRAIN_SCENARIO);

  // Shared daemon for plumbing scenarios (skip booting it if no plumbing
  // scenario will run).
  let handle: DaemonHandle | null = null;
  let tmpDir: string | null = null;
  let dbPath: string | null = null;
  if (runPlumbing && scheduled.some((s) => s.kind === "shared_daemon")) {
    tmpDir = mkdtempSync(join(tmpdir(), "acc2-harness-shared-"));
    dbPath = join(tmpDir, "state.db");
    try {
      handle = await bootDaemon(tmpDir, dbPath);
    } catch (err) {
      process.stdout.write(`boot: FAILED — ${(err as Error).message}\n`);
      rmSync(tmpDir, { recursive: true, force: true });
      restoreEnv(originalBridgeMode);
      return 1;
    }
    process.stdout.write(
      `boot: daemon up on mcp=${handle.port} aux=${handle.auxPort} state=${dbPath}\n\n`,
    );
  }

  const results: ScenarioResult[] = [];
  let index = 1;
  for (const sc of scheduled) {
    const labelTxt = `[${index}/${scheduled.length}] ${formatLabel(sc.label)}`;

    // Skip honoring: pre-flight may report a skip reason (e.g. real-brain
    // pre-flight when OPENAI_API_KEY is absent or opencode is not on PATH).
    let skipReason: string | null = null;
    if (sc.preflight) {
      skipReason = sc.preflight(argv);
    }
    if (skipReason !== null) {
      results.push({ id: sc.id, label: sc.label, status: "skip", elapsedMs: 0, detail: skipReason });
      process.stdout.write(`${labelTxt} SKIP — ${skipReason}\n`);
      index++;
      continue;
    }

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
  if (handle) {
    process.stdout.write("\n");
    try {
      await stopDaemon(handle);
      process.stdout.write("shutdown: daemon stopped cleanly\n");
    } catch (err) {
      process.stdout.write(`shutdown: error stopping daemon — ${(err as Error).message}\n`);
    }
  }
  try { closeDb(); } catch { /* swallow */ }
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  restoreEnv(originalBridgeMode);

  // Summary
  const elapsedTotal = Date.now() - startedAt;
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skip").length;
  process.stdout.write("\n========================================\n");

  const total = results.length;
  if (failed === 0) {
    if (skipped === 0) {
      process.stdout.write(
        `${passed}/${total} scenarios passed in ${formatSeconds(elapsedTotal)}` +
        (total >= 10 ? `  (9 plumbing + 1 real-brain)\n` : "\n"),
      );
      if (results.some((r) => r.id === "real_brain_end_to_end" && r.status === "pass")) {
        process.stdout.write("[ok] acc2 is fully workable end-to-end against a live LLM brain\n");
      } else {
        process.stdout.write("[ok] acc2 is fully workable end-to-end\n");
      }
      return 0;
    }
    // Some skipped, none failed — still green.
    const skipDetails = results
      .filter((r) => r.status === "skip")
      .map((r) => `${r.id}: ${r.detail ?? "skipped"}`)
      .join("; ");
    process.stdout.write(
      `${passed}/${total} scenarios passed; ${skipped} skipped in ${formatSeconds(elapsedTotal)} (${skipDetails})\n`,
    );
    if (results.some((r) => r.id === "real_brain_end_to_end" && r.status === "skip")) {
      process.stdout.write("[ok] acc2 plumbing is end-to-end green\n");
      process.stdout.write("[skip] real-brain proof skipped — install opencode + set OPENAI_API_KEY to enable\n");
    } else {
      process.stdout.write("[ok] acc2 plumbing is end-to-end green\n");
    }
    return 0;
  }
  process.stdout.write(
    `${passed}/${total} passed — ${failed} failure${failed > 1 ? "s" : ""}` +
    (skipped > 0 ? `, ${skipped} skipped\n` : "\n"),
  );
  return 1;
};

const restoreEnv = (originalBridgeMode: string | undefined): void => {
  if (originalBridgeMode === undefined) delete process.env.ACC2_BRIDGE_MODE;
  else process.env.ACC2_BRIDGE_MODE = originalBridgeMode;
};

// Entrypoint when invoked directly.
if (import.meta.main) {
  void (async () => {
    const code = await runHarness(process.argv.slice(2));
    process.exit(code);
  })();
}
