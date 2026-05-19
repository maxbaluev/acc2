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
  writeChildGitHead,
} from "../runtime/daemon_supervisor";

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
});
