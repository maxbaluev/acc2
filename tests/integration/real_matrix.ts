#!/usr/bin/env bun
// acc2 real-brain matrix — statistical organism probe.
//
// Drives a battery of universal-goal-shape hard tasks through the REAL brain
// (opencode → gpt-5.5) one after another, in a fresh ephemeral daemon per
// task. Tabulates aggregate stats so the operator can answer "does acc2 work
// on REAL hard tasks, not just plumbing scenarios?" with numbers, not vibes.
//
// Run:
//   cd /home/maxbaluev/bos2/system/acc2 && bun tests/integration/real_matrix.ts
//
// Expected wall-clock: ~15-25 min across the 6-task battery (5 min per task
// timeout × 6 tasks worst case). Per-task verbose output is buffered and
// printed once a task finishes — keeps the live surface readable. Final
// aggregate table prints to stdout.
//
// Honest reporting: tasks that TIME OUT or FAIL surface their per-task
// stats in the table — we are not here to make everything green, we are
// here to give the operator real numbers.

import { scenarioAdHocTask, realBrainPreflight, type AdHocTaskResult, type AdHocTaskUrgency } from "./scenarios";

type MatrixDirective = {
  name: string;
  taskText: string;
  urgency?: AdHocTaskUrgency;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

const MATRIX: MatrixDirective[] = [
  {
    name: "bun_webfetch_title",
    taskText:
      "Fetch https://example.com via Bun.fetch (bun runtime). Extract the <title> tag. Return JSON {result:{title:string}}. Author ACTION (bun) + VERIFIER (bun, residual=0 iff title non-empty). Single cycle.",
  },
  {
    name: "bun_pure_compute",
    taskText:
      "Compute the 20th Fibonacci number in TypeScript using the bun runtime. Return JSON {result:{fib20:number}}. Author ACTION (bun) + VERIFIER (bun, residual=0 iff fib20===6765). Single cycle.",
  },
  {
    name: "uv_numerical",
    taskText:
      "Use numpy in the uv runtime to compute the mean and stddev of [1,2,3,4,5,6,7,8,9,10]. Return JSON {result:{mean:number,stddev:number}}. Author ACTION (uv, deps=['numpy']) + VERIFIER (bun, residual=0 iff mean===5.5 and abs(stddev-2.872) < 0.01). Single cycle.",
  },
  {
    name: "bun_multistep",
    taskText:
      "Fetch https://example.com via Bun.fetch (bun runtime). Extract BOTH the <title> tag AND the first <p> tag text. Return JSON {result:{title:string,paragraph:string}}. Author ACTION (bun) + VERIFIER (bun, residual=0 iff both non-empty). If you cannot complete this in one cycle, emit a refinement edge.",
  },
  {
    name: "crisis_factcheck",
    taskText:
      "EMERGENCY fact-check: does water boil at 99°C at sea level? Author ACTION (bun) that prints `@@RESULT@@ {\"result\":{\"answer\":\"yes\"|\"no\",\"actual_boiling_point_c\":number}}` based on the well-known physical constant. Author VERIFIER (bun) returning residual=0 iff answer===\"no\" and actual_boiling_point_c===100. Single cycle.",
    urgency: "crisis",
  },
  {
    name: "bun_haiku",
    taskText:
      "Author a single bun ACTION artifact that prints `@@RESULT@@ {\"result\":{\"haiku\":\"<5-7-5 syllable haiku about retrieval-linked memory>\"}}`. Author VERIFIER (bun) returning residual=0 iff haiku is non-empty AND contains at least 3 lines. Single cycle.",
  },
];

type PerTaskRecord = {
  name: string;
  urgency: AdHocTaskUrgency;
  result: AdHocTaskResult;
  buffer: string;
  error: string | null;
};

const verdictOf = (r: AdHocTaskResult): string => {
  if (r.committed) return "COMMITTED";
  if (r.failed) return "FAILED";
  if (r.timedOut) return "TIMED OUT";
  return "UNKNOWN";
};

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
};

const pct = (n: number, d: number): string => (d === 0 ? "0%" : `${((n / d) * 100).toFixed(0)}%`);

const runOne = async (d: MatrixDirective): Promise<PerTaskRecord> => {
  let buf = "";
  const writer = (s: string) => {
    buf += s;
  };
  const urgency: AdHocTaskUrgency = d.urgency ?? "normal";
  try {
    const result = await scenarioAdHocTask({
      taskText: d.taskText,
      timeoutMs: d.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      keepState: false,
      urgency,
      writer,
    });
    return { name: d.name, urgency, result, buffer: buf, error: null };
  } catch (err) {
    // scenarioAdHocTask catches most errors; this is the belt-and-braces lane
    // for boot failures that throw before the try-block completes.
    const message = err instanceof Error ? err.message : String(err);
    const fallback: AdHocTaskResult = {
      committed: false,
      failed: true,
      timedOut: false,
      residual: null,
      durationMs: 0,
      directiveId: "",
      stateDir: "",
      eventsCount: 0,
      artifactsCount: 0,
      violations: 0,
      refinementEdges: 0,
      urgency,
      crisisModeEngaged: false,
      bridgeInvokedCount: 0,
      recipeExtractedCount: 0,
      vecEventsIndexed: 0,
      runtimesInvoked: [],
      artifactInvokedCount: 0,
    };
    return { name: d.name, urgency, result: fallback, buffer: buf, error: message };
  }
};

const runMatrix = async (): Promise<number> => {
  const skip = realBrainPreflight([]);
  if (skip !== null) {
    process.stdout.write(`acc2 real-brain matrix: cannot run — ${skip}\n`);
    process.stdout.write(`  set OPENAI_API_KEY (sourcing the repo .env helps) and put opencode on PATH\n`);
    return 1;
  }

  const startedAt = Date.now();
  process.stdout.write(`acc2 real-brain matrix — ${MATRIX.length} tasks\n`);
  process.stdout.write(`============================================================\n`);
  process.stdout.write(`Battery: ${MATRIX.map((d) => d.name).join(", ")}\n`);
  process.stdout.write(`Per-task timeout: ${(DEFAULT_TIMEOUT_MS / 1000).toFixed(0)}s\n`);
  process.stdout.write(`Bridge mode: real (ACC2_BRIDGE_MODE=real)\n\n`);

  const records: PerTaskRecord[] = [];
  let aborted = false;

  // Allow Ctrl-C to break out of the matrix cleanly: surface what we've got.
  const onInt = () => {
    process.stdout.write("\n[matrix] SIGINT received — printing partial results...\n");
    aborted = true;
  };
  process.on("SIGINT", onInt);

  for (let i = 0; i < MATRIX.length && !aborted; i++) {
    const d = MATRIX[i];
    process.stdout.write(`\n────────────────────────────────────────────────────────────\n`);
    process.stdout.write(`[${i + 1}/${MATRIX.length}] ${d.name}  (urgency=${d.urgency ?? "normal"})\n`);
    process.stdout.write(`────────────────────────────────────────────────────────────\n`);
    const taskStartedAt = Date.now();
    const rec = await runOne(d);
    records.push(rec);
    const elapsed = ((Date.now() - taskStartedAt) / 1000).toFixed(1);
    const v = verdictOf(rec.result);
    const r = rec.result.residual !== null ? `residual=${rec.result.residual.toFixed(3)}` : "residual=n/a";
    process.stdout.write(
      `[${i + 1}/${MATRIX.length}] ${d.name}  ${v}  ${r}  events=${rec.result.eventsCount}  ` +
        `bridge=${rec.result.bridgeInvokedCount}  refines=${rec.result.refinementEdges}  duration=${elapsed}s\n`,
    );
    if (rec.error) process.stdout.write(`  ⚠ error: ${rec.error}\n`);
    // Persist per-task buffer to a sibling /tmp file so the operator can read
    // the full per-task chain post-hoc without re-running the matrix.
    try {
      const fn = `/tmp/acc2-real-matrix-${d.name}.log`;
      await Bun.write(fn, rec.buffer);
      process.stdout.write(`  → per-task chain saved: ${fn}\n`);
    } catch {
      /* swallow — buffer is non-essential */
    }
  }

  process.off("SIGINT", onInt);

  const totalElapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  // ── Aggregate ────────────────────────────────────────────────────
  const committed = records.filter((r) => r.result.committed).length;
  const failed = records.filter((r) => r.result.failed).length;
  const timedOut = records.filter((r) => r.result.timedOut).length;
  const committedResiduals = records
    .filter((r) => r.result.committed && r.result.residual !== null)
    .map((r) => r.result.residual as number);
  const durations = records.map((r) => r.result.durationMs / 1000);
  const totalEvents = records.reduce((s, r) => s + r.result.eventsCount, 0);
  const totalBridge = records.reduce((s, r) => s + r.result.bridgeInvokedCount, 0);
  const totalArtifacts = records.reduce((s, r) => s + r.result.artifactsCount, 0);
  const totalRefines = records.reduce((s, r) => s + r.result.refinementEdges, 0);
  const totalRecipes = records.reduce((s, r) => s + r.result.recipeExtractedCount, 0);
  const totalVec = records.reduce((s, r) => s + r.result.vecEventsIndexed, 0);
  const totalArtInvoked = records.reduce((s, r) => s + r.result.artifactInvokedCount, 0);
  const totalViolations = records.reduce((s, r) => s + r.result.violations, 0);
  const distinctRuntimes = new Set<string>();
  for (const r of records) for (const rt of r.result.runtimesInvoked) distinctRuntimes.add(rt);
  const crisisFlips = records.filter((r) => r.result.crisisModeEngaged).length;
  const N = records.length;
  const avgBridge = N > 0 ? (totalBridge / N).toFixed(1) : "0.0";

  process.stdout.write(`\n===========================================================\n`);
  process.stdout.write(`acc2 real-brain matrix — ${N} tasks\n`);
  process.stdout.write(`===========================================================\n`);
  process.stdout.write(`  commit rate:           ${committed}/${N}  (${pct(committed, N)})\n`);
  process.stdout.write(`  fail rate:             ${failed}/${N}\n`);
  process.stdout.write(`  timed-out:             ${timedOut}/${N}\n`);
  process.stdout.write(
    `  median residual:       ${committedResiduals.length > 0 ? median(committedResiduals).toFixed(3) : "n/a"}  (over committed)\n`,
  );
  process.stdout.write(`  median duration:       ${median(durations).toFixed(1)}s\n`);
  process.stdout.write(`  total events:          ${totalEvents}\n`);
  process.stdout.write(`  total bridge cycles:   ${totalBridge}  (avg ${avgBridge} per task)\n`);
  process.stdout.write(`  total artifacts admitted: ${totalArtifacts}\n`);
  process.stdout.write(`  total refinement edges: ${totalRefines}\n`);
  process.stdout.write(`  total recipe-shape rows: ${totalRecipes}\n`);
  process.stdout.write(`  total vec_events indexed: ${totalVec}\n`);
  process.stdout.write(`  total artifact_invoked: ${totalArtInvoked}\n`);
  process.stdout.write(
    `  distinct runtimes:     ${distinctRuntimes.size > 0 ? [...distinctRuntimes].sort().join(", ") : "(none)"}\n`,
  );
  process.stdout.write(
    `  dispatcher violations: ${totalViolations}  ${totalViolations === 0 ? "✓  (cycle-1-only invariant)" : "⚠"}\n`,
  );
  process.stdout.write(`  crisis mode flips:     ${crisisFlips} (expected from urgency=crisis directives)\n`);
  process.stdout.write(`  wall-clock total:      ${totalElapsed}s\n`);
  process.stdout.write(`===========================================================\n`);

  // Per-task one-liners again for at-a-glance review.
  process.stdout.write(`\nPer-task summary:\n`);
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const v = verdictOf(r.result);
    const rr = r.result.residual !== null ? r.result.residual.toFixed(3) : "n/a";
    const dur = (r.result.durationMs / 1000).toFixed(1);
    process.stdout.write(
      `  [${i + 1}/${N}] ${r.name.padEnd(22)} ${v.padEnd(10)}  residual=${rr.padStart(5)}  events=${String(r.result.eventsCount).padStart(4)}  bridge=${r.result.bridgeInvokedCount}  refines=${r.result.refinementEdges}  art=${r.result.artifactsCount}  inv=${r.result.artifactInvokedCount}  rt=${r.result.runtimesInvoked.join(",") || "-"}  dur=${dur}s\n`,
    );
  }

  return committed === N && totalViolations === 0 ? 0 : 1;
};

// Entry point — only when invoked directly, not when imported by a test.
if (import.meta.main) {
  runMatrix().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`acc2 real-brain matrix crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
      process.exit(2);
    },
  );
}

export { runMatrix, MATRIX };
