// acc2 canonical test runner — `bun run test`.
//
// Why this exists (not a bare `bun test --parallel`): Bun's `--parallel` with
// no value defaults to the CPU-core COUNT. Many acc2 integration tests boot an
// isolated daemon + FastMCP server per worker (~1-1.5GB each). On a high-core
// but modest-RAM host that over-subscribes RAM and the workers die with SIGILL
// — and the run is SLOWER, not faster. Live evidence (20-core / 15.5GB box):
//   --parallel (=20 workers): 200s wall, 2 SIGILL worker crashes.
//   --parallel=10           :  19s wall, clean.
// So cap workers by the TIGHTER of (cores) and a ~1.5GB-per-worker memory
// budget, leaving headroom for the live daemon + an in-flight brain so the
// suite never disturbs a running daemon (tests are already state/port isolated;
// this keeps them resource-isolated too). Override with ACC2_TEST_WORKERS=N.
//
// Extra args after `bun run test` are forwarded (e.g. `bun run test --watch`,
// or a path: `bun run test runtime/foo.test.ts`).

import { cpus, totalmem } from "node:os";

const PER_WORKER_RAM_BYTES = 1_500_000_000; // ~1.5GB budget per daemon-booting worker

const computeWorkers = (): number => {
  const envOverride = Number(process.env.ACC2_TEST_WORKERS);
  if (Number.isFinite(envOverride) && envOverride >= 1) return Math.floor(envOverride);
  const cores = Math.max(1, cpus().length);
  const memBudget = Math.max(1, Math.floor(totalmem() / PER_WORKER_RAM_BYTES));
  return Math.max(2, Math.min(cores, memBudget));
};

const workers = computeWorkers();
const forwarded = Bun.argv.slice(2);
const args = ["test", `--parallel=${workers}`, "--bail", ...forwarded];

console.error(`[acc2 test] ${workers} parallel workers (cores=${cpus().length}, mem-budget=${Math.floor(totalmem() / PER_WORKER_RAM_BYTES)})`);

const proc = Bun.spawn(["bun", ...args], { stdio: ["inherit", "inherit", "inherit"] });
process.exit(await proc.exited);
