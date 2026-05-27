// acc2 canonical test runner — `bun run test`.
//
// Why this exists (not a bare `bun test --parallel`): Bun's `--parallel` with
// no value defaults to the CPU-core COUNT. Many acc2 integration tests boot an
// isolated daemon + FastMCP server per worker (~1.5GB each). On a high-core but
// modest-RAM host that over-subscribes RAM and the workers die with SIGILL —
// and the run is SLOWER, not faster.
//
// Crucially the cap is sized by AVAILABLE memory, not total: the suite usually
// runs WHILE the live daemon (and possibly an in-flight brain) is resident, so
// total-RAM math over-commits. Sizing off MemAvailable makes the run adaptive:
// many workers when the box is idle, fewer when it is busy (never starves the
// daemon). Tests are already state/port isolated via mkdtemp + free ports; this
// keeps them resource-isolated too. Override with ACC2_TEST_WORKERS=N.
//
// Worker-count sweet spot (measured 2026-05-27, 20-core / 16GB WSL box, full
// 208-file / ~2313-test suite): 6 workers is fastest AND stablest (~41–48s,
// no SIGILL across repeated runs). 8 workers starts shedding tests to native
// contention; 2–4 workers are BOTH slower (90–399s) AND more SIGILL-prone.
// SIGILL is Bun-native (bun:sqlite + worker isolation), nondeterministic, and
// NOT monotonic in parallelism — so the ceiling is a contention limit, not a
// RAM budget, and lower parallelism is not a safety lever.
//
// Extra args after `bun run test` are forwarded (e.g. `bun run test --watch`,
// or a path: `bun run test runtime/foo.test.ts`).

import { cpus, freemem } from "node:os";
import { readFileSync } from "node:fs";

// Empirical per-worker footprint (measured 2026-05-27): the full suite at 6
// workers peaked at ~0.6GB RSS *total* (parent + all workers), i.e. ~0.1GB
// per worker — the old 1.5GB/worker figure was wildly conservative and
// artificially capped the run at 5 workers on a box with the live daemon
// resident, even though 6 is both faster and stabler. The genuine ceiling is
// the SIGILL contention limit (MAX_WORKERS below), NOT RAM. Keep a modest
// per-worker budget so the math still backs off on a genuinely starved box.
const PER_WORKER_RAM_BYTES = 500_000_000; // ~0.5GB budget per worker (5x measured headroom)
const RESERVE_BYTES = 2_000_000_000;      // keep ~2GB for the OS + the test parent

// Hard ceiling on parallel workers regardless of how much RAM is free. Bun's
// test-worker fleet crashes nondeterministically with SIGILL / "Segmentation
// fault" when too many workers do heavy native work at once (bun:sqlite +
// spawning real FastMCP HTTP servers + subprocesses). Observed 2026-05-25:
// runs at 8–11 workers SIGILL'd in runtime/bridge.test.ts and
// runtime/daemon.test.ts while the identical files pass in isolation and the
// whole suite passes no-bail. The crash is a runtime resource ceiling, not a
// per-test memory budget, so cap worker COUNT independently of the RAM math.
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

const computeWorkers = (): { workers: number; avail: number } => {
  const avail = availableBytes();
  const envOverride = Number(process.env.ACC2_TEST_WORKERS);
  if (Number.isFinite(envOverride) && envOverride >= 1) return { workers: Math.floor(envOverride), avail };
  const cores = Math.max(1, cpus().length);
  const memBudget = Math.max(1, Math.floor(Math.max(0, avail - RESERVE_BYTES) / PER_WORKER_RAM_BYTES));
  return { workers: Math.max(2, Math.min(cores, memBudget, MAX_WORKERS)), avail };
};

const { workers, avail } = computeWorkers();
const forwarded = Bun.argv.slice(2);

const runSuite = async (parallel: number, bail: boolean): Promise<number> => {
  const args = ["test", `--parallel=${parallel}`, ...(bail ? ["--bail"] : []), ...forwarded];
  const proc = Bun.spawn(["bun", ...args], { stdio: ["inherit", "inherit", "inherit"] });
  return await proc.exited;
};

console.error(`[acc2 test] ${workers} parallel workers (cores=${cpus().length}, available=${(avail / 1e9).toFixed(1)}GB, ceiling=${MAX_WORKERS})`);

// First pass: fast feedback with --bail at the computed concurrency.
let code = await runSuite(workers, true);

// A non-zero exit is AMBIGUOUS: it is either a real assertion failure OR a
// transient Bun worker crash (SIGILL/segfault) that bail turned into a suite
// abort. Distinguish by retrying ONCE WITHOUT --bail: a real failure
// reproduces (and we now get the full report instead of a bailed-early one);
// a transient runtime crash usually clears on a fresh worker fleet.
//
// CONCURRENCY OF THE RETRY (measured 2026-05-27): the old "halve the worker
// count" rule was actively harmful. SIGILL is nondeterministic Bun-native
// contention, NOT a monotonic function of parallelism — full-suite runs at
// 2 and 4 workers SIGILL'd AND ran for 4–6.6 MINUTES (244s / 399s), while 5–7
// workers completed clean in ~41–48s across repeated runs. Halving (6→3, or
// 5→2) dropped the retry straight into the slow, crash-prone low-worker zone,
// roughly DOUBLING total wall-clock. So the retry now drops by just ONE worker
// (a fresh fleet + a small contention reduction) and stays in the fast band.
// Skip the retry for --watch and other interactive forwards.
const interactive = forwarded.some((a) => a === "--watch" || a === "-w");
if (code !== 0 && !interactive) {
  const retryWorkers = Math.max(2, workers - 1);
  console.error(`[acc2 test] non-zero exit — retrying once at ${retryWorkers} workers, no --bail (fresh worker fleet clears transient SIGILL/segfault without collapsing into the slow low-parallelism band; a real failure will reproduce with full output)`);
  code = await runSuite(retryWorkers, false);
}

process.exit(code);
