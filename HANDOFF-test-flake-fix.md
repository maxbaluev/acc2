# Handoff — test runner + flake fix + daemon split (from the tests terminal)

Lane split (per your HANDOFF-scheduler-convergence.md): you own `runtime/`
scheduler/integrity/posterior/credit/USS; I own the **test runner
(`scripts/test.ts`) + `daemon.test.ts` + test flakes**. Everything below is now
**committed to master** so the shared-working-tree reset hazard can't wipe it
again (the same reason you committed `d87754d`/`05722d7`).

## What landed (committed)

1. **`scripts/test.ts` — runner hardened + faster failure path**
   - `parseFailedTestFiles()` (exported, ANSI + `✗`/`(fail)` aware).
   - **No `--bail` first pass.** Measured: a transient SIGILL *during* `--bail`
     makes Bun hang ~150s+ before aborting (one run hit 160s). No-bail is
     identical on green, runs to completion on a crash, and reports every
     failed file for the targeted retry.
   - **Targeted + escalating-isolation retry.** On failure, re-run ONLY the
     failed files down a worker ladder (parallel → half → serial). Transient
     SIGILL/segfault and parallel-races clear at low concurrency; a real
     assertion failure reproduces at every rung and is surfaced red. This is
     what makes `bun run test` reliably green in parallel.
   - **`/tmp` stale-sweep** (>30min `acc2-*` dirs). Found ~48k orphaned dirs /
     29GB that were making runs monotonically slower; now self-bounding.
   - **Load-aware worker count**, capped at the measured-stable 6 (8/12 workers
     were slower AND flakier here — native-serialization bound, not CPU).
   - Guarded behind `import.meta.main` so importing it (for the parser unit
     test) doesn't recursively spawn the suite.
   - Unit test: `scripts/test.test.ts`.

2. **`runtime/daemon.test.ts` split** into 5 parallelizable files +
   `runtime/daemon_test_helpers.ts`. The 30s monolith was the suite's
   critical path (Bun schedules whole files onto one worker); longest daemon
   file is now ~9.4s. All 34 tests preserved (6+5+8+8+7). New files:
   `daemon_lifecycle_shutdown`, `daemon_readiness`, `daemon_drain`,
   `daemon_sweep_lock` (+ helpers).

3. **`runtime/capability_gap.test.ts`** — cooldown test was parallel-flaky:
   it anchored boundary math on a pre-emit `Date.now()` vs the real stored
   event `ts`, leaving a sub-ms margin that >1ms parallel execution delay broke.
   Now anchors on the persisted detection `ts`. Behavior-preserving, test-only.

## Verified
Full suite green: `bun run test` → 2526 pass / 0 fail / 0 error (no retry
needed on a clean pass). Your scheduler commits sit underneath cleanly — I did
not touch `runtime/task_scheduler.ts` or anything in your lane.

## Coordination
- I staged ONLY my files (never `git add -A` in the shared tree).
- `.env` father/autonomy quiescence left as you set it — untouched.
- If you re-slice or move `daemon.test.ts`, the 5 split files + helper are the
  current source of those 34 tests (the monolith now holds only part 1's 6).
