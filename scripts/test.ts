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
// total-RAM math over-commits (live evidence: 11 workers sized off 16GB total
// crashed with SIGILL while the daemon was draining work, because only ~7GB was
// actually free). Sizing off MemAvailable makes the run adaptive: many workers
// when the box is idle (fast), few when it is busy (stable, never starves the
// daemon). Tests are already state/port isolated via mkdtemp + free ports; this
// keeps them resource-isolated too. Override with ACC2_TEST_WORKERS=N.
//
// Extra args after `bun run test` are forwarded (e.g. `bun run test --watch`,
// or a path: `bun run test runtime/foo.test.ts`).

import { cpus, freemem } from "node:os";
import { readFileSync } from "node:fs";

const PER_WORKER_RAM_BYTES = 1_500_000_000; // ~1.5GB budget per daemon-booting worker
const RESERVE_BYTES = 2_000_000_000;        // keep ~2GB for the OS + the test parent

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
  return { workers: Math.max(2, Math.min(cores, memBudget)), avail };
};

const { workers, avail } = computeWorkers();
const forwarded = Bun.argv.slice(2);
const args = ["test", `--parallel=${workers}`, "--bail", ...forwarded];

console.error(`[acc2 test] ${workers} parallel workers (cores=${cpus().length}, available=${(avail / 1e9).toFixed(1)}GB)`);

const proc = Bun.spawn(["bun", ...args], { stdio: ["inherit", "inherit", "inherit"] });
process.exit(await proc.exited);
