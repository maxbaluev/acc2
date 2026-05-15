#!/usr/bin/env bun
import { Glob } from "bun";

type Timing = {
  file: string;
  exitCode: number | null;
  durationMs: number;
};

const args = new Set(process.argv.slice(2));
const json = args.has("--json");
const continueOnFailure = args.has("--continue-on-failure");
const topArg = process.argv.find((arg) => arg.startsWith("--top="));
const topN = topArg ? Number(topArg.slice("--top=".length)) : 5;
const patterns = process.argv.slice(2).filter((arg) => !arg.startsWith("--") && arg.length > 0);

const testFiles = patterns.length > 0
  ? patterns
  : [...new Glob("**/*.test.ts").scanSync({ cwd: process.cwd(), onlyFiles: true })]
      .filter((file) => !file.startsWith("node_modules/"));

const uniqueFiles = [...new Set(testFiles)].sort();
const timings: Timing[] = [];
const startedAt = performance.now();

for (const file of uniqueFiles) {
  const start = performance.now();
  const proc = Bun.spawn(["bun", "test", file, "--bail", "--timeout", "30000"], {
    stdout: "ignore",
    stderr: "pipe",
    env: process.env,
  });
  const exitCode = await proc.exited;
  const durationMs = Math.round(performance.now() - start);
  timings.push({ file, exitCode, durationMs });

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    console.error(`${file} failed with exit ${exitCode}`);
    console.error(stderr);
    if (!continueOnFailure) break;
  }

  if (!json) console.log(`${durationMs.toString().padStart(6)} ms  ${file}`);
}

const totalMs = Math.round(performance.now() - startedAt);
const slowest = [...timings].sort((a, b) => b.durationMs - a.durationMs).slice(0, topN);
const failed = timings.filter((timing) => timing.exitCode !== 0);
const maxSlowFileMs = slowest[0]?.durationMs ?? 0;
const residual = failed.length > 0 ? 1 : Math.min(1, maxSlowFileMs / 12_000);

const report = {
  fileCount: uniqueFiles.length,
  timedCount: timings.length,
  totalMs,
  topN,
  slowest,
  failed,
  residual,
};

if (json) console.log(JSON.stringify(report, null, 2));
else {
  console.log("\nSlowest files:");
  for (const timing of slowest) console.log(`${timing.durationMs.toString().padStart(6)} ms  ${timing.file}`);
  console.log(`\nTimed ${timings.length}/${uniqueFiles.length} files in ${totalMs} ms; residual=${residual.toFixed(3)}`);
}

process.exit(failed.length > 0 ? 1 : 0);
