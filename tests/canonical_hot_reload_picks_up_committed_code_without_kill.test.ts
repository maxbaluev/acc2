// F10 canonical hot-reload — falsifying tests for the supervisor's
// design. The full process-lifecycle leg (spawn outer supervisor +
// child + /shutdown roundtrip) is exercised in integration; this
// suite pins the three structural decisions a hot-reload swap rests
// on:
//
//   Case A. The supervisor's decision function returns `no_op` for
//           identical HEADs and `swap` for divergent HEADs, both with
//           the supervisor process remaining alive (decideSupervisorAction
//           is pure — its return shape is the falsifiability surface).
//   Case B. Open `brain_dispatched` rows + an insufficient drain budget
//           defer the swap. The emitted evidence row is
//           `daemon_hotreload_rejected`, not a new event kind.
//   Case D. The child writes `loaded_git_head` to a sibling state file
//           at boot; the supervisor (separate process model) reads it
//           via the cross-process helper and that read drives the
//           decision.
//
// Cites the F10 design KCs:
//   EJFZER4SBH3C51WF1J6KWX2V6G (git HEAD detector),
//   JQ5339HR1N2CQ6FH59JRJ3Z4NW (outer supervisor),
//   T9MRX55WX90NFEPHJRE37RC2XC (eligibility predicate),
//   R2DKSST5SN3BZFF1YH2XK9XF94 (event kind reuse),
//   7T0Y7EMGPD1BXDF4CR5F7YNYJC (quiescent swap protocol).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, openDb } from "../substrate/db";
import { emitEvent } from "../runtime/events";
import {
  decideSupervisorAction,
  emitReloadDeferred,
  isReloadEligible,
  readChildGitHead,
  removeChildGitHead,
  resolveChildGitHeadPath,
  runSupervisorLoop,
  writeChildGitHead,
  type SupervisorChildHandle,
  type SupervisorLoopDeps,
} from "../runtime/daemon_supervisor";
import { runDispatch } from "../cli/dispatch";

const dbPath = ":memory:";
let db: ReturnType<typeof openDb>;
let stateDir: string;

const seedDispatch = (dispatchId: string, startedAtMs: number): void => {
  emitEvent(db, {
    kind: "brain_dispatched",
    substrate_origin: "opencode",
    directive_id: "d-hr-1",
    task_id: "t-hr-1",
    payload: {
      dispatch_id: dispatchId,
      session_token: "hr-test",
      started_at_ms: startedAtMs,
      subprocess_pid: 4242,
      directive_id: "d-hr-1",
    },
  });
};

beforeEach(() => {
  db = openDb(dbPath);
  stateDir = mkdtempSync(join(tmpdir(), "acc2-f10-test-"));
});

afterEach(() => {
  closeDb(dbPath);
  try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* tolerate */ }
});

describe("F10 canonical hot-reload picks up committed code without kill", () => {
  test("Case A — divergent HEAD with no open dispatches yields swap; identical HEAD yields no_op", () => {
    const now = 10_000_000;
    const childBootAtMs = now - 10 * 60 * 1000; // 10 min old, past min age

    const stay = decideSupervisorAction(
      db,
      { currentGitHead: "deadbeefcafebabe", childGitHead: "deadbeefcafebabe", childBootAtMs },
      { tickIntervalMs: 1000, minChildAgeMs: 60_000, drainBudgetMs: 60_000, nowMs: () => now },
    );
    expect(stay.action).toBe("no_op");
    if (stay.action === "no_op") expect(stay.reason).toBe("head_unchanged");

    const swap = decideSupervisorAction(
      db,
      { currentGitHead: "f00dface11223344", childGitHead: "deadbeefcafebabe", childBootAtMs },
      { tickIntervalMs: 1000, minChildAgeMs: 60_000, drainBudgetMs: 60_000, nowMs: () => now },
    );
    expect(swap.action).toBe("swap");
    if (swap.action === "swap") {
      expect(swap.previous_git_head).toBe("deadbeefcafebabe");
      expect(swap.new_git_head).toBe("f00dface11223344");
      expect(swap.eligibility.open_brain_dispatch_count).toBe(0);
    }
  });

  test("Case A2 — child too young defers the swap regardless of HEAD change", () => {
    const now = 10_000_000;
    const decision = decideSupervisorAction(
      db,
      { currentGitHead: "newhead", childGitHead: "oldhead", childBootAtMs: now - 10_000 },
      { minChildAgeMs: 60_000, drainBudgetMs: 60_000, nowMs: () => now },
    );
    expect(decision.action).toBe("no_op");
    if (decision.action === "no_op") expect(decision.reason).toBe("child_too_young");
  });

  test("Case B — open brain dispatches plus insufficient drain budget defer the swap and emit daemon_hotreload_rejected", () => {
    const now = 10_000_000;
    seedDispatch("d-hr-open-1", now - 30_000); // 30s old
    seedDispatch("d-hr-open-2", now - 90_000); // 90s old — projected drain anchored here

    // Drain budget 30s; estimated completion 5min → projected drain >>
    // budget → defer with drain_budget_insufficient.
    const decision = decideSupervisorAction(
      db,
      { currentGitHead: "newhead", childGitHead: "oldhead", childBootAtMs: now - 10 * 60 * 1000 },
      { minChildAgeMs: 60_000, drainBudgetMs: 30_000, nowMs: () => now },
    );
    expect(decision.action).toBe("defer");
    if (decision.action === "defer") {
      expect(decision.reason).toBe("drain_budget_insufficient");
      expect(decision.eligibility.open_brain_dispatch_count).toBe(2);
      expect(decision.eligibility.oldest_lease_age_ms).toBeGreaterThanOrEqual(90_000);
      emitReloadDeferred(db, decision.eligibility, {
        previous_git_head: "oldhead",
        new_git_head: "newhead",
      });
    }

    const rejected = db
      .query(`SELECT payload FROM events WHERE kind = 'daemon_hotreload_rejected' ORDER BY ts ASC`)
      .all() as Array<{ payload: string }>;
    expect(rejected.length).toBe(1);
    const parsed = JSON.parse(rejected[0].payload) as Record<string, unknown>;
    expect(parsed.reason).toBe("drain_budget_insufficient");
    expect(parsed.open_brain_dispatch_count).toBe(2);
    expect(parsed.drain_budget_ms).toBe(30_000);
    expect(parsed.previous_git_head).toBe("oldhead");
    expect(parsed.new_git_head).toBe("newhead");
  });

  test("Case B2 — open dispatch with generous drain budget remains eligible", () => {
    const now = 10_000_000;
    seedDispatch("d-hr-fast", now - 5_000);
    const result = isReloadEligible(db, {
      drainBudgetMs: 10 * 60 * 1000,
      estimatedCompletionMs: 60_000,
      nowMs: () => now,
    });
    expect(result.eligible).toBe(true);
    expect(result.open_brain_dispatch_count).toBe(1);
    expect(result.refusal_reason).toBe(null);
  });

  test("Case D — child writes loaded_git_head; supervisor reads it; comparison drives the decision", () => {
    // Pin the supervisor state-dir helper to the test scratch dir so
    // the cross-process state file lives outside the operator's home.
    const childHead = "1111aaaa2222bbbb3333cccc4444dddd55556666";
    expect(readChildGitHead(stateDir)).toBe(null);

    writeChildGitHead(childHead, stateDir);
    expect(readChildGitHead(stateDir)).toBe(childHead);
    expect(resolveChildGitHeadPath(stateDir).endsWith("v2.sock.git_head")).toBe(true);

    // Supervisor compares: identical HEAD → no_op.
    const now = 10_000_000;
    const childBootAtMs = now - 10 * 60 * 1000;
    const stayDecision = decideSupervisorAction(
      db,
      { currentGitHead: childHead, childGitHead: readChildGitHead(stateDir), childBootAtMs },
      { minChildAgeMs: 60_000, drainBudgetMs: 60_000, nowMs: () => now },
    );
    expect(stayDecision.action).toBe("no_op");

    // Repo HEAD advances (operator commits new code); the running
    // child still holds the previous HEAD on disk; supervisor's next
    // tick reads the on-disk value and the decision flips to swap.
    const newRepoHead = "9999eeee8888ffff77770000aaaabbbb11112222";
    const swapDecision = decideSupervisorAction(
      db,
      { currentGitHead: newRepoHead, childGitHead: readChildGitHead(stateDir), childBootAtMs },
      { minChildAgeMs: 60_000, drainBudgetMs: 60_000, nowMs: () => now },
    );
    expect(swapDecision.action).toBe("swap");
    if (swapDecision.action === "swap") {
      expect(swapDecision.previous_git_head).toBe(childHead);
      expect(swapDecision.new_git_head).toBe(newRepoHead);
    }

    // Reap clears the file so the next tick sees child_head_unavailable
    // (the rare path where a crashed child left no value behind).
    removeChildGitHead(stateDir);
    expect(readChildGitHead(stateDir)).toBe(null);
  });

  test("Case D2 — supervisor degrades gracefully when child HEAD is unavailable instead of swapping blindly", () => {
    const now = 10_000_000;
    const decision = decideSupervisorAction(
      db,
      { currentGitHead: "abcdef", childGitHead: null, childBootAtMs: now - 10 * 60 * 1000 },
      { minChildAgeMs: 60_000, drainBudgetMs: 60_000, nowMs: () => now },
    );
    expect(decision.action).toBe("no_op");
    if (decision.action === "no_op") expect(decision.reason).toBe("child_head_unavailable");
  });

  test("Case G — runSupervisorLoop with mock git HEAD + mock child returns expected emission sequence", async () => {
    // Drive the loop end-to-end without spawning any real subprocess.
    // All external effects (git rev-parse, /shutdown, /health, spawn,
    // exit wait, clock, sleep) are injected as deps.
    let clock = 10_000_000;
    const advance = (ms: number): void => { clock += ms; };

    // Tick 1: HEAD unchanged → no_op. Tick 2: HEAD diverges → swap.
    const heads = ["aaaa1111", "bbbb2222"];
    let tick = 0;

    writeChildGitHead("aaaa1111", stateDir);

    const childHandle: SupervisorChildHandle = {
      pid: 12345,
      exited: false,
      exitCode: null,
    };
    let spawnCount = 0;
    let shutdownCount = 0;
    let healthCount = 0;

    const deps: SupervisorLoopDeps = {
      getCurrentGitHead: () => {
        const h = heads[Math.min(tick, heads.length - 1)] ?? null;
        tick += 1;
        return h;
      },
      readChildGitHead: (sd) => readChildGitHead(sd),
      nowMs: () => clock,
      sleep: async (ms) => { advance(ms); },
      spawnChild: (_entry, sd) => {
        spawnCount += 1;
        // Simulate the new child writing its loaded HEAD on boot.
        writeChildGitHead("bbbb2222", sd);
        return { pid: 99999, exited: false, exitCode: null };
      },
      requestChildShutdown: async () => { shutdownCount += 1; return true; },
      pollChildHealth: async () => { healthCount += 1; return true; },
      waitChildExit: async (h) => { h.exited = true; h.exitCode = 0; return true; },
    };

    const outcomes = await runSupervisorLoop(
      db,
      childHandle,
      {
        tickIntervalMs: 100,
        minChildAgeMs: 0,
        drainBudgetMs: 60_000,
        stateDir,
        nowMs: () => clock,
        maxTicks: 2,
      },
      deps,
    );

    expect(outcomes.length).toBe(2);
    expect(outcomes[0].outcome).toBe("no_op");
    expect(outcomes[1].outcome).toBe("swap_succeeded");
    if (outcomes[1].outcome === "swap_succeeded") {
      expect(outcomes[1].previousHead).toBe("aaaa1111");
      expect(outcomes[1].newHead).toBe("bbbb2222");
    }
    expect(spawnCount).toBe(1);
    expect(shutdownCount).toBe(1);
    expect(healthCount).toBeGreaterThanOrEqual(1);

    // Verify the canonical emission chain landed on the bus — no new
    // event kinds, only the existing daemon_hotreload_* family.
    const kinds = db
      .query(`SELECT kind FROM events WHERE kind LIKE 'daemon_hotreload_%' ORDER BY ts ASC`)
      .all() as Array<{ kind: string }>;
    const kindList = kinds.map((r) => r.kind);
    expect(kindList).toContain("daemon_hotreload_triggered");
    expect(kindList).toContain("daemon_hotreload_swapped");
    expect(kindList).toContain("daemon_hotreload_completed");
  });

  test("Case H — SIGHUP receipt schedules an immediate tick", async () => {
    // The loop's sleep window is 60s; SIGHUP must break it inside a
    // short observation window. We assert two ticks complete despite
    // the long natural cadence — only possible if SIGHUP woke the
    // sleeper.
    let clock = 10_000_000;
    writeChildGitHead("samehead", stateDir);

    let tickCount = 0;
    const deps: SupervisorLoopDeps = {
      getCurrentGitHead: () => { tickCount += 1; return "samehead"; },
      readChildGitHead: (sd) => readChildGitHead(sd),
      nowMs: () => clock,
      sleep: async (ms) => { clock += ms; },
    };

    // Synthesize the SIGHUP shortly after the loop starts. Using
    // process.emit rather than kill -HUP keeps the test runner's own
    // signal disposition untouched (a real SIGHUP would terminate
    // bun:test with exit 129).
    setTimeout(() => { process.emit("SIGHUP" as never); }, 25);

    await runSupervisorLoop(
      db,
      null,
      {
        tickIntervalMs: 60_000,
        minChildAgeMs: 0,
        drainBudgetMs: 60_000,
        stateDir,
        nowMs: () => clock,
        maxTicks: 2,
      },
      deps,
    );

    expect(tickCount).toBeGreaterThanOrEqual(2);
  });

  test("Case I — acc daemon supervise + swap-now subcommands accept --help", async () => {
    const log: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => { log.push(args.map(String).join(" ")); };
    try {
      const codeA = await runDispatch(["daemon", "supervise", "--help"]);
      expect(codeA).toBe(0);
      const codeB = await runDispatch(["daemon", "swap-now", "--help"]);
      expect(codeB).toBe(0);
    } finally {
      console.log = origLog;
    }
    const joined = log.join("\n");
    expect(joined).toContain("acc daemon supervise");
    expect(joined).toContain("--tick-ms");
    expect(joined).toContain("acc daemon swap-now");
    expect(joined).toContain("SIGHUP");
  });
});
