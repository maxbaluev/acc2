// acc2 canonical test runner — `bun run test`.
//
// Why this exists (not a bare `bun test --parallel`): Bun's `--parallel` with
// no value defaults to the CPU-core COUNT. Many acc2 integration tests boot an
// isolated daemon + FastMCP server per worker. On a high-core but modest-RAM
// host that over-subscribes resources and the workers die with SIGILL — and
// the run is SLOWER, not faster. So we size the fleet to the host (memory +
// load aware) and cap it at the measured-stable ceiling.
//
// Extra args after `bun run test` are forwarded (e.g. `bun run test --watch`,
// or a path: `bun run test runtime/foo.test.ts`).

import { cpus, freemem, tmpdir } from "node:os";
import { readFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";

const PER_WORKER_RAM_BYTES = 500_000_000; // ~0.5GB budget per worker
const RESERVE_BYTES = 2_000_000_000;      // keep ~2GB for the OS + the test parent

// Hard ceiling on parallel workers regardless of how much RAM is free. Bun's
// test-worker fleet crashes nondeterministically with SIGILL / "Segmentation
// fault" when too many workers do heavy native work at once (bun:sqlite +
// spawning real FastMCP HTTP servers + subprocesses).
//
// 6 is the MEASURED sweet spot and the ceiling is NOT worth raising — verified
// 2026-05-27 on a 20-core box with the retry path already cheap:
//     workers=6  → ~32s, 0 crashes, 0 fails
//     workers=8  → ~40s, 0 crashes, 1 fail
//     workers=12 → ~39s, 0 crashes, 5 fails
// Going wider did NOT reduce wall-clock — the suite is bound by native
// serialization (bun:sqlite locks + FastMCP boots), not CPU — AND it surfaced
// parallel-timing fails that do not occur at 6. So more workers is strictly
// worse here. Keep 6. computeWorkers() still backs the count DOWN by 1-minute
// load average so a box already busy with a live daemon or a sibling
// `bun run test` in another worktree is not piled on.
const MAX_WORKERS = 6;

// Host memory genuinely available right now. Prefer Linux MemAvailable
// (reclaimable-cache-aware); os.freemem() (MemFree) under-reports because it
// excludes reclaimable page cache. Falls back off-Linux.
const availableBytes = (): number => {
  try {
    const m = readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+)\s+kB/m);
    if (m) return Number(m[1]) * 1024;
  } catch { /* non-linux / unreadable */ }
  return freemem();
};

// Idle CPU headroom right now, from the 1-minute load average: cores not
// already committed to other work (the live daemon, a sibling `bun run test`
// in another worktree, an in-flight brain). On an idle box this ≈ cores; on a
// loaded one it shrinks, so we scale the fleet DOWN instead of oversubscribing
// (which both slows everyone and makes SIGILL more likely). Falls back to all
// cores where loadavg is unavailable (non-Linux).
const idleCores = (): number => {
  const cores = Math.max(1, cpus().length);
  try {
    const load1 = Number(readFileSync("/proc/loadavg", "utf8").split(/\s+/)[0]);
    if (Number.isFinite(load1)) return Math.max(1, Math.floor(cores - load1));
  } catch { /* non-linux / unreadable */ }
  return cores;
};

const computeWorkers = (): { workers: number; avail: number } => {
  const avail = availableBytes();
  const envOverride = Number(process.env.ACC2_TEST_WORKERS);
  if (Number.isFinite(envOverride) && envOverride >= 1) return { workers: Math.floor(envOverride), avail };
  const cores = Math.max(1, cpus().length);
  const memBudget = Math.max(1, Math.floor(Math.max(0, avail - RESERVE_BYTES) / PER_WORKER_RAM_BYTES));
  // min(cores, RAM budget, load-aware idle cores, SIGILL/host ceiling); floor 2.
  return { workers: Math.max(2, Math.min(cores, memBudget, idleCores(), MAX_WORKERS)), avail };
};

const forwarded = Bun.argv.slice(2);

// Sweep stale `acc2-*` scratch dirs out of the OS temp dir before a run.
//
// WHY: every daemon/db/bridge test mkdtemp's a per-test scratch dir under
// tmpdir() and rmSync's it in afterEach/afterAll — but a worker that SIGILLs
// or segfaults mid-test (the Bun-native crash this runner retries around) dies
// before its cleanup runs, AND the preload's per-pid `acc2-test-state-<pid>`
// dir is never cleaned at all. Across many runs these orphans accumulated to
// ~48k dirs / 29GB here, which bloats every subsequent `mkdtemp`/`readdir`
// (and, when /tmp is tmpfs, eats RAM that feeds the MemAvailable-based worker
// math) — the suite got monotonically slower the more it was run. Sweeping at
// the runner layer bounds the leak permanently regardless of which test leaks
// or how a worker dies.
//
// Only dirs older than the cutoff are removed so a suite running concurrently
// in another terminal (its scratch dirs are fresh) is never disturbed.
const STALE_TMP_CUTOFF_MS = 30 * 60 * 1000; // 30 min
const sweepStaleTmpDirs = (): void => {
  const root = tmpdir();
  const now = Date.now();
  let removed = 0;
  let entries: string[];
  try { entries = readdirSync(root); } catch { return; }
  for (const name of entries) {
    if (!name.startsWith("acc2-")) continue;
    const full = join(root, name);
    try {
      if (now - statSync(full).mtimeMs < STALE_TMP_CUTOFF_MS) continue;
      rmSync(full, { recursive: true, force: true });
      removed++;
    } catch { /* raced with another sweeper / in-use — skip */ }
  }
  if (removed > 0) console.error(`[acc2 test] swept ${removed} stale acc2-* scratch dir(s) from ${root}`);
};

// Parse the set of test FILES that failed (or crashed) from a Bun test run's
// combined stdout+stderr. This is the targeted-retry input: instead of
// re-running all ~220 files we re-run only the handful that failed to
// distinguish a transient SIGILL/segfault from a real assertion failure.
//
// Two complementary signals are parsed because Bun emits failures two ways:
//   1. A per-file heading (`runtime/foo.test.ts:`) becomes the "current file";
//      a following `(fail)`/`✗` marker line attributes the failure to it.
//   2. A direct file reference on a failure/crash line (`fail: ./x.test.ts:..`,
//      `error while running x.test.ts`, `SIGILL in x.test.ts`, `worker crashed
//      … x.test.ts`) — covers a worker that crashed natively.
// Returns a de-duplicated, sorted list of repo-relative paths.
export function parseFailedTestFiles(output: string): string[] {
  const failed = new Set<string>();
  const norm = (p: string): string => p.replace(/^\.\//, "");
  // Strip ANSI escape codes first: the runner spawns the child with FORCE_COLOR
  // so the operator still sees Bun's coloured reporter while we tee, but that
  // wraps every heading/marker in `\e[..m` sequences AND switches the failure
  // glyph from plain `(fail)` to a coloured `✗`. Strip both so parsing is
  // identical whether or not colour is on.
  const ansi = /\[[0-9;]*[A-Za-z]/g;
  const headingRe = /^\s*((?:\.\/)?[\w./-]+\.test\.ts):\s*$/;
  const pathRe = /(?:\.\/)?[\w./-]+\.test\.ts/g;
  // Bun marks a failed test with `(fail)` (plain) or `✗` U+2717 / `✘` U+2718
  // (coloured reporter). Either glyph attributes the failure to the current file.
  const failMarkerRe = /^\s*(?:\(fail\)|✗|✘)/;
  const crashRe = /\b(?:fail|error|sigill|segmentation fault|panic|crash|killed|oom)\b/i;
  let currentFile: string | null = null;
  for (const raw of output.split("\n")) {
    const line = raw.replace(ansi, "");
    const heading = line.match(headingRe);
    if (heading) {
      currentFile = norm(heading[1]);
      continue;
    }
    if (failMarkerRe.test(line)) {
      // The marker line itself often carries the path (e.g. a worker-crash
      // line `✗ cli/dispatch.test.ts (worker crashed: SIGILL)`); prefer that,
      // else fall back to the current file heading.
      const onLine = line.match(pathRe);
      if (onLine) for (const m of onLine) failed.add(norm(m));
      else if (currentFile) failed.add(currentFile);
      continue;
    }
    if (crashRe.test(line)) {
      for (const m of line.match(pathRe) ?? []) failed.add(norm(m));
    }
  }
  return [...failed].sort();
}

type SuiteResult = { code: number; output: string };

const runSuite = async (
  parallel: number,
  bail: boolean,
  opts: { files?: string[]; capture?: boolean } = {},
): Promise<SuiteResult> => {
  const args = ["test", `--parallel=${parallel}`, ...(bail ? ["--bail"] : []), ...forwarded, ...(opts.files ?? [])];
  if (!opts.capture) {
    const proc = Bun.spawn(["bun", ...args], { stdio: ["inherit", "inherit", "inherit"] });
    return { code: await proc.exited, output: "" };
  }
  // Capture for failed-file parsing while still streaming live to the terminal.
  // FORCE_COLOR keeps Bun's coloured reporter output even though stdout is now a
  // pipe; we tee the raw bytes so the operator's view is unchanged, and decode a
  // copy for parseFailedTestFiles. stdout/stderr are accumulated separately so a
  // concurrent-write interleave can never corrupt a heading/marker line.
  const proc = Bun.spawn(["bun", ...args], {
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? "1" },
  });
  let out = "";
  let err = "";
  const tee = async (
    stream: ReadableStream<Uint8Array>,
    sink: typeof process.stdout,
    append: (s: string) => void,
  ): Promise<void> => {
    const dec = new TextDecoder();
    for await (const chunk of stream) {
      sink.write(chunk);
      append(dec.decode(chunk, { stream: true }));
    }
  };
  await Promise.all([
    tee(proc.stdout, process.stdout, (s) => { out += s; }),
    tee(proc.stderr, process.stderr, (s) => { err += s; }),
  ]);
  return { code: await proc.exited, output: `${out}\n${err}` };
};

// Guard the executable block behind `import.meta.main` so importing this module
// (e.g. scripts/test.test.ts importing parseFailedTestFiles) does NOT recursively
// spawn the whole test suite. Only running it as the entry point launches a run.
if (import.meta.main) {
  sweepStaleTmpDirs();
  const { workers, avail } = computeWorkers();
  console.error(`[acc2 test] ${workers} parallel workers (cores=${cpus().length}, available=${(avail / 1e9).toFixed(1)}GB, ceiling=${MAX_WORKERS})`);

  // First pass: run the FULL suite WITHOUT --bail, capturing output so a
  // non-zero exit can be triaged to the specific failed file(s).
  //
  // Why NOT --bail (measured 2026-05-27): a transient worker SIGILL DURING a
  // --bail pass makes Bun hang/thrash for 150s+ before it aborts — one such
  // run took 160s total (vs a ~32–50s clean pass) while the actual failure was
  // a single file that passed instantly on retry. --bail only helps when a REAL
  // failure aborts early (rare), is identical to no-bail on a green run, and is
  // catastrophically worse on the COMMON case (a transient native crash). So we
  // drop it: same cost on green, runs to completion instead of hanging on a
  // crash, and reports EVERY failed file at once for the targeted retry below.
  const first = await runSuite(workers, false, { capture: true });
  let code = first.code;

  const interactive = forwarded.some((a) => a === "--watch" || a === "-w");
  const crashShape = /SIGILL|segmentation fault|worker crashed|panic\(/i;
  if (code !== 0 && !interactive) {
    let failedFiles = parseFailedTestFiles(first.output);
    if (failedFiles.length === 0) {
      // No parseable file (a worker segfaulted before printing any marker) —
      // retry the FULL suite once at one fewer worker (fresh fleet + a small
      // contention reduction).
      const retryWorkers = Math.max(2, workers - 1);
      console.error(`[acc2 test] non-zero exit but no failed file was parseable (worker crash before any marker) — retrying full suite once at ${retryWorkers} workers`);
      code = (await runSuite(retryWorkers, false)).code;
    } else {
      // Targeted retry with ESCALATING ISOLATION so the parallel suite ALWAYS
      // converges green for correct code. Bun's SIGILL/segfault is
      // nondeterministic native contention (bun:sqlite + real FastMCP HTTP
      // servers booting at once), not a code defect — it clears when the few
      // failed files run with less concurrency. A real assertion failure, by
      // contrast, reproduces at ANY concurrency. So we re-run only the failed
      // files down a worker ladder (parallel → half → serial): each rung is
      // cheap, the final serial rung has effectively zero intra-run contention,
      // and we STOP immediately on a clean (non-crash) failure to surface real
      // breakage as red.
      const ladder = Array.from(new Set([workers, Math.max(2, Math.floor(workers / 2)), 1]));
      code = first.code;
      for (let i = 0; i < ladder.length; i++) {
        const w = ladder[i];
        console.error(`[acc2 test] retrying ONLY the ${failedFiles.length} failed file(s) at ${w} worker(s) (rung ${i + 1}/${ladder.length}): ${failedFiles.join(", ")}`);
        const r = await runSuite(w, false, { files: failedFiles, capture: true });
        if (r.code === 0) { code = 0; break; }
        code = r.code;
        if (!crashShape.test(r.output)) {
          console.error(`[acc2 test] failed file(s) reproduced a real (non-crash) failure at ${w} worker(s) — surfacing as red.`);
          break;
        }
        const narrowed = parseFailedTestFiles(r.output);
        if (narrowed.length > 0) failedFiles = narrowed;
        if (i === ladder.length - 1) {
          console.error(`[acc2 test] native crash persisted on the serial rung for: ${failedFiles.join(", ")} — surfacing as red (investigate for a genuine native fault).`);
        }
      }
    }
  }

  process.exit(code);
}
